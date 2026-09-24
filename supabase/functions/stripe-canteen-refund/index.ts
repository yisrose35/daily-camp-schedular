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
  const out = await resp.json();
  // A "no" Stripe stands by is a 4xx it keeps for the key. A 5xx, a 409
  // (the same key still running) or a 429 decides nothing: the refund may
  // yet be made, so it is never treated as declined.
  // idempotency_error (a 400) says only that the key was used with other
  // details — nothing about whether the first refund was made (TED-117).
  if (out && typeof out === "object" && out.error) out.__definite = resp.status >= 400 && resp.status < 500 && resp.status !== 409 && resp.status !== 429
    && out.error.type !== "idempotency_error";
  return out;
}

// The one way a canteen refund is asked of Stripe, so asking again sends the
// very same request. The reservation's key rides along in metadata, so the
// refund can be found among the payment's refunds later (TED-117).
function refundParams(piId: string, cents: number, pi: any, reason: unknown, holdKey: string): Record<string, string> {
  const p: Record<string, string> = { payment_intent: piId, amount: String(cents), "metadata[campistryHold]": holdKey };
  if (reason === "duplicate" || reason === "fraudulent" || reason === "requested_by_customer") p.reason = String(reason);
  if (pi?.transfer_data?.destination) p.reverse_transfer = "true";
  return p;
}

