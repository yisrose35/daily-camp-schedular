-- ════════════════════════════════════════════════════════════════════════════
-- Behaviour test for 261 (TED-023): only the camp's office writes a parent
-- invitation. A stranger — logged in, no role at the camp — asks for child
-- #5 by number, for a child by name, and for the whole camp. Each is refused,
-- and afterwards the stranger owns nobody. A manager of the camp can write
-- one; an owner writing one with no list gets an empty list, never the camp.
-- uuids are prefixed a6100000-.
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO auth.users (id, email) VALUES
    ('a6100000-0000-0000-0000-0000000000a1', 'owner@261.test'),
    ('a6100000-0000-0000-0000-0000000000b1', 'stranger@261.test'),
    ('a6100000-0000-0000-0000-0000000000c1', 'manager@261.test'),
    ('a6100000-0000-0000-0000-0000000000d1', 'counselor@261.test');
INSERT INTO camps (id, name, owner) VALUES
    ('a6100000-0000-0000-0000-000000000001', '261 camp', 'a6100000-0000-0000-0000-0000000000a1');
INSERT INTO camp_users (camp_id, user_id, role) VALUES
    ('a6100000-0000-0000-0000-000000000001', 'a6100000-0000-0000-0000-0000000000c1', 'manager'),
    ('a6100000-0000-0000-0000-000000000001', 'a6100000-0000-0000-0000-0000000000d1', 'counselor');
INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('a6100000-0000-0000-0000-000000000001', 'app1',
    '{"camperRoster":{"Moshe Gold":{"name":"Moshe Gold","camperId":5}}}');

-- The stranger.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS 'SELECT ''a6100000-0000-0000-0000-0000000000b1''::uuid';
DO $$
DECLARE v jsonb; c uuid := 'a6100000-0000-0000-0000-000000000001';
BEGIN
    v := public.upsert_parent_invite(c, 'tok-stranger-1', 'X', 'stranger@261.test',
            '["Moshe Gold"]', '{"Moshe Gold":{"camperId":5}}', now() + interval '1 year');
    IF (v ->> 'success')::boolean IS NOT FALSE THEN
        RAISE EXCEPTION 'TED-023: a stranger wrote an invitation naming a child: %', v;
    END IF;
    v := public.upsert_parent_invite(c, 'tok-stranger-2', 'X', 'stranger@261.test',
            NULL, NULL, now() + interval '1 year');
    IF (v ->> 'success')::boolean IS NOT FALSE THEN
        RAISE EXCEPTION 'TED-023: a stranger wrote a whole-camp invitation: %', v;
    END IF;
    IF EXISTS (SELECT 1 FROM link_parent_invites WHERE camp_id = c) THEN
        RAISE EXCEPTION 'TED-023: an invitation was written for the stranger';
    END IF;
    -- Even if one were claimed by hand, nothing grants them the child.
    UPDATE link_parent_invites SET user_id = auth.uid() WHERE parent_email = 'stranger@261.test';
    IF public._parent_owns_person(c, 5) THEN
        RAISE EXCEPTION 'TED-023: the stranger owns child #5';
    END IF;
END $$;

-- A counselor at the camp is not the office either.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS 'SELECT ''a6100000-0000-0000-0000-0000000000d1''::uuid';
DO $$
BEGIN
    IF (public.upsert_parent_invite('a6100000-0000-0000-0000-000000000001', 'tok-c', 'C', 'counselor@261.test',
            '["Moshe Gold"]', '{}', now() + interval '1 year') ->> 'success')::boolean IS NOT FALSE THEN
        RAISE EXCEPTION 'TED-023: a counselor wrote a parent invitation';
    END IF;
END $$;

