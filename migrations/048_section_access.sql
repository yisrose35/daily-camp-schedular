-- ============================================================================
-- Migration: per-SECTION access for staff (access_preset + section_access)
--
-- Why: product_access (migration 027) gates whole apps — you get Campistry Me
--      or you don't. But Me holds the camper roster AND billing AND payroll. A
--      division head who needs the roster has no business in the payment
--      history, and until now there was no way to express that.
--
-- Two new columns on camp_users:
--
--   access_preset   text   — a named starting point ('division-head', 'nurse',
--                            'bookkeeper', ...). NULL means no preset.
--   section_access  jsonb  — explicit per-capability overrides on top of the
--                            preset, e.g. {"me.billing":"none"}. Levels are
--                            'none' | 'view' | 'edit'.
--
-- The capability keys and the preset definitions live in
-- campistry_capabilities.js — deliberately NOT duplicated here. Postgres only
-- stores and serves these values; the meaning of them has one home.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE BACKWARD-COMPATIBILITY RULE
--
-- Both columns default to unset. A user with NO preset and NO overrides is
-- "unconfigured" and keeps exactly the access they had before this migration:
-- full use of every app in their product_access. Gating begins only when an
-- owner deliberately assigns something.
--
-- This is why section_access defaults to '{}' rather than to a restrictive
-- map — the alternative locks every existing staff member out of everything
-- the moment this is applied.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- WHAT THIS ENFORCES. get_my_access() is the trustworthy read of a caller's
-- own permissions — a client can't inflate its own row through it. Writing
-- someone's access goes through set_member_access(), which verifies the CALLER
-- is an owner or admin of that camp, so a division head can't grant themselves
-- billing by calling the RPC directly.
--
-- What it does NOT do is stop a restricted user's browser from RECEIVING data
-- for a hidden section: several apps hydrate one JSON blob per app from
-- camp_state_kv, so the roster and billing arrive together. The client scrubs
-- and preserves (see campistry_access_sections.js). Splitting those blobs per
-- section is the follow-up that would make this a hard read boundary.
-- ============================================================================

ALTER TABLE camp_users
    ADD COLUMN IF NOT EXISTS access_preset  text,
    ADD COLUMN IF NOT EXISTS section_access jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN camp_users.access_preset IS
    'Named access preset key from campistry_capabilities.js (e.g. division-head). NULL = none.';
COMMENT ON COLUMN camp_users.section_access IS
    'Per-capability overrides, {"<app>.<section>": "none|view|edit"}. Empty = unconfigured (full access to their products).';


-- ─── 1. get_my_access ─────────────────────────────────────────────────────────
-- The caller's own effective access inputs. The client resolves levels from
-- these using the shared registry; this is just the trustworthy source of the
-- four values that go into that decision.
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

    SELECT role, product_access, access_preset, section_access
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


-- ─── 2. set_member_access ─────────────────────────────────────────────────────
-- Owner/admin only. This is the guard that stops a restricted user from
-- granting themselves anything by calling the RPC from the console.
CREATE OR REPLACE FUNCTION public.set_member_access(
    p_member_id      uuid,
    p_preset         text,
    p_section_access jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller     uuid := auth.uid();
    v_camp     uuid;
    v_role     text;
    v_is_admin boolean;
    v_key      text;
    v_val      jsonb;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    SELECT camp_id, role INTO v_camp, v_role
    FROM camp_users WHERE id = p_member_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'member_not_found');
    END IF;

    -- Caller must own or admin THAT camp — not merely be an admin somewhere.
    v_is_admin :=
        EXISTS (SELECT 1 FROM camps WHERE id = v_camp AND owner = caller)
        OR EXISTS (SELECT 1 FROM camp_users
                   WHERE camp_id = v_camp AND user_id = caller AND role IN ('owner', 'admin'));

    IF NOT v_is_admin THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    -- Refuse to restrict an owner or admin. They're ungated by design, so a
    -- stored restriction would be a lie the UI has to keep explaining — and if
    -- the resolver ever stopped special-casing them it would become a lockout.
    IF v_role IN ('owner', 'admin') THEN
        RETURN jsonb_build_object('success', false, 'error', 'cannot_restrict_admin');
    END IF;

    IF p_section_access IS NOT NULL AND jsonb_typeof(p_section_access) <> 'object' THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_section_access');
    END IF;

    -- Validate every level. Keys aren't checked against the registry (it lives
    -- in JS and grows), but an unknown key is harmless — the resolver ignores
    -- anything it can't match. A bad LEVEL is not harmless, so it's rejected
    -- here rather than silently read as 'none' later.
    IF p_section_access IS NOT NULL THEN
        FOR v_key, v_val IN SELECT * FROM jsonb_each(p_section_access)
        LOOP
            IF jsonb_typeof(v_val) <> 'string'
               OR (v_val #>> '{}') NOT IN ('none', 'view', 'edit') THEN
                RETURN jsonb_build_object('success', false, 'error', 'invalid_level',
                                          'capability', v_key);
            END IF;
        END LOOP;
    END IF;

    UPDATE camp_users
    SET access_preset  = NULLIF(btrim(COALESCE(p_preset, '')), ''),
        section_access = COALESCE(p_section_access, '{}'::jsonb)
    WHERE id = p_member_id;

    RETURN jsonb_build_object('success', true);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.set_member_access(uuid, text, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.set_member_access(uuid, text, jsonb) TO authenticated;


-- ─── 3. Sanity check ──────────────────────────────────────────────────────────
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'camp_users' AND column_name IN ('access_preset','section_access');
--
--   SELECT proname FROM pg_proc WHERE proname IN ('get_my_access','set_member_access');
