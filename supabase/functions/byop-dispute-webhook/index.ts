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
// BYOP_DISPUTE_SECRET IS REQUIRED. Set it, and have the processor send it as the
// x-webhook-secret header.
//
// This used to say that leaving it unset was acceptable — the endpoint would then
// rely on an unguessable URL, on the reasoning that every write here is idempotent
// and reversible. That reasoning was wrong twice over. A Supabase function URL is
// a project ref and a function name, which is not a secret; and "reversible" is
// not the same as harmless, because record_chargeback posts a real ledger entry,
// rewrites campistryMe and notifies the office. An unauthenticated caller could
// fabricate chargebacks against families, and somebody would have to work out
// which of them were real.
//
// So it fails CLOSED: no secret configured, no requests served. A feature that is
// switched off until an operator finishes configuring it is a far smaller problem
// than one that is quietly open.
//
// ── WHAT IS VERIFIED AND WHAT IS NOT ───────────────────────────────────────
// CARDKNOX / SOLA: the field names are verified against the field picker in the
// portal's own Webhook Settings screen. Two findings from it are load-bearing
// and are spelled out at the mapper: the postback calls the transaction
// reference xResponseRefnum / xGatewayRefNum (the API response calls the same
// value xRefNum), and it carries NO amount field at all.
//
// That picker also strongly suggests this postback is Cardknox's TRANSACTION
// notification rather than a dispute feed: it offers no chargeback id, no case
// number and no dispute reason — only xStatus / xStatusReason, which is where a
// chargeback would have to show up if it shows up at all. Whether Cardknox
// emits a postback for a chargeback is an open question, and the cheapest way
// to answer it is to look at this function's logs after a real one.
//
// BANQUEST: still unverified. No public webhook documentation could be found,
// and every relevant domain is unreachable from this environment (the egress
// proxy blocks docs.banquestgateway.com, banquest.com and developers.8am.com).
// Its field names below come from banquest_adapter, so the reference is right
// if the envelope resembles a transaction; the envelope itself is a guess.
//
// So normalise() stays generous: it reads several plausible spellings and logs
// the whole body when it cannot find what it needs. Send one real test dispute
// from the processor's dashboard, read the log line, and tighten the mapping to
// what actually arrives. Until that is done for a given processor, treat its
// chargeback handling as plumbed but unproven.
//
// IF A PROCESSOR CANNOT PUSH DISPUTES AT ALL, this endpoint is the wrong shape
// for it and no amount of field-mapping fixes that. The answer there is to poll
// — Cardknox has a Reporting API at x1.cardknox.com/report — and feed the same
// record_chargeback path from a scheduled job instead of from a request.
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
    // These names are VERIFIED against the field picker in the Sola/Cardknox
    // portal's own Webhook Settings screen, not guessed from documentation.
    //
    // Note what is NOT in that picker, because both matter:
    //
    //   * xRefNum. The API RESPONSE calls it that — cardknox_adapter.charge()
    //     returns result.xRefNum and we store it as byopTransactionId — but the
    //     postback spells the same value xResponseRefnum, with xGatewayRefNum
    //     alongside it. Reading only xRefNum, as this did first, finds nothing.
    //   * any amount field at all. The Transaction Fields group has no xAmount;
    //     the only money fields are xSubtotal/xTip/xTax/xShipAmount under Order
    //     Details, which are order lines rather than what was captured. So the
    //     amount is often simply absent, and migration 177 takes it from the
    //     payment being disputed instead.
    //
    // There is also no chargeback id, reason or case number anywhere in the
    // picker — which is itself the evidence that this postback is Cardknox's
    // TRANSACTION notification and not a dispute feed. See the header.
    const refs = [b.xResponseRefnum, b.xResponseRefNum, b.xGatewayRefNum,
                  b.xRefNum, b.xRefnum, b.refNum, b.ReferenceNumber,
                  b.xOrigRefNum, b.originalRefNum, b.xInvoice]
      .map(str).filter(Boolean);
    if (!refs.length) return null;
    // No dispute id in the payload, so derive one from the transaction. It has
    // to be DETERMINISTIC: it is the idempotency key, and it is what a later
    // resolution event must produce again to find this chargeback.
    const disputeId = str(b.xChargebackId || b.chargebackId || b.caseId ||
                          b.disputeId || b.id) || ("ck_" + refs[0]);
    const status = str(b.xStatus || b.xStatusReason || b.status ||
                       b.chargebackStatus || b.xGatewayResult) || null;
    const closed = /reversed|won|lost|closed|resolved/i.test(status || "") ||
                   /chargeback[_.]?(reversal|closed|resolved)/i.test(str(b.xCommand || b.event || b.type));
    return {
      disputeId, refs,
      // 0 when absent, which record_chargeback reads as "use the payment's own
      // amount" rather than as an error.
      amount: Math.abs(num(b.xAmount ?? b.amount ?? b.chargebackAmount)),
      reason: str(b.xStatusReason || b.xChargebackReason || b.reason ||
                  b.reasonCode || b.xResponseError) || null,
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
  // No secret configured at all: refuse everything, and say what to do about it.
  // 503 rather than 401 because this is the deployment being incomplete, not the
  // caller being wrong — and it keeps the two cases apart in the logs.
  if (!WEBHOOK_SECRET) {
    console.error("[byop-dispute] REFUSING ALL REQUESTS: BYOP_DISPUTE_SECRET is not " +
                  "set. Set it in the Edge Function secrets and have the processor " +
                  "send it as the x-webhook-secret header.");
    return new Response(JSON.stringify({ error: "webhook_not_configured" }), {
      status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (req.headers.get("x-webhook-secret") !== WEBHOOK_SECRET) {
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

  let pauseFailed = "";
  try {
    if (d.closed) {
      const { data, error } = await supabase.rpc("resolve_chargeback", {
        p_camp_id: camp, p_dispute_id: d.disputeId,
        p_won: d.won, p_status: d.status,
      });
      if (error) console.warn(`[byop-dispute] ${processor} close not recorded: ${error.message}`);
      // The family's card pause (288, TED-200): won lifts this dispute from
      // it; lost marks it lost, so the office may resume from Billing.
      if (!error && data?.familyKey) {
        const r = d.won
          ? await supabase.rpc("hold_autopay_for_dispute", {
              p_camp_id: camp, p_family_key: String(data.familyKey), p_dispute_id: d.disputeId, p_hold: false })
          : await supabase.rpc("note_dispute_lost", {
              p_camp_id: camp, p_family_key: String(data.familyKey), p_dispute_id: d.disputeId });
        if (r.error) pauseFailed = `dispute ${d.disputeId} closed, but the family's card pause was not updated: ${r.error.message} — is migration 288 applied?`;
      }
    } else {
      // A missing amount is NOT a reason to refuse. Cardknox's postback has no
      // amount field at all, so requiring one meant the camp stayed exactly
      // where it started — money gone from the bank, nothing recorded here.
      // Passing null tells record_chargeback (migration 177) to use the amount
      // of the payment being disputed, which is our own record of what was
      // actually captured. A real amount still wins, because only the processor
      // knows about a PARTIAL chargeback.
      const { data, error } = await supabase.rpc("record_chargeback", {
        p_camp_id: camp, p_dispute_id: d.disputeId, p_refs: d.refs,
        p_amount: d.amount > 0 ? d.amount : null,
        p_reason: d.reason, p_status: d.status,
      });
      if (error || !data?.success) {
        console.error(`[byop-dispute] ${processor}: chargeback ${d.disputeId} NOT posted ` +
          `(${error?.message || data?.error || "unknown"}) — the camp's books now overstate ` +
          `collected cash until this is reconciled by hand. refs=${d.refs.join(",")}`);
      }
      // The family's card is not charged again — by autopay or from Billing —
      // while their bank decides (288, TED-200), as for a Stripe dispute.
      if (!error && data?.success && data.familyKey) {
        const hold = await supabase.rpc("hold_autopay_for_dispute", {
          p_camp_id: camp, p_family_key: String(data.familyKey), p_dispute_id: d.disputeId, p_hold: true,
          p_detail: d.reason || null });
        if (hold.error) pauseFailed = `chargeback ${d.disputeId} posted, but the family's card was not paused: ${hold.error.message} — is migration 288 applied?`;
      }
    }
  } catch (e) {
    console.error(`[byop-dispute] ${processor} threw: ${(e as Error).message}`);
  }

  // The pause is the one write a retry fixes (every writer here is keyed on the
  // dispute, so sending it again posts nothing twice): 500, so the processor
  // sends it again, instead of leaving the family's card chargeable.
  if (pauseFailed) {
    console.error(`[byop-dispute] ${processor}: ${pauseFailed}`);
    return new Response(JSON.stringify({ received: true, paused: false }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  // Otherwise 200. A dispute notification retried forever because our own write
  // failed helps nobody; the log line above is the actionable signal.
  return new Response(JSON.stringify({ received: true }), {
    status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
