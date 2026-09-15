-- ============================================================================
-- Migration 155: camp entitlements — what the camp actually BOUGHT.
--
-- Phase 1 of ENTITLEMENTS_DESIGN.md. This adds the model and surfaces it to the
-- client; it does NOT yet enforce it in the database. Phase 3 is what closes
-- that door, and it must not run before the RPC read/write path exists.
--
-- WHY A THIRD LAYER. product_access and section_access are both per STAFF
-- MEMBER, and owners/admins are deliberately never gated by them (so an owner
-- can't lock themselves out). Neither property is what selling a partial
-- product needs: the limit belongs to the CAMP, and it has to hold for the
-- owner, who is precisely the person being sold to. So this is stored on camps,
-- not on camp_users, and campistry_capabilities.js applies it ABOVE the
-- owner/admin bypass — the only rule that sits above it.
--
-- SUBTRACTIVE ONLY. '{}' means unrestricted, so every existing camp is
-- unaffected by this migration. An entitlement can never grant access that the
-- staff-level layers don't already allow; it can only take away.
--
-- SHAPE (keys are exactly the registry keys in campistry_capabilities.js, so
-- there is one vocabulary rather than two):
--   {}                                  -- unrestricted (the default)
--   {"me": "*"}                         -- all of Campistry Me, nothing else
--   {"me": ["campers","structure"]}     -- the roster-only camp
--   {"me": [], "flow": "*"}             -- Flow outright, Me bought but empty
-- An app absent from a NON-EMPTY object was not bought.
--
-- Idempotent.
-- ============================================================================

ALTER TABLE camps
    ADD COLUMN IF NOT EXISTS entitlements jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN camps.entitlements IS
'What this camp bought. ''{}'' = unrestricted (default). Otherwise per app: "*" for the whole app, or an array of section keys from campistry_capabilities.js. An app absent from a non-empty object was not bought. Subtractive only — never grants. See ENTITLEMENTS_DESIGN.md.';

-- ─── Helpers, so nothing hand-parses the JSON ───────────────────────────────
CREATE OR REPLACE FUNCTION public.camp_entitled(p_camp_id uuid, p_app text, p_section text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_ent jsonb;
    v_app jsonb;
BEGIN
    SELECT entitlements INTO v_ent FROM camps WHERE id = p_camp_id;
    -- Unknown camp or unset entitlement: unrestricted, matching the client.
    IF v_ent IS NULL OR v_ent = '{}'::jsonb THEN RETURN true; END IF;
    IF NOT (v_ent ? p_app) THEN RETURN false; END IF;
    v_app := v_ent -> p_app;
    IF jsonb_typeof(v_app) = 'string' AND v_app #>> '{}' = '*' THEN RETURN true; END IF;
    IF jsonb_typeof(v_app) <> 'array' THEN RETURN false; END IF;
    RETURN v_app ? p_section;
END;
$$;
REVOKE ALL ON FUNCTION public.camp_entitled(uuid, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.camp_entitled(uuid, text, text) TO authenticated, service_role;

-- ─── Setting entitlements is ours, not the camp's ───────────────────────────
-- Deliberately service_role only: this is a commercial boundary, so a camp
-- owner must not be able to widen it from their own dashboard. Same reasoning
-- as _admin_store_camp_processor_credentials in migration 126.
CREATE OR REPLACE FUNCTION public._admin_set_camp_entitlements(p_camp_id uuid, p_entitlements jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    rec record;
    v_app jsonb;
BEGIN
    IF p_entitlements IS NULL OR jsonb_typeof(p_entitlements) <> 'object' THEN
        RETURN jsonb_build_object('success', false, 'error', 'entitlements must be a json object ({} = unrestricted)');
    END IF;
    -- Validate the shape up front; a malformed entry would otherwise read as
    -- "not bought" and quietly switch a paying camp off.
    FOR rec IN SELECT key, value FROM jsonb_each(p_entitlements) LOOP
        v_app := rec.value;
        IF NOT ( (jsonb_typeof(v_app) = 'string' AND v_app #>> '{}' = '*')
                 OR jsonb_typeof(v_app) = 'array' ) THEN
            RETURN jsonb_build_object('success', false,
                'error', format('entitlements.%s must be "*" or an array of section keys', rec.key));
        END IF;
    END LOOP;

    IF NOT EXISTS (SELECT 1 FROM camps WHERE id = p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'no camp with that id');
    END IF;

    UPDATE camps SET entitlements = p_entitlements WHERE id = p_camp_id;
    RETURN jsonb_build_object('success', true, 'entitlements', p_entitlements);
END;
$$;
REVOKE ALL ON FUNCTION public._admin_set_camp_entitlements(uuid, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._admin_set_camp_entitlements(uuid, jsonb) TO service_role;

-- ─── get_my_access carries the entitlement to the client ────────────────────
-- Same body as migration 154 (which fixed the unassigned-record and NULL-preset
-- bugs) plus one new field. Note it is returned even for owners and for the
-- fail-open not-a-member case: 'unrestricted' means "no per-STAFF restriction",
-- and must not be read as "no entitlement". campistry_capabilities.js applies
-- the entitlement before the owner bypass for exactly this reason.
CREATE OR REPLACE FUNCTION public.get_my_access(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller         uuid := auth.uid();
    v_row          record;
    v_grp_found    boolean := false;
    v_grp_products jsonb;
    v_grp_preset   text;
    v_grp_sections jsonb;
    v_ent          jsonb := '{}'::jsonb;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    SELECT COALESCE(entitlements, '{}'::jsonb) INTO v_ent FROM camps WHERE id = p_camp_id;
    v_ent := COALESCE(v_ent, '{}'::jsonb);

    -- Owner of the camp: never gated by the per-staff layers, but STILL capped
    -- by what the camp bought.
    IF EXISTS (SELECT 1 FROM camps WHERE id = p_camp_id AND owner = caller) THEN
        RETURN jsonb_build_object(
            'success', true, 'role', 'owner',
            'products', '[]'::jsonb, 'preset', NULL,
            'overrides', '{}'::jsonb, 'unrestricted', true,
            'entitlements', v_ent
        );
    END IF;

    SELECT role, product_access, access_preset, section_access, access_group_id
    INTO v_row
    FROM camp_users
    WHERE camp_id = p_camp_id AND user_id = caller
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', true, 'role', NULL,
            'products', '[]'::jsonb, 'preset', NULL,
            'overrides', '{}'::jsonb, 'unrestricted', true,
            'entitlements', v_ent
        );
    END IF;

    IF v_row.access_group_id IS NOT NULL THEN
        SELECT product_access, access_preset, section_access
          INTO v_grp_products, v_grp_preset, v_grp_sections
          FROM camp_access_groups WHERE id = v_row.access_group_id;
        v_grp_found := FOUND;
    END IF;

    IF v_grp_found THEN
        RETURN jsonb_build_object(
            'success', true,
            'role', v_row.role,
            'products', COALESCE(v_grp_products, '[]'::jsonb),
            'preset', v_grp_preset,
            'overrides', COALESCE(v_grp_sections, '{}'::jsonb),
            'unrestricted', (v_row.role IN ('owner', 'admin')),
            'entitlements', v_ent
        );
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'role', v_row.role,
        'products', COALESCE(v_row.product_access, '[]'::jsonb),
        'preset', v_row.access_preset,
        'overrides', COALESCE(v_row.section_access, '{}'::jsonb),
        'unrestricted', (v_row.role IN ('owner', 'admin')),
        'entitlements', v_ent
    );
EXCEPTION WHEN OTHERS THEN
    -- Fail open on an unexpected error, matching the documented policy in
    -- campistry_access_sections.js. Entitlements fail open too: a camp that
    -- paid must never be locked out by an error on our side.
    RETURN jsonb_build_object('success', false, 'error', SQLERRM,
                              'unrestricted', true, 'entitlements', '{}'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.get_my_access(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_access(uuid) TO authenticated;

-- ─── Usage ─────────────────────────────────────────────────────────────────
-- Sell a camp the roster and bunk structure only:
--   select _admin_set_camp_entitlements(
--     '<camp id>'::uuid,
--     '{"me": ["campers","structure","bunkbuilder"]}'::jsonb);
--
-- Give a camp everything again:
--   select _admin_set_camp_entitlements('<camp id>'::uuid, '{}'::jsonb);
--
-- Check one section:
--   select camp_entitled('<camp id>'::uuid, 'me', 'billing');
-- ============================================================================
