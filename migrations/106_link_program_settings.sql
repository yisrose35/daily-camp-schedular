-- ============================================================================
-- Migration 106: per-camp "which Link programs are actually offered"
--
-- Why: every parent-facing Link purchase/sign-up flow (Photos' facial-
-- recognition folders, Canteen's Add Funds, Camp Shop, Tips, Camper Mail,
-- Pickup & Arrival requests) is visible to every parent at every camp today,
-- whether or not that camp actually runs the program. A camp that doesn't
-- send out photos still shows parents a "buy a photo folder" button; a camp
-- with no canteen still shows "Add Funds." This closes that gap with one
-- camp-wide on/off switch per program, owner/admin controlled from the
-- Dashboard, that the parent app (campistry_link_parent.html) reads to hide
-- the corresponding nav/tiles entirely, and that money-moving RPCs/edge
-- functions check server-side before letting a purchase go through — never
-- just a client-side hide, per this app's established rule that a hidden
-- button is not a real gate.
--
-- Default is ON for every program on every camp (no row = everything
-- enabled) — this is purely additive and must not change behavior for any
-- camp that hasn't touched the new Dashboard toggles, including camps
-- already live with Photos/Canteen this summer.
--
-- Same convention as every other secret/config-bearing table in this app:
-- RLS enabled, ZERO client-facing policies, every access via a SECURITY
-- DEFINER RPC (or, for edge functions holding the service-role key, a
-- direct read — service role bypasses RLS by design).
--
-- Idempotent — safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS camp_link_program_settings (
    camp_id             uuid PRIMARY KEY REFERENCES camps(id),
    photos_enabled      boolean NOT NULL DEFAULT true,
    canteen_enabled     boolean NOT NULL DEFAULT true,
    shop_enabled        boolean NOT NULL DEFAULT true,
    tips_enabled        boolean NOT NULL DEFAULT true,
    camper_mail_enabled boolean NOT NULL DEFAULT true,
    pickup_enabled      boolean NOT NULL DEFAULT true,
    updated_at          timestamptz NOT NULL DEFAULT now(),
    updated_by          uuid
);

ALTER TABLE camp_link_program_settings ENABLE ROW LEVEL SECURITY;
-- No client-side policies — every access goes through the RPCs below (or a
-- service-role read, which bypasses RLS entirely).

COMMENT ON TABLE camp_link_program_settings IS
    'Per-camp on/off switch for parent-facing Link programs (Photos, Canteen, Shop, Tips, Camper Mail, Pickup). No row for a camp = every program enabled (backward-compatible default). RLS-locked; owner/admin write via set_link_program_settings, any authenticated caller reads via get_link_program_settings.';


