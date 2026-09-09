// =============================================================================
// cardknox-webhook — receives Sola's async webhook notification after a
// transaction completes on the hosted checkout page (cardknox-checkout-start
// mints the link the parent's browser is sent to; Sola charges the card
// directly on their own servers, then POSTs the result here).
//
// This is the actual source of truth for crediting money — NOT the browser
// redirect (Sola's "Redirect on success/error" fields are a single static
// URL per merchant account, configured once in their dashboard, carrying no
// per-transaction data; it exists purely to bring the parent back into
// Link/the office UI, never to prove a payment happened, since a redirect
// alone can be faked by anyone just navigating to that URL without paying).
//
// Public endpoint (Sola calls it directly, no Supabase session) — the
// Postback URL is configured PER CAMP in that camp's own Sola dashboard
// (Gateway Settings → Webhook Settings), pointing here with ?campId=<uuid>
// so this function knows which camp's credentials/PIN to check against.
// Authenticity is verified via the ck-signature header exactly as documented
// at docs.solapayments.com/products/webhooks (pasted in directly by the
// camp this session, since that domain is network-blocked from here):
//   1. URL-decode the posted form data
//   2. Lowercase every key
//   3. Sort alphabetically by (lowercased) key
//   4. Concatenate just the VALUES, in that sorted order
//   5. Append the webhook PIN at the end
//   6. MD5-hash the result and compare to the ck-signature header
//
// IMPORTANT: the Postback URL fires for EVERY transaction on that Sola
// account, not just ones that came through cardknox-checkout-start — a
// webhook with no matching intent (e.g. the office ran a charge directly
// through the Sola portal) is expected and not an error; it's just ignored.
//
// CORRELATION (confirmed via live testing, 2026-09-08): the checkout URL
// cardknox-checkout-start builds passes &xInvoice=<our reference>, but
// Sola's HOSTED CHECKOUT webhook never echoes it back — its payload is a
// fixed small set of fields (xAmount/xEnteredDate/xMaskedCardNumber/
// xRefNum/xRequestAmount/xResponseResult/xToken) with no reference of any
// kind, unlike what Sola's Direct API docs describe. get_cardknox_checkout_
// intent-by-reference is still tried first (in case a future integration
// path DOES carry it through), but the real path in production is the
// amount-fallback below: match the single still-pending intent for this
// camp (from ?campId=) with the same dollar amount, within a bounded
// lookback window. Two pending intents at the same amount is the one case
// this can't resolve — it's left alone rather than guessed at, since a
// wrong guess means crediting the wrong family's payment.
//
// Response: always 200 unless the signature itself fails to verify — Sola
// has no reason to retry a webhook we understood and (correctly) did
// nothing with.
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import md5 from "https://esm.sh/js-md5@0.8.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

function text(body: string, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}

// Implements Sola's documented ck-signature algorithm exactly (see header).
function verifySignature(rawBody: string, pin: string, signature: string): boolean {
  if (!signature) return false;
  const params = new URLSearchParams(rawBody); // decodes both '+' and %XX
  const pairs: string[][] = [];
  for (const [k, v] of params.entries()) pairs.push([k.toLowerCase(), v]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const concatenated = pairs.map((p) => p[1]).join("") + pin;
  const computed = md5(concatenated);
  return computed.toLowerCase() === signature.toLowerCase().trim();
}

// Turns the xToken Sola returns on a hosted-checkout transaction into a
// long-lived vault token we can charge later (autopay installments, via
// charge-due-installments). Uses cc:save for the same reason
// cardknox_adapter.saveMethod() does: a transaction-scoped token isn't
// guaranteed to outlive the checkout it came from, and a card-on-file that
// silently stops working months later is worse than not storing one.
// Best-effort by design — a failure here must never fail the webhook or
// block crediting money that was genuinely collected.
async function vaultCardknoxToken(
  service: ReturnType<typeof createClient>,
  campId: string,
  rawToken: string,
): Promise<string | null> {
  try {
    const { data: credResult } = await service.rpc("_admin_get_processor_credential", { p_camp_id: campId });
    const apiKey = credResult?.success ? credResult.credentials?.apiKey : null;
    if (!apiKey) return null;
    const resp = await fetch("https://x1.cardknox.com/gateway", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        xKey: apiKey,
        xVersion: "4.5.9",
        xSoftwareName: "Campistry",
        xSoftwareVersion: "1.0",
        xCommand: "cc:save",
        xToken: rawToken,
      }).toString(),
    });
    const parsed: Record<string, string> = {};
    new URLSearchParams(await resp.text()).forEach((v, k) => { parsed[k] = v; });
    if (parsed.xResult !== "A" || !parsed.xToken) {
      console.warn(`[cardknox-webhook] Could not vault card token for camp ${campId}: ${parsed.xError || parsed.xResult || "unknown"} — autopay won't be available for this family until a card is saved another way`);
      return null;
    }
    return parsed.xToken;
  } catch (err) {
    console.warn(`[cardknox-webhook] Vaulting card token threw for camp ${campId}: ${(err as Error).message}`);
    return null;
  }
}

