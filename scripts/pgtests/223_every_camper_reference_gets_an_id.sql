-- Behaviour test for 223. The migration adds a column to twenty tables, which
-- is the easy half; what has to be proved is that the column means something
-- and keeps meaning it.
--
--   1. The column, the index and the trigger all exist on every table with a
--      camper_name — not two out of three, which would be a column that starts
--      rotting with the next INSERT.
--   2. A new row is stamped on the way in.
--   3. A RENAME does not change the id. That is the whole reason for the id.
--   4. A name the roster cannot resolve leaves NULL and the row is still
--      written. A pickup alert must never be refused over bookkeeping.
--   5. Case and trailing space resolve to the same child; a departed camper
--      still resolves.
--   6. An AMBIGUOUS name resolves to NULL rather than to a coin flip — the one
--      deliberate behaviour change from 217's matcher.
--   7. 217's canteen attribution still behaves, now that it delegates.
--   8. The backfill fills rows that already existed, proved by re-applying the
--      real migration file rather than by re-typing its UPDATE here.
--   9. link_parent_invites gets a POSITIONAL id array, nulls included.

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION public.camp_reader(p_camp_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$ SELECT true $$;

-- ── 1. column + index + trigger, on every one of them ───────────────────────
DO $$
DECLARE
    t       record;
    v_seen  integer := 0;
BEGIN
    FOR t IN
        SELECT c.oid, c.relname::text AS tbl
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r'
           AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                        AND a.attname = 'camper_name' AND a.atttypid = 'text'::regtype
                        AND a.attnum > 0 AND NOT a.attisdropped)
           AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                        AND a.attname = 'camp_id' AND a.atttypid = 'uuid'::regtype
                        AND a.attnum > 0 AND NOT a.attisdropped)
    LOOP
        v_seen := v_seen + 1;
        IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = t.oid
                        AND a.attname = 'person_id' AND a.attnum > 0 AND NOT a.attisdropped) THEN
            RAISE EXCEPTION '%s has a camper_name and no person_id', t.tbl;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_trigger tg WHERE tg.tgrelid = t.oid
                        AND tg.tgname = 'trg_stamp_person_id' AND NOT tg.tgisinternal) THEN
            RAISE EXCEPTION '% has the column but nothing keeps it true', t.tbl;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
                        WHERE i.indrelid = t.oid AND ic.relname = left('idx_' || t.tbl || '_person', 63)) THEN
            RAISE EXCEPTION '% has no index on (camp_id, person_id)', t.tbl;
        END IF;
    END LOOP;
    IF v_seen < 4 THEN
        RAISE EXCEPTION 'only % tables with a camper_name were found — this test proved nothing', v_seen;
    END IF;
    RAISE NOTICE '223: all % name-keyed tables carry an id, an index and the stamp', v_seen;
END $$;


-- ── 2-7. the stamp, renames, misses, fuzz, ambiguity, the canteen ────────────
DO $$
DECLARE
    c     uuid := 'e2300000-0000-0000-0000-000000000001';
    owner uuid := 'e2300000-0000-0000-0000-0000000000ff';
    a1    uuid;
    got   bigint;
    ayala bigint;
