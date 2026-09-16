// =============================================================================
// charge-saved-card — lets a parent charge their ALREADY-SAVED card directly
// for a one-off tuition payment or canteen deposit, instead of always being
// sent through a brand-new hosted checkout page even when a card is already
// on file (see migration 137's header comment for the full "why").
//
// Unlike every other parent-facing payment function in this codebase
// (cardknox-checkout-start, stripe-checkout, payments-checkout, ...), this
// one REQUIRES the caller's real Supabase session JWT, not just the anon
// key + an ownership check. Those other functions only ever mint a link to
// a hosted page where the processor itself is the actual gate (the parent
// must interact with Sola's/Stripe's own UI to make anything happen); this
// function charges real money on a single request with no such page in the
// loop, so it needs the stronger "a real authenticated parent" bar, not just
// "knows a campId/familyKey". get_my_balance (called below AS the caller,
// using their JWT) is what actually resolves which family this parent
// belongs to — never trusted from the request body.
//
// Request:  { campId, kind: 'tuition_charge'|'canteen_deposit', camperName?,
//              amount, idempotencyKey }
//   Authorization: Bearer <parent's Supabase access token>  (required)
//   idempotencyKey: any client-generated string unique to this one button
//     press (e.g. crypto.randomUUID()) — a retried/duplicated request with
//     the same key returns the first attempt's result instead of charging
//     twice (migration 137's saved_card_charge_locks).
// Response: { success: true, amount, processorKey } or { success: false, error }
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── receipts ────────────────────────────────────────────────────────────────
// Emailing the parent a receipt is the last step of taking money, not an extra.
// It is dispatched, never awaited for correctness: the money is already taken,
// so a receipt that fails must never fail — or retry — the charge. send-payment-
// receipt is idempotent on the payment reference, so several callers racing for
// the same payment produce exactly one email.
async function sendReceipt(o: Record<string, unknown>) {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
    const r = await fetch(`${SUPABASE_URL}/functions/v1/send-payment-receipt`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(o),
    });
    if (!r.ok) console.warn(`[receipt] dispatch returned ${r.status} for ref ${String(o.ref || "")}`);
  } catch (e) {
    console.warn("[receipt] dispatch failed:", (e as Error)?.message);
  }
}


const STRIPE_SECRET = Deno.env.get("STRIPE_SECRET_KEY");
const STRIPE_API = "https://api.stripe.com/v1";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function stripeCharge(customerId: string, pmId: string | null, amountCents: number, description: string, metadata: Record<string, string>, destinationAccountId?: string | null) {
  const params: Record<string, string> = {
    amount: String(amountCents),
    currency: "usd",
    customer: customerId,
    off_session: "true",
    confirm: "true",
    description,
  };
  if (pmId) params["payment_method"] = pmId;
  Object.entries(metadata).forEach(([k, v]) => { params[`metadata[${k}]`] = String(v); });
  // on_behalf_of makes the CAMP the settlement merchant, which is the whole
  // point: a destination charge without it settles on the platform, so the
  // cardholder's statement carries the PLATFORM's descriptor. A parent who
  // pays their camp and finds a charge from a company they have never heard
  // of disputes it — and a dispute over an unrecognised descriptor is the
  // single most documented avoidable chargeback there is. With on_behalf_of
  // the statement uses the connected account's descriptor, i.e. the camp's.
  // Stripe requires it to EQUAL transfer_data[destination] for card
  // payments, so the two are always set together, from the same value.
  if (destinationAccountId) {
    params["transfer_data[destination]"] = destinationAccountId;
    params["on_behalf_of"] = destinationAccountId;
  }
  const resp = await fetch(`${STRIPE_API}/payment_intents`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${STRIPE_SECRET}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  return resp.json();
}

// Inlined per this project's deploy convention (see charge-due-installments'
// own header comment) — kept in sync with that file's copy by hand.
// xInvoice is DERIVED FROM the caller's idempotencyKey rather than random —
// deliberately the opposite of charge-due-installments' random invoice: this
// function WANTS Sola's own same-Key+Card+Amount+Invoice-within-10-minutes
// duplicate block to catch a genuine resubmission as a second line of
// defense, behind the saved_card_charge_locks table which is the primary one.
const CARDKNOX_GATEWAY = "https://x1.cardknox.com/gateway";
async function cardknoxCharge(apiKey: string, amountCents: number, cardToken: string, invoice: string) {
  const resp = await fetch(CARDKNOX_GATEWAY, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      xKey: apiKey,
      xVersion: "4.5.9",
      xSoftwareName: "Campistry",
      xSoftwareVersion: "1.0",
      xCommand: "cc:sale",
      xAmount: (amountCents / 100).toFixed(2),
      xToken: cardToken,
      xInvoice: invoice,
    }).toString(),
  });
  const parsed: Record<string, string> = {};
  new URLSearchParams(await resp.text()).forEach((v, k) => { parsed[k] = v; });
  if (parsed.xResult !== "A") {
    return { success: false, error: parsed.xError || "Declined" };
  }
  return { success: true, externalTransactionId: parsed.xRefNum };
}

