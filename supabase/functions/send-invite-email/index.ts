import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { Resend } from "npm:resend@2.0.0";

const resend = new Resend(Deno.env.get("RESEND_API_KEY"));

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  // Require a Bearer token — rejects unauthenticated callers
  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  try {
    const { email, inviteUrl, role, invitedBy } = await req.json();

    // Validate required fields
    if (!email || !inviteUrl || !role || !invitedBy) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return new Response(JSON.stringify({ error: "Invalid email address" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // Escape all user-supplied values before inserting into HTML
    const safeInvitedBy = escapeHtml(invitedBy);
    const safeRole = escapeHtml(role);
    const safeEmail = escapeHtml(email);
    // inviteUrl goes into an href — validate it's a real URL, not javascript:
    const safeInviteUrl = inviteUrl.startsWith("https://") ? inviteUrl : "";
    if (!safeInviteUrl) {
      return new Response(JSON.stringify({ error: "Invalid invite URL" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const { data, error } = await resend.emails.send({
      from: "Campistry <onboarding@resend.dev>",
      to: [email],
      subject: "You've been invited to join Campistry",
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Hello!</h2>
          <p>You have been invited by <strong>${safeInvitedBy}</strong> to join their camp team on Campistry as a <strong>${safeRole}</strong>.</p>
          <div style="margin: 24px 0;">
            <a href="${safeInviteUrl}" style="background-color: #6366F1; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Accept Invitation</a>
          </div>
          <p style="color: #666; font-size: 14px;">Or copy this link: <br> ${safeInviteUrl}</p>
        </div>
      `,
    });

    if (error) {
      console.error(error);
      return new Response(JSON.stringify({ error }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
