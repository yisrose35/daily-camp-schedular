-- =============================================================================
-- 193 — plan the second half while the first half is running
--
-- A camp runs on one set of operational state: who is in which bunk, what the
-- divisions are, which bus goes where, what the schedule layers look like, what
-- the rotation history says. All of it singular. So an office three weeks out
-- from the second half has two options: overwrite the running camp, or work on
-- paper.
--
-- A WORKSPACE is a named copy of that state. One is LIVE — it is the camp. The
-- others are SANDBOXES: fully editable, fully saved, invisible to counsellors
-- and parents. On the day, a sandbox is PROMOTED: it becomes live and the
-- outgoing live workspace is archived as a sandbox, so last half's bunk lists
-- and routes are still there to look at.
--
-- ── THE LIVE WORKSPACE USES THE BARE KEYS ───────────────────────────────────
--
-- `app1` is `app1`. Not `ws:live/app1`, not a row with a workspace column — the
-- same key in the same place every reader in this app has always used.
--
-- That is the entire risk model, not a convenience. Every page, script and edge
-- function that reads `app1` keeps reading `app1` and keeps working, knowing
-- nothing about workspaces. A sandbox writes to a PREFIXED key and can
-- therefore reach nothing. If the workspace layer broke completely the worst
-- available outcome is that somebody's sandbox looks empty: the running camp is
-- the code path this feature does not participate in.
--
-- It also means this migration needs no change to camp_state_kv — no new
-- column, no new primary key, no RLS rewrite. A sandbox is just more rows.
--
-- ── IDENTITY AND MONEY ARE NEVER WORKSPACED ─────────────────────────────────
--
-- Families, enrollments, the ledger, payroll, canteen and shop balances stay on
-- the bare key in every mode. A payment is a fact about the world; there is no
-- such thing as a sandbox payment, and no camp may ever "promote" a balance.
-- The operational key list below is therefore explicit and closed: a key nobody
-- has classified is GLOBAL and stays shared. A key that should have been
-- sandboxed and was not is a planning inconvenience. A key that should have
-- been global and got sandboxed could put a summer of money in a draft.
--
-- ── PROMOTION IS ONE TRANSACTION ────────────────────────────────────────────
--
-- Archive-then-promote, both halves of the swap, under a lock, in one
-- statement-level transaction. A promotion that half-finished would leave a
-- camp running on a mixture of two halves' bunk lists on the first morning of
-- the session, which is the single worst outcome this feature can produce.
--
-- Standalone — not in APPLY_BUNDLE.sql. Paste this file on its own. Idempotent.
-- Mirrors campistry_workspace.js; the key list is duplicated there deliberately
-- (client-side routing needs it before any round trip) and a test pins them
-- together.
-- =============================================================================

-- ─── 1. the registry ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.camp_workspaces (
    camp_id     uuid        NOT NULL,
    id          text        NOT NULL,       -- 'second_half'; never 'live'
    label       text        NOT NULL,       -- '2nd Half', what a human reads
    session     text,                       -- the session this plans for, if any
    status      text        NOT NULL DEFAULT 'sandbox',  -- sandbox | archived
    created_at  timestamptz NOT NULL DEFAULT now(),
    created_by  uuid,
    promoted_at timestamptz,                -- when it last became live
    retired_at  timestamptz,                -- when it stopped being live
    PRIMARY KEY (camp_id, id),
    CONSTRAINT camp_workspaces_id_not_live CHECK (id <> 'live'),
    CONSTRAINT camp_workspaces_status CHECK (status IN ('sandbox', 'archived'))
);

COMMENT ON TABLE public.camp_workspaces IS
    'Named planning copies of a camp''s operational state. The LIVE workspace is '
    'deliberately NOT in this table: live is the absence of a key prefix, so that '
    'every existing reader keeps working and no workspace bug can reach it.';

ALTER TABLE public.camp_workspaces ENABLE ROW LEVEL SECURITY;
-- No policies: RLS on with none means no direct access for anon or
-- authenticated. Everything goes through the owner-checked functions below.
REVOKE ALL ON TABLE public.camp_workspaces FROM anon, authenticated;

