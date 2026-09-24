-- ============================================================================
-- 222 — deleting a camp deletes its data
--
-- WHY THIS EXISTS. This project has 42 camps that no longer exist and still
-- hold 2,194 camper records, 430 canteen accounts and $95 of balances. Nobody
-- can see that data, nobody can bill it, nobody can refund it, and nothing
-- will ever remove it. It is not a tidiness problem: money is sitting in rows
-- attached to a camp id with no camp, which means a parent's credit cannot be
-- found, and a report that scans a table rather than joining camps counts it.
--
-- HOW IT HAPPENED. camp_clone.js:deleteCopy is the only code path that deletes
-- a camp, and it deletes three tables:
--
--     await sb().from('rotation_counts').delete().eq('camp_id', campId);
--     await sb().from('daily_schedules').delete().eq('camp_id', campId);
--     await sb().from('camp_state_kv').delete().eq('camp_id', campId);
--     var del = await sb().from('camps').delete().eq('id', campId);
--
-- There are 67 tables carrying a camp_id. Three were written in 2024 when
-- three was all there was, and the other sixty-four arrived one migration at a
-- time without anyone going back. Worse, supabase-js does not THROW on a
-- rejected write — it returns { error } — and none of those three results is
-- read. An RLS refusal therefore deleted nothing, reported nothing, and the
-- next line deleted the camp anyway. The one error that IS checked, on the
-- camps row, reports "Data cleared, but camp row could not be deleted" —
-- a sentence that states as fact the thing that was never checked.
--
-- That is the same shape as the last four bugs in this project: something
-- recorded that nobody reads, and a guard that looks like a guard and bounds
-- nothing.
--
-- WHAT THIS DOES. It stops the cleanup being a list somebody has to remember.
--
--   1. A BEFORE DELETE trigger on camps purges every camp-scoped table. The
--      table list is not written down — it is DISCOVERED from the catalog, so
--      migration 250's new table is covered on the day it is created. A list
--      in this file would be stale by the same mechanism that made the client
--      stale, and the whole lesson here is that lists rot.
--
--   2. Every foreign key to camps that would merely BLOCK a delete becomes
--      ON DELETE CASCADE, so the database agrees with the trigger instead of
--      fighting it.
--
--   3. purge_orphaned_camp_data() clears what the old path left behind. It
--      defaults to a DRY RUN: called with no argument it counts and deletes
--      nothing, so the report can be read before 2,194 rows are destroyed.
--      Irreversible work should take two steps.
--
--   4. verify_camp_deletion() answers "is any of this still true?" — orphan
--      rows, missing trigger, a foreign key that still refuses to cascade.
--
-- WHY A TRIGGER AND NOT JUST FOREIGN KEYS. Migration 200 hit ERROR 23503
-- because a table written by a projection trigger had a foreign key to camps,
-- and an FK violation inside a trigger aborts the ORIGINAL blob save — a
-- camper failing to save because of a bookkeeping row. Adding an FK to the ten
-- projection tables would reintroduce exactly that. A trigger on camps adds no
-- new way for any write to fail: it only runs when a camp is being deleted.
--
-- WHY IT REFUSES RATHER THAN HALF-DELETES. purge_camp_data re-checks every
-- table afterwards and raises if anything is left, which aborts the camp
-- deletion. A camp that still exists with its data intact is a state somebody
-- can fix. A camp that is gone with half its data behind is this file.
--
-- WHAT IT DOES NOT DO. It does not touch the two soft-delete conventions this
-- project uses on purpose — camp_people.deleted_at and camp_families' absence
-- handling are about a person leaving a camp, not a camp ceasing to exist.
-- Deleting the camp deletes those rows too, which is the point.
--
-- HOW TO APPLY. Paste the whole file into the SQL Editor. One transaction,
-- idempotent, and it deletes nothing by itself — the dry-run report at the
-- bottom tells you what the second step would remove.
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

-- ─── 0. preflight ───────────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_name = 'camps') THEN
        RAISE EXCEPTION 'camps is missing — this file has nothing to hang a trigger on';
    END IF;
END $$;

