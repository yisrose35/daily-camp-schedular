-- ════════════════════════════════════════════════════════════════════════════
-- Behaviour test for 232.
--
-- The one thing that matters: a camper enrolled AFTER an invite was resolved
-- cannot be reached by that invite's null slot. Everything else here exists to
-- prove the fix did not buy that by breaking the cases 223 and 225 protect.
--
-- uuids are prefixed a3200000- so this file cannot collide with the other
-- pgtests sharing one server.
-- ════════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

BEGIN;

-- ─── the camp, its roster, and a parent ─────────────────────────────────────
INSERT INTO camps (id, name, owner)
VALUES ('a3200000-0000-0000-0000-000000000001', '232 camp',
        'a3200000-0000-0000-0000-0000000000aa')
ON CONFLICT (id) DO NOTHING;

-- Two campers who are on the roster BEFORE any invite is resolved. first_seen
-- is set explicitly: the default is now(), and now() is the transaction clock,
-- so every row in this file would otherwise share one timestamp and the bound
-- would be untestable.
INSERT INTO camp_people (camp_id, person_id, kind, source_key, name, first_seen)
VALUES ('a3200000-0000-0000-0000-000000000001', 9001, 'camper',
        'Present Child', 'Present Child', now() - interval '10 days'),
       ('a3200000-0000-0000-0000-000000000001', 9002, 'camper',
        'Other Child', 'Other Child', now() - interval '10 days');

-- ─── 1. an invite for a camper who IS on the roster ─────────────────────────
-- 223's trigger stamps the id; 232's trigger stamps the mark. Both must happen.
INSERT INTO link_parent_invites
    (id, camp_id, user_id, token, parent_name, parent_email, camper_names, status)
VALUES ('a3200000-0000-0000-0000-00000000b001',
        'a3200000-0000-0000-0000-000000000001',
        'a3200000-0000-0000-0000-0000000000b1', 'tok-b1', 'Present Parent',
        'present@example.com', '["Present Child"]'::jsonb, 'active');

DO $$
DECLARE r record;
BEGIN
    SELECT person_ids, person_ids_resolved_at IS NOT NULL AS marked
      INTO r FROM link_parent_invites
     WHERE id = 'a3200000-0000-0000-0000-00000000b001';
    IF r.person_ids <> '[9001]'::jsonb THEN
        RAISE EXCEPTION '223 did not stamp the id: %', r.person_ids;
    END IF;
    IF NOT r.marked THEN
        RAISE EXCEPTION '232 did not mark an invite it inserted';
    END IF;
    -- Stamped on an id, so it is covered by id and does not depend on the name.
    IF NOT public._invite_covers_person('a3200000-0000-0000-0000-00000000b001', 9001) THEN
        RAISE EXCEPTION 'a stamped invite does not cover its own camper';
    END IF;
    IF public._invite_covers_person('a3200000-0000-0000-0000-00000000b001', 9002) THEN
        RAISE EXCEPTION 'an invite covers a camper it never named';
    END IF;
END $$;

-- ─── 2. the attack ──────────────────────────────────────────────────────────
-- An invite naming a camper who is NOT on the roster. The slot is null, and
-- 223's comment is right that this is normal: the invite goes out before the
-- child is enrolled.
INSERT INTO link_parent_invites
    (id, camp_id, user_id, token, parent_name, parent_email, camper_names, status)
VALUES ('a3200000-0000-0000-0000-00000000b002',
        'a3200000-0000-0000-0000-000000000001',
        'a3200000-0000-0000-0000-0000000000b2', 'tok-b2', 'Waiting Parent',
        'waiting@example.com', '["Future Child"]'::jsonb, 'active');

DO $$
DECLARE v jsonb;
BEGIN
    SELECT person_ids INTO v FROM link_parent_invites
     WHERE id = 'a3200000-0000-0000-0000-00000000b002';
    IF v <> '[null]'::jsonb THEN
        RAISE EXCEPTION 'expected a null slot for an unenrolled camper, got %', v;
    END IF;
    -- No camper of that name exists, so the string fallback in
    -- _invite_covers_camper is the only thing that can answer, and it must keep
    -- working: this is the pre-enrolment workflow 223 protects.
    IF NOT public._invite_covers_camper('a3200000-0000-0000-0000-00000000b002',
                                        'Future Child') THEN
        RAISE EXCEPTION 'the pre-enrolment workflow broke: an invite no longer covers '
                        'the name it was written with';
    END IF;
END $$;

-- Now a DIFFERENT child is enrolled under that name, after the invite was
-- resolved. This is the whole file.
INSERT INTO camp_people (camp_id, person_id, kind, source_key, name, first_seen)
VALUES ('a3200000-0000-0000-0000-000000000001', 9003, 'camper',
        'Future Child', 'Future Child', now() + interval '1 day');

