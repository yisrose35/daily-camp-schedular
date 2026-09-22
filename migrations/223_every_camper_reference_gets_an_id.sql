-- ============================================================================
-- 223 — every camper reference gets an id
--
-- WHY THIS EXISTS. 216 made (camp_id, person_id) a real identity and 217-221
-- moved the canteen onto it. Everything else still identifies a camper by
-- NAME: twenty tables carry a camper_name and no id, across pickup alerts,
-- health documents, camper mail, photo tags, tips, photo purchases, billing
-- enrolments and two payment-intent tables.
--
-- A name is not an identity, and this project already knows what the failure
-- looks like: 353 canteen accounts point at a name the roster cannot resolve,
-- holding $76.72 that belongs to children nobody can name. That happened
-- because the season reset clears camperRoster wholesale and the accounts kept
-- pointing at the strings. Every table below can do the same thing, and the
-- ones holding money can do it with money.
--
-- Three distinct ways a name fails, all of them already live here:
--   - a rename orphans the history (the camper is the same child; the key is not)
--   - two campers share a name, so one child's health form can be read by the
--     other's parent
--   - a trailing space invents a second person
--
-- WHAT THIS DOES. Additive only. Every table with a camp_id and a camper_name
-- gains a nullable person_id, backfilled from camp_people, indexed, and kept
-- true from here on by a BEFORE INSERT trigger — so the column cannot be a
-- snapshot that rots the moment the next row is written. That last part is the
-- point: a column recorded once and maintained by nobody is the defect shape
-- this project keeps finding, not a fix for it.
--
-- WHAT IT DOES NOT DO. Nothing READS person_id yet. No function signature
-- changes, no primary key moves, no name stops working, and every existing
-- query returns exactly what it returned before. Later files move the readers
-- and writers per domain — pickup and mail, then photos and tips, then the two
-- money tables — and each of those is a behaviour change that deserves to fail
-- on its own rather than inside a twenty-table sweep.
--
-- ONE MATCHER, NOT TWO. 217 wrote a ranked name matcher for canteen accounts.
-- Writing a second one here would guarantee that two parts of the system
-- eventually disagree about which child a name means, and the disagreement
-- would be about money. So 217's matcher is generalised into
-- camp_person_by_name() and 217's own function now delegates to it.
--
-- WITH ONE DELIBERATE CHANGE: an AMBIGUOUS match now resolves to NULL instead
-- of picking a row. 217 took the first row of whatever rank matched, with no
-- ORDER BY, so two roster entries differing only in case or trailing space —
-- exactly the thing a fuzzy rank exists to paper over — resolved to an
-- arbitrary one of them. For a health form or a canteen balance, "we do not
-- know which child" is a true answer and a coin flip is not. Unattributed is
-- already a state this system handles and reports; misattributed is not.
--
-- WHY THE TABLE LIST IS DISCOVERED AND THEN ASSERTED. The list is built from
-- the catalog, because 222 was written the week a hardcoded list of three
-- tables out of 67 turned out to have cost 42 camps' worth of data. But unlike
-- 222 this file runs once, at apply time, so it can do better than trust its
-- own loop: section 4 asserts that NO table in public has a camper_name and no
-- person_id afterwards. If the discovery misses one, this migration fails
-- rather than reporting success over a gap.
--
-- HOW TO APPLY. Paste into the SQL Editor. One transaction, idempotent, safe to
-- re-run — re-running is also how you repair the column after importing a
-- camp's own numbers.
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

-- ─── 0. preflight ───────────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_name = 'camp_people') THEN
        RAISE EXCEPTION 'camp_people is missing — apply migration 216 before this file';
    END IF;
END $$;

-- The ALTER TABLEs below take AccessExclusive on twenty tables. Adding a
-- nullable column with no default is a catalog-only change, so it is fast, but
-- fast is not the same as able to wait: a parent submitting a pickup request at
-- that instant holds the row. 216's lesson is that a migration which hangs
-- holding locks is worse than one that fails and can be run again.
SET LOCAL lock_timeout = '15s';