-- Section 4 rebuilds foreign keys, which takes AccessExclusive on the child
-- table and ShareRowExclusive on camps. That is brief, but "brief" is not
-- "cannot wait": a checkout writing cardknox_checkout_intents at that instant
-- can hold the row this file wants. 216's lesson is that a migration which
-- hangs holding locks is worse than one that fails and can be run again.
SET LOCAL lock_timeout = '15s';


-- ─── 1. which tables belong to a camp ───────────────────────────────────────
-- Discovered, never listed. Any ordinary table in public with a uuid column
-- named camp_id belongs to a camp, and that is the whole rule — so a table
-- added next year is covered without anyone remembering this file exists.
--
-- copy_camp_id is here and source_camp_id deliberately is NOT. debug_copies
-- has both: copy_camp_id is the sandbox camp the row is ABOUT, so deleting
-- that camp must take the registry row; source_camp_id points at the camp it
-- was cloned FROM, and deleting the original must not delete the registry
-- entry for a copy that still exists.
--
-- camp_state_kv sorts first. Its own AFTER DELETE triggers (202, 205) clear the
-- ledger and billing projections, so letting it go first means those tables are
-- already empty when the loop reaches them, instead of being repopulated behind
-- it. The convergence check below would catch that either way; this just means
-- the common case takes one pass.
CREATE OR REPLACE FUNCTION public._camp_scoped_tables()
RETURNS TABLE (table_name text, camp_col text)
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
    SELECT c.relname::text, a.attname::text
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND c.relname <> 'camps'
       AND a.attnum > 0
       AND NOT a.attisdropped
       AND a.atttypid = 'uuid'::regtype
       AND a.attname IN ('camp_id', 'copy_camp_id')
     ORDER BY (c.relname <> 'camp_state_kv'), c.relname
$$;
COMMENT ON FUNCTION public._camp_scoped_tables() IS
    'Every public table that belongs to a camp, discovered from the catalog. camp_state_kv first.';


