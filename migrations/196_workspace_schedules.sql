-- ============================================================================
-- 196_workspace_schedules.sql
--
-- PUT SCHEDULES AND ROTATION COUNTS INSIDE THE SANDBOX.
--
-- Migration 193 sandboxed the operational state that lives in camp_state_kv:
-- bunks, divisions, periods, bus routes, league setup. Two things an office plans
-- ahead do NOT live there. `daily_schedules` and `rotation_counts` are their own
-- tables, keyed by date, and the client's key routing has no reach into them.
--
-- So generating a schedule inside a plan wrote real rows to the live
-- daily_schedules for those dates — visible to everyone, before the plan was
-- made official, and left behind if the plan was thrown away. And it wrote real
-- rotation_counts, which burned the live camp's rotation fairness. That second
-- one is worse than a gap, because campistry_workspace.js states in as many words
-- that it cannot happen:
--
--     'rotationHistory', ... // a trial schedule in a sandbox would otherwise
--                            // burn the live camp's rotation fairness
--
-- Half true. The kv history was protected; the cloud table was not.
--
-- ── WHY THIS IS ENFORCED HERE AND NOT IN THE CLIENT ────────────────────────
--
-- Those two tables are queried from 41 places across 12 files — the calendar, the
-- orchestrator, print, daily adjustments, the solver, trial guard. Routing each
-- one by hand would mean 41 chances to miss one, and a PARTIALLY routed schedule
-- table is worse than an unrouted one: reads and writes would disagree about which
-- workspace they are in, which is how a plan's schedule ends up half in live.
--
-- The server already knows which workspace each user has selected — 193 stores it
-- in camp_workspace_selection. So the boundary goes in RLS and a default, where it
-- is enforced rather than cooperated with:
--
--   * every row carries a `workspace`, defaulting to 'live'
--   * a trigger stamps new rows with the writer's CURRENT selection
--   * RLS lets a user see and touch only rows in the workspace they are in
--
-- Every existing query keeps working, unchanged, and is correct: a client in live
-- sees live's rows because that is all RLS will show it. A client that has never
-- heard of workspaces behaves exactly as it did before this ran.
--
-- ── ON PROMOTION ───────────────────────────────────────────────────────────
--
-- promote_workspace is replaced to move these rows the same way it moves the kv
-- keys: the outgoing live rows become the archive's, the promoted plan's become
-- live. Without that, making a plan official would swap its bunks in and leave
-- its schedules behind — which is the shape of the bug reported from live testing
-- as "a planned change didn't reach live".
--
-- Idempotent. Safe to run twice.
-- ============================================================================

-- ─── 1. The column ─────────────────────────────────────────────────────────
-- DEFAULT 'live' and NOT NULL: every row that exists today IS live's, because
-- this feature did not exist when they were written.

ALTER TABLE public.daily_schedules
    ADD COLUMN IF NOT EXISTS workspace text NOT NULL DEFAULT 'live';

ALTER TABLE public.rotation_counts
    ADD COLUMN IF NOT EXISTS workspace text NOT NULL DEFAULT 'live';

-- The uniqueness that matters changes shape: one row per (camp, date, bunk,
-- activity) PER WORKSPACE. Without this a plan's count for a date would collide
-- with live's and one would overwrite the other.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'rotation_counts_pkey'
           AND conrelid = 'public.rotation_counts'::regclass
    ) AND NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'rotation_counts_ws_pkey'
           AND conrelid = 'public.rotation_counts'::regclass
    ) THEN
        ALTER TABLE public.rotation_counts DROP CONSTRAINT rotation_counts_pkey;
        ALTER TABLE public.rotation_counts
            ADD CONSTRAINT rotation_counts_ws_pkey
            PRIMARY KEY (camp_id, workspace, date_key, bunk, activity);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_daily_schedules_camp_ws
    ON public.daily_schedules (camp_id, workspace, date_key);
CREATE INDEX IF NOT EXISTS idx_rotation_counts_camp_ws
    ON public.rotation_counts (camp_id, workspace);

-- ─── 2. Which workspace is this user in, right now? ────────────────────────
/**
 * The caller's selected workspace for a camp, or 'live'.
 *
 * STABLE rather than IMMUTABLE: it reads a table. Marked so the planner can still
 * hoist it out of a per-row RLS check instead of calling it once per row, which on
 * a season of schedules is the difference between a query and a wait.
 */