DO $$
BEGIN
    -- BEFORE 232 both of these returned true.
    IF public._invite_covers_person('a3200000-0000-0000-0000-00000000b002', 9003) THEN
        RAISE EXCEPTION 'a later arrival was claimed by a waiting null slot — 232''s '
                        'bound is not working';
    END IF;
    IF public._invite_covers_camper('a3200000-0000-0000-0000-00000000b002',
                                    'Future Child') THEN
        RAISE EXCEPTION 'the name-shaped wrapper still reaches a later arrival';
    END IF;
    -- And the parent gate built on it says no.
    IF public._invite_covers_camper('a3200000-0000-0000-0000-00000000b002', 'Present Child') THEN
        RAISE EXCEPTION 'an invite reaches a camper it never named';
    END IF;
END $$;

-- ─── 3. and the verifier counts it as closed ────────────────────────────────
DO $$
DECLARE v jsonb;
BEGIN
    v := public.verify_parent_invite_identity();
    IF (v->>'slots_a_later_arrival_could_claim')::bigint <> 0 THEN
        RAISE EXCEPTION 'verify_parent_invite_identity reports a claimable slot: %', v;
    END IF;
    -- And the queue is NOT zero: there is a later arrival waiting for a
    -- decision. If this were 0 the assertion above would pass for the wrong
    -- reason — nothing to claim rather than a claim refused.
    IF (v->>'slots_awaiting_a_decision')::bigint < 1 THEN
        RAISE EXCEPTION 'the restamp queue is empty, so the refusal above proves nothing: %', v;
    END IF;
    IF (v->>'invites_without_a_resolution_mark')::bigint <> 0 THEN
        RAISE EXCEPTION 'an active invite carries no resolution mark: %', v;
    END IF;
    IF (v->>'entries_with_a_null_id_slot')::bigint < 1 THEN
        RAISE EXCEPTION 'the null slot vanished — this test proves nothing: %', v;
    END IF;
END $$;

-- ─── 4. the deliberate decision attaches the later arrival ──────────────────
-- Fail-closed is only tolerable because somebody can say yes. As the camp owner.
-- Become the camp owner. The harness stubs auth.uid() as a function, so a
-- caller is impersonated by redefining it — transactional, so the ROLLBACK at
-- the end puts it back.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS 'SELECT ''a3200000-0000-0000-0000-0000000000aa''::uuid';

