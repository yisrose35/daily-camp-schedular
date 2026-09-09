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
  if (destinationAccountId) params["transfer_data[destination]"] = destinationAccountId;
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
    let chargeToken: string | undefined = processorKey === "cardknox" ? fam.byopCustomerRef : fam.stripePaymentMethodId;
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
    } else {
      if (!STRIPE_SECRET || !chargeStripeCustomerId) {
        const result = { success: false, error: "This camp's processor isn't connected right now." };
        await finishLock("failed", result);
        return json(result, 400);
      }
      const { data: camp } = await service.from("camps").select("stripe_account_id, stripe_charges_enabled").eq("id", campId).maybeSingle();
      const destinationAccountId = (camp?.stripe_account_id && camp?.stripe_charges_enabled) ? camp.stripe_account_id : null;
      const pi = await stripeCharge(
        chargeStripeCustomerId, chargeToken || null, amountCents,
        (kind === "canteen_deposit" ? "Canteen funds — " + camperName : "Camp payment"),
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
      let saved = false;
      for (let attempt = 0; attempt < 4 && !saved; attempt++) {
        const cur = await service.from("camp_state_kv").select("value")
          .eq("camp_id", campId).eq("key", "campistryMe").maybeSingle();
        const cur_me: Record<string, any> = (cur.data?.value && typeof cur.data.value === "object") ? cur.data.value : {};
        if (!cur_me.finance) cur_me.finance = {};
        if (!Array.isArray(cur_me.finance.payments)) cur_me.finance.payments = [];
        const pays: Record<string, any>[] = cur_me.finance.payments;
        if (!pays.find((p) => p.byopTransactionId === externalTransactionId || p.stripePaymentIntentId === externalTransactionId)) {
          pays.push({
            id: (chargeProcessorKey === "cardknox" ? "byop_" : "stripe_") + externalTransactionId,
            family: fam.name || familyKey, familyKey,
            amount: amountCents / 100,
            date: new Date().toISOString().split("T")[0],
            method: chargeProcessorKey === "cardknox" ? "Card on file (Sola)" : "Card on file (Stripe)",
            reference: externalTransactionId,
            notes: "Charged card on file",
            ...(chargeProcessorKey === "cardknox" ? { byopTransactionId: externalTransactionId, byopProcessor: "cardknox" } : { stripePaymentIntentId: externalTransactionId }),
            status: "succeeded", timestamp: Date.now(),
          });
        }
        const up = await service.from("camp_state_kv").upsert(
          { camp_id: campId, key: "campistryMe", value: cur_me, updated_at: new Date().toISOString() },
          { onConflict: "camp_id,key" },
        );
        if (!up.error) saved = true;
      }
      if (!saved) {
        console.error(`[charge-saved-card] Charged ${externalTransactionId} but could not record the payment for camp ${campId} after retries`);
      }
    }

    const result = { success: true, amount: amountCents / 100, processorKey: chargeProcessorKey };
    await finishLock("succeeded", result);
    console.log(`[charge-saved-card] ${kind} ${externalTransactionId}: $${amountCents / 100}, camp ${campId}, family ${familyKey}`);
    return json(result);
  } catch (err) {
    console.error("[charge-saved-card] Error:", (err as Error).message);
    return json({ success: false, error: (err as Error).message }, 500);
  }
});