CREATE OR REPLACE FUNCTION public.current_workspace(p_camp_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT COALESCE(
        (SELECT s.workspace
           FROM camp_workspace_selection s
          WHERE s.camp_id = p_camp_id
            AND s.user_id = auth.uid()),
        'live');
$$;

REVOKE ALL ON FUNCTION public.current_workspace(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.current_workspace(uuid) TO authenticated;

-- ─── 3. Stamp new rows with the writer's workspace ─────────────────────────
/**
 * A client that does not set `workspace` gets the one it is actually in.
 *
 * This is what makes the 41 unrouted call sites correct rather than merely
 * unbroken: an insert from inside a plan lands in the plan without the inserting
 * code knowing plans exist. An explicit non-default value is left alone, so
 * promote_workspace can still move rows deliberately.
 */
CREATE OR REPLACE FUNCTION public._stamp_workspace()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    IF NEW.workspace IS NULL OR NEW.workspace = 'live' THEN
        NEW.workspace := public.current_workspace(NEW.camp_id);
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_daily_schedules_workspace ON public.daily_schedules;
CREATE TRIGGER trg_daily_schedules_workspace
    BEFORE INSERT ON public.daily_schedules
    FOR EACH ROW EXECUTE FUNCTION public._stamp_workspace();

DROP TRIGGER IF EXISTS trg_rotation_counts_workspace ON public.rotation_counts;
CREATE TRIGGER trg_rotation_counts_workspace
    BEFORE INSERT ON public.rotation_counts
    FOR EACH ROW EXECUTE FUNCTION public._stamp_workspace();

-- ─── 4. RLS: you only reach the workspace you are in ───────────────────────
-- The camp and role conditions are carried over from 003 and 002 unchanged; the
-- workspace condition is added to each. A user in live cannot see a plan's
-- schedules and a user in a plan cannot see live's, in either direction, whatever
-- the client asks for.

DROP POLICY IF EXISTS daily_schedules_select ON public.daily_schedules;
CREATE POLICY daily_schedules_select ON public.daily_schedules
    FOR SELECT
    USING (camp_id = get_user_camp_id()
           AND workspace = public.current_workspace(camp_id));

DROP POLICY IF EXISTS daily_schedules_insert ON public.daily_schedules;
CREATE POLICY daily_schedules_insert ON public.daily_schedules
    FOR INSERT
    WITH CHECK (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'scheduler'::text])
        AND workspace = public.current_workspace(camp_id)
    );

DROP POLICY IF EXISTS daily_schedules_update ON public.daily_schedules;
CREATE POLICY daily_schedules_update ON public.daily_schedules
    FOR UPDATE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'scheduler'::text])
        AND workspace = public.current_workspace(camp_id)
    );

-- DELETE stays owner/admin, per 003's reasoning, plus the workspace fence: an
-- owner clearing a day in a plan must not clear the live one.
DROP POLICY IF EXISTS daily_schedules_delete ON public.daily_schedules;
CREATE POLICY daily_schedules_delete ON public.daily_schedules
    FOR DELETE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text])
        AND workspace = public.current_workspace(camp_id)
    );

-- rotation_counts: 002 mirrored camp_state_kv's policies. Same treatment.
DROP POLICY IF EXISTS rotation_counts_select ON public.rotation_counts;
CREATE POLICY rotation_counts_select ON public.rotation_counts
    FOR SELECT
    USING (camp_id = get_user_camp_id()
           AND workspace = public.current_workspace(camp_id));

DROP POLICY IF EXISTS rotation_counts_insert ON public.rotation_counts;
CREATE POLICY rotation_counts_insert ON public.rotation_counts
    FOR INSERT
    WITH CHECK (camp_id = get_user_camp_id()
                AND workspace = public.current_workspace(camp_id));

DROP POLICY IF EXISTS rotation_counts_update ON public.rotation_counts;
CREATE POLICY rotation_counts_update ON public.rotation_counts
    FOR UPDATE
    USING (camp_id = get_user_camp_id()
           AND workspace = public.current_workspace(camp_id));

