// =============================================================================
// payments-charge-nonce — charge a FRESH card (a tokenizer nonce) once, for a
// tuition payment or a canteen deposit, from Campistry's own card page.
//
// Replaces payments-checkout + payments-canteen-checkout for Banquest. Those
// two import ../_shared/processor_adapter.ts, which cannot bundle when a
// function is deployed by pasting ONE file into the Supabase Dashboard (this
// project has no Supabase CLI — see CLAUDE.md), so neither of them can even
// boot. Everything here is inlined for that reason.
//
// This is the "parent has no saved card and no session" path: the card page
// (campistry_card_setup.html) tokenizes the card in Banquest's own iframe, then
// posts the resulting single-use nonce here with the amount. We charge it and
// record the result. The nonce is NOT saved as a reusable card — that's
// payments-save-method's job.
//
// Request:  { campId, kind: 'tuition_charge'|'canteen_deposit',
//             token,            // the tokenizer nonce (single-use)
//             amount,
//             familyKey?, familyName?,   // tuition
//             camperName?,               // canteen
//             description?, billing? }
// Response: { success: true, amount, last4? } | { success: false, error }
//
// Auth: anon key only, like every other hosted-card-page function here — the
// parent following an emailed link has no Supabase session. That is safe
// because this endpoint cannot move money on its own: it can only charge a
// nonce the caller already obtained by typing a real card into the processor's
// iframe, and it charges it to the CAMP's own merchant account. campId/amount
// are client-supplied, so we confirm the family/camper exists under that camp
// before recording anything against it, and the recorded amount is the amount
// the GATEWAY says it captured, never the client's number.
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ── Banquest (AffiniPay/8am) ────────────────────────────────────────────────
// Keep in sync with _shared/adapters/banquest_adapter.ts and the other inlined
// copies. The v2 API always lives under /api/v2; append it when the stored
// gatewayUrl is a bare host. Approval is status_code "A"; the integer
// reference_number is what we store so a later refund/reversal can find it.
const BANQUEST_DEFAULT_BASE = "https://api.banquestgateway.com/api/v2";
function bqBase(c: Record<string, string>): string {
  let b = (c.gatewayUrl || BANQUEST_DEFAULT_BASE).replace(/\/+$/, "");
  if (!/\/(api\/)?v\d+$/i.test(b)) b += "/api/v2";
  return b;
}
function bqAuth(c: Record<string, string>): string {
  return "Basic " + btoa(`${c.sourceKey}:${c.pin}`);
}

// Maps the card page's collected fields (campistryMe.cardFormFields, migration
// 150) onto Banquest's shapes — billing_info is an Address, and the cardholder
// name arrives as one string Banquest wants split. Only non-empty values are
// sent: the gateway treats a blank AVS field worse than an absent one. Keep in
// sync with payments-save-method's copy.
function bqBillingParts(billing: Record<string, string> | null | undefined): Record<string, unknown> {
  const b = (billing && typeof billing === "object") ? billing : {};
  const out: Record<string, unknown> = {};
  const addr: Record<string, string> = {};
  const put = (k: string, v: unknown) => { const s = String(v ?? "").trim(); if (s) addr[k] = s; };

  if (b.name) {
    const parts = String(b.name).trim().split(/\s+/);
    put("first_name", parts.shift());
    put("last_name", parts.join(" "));
  }
  put("street", b.street);
  put("street2", b.street2);
  put("city", b.city);
  put("state", b.state);
  put("zip", b.zip);
  put("country", b.country);
  put("phone", b.phone);
  if (Object.keys(addr).length) out.billing_info = addr;

  const email = String(b.email ?? "").trim();
  if (email) out.customer = { email };
  return out;
}

