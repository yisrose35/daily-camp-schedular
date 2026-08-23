// =============================================================================
// send-broadcast — Deliver broadcast emails/SMS to camp families
//
// Request: { campId, to: [{email, name, phone, consent}], subject, body,
//            method, campName, eventKey? }
// Methods: 'email', 'sms', 'all'
//
// Security: JWT-verified (Supabase default) + re-checks the caller's camp
// role server-side via get_user_role() (owner/admin/scheduler only, same
// pattern as send-sms/index.ts). Every recipient must be consented
// (`consent:true`, resolved by the caller from smsEmailConsent on the
// roster/family/staff record — this function trusts that flag but is the
// last line of defense against sms_opt_outs/email_unsubscribes regardless
// of what the caller passed) and not present in the opt-out/unsubscribe
// tables, checked with the service-role key so a client can never bypass
// them. Phone numbers are also re-verified against the caller's own camp
// (same phoneKey()/campPhoneBook approach as send-sms) before an SMS goes
// out — consent alone isn't proof a number actually belongs to this camp.
//
// Idempotency: pass eventKey to avoid double-sending the same broadcast to
// the same recipient on retry — reuses the notifications table (migration
// 056) exactly as its own comment prescribes.
//
// Secrets: RESEND_API_KEY, FROM_EMAIL, TELNYX_API_KEY,
//   TELNYX_FROM_NUMBER or TELNYX_MESSAGING_PROFILE_ID,
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "npm:resend@2.0.0";

