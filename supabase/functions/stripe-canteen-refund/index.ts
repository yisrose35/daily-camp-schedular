// =============================================================================
// stripe-canteen-refund — Refund a camper's canteen balance back to the
// parent, in ONE requested dollar amount (not tied to picking a single
// original deposit).
//
// Why not "pick one deposit and refund from it": a parent who deposits $10
// every week ends up with several separate Stripe PaymentIntents behind one
// balance. Office needed to refund, say, $20 back — with the old "refund
// exactly one deposit" design that meant either picking a single $20+
// deposit (rare) or manually repeating the refund action once per deposit
// until the total added up. Real money in a wallet is fungible; this
// function accepts one target dollar amount and automatically apportions
// it across as many of the camper's Stripe-backed deposits as needed
// (oldest first), issuing one Stripe refund per deposit it draws from —
// transparent to the office as a single action.
//
// Auth: requires the caller's real Supabase session JWT, owner/admin only
// (same tightest-default precedent as other money-moving actions in this
// app). The acting camp is derived EXCLUSIVELY from that session's own
// owner/admin membership (callerCampId, copied verbatim from
// stripe-charge/index.ts) — never from a client-supplied campId.
//
// A refund is capped at THE LOWEST of three ceilings:
//   1. whatever's still unspent in the camper's canteen wallet
//      (balance - balanceFloor — the same ceiling cash-out already uses;
//      creditLimit is a forward-looking spending allowance, not a
//      withdrawal ceiling, so it's deliberately not used here)
//   2. the total still refundable across the camper's Stripe deposits
//      (each deposit's original amount minus whatever's already been
//      refunded from it — Stripe itself enforces this per PaymentIntent,
//      this just mirrors that ceiling so the response can explain a cap
//      instead of Stripe rejecting a chunk deep into the loop)
//   3. the amount actually requested (or, if omitted, ceiling 1 — "refund
//      everything left")
// Ceiling 2 can be BELOW ceiling 1 when some of the balance came from a
// manual/cash deposit (campistry_snacks.js's addDep) — that money was
// never charged through Stripe, so there's nothing here to refund it
// from; the response says so explicitly rather than silently under-
// refunding with no explanation.
//
// Request:  { camperName, amount?, reason? }
//           header: Authorization: Bearer <caller's Supabase access token>
// Response: { totalRefunded, requested, capped, cappedReason?, refunds: [...] }
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STRIPE_SECRET = Deno.env.get("STRIPE_SECRET_KEY");
const STRIPE_API = "https://api.stripe.com/v1";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const SENDER_ROLES = ["owner", "admin"];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function stripePost(endpoint: string, body: Record<string, string>, idempotencyKey?: string) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${STRIPE_SECRET}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const resp = await fetch(`${STRIPE_API}${endpoint}`, { method: "POST", headers, body: new URLSearchParams(body).toString() });
  return resp.json();
}

async function stripeGet(endpoint: string) {
  const resp = await fetch(`${STRIPE_API}${endpoint}`, { headers: { Authorization: `Bearer ${STRIPE_SECRET}` } });
  return resp.json();
}