// The tokenizer hands the browser expiry_month/expiry_year/avs_zip alongside the
// nonce, and Banquest's own integration example sends them on with the charge —
// avs_zip in particular is what AVS actually checks.
function bqCardParts(card: Record<string, any> | null | undefined): Record<string, unknown> {
  const c = (card && typeof card === "object") ? card : {};
  const out: Record<string, unknown> = {};
  if (Number(c.expiryMonth) > 0) out.expiry_month = Number(c.expiryMonth);
  if (Number(c.expiryYear) > 0) out.expiry_year = Number(c.expiryYear);
  const zip = String(c.avsZip ?? "").trim();
  if (zip) out.avs_zip = zip;
  return out;
}

// Banquest's error_details is not a string — it's an object (often nested, or an
// array) keyed by the offending field, so interpolating it straight into a
// message yields "[object Object]". Flatten it to "field message; field message".
function bqErrDetail(d: unknown): string {
  if (d === null || d === undefined) return "";
  if (typeof d === "string") return d.trim();
  if (typeof d === "number" || typeof d === "boolean") return String(d);
  if (Array.isArray(d)) return d.map(bqErrDetail).filter(Boolean).join("; ");
  if (typeof d === "object") {
    return Object.entries(d as Record<string, unknown>)
      .map(([k, v]) => { const s = bqErrDetail(v); return s ? `${k}: ${s}` : k; })
      .filter(Boolean).join("; ");
  }
  return String(d);
}

async function banquestChargeNonce(
  creds: Record<string, string>,
  amountCents: number,
  nonce: string,
  description: string,
  billing: Record<string, string> | null | undefined,
  card: Record<string, any> | null | undefined,
) {
  // Banquest REQUIRES expiry_month/expiry_year alongside a nonce source (a
  // verify without them returns {"required":["Must have required property
  // 'expiry_month'", ...]}). A cached page that predates us sending `card`
  // would omit them, so fail with something actionable instead of an opaque
  // gateway validation error.
  const cardParts = bqCardParts(card);
  if (cardParts.expiry_month === undefined || cardParts.expiry_year === undefined) {
    return { success: false, error: "The card's expiry didn't come through — please refresh the page and re-enter the card." };
  }
  const resp = await fetch(`${bqBase(creds)}/transactions/charge`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": bqAuth(creds) },
    body: JSON.stringify({
      amount: Number((amountCents / 100).toFixed(2)),
      source: "nonce-" + nonce,
      transaction_details: { description: description.slice(0, 255) },
      ...cardParts,
      ...bqBillingParts(billing),
    }),
  });
  let data: Record<string, any> = {};
  try { data = await resp.json(); } catch { /* non-JSON error body */ }
  const approved = String(data?.status_code || "").toUpperCase() === "A"
                || String(data?.status || "").toLowerCase() === "approved";
  const ref = data?.reference_number != null ? String(data.reference_number) : "";
  if (resp.status < 200 || resp.status >= 300 || !approved || !ref) {
    // Same reasoning as payments-save-method: a bare "Validation error" in
    // error_message is useless without error_details naming the field.
    console.error("[payments-charge-nonce] banquest charge failed:", resp.status, JSON.stringify(data));
    const detail = bqErrDetail(data?.error_details) || bqErrDetail(data?.error_messages);
    const base = data?.error_message || data?.error || data?.message || data?.status || `Declined (HTTP ${resp.status})`;
    return { success: false, error: String(detail ? `${base}: ${detail}` : base) };
  }
  // auth_amount is what actually got captured; fall back to what we asked for.
  const capturedCents = Number(data?.auth_amount) > 0 ? Math.round(Number(data.auth_amount) * 100) : amountCents;
  return {
    success: true,
    externalTransactionId: ref,
    amountCents: capturedCents,
    last4: data?.last_4 ? String(data.last_4) : (card?.last4 ? String(card.last4) : undefined),
    brand: data?.card_type ? String(data.card_type) : (card?.cardType ? String(card.cardType) : undefined),
  };
}

