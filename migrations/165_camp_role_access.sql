-- ============================================================================
-- Migration 165: per-JOB access defaults, set by the camp owner.
--
-- Camps describe access two ways and both have to compose:
--
--     "everyone with the title Scheduler gets this"
--     "...but THIS scheduler also does bussing"
--
-- Until now only the second was expressible. Access was per-person
-- (camp_users.access_preset / section_access) or per named group
-- (camp_access_groups), so "what a scheduler gets here" had to be set on every
-- scheduler individually — and a new hire defaulted to FULL access, because an
-- unconfigured user keeps the pre-section-access behaviour.
--
-- That default is the real problem this fixes. A camp that carefully restricted
-- its four schedulers got a fifth one with the run of the place.
--
-- ── THE MODEL ──────────────────────────────────────────────────────────────
-- One row per (camp, role). Same shape as a member's own access, so the same
-- editor and the same resolver work on it:
--
--     access_preset   — a named role to start from, or null
--     section_access  — explicit per-capability levels
--
-- Precedence, weakest last:
--
--     camp entitlement            what the camp bought — a ceiling over all of it
--     └─ owner/admin              never gated by the per-staff layers
--        └─ product_access        which apps at all
--           └─ member overrides   "this scheduler also does bussing"
--           └─ member preset
--           └─ ROLE DEFAULT       "what a scheduler gets here"   <- NEW
--           └─ legacy full        nobody has configured anything
--
-- A role default makes a person CONFIGURED, which is what stops the legacy
-- full-access rule from overriding the very thing the owner just set. That is
-- the one subtle part: without it, setting a role default would appear to do
-- nothing for anyone who has no personal access record — i.e. exactly the
-- people it is for.
--
-- The role default being WEAKER than anything personal is what keeps the
-- per-person screen an exception list rather than a full re-specification.
--
-- ── WHAT IT DOES NOT DO ────────────────────────────────────────────────────
-- It cannot raise anyone above the camp entitlement, and it does not apply to
-- owners or admins — both deliberately, and both enforced in resolve() and in
-- user_section_level() rather than here.
--
-- Roles are the existing camp_users.role values. 'owner' and 'admin' are
-- rejected: a default for them would be a no-op that looks like it works.
--
-- Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS camp_role_access (
    camp_id        uuid NOT NULL REFERENCES camps(id) ON DELETE CASCADE,
    role           text NOT NULL,
    access_preset  text,
    section_access jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (camp_id, role),
    -- Only roles the per-staff layers actually gate. owner/admin are excluded
    -- because resolve() returns full access for them before any of this is
    -- consulted, so a row here would be a setting that silently does nothing.
    CONSTRAINT camp_role_access_role_chk
        CHECK (role IN ('manager', 'scheduler', 'counselor', 'viewer'))
);

ALTER TABLE camp_role_access ENABLE ROW LEVEL SECURITY;

-- Every member of the camp may READ their camp's role defaults: get_my_access
-- has to resolve them, the owner's editor has to show them, and they are not
-- sensitive — they describe access, they are not access.
DROP POLICY IF EXISTS camp_role_access_select ON camp_role_access;
CREATE POLICY camp_role_access_select ON camp_role_access
    FOR SELECT
    USING (camp_id = get_user_camp_id());

-- Writing is owner/admin only, and goes through the RPC below rather than the
-- table, so the shape is validated in one place.
DROP POLICY IF EXISTS camp_role_access_write ON camp_role_access;
CREATE POLICY camp_role_access_write ON camp_role_access
    FOR ALL
    USING (camp_id = get_user_camp_id()
           AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text]))
    WITH CHECK (camp_id = get_user_camp_id()
           AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text]));

-- ─── Read: every role default for my camp ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_camp_role_access()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_camp uuid := get_user_camp_id();
    v_out  jsonb := '{}'::jsonb;
    r      record;
BEGIN
    IF v_camp IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_camp');
    END IF;
    FOR r IN SELECT role, access_preset, section_access
               FROM camp_role_access WHERE camp_id = v_camp LOOP
        v_out := v_out || jsonb_build_object(r.role, jsonb_build_object(
            'preset', r.access_preset,
            'overrides', COALESCE(r.section_access, '{}'::jsonb)));
    END LOOP;
    RETURN jsonb_build_object('success', true, 'roles', v_out);
