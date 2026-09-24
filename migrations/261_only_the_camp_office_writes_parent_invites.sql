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
-- AND (TED-047) whether a family is still at camp is decided by its children's
-- numbers, not their names.
--
-- THE SAME HOLE FROM INSIDE (TED-028). The office's list of invitations —
-- with every family's access code — was open to ANY member of the camp, a
-- counselor or a viewer too, who could then claim a family's code on their own
-- login. That list, and every other function that binds or changes a family's
-- invitation, is the office's too now.
--
-- Standalone. Does NOT need 260 — paste it into the Supabase SQL Editor and
-- run it as soon as you can. Safe to run twice — and if you ran an EARLIER
-- copy of this file, run this one again: it closes more (the verify script's
-- 261 row says "run 261 again" until you do). NOT part of APPLY_BUNDLE.sql.
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
    -- Pasted from Windows the patterns carry CR LF; the function text has none.
    f := replace(f, chr(13), '');
    v_re := replace(v_re, chr(13), '');
    FOREACH f IN ARRAY ARRAY['get_camp_parent_invites', 'resolve_join_request', 'set_parent_invite_email',
                             'set_parent_billing_access', 'revoke_orphaned_parent_invites'] LOOP
        FOR d IN SELECT replace(pg_get_functiondef(p.oid), chr(13), '') FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
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

-- ─── "is this family still at camp?" goes by number (TED-047) ───────────────
-- When a family's last child leaves, their parent app is switched off for live
-- camp features (122). That was decided by NAME — a new child with the same
-- name kept a departed child's family switched on. Now by number: an
-- invitation stays connected while one of its children's numbers is still an
-- enrolled camper. Only an invitation that carries no number at all (written
-- before its child was numbered) is still decided by its names.
--
-- A number counts as enrolled when the page says so OR the database's own
-- roster copy (camp_people: on the roster, not unenrolled) says so — the page
-- can hold a child's old number for a few seconds after a save, and a family
-- must never be switched off on that (TED-049). A slot whose number is not
-- filled in yet (a sibling added a moment ago) keeps the family on when that
-- slot's name is on the roster. A list of numbers with no usable number in it
-- counts as empty.
CREATE OR REPLACE FUNCTION public.revoke_orphaned_parent_invites(
    p_camp_id      uuid,
    p_roster_names jsonb,
    p_roster_ids   jsonb             -- the numbers of every camper still enrolled
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    n      int := 0;
    v_ids  bigint[];
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    IF NOT public._is_camp_office(p_camp_id, caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_camp_office');
    END IF;
    -- Safety: never mass-disconnect when we were handed an empty roster —
    -- counted in usable numbers, not list items ('[null]' is empty).
    IF p_roster_ids IS NOT NULL AND jsonb_typeof(p_roster_ids) = 'array' THEN
        v_ids := ARRAY(SELECT DISTINCT public._stated_person_id(x #>> '{}') FROM jsonb_array_elements(p_roster_ids) x
                        WHERE public._stated_person_id(x #>> '{}') IS NOT NULL);
    END IF;
    IF COALESCE(cardinality(v_ids), 0) = 0 THEN
        RETURN jsonb_build_object('success', true, 'revoked', 0, 'skipped', 'empty_roster');
    END IF;
    -- plus every camper the database itself has on the roster and enrolled
    v_ids := v_ids || ARRAY(SELECT p.person_id FROM camp_people p
                             WHERE p.camp_id = p_camp_id AND p.kind = 'camper' AND p.deleted_at IS NULL
                               AND lower(COALESCE(p.payload ->> 'unenrolled', '')) NOT IN ('true', '1', 'yes'));

    WITH stale AS (
        SELECT i.id
          FROM link_parent_invites i
         WHERE i.camp_id = p_camp_id
           AND i.camp_connected = true
           AND CASE
                 -- the invitation's children by number
                 WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(i.person_ids) = 'array'
                                                                      THEN i.person_ids ELSE '[]'::jsonb END) x
                               WHERE public._stated_person_id(x #>> '{}') IS NOT NULL)
                 THEN NOT EXISTS (SELECT 1 FROM jsonb_array_elements(i.person_ids) x
                                   WHERE public._stated_person_id(x #>> '{}') = ANY (v_ids))
                      -- a child on it whose number is not filled in yet, still on the roster
                      AND NOT (jsonb_typeof(p_roster_names) = 'array' AND jsonb_typeof(i.camper_names) = 'array'
                               AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(i.camper_names) WITH ORDINALITY cn(name, ord)
                                            WHERE public._stated_person_id(i.person_ids ->> (cn.ord - 1)::int) IS NULL
                                              AND p_roster_names ? cn.name))
                 -- no number on it yet: its names, as before
                 ELSE jsonb_typeof(p_roster_names) = 'array' AND jsonb_array_length(p_roster_names) > 0
                      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(i.camper_names, '[]'::jsonb)) cn
                                       WHERE p_roster_names ? cn)
               END
    )
    UPDATE link_parent_invites SET camp_connected = false
     WHERE id IN (SELECT id FROM stale);
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN jsonb_build_object('success', true, 'revoked', n);
END;
$$;
REVOKE ALL ON FUNCTION public.revoke_orphaned_parent_invites(uuid, jsonb, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.revoke_orphaned_parent_invites(uuid, jsonb, jsonb) TO authenticated;

-- ─── reading the invitations table itself (TED-028) ─────────────────────────
-- The table's staff read rule (098) let a scheduler read every column —
-- every family's access code and token — straight from the table, and claim
-- a family with it. Staff reads are the office's now, like the functions
-- above. (A parent still reads their OWN invitation: 009's parent rule.)
ALTER TABLE public.link_parent_invites ENABLE ROW LEVEL SECURITY;   -- as it is live (008)
DROP POLICY IF EXISTS link_parent_invites_select ON public.link_parent_invites;
CREATE POLICY link_parent_invites_select ON public.link_parent_invites
    FOR SELECT
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'manager'::text])
    );

-- ─── read-only check: was the hole used? ────────────────────────────────────
-- Every claimed invitation that covers a whole camp (it names no children).
-- Run this and send any email you do not recognise to the builder:
--
--   SELECT i.camp_id, i.parent_email, i.user_id, i.created_at, i.camper_names
--     FROM link_parent_invites i
--    WHERE i.user_id IS NOT NULL AND i.camper_names IS NULL
--    ORDER BY i.created_at DESC;
