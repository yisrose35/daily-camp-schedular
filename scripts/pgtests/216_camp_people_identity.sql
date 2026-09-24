-- Behaviour test for 216. Run by scripts/try_migration.sh after the migration
-- applies. Every check RAISEs on failure, so a green run means all of it held.
--
-- What is worth testing here is not "does a row appear" but the four promises
-- the file makes: a stated id is never overridden, a gap is filled without
-- treading on anyone, one number is one person across BOTH kinds, and a save
-- that rewrites the whole roster does not re-derive the whole roster.

\set ON_ERROR_STOP on

-- camp_reader is owner-only and auth.uid() is NULL in this harness, so
-- verify_camp_people would answer not_your_camp. Open it for the test only.
CREATE OR REPLACE FUNCTION public.camp_reader(p_camp_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$ SELECT true $$;

DO $$
DECLARE
    c1 uuid := '11111111-1111-1111-1111-111111111111';
    c2 uuid := '22222222-2222-2222-2222-222222222222';
    v  jsonb;
    n  bigint;
    m  bigint;
    cnt integer;
BEGIN
    INSERT INTO camps (id, owner, name) VALUES (c1, NULL, 'Test Camp'), (c2, NULL, 'Other Camp');

    -- ── 1. a camp that brings its own numbers ───────────────────────────────
    -- Two campers with four-digit ids the camp printed on forms, one with none,
    -- and a leading-zero id that must normalise to 42.
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES (c1, 'app1', jsonb_build_object(
        'camperRoster', jsonb_build_object(
            'Chaim Katz',  jsonb_build_object('camperId', '1041', 'name', 'Chaim Katz'),
            'Rivka Stern', jsonb_build_object('camperId', '1042', 'name', 'Rivka Stern'),
            'Zero Padded', jsonb_build_object('camperId', '0042', 'name', 'Zero Padded'),
            'No Number',   jsonb_build_object('name', 'No Number'))));

    IF (SELECT person_id FROM camp_people
         WHERE camp_id = c1 AND source_key = 'Chaim Katz') <> 1041 THEN
        RAISE EXCEPTION 'a stated id was not honoured';
    END IF;
    IF (SELECT person_id FROM camp_people
         WHERE camp_id = c1 AND source_key = 'Zero Padded') <> 42 THEN
        RAISE EXCEPTION 'leading zeros were not stripped — 0042 must be 42, as normalizePersonId does';
    END IF;
    IF (SELECT minted FROM camp_people WHERE camp_id = c1 AND source_key = 'Chaim Katz') THEN
        RAISE EXCEPTION 'an id the camp chose was recorded as minted';
    END IF;

    SELECT person_id INTO n FROM camp_people WHERE camp_id = c1 AND source_key = 'No Number';
    IF n IS NULL THEN RAISE EXCEPTION 'a camper with no id got no row'; END IF;
    IF n IN (1041, 1042, 42) THEN
        RAISE EXCEPTION 'minted id % collided with a number the camp chose', n;
    END IF;
    IF NOT (SELECT minted FROM camp_people WHERE camp_id = c1 AND source_key = 'No Number') THEN
        RAISE EXCEPTION 'a minted id was not flagged as minted';
    END IF;

    -- ── 2. one number, one person — across BOTH kinds ───────────────────────
    -- This is the constraint the app only enforced in the browser. A staff
    -- member claiming a camper's number must not land.
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES (c1, 'campistryMe', jsonb_build_object(
        'staffApplications', jsonb_build_object(
            'app-1', jsonb_build_object('staffId', '1041', 'name', 'Counselor Who Wants 1041'),
            'app-2', jsonb_build_object('staffId', '7000', 'name', 'Counselor Seven Thousand'))));

    IF (SELECT person_id FROM camp_people WHERE camp_id = c1 AND source_key = 'Chaim Katz') <> 1041 THEN
        RAISE EXCEPTION 'a staff member took a camper''s number';
    END IF;
    SELECT person_id INTO m FROM camp_people WHERE camp_id = c1 AND source_key = 'app-1';
    IF m = 1041 THEN
        RAISE EXCEPTION 'the same number is on two badges — the whole point of this table';
    END IF;
    IF (SELECT person_id FROM camp_people WHERE camp_id = c1 AND source_key = 'app-2') <> 7000 THEN
        RAISE EXCEPTION 'a free staff id was not honoured';
    END IF;
    IF (SELECT count(*) FROM (SELECT person_id FROM camp_people WHERE camp_id = c1
                              GROUP BY person_id HAVING count(*) > 1) d) <> 0 THEN
        RAISE EXCEPTION 'two people share a number';
    END IF;

    -- ── 3. the conflict is reported, not silently swallowed ─────────────────
    v := public.verify_camp_people(c1);
    IF (v ->> 'idIsUnique') <> 'true' THEN RAISE EXCEPTION 'verifier says ids are not unique: %', v; END IF;
    IF (v ->> 'everyCamperHasRow') <> 'true' THEN RAISE EXCEPTION 'a camper has no row: %', v; END IF;
    IF (v ->> 'campersInDoc') <> '4' OR (v ->> 'campersInRows') <> '4' THEN
        RAISE EXCEPTION 'camper counts disagree: %', v;
    END IF;
    IF (v ->> 'staffInRows') <> '2' THEN RAISE EXCEPTION 'staff rows wrong: %', v; END IF;

    -- (The "an unchanged save touches nothing" check lives at the bottom of
    --  this file, outside the block — see the note there on why it cannot work
    --  inside one transaction.)

    -- ── 5. a rename keeps the number, and creates nobody ────────────────────
    -- The roster is keyed by name, so a rename arrives as a NEW key carrying
    -- the same id while the old key vanishes. Because the id is the identity
    -- and source_key is only the current label, that must RELABEL the one row
    -- — not mint a second person and stamp the first. If it split, the
    -- camper's canteen balance and billing history would stay pinned to a
    -- stamped row and the renamed child would start from zero.
    UPDATE camp_state_kv SET value = jsonb_build_object('camperRoster', jsonb_build_object(
            'Chaim Katz',   jsonb_build_object('camperId', '1041', 'name', 'Chaim Katz'),
            'Rivka Stein',  jsonb_build_object('camperId', '1042', 'name', 'Rivka Stein'),
            'Zero Padded',  jsonb_build_object('camperId', '0042', 'name', 'Zero Padded'),
            'No Number',    jsonb_build_object('name', 'No Number')))
     WHERE camp_id = c1 AND key = 'app1';

    IF (SELECT person_id FROM camp_people
         WHERE camp_id = c1 AND source_key = 'Rivka Stein' AND deleted_at IS NULL) <> 1042 THEN
        RAISE EXCEPTION 'a renamed camper did not carry their number across';
    END IF;
    IF EXISTS (SELECT 1 FROM camp_people WHERE camp_id = c1 AND source_key = 'Rivka Stern') THEN
        RAISE EXCEPTION 'the rename SPLIT into two rows — the old label must be replaced, not kept beside the new';
    END IF;
    IF (SELECT count(*) FROM camp_people
         WHERE camp_id = c1 AND kind = 'camper' AND deleted_at IS NULL) <> 4 THEN
        RAISE EXCEPTION 'a rename changed the number of campers';
    END IF;
    IF (SELECT name FROM camp_people WHERE camp_id = c1 AND person_id = 1042) <> 'Rivka Stein' THEN
        RAISE EXCEPTION 'the row kept the old name';
    END IF;

    -- ── 6. the season reset ─────────────────────────────────────────────────
    -- campistry_me.js:21440 clears camperRoster wholesale. Every id must stay
    -- spoken for, or next season's first camper inherits a stranger's canteen
    -- balance — which is how this project ended up with 354 orphan accounts.
    SELECT count(*) INTO cnt FROM camp_people WHERE camp_id = c1 AND kind = 'camper';
    UPDATE camp_state_kv SET value = jsonb_build_object('camperRoster', '{}'::jsonb)
     WHERE camp_id = c1 AND key = 'app1';
    IF (SELECT count(*) FROM camp_people
         WHERE camp_id = c1 AND kind = 'camper' AND deleted_at IS NULL) <> 0 THEN
        RAISE EXCEPTION 'a cleared roster left live camper rows';
    END IF;
    IF (SELECT count(*) FROM camp_people WHERE camp_id = c1 AND kind = 'camper') <> cnt THEN
        RAISE EXCEPTION 'the season reset destroyed rows instead of stamping them (% before, % after)',
            cnt, (SELECT count(*) FROM camp_people WHERE camp_id = c1 AND kind = 'camper');
    END IF;
    -- and the next number handed out must clear everything ever used
    SELECT public.mint_person_id(c1) INTO n;
    IF EXISTS (SELECT 1 FROM camp_people WHERE camp_id = c1 AND person_id = n) THEN
        RAISE EXCEPTION 'minted % which a (deleted) person already holds', n;
    END IF;

    -- ── 7. camps do not share a number space ────────────────────────────────
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES (c2, 'app1', jsonb_build_object(
        'camperRoster', jsonb_build_object(
            'Someone Else', jsonb_build_object('camperId', '1041', 'name', 'Someone Else'),
            'Dashed Id',    jsonb_build_object('camperId', 'ID-2050', 'name', 'Dashed Id'),
            'Needs One',    jsonb_build_object('name', 'Needs One'))));
    IF (SELECT person_id FROM camp_people WHERE camp_id = c2 AND source_key = 'Someone Else') <> 1041 THEN
        RAISE EXCEPTION 'camp 2 could not use 1041 — ids are unique per CAMP, not globally';
    END IF;

    -- ── 8. an id is digits, wherever the camp typed punctuation ─────────────
    -- normalizePersonId() strips non-digits, so 'ID-2050' is 2050. If the two
    -- disagree the same camper resolves differently in the browser and in the
    -- database, which is the one thing an identity may never do.
    IF (SELECT person_id FROM camp_people WHERE camp_id = c2 AND source_key = 'Dashed Id') <> 2050 THEN
        RAISE EXCEPTION 'ID-2050 did not normalise to 2050 — _person_id disagrees with normalizePersonId';
    END IF;

    -- ── 9. minting steps over numbers that are already taken ────────────────
    -- The counter can legitimately point at a taken number: a camp imports
    -- four-digit ids ABOVE it at any time. Drive the counter onto an occupied
    -- number deliberately — the backfill's ordering usually hides this.
    UPDATE camp_person_seq SET next_id = 1041 WHERE camp_id = c2;
    SELECT public.mint_person_id(c2) INTO n;
    IF n = 1041 OR n = 2050 THEN
        RAISE EXCEPTION 'mint handed out %, which somebody already holds', n;
    END IF;
    IF EXISTS (SELECT 1 FROM camp_people WHERE camp_id = c2 AND person_id = n) THEN
        RAISE EXCEPTION 'mint handed out an occupied number';
    END IF;

    -- ── 10. the counter never starts below what is in use ───────────────────
    v := public.verify_camp_people(c2);
    IF (v ->> 'nextId')::bigint <= 2050 THEN
        RAISE EXCEPTION 'the counter sits at or below a live id (%) — it will grind through taken numbers', v ->> 'nextId';
    END IF;

    -- ── 11. a camp renumbering somebody by hand ─────────────────────────────
    -- The sequence is a fallback: a camp that later types its own number for a
    -- camper we minted for must win, and the person must MOVE rather than
    -- gain a second row.
    SELECT person_id INTO m FROM camp_people WHERE camp_id = c2 AND source_key = 'Needs One';
    UPDATE camp_state_kv SET value = jsonb_build_object('camperRoster', jsonb_build_object(
            'Someone Else', jsonb_build_object('camperId', '1041', 'name', 'Someone Else'),
            'Dashed Id',    jsonb_build_object('camperId', 'ID-2050', 'name', 'Dashed Id'),
            'Needs One',    jsonb_build_object('camperId', '3300', 'name', 'Needs One')))
     WHERE camp_id = c2 AND key = 'app1';
    IF (SELECT person_id FROM camp_people WHERE camp_id = c2 AND source_key = 'Needs One') <> 3300 THEN
        RAISE EXCEPTION 'a hand-typed id did not override the one we minted';
    END IF;
    IF EXISTS (SELECT 1 FROM camp_people WHERE camp_id = c2 AND person_id = m) THEN
        RAISE EXCEPTION 'the renumbered camper left their old id behind as a second row';
    END IF;

    -- ── 12. the backfill is a repair tool, not just a migration step ────────
    -- Nothing above this line has exercised it: every row so far arrived
    -- through the trigger. Wipe the rows and rebuild them from the documents.
    SELECT count(*) INTO cnt FROM camp_people WHERE camp_id = c2 AND deleted_at IS NULL;
    DELETE FROM camp_people  WHERE camp_id = c2;
    DELETE FROM camp_person_seq WHERE camp_id = c2;
    PERFORM public.backfill_camp_people();

    IF (SELECT count(*) FROM camp_people WHERE camp_id = c2 AND deleted_at IS NULL) <> cnt THEN
        RAISE EXCEPTION 'the backfill did not rebuild every person (% expected)', cnt;
    END IF;
    IF (SELECT person_id FROM camp_people WHERE camp_id = c2 AND source_key = 'Someone Else') <> 1041
       OR (SELECT person_id FROM camp_people WHERE camp_id = c2 AND source_key = 'Dashed Id') <> 2050
       OR (SELECT person_id FROM camp_people WHERE camp_id = c2 AND source_key = 'Needs One') <> 3300 THEN
        RAISE EXCEPTION 'the backfill did not restore the ids the camp chose';
    END IF;
    IF (SELECT count(*) FROM (SELECT person_id FROM camp_people WHERE camp_id = c2
                              GROUP BY person_id HAVING count(*) > 1) d) <> 0 THEN
        RAISE EXCEPTION 'the backfill put two people on one number';
    END IF;

    RAISE NOTICE '216: stated ids honoured, punctuation stripped, gaps minted over taken numbers,';
    RAISE NOTICE '216: one number one person across campers+staff, renames carry the id,';
    RAISE NOTICE '216: hand-renumbering moves the row, season reset keeps ids spoken for,';
    RAISE NOTICE '216: and the backfill rebuilds all of it from the documents alone.';
END $$;

-- ── 13. the trigger diffs ───────────────────────────────────────────────────
-- Deliberately OUTSIDE the block above: now() is the TRANSACTION clock, so a
-- re-save inside one transaction stamps the identical updated_at whether the
-- trigger diffed or rewrote every row. The first version of this check passed
-- against a trigger with the diff removed. Separate statements, separate
-- transactions, real elapsed time.
CREATE TEMP TABLE _t AS
SELECT max(updated_at) AS before FROM camp_people
 WHERE camp_id = '22222222-2222-2222-2222-222222222222';

UPDATE camp_state_kv SET value = value
 WHERE camp_id = '22222222-2222-2222-2222-222222222222' AND key = 'app1';

DO $$
DECLARE b timestamptz; a timestamptz;
BEGIN
    SELECT before INTO b FROM _t;
    SELECT max(updated_at) INTO a FROM camp_people
     WHERE camp_id = '22222222-2222-2222-2222-222222222222';
    IF a IS DISTINCT FROM b THEN
        RAISE EXCEPTION 'an unchanged roster rewrote its rows (% → %) — the trigger is not diffing, '
                        'which is the decay 206 had to undo in the canteen', b, a;
    END IF;
    RAISE NOTICE '216: an unchanged save touches no rows.';
END $$;
