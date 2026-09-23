// =============================================================================
// send-payment-receipt — email a parent a receipt for money we took.
//
// WHY. Nothing in Campistry has ever sent one. A parent pays the registration
// deposit, or has an instalment taken off a stored card overnight, or has a
// canteen balance auto-reloaded, and hears nothing. When the charge turns up on
// their statement they have two options: telephone the camp, or dispute it. The
// camp gets both — the calls and the chargebacks — and the dispute is the
// expensive one. Every product in this category sends receipts for exactly this
// reason, and it is the other half of the descriptor fix: on_behalf_of makes the
// statement say the camp's name, and this says what the charge was for.
//
// SHAPE. Callers pass what they already have and this works out the rest:
//
//   { campId, amount, ref, what?, method?, familyKey?, camperName?,
//     enrollmentId?, when?, balanceAfter?, email? }
//
// `ref` is the payment's own gateway id, and it is required: it is what makes
// the send happen at most once. Webhooks get redelivered and nightly sweeps get
// re-run, and a parent who receives two receipts for one charge concludes they
// were billed twice — which is the dispute this exists to prevent. The claim is
// an INSERT that one caller wins (migration 188), not a read-then-write two
// concurrent deliveries can both pass. A claim that is won but whose send then
// fails is RELEASED, so a Resend outage delays a receipt instead of silencing
// it for ever.
//
// AUTH. Service role only. Every caller is another edge function, and the
// parent's email address is looked up here rather than passed in, so there is
// one place that knows how to find it. A camp staff member can also trigger a
// resend with their own token — the camp id is then taken from their membership
// and never from the request body.
//
// SELF-CONTAINED per this project's deploy convention: the Dashboard pastes one
// file, so there are no ../_shared imports.
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const FROM_EMAIL = Deno.env.get("FROM_EMAIL") || "";

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

