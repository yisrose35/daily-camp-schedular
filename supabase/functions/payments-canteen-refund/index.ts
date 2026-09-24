// =============================================================================
// payments-canteen-refund — BYOP equivalent of stripe-canteen-refund: refund
// a camper's canteen balance back to the parent, in ONE requested dollar
// amount, apportioned across as many of the camper's BYOP-backed deposits as
// needed (oldest first) — same reasoning as stripe-canteen-refund's own
// header comment (a wallet is fungible; the office shouldn't have to pick
// one deposit and repeat the action until a target total is reached).
//
// Auth: requires the caller's real Supabase session JWT, owner/admin only —
// callerCampId copied verbatim from payments-refund/stripe-canteen-refund.
// The acting camp is derived EXCLUSIVELY from that session, never a
// client-supplied campId.
//
// A refund is capped at THE LOWEST of three ceilings, same as
// stripe-canteen-refund:
//   1. whatever's still unspent in the camper's canteen wallet
//      (the whole balance — a balanceFloor limits spending, not a refund
//      to the parent, TED-142)
//   2. the total still refundable across the camper's BYOP deposits FOR
//      THE CAMP'S CURRENT PROCESSOR (each deposit's original amount minus
//      whatever's already been refunded from it)
//   3. the amount actually requested (or, if omitted, ceiling 1)
// Ceiling 2 can be below ceiling 1 when some of the balance came from a
// manual/cash deposit, a Stripe deposit from before a processor switch, or
// a deposit on a DIFFERENT BYOP processor than the camp is on now — none of
// those have anything here to refund them from; the response says so.
//
// Request:  { camperName, amount?, reason? }
//           header: Authorization: Bearer <caller's Supabase access token>
// Response: { totalRefunded, requested, capped, cappedReason?, refunds: [...] }
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// Cardknox/Sola refund, inlined so this function is self-contained and
// Dashboard-deployable (no CLI / ../_shared bundling). Mirrors
// _shared/adapters/cardknox_adapter.ts's refund().
const CARDKNOX_GATEWAY = "https://x1.cardknox.com/gateway";
async function cardknoxRefund(
  credentials: Record<string, string>,
  externalTransactionId: string,
  amountCents: number,
): Promise<{ success: boolean; uncertain?: boolean; externalTransactionId?: string; status?: string; error?: string; raw?: unknown }> {
  const apiKey = credentials.apiKey;
  if (!apiKey) return { success: false, error: "Missing apiKey" };
  try {
    const resp = await fetch(CARDKNOX_GATEWAY, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        xKey: apiKey, xVersion: "4.5.9", xSoftwareName: "Campistry", xSoftwareVersion: "1.0",
        xCommand: "cc:refund", xRefNum: externalTransactionId, xAmount: (amountCents / 100).toFixed(2),
      }).toString(),
    });
    const text = await resp.text();
    const r: Record<string, string> = {};
    new URLSearchParams(text).forEach((v, k) => { r[k] = v; });
    // No result at all is not a "no" (TED-093): the gateway may have refunded.
    if (!r.xResult) return { success: false, uncertain: true, error: "No answer from the card company (HTTP " + resp.status + ")", raw: r };
    if (r.xResult !== "A") return { success: false, status: r.xStatus, error: r.xError || "Refund failed", raw: r };
    return { success: true, externalTransactionId: r.xRefNum, status: r.xStatus, raw: r };
  } catch (err) {
    return { success: false, uncertain: true, error: (err as Error).message };   // cut off: may have moved money (TED-093)
  }
}