serve(async (req) => {
  if (req.method !== "POST") return text("Method not allowed", 405);

  try {
    const url = new URL(req.url);
    const campId = url.searchParams.get("campId");
    if (!campId) return text("Missing campId", 400);

    const rawBody = await req.text();
    const signature = req.headers.get("ck-signature") || "";

    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const { data: credResult } = await service.rpc("_admin_get_processor_credential", { p_camp_id: campId });
    if (!credResult?.success || credResult.processorKey !== "cardknox") {
      console.error(`[cardknox-webhook] No verified cardknox credential for camp ${campId}`);
      return text("Unknown camp", 200); // don't leak which campIds exist; don't invite retries either
    }
    const webhookPin = credResult.credentials?.webhookPin;
    if (!webhookPin) {
      console.error(`[cardknox-webhook] Camp ${campId} has no webhookPin on file — cannot verify`);
      return text("Not configured", 200);
    }
    if (!verifySignature(rawBody, webhookPin, signature)) {
      console.error(`[cardknox-webhook] Signature mismatch for camp ${campId}`);
      return text("Invalid signature", 401);
    }

    const fields = new URLSearchParams(rawBody);
    // Mutable: the amount-fallback branch below fills this in from the
    // matched intent's own reference when Sola's payload doesn't carry one.
    let xInvoice = fields.get("xInvoice") || fields.get("xinvoice") || "";
    const xRefNum = fields.get("xRefNum") || fields.get("xrefnum") || "";
    const xResult = fields.get("xResponseResult") || fields.get("xresponseresult") || "";
    const xAmount = fields.get("xAmount") || fields.get("xamount") || "";
    const xToken = fields.get("xToken") || fields.get("xtoken") || "";
    const xMaskedCardNumber = fields.get("xMaskedCardNumber") || fields.get("xmaskedcardnumber") || "";

    type IntentMatch = { success: boolean; campId?: string; kind?: string; familyKey?: string; familyName?: string; camperName?: string; amountCents?: number; status?: string };
    let intent: IntentMatch | null = null;

    if (xInvoice) {
      const { data } = await service.rpc("get_cardknox_checkout_intent", { p_reference: xInvoice });
      if (data?.success) intent = data;
    }

    if (!intent) {
      // Sola's hosted-checkout webhook (confirmed via live testing,
      // 2026-09-08) never echoes xInvoice back at all — its payload is a
      // fixed small set of fields (xAmount/xEnteredDate/xMaskedCardNumber/
      // xRefNum/xRequestAmount/xResponseResult/xToken), unlike what Sola's
      // Direct API docs describe for a merchant reference. That leaves
      // amount as the only correlation available, scoped to this camp (via
      // ?campId= on the Postback URL, which Sola DOES preserve) within a
      // bounded lookback window. Ambiguous (more than one pending intent at
      // the same amount) is deliberately left alone rather than guessed —
      // guessing wrong here means crediting the wrong family's payment.
      const amountCents = Math.round(parseFloat(xAmount || "0") * 100);
      if (amountCents > 0) {
        const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const { data: candidates } = await service.from("cardknox_checkout_intents")
          .select("*")
          .eq("camp_id", campId)
          .eq("status", "pending")
          .eq("amount_cents", amountCents)
          .gte("created_at", cutoff);
        if (candidates && candidates.length === 1) {
          const row = candidates[0];
          xInvoice = row.reference;
          intent = {
            success: true, campId: row.camp_id, kind: row.kind, familyKey: row.family_key,
            familyName: row.family_name, camperName: row.camper_name, amountCents: row.amount_cents,
            status: row.status,
          };
        } else if (candidates && candidates.length > 1) {
          console.error(`[cardknox-webhook] Ambiguous amount match for camp ${campId}: ${candidates.length} pending intents at $${xAmount}, xRefNum=${xRefNum} — refusing to guess, needs manual reconciliation`);
          return text("ok", 200);
        }
      }
    }

    if (!intent?.success) {
      console.log(`[cardknox-webhook] No matching intent for camp ${campId}, xRefNum=${xRefNum}, amount=${xAmount} — ignoring (not ours). Full payload:`, JSON.stringify(Object.fromEntries(fields.entries())));
      return text("ok", 200);
    }
    if (intent.campId !== campId) {
      console.error(`[cardknox-webhook] Intent ${xInvoice} belongs to camp ${intent.campId}, not ${campId} — refusing`);
      return text("Camp mismatch", 200);
    }
    if (intent.status !== "pending") {
      console.log(`[cardknox-webhook] Intent ${xInvoice} already ${intent.status} — ignoring duplicate delivery`);
      return text("ok", 200);
    }

    if (xResult !== "Approved") {
      await service.rpc("mark_cardknox_checkout_intent_status", { p_reference: xInvoice, p_status: "failed", p_xref_num: xRefNum || null });
      console.log(`[cardknox-webhook] Intent ${xInvoice} not approved (xResponseResult=${xResult}) — no credit issued`);
      return text("ok", 200);
    }

    // A card save (Sola's cc:save — migration 135) moves no money, so it
    // skips everything below: no processor_transactions row, no ledger
    // write, and no xRefNum requirement, since the token is the entire
    // point of the transaction rather than an amount to record idempotently.
    if (intent.kind === "card_save") {
      if (!xToken) {
        console.error(`[cardknox-webhook] card_save ${xInvoice} approved but carried no xToken — nothing to save`);
        await service.rpc("mark_cardknox_checkout_intent_status", { p_reference: xInvoice, p_status: "failed", p_xref_num: xRefNum || null });
        return text("ok", 200);
      }
      const vaulted = await vaultCardknoxToken(service, campId, xToken);
      if (!vaulted) {
        console.error(`[cardknox-webhook] card_save ${xInvoice}: could not vault token`);
        return text("Vault failed", 500); // worth a retry from Sola's side
      }
      let savedCard = false;
      for (let attempt = 0; attempt < 4 && !savedCard; attempt++) {
        const cur = await service.from("camp_state_kv").select("value")
          .eq("camp_id", campId).eq("key", "campistryMe").maybeSingle();
        const me: Record<string, any> = (cur.data && cur.data.value && typeof cur.data.value === "object") ? cur.data.value : {};
        if (!me.families || typeof me.families !== "object") me.families = {};
        const fam = intent.familyKey ? me.families[intent.familyKey] : null;
        if (!fam) {
          console.error(`[cardknox-webhook] card_save ${xInvoice}: family ${intent.familyKey} gone for camp ${campId}`);
          break;
        }
        fam.byopProcessor = "cardknox";
        fam.byopCustomerRef = vaulted;
        fam.cardOnFile = true;
        fam.cardSavedDate = new Date().toISOString();
        const up = await service.from("camp_state_kv").upsert(
          { camp_id: campId, key: "campistryMe", value: me, updated_at: new Date().toISOString() },
          { onConflict: "camp_id,key" },
        );
        if (!up.error) savedCard = true;
      }
      if (!savedCard) {
        console.error(`[cardknox-webhook] card_save ${xInvoice}: could not record token for camp ${campId}`);
        return text("Record failed", 500);
      }
      await service.rpc("mark_cardknox_checkout_intent_status", { p_reference: xInvoice, p_status: "completed", p_xref_num: xRefNum || null });
      console.log(`[cardknox-webhook] Saved card for family ${intent.familyKey}, camp ${campId} (${xInvoice})`);
      return text("ok", 200);
    }

    // Canteen auto-reload's card save (migration 136) — same cc:save/no-money
    // shape as card_save above, but the token lands on the CAMPER's
    // campistrySnacks.accounts[camperName].autoReload block instead of a
    // family record, mirroring the field shape stripe-webhook's
    // handleCanteenAutoReloadSetup already writes (cardOnFile/
    // paymentMethodType/paymentMethodLabel/cardSavedDate) so
    // canteen-auto-reload's cron and the parent-portal status display don't
    // need to special-case which processor saved the card — only the
    // presence of byopCustomerRef (Cardknox) vs stripeCustomerId (Stripe)
    // tells the cron which charge path to use. Never touches
    // enabled/threshold*/schedule* — that's the parent's own trigger config,
    // set separately via set_canteen_auto_reload and merged into, not
    // overwritten by, this block.
    if (intent.kind === "canteen_autoreload_setup") {
      if (!xToken) {
        console.error(`[cardknox-webhook] canteen_autoreload_setup ${xInvoice} approved but carried no xToken — nothing to save`);
        await service.rpc("mark_cardknox_checkout_intent_status", { p_reference: xInvoice, p_status: "failed", p_xref_num: xRefNum || null });
        return text("ok", 200);
      }
      const vaulted = await vaultCardknoxToken(service, campId, xToken);
      if (!vaulted) {
        console.error(`[cardknox-webhook] canteen_autoreload_setup ${xInvoice}: could not vault token`);
        return text("Vault failed", 500); // worth a retry from Sola's side
      }
      let savedCard = false;
      for (let attempt = 0; attempt < 4 && !savedCard; attempt++) {
        const cur = await service.from("camp_state_kv").select("value")
          .eq("camp_id", campId).eq("key", "campistrySnacks").maybeSingle();
        const snacks: Record<string, any> = (cur.data && cur.data.value && typeof cur.data.value === "object")
          ? cur.data.value : { accounts: {}, transactions: [] };
        if (!snacks.accounts || typeof snacks.accounts !== "object") snacks.accounts = {};
        const camperName = intent.camperName as string;
        const acct = snacks.accounts[camperName] || (snacks.accounts[camperName] = { balance: 0, dailyLimit: 10, spentToday: 0 });
        const ar = acct.autoReload || (acct.autoReload = {});
        ar.byopProcessor = "cardknox";
        ar.byopCustomerRef = vaulted;
        ar.cardOnFile = true;
        ar.paymentMethodType = "card";
        const last4 = xMaskedCardNumber.replace(/[^0-9]/g, "").slice(-4);
        if (last4) ar.paymentMethodLabel = "Card ···· " + last4;
        ar.cardSavedDate = new Date().toISOString();
        const up = await service.from("camp_state_kv").upsert(
          { camp_id: campId, key: "campistrySnacks", value: snacks, updated_at: new Date().toISOString() },
          { onConflict: "camp_id,key" },
        );
        if (!up.error) savedCard = true;
      }
      if (!savedCard) {
        console.error(`[cardknox-webhook] canteen_autoreload_setup ${xInvoice}: could not record token for camp ${campId}`);
        return text("Record failed", 500);
      }
      await service.rpc("mark_cardknox_checkout_intent_status", { p_reference: xInvoice, p_status: "completed", p_xref_num: xRefNum || null });
      console.log(`[cardknox-webhook] Saved auto-reload card for camper ${intent.camperName}, camp ${campId} (${xInvoice})`);
      return text("ok", 200);
    }

    if (!xRefNum) {
      console.error(`[cardknox-webhook] Approved webhook for ${xInvoice} has no xRefNum — cannot record idempotently, refusing to credit`);
      return text("ok", 200);
    }

    await service.rpc("record_processor_transaction", {
      p_camp_id: campId,
      p_processor_key: "cardknox",
      p_external_transaction_id: xRefNum,
      p_kind: "charge",
      p_amount_cents: intent.amountCents,
      p_status: "Approved",
      p_raw_response: Object.fromEntries(fields.entries()),
    });

    if (intent.kind === "canteen_deposit") {
      const { data: creditResult, error: creditErr } = await service.rpc("credit_canteen_balance_from_processor", {
        p_camp_id: campId,
        p_camper_name: intent.camperName,
        p_amount: intent.amountCents / 100,
        p_processor_key: "cardknox",
        p_external_transaction_id: xRefNum,
      });
      if (creditErr || !creditResult?.success) {
        console.error(`[cardknox-webhook] Canteen credit failed for ${xInvoice}/${xRefNum}:`, creditErr?.message || creditResult?.error);
        return text("Credit failed", 500); // worth a retry from Sola's side
      }
    } else {
      // Tuition — same read-modify-write into campistryMe.finance.payments
      // payments-checkout already does (duplicated rather than shared,
      // matching this project's existing convention of small per-function
      // duplication over a cross-function import chain — see
      // stripe-canteen-refund's own header comment for the same reasoning).
      let saved = false;
      for (let attempt = 0; attempt < 4 && !saved; attempt++) {
        const cur = await service.from("camp_state_kv").select("value")
          .eq("camp_id", campId).eq("key", "campistryMe").maybeSingle();
        const me: Record<string, any> = (cur.data && cur.data.value && typeof cur.data.value === "object") ? cur.data.value : {};
        if (!me.families || typeof me.families !== "object") me.families = {};
        const f = intent.familyKey ? me.families[intent.familyKey] : null;
        if (!f) {
          console.error(`[cardknox-webhook] Family ${intent.familyKey} gone for camp ${campId} — payment ${xRefNum} not recorded`);
          break;
        }

        f.byopProcessor = "cardknox";
        f.cardOnFile = true;
        // Sola's webhook hands back an xToken for the card that was just
        // used (confirmed live in a real payload). Vaulting it as this
        // family's byopCustomerRef is what lets charge-due-installments
        // actually charge an autopay plan later — without it, a family who
        // paid through hosted checkout has cardOnFile:true but nothing
        // chargeable behind it, and their payment plan silently never runs.
        // Only set on the FIRST capture: never overwrite a token the office
        // saved deliberately through campistry_card_setup.html.
        if (xToken && !f.byopCustomerRef) {
          const vaulted = await vaultCardknoxToken(service, campId, xToken);
          if (vaulted) f.byopCustomerRef = vaulted;
        }

        if (!me.finance) me.finance = {};
        if (!Array.isArray(me.finance.payments)) me.finance.payments = [];
        const pays: Record<string, any>[] = me.finance.payments;
        if (!pays.find((p) => p.byopTransactionId === xRefNum)) {
          pays.push({
            id: "byop_" + xRefNum,
            family: intent.familyName || f.name || "",
            familyKey: intent.familyKey,
            amount: intent.amountCents / 100,
            date: new Date().toISOString().split("T")[0],
            method: "Sola Checkout (online)",
            reference: xRefNum,
            notes: "Online payment (Sola hosted checkout)",
            byopTransactionId: xRefNum,
            byopProcessor: "cardknox",
            status: "succeeded",
            timestamp: Date.now(),
          });
        }

        const up = await service.from("camp_state_kv").upsert(
          { camp_id: campId, key: "campistryMe", value: me, updated_at: new Date().toISOString() },
          { onConflict: "camp_id,key" },
        );
        if (!up.error) saved = true;
      }
      if (!saved) {
        console.error(`[cardknox-webhook] Could not record tuition payment ${xRefNum} for camp ${campId} after retries`);
        return text("Record failed", 500); // worth a retry from Sola's side
      }
    }

    await service.rpc("mark_cardknox_checkout_intent_status", { p_reference: xInvoice, p_status: "completed", p_xref_num: xRefNum });
    console.log(`[cardknox-webhook] Credited ${intent.kind} ${xInvoice}/${xRefNum}: $${xAmount || (intent.amountCents / 100)}, camp ${campId}`);
    return text("ok", 200);
  } catch (err) {
    console.error("[cardknox-webhook] Error:", (err as Error).message);
    return text("error", 500);
  }
});
