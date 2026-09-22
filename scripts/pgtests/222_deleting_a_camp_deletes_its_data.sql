-- Behaviour test for 222. Applying is the low bar: the file creates a trigger
-- and two purge functions, and "it compiled" says nothing about whether
-- deleting a camp actually takes its data with it.
--
-- Five things are proved here, and each one is a way this could ship broken:
--
--   1. Deleting a camp clears EVERY camp-scoped table, not the three the
--      client knew about — including one created after this migration, because
--      the table list is discovered rather than written down.
--   2. It clears only THAT camp. A purge that takes the neighbouring camp
--      would be worse than the leak it replaces.
--   3. A table whose rows cannot be deleted aborts the whole thing and the
--      camp survives, rather than leaving a half-deleted camp behind.
--   4. Child-to-child foreign keys between camp-scoped tables do not block it.
--   5. purge_orphaned_camp_data() deletes NOTHING unless told to, and then
--      deletes only rows whose camp is really gone.

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION public.camp_reader(p_camp_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$ SELECT true $$;

-- A table that did not exist when 222 was written. If the purge carried a
-- hardcoded list, this is the row that would survive — which is the exact
-- mechanism that left camp_clone.js knowing about three tables out of 67.
CREATE TABLE IF NOT EXISTS public.a_table_invented_after_222 (
    camp_id uuid NOT NULL,
    note    text NOT NULL DEFAULT '');

-- A parent/child pair among camp-scoped tables, so the pass loop has a real
-- foreign key to trip over rather than a hypothetical one. The names are
-- deliberately adversarial: the catalog is walked alphabetically, so the PARENT
-- is visited first and its delete must fail and be retried. Named the other way
-- round, a single-pass purge would pass this test by luck.
CREATE TABLE IF NOT EXISTS public.zz_aaa_parent (
    id      uuid PRIMARY KEY,
    camp_id uuid NOT NULL);
CREATE TABLE IF NOT EXISTS public.zz_bbb_child (
    id        uuid PRIMARY KEY,
    camp_id   uuid NOT NULL,
    parent_id uuid NOT NULL REFERENCES public.zz_aaa_parent(id));

DO $$
DECLARE
    doomed uuid := 'd2200000-0000-0000-0000-000000000001';
    keeper uuid := 'd2200000-0000-0000-0000-000000000002';
    ghost  uuid := 'd2200000-0000-0000-0000-000000000003';
    owner  uuid := 'd2200000-0000-0000-0000-0000000000ff';
    r      jsonb;
    n      bigint;
    t      record;
BEGIN
    INSERT INTO camps (id, owner, name) VALUES (doomed, owner, 'Doomed'),
                                              (keeper, owner, 'Keeper');

    -- ── seed both camps across a spread of tables ────────────────────────────
    -- camp_state_kv is the source of truth; camp_people and the billing
    -- projections come from its triggers, so seeding the blob seeds them too.
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES
        (doomed, 'app1', jsonb_build_object('camperRoster', jsonb_build_object(
            'Ayala Weiss', jsonb_build_object('camperId', '880', 'name', 'Ayala Weiss'),
            'Dov Lerner',  jsonb_build_object('camperId', '881', 'name', 'Dov Lerner')))),
        (keeper, 'app1', jsonb_build_object('camperRoster', jsonb_build_object(
            'Rivka Stern', jsonb_build_object('camperId', '5', 'name', 'Rivka Stern'))));

    PERFORM public.canteen_account_save(doomed, 'Ayala Weiss',
        jsonb_build_object('balance', 41.25, 'dailyLimit', 10, 'spentToday', 0));
    PERFORM public.canteen_account_save(keeper, 'Rivka Stern',
        jsonb_build_object('balance', 7.00, 'dailyLimit', 10, 'spentToday', 0));

    INSERT INTO public.a_table_invented_after_222 (camp_id, note)
        VALUES (doomed, 'invented later'), (keeper, 'invented later');
    INSERT INTO public.zz_aaa_parent (id, camp_id) VALUES
        ('d22aaaaa-0000-0000-0000-000000000001', doomed),
        ('d22aaaaa-0000-0000-0000-000000000002', keeper);
    INSERT INTO public.zz_bbb_child (id, camp_id, parent_id) VALUES
        ('d22bbbbb-0000-0000-0000-000000000001', doomed, 'd22aaaaa-0000-0000-0000-000000000001'),
        ('d22bbbbb-0000-0000-0000-000000000002', keeper, 'd22aaaaa-0000-0000-0000-000000000002');

    IF (SELECT count(*) FROM camp_people WHERE camp_id = doomed) < 2 THEN
        RAISE EXCEPTION 'seed did not project campers — the rest of this test would prove nothing';
    END IF;

    -- ── 1 & 2 & 4. delete the camp ───────────────────────────────────────────
    DELETE FROM camps WHERE id = doomed;

    FOR t IN SELECT * FROM public._camp_scoped_tables() LOOP
        EXECUTE format('SELECT count(*) FROM public.%I WHERE %I = $1', t.table_name, t.camp_col)
           INTO n USING doomed;
        IF n > 0 THEN
            RAISE EXCEPTION '% rows survived in % after the camp was deleted', n, t.table_name;
        END IF;
    END LOOP;

    -- Named individually as well as swept above, because a sweep that
    -- discovered no tables at all would pass the loop silently.
    IF (SELECT count(*) FROM camp_people WHERE camp_id = doomed) <> 0
       OR (SELECT count(*) FROM camp_canteen_accounts WHERE camp_id = doomed) <> 0
       OR (SELECT count(*) FROM public.a_table_invented_after_222 WHERE camp_id = doomed) <> 0
       OR (SELECT count(*) FROM public.zz_bbb_child WHERE camp_id = doomed) <> 0 THEN
        RAISE EXCEPTION 'the sweep found no tables — it proved nothing';
    END IF;

    -- The neighbour is untouched, including the $7.00.
    IF (SELECT count(*) FROM camp_state_kv WHERE camp_id = keeper) <> 1
       OR (SELECT count(*) FROM camp_people WHERE camp_id = keeper) <> 1
       OR (SELECT balance FROM camp_canteen_accounts
            WHERE camp_id = keeper AND account_key = 'Rivka Stern') IS DISTINCT FROM 7.00
       OR (SELECT count(*) FROM public.a_table_invented_after_222 WHERE camp_id = keeper) <> 1
       OR (SELECT count(*) FROM public.zz_bbb_child WHERE camp_id = keeper) <> 1 THEN
        RAISE EXCEPTION 'deleting one camp disturbed another camp';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM camps WHERE id = keeper) THEN
        RAISE EXCEPTION 'deleting one camp deleted another camp''s row';
    END IF;

    RAISE NOTICE 'deleting a camp cleared every camp-scoped table and left the neighbour alone';

    -- ── 5. the orphan purge is a dry run by default ──────────────────────────
    -- A camp id with data and no camps row: exactly the 42 this project has.
    INSERT INTO camp_state_kv (camp_id, key, value)
        VALUES (ghost, 'app1', jsonb_build_object('camperRoster', jsonb_build_object(
            'Nobody At All', jsonb_build_object('camperId', '7', 'name', 'Nobody At All'))));
    INSERT INTO public.a_table_invented_after_222 (camp_id, note) VALUES (ghost, 'orphan');

    r := public.purge_orphaned_camp_data();
    IF (r ->> 'deleted') <> 'false' OR (r ->> 'dry_run') <> 'true' THEN
        RAISE EXCEPTION 'the no-argument form claims to have deleted: %', r;
    END IF;
    IF (r ->> 'orphaned_camps')::bigint <> 1 THEN
        RAISE EXCEPTION 'dry run counted % orphaned camps, expected 1: %', r ->> 'orphaned_camps', r;
    END IF;
    IF (r ->> 'rows_that_would_go')::bigint < 3 THEN
        RAISE EXCEPTION 'dry run found only % rows; the blob, its projected camper and the '
                        'invented table are at least three: %', r ->> 'rows_that_would_go', r;
    END IF;
    IF (SELECT count(*) FROM camp_state_kv WHERE camp_id = ghost) <> 1 THEN
        RAISE EXCEPTION 'the DRY RUN deleted data — there is no undo for 2,194 rows';
    END IF;
    RAISE NOTICE 'dry run counted % orphan rows across % camps and deleted nothing',
                 r ->> 'rows_that_would_go', r ->> 'orphaned_camps';

    -- And now for real.
    r := public.purge_orphaned_camp_data(true);
    IF (r ->> 'deleted') <> 'true' OR (r ->> 'rows_deleted')::bigint < 3 THEN
        RAISE EXCEPTION 'the confirmed purge deleted %: %', r ->> 'rows_deleted', r;
    END IF;
    IF (r ->> 'still_orphaned')::bigint <> 0 THEN
        RAISE EXCEPTION 'the purge reported success with % orphan rows left: %',
                        r ->> 'still_orphaned', r;
    END IF;
    IF (SELECT count(*) FROM camp_state_kv WHERE camp_id = ghost) <> 0
       OR (SELECT count(*) FROM camp_people WHERE camp_id = ghost) <> 0
       OR (SELECT count(*) FROM public.a_table_invented_after_222 WHERE camp_id = ghost) <> 0 THEN
        RAISE EXCEPTION 'the confirmed purge left the orphan behind';
    END IF;
    -- The living camp is still living.
    IF (SELECT count(*) FROM camp_state_kv WHERE camp_id = keeper) <> 1 THEN
        RAISE EXCEPTION 'the orphan purge took a camp that still exists';
    END IF;
    RAISE NOTICE 'the confirmed purge removed % orphan rows and nothing else', r ->> 'rows_deleted';