// Banquest (AffiniPay/8am) reversal of a prior transaction — the convenience
// endpoint that auto-picks refund (settled) vs void (unsettled). Inlined for
// the same Dashboard-deploy reason; keep in sync with
// _shared/adapters/banquest_adapter.ts. Auth is HTTP Basic base64(sourceKey:
// pin); API base is per-camp and lives under /api/v2; amounts are DOLLARS;
// the prior transaction is referenced by its integer `reference_number`
// (NOT a "ref-" source string — that prefix is only for charging a stored
// transaction's card again, not for reversing it).
const BANQUEST_DEFAULT_BASE = "https://api.banquestgateway.com/api/v2";
function bqBase(credentials: Record<string, string>): string {
  // A stored gatewayUrl that already ends in /v2 or /api/v2 is used verbatim;
  // a bare host gets /api/v2 appended. Both spellings are honoured on purpose:
  // the API reference documents the base as /api/v2, while the Hosted
  // Tokenization guide's own backend example posts to /v2 — so whichever path
  // the camp actually stores is the one we call.
  let b = (credentials.gatewayUrl || BANQUEST_DEFAULT_BASE).replace(/\/+$/, "");
  if (!/\/(api\/)?v\d+$/i.test(b)) b += "/api/v2";
  return b;
}
async function banquestRefund(
  credentials: Record<string, string>,
  externalTransactionId: string,
  amountCents: number,
): Promise<{ success: boolean; uncertain?: boolean; externalTransactionId?: string; status?: string; error?: string; raw?: unknown }> {
  if (!credentials.sourceKey || !credentials.pin) return { success: false, error: "Missing sourceKey/pin" };
  const refNum = Number(externalTransactionId);
  if (!Number.isFinite(refNum)) return { success: false, error: "Original transaction reference is not a valid Banquest reference_number." };
  try {
    const resp = await fetch(`${bqBase(credentials)}/transactions/reversal`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Basic " + btoa(`${credentials.sourceKey}:${credentials.pin}`) },
      body: JSON.stringify({ reference_number: refNum, amount: Number((amountCents / 100).toFixed(2)) }),
    });
    let data: Record<string, any> = {};
    try { data = await resp.json(); } catch { /* non-JSON error body */ }
    // Success = an "A" status_code (or "Approved"/"Voided" status word); the
    // new reversal transaction's own reference_number is what we record.
    const code = String(data?.status_code || "").toUpperCase();
    const st = String(data?.status || "").toLowerCase();
    const ok = code === "A" || /approv|void|refund/.test(st);
    const newRef = data?.reference_number != null ? String(data.reference_number) : (data?.transaction?.id ? String(data.transaction.id) : "");
    if (resp.status >= 500 && !newRef) {
      return { success: false, uncertain: true, error: `No answer from the card company (HTTP ${resp.status})`, raw: data };
    }
    if (resp.status < 200 || resp.status >= 300 || !ok || !newRef) {
      const errMsg = data?.error_message || (Array.isArray(data?.error_messages) && data.error_messages[0]) || data?.error_details || data?.error || data?.message || data?.status || `Refund failed (HTTP ${resp.status})`;
      return { success: false, status: data?.status, error: errMsg, raw: data };
    }
    return { success: true, externalTransactionId: newRef, status: data?.status, raw: data };
  } catch (err) {
    return { success: false, uncertain: true, error: (err as Error).message };   // cut off: may have moved money (TED-093)
  }
}

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

// What each child can be refunded to a card right now, worked out from the
// FULL ledger (TED-130): the Snacks page loads only a week of history (245), so
// it cannot work this out itself — a top-up from July read as "$0.00
// refundable" in August. The same maths as a refund of that child: the wallet
// (less its floor) against what the child's top-ups on this processor still
// have — less what is already refunded from them (a refund that failed and was
// put back, 278, counts as not refunded) and what another refund has on its way.
function refundableByAccount(view: Record<string, any>, method: string, idField: string): Record<string, unknown> {
  const txs: Record<string, any>[] = Array.isArray(view.transactions) ? view.transactions : [];
  const holds: Record<string, any>[] = Array.isArray(view.holds) ? view.holds : [];
  const idx = ledgerIndex(txs, holds, method, idField);
  const out: Record<string, unknown> = {};
  for (const [key, a] of Object.entries((view.accounts || {}) as Record<string, any>)) {
    const acct = a || {};
    const cid = acct.camperId != null ? Number(acct.camperId) : null;
    let card = 0;
    for (const dep of depositsOf(idx, cid, key)) {
      const ref = String(dep[idField]);
      card += Math.max(0, round2((Number(dep.amount) || 0) - (idx.refunded.get(ref) || 0) - (idx.held.get(ref) || 0)));
    }
    // the whole balance: the floor limits spending, not a refund to the parent (TED-142)
    const wallet = Math.max(0, round2(Number(acct.balance) || 0));
    out[key] = { camperId: cid, wallet, card: round2(card), now: round2(Math.min(wallet, card)) };
  }
  return out;
}

