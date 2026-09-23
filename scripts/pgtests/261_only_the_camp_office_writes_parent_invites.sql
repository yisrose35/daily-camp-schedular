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
