-- ============================================================================
-- Migration 097: Access Groups — named, reusable staff permission templates
-- + the 'manager' role
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY
--
-- Today (migration 048) a staff member's app/section access is a one-shot
-- combination of access_preset + section_access stored directly on their own
-- camp_users row. That works, but two real gaps came up:
--
--   1. There's no way to save a combination and reuse it across many staff —
--      an owner has to redo the same picks for every "Office Admin" they
--      hire. CampMinder solves the same problem with owner-defined, named,
--      reusable "User Groups" — this migration brings the same shape here.
--   2. Owner/Admin are (deliberately, still) always unrestricted. The
--      concrete need that drove this — "an admin who can see campers/reports
--      but not billing/hiring/registration" — needs a role that was never in
--      that exempted bucket to begin with. Rather than touch admin's
--      exemption (which research this session confirmed is load-bearing in
--      dozens of RLS policies and several edge functions, not just a UI
--      convention), a new role — 'manager' — is added alongside scheduler,
--      viewer, counselor. It goes through the EXACT same
--      product_access/section_access resolution those already use, with
--      zero special-casing.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT'S NEW
--
--   camp_access_groups   — one row per named, reusable permission template:
--                           product_access (which apps), access_preset +
--                           section_access (which sections, none/view/edit).
--                           Same shape as what already lived on camp_users,
--                           just camp-owned and named instead of per-person.
--   camp_users.access_group_id
--                         — nullable FK. When set, get_my_access() resolves
--                           products/preset/overrides from the GROUP instead
--                           of the member's own access_preset/section_access
--                           columns (which are left in place, untouched, as
--                           the fallback for anyone not in a group — the
--                           existing backward-compatibility rule from
--                           migration 048 is unaffected).
--
-- Editing a group updates everyone assigned to it immediately (next
-- get_my_access() call) — that's the whole point, matching CampMinder's
-- "edit the group, everyone in it updates" behavior.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE 'manager' ROLE
--
-- Added to camp_users.role's accepted values only. Deliberately NOT added to
-- get_my_access()'s `unrestricted` check (stays role IN ('owner','admin'),
-- completely unchanged) and NOT added to campistry_capabilities.js's
-- owner/admin exemption or viewer/counselor view-only floor — a manager
-- resolves through normal preset/override logic, identical to how scheduler
-- already works today. This migration only needs to grant it the same
-- baseline RLS scheduler already has on non-Flow-specific tables (see the
-- companion migration 098 for the RLS grants) — campistry_capabilities.js
-- and campistry_access_sections.js need no changes at all for this role to
-- work correctly.
-- ============================================================================