DO $$
DECLARE v jsonb;
BEGIN
    -- The office can see what needs a decision before making one.
    v := public.parent_invites_needing_attention('a3200000-0000-0000-0000-000000000001');
    IF (v->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'the attention list refused the owner: %', v;
    END IF;
    IF (v->>'count')::int < 1 THEN
        RAISE EXCEPTION 'the attention list is empty while a slot needs a person: %', v;
    END IF;
    IF NOT (v->'invites')::text LIKE '%Future Child%' THEN
        RAISE EXCEPTION 'the attention list does not name the camper at issue: %', v;
    END IF;

    v := public.restamp_parent_invite('a3200000-0000-0000-0000-00000000b002');
    IF (v->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'restamp refused the camp owner: %', v;
    END IF;
    IF v->'now' <> '[9003]'::jsonb THEN
        RAISE EXCEPTION 'restamp did not attach the enrolled camper: %', v;
    END IF;
END $$;

DO $$
BEGIN
    -- And now the parent can act — decided on an id, not on the name.
    IF NOT public._invite_covers_person('a3200000-0000-0000-0000-00000000b002', 9003) THEN
        RAISE EXCEPTION 'a restamped invite still does not cover its camper';
    END IF;
END $$;

-- ─── 5. a stranger cannot restamp ───────────────────────────────────────────
-- Become the invited parent, who is not an admin of the camp.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS 'SELECT ''a3200000-0000-0000-0000-0000000000b2''::uuid';

DO $$
DECLARE v jsonb;
BEGIN
    -- The invited parent is not an admin of the camp.
    v := public.restamp_parent_invite('a3200000-0000-0000-0000-00000000b002');
    IF (v->>'error') IS DISTINCT FROM 'forbidden' THEN
        RAISE EXCEPTION 'a parent was allowed to restamp their own invite: %', v;
    END IF;
    v := public.parent_invites_needing_attention('a3200000-0000-0000-0000-000000000001');
    IF (v->>'error') IS DISTINCT FROM 'forbidden' THEN
        RAISE EXCEPTION 'a parent can read the camp''s attention list: %', v;
    END IF;
END $$;

-- ─── 6. an invite naming nobody still covers the camp ───────────────────────
-- Become the camp owner. The harness stubs auth.uid() as a function, so a
-- caller is impersonated by redefining it — transactional, so the ROLLBACK at
-- the end puts it back.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS 'SELECT ''a3200000-0000-0000-0000-0000000000aa''::uuid';

INSERT INTO link_parent_invites
    (id, camp_id, user_id, token, parent_name, parent_email, camper_names, status)
VALUES ('a3200000-0000-0000-0000-00000000b003',
        'a3200000-0000-0000-0000-000000000001',
        'a3200000-0000-0000-0000-0000000000b3', 'tok-b3', 'Whole Camp',
        'camp@example.com', NULL, 'active');

DO $$
DECLARE v jsonb;
BEGIN
    IF NOT public._invite_covers_person('a3200000-0000-0000-0000-00000000b003', 9001) THEN
        RAISE EXCEPTION 'a camp-wide invite stopped covering the camp';
    END IF;
    -- Restamping one has nothing to resolve but must still move the mark rather
    -- than leave a row the bound cannot answer for.
    v := public.restamp_parent_invite('a3200000-0000-0000-0000-00000000b003');
    IF (v->>'camp_wide')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'restamp did not recognise a camp-wide invite: %', v;
    END IF;
END $$;

-- ─── 6b. an insert that supplies person_ids still gets a mark ───────────────
-- 223's trigger returns EARLY when the caller supplies person_ids. 232 sets the
-- mark before that return, and this is the only case that proves it: every other
-- invite in this file leaves person_ids to the trigger, so the mark would be set
-- on the way past either way. Without this, moving the assignment below the early
-- return is a mutation no test notices — and an unmarked invite is one the gate
-- refuses outright.
INSERT INTO link_parent_invites
    (id, camp_id, user_id, token, parent_name, parent_email, camper_names,
     person_ids, status)
VALUES ('a3200000-0000-0000-0000-00000000b005',
        'a3200000-0000-0000-0000-000000000001',
        'a3200000-0000-0000-0000-0000000000b5', 'tok-b5', 'Explicit Parent',
        'explicit@example.com', '["Present Child"]'::jsonb, '[9001]'::jsonb, 'active');

DO $$
DECLARE r record;
BEGIN
    SELECT person_ids, person_ids_resolved_at IS NOT NULL AS marked
      INTO r FROM link_parent_invites
     WHERE id = 'a3200000-0000-0000-0000-00000000b005';
    IF NOT r.marked THEN
        RAISE EXCEPTION '232 left an invite unmarked because the caller supplied person_ids';
    END IF;
    IF r.person_ids <> '[9001]'::jsonb THEN
        RAISE EXCEPTION 'the caller''s own person_ids were overwritten: %', r.person_ids;
    END IF;
END $$;


-- ─── 7. two campers sharing a name are still refused, never guessed ─────────
-- Getting to a genuinely ambiguous name takes more care than it looks, and it
-- is worth writing down because it also explains why verify_camper_ownership()
-- reports names_matching_two_campers: 0 on live data.
--
-- uq_camp_people_source is UNIQUE (camp_id, kind, source_key) and is NOT
-- partial, so within one camp no two campers can share a spelling exactly.
-- camp_person_by_name's rank 1 is an exact match, so rank 1 can never tie:
-- ambiguity is only reachable at rank 2/3, where the comparison is
-- lower(btrim(...)) and two DIFFERENT stored spellings fold together.
--
-- So: two roster entries differing only in case, queried with a third spelling
-- that matches neither exactly. Rank 1 is empty, rank 2 ties on two ids, and
-- camp_person_by_name returns NULL rather than picking one.
INSERT INTO camp_people (camp_id, person_id, kind, source_key, name, first_seen)
VALUES ('a3200000-0000-0000-0000-000000000001', 9004, 'camper',
        'Twin Name', 'Twin Name', now() - interval '10 days'),
       ('a3200000-0000-0000-0000-000000000001', 9005, 'camper',
        'twin name', 'Twin Name Two', now() - interval '10 days');

INSERT INTO link_parent_invites
    (id, camp_id, user_id, token, parent_name, parent_email, camper_names, status)
VALUES ('a3200000-0000-0000-0000-00000000b004',
        'a3200000-0000-0000-0000-000000000001',
        'a3200000-0000-0000-0000-0000000000b4', 'tok-b4', 'Twin Parent',
        'twin@example.com', '["TWIN NAME"]'::jsonb, 'active');

DO $$
BEGIN
    -- camp_person_by_name returns NULL for an ambiguous name, and the UNKNOWN
    -- branch refuses rather than picking one.
    IF public.camp_person_by_name('a3200000-0000-0000-0000-000000000001',
                                  'TWIN NAME') IS NOT NULL THEN
        RAISE EXCEPTION 'an ambiguous spelling resolved to a single camper';
    END IF;
    IF public._invite_covers_camper('a3200000-0000-0000-0000-00000000b004', 'TWIN NAME') THEN
        RAISE EXCEPTION 'an ambiguous name was resolved to one of two campers';
    END IF;
    -- And the unambiguous spellings still work, so the refusal above is about
    -- ambiguity and not about the rows being unreachable.
    IF public.camp_person_by_name('a3200000-0000-0000-0000-000000000001',
                                  'Twin Name') <> 9004 THEN
        RAISE EXCEPTION 'an exact spelling stopped resolving';
    END IF;
END $$;

ROLLBACK;
