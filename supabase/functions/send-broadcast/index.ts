// =============================================================================
// send-broadcast — Deliver broadcast emails/SMS to camp families
//
// Request: { to: [{email, name, phone}], subject, body, method, campName }
// Methods: 'email', 'sms', 'all'
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { Resend } from "npm:resend@2.0.0";

const resend = new Resend(Deno.env.get("RESEND_API_KEY"));
const TWILIO_SID = Deno.env.get("TWILIO_ACCOUNT_SID");
const TWILIO_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN");
const TWILIO_FROM = Deno.env.get("TWILIO_FROM_NUMBER");
const FROM_EMAIL = Deno.env.get("FROM_EMAIL") || "Campistry <noreply@campistry.com>";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function sendSMS(to: string, body: string): Promise<boolean> {
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) return false;
  try {
    const resp = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
      {
        method: "POST",
        headers: {
          "Authorization": "Basic " + btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: to, From: TWILIO_FROM, Body: body }).toString(),
      }
    );
    return resp.ok;
  } catch {
    return false;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { to, subject, body, method, campName } = await req.json();
    if (!to?.length || !body) {
      return new Response(JSON.stringify({ error: "to and body required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const results = { emailSent: 0, emailFailed: 0, smsSent: 0, smsFailed: 0 };
    const sendEmail = method === "email" || method === "all" || method === "All Channels";
    const sendSms = method === "sms" || method === "SMS" || method === "all" || method === "All Channels";

    const htmlBody = `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#2563EB;color:#fff;padding:16px 24px;border-radius:8px 8px 0 0;">
          <strong>${campName || "Camp"}</strong>
        </div>
        <div style="padding:24px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px;">
          ${subject ? `<h2 style="margin:0 0 12px;font-size:18px;">${subject}</h2>` : ""}
          <div style="font-size:15px;line-height:1.6;color:#334155;white-space:pre-wrap;">${body}</div>
          <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">
          <p style="font-size:12px;color:#94a3b8;">Sent via Campistry</p>
        </div>
      </div>`;

    for (const recipient of to) {
      // Email
      if (sendEmail && recipient.email) {
        try {
          const { error } = await resend.emails.send({
            from: FROM_EMAIL,
            to: [recipient.email],
            subject: subject || `Message from ${campName || "Camp"}`,
            html: htmlBody,
          });
          if (error) { results.emailFailed++; console.error("Email failed:", recipient.email, error); }
          else results.emailSent++;
        } catch (e) {
          results.emailFailed++;
          console.error("Email error:", recipient.email, e.message);
        }
      }

      // SMS
      if (sendSms && recipient.phone) {
        const smsBody = (subject ? subject + "\n\n" : "") + body + "\n\n— " + (campName || "Camp");
        const ok = await sendSMS(recipient.phone, smsBody);
        if (ok) results.smsSent++;
        else results.smsFailed++;
      }

      // Rate limit: small delay between sends
      if (to.length > 5) await new Promise((r) => setTimeout(r, 100));
    }

    console.log(`[send-broadcast] Results:`, results);

    return new Response(JSON.stringify({ success: true, ...results }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[send-broadcast] Error:", err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