// Banquest (AffiniPay/8am) sale against a saved card_ref. Inlined per this
// project's deploy convention; keep in sync with
// _shared/adapters/banquest_adapter.ts. Auth is HTTP Basic base64(sourceKey:
// pin); API base is per-camp and lives under /api/v2; amounts are DOLLARS; a
// saved card is charged as source "tkn-<card_ref>". Approval is reported by
// status_code "A" (status "Approved"); the transaction's integer
// `reference_number` is what we store to later refund/reverse it.
const BANQUEST_DEFAULT_BASE = "https://api.banquestgateway.com/api/v2";
function bqBase(c: Record<string, string>): string {
  // A stored gatewayUrl that already ends in /v2 or /api/v2 is used verbatim;
  // a bare host gets /api/v2 appended. Both spellings are honoured on purpose:
  // the API reference documents the base as /api/v2, while the Hosted
  // Tokenization guide's own backend example posts to /v2 — so whichever path
  // the camp actually stores is the one we call.
  let b = (c.gatewayUrl || BANQUEST_DEFAULT_BASE).replace(/\/+$/, "");
  if (!/\/(api\/)?v\d+$/i.test(b)) b += "/api/v2";
  return b;
}
async function banquestCharge(creds: Record<string, string>, amountCents: number, cardRef: string) {
  const resp = await fetch(`${bqBase(creds)}/transactions/charge`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Basic " + btoa(`${creds.sourceKey}:${creds.pin}`) },
    // A saved card is either a verify card_ref (charged "tkn-<ref>") or a
    // Customer payment-method saved on the hosted page (already stored WITH its
    // "pm-<id>" prefix). Pass an already-prefixed ref through untouched.
    body: JSON.stringify({ amount: Number((amountCents / 100).toFixed(2)), source: /^(tkn-|pm-|ref-|nonce-)/.test(cardRef) ? cardRef : "tkn-" + cardRef }),
  });
  let data: Record<string, any> = {};
  try { data = await resp.json(); } catch { /* non-JSON error body */ }
  const approved = String(data?.status_code || "").toUpperCase() === "A"
                || String(data?.status || "").toLowerCase() === "approved";
  const ref = data?.reference_number != null ? String(data.reference_number) : "";
  if (resp.status < 200 || resp.status >= 300 || !approved || !ref) {
    const errMsg = data?.error_message || (Array.isArray(data?.error_messages) && data.error_messages[0]) || data?.error_details || data?.error || data?.message || data?.status || `Declined (HTTP ${resp.status})`;
    return { success: false, error: errMsg };
  }
  return { success: true, externalTransactionId: ref };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ success: false, error: "Sign in required." }, 401);

    const { campId, kind, camperName, amount, idempotencyKey, paymentMethodId } = await req.json();
    if (!campId || !kind || !amount || !idempotencyKey) {
      return json({ success: false, error: "campId, kind, amount, and idempotencyKey are required" }, 400);
    }
    if (kind !== "tuition_charge" && kind !== "canteen_deposit") {
      return json({ success: false, error: "kind must be tuition_charge or canteen_deposit" }, 400);
    }
    if (kind === "canteen_deposit" && !camperName) {
      return json({ success: false, error: "camperName is required for a canteen deposit" }, 400);
    }
    const amountCents = Math.round(Number(amount) * 100);
    if (!Number.isFinite(amountCents) || amountCents < 50) {
      return json({ success: false, error: "Enter an amount of at least $0.50" }, 400);
    }

    // Real caller identity + family resolution, both via get_my_balance run
    // AS the caller (their JWT, not the service role) — this is the only
    // source of truth for "which family is this" and "is a card even on
    // file"; nothing here is ever trusted from the request body.
    const asUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authErr } = await asUser.auth.getUser();
    if (authErr || !authData?.user) return json({ success: false, error: "Sign in required." }, 401);

    const { data: bal, error: balErr } = await asUser.rpc("get_my_balance", { p_camp_id: campId });
    if (balErr || !bal?.success) {
      return json({ success: false, error: bal?.error || balErr?.message || "Could not verify your account." }, 400);
    }
    if (!bal.chargeable || !bal.familyKey || !bal.processorKey) {
      return json({ success: false, error: "No card on file to charge." }, 400);
    }
    if (kind === "canteen_deposit") {
      const campers: string[] = Array.isArray(bal.campers) ? bal.campers : [];
      if (!campers.includes(camperName)) {
        return json({ success: false, error: "That camper isn't linked to your account." }, 403);
      }
    }
    const familyKey = bal.familyKey as string;
    const processorKey = bal.processorKey as string;

    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Idempotency lock — first line of defense against a double-click or a
    // retried request. A conflict means this exact idempotencyKey was
    // already handled: replay its stored result rather than charging again.
    // Best-effort cleanup only — supabase-js's query builder is a thenable,
    // not a real Promise (no .catch()/.finally()), so a plain try/await is
    // required here rather than chaining .catch() directly onto the call.
    try {
      await service.rpc("_prune_saved_card_charge_locks");
    } catch (_pruneErr) {
      // never block a real charge on best-effort lock cleanup
    }
    const { data: lockRow, error: lockErr } = await service
      .from("saved_card_charge_locks")
      .insert({ idempotency_key: idempotencyKey, camp_id: campId, status: "pending" })
      .select()
      .maybeSingle();
    if (lockErr || !lockRow) {
      const { data: existing } = await service
        .from("saved_card_charge_locks")
        .select("status, result")
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle();
      if (existing?.status === "succeeded") return json(existing.result || { success: true });
      if (existing?.status === "pending") return json({ success: false, error: "This charge is already being processed." }, 409);
      return json({ success: false, error: (existing?.result as any)?.error || "This charge already failed — try again." }, 400);
    }

    async function finishLock(status: "succeeded" | "failed", result: Record<string, unknown>) {
      await service.from("saved_card_charge_locks")
        .update({ status, result, updated_at: new Date().toISOString() })
        .eq("idempotency_key", idempotencyKey);
    }

    // Re-read the family record directly (service role) for the actual
    // token/customer id — get_my_balance deliberately never returns these.
    const { data: meRow } = await service.from("camp_state_kv").select("value")
      .eq("camp_id", campId).eq("key", "campistryMe").maybeSingle();
    const me: Record<string, any> = (meRow?.value && typeof meRow.value === "object") ? meRow.value : {};
    const fam = me.families?.[familyKey];
    if (!fam) {
      const result = { success: false, error: "Family record not found." };
      await finishLock("failed", result);
      return json(result, 400);
    }

    // Migration 139: a family can now have several saved methods, not just
    // one. When the caller picked a specific one (paymentMethodId), resolve
    // ITS token/processor from savedPaymentMethods[] — verified to actually
    // belong to this family, never trusted from the request beyond the id
    // itself. No paymentMethodId (every pre-existing caller) falls back to
    // the legacy single-slot fields exactly as before, which get_my_balance's
    // processorKey/chargeable already describe.
    let chargeProcessorKey = processorKey;
    let chargeToken: string | undefined = (processorKey === "cardknox" || processorKey === "banquest") ? fam.byopCustomerRef : fam.stripePaymentMethodId;
    let chargeStripeCustomerId: string | undefined = fam.stripeCustomerId;
    if (paymentMethodId) {
      const methods: any[] = Array.isArray(fam.savedPaymentMethods) ? fam.savedPaymentMethods : [];
      const picked = methods.find((m) => m && m.id === paymentMethodId);
      if (!picked) {
        const result = { success: false, error: "That saved card could not be found." };
        await finishLock("failed", result);
        return json(result, 400);
      }
      chargeProcessorKey = picked.processor;
      chargeToken = picked.token;
      if (picked.processor === "stripe") chargeStripeCustomerId = picked.stripeCustomerId;
    }

    let externalTransactionId: string;
    if (chargeProcessorKey === "cardknox") {
      const { data: credResult } = await service.rpc("_admin_get_processor_credential", { p_camp_id: campId });
      const apiKey = credResult?.success ? credResult.credentials?.apiKey : null;
      if (!apiKey || !chargeToken) {
        const result = { success: false, error: "This camp's processor isn't connected right now." };
        await finishLock("failed", result);
        return json(result, 400);
      }
      const res = await cardknoxCharge(apiKey, amountCents, String(chargeToken), "CSC-" + idempotencyKey);
      if (!res.success || !res.externalTransactionId) {
        const result = { success: false, error: res.error || "Card declined." };
        await finishLock("failed", result);
        return json(result, 402);
      }
      externalTransactionId = res.externalTransactionId;
    } else if (chargeProcessorKey === "banquest") {
      const { data: credResult } = await service.rpc("_admin_get_processor_credential", { p_camp_id: campId });
      const creds = credResult?.success ? credResult.credentials : null;
      if (!creds?.sourceKey || !creds?.pin || !chargeToken) {
        const result = { success: false, error: "This camp's processor isn't connected right now." };
        await finishLock("failed", result);
        return json(result, 400);
      }
      const res = await banquestCharge(creds, amountCents, String(chargeToken));
      if (!res.success || !res.externalTransactionId) {
        const result = { success: false, error: res.error || "Card declined." };
        await finishLock("failed", result);
        return json(result, 402);
      }
      externalTransactionId = res.externalTransactionId;
    } else {
      if (!STRIPE_SECRET || !chargeStripeCustomerId) {
        const result = { success: false, error: "This camp's processor isn't connected right now." };
        await finishLock("failed", result);
        return json(result, 400);
      }
      const { data: camp } = await service.from("camps").select("stripe_account_id, stripe_charges_enabled, name").eq("id", campId).maybeSingle();
      const destinationAccountId = (camp?.stripe_account_id && camp?.stripe_charges_enabled) ? camp.stripe_account_id : null;
      // Name the camp on the charge — see on_behalf_of in stripeCharge above.
      const campLabel = String(camp?.name || "").trim() || "Camp";
      const pi = await stripeCharge(
        chargeStripeCustomerId, chargeToken || null, amountCents,
        (kind === "canteen_deposit" ? `${campLabel} — canteen funds for ${camperName}` : `${campLabel} — payment`),
        { campId: String(campId), familyKey, kind, idempotencyKey },
        destinationAccountId,
      );
      if (pi.error || (pi.status !== "succeeded" && pi.status !== "processing")) {
        const result = { success: false, error: pi.error?.message || "Card declined." };
        await finishLock("failed", result);
        return json(result, 402);
      }
      externalTransactionId = pi.id;
    }

    await service.rpc("record_processor_transaction", {
      p_camp_id: campId,
      p_processor_key: chargeProcessorKey,
      p_external_transaction_id: externalTransactionId,
      p_kind: "charge",
      p_amount_cents: amountCents,
      p_status: "succeeded",
      p_raw_response: { source: "charge-saved-card", kind, idempotencyKey },
    });

    if (kind === "canteen_deposit") {
      await service.rpc("credit_canteen_balance_from_processor", {
        p_camp_id: campId,
        p_camper_name: camperName,
        p_amount: amountCents / 100,
        p_processor_key: chargeProcessorKey,
        p_external_transaction_id: externalTransactionId,
      });
    } else {
      // Tuition — same shape cardknox-webhook/payments-charge already write
      // into campistryMe.finance.payments.
      // ── recorded through append_camp_payment, NOT a blind blob upsert ────
      // The old code here read campistryMe, pushed onto finance.payments and
      // upserted the whole blob. With no lock and no version check, any other
      // writer that overlapped — a second webhook, the nightly autopay run, an
      // office save — silently discarded whichever append landed first. The
      // money left the card and Campistry had no record of it.
      //
      // The retry loop that used to wrap this did not help: it retried on a
      // WRITE ERROR, and a lost update is not an error. Both writes succeed.
      //
      // append_camp_payment does the read, the dedupe and the write inside one
      // transaction holding a row lock, so a concurrent writer waits instead of
      // overwriting — and the dedupe on the processor's own transaction id now
      // happens under that lock too, which is what makes a retried webhook
      // land once instead of racing itself. See migration 168.
      const isByop = chargeProcessorKey === "cardknox" || chargeProcessorKey === "banquest";
      const rec = await service.rpc("append_camp_payment", {
        p_camp_id: campId,
        p_payment: {
          id: (isByop ? "byop_" : "stripe_") + externalTransactionId,
          family: fam.name || familyKey, familyKey,
          amount: amountCents / 100,
          date: new Date().toISOString().split("T")[0],
          method: isByop ? ("Card on file (" + (chargeProcessorKey === "cardknox" ? "Sola" : "Banquest") + ")") : "Card on file (Stripe)",
          reference: externalTransactionId,
          notes: "Charged card on file",
          ...(isByop ? { byopTransactionId: externalTransactionId, byopProcessor: chargeProcessorKey } : { stripePaymentIntentId: externalTransactionId }),
          status: "succeeded", timestamp: Date.now(),
        },
        p_dedupe_key: externalTransactionId,
      });
      const saved = !rec.error && rec.data?.success === true;
      if (!saved) {
        console.error(`[charge-saved-card] Charged ${externalTransactionId} but could not record the payment for camp ${campId}`);
      }
    }

    // The office charged a card the parent is not sitting in front of, so the
    // receipt is the only thing that tells them it happened. Keyed on the
    // processor's transaction id, which is what the Stripe webhook also keys
    // on — so the Stripe path gets one email, not two.
    await sendReceipt({
      campId: String(campId), familyKey, camperName: camperName || null,
      ref: String(externalTransactionId || ""), amount: amountCents / 100,
      what: kind === "canteen_deposit" ? "Canteen funds" : "Camp payment",
      method: "Card on file",
    });

    const result = { success: true, amount: amountCents / 100, processorKey: chargeProcessorKey };
    await finishLock("succeeded", result);
    console.log(`[charge-saved-card] ${kind} ${externalTransactionId}: $${amountCents / 100}, camp ${campId}, family ${familyKey}`);
    return json(result);
  } catch (err) {
    console.error("[charge-saved-card] Error:", (err as Error).message);
    return json({ success: false, error: (err as Error).message }, 500);
  }
});
