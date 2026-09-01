// =============================================================================
// pos-pin-login — shared-PIN login for the standalone Snacks POS
// (snacks.campistry.org). Public/anon endpoint by design: there is no
// authenticated caller yet at this point, that's the whole point of it.
//
// A camp owner sets a short PIN for their register (set_camp_pos_pin RPC,
// called directly from the Manager Dashboard with the owner's own session —
// no edge function needed for that half). A canteen runner just goes to
// snacks.campistry.org and types the PIN — there is no camp-scoped link to
// share anymore, so this function has to figure out WHICH camp a PIN
// belongs to, not just verify one it's already been told.
//
// Two lookup paths, depending on whether the browser already knows a camp:
//   - campId present (a device that has logged in here before remembers it
//     locally, purely as a client-side speed hint — see
//     campistry_snacks_pos.html): verify_camp_pos_pin checks THAT camp's
//     hash only, with full per-camp lockout (5 wrong guesses locks it until
//     an owner/admin unlocks it from the Dashboard — migration 101).
//   - campId absent (first time on this device, or storage was cleared):
//     verify_pos_pin_global scans every camp's hash to find a match. A
//     wrong guess here can't be attributed to any specific camp (nothing to
//     lock), so this path is throttled by IP instead
//     (check_pos_global_rate_limit) — see migration 102 for the full
//     reasoning on why both of these exist together.
//
// Either way, on a correct PIN this function lazily provisions (first time
// only, per camp) a hidden "shadow" Supabase Auth user with a camp_users
// row at role='counselor' + product_access:['snacks'] — read-everything,
// write-only-Snacks, and nothing else. Nobody ever sees this shadow
// account's own credentials; the runner only ever knows the PIN. Signs in
// as it and returns real session tokens to the browser.
//
// Response: { access_token, refresh_token, campId } on success, or
// { error, locked? } on failure.
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

function callerIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || "unknown";
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_KEY) {
      return json({ error: "Server not configured" }, 500);
    }

    const body = await req.json().catch(() => ({}));
    const hintedCampId = typeof body?.campId === "string" ? body.campId.trim() : "";
    const pin = typeof body?.pin === "string" ? body.pin.trim() : "";
    if (!pin) return json({ error: "Enter the PIN." }, 400);

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

    let verifyData: Record<string, unknown> | null = null;

    if (hintedCampId) {
      const { data, error } = await admin.rpc("verify_camp_pos_pin", { p_camp_id: hintedCampId, p_pin: pin });
      if (error) return json({ error: "Could not verify the PIN right now. Try again in a moment." }, 500);
      verifyData = data;
      // A remembered camp with no PIN set at all (e.g. the office cleared it)
      // falls through to the global scan below instead of dead-ending here —
      // the device's stale hint shouldn't block a PIN that's valid elsewhere.
      if (verifyData && verifyData.reason === "not_set_up") verifyData = null;
    }

    if (!verifyData) {
      const { data: limitData, error: limitErr } = await admin.rpc("check_pos_global_rate_limit", { p_ip: callerIp(req) });
      if (limitErr) return json({ error: "Could not verify the PIN right now. Try again in a moment." }, 500);
      if (!limitData?.allowed) {
        return json({ error: "Too many attempts from this network. Try again in a few minutes." }, 429);
      }

      const { data, error } = await admin.rpc("verify_pos_pin_global", { p_pin: pin });
      if (error) return json({ error: "Could not verify the PIN right now. Try again in a moment." }, 500);
      verifyData = data;
    }

    if (!verifyData?.success) {
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

    const campId: string = (verifyData.campId as string) || hintedCampId;
    let shadowUserId: string | null = (verifyData.shadowUserId as string) || null;
    let shadowEmail: string | null = (verifyData.shadowEmail as string) || null;
    let shadowPassword: string | null = (verifyData.shadowPassword as string) || null;

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
