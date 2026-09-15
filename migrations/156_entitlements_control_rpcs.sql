-- ============================================================================
-- Migration 156: super-admin RPCs behind the entitlements control page.
--
-- Migration 155 added camps.entitlements and _admin_set_camp_entitlements, but
-- that setter is service_role only — callable from an edge function or the SQL
-- editor, not from a signed-in browser. Configuring what every camp has bought
-- by hand-editing JSON in the SQL editor is exactly the friction this removes.
--
-- Auth reuses the mechanism migration 010 already established for the debug
-- clone: the super_admins allow-list plus is_super_admin(). Nothing new to
-- distribute, and membership stays grantable only from the SQL editor — a camp
-- owner can never reach these, which matters because entitlements are a
-- commercial boundary rather than a permission.
--
-- Every function here fails CLOSED. Unlike get_my_access — which fails open on
-- purpose, so a glitch can't lock a paying camp out of its own data — these
-- WRITE the commercial boundary, and the safe direction for a write is to
-- refuse.
--
-- Idempotent.
-- ============================================================================

-- ─── 1. List every camp with what it currently has ──────────────────────────
-- One row per camp. Deliberately returns only what the control page renders:
-- no credentials, no camp data, nothing from camp_state_kv.
CREATE OR REPLACE FUNCTION public.admin_list_camps_entitlements()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_rows jsonb;
BEGIN
    IF NOT public.is_super_admin() THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    SELECT COALESCE(jsonb_agg(r ORDER BY r->>'name'), '[]'::jsonb) INTO v_rows
    FROM (
        SELECT jsonb_build_object(
            'id',           c.id,
            'name',         COALESCE(c.name, '(unnamed camp)'),
            'entitlements', COALESCE(c.entitlements, '{}'::jsonb),
            -- 'unrestricted' is the honest label for '{}': the camp has
            -- everything, because nothing has been sold to it in particular.
            'unrestricted', (COALESCE(c.entitlements, '{}'::jsonb) = '{}'::jsonb),
            'processorKey', c.payment_processor_key,
            'createdAt',    c.created_at,
            'staffCount',   (SELECT count(*) FROM camp_users u WHERE u.camp_id = c.id)
        ) AS r
        FROM camps c
    ) s;

    RETURN jsonb_build_object('success', true, 'camps', v_rows);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_list_camps_entitlements() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_camps_entitlements() TO authenticated;

-- ─── 2. Set one camp's entitlements ─────────────────────────────────────────
-- Validates the shape before writing. A malformed entry would read as "not
-- bought" everywhere and quietly switch a paying camp off, so a typo must be
-- rejected rather than stored.
CREATE OR REPLACE FUNCTION public.admin_set_camp_entitlements(p_camp_id uuid, p_entitlements jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    rec   record;
    v_app jsonb;
    v_el  jsonb;
BEGIN
    IF NOT public.is_super_admin() THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;
    IF p_entitlements IS NULL OR jsonb_typeof(p_entitlements) <> 'object' THEN
        RETURN jsonb_build_object('success', false,
            'error', 'entitlements must be a JSON object ({} means unrestricted)');
    END IF;

    FOR rec IN SELECT key, value FROM jsonb_each(p_entitlements) LOOP
        v_app := rec.value;
        IF jsonb_typeof(v_app) = 'string' THEN
            IF v_app #>> '{}' <> '*' THEN
                RETURN jsonb_build_object('success', false,
                    'error', format('entitlements.%s: the only allowed string is "*"', rec.key));
            END IF;
        ELSIF jsonb_typeof(v_app) = 'array' THEN
            -- Every element must be a plain section key.
            FOR v_el IN SELECT * FROM jsonb_array_elements(v_app) LOOP
                IF jsonb_typeof(v_el) <> 'string' THEN
                    RETURN jsonb_build_object('success', false,
                        'error', format('entitlements.%s: section keys must be strings', rec.key));
                END IF;
            END LOOP;
        ELSE
            RETURN jsonb_build_object('success', false,
                'error', format('entitlements.%s must be "*" or an array of section keys', rec.key));
        END IF;
    END LOOP;

    IF NOT EXISTS (SELECT 1 FROM camps WHERE id = p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'no camp with that id');
    END IF;

    UPDATE camps SET entitlements = p_entitlements WHERE id = p_camp_id;

    RETURN jsonb_build_object('success', true, 'campId', p_camp_id, 'entitlements', p_entitlements);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_set_camp_entitlements(uuid, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_camp_entitlements(uuid, jsonb) TO authenticated;

-- ─── 3. Am I a super admin? ─────────────────────────────────────────────────
-- is_super_admin() is already granted to authenticated, but the control page
-- wants one call that also works when the user simply isn't one (returning
-- false rather than erroring), so the page can render a clean "not authorised"
-- instead of a broken screen.
CREATE OR REPLACE FUNCTION public.am_i_super_admin()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT jsonb_build_object('success', true, 'isSuperAdmin', public.is_super_admin());
$$;
REVOKE ALL ON FUNCTION public.am_i_super_admin() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.am_i_super_admin() TO authenticated;

-- ─── Granting yourself access (SQL editor only, by design) ──────────────────
--   insert into super_admins (user_id, note)
--   select id, 'platform owner' from auth.users where email = 'yisrose35@gmail.com'
--   on conflict (user_id) do nothing;
--
-- Check it took:
--   select am_i_super_admin();          -- as that signed-in user
--   select admin_list_camps_entitlements();
-- ============================================================================
