-- ============================================================================
-- Migration 261: only the camp's office can write a parent invitation.
-- (Ted TED-023)
--
-- THE HOLE. upsert_parent_invite (011 → 087 → 131) checked only that the
-- caller was logged in. Any account — a parent of another camp, or a stranger
-- who signed up — could write an invitation for ANY camp under their own
-- email, naming any child (or naming none, which covers every child in the
-- camp), then claim it with the access code the function handed back. The
-- portal then treated them as that child's parent.
--
-- THE RULE. Writing an invitation is the office's act: the camp owner, or a
-- member of the camp with the owner, admin or manager role — the same people
-- who enrol campers. Everyone else is refused. And the function never writes
-- an invitation that names no children (which would cover the whole camp):
-- a missing list is written as an empty one, which covers nobody.
--
-- THE SAME HOLE FROM INSIDE (TED-028). The office's list of invitations —
-- with every family's access code — was open to ANY member of the camp, a
-- counselor or a viewer too, who could then claim a family's code on their own
-- login. That list, and every other function that binds or changes a family's
-- invitation, is the office's too now.
--
-- Standalone. Does NOT need 260 — paste it into the Supabase SQL Editor and
-- run it as soon as you can. Safe to run twice. NOT part of APPLY_BUNDLE.sql.
-- Afterwards, run the read-only check at the bottom of this file.
-- ============================================================================

-- The code a parent claims with (010); already there on a live database.
ALTER TABLE public.link_parent_invites ADD COLUMN IF NOT EXISTS access_code text;

CREATE OR REPLACE FUNCTION public._is_camp_office(p_camp_id uuid, p_caller uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT p_camp_id IS NOT NULL AND p_caller IS NOT NULL AND (
           EXISTS (SELECT 1 FROM camps WHERE id = p_camp_id AND owner = p_caller)
        OR EXISTS (SELECT 1 FROM camp_users
                    WHERE camp_id = p_camp_id AND user_id = p_caller
                      AND role IN ('owner', 'admin', 'manager')));
$$;
REVOKE ALL ON FUNCTION public._is_camp_office(uuid, uuid) FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.upsert_parent_invite(
    p_camp_id      uuid,
    p_token        text,
    p_parent_name  text,
    p_parent_email text,
    p_camper_names jsonb,
    p_camper_data  jsonb,
    p_expires_at   timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_existing_id    uuid;
    v_existing_token text;
    v_existing_code  text;
    v_code           text;
    v_names          jsonb;
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    -- 261: only this camp's office writes its invitations.
    IF NOT public._is_camp_office(p_camp_id, auth.uid()) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_camp_office');
    END IF;
    IF COALESCE(btrim(p_parent_email), '') = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_email');
    END IF;
    -- Never an invitation that covers the whole camp: no list is an empty list.
    v_names := CASE WHEN jsonb_typeof(p_camper_names) = 'array' THEN p_camper_names ELSE '[]'::jsonb END;

    SELECT id, token, access_code
    INTO v_existing_id, v_existing_token, v_existing_code
    FROM link_parent_invites
    WHERE camp_id      = p_camp_id
      AND parent_email = p_parent_email
      AND status       = 'active'
    ORDER BY created_at DESC
    LIMIT 1;

    IF FOUND THEN
        v_code := COALESCE(
            NULLIF(v_existing_code, ''),
            upper(
                substring(replace(gen_random_uuid()::text, '-', '') from 1 for 4) || '-' ||
                substring(replace(gen_random_uuid()::text, '-', '') from 5 for 4)
            )
        );
        -- user_id intentionally NOT reset (087); camp_connected reset (131).
        UPDATE link_parent_invites
        SET parent_name    = p_parent_name,
            camper_names   = v_names,
            camper_data    = p_camper_data,
            access_code    = v_code,
            camp_connected = true
        WHERE id = v_existing_id;

        RETURN jsonb_build_object('success', true, 'action', 'updated',
                                  'token', v_existing_token, 'access_code', v_code);
    ELSE
        v_code := upper(
            substring(replace(gen_random_uuid()::text, '-', '') from 1 for 4) || '-' ||
            substring(replace(gen_random_uuid()::text, '-', '') from 5 for 4)
        );
        INSERT INTO link_parent_invites
            (camp_id, token, access_code, parent_name, parent_email,
             camper_names, camper_data, status, expires_at)
        VALUES
            (p_camp_id, p_token, v_code, p_parent_name, p_parent_email,
             v_names, p_camper_data, 'active', p_expires_at);

        RETURN jsonb_build_object('success', true, 'action', 'created',
                                  'token', p_token, 'access_code', v_code);
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.upsert_parent_invite(uuid, text, text, text, jsonb, jsonb, timestamptz) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.upsert_parent_invite(uuid, text, text, text, jsonb, jsonb, timestamptz) TO authenticated;

-- ─── the office functions that let ANY camp member through (TED-028) ────────
-- These let the camp owner or ANY member of the camp in — counselors and
-- viewers included:
--   get_camp_parent_invites      (032) lists every family's invitation WITH its
--                                      access code — which anyone can then claim
--                                      on their own login (claim_invite_by_code)
--   resolve_join_request         (032) binds a login to a family
--   set_parent_invite_email      (034) points a family's invitation at an email
--   set_parent_billing_access    (070) opens a family's billing to its login
--   revoke_orphaned_parent_invites (122) closes families' invitations
-- Each is the office's act. Rewritten in place: the membership check becomes
-- "the camp office" (owner, admin, manager); nothing else changes.
DO $$
DECLARE
    f     text;
    d     text;
    n     text;
    v_re  text := 'IF\s+NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+camps\s+c\s+WHERE\s+c\.id\s*=\s*([a-z_.]+)\s+AND\s+c\.owner\s*=\s*caller\s*\)\s*AND\s+NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+camp_users\s+u\s+WHERE\s+u\.camp_id\s*=\s*[a-z_.]+\s+AND\s+u\.user_id\s*=\s*caller\s*\)\s*THEN\s*RETURN\s+jsonb_build_object\(\s*''success'',\s*false,\s*''error'',\s*''not_a_member''\s*\)';
BEGIN
    FOREACH f IN ARRAY ARRAY['get_camp_parent_invites', 'resolve_join_request', 'set_parent_invite_email',
                             'set_parent_billing_access', 'revoke_orphaned_parent_invites'] LOOP
        FOR d IN SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                  WHERE ns.nspname = 'public' AND p.proname = f LOOP
            CONTINUE WHEN d ~ '_is_camp_office';                  -- already done
            n := regexp_replace(d, v_re,
                   'IF NOT public._is_camp_office(\1, caller) THEN RETURN jsonb_build_object(''success'', false, ''error'', ''not_camp_office'')');
            IF n = d THEN
                RAISE EXCEPTION '261: % does not look the way this file expects — send this message to the builder', f;
            END IF;
            EXECUTE n;
        END LOOP;
    END LOOP;
END $$;

-- ─── read-only check: was the hole used? ────────────────────────────────────
-- Every claimed invitation that covers a whole camp (it names no children).
-- Run this and send any email you do not recognise to the builder:
--
--   SELECT i.camp_id, i.parent_email, i.user_id, i.created_at, i.camper_names
--     FROM link_parent_invites i
--    WHERE i.user_id IS NOT NULL AND i.camper_names IS NULL
--    ORDER BY i.created_at DESC;
