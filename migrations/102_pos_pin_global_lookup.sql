-- ============================================================================
-- Migration 102: PIN-only login — no per-camp link required anymore
--
-- The owner asked to drop the camp-scoped "register link" entirely: any
-- device should be able to go straight to snacks.campistry.org and type
-- the PIN, with nothing identifying which camp first. That changes the
-- login from "verify this PIN for a camp I already know" to "find out
-- which camp this PIN belongs to."
--
-- Two consequences that have to be handled for this to stay safe on a
-- multi-tenant platform (many camps sharing one snacks.campistry.org):
--
-- 1. PINs must be UNIQUE ACROSS ALL CAMPS. Without a camp identifier, two
--    camps sharing the same PIN would make a login ambiguous — whichever
--    camp's row happens to be checked first would win, so a runner could
--    land in a DIFFERENT camp's register. set_camp_pos_pin now rejects a
--    PIN already in use by another camp. (Hashes are bcrypt/salted, so this
--    can't be a simple UNIQUE index — it's checked by comparing the
--    candidate PIN against every other camp's stored hash with crypt().)
--
-- 2. A WRONG PIN with no camp hint can't be attributed to any specific
--    camp, so the per-camp 5-attempts-then-owner-must-unlock lockout
--    (migration 101) simply doesn't apply to a guess that matches nobody —
--    there's no camp to lock. That's a real reduction in per-tenant
--    brute-force protection for a brand-new/never-used device. To keep a
--    floor under it, this migration adds a coarse GLOBAL rate limit
--    (by caller IP) on the no-hint lookup path specifically — see
--    pos_global_login_attempts below. A device that HAS already logged in
--    once keeps remembering its camp locally (unchanged from before) and
--    goes through the existing per-camp path on repeat visits, so it keeps
--    full per-camp lockout protection; only the cold/first-time path is
--    weaker, and it's still bounded by both the global uniqueness (correct
--    PINs are scarce) and this rate limit.
--
-- Idempotent — safe to re-run.
-- ============================================================================

-- ─── 1. set_camp_pos_pin — reject a PIN already used by another camp ──────
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

    IF EXISTS (
        SELECT 1 FROM camp_pos_credentials
        WHERE camp_id <> p_camp_id
          AND pin_hash IS NOT NULL
          AND pin_hash = crypt(p_pin, pin_hash)
    ) THEN
        RETURN jsonb_build_object('success', false, 'error', 'pin_taken');
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


-- ─── 2. verify_pos_pin_global — find out which camp this PIN belongs to ───
-- service_role ONLY. Two-phase: scan every camp's hash for a match (no lock
-- held during the scan — comparing hashes is read-only), then re-check and
-- update JUST the matched camp's row under FOR UPDATE, identical in shape
-- to verify_camp_pos_pin's existing lockout logic. No match anywhere = no
-- camp to blame, so nothing gets locked (see the migration header above for
-- why — that gap is covered by the caller applying check_pos_global_rate_limit
-- first, not by anything in this function).
CREATE OR REPLACE FUNCTION public.verify_pos_pin_global(p_pin text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
    v_scan      record;
    v_match_id  uuid;
    v_row       camp_pos_credentials%ROWTYPE;
    v_next_fail integer;
BEGIN
    IF p_pin IS NULL OR length(p_pin) > 16 THEN
        RETURN jsonb_build_object('success', false, 'reason', 'wrong_pin');
    END IF;

    FOR v_scan IN SELECT camp_id, pin_hash FROM camp_pos_credentials WHERE pin_hash IS NOT NULL LOOP
        IF v_scan.pin_hash = crypt(p_pin, v_scan.pin_hash) THEN
            v_match_id := v_scan.camp_id;
            EXIT;
        END IF;
    END LOOP;

    IF v_match_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'reason', 'wrong_pin');
    END IF;

    SELECT * INTO v_row FROM camp_pos_credentials WHERE camp_id = v_match_id FOR UPDATE;

    IF v_row.locked THEN
        RETURN jsonb_build_object('success', false, 'reason', 'locked');
    END IF;

    IF v_row.pin_hash = crypt(p_pin, v_row.pin_hash) THEN
        UPDATE camp_pos_credentials
           SET failed_attempts = 0, locked = false, locked_at = NULL, updated_at = now()
         WHERE camp_id = v_match_id;

        RETURN jsonb_build_object(
            'success', true,
            'campId', v_match_id,
            'shadowUserId', v_row.shadow_user_id,
            'shadowEmail', v_row.shadow_email,
            'shadowPassword', v_row.shadow_password
        );
    ELSE
        -- Vanishingly unlikely (the PIN changed between the scan and the
        -- lock) but handled the same way a per-camp wrong guess is.
        v_next_fail := v_row.failed_attempts + 1;
        UPDATE camp_pos_credentials
           SET failed_attempts = v_next_fail,
               locked          = (v_next_fail >= 5),
               locked_at       = CASE WHEN v_next_fail >= 5 THEN now() ELSE locked_at END,
               updated_at      = now()
         WHERE camp_id = v_match_id;
        RETURN jsonb_build_object('success', false, 'reason', 'wrong_pin');
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.verify_pos_pin_global(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_pos_pin_global(text) TO service_role;


-- ─── 3. Global rate limit for the no-camp-hint lookup path ────────────────
-- One row per caller IP. check_pos_global_rate_limit bumps the counter and
-- returns whether the caller is still under the cap — 20 attempts per
-- rolling 10-minute window. This is coarse (an IP, not a person) and
-- deliberately separate from the per-camp lockout in camp_pos_credentials:
-- its only job is to slow down a script trying PINs against the platform
-- with no camp context, not to replace real per-camp protection.
CREATE TABLE IF NOT EXISTS pos_global_login_attempts (
    ip           text PRIMARY KEY,
    attempts     integer NOT NULL DEFAULT 0,
    window_start timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pos_global_login_attempts ENABLE ROW LEVEL SECURITY;
-- No client-side policies — service_role (via the RPC below) only.

CREATE OR REPLACE FUNCTION public.check_pos_global_rate_limit(p_ip text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_ip  text := COALESCE(NULLIF(btrim(p_ip), ''), 'unknown');
    v_cur record;
BEGIN
    INSERT INTO pos_global_login_attempts (ip, attempts, window_start)
    VALUES (v_ip, 1, now())
    ON CONFLICT (ip) DO UPDATE
        SET attempts = CASE WHEN pos_global_login_attempts.window_start < now() - interval '10 minutes'
                             THEN 1
                             ELSE pos_global_login_attempts.attempts + 1 END,
            window_start = CASE WHEN pos_global_login_attempts.window_start < now() - interval '10 minutes'
                                 THEN now()
                                 ELSE pos_global_login_attempts.window_start END
    RETURNING attempts, window_start INTO v_cur;

    RETURN jsonb_build_object('allowed', v_cur.attempts <= 20);
END;
$$;

REVOKE ALL ON FUNCTION public.check_pos_global_rate_limit(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_pos_global_rate_limit(text) TO service_role;


-- ─── Sanity checks (run manually after applying) ───────────────────────────
--   SELECT proname, proacl FROM pg_proc
--   WHERE proname IN ('verify_pos_pin_global','check_pos_global_rate_limit');
--   -- expect both grant to service_role only
--
--   SELECT * FROM pg_policies WHERE tablename = 'pos_global_login_attempts';
--   -- expect ZERO rows
-- ============================================================================