-- ─── 1. camp_access_groups ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.camp_access_groups (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    camp_id         uuid NOT NULL REFERENCES camps(id) ON DELETE CASCADE,
    name            text NOT NULL,
    product_access  jsonb NOT NULL DEFAULT '[]'::jsonb,
    access_preset   text,
    section_access  jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_camp_access_groups_camp ON camp_access_groups (camp_id);

COMMENT ON TABLE public.camp_access_groups IS
    'Owner-defined, named, reusable permission templates (product_access + section_access), assignable to any number of camp_users rows via access_group_id. Same values campistry_capabilities.js already resolves per-member — this just makes the combination camp-owned and shared instead of one-shot.';

ALTER TABLE public.camp_access_groups ENABLE ROW LEVEL SECURITY;
-- No client-side policies at all — every access goes through the
-- SECURITY DEFINER RPCs below, same convention as migration 048's
-- get_my_access()/set_member_access().

ALTER TABLE public.camp_users
    ADD COLUMN IF NOT EXISTS access_group_id uuid REFERENCES camp_access_groups(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.camp_users.access_group_id IS
    'Optional link to a camp_access_groups row. When set, get_my_access() resolves products/preset/overrides from the group instead of this row''s own access_preset/section_access. NULL = today''s per-member behavior, unchanged.';


-- ─── 2. Caller-authorization helper ─────────────────────────────────────────
-- Same "owner or admin of THIS camp" check migration 048's set_member_access
-- already uses — factored out here since three new RPCs need it too.
CREATE OR REPLACE FUNCTION public._is_camp_admin(p_camp_id uuid, p_caller uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT EXISTS (SELECT 1 FROM camps WHERE id = p_camp_id AND owner = p_caller)
        OR EXISTS (SELECT 1 FROM camp_users
                   WHERE camp_id = p_camp_id AND user_id = p_caller AND role IN ('owner', 'admin'));
$$;
REVOKE ALL ON FUNCTION public._is_camp_admin(uuid, uuid) FROM public, anon, authenticated;
-- Callable only from other SECURITY DEFINER functions in this file, not directly.


-- ─── 3. list_access_groups ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.list_access_groups(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    result jsonb;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF NOT public._is_camp_admin(p_camp_id, caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', g.id, 'name', g.name, 'product_access', g.product_access,
        'access_preset', g.access_preset, 'section_access', g.section_access,
        'member_count', (SELECT count(*) FROM camp_users u WHERE u.access_group_id = g.id)
    ) ORDER BY g.name), '[]'::jsonb)
    INTO result
    FROM camp_access_groups g
    WHERE g.camp_id = p_camp_id;

    RETURN jsonb_build_object('success', true, 'groups', result);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
REVOKE ALL ON FUNCTION public.list_access_groups(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.list_access_groups(uuid) TO authenticated;


-- ─── 4. create_access_group ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_access_group(
    p_camp_id        uuid,
    p_name           text,
    p_product_access jsonb,
    p_preset         text,
    p_section_access jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller  uuid := auth.uid();
    v_key   text;
    v_val   jsonb;
    v_id    uuid;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF NOT public._is_camp_admin(p_camp_id, caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;
    IF p_name IS NULL OR btrim(p_name) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'name_required');
    END IF;
    IF p_product_access IS NOT NULL AND jsonb_typeof(p_product_access) <> 'array' THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_product_access');
    END IF;
    IF p_section_access IS NOT NULL AND jsonb_typeof(p_section_access) <> 'object' THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_section_access');
    END IF;
    IF p_section_access IS NOT NULL THEN
        FOR v_key, v_val IN SELECT * FROM jsonb_each(p_section_access) LOOP
            IF jsonb_typeof(v_val) <> 'string' OR (v_val #>> '{}') NOT IN ('none', 'view', 'edit') THEN
                RETURN jsonb_build_object('success', false, 'error', 'invalid_level', 'capability', v_key);
            END IF;
        END LOOP;
    END IF;

    INSERT INTO camp_access_groups (camp_id, name, product_access, access_preset, section_access)
    VALUES (p_camp_id, btrim(p_name), COALESCE(p_product_access, '[]'::jsonb),
            NULLIF(btrim(COALESCE(p_preset, '')), ''), COALESCE(p_section_access, '{}'::jsonb))
    RETURNING id INTO v_id;

    RETURN jsonb_build_object('success', true, 'id', v_id);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
REVOKE ALL ON FUNCTION public.create_access_group(uuid, text, jsonb, text, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.create_access_group(uuid, text, jsonb, text, jsonb) TO authenticated;


-- ─── 5. update_access_group ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_access_group(
    p_group_id       uuid,
    p_name           text,
    p_product_access jsonb,
    p_preset         text,
    p_section_access jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller  uuid := auth.uid();
    v_camp  uuid;
    v_key   text;
    v_val   jsonb;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    SELECT camp_id INTO v_camp FROM camp_access_groups WHERE id = p_group_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'group_not_found');
    END IF;
    IF NOT public._is_camp_admin(v_camp, caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;
    IF p_name IS NULL OR btrim(p_name) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'name_required');
    END IF;
    IF p_product_access IS NOT NULL AND jsonb_typeof(p_product_access) <> 'array' THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_product_access');
    END IF;
    IF p_section_access IS NOT NULL AND jsonb_typeof(p_section_access) <> 'object' THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_section_access');
    END IF;
    IF p_section_access IS NOT NULL THEN
        FOR v_key, v_val IN SELECT * FROM jsonb_each(p_section_access) LOOP
            IF jsonb_typeof(v_val) <> 'string' OR (v_val #>> '{}') NOT IN ('none', 'view', 'edit') THEN
                RETURN jsonb_build_object('success', false, 'error', 'invalid_level', 'capability', v_key);
            END IF;
        END LOOP;
    END IF;

    UPDATE camp_access_groups
    SET name = btrim(p_name),
        product_access = COALESCE(p_product_access, '[]'::jsonb),
        access_preset = NULLIF(btrim(COALESCE(p_preset, '')), ''),
        section_access = COALESCE(p_section_access, '{}'::jsonb),
        updated_at = now()
    WHERE id = p_group_id;

    RETURN jsonb_build_object('success', true);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
REVOKE ALL ON FUNCTION public.update_access_group(uuid, text, jsonb, text, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.update_access_group(uuid, text, jsonb, text, jsonb) TO authenticated;


-- ─── 6. delete_access_group ──────────────────────────────────────────────────
-- Before removing the group, freeze its current values onto every member
-- still assigned to it (their own access_preset/section_access/product_access
-- columns), so deleting a group never silently changes anyone's access —
-- least-surprise: they keep exactly what they had a moment ago, now stored
-- per-person instead of via the (now-gone) group, editable individually from
-- then on.
CREATE OR REPLACE FUNCTION public.delete_access_group(p_group_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    v_camp uuid;
    v_grp  record;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    SELECT camp_id, product_access, access_preset, section_access
    INTO v_grp
    FROM camp_access_groups WHERE id = p_group_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'group_not_found');
    END IF;
    v_camp := v_grp.camp_id;
    IF NOT public._is_camp_admin(v_camp, caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    UPDATE camp_users
    SET product_access = v_grp.product_access,
        access_preset  = v_grp.access_preset,
        section_access = v_grp.section_access,
        access_group_id = NULL
    WHERE access_group_id = p_group_id;

    DELETE FROM camp_access_groups WHERE id = p_group_id;

    RETURN jsonb_build_object('success', true);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
REVOKE ALL ON FUNCTION public.delete_access_group(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.delete_access_group(uuid) TO authenticated;


-- ─── 7. assign_member_access_group ───────────────────────────────────────────
-- Owner/admin only, same authorization shape as set_member_access. Setting
-- p_group_id to NULL unassigns — the member falls back to their own
-- access_preset/section_access/product_access columns (untouched, whatever
-- they were before joining the group).
CREATE OR REPLACE FUNCTION public.assign_member_access_group(
    p_member_id uuid,
    p_group_id  uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller      uuid := auth.uid();
    v_camp      uuid;
    v_role      text;
    v_grp_camp  uuid;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    SELECT camp_id, role INTO v_camp, v_role FROM camp_users WHERE id = p_member_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'member_not_found');
    END IF;
    IF NOT public._is_camp_admin(v_camp, caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;
    -- Only refuse when actually ASSIGNING a group (p_group_id IS NOT NULL) —
    -- clearing to NULL must stay a no-op for an owner/admin row (harmless:
    -- get_my_access()'s unrestricted flag never depends on access_group_id
    -- for them either way), otherwise every edit-member save on an admin's
    -- row would fail here even when the group field was never touched.
    IF p_group_id IS NOT NULL AND v_role IN ('owner', 'admin') THEN
        RETURN jsonb_build_object('success', false, 'error', 'cannot_restrict_admin');
    END IF;

    IF p_group_id IS NOT NULL THEN
        SELECT camp_id INTO v_grp_camp FROM camp_access_groups WHERE id = p_group_id;
        IF NOT FOUND OR v_grp_camp <> v_camp THEN
            RETURN jsonb_build_object('success', false, 'error', 'group_not_found');
        END IF;
    END IF;

    UPDATE camp_users SET access_group_id = p_group_id WHERE id = p_member_id;

    RETURN jsonb_build_object('success', true);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
REVOKE ALL ON FUNCTION public.assign_member_access_group(uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.assign_member_access_group(uuid, uuid) TO authenticated;


-- ─── 8. get_my_access — resolve through the group when assigned ────────────
-- Same signature/contract as migration 048's version — only the resolution
-- source changes when access_group_id is set. 'unrestricted' stays exactly
-- role IN ('owner','admin'); manager (or any non-exempt role) with a group
-- assigned resolves products/preset/overrides from the GROUP row instead of
-- their own access_preset/section_access columns.
CREATE OR REPLACE FUNCTION public.get_my_access(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    v_row  record;
    v_grp  record;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    -- Owner of the camp: always full, never gated.
    IF EXISTS (SELECT 1 FROM camps WHERE id = p_camp_id AND owner = caller) THEN
        RETURN jsonb_build_object(
            'success', true, 'role', 'owner',
            'products', '[]'::jsonb, 'preset', NULL,
            'overrides', '{}'::jsonb, 'unrestricted', true
        );
    END IF;

    SELECT role, product_access, access_preset, section_access, access_group_id
    INTO v_row
    FROM camp_users
    WHERE camp_id = p_camp_id AND user_id = caller
    LIMIT 1;

    IF NOT FOUND THEN
        -- Not a resolvable member here. Fail OPEN, matching
        -- product_access_guard.js: the page's own auth handles non-members, and
        -- RLS is the real boundary. Failing closed would lock out legitimate
        -- users during the window where membership hasn't propagated.
        RETURN jsonb_build_object(
            'success', true, 'role', NULL,
            'products', '[]'::jsonb, 'preset', NULL,
            'overrides', '{}'::jsonb, 'unrestricted', true
        );
    END IF;

    IF v_row.access_group_id IS NOT NULL THEN
        SELECT product_access, access_preset, section_access
        INTO v_grp
        FROM camp_access_groups WHERE id = v_row.access_group_id;
    END IF;

    IF v_grp IS NOT NULL THEN
        RETURN jsonb_build_object(
            'success', true,
            'role', v_row.role,
            'products', COALESCE(v_grp.product_access, '[]'::jsonb),
            'preset', v_grp.access_preset,
            'overrides', COALESCE(v_grp.section_access, '{}'::jsonb),
            'unrestricted', (v_row.role IN ('owner', 'admin'))
        );
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'role', v_row.role,
        'products', COALESCE(v_row.product_access, '[]'::jsonb),
        'preset', v_row.access_preset,
        'overrides', COALESCE(v_row.section_access, '{}'::jsonb),
        'unrestricted', (v_row.role IN ('owner', 'admin'))
    );
EXCEPTION WHEN OTHERS THEN
    -- Fail open on an unexpected error, for the same reason as above.
    RETURN jsonb_build_object('success', false, 'error', SQLERRM, 'unrestricted', true);
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_access(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_access(uuid) TO authenticated;


-- ─── 9. Sanity checks ────────────────────────────────────────────────────────
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'camp_access_groups';
--
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'camp_users' AND column_name = 'access_group_id';
--
--   SELECT proname FROM pg_proc WHERE proname IN
--     ('list_access_groups','create_access_group','update_access_group',
--      'delete_access_group','assign_member_access_group','get_my_access');
--
--   -- Confirm a manager with a group assigned resolves through it:
--   -- 1. create_access_group(<camp>, 'Office Admin', '["me"]',
--   --      NULL, '{"me.campers":"view","me.reports":"view",
--   --      "me.printsheets":"edit","me.billing":"none","me.enrollment":"none"}')
--   -- 2. assign_member_access_group(<member id>, <group id from step 1>)
--   -- 3. As that member: get_my_access(<camp>) should return products=["me"]
--   --    and overrides matching the group, unrestricted=false.
-- ============================================================================
