// =============================================================================
// stripe-canteen-refund-all — Refund EVERY camper's leftover canteen balance
// in one action, instead of the office going camper-by-camper.
//
// Same underlying per-camper apportionment logic as stripe-canteen-refund
// (draw from that camper's Stripe deposits oldest-first, cap at the lower of
// wallet balance and Stripe-refundable capacity) — just run once per camper
// who actually has money left, with modest concurrency so a camp with a
// large roster doesn't take forever. Deliberately NOT shared code with
// stripe-canteen-refund (this repo doesn't use a _shared/ import convention
// for edge functions — every function here is self-contained by design, see
// stripe-canteen-refund's own header comment on why duplication was chosen
// over chaining an HTTP call).
//
// Auth: requires the caller's real Supabase session JWT, owner/admin only —
// same as every other money-moving action in this app. The acting camp is
// derived EXCLUSIVELY from that session's own owner/admin membership, never
// from a client-supplied campId.
//
// A camper is SKIPPED (not an error) when they have nothing refundable —
// either a zero/spent balance, or a balance that came entirely from a
// cash/manual deposit (no PaymentIntent behind it, nothing for Stripe to
// refund). A camper only counts as FAILED if a Stripe call for them actually
// errored — one camper failing does not stop the rest from processing.
//
// Request:  {}  (no body needed — acts on every camper in this camp)
//           header: Authorization: Bearer <caller's Supabase access token>
// Response: { totalRefunded, refundedCount, skippedCount, failedCount, details: [...] }
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STRIPE_SECRET = Deno.env.get("STRIPE_SECRET_KEY");
const STRIPE_API = "https://api.stripe.com/v1";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const SENDER_ROLES = ["owner", "admin"];

// How many campers to refund in parallel. Each camper may involve several
// sequential Stripe calls of its own (one PI fetch + one refund per deposit
// drawn from), so this caps total concurrent Stripe requests at a
// reasonable level rather than firing the whole roster at once.
const CONCURRENCY = 4;

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

// A child whose canteen money has just been refunded has their auto-reload
// switched off (TED-143): otherwise the next run tops the emptied wallet back
// up from the parent's card — the day after the end-of-season Refund All, and
// every week after. The parent's Link page shows why and can switch it back on.
async function pauseAutoReload(supabase: ReturnType<typeof createClient>, campId: string,
                               camperId: number | null, camperName: string, acct: Record<string, any> | undefined) {
  const ar = acct && acct.autoReload;
  if (!ar || ar.enabled !== true) return;
  const next = Object.assign({}, ar, {
    enabled: false,
    disabledAt: new Date().toISOString(),
    disabledReason: "switched off when the camp refunded the canteen balance — switch it back on if you still want it",
  });
  const { error } = await supabase.rpc("update_canteen_autoreload_state", {
    p_camp_id: campId, p_camper_name: camperName, p_camper_id: camperId, p_autoreload: next });
  if (error) console.warn(`[canteen-refund] could not switch off auto-reload for ${camperName}: ${error.message}`);
}

// The ledger, indexed ONCE per run (TED-139): each top-up used to re-scan the
// whole ledger for its refunds, and the holds for what is on its way — at 1,000
// children × 15 top-ups that was ~3 s of CPU, over Supabase's limit for a
// function, and the Snacks page then fell back to its week-only figure. The
// same rules as before, by camper number (a row with no number: by name).
type LedgerIndex = {
  byId: Map<string, Record<string, any>[]>;
  byName: Map<string, Record<string, any>[]>;
  byNameNoId: Map<string, Record<string, any>[]>;
  refunded: Map<string, number>;   // refunds from each payment, less ones failed and put back (278)
  held: Map<string, number>;       // refunds of each payment on their way (275)
};
const __ledgerIndexes = new WeakMap<object, WeakMap<object, Map<string, LedgerIndex>>>();
function ledgerIndex(transactions: Record<string, any>[], holds: Record<string, any>[], method: string, idField: string): LedgerIndex {
  let byHolds = __ledgerIndexes.get(transactions);
  if (!byHolds) { byHolds = new WeakMap(); __ledgerIndexes.set(transactions, byHolds); }
  let cached = byHolds.get(holds);
  if (!cached) { cached = new Map(); byHolds.set(holds, cached); }
  const hit = cached.get(method + "|" + idField);
  if (hit) return hit;
  const idx: LedgerIndex = { byId: new Map(), byName: new Map(), byNameNoId: new Map(), refunded: new Map(), held: new Map() };
  const add = (m: Map<string, Record<string, any>[]>, k: string, v: Record<string, any>) => { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); };
  const bump = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) || 0) + n);
  for (const t of transactions) {
    if (!t) continue;
    if (t.kind === "deposit" && t.method === method && t[idField]) {
      if (t.camperId != null) add(idx.byId, String(t.camperId), t); else add(idx.byNameNoId, String(t.camper), t);
      add(idx.byName, String(t.camper), t);
    } else if (t.kind === "refund" && t[idField]) {
      bump(idx.refunded, String(t[idField]), Number(t.amount) || 0);
    } else if (t.kind === "refund_failed" && t[idField]) {
      bump(idx.refunded, String(t[idField]), -(Number(t.amount) || 0));
    }
  }
  for (const h of holds) {
    if (h && h.method === method && h.paymentRef) bump(idx.held, String(h.paymentRef), Number(h.amount) || 0);
  }
  cached.set(method + "|" + idField, idx);
  return idx;
}
// A child's top-ups: by number when both carry one, by name when either has none.
function depositsOf(idx: LedgerIndex, camperId: number | null, name: string): Record<string, any>[] {
  if (camperId != null) return (idx.byId.get(String(camperId)) || []).concat(idx.byNameNoId.get(String(name)) || []);
  return idx.byName.get(String(name)) || [];
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
  if (out && typeof out === "object" && !out.error) {
    // Stripe marks an answer repeated from its memory of the key (TED-126).
    try { out.__replayed = resp.headers?.get?.("Idempotent-Replayed") === "true"; } catch (_) { /* no headers */ }
  }
  return out;
}