-- ─── 1. the one matcher ─────────────────────────────────────────────────────
-- Generalised from 217's _attribute_canteen_account. The ranks, in order:
--
--   1. the document's own key for this camper — an exact source_key match on a
--      live row. uq_camp_people_source makes (camp_id, kind, source_key)
--      unique, so this rank can never be ambiguous.
--   2. the same key ignoring case and surrounding space, still live. This is
--      the trailing-space case: 'Chaim Katz ' and 'Chaim Katz' are one child.
--   3. the same, including departed campers. A pickup alert or a canteen
--      balance from last season still belongs to whoever it belonged to;
--      camp_people keeps them with deleted_at set precisely so the id stays
--      spoken for.
--
-- Ambiguity within the matched rank returns NULL. See the header.
CREATE OR REPLACE FUNCTION public.camp_person_by_name(p_camp_id uuid, p_name text)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    WITH ranked AS (
        SELECT person_id, 1 AS rank FROM camp_people
         WHERE camp_id = p_camp_id AND kind = 'camper'
           AND deleted_at IS NULL AND source_key = p_name
        UNION ALL
        SELECT person_id, 2 FROM camp_people
         WHERE camp_id = p_camp_id AND kind = 'camper'
           AND deleted_at IS NULL AND lower(btrim(source_key)) = lower(btrim(p_name))
        UNION ALL
        SELECT person_id, 3 FROM camp_people
         WHERE camp_id = p_camp_id AND kind = 'camper'
           AND lower(btrim(source_key)) = lower(btrim(p_name))
    ),
    best AS (SELECT min(rank) AS rank FROM ranked)
    -- count(DISTINCT) rather than count(*): rank 3 re-matches the same row that
    -- rank 2 matched, and a row matching itself is not two candidates.
    SELECT CASE WHEN count(DISTINCT r.person_id) = 1 THEN min(r.person_id) END
      FROM ranked r JOIN best b ON r.rank = b.rank
     WHERE NULLIF(btrim(COALESCE(p_name, '')), '') IS NOT NULL
$$;
REVOKE ALL ON FUNCTION public.camp_person_by_name(uuid, text) FROM public, anon, authenticated;
COMMENT ON FUNCTION public.camp_person_by_name(uuid, text) IS
    'The one name-to-camper-id matcher. Exact key, then case/space-insensitive, then including departed campers. Ambiguous at the matched rank → NULL, because a coin flip about which child owns money is worse than not knowing.';


-- 217's function becomes a name for this one. Keeping two implementations would
-- guarantee they eventually disagree, about money.
CREATE OR REPLACE FUNCTION public._attribute_canteen_account(p_camp_id uuid, p_key text)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$ SELECT public.camp_person_by_name(p_camp_id, p_key) $$;
REVOKE ALL ON FUNCTION public._attribute_canteen_account(uuid, text)
    FROM public, anon, authenticated;


-- ─── 2. the stamp ───────────────────────────────────────────────────────────
-- One trigger function for every table. NEW.person_id and NEW.camper_name are
-- resolved per table at runtime, which is exactly what makes a single generic
-- trigger possible — and why section 3 only attaches it to tables that have
-- both columns.
--
-- It never raises and never rejects. A camper_name that resolves to nothing
-- leaves person_id NULL and the row is written as before: an unresolvable name
-- must not stop a parent reporting a pickup, and 216 makes the same argument
-- for keeping camp_people free of foreign keys.
--
-- An id already present is never overwritten. That is what makes a rename safe:
-- the child keeps the number, whatever the name on the row now says.
CREATE OR REPLACE FUNCTION public.stamp_person_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    IF NEW.person_id IS NOT NULL THEN
        RETURN NEW;
    END IF;
    IF COALESCE(btrim(NEW.camper_name), '') = '' OR NEW.camp_id IS NULL THEN
        RETURN NEW;
    END IF;
    NEW.person_id := public.camp_person_by_name(NEW.camp_id, NEW.camper_name);
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.stamp_person_id() FROM public, anon, authenticated;


-- ─── 3. the column, the index, the backfill, the trigger ────────────────────
-- Discovered from the catalog: every ordinary table in public with a uuid
-- camp_id and a text camper_name. Four statements each, and the loop is the
-- only place any of them is written, so a table cannot be covered by three of
-- the four.
--
-- The UPDATE is the only slow part — one pass per table, resolving each
-- distinct name against an index. It is also the only statement here that can
-- be re-run to repair: person_id IS NULL is its filter, so re-applying this
-- file after a camp imports its own numbers fills in whatever now resolves and
-- leaves settled rows alone.
DO $$
DECLARE
    t       record;
    v_added integer := 0;
    v_rows  bigint;
    v_total bigint := 0;