END;
$$;
REVOKE ALL ON FUNCTION public.get_camp_role_access() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_camp_role_access() TO authenticated;

-- ─── Write: set (or clear) one role's default ───────────────────────────────
-- Passing a null preset AND an empty section_access DELETES the row, which is
-- how a camp goes back to "no default for this job". Storing an empty row
-- instead would leave everyone with that job CONFIGURED and therefore denied
-- everything unlisted — an empty default is not the same as no default, and
-- confusing the two would lock out a whole job title at once.
CREATE OR REPLACE FUNCTION public.set_camp_role_access(
    p_role text, p_preset text, p_section_access jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_camp uuid := get_user_camp_id();
    v_me   text := get_user_role();
    v_sec  jsonb := COALESCE(p_section_access, '{}'::jsonb);
    v_pre  text := NULLIF(TRIM(COALESCE(p_preset, '')), '');
BEGIN
    IF v_camp IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_camp');
    END IF;
    IF v_me IS NULL OR v_me NOT IN ('owner', 'admin') THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;
    IF p_role IS NULL OR p_role NOT IN ('manager', 'scheduler', 'counselor', 'viewer') THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_role',
            'detail', 'Defaults apply to manager, scheduler, counselor or viewer. '
                   || 'Owners and admins always have full access.');
    END IF;
    IF jsonb_typeof(v_sec) <> 'object' THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_section_access');
    END IF;

    -- "No default for this job" — see the note above on why this deletes.
    IF v_pre IS NULL AND v_sec = '{}'::jsonb THEN
        DELETE FROM camp_role_access WHERE camp_id = v_camp AND role = p_role;
        RETURN jsonb_build_object('success', true, 'role', p_role, 'cleared', true);
    END IF;

    INSERT INTO camp_role_access (camp_id, role, access_preset, section_access, updated_at)
    VALUES (v_camp, p_role, v_pre, v_sec, now())
    ON CONFLICT (camp_id, role) DO UPDATE
       SET access_preset = EXCLUDED.access_preset,
           section_access = EXCLUDED.section_access,
           updated_at = now();

    RETURN jsonb_build_object('success', true, 'role', p_role,
                              'preset', v_pre, 'overrides', v_sec);