async function stripeGet(endpoint: string) {
  const resp = await fetch(`${STRIPE_API}${endpoint}`, { headers: { Authorization: `Bearer ${STRIPE_SECRET}` } });
  return resp.json();
}

// Stripe keeps each Idempotency-Key's first answer for 24 hours and answers a
// repeat from that memory. A refund it made under the key and has since FAILED
// (the parent's card account closed, say) comes back as it was then —
// "succeeded" — with nothing sent (TED-126). So a repeated answer is checked
// against the refund as it is NOW, and a failed one moves the key on, to one
// made from the failed refund's own id: the same new key again if this send is
// itself cut off and repeated, and a newer one still if that one fails too.
async function sendRefund(params: Record<string, string>, key: string): Promise<any> {
  let k = key;
  for (let i = 0; i < 5; i++) {
    const out = await stripePost("/refunds", params, k);
    if (!out || out.error || !out.id) return out;
    const replayed = out.__replayed === true
      || (Number(out.created) > 0 && Date.now() - Number(out.created) * 1000 > 120000);
    if (!replayed) return out;
    let now: any = null;
    try { now = await stripeGet(`/refunds/${encodeURIComponent(String(out.id))}`); } catch (_) { now = null; }
    if (!now || now.error || !now.id) {
      return { error: { message: "Stripe did not say what became of this refund." }, __definite: false };
    }
    if (now.status !== "failed" && now.status !== "canceled") return now;
    k = `${key}_after_${now.id}`;
  }
  return { error: { message: "This refund has failed at Stripe five times — refund it by hand." }, __definite: true };
}

// The refund Stripe has for this reservation, if any: one still standing is
// the answer; only when every refund carrying the key has failed is it "failed"
// (a failed one is sent again under a new key, with the same key in metadata).
function refundForHold(list: any[], key: string): any {
  const tagged = list.filter((r: any) => r && r.metadata && r.metadata.campistryHold === key);
  return tagged.find((r: any) => r.status !== "failed" && r.status !== "canceled") || tagged[0] || null;
}

// Copied verbatim from stripe-charge/index.ts (and stripe-canteen-refund) —
// resolves the camp the AUTHENTICATED caller actually belongs to as
// owner/admin. This, not any client-supplied value, is the only campId
// ever trusted for this action.
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

type DepositRemainder = { paymentIntentId: string; remaining: number; timestamp: number };

// Everything this camper's Stripe deposits can still be refunded from,
// oldest first — same math as stripe-canteen-refund's per-request version.
function depositsFor(who: { camperId: number | null; camperName: string }, transactions: Record<string, any>[], holds: Record<string, any>[] = []): DepositRemainder[] {
  // By camper ID when the account has one (250): the account's key is the
  // spelling at the time, and a renamed or same-named child shares spellings.
  // The name is compared only when the account or the ledger row has no number.
  // What is already refunded from each (less a refund that failed later and was
  // put back, TED-126), and what another refund has on its way from it (275) —
  // from one index of the ledger per run (TED-139).
  const idx = ledgerIndex(transactions, holds, "stripe", "stripePaymentIntentId");
  return depositsOf(idx, who.camperId, who.camperName)
    .map((dep) => {
      const ref = String(dep.stripePaymentIntentId);
      return { paymentIntentId: ref, remaining: round2((Number(dep.amount) || 0) - (idx.refunded.get(ref) || 0) - (idx.held.get(ref) || 0)), timestamp: Number(dep.timestamp) || 0 };
    })
    .filter((d) => d.remaining > 0)
    .sort((a, b) => a.timestamp - b.timestamp);
}

