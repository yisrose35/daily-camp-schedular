-- ============================================================================
-- Migration 103: POS login becomes email + PIN, not PIN alone
--
-- Migration 102 made the PIN the sole identifier (no camp-scoped link at
-- all), which required enforcing PIN uniqueness across every camp on the
-- platform and scanning all camps' hashes on every login — workable, but
-- global uniqueness was a real, slightly awkward constraint to explain to
-- an owner picking a PIN.
--
-- Cleaner approach, per the owner: log in with the SAME EMAIL used for the
-- owner's real Campistry account, plus the PIN in place of a password. The
-- email disambiguates the camp (exactly like a normal login), so the PIN
-- only ever needs to be checked against ONE camp's hash — no global scan,
-- no cross-camp uniqueness requirement, and every attempt (right or wrong)
-- is attributable to a specific camp again, so the existing per-camp
-- lockout (migration 101, 5 wrong attempts -> owner must unlock) is back
-- to being the WHOLE brute-force story, not just the "returning device"
-- half of it.
--
-- This still isn't the owner's real login: the PIN is a completely
-- separate secret from their actual Supabase Auth password, checked by a
-- different function against a different stored value. Someone with the
-- owner's email + PIN can only ever reach the POS's shadow counselor
-- account — never the owner's real account, which still needs the real
-- password.
--
-- Supersedes migration 102's global-lookup machinery — dropped below,
-- nothing else in the app referenced it.
--
-- Idempotent — safe to re-run.
-- ============================================================================

-- ─── 1. set_camp_pos_pin — drop the now-unneeded global-uniqueness check ──
-- Email disambiguates the camp now, so two camps sharing a PIN is no
-- longer ambiguous — back to a plain per-camp save.
CREATE OR REPLACE FUNCTION public.set_camp_pos_pin(p_camp_id uuid, p_pin text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
    caller     uuid := auth.uid();
    v_is_admin boolean;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    v_is_admin :=
        EXISTS (SELECT 1 FROM camps WHERE id = p_camp_id AND owner = caller)
        OR EXISTS (SELECT 1 FROM camp_users
                   WHERE camp_id = p_camp_id AND user_id = caller AND role IN ('owner', 'admin'));

    IF NOT v_is_admin THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    IF p_pin IS NULL OR p_pin !~ '^[0-9]{4,8}$' THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_pin');
    END IF;

    INSERT INTO camp_pos_credentials (camp_id, pin_hash, pin_set_at, pin_set_by, failed_attempts, locked, locked_at)
    VALUES (p_camp_id, crypt(p_pin, gen_salt('bf')), now(), caller, 0, false, NULL)
    ON CONFLICT (camp_id) DO UPDATE
        SET pin_hash        = EXCLUDED.pin_hash,
            pin_set_at      = now(),
            pin_set_by      = caller,
            failed_attempts = 0,
            locked          = false,
            locked_at       = NULL,
            updated_at      = now();

    RETURN jsonb_build_object('success', true);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.set_camp_pos_pin(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.set_camp_pos_pin(uuid, text) TO authenticated;


-- ─── 2. resolve_camp_owner_by_email — the new "which camp is this" step ──
-- service_role ONLY. Looks up the Supabase Auth user with this email
-- (schema-qualified auth.users read — same established pattern already
-- used by claim_invites_by_email/request_link_join, migration 032), then
-- returns the camp THEY OWN. Deliberately owner-only (not any staff
-- member's email) — this is standing in for "the same email used to sign
-- into the main Campistry account" from the owner's own request, and
-- matches how camp_id is resolved everywhere else in this app (the
-- owner's own uid, per callerCampId's "original signup convention").
CREATE OR REPLACE FUNCTION public.resolve_camp_owner_by_email(p_email text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_user_id uuid;
    v_camp_id uuid;
BEGIN
    IF p_email IS NULL OR btrim(p_email) = '' THEN
        RETURN NULL;
    END IF;

    SELECT id INTO v_user_id FROM auth.users WHERE lower(email) = lower(btrim(p_email)) LIMIT 1;
    IF v_user_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT id INTO v_camp_id FROM camps WHERE owner = v_user_id LIMIT 1;
    RETURN v_camp_id;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_camp_owner_by_email(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_camp_owner_by_email(text) TO service_role;


-- ─── 3. Drop migration 102's now-superseded global-lookup machinery ──────
DROP FUNCTION IF EXISTS public.verify_pos_pin_global(text);
DROP FUNCTION IF EXISTS public.check_pos_global_rate_limit(text);
DROP TABLE IF EXISTS pos_global_login_attempts;


-- ─── Sanity checks (run manually after applying) ───────────────────────────
--   SELECT proname, proacl FROM pg_proc WHERE proname = 'resolve_camp_owner_by_email';
--   -- expect grant to service_role only
--
--   SELECT proname FROM pg_proc WHERE proname IN ('verify_pos_pin_global','check_pos_global_rate_limit');
--   -- expect ZERO rows
-- ============================================================================
