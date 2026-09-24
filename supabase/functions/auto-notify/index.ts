// =============================================================================
// auto-notify — Automated camp notification engine
//
// Called on a schedule (cron) or triggered by events.
// Checks for pending notifications and sends them:
//   - Enrollment confirmation
//   - Payment due reminders (7 days, 1 day)
//   - Missing form reminders
//   - Waitlist promotion notice
//
// Request: { campId, type?, dryRun? }
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "npm:resend@2.0.0";

const resend = new Resend(Deno.env.get("RESEND_API_KEY"));
// campistry.org — the app's actual domain (link./snacks.campistry.org).
// The old default said campistry.com, which Campistry does not own: with
// FROM_EMAIL unset that sends from an unverified domain, so Resend rejects
// it or the mail fails DKIM/SPF alignment and lands in spam. Set FROM_EMAIL
// explicitly in Edge Function secrets; this default is only a safety net.
const FROM_EMAIL = Deno.env.get("FROM_EMAIL") || "Campistry <noreply@campistry.org>";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const SENDER_ROLES = ["owner", "admin", "scheduler"];

function fail(status: number, error: string) {
  return new Response(JSON.stringify({ error }), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// Same shape as send-broadcast's callerRole — asks Postgres who the caller
// is (via their own JWT, not the service-role key), rather than trusting
// anything the request body claims about the caller.
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

// get_user_role() answers for the CALLER'S OWN camp (auth.uid() ->
// get_user_camp_id()) — it says nothing about the campId the request body
// claims. Without this, an owner/admin of Camp A could pass Camp B's id and
// have this function (running on the service-role key) email Camp B's
// families on their behalf. Confirming the two match is what actually ties
// "authorized sender" to "the camp being sent for."
async function callerCampId(req: Request): Promise<string | null> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const authHeader = req.headers.get("Authorization");
  if (!supabaseUrl || !anonKey || !authHeader) return null;
  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/get_user_camp_id`, {
    method: "POST",
    headers: { apikey: anonKey, Authorization: authHeader, "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) return null;
  const id = await res.json();
  return typeof id === "string" ? id : null;
}

function template(type: string, data: Record<string, string>): { subject: string; html: string } {
  const campName = data.campName || "Camp";
  const parentName = data.parentName || "Parent";
  const amount = data.amount || "$0";
  const dueDate = data.dueDate || "";
  const formName = data.formName || "required form";

  const wrap = (title: string, body: string) => `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#2563EB;color:#fff;padding:16px 24px;border-radius:8px 8px 0 0;">
        <strong>${campName}</strong>
      </div>
      <div style="padding:24px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px;">
        <h2 style="margin:0 0 16px;font-size:18px;color:#1e293b;">${title}</h2>
        <div style="font-size:15px;line-height:1.7;color:#334155;">${body}</div>
        <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">
        <p style="font-size:12px;color:#94a3b8;">Sent automatically by Campistry</p>
      </div>
    </div>`;

  switch (type) {
    case "enrollment_confirmation":
      return {
        subject: `${displayName(data.camperName)} is enrolled at ${campName}!`,
        html: wrap("Enrollment Confirmed! 🎉", `
          <p>Dear ${parentName},</p>
          <p>We're excited to confirm that <strong>${displayName(data.camperName)}</strong> is officially enrolled at <strong>${campName}</strong>!</p>
          <p>Please make sure to complete any outstanding forms and review your payment schedule.</p>
          <p>We can't wait to see ${displayName(data.camperName)} this summer!</p>
          <p style="margin-top:24px;">Warm regards,<br><strong>The ${campName} Team</strong></p>
        `),
      };

    case "payment_reminder":
      return {
        subject: `Payment reminder: ${amount} due ${dueDate}`,
        html: wrap("Payment Reminder", `
          <p>Dear ${parentName},</p>
          <p>This is a friendly reminder that a payment of <strong>${amount}</strong> for <strong>${displayName(data.camperName)}</strong> is due on <strong>${dueDate}</strong>.</p>
          <p>If you've already made this payment, please disregard this message.</p>
          <p style="margin-top:24px;">Thank you,<br><strong>The ${campName} Team</strong></p>
        `),
      };

    case "payment_overdue":
      return {
        subject: `Overdue payment: ${amount} for ${displayName(data.camperName)}`,
        html: wrap("Payment Overdue", `
          <p>Dear ${parentName},</p>
          <p>Our records show that a payment of <strong>${amount}</strong> for <strong>${displayName(data.camperName)}</strong> was due on <strong>${dueDate}</strong> and has not yet been received.</p>
          <p>Please arrange payment at your earliest convenience. If you have any questions or need to discuss a payment plan, please contact the camp office.</p>
          <p style="margin-top:24px;">Thank you,<br><strong>The ${campName} Team</strong></p>
        `),
      };

    case "form_reminder":
      return {
        subject: `Action needed: ${formName} for ${displayName(data.camperName)}`,
        html: wrap("Form Reminder", `
          <p>Dear ${parentName},</p>
          <p>We still need the <strong>${formName}</strong> for <strong>${displayName(data.camperName)}</strong>. Please complete and submit this form as soon as possible.</p>
          <p>Incomplete forms may affect your child's participation in camp activities.</p>
          <p style="margin-top:24px;">Thank you,<br><strong>The ${campName} Team</strong></p>
        `),
      };

    case "waitlist_promoted":
      return {
        subject: `Great news! ${displayName(data.camperName)} has been accepted!`,
        html: wrap("Waitlist Update 🎉", `
          <p>Dear ${parentName},</p>
          <p>A spot has opened up and <strong>${displayName(data.camperName)}</strong> has been moved from the waitlist to <strong>accepted</strong>!</p>
          <p>Please log in to complete enrollment and arrange payment to secure your child's spot.</p>
          <p style="margin-top:24px;">We look forward to seeing ${displayName(data.camperName)} at camp!<br><strong>The ${campName} Team</strong></p>
        `),
      };

    default:
      return {
        subject: `Update from ${campName}`,
        html: wrap("Camp Update", `<p>${data.message || "You have a new notification."}</p>`),
      };
  }
}


/** A camper's name as a person reads it: without the roster's internal
 *  " #<number>" that tells two campers with one name apart. For what a parent
 *  sees; never for identifying the camper. */
function displayName(s: unknown): string {
  return String(s ?? "").replace(/\s#\d+(?:-\d+)?$/, "");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { campId, recipients, type, data, dryRun } = await req.json();

    if (!recipients?.length || !type) {
      return fail(400, "recipients and type required");
    }

    // Payment/form reminders and other automated notices are covered by the
    // same paid emailing service as broadcasts and the acceptance letter
    // (migration 196) — this is the server-side half of the check
    // campistry_me.js's _emailServiceOn() already does client-side, so a
    // direct call to this function can't skip it. campId is required from
    // here forward (every current caller passes it); a legacy call without
    // one is refused rather than silently let through unchecked.
    if (!campId) return fail(400, "campId required");

    // This function had NO auth check at all before: any bearer token, any
    // recipient list, any content — it would send. Same standard as
    // send-broadcast/send-sms: the caller must be owner/admin/scheduler
    // *in the camp being sent for*. get_user_role() only proves a role in
    // the caller's OWN camp, so that's checked together with get_user_camp_id()
    // matching the campId the request claims — the role check alone would
    // let an admin of Camp A email Camp B's families just by passing Camp
    // B's id.
    const role = await callerRole(req);
    if (!role || !SENDER_ROLES.includes(role)) {
      return fail(403, "Not authorized to send notifications (owner/admin/scheduler only).");
    }
    const ownCampId = await callerCampId(req);
    if (!ownCampId || ownCampId !== campId) {
      return fail(403, "Not authorized for this camp.");
    }

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: mayEmail, error: mayEmailErr } = await supabase.rpc("_camp_may_send_email", { p_camp_id: campId });
    if (mayEmailErr) {
      console.error("[auto-notify] email-gate check failed:", mayEmailErr.message);
      return fail(500, "Could not verify this camp's emailing plan.");
    }
    if (!mayEmail) {
      return fail(403, "This camp's plan doesn't include emailing. Contact Campistry to add it.");
    }

    const { subject, html } = template(type, data || {});
    let sent = 0, failed = 0;

    if (dryRun) {
      console.log(`[auto-notify] DRY RUN: would send "${subject}" to ${recipients.length} recipients`);
      return new Response(JSON.stringify({ dryRun: true, subject, recipientCount: recipients.length }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    for (const r of recipients) {
      if (!r.email) continue;
      try {
        const { error } = await resend.emails.send({
          from: FROM_EMAIL,
          to: [r.email],
          subject,
          html,
        });
        if (error) { failed++; console.error(`[auto-notify] Failed: ${r.email}`, error); }
        else sent++;
      } catch (e) {
        failed++;
        console.error(`[auto-notify] Error: ${r.email}`, e.message);
      }
      if (recipients.length > 3) await new Promise((resolve) => setTimeout(resolve, 100));
    }

    console.log(`[auto-notify] ${type}: ${sent} sent, ${failed} failed`);

    return new Response(JSON.stringify({ success: true, type, sent, failed }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[auto-notify] Error:", err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
