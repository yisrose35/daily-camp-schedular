-- Behaviour test for 224. This file decides who may read a child's health
-- documents, so "it applied" is worth nothing here. Nine things are proved, and
-- they pull in opposite directions on purpose: four are about not locking a
-- legitimate parent out, and the rest are about not letting the wrong one in.
--
--   1. A RENAME no longer locks a parent out. The win.
--   2. TWO CAMPERS, ONE NAME is refused — for both parents — and the verifier
--      names the collision. The hole.
--   3. A camper added to the roster AFTER the invite was sent still reaches
--      their parent (the null slot is re-resolved, not treated as a refusal).
--   4. An invite written before 223, with no person_ids at all, still works.
--   5. The camp-wide wildcard still covers the camp.
--   6. Case and trailing space resolve to the same child.
--   7. A name on nobody's roster still falls back to the invite's own list.
--   8. Another camp's parent, an expired invite and a revoked invite all get
--      nothing.
--   9. verify_my_camper spans camps when given no camp, and refuses a camp id
--      that is not a uuid rather than widening to every camp.

\set ON_ERROR_STOP on

-- auth.uid() has to vary per parent for any of this to mean anything.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION public.camp_reader(p_camp_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$ SELECT true $$;

-- ── the camp, its roster, and four parents ──────────────────────────────────
DO $$
DECLARE
    camp  uuid := 'f2400000-0000-0000-0000-000000000001';
    other uuid := 'f2400000-0000-0000-0000-000000000002';
    owner uuid := 'f2400000-0000-0000-0000-0000000000ff';
BEGIN
    INSERT INTO camps (id, owner, name) VALUES (camp, owner, 'Ownership Camp'),
                                              (other, owner, 'Another Camp');
    -- Two children called Chaim Katz, on purpose: that is the collision.
    -- 216 keys camp_people on the ROSTER KEY, so the camp distinguishes them in
    -- the document even though the displayed name is the same.
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES (camp, 'app1', jsonb_build_object(
        'camperRoster', jsonb_build_object(
            'Ayala Weiss',   jsonb_build_object('camperId', '880', 'name', 'Ayala Weiss'),
            'Dov Lerner',    jsonb_build_object('camperId', '881', 'name', 'Dov Lerner'),
            'Chaim Katz',    jsonb_build_object('camperId', '890', 'name', 'Chaim Katz'),
            'chaim katz  ',  jsonb_build_object('camperId', '891', 'name', 'Chaim Katz'))));
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES (other, 'app1', jsonb_build_object(
        'camperRoster', jsonb_build_object(
            'Ayala Weiss', jsonb_build_object('camperId', '4', 'name', 'Ayala Weiss'))));

    IF (SELECT count(*) FROM camp_people WHERE camp_id = camp AND kind = 'camper') <> 4 THEN
        RAISE EXCEPTION 'the roster did not project four campers — nothing below would mean anything';
    END IF;
END $$;

-- Invites. The stamping trigger from 223 fills person_ids on insert, except
-- where it is deliberately switched off to reproduce a pre-223 row.
INSERT INTO link_parent_invites (camp_id, user_id, parent_name, camper_names, status) VALUES
    ('f2400000-0000-0000-0000-000000000001', 'f2400000-0000-0000-0000-00000000a001',
     'Weiss parent',  jsonb_build_array('Ayala Weiss'),   'active'),
    ('f2400000-0000-0000-0000-000000000001', 'f2400000-0000-0000-0000-00000000a002',
     'Katz parent A', jsonb_build_array('Chaim Katz'),    'active'),
    ('f2400000-0000-0000-0000-000000000001', 'f2400000-0000-0000-0000-00000000a003',
     'Not yet',       jsonb_build_array('Later Arrival'),  'active'),
    ('f2400000-0000-0000-0000-000000000001', 'f2400000-0000-0000-0000-00000000a004',
     'Whole camp',    NULL,                               'active'),
    ('f2400000-0000-0000-0000-000000000001', 'f2400000-0000-0000-0000-00000000a005',
     'Expired',       jsonb_build_array('Dov Lerner'),    'active'),
    ('f2400000-0000-0000-0000-000000000001', 'f2400000-0000-0000-0000-00000000a006',
     'Revoked',       jsonb_build_array('Dov Lerner'),    'revoked'),
    ('f2400000-0000-0000-0000-000000000002', 'f2400000-0000-0000-0000-00000000a007',
     'Other camp',    jsonb_build_array('Ayala Weiss'),   'active'),
    -- A parent who typed the name in capitals. Their invite therefore contains
    -- the exact ambiguous string, which is what makes the collision reachable
    -- through the old name-containment path: `['CHAIM KATZ'] ? 'CHAIM KATZ'` is
    -- true, and it is true for whichever of the two children the row is about.
    ('f2400000-0000-0000-0000-000000000001', 'f2400000-0000-0000-0000-00000000a009',
     'Katz parent B', jsonb_build_array('CHAIM KATZ'),    'active');
UPDATE link_parent_invites SET expires_at = now() - interval '1 day' WHERE parent_name = 'Expired';

-- A pre-223 invite: named, active, and no person_ids at all. The trigger is
-- disabled so the row is genuinely un-stamped, the way one written before 223
-- existed would be — the reader has to tolerate a NULL person_ids, not just an
-- array with nulls in it.
ALTER TABLE public.link_parent_invites DISABLE TRIGGER trg_stamp_invite_person_ids;
INSERT INTO link_parent_invites (camp_id, user_id, parent_name, camper_names, status)
     VALUES ('f2400000-0000-0000-0000-000000000001', 'f2400000-0000-0000-0000-00000000a008',
             'Pre-223', jsonb_build_array('Dov Lerner'), 'active');
-- ★ AND THEN WHAT 232'S BACKFILL DID TO EVERY SUCH ROW, which is the part this
--   fixture was missing. 232 ends with an unconditional
--       UPDATE link_parent_invites SET … person_ids_resolved_at = now()
--   over every existing invite, so after 232 there is no invite anywhere with a
--   NULL mark. Leaving it null here manufactured a state the migration guarantees
--   cannot exist, and then failed because 232's name fallback requires the mark —
--   reporting a regression that no live camp can reach.
--
--   person_ids is left NULL on purpose: that IS what section 4 tests, and it is
--   still reachable (232 only fills it when camper_names is an array, and a camp
--   whose names resolve to nobody keeps a NULL there).
UPDATE link_parent_invites SET person_ids_resolved_at = now()
 WHERE parent_name = 'Pre-223';
ALTER TABLE public.link_parent_invites ENABLE TRIGGER trg_stamp_invite_person_ids;

DO $$
BEGIN
    IF (SELECT person_ids FROM link_parent_invites WHERE parent_name = 'Pre-223') IS NOT NULL THEN
        RAISE EXCEPTION 'the pre-223 invite was stamped anyway — test 4 would be vacuous';
    END IF;
    IF (SELECT person_ids FROM link_parent_invites WHERE parent_name = 'Weiss parent')
       IS DISTINCT FROM jsonb_build_array(880) THEN
        RAISE EXCEPTION 'the Weiss invite was not stamped: %',
            (SELECT person_ids FROM link_parent_invites WHERE parent_name = 'Weiss parent');
    END IF;
END $$;


-- ── 1. a rename does not lock a parent out ──────────────────────────────────
SET test.uid = 'f2400000-0000-0000-0000-00000000a001';
DO $$
DECLARE camp uuid := 'f2400000-0000-0000-0000-000000000001';
BEGIN
    IF NOT public._parent_owns_camper(camp, 'Ayala Weiss') THEN
        RAISE EXCEPTION 'a parent cannot reach their own child before any rename';
    END IF;

    -- The camp renames her. The roster key moves with her — 216 relabels the
    -- row rather than minting a second id — and the invite still says the old
    -- name. Under the old `camper_names ? name` rule she is now unreachable by
    -- BOTH spellings: the invite does not know the new one, and the roster no
    -- longer has the old one.
    UPDATE camp_state_kv SET value = jsonb_set(value, '{camperRoster}', jsonb_build_object(
        'Ayala Weiss-Katz', jsonb_build_object('camperId', '880', 'name', 'Ayala Weiss-Katz'),
        'Dov Lerner',       jsonb_build_object('camperId', '881', 'name', 'Dov Lerner'),
        'Chaim Katz',       jsonb_build_object('camperId', '890', 'name', 'Chaim Katz'),
        'chaim katz  ',     jsonb_build_object('camperId', '891', 'name', 'Chaim Katz')))
     WHERE camp_id = camp AND key = 'app1';

    IF (SELECT person_id FROM camp_people
         WHERE camp_id = camp AND source_key = 'Ayala Weiss-Katz') IS DISTINCT FROM 880 THEN
        RAISE EXCEPTION 'the rename did not carry the id — 216 is not behaving, so this test '
                        'cannot say anything about 224';
    END IF;

    -- Reached by her NEW name, because the invite's stored id still points at
    -- her and the new name resolves to that id.
    IF NOT public._parent_owns_camper(camp, 'Ayala Weiss-Katz') THEN
        RAISE EXCEPTION 'a rename locked a parent out of their own child — the one thing this '
                        'file exists to prevent';
    END IF;
    RAISE NOTICE '224: a rename no longer locks a parent out';
END $$;


-- ── 2. two campers, one name: refused, for both parents ─────────────────────
SET test.uid = 'f2400000-0000-0000-0000-00000000a002';
DO $$
DECLARE
    camp uuid := 'f2400000-0000-0000-0000-000000000001';
    v    jsonb;
BEGIN
    -- 'Chaim Katz' and 'chaim katz  ' are two different children with two
    -- different ids. Asking by the shared display name cannot say which, and
    -- the old rule answered "both".
    IF public._parent_owns_camper(camp, 'CHAIM KATZ') THEN
        RAISE EXCEPTION 'an ambiguous name was granted — that is one child''s health documents '
                        'shown to another child''s parent';
    END IF;

    -- The exact roster key is NOT ambiguous, and this parent's invite holds
    -- 890, so their own child is still reachable. Refusing that too would make
    -- the fix worse than the bug.
    IF NOT public._parent_owns_camper(camp, 'Chaim Katz') THEN
        RAISE EXCEPTION 'the exact roster key was refused — uq_camp_people_source makes it '
                        'unique, so it is never ambiguous';
    END IF;

    -- And this parent must not reach the OTHER Chaim Katz.
    IF public._parent_owns_person(camp, 891) THEN
        RAISE EXCEPTION 'a parent reached the other child of the same name by id';
    END IF;

    -- And the parent whose invite literally SPELLS the ambiguous name. This is
    -- the one the old rule granted: `['CHAIM KATZ'] ? 'CHAIM KATZ'` is true, and
    -- it is equally true whichever of the two children the row belongs to. They
    -- are refused now, which is also a real cost — they cannot reach their own
    -- child until the camp makes the two roster entries distinguishable. That is
    -- why the verifier has to name the collision.
    PERFORM set_config('test.uid', 'f2400000-0000-0000-0000-00000000a009', false);
    IF public._parent_owns_camper(camp, 'CHAIM KATZ') THEN
        RAISE EXCEPTION 'an invite spelling the ambiguous name was granted — that is the breach: '
                        'the grant does not say WHICH child, so it covers both';
    END IF;
    PERFORM set_config('test.uid', 'f2400000-0000-0000-0000-00000000a002', false);

    v := public.verify_camper_ownership();
    IF (v ->> 'names_matching_two_campers')::bigint < 1 THEN
        RAISE EXCEPTION 'the verifier does not see the collision it just refused: %', v;
    END IF;
    IF NOT (v -> 'ambiguous_names') @> jsonb_build_array(
             jsonb_build_object('camp_id', camp::text, 'name', 'Chaim Katz')) THEN
        RAISE EXCEPTION 'the verifier does not NAME the collision, so nobody can fix it: %',
                        v -> 'ambiguous_names';
    END IF;
    RAISE NOTICE '224: a shared name is refused for both parents, and the verifier names it';
END $$;


-- ── 3. a camper added after the invite is REFUSED, reported, and repairable ─
-- THIS SECTION USED TO ASSERT THE OPPOSITE, and the change is deliberate.
--
-- 224 shipped with the null slot being re-resolved by name at check time, so a
-- camper added after her invite was sent became reachable the moment she appeared.
-- Migration 232 stopped that: "a matching name that appeared later" cannot be told
-- apart from "a DIFFERENT child with the same name who appeared later", and the
-- second one hands a parent somebody else's child. Section 3b below is that case,
-- and it is why the refusal is worth the inconvenience.
--
-- So the rule is now three parts, and all three have to hold or the office is
-- stuck with a parent who cannot see their own child and no way to know:
--   a. she is refused,
--   b. parent_invites_needing_attention NAMES her, with the repair,
--   c. restamping attaches her.
--
-- On the app side campistry_me.js closes the window at the source —
-- enrollCamper refreshes the family's invite when it creates the roster entry —
-- so the ordinary Accept-then-Enroll flow never reaches state (a).
-- tests/invite_stamp_on_roster_write.test.js holds that.
SET test.uid = 'f2400000-0000-0000-0000-00000000a003';
DO $$
DECLARE
    camp      uuid := 'f2400000-0000-0000-0000-000000000001';
    v_invite  uuid;
    v         jsonb;
BEGIN
    SELECT id INTO v_invite FROM link_parent_invites WHERE parent_name = 'Not yet';

    -- The invite named 'Later Arrival' before she was on the roster, so 223
    -- stamped a null in her slot.
    IF (SELECT person_ids FROM link_parent_invites WHERE id = v_invite)
       IS DISTINCT FROM jsonb_build_array(null) THEN
        RAISE EXCEPTION 'expected a null slot, got %',
            (SELECT person_ids FROM link_parent_invites WHERE id = v_invite);
    END IF;

    -- ★ BACKDATE THE STAMP, or this whole section proves nothing.
    --
    -- 232's test is `p.first_seen <= i.person_ids_resolved_at`, and now() is the
    -- TRANSACTION clock: an invite and a camper created in the same transaction
    -- share a timestamp to the microsecond, the <= holds, and she reads as
    -- reachable no matter what the rule says. (I wrote that version first and it
    -- passed for exactly that reason.) An hour is not a real interval here — it is
    -- the difference between "before the stamp" and "after it".
    UPDATE link_parent_invites SET person_ids_resolved_at = now() - interval '1 hour'
     WHERE id = v_invite;

    -- Now the camp adds her, which is when her camp_people row is born.
    UPDATE camp_state_kv
       SET value = jsonb_set(value, '{camperRoster,Later Arrival}',
                             jsonb_build_object('camperId', '905', 'name', 'Later Arrival'))
     WHERE camp_id = camp AND key = 'app1';

    IF NOT EXISTS (SELECT 1 FROM camp_people p, link_parent_invites i
                    WHERE p.camp_id = camp AND p.person_id = 905 AND i.id = v_invite
                      AND p.first_seen > i.person_ids_resolved_at) THEN
        RAISE EXCEPTION 'she did not arrive after the stamp, so the rule under test is not '
                        'the one being exercised';
    END IF;

    -- a. refused, because the name alone cannot prove she is the child meant.
    IF public._parent_owns_camper(camp, 'Later Arrival') THEN
        RAISE EXCEPTION 'a camper who appeared AFTER the invite was stamped was accepted on '
                        'her name alone — 232''s containment is open again';
    END IF;

    -- b. and said out loud, by name, with the line that fixes it. A refusal the
    --    office cannot see is indistinguishable from the portal being broken.
    --
    --    AS THE OWNER, not as the parent: 232 gates the report behind _is_camp_admin,
    --    which is right — a parent must not be able to enumerate a camp's invites.
    --    Read as the parent it answers {"error":"forbidden"}, and the two checks
    --    below then compared NULL and did not fire. Same shape as the defect 239
    --    fixed, in a test about that very shape. So `success` is asserted FIRST and
    --    everything after it can be trusted.
    PERFORM set_config('test.uid', 'f2400000-0000-0000-0000-0000000000ff', false);
    v := public.parent_invites_needing_attention(camp);
    IF COALESCE((v ->> 'success')::boolean, false) IS NOT TRUE THEN
        RAISE EXCEPTION 'the report refused the camp owner: %', v;
    END IF;
    IF COALESCE((v ->> 'count')::bigint, 0) < 1 THEN
        RAISE EXCEPTION 'nothing reported her, so the office has no way to find out: %', v;
    END IF;
    IF NOT (v -> 'invites') @> jsonb_build_array(
             jsonb_build_object('camper_name', 'Later Arrival')) THEN
        RAISE EXCEPTION 'the report does not NAME her: %', v -> 'invites';
    END IF;
    IF COALESCE(v -> 'invites' -> 0 ->> 'to_fix', '') = '' THEN
        RAISE EXCEPTION 'the report names her but does not say how to fix it: %', v;
    END IF;

    -- c. and a restamp attaches her. Also the owner's to run, for the same reason.
    IF COALESCE((public.restamp_parent_invite(v_invite) ->> 'success')::boolean, false)
       IS NOT TRUE THEN
        RAISE EXCEPTION 'the restamp itself was refused: %',
            public.restamp_parent_invite(v_invite);
    END IF;

    -- Back to the parent, because whether SHE can reach her child is a question
    -- about the parent's session, not the owner's.
    PERFORM set_config('test.uid', 'f2400000-0000-0000-0000-00000000a003', false);
    IF NOT public._parent_owns_camper(camp, 'Later Arrival') THEN
        RAISE EXCEPTION 'a restamp did not attach her, so the repair does not repair';
    END IF;
    IF NOT public._parent_owns_person(camp, 905) THEN
        RAISE EXCEPTION 'attached by name but not by id';
    END IF;
    IF (SELECT person_ids FROM link_parent_invites WHERE id = v_invite)
       IS DISTINCT FROM jsonb_build_array(905) THEN
        RAISE EXCEPTION 'the restamp did not write her id into the slot: %',
            (SELECT person_ids FROM link_parent_invites WHERE id = v_invite);
    END IF;

    -- and she is no longer reported, or the office would chase a fixed problem.
    PERFORM set_config('test.uid', 'f2400000-0000-0000-0000-0000000000ff', false);
    v := public.parent_invites_needing_attention(camp);
    IF COALESCE((v ->> 'success')::boolean, false) IS NOT TRUE THEN
        RAISE EXCEPTION 'the second read of the report refused the owner: %', v;
    END IF;
    IF (v -> 'invites') @> jsonb_build_array(
             jsonb_build_object('camper_name', 'Later Arrival')) THEN
        RAISE EXCEPTION 'still reported after the repair: %', v -> 'invites';
    END IF;

    RAISE NOTICE '224: a camper who arrives after the stamp is refused, reported and repairable';
END $$;


-- ── 3b. WHY the refusal is worth it: a stranger's child with the same name ──
-- The other side of the same rule. Without it, section 3's convenience would let
-- any later-added camper matching a name on an invite be claimed by that parent.
DO $$
DECLARE
    camp uuid := 'f2400000-0000-0000-0000-000000000001';
    v_invite uuid;
BEGIN
    SELECT id INTO v_invite FROM link_parent_invites WHERE parent_name = 'Not yet';
    -- Her invite is stamped and current again after the repair above, so push it
    -- back once more: the question is whether a name that appears LATER can be
    -- claimed, and that needs the arrival to be after the stamp.
    UPDATE link_parent_invites SET person_ids_resolved_at = now() - interval '1 hour'
     WHERE id = v_invite;

    -- A second, unrelated child called 'Later Arrival' joins. This parent's invite
    -- names that spelling, and she is NOT their child.
    UPDATE camp_state_kv
       SET value = jsonb_set(value, '{camperRoster,Later Arrival #2}',
                             jsonb_build_object('camperId', '906', 'name', 'Later Arrival'))
     WHERE camp_id = camp AND key = 'app1';

    PERFORM set_config('test.uid', 'f2400000-0000-0000-0000-00000000a003', false);
    IF public._parent_owns_person(camp, 906) THEN
        RAISE EXCEPTION 'a parent reached a DIFFERENT family''s child because the name on '
                        'their invite happened to match — this is the failure 232 exists to '
                        'prevent, and it is worse than the inconvenience in section 3';
    END IF;
    RAISE NOTICE '224: and a stranger''s same-named child added later is still refused';
END $$;


-- ── 4, 5, 6, 7. pre-223 invites, the wildcard, fuzz, and unknown names ──────
DO $$
DECLARE camp uuid := 'f2400000-0000-0000-0000-000000000001';
BEGIN
    -- 4. an invite with no person_ids column value at all
    PERFORM set_config('test.uid', 'f2400000-0000-0000-0000-00000000a008', false);
    IF NOT public._parent_owns_camper(camp, 'Dov Lerner') THEN
        RAISE EXCEPTION 'an invite written before 223 stopped working';
    END IF;

    -- 5. the camp-wide wildcard, unchanged
    PERFORM set_config('test.uid', 'f2400000-0000-0000-0000-00000000a004', false);
    IF NOT public._parent_owns_camper(camp, 'Dov Lerner')
       OR NOT public._parent_owns_camper(camp, 'Ayala Weiss-Katz')
       OR NOT public._parent_owns_person(camp, 881) THEN
        RAISE EXCEPTION 'an invite naming no campers stopped covering the camp';
    END IF;

    -- 6. case and trailing space reach the same child
    PERFORM set_config('test.uid', 'f2400000-0000-0000-0000-00000000a008', false);
    IF NOT public._parent_owns_camper(camp, '  dov LERNER ') THEN
        RAISE EXCEPTION 'a trailing space locked a parent out';
    END IF;

    -- 7. a name on nobody's roster still falls back to the invite's list — a
    --    parent must not be refused because the office has not typed their
    --    child in yet.
    PERFORM set_config('test.uid', 'f2400000-0000-0000-0000-00000000a003', false);
    UPDATE link_parent_invites
       SET camper_names = jsonb_build_array('Later Arrival', 'Never Enrolled')
     WHERE parent_name = 'Not yet';
    IF NOT public._parent_owns_camper(camp, 'Never Enrolled') THEN
        RAISE EXCEPTION 'a child who is not on the roster is unreachable by the parent whose '
                        'invite names them';
    END IF;
    RAISE NOTICE '224: pre-223 invites, the wildcard, fuzzy names and not-yet-enrolled children '
                 'all still work';
END $$;


-- ── 8. everybody else gets nothing ──────────────────────────────────────────
DO $$
DECLARE
    camp  uuid := 'f2400000-0000-0000-0000-000000000001';
    other uuid := 'f2400000-0000-0000-0000-000000000002';
BEGIN
    -- another camp's parent, asking about this camp
    PERFORM set_config('test.uid', 'f2400000-0000-0000-0000-00000000a007', false);
    IF public._parent_owns_camper(camp, 'Ayala Weiss-Katz')
       OR public._parent_owns_person(camp, 880) THEN
        RAISE EXCEPTION 'a parent from another camp reached this camp''s camper';
    END IF;
    -- and their own camp still works, so the refusal above is about scope and
    -- not about the function being broken
    IF NOT public._parent_owns_camper(other, 'Ayala Weiss') THEN
        RAISE EXCEPTION 'that parent cannot reach their own child either — the test above proves '
                        'nothing';
    END IF;

    -- expired
    PERFORM set_config('test.uid', 'f2400000-0000-0000-0000-00000000a005', false);
    IF public._parent_owns_camper(camp, 'Dov Lerner') OR public._parent_owns_person(camp, 881) THEN
        RAISE EXCEPTION 'an expired invite still grants access';
    END IF;

    -- revoked
    PERFORM set_config('test.uid', 'f2400000-0000-0000-0000-00000000a006', false);
    IF public._parent_owns_camper(camp, 'Dov Lerner') OR public._parent_owns_person(camp, 881) THEN
        RAISE EXCEPTION 'a revoked invite still grants access';
    END IF;

    -- nobody at all
    PERFORM set_config('test.uid', '', false);
    IF public._parent_owns_camper(camp, 'Dov Lerner') OR public._parent_owns_person(camp, 881) THEN
        RAISE EXCEPTION 'an unauthenticated caller was granted access';
    END IF;
    RAISE NOTICE '224: another camp, an expired invite, a revoked invite and no session all get '
                 'nothing';
END $$;


-- ── 9. verify_my_camper ─────────────────────────────────────────────────────
DO $$
DECLARE camp text := 'f2400000-0000-0000-0000-000000000001';
BEGIN
    PERFORM set_config('test.uid', 'f2400000-0000-0000-0000-00000000a001', false);
    IF NOT public.verify_my_camper(camp, 'Ayala Weiss-Katz') THEN
        RAISE EXCEPTION 'verify_my_camper refuses a parent''s own renamed child';
    END IF;
    -- No camp given means "any camp this parent has an invite for".
    IF NOT public.verify_my_camper('', 'Ayala Weiss-Katz')
       OR NOT public.verify_my_camper(NULL, 'Ayala Weiss-Katz') THEN
        RAISE EXCEPTION 'verify_my_camper stopped spanning camps when given none';
    END IF;
    -- A camp id that is not a uuid must refuse, not fall through to "any camp":
    -- that would turn a malformed argument into a wider grant.
    IF public.verify_my_camper('not-a-uuid', 'Ayala Weiss-Katz') THEN
        RAISE EXCEPTION 'a malformed camp id widened the check instead of refusing it';
    END IF;
    -- And the collision is refused here too.
    PERFORM set_config('test.uid', 'f2400000-0000-0000-0000-00000000a002', false);
    IF public.verify_my_camper(camp, 'CHAIM KATZ') THEN
        RAISE EXCEPTION 'verify_my_camper still grants an ambiguous name';
    END IF;
    RAISE NOTICE '224: verify_my_camper spans camps without a camp, refuses a malformed one, '
                 'and refuses the collision';
END $$;

RESET test.uid;