DROP POLICY IF EXISTS rotation_counts_delete ON public.rotation_counts;
CREATE POLICY rotation_counts_delete ON public.rotation_counts
    FOR DELETE
    USING (camp_id = get_user_camp_id()
           AND workspace = public.current_workspace(camp_id));

-- ─── 5. Promotion moves the schedules too ──────────────────────────────────
/**
 * Make a sandbox the live camp — now including its schedules and rotation counts.
 *
 * This is 193's function VERBATIM with two blocks inserted. It is generated from
 * 193's text rather than retyped, because the first attempt at this was retyped
 * and quietly lost five things: `updated_at = now()` on both key moves, the loop
 * that keeps two promotions in the same second from sharing an archive id, the
 * explicit operational-key list (replaced by a LIKE pattern that an id containing
 * `_` would over-match, `_` being a LIKE wildcard), the `no_such_workspace` guard,
 * and the `archived_label` the admin card reads back. Plus a syntax error:
 * `parse_workspace_key(...)` returns text, so `.key` on it does not parse.
 */
CREATE OR REPLACE FUNCTION public.promote_workspace(
    p_camp_id  uuid,
    p_id       text,
    p_archive_label text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_ws       camp_workspaces;
    v_out_id   text;
    v_out_lab  text;
    v_moved    int := 0;
    v_promoted int := 0;
    v_sched    int := 0;
    v_rot      int := 0;
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF NOT public._workspace_is_owner(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_owner');
    END IF;

    -- Serialize promotions for this camp. An advisory lock rather than FOR
    -- UPDATE on the registry: row locks only lock rows that exist, and the whole
    -- point here is to guard a rename of keys that live in a different table.
    PERFORM pg_advisory_xact_lock(hashtext('campistry_ws:' || p_camp_id::text));

    SELECT * INTO v_ws FROM camp_workspaces w
     WHERE w.camp_id = p_camp_id AND w.id = p_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_such_workspace');
    END IF;

    -- A unique id for the outgoing live state, so an archive can never land on
    -- top of an existing one.
    v_out_id  := 'archive_' || to_char(now(), 'YYYYMMDD_HH24MISS');
    v_out_lab := COALESCE(NULLIF(btrim(COALESCE(p_archive_label, '')), ''),
                          'Before ' || v_ws.label);
    WHILE EXISTS (SELECT 1 FROM camp_workspaces w WHERE w.camp_id = p_camp_id AND w.id = v_out_id) LOOP
        v_out_id := v_out_id || '_x';
    END LOOP;

    INSERT INTO camp_workspaces (camp_id, id, label, session, status, created_by, retired_at)
    VALUES (p_camp_id, v_out_id, v_out_lab, NULL, 'archived', auth.uid(), now());

    -- ARCHIVE: the bare (live) keys become the outgoing workspace's keys.
    UPDATE camp_state_kv kv
       SET key = public.workspace_key(kv.key, v_out_id), updated_at = now()
     WHERE kv.camp_id = p_camp_id
       AND kv.key = ANY (public.workspace_operational_keys());
    GET DIAGNOSTICS v_moved = ROW_COUNT;

    -- The same move for the two things that are NOT in camp_state_kv: schedules
    -- and rotation counts are their own tables (migration 196). Live's rows go to
    -- the archive BEFORE the plan's are renamed to live, or the two sets collide
    -- on rotation_counts' (camp, workspace, date, bunk, activity).
    UPDATE public.daily_schedules SET workspace = v_out_id
     WHERE camp_id = p_camp_id AND workspace = 'live';
    UPDATE public.rotation_counts SET workspace = v_out_id
     WHERE camp_id = p_camp_id AND workspace = 'live';

    -- PROMOTE: the incoming workspace's keys become the bare (live) keys.
    UPDATE camp_state_kv kv
       SET key = public.parse_workspace_key(kv.key), updated_at = now()
     WHERE kv.camp_id = p_camp_id
       AND kv.key = ANY (SELECT 'ws:' || p_id || '/' || k
                           FROM unnest(public.workspace_operational_keys()) AS k);
    GET DIAGNOSTICS v_promoted = ROW_COUNT;

    -- And the plan's become live's.
    UPDATE public.daily_schedules SET workspace = 'live'
     WHERE camp_id = p_camp_id AND workspace = p_id;
    GET DIAGNOSTICS v_sched = ROW_COUNT;
    UPDATE public.rotation_counts SET workspace = 'live'
     WHERE camp_id = p_camp_id AND workspace = p_id;
    GET DIAGNOSTICS v_rot = ROW_COUNT;

    -- The promoted workspace no longer exists as a sandbox: it IS live now, and
    -- live is the absence of a prefix, so its registry row goes.
    DELETE FROM camp_workspaces w WHERE w.camp_id = p_camp_id AND w.id = p_id;

    -- Anybody sitting in the workspace that just became live belongs in live.
    UPDATE camp_workspace_selection s
       SET workspace = 'live', updated_at = now()
     WHERE s.camp_id = p_camp_id AND s.workspace = p_id;

    RETURN jsonb_build_object('success', true, 'promoted', p_id,
                              'archived_as', v_out_id, 'archived_label', v_out_lab,
                              'keys_archived', v_moved, 'keys_promoted', v_promoted,
                              'schedules_promoted', v_sched,
                              'rotation_rows_promoted', v_rot);
END;
$$;

REVOKE ALL ON FUNCTION public.promote_workspace(uuid, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.promote_workspace(uuid, text, text) TO authenticated;

-- ─── 6. Deleting a plan throws its schedules away too ──────────────────────
/**
 * Replaces 193's delete_workspace so a discarded plan does not leave a season of
 * orphan schedule rows behind, invisible to everyone and counted by nothing.
 */
CREATE OR REPLACE FUNCTION public.delete_workspace(p_camp_id uuid, p_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE v_gone int := 0;
DECLARE v_sched int := 0;
DECLARE v_rot int := 0;
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF NOT public._workspace_is_owner(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_owner');
    END IF;
    IF p_id IS NULL OR p_id = 'live' THEN
        -- Belt and braces: 'live' has no row, so this could not have matched
        -- anything, but a delete_workspace(camp,'live') that returned success
        -- would read as though it had done something.
        RETURN jsonb_build_object('success', false, 'error', 'cannot_delete_live');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM camp_workspaces w WHERE w.camp_id = p_camp_id AND w.id = p_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_such_workspace');
    END IF;

    DELETE FROM camp_state_kv kv
     WHERE kv.camp_id = p_camp_id
       AND kv.key = ANY (SELECT 'ws:' || p_id || '/' || k
                           FROM unnest(public.workspace_operational_keys()) AS k);
    GET DIAGNOSTICS v_gone = ROW_COUNT;

    -- A discarded plan must not leave a season of schedule rows behind, invisible
    -- to everyone and counted by nothing (migration 196).
    DELETE FROM public.daily_schedules
     WHERE camp_id = p_camp_id AND workspace = p_id;
    GET DIAGNOSTICS v_sched = ROW_COUNT;

    DELETE FROM public.rotation_counts
     WHERE camp_id = p_camp_id AND workspace = p_id;
    GET DIAGNOSTICS v_rot = ROW_COUNT;

    DELETE FROM camp_workspaces w WHERE w.camp_id = p_camp_id AND w.id = p_id;
    UPDATE camp_workspace_selection s SET workspace = 'live', updated_at = now()
     WHERE s.camp_id = p_camp_id AND s.workspace = p_id;

    RETURN jsonb_build_object('success', true, 'deleted', p_id, 'keys_removed', v_gone,
                              'schedules_removed', v_sched,
                              'rotation_rows_removed', v_rot);
END;
$$;

REVOKE ALL ON FUNCTION public.delete_workspace(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.delete_workspace(uuid, text) TO authenticated;

-- ============================================================================
-- HOW TO RUN THIS
--   Supabase Dashboard -> SQL Editor -> New query -> paste this whole file -> Run.
--
-- HOW TO CHECK IT TOOK
--   -- every existing row is live's, because this feature did not exist:
--   select workspace, count(*) from daily_schedules group by workspace;
--
--   -- and generating inside a plan now lands in the plan:
--   select workspace, date_key, count(*) from daily_schedules
--    where camp_id = '<your camp uuid>' group by workspace, date_key
--    order by workspace, date_key;
-- ============================================================================