END $$;


-- ── 3. a table that refuses to clear must abort the deletion ────────────────
-- The failure this guards against is the one 222 exists to fix, one level up:
-- a camp that is gone with data behind it. If the purge cannot finish, the
-- right outcome is a camp that is still there.
--
-- An outside table holding a foreign key to a camp-scoped row is the realistic
-- version — it is not itself camp-scoped, so the purge never visits it, and it
-- pins the row it points at forever.
CREATE TABLE IF NOT EXISTS public.zz_outsider (
    id        uuid PRIMARY KEY,
    parent_id uuid NOT NULL REFERENCES public.zz_aaa_parent(id));

DO $$
DECLARE
    stuck uuid := 'd2200000-0000-0000-0000-000000000004';
    owner uuid := 'd2200000-0000-0000-0000-0000000000ff';
    ok    boolean := false;
BEGIN
    INSERT INTO camps (id, owner, name) VALUES (stuck, owner, 'Stuck');
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES (stuck, 'app1', '{}'::jsonb);
    INSERT INTO public.zz_aaa_parent (id, camp_id)
        VALUES ('d22aaaaa-0000-0000-0000-000000000009', stuck);
    INSERT INTO public.zz_outsider (id, parent_id)
        VALUES ('d22ccccc-0000-0000-0000-000000000009', 'd22aaaaa-0000-0000-0000-000000000009');

    BEGIN
        DELETE FROM camps WHERE id = stuck;
    EXCEPTION WHEN OTHERS THEN
        ok := true;
    END;

    IF NOT ok THEN
        RAISE EXCEPTION 'a camp whose data could not be cleared was deleted anyway — '
                        'which is the bug 222 exists to fix';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM camps WHERE id = stuck) THEN
        RAISE EXCEPTION 'the camp row went despite the purge failing';
    END IF;
    IF (SELECT count(*) FROM camp_state_kv WHERE camp_id = stuck) <> 1 THEN
        RAISE EXCEPTION 'the refused deletion still destroyed data — it must be all or nothing';
    END IF;
    RAISE NOTICE 'a camp whose data cannot be cleared is refused, with its data intact';
