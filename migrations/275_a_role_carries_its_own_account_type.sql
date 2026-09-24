-- ============================================================================
-- Migration 275: a Role carries its own account type (admin/manager/
-- scheduler/viewer) — invites pick a Role, not a raw account type.
--
-- WHY. Inviting someone used to mean picking BOTH an account type (Admin,
-- Manager, Scheduler, Viewer — camp_users.role) AND, optionally, a named
-- Role/group on top of it (migration 097) for fine-tuned section access. Two
-- decisions for one person's access is exactly the kind of thing that drifts
-- out of sync — e.g. nothing stopped "Scheduler" + a Role built for a
-- Manager. The fix: fold the account type INTO the Role itself. An owner now
-- creates a Role once (name, account type, sections/scope), and every invite
-- after that is just "pick a Role" — one decision, not two.
--
-- Admin is the one account type with nothing to fine-tune (get_my_access()'s
-- 'unrestricted' check is role IN ('owner','admin'), checked BEFORE any
-- preset/section resolution — full access is structural, not a grant this
-- system can express). An "Admin" Role still fits the same shape: name +
-- base_role='admin', with an empty section_access/preset that resolve()
-- never even looks at for that member. Nothing about resolve() or the
-- owner/admin bypass changes here — this migration only teaches
-- camp_access_groups its own account type and keeps camp_users.role in sync
-- with whichever Role a member is assigned.
--
-- WHAT CHANGES.
--   camp_access_groups.base_role — which account type this Role grants.
--     Existing rows default to 'manager' (migration 097's own reasoning for
--     adding that tier: to host a group's own permission set — every
--     pre-existing Role was already being used that way).
--   create_access_group / update_access_group — take p_base_role, validated
--     against the same four values (never 'owner' — singular per camp,
--     assigned outside this system — and never 'counselor' — Lite-only,
--     excluded from Team & Access entirely, see migration 274's neighbor
--     work in access_control.js).
--   list_access_groups — returns base_role so the UI can show it and the
--     invite dropdown can read it.
--   assign_member_access_group — now ALSO sets camp_users.role to the
--     group's base_role in the same statement that sets access_group_id, so
--     the two can never disagree (the previous version updated
--     access_group_id alone and trusted the caller to have already set role
--     correctly, which is exactly the two-decisions-drift this migration
--     exists to remove). Clearing to NULL (p_group_id IS NULL) leaves role
--     untouched, same as before — unassigning a Role doesn't change what the
--     person already is, it just stops tracking the Role's future edits.
-- ============================================================================

-- ─── 1. camp_access_groups.base_role ────────────────────────────────────────
ALTER TABLE public.camp_access_groups
    ADD COLUMN IF NOT EXISTS base_role text NOT NULL DEFAULT 'manager';

ALTER TABLE public.camp_access_groups
    DROP CONSTRAINT IF EXISTS camp_access_groups_base_role_check;
ALTER TABLE public.camp_access_groups
    ADD CONSTRAINT camp_access_groups_base_role_check
    CHECK (base_role IN ('admin', 'manager', 'scheduler', 'viewer'));

COMMENT ON COLUMN public.camp_access_groups.base_role IS
    'The account type this Role grants (admin/manager/scheduler/viewer) — assign_member_access_group() keeps camp_users.role in sync with this whenever the Role is assigned. Never owner (singular per camp) or counselor (Campistry Lite only, excluded from Team & Access).';

