// =============================================================================
// pos-pin-login — email + PIN login for the standalone Snacks POS
// (snacks.campistry.org). Public/anon endpoint by design: there is no
// authenticated caller yet at this point, that's the whole point of it.
//
// Login shape: the SAME EMAIL the owner uses to sign into the main
// Campistry app, plus a PIN standing in for a password. The email is what
// tells this function which camp is being logged into (resolve_camp_owner_
// by_email — a plain lookup, not a secret); the PIN is the actual secret,
// checked against that ONE camp's stored hash by the existing
// verify_camp_pos_pin RPC (migration 101), with its full per-camp lockout
// (5 wrong PINs locks the register until an owner/admin unlocks it from
// the Manager Dashboard).
//
// This is still NOT the owner's real login — the PIN is a separate secret
// from their actual account password, stored and checked completely
// independently. Someone with the email + PIN can only ever reach the
// hidden shadow counselor account this function signs them into, never the
// owner's real account (that still needs the real password, which this
// flow never touches).
//
// On a correct PIN, lazily provisions (first time only, per camp) that
// hidden shadow Supabase Auth user, with a camp_users row at
// role='counselor' + product_access:['snacks'] — read-everything,
// write-only-Snacks, and nothing else. Signs in as it and returns real
// session tokens to the browser.
//
// Request:  { email, pin }
// Response: { access_token, refresh_token, campId } on success, or
//           { error, locked? } on failure.
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
    const email = typeof body?.email === "string" ? body.email.trim() : "";
    const pin = typeof body?.pin === "string" ? body.pin.trim() : "";
    if (!email) return json({ error: "Enter the email address." }, 400);
    if (!pin) return json({ error: "Enter the PIN." }, 400);

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

    const { data: campId, error: resolveErr } = await admin.rpc("resolve_camp_owner_by_email", { p_email: email });
    if (resolveErr) return json({ error: "Could not verify those details right now. Try again in a moment." }, 500);
    // Same message either way (unknown email vs wrong PIN) — don't let this
    // endpoint be used to check whether an email has a Campistry account.
    if (!campId) return json({ error: "Incorrect email or PIN." }, 401);

    const { data: verifyData, error: verifyErr } = await admin.rpc("verify_camp_pos_pin", { p_camp_id: campId, p_pin: pin });
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
        error: "Incorrect email or PIN." + (typeof remaining === "number"
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
      const shadowLoginEmail = `pos-${campId}@pos.campistry.internal`;
      const password = randomSecret();

      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email: shadowLoginEmail,
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
        email: shadowLoginEmail,
        name: "POS Register",
        role: "counselor",
        accepted_at: new Date().toISOString(),
        invite_token: crypto.randomUUID(),
        // product_access_guard.js blocks any page not listed here — the
        // shadow account exists for exactly one thing, this page.
        product_access: ["snacks"],
      });
      if (cuErr) {
        await admin.auth.admin.deleteUser(newUserId);
        return json({ error: "Could not set up the register login. Try again, or ask the office to reset the PIN." }, 500);
      }

      const { data: stored, error: storeErr } = await admin.rpc("set_camp_pos_shadow_account", {
        p_camp_id: campId,
        p_shadow_user_id: newUserId,
        p_shadow_email: shadowLoginEmail,
        p_shadow_password: password,
      });

      if (storeErr || !stored?.success) {
        await admin.from("camp_users").delete().eq("user_id", newUserId);
        await admin.auth.admin.deleteUser(newUserId);
        return json({ error: "Could not set up the register login. Try again, or ask the office to reset the PIN." }, 500);
      }

      if (stored.applied) {
        shadowUserId = newUserId;
        shadowEmail = shadowLoginEmail;
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

    // Self-heal: a shadow account provisioned before product_access was
    // added to the insert above would otherwise be stuck forever with an
    // empty product_access array (product_access_guard.js blocks it from
    // ever opening the Snacks POS). Unconditionally re-assert it on every
    // login — cheap, idempotent, and this account only ever needs one
    // product, so there's nothing to preserve by conditioning the write.
    if (shadowUserId) {
      await admin.from("camp_users").update({ product_access: ["snacks"] }).eq("user_id", shadowUserId);
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