async function refundOneCamper(
  supabase: ReturnType<typeof createClient>,
  campId: string,
  who: { camperId: number | null; camperName: string },
  walletAvailable: number,
  transactions: Record<string, any>[],
  holds: Record<string, any>[] = [],
): Promise<{ camperId: number | null; camperName: string; refunded: number; skipped?: string; error?: string }> {
  const { camperId, camperName } = who;
  const deposits = depositsFor(who, transactions, holds);
  const stripeCapacity = round2(deposits.reduce((sum, d) => sum + d.remaining, 0));
  const targetAmount = round2(Math.min(walletAvailable, stripeCapacity));

  // An earlier refund of this child's money Stripe has still not answered,
  // even when asked again at the start of this run (275): its money stays off
  // the wallet, and the office is told.
  const mineHold = (h: Record<string, any>) => (camperId != null && h.camperId != null) ? String(h.camperId) === String(camperId) : h.accountKey === camperName;
  const stale = holds.filter((h) => mineHold(h) && Number(h.ageSeconds) >= 180);
  const staleAmt = round2(stale.reduce((t, h) => t + (Number(h.amount) || 0), 0));
  const staleNote = stale.length
    ? `An earlier refund of $${staleAmt.toFixed(2)} for this child has not been confirmed by Stripe yet — check the Stripe dashboard; it is asked again on the next run.`
    : null;

  if (targetAmount <= 0) {
    if (staleNote) return { camperId, camperName, refunded: 0, error: staleNote };
    return {
      camperId, camperName,
      refunded: 0,
      skipped: stripeCapacity <= 0 ? "no Stripe-paid deposits (cash/manual only)" : "nothing available",
    };
  }

  let remainingToRefund = targetAmount;
  let refunded = 0;
  for (const dep of deposits) {
    if (remainingToRefund <= 0) break;
    let chunk = round2(Math.min(dep.remaining, remainingToRefund));
    if (chunk <= 0) continue;

    try {
      const pi = await stripeGet(`/payment_intents/${dep.paymentIntentId}`);
      if (pi.error) throw new Error(pi.error.message);

      // What is still refundable is part of the key (TED-097): a second refund of
      // the same amount later is a NEW refund, while a retry of this one after a
      // lost answer repeats the key and Stripe answers with the refund it made.
      const stripeKeyFor = (amt: number) => `canteen_refund_${dep.paymentIntentId}_${Math.round(dep.remaining * 100)}_${Math.round(amt * 100)}`;
      const holdKeyFor = (amt: number) => `scanteen:${dep.paymentIntentId}:${Math.round(dep.remaining * 100)}:${Math.round(amt * 100)}`;
      // TAKE THE MONEY OFF THE WALLET FIRST (275, TED-110), at this child's
      // turn and in one locked step — not from the balances read when the run
      // started. A refund of this child from another computer, or a sale, since
      // then is seen here; whichever reserves first has the money.
      const reserve = (amt: number) => supabase.rpc("reserve_canteen_refund", {
        p_camp_id: campId, p_camper_id: camperId, p_camper_name: camperName,
        p_hold_key: holdKeyFor(amt), p_amount: amt, p_method: "stripe", p_payment_ref: dep.paymentIntentId,
        p_stripe_key: stripeKeyFor(amt) });
      let { data: held, error: holdErr } = await reserve(chunk);
      if (!holdErr && held && held.success === false && held.error === "insufficient") {
        const avail = round2(Number(held.available) || 0);
        if (avail <= 0) {
          if (refunded > 0 || staleNote) break;
          return { camperId, camperName, refunded, skipped: "the balance changed during the run (another refund or a sale took it)" };
        }
        chunk = round2(Math.min(chunk, avail));
        ({ data: held, error: holdErr } = await reserve(chunk));
      }
      if (holdErr || !held || held.success !== true) {
        throw new Error("Could not set this child's refund money aside, so nothing was sent: " + (holdErr?.message || held?.error || "no answer"));
      }
      if (held.existing && held.state === "posted") continue;          // this exact refund is already done
      if (held.existing) chunk = round2(Number(held.amount) || chunk);   // its reservation decides the amount
      const holdKey = holdKeyFor(chunk);

      // The reservation's key rides along, so the refund can be found among the
      // payment's refunds if its answer is lost (TED-117).
      const params: Record<string, string> = {
        payment_intent: dep.paymentIntentId,
        amount: String(Math.round(chunk * 100)),
        "metadata[campistryHold]": holdKey,
      };
      if (pi.transfer_data?.destination) params.reverse_transfer = "true";

      let refund: any;
      try {
        refund = await sendRefund(params, stripeKeyFor(chunk));
      } catch (_) {
        // Cut off: Stripe may have made it. The money stays off the wallet, and
        // the next run (or a single refund of this child) asks Stripe again
        // with the same key.
        throw new Error("Stripe did not answer, so this child's refund may have gone through — check the Stripe dashboard; it is asked again on the next run.");
      }
      if (refund.error && !refund.__definite) {
        throw new Error("Stripe did not give a final answer, so this child's refund may have gone through — check the Stripe dashboard; it is asked again on the next run.");
      }
      if (refund.error) {
        // A definite "no": nothing moved, and the money goes back on the wallet.
        await supabase.rpc("release_canteen_refund_hold", { p_camp_id: campId, p_hold_key: holdKey });
        throw new Error(refund.error.message);
      }

      // The refund line goes on the wallet's ledger; the money came off when
      // it was reserved, so the balance does not move again (275).
      const { data: posted, error: postErr } = await supabase.rpc("settle_canteen_refund_hold", {
        p_camp_id: campId, p_hold_key: holdKey, p_refund_id: String(refund.id) });
      if (postErr || !posted || posted.success !== true) console.error(`[stripe-canteen-refund-all] Stripe refund ${refund.id} succeeded but ledger update failed for ${camperName}: ${postErr?.message || posted?.error}`);

      refunded = round2(refunded + chunk);
      remainingToRefund = round2(remainingToRefund - chunk);
    } catch (chunkErr) {
      // Keep whatever succeeded for this camper before the error — real
      // money already moved for those chunks — and report the rest as a
      // partial failure rather than losing track of it.
      return { camperId, camperName, refunded, error: (chunkErr as Error).message };
    }
  }

  return staleNote ? { camperId, camperName, refunded, error: staleNote } : { camperId, camperName, refunded };
}