-- ─── 2. create_access_group — now takes p_base_role ─────────────────────────
-- Adding a parameter changes the function's signature, so Postgres treats
-- CREATE OR REPLACE as a new overload rather than replacing the old one in
-- place — drop the 097 signature explicitly first, or both versions exist
-- side by side and PostgREST can't tell which one a 5-argument call means.
DROP FUNCTION IF EXISTS public.create_access_group(uuid, text, jsonb, text, jsonb);
CREATE OR REPLACE FUNCTION public.create_access_group(
    p_camp_id        uuid,
    p_name           text,
    p_product_access jsonb,
    p_preset         text,
    p_section_access jsonb,
    p_base_role      text DEFAULT 'manager'
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
    IF p_base_role IS NULL OR p_base_role NOT IN ('admin', 'manager', 'scheduler', 'viewer') THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_base_role');
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

    INSERT INTO camp_access_groups (camp_id, name, product_access, access_preset, section_access, base_role)
    VALUES (p_camp_id, btrim(p_name), COALESCE(p_product_access, '[]'::jsonb),
            NULLIF(btrim(COALESCE(p_preset, '')), ''), COALESCE(p_section_access, '{}'::jsonb), p_base_role)
    RETURNING id INTO v_id;

    RETURN jsonb_build_object('success', true, 'id', v_id);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
REVOKE ALL ON FUNCTION public.create_access_group(uuid, text, jsonb, text, jsonb, text) FROM public;
GRANT EXECUTE ON FUNCTION public.create_access_group(uuid, text, jsonb, text, jsonb, text) TO authenticated;

-- ─── 3. update_access_group — now takes p_base_role ─────────────────────────
DROP FUNCTION IF EXISTS public.update_access_group(uuid, text, jsonb, text, jsonb);
CREATE OR REPLACE FUNCTION public.update_access_group(
    p_group_id       uuid,
    p_name           text,
    p_product_access jsonb,
    p_preset         text,
    p_section_access jsonb,
    p_base_role      text DEFAULT 'manager'
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
    IF p_base_role IS NULL OR p_base_role NOT IN ('admin', 'manager', 'scheduler', 'viewer') THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_base_role');
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
        base_role = p_base_role,
        updated_at = now()
    WHERE id = p_group_id;

    -- Keep every member currently assigned to this Role in sync with its
    -- (possibly just-changed) account type — the whole point of folding
    -- account type into the Role is that it can never drift from what the
    -- Role says, including when the Role itself is edited afterward.
    UPDATE camp_users SET role = p_base_role
    WHERE access_group_id = p_group_id AND role IS DISTINCT FROM p_base_role;

    RETURN jsonb_build_object('success', true);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
REVOKE ALL ON FUNCTION public.update_access_group(uuid, text, jsonb, text, jsonb, text) FROM public;
GRANT EXECUTE ON FUNCTION public.update_access_group(uuid, text, jsonb, text, jsonb, text) TO authenticated;

-- ─── 4. list_access_groups — now returns base_role ──────────────────────────
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
        'base_role', g.base_role,
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

-- ─── 5. assign_member_access_group — keeps camp_users.role in sync ──────────
-- Same authorization/shape as migration 097's version. The one change: when
-- ASSIGNING a group (p_group_id IS NOT NULL), camp_users.role is set to that
-- group's base_role in the same UPDATE — account type now travels WITH the
-- Role assignment instead of being a separate field the caller could set
-- inconsistently. Clearing to NULL still leaves role untouched.
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
    caller       uuid := auth.uid();
    v_camp       uuid;
    v_role       text;
    v_grp_camp   uuid;
    v_base_role  text;
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
        SELECT camp_id, base_role INTO v_grp_camp, v_base_role FROM camp_access_groups WHERE id = p_group_id;
        IF NOT FOUND OR v_grp_camp <> v_camp THEN
            RETURN jsonb_build_object('success', false, 'error', 'group_not_found');
        END IF;
        UPDATE camp_users SET access_group_id = p_group_id, role = v_base_role WHERE id = p_member_id;
    ELSE
        UPDATE camp_users SET access_group_id = NULL WHERE id = p_member_id;
    END IF;

    RETURN jsonb_build_object('success', true);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
REVOKE ALL ON FUNCTION public.assign_member_access_group(uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.assign_member_access_group(uuid, uuid) TO authenticated;