-- Which workspace each USER is currently looking at. Per user, not per camp:
-- one person planning next half must not move everybody else's screen, and an
-- office with two people in it will have one in live and one in a sandbox.
CREATE TABLE IF NOT EXISTS public.camp_workspace_selection (
    camp_id    uuid        NOT NULL,
    user_id    uuid        NOT NULL,
    workspace  text        NOT NULL DEFAULT 'live',
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (camp_id, user_id)
);
ALTER TABLE public.camp_workspace_selection ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.camp_workspace_selection FROM anon, authenticated;

-- ─── 2. the key list, server-side ───────────────────────────────────────────
/**
 * The operational keys a workspace owns a copy of.
 *
 * Mirrors campistry_workspace.js OPERATIONAL exactly. Duplicated rather than
 * fetched because the client has to route a read before it can make one.
 */
CREATE OR REPLACE FUNCTION public.workspace_operational_keys()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT ARRAY[
        'app1', 'campStructure', 'bunkMetaData', 'fields', 'campPeriods',
        'campistryGo', 'campistryLuggage',
        'leaguesByName', 'specialtyLeagues', 'leagueRoundState',
        -- History and rotation. Sandboxed because GENERATING a trial schedule
        -- writes rotation counts as a side effect, and a shared history would
        -- let a week of planning decide who gets the good activities in the
        -- camp that is actually running.
        'rotationHistory', 'rotationEpoch', 'swimRotationHistory',
        'historicalCounts', 'historicalCountsByDate', 'historicalCountedDates',
        'activityHistory', 'leagueHistory', 'specialtyLeagueHistory',
        'manualUsageOffsets', 'solverV3LearningData', 'scheduleViewIncrement'
    ];
$$;

