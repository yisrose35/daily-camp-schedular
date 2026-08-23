import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "npm:resend@2.0.0";

const TELNYX_API_KEY = Deno.env.get("TELNYX_API_KEY");
const TELNYX_FROM = Deno.env.get("TELNYX_FROM_NUMBER");
const TELNYX_PROFILE = Deno.env.get("TELNYX_MESSAGING_PROFILE_ID");
const EMAIL_UNSUB_SECRET = Deno.env.get("EMAIL_UNSUB_SECRET");

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

async function sendTelnyxSMS(to: string, body: string, fromNumber?: string): Promise<boolean> {
  // A camp's own number (Dashboard → Camp Profile) wins for deliverability/
  // reputation isolation; otherwise defer to the platform's shared default.
  if (!TELNYX_API_KEY || (!fromNumber && !TELNYX_FROM && !TELNYX_PROFILE)) return false;
  try {
    const payload: Record<string, unknown> = { to, text: body.slice(0, 1600) };
    if (fromNumber) payload.from = fromNumber;
    else if (TELNYX_PROFILE) payload.messaging_profile_id = TELNYX_PROFILE;
    else payload.from = TELNYX_FROM;
    const res = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${TELNYX_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function unsubLink(email: string): Promise<string> {
  if (!EMAIL_UNSUB_SECRET) return "";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(EMAIL_UNSUB_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(email.toLowerCase()));
  const t = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
  const base = Deno.env.get("SUPABASE_URL")!.replace(".supabase.co", ".functions.supabase.co");
  return `${base}/email-unsubscribe?email=${encodeURIComponent(email)}&t=${t}`;
}

// -----------------------------------------------------------------------------
// send-scheduled-broadcasts
//
// Server-side driver for Campistry Link scheduled broadcasts. Meant to be hit
// on a schedule (Supabase cron / pg_cron HTTP, e.g. every minute):
//
//   select cron.schedule(
//     'send-scheduled-broadcasts', '* * * * *',
//     $$ select net.http_post(
//          url     := '<project>.functions.supabase.co/send-scheduled-broadcasts',
//          headers := jsonb_build_object('Authorization', 'Bearer <CRON_SECRET>')
//        ) $$);
//
// It finds every link_broadcasts row that is due (status='scheduled',
// scheduled_for <= now) and delivers the pre-resolved recipient snapshot, then
// flips the row to 'sent'. The status flip is claim-first so the browser-side
// driver and this function can never double-send the same row.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY, CRON_SECRET
// -----------------------------------------------------------------------------

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // Simple shared-secret gate so only the cron job can trigger sends.
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (cronSecret) {
    const auth = req.headers.get("Authorization") || "";
    if (auth !== `Bearer ${cronSecret}`) return json({ error: "unauthorized" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);
  const resend = new Resend(Deno.env.get("RESEND_API_KEY"));

  const nowIso = new Date().toISOString();

  // 1. Find due broadcasts.
  const { data: due, error: findErr } = await supabase
    .from("link_broadcasts")
    .select("id, camp_id, subject, body, channels, recipients, scheduled_for")
    .eq("status", "scheduled")
    .lte("scheduled_for", nowIso)
    .limit(50);

  if (findErr) return json({ error: findErr.message }, 500);
  if (!due || due.length === 0) return json({ processed: 0 });

  const results: Array<{ id: string; sent: number; skipped?: string }> = [];

  for (const b of due) {
    // 2. Claim the row first (status flip is the lock). If another worker beat
    //    us to it, .eq('status','scheduled') matches nothing and we skip.
    const { data: claimed, error: claimErr } = await supabase
      .from("link_broadcasts")
      .update({ status: "sending" })
      .eq("id", b.id)
      .eq("status", "scheduled")
      .select("id");

    if (claimErr || !claimed || claimed.length === 0) {
      results.push({ id: b.id, sent: 0, skipped: "already-claimed" });
      continue;
    }

    // 3. Deliver the recipient snapshot. Recipients here are expected to
    // already be the non-adopter, consented subset — the composer
    // (campistry_link_admin.html's scheduleCompose) resolves Link adoption
    // and consent at schedule time and only snapshots recipients who need
    // this fallback. This function still re-checks consent and opt-out/
    // unsubscribe status itself as the authoritative last line of defense.
    const channels: string[] = Array.isArray(b.channels) ? b.channels : ["app"];
    const recipients: Array<{ name?: string; email?: string; phone?: string; subject?: string; body?: string; consent?: boolean; adopter?: boolean }> =
      Array.isArray(b.recipients) ? b.recipients : [];
    let sent = 0;

    const phoneKeys = new Set(recipients.map((r) => phoneKey(r.phone)).filter(Boolean) as string[]);
    const emails = new Set(recipients.map((r) => String(r.email || "").toLowerCase()).filter(Boolean));
    const [{ data: optOuts }, { data: unsubs }] = await Promise.all([
      phoneKeys.size ? supabase.from("sms_opt_outs").select("phone_key").in("phone_key", Array.from(phoneKeys)) : Promise.resolve({ data: [] as any[] }),
      emails.size ? supabase.from("email_unsubscribes").select("email").in("email", Array.from(emails)) : Promise.resolve({ data: [] as any[] }),
    ]);
    const optedOutPhones = new Set((optOuts || []).map((r: any) => r.phone_key));
    const unsubscribedEmails = new Set((unsubs || []).map((r: any) => r.email));

    // This camp's own mailing address (CAN-SPAM footer), contact email
    // (Reply-To), and SMS sending number — set on the Dashboard's Camp
    // Profile card. Address/number fall back to platform-wide defaults if a
    // camp hasn't set theirs yet.
    let campAddress = "";
    let campReplyTo: string | undefined;
    let campTelnyxNumber: string | undefined;
    if (channels.includes("email") || channels.includes("sms")) {
      const { data: campRow } = await supabase.from("camps").select("address, contact_email, telnyx_from_number").eq("id", b.camp_id).maybeSingle();
      campAddress = campRow?.address || Deno.env.get("POSTAL_ADDRESS") || "";
      campReplyTo = campRow?.contact_email || undefined;
      campTelnyxNumber = campRow?.telnyx_from_number || undefined;
    }

    if (channels.includes("email")) {
      for (const r of recipients) {
        if (!r.email || !r.consent || r.adopter) continue; // adopters already see this in Link — no redundant email
        if (unsubscribedEmails.has(r.email.toLowerCase())) continue;
        try {
          const link = await unsubLink(r.email);
          await resend.emails.send({
            from: "Campistry <onboarding@resend.dev>",
            to: [r.email],
            subject: r.subject || b.subject || "A message from your camp",
            replyTo: campReplyTo,
            html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;white-space:pre-wrap;">${
              (r.body || b.body || "").replace(/</g, "&lt;")
            }</div><p style="font-size:12px;color:#94a3b8;">${link ? `<a href="${link}" style="color:#94a3b8;">Unsubscribe</a>` : ""}${campAddress ? ` ${campAddress}` : ""}</p>`,
            headers: link ? { "List-Unsubscribe": `<${link}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : undefined,
          });
          sent++;
        } catch (e) {
          console.error("[scheduled-broadcast] email error", b.id, e);
        }
      }
    }

    if (channels.includes("sms")) {
      for (const r of recipients) {
        if (!r.phone || !r.consent || r.adopter) continue; // adopters already see this in Link — no redundant text
        const to = normalizePhone(r.phone);
        const key = to ? phoneKey(to) : null;
        if (!to || !key || optedOutPhones.has(key)) continue;
        const smsBody = (r.body || b.body || "") + "\n\n— Campistry\nReply STOP to opt out.";
        if (await sendTelnyxSMS(to, smsBody, campTelnyxNumber)) sent++;
      }
    }

    // In-app: the outbox is the source of truth for the parent portal.
    // Insert one link_outbox row per recipient for tracking/history — SMS
    // is now actually sent above (real Telnyx dispatch, counted in `sent`
    // there), this insert no longer double-counts it.
    if (channels.includes("app") || channels.includes("sms")) {
      const rows = recipients.map((r) => ({
        camp_id: b.camp_id,
        type: "broadcast",
        parent_name: r.name || null,
        parent_email: r.email || null,
        parent_phone: r.phone || null,
        subject: r.subject || b.subject || "",
        body: r.body || b.body || "",
        channels,
        status: "sent",
      }));
      if (rows.length) {
        const { error: outErr } = await supabase.from("link_outbox").insert(rows);
        if (outErr) console.error("[scheduled-broadcast] outbox error", b.id, outErr.message);
      }
    }

    // 4. Mark sent.
    await supabase
      .from("link_broadcasts")
      .update({ status: "sent", sent_at: new Date().toISOString(), recipient_count: sent })
      .eq("id", b.id);

    results.push({ id: b.id, sent });
  }

  return json({ processed: results.length, results });
});
