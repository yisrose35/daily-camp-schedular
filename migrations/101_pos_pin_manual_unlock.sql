-- ============================================================================
-- Migration 101: register lockout now requires an owner/admin to clear it
--
-- Migration 100 auto-unlocked the register 15 minutes after 5 wrong PIN
-- attempts. The owner asked for something stronger: after 5 wrong guesses,
-- the register stays locked until an owner/admin actively unlocks it from
-- the Manager Dashboard — no waiting it out.
--
-- Adds a real `locked` boolean (instead of a `locked_until` timestamp that
-- expires on its own) and a new owner/admin-only unlock_camp_pos_pin RPC.
-- locked_until from migration 100 is left in place, unused — harmless, and
-- avoids a destructive column drop for a table nothing else depends on yet.
--
-- Idempotent — safe to re-run.
-- ============================================================================

ALTER TABLE camp_pos_credentials
    ADD COLUMN IF NOT EXISTS locked    boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS locked_at timestamptz;

COMMENT ON COLUMN camp_pos_credentials.locked IS
    'true after 5 wrong PIN attempts. Stays true until an owner/admin calls unlock_camp_pos_pin — no auto-expiry.';


-- ─── verify_camp_pos_pin — now checks/sets the `locked` boolean ───────────
CREATE OR REPLACE FUNCTION public.verify_camp_pos_pin(p_camp_id uuid, p_pin text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
    v_row       camp_pos_credentials%ROWTYPE;
    v_next_fail integer;
BEGIN
    SELECT * INTO v_row FROM camp_pos_credentials WHERE camp_id = p_camp_id FOR UPDATE;

    IF NOT FOUND OR v_row.pin_hash IS NULL THEN
        RETURN jsonb_build_object('success', false, 'reason', 'not_set_up');
    END IF;

    IF v_row.locked THEN
        RETURN jsonb_build_object('success', false, 'reason', 'locked');
    END IF;

    IF p_pin IS NOT NULL AND v_row.pin_hash = crypt(p_pin, v_row.pin_hash) THEN
        UPDATE camp_pos_credentials
           SET failed_attempts = 0, locked = false, locked_at = NULL, updated_at = now()
         WHERE camp_id = p_camp_id;

        RETURN jsonb_build_object(
            'success', true,
            'shadowUserId', v_row.shadow_user_id,
            'shadowEmail', v_row.shadow_email,
            'shadowPassword', v_row.shadow_password
        );
    ELSE
        v_next_fail := v_row.failed_attempts + 1;
        UPDATE camp_pos_credentials
           SET failed_attempts = v_next_fail,
               locked          = (v_next_fail >= 5),
               locked_at       = CASE WHEN v_next_fail >= 5 THEN now() ELSE locked_at END,
               updated_at      = now()
         WHERE camp_id = p_camp_id;

        RETURN jsonb_build_object(
            'success', false,
            'reason', CASE WHEN v_next_fail >= 5 THEN 'locked' ELSE 'wrong_pin' END,
            'attemptsRemaining', GREATEST(0, 5 - v_next_fail)
        );
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.verify_camp_pos_pin(uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_camp_pos_pin(uuid, text) TO service_role;


-- ─── get_camp_pos_login_status — report the boolean directly ─────────────
CREATE OR REPLACE FUNCTION public.get_camp_pos_login_status(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
    caller     uuid := auth.uid();
    v_is_admin boolean;
    v_row      record;
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

    SELECT pin_set_at, locked, locked_at INTO v_row
    FROM camp_pos_credentials WHERE camp_id = p_camp_id;

    RETURN jsonb_build_object(
        'success', true,
        'pinSet', v_row.pin_set_at IS NOT NULL,
        'pinSetAt', v_row.pin_set_at,
        'locked', COALESCE(v_row.locked, false),
        'lockedAt', v_row.locked_at
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_camp_pos_login_status(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_camp_pos_login_status(uuid) TO authenticated;


-- ─── unlock_camp_pos_pin — owner/admin only ───────────────────────────────
CREATE OR REPLACE FUNCTION public.unlock_camp_pos_pin(p_camp_id uuid)
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

    UPDATE camp_pos_credentials
       SET failed_attempts = 0, locked = false, locked_at = NULL, updated_at = now()
     WHERE camp_id = p_camp_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_set_up');
    END IF;

    RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.unlock_camp_pos_pin(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.unlock_camp_pos_pin(uuid) TO authenticated;


-- ─── Sanity checks (run manually after applying) ───────────────────────────
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'camp_pos_credentials' AND column_name IN ('locked','locked_at');
--   -- expect 2 rows
--
--   SELECT proname, proacl FROM pg_proc WHERE proname = 'unlock_camp_pos_pin';
--   -- expect grant to authenticated only
-- ============================================================================