-- The camp's manager can.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS 'SELECT ''a6100000-0000-0000-0000-0000000000c1''::uuid';
DO $$
DECLARE v jsonb;
BEGIN
    v := public.upsert_parent_invite('a6100000-0000-0000-0000-000000000001', 'tok-gold', 'Gold', 'gold@261.test',
            '["Moshe Gold"]', '{"Moshe Gold":{"camperId":5}}', now() + interval '1 year');
    IF (v ->> 'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'the camp''s manager could not write an invitation: %', v;
    END IF;
END $$;

-- (TED-028) A counselor cannot read the families' access codes, re-point a
-- family's invitation, open its billing, or bind a login to it — so cannot
-- claim a family the way Ted did (read the code, then claim it).
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS 'SELECT ''a6100000-0000-0000-0000-0000000000d1''::uuid';
DO $$
DECLARE v jsonb; c uuid := 'a6100000-0000-0000-0000-000000000001';
BEGIN
    v := public.get_camp_parent_invites(c);
    IF (v ->> 'success')::boolean IS NOT FALSE OR v::text ~ 'access_code' THEN
        RAISE EXCEPTION 'TED-028: a counselor read the families'' access codes: %', v;
    END IF;
    v := public.set_parent_invite_email(c, 'gold@261.test', 'counselor@261.test');
    IF (v ->> 'success')::boolean IS NOT FALSE THEN
        RAISE EXCEPTION 'TED-028: a counselor re-pointed a family''s invitation: %', v;
    END IF;
    v := public.set_parent_billing_access(c, 'gold@261.test', true);
    IF (v ->> 'success')::boolean IS NOT FALSE THEN
        RAISE EXCEPTION 'TED-028: a counselor opened a family''s billing: %', v;
    END IF;
    INSERT INTO link_join_requests (id, camp_id, user_id, email, status)
    VALUES ('a6100000-eeee-0000-0000-000000000001', c, 'a6100000-0000-0000-0000-0000000000d1', 'counselor@261.test', 'pending');
    v := public.resolve_join_request('a6100000-eeee-0000-0000-000000000001', 'approve', 'gold@261.test');
    IF (v ->> 'success')::boolean IS NOT FALSE THEN
        RAISE EXCEPTION 'TED-028: a counselor bound themselves to a family: %', v;
    END IF;
    IF EXISTS (SELECT 1 FROM link_parent_invites WHERE camp_id = c AND user_id = auth.uid())
       OR public._parent_owns_person(c, 5) THEN
        RAISE EXCEPTION 'TED-028: the counselor owns Moshe';
    END IF;
END $$;

-- The owner still reads the list (with the codes, to hand to families).
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS 'SELECT ''a6100000-0000-0000-0000-0000000000a1''::uuid';
DO $$
DECLARE v jsonb;
BEGIN
    v := public.get_camp_parent_invites('a6100000-0000-0000-0000-000000000001');
    IF (v ->> 'success')::boolean IS NOT TRUE OR jsonb_array_length(v -> 'invites') < 1 THEN
        RAISE EXCEPTION 'the owner cannot read the invitations: %', v;
    END IF;
END $$;

-- The owner, with no list: an empty list, never a whole-camp invitation.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS 'SELECT ''a6100000-0000-0000-0000-0000000000a1''::uuid';
DO $$
DECLARE v jsonb;
BEGIN
    v := public.upsert_parent_invite('a6100000-0000-0000-0000-000000000001', 'tok-empty', 'E', 'empty@261.test',
            NULL, NULL, now() + interval '1 year');
    IF (v ->> 'success')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'owner refused: %', v; END IF;
    IF (SELECT camper_names FROM link_parent_invites WHERE parent_email = 'empty@261.test') IS DISTINCT FROM '[]'::jsonb THEN
        RAISE EXCEPTION 'TED-023: an invitation with no list covers the whole camp';
    END IF;
END $$;
ROLLBACK;

-- ════════════════════════════════════════════════════════════════════════════
-- (TED-028) Reading the invitations TABLE, as a logged-in user under its real
-- read rules: a scheduler sees no family's access code (so cannot claim one);
-- the owner does; a parent sees their own invitation only.
-- ════════════════════════════════════════════════════════════════════════════
BEGIN;
INSERT INTO auth.users (id, email) VALUES
    ('a6100000-0000-0000-0000-0000000000a2', 'owner2@261.test'),
    ('a6100000-0000-0000-0000-0000000000e2', 'scheduler2@261.test'),
    ('a6100000-0000-0000-0000-0000000000f2', 'parent2@261.test');
INSERT INTO camps (id, name, owner) VALUES
    ('a6100000-0000-0000-0000-000000000002', '261 camp two', 'a6100000-0000-0000-0000-0000000000a2');
INSERT INTO camp_users (camp_id, user_id, role, accepted_at) VALUES
    ('a6100000-0000-0000-0000-000000000002', 'a6100000-0000-0000-0000-0000000000e2', 'scheduler', now());
INSERT INTO link_parent_invites (camp_id, parent_email, camper_names, person_ids, status, access_code, token, user_id) VALUES
    ('a6100000-0000-0000-0000-000000000002', 'gold2@261.test', '["Moshe Gold"]', '[5]', 'active', 'GOLD-CODE', 'tok-gold2', NULL),
    ('a6100000-0000-0000-0000-000000000002', 'parent2@261.test', '["Dina Gold"]', '[6]', 'active', 'DINA-CODE', 'tok-dina2',
     'a6100000-0000-0000-0000-0000000000f2');
-- A parent's own read rule, exactly as 009 has it live (009 is not in the chain).
CREATE POLICY link_parent_invites_parent_select ON public.link_parent_invites
    FOR SELECT USING (user_id = auth.uid());
GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT SELECT ON public.link_parent_invites TO authenticated;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $f$ SELECT NULLIF(current_setting('t261.uid', true), '')::uuid $f$;

SET LOCAL t261.uid = 'a6100000-0000-0000-0000-0000000000e2';
SET LOCAL ROLE authenticated;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.link_parent_invites WHERE access_code IS NOT NULL) THEN
        RAISE EXCEPTION 'TED-028: a scheduler read families'' access codes from the table: %',
            (SELECT jsonb_agg(access_code) FROM public.link_parent_invites);
    END IF;