BEGIN
    FOR t IN
        SELECT c.relname::text AS tbl
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r'
           AND EXISTS (SELECT 1 FROM pg_attribute a
                        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                          AND a.attname = 'camp_id' AND a.atttypid = 'uuid'::regtype)
           AND EXISTS (SELECT 1 FROM pg_attribute a
                        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                          AND a.attname = 'camper_name' AND a.atttypid = 'text'::regtype)
         ORDER BY c.relname
    LOOP
        EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS person_id bigint', t.tbl);

        -- Partial, because most rows in most of these tables will resolve and
        -- the NULLs are the ones nobody can look up by id anyway.
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS %I ON public.%I (camp_id, person_id)'
            || ' WHERE person_id IS NOT NULL',
            left('idx_' || t.tbl || '_person', 63), t.tbl);

        EXECUTE format(
            'UPDATE public.%I SET person_id = public.camp_person_by_name(camp_id, camper_name)'
            || ' WHERE person_id IS NULL AND COALESCE(btrim(camper_name), '''') <> ''''',
            t.tbl);
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        v_total := v_total + v_rows;

        EXECUTE format('DROP TRIGGER IF EXISTS trg_stamp_person_id ON public.%I', t.tbl);
        EXECUTE format(
            'CREATE TRIGGER trg_stamp_person_id BEFORE INSERT OR UPDATE OF camper_name'
            || ' ON public.%I FOR EACH ROW EXECUTE FUNCTION public.stamp_person_id()', t.tbl);

        v_added := v_added + 1;
    END LOOP;
    RAISE NOTICE '223: % tables given a person_id, % rows visited by the backfill', v_added, v_total;
END $$;


