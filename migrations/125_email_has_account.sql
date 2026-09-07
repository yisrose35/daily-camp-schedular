-- ============================================================================
-- Migration 125: email_has_account — lets the main login's "Forgot
-- Password" screen tell someone up front that an email has no account,
-- instead of always saying "reset link sent" the way Supabase's own
-- resetPasswordForEmail() does by design (it never reveals whether an
-- email exists, to prevent account enumeration).
--
-- Deliberate trade-off, consistent with how this app already behaves
-- elsewhere: the main signup form (landing.js) already tells someone
-- "An account with this email already exists" when they try to sign up
-- with a registered address — Supabase's own GoTrue error surfaces that
-- today with no extra code. This migration applies the same posture to
-- the reset-password screen for the SAME population (camp owners/staff).
--
-- This is intentionally NOT applied to Campistry Link's parent-portal
-- reset flow (campistry_link_parent.html) — that one has its own
-- deliberate comment keeping the response identical either way, since a
-- differing reply there could tell a stranger which family emails have
-- an account with a specific camp. Leave that one as-is.
--
-- Same convention as every other auth.users lookup in this app
-- (migration 105's _resolve_camp_id): SECURITY DEFINER function reading
-- auth.users directly (not exposed via PostgREST on its own), granted to
-- anon since the person checking hasn't signed in yet. Read-only, no
-- lockout/rate-limit table added here — the existing account_lockouts
-- system (migration 105) is about failed PASSWORD attempts, not email
-- lookups, and isn't a fit for this endpoint.
--
-- Idempotent — safe to re-run.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.email_has_account(p_email text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, auth, pg_catalog
AS $$
    SELECT EXISTS (
        SELECT 1 FROM auth.users WHERE lower(email) = lower(p_email)
    );
$$;

REVOKE ALL ON FUNCTION public.email_has_account(text) FROM public;
GRANT EXECUTE ON FUNCTION public.email_has_account(text) TO anon, authenticated;

-- ─── Sanity check (run manually after applying) ────────────────────────────
--   SELECT proname, proacl FROM pg_proc WHERE proname = 'email_has_account';
--   -- expect: grants to anon + authenticated.
--
--   SELECT email_has_account('someone@realaccount.com'); -- true for a real account
--   SELECT email_has_account('nobody@nowhere.test');      -- false
-- ============================================================================
