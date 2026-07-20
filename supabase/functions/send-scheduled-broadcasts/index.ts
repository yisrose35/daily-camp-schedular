import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "npm:resend@2.0.0";

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

    // 3. Deliver the recipient snapshot.
    const channels: string[] = Array.isArray(b.channels) ? b.channels : ["app"];
    const recipients: Array<{ name?: string; email?: string; phone?: string; subject?: string; body?: string }> =
      Array.isArray(b.recipients) ? b.recipients : [];
    let sent = 0;

    if (channels.includes("email")) {
      for (const r of recipients) {
        if (!r.email) continue;
        try {
          await resend.emails.send({
            from: "Campistry <onboarding@resend.dev>",
            to: [r.email],
            subject: r.subject || b.subject || "A message from your camp",
            html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;white-space:pre-wrap;">${
              (r.body || b.body || "").replace(/</g, "&lt;")
            }</div>`,
          });
          sent++;
        } catch (e) {
          console.error("[scheduled-broadcast] email error", b.id, e);
        }
      }
    }

    // In-app + SMS: the outbox is the source of truth for the parent portal.
    // Insert one link_outbox row per recipient so in-app delivery works even
    // when no email/SMS provider is wired yet. (SMS provider dispatch would
    // hook in here once configured.)
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
        else if (!channels.includes("email")) sent += rows.length;
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
