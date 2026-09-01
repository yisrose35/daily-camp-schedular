-- ============================================================================
-- Migration 100: shared PIN login for the Snacks POS (snacks.campistry.org)
--
-- Why: snacks.campistry.org was reachable by anyone with the URL, and the
-- only way in was the owner's OWN Campistry login — which means handing a
-- canteen runner the office's real credentials just to run the register.
-- The owner asked for a genuinely separate login, scoped to POS only, that
-- doesn't expose the rest of the camp's account.
--
-- Design: each camp sets ONE shared numeric PIN for its register (not a
-- per-runner login — the owner explicitly chose "a simple shared PIN code
-- for the register" over a full staff-invite email+password flow). The PIN
-- itself proves nothing on its own to Postgres/RLS — the POS still needs a
-- real Supabase Auth session to read/write camp_state_kv under RLS like
-- every other client in this app. So a PIN login lazily provisions one
-- hidden "shadow" Auth user per camp (created via the Admin API in the
-- pos-pin-login edge function, since raw SQL can't insert into auth.users),
-- with a camp_users row at role='counselor' — the same role migration 099
-- already scoped to read everything + write ONLY campistrySnacks. The
-- runner never sees or touches that shadow account's credentials; they only
-- ever type the camp's PIN, which the edge function verifies server-side.
--
-- Everything here is locked down the same way as every other secret-bearing
-- table in this app (sms_opt_outs, camp_telnyx_provisioning, etc.): RLS
-- enabled, ZERO client-facing policies, every access funneled through a
-- SECURITY DEFINER RPC (owner/admin only) or a service-role-only RPC that
-- only the edge function can call.
--
-- Idempotent — safe to re-run.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─── 1. camp_pos_credentials ────────────────────────────────────────────────
-- One row per camp. pin_hash is a bcrypt hash (pgcrypto crypt/gen_salt), never
-- the raw PIN. shadow_* columns are populated lazily on first successful PIN
-- entry (or first PIN set, whichever happens first to need them) by the
-- pos-pin-login edge function using the service-role key — never by a client.
-- failed_attempts/locked_until implement a simple per-camp lockout so a PIN
-- (much lower entropy than a real password) can't be brute-forced from the
-- public internet.
CREATE TABLE IF NOT EXISTS camp_pos_credentials (
    camp_id          uuid PRIMARY KEY REFERENCES camps(id),
    pin_hash         text,
    pin_set_at       timestamptz,
    pin_set_by       uuid,
    shadow_user_id   uuid,
    shadow_email     text,
    shadow_password  text,
    failed_attempts  integer NOT NULL DEFAULT 0,
    locked_until     timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE camp_pos_credentials ENABLE ROW LEVEL SECURITY;
-- No client-side policies at all — every access goes through the RPCs below.

COMMENT ON TABLE camp_pos_credentials IS
    'Shared PIN login for the standalone Snacks POS. pin_hash is bcrypt-hashed. shadow_* holds the lazily-provisioned hidden Auth account the POS actually signs in as after a correct PIN. RLS-locked; access only via RPC.';


-- ─── 2. set_camp_pos_pin ────────────────────────────────────────────────────
-- Owner/admin only (same "owns or admins THIS camp" check as set_member_access,
-- migration 048). Sets/replaces the camp's PIN. Requires 4-8 digits — long
-- enough to matter, short enough for a canteen runner to actually remember
-- and type quickly on a register.
CREATE OR REPLACE FUNCTION public.set_camp_pos_pin(p_camp_id uuid, p_pin text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
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

    INSERT INTO camp_pos_credentials (camp_id, pin_hash, pin_set_at, pin_set_by, failed_attempts, locked_until)
    VALUES (p_camp_id, crypt(p_pin, gen_salt('bf')), now(), caller, 0, NULL)
    ON CONFLICT (camp_id) DO UPDATE
        SET pin_hash        = EXCLUDED.pin_hash,
            pin_set_at      = now(),
            pin_set_by      = caller,
            failed_attempts = 0,
            locked_until    = NULL,
            updated_at      = now();

    RETURN jsonb_build_object('success', true);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.set_camp_pos_pin(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.set_camp_pos_pin(uuid, text) TO authenticated;


-- ─── 3. get_camp_pos_login_status ───────────────────────────────────────────
-- Owner/admin only. Lets the Manager Dashboard show whether a PIN is set
-- without ever exposing the hash (or anything shadow-account-related).
CREATE OR REPLACE FUNCTION public.get_camp_pos_login_status(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
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

    SELECT pin_set_at, locked_until INTO v_row
    FROM camp_pos_credentials WHERE camp_id = p_camp_id;

    RETURN jsonb_build_object(
        'success', true,
        'pinSet', v_row.pin_set_at IS NOT NULL,
        'pinSetAt', v_row.pin_set_at,
        'locked', v_row.locked_until IS NOT NULL AND v_row.locked_until > now()
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_camp_pos_login_status(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_camp_pos_login_status(uuid) TO authenticated;


-- ─── 4. verify_camp_pos_pin ─────────────────────────────────────────────────
-- service_role ONLY — called exclusively by the pos-pin-login edge function
-- with the service-role key, never reachable from a browser. Locks the row
-- for the duration of the check so two racing brute-force attempts can't
-- both slip past the lockout counter. Returns the shadow account's stored
-- credentials on success so the edge function can sign in as it without a
-- second round trip; the caller here is trusted precisely because only the
-- edge function's service-role key can ever invoke this.
CREATE OR REPLACE FUNCTION public.verify_camp_pos_pin(p_camp_id uuid, p_pin text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_row       camp_pos_credentials%ROWTYPE;
    v_next_fail integer;
BEGIN
    SELECT * INTO v_row FROM camp_pos_credentials WHERE camp_id = p_camp_id FOR UPDATE;

    IF NOT FOUND OR v_row.pin_hash IS NULL THEN
        RETURN jsonb_build_object('success', false, 'reason', 'not_set_up');
    END IF;

    IF v_row.locked_until IS NOT NULL AND v_row.locked_until > now() THEN
        RETURN jsonb_build_object('success', false, 'reason', 'locked',
            'retryAfterSeconds', GREATEST(0, EXTRACT(EPOCH FROM (v_row.locked_until - now()))::int));
    END IF;

    IF p_pin IS NOT NULL AND v_row.pin_hash = crypt(p_pin, v_row.pin_hash) THEN
        UPDATE camp_pos_credentials
           SET failed_attempts = 0, locked_until = NULL, updated_at = now()
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
               locked_until = CASE WHEN v_next_fail >= 5
                                    THEN now() + interval '15 minutes'
                                    ELSE locked_until END,
               updated_at = now()
         WHERE camp_id = p_camp_id;

        RETURN jsonb_build_object('success', false, 'reason', 'wrong_pin');
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.verify_camp_pos_pin(uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_camp_pos_pin(uuid, text) TO service_role;


-- ─── 5. set_camp_pos_shadow_account ─────────────────────────────────────────
-- service_role ONLY. The edge function calls this the first time it has to
-- provision the hidden shadow Auth account (it can't be created by SQL —
-- that needs the Admin API), to persist that account's id and credentials
-- for every login after the first.
--
-- Race-safe: two PIN entries arriving at nearly the same moment could both
-- observe no shadow account yet and both create one via the Admin API. The
-- WHERE shadow_user_id IS NULL clause means only the first UPDATE to land
-- actually wins; the loser gets 'applied':false plus the WINNER's stored
-- credentials back, so the edge function can delete its own now-redundant
-- Auth user + camp_users row and sign in as the winning shadow account
-- instead — no duplicate shadow accounts ever persist.
CREATE OR REPLACE FUNCTION public.set_camp_pos_shadow_account(
    p_camp_id uuid, p_shadow_user_id uuid, p_shadow_email text, p_shadow_password text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_row camp_pos_credentials%ROWTYPE;
BEGIN
    UPDATE camp_pos_credentials
       SET shadow_user_id  = p_shadow_user_id,
           shadow_email    = p_shadow_email,
           shadow_password = p_shadow_password,
           updated_at      = now()
     WHERE camp_id = p_camp_id AND shadow_user_id IS NULL;

    IF FOUND THEN
        RETURN jsonb_build_object('success', true, 'applied', true);
    END IF;

    SELECT * INTO v_row FROM camp_pos_credentials WHERE camp_id = p_camp_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'credentials_row_missing');
    END IF;

    RETURN jsonb_build_object(
        'success', true, 'applied', false,
        'shadowUserId', v_row.shadow_user_id,
        'shadowEmail', v_row.shadow_email,
        'shadowPassword', v_row.shadow_password
    );
END;
$$;

REVOKE ALL ON FUNCTION public.set_camp_pos_shadow_account(uuid, uuid, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_camp_pos_shadow_account(uuid, uuid, text, text) TO service_role;


-- ─── Sanity checks (run manually after applying) ───────────────────────────
--   SELECT proname, proacl FROM pg_proc
--   WHERE proname IN ('set_camp_pos_pin','get_camp_pos_login_status',
--                      'verify_camp_pos_pin','set_camp_pos_shadow_account');
--   -- expect: set_camp_pos_pin + get_camp_pos_login_status grant to
--   -- authenticated; verify_camp_pos_pin + set_camp_pos_shadow_account grant
--   -- to service_role only (no authenticated/anon/public in the ACL).
--
--   SELECT * FROM pg_policies WHERE tablename = 'camp_pos_credentials';
--   -- expect ZERO rows — no client-facing policy exists on this table.
-- ============================================================================