// What became of a canteen refund sent to Stripe whose answer never came back
// (TED-117). Stripe's own list of refunds on that payment says what really
// happened; the refund is NEVER simply sent again after the fact — a key is
// forgotten after 24 hours (a second refund), and a repeat with any detail
// different is refused (a refund that went through read as a "no").
//   made     it went through (or is on its way): refundId
//   failed   Stripe made it and it failed, or said no: nothing moved
//   none     Stripe has no such refund, and nothing is still running
//   unknown  Stripe could not be asked, or it is too soon to say
async function askStripeAbout(h: { piId: string; key: string; cents: number; ageSec: number; sinceMs: number;
                                  stripeKey: string | null; reason?: unknown }, booked: Set<string>)
  : Promise<{ state: "made" | "failed" | "none" | "unknown"; refundId?: string }> {
  let list: any;
  try { list = await stripeGet(`/refunds?payment_intent=${encodeURIComponent(h.piId)}&limit=100`); } catch (_) { return { state: "unknown" }; }
  if (!list || list.error || !Array.isArray(list.data)) return { state: "unknown" };
  const hit = list.data.find((r: any) => r && r.metadata && r.metadata.campistryHold === h.key)
    // a part sent before refunds carried their key: the same amount, not already
    // on a wallet's ledger, made after it was sent
    || list.data.find((r: any) => r && !(r.metadata && r.metadata.campistryHold) && !booked.has(String(r.id))
         && Number(r.amount) === h.cents && (!h.sinceMs || Number(r.created) * 1000 >= h.sinceMs - 300000));
  if (hit) return (hit.status === "failed" || hit.status === "canceled") ? { state: "failed" } : { state: "made", refundId: String(hit.id) };
  if (list.has_more) return { state: "unknown" };
  if (h.ageSec >= 120) return { state: "none" };              // long enough ago: never made
  // Moments ago, so it may still be running: asked again with the SAME key and
  // the SAME details — only then does Stripe answer with the first refund.
  if (!h.stripeKey) return { state: "unknown" };
  let pi: any, again: any;
  try { pi = await stripeGet(`/payment_intents/${h.piId}`); } catch (_) { return { state: "unknown" }; }
  if (!pi || pi.error) return { state: "unknown" };           // the details cannot be rebuilt: don't guess
  try { again = await stripePost("/refunds", refundParams(h.piId, h.cents, pi, h.reason, h.key), h.stripeKey); } catch (_) { return { state: "unknown" }; }
  if (!again.error && again.id) return (again.status === "failed" || again.status === "canceled") ? { state: "failed" } : { state: "made", refundId: String(again.id) };
  return again.__definite ? { state: "failed" } : { state: "unknown" };
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

    const { camperName, camperId: body_camperId, amount, reason, idempotencyKey, action } = await req.json();
    // The camper by ID when the page sent one: the account's key is a spelling.
    const camperIdSent = (body_camperId != null && /^\d+$/.test(String(body_camperId)) && Number(body_camperId) > 0) ? Number(body_camperId) : null;
    if (action !== "holds" && camperIdSent == null && !camperName) return json({ error: "camperId (or camperName) is required" }, 400);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    // Refunds whose answer is still being looked up (275, TED-116), for the
    // office to see. A Stripe one settles itself against Stripe's own list the
    // next time this child is refunded or Refund All runs (TED-117).
    if (action === "holds") {
      const { data: view, error: vErr } = await supabase.rpc("canteen_refund_view", { p_camp_id: authedCampId });
      if (vErr || !view?.success) return json({ error: "Could not read canteen refunds." }, 500);
      return json({ holds: (Array.isArray(view.holds) ? view.holds : []).map((h: Record<string, any>) => ({ key: h.key,
        camperId: h.camperId ?? null, account: h.accountKey, amount: Number(h.amount), method: h.method,
        ageSeconds: Number(h.ageSeconds) || 0, createdAt: h.createdAt })) });
    }
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
    const reqKey = (typeof idempotencyKey === "string" && idempotencyKey.trim()) ? idempotencyKey.trim() : "";
    // the account found above (by number when one was sent), to match a hold with no number
    const acctKey = Object.keys(accountsAll).find((k) => accountsAll[k] === account) ?? "";

    // The refund line goes on the wallet's ledger. Its money came off when it
    // was reserved (275); a part reserved before 275 was in place has no
    // reservation, and is booked the old way.
    const book = async (holdKey: string, piId: string, amt: number, refundId: string) => {
      const { data: posted, error: e1 } = await supabase.rpc("settle_canteen_refund_hold", {
        p_camp_id: authedCampId, p_hold_key: holdKey, p_refund_id: refundId });
      if (!e1 && posted && posted.success === true) return;
      if (posted && posted.error === "no_hold") {
        const { error: e2 } = await supabase.rpc("refund_canteen_deposit_from_stripe", {
          p_camp_id: authedCampId, p_camper_id: camperId, p_camper_name: String(camperName ?? ""),
          p_amount: amt, p_payment_intent_id: piId, p_refund_id: refundId });
        if (!e2) return;
      }
      console.error(`[stripe-canteen-refund] Stripe refund ${refundId} succeeded but ledger update failed: ${e1?.message || posted?.error}`);
    };

    // Refunds of this child's money already on their way (275, TED-110). Each
    // took its money off the wallet before Stripe was asked. This refund's own
    // (an earlier press whose answer was lost) is still its money to send;
    // anyone else's is not. One that has waited is looked up in Stripe's own
    // list of that payment's refunds (TED-117): made — it goes on the ledger;
    // never made — the money goes back on the wallet; Stripe cannot say — it
    // stays on its way.
    const ownPrefix = reqKey ? `scanteen:${reqKey}:` : null;
    let holdsAll: Record<string, any>[] = Array.isArray(accountsData.holds) ? accountsData.holds : [];
    const holdIsMine = (h: Record<string, any>) => (camperId != null && h.camperId != null) ? String(h.camperId) === String(camperId) : h.accountKey === acctKey;
    const isOwn = (h: Record<string, any>) => !!ownPrefix && String(h.key).startsWith(ownPrefix);
    const booked = new Set<string>(((accountsData.transactions || []) as Record<string, any>[])
      .filter((t) => t && t.stripeRefundId).map((t) => String(t.stripeRefundId)));
    let releasedBack = 0;
    for (const h of holdsAll.filter((x) => holdIsMine(x) && !isOwn(x) && x.method === "stripe" && Number(x.ageSeconds) >= 120)) {
      const found = await askStripeAbout({ piId: String(h.paymentRef), key: String(h.key), cents: Math.round(Number(h.amount) * 100),
        ageSec: Number(h.ageSeconds) || 0, sinceMs: Date.parse(String(h.createdAt || "")) || 0, stripeKey: null }, booked);
      if (found.state === "made") {
        await supabase.rpc("settle_refund_intent", { p_camp_id: authedCampId, p_key: h.key, p_result: { refundId: found.refundId, amount: Number(h.amount) } });
        await book(String(h.key), String(h.paymentRef), Number(h.amount), String(found.refundId));
        booked.add(String(found.refundId));
        holdsAll = holdsAll.filter((x) => x !== h);
      } else if (found.state === "failed" || found.state === "none") {
        await supabase.rpc("release_refund_intent", { p_camp_id: authedCampId, p_key: h.key });
        const { data: rel } = await supabase.rpc("release_canteen_refund_hold", { p_camp_id: authedCampId, p_hold_key: h.key });
        if (rel && rel.released) releasedBack = round2(releasedBack + Number(h.amount));
        holdsAll = holdsAll.filter((x) => x !== h);
      }
    }
    const ownHolds = holdsAll.filter((h) => holdIsMine(h) && isOwn(h));
    const otherHolds = holdsAll.filter((h) => holdIsMine(h) && !isOwn(h));
    const walletAvailable = Math.max(0, round2(balance - balanceFloor + releasedBack
      + ownHolds.reduce((t, h) => t + (Number(h.amount) || 0), 0)));
    const heldElsewhere = round2(otherHolds.reduce((t, h) => t + (Number(h.amount) || 0), 0));
    const heldNote = heldElsewhere > 0
      ? `A refund of $${heldElsewhere.toFixed(2)} of this child's money is already on its way to the parent (Refund All, or another computer) and is waiting for Stripe. Check again in a few minutes.`
      : null;

    // What this refund (the page's key) already did on an earlier try whose
    // answer was lost (TED-105): settled parts are counted, never re-split and
    // sent again; a part sent but never confirmed is re-asked with the SAME
    // Stripe key — Stripe answers with the refund it made, or makes it now.
    let priorDone = 0;
    const priorRefunds: Record<string, unknown>[] = [];
    const priorPIs = new Set<string>();
    const requestedAll = amount != null && Number(amount) > 0 ? round2(Number(amount)) : null;
    if (reqKey) {
      const { data: prior } = await supabase.from("refund_intents").select("key, result, settled_at, amount, created_at")
        .eq("camp_id", authedCampId).like("key", `scanteen:${reqKey}:%`);
      for (const c of (Array.isArray(prior) ? prior : [])) {
        const piId = String(c.key).slice(`scanteen:${reqKey}:`.length);
        let amt = c.settled_at && c.result ? Number(c.result.amount) || 0 : 0;
        if (c.settled_at) priorPIs.add(piId);
        if (!c.settled_at) {
          const heldAmt = round2(Number(c.amount) || 0);
          const notYet = "An earlier try at this refund has not been confirmed by Stripe yet, so it may have gone through — wait a minute and check the Stripe dashboard before trying again.";
          const sinceMs = Date.parse(String(c.created_at || "")) || 0;
          const own = holdsAll.find((h) => String(h.key) === String(c.key));
          const ageSec = own ? Number(own.ageSeconds) || 0 : (sinceMs ? (Date.now() - sinceMs) / 1000 : 0);
          // Looked up, never simply sent again (TED-117); cut off while asking
          // is still "may have gone through" (TED-115).
          const found = await askStripeAbout({ piId, key: String(c.key), cents: Math.round(heldAmt * 100), ageSec, sinceMs,
            stripeKey: `canteen_refund_${reqKey}_${piId}`, reason }, booked);
          if (found.state === "unknown") return json({ uncertain: true, error: notYet }, 200);
          if (found.state !== "made") {
            // Never made: nothing moved. The claim and the money go back, and
            // this refund sends it now, below.
            await supabase.rpc("release_refund_intent", { p_camp_id: authedCampId, p_key: c.key });
            await supabase.rpc("release_canteen_refund_hold", { p_camp_id: authedCampId, p_hold_key: c.key });
            continue;
          }
          priorPIs.add(piId);
          await supabase.rpc("settle_refund_intent", { p_camp_id: authedCampId, p_key: c.key,
            p_result: { refundId: found.refundId, amount: heldAmt } });
          await book(String(c.key), piId, heldAmt, String(found.refundId));
          booked.add(String(found.refundId));
          amt = heldAmt;
          priorRefunds.push({ refundId: found.refundId, paymentIntentId: piId, amount: heldAmt });
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
      return json({ error: heldNote || "Nothing available to refund — this balance has already been spent." }, 409);
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
        // what is already refunded from it, and what another refund has on its way from it (275)
        const refundedSoFar = transactions
          .filter((t) => t && t.kind === "refund" && t.stripePaymentIntentId === dep.stripePaymentIntentId)
          .reduce((sum, t) => sum + (Number(t.amount) || 0), 0)
          + holdsAll.filter((h) => h.method === "stripe" && h.paymentRef === dep.stripePaymentIntentId && !isOwn(h))
              .reduce((sum, h) => sum + (Number(h.amount) || 0), 0);
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
      let chunk = round2(Math.min(dep.remaining, remainingToRefund));
      if (chunk <= 0) continue;

      try {
        // Re-fetch the PI to auto-detect whether it was a destination charge
        // (reverse_transfer needed) — mirrors stripe-refund/index.ts. Before
        // anything is reserved or claimed: a failure here has sent nothing.
        const pi = await stripeGet(`/payment_intents/${dep.paymentIntentId}`);
        if (pi.error) throw new Error(pi.error.message);

        // One claim per top-up per refund, taken before Stripe (TED-105).
        const claimKey = reqKey ? `scanteen:${reqKey}:${dep.paymentIntentId}` : "";
        // The Stripe key: the page's key for this refund when it sends one
        // (TED-105), else what is still refundable and the amount (TED-097).
        const stripeKeyFor = (amt: number) => reqKey
          ? `canteen_refund_${reqKey}_${dep.paymentIntentId}`
          : `canteen_refund_${dep.paymentIntentId}_${Math.round(dep.remaining * 100)}_${Math.round(amt * 100)}`;
        const holdKeyFor = (amt: number) => claimKey || `scanteen:${dep.paymentIntentId}:${Math.round(dep.remaining * 100)}:${Math.round(amt * 100)}`;
        // TAKE THE MONEY OFF THE WALLET FIRST (275, TED-110), in one locked
        // step: a second refund for this child — Refund All, another computer —
        // or a sale waits for it and then sees the lower balance. The same
        // refund again meets its own reservation and takes nothing more.
        const reserve = (amt: number) => supabase.rpc("reserve_canteen_refund", {
          p_camp_id: authedCampId, p_camper_id: camperId, p_camper_name: String(camperName ?? acctKey),
          p_hold_key: holdKeyFor(amt), p_amount: amt, p_method: "stripe", p_payment_ref: dep.paymentIntentId,
          p_stripe_key: stripeKeyFor(amt) });
        let { data: held, error: holdErr } = await reserve(chunk);
        if (!holdErr && held && held.success === false && held.error === "insufficient") {
          const avail = round2(Number(held.available) || 0);
          if (avail <= 0) throw new Error(heldNote || "The wallet changed while this refund was being made — another refund or a sale took the money first. Nothing more was refunded; reload to see the balance.");
          chunk = round2(Math.min(chunk, avail));
          ({ data: held, error: holdErr } = await reserve(chunk));
        }
        if (holdErr || !held || held.success !== true) {
          throw new Error("Could not set this refund's money aside, so nothing was sent: " + (holdErr?.message || held?.error || "no answer"));
        }
        if (held.existing && held.state === "posted" && held.refundId) {
          const doneAmt = round2(Number(held.amount) || chunk);
          refunds.push({ refundId: held.refundId, paymentIntentId: dep.paymentIntentId, amount: doneAmt });
          totalRefunded = round2(totalRefunded + doneAmt);
          remainingToRefund = round2(remainingToRefund - doneAmt);
          continue;
        }
        if (held.existing) chunk = round2(Number(held.amount) || chunk);   // its reservation decides the amount
        const holdKey = holdKeyFor(chunk);
        if (claimKey) {
          const { data: cl } = await supabase.rpc("claim_refund_intent", {
            p_camp_id: authedCampId, p_key: claimKey, p_amount: chunk, p_payment_ref: dep.paymentIntentId });
          if (cl && cl.claimed === false) {
            // Another press of THIS refund has this top-up (TED-109). Done:
            // count it. Still going: stop — never move on to the next top-up
            // and refund the same money from there.
            if (cl.previous && cl.previous.refundId) {
              const doneAmt = round2(Number(cl.previous.amount) || chunk);
              await book(holdKey, dep.paymentIntentId, doneAmt, String(cl.previous.refundId));
              refunds.push({ refundId: cl.previous.refundId, paymentIntentId: dep.paymentIntentId, amount: doneAmt });
              totalRefunded = round2(totalRefunded + doneAmt);
              remainingToRefund = round2(remainingToRefund - doneAmt);
              continue;
            }
            throw Object.assign(new Error("This refund is being sent right now — wait a moment and check the child's wallet before trying again."), { uncertain: true });
          }
        }
        const params = refundParams(dep.paymentIntentId, Math.round(chunk * 100), pi, reason, holdKey);

        // What is still refundable is part of the key (TED-097): a second refund of
      // the same amount later is a NEW refund, while a retry of this one after a
      // lost answer repeats the key and Stripe answers with the refund it made.
      // The page's key for this refund when it sends one (TED-105): a retry of
      // the same refund repeats it, so Stripe answers with the refund it made.
      let refund: any;
      try {
        refund = await stripePost("/refunds", params, stripeKeyFor(chunk));
      } catch (e) {
        // Cut off: Stripe may have made it. The claim stays open, and the next
        // press re-asks with the same key, which Stripe answers with the refund
        // it made — so this is "check first", never a plain failure (TED-109).
        throw Object.assign(new Error("Stripe did not answer, so this refund may have gone through. Check the child's wallet before trying again."), { uncertain: true });
      }
        if (refund.error && !refund.__definite) {
          // Stripe's own trouble, or the same key still running: undecided.
          throw Object.assign(new Error("Stripe did not give a final answer, so this refund may have gone through. Check the child's wallet before trying again."), { uncertain: true });
        }
        if (refund.error) {
          // A definite "no": nothing moved. The claim and the money go back.
          if (claimKey) await supabase.rpc("release_refund_intent", { p_camp_id: authedCampId, p_key: claimKey });
          await supabase.rpc("release_canteen_refund_hold", { p_camp_id: authedCampId, p_hold_key: holdKey });
          throw new Error(refund.error.message);
        }
        if (claimKey) {
          await supabase.rpc("settle_refund_intent", { p_camp_id: authedCampId, p_key: claimKey,
            p_result: { refundId: refund.id, amount: chunk } });
        }

        await book(holdKey, dep.paymentIntentId, chunk, String(refund.id));

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
    } else if (capped && heldNote) {
      cappedReason = `Refunded $${totalRefunded.toFixed(2)}. ${heldNote}`;
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
