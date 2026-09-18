-- =============================================================================
-- 200 — public submissions stop rewriting the whole camp
--
-- WHAT IS WRONG TODAY
--
-- submit_public_application is correct and it does not scale. Every submission:
--
--   1. takes SELECT ... FOR UPDATE on the ONE camp_state_kv row keyed
--      (camp_id, 'campistryMe'),
--   2. rewrites that row's ENTIRE jsonb value,
--   3. commits.
--
-- jsonb has no partial update. A multi-megabyte value is TOASTed, so step 2
-- rewrites the whole value's TOAST chunks, writes a new heap tuple and WALs all
-- of it. For a camp with a thousand campers that value is realistically 2–10 MB.
--
-- So submissions for one camp are FULLY SERIALISED, each paying the cost of the
-- entire camp's data, and the value grows with every one — the queue gets slower
-- as the evening goes on. At ~5 MB and ~50–150 ms a rewrite, a few hundred
-- families registering the hour a camp opens is a minute-plus of serialised work
-- and gigabytes of WAL. Families at the back of the queue hit the statement
-- timeout.
--
-- Worse, that same row is the one every payment webhook rewrites
-- (append_camp_payment and friends all SELECT the blob, modify it and write it
-- back) — so a registration burst and the card charges it triggers contend with
-- each other on a single lock.
--
-- ── WHAT THIS DOES ─────────────────────────────────────────────────────────
--
-- Submissions become ROWS. camp_applications is append-only and per-submission,
-- so two families registering touch two different rows and nothing serialises
-- except a genuine race for the last place in one session.
--
-- This is the same move migration 145 made for bank deposits: capture into a
-- purpose-built table, join it in at read time. 145's header says outright that
-- the payments should get there too; applications get there first because they
-- arrive in bursts and deposits do not.
--
-- ── THE LOCK GETS NARROWER, NOT WEAKER ─────────────────────────────────────
--
-- 190 counted places under a FOR UPDATE on the camp's whole row, which is what
-- makes overbooking impossible: two families submitting for the last place both
-- counted 39 without it. That guarantee is kept exactly, on a lock that covers
-- only what it has to — pg_advisory_xact_lock over (camp, session). Two families
-- racing for 1st Half still serialise; a family registering for 2nd Half, and
-- every payment webhook in flight, no longer wait behind them.
--
-- ── COUNTING WITHOUT DOUBLE COUNTING, AND WITHOUT A "CLAIMED" FLAG ─────────
--
-- During and after the transition a submission can be in the table, and — once
-- the office's browser has absorbed it — also in campistryMe.enrollments. A
-- naive count of both double-counts and under-fills every session.
--
-- The obvious fix is a claimed_at column the office sets when it absorbs a row.
-- It is not used here, because a row marked claimed by a fetch whose save then
-- failed is a row in neither place: the application is gone and the family saw
-- "Success!". That is the exact failure class this file exists to remove.
--
-- So absorption is DERIVED, not recorded: a table row whose entry_id is already
-- a key of campistryMe.enrollments is counted from the blob, and every other row
-- is counted from the table. Nothing to set, nothing to get stuck, and a fetch
-- that fails costs nothing but a retry.
--
-- ── WHAT STILL WRITES THE BLOB ─────────────────────────────────────────────
--
-- The office's own edits, exactly as before. An application is accepted,
-- declined, priced and enrolled in campistryMe, and campistry_finance_merge.js
-- keeps the office's save from erasing rows it has not seen yet. This migration
-- removes the BURST from the blob, not the office.
--
-- Standalone — not in APPLY_BUNDLE.sql. Paste this file on its own.
-- Idempotent. Requires 083 (the public RPCs), 184 (the submission guard),
-- 185 (the deposit) and 190 (capacity).
-- =============================================================================

-- ─── 1. the table ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.camp_applications (
    camp_id      uuid        NOT NULL REFERENCES public.camps(id) ON DELETE CASCADE,
    kind         text        NOT NULL,
    entry_id     text        NOT NULL,
    payload      jsonb       NOT NULL,
    -- Denormalised out of the payload so the capacity count is an index scan
    -- rather than a jsonb walk over every row in the camp.
    session      text,
    status       text        NOT NULL DEFAULT 'applied',
    submitted_at timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (camp_id, kind, entry_id),
    CONSTRAINT camp_applications_kind_ck
        CHECK (kind IN ('enrollments', 'staffApplications'))
);

-- The capacity count's index. Partial on kind because a staff application is
-- not a place in a session and must never be counted as one.
CREATE INDEX IF NOT EXISTS camp_applications_capacity_idx
    ON public.camp_applications (camp_id, session, status)
 WHERE kind = 'enrollments';

