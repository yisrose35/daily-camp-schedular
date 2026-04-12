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
import { Resend } from "npm:resend@2.0.0";

const resend = new Resend(Deno.env.get("RESEND_API_KEY"));
const FROM_EMAIL = Deno.env.get("FROM_EMAIL") || "Campistry <noreply@campistry.com>";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function template(type: string, data: Record<string, string>): { subject: string; html: string } {
  const campName = data.campName || "Camp";
  const camperName = data.camperName || "";
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
        subject: `${camperName} is enrolled at ${campName}!`,
        html: wrap("Enrollment Confirmed! 🎉", `
          <p>Dear ${parentName},</p>
          <p>We're excited to confirm that <strong>${camperName}</strong> is officially enrolled at <strong>${campName}</strong>!</p>
          <p>Please make sure to complete any outstanding forms and review your payment schedule.</p>
          <p>We can't wait to see ${camperName} this summer!</p>
          <p style="margin-top:24px;">Warm regards,<br><strong>The ${campName} Team</strong></p>
        `),
      };

    case "payment_reminder":
      return {
        subject: `Payment reminder: ${amount} due ${dueDate}`,
        html: wrap("Payment Reminder", `
          <p>Dear ${parentName},</p>
          <p>This is a friendly reminder that a payment of <strong>${amount}</strong> for <strong>${camperName}</strong> is due on <strong>${dueDate}</strong>.</p>
          <p>If you've already made this payment, please disregard this message.</p>
          <p style="margin-top:24px;">Thank you,<br><strong>The ${campName} Team</strong></p>
        `),
      };

    case "payment_overdue":
      return {
        subject: `Overdue payment: ${amount} for ${camperName}`,
        html: wrap("Payment Overdue", `
          <p>Dear ${parentName},</p>
          <p>Our records show that a payment of <strong>${amount}</strong> for <strong>${camperName}</strong> was due on <strong>${dueDate}</strong> and has not yet been received.</p>
          <p>Please arrange payment at your earliest convenience. If you have any questions or need to discuss a payment plan, please contact the camp office.</p>
          <p style="margin-top:24px;">Thank you,<br><strong>The ${campName} Team</strong></p>
        `),
      };

    case "form_reminder":
      return {
        subject: `Action needed: ${formName} for ${camperName}`,
        html: wrap("Form Reminder", `
          <p>Dear ${parentName},</p>
          <p>We still need the <strong>${formName}</strong> for <strong>${camperName}</strong>. Please complete and submit this form as soon as possible.</p>
          <p>Incomplete forms may affect your child's participation in camp activities.</p>
          <p style="margin-top:24px;">Thank you,<br><strong>The ${campName} Team</strong></p>
        `),
      };

    case "waitlist_promoted":
      return {
        subject: `Great news! ${camperName} has been accepted!`,
        html: wrap("Waitlist Update 🎉", `
          <p>Dear ${parentName},</p>
          <p>A spot has opened up and <strong>${camperName}</strong> has been moved from the waitlist to <strong>accepted</strong>!</p>
          <p>Please log in to complete enrollment and arrange payment to secure your child's spot.</p>
          <p style="margin-top:24px;">We look forward to seeing ${camperName} at camp!<br><strong>The ${campName} Team</strong></p>
        `),
      };

    default:
      return {
        subject: `Update from ${campName}`,
        html: wrap("Camp Update", `<p>${data.message || "You have a new notification."}</p>`),
      };
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { recipients, type, data, dryRun } = await req.json();

    if (!recipients?.length || !type) {
      return new Response(JSON.stringify({ error: "recipients and type required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
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
