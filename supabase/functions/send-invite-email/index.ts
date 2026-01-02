import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { Resend } from "npm:resend@2.0.0";

const resend = new Resend(Deno.env.get("RESEND_API_KEY"));

serve(async (req) => {
  // Handle CORS (allows your website to call this function)
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      },
    })
  }

  try {
    const { email, inviteUrl, role, invitedBy } = await req.json();

    const { data, error } = await resend.emails.send({
      from: "Campistry <onboarding@resend.dev>", // Update this if you verified a domain
      to: [email],
      subject: "You've been invited to join Campistry",
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Hello!</h2>
          <p>You have been invited by <strong>${invitedBy}</strong> to join their camp team on Campistry as a <strong>${role}</strong>.</p>
          <div style="margin: 24px 0;">
            <a href="${inviteUrl}" style="background-color: #6366F1; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Accept Invitation</a>
          </div>
          <p style="color: #666; font-size: 14px;">Or copy this link: <br> ${inviteUrl}</p>
        </div>
      `,
    });

    if (error) {
      console.error(error);
      return new Response(JSON.stringify({ error }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
});