-- The office's drain reads newest-first for one camp.
CREATE INDEX IF NOT EXISTS camp_applications_camp_idx
    ON public.camp_applications (camp_id, kind, submitted_at DESC);

ALTER TABLE public.camp_applications ENABLE ROW LEVEL SECURITY;

-- ─── 2. RLS ──────────────────────────────────────────────────────────────────
-- Reads are for the camp's own staff. There is deliberately NO anon policy:
-- a family writes through the SECURITY DEFINER RPC below and reads their own
-- status through get_public_application_status (113), never the table.
DROP POLICY IF EXISTS camp_applications_read ON public.camp_applications;
CREATE POLICY camp_applications_read ON public.camp_applications
    FOR SELECT TO authenticated
    USING (public.get_user_role() IN ('owner', 'admin', 'scheduler'));

-- No INSERT/UPDATE/DELETE policy at all. Every write goes through a definer
-- function, so there is one place that decides what a submission may do —
-- which is the lesson of 083 and 184, applied from the start this time.
REVOKE ALL ON TABLE public.camp_applications FROM anon, authenticated;
GRANT SELECT ON TABLE public.camp_applications TO authenticated;

-- ─── 3. counting places, across both homes ───────────────────────────────────
/**
 * How many places in `p_session` are taken, counting the table and the blob
 * without counting anything twice.
 *
 * A row the office has already absorbed (its entry_id is a key of
 * campistryMe.enrollments) is counted from the blob, because the blob carries
 * the CURRENT status — the office may have declined it since, which frees the
 * place. Every other row is counted from the table.
 */
CREATE OR REPLACE FUNCTION public._session_taken_all(
    p_camp_id uuid,
    p_doc     jsonb,
    p_session text
)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
    SELECT public._session_taken(p_doc, p_session)
         + (SELECT count(*)::integer
              FROM public.camp_applications a
             WHERE a.camp_id = p_camp_id
               AND a.kind = 'enrollments'
               AND a.session = p_session
               AND a.status IN ('applied', 'waitlisted', 'accepted', 'enrolled')
               AND NOT coalesce(p_doc -> 'enrollments', '{}'::jsonb) ? a.entry_id);
$$;

-- ─── 4. the submission itself ────────────────────────────────────────────────
/**
 * Replaces 190's definition. Same contract, same guards, same waitlist
 * behaviour — it writes a row instead of the camp.
 */