// Copied verbatim from stripe-charge/index.ts — resolves the camp the
// AUTHENTICATED caller actually belongs to as owner/admin. This, not any
// client-supplied value, is the only campId ever trusted for this action.
async function callerCampId(req: Request): Promise<string | null> {
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt || !SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  const asUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData } = await asUser.auth.getUser();
  const uid = userData?.user?.id;
  if (!uid) return null;

  // .maybeSingle() throws/returns null on >1 rows — an account can
  // legitimately own more than one camp (debug copies, multiple real
  // camps), and that silently broke this whole check for any such
  // account: a genuine owner fell through to the camp_users check below
  // and, finding nothing there either, got rejected as "not owner/admin"
  // on their own camp. Mirrors detectCampAndRole()'s own tie-break in
  // supabase_client.js: prefer the camp whose id equals the owner's own
  // uid (the original signup convention), else just the first one.
  const { data: ownedCamps } = await asUser.from("camps").select("id").eq("owner", uid);
  const owned = Array.isArray(ownedCamps) && ownedCamps.length
    ? (ownedCamps.find((c: { id: string }) => c.id === uid) || ownedCamps[0])
    : null;
  if (owned?.id) return owned.id;

  // Same fix here — .maybeSingle() also broke for anyone belonging to more
  // than one camp_users row. Most-recently-accepted wins, matching
  // detectCampAndRole()'s STEP 1 rule (and only an ACCEPTED invite counts,
  // same as that rule — a still-pending one shouldn't grant refund
  // authority).
  const { data: memberships } = await asUser
    .from("camp_users")
    .select("camp_id, role")
    .eq("user_id", uid)
    .not("accepted_at", "is", null)
    .order("accepted_at", { ascending: false })
    .limit(1);
  const membership = Array.isArray(memberships) && memberships.length ? memberships[0] : null;
  if (membership?.camp_id && SENDER_ROLES.includes(membership.role)) return membership.camp_id;
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (!STRIPE_SECRET) return json({ error: "Stripe not configured" }, 500);

    const authedCampId = await callerCampId(req);
    if (!authedCampId) return json({ error: "Only camp owners/admins can refund a canteen deposit." }, 403);

    const { camperName, camperId: body_camperId, amount, reason, idempotencyKey } = await req.json();
    // The camper by ID when the page sent one: the account's key is a spelling.
    const camperIdSent = (body_camperId != null && /^\d+$/.test(String(body_camperId)) && Number(body_camperId) > 0) ? Number(body_camperId) : null;
    if (camperIdSent == null && !camperName) return json({ error: "camperId (or camperName) is required" }, 400);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    // canteen_refund_view (migration 250), not get_canteen_accounts: that one
    // decides what to show from the signed-in caller, which the service role is
    // not — it answered not_authorized, so every refund stopped here — and its
    // ledger is a 7-day window. This has every deposit, and each account's id.
    const { data: accountsData, error: acctErr } = await supabase.rpc("canteen_refund_view", { p_camp_id: authedCampId });
    if (acctErr || !accountsData?.success) return json({ error: "Could not read canteen balance." }, 500);

    // The number decides: given one, only the account carrying it; the name
    // (the account key) is the fallback only for a caller that sent no number.
    const accountsAll: Record<string, any> = accountsData.accounts || {};
    const byNumber = (id: number) => Object.values(accountsAll).find((a: any) => a && String(a.camperId) === String(id));
    const account = (camperIdSent != null ? byNumber(camperIdSent) : accountsAll[String(camperName)]) || {};   // name only when no camperId was sent
    const camperId: number | null = camperIdSent != null ? camperIdSent
        : (account.camperId != null ? Number(account.camperId) : null);
    // A ledger row with a number matches by its number; by name only when either side has none.
    const mine = (t: Record<string, any>) => (camperId != null && t.camperId != null) ? String(t.camperId) === String(camperId) : t.camper === camperName;
    const balance = Number(account.balance) || 0;
    const balanceFloor = Number(account.balanceFloor) || 0;
    const walletAvailable = Math.max(0, round2(balance - balanceFloor));

    // What this refund (the page's key) already did on an earlier try whose
    // answer was lost (TED-105): settled parts are counted, never re-split and
    // sent again; a part sent but never confirmed is re-asked with the SAME
    // Stripe key — Stripe answers with the refund it made, or makes it now.
    const reqKey = (typeof idempotencyKey === "string" && idempotencyKey.trim()) ? idempotencyKey.trim() : "";
    let priorDone = 0;
    const priorRefunds: Record<string, unknown>[] = [];
    const priorPIs = new Set<string>();
    const requestedAll = amount != null && Number(amount) > 0 ? round2(Number(amount)) : null;
    if (reqKey) {
      const { data: prior } = await supabase.from("refund_intents").select("key, result, settled_at, amount")
        .eq("camp_id", authedCampId).like("key", `scanteen:${reqKey}:%`);
      for (const c of (Array.isArray(prior) ? prior : [])) {
        const piId = String(c.key).slice(`scanteen:${reqKey}:`.length);
        priorPIs.add(piId);
        let amt = c.settled_at && c.result ? Number(c.result.amount) || 0 : 0;
        if (!c.settled_at) {
          const heldAmt = round2(Number(c.amount) || 0);
          const hpi = await stripeGet(`/payment_intents/${piId}`);
          const hp: Record<string, string> = { payment_intent: piId, amount: String(Math.round(heldAmt * 100)) };
          if (reason === "duplicate" || reason === "fraudulent" || reason === "requested_by_customer") hp.reason = reason;
          if (hpi?.transfer_data?.destination) hp.reverse_transfer = "true";
          const again = await stripePost("/refunds", hp, `canteen_refund_${reqKey}_${piId}`);
          if (again.error) {
            return json({ uncertain: true, error: "An earlier try at this refund has not been confirmed by Stripe yet — wait a minute and check the Stripe dashboard before trying again." }, 200);
          }
          await supabase.rpc("settle_refund_intent", { p_camp_id: authedCampId, p_key: c.key,
            p_result: { refundId: again.id, amount: heldAmt } });
          await supabase.rpc("refund_canteen_deposit_from_stripe", {
            p_camp_id: authedCampId, p_camper_id: camperId, p_camper_name: String(camperName ?? ""),
            p_amount: heldAmt, p_payment_intent_id: piId, p_refund_id: again.id,
          });
          amt = heldAmt;
          priorRefunds.push({ refundId: again.id, paymentIntentId: piId, amount: heldAmt });
        } else if (amt > 0) {
          priorRefunds.push({ refundId: c.result.refundId, paymentIntentId: piId, amount: amt });
        }
        priorDone = round2(priorDone + amt);
      }
    }
    if (requestedAll != null && priorDone >= requestedAll - 0.004) {
      return json({ totalRefunded: priorDone, requested: requestedAll, capped: false, cappedReason: null, refunds: priorRefunds, replayed: true });
    }

    if (walletAvailable <= 0) {
      return json({ error: "Nothing available to refund — this balance has already been spent." }, 409);
    }

    // Every Stripe-backed deposit for this camper, minus whatever's already
    // been refunded from each one — this is the real per-deposit ceiling
    // Stripe itself will enforce. Oldest first: refunding "first money in"
    // first is the natural expectation, and it doesn't change the total
    // available either way (the dollars are fungible).
    const transactions: Record<string, any>[] = accountsData.transactions || [];
    const deposits = transactions
      .filter((t) => t && mine(t) && t.kind === "deposit" && t.method === "stripe" && t.stripePaymentIntentId)
      .map((dep) => {
        const refundedSoFar = transactions
          .filter((t) => t && t.kind === "refund" && t.stripePaymentIntentId === dep.stripePaymentIntentId)
          .reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
        return { paymentIntentId: dep.stripePaymentIntentId as string, remaining: round2((Number(dep.amount) || 0) - refundedSoFar), timestamp: Number(dep.timestamp) || 0 };
      })
      .filter((d) => d.remaining > 0)
      .sort((a, b) => a.timestamp - b.timestamp);

    const stripeCapacity = round2(deposits.reduce((sum, d) => sum + d.remaining, 0));

    const requested = requestedAll != null ? requestedAll : walletAvailable;
    const targetAmount = round2(Math.min(round2(requested - priorDone), walletAvailable, stripeCapacity));

    if (targetAmount <= 0) {
      if (stripeCapacity <= 0) {
        return json({ error: "This balance has no Stripe-paid deposits left to refund online — it came from cash/manual deposits and must be refunded that way instead." }, 409);
      }
      return json({ error: "Nothing available to refund." }, 409);
    }

    // Draw from deposits oldest-first until the target amount is covered.
    // Each chunk is its own Stripe refund (a partial refund of that specific
    // PaymentIntent) and its own ledger entry — if one chunk fails partway
    // through, everything before it has already succeeded for real money,
    // so those are kept and reported rather than rolled back or hidden.
    let remainingToRefund = targetAmount;
    let totalRefunded = priorDone;
    const refunds: Record<string, unknown>[] = priorRefunds.slice();
    let chunkError: string | null = null;
    let chunkUncertain = false;

    for (const dep of deposits) {
      if (remainingToRefund <= 0) break;
      if (reqKey && priorPIs.has(dep.paymentIntentId)) continue;     // this refund already drew on it
      const chunk = round2(Math.min(dep.remaining, remainingToRefund));
      if (chunk <= 0) continue;

      try {
        // One claim per top-up per refund, taken before Stripe (TED-105).
        const claimKey = reqKey ? `scanteen:${reqKey}:${dep.paymentIntentId}` : "";
        if (claimKey) {
          const { data: cl } = await supabase.rpc("claim_refund_intent", {
            p_camp_id: authedCampId, p_key: claimKey, p_amount: chunk, p_payment_ref: dep.paymentIntentId });
          if (cl && cl.claimed === false) {
            // Another press of THIS refund has this top-up (TED-109). Done:
            // count it. Still going: stop — never move on to the next top-up
            // and refund the same money from there.
            if (cl.previous && cl.previous.refundId) {
              const doneAmt = round2(Number(cl.previous.amount) || chunk);
              refunds.push({ refundId: cl.previous.refundId, paymentIntentId: dep.paymentIntentId, amount: doneAmt });
              totalRefunded = round2(totalRefunded + doneAmt);
              remainingToRefund = round2(remainingToRefund - doneAmt);
              continue;
            }
            throw Object.assign(new Error("This refund is being sent right now — wait a moment and check the child's wallet before trying again."), { uncertain: true });
          }
        }
        // Re-fetch the PI to auto-detect whether it was a destination charge
        // (reverse_transfer needed) — mirrors stripe-refund/index.ts.
        const pi = await stripeGet(`/payment_intents/${dep.paymentIntentId}`);
        if (pi.error) throw new Error(pi.error.message);

        const params: Record<string, string> = {
          payment_intent: dep.paymentIntentId,
          amount: String(Math.round(chunk * 100)),
        };
        if (reason === "duplicate" || reason === "fraudulent" || reason === "requested_by_customer") params.reason = reason;
        if (pi.transfer_data?.destination) params.reverse_transfer = "true";

        // What is still refundable is part of the key (TED-097): a second refund of
      // the same amount later is a NEW refund, while a retry of this one after a
      // lost answer repeats the key and Stripe answers with the refund it made.
      // The page's key for this refund when it sends one (TED-105): a retry of
      // the same refund repeats it, so Stripe answers with the refund it made.
      let refund: any;
      try {
        refund = await stripePost("/refunds", params, reqKey
          ? `canteen_refund_${reqKey}_${dep.paymentIntentId}`
          : `canteen_refund_${dep.paymentIntentId}_${Math.round(dep.remaining * 100)}_${Math.round(chunk * 100)}`);
      } catch (e) {
        // Cut off: Stripe may have made it. The claim stays open, and the next
        // press re-asks with the same key, which Stripe answers with the refund
        // it made — so this is "check first", never a plain failure (TED-109).
        throw Object.assign(new Error("Stripe did not answer, so this refund may have gone through. Check the child's wallet before trying again."), { uncertain: true });
      }
        if (refund.error) {
          if (claimKey) await supabase.rpc("release_refund_intent", { p_camp_id: authedCampId, p_key: claimKey });
          throw new Error(refund.error.message);
        }
        if (claimKey) {
          await supabase.rpc("settle_refund_intent", { p_camp_id: authedCampId, p_key: claimKey,
            p_result: { refundId: refund.id, amount: chunk } });
        }

        const { error: creditErr } = await supabase.rpc("refund_canteen_deposit_from_stripe", {
          p_camp_id: authedCampId,
          p_camper_id: camperId, p_camper_name: String(camperName ?? ""),
          p_amount: chunk,
          p_payment_intent_id: dep.paymentIntentId,
          p_refund_id: refund.id,
        });
        if (creditErr) console.error(`[stripe-canteen-refund] Stripe refund ${refund.id} succeeded but ledger update failed: ${creditErr.message}`);

        refunds.push({ refundId: refund.id, paymentIntentId: dep.paymentIntentId, amount: chunk });
        totalRefunded = round2(totalRefunded + chunk);
        remainingToRefund = round2(remainingToRefund - chunk);
      } catch (chunkErr) {
        chunkError = (chunkErr as Error).message;
        if ((chunkErr as any).uncertain) chunkUncertain = true;
        break;
      }
    }

    if (totalRefunded <= 0) {
      if (chunkUncertain) return json({ uncertain: true, error: chunkError }, 200);
      throw new Error(chunkError || "Refund failed.");
    }

    const capped = totalRefunded < round2(requested);
    let cappedReason: string | null = null;
    if (chunkError) {
      cappedReason = `Refunded $${totalRefunded.toFixed(2)} before hitting an error on the rest: ${chunkError}`;
    } else if (capped) {
      cappedReason = stripeCapacity < Math.min(requested, walletAvailable)
        ? "Capped — the rest of this balance came from cash/manual deposits and must be refunded that way."
        : "Capped to what was left available.";
    }

    console.log(`[stripe-canteen-refund] Refunded $${totalRefunded} for ${camperName} (camp ${authedCampId}) across ${refunds.length} deposit(s)${capped ? " (capped)" : ""}`);

    return json({ totalRefunded, requested: round2(requested), capped, cappedReason, refunds, uncertain: chunkUncertain || undefined });
  } catch (err) {
    console.error("[stripe-canteen-refund] Error:", (err as Error).message);
    return json({ error: (err as Error).message }, 500);
  }
});
