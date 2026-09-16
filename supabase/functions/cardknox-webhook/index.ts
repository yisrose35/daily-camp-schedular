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
// fallback below: match the single still-pending intent for this camp
// (from ?campId=) within a bounded lookback window, on dollar amount for a
// real charge (tuition_charge/canteen_deposit) or, since a card-save (Sola's
// cc:save) carries no amount at all, on zero-amount + kind for a card_save/
// canteen_autoreload_setup intent instead. More than one candidate at the
// same key is the one case this can't resolve — it's left alone rather than
// guessed at, since a wrong guess means crediting the wrong family's
// payment (or vaulting a card onto the wrong family).
//
// Response: always 200 unless the signature itself fails to verify — Sola
// has no reason to retry a webhook we understood and (correctly) did
// nothing with.
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import md5 from "https://esm.sh/js-md5@0.8.3";

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

    type IntentMatch = { success: boolean; campId?: string; kind?: string; familyKey?: string; familyName?: string; camperName?: string; enrollmentId?: string; amountCents?: number; status?: string };
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
      //
      // card_save/canteen_autoreload_setup carry NO amount (Sola's cc:save
      // has nothing to charge), so xAmount is always "0.00"/empty for these
      // — a bare `amountCents > 0` gate skipped this branch entirely for
      // every card save, so the webhook could never resolve back to its
      // intent and silently dropped it (confirmed live: Sola showed the
      // card saved on its own side, but nothing ever reached
      // savedPaymentMethods). Zero-amount callbacks are resolved the same
      // way, just narrowed to the zero-amount, tokenize-only kinds instead
      // of matching on amount — a real charge can never land here since
      // tuition_charge/canteen_deposit intents always have amount_cents > 0.
      const amountCents = Math.round(parseFloat(xAmount || "0") * 100);
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      let candidateQuery = service.from("cardknox_checkout_intents")
        .select("*")
        .eq("camp_id", campId)
        .eq("status", "pending")
        .gte("created_at", cutoff);
      candidateQuery = amountCents > 0
        ? candidateQuery.eq("amount_cents", amountCents)
        : candidateQuery.eq("amount_cents", 0).in("kind", ["card_save", "canteen_autoreload_setup"]);
      const { data: candidates } = await candidateQuery;
      if (candidates && candidates.length === 1) {
        const row = candidates[0];
        xInvoice = row.reference;
        intent = {
          success: true, campId: row.camp_id, kind: row.kind, familyKey: row.family_key,
          familyName: row.family_name, camperName: row.camper_name,
          // Sola does not echo xInvoice back, so this amount-matched path is
          // the NORMAL one for a hosted-checkout payment. Leaving this out
          // would resolve a registration deposit to an intent with no
          // application to credit, and the money would land nowhere.
          enrollmentId: row.enrollment_id,
          amountCents: row.amount_cents,
          status: row.status,
        };
      } else if (candidates && candidates.length > 1) {
        console.error(`[cardknox-webhook] Ambiguous match for camp ${campId}: ${candidates.length} pending intents at $${xAmount}, xRefNum=${xRefNum} — refusing to guess, needs manual reconciliation`);
        return text("ok", 200);
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

    // ── a registration deposit ──────────────────────────────────────────────
    // There is no family record yet — the office has not accepted anybody — so
    // this credits the APPLICATION. Its own branch, ahead of everything
    // family-scoped below, which would otherwise look for a familyKey that
    // does not exist.
    if (intent.kind === "registration_deposit") {
      const enrollId = String(intent.enrollmentId || "");
      if (!enrollId) {
        console.error(`[cardknox-webhook] registration deposit ${xInvoice} has no application on its intent — cannot credit`);
        await service.rpc("mark_cardknox_checkout_intent_status", { p_reference: xInvoice, p_status: "failed", p_xref_num: xRefNum || null });
        return text("ok", 200);
      }
      const paid = (intent.amountCents || Math.round(parseFloat(xAmount || "0") * 100)) / 100;

      // Recorded first, so the reconciliation tool in Finance can see a charge
      // that exists on the processor even if the step after it fails.
      await service.rpc("record_processor_transaction", {
        p_camp_id: campId,
        p_processor_key: "cardknox",
        p_external_transaction_id: xRefNum || xInvoice,
        p_kind: "charge",
        p_amount_cents: Math.round(paid * 100),
        p_status: "approved",
        p_raw_response: { source: "registration_deposit", enrollmentId: enrollId },
      });

      const { data: rec, error: recErr } = await service.rpc("_record_registration_deposit", {
        p_camp_id: campId,
        p_enroll_id: enrollId,
        p_amount: paid,
        p_reference: xRefNum || xInvoice,
      });
      if (recErr || !(rec as any)?.success) {
        // The money moved. A 500 asks Sola to retry, which is the right answer
        // here — a silent success would leave a paid family marked unpaid.
        console.error(`[cardknox-webhook] could not mark registration deposit for ${enrollId}: ${recErr?.message || (rec as any)?.error}`);
        return text("Could not record deposit", 500);
      }

      // The card, only when the parent asked on the way in — xToken only comes
      // back at all when the checkout was told to save one.
      if (xToken) {
        const vaulted = await vaultCardknoxToken(service, campId, xToken);
        if (vaulted) {
          const last4 = (xMaskedCardNumber || "").replace(/[^0-9]/g, "").slice(-4);
          const { error: cardErr } = await service.rpc("_record_registration_card", {
            p_camp_id: campId,
            p_enroll_id: enrollId,
            p_processor: "cardknox",
            p_customer: vaulted,
            p_method: "",
            p_last4: last4,
          });
          // Not fatal: the deposit is marked and the money is in. A card that
          // did not stick means typing it once more later.
          if (cardErr) console.warn(`[cardknox-webhook] card not saved for ${enrollId}: ${cardErr.message}`);
        } else {
          console.warn(`[cardknox-webhook] could not vault the card for ${enrollId} — deposit still recorded`);
        }
      }

      await service.rpc("mark_cardknox_checkout_intent_status", { p_reference: xInvoice, p_status: "completed", p_xref_num: xRefNum || null });
      // A registration deposit is the FIRST money a family ever sends this
      // camp, from a form, to a processor they have never seen — so it is the
      // charge most likely to be queried. There is no family record yet, so the
      // parent's address comes off the application via the enrollment id.
      await sendReceipt({
        campId, enrollmentId: enrollId, ref: String(xRefNum || xInvoice || ""),
        amount: paid, what: "Registration deposit", method: "Card",
      });
      console.log(`[cardknox-webhook] registration deposit $${paid} marked on ${enrollId}${(rec as any)?.duplicate ? " (already recorded)" : ""}`);
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
      // Migration 139: savedPaymentMethods is a real LIST, not a single slot.
      // The first-ever card for a family becomes the default and syncs the
      // legacy single-slot fields (autopay and every other existing charge path
      // reads those directly); an ADDITIONAL card just appends as non-default,
      // leaving whatever the family currently charges completely alone.
      //
      // Which of those it is depends on whether the list is empty, so migration
      // 170's append_family_payment_method decides it under the row lock. The
      // read-push-upsert this replaces lost one of two cards saved at once, and
      // appended the SAME card twice if Sola redelivered the webhook.
      const last4 = (xMaskedCardNumber || "").replace(/[^0-9]/g, "").slice(-4);
      const { data: saved, error: saveErr } = await service.rpc("append_family_payment_method", {
        p_camp_id: campId,
        p_family_key: intent.familyKey || "",
        p_method: {
          id: "pm_" + crypto.randomUUID().replace(/-/g, ""),
          type: "card",
          processor: "cardknox",
          token: vaulted,
          last4,
          label: last4 ? `Card ···· ${last4}` : "Card on file",
          addedDate: new Date().toISOString(),
        },
        p_default_fields: {
          byopProcessor: "cardknox",
          byopCustomerRef: vaulted,
          cardOnFile: true,
          cardSavedDate: new Date().toISOString(),
          // Legacy single-slot fields get_my_balance reads for the autopay card
          // display (v_fam->>'paymentMethodLabel'). Without these the parent
          // portal only ever shows a generic "a card" instead of the last four
          // — the actual number the office and the parent expect to see.
          paymentMethodType: "card",
          paymentMethodLabel: last4 ? `Card ···· ${last4}` : "Card on file",
        },
      });
      if (saveErr || !saved?.success) {
        const why = saveErr?.message || saved?.error || "unknown";
        console.error(`[cardknox-webhook] card_save ${xInvoice}: could not record token for camp ${campId} (${why})`);
        // family_not_found is permanent — the family was deleted between the
        // parent starting the save and Sola confirming it, so a retry would
        // fail identically. Anything else is worth Sola retrying.
        if (saved?.error === "family_not_found") {
          await service.rpc("mark_cardknox_checkout_intent_status", { p_reference: xInvoice, p_status: "failed", p_xref_num: xRefNum || null });
          return text("ok", 200);
        }
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
      // Migration 170's merge_canteen_autoreload_card — a shallow merge under a
      // row lock. The blob this touches holds the canteen TRANSACTION LEDGER,
      // and the canteen balance is recomputed from it, so the whole-blob upsert
      // this replaces could erase a POS sale (and its money) if a camper bought
      // something in the seconds a parent was saving a card.
      const arLast4 = (xMaskedCardNumber || "").replace(/[^0-9]/g, "").slice(-4);
      const { data: merged, error: mergeErr } = await service.rpc("merge_canteen_autoreload_card", {
        p_camp_id: campId,
        p_camper: String(intent.camperName || ""),
        p_fields: {
          byopProcessor: "cardknox",
          byopCustomerRef: vaulted,
          cardOnFile: true,
          paymentMethodType: "card",
          ...(arLast4 ? { paymentMethodLabel: "Card ···· " + arLast4 } : {}),
          cardSavedDate: new Date().toISOString(),
        },
      });
      if (mergeErr || !merged?.success) {
        const why = mergeErr?.message || merged?.error || "unknown";
        console.error(`[cardknox-webhook] canteen_autoreload_setup ${xInvoice}: could not record token for camp ${campId} (${why})`);
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
      // ── atomic: family fields, then the payment ───────────────────────────
      // This was one blind read-modify-write of the whole campistryMe blob —
      // read, mutate families[...] AND finance.payments, upsert it all back —
      // with no lock and no version check, so any overlapping writer silently
      // discarded whichever change landed first. Worse than the others: the
      // vault call below is an await INSIDE that read-write window, so the
      // window was a network round trip wide, not microseconds.
      //
      // The read here is only to DECIDE what to change (never overwrite a
      // token or label the office saved deliberately). The writes are two
      // locked calls — see migration 168.
      let saved = false;
      const cur = await service.from("camp_state_kv").select("value")
        .eq("camp_id", campId).eq("key", "campistryMe").maybeSingle();
      const meNow: Record<string, any> = (cur.data && cur.data.value && typeof cur.data.value === "object") ? cur.data.value : {};
      const f = intent.familyKey ? ((meNow.families || {})[intent.familyKey] || null) : null;
      if (!f) {
        console.error(`[cardknox-webhook] Family ${intent.familyKey} gone for camp ${campId} — payment ${xRefNum} not recorded`);
      } else {
        const fields: Record<string, any> = { byopProcessor: "cardknox", cardOnFile: true };

        // Sola's webhook hands back an xToken for the card that was just used.
        // Vaulting it as this family's byopCustomerRef is what lets
        // charge-due-installments actually charge an autopay plan later —
        // without it, a family who paid through hosted checkout has
        // cardOnFile:true but nothing chargeable behind it, and their payment
        // plan silently never runs. Only on the FIRST capture: never overwrite
        // a token the office saved through campistry_card_setup.html.
        //
        // Two captures at once could both see no token and both vault. That
        // leaves one unused token at the processor — harmless, and a far better
        // trade than holding a database lock across a network call.
        if (xToken && !f.byopCustomerRef) {
          const vaulted = await vaultCardknoxToken(service, campId, xToken);
          if (vaulted) fields.byopCustomerRef = vaulted;
        }

        // Record the card's last four so the parent-portal autopay display
        // shows the real number instead of a generic "a card". Backfill only
        // when we don't already have a label, so a deliberately-saved card's
        // label is never clobbered by a later one-off payment on another card.
        const last4 = (xMaskedCardNumber || "").replace(/[^0-9]/g, "").slice(-4);
        if (last4 && !f.paymentMethodLabel) {
          fields.paymentMethodType = f.paymentMethodType || "card";
          fields.paymentMethodLabel = `Card ···· ${last4}`;
        }

        const famRes = await service.rpc("merge_camp_family_fields", {
          p_camp_id: campId, p_family_key: intent.familyKey, p_fields: fields,
        });
        if (famRes.error || famRes.data?.success !== true) {
          console.error(`[cardknox-webhook] could not save card fields for ${intent.familyKey}: ${famRes.error?.message || famRes.data?.error || "unknown"}`);
        }

        const payRes = await service.rpc("append_camp_payment", {
          p_camp_id: campId,
          p_payment: {
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
          },
          p_dedupe_key: xRefNum,
        });
        saved = !payRes.error && payRes.data?.success === true;
      }
      if (!saved) {
        console.error(`[cardknox-webhook] Could not record tuition payment ${xRefNum} for camp ${campId} after retries`);
        return text("Record failed", 500); // worth a retry from Sola's side
      }
    }

    await service.rpc("mark_cardknox_checkout_intent_status", { p_reference: xInvoice, p_status: "completed", p_xref_num: xRefNum });
    // Sola's hosted checkout shows its own confirmation page and then the
    // parent leaves. Nothing else in this flow ever reaches their inbox.
    await sendReceipt({
      campId, ref: String(xRefNum || ""), amount: intent.amountCents / 100,
      familyKey: intent.familyKey || null,
      camperName: intent.kind === "canteen_deposit" ? intent.camperName : null,
      what: intent.kind === "canteen_deposit" ? "Canteen funds" : "Camp payment",
      method: "Card",
    });
    console.log(`[cardknox-webhook] Credited ${intent.kind} ${xInvoice}/${xRefNum}: $${xAmount || (intent.amountCents / 100)}, camp ${campId}`);
    return text("ok", 200);
  } catch (err) {
    console.error("[cardknox-webhook] Error:", (err as Error).message);
    return text("error", 500);
  }
});