CREATE OR REPLACE FUNCTION public.submit_public_application(
    p_camp_id  uuid,
    p_kind     text,
    p_entry_id text,
    p_entry    jsonb
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_doc      jsonb;
    v_existing jsonb;
    v_status   text;
    v_session  text;
    v_cap      integer;
    v_taken    integer;
    v_entry    jsonb := p_entry;
    v_waited   boolean := false;
BEGIN
    IF p_camp_id IS NULL OR p_entry_id IS NULL OR p_entry IS NULL OR jsonb_typeof(p_entry) <> 'object' THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_payload');
    END IF;
    IF p_kind NOT IN ('enrollments', 'staffApplications') THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_kind');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM camps WHERE id = p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'camp_not_found');
    END IF;
    -- 184: the id must be unguessable, because it is the only thing standing
    -- between an anonymous caller and somebody else's record.
    IF length(p_entry_id) < 32 THEN
        RETURN jsonb_build_object('success', false, 'error', 'weak_entry_id');
    END IF;
    -- 083's abuse guard on a genuinely public, unauthenticated endpoint.
    IF pg_column_size(p_entry) > 8388608 THEN
        RETURN jsonb_build_object('success', false, 'error', 'submission_too_large');
    END IF;

    v_session := NULLIF(btrim(COALESCE(p_entry ->> 'session', '')), '');

    -- THE LOCK, NARROWED. 190 held FOR UPDATE on the camp's whole campistryMe
    -- row; this holds an advisory lock over (camp, session) instead. Two
    -- families racing for the last place in 1st Half still serialise — which is
    -- the whole point — while a family registering for 2nd Half, and every
    -- payment webhook writing the blob, no longer queue behind them.
    --
    -- Taken before anything is counted, released at commit. Only registrations
    -- need it: a staff application is not a place.
    IF p_kind = 'enrollments' AND v_session IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(
            hashtext(p_camp_id::text || '|' || v_session));
    END IF;

    -- The blob is READ, never written here. It is needed for two things: the
    -- session's capacity (the office sets it on the dashboard) and which entry
    -- ids the office has already absorbed.
    SELECT value INTO v_doc
      FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe';

    -- 184: a public submission may create, or re-send, an entry that is still
    -- 'applied'. The moment the office has acted on it the public endpoint is
    -- shut out, or anyone who guessed an id could rewrite an accepted camper's
    -- record from an anonymous page.
    --
    -- Checked in BOTH homes: the table for anything submitted since this
    -- migration, the blob for everything before it and for anything the office
    -- has since absorbed and acted on. The blob wins when both have it, because
    -- the office's decision is the newer fact.
    SELECT to_jsonb(a) INTO v_existing
      FROM public.camp_applications a
     WHERE a.camp_id = p_camp_id AND a.kind = p_kind AND a.entry_id = p_entry_id;
    v_status := v_existing ->> 'status';

    IF v_doc IS NOT NULL AND jsonb_typeof(v_doc -> p_kind -> p_entry_id) = 'object' THEN
        v_status := COALESCE(v_doc -> p_kind -> p_entry_id ->> 'status', '');
    END IF;

    IF v_status IS NOT NULL AND v_status NOT IN ('applied', 'waitlisted') THEN
        RETURN jsonb_build_object('success', false, 'error', 'already_processed',
                                  'status', v_status);
    END IF;

    -- CAPACITY. Registrations only. An entry that already exists is being
    -- re-sent, so it is already counted and must not be pushed onto the
    -- waitlist by its own retry.
    IF p_kind = 'enrollments' AND v_session IS NOT NULL AND v_status IS NULL THEN
        SELECT greatest(0, coalesce(NULLIF(s ->> 'capacity', '')::numeric, 0)::integer)
          INTO v_cap
          FROM jsonb_array_elements(coalesce(v_doc -> 'sessions', '[]'::jsonb)) AS s
         WHERE s ->> 'name' = v_session
         LIMIT 1;

        -- A capacity of 0 or absent is UNLIMITED, the same as an empty box on
        -- the dashboard's own session form.
        IF COALESCE(v_cap, 0) > 0 THEN
            v_taken := public._session_taken_all(p_camp_id, coalesce(v_doc, '{}'::jsonb), v_session);
            IF v_taken >= v_cap THEN
                -- Full. Keep everything the family typed and queue them, rather
                -- than refusing and losing twenty minutes of their evening.
                v_entry := v_entry
                    || jsonb_build_object('status', 'waitlisted')
                    || jsonb_build_object('waitlistedAt', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF'))
                    -- Zeroed on the entry as well as in
                    -- _registration_deposit_owed: a family must not be asked to
                    -- pay to hold a place that does not exist.
                    || jsonb_build_object('depositRequired', 0);
                v_waited := true;
            END IF;
        END IF;
    END IF;

    -- ONE ROW. No lock on the camp, no rewrite of anything shared.
    INSERT INTO public.camp_applications
        (camp_id, kind, entry_id, payload, session, status, submitted_at, updated_at)
    VALUES (p_camp_id, p_kind, p_entry_id, v_entry, v_session,
            COALESCE(v_entry ->> 'status', 'applied'), now(), now())
    ON CONFLICT (camp_id, kind, entry_id) DO UPDATE
       SET payload    = EXCLUDED.payload,
           session    = EXCLUDED.session,
           status     = EXCLUDED.status,
           updated_at = now()
     -- A retry may re-send; anything the office has acted on was refused above,
     -- and this repeats that guard at the row level so a race cannot slip past.
     WHERE public.camp_applications.status IN ('applied', 'waitlisted');

    RETURN jsonb_build_object('success', true, 'id', p_entry_id,
                              'waitlisted', v_waited,
                              'status', COALESCE(v_entry ->> 'status', 'applied'));
END;
$$;
REVOKE ALL ON FUNCTION public.submit_public_application(uuid, text, text, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.submit_public_application(uuid, text, text, jsonb) TO anon, authenticated;

-- ─── 5. the office reads them ────────────────────────────────────────────────
/**
 * Every submission this camp has, newest first, for the office's browser to
 * merge into campistryMe.enrollments.
 *
 * Read-only and it marks NOTHING. See the header: a row marked absorbed by a
 * fetch whose save then failed is an application in neither place, and that is
 * the failure this whole file exists to remove. A fetch that fails costs a
 * retry and nothing else.
 */
CREATE OR REPLACE FUNCTION public.get_camp_applications(
    p_camp_id uuid,
    p_kind    text DEFAULT 'enrollments',
    p_since   timestamptz DEFAULT NULL,
    p_limit   integer DEFAULT 2000
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_out jsonb;
BEGIN
    IF p_camp_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_camp');
    END IF;
    IF p_kind NOT IN ('enrollments', 'staffApplications') THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_kind');
    END IF;
    -- Camp-scoped through 183's own helper, rather than a second opinion about
    -- what membership means. camp_staff_member accepts any accepted role, which
    -- is right here: a scheduler has to be able to see the applications.
    IF NOT public.camp_staff_member(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_a_member');
    END IF;

    SELECT coalesce(jsonb_object_agg(t.entry_id, t.payload), '{}'::jsonb)
      INTO v_out
      FROM (SELECT a.entry_id, a.payload
              FROM public.camp_applications a
             WHERE a.camp_id = p_camp_id
               AND a.kind = p_kind
               AND (p_since IS NULL OR a.updated_at > p_since)
             ORDER BY a.submitted_at DESC
             LIMIT greatest(1, least(coalesce(p_limit, 2000), 5000))) AS t;

    RETURN jsonb_build_object('success', true, 'kind', p_kind, 'entries', v_out);
END;
$$;
REVOKE ALL ON FUNCTION public.get_camp_applications(uuid, text, timestamptz, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.get_camp_applications(uuid, text, timestamptz, integer) TO authenticated;

-- ─── 6. capacity state, from both homes ──────────────────────────────────────
-- Replaces 190's definition so the public form's "Full — join the waitlist"
-- agrees with what the submission will actually decide. Two counts that can
-- disagree is how a family is told there is room and then waitlisted.
CREATE OR REPLACE FUNCTION public.session_capacity_state(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_doc jsonb;
    v_out jsonb := '[]'::jsonb;
    v_s   jsonb;
    v_cap integer;
    v_tak integer;
BEGIN
    IF p_camp_id IS NULL THEN RETURN v_out; END IF;
    SELECT value INTO v_doc FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe';
    IF v_doc IS NULL THEN v_doc := '{}'::jsonb; END IF;

    FOR v_s IN SELECT * FROM jsonb_array_elements(coalesce(v_doc -> 'sessions', '[]'::jsonb))
    LOOP
        IF COALESCE(btrim(v_s ->> 'name'), '') = '' THEN CONTINUE; END IF;
        v_cap := greatest(0, coalesce(NULLIF(v_s ->> 'capacity', '')::numeric, 0)::integer);
        v_tak := public._session_taken_all(p_camp_id, v_doc, v_s ->> 'name');
        v_out := v_out || jsonb_build_array(jsonb_build_object(
            'name', v_s ->> 'name',
            'capacity', v_cap,
            'taken', v_tak,
            -- A capacity of 0 is unlimited, so `left` is null rather than a
            -- number a form could render as "0 places left".
            'left', CASE WHEN v_cap > 0 THEN greatest(0, v_cap - v_tak) ELSE NULL END,
            'full', CASE WHEN v_cap > 0 THEN v_tak >= v_cap ELSE false END));
    END LOOP;
    RETURN v_out;
END;
$$;
REVOKE ALL ON FUNCTION public.session_capacity_state(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.session_capacity_state(uuid) TO anon, authenticated;

-- ─── 7. backfill ─────────────────────────────────────────────────────────────
-- Every submission already in a blob becomes a row, so the count above is
-- complete from the first minute and nothing has to be migrated by hand.
--
-- ON CONFLICT DO NOTHING: re-running this file must not overwrite a row a
-- family has submitted since, which would undo a status the office set.
INSERT INTO public.camp_applications
    (camp_id, kind, entry_id, payload, session, status, submitted_at, updated_at)
SELECT kv.camp_id,
       k.kind,
       e.key,
       e.value,
       NULLIF(btrim(COALESCE(e.value ->> 'session', '')), ''),
       COALESCE(NULLIF(btrim(e.value ->> 'status'), ''), 'applied'),
       -- The client stamps appliedTime; fall back to the row's own age rather
       -- than to now(), so a backfilled application does not read as submitted
       -- the moment the migration ran.
       COALESCE((e.value ->> 'appliedTime')::timestamptz,
                (e.value ->> 'appliedDate')::timestamptz,
                kv.updated_at,
                now()),
       now()
  FROM camp_state_kv kv
 CROSS JOIN (VALUES ('enrollments'), ('staffApplications')) AS k(kind)
 CROSS JOIN LATERAL jsonb_each(coalesce(kv.value -> k.kind, '{}'::jsonb)) AS e(key, value)
 WHERE kv.key = 'campistryMe'
   AND jsonb_typeof(e.value) = 'object'
   AND length(e.key) > 0
ON CONFLICT (camp_id, kind, entry_id) DO NOTHING;

COMMENT ON TABLE public.camp_applications IS
    'Public form submissions, one row each. Written only by '
    'submit_public_application; read by get_camp_applications and the capacity '
    'count. The office''s working copy stays in campistryMe.enrollments — see '
    'migration 200''s header for why absorption is derived rather than flagged.';