const money = (n: number) =>
  "$" + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString("en-US",
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function esc(s: unknown) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function prettyDate(iso: string) {
  const d = new Date((iso || "").length === 10 ? iso + "T12:00:00Z" : iso);
  if (isNaN(d.getTime())) return iso || "";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

/**
 * Is this request allowed to send a receipt, and for which camp?
 *
 * The service role may name any camp (it is another edge function). A user
 * token may only send for a camp they belong to, and the camp id comes from
 * that membership — never from the body, or anyone with a login could email
 * themselves another camp's payment details.
 */
async function authorize(req: Request, bodyCampId: string): Promise<{ campId: string } | { error: string; status: number }> {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { error: "not_authenticated", status: 401 };
  if (token === SUPABASE_SERVICE_KEY) {
    if (!bodyCampId) return { error: "campId required", status: 400 };
    return { campId: bodyCampId };
  }
  const asUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: me } = await asUser.auth.getUser();
  const uid = me?.user?.id;
  if (!uid) return { error: "not_authenticated", status: 401 };

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { data: owned } = await service.from("camps").select("id").eq("owner", uid);
  const ids = new Set((owned || []).map((c: { id: string }) => String(c.id)));
  const { data: member } = await service.from("camp_team_members")
    .select("camp_id").eq("user_id", uid).eq("status", "accepted");
  (member || []).forEach((m: { camp_id: string }) => ids.add(String(m.camp_id)));

  if (!bodyCampId) {
    if (ids.size !== 1) return { error: "campId required", status: 400 };
    return { campId: [...ids][0] };
  }
  if (!ids.has(String(bodyCampId))) return { error: "not_authorized", status: 403 };
  return { campId: String(bodyCampId) };
}

function receiptHtml(o: {
  campName: string; campAddress: string; toName: string; what: string;
  amount: number; when: string; method: string; camperName: string;   // name-ok: the name printed on the receipt, display only
  familyName: string; ref: string; balanceAfter: number | null; replyTo: string;
}) {
  const rows: string[] = [];
  const row = (k: string, v: string) =>
    `<tr><td style="padding:6px 0;color:#666;font-size:13px;white-space:nowrap">${esc(k)}</td>` +
    `<td style="padding:6px 0 6px 18px;font-size:13px;color:#222">${v}</td></tr>`;

  rows.push(row("Amount", `<strong style="font-size:16px">${esc(money(o.amount))}</strong>`));
  rows.push(row("Date", esc(prettyDate(o.when))));
  if (o.what) rows.push(row("For", esc(o.what)));
  if (o.camperName) rows.push(row("Camper", esc(displayName(o.camperName))));
  if (o.method) rows.push(row("Paid with", esc(o.method)));
  if (o.ref) rows.push(row("Reference", `<span style="font-family:monospace;font-size:12px">${esc(o.ref)}</span>`));
  // Only ever stated when the caller actually knows it. A receipt that guesses
  // at a balance is worse than one that does not mention it, because a parent
  // reads it as a demand.
  if (o.balanceAfter != null) {
    rows.push(row("Balance after this", o.balanceAfter > 0.004
      ? esc(money(o.balanceAfter)) + " still owed"
      : "Paid in full"));
  }

  return `<!DOCTYPE html><html><body style="margin:0;background:#f6f7f9">
<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;padding:28px 20px">
  <div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:26px">
    <div style="font-size:19px;font-weight:700;color:#111">${esc(o.campName || "Your camp")}</div>
    ${o.campAddress ? `<div style="font-size:12px;color:#777;margin-top:3px">${esc(o.campAddress)}</div>` : ""}
    <div style="margin:20px 0 4px;font-size:15px;color:#111">Thank you — your payment went through.</div>
    <div style="font-size:13px;color:#666">${o.toName ? esc(o.toName) + ", this" : "This"} is your receipt${o.familyName ? " for the " + esc(o.familyName) : ""}.</div>
    <table style="width:100%;border-collapse:collapse;margin-top:18px">${rows.join("")}</table>
    <div style="margin-top:22px;padding-top:16px;border-top:1px solid #eee;font-size:12px;color:#666;line-height:1.55">
      This charge will appear on your statement from <strong>${esc(o.campName || "the camp")}</strong>.
      ${o.replyTo
        ? `If anything here looks wrong, reply to this email and it goes straight to the camp office — please do that before disputing the charge with your bank, it is much faster to sort out.`
        : `If anything here looks wrong, contact the camp office.`}
    </div>
  </div>
  <div style="text-align:center;color:#9ca3af;font-size:11px;margin-top:14px">Sent by ${esc(o.campName || "your camp")} via Campistry</div>
</div></body></html>`;
}


/** A camper id (from the page, or from metadata), or null. */
function camperIdIn(v: unknown): number | null {
  return v != null && /^\d+$/.test(String(v)) ? Number(v) : null;
}


/** A camper's name as a person reads it: without the roster's internal
 *  " #<number>" that tells two campers with one name apart. For what a parent
 *  sees; never for identifying the camper. */
function displayName(s: unknown): string {
  return String(s ?? "").replace(/\s#\d+(?:-\d+)?$/, "");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return json({ error: "server_not_configured" }, 500);

    const body = await req.json().catch(() => ({}));
    const who = await authorize(req, String(body.campId || ""));
    if ("error" in who) return json({ error: who.error }, who.status);
    const campId = who.campId;

    const amount = Math.round((Number(body.amount) || 0) * 100) / 100;
    const ref = String(body.ref || "").trim();
    if (!(amount > 0)) return json({ error: "bad_amount" }, 400);
    // No reference means no way to tell a redelivery from a second payment, so
    // there is no safe way to send this. Refusing is the conservative failure:
    // a missing receipt is a phone call, a duplicate receipt is a dispute.
    if (!ref) return json({ error: "ref_required" }, 400);

    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const { data: rcp } = await service.rpc("receipt_recipient", {
      p_camp_id: campId,
      p_family_key: body.familyKey ? String(body.familyKey) : null,
      // The camper's number decides whose parent is emailed; name only without one.
      p_camper_id: camperIdIn(body.camperId), p_camper_name: body.camperName ? String(body.camperName) : null,
      p_enroll_id: body.enrollmentId ? String(body.enrollmentId) : null,
    });
    const to = String(body.email || rcp?.email || "").trim();
    if (!to) {
      // Not an error worth failing a charge over — the money is already taken
      // and the caller must not roll anything back because of a receipt. Say
      // so plainly so the log shows which payments nobody was told about.
      console.warn(`[receipt] camp ${campId} ref ${ref}: no email on file — no receipt sent`);
      return json({ sent: false, reason: "no_email_on_file" }, 200);
    }

    if (!RESEND_API_KEY || !FROM_EMAIL) {
      console.warn(`[receipt] camp ${campId} ref ${ref}: RESEND_API_KEY/FROM_EMAIL not set`);
      return json({ sent: false, reason: "email_not_configured" }, 200);
    }

    // Claim BEFORE sending. Winning the claim is permission to send exactly
    // once; losing it means somebody already did.
    const { data: won } = await service.rpc("claim_payment_receipt", {
      p_camp_id: campId, p_ref: ref, p_email: to, p_amount: amount,
    });
    if (won !== true) return json({ sent: false, reason: "already_sent" }, 200);

    const campName = String(rcp?.camp_name || "").trim();
    const replyTo = String(rcp?.reply_to || "").trim();
    const what = String(body.what || "Camp payment").trim();
    const html = receiptHtml({
      campName,
      campAddress: String(rcp?.camp_address || "").trim(),
      toName: String(rcp?.to_name || "").trim(),
      what,
      amount,
      when: String(body.when || new Date().toISOString().slice(0, 10)),
      method: String(body.method || "").trim(),
      camperName: displayName(body.camperName || rcp?.camper_name || "").trim(),
      familyName: String(rcp?.family_name || "").trim(),
      ref,
      balanceAfter: body.balanceAfter == null ? null : Math.round((Number(body.balanceAfter) || 0) * 100) / 100,
      replyTo,
    });

    const payload: Record<string, unknown> = {
      from: FROM_EMAIL,
      to: [to],
      // The camp's name in the subject, for the same reason it is on the
      // charge: this has to be recognisable in an inbox six weeks later.
      subject: `${campName || "Camp"} — receipt for ${money(amount)}`,
      html,
    };
    // A parent's reply must reach the camp, not us. Without this the one
    // person who can fix a wrong charge never hears about it.
    if (replyTo) payload.reply_to = replyTo;

    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      // Give the claim back, or this payment's receipt is silenced for ever by
      // one bad minute at the mail provider.
      await service.rpc("release_payment_receipt", { p_camp_id: campId, p_ref: ref });
      console.error(`[receipt] camp ${campId} ref ${ref}: send failed`, result);
      return json({ sent: false, reason: "send_failed", detail: result?.message || null }, 200);
    }

    console.log(`[receipt] camp ${campId} ref ${ref}: sent to ${to} (${money(amount)})`);
    return json({ sent: true, id: result?.id || null, to });
  } catch (err) {
    console.error("[receipt] unexpected:", err);
    // Never a non-200 to a charge path: the money is already taken and a
    // caller that treats a receipt failure as a charge failure would retry the
    // charge.
    return json({ sent: false, reason: "error", detail: String((err as Error)?.message || err) }, 200);
  }
});