END $$;


-- ── the verifier tells the truth about all of it ─────────────────────────────
DO $$
DECLARE v jsonb := public.verify_camp_deletion();
BEGIN
    IF (v ->> 'trigger_installed') <> 'true' THEN
        RAISE EXCEPTION 'verify_camp_deletion cannot see its own trigger: %', v;
    END IF;
    IF (v ->> 'camp_scoped_tables')::int < 10 THEN
        RAISE EXCEPTION 'only % camp-scoped tables discovered — the catalog query is wrong: %',
                        v ->> 'camp_scoped_tables', v;
    END IF;
    IF (v ->> 'orphan_rows')::bigint <> 0 THEN
        RAISE EXCEPTION 'orphans left after the purge: %', v;
    END IF;
    IF jsonb_array_length(v -> 'fks_that_do_not_cascade') <> 0 THEN
        RAISE EXCEPTION 'a foreign key to camps still refuses to cascade: %',
                        v -> 'fks_that_do_not_cascade';
    END IF;
    RAISE NOTICE 'verifier: % camp-scoped tables, trigger installed, 0 orphans, all FKs cascade',
                 v ->> 'camp_scoped_tables';
END $$;

-- verify_camp_deleted answers for one camp, and says fully_deleted only when
-- both halves are true.
DO $$
DECLARE
    v jsonb;
BEGIN
    v := public.verify_camp_deleted('d2200000-0000-0000-0000-000000000001');
    IF (v ->> 'fully_deleted') <> 'true' THEN
        RAISE EXCEPTION 'the camp deleted at the top of this test does not read as fully deleted: %', v;
    END IF;
    v := public.verify_camp_deleted('d2200000-0000-0000-0000-000000000002');
    IF (v ->> 'fully_deleted') <> 'false' OR (v ->> 'rows_left')::bigint = 0 THEN
        RAISE EXCEPTION 'a camp that still exists with all its data reads as deleted: %', v;
    END IF;
    RAISE NOTICE 'verify_camp_deleted distinguishes a deleted camp from a living one';
END $$;

DROP TABLE IF EXISTS public.zz_outsider;
DROP TABLE IF EXISTS public.zz_bbb_child;
DROP TABLE IF EXISTS public.zz_aaa_parent;
DROP TABLE IF EXISTS public.a_table_invented_after_222;
