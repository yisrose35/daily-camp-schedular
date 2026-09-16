// =============================================================================
// byop-dispute-webhook — a parent disputed a charge on a NON-Stripe processor
//
// Stripe disputes arrive at stripe-webhook and post to the family's ledger
// (migration 175). Cardknox/Sola and Banquest had no equivalent, so on those
// camps a chargeback pulled money out of the camp's bank account while
// Campistry went on showing the payment as succeeded and the family as having
// paid. The books overstated collected cash with no signal at all.
//
// This is ONE endpoint for every BYOP processor rather than one per processor,
// because the hard part is identical in all cases: find the payment we recorded,
// post a refund entry against that family's ledger, and do it once. Only the
// shape of the incoming body differs, and that lives in normalise() below.
//
// ── SETTING IT UP ──────────────────────────────────────────────────────────
// In the processor's own dashboard, point its dispute/chargeback notification at
//
//     https://<project>.supabase.co/functions/v1/byop-dispute-webhook?processor=cardknox
//
// (or ?processor=banquest). The processor query parameter is required — nothing
// is inferred from the body, because a mis-detected processor would map the
// wrong fields and post a chargeback against the wrong payment.
//
// Set BYOP_DISPUTE_SECRET and pass it as the x-webhook-secret header if the
// processor supports custom headers. If it does not, leave the secret unset —
// the endpoint then relies on the unguessable URL, and every write it makes is
// idempotent and reversible, so a spurious call costs a wrong ledger entry that
// an office can reverse rather than money.
//
// ── WHAT IS VERIFIED AND WHAT IS NOT ───────────────────────────────────────
// The FIELD NAMES below are taken from each processor's existing adapter in this
// repo — Cardknox identifies a transaction by xRefNum, Banquest by
// reference_number — so the reference that identifies the disputed payment is
// right. What could NOT be verified from here is each processor's exact dispute
// EVENT NAME and envelope, because their documentation is unreachable from this
// environment (the egress proxy blocks docs.banquestgateway.com and
// developers.8am.com).
//
// So normalise() is written to be generous: it reads any of several plausible
// field spellings and logs the whole body when it cannot find what it needs.
// Send one real test dispute from the processor's dashboard, read the log line,
// and tighten the mapping to what actually arrives. Until that is done for a
// given processor, treat its chargeback handling as plumbed but unproven.
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const WEBHOOK_SECRET = Deno.env.get("BYOP_DISPUTE_SECRET") || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-webhook-secret",
};

/** What every processor's dispute body is reduced to. */
type Dispute = {
  disputeId: string;
  refs: string[];        // every id that might identify the disputed payment
  amount: number;        // dollars
  reason: string | null;
  status: string | null;
  closed: boolean;       // a resolution rather than a new dispute
  won: boolean;          // only meaningful when closed
};

const num = (v: unknown) => {
  const n = Number(v);
  return isFinite(n) ? n : 0;
};
const str = (v: unknown) => (v == null ? "" : String(v)).trim();

/**
 * Map one processor's body onto Dispute.
 *
 * Deliberately reads SEVERAL spellings per field. The alternative — picking one
 * and being wrong — fails silently at the worst possible moment, which is
 * exactly the class of bug this whole endpoint exists to close.
 */