// ── Subject existence checks (campId is client-supplied) ────────────────────
async function getFamily(service: ReturnType<typeof createClient>, campId: string, familyKey: string) {
  // The family ROW (camp_family), not the campistryMe document's copy, which
  // lags every server-side write until somebody saves the Me page.
  const { data, error } = await service.rpc("camp_family", { p_camp_id: campId, p_family_key: familyKey });
  if (error || !data || typeof data !== "object") return null;
  return data as Record<string, any>;
}
async function campHasCamper(service: ReturnType<typeof createClient>, campId: string, camperName: string, camperId: number | null = null) {
  // The canteen accounts are ROWS since 219, and the page strips `accounts`
  // out of every campistrySnacks document save — so reading the document said
  // "no such camper" for everyone, and every canteen card deposit was refused.
  // canteen_camper_known (migration 243) asks the roster and the account rows.
  const { data, error } = await service.rpc("canteen_camper_known", {
    p_camp_id: campId, p_camper_name: camperName, p_camper_id: camperId,
  });
  if (error) {
    console.error("[campHasCamper] canteen_camper_known failed:", error.message);
    return false;   // fail closed: money is never taken for a camper we cannot confirm
  }
  return data === true;
}


/** A camper id sent by the page (campistry_camper_id_rpc.js adds it), or null. */
function camperIdIn(v: unknown): number | null {
  return v != null && /^\d+$/.test(String(v)) ? Number(v) : null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { campId, kind, token, amount, familyKey, familyName, camperName, camperId: bodyCamperId, description, billing, card } = await req.json();
    const camperId = camperIdIn(bodyCamperId);
    if (!campId || !kind || !token || !(Number(amount) > 0)) {
      return json({ success: false, error: "campId, kind, token, and a positive amount are required" }, 400);
    }
    if (kind !== "tuition_charge" && kind !== "canteen_deposit") {
      return json({ success: false, error: "kind must be tuition_charge or canteen_deposit" }, 400);
    }
    const amountCents = Math.round(Number(amount) * 100);
    if (amountCents < 50) return json({ success: false, error: "Minimum payment is $0.50." }, 400);

    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const { data: camp } = await service.from("camps").select("payment_processor_key").eq("id", campId).maybeSingle();
    const processorKey = camp?.payment_processor_key;
    if (processorKey !== "banquest") {
      return json({ success: false, error: `Paying by new card isn't wired for processor '${processorKey || "unknown"}' yet.` }, 400);
    }

    // Confirm the subject exists under this camp before charging in its name.
    let fam: Record<string, any> | null = null;
    if (kind === "canteen_deposit") {
      if (!camperName || !(await campHasCamper(service, campId, String(camperName), camperId))) {
        return json({ success: false, error: "Camper not found for this camp" }, 400);
      }
    } else {
      if (!familyKey) return json({ success: false, error: "familyKey is required for a tuition payment" }, 400);
      fam = await getFamily(service, campId, String(familyKey));
      if (!fam) return json({ success: false, error: "Family not found for this camp" }, 400);
    }

    const { data: credResult } = await service.rpc("_admin_get_processor_credential", { p_camp_id: campId });
    if (!credResult?.success) {
      return json({ success: false, error: credResult?.error || "This camp's processor isn't connected/verified yet." }, 400);
    }
    const creds = credResult.credentials as Record<string, string>;
    if (!creds?.sourceKey || !creds?.pin) {
      return json({ success: false, error: "This camp's Banquest credential is incomplete." }, 400);
    }

    const desc = String(description || (kind === "canteen_deposit" ? `Canteen funds — ${camperName}` : `Camp payment — ${familyName || familyKey}`));
    const res = await banquestChargeNonce(creds, amountCents, String(token), desc, billing, card);
    if (!res.success || !res.externalTransactionId) {
      return json({ success: false, error: res.error || "Card declined." }, 200);
    }
    const chargedCents = res.amountCents ?? amountCents;
    const charged = chargedCents / 100;
    const txnId = res.externalTransactionId;

    // Best-effort audit row; never fail a captured charge over bookkeeping.
    try {
      await service.rpc("record_processor_transaction", {
        p_camp_id: campId,
        p_processor_key: "banquest",
        p_external_transaction_id: txnId,
        p_kind: kind,
        p_amount_cents: chargedCents,
        p_status: "succeeded",
        p_raw_response: null,
      });
    } catch (e) {
      console.error("[payments-charge-nonce] record_processor_transaction failed (non-fatal):", (e as Error).message);
    }

    // ── canteen: credit the camper (idempotent on the gateway's txn id) ──────
    if (kind === "canteen_deposit") {
      const creditRes = await service.rpc("credit_canteen_balance_from_processor", {
        p_camp_id: campId,
        p_camper_name: camperName,
        p_camper_id: camperId,
        p_amount: charged,
        p_processor_key: "banquest",
        p_external_transaction_id: txnId,
        p_source: "parent",
      });
      if (creditRes.error || !creditRes.data?.success) {
        console.error(`[payments-charge-nonce] canteen credit failed camp ${campId}/${camperName} txn ${txnId}:`, creditRes.error?.message || creditRes.data?.error);
        return json({ success: false, error: "Your card was charged but crediting the balance failed — contact the camp office." }, 200);
      }
      console.log(`[payments-charge-nonce] canteen deposit $${charged} for ${camperName} (camp ${campId}) txn ${txnId}`);
      return json({ success: true, amount: charged, last4: res.last4 });
    }

    // ── tuition: append to the family ledger (dedup on the gateway txn id) ───
    // ── recorded through append_camp_payment, NOT a blind blob upsert ──────
    // This used to read campistryMe, push onto finance.payments and upsert the
    // whole blob, with no lock and no version check — so any writer that
    // overlapped (another webhook, the nightly autopay run, an office save)
    // silently discarded whichever append landed first. The card was charged
    // and Campistry had no record of it. The retry loop did not help: it
    // retried on a WRITE ERROR, and a lost update is not an error.
    //
    // The read below is only for the family's display name, so it needs no
    // lock and a stale answer is harmless — parent-side attribution matches on
    // familyKey, not on this string. The WRITE is what had to become atomic.
    // See migration 168.
    let famName = familyName || String(familyKey);
    try {
      const cur = await service.from("camp_state_kv").select("value")
        .eq("camp_id", campId).eq("key", "campistryMe").maybeSingle();
      const meNow: Record<string, any> = (cur.data?.value && typeof cur.data.value === "object") ? cur.data.value : {};
      const famNow = (meNow.families && meNow.families[String(familyKey)]) || null;
      if (famNow && famNow.name) famName = famNow.name;
    } catch (_) { /* cosmetic only */ }

    const rec = await service.rpc("append_camp_payment", {
      p_camp_id: campId,
      p_payment: {
        id: "byop_" + txnId,
        family: famName,
        familyKey: String(familyKey),
        amount: charged,
        date: new Date().toISOString().split("T")[0],
        method: "Card (Banquest)" + (res.last4 ? ` •••• ${res.last4}` : ""),
        reference: txnId,
        notes: desc,
        byopTransactionId: txnId,
        byopProcessor: "banquest",
        status: "succeeded",
        timestamp: Date.now(),
      },
      p_dedupe_key: txnId,
    });
    const recorded = !rec.error && rec.data?.success === true;
    if (!recorded) {
      console.error(`[payments-charge-nonce] captured ${txnId} but could not record it for camp ${campId}/${familyKey}`);
      return json({ success: false, error: "Your card was charged but recording it failed — contact the camp office." }, 200);
    }

    console.log(`[payments-charge-nonce] tuition $${charged} for ${familyKey} (camp ${campId}) txn ${txnId}`);
    return json({ success: true, amount: charged, last4: res.last4 });
  } catch (err) {
    console.error("[payments-charge-nonce] Error:", (err as Error).message);
    return json({ success: false, error: (err as Error).message }, 500);
  }
});