END $$;
RESET ROLE;

SET LOCAL t261.uid = 'a6100000-0000-0000-0000-0000000000a2';
SET LOCAL ROLE authenticated;
DO $$
BEGIN
    IF (SELECT count(*) FROM public.link_parent_invites) <> 2 THEN
        RAISE EXCEPTION 'the owner cannot read the camp''s invitations';
    END IF;
END $$;
RESET ROLE;

SET LOCAL t261.uid = 'a6100000-0000-0000-0000-0000000000f2';
SET LOCAL ROLE authenticated;
DO $$
BEGIN
    IF (SELECT array_agg(access_code) FROM public.link_parent_invites) IS DISTINCT FROM ARRAY['DINA-CODE'] THEN
        RAISE EXCEPTION 'a parent does not see exactly their own invitation: %',
            (SELECT array_agg(access_code) FROM public.link_parent_invites);
    END IF;
END $$;
RESET ROLE;
ROLLBACK;

-- ════════════════════════════════════════════════════════════════════════════
-- (TED-047) "Is this family still at camp?" by number. The Katz family's Avi
-- #1 has left; a DIFFERENT Avi Katz (#3) is enrolled. The Katz family is
-- switched off, the new Avi's family stays on, and an invitation that has no
-- number yet is still decided by its names.
-- ════════════════════════════════════════════════════════════════════════════
BEGIN;
INSERT INTO auth.users (id, email) VALUES ('a6100000-0000-0000-0000-0000000000a3', 'owner3@261.test');
INSERT INTO camps (id, name, owner) VALUES
    ('a6100000-0000-0000-0000-000000000003', '261 camp three', 'a6100000-0000-0000-0000-0000000000a3');
INSERT INTO link_parent_invites (id, camp_id, parent_email, camper_names, person_ids, status, camp_connected) VALUES
    ('a6100000-aaaa-0000-0000-000000000031', 'a6100000-0000-0000-0000-000000000003', 'katz@261.test', '["Avi Katz"]', '[1]', 'active', true),
    ('a6100000-aaaa-0000-0000-000000000033', 'a6100000-0000-0000-0000-000000000003', 'katz2@261.test', '["Avi Katz #3"]', '[3]', 'active', true),
    ('a6100000-aaaa-0000-0000-000000000034', 'a6100000-0000-0000-0000-000000000003', 'old@261.test', '["Rina Stone"]', '[null]', 'active', true);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $f$ SELECT NULLIF(current_setting('t261.uid', true), '')::uuid $f$;
SET LOCAL t261.uid = 'a6100000-0000-0000-0000-0000000000a3';
DO $$
DECLARE v jsonb;
BEGIN
    -- the page sends the roster as the plain name "Avi Katz" (it has not yet
    -- adopted the new Avi's own label) and the enrolled numbers
    v := public.revoke_orphaned_parent_invites('a6100000-0000-0000-0000-000000000003',
            '["Avi Katz","Rina Stone"]', '[3]');
    IF (v ->> 'success')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'sweep refused: %', v; END IF;
    IF (SELECT camp_connected FROM link_parent_invites WHERE id = 'a6100000-aaaa-0000-0000-000000000031') THEN
        RAISE EXCEPTION 'TED-047: the departed Avi #1''s family is still connected because a new child shares his name';
    END IF;
    IF NOT (SELECT camp_connected FROM link_parent_invites WHERE id = 'a6100000-aaaa-0000-0000-000000000033') THEN
        RAISE EXCEPTION 'the new Avi #3''s family was switched off';
    END IF;
    IF NOT (SELECT camp_connected FROM link_parent_invites WHERE id = 'a6100000-aaaa-0000-0000-000000000034') THEN
        RAISE EXCEPTION 'an invitation with no number yet was switched off although its child''s name is on the roster';
    END IF;
END $$;
ROLLBACK;
