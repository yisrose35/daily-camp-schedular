// supabase/functions/send-invite-email/index.ts
// Supabase Edge Function to send invite emails via Resend

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

// CORS headers for browser requests
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface InviteEmailRequest {
  to: string;
  inviteUrl: string;
  role: string;
  campName: string;
  invitedBy?: string;
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Verify API key exists
    if (!RESEND_API_KEY) {
      throw new Error("RESEND_API_KEY not configured");
    }

    // Parse request body
    const { to, inviteUrl, role, campName, invitedBy }: InviteEmailRequest = await req.json();

    // Validate required fields
    if (!to || !inviteUrl || !role || !campName) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: to, inviteUrl, role, campName" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Build the email HTML
    const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>You're Invited to ${campName}</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f8fafc;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f8fafc; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 500px; background-color: #ffffff; border-radius: 16px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05);">
          
          <!-- Header -->
          <tr>
            <td style="padding: 40px 40px 20px; text-align: center;">
              <div style="font-size: 40px; margin-bottom: 16px;">⛺</div>
              <h1 style="margin: 0; font-size: 24px; color: #1e293b; font-weight: 700;">
                You're Invited!
              </h1>
            </td>
          </tr>
          
          <!-- Body -->
          <tr>
            <td style="padding: 0 40px 30px;">
              <p style="margin: 0 0 20px; font-size: 16px; line-height: 1.6; color: #475569;">
                You've been invited to join <strong style="color: #1e293b;">${campName}</strong> on Campistry as a <strong style="color: #6366f1;">${role}</strong>.
              </p>
              
              <p style="margin: 0 0 30px; font-size: 16px; line-height: 1.6; color: #475569;">
                Campistry helps camps create and manage daily schedules, activities, and more.
              </p>
              
              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center">
                    <a href="${inviteUrl}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #6366f1, #4f46e5); color: #ffffff; text-decoration: none; font-weight: 600; font-size: 16px; border-radius: 10px; box-shadow: 0 4px 12px rgba(99, 102, 241, 0.4);">
                      Accept Invitation
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Divider -->
          <tr>
            <td style="padding: 0 40px;">
              <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 0;">
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 20px 40px 30px;">
              <p style="margin: 0 0 10px; font-size: 13px; color: #94a3b8; line-height: 1.5;">
                If the button doesn't work, copy and paste this link:
              </p>
              <p style="margin: 0; font-size: 12px; color: #6366f1; word-break: break-all;">
                ${inviteUrl}
              </p>
            </td>
          </tr>
          
          <!-- Brand Footer -->
          <tr>
            <td style="padding: 20px 40px 30px; background-color: #f8fafc; border-radius: 0 0 16px 16px;">
              <p style="margin: 0; font-size: 13px; color: #94a3b8; text-align: center;">
                Sent via <a href="https://campistry.org" style="color: #6366f1; text-decoration: none;">Campistry</a>
                ${invitedBy ? ` • Invited by ${invitedBy}` : ''}
              </p>
            </td>
          </tr>
          
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `;

    // Plain text version
    const emailText = `
You're Invited to ${campName}!

You've been invited to join ${campName} on Campistry as a ${role}.

Campistry helps camps create and manage daily schedules, activities, and more.

Accept your invitation here:
${inviteUrl}

---
Sent via Campistry (campistry.org)
${invitedBy ? `Invited by ${invitedBy}` : ''}
    `.trim();

    // Send email via Resend
    const resendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Campistry <invites@campistry.org>", // Change this to your verified domain
        to: [to],
        subject: `You're invited to join ${campName} on Campistry`,
        html: emailHtml,
        text: emailText,
      }),
    });

    const resendData = await resendResponse.json();

    if (!resendResponse.ok) {
      console.error("Resend error:", resendData);
      return new Response(
        JSON.stringify({ error: resendData.message || "Failed to send email" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("Email sent successfully:", resendData);

    return new Response(
      JSON.stringify({ 
        success: true, 
        messageId: resendData.id,
        message: `Invite email sent to ${to}` 
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
