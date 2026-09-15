-- ============================================================================
-- Migration 154: fix get_my_access, which silently granted full access.
--
-- Migration 097 declared `v_grp record` and then tested `IF v_grp IS NOT NULL`.
-- That is wrong twice over, and both failures grant MORE access, silently:
--
--   1. A member with NO access group never assigns v_grp at all. In PL/pgSQL an
--      unassigned record raises "record \"v_grp\" is not assigned yet" the
--      moment it is referenced — including by IS NOT NULL. That exception is
--      swallowed by the function's own EXCEPTION WHEN OTHERS handler, which
--      returns success:false + unrestricted:true, and
--      campistry_access_sections.js treats that as "no restrictions at all".
--      So for every ungrouped staff member — the common case — section access
--      has been doing nothing.
--
--   2. A member WITH a group whose access_preset is NULL (any group built from
--      raw section toggles rather than a named preset — including migration
--      097's own worked example) fails `record IS NOT NULL`, because SQL
--      row-value semantics require EVERY field to be non-null. Execution falls
--      through to the member's own columns, which for a grouped member are
--      typically empty, so resolve() sees "unconfigured" and grants edit on
--      everything. The group's restrictions are discarded.
--
-- Fix: select into three scalar variables instead of a record, and branch on
-- FOUND. Nothing else about the function changes — the owner short-circuit, the
-- not-a-member fail-open and the deliberate fail-open exception handler are all
-- preserved verbatim, because they are policy (documented in
-- campistry_access_sections.js:26-37), not bugs.
--
-- AFTER APPLYING: section access starts actually applying for ungrouped members
-- for the first time. Any member who was configured with restrictions has been
-- silently enjoying full access; they will now be gated as intended. Worth
-- telling the camp before running this, so a suddenly-restricted staff member
-- isn't reported as a regression.
--
-- Idempotent.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_my_access(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller        uuid := auth.uid();
    v_row         record;
    v_grp_found   boolean := false;
    v_grp_products jsonb;
    v_grp_preset   text;
    v_grp_sections jsonb;
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

    -- Scalars, not a record: an unassigned record cannot be tested safely, and
    -- a record IS NOT NULL test would also reject a group with a NULL preset.
    IF v_row.access_group_id IS NOT NULL THEN
        SELECT product_access, access_preset, section_access
          INTO v_grp_products, v_grp_preset, v_grp_sections
          FROM camp_access_groups WHERE id = v_row.access_group_id;
        v_grp_found := FOUND;
    END IF;

    -- A group assignment replaces the member's own columns wholesale (no
    -- merge), which is migration 097's intended behaviour.
    IF v_grp_found THEN
        RETURN jsonb_build_object(
            'success', true,
            'role', v_row.role,
            'products', COALESCE(v_grp_products, '[]'::jsonb),
            'preset', v_grp_preset,
            'overrides', COALESCE(v_grp_sections, '{}'::jsonb),
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

-- ─── Sanity check after applying ───────────────────────────────────────────
-- As a restricted (non-owner, ungrouped) staff member, this should now return
-- unrestricted:false with their real preset/overrides, instead of
-- success:false + unrestricted:true:
--   select get_my_access('<camp id>'::uuid);
-- ============================================================================