BEGIN
    INSERT INTO camps (id, owner, name) VALUES (c, owner, 'Identity Camp');
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES (c, 'app1', jsonb_build_object(
        'camperRoster', jsonb_build_object(
            'Ayala Weiss',  jsonb_build_object('camperId', '880', 'name', 'Ayala Weiss'),
            'Dov Lerner',   jsonb_build_object('camperId', '881', 'name', 'Dov Lerner'),
            'Gone Lastyear', jsonb_build_object('camperId', '700', 'name', 'Gone Lastyear'))));

    SELECT person_id INTO ayala FROM camp_people
     WHERE camp_id = c AND kind = 'camper' AND source_key = 'Ayala Weiss';
    IF ayala IS DISTINCT FROM 880 THEN
        RAISE EXCEPTION 'the seed did not project: Ayala is %', ayala;
    END IF;

    -- 2. a new row is stamped on the way in
    INSERT INTO pickup_alerts (camp_id, camper_name, camper_bunk)
         VALUES (c, 'Ayala Weiss', 'B1') RETURNING id INTO a1;
    SELECT person_id INTO got FROM pickup_alerts WHERE id = a1;
    IF got IS DISTINCT FROM 880 THEN
        RAISE EXCEPTION 'a new pickup alert was not stamped: person_id is %', got;
    END IF;

    -- 3. a rename does not move the id. The name on the row changes, the child
    --    does not. This is the single thing a name-keyed system cannot do.
    UPDATE pickup_alerts SET camper_name = 'Ayala Weiss-Katz' WHERE id = a1;
    SELECT person_id INTO got FROM pickup_alerts WHERE id = a1;
    IF got IS DISTINCT FROM 880 THEN
        RAISE EXCEPTION 'a rename changed the id from 880 to % — the id is not an identity', got;
    END IF;

    -- 4. an unresolvable name leaves NULL, and the row is still written
    INSERT INTO pickup_alerts (camp_id, camper_name) VALUES (c, 'Nobody At All');
    IF NOT EXISTS (SELECT 1 FROM pickup_alerts
                    WHERE camp_id = c AND camper_name = 'Nobody At All' AND person_id IS NULL) THEN
        RAISE EXCEPTION 'an unresolvable name was either refused or invented an id — a pickup '
                        'alert must never fail over bookkeeping';
    END IF;

    -- 5a. case and trailing space are the same child (rank 2)
    INSERT INTO link_health_submissions (camp_id, camper_name, doc_type)
         VALUES (c, '  dov LERNER ', 'immunisation');
    SELECT person_id INTO got FROM link_health_submissions
     WHERE camp_id = c AND camper_name = '  dov LERNER ';
    IF got IS DISTINCT FROM 881 THEN
        RAISE EXCEPTION 'a trailing space and a capital invented a second person: %', got;
    END IF;

    -- 5b. a departed camper still resolves (rank 3). Last season's tip belongs
    --     to whoever it belonged to; 216 keeps them with deleted_at set exactly
    --     so the number stays spoken for.
    UPDATE camp_people SET deleted_at = now()
     WHERE camp_id = c AND source_key = 'Gone Lastyear';
    INSERT INTO link_tips (camp_id, camper_name, staff_name, amount)
         VALUES (c, 'Gone Lastyear', 'Counselor R', 20);
    SELECT person_id INTO got FROM link_tips WHERE camp_id = c AND camper_name = 'Gone Lastyear';
    IF got IS DISTINCT FROM 700 THEN
        RAISE EXCEPTION 'a departed camper stopped resolving: %', got;
    END IF;

    -- 6. ambiguity is NULL, not a coin flip. Two roster entries differing only
    --    in case, and a third spelling that matches neither exactly: the fuzzy
    --    rank now has two candidates, and "we do not know which child" is the
    --    only true answer.
    INSERT INTO camp_people (camp_id, person_id, kind, source_key, name)
         VALUES (c, 901, 'camper', 'Tzvi Adler', 'Tzvi Adler'),
                (c, 902, 'camper', 'tzvi adler', 'tzvi adler');
    got := public.camp_person_by_name(c, 'TZVI ADLER');
    IF got IS NOT NULL THEN
        RAISE EXCEPTION 'an ambiguous name resolved to % — that is a coin flip about which '
                        'child owns the row', got;
    END IF;
    -- But an EXACT key is never ambiguous: uq_camp_people_source makes it unique,
    -- so the fuzzy rank is never reached and the right child is still found.
    IF public.camp_person_by_name(c, 'Tzvi Adler') IS DISTINCT FROM 901
       OR public.camp_person_by_name(c, 'tzvi adler') IS DISTINCT FROM 902 THEN
        RAISE EXCEPTION 'the ambiguity rule broke exact matching, which is never ambiguous';
    END IF;

    -- 7. the canteen still attributes the way 217 and 219 require, through the
    --    shared matcher rather than its own copy.
    IF public._attribute_canteen_account(c, 'Ayala Weiss') IS DISTINCT FROM 880 THEN
        RAISE EXCEPTION '_attribute_canteen_account stopped attributing after it started '
                        'delegating: %', public._attribute_canteen_account(c, 'Ayala Weiss');
    END IF;
    PERFORM public.canteen_account_save(c, 'Ayala Weiss',
        jsonb_build_object('balance', 12.50, 'dailyLimit', 10, 'spentToday', 0));
    IF (SELECT person_id FROM camp_canteen_accounts
         WHERE camp_id = c AND account_key = 'Ayala Weiss') IS DISTINCT FROM 880 THEN
        RAISE EXCEPTION 'a canteen account stopped carrying its camper id';
    END IF;

    RAISE NOTICE '223: stamped on insert, id survives a rename, misses stay NULL without '
                 'refusing the row, case/space/departed all resolve, ambiguity does not';
END $$;


-- ── 9. the invite's id list is positional, nulls included ───────────────────
DO $$
DECLARE
    c   uuid := 'e2300000-0000-0000-0000-000000000001';
    ids jsonb;