// Refunds sent on an earlier run (or from a single refund) whose answer never
// came back (275). Looked up in Stripe's own list of that payment's refunds —
// never simply sent again (TED-117): a key is forgotten after 24 hours, so a
// repeat can be a second refund, and a repeat with any detail different is
// refused, which is not a "no". Made: on the ledger. Never made: the money
// goes back on the wallet. Stripe cannot say: still waiting. One not yet a
// couple of minutes old may still be running, and is left alone.
type LookedUp = { made: number; madeAmount: number; notMade: number; notMadeAmount: number };
async function settleWaitingRefunds(supabase: ReturnType<typeof createClient>, campId: string,
                                    holds: Record<string, any>[], transactions: Record<string, any>[],
                                    found: LookedUp): Promise<boolean> {
  let changed = false;
  const booked = new Set<string>(transactions.filter((t) => t && t.stripeRefundId).map((t) => String(t.stripeRefundId)));
  for (const h of holds.filter((x) => x.method === "stripe" && Number(x.ageSeconds) >= 120)) {
    let list: any;
    try { list = await stripeGet(`/refunds?payment_intent=${encodeURIComponent(String(h.paymentRef))}&limit=100`); } catch (_) { continue; }
    if (!list || list.error || !Array.isArray(list.data)) continue;
    const cents = Math.round(Number(h.amount) * 100);
    const sinceMs = Date.parse(String(h.createdAt || "")) || 0;
    const hit = refundForHold(list.data, h.key)
      || list.data.find((r: any) => r && !(r.metadata && r.metadata.campistryHold) && !booked.has(String(r.id))
           && Number(r.amount) === cents && (!sinceMs || Number(r.created) * 1000 >= sinceMs - 300000));
    if (hit && hit.status !== "failed" && hit.status !== "canceled") {
      await supabase.rpc("settle_refund_intent", { p_camp_id: campId, p_key: h.key, p_result: { refundId: hit.id, amount: Number(h.amount) } });
      await supabase.rpc("settle_canteen_refund_hold", { p_camp_id: campId, p_hold_key: h.key, p_refund_id: String(hit.id) });
      booked.add(String(hit.id));
      found.made++; found.madeAmount = round2(found.madeAmount + (Number(h.amount) || 0));
      changed = true;
    } else if (hit || !list.has_more) {
      await supabase.rpc("release_refund_intent", { p_camp_id: campId, p_key: h.key });
      const { data: rel } = await supabase.rpc("release_canteen_refund_hold", { p_camp_id: campId, p_hold_key: h.key });
      if (rel && rel.released) { found.notMade++; found.notMadeAmount = round2(found.notMadeAmount + (Number(h.amount) || 0)); }
      changed = true;
    }
  }
  return changed;
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 1 }, () => worker()));
  return results;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (!STRIPE_SECRET) return json({ error: "Stripe not configured" }, 500);

    const authedCampId = await callerCampId(req);
    if (!authedCampId) return json({ error: "Only camp owners/admins can refund canteen balances." }, 403);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    // canteen_refund_view (migration 250), not get_canteen_accounts: that one
    // decides what to show from the signed-in caller, which the service role is
    // not — it answered not_authorized, so every refund stopped here — and its
    // ledger is a 7-day window. This has every deposit, and each account's id.
    let { data: accountsData, error: acctErr } = await supabase.rpc("canteen_refund_view", { p_camp_id: authedCampId });
    if (acctErr || !accountsData?.success) return json({ error: "Could not read canteen balances." }, 500);
    // What the look-up of refunds still waiting for Stripe found, for the
    // office (TED-135): a run that refunds nobody new still says what it did.
    const lookedUp: LookedUp = { made: 0, madeAmount: 0, notMade: 0, notMadeAmount: 0 };
    if (await settleWaitingRefunds(supabase, authedCampId, Array.isArray(accountsData.holds) ? accountsData.holds : [],
                                   Array.isArray(accountsData.transactions) ? accountsData.transactions : [], lookedUp)) {
      ({ data: accountsData, error: acctErr } = await supabase.rpc("canteen_refund_view", { p_camp_id: authedCampId }));
      if (acctErr || !accountsData?.success) return json({ error: "Could not read canteen balances." }, 500);
    }

    const accounts: Record<string, any> = accountsData.accounts || {};
    const transactions: Record<string, any>[] = accountsData.transactions || [];
    const holds: Record<string, any>[] = Array.isArray(accountsData.holds) ? accountsData.holds : [];

    // Each account with its camper number (250); the account key rides along
    // as the name, for the fallback of an account with no number. A child
    // whose earlier refund Stripe still has not answered is listed too, so the
    // office hears about it (275).
    const candidates = Object.entries(accounts)
      .map(([accountKey, acct]) => {
        const a = acct || {};
        // All of it: a balance floor keeps a child from SPENDING below it; a
        // refund goes to the parent, so the floor is not held back (TED-142).
        const walletAvailable = Math.max(0, round2(Number(a.balance) || 0));
        const who = { camperId: a.camperId != null ? Number(a.camperId) : null, camperName: accountKey };
        const staleHold = holds.some((h) => Number(h.ageSeconds) >= 180 &&
          ((who.camperId != null && h.camperId != null) ? String(h.camperId) === String(who.camperId) : h.accountKey === accountKey));
        return { who, walletAvailable, staleHold };
      })
      .filter((c) => c.walletAvailable > 0 || c.staleHold);

    if (!candidates.length) {
      return json({ totalRefunded: 0, refundedCount: 0, skippedCount: 0, failedCount: 0, details: [], lookedUp });
    }

    const results = await mapWithConcurrency(candidates, CONCURRENCY, (c) =>
      refundOneCamper(supabase, authedCampId, c.who, c.walletAvailable, transactions, holds)
    );

    let totalRefunded = 0, refundedCount = 0, skippedCount = 0, failedCount = 0;
    for (const r of results) {
      if (r.refunded > 0) { totalRefunded = round2(totalRefunded + r.refunded); refundedCount++; }
      if (r.error) failedCount++;
      else if (r.skipped) skippedCount++;
    }
    // The children refunded here have their auto-reload switched off (TED-143).
    for (let i = 0; i < results.length; i++) {
      if (results[i].refunded > 0) {
        const who = candidates[i].who;
        await pauseAutoReload(supabase, authedCampId, who.camperId, who.camperName, accounts[who.camperName]);
      }
    }

    console.log(`[stripe-canteen-refund-all] camp ${authedCampId}: refunded $${totalRefunded} across ${refundedCount} camper(s), ${skippedCount} skipped, ${failedCount} failed`);

    return json({ totalRefunded, refundedCount, skippedCount, failedCount, details: results, lookedUp });
  } catch (err) {
    console.error("[stripe-canteen-refund-all] Error:", (err as Error).message);
    return json({ error: (err as Error).message }, 500);
  }
});
