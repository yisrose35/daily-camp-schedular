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
    const xInvoice = fields.get("xInvoice") || fields.get("xinvoice") || "";
    const xRefNum = fields.get("xRefNum") || fields.get("xrefnum") || "";
    const xResult = fields.get("xResponseResult") || fields.get("xresponseresult") || "";
    const xAmount = fields.get("xAmount") || fields.get("xamount") || "";

    if (!xInvoice) {
      // A real, legitimately-signed webhook from a transaction that didn't
      // originate from cardknox-checkout-start (e.g. the office charged
      // someone directly through the Sola portal) — nothing for us to do.
      console.log(`[cardknox-webhook] No xInvoice on signed webhook for camp ${campId}, xRefNum=${xRefNum} — ignoring (not ours)`);
      return text("ok", 200);
    }

    const { data: intent } = await service.rpc("get_cardknox_checkout_intent", { p_reference: xInvoice });
    if (!intent?.success) {
      console.log(`[cardknox-webhook] No intent found for reference ${xInvoice} (camp ${campId}) — ignoring`);
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