BEGIN
    INSERT INTO link_parent_invites (camp_id, parent_name, camper_names)
         VALUES (c, 'A Parent',
                 jsonb_build_array('Ayala Weiss', 'Not In The Roster', 'Dov Lerner'));
    SELECT person_ids INTO ids FROM link_parent_invites
     WHERE camp_id = c AND parent_name = 'A Parent';
    -- Positional, so the middle entry must be null rather than dropped: an id
    -- list shorter than the name list silently re-points every name after the
    -- gap at the wrong child.
    IF ids IS DISTINCT FROM jsonb_build_array(880, null, 881) THEN
        RAISE EXCEPTION 'invite ids are % — expected [880, null, 881], positional against '
                        'camper_names', ids;
    END IF;
    RAISE NOTICE '223: an invite carries a positional id list, null where a name does not resolve';
END $$;


-- ── 8. the backfill fills rows that already existed ─────────────────────────
-- Proved by re-applying the real migration rather than by re-typing its UPDATE,
-- which would test this file against itself. Re-applying is also the documented
-- repair path for a camp that imports its own numbers later, so this doubles as
-- the idempotency check.
--
-- The trigger is switched off around the inserts so the rows arrive exactly as
-- they arrived before 223 existed: named, with no id.
ALTER TABLE public.pickup_alerts DISABLE TRIGGER trg_stamp_person_id;
INSERT INTO pickup_alerts (camp_id, camper_name, camper_bunk) VALUES
    ('e2300000-0000-0000-0000-000000000001', 'Dov Lerner', 'B2'),
    ('e2300000-0000-0000-0000-000000000001', 'Still Nobody', 'B2');
ALTER TABLE public.pickup_alerts ENABLE TRIGGER trg_stamp_person_id;

DO $$
BEGIN
    IF (SELECT count(*) FROM pickup_alerts
         WHERE camper_name = 'Dov Lerner' AND person_id IS NULL) <> 1 THEN
        RAISE EXCEPTION 'the pre-223 row was not seeded unstamped — the backfill test is vacuous';
    END IF;
END $$;

\i migrations/223_every_camper_reference_gets_an_id.sql

DO $$
BEGIN
    IF (SELECT person_id FROM pickup_alerts WHERE camper_name = 'Dov Lerner') IS DISTINCT FROM 881 THEN
        RAISE EXCEPTION 'the backfill did not reach a row that existed before the migration';
    END IF;
    IF (SELECT person_id FROM pickup_alerts WHERE camper_name = 'Still Nobody') IS NOT NULL THEN
        RAISE EXCEPTION 'the backfill invented an id for a name the roster cannot resolve';
    END IF;
    -- Re-applying must not disturb what already resolved.
    IF (SELECT person_id FROM pickup_alerts WHERE camper_name = 'Ayala Weiss-Katz') IS DISTINCT FROM 880 THEN
        RAISE EXCEPTION 're-applying the migration changed a settled id';
    END IF;
    RAISE NOTICE '223: the backfill reaches pre-existing rows, invents nothing, and re-applying '
                 'is safe';
END $$;


-- ── the verifier tells the truth ─────────────────────────────────────────────
DO $$
DECLARE v jsonb := public.verify_camper_ids();
BEGIN
    IF (v ->> 'tables_with_an_id_column')::int < 4 THEN
        RAISE EXCEPTION 'the verifier sees only % tables: %', v ->> 'tables_with_an_id_column', v;
    END IF;
    IF jsonb_array_length(v -> 'tables_without_the_stamping_trigger') <> 0 THEN
        RAISE EXCEPTION 'a table is accumulating nameless rows right now: %',
                        v -> 'tables_without_the_stamping_trigger';
    END IF;
    -- Counted per table, not in total: earlier files' behaviour tests ran against
    -- this same server and left their own unattributed canteen accounts behind,
    -- so a total is not a number this test gets to predict. pickup_alerts is
    -- entirely this test's, and it holds exactly four named rows of which two
    -- name nobody.
    IF (v -> 'by_table' -> 'pickup_alerts' ->> 'named')::bigint <> 4
       OR (v -> 'by_table' -> 'pickup_alerts' ->> 'with_id')::bigint <> 2
       OR (v -> 'by_table' -> 'pickup_alerts' ->> 'unresolvable')::bigint <> 2 THEN
        RAISE EXCEPTION 'pickup_alerts reads %, expected 4 named / 2 with an id / 2 unresolvable',
                        v -> 'by_table' -> 'pickup_alerts';
    END IF;
    IF (v ->> 'rows_the_roster_cannot_resolve')::bigint < 2 THEN
        RAISE EXCEPTION 'the verifier under-counts unresolvable rows — that is the number that '
                        'turned out to be 353 for canteen accounts: %', v;
    END IF;
    RAISE NOTICE 'verifier: % tables, % rows naming a camper, % carrying an id, % unresolvable',
                 v ->> 'tables_with_an_id_column', v ->> 'rows_naming_a_camper',
                 v ->> 'rows_carrying_an_id', v ->> 'rows_the_roster_cannot_resolve';
END $$;
