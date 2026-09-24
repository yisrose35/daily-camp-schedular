// =============================================================================
// registration-deposit-checkout — pay a registration deposit from the form
//
// A camp can require money to hold a place. The form states the amount
// (migration 164); this takes it.
//
// THE ORDER MATTERS: the application is saved FIRST, then the parent pays
// against it. A form that refused to submit until a card cleared would throw
// away twenty minutes of typing on a declined card, and an unpaid application
// is a real state the office already understands -- "awaiting deposit".
//
// DELIBERATELY ITS OWN FUNCTION. stripe-checkout and payments-hosted-link both
// work today and both move money; widening either to accept a caller with no
// family record risks the flows camps already depend on. This one can only do
// the single thing it is for.
//
// THE PRICE IS NEVER THE CALLER'S. The amount comes from
// _registration_deposit_owed -- what the camp stamped on that application --
// never from the request body. The page asking is anonymous by design, so it
// must not be able to name its own figure in either direction.
//
// TWO WAYS IN. A parent on a Banquest camp types the card into the form
// itself (campistry_card_setup.html framed in mode=token) and sends the nonce
// here with the submission -- we charge it and there is no redirect at all.
// Stripe and Cardknox/Sola camps collect cards on their own hosted pages, so
// those still get a URL back. The amount is decided the same way in both.
//
// Request:  { campId, enrollmentId, returnUrl, saveCard?,
//             cardToken?, card?, billing? }   <- nonce path (Banquest)
// Response: { success, url } | { success, paid:true, amount, last4 }
//         | { success:false, error, reason? }
//
// Deploy as its own function in the Supabase Dashboard. Needs the same secrets
// the other payment functions use: STRIPE_SECRET_KEY for Stripe camps, nothing
// extra for Banquest (credentials are read per camp).
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";

// The camp the AUTHENTICATED caller is owner/admin of — the same rule the
// office's other charge functions use. The office's "charge deposit now"
// needs it (TED-069): it used to charge a parent's saved card for anyone who
// knew a camp id and an application id.
async function callerCampId(req: Request): Promise<string | null> {
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt || jwt === SUPABASE_ANON_KEY || !SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  const asUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData } = await asUser.auth.getUser();
  const uid = userData?.user?.id;
  if (!uid) return null;
  const { data: ownedCamps } = await asUser.from("camps").select("id").eq("owner", uid);
  const owned = Array.isArray(ownedCamps) && ownedCamps.length
    ? (ownedCamps.find((c: { id: string }) => c.id === uid) || ownedCamps[0]) : null;
  if (owned?.id) return owned.id;
  const { data: memberships } = await asUser.from("camp_users").select("camp_id, role")
    .eq("user_id", uid).not("accepted_at", "is", null)
    .order("accepted_at", { ascending: false }).limit(1);
  const m = Array.isArray(memberships) && memberships.length ? memberships[0] : null;
  if (m?.camp_id && (m.role === "owner" || m.role === "admin")) return m.camp_id;
  return null;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const BANQUEST_DEFAULT_BASE = "https://api.banquestgateway.com/api/v2";
// The camp's gateway address is stored as gatewayUrl, as every other Banquest
// call reads it (TED-070: this read apiHost, a field nothing stores, so a camp
// on any gateway but the default was charged at the wrong address).
function bqBase(c: Record<string, string>): string {
  let b = (c.gatewayUrl || c.apiHost || BANQUEST_DEFAULT_BASE).trim().replace(/\/+$/, "");
  if (!/\/(api\/)?v\d+$/i.test(b)) b += "/api/v2";
  return b;
}
function bqAuth(c: Record<string, string>): string {
  return "Basic " + btoa(`${c.sourceKey}:${c.pin}`);
}

// ── Banquest billing/card shapes ────────────────────────────────────────────
// Inlined, not imported: this project deploys an edge function by pasting ONE
// file into the Supabase Dashboard (no CLI -- see CLAUDE.md), so any relative
// import fails to bundle. Keep in sync with payments-charge-nonce's copies.
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
  put("street", b.street); put("street2", b.street2); put("city", b.city);
  put("state", b.state); put("zip", b.zip); put("country", b.country); put("phone", b.phone);
  if (Object.keys(addr).length) out.billing_info = addr;
  const email = String(b.email ?? "").trim();
  if (email) out.customer = { email };
  return out;
}