-- ─── 3b. the one table that holds a LIST of campers ─────────────────────────
-- link_parent_invites.camper_names is a jsonb array of names a parent typed,
-- and camper_data is an object keyed by those same names. It is the odd one
-- out: an invite names campers who may not exist in the roster yet, which is
-- the whole point of an invite.
--
-- person_ids is therefore positional against camper_names — same length, same
-- order, null where the name does not resolve — rather than an object keyed by
-- name, because keying by name is the thing being fixed. A null entry is
-- expected and normal here, not a failure.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'link_parent_invites'
                      AND column_name = 'camper_names') THEN
        RAISE NOTICE '223: link_parent_invites has no camper_names — skipping';
        RETURN;
    END IF;

    ALTER TABLE public.link_parent_invites ADD COLUMN IF NOT EXISTS person_ids jsonb;

    UPDATE public.link_parent_invites i
       SET person_ids = (
            SELECT jsonb_agg(to_jsonb(public.camp_person_by_name(i.camp_id, e.value #>> '{}'))
                             ORDER BY e.ord)
              FROM jsonb_array_elements(i.camper_names) WITH ORDINALITY AS e(value, ord))
     WHERE i.person_ids IS NULL
       AND jsonb_typeof(i.camper_names) = 'array'
       AND jsonb_array_length(i.camper_names) > 0;
END $$;

CREATE OR REPLACE FUNCTION public.stamp_invite_person_ids()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    IF NEW.person_ids IS NOT NULL OR NEW.camp_id IS NULL
       OR jsonb_typeof(NEW.camper_names) IS DISTINCT FROM 'array' THEN
        RETURN NEW;
    END IF;
    NEW.person_ids := (
        SELECT jsonb_agg(to_jsonb(public.camp_person_by_name(NEW.camp_id, e.value #>> '{}'))
                         ORDER BY e.ord)
          FROM jsonb_array_elements(NEW.camper_names) WITH ORDINALITY AS e(value, ord));
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.stamp_invite_person_ids() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS trg_stamp_invite_person_ids ON public.link_parent_invites;
CREATE TRIGGER trg_stamp_invite_person_ids
BEFORE INSERT OR UPDATE OF camper_names ON public.link_parent_invites
FOR EACH ROW EXECUTE FUNCTION public.stamp_invite_person_ids();


-- ─── 4. the assertion the loop cannot make about itself ─────────────────────
-- A loop that reports "20 tables done" is reporting how many times it went
-- round, which is not the same as whether anything was left out. This asks the
-- catalog the opposite question, and fails the migration if the answer is wrong
-- — including the trigger, because a column without the trigger is a snapshot
-- that starts rotting with the next INSERT.
DO $$
DECLARE
    v_gaps text;
BEGIN
    SELECT string_agg(c.relname || ' (' || missing || ')', ', ' ORDER BY c.relname)
      INTO v_gaps
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL (
        SELECT CASE
                 WHEN NOT EXISTS (SELECT 1 FROM pg_attribute a
                                   WHERE a.attrelid = c.oid AND a.attnum > 0
                                     AND NOT a.attisdropped AND a.attname = 'person_id')
                      THEN 'no person_id column'
                 WHEN NOT EXISTS (SELECT 1 FROM pg_trigger tg
                                   WHERE tg.tgrelid = c.oid AND NOT tg.tgisinternal
                                     AND tg.tgname = 'trg_stamp_person_id')
                      THEN 'no stamping trigger'
               END AS missing) g
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND g.missing IS NOT NULL
       AND EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                      AND a.attname = 'camp_id' AND a.atttypid = 'uuid'::regtype)
       AND EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                      AND a.attname = 'camper_name' AND a.atttypid = 'text'::regtype);

    IF v_gaps IS NOT NULL THEN
        RAISE EXCEPTION '223 left camper names without an id: %', v_gaps;
    END IF;
END $$;


-- ─── 5. the verifier ────────────────────────────────────────────────────────
-- Per table: how many rows name a camper, how many of those now carry an id,
-- and how many name someone the roster cannot resolve at all. That last number
-- is the one worth watching — it is the same number that turned out to be 353
-- for canteen accounts, and it does not go down by itself.
CREATE OR REPLACE FUNCTION public.verify_camper_ids()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    t            record;
    v_named      bigint;
    v_with       bigint;
    v_by_table   jsonb := '{}'::jsonb;
    v_tables     integer := 0;
    v_all_named  bigint := 0;
    v_all_with   bigint := 0;
    v_no_trigger jsonb;
BEGIN
    FOR t IN
        SELECT c.relname::text AS tbl
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r'
           AND EXISTS (SELECT 1 FROM pg_attribute a
                        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                          AND a.attname = 'camper_name' AND a.atttypid = 'text'::regtype)
           AND EXISTS (SELECT 1 FROM pg_attribute a
                        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                          AND a.attname = 'person_id')
         ORDER BY c.relname
    LOOP
        EXECUTE format(
            'SELECT count(*) FILTER (WHERE COALESCE(btrim(camper_name), '''') <> ''''),'
            || '       count(*) FILTER (WHERE person_id IS NOT NULL)'
            || '  FROM public.%I', t.tbl)
          INTO v_named, v_with;
        v_tables    := v_tables + 1;
        v_all_named := v_all_named + v_named;
        v_all_with  := v_all_with + v_with;
        IF v_named > 0 THEN
            v_by_table := jsonb_set(v_by_table, ARRAY[t.tbl], jsonb_build_object(
                'named', v_named, 'with_id', v_with, 'unresolvable', v_named - v_with));
        END IF;
    END LOOP;

    SELECT COALESCE(jsonb_agg(c.relname ORDER BY c.relname), '[]'::jsonb)
      INTO v_no_trigger
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                      AND a.attname = 'camper_name' AND a.atttypid = 'text'::regtype)
       AND NOT EXISTS (SELECT 1 FROM pg_trigger tg
                        WHERE tg.tgrelid = c.oid AND NOT tg.tgisinternal
                          AND tg.tgname = 'trg_stamp_person_id');

    RETURN jsonb_build_object(
        'success', true,
        'tables_with_an_id_column', v_tables,
        'rows_naming_a_camper', v_all_named,
        'rows_carrying_an_id', v_all_with,
        'rows_the_roster_cannot_resolve', v_all_named - v_all_with,
        'by_table', v_by_table,
        -- Non-empty means a table is accumulating new nameless rows right now.
        'tables_without_the_stamping_trigger', v_no_trigger);
END;
$$;
REVOKE ALL ON FUNCTION public.verify_camper_ids() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.verify_camper_ids() TO authenticated, service_role;


-- ─── did it work? ───────────────────────────────────────────────────────────
SELECT 'migration 223 applied' AS status,
       public.verify_camper_ids() AS camper_ids;
