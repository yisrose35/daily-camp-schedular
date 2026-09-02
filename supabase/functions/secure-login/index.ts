// =============================================================================
// secure-login — the ONLY path for a password sign-in against a real
// Campistry account (index.html/landing.js, invite.html's "already have an
// account" step). The client never calls supabase.auth.signInWithPassword()
// directly for these anymore — every attempt is proxied through here so the
// lockout in migration 105 can actually be enforced. A client calling GoTrue
// directly would be able to skip the lockout entirely; routing every attempt
// through a service-role-checked function is the only way to make it real.
//
// Request:  { email, password }
// Response: { access_token, refresh_token } on success, or
//           { error, locked?, lockLevel?, emailNotConfirmed? } on failure.
//
// On success the CLIENT is responsible for calling
// supabase.auth.setSession({ access_token, refresh_token }) to actually
// adopt the session — this function only proves the password was correct
// and hands back real tokens, same shape pos-pin-login already returns.
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "npm:resend@2.0.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const resend = new Resend(Deno.env.get("RESEND_API_KEY"));

// Hardcoded, never taken from the request — the unlock link goes out in an
// email to the account's real inbox, so the destination it points at can't
// be influenced by whoever triggered the lockout (which needs nothing more
// than someone else's email address and a few wrong guesses).
const APP_ORIGIN = "https://campistry.org";