/** The stored key for one logical key in one workspace. Live is the bare key. */
CREATE OR REPLACE FUNCTION public.workspace_key(p_key text, p_workspace text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE
        WHEN COALESCE(NULLIF(btrim(COALESCE(p_workspace, '')), ''), 'live') = 'live'
            THEN p_key
        WHEN NOT (p_key = ANY (public.workspace_operational_keys()))
            THEN p_key                       -- global keys are never prefixed
        ELSE 'ws:' || p_workspace || '/' || p_key
    END;
$$;

-- ─── 3. who may do any of this ──────────────────────────────────────────────
/** Owner-only. Creating and promoting a workspace changes what the camp IS. */
CREATE OR REPLACE FUNCTION public._workspace_is_owner(p_camp_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT EXISTS (SELECT 1 FROM camps c WHERE c.id = p_camp_id AND c.owner = auth.uid());
$$;

-- ─── 4. create a sandbox, seeded from live ──────────────────────────────────
/**
 * Make a new sandbox and COPY live's operational state into it.
 *
 * Seeded on creation, in one statement, deliberately. The alternative — an
 * empty sandbox that reads through to live for any key it does not have — is
 * worse than it looks: the first write copies one key, every other key still
 * silently shows live, and the office is editing a half-copy without being able
 * to tell. A seeded sandbox that is missing a key is simply empty, which is
 * honest and visible.
 */
CREATE OR REPLACE FUNCTION public.create_workspace(
    p_camp_id uuid,
    p_id      text,
    p_label   text,
    p_session text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_id     text := lower(regexp_replace(COALESCE(p_id, ''), '[^a-zA-Z0-9]+', '_', 'g'));
    v_copied int  := 0;
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF NOT public._workspace_is_owner(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_owner');
    END IF;

    v_id := btrim(v_id, '_');
    IF v_id = '' OR v_id = 'live' THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_id');
    END IF;
    IF EXISTS (SELECT 1 FROM camp_workspaces w WHERE w.camp_id = p_camp_id AND w.id = v_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'already_exists');
    END IF;

    INSERT INTO camp_workspaces (camp_id, id, label, session, status, created_by)
    VALUES (p_camp_id, v_id,
            COALESCE(NULLIF(btrim(COALESCE(p_label, '')), ''), v_id),
            NULLIF(btrim(COALESCE(p_session, '')), ''),
            'sandbox', auth.uid());

    -- Copy live's operational keys in. ON CONFLICT DO NOTHING so a re-run after
    -- a partial failure tops up rather than clobbering work already done in the
    -- sandbox.
    INSERT INTO camp_state_kv (camp_id, key, value, updated_at)
    SELECT kv.camp_id, public.workspace_key(kv.key, v_id), kv.value, now()
      FROM camp_state_kv kv
     WHERE kv.camp_id = p_camp_id
       AND kv.key = ANY (public.workspace_operational_keys())
    ON CONFLICT (camp_id, key) DO NOTHING;
    GET DIAGNOSTICS v_copied = ROW_COUNT;

    RETURN jsonb_build_object('success', true, 'id', v_id, 'copied', v_copied);
END;
$$;

-- ─── 5. the switch ──────────────────────────────────────────────────────────
/** Strip a workspace prefix off a stored key. Used by promote_workspace below. */
CREATE OR REPLACE FUNCTION public.parse_workspace_key(p_stored text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE
        WHEN p_stored LIKE 'ws:%/%'
            THEN substring(p_stored from position('/' in p_stored) + 1)
        ELSE p_stored
    END;
$$;

/**
 * Make a sandbox live, and archive the workspace it replaces.
 *
 * Both halves of the swap happen in ONE transaction, under a lock on the camp's
 * registry rows. A promotion that half-finished would have a camp running on a
 * mixture of two halves' bunk lists on the first morning of a session — the
 * worst thing this feature could do — so there is no path here that writes one
 * side without the other.
 *
 * The mechanics are a three-way rename, because the live keys are bare:
 *   live `app1`            → `ws:<outgoing>/app1`   (archive)
 *   `ws:<incoming>/app1`   → `app1`                 (promote)
 *
 * The outgoing workspace id is generated rather than asked for, so a promotion
 * can never be told to overwrite an existing archive.
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

    -- PROMOTE: the incoming workspace's keys become the bare (live) keys.
    UPDATE camp_state_kv kv
       SET key = public.parse_workspace_key(kv.key), updated_at = now()
     WHERE kv.camp_id = p_camp_id
       AND kv.key = ANY (SELECT 'ws:' || p_id || '/' || k
                           FROM unnest(public.workspace_operational_keys()) AS k);
    GET DIAGNOSTICS v_promoted = ROW_COUNT;

    -- The promoted workspace no longer exists as a sandbox: it IS live now, and
    -- live is the absence of a prefix, so its registry row goes.
    DELETE FROM camp_workspaces w WHERE w.camp_id = p_camp_id AND w.id = p_id;

    -- Anybody sitting in the workspace that just became live belongs in live.
    UPDATE camp_workspace_selection s
       SET workspace = 'live', updated_at = now()
     WHERE s.camp_id = p_camp_id AND s.workspace = p_id;

    RETURN jsonb_build_object('success', true, 'promoted', p_id,
                              'archived_as', v_out_id, 'archived_label', v_out_lab,
                              'keys_archived', v_moved, 'keys_promoted', v_promoted);
END;
$$;

-- ─── 6. reading the registry, and choosing one ──────────────────────────────
CREATE OR REPLACE FUNCTION public.list_workspaces(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_rows jsonb;
    v_sel  text;
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    -- Reading the list is a staff-level thing; only creating and promoting are
    -- owner-only. A scheduler needs to know which workspace they are in.
    -- Migration 183's helper: owner, or any accepted staff member. Reused rather
    -- than re-implemented, because two spellings of "is this person staff here"
    -- is two things to keep in step.
    IF NOT public.camp_staff_member(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
               'id', w.id, 'label', w.label, 'session', w.session,
               'status', w.status, 'created_at', w.created_at,
               'retired_at', w.retired_at
           ) ORDER BY w.created_at DESC), '[]'::jsonb)
      INTO v_rows
      FROM camp_workspaces w WHERE w.camp_id = p_camp_id;

    SELECT s.workspace INTO v_sel
      FROM camp_workspace_selection s
     WHERE s.camp_id = p_camp_id AND s.user_id = auth.uid();

    RETURN jsonb_build_object('success', true,
        'workspaces', v_rows,
        -- Whether this caller may CREATE, PROMOTE or DELETE. Reading the list is
        -- staff-level (a scheduler has to know which session they are in), but
        -- managing workspaces is owner-only, and the client needs to be told
        -- which so it does not offer buttons that will be refused.
        'is_owner', public._workspace_is_owner(p_camp_id),
        -- A selection pointing at a workspace that no longer exists (promoted,
        -- or deleted) resolves to live rather than to nothing.
        'selected', CASE
            WHEN v_sel IS NULL OR v_sel = 'live' THEN 'live'
            WHEN EXISTS (SELECT 1 FROM camp_workspaces w
                          WHERE w.camp_id = p_camp_id AND w.id = v_sel) THEN v_sel
            ELSE 'live'
        END);
END;
$$;

CREATE OR REPLACE FUNCTION public.select_workspace(p_camp_id uuid, p_workspace text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_ws text := COALESCE(NULLIF(btrim(COALESCE(p_workspace, '')), ''), 'live');
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    -- Migration 183's helper: owner, or any accepted staff member. Reused rather
    -- than re-implemented, because two spellings of "is this person staff here"
    -- is two things to keep in step.
    IF NOT public.camp_staff_member(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;
    IF v_ws <> 'live' AND NOT EXISTS (
        SELECT 1 FROM camp_workspaces w WHERE w.camp_id = p_camp_id AND w.id = v_ws) THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_such_workspace');
    END IF;

    INSERT INTO camp_workspace_selection (camp_id, user_id, workspace, updated_at)
    VALUES (p_camp_id, auth.uid(), v_ws, now())
    ON CONFLICT (camp_id, user_id) DO UPDATE
      SET workspace = EXCLUDED.workspace, updated_at = now();

    RETURN jsonb_build_object('success', true, 'selected', v_ws);
END;
$$;

/** Throw a sandbox away. Never touches live, because live has no registry row. */
CREATE OR REPLACE FUNCTION public.delete_workspace(p_camp_id uuid, p_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE v_gone int := 0;
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

    DELETE FROM camp_workspaces w WHERE w.camp_id = p_camp_id AND w.id = p_id;
    UPDATE camp_workspace_selection s SET workspace = 'live', updated_at = now()
     WHERE s.camp_id = p_camp_id AND s.workspace = p_id;

    RETURN jsonb_build_object('success', true, 'deleted', p_id, 'keys_removed', v_gone);
END;
$$;

-- ─── 7. grants ──────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public._workspace_is_owner(uuid) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_workspace(uuid, text, text, text) FROM public, anon;
REVOKE ALL ON FUNCTION public.promote_workspace(uuid, text, text) FROM public, anon;
REVOKE ALL ON FUNCTION public.delete_workspace(uuid, text) FROM public, anon;
REVOKE ALL ON FUNCTION public.list_workspaces(uuid) FROM public, anon;
REVOKE ALL ON FUNCTION public.select_workspace(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.create_workspace(uuid, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.promote_workspace(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_workspace(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_workspaces(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.select_workspace(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_operational_keys() TO authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_key(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.parse_workspace_key(text) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- Verify after running:
--   -- nothing exists yet, and live is the answer:
--   select public.list_workspaces('<camp uuid>');
--   -- {"success": true, "workspaces": [], "selected": "live"}
--
--   -- make a sandbox for the second half; `copied` is how many keys came over:
--   select public.create_workspace('<camp uuid>', 'second_half', '2nd Half', '2nd Half');
--
--   -- the sandbox's rows exist and live's are untouched:
--   select key from camp_state_kv where camp_id = '<camp uuid>' and key like 'ws:%' order by key;
--   select key from camp_state_kv where camp_id = '<camp uuid>' and key = 'app1';
--
--   -- promote it. `keys_archived` and `keys_promoted` should both be non-zero:
--   select public.promote_workspace('<camp uuid>', 'second_half', '1st Half');
--
--   -- and now live is the second half's data, with the first half kept:
--   select id, label, status from camp_workspaces where camp_id = '<camp uuid>';
--
--   -- a non-owner is refused:
--   --   → {"success": false, "error": "not_owner"}
--
--   -- and live can never be deleted:
--   select public.delete_workspace('<camp uuid>', 'live');
--   -- {"success": false, "error": "cannot_delete_live"}