function normalise(processor: string, b: Record<string, any>): Dispute | null {
  if (processor === "cardknox") {
    // Cardknox/Sola identifies every transaction by xRefNum — that is what
    // cardknox_adapter.charge() returns and what the ledger stores as
    // byopTransactionId, so it is the reference that will match.
    const refs = [b.xRefNum, b.xRefnum, b.refNum, b.ReferenceNumber,
                  b.xOrigRefNum, b.originalRefNum, b.xInvoice]
      .map(str).filter(Boolean);
    const disputeId = str(b.xChargebackId || b.chargebackId || b.caseId ||
                          b.disputeId || b.id) || ("ck_" + refs[0]);
    if (!refs.length) return null;
    const status = str(b.xStatus || b.status || b.chargebackStatus) || null;
    const closed = /reversed|won|lost|closed|resolved/i.test(status || "") ||
                   /chargeback[_.]?(reversal|closed|resolved)/i.test(str(b.xCommand || b.event || b.type));
    return {
      disputeId, refs,
      amount: Math.abs(num(b.xAmount ?? b.amount ?? b.chargebackAmount)),
      reason: str(b.xChargebackReason || b.reason || b.reasonCode) || null,
      status, closed,
      won: /reversed|won/i.test(status || ""),
    };
  }

  if (processor === "banquest") {
    // Banquest returns an integer reference_number on every transaction, which
    // banquest_adapter stores and the ledger carries as byopTransactionId.
    const refs = [b.reference_number, b.referenceNumber, b.transaction_id,
                  b.transactionId, b.charge_id, b.original_reference_number]
      .map(str).filter(Boolean);
    const disputeId = str(b.chargeback_id || b.dispute_id || b.case_number ||
                          b.id) || ("bq_" + refs[0]);
    if (!refs.length) return null;
    const status = str(b.status || b.chargeback_status || b.state) || null;
    const closed = /won|lost|closed|resolved|reversed/i.test(status || "") ||
                   /closed|resolved/i.test(str(b.event_type || b.event || b.type));
    return {
      disputeId, refs,
      amount: Math.abs(num(b.amount ?? b.chargeback_amount ?? b.disputed_amount)),
      reason: str(b.reason || b.reason_code || b.reason_description) || null,
      status, closed,
      won: /won|reversed/i.test(status || ""),
    };
  }

  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = new URL(req.url);
  const processor = (url.searchParams.get("processor") || "").toLowerCase();
  const campId = url.searchParams.get("camp") || "";

  // Nothing is inferred from the body: a mis-detected processor would map the
  // wrong fields and post a chargeback against the wrong payment.
  if (processor !== "cardknox" && processor !== "banquest") {
    return new Response(JSON.stringify({ error: "unknown_processor" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (WEBHOOK_SECRET && req.headers.get("x-webhook-secret") !== WEBHOOK_SECRET) {
    console.warn(`[byop-dispute] rejected: bad or missing x-webhook-secret (${processor})`);
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: Record<string, any> = {};
  try {
    const raw = await req.text();
    try {
      body = JSON.parse(raw);
    } catch {
      // Cardknox posts form-encoded on some endpoints.
      new URLSearchParams(raw).forEach((v, k) => { body[k] = v; });
    }
  } catch { /* empty body falls through to the not-understood path below */ }

  const d = normalise(processor, body);
  if (!d || !d.refs.length) {
    // The whole body, once, so the mapping can be tightened to what actually
    // arrives instead of to what its documentation claims.
    console.error(`[byop-dispute] ${processor}: could not find a transaction reference. ` +
      `Body was: ${JSON.stringify(body).slice(0, 2000)}`);
    // 200 on purpose: a retry would deliver the same unreadable body forever.
    return new Response(JSON.stringify({ received: true, understood: false }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Which camp? These processors are per-camp, so the credential row is the
  // authoritative answer; the query parameter is only a fallback for a processor
  // that can be told to include it.
  let camp = campId;
  if (!camp) {
    const { data } = await supabase
      .from("camp_processor_credentials")
      .select("camp_id")
      .eq("processor_key", processor);
    if (data && data.length === 1) {
      camp = String(data[0].camp_id);
    } else if (data && data.length > 1) {
      // More than one camp on this processor and no camp in the URL: guessing
      // would put a chargeback on the wrong camp's books, which is worse than
      // not recording it. Give the operator the one instruction that fixes it.
      console.error(`[byop-dispute] ${processor}: ${data.length} camps use this processor and ` +
        `the webhook URL carries no &camp=<uuid>. Dispute ${d.disputeId} NOT recorded — ` +
        `add the camp id to each camp's webhook URL in the processor dashboard.`);
      return new Response(JSON.stringify({ received: true, recorded: false }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }
  if (!camp) {
    console.error(`[byop-dispute] ${processor}: no camp resolved for dispute ${d.disputeId}`);
    return new Response(JSON.stringify({ received: true, recorded: false }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    if (d.closed) {
      const { error } = await supabase.rpc("resolve_chargeback", {
        p_camp_id: camp, p_dispute_id: d.disputeId,
        p_won: d.won, p_status: d.status,
      });
      if (error) console.warn(`[byop-dispute] ${processor} close not recorded: ${error.message}`);
    } else {
      if (!(d.amount > 0)) {
        console.error(`[byop-dispute] ${processor}: dispute ${d.disputeId} has no amount — not recorded`);
      } else {
        const { data, error } = await supabase.rpc("record_chargeback", {
          p_camp_id: camp, p_dispute_id: d.disputeId, p_refs: d.refs,
          p_amount: d.amount, p_reason: d.reason, p_status: d.status,
        });
        if (error || !data?.success) {
          console.error(`[byop-dispute] ${processor}: chargeback ${d.disputeId} NOT posted ` +
            `(${error?.message || data?.error || "unknown"}) — the camp's books now overstate ` +
            `collected cash until this is reconciled by hand. refs=${d.refs.join(",")}`);
        }
      }
    }
  } catch (e) {
    console.error(`[byop-dispute] ${processor} threw: ${(e as Error).message}`);
  }

  // Always 200. A dispute notification retried forever because our own write
  // failed helps nobody; the log line above is the actionable signal.
  return new Response(JSON.stringify({ received: true }), {
    status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