// Where the office's OWN heads-up alert goes when a camp gets office-locked
// (10-in-24h) — separate from LOCKED_MESSAGE.office, which is what the
// locked-out person sees. Same address, same convention as
// stripe-risk-volume-monitor's RISK_ALERT_EMAIL: the office should hear
// about this proactively, not only when the camp calls in confused.
const OFFICE_ALERT_EMAIL = "campistryoffice@gmail.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// Fires once per escalation (record_login_failure only ever sets
// justLocked=true on the transition into 'office' — a locked camp's further
// attempts never reach record_login_failure at all, since check_login_lock_
// status rejects them first) — so this can't turn into a flood of alerts
// for one ongoing incident. Best-effort: a failure here must never surface
// to the person who triggered the lockout, so it's swallowed, same as the
// unlock-email send above.
async function sendOfficeLockAlert(triggeringEmail: string, campEmails: string[]) {
  try {
    const emailList = campEmails.length
      ? `<ul>${campEmails.map((e) => `<li>${e}</li>`).join("")}</ul>`
      : "<p>(could not resolve the camp's other logins)</p>";
    const { error } = await resend.emails.send({
      from: "Campistry Platform Alerts <onboarding@resend.dev>",
      to: [OFFICE_ALERT_EMAIL],
      subject: `Camp locked out: 10 failed sign-ins on ${triggeringEmail}`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color:#B91C1C;">A camp just got locked out</h2>
          <p><strong>${triggeringEmail}</strong> hit 10 failed password attempts within a rolling 24 hours, which escalates to an office-only lock.</p>
          <p>Every login at that camp is now locked out until it's cleared by hand:</p>
          ${emailList}
          <p style="margin-top:20px;color:#64748B;font-size:13px;">
            This could be a real credential-guessing attempt, or just someone who
            forgot their password and kept retrying past the self-service reopen
            step. Verify with the camp owner before clearing it — see
            EMAIL_VERIFICATION_LOCKOUT_SETUP.md step 5 for the unlock query.
          </p>
        </div>`,
    });
    if (error) console.error("[secure-login] office alert email failed:", error);
  } catch (mailErr) {
    console.error("[secure-login] office alert email threw:", mailErr);
  }
}

const LOCKED_MESSAGE: Record<string, string> = {
  email: "This account is locked due to repeated failed sign-in attempts. Check your email for a link to reopen it.",
  office: "You have been locked out due to repeated failed sign-in attempts. Please contact campistryoffice@gmail.com in order to unlock your account.",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_KEY) {
      return json({ error: "Server not configured" }, 500);
    }

    const body = await req.json().catch(() => ({}));
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    if (!email) return json({ error: "Enter your email address." }, 400);
    if (!password) return json({ error: "Enter your password." }, 400);

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

    const { data: lockStatus, error: lockErr } = await admin.rpc("check_login_lock_status", { p_email: email });
    if (lockErr) {
      console.error("[secure-login] check_login_lock_status error:", lockErr);
      return json({ error: "Could not verify login right now. Try again in a moment." }, 500);
    }

    if (lockStatus?.locked) {
      const level = lockStatus.lockLevel === "office" ? "office" : "email";
      return json({ error: LOCKED_MESSAGE[level], locked: true, lockLevel: level }, 423);
    }

    // The real check, done server-side against GoTrue's own token endpoint —
    // this is exactly what supabase-js's signInWithPassword does under the
    // hood, just from here instead of the browser, so the lockout check
    // above always runs first.
    const tokenResp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const tokenData = await tokenResp.json().catch(() => ({} as any));

    if (tokenResp.ok && tokenData?.access_token) {
      // admin.rpc(...) returns a Postgrest query builder, not a native
      // Promise — it's thenable (awaitable) but has no real .catch()
      // method, so chaining .catch() directly on it throws "catch is not
      // a function" before the request is even sent. try/catch instead.
      try {
        await admin.rpc("clear_login_failures", { p_email: email });
      } catch (_) {
        // Best-effort cleanup only — a failure here must never block a
        // successful login.
      }
      return json({ access_token: tokenData.access_token, refresh_token: tokenData.refresh_token });
    }

    const errCode = String(tokenData?.error_code || tokenData?.error || "");
    const errDesc = String(tokenData?.error_description || tokenData?.msg || "");

    // An unconfirmed account isn't a wrong-password guess — route the
    // client back to the verification-code step instead of counting it
    // toward the lockout.
    if (errCode === "email_not_confirmed" || /not confirmed/i.test(errDesc)) {
      return json({ error: "Please verify your email before signing in.", emailNotConfirmed: true }, 400);
    }

    // Everything else — wrong password, or an email with no account at all
    // (GoTrue returns the same invalid_grant either way, which is also what
    // keeps this endpoint from revealing whether an email has an account) —
    // counts as a failed attempt.
    const { data: failResult, error: failErr } = await admin.rpc("record_login_failure", { p_email: email });
    if (failErr) {
      console.error("[secure-login] record_login_failure error:", failErr);
      return json({ error: "Invalid email or password. Please try again." }, 401);
    }

    if (failResult?.justLocked && failResult.lockLevel === "email" && failResult.unlockToken) {
      const unlockUrl = `${APP_ORIGIN}/index.html?unlock=${failResult.unlockToken}`;
      try {
        await resend.emails.send({
          from: "Campistry <onboarding@resend.dev>",
          to: [email],
          subject: "Reopen your Campistry account",
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
              <h2>Your account was locked</h2>
              <p>We saw several incorrect password attempts on your Campistry account. To protect it, sign-in has been temporarily paused.</p>
              <div style="margin: 24px 0;">
                <a href="${unlockUrl}" style="background-color: #147D91; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Reopen My Account</a>
              </div>
              <p style="color: #666; font-size: 14px;">Or copy this link: <br> ${unlockUrl}</p>
              <p style="color: #666; font-size: 14px;">If this wasn't you, someone may be trying to guess your password — consider changing it once you're back in.</p>
            </div>
          `,
        });
      } catch (mailErr) {
        console.error("[secure-login] Failed to send unlock email:", mailErr);
      }
      return json({ error: LOCKED_MESSAGE.email, locked: true, lockLevel: "email" }, 423);
    }

    if (failResult?.lockLevel === "office") {
      if (failResult.justLocked) {
        // Awaited (not fire-and-forget) — an edge function's isolate can be
        // torn down right after the response is returned, which would drop
        // an un-awaited send before it ever reaches Resend. sendOfficeLockAlert
        // itself swallows its own errors, so this can't turn a mail hiccup
        // into a failed sign-in response.
        const campEmails: string[] = Array.isArray(failResult.campEmails) ? failResult.campEmails : [];
        await sendOfficeLockAlert(email, campEmails);
      }
      return json({ error: LOCKED_MESSAGE.office, locked: true, lockLevel: "office" }, 423);
    }

    const remaining = failResult?.attemptsRemaining;
    const suffix = typeof remaining === "number" && remaining > 0
      ? ` ${remaining} attempt${remaining === 1 ? "" : "s"} left before your account locks.`
      : "";
    return json({ error: "Invalid email or password." + suffix }, 401);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
