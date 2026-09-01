// =============================================================================
// pos-pin-login — shared-PIN login for the standalone Snacks POS
// (snacks.campistry.org). Public/anon endpoint by design: there is no
// authenticated caller yet at this point, that's the whole point of it.
//
// A camp owner sets a short PIN for their register (set_camp_pos_pin RPC,
// called directly from the Manager Dashboard with the owner's own session —
// no edge function needed for that half). A canteen runner types that PIN
// into campistry_snacks_login.html, which posts { campId, pin } here.
//
// This function NEVER hands out the owner's real account. Instead:
//   1. verify_camp_pos_pin (service-role RPC) checks the PIN against the
//      bcrypt hash, atomically enforcing a per-camp lockout after repeated
//      wrong guesses (a PIN is much lower entropy than a real password —
//      this endpoint is reachable by anyone on the internet who has the
//      camp's link, so brute force has to be shut down server-side).
//   2. On a correct PIN, it lazily provisions (first time only) a hidden
//      "shadow" Supabase Auth user for this camp, with a camp_users row at
//      role='counselor' — the same role migration 099 scoped to read
//      everything and write ONLY campistrySnacks. Nobody ever sees this
//      shadow account's own credentials; the runner only ever knows the PIN.
//   3. Signs in as that shadow account and returns real session tokens
//      (access_token/refresh_token) to the browser, which calls
//      supabase.auth.setSession(...) — from then on the POS behaves exactly
//      like every other authenticated client in this app, RLS included.
//
// Response: { access_token, refresh_token, campId } on success, or
// { error, locked?, retryAfterSeconds? } on failure.
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function randomSecret(): string {
  return crypto.randomUUID() + crypto.randomUUID();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_KEY) {
      return json({ error: "Server not configured" }, 500);
    }

    const body = await req.json().catch(() => ({}));
    const campId = typeof body?.campId === "string" ? body.campId.trim() : "";
    const pin = typeof body?.pin === "string" ? body.pin.trim() : "";
    if (!campId) return json({ error: "This login link is missing its camp — ask the office to re-share it." }, 400);
    if (!pin) return json({ error: "Enter the PIN." }, 400);

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

    const { data: verifyData, error: verifyErr } = await admin.rpc("verify_camp_pos_pin", {
      p_camp_id: campId,
      p_pin: pin,
    });
    if (verifyErr) return json({ error: "Could not verify the PIN right now. Try again in a moment." }, 500);

    if (!verifyData?.success) {
      if (verifyData?.reason === "not_set_up") {
        return json({ error: "This register hasn't had a PIN set up yet. Ask the office to set one from the Manager Dashboard." }, 400);
      }
      if (verifyData?.reason === "locked") {
        return json({
          error: "Too many wrong PIN attempts. The register is locked — ask the office to unlock it from the Manager Dashboard.",
          locked: true,
        }, 429);
      }
      const remaining = verifyData?.attemptsRemaining;
      return json({
        error: "Incorrect PIN." + (typeof remaining === "number"
          ? (remaining > 0 ? ` ${remaining} attempt${remaining === 1 ? "" : "s"} left before the register locks.` : " The register is now locked.")
          : ""),
      }, 401);
    }

    let shadowUserId: string | null = verifyData.shadowUserId || null;
    let shadowEmail: string | null = verifyData.shadowEmail || null;
    let shadowPassword: string | null = verifyData.shadowPassword || null;

    if (!shadowUserId || !shadowEmail || !shadowPassword) {
      // First correct PIN entry for this camp — provision the hidden shadow
      // account. Deliberately not a real inbox: this account is only ever
      // signed into server-side, from here, by password.
      const email = `pos-${campId}@pos.campistry.internal`;
      const password = randomSecret();

      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { campistry_pos_shadow: true, camp_id: campId },
      });
      if (createErr || !created?.user) {
        return json({ error: "Could not set up the register login. Try again, or ask the office to reset the PIN." }, 500);
      }
      const newUserId = created.user.id;

      const { error: cuErr } = await admin.from("camp_users").insert({
        camp_id: campId,
        user_id: newUserId,
        email,
        name: "POS Register",
        role: "counselor",
        accepted_at: new Date().toISOString(),
        invite_token: crypto.randomUUID(),
      });
      if (cuErr) {
        await admin.auth.admin.deleteUser(newUserId);
        return json({ error: "Could not set up the register login. Try again, or ask the office to reset the PIN." }, 500);
      }

      const { data: stored, error: storeErr } = await admin.rpc("set_camp_pos_shadow_account", {
        p_camp_id: campId,
        p_shadow_user_id: newUserId,
        p_shadow_email: email,
        p_shadow_password: password,
      });

      if (storeErr || !stored?.success) {
        await admin.from("camp_users").delete().eq("user_id", newUserId);
        await admin.auth.admin.deleteUser(newUserId);
        return json({ error: "Could not set up the register login. Try again, or ask the office to reset the PIN." }, 500);
      }

      if (stored.applied) {
        shadowUserId = newUserId;
        shadowEmail = email;
        shadowPassword = password;
      } else {
        // Another request won the race and provisioned first — throw away
        // the duplicate we just made and use theirs.
        await admin.from("camp_users").delete().eq("user_id", newUserId);
        await admin.auth.admin.deleteUser(newUserId);
        shadowUserId = stored.shadowUserId;
        shadowEmail = stored.shadowEmail;
        shadowPassword = stored.shadowPassword;
      }
    }

    if (!shadowEmail || !shadowPassword) {
      return json({ error: "Could not sign in to the register right now. Try again, or ask the office to reset the PIN." }, 500);
    }

    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const { data: signInData, error: signInErr } = await anon.auth.signInWithPassword({
      email: shadowEmail,
      password: shadowPassword,
    });
    if (signInErr || !signInData?.session) {
      return json({ error: "Could not sign in to the register right now. Try again, or ask the office to reset the PIN." }, 500);
    }

    return json({
      access_token: signInData.session.access_token,
      refresh_token: signInData.session.refresh_token,
      campId,
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