function bqCardParts(card: Record<string, any> | null | undefined): Record<string, unknown> {
  const c = (card && typeof card === "object") ? card : {};
  const out: Record<string, unknown> = {};
  if (Number(c.expiryMonth) > 0) out.expiry_month = Number(c.expiryMonth);
  if (Number(c.expiryYear) > 0) out.expiry_year = Number(c.expiryYear);
  const zip = String(c.avsZip ?? "").trim();
  if (zip) out.avs_zip = zip;
  return out;
}

// Banquest puts the useful part of a rejection in error_details (an object, or
// an array of them), so a bare error_message reads "Validation error" and
// names nothing.
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

/** A camper's name as a person reads it: without the roster's internal
 *  " #<number>" that tells two campers with one name apart. For what a parent
 *  sees; never for identifying the camper. */
function displayName(s: unknown): string {
  return String(s ?? "").replace(/\s#\d+(?:-\d+)?$/, "");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { campId, enrollmentId, returnUrl, saveCard, captureReference, keepOnFile, officeCharge } = await req.json();
    if (!campId || !enrollmentId || !returnUrl) {
      return json({ success: false, error: "campId, enrollmentId and returnUrl are required" }, 400);
    }
    // An open redirect here would let anyone turn the camp's own payment page
    // into a phishing hop.
    if (!/^https:\/\//.test(String(returnUrl))) {
      return json({ success: false, error: "returnUrl must be an https URL" }, 400);
    }

    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // What is owed, decided server-side from what the camp stamped.
    const { data: owedRes, error: owedErr } = await service.rpc("_registration_deposit_owed", {
      p_camp_id: campId,
      p_enroll_id: String(enrollmentId),
    });
    if (owedErr) {
      console.error(`[registration-deposit] owed lookup failed: ${owedErr.message}`);
      return json({ success: false, error: "Could not look up this application." }, 500);
    }
    if (!owedRes?.success) {
      return json({ success: false, error: "We could not find that application.", reason: owedRes?.error }, 404);
    }
    const owed = Number(owedRes.owed) || 0;
    if (owed <= 0) {
      // Not an error: a parent who pressed back, or whose payment already
      // landed, should be told it is settled rather than charged twice.
      return json({ success: true, alreadyPaid: true });
    }

    const label = String(owedRes.label || "Registration deposit") +
      (owedRes.camperName ? ` — ${displayName(owedRes.camperName)}` : "");

    // Which rail this camp is on. Exactly the same test the autopay cron uses,
    // so a camp cannot be on one processor here and another there.
    const { data: camp } = await service
      .from("camps")
      .select("payment_processor_key, stripe_account_id, stripe_charges_enabled")
      .eq("id", campId)
      .maybeSingle();
    const processorKey: string | null = camp?.payment_processor_key || null;

    // Filled in only by the office path below, which resolves the card from
    // the camp's own record instead of a capture row. Everything downstream
    // then treats the two identically.
    let claimOverride: Record<string, any> | null = null;

    // ── the office taking it against the card already on the application ────
    // Same charge as the capture path below, against the card the parent had
    // accepted when they applied -- just started from the office because the
    // automatic attempt did not land.
    //
    // The card references are read HERE, from what the camp's own record says,
    // never from the request. An office page cannot name someone else's card
    // any more than a parent's browser can name its own price.
    if (officeCharge && !captureReference) {
      const office = await callerCampId(req);
      if (!office || office !== String(campId)) {
        return json({ success: false, error: "Only the camp's owner or an admin can charge a deposit." }, 403);
      }
      const { data: kv } = await service.from("camp_state_kv").select("value")
        .eq("camp_id", campId).eq("key", "campistryMe").maybeSingle();
      const enr = (kv?.value as Record<string, any> | null)?.enrollments?.[String(enrollmentId)];
      if (!enr) return json({ success: false, error: "We could not find that application." }, 404);
      if (!enr.savedCardCustomer) {
        return json({ success: false, error: "There is no card on file for this application." }, 200);
      }
      // Hand it to the same code path as a fresh capture by describing the
      // card the same way _claim_card_capture would.
      claimOverride = {
        success: true,
        processor: String(enr.savedCardProcessor || processorKey || ""),
        customer: String(enr.savedCardCustomer || ""),
        method: String(enr.savedCardMethod || enr.savedCardCustomer || ""),
        last4: enr.savedCardLast4 ? String(enr.savedCardLast4) : null,
        brand: enr.savedCardBrand ? String(enr.savedCardBrand) : null,
      };
    }

    // ── the card the processor already accepted ─────────────────────────────
    // The parent settled the card BEFORE this form was submitted
    // (card-capture-start, migration 189): the processor said yes, the form
    // showed a tick, and only then would it let them submit. All that is left
    // is to charge it.
    //
    // The caller sends a capture reference and nothing else that matters. The
    // amount is `owed` above -- what the camp stamped on this application --
    // and the card is whatever _claim_card_capture hands back. A browser
    // cannot name either.
    if (captureReference || claimOverride) {
      const { data: claimed, error: claimErr } = claimOverride
        ? { data: claimOverride, error: null }
        : await service.rpc("_claim_card_capture", {
            p_camp_id: campId,
            p_reference: String(captureReference),
            p_enroll_id: String(enrollmentId),
          });
      const claim = claimed as Record<string, any> | null;
      if (claimErr || !claim?.success) {
        const why = claimErr?.message || claim?.error || "unknown";
        console.error(`[registration-deposit] capture ${captureReference} unusable for ${enrollmentId}: ${why}`);
        return json({
          success: false,
          error: claim?.error === "already_claimed"
            ? "That card has already been used for another application — please enter it again."
            : "We could not find the card you entered — please enter it again.",
        }, 200);
      }

      const amountCents = Math.round(owed * 100);
      let txnId = "", chargedCents = amountCents, declineMsg = "";

      // ONE charge per application at a time (TED-069): an office click and a
      // parent's retry arriving together could both pass the "owed" check above
      // and both charge. The claim is taken before the processor is called,
      // released if it declines, and kept once it succeeds.
      // Keyed on the amount too: a settled claim is kept, and a later, different
      // deposit on the same application must still be chargeable.
      const depositKey = "deposit:" + String(enrollmentId) + ":" + amountCents;
      const { data: dclaim } = await service.rpc("claim_refund_intent", {
        p_camp_id: campId, p_key: depositKey, p_amount: owed, p_payment_ref: String(enrollmentId),
      });
      if (dclaim && dclaim.claimed === false) {
        return json({ success: true, alreadyPaid: true, replayed: true });
      }
      const last4 = claim.last4 || null, brand = claim.brand || null;

      if (claim.processor === "banquest") {
        const { data: credRes } = await service.rpc("_admin_get_processor_credential", { p_camp_id: campId });
        const creds = (credRes?.credentials || credRes?.credential || credRes) as Record<string, string> | null;
        if (!creds?.sourceKey || !creds?.pin) {
          { await service.rpc("release_refund_intent", { p_camp_id: campId, p_key: depositKey }); return json({ success: false, error: "This camp has not finished setting up online payments." }, 200); }
        }
        // A saved card is charged as source "tkn-<card_ref>" -- the same shape
        // charge-due-installments already uses for autopay.
        const ref = String(claim.method || claim.customer || "");
        const resp = await fetch(`${bqBase(creds)}/transactions/charge`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": bqAuth(creds) },
          body: JSON.stringify({
            amount: Number(owed.toFixed(2)),
            source: /^(tkn-|pm-|ref-|nonce-)/.test(ref) ? ref : "tkn-" + ref,
            transaction_details: { description: label.slice(0, 255) },
          }),
        });
        let d: Record<string, any> = {};
        try { d = await resp.json(); } catch { /* non-JSON error body */ }
        const approved = String(d?.status_code || "").toUpperCase() === "A"
                      || String(d?.status || "").toLowerCase() === "approved";
        txnId = d?.reference_number != null ? String(d.reference_number) : "";
        if (resp.status < 200 || resp.status >= 300 || !approved || !txnId) {
          console.error(`[registration-deposit] banquest saved-card charge failed camp ${campId}:`, resp.status, JSON.stringify(d));
          const detail = bqErrDetail(d?.error_details) || bqErrDetail(d?.error_messages);
          const base = d?.error_message || d?.error || d?.message || `Declined (HTTP ${resp.status})`;
          declineMsg = String(detail ? `${base}: ${detail}` : base);
        } else if (Number(d?.auth_amount) > 0) {
          chargedCents = Math.round(Number(d.auth_amount) * 100);
        }
      } else if (claim.processor === "cardknox") {
        const { data: credResult } = await service.rpc("_admin_get_processor_credential", { p_camp_id: campId });
        const apiKey = credResult?.success ? credResult.credentials?.apiKey : null;
        if (!apiKey) { await service.rpc("release_refund_intent", { p_camp_id: campId, p_key: depositKey }); return json({ success: false, error: "This camp has not finished setting up online payments." }, 200); }
        // The unique xInvoice is load-bearing: Sola blocks a transaction whose
        // Key+Card+Amount+Invoice match another within 10 minutes.
        const resp = await fetch("https://x1.cardknox.com/gateway", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            xKey: apiKey, xVersion: "4.5.9", xSoftwareName: "Campistry", xSoftwareVersion: "1.0",
            xCommand: "cc:sale",
            xAmount: (amountCents / 100).toFixed(2),
            xToken: String(claim.method || claim.customer || ""),
            xInvoice: "RD-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          }).toString(),
        });
        const parsed: Record<string, string> = {};
        new URLSearchParams(await resp.text()).forEach((v, k) => { parsed[k] = v; });
        if (parsed.xResult !== "A") declineMsg = parsed.xError || "Declined";
        else txnId = parsed.xRefNum || "";
      } else if (claim.processor === "stripe") {
        if (!STRIPE_SECRET_KEY) { await service.rpc("release_refund_intent", { p_camp_id: campId, p_key: depositKey }); return json({ success: false, error: "Online payment is not configured." }, 200); }
        const params: Record<string, string> = {
          amount: String(amountCents), currency: "usd",
          customer: String(claim.customer || ""),
          off_session: "true", confirm: "true",
          description: label,
          "metadata[source]": "registration_deposit",
          "metadata[enrollmentId]": String(enrollmentId),
          "metadata[campId]": String(campId),
        };
        if (claim.method) params["payment_method"] = String(claim.method);
        // Money lands in the camp's own account when they are connected.
        if (camp?.stripe_charges_enabled && camp?.stripe_account_id) {
          params["transfer_data[destination]"] = String(camp.stripe_account_id);
          // The camp's name on the parent's statement, not the platform's
          // (TED-076) — the same pairing stripe-charge uses.
          params["on_behalf_of"] = String(camp.stripe_account_id);
        }
        const resp = await fetch("https://api.stripe.com/v1/payment_intents", {
          method: "POST",
          headers: { "Authorization": `Bearer ${STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded",
                     "Idempotency-Key": `deposit:${campId}:${enrollmentId}:${amountCents}` },
          body: new URLSearchParams(params).toString(),
        });
        const pi = await resp.json();
        if (!resp.ok || pi?.status !== "succeeded") {
          declineMsg = pi?.error?.message || pi?.last_payment_error?.message || "Declined";
        } else {
          txnId = String(pi.id);
          if (Number(pi.amount_received) > 0) chargedCents = Number(pi.amount_received);
        }
      } else {
        declineMsg = "This camp takes payment another way.";
      }

      if (declineMsg || !txnId) {
        await service.rpc("release_refund_intent", { p_camp_id: campId, p_key: depositKey });
        return json({ success: false, error: declineMsg || "The card was declined." }, 200);
      }
      await service.rpc("settle_refund_intent", {
        p_camp_id: campId, p_key: depositKey,
        p_result: { txnId, amount: chargedCents / 100, processor: String(claim.processor) },
      });

      const charged = chargedCents / 100;

      // Audit row: useful, but never worth failing a captured charge over.
      try {
        await service.rpc("record_processor_transaction", {
          p_camp_id: campId,
          p_processor_key: String(claim.processor),
          p_external_transaction_id: txnId,
          p_kind: "registration_deposit",
          p_amount_cents: chargedCents,
          p_status: "succeeded",
          p_raw_response: null,
        });
      } catch (e) {
        console.error("[registration-deposit] record_processor_transaction failed (non-fatal):", (e as Error).message);
      }

      // THIS one matters: money left the parent's card, so the application has
      // to show it as paid. Idempotent on the processor's own reference.
      const { data: markRes, error: markErr } = await service.rpc("_record_registration_deposit", {
        p_camp_id: campId,
        p_enroll_id: String(enrollmentId),
        p_amount: charged,
        p_reference: txnId,
      });
      if (markErr || !markRes?.success) {
        console.error(`[registration-deposit] captured ${txnId} but could not mark camp ${campId}/${enrollmentId}:`,
                      markErr?.message || markRes?.error);
        return json({
          success: false,
          error: "Your card was charged but recording it failed — please contact the camp office.",
        }, 200);
      }

      // The card is already vaulted at the processor -- that is what the
      // capture was, and what this charge just used. Whether it is KEPT, on
      // the application and so on the family the office creates from it, is
      // the parent's answer to the tick on the form. Without it, the vault
      // reference stops here: this charge used it, nothing else will.
      //
      // A failure here costs a convenience, not a payment, so it must not
      // fail the charge.
      if (claimOverride) {
        // The office path found this card BY reading it off the application,
        // so it is already recorded there. Nothing to carry over.
      } else if (!keepOnFile) {
        console.log(`[registration-deposit] ${enrollmentId}: parent did not ask to keep the card on file`);
      } else {
        try {
          await service.rpc("_record_registration_card", {
            p_camp_id: campId,
            p_enroll_id: String(enrollmentId),
            p_processor: String(claim.processor),
            p_customer: String(claim.customer || ""),
            p_method: String(claim.method || ""),
            p_last4: last4,
          });
        } catch (e) {
          console.error("[registration-deposit] saving the card failed (non-fatal):", (e as Error).message);
        }
      }

      console.log(`[registration-deposit] ${claim.processor} captured-card $${charged} enroll ${enrollmentId} (camp ${campId}) txn ${txnId}`);
      return json({ success: true, paid: true, amount: charged, last4, brand, processor: claim.processor });
    }

    // ── Banquest: a hosted pay page ─────────────────────────────────────────
    if (processorKey === "banquest") {
      const { data: credRes } = await service.rpc("_admin_get_processor_credential", { p_camp_id: campId });
      // `.credentials`, as _admin_get_processor_credential answers (TED-070:
      // this read `.credential`, found nothing, and told every parent the camp
      // had not finished setting up online payments).
      const creds = (credRes?.credentials || credRes?.credential || credRes) as Record<string, string> | null;
      if (!creds?.sourceKey || !creds?.pin || !creds?.paymentPageSlug) {
        return json({
          success: false,
          error: "This camp has not finished setting up online payments.",
          reason: "banquest_not_configured",
        }, 200);
      }

      const resp = await fetch(`${bqBase(creds)}/payment-pages/generate-pay-link/${creds.paymentPageSlug}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": bqAuth(creds) },
        body: JSON.stringify({
          redirect_url: returnUrl,
          custom_fields: {
            custom1: "registration_deposit",
            // The completion step reads this to decide whether to keep the
            // token it gets back. A card is only ever vaulted because the
            // parent ticked the box.
            custom2: saveCard ? "save" : "",
            custom3: "",
            custom4: String(enrollmentId),
          },
          ...(saveCard ? { save_payment_method: true } : {}),
          transaction: { description: label, amount: Number(owed.toFixed(2)) },
        }),
      });
      let data: Record<string, any> = {};
      try { data = await resp.json(); } catch { /* non-JSON error body */ }

      const payLink = data?.payment_link, key = data?.key;
      if (resp.status < 200 || resp.status >= 300 || !payLink || !key) {
        const msg = (Array.isArray(data?.messages) && data.messages[0]) || data?.error_message ||
          `Could not create a payment link (HTTP ${resp.status})`;
        console.error(`[registration-deposit] banquest link failed for camp ${campId}: ${msg}`);
        return json({ success: false, error: "Could not start the payment — please try again." }, 200);
      }

      // The pending row is what the completion step reads; without it a
      // successful payment would have nothing to attach itself to.
      const { error: insErr } = await service.from("banquest_pending_links").insert({
        key: String(key),
        camp_id: campId,
        purpose: saveCard ? "registration_deposit_save" : "registration_deposit",
        enrollment_id: String(enrollmentId),
        amount: Number(owed.toFixed(2)),
      });
      if (insErr) {
        console.error(`[registration-deposit] pending row failed: ${insErr.message}`);
        return json({ success: false, error: "Could not start the payment — please try again." }, 500);
      }
      return json({ success: true, url: payLink, processor: "banquest" });
    }

    // ── Stripe: a Checkout session ──────────────────────────────────────────
    const stripeReady = !!camp?.stripe_charges_enabled && !!camp?.stripe_account_id;
    if ((!processorKey || processorKey === "stripe")) {
      if (!STRIPE_SECRET_KEY) {
        return json({ success: false, error: "Online payment is not configured.", reason: "no_stripe_key" }, 200);
      }
      const cents = String(Math.round(owed * 100));
      const params: Record<string, string> = {
        "mode": "payment",
        "success_url": `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}deposit=paid`,
        "cancel_url": `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}deposit=cancelled`,
        "line_items[0][quantity]": "1",
        "line_items[0][price_data][currency]": "usd",
        "line_items[0][price_data][unit_amount]": cents,
        "line_items[0][price_data][product_data][name]": label,
        "payment_intent_data[description]": label,
      };
      if (saveCard) {
        // off_session is what makes the method chargeable later without the
        // parent present, which is what a payment plan needs. Stripe requires
        // a customer to attach it to, and Checkout will make one.
        params["payment_intent_data[setup_future_usage]"] = "off_session";
        params["customer_creation"] = "always";
      }
      if (owedRes.parentEmail) params["customer_email"] = String(owedRes.parentEmail);

      // On BOTH the session and the intent, so the webhook has it whichever
      // event it keys off.
      const meta: Record<string, string> = {
        campId: String(campId),
        enrollmentId: String(enrollmentId),
        source: "registration_deposit",
      };
      Object.entries(meta).forEach(([k, v]) => {
        params[`metadata[${k}]`] = v;
        params[`payment_intent_data[metadata][${k}]`] = v;
      });
      // Money lands in the camp's own account when they are connected. A camp
      // that is not still gets a working payment rather than a dead button.
      if (stripeReady) params["payment_intent_data[transfer_data][destination]"] = String(camp!.stripe_account_id);

      const resp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${STRIPE_SECRET_KEY}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(params).toString(),
      });
      const session = await resp.json();
      if (!resp.ok || !session?.url) {
        console.error(`[registration-deposit] stripe session failed: ${session?.error?.message || resp.status}`);
        return json({ success: false, error: "Could not start the payment — please try again." }, 200);
      }
      return json({ success: true, url: session.url, processor: "stripe" });
    }

    // ── Cardknox / Sola: their own hosted checkout ──────────────────────────
    // Sola's page carries a real per-transaction amount (?xAmount=) and one
    // field that survives to the webhook (xInvoice), so the correlation is our
    // own reference against an intent row -- exactly the mechanism
    // cardknox-checkout-start already uses for tuition and canteen.
    if (processorKey === "cardknox") {
      const { data: credResult } = await service.rpc("_admin_get_processor_credential", { p_camp_id: campId });
      const checkoutSlug = credResult?.credentials?.checkoutSlug;
      if (!credResult?.success || !checkoutSlug) {
        return json({
          success: false,
          error: "This camp has not finished setting up online payments.",
          reason: "cardknox_not_configured",
        }, 200);
      }

      const reference = "ckrd_" + crypto.randomUUID().replace(/-/g, "");
      const { data: intentRes, error: intentErr } = await service.rpc("create_cardknox_registration_intent", {
        p_camp_id: campId,
        p_reference: reference,
        p_enroll_id: String(enrollmentId),
        p_amount_cents: Math.round(owed * 100),
        p_description: label,
      });
      if (intentErr || !intentRes?.success) {
        console.error(`[registration-deposit] cardknox intent failed: ${intentErr?.message || intentRes?.error}`);
        return json({ success: false, error: "Could not start the payment — please try again." }, 500);
      }

      // xCustomerVaultSaveCard is what tells Sola's hosted page to hand back a
      // reusable token alongside the charge. Only ever sent because the parent
      // asked -- a card is never vaulted quietly.
      const url = "https://secure.cardknox.com/" + encodeURIComponent(checkoutSlug) +
        "?xAmount=" + encodeURIComponent(owed.toFixed(2)) +
        "&xInvoice=" + encodeURIComponent(reference) +
        (saveCard ? "&xCustomerVaultSaveCard=true" : "");

      console.log(`[registration-deposit] cardknox intent ${reference}: $${owed.toFixed(2)}, camp ${campId}`);
      return json({ success: true, url, processor: "cardknox", reference });
    }

    // ── anything else ───────────────────────────────────────────────────────
    // Say so plainly rather than showing a button that cannot work: the camp
    // still collects the deposit the way it already does.
    console.log(`[registration-deposit] camp ${campId} is on '${processorKey}', which has no hosted page here yet`);
    return json({
      success: false,
      error: "This camp takes its deposit another way — they will be in touch.",
      reason: "processor_unsupported",
    }, 200);
  } catch (err) {
    console.error("[registration-deposit] Error:", (err as Error).message);
    return json({ success: false, error: (err as Error).message }, 500);
  }
});