-- ─── 2. the purge ───────────────────────────────────────────────────────────
-- Passes, not one sweep, because camp-scoped tables reference each other
-- (pickup_alert_recipients → pickup_alerts) and the catalog order is
-- alphabetical, not topological. A pass that hits a child-blocked table catches
-- foreign_key_violation, leaves it, and the next pass finds its blocker gone.
-- The loop stops when a whole pass deletes nothing.
--
-- Then it counts. Six passes is generous for a graph this shallow, but
-- "generous" is a guess, and a guess that is wrong must not present itself as
-- a completed deletion — so the final check is an actual count of every table,
-- and anything left raises. Called from the trigger, that raise aborts the
-- camp's deletion: the camp and all its data stay, and the message names the
-- table that would not clear.
CREATE OR REPLACE FUNCTION public.purge_camp_data(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    t        record;
    v_counts jsonb   := '{}'::jsonb;
    v_n      bigint;
    v_pass   integer := 0;
    v_moved  boolean := true;
BEGIN
    IF p_camp_id IS NULL THEN
        RETURN jsonb_build_object('error', 'missing_camp');
    END IF;

    WHILE v_moved AND v_pass < 6 LOOP
        v_moved := false;
        v_pass  := v_pass + 1;
        FOR t IN SELECT * FROM public._camp_scoped_tables() LOOP
            BEGIN
                EXECUTE format('DELETE FROM public.%I WHERE %I = $1', t.table_name, t.camp_col)
                  USING p_camp_id;
                GET DIAGNOSTICS v_n = ROW_COUNT;
            EXCEPTION WHEN foreign_key_violation THEN
                -- Another camp-scoped table still points at these rows. It is
                -- either later in this pass or blocked itself; try again next
                -- pass. Only this table's DELETE rolls back, not the others.
                CONTINUE;
            END;
            IF v_n > 0 THEN
                v_moved  := true;
                v_counts := jsonb_set(v_counts, ARRAY[t.table_name],
                    to_jsonb(COALESCE((v_counts ->> t.table_name)::bigint, 0) + v_n));
            END IF;
        END LOOP;
    END LOOP;

    -- The honest part. Everything above is an attempt; this is the assertion.
    FOR t IN SELECT * FROM public._camp_scoped_tables() LOOP
        EXECUTE format('SELECT count(*) FROM public.%I WHERE %I = $1', t.table_name, t.camp_col)
           INTO v_n USING p_camp_id;
        IF v_n > 0 THEN
            RAISE EXCEPTION
                'purge_camp_data: % rows left in %.% for camp % after % passes — camp NOT deleted',
                v_n, 'public', t.table_name, p_camp_id, v_pass;
        END IF;
    END LOOP;

    RETURN v_counts;
END;
$$;
REVOKE ALL ON FUNCTION public.purge_camp_data(uuid) FROM public, anon, authenticated;
COMMENT ON FUNCTION public.purge_camp_data(uuid) IS
    'Deletes every camp-scoped row for one camp, or raises leaving everything intact.';


-- ─── 3. the trigger ─────────────────────────────────────────────────────────
-- BEFORE, not AFTER. Seven tables hold a foreign key to camps that does not
-- cascade (section 4 fixes those, but a future one may arrive the same way);
-- clearing the children before the parent row goes means referential integrity
-- is satisfied by construction rather than by ordering luck between user
-- triggers and the internal RI triggers, which is not something this file
-- should be betting on.
CREATE OR REPLACE FUNCTION public.camps_purge_data()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    PERFORM public.purge_camp_data(OLD.id);
    RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.camps_purge_data() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS trg_purge_camp_data ON public.camps;
CREATE TRIGGER trg_purge_camp_data
BEFORE DELETE ON public.camps
FOR EACH ROW
EXECUTE FUNCTION public.camps_purge_data();


-- ─── 4. foreign keys that block instead of following ────────────────────────
-- A foreign key to camps with no delete action refuses the delete; with
-- CASCADE it follows it. Since these tables ALREADY enforce the key, nothing
-- about inserting into them changes — only what happens to them when their
-- camp goes, which until now was "the camp cannot go".
--
-- SET NULL and SET DEFAULT are left alone and reported by the verifier
-- instead. Those are a deliberate choice by whoever wrote them — keep the row,
-- detach it — and silently converting a deliberate choice into a deletion is
-- not a decision a migration gets to make on its own.
DO $$
DECLARE
    r     record;
    v_def text;
BEGIN
    FOR r IN
        SELECT con.conname AS name, child.relname AS child,
               pg_get_constraintdef(con.oid) AS def
          FROM pg_constraint con
          JOIN pg_class     child ON child.oid = con.conrelid
          JOIN pg_namespace nsp   ON nsp.oid   = child.relnamespace
          JOIN pg_class     ref   ON ref.oid   = con.confrelid
         WHERE con.contype = 'f'
           AND nsp.nspname = 'public'
           AND ref.relname = 'camps'
           AND con.confdeltype IN ('a', 'r')      -- NO ACTION, RESTRICT
    LOOP
        -- NO ACTION is the default and is not printed, so most defs need
        -- nothing stripped; RESTRICT is printed and must go before the new
        -- action is appended.
        v_def := regexp_replace(r.def, '\s+ON\s+DELETE\s+(NO\s+ACTION|RESTRICT)', '', 'i');
        EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', r.child, r.name);
        EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I %s ON DELETE CASCADE',
                       r.child, r.name, v_def);
        RAISE NOTICE 'public.%.% now cascades on camp delete', r.child, r.name;
    END LOOP;
END $$;