-- ─── 1. _link_program_enabled ───────────────────────────────────────────────
-- Internal helper, called directly (no RPC round trip) from OTHER plpgsql
-- functions in the same transaction — submit_shop_order, submit_camper_mail,
-- etc. Not itself exposed to any role; PostgreSQL function-level privileges
-- are irrelevant here since it's only ever called from within another
-- SECURITY DEFINER function's body, never directly by a client.
CREATE OR REPLACE FUNCTION public._link_program_enabled(p_camp_id uuid, p_program text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_row camp_link_program_settings%ROWTYPE;
BEGIN
    SELECT * INTO v_row FROM camp_link_program_settings WHERE camp_id = p_camp_id;
    IF NOT FOUND THEN RETURN true; END IF;

    RETURN CASE p_program
        WHEN 'photos'      THEN v_row.photos_enabled
        WHEN 'canteen'     THEN v_row.canteen_enabled
        WHEN 'shop'        THEN v_row.shop_enabled
        WHEN 'tips'        THEN v_row.tips_enabled
        WHEN 'camperMail'  THEN v_row.camper_mail_enabled
        WHEN 'pickup'      THEN v_row.pickup_enabled
        ELSE true
    END;
END;
$$;


-- ─── 2. get_link_program_settings ───────────────────────────────────────────
-- Any authenticated caller (parent OR staff — both are real Supabase Auth
-- sessions in this app) — this is non-sensitive config, just which
-- features are visible, no PII, no secrets. Returns camelCase keys
-- matching the client's toggle names directly.
CREATE OR REPLACE FUNCTION public.get_link_program_settings(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_row camp_link_program_settings%ROWTYPE;
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    SELECT * INTO v_row FROM camp_link_program_settings WHERE camp_id = p_camp_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', true,
            'photos', true, 'canteen', true, 'shop', true,
            'tips', true, 'camperMail', true, 'pickup', true
        );
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'photos', v_row.photos_enabled,
        'canteen', v_row.canteen_enabled,
        'shop', v_row.shop_enabled,
        'tips', v_row.tips_enabled,
        'camperMail', v_row.camper_mail_enabled,
        'pickup', v_row.pickup_enabled
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_link_program_settings(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_link_program_settings(uuid) TO authenticated;


-- ─── 3. set_link_program_settings ───────────────────────────────────────────
-- Owner/admin only (same "owns or admins THIS camp" check used throughout
-- this app — set_member_access, set_camp_pos_pin, etc.). p_settings is a
-- partial jsonb object — any key omitted keeps its current (or default)
-- value, so the Dashboard can send just the one toggle that changed.
CREATE OR REPLACE FUNCTION public.set_link_program_settings(p_camp_id uuid, p_settings jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller     uuid := auth.uid();
    v_is_admin boolean;
    v_existing camp_link_program_settings%ROWTYPE;
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

    SELECT * INTO v_existing FROM camp_link_program_settings WHERE camp_id = p_camp_id;

    INSERT INTO camp_link_program_settings (
        camp_id, photos_enabled, canteen_enabled, shop_enabled,
        tips_enabled, camper_mail_enabled, pickup_enabled, updated_at, updated_by
    )
    VALUES (
        p_camp_id,
        COALESCE((p_settings->>'photos')::boolean, v_existing.photos_enabled, true),
        COALESCE((p_settings->>'canteen')::boolean, v_existing.canteen_enabled, true),
        COALESCE((p_settings->>'shop')::boolean, v_existing.shop_enabled, true),
        COALESCE((p_settings->>'tips')::boolean, v_existing.tips_enabled, true),
        COALESCE((p_settings->>'camperMail')::boolean, v_existing.camper_mail_enabled, true),
        COALESCE((p_settings->>'pickup')::boolean, v_existing.pickup_enabled, true),
        now(), caller
    )
    ON CONFLICT (camp_id) DO UPDATE
        SET photos_enabled      = EXCLUDED.photos_enabled,
            canteen_enabled     = EXCLUDED.canteen_enabled,
            shop_enabled        = EXCLUDED.shop_enabled,
            tips_enabled        = EXCLUDED.tips_enabled,
            camper_mail_enabled = EXCLUDED.camper_mail_enabled,
            pickup_enabled      = EXCLUDED.pickup_enabled,
            updated_at          = now(),
            updated_by          = caller;

    RETURN jsonb_build_object('success', true);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.set_link_program_settings(uuid, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.set_link_program_settings(uuid, jsonb) TO authenticated;


-- ─── Sanity checks (run manually after applying) ───────────────────────────
--   SELECT proname, proacl FROM pg_proc
--   WHERE proname IN ('get_link_program_settings','set_link_program_settings');
--   -- expect: both grant to authenticated only (no anon, no public).
--
--   SELECT * FROM pg_policies WHERE tablename = 'camp_link_program_settings';
--   -- expect ZERO rows — no client-facing policy exists on this table.
--
--   SELECT public._link_program_enabled('00000000-0000-0000-0000-000000000000'::uuid, 'photos');
--   -- expect true (no row for this camp = default-on)
-- ============================================================================