// Copied verbatim from payments-refund/index.ts.
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

  const { data: ownedCamps } = await asUser.from("camps").select("id").eq("owner", uid);
  const owned = Array.isArray(ownedCamps) && ownedCamps.length
    ? (ownedCamps.find((c: { id: string }) => c.id === uid) || ownedCamps[0])
    : null;
  if (owned?.id) return owned.id;

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
    const authedCampId = await callerCampId(req);
    if (!authedCampId) return json({ error: "Only camp owners/admins can refund a canteen deposit." }, 403);

    const { camperName, camperId: body_camperId, amount, reason, idempotencyKey, confirmNotRefunded, confirmHolds,
            action, holdKey, wentThrough, reference } = await req.json();
    // The camper by ID when the page sent one: the account's key is a spelling.
    const camperIdSent = (body_camperId != null && /^\d+$/.test(String(body_camperId)) && Number(body_camperId) > 0) ? Number(body_camperId) : null;
    if (!action && camperIdSent == null && !camperName) return json({ error: "camperId (or camperName) is required" }, 400);

    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // ── refunds the card company never answered (275, TED-116) ─────────────
    // Their money is held off the wallet. Only the office can say, from the
    // processor's dashboard, what happened: these two actions list them and
    // settle one either way.
    if (action === "holds" || action === "resolveHold") {
      const { data: view, error: vErr } = await service.rpc("canteen_refund_view", { p_camp_id: authedCampId });
      if (vErr || !view?.success) return json({ error: "Could not read canteen refunds." }, 500);
      const open: Record<string, any>[] = Array.isArray(view.holds) ? view.holds : [];
      if (action === "holds") {
        const { data: campRow } = await service.from("camps").select("payment_processor_key").eq("id", authedCampId).maybeSingle();
        const proc = String(campRow?.payment_processor_key || "");
        return json({ holds: open.map((h) => ({ key: h.key, camperId: h.camperId ?? null, account: h.accountKey,
          amount: Number(h.amount), method: h.method, ageSeconds: Number(h.ageSeconds) || 0, createdAt: h.createdAt })),
          processor: proc,
          refundable: (proc === "cardknox" || proc === "banquest") ? refundableByAccount(view, proc, "byopTransactionId") : {} });
      }
      const h = open.find((x) => String(x.key) === String(holdKey || ""));
      if (!h) return json({ error: "That refund was already settled." }, 409);
      if (h.method === "stripe") {
        return json({ error: "A Stripe refund is settled from Stripe's own records — refund this child again (or run Refund All) and it is looked up." }, 409);
      }
      if (wentThrough === true) {
        const ref = String(reference ?? "").trim();
        if (!ref) return json({ error: "The card company's reference for the refund is needed." }, 400);
        // A reference already on a wallet's ledger belongs to another refund:
        // taking it would put this child's money back (a refund counted once
        // for two) — refused rather than guessed.
        const used = (Array.isArray(view.transactions) ? view.transactions : [])
          .some((t: Record<string, any>) => t && (String(t.byopRefundId || "") === ref || String(t.stripeRefundId || "") === ref));
        if (used) return json({ error: "That reference is already recorded for another refund. Check it in the processor's dashboard." }, 409);
        const { data: posted, error: pErr } = await service.rpc("settle_canteen_refund_hold", {
          p_camp_id: authedCampId, p_hold_key: h.key, p_refund_id: ref });
        if (pErr || !posted?.success) return json({ error: "Could not record it: " + (pErr?.message || posted?.error || "no answer") }, 500);
        await service.rpc("settle_refund_intent", { p_camp_id: authedCampId, p_key: h.key,
          p_result: { success: true, externalTransactionId: ref, amount: Number(h.amount), confirmedBy: "office" } });
        return json({ settled: true, balance: posted.balance });
      }
      if (wentThrough === false) {
        // Only one that has waited: never one still on its way.
        const { data: rel } = await service.rpc("release_canteen_refund_hold", {
          p_camp_id: authedCampId, p_hold_key: h.key, p_min_age: "3 minutes" });
        if (!rel?.released) {
          return json({ error: rel?.error === "too_new"
            ? "This refund was sent a moment ago and may still be going through. Wait a few minutes, check the processor's dashboard, then answer."
            : "That refund was already settled." }, 409);
        }
        await service.rpc("release_stale_refund_intent", { p_camp_id: authedCampId, p_key: h.key });
        return json({ released: true, balance: rel.balance });
      }
      return json({ error: "Say whether it went through." }, 400);
    }

    const { data: camp } = await service.from("camps").select("payment_processor_key").eq("id", authedCampId).maybeSingle();
    const processorKey = camp?.payment_processor_key;
    if (!processorKey || processorKey === "stripe") {
      return json({ error: "This camp is on Stripe — use stripe-canteen-refund instead." }, 400);
    }

    if (processorKey !== "cardknox" && processorKey !== "banquest") return json({ error: `Refunds aren't supported yet for processor '${processorKey}'.` }, 400);

    const { data: credResult } = await service.rpc("_admin_get_processor_credential", { p_camp_id: authedCampId });
    if (!credResult?.success) return json({ error: credResult?.error || "This camp's processor isn't connected/verified yet." }, 400);

    // canteen_refund_view (migration 250), not get_canteen_accounts: that one
    // decides what to show from the signed-in caller, which the service role is
    // not — it answered not_authorized, so every refund stopped here — and its
    // ledger is a 7-day window. This has every deposit, and each account's id.
    const { data: accountsData, error: acctErr } = await service.rpc("canteen_refund_view", { p_camp_id: authedCampId });
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
    const reqKey = (typeof idempotencyKey === "string" && idempotencyKey.trim()) ? idempotencyKey.trim() : "";
    // the account found above (by number when one was sent), to match a hold with no number
    const acctKey = Object.keys(accountsAll).find((k) => accountsAll[k] === account) ?? "";

    // Refunds of this child's money already on their way (275, TED-110): each
    // took its money off the wallet before the card company was asked. This
    // refund's own (an earlier press whose answer was lost) is still its money
    // to send, so it counts as available; anyone else's is not.
    const ownPrefix = reqKey ? `canteen:${reqKey}:` : null;
    const holdsAll: Record<string, any>[] = Array.isArray(accountsData.holds) ? accountsData.holds : [];
    const holdIsMine = (h: Record<string, any>) => (camperId != null && h.camperId != null) ? String(h.camperId) === String(camperId) : h.accountKey === acctKey;
    const ownHolds = holdsAll.filter((h) => holdIsMine(h) && ownPrefix && String(h.key).startsWith(ownPrefix));
    let otherHolds = holdsAll.filter((h) => holdIsMine(h) && !(ownPrefix && String(h.key).startsWith(ownPrefix)));
    const STALE_SECONDS = 180;

    // "Nothing went through" (the office checked the processor): exactly the
    // earlier refunds of this child's money it was asked about (confirmHolds)
    // go back on the wallet — only ones that have waited, never one on its way.
    let releasedBack = 0;
    const asked = new Set<string>(Array.isArray(confirmHolds) ? confirmHolds.map((k: unknown) => String(k)) : []);
    if (confirmNotRefunded === true && asked.size) {
      for (const h of otherHolds.filter((x) => Number(x.ageSeconds) >= STALE_SECONDS && asked.has(String(x.key)))) {
        const { data: rel } = await service.rpc("release_canteen_refund_hold", {
          p_camp_id: authedCampId, p_hold_key: h.key, p_min_age: "3 minutes" });
        if (rel && rel.released) {
          await service.rpc("release_stale_refund_intent", { p_camp_id: authedCampId, p_key: h.key });
          releasedBack = round2(releasedBack + (Number(rel.amount) || Number(h.amount) || 0));
          otherHolds = otherHolds.filter((x) => x !== h);
        }
      }
    }
    // the whole balance: a floor limits SPENDING, not a refund to the parent (TED-142)
    const walletAvailable = Math.max(0, round2(balance
      + ownHolds.reduce((t, h) => t + (Number(h.amount) || 0), 0) + releasedBack));

    // What this refund (the page's key) already did, on an earlier try whose
    // answer was lost (TED-105). Settled parts are counted — not re-split
    // against today's remaining and sent again — and a part that was sent and
    // never confirmed stops everything until the office has looked.
    let priorDone = 0;
    const priorRefunds: Record<string, unknown>[] = [];
    const priorDeposits = new Set<string>();
    const priorSettled = new Set<string>();
    if (reqKey) {
      const { data: prior } = await service.from("refund_intents").select("key, result, settled_at")
        .eq("camp_id", authedCampId).like("key", `canteen:${reqKey}:%`);
      for (const c of (Array.isArray(prior) ? prior : [])) {
        const dep = String(c.key).slice(`canteen:${reqKey}:`.length);
        priorDeposits.add(dep);
        if (c.settled_at) priorSettled.add(dep);
        if (c.settled_at && c.result && Number(c.result.amount) > 0) {
          priorDone = round2(priorDone + Number(c.result.amount));
          priorRefunds.push({ refundId: c.result.externalTransactionId, externalTransactionId: dep, amount: Number(c.result.amount) });
        } else if (!c.settled_at && confirmNotRefunded !== true) {
          return json({ uncertain: true, error: "An earlier try at this refund was never confirmed by the card company. Check the processor's dashboard: if it is not there, confirm and it will be sent." }, 200);
        }
      }
    }
    const requestedAll = amount != null && Number(amount) > 0 ? round2(Number(amount)) : null;
    if (requestedAll != null && priorDone >= requestedAll - 0.004) {
      return json({ totalRefunded: priorDone, requested: requestedAll, capped: false, cappedReason: null, refunds: priorRefunds, replayed: true });
    }

    // The rest of this child's money is on its way to the parent in another
    // refund. Said plainly: one the card company never confirmed is the
    // office's to check; one sent a moment ago is simply still going.
    const heldElsewhere = round2(otherHolds.reduce((t, h) => t + (Number(h.amount) || 0), 0));
    const staleElsewhere = otherHolds.filter((h) => Number(h.ageSeconds) >= STALE_SECONDS);
    const heldNote = (): string | null => {
      if (heldElsewhere <= 0) return null;
      if (staleElsewhere.length) {
        const amt = round2(staleElsewhere.reduce((t, h) => t + (Number(h.amount) || 0), 0));
        return `An earlier refund of $${amt.toFixed(2)} of this child's money was never confirmed by the card company, so it is held off the wallet. Check the processor's dashboard: if it is NOT there, confirm and it goes back on the wallet and this refund is sent. If it IS there, cancel and record it under "waiting for an answer" in this window.`;
      }
      return `A refund of $${heldElsewhere.toFixed(2)} of this child's money is being sent right now (Refund All, or another computer). Wait a moment, then check the wallet.`;
    };

    // An earlier refund of this child's money the card company never answered
    // is settled FIRST (TED-116): refunding again around it is how a parent's
    // money ended up locked off the wallet. "Not there" (confirmHolds) gives it
    // back and sends this one; "it went through" is answered in Refund's list.
    if (staleElsewhere.length) {
      return json({ uncertain: true, error: heldNote(), confirmHolds: staleElsewhere.map((h) => h.key) }, 200);
    }
    if (walletAvailable <= 0) {
      const note = heldNote();
      return json({ error: note || "Nothing available to refund — this balance has already been spent." }, 409);
    }

    // Every deposit for this camper on the camp's CURRENT processor, minus
    // whatever's already been refunded from each one — and whatever another
    // refund has on its way from it (275).
    const transactions: Record<string, any>[] = accountsData.transactions || [];
    const deposits = transactions
      .filter((t) => t && mine(t) && t.kind === "deposit" && t.method === processorKey && t.byopTransactionId)
      .map((dep) => {
        const refundedSoFar = transactions
          .filter((t) => t && t.kind === "refund" && t.byopTransactionId === dep.byopTransactionId)
          .reduce((sum, t) => sum + (Number(t.amount) || 0), 0)
          + holdsAll.filter((h) => h.method === processorKey && h.paymentRef === dep.byopTransactionId && !ownHolds.includes(h))
              .reduce((sum, h) => sum + (Number(h.amount) || 0), 0);
        return { externalTransactionId: dep.byopTransactionId as string, remaining: round2((Number(dep.amount) || 0) - refundedSoFar), timestamp: Number(dep.timestamp) || 0 };
      })
      .filter((d) => d.remaining > 0)
      .sort((a, b) => a.timestamp - b.timestamp);

    const processorCapacity = round2(deposits.reduce((sum, d) => sum + d.remaining, 0));

    const requested = requestedAll != null ? requestedAll : walletAvailable;
    // What is left of THIS refund after what an earlier try already did.
    const targetAmount = round2(Math.min(round2(requested - priorDone), walletAvailable, processorCapacity));

    if (targetAmount <= 0) {
      if (processorCapacity <= 0) {
        return json({ error: "This balance has no online deposits on this processor left to refund — it came from cash/manual deposits (or a different processor) and must be refunded that way instead." }, 409);
      }
      return json({ error: "Nothing available to refund." }, 409);
    }

    // Draw from deposits oldest-first until the target amount is covered.
    // Each chunk is its own refund call and its own ledger entry — if one
    // chunk fails partway through, everything before it has already
    // succeeded for real money, so those are kept and reported rather than
    // rolled back or hidden.
    let remainingToRefund = targetAmount;
    let totalRefunded = priorDone;
    const refunds: Record<string, unknown>[] = priorRefunds.slice();
    let chunkError: string | null = null;
    let chunkUncertain = false;

    for (const dep of deposits) {
      if (remainingToRefund <= 0) break;
      // one part per top-up per refund: a top-up this refund already drew on
      // was counted above
      // (a part already refunded is never sent again, confirmed or not; one
      // never confirmed is sent again only when the office says it did not go)
      if (reqKey && priorSettled.has(dep.externalTransactionId)) continue;
      if (reqKey && priorDeposits.has(dep.externalTransactionId) && confirmNotRefunded !== true) continue;
      let chunk = round2(Math.min(dep.remaining, remainingToRefund));
      if (chunk <= 0) continue;

      try {
        const keyFor = (amt: number) => reqKey
          ? `canteen:${reqKey}:${dep.externalTransactionId}`
          : `canteen:${dep.externalTransactionId}:${Math.round(dep.remaining * 100)}:${Math.round(amt * 100)}`;
        // TAKE THE MONEY OFF THE WALLET FIRST (275, TED-110), in one locked
        // step: a second refund for this child — Refund All, another computer —
        // or a sale waits for it and then sees the lower balance. The same
        // refund again meets its own reservation and takes nothing more.
        const reserve = (amt: number) => service.rpc("reserve_canteen_refund", {
          p_camp_id: authedCampId, p_camper_id: camperId, p_camper_name: String(camperName ?? acctKey),
          p_hold_key: keyFor(amt), p_amount: amt, p_method: processorKey, p_payment_ref: String(dep.externalTransactionId) });
        let { data: held, error: holdErr } = await reserve(chunk);
        if (!holdErr && held && held.success === false && held.error === "insufficient") {
          const avail = round2(Number(held.available) || 0);
          if (avail <= 0) throw new Error("The wallet changed while this refund was being made — another refund or a sale took the money first. Nothing more was refunded; reload to see the balance.");
          chunk = round2(Math.min(chunk, avail));
          ({ data: held, error: holdErr } = await reserve(chunk));
        }
        if (holdErr || !held || held.success !== true) {
          throw new Error("Could not set this refund's money aside, so nothing was sent: " + (holdErr?.message || held?.error || "no answer"));
        }
        if (held.existing && held.state === "posted" && held.refundId) {
          // this exact refund already went through and is on the wallet's ledger
          const doneAmt = round2(Number(held.amount) || chunk);
          refunds.push({ refundId: held.refundId, externalTransactionId: dep.externalTransactionId, amount: doneAmt });
          totalRefunded = round2(totalRefunded + doneAmt);
          remainingToRefund = round2(remainingToRefund - doneAmt);
          continue;
        }
        if (held.existing) chunk = round2(Number(held.amount) || chunk);   // its reservation decides the amount
        const holdKey = keyFor(chunk);
        const chunkCents = Math.round(chunk * 100);
        // CLAIM BEFORE THE PROCESSOR. Same reasoning as payments-refund: the
        // ledger's idempotency keys on the processor's refund id, which does not
        // exist until money has already moved. Per CHUNK, because each chunk is a
        // separate processor call and a retry may resume partway through.
        // Keyed on the deposit and what is left on it, not on the click (TED-093):
        // a second click after an answer was lost must meet the same claim, not
        // start a second refund. A refund that was recorded changes what is left,
        // so a deliberate later refund gets a new key.
        // With the page's key for this refund (TED-105), the retry of a refund
        // whose answer was lost meets its first attempt, while a deliberate
        // second refund (a new key) is its own. Without one, the deposit and
        // what is left on it.
        const chunkKey = holdKey;
        if (chunkKey) {
          const { data: claim } = await service.rpc("claim_refund_intent", {
            p_camp_id: authedCampId, p_key: chunkKey, p_amount: chunk,
            p_payment_ref: String(dep.externalTransactionId),
          });
          // Already done. Skip the processor and move to the next deposit rather
          // than refunding this one twice.
          if (claim && claim.claimed === false) {
            if (claim.previous && claim.previous.externalTransactionId) {
              // Done already — by this refund's other press, a moment ago
              // (TED-109). It IS part of this refund: count it, and never move
              // on to the next top-up to refund the same money again.
              const doneAmt = round2(Number(claim.previous.amount) || chunk);
              console.log(`[canteen-refund] chunk already settled, counting it: ${chunkKey}`);
              await service.rpc("settle_canteen_refund_hold", { p_camp_id: authedCampId, p_hold_key: chunkKey, p_refund_id: String(claim.previous.externalTransactionId) });
              refunds.push({ refundId: claim.previous.externalTransactionId, externalTransactionId: dep.externalTransactionId, amount: doneAmt });
              totalRefunded = round2(totalRefunded + doneAmt);
              remainingToRefund = round2(remainingToRefund - doneAmt);
              continue;
            }
            // Asked before and never confirmed (TED-093): stop here rather than
            // refund it again or move on to the next deposit.
            if (confirmNotRefunded !== true) throw Object.assign(new Error("An earlier refund of this canteen money was never confirmed by the card company. Check the processor's dashboard: if it is not there, confirm and it will be sent."), { uncertain: true });
            // Only a claim that has waited a few minutes (273), never one still running.
            const { data: freed } = await service.rpc("release_stale_refund_intent", { p_camp_id: authedCampId, p_key: chunkKey });
            if (freed !== true) throw Object.assign(new Error("This refund was sent a moment ago and may still be going through. Wait a few minutes, check the processor's dashboard, and try again only if it is not there."), { uncertain: true });
            const { data: again } = await service.rpc("claim_refund_intent", {
              p_camp_id: authedCampId, p_key: chunkKey, p_amount: chunk, p_payment_ref: String(dep.externalTransactionId),
            });
            if (again && again.claimed === false) throw Object.assign(new Error("This refund is being sent right now by someone else."), { uncertain: true });
          }
        }
        const refundResult = processorKey === "cardknox"
          ? await cardknoxRefund(credResult.credentials, dep.externalTransactionId, chunkCents)
          : await banquestRefund(credResult.credentials, dep.externalTransactionId, chunkCents);
        if (!refundResult.success && refundResult.uncertain) {
          // Maybe it moved money: keep the claim and stop (TED-093).
          throw Object.assign(new Error("The card company did not answer, so a canteen refund may or may not have gone through. Check the processor's dashboard before trying again."), { uncertain: true });
        }
        if (!refundResult.success) {
          // No money moved, so give the claim back or this chunk is locked out,
          // and the money back to the wallet.
          if (chunkKey) {
            await service.rpc("release_refund_intent", { p_camp_id: authedCampId, p_key: chunkKey });
          }
          await service.rpc("release_canteen_refund_hold", { p_camp_id: authedCampId, p_hold_key: holdKey });
          throw new Error(refundResult.error || "Refund failed");
        }
        if (chunkKey) {
          await service.rpc("settle_refund_intent", {
            p_camp_id: authedCampId, p_key: chunkKey,
            p_result: { success: true, externalTransactionId: refundResult.externalTransactionId,
                        amount: chunk },
          });
        }

        await service.rpc("record_processor_transaction", {
          p_camp_id: authedCampId,
          p_processor_key: processorKey,
          p_external_transaction_id: refundResult.externalTransactionId,
          p_kind: "refund",
          p_amount_cents: chunkCents,
          p_status: refundResult.status || "unknown",
          p_raw_response: refundResult.raw ? JSON.parse(JSON.stringify(refundResult.raw)) : null,
        });

        // The refund line goes on the wallet's ledger; the money came off when
        // it was reserved, so the balance does not move again (275).
        const { data: posted, error: creditErr } = await service.rpc("settle_canteen_refund_hold", {
          p_camp_id: authedCampId, p_hold_key: holdKey, p_refund_id: String(refundResult.externalTransactionId) });
        if (creditErr || !posted || posted.success !== true) console.error(`[payments-canteen-refund] refund ${refundResult.externalTransactionId} succeeded but ledger update failed: ${creditErr?.message || posted?.error}`);

        refunds.push({ refundId: refundResult.externalTransactionId, externalTransactionId: dep.externalTransactionId, amount: chunk });
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
    } else if (capped && heldNote()) {
      cappedReason = `Refunded $${totalRefunded.toFixed(2)}. ${heldNote()}`;
    } else if (capped) {
      cappedReason = processorCapacity < Math.min(requested, walletAvailable)
        ? "Capped — the rest of this balance came from cash/manual deposits (or a different processor) and must be refunded that way."
        : "Capped to what was left available.";
    }

    console.log(`[payments-canteen-refund] Refunded $${totalRefunded} for ${camperName} (camp ${authedCampId}) across ${refunds.length} deposit(s)${capped ? " (capped)" : ""}`);

    // The wallet is empty now: auto-reload would top it straight back up
    // from the parent's card (TED-143).
    if (totalRefunded > 0 && totalRefunded >= walletAvailable - 0.004) {
      await pauseAutoReload(service, authedCampId, camperId, acctKey || String(camperName ?? ""), account);
    }
    return json({ totalRefunded, requested: round2(requested), capped, cappedReason, refunds, uncertain: chunkUncertain || undefined });
  } catch (err) {
    console.error("[payments-canteen-refund] Error:", (err as Error).message);
    return json({ error: (err as Error).message }, 500);
  }
});