-- ─── 5. clearing what the old path left behind ──────────────────────────────
-- DRY RUN BY DEFAULT. purge_orphaned_camp_data() counts; only
-- purge_orphaned_camp_data(true) deletes. There is no undo for 2,194 rows, and
-- a function whose no-argument form destroys data is a function somebody
-- destroys data with by accident.
--
-- "Orphan" means the camp_id points at no row in camps. It deliberately does
-- NOT mean "old", "empty" or "looks like a test": every camp that still exists
-- keeps everything, however dead it looks.
CREATE OR REPLACE FUNCTION public.purge_orphaned_camp_data(p_confirm boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    t        record;
    v_counts jsonb   := '{}'::jsonb;
    v_total  bigint  := 0;
    v_n      bigint;
    v_pass   integer := 0;
    v_moved  boolean := true;
    v_camps  bigint;
    v_left   bigint;
BEGIN
    -- A count of orphaned camp_ids is worth reporting on its own: it is the
    -- number in the sentence "42 camps that no longer exist".
    SELECT count(DISTINCT x.camp_id) INTO v_camps
      FROM public.camp_state_kv x
     WHERE NOT EXISTS (SELECT 1 FROM public.camps c WHERE c.id = x.camp_id);

    IF NOT p_confirm THEN
        FOR t IN SELECT * FROM public._camp_scoped_tables() LOOP
            EXECUTE format(
                'SELECT count(*) FROM public.%I x WHERE x.%I IS NOT NULL'
                || ' AND NOT EXISTS (SELECT 1 FROM public.camps c WHERE c.id = x.%I)',
                t.table_name, t.camp_col, t.camp_col) INTO v_n;
            IF v_n > 0 THEN
                v_total  := v_total + v_n;
                v_counts := jsonb_set(v_counts, ARRAY[t.table_name], to_jsonb(v_n));
            END IF;
        END LOOP;
        RETURN jsonb_build_object(
            'dry_run', true, 'deleted', false,
            'orphaned_camps', v_camps, 'rows_that_would_go', v_total, 'by_table', v_counts,
            'to_delete_them', 'SELECT public.purge_orphaned_camp_data(true);');
    END IF;

    WHILE v_moved AND v_pass < 6 LOOP
        v_moved := false;
        v_pass  := v_pass + 1;
        FOR t IN SELECT * FROM public._camp_scoped_tables() LOOP
            BEGIN
                EXECUTE format(
                    'DELETE FROM public.%I x WHERE x.%I IS NOT NULL'
                    || ' AND NOT EXISTS (SELECT 1 FROM public.camps c WHERE c.id = x.%I)',
                    t.table_name, t.camp_col, t.camp_col);
                GET DIAGNOSTICS v_n = ROW_COUNT;
            EXCEPTION WHEN foreign_key_violation THEN
                CONTINUE;
            END;
            IF v_n > 0 THEN
                v_moved  := true;
                v_total  := v_total + v_n;
                v_counts := jsonb_set(v_counts, ARRAY[t.table_name],
                    to_jsonb(COALESCE((v_counts ->> t.table_name)::bigint, 0) + v_n));
            END IF;
        END LOOP;
    END LOOP;

    -- Counted again rather than deduced from the loop, and counted HERE rather
    -- than by calling verify_camp_deletion() — that function is defined further
    -- down this file, and PL/pgSQL resolves a name when the line first runs.
    -- Migration 221 is the whole reason that sentence is in this file: 219
    -- called a function that could not be resolved, applied cleanly, and threw
    -- on the first real purchase.
    v_n := 0;
    FOR t IN SELECT * FROM public._camp_scoped_tables() LOOP
        EXECUTE format(
            'SELECT count(*) FROM public.%I x WHERE x.%I IS NOT NULL'
            || ' AND NOT EXISTS (SELECT 1 FROM public.camps c WHERE c.id = x.%I)',
            t.table_name, t.camp_col, t.camp_col) INTO v_left;
        v_n := v_n + v_left;
    END LOOP;

    RETURN jsonb_build_object(
        'dry_run', false, 'deleted', true,
        'orphaned_camps', v_camps, 'rows_deleted', v_total, 'by_table', v_counts,
        'passes', v_pass,
        'still_orphaned', v_n);
END;
$$;
REVOKE ALL ON FUNCTION public.purge_orphaned_camp_data(boolean) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_orphaned_camp_data(boolean) TO service_role;


-- ─── 6. the verifier ────────────────────────────────────────────────────────
-- Camp-wide, so there is no p_camp_id to gate on and nothing sensitive in the
-- answer: it reports counts of data belonging to camps that do not exist.
CREATE OR REPLACE FUNCTION public.verify_camp_deletion()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    t         record;
    v_n       bigint;
    v_total   bigint := 0;
    v_tables  integer := 0;
    v_worst   jsonb  := '{}'::jsonb;
    v_camps   bigint;
    v_notcasc jsonb  := '[]'::jsonb;
BEGIN
    SELECT count(*) INTO v_tables FROM public._camp_scoped_tables();

    SELECT count(DISTINCT x.camp_id) INTO v_camps
      FROM public.camp_state_kv x
     WHERE NOT EXISTS (SELECT 1 FROM public.camps c WHERE c.id = x.camp_id);

    FOR t IN SELECT * FROM public._camp_scoped_tables() LOOP
        EXECUTE format(
            'SELECT count(*) FROM public.%I x WHERE x.%I IS NOT NULL'
            || ' AND NOT EXISTS (SELECT 1 FROM public.camps c WHERE c.id = x.%I)',
            t.table_name, t.camp_col, t.camp_col) INTO v_n;
        IF v_n > 0 THEN
            v_total := v_total + v_n;
            v_worst := jsonb_set(v_worst, ARRAY[t.table_name], to_jsonb(v_n));
        END IF;
    END LOOP;

    -- A foreign key that detaches instead of following. Reported, not changed:
    -- section 4 explains why.
    SELECT COALESCE(jsonb_agg(child.relname || '.' || con.conname), '[]'::jsonb)
      INTO v_notcasc
      FROM pg_constraint con
      JOIN pg_class     child ON child.oid = con.conrelid
      JOIN pg_namespace nsp   ON nsp.oid   = child.relnamespace
      JOIN pg_class     ref   ON ref.oid   = con.confrelid
     WHERE con.contype = 'f' AND nsp.nspname = 'public'
       AND ref.relname = 'camps' AND con.confdeltype <> 'c';

    RETURN jsonb_build_object(
        'success', true,
        'camp_scoped_tables', v_tables,
        'trigger_installed', EXISTS (
            SELECT 1 FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
             WHERE c.relname = 'camps' AND tg.tgname = 'trg_purge_camp_data'
               AND NOT tg.tgisinternal),
        'orphaned_camps', v_camps,
        'orphan_rows', v_total,
        'orphans_by_table', v_worst,
        'fks_that_do_not_cascade', v_notcasc);
END;
$$;
REVOKE ALL ON FUNCTION public.verify_camp_deletion() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.verify_camp_deletion() TO authenticated, service_role;


-- ─── 7. did one camp's deletion actually clear? ─────────────────────────────
-- For the client to call after deleting a camp, so "Data cleared" stops being
-- a sentence nobody verified. It runs as owner, so it sees rows the caller's
-- RLS would hide — a count of 0 read under RLS after leaving the camp proves
-- nothing, which is how this whole failure stayed invisible.
CREATE OR REPLACE FUNCTION public.verify_camp_deleted(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_claims text := NULLIF(current_setting('request.jwt.claims', true), '');
    v_exists boolean;
    t        record;
    v_n      bigint;
    v_total  bigint := 0;
    v_left   jsonb  := '{}'::jsonb;
BEGIN
    IF p_camp_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_camp');
    END IF;

    SELECT EXISTS (SELECT 1 FROM public.camps c WHERE c.id = p_camp_id) INTO v_exists;

    -- Gated the way 211's verifier is, for the reason 202's had to be fixed:
    -- the SQL Editor carries no JWT, so camp_reader() would refuse the owner.
    -- The exemption is for "no claims", not "any claims".
    --
    -- The camp still existing is what makes an ownership check possible at
    -- all. Once it is deleted there is no owner row left to compare against,
    -- and the answer — how many rows reference a camp id that names no camp —
    -- belongs to nobody.
    IF v_exists AND v_claims IS NOT NULL
       AND COALESCE(v_claims::jsonb ->> 'role', '') <> 'service_role'
       AND NOT public.camp_reader(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    FOR t IN SELECT * FROM public._camp_scoped_tables() LOOP
        EXECUTE format('SELECT count(*) FROM public.%I WHERE %I = $1', t.table_name, t.camp_col)
           INTO v_n USING p_camp_id;
        IF v_n > 0 THEN
            v_total := v_total + v_n;
            v_left  := jsonb_set(v_left, ARRAY[t.table_name], to_jsonb(v_n));
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'success', true,
        'camp_row_still_there', v_exists,
        'rows_left', v_total,
        'left_by_table', v_left,
        'fully_deleted', (NOT v_exists AND v_total = 0));
END;
$$;
REVOKE ALL ON FUNCTION public.verify_camp_deleted(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.verify_camp_deleted(uuid) TO authenticated, service_role;


-- ─── did it work? ───────────────────────────────────────────────────────────
-- Nothing above deleted anything. This is the dry run: read it, then run the
-- one line it hands back.
SELECT 'migration 222 applied'                     AS status,
       public.verify_camp_deletion()               AS state,
       public.purge_orphaned_camp_data()           AS dry_run;