END;
$$;
REVOKE ALL ON FUNCTION public.set_camp_role_access(text, text, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.set_camp_role_access(text, text, jsonb) TO authenticated;

-- ─── get_my_access now carries the caller's role default ────────────────────
-- Same function as migration 154, with roleAccess added. Every other branch is
-- preserved verbatim, including the owner short-circuit, the not-a-member
-- fail-open and the deliberate fail-open exception handler — those are policy,
-- not bugs (documented in campistry_access_sections.js).
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
    v_ent         jsonb;
    v_role_pre    text;
    v_role_sec    jsonb;
    v_role_found  boolean := false;
    v_role_access jsonb := NULL;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    SELECT entitlements INTO v_ent FROM camps WHERE id = p_camp_id;
    v_ent := COALESCE(v_ent, '{}'::jsonb);

    -- Owner of the camp: always full, never gated.
    IF EXISTS (SELECT 1 FROM camps WHERE id = p_camp_id AND owner = caller) THEN
        RETURN jsonb_build_object(
            'success', true, 'role', 'owner',
            'products', '[]'::jsonb, 'preset', NULL,
            'overrides', '{}'::jsonb, 'unrestricted', true,
            'entitlements', v_ent, 'roleAccess', NULL
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
        -- RLS is the real boundary.
        RETURN jsonb_build_object(
            'success', true, 'role', NULL,
            'products', '[]'::jsonb, 'preset', NULL,
            'overrides', '{}'::jsonb, 'unrestricted', true,
            'entitlements', v_ent, 'roleAccess', NULL
        );
    END IF;

    -- The camp-wide default for this person's job, if the owner set one.
    SELECT access_preset, section_access INTO v_role_pre, v_role_sec
      FROM camp_role_access
     WHERE camp_id = p_camp_id AND role = v_row.role;
    v_role_found := FOUND;
    IF v_role_found THEN
        v_role_access := jsonb_build_object(
            'preset', v_role_pre,
            'overrides', COALESCE(v_role_sec, '{}'::jsonb));
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
    -- merge), which is migration 097's intended behaviour. The ROLE default is
    -- a separate, weaker layer and is carried through either way.
    IF v_grp_found THEN
        RETURN jsonb_build_object(
            'success', true,
            'role', v_row.role,
            'products', COALESCE(v_grp_products, '[]'::jsonb),
            'preset', v_grp_preset,
            'overrides', COALESCE(v_grp_sections, '{}'::jsonb),
            'unrestricted', (v_row.role IN ('owner', 'admin')),
            'entitlements', v_ent,
            'roleAccess', v_role_access
        );
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'role', v_row.role,
        'products', COALESCE(v_row.product_access, '[]'::jsonb),
        'preset', v_row.access_preset,
        'overrides', COALESCE(v_row.section_access, '{}'::jsonb),
        'unrestricted', (v_row.role IN ('owner', 'admin')),
        'entitlements', v_ent,
        'roleAccess', v_role_access
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM, 'unrestricted', true);
END;
$$;
REVOKE ALL ON FUNCTION public.get_my_access(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_access(uuid) TO authenticated;

-- ─── The RLS resolver honours role defaults too ─────────────────────────────
-- Same function as migration 160, with the role default inserted at its place
-- in the precedence chain. It has to match C.resolve exactly or the database
-- and the browser disagree about who can see what — see
-- tests/access_registry_sql.test.js, which cross-checks them.
CREATE OR REPLACE FUNCTION public.user_section_level(p_camp_id uuid, p_cap_key text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_caller      uuid := auth.uid();
    v_app         text;
    v_section     text;
    v_view_only   boolean;
    v_role        text;
    v_products    jsonb;
    v_preset      text;
    v_overrides   jsonb;
    v_group_id    uuid;
    v_grp_found   boolean := false;
    v_grp_products jsonb;
    v_grp_preset   text;
    v_grp_sections jsonb;
    v_role_pre    text;
    v_role_sec    jsonb;
    v_role_found  boolean := false;
    v_role_level  text;
    v_role_names  boolean := false;
    v_level       text;
    v_explicit    boolean;
    v_unconfigured boolean;
BEGIN
    IF v_caller IS NULL THEN RETURN 'none'; END IF;

    SELECT app, section, view_only
      INTO v_app, v_section, v_view_only
      FROM access_capabilities WHERE cap_key = p_cap_key;
    IF NOT FOUND THEN RETURN 'edit'; END IF;

    IF EXISTS (SELECT 1 FROM camps WHERE id = p_camp_id AND owner = v_caller) THEN
        RETURN CASE WHEN v_view_only THEN 'view' ELSE 'edit' END;
    END IF;

    SELECT role, product_access, access_preset, section_access, access_group_id
      INTO v_role, v_products, v_preset, v_overrides, v_group_id
      FROM camp_users
     WHERE camp_id = p_camp_id AND user_id = v_caller
     LIMIT 1;

    IF NOT FOUND THEN RETURN 'edit'; END IF;

    IF v_group_id IS NOT NULL THEN
        SELECT product_access, access_preset, section_access
          INTO v_grp_products, v_grp_preset, v_grp_sections
          FROM camp_access_groups WHERE id = v_group_id;
        v_grp_found := FOUND;
    END IF;
    IF v_grp_found THEN
        v_products  := v_grp_products;
        v_preset    := v_grp_preset;
        v_overrides := v_grp_sections;
    END IF;

    v_products  := COALESCE(v_products,  '[]'::jsonb);
    v_overrides := COALESCE(v_overrides, '{}'::jsonb);
    IF v_preset = '' THEN v_preset := NULL; END IF;

    IF v_role IN ('owner', 'admin') THEN
        RETURN CASE WHEN v_view_only THEN 'view' ELSE 'edit' END;
    END IF;

    IF jsonb_typeof(v_products) = 'array'
       AND jsonb_array_length(v_products) > 0
       AND NOT (v_products ? v_app) THEN
        RETURN 'none';
    END IF;

    -- The camp-wide default for this person's job (migration 165).
    SELECT access_preset, section_access INTO v_role_pre, v_role_sec
      FROM camp_role_access
     WHERE camp_id = p_camp_id AND role = v_role;
    v_role_found := FOUND;
    IF v_role_pre = '' THEN v_role_pre := NULL; END IF;
    v_role_sec := COALESCE(v_role_sec, '{}'::jsonb);

    IF v_role_found THEN
        IF v_role_sec ? p_cap_key THEN
            v_role_level := v_role_sec ->> p_cap_key;
            v_role_names := true;
        ELSIF v_role_pre IS NOT NULL THEN
            SELECT level, explicit INTO v_role_level, v_role_names
              FROM access_preset_grants
             WHERE preset = v_role_pre AND cap_key = p_cap_key;
            v_role_names := COALESCE(v_role_names, false);
        END IF;
    END IF;

    -- A role default makes this person CONFIGURED. Without that, setting a
    -- default would do nothing for anyone with no personal access record —
    -- which is exactly the people it exists for.
    v_unconfigured := (v_preset IS NULL
                       AND v_overrides = '{}'::jsonb
                       AND NOT (v_role_found AND (v_role_pre IS NOT NULL OR v_role_sec <> '{}'::jsonb)));

    IF v_unconfigured THEN
        v_level := 'edit';
    ELSE
        IF v_section = 'finance' AND NOT (v_overrides ? p_cap_key) AND NOT v_role_names THEN
            SELECT explicit INTO v_explicit
              FROM access_preset_grants
             WHERE preset = v_preset AND cap_key = p_cap_key;
            IF v_preset IS NULL OR NOT COALESCE(v_explicit, false) THEN
                RETURN public.user_section_level(p_camp_id, v_app || '.analytics');
            END IF;
        END IF;

        IF v_overrides ? p_cap_key THEN
            v_level := v_overrides ->> p_cap_key;
        ELSIF v_preset IS NOT NULL THEN
            SELECT level INTO v_level
              FROM access_preset_grants
             WHERE preset = v_preset AND cap_key = p_cap_key;
        ELSIF v_role_level IS NOT NULL THEN
            v_level := v_role_level;
        ELSE
            v_level := 'none';
        END IF;
    END IF;

    IF v_level IS NULL OR v_level NOT IN ('none', 'view', 'edit') THEN
        v_level := 'none';
    END IF;

    IF v_role IN ('viewer', 'counselor') AND v_level = 'edit' THEN
        v_level := 'view';
    END IF;
    IF v_view_only AND v_level = 'edit' THEN
        v_level := 'view';
    END IF;

    RETURN v_level;
END;
$$;
REVOKE ALL ON FUNCTION public.user_section_level(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.user_section_level(uuid, text) TO authenticated, service_role;

-- ─── Sanity checks ─────────────────────────────────────────────────────────
-- Set a default for schedulers, then check one:
--   select set_camp_role_access('scheduler', null,
--            '{"flow.schedule":"edit","flow.print":"edit"}'::jsonb);
--   -- as that scheduler:
--   select user_section_level('<camp>'::uuid, 'flow.schedule');  -- edit
--   select user_section_level('<camp>'::uuid, 'me.billing');     -- none
--
-- Give ONE scheduler bussing on top — the role default must survive for
-- everything else:
--   select set_member_access('<member id>', null, '{"go.routes":"edit"}'::jsonb);
--   select user_section_level('<camp>'::uuid, 'go.routes');      -- edit
--   select user_section_level('<camp>'::uuid, 'flow.schedule');  -- still edit
--
-- Clear the default again:
--   select set_camp_role_access('scheduler', null, '{}'::jsonb);   -- cleared
--   select user_section_level('<camp>'::uuid, 'me.billing');       -- edit (legacy full)
-- ============================================================================