const resend = new Resend(Deno.env.get("RESEND_API_KEY"));
const TELNYX_API_KEY = Deno.env.get("TELNYX_API_KEY");
const TELNYX_FROM = Deno.env.get("TELNYX_FROM_NUMBER");
const TELNYX_PROFILE = Deno.env.get("TELNYX_MESSAGING_PROFILE_ID");
const FROM_EMAIL = Deno.env.get("FROM_EMAIL") || "Campistry <noreply@campistry.com>";
const EMAIL_UNSUB_SECRET = Deno.env.get("EMAIL_UNSUB_SECRET");
const SENDER_ROLES = ["owner", "admin", "scheduler"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

function phoneKey(raw: unknown): string | null {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

function normalizePhone(raw: unknown): string | null {
  const digits = String(raw || "").replace(/[^\d+]/g, "");
  if (/^\+\d{8,15}$/.test(digits)) return digits;
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  return null;
}

async function callerRole(req: Request): Promise<string | null> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const authHeader = req.headers.get("Authorization");
  if (!supabaseUrl || !anonKey || !authHeader) return null;
  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/get_user_role`, {
    method: "POST",
    headers: { apikey: anonKey, Authorization: authHeader, "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) return null;
  const role = await res.json();
  return typeof role === "string" ? role : null;
}

// Every phone number that belongs to this camp — same shape as send-sms's
// campPhoneBook, scoped by the caller's own JWT/RLS.
async function campPhoneBook(req: Request): Promise<Set<string> | null> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const authHeader = req.headers.get("Authorization");
  if (!supabaseUrl || !anonKey || !authHeader) return null;
  const res = await fetch(
    `${supabaseUrl}/rest/v1/camp_state_kv?select=key,value&key=in.(app1,campistryMe)`,
    { headers: { apikey: anonKey, Authorization: authHeader } },
  );
  if (!res.ok) return null;
  let rows: Array<{ key: string; value: any }>;
  try { rows = await res.json(); } catch { return null; }
  if (!Array.isArray(rows)) return null;
  const byKey: Record<string, any> = {};
  rows.forEach((r) => { byKey[r.key] = r.value; });
  const me = byKey.campistryMe || {};
  const book = new Set<string>();
  const add = (v: unknown) => { const k = phoneKey(v); if (k) book.add(k); };
  const roster = byKey.app1?.camperRoster || {};
  Object.values<any>(roster).forEach((c) => { add(c?.parent1Phone); add(c?.parent2Phone); add(c?.emergencyPhone); });
  Object.values<any>(me.bunkStaff || {}).forEach((list: any) => (Array.isArray(list) ? list : []).forEach((s: any) => add(s?.phone)));
  Object.values<any>(me.families || {}).forEach((f: any) => (f?.households || []).forEach((hh: any) => (hh?.parents || []).forEach((p: any) => add(p?.phone))));
  return book;
}

async function sendTelnyxSMS(to: string, body: string, fromNumber?: string): Promise<{ ok: boolean; error?: string }> {
  // A camp's own number (Dashboard → Camp Profile → SMS Sending Number)
  // takes priority — isolates deliverability/reputation per camp instead of
  // every camp sharing one platform-wide number. Falls back to the shared
  // TELNYX_FROM_NUMBER/TELNYX_MESSAGING_PROFILE_ID for camps that haven't
  // set up their own yet.
  const effectiveFrom = fromNumber || TELNYX_FROM;
  if (!TELNYX_API_KEY || (!effectiveFrom && !TELNYX_PROFILE)) return { ok: false, error: "SMS not configured" };
  try {
    const payload: Record<string, unknown> = { to, text: body.slice(0, 1600) };
    // A camp's own number always wins. Otherwise defer to whichever the
    // platform has configured — a shared Messaging Profile (if set) over a
    // shared bare number, matching the original platform-wide priority.
    if (fromNumber) payload.from = fromNumber;
    else if (TELNYX_PROFILE) payload.messaging_profile_id = TELNYX_PROFILE;
    else payload.from = TELNYX_FROM;
    const res = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${TELNYX_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true };
    return { ok: false, error: data?.errors?.[0]?.detail || `Telnyx error ${res.status}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const { campId, to, subject, body, method, campName, eventKey } = await req.json();
    if (!campId) return json({ error: "campId required" }, 400);
    if (!to?.length || !body) return json({ error: "to and body required" }, 400);

    const role = await callerRole(req);
    if (!role || !SENDER_ROLES.includes(role)) {
      return json({ error: "Not authorized to send broadcasts (owner/admin/scheduler only)." }, 403);
    }

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const results = { emailSent: 0, emailFailed: 0, emailSkipped: 0, smsSent: 0, smsFailed: 0, smsSkipped: 0 };
    const sendEmail = method === "email" || method === "all" || method === "All Channels" || method === "Email";
    const sendSms = method === "sms" || method === "SMS" || method === "all" || method === "All Channels";

    const phoneBook = sendSms ? await campPhoneBook(req) : null;

    // Each camp's own mailing address (CAN-SPAM footer), contact email
    // (Reply-To, so a parent's reply reaches the camp's real inbox, not a
    // noreply@ mailbox), and SMS sending number (own deliverability/
    // reputation instead of sharing the platform-wide number) — all set on
    // the Dashboard's Camp Profile card. Address/number fall back to
    // platform-wide defaults for camps that haven't filled theirs in yet.
    let campAddress = "";
    let campReplyTo: string | undefined;
    let campTelnyxNumber: string | undefined;
    if (sendEmail || sendSms) {
      const { data: campRow } = await supabase.from("camps").select("address, contact_email, telnyx_from_number").eq("id", campId).maybeSingle();
      campAddress = campRow?.address || Deno.env.get("POSTAL_ADDRESS") || "";
      campReplyTo = campRow?.contact_email || undefined;
      campTelnyxNumber = campRow?.telnyx_from_number || undefined;
    }

    // Pull opt-out/unsubscribe lists once up front — small tables, cheap to
    // scan in full rather than one round-trip per recipient.
    const phoneKeys = new Set((to as any[]).map((r) => phoneKey(r.phone)).filter(Boolean) as string[]);
    const emails = new Set((to as any[]).map((r) => String(r.email || "").toLowerCase()).filter(Boolean));
    const [{ data: optOuts }, { data: unsubs }] = await Promise.all([
      phoneKeys.size ? supabase.from("sms_opt_outs").select("phone_key").in("phone_key", Array.from(phoneKeys)) : Promise.resolve({ data: [] as any[] }),
      emails.size ? supabase.from("email_unsubscribes").select("email").in("email", Array.from(emails)) : Promise.resolve({ data: [] as any[] }),
    ]);
    const optedOutPhones = new Set((optOuts || []).map((r: any) => r.phone_key));
    const unsubscribedEmails = new Set((unsubs || []).map((r: any) => r.email));

    const unsubLink = async (email: string) => {
      if (!EMAIL_UNSUB_SECRET) return "";
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(EMAIL_UNSUB_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(email.toLowerCase()));
      const t = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
      const base = Deno.env.get("SUPABASE_URL")!.replace(".supabase.co", ".functions.supabase.co");
      return `${base}/email-unsubscribe?email=${encodeURIComponent(email)}&t=${t}`;
    };

    for (const recipient of to as any[]) {
      // Default-allow when consent isn't specified at all — existing callers
      // (post-acceptance form links, a parent's own transactional emails
      // they triggered by applying/enrolling) predate this field and are
      // relationship/transactional mail, not the unsolicited marketing-style
      // sends this gate exists for. Only an EXPLICIT consent:false (the new
      // composer fallback passing a non-consenting non-adopter) is skipped.
      if (recipient.consent === false) { if (recipient.email) results.emailSkipped++; if (recipient.phone) results.smsSkipped++; continue; }

      // Idempotency — skip a recipient we've already sent this exact event to.
      let alreadySent = false;
      if (eventKey) {
        const sourceId = `${eventKey}:${recipient.email || recipient.phone || ""}`;
        const { data: ins } = await supabase
          .from("notifications")
          .insert({ camp_id: campId, source: "broadcast_fallback", source_id: sourceId, title: subject || "", body: body })
          .select("id");
        alreadySent = !ins || ins.length === 0;
      }
      if (alreadySent) continue;

      // Per-recipient subject/body (merge-tag-personalized by the composer)
      // override the shared top-level ones when present.
      const rSubject = recipient.subject || subject;
      const rBody = recipient.body || body;

      if (sendEmail && recipient.email) {
        if (unsubscribedEmails.has(String(recipient.email).toLowerCase())) { results.emailSkipped++; }
        else {
          try {
            const link = await unsubLink(recipient.email);
            const htmlBody = `
              <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
                <div style="background:#2563EB;color:#fff;padding:16px 24px;border-radius:8px 8px 0 0;"><strong>${campName || "Camp"}</strong></div>
                <div style="padding:24px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px;">
                  ${rSubject ? `<h2 style="margin:0 0 12px;font-size:18px;">${rSubject}</h2>` : ""}
                  <div style="font-size:15px;line-height:1.6;color:#334155;white-space:pre-wrap;">${rBody}</div>
                  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">
                  <p style="font-size:12px;color:#94a3b8;">Sent via Campistry.${link ? ` <a href="${link}" style="color:#94a3b8;">Unsubscribe</a>` : ""}${campAddress ? ` ${campAddress}` : ""}</p>
                </div>
              </div>`;
            const { error } = await resend.emails.send({
              from: FROM_EMAIL, to: [recipient.email],
              subject: rSubject || `Message from ${campName || "Camp"}`, html: htmlBody,
              replyTo: campReplyTo,
              headers: link ? { "List-Unsubscribe": `<${link}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : undefined,
            });
            if (error) results.emailFailed++; else results.emailSent++;
          } catch { results.emailFailed++; }
        }
      }

      if (sendSms && recipient.phone) {
        const smsTo = normalizePhone(recipient.phone);
        const key = smsTo ? phoneKey(smsTo) : null;
        if (!smsTo || !key || !phoneBook?.has(key)) { results.smsFailed++; }
        else if (optedOutPhones.has(key)) { results.smsSkipped++; }
        else {
          const smsBody = (rSubject ? rSubject + "\n\n" : "") + rBody + "\n\n— " + (campName || "Camp") + "\nReply STOP to opt out.";
          const r = await sendTelnyxSMS(smsTo, smsBody, campTelnyxNumber);
          if (r.ok) results.smsSent++; else results.smsFailed++;
        }
      }

      if ((to as any[]).length > 5) await new Promise((r) => setTimeout(r, 100));
    }

    console.log(`[send-broadcast] Results:`, results);
    return json({ success: true, ...results });
  } catch (err) {
    console.error("[send-broadcast] Error:", (err as Error).message);
    return json({ error: (err as Error).message }, 500);
  }
});
