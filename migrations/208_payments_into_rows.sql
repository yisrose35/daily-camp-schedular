-- ════════════════════════════════════════════════════════════════════════════
-- 208 — payments get their own rows (PHASE 1 of 4: the new home, kept true)
-- ════════════════════════════════════════════════════════════════════════════
--
-- THE PROBLEM. A camp's payments live in ONE jsonb array inside ONE row:
-- camp_state_kv(campistryMe).finance.payments. Sixteen functions take
-- `SELECT ... FOR UPDATE` on that row, read the whole document, edit it and
-- write it all back. So:
--
--   * every payment in a camp is serialized behind every other payment,
--     whatever the parent is paying for;
--   * each one costs in proportion to the WHOLE camp's document, not to the
--     payment — the same defect that made the parent balance take 3575ms at
--     32 concurrent parents before migration 205 narrowed what it reads;
--   * and the cost grows all season, because the array only gets longer.
--
-- Camps do not block each other — the lock is per camp — but a 500-family camp
-- opening registration is exactly one camp.
--
-- THE PLAN, IN FOUR PHASES. This file is phase 1 and changes NO behaviour:
--
--   1. (here) camp_payments: one row per payment, with a real identity, kept
--      in step with the array by a trigger. Nothing reads it yet. A verifier
--      proves the two agree on live data before anything depends on it.
--   2. The seven payment writers INSERT a row instead of rewriting the array,
--      and the reads (get_my_balance_derived and the office's read path) move
--      to the table. The camp-wide lock goes with them.
--   3. camp_families: one row per family, so the nine remaining functions lock
--      one family instead of the camp.
--   4. The load test grows a payments phase, so the ceiling is measured rather
--      than argued about.
--
-- WHY A TRIGGER AND NOT A CHANGE TO EACH WRITER. The same reason 202, 203 and
-- 205 used one: a copy some writer forgets is a copy that drifts. The trigger
-- cannot be forgotten, and it runs in the writer's own transaction, so the row
-- and the array commit together or not at all.
--
-- WHY MERGE AND NEVER DELETE. Phase 2 puts rows here that the array will not
-- have. A trigger that rebuilt the table from the array would erase them. So it
-- merges from the first day, which also means phase 2 does not have to change
-- it. Append-only has the same payoff it has in the canteen archive: a payment
-- lost from the document is exactly what this table exists to survive.
--
-- WHY IT DIFFS AGAINST OLD (the lesson from 203, which cost real throughput).
-- 203's archive trigger re-submitted the entire history on every write and let
-- ON CONFLICT discard the duplicates. Correct, and O(history) per sale, on a
-- table that only grows — canteen throughput decayed 84 → 77 → 26 per second
-- across three identical runs. 206 fixed it. This trigger diffs from the start:
-- it upserts only the entries whose payload actually changed, so appending one
-- payment writes one row however long the season has been.
--
-- IDENTITY. Payments already carry their own ids, and append_camp_payment
-- already dedupes on four fields, so there is no need to invent a signature
-- the way the canteen had to. camp_payment_identity prefers, in order: id,
-- reference, stripePaymentIntentId, byopTransactionId. Only a legacy row with
-- none of them falls back to a signature over its visible fields — which is
-- deterministic, so re-running the backfill converges instead of duplicating.
--
-- SAFE TO RE-RUN. Tables and indexes are IF NOT EXISTS, functions are CREATE OR
-- REPLACE, and the backfill is an idempotent merge.
--
-- ─── HOW TO APPLY ───────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → New query → paste this whole file → Run.
--
-- ─── THEN VERIFY (this is the point of phase 1) ─────────────────────────────
--   SELECT c.id AS camp_id, public.verify_camp_payments(c.id) AS result
--     FROM camps c
--    WHERE EXISTS (SELECT 1 FROM camp_state_kv k
--                   WHERE k.camp_id = c.id AND k.key = 'campistryMe');
--
-- Every row must read "inSync": true with "missingFromRows": 0. That is what
-- says phase 2 may proceed. Anything else, send it back before we cut over.
-- ════════════════════════════════════════════════════════════════════════════


-- ─── 0. preflight ───────────────────────────────────────────────────────────
-- This file depends on three things an earlier migration created. If one is
-- absent the paste fails somewhere in the middle with ERROR 42883 naming a
-- function nobody asked about, the whole transaction rolls back, and the only
-- visible symptom is that verify_camp_payments "does not exist" — which sends
-- you looking at the wrong file. So say it plainly and up front instead.
DO $preflight$
DECLARE
    v_missing text[] := ARRAY[]::text[];
BEGIN
    IF to_regclass('public.camp_state_kv') IS NULL THEN
        v_missing := v_missing || 'table camp_state_kv'::text;
    END IF;
    IF to_regclass('public.camps') IS NULL THEN
        v_missing := v_missing || 'table camps'::text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = '_num_or_null') THEN
        v_missing := v_missing || '_num_or_null()  → apply migrations/203_canteen_archive.sql first'::text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'camp_reader') THEN
        v_missing := v_missing || 'camp_reader()  → apply migrations/183_lock_down_camp_scoped_readers.sql first'::text;
    END IF;

    -- A table of this name that is NOT ours would be skipped by CREATE TABLE IF
    -- NOT EXISTS and then fail confusingly on the first insert.
    IF to_regclass('public.camp_payments') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_schema = 'public' AND table_name = 'camp_payments'
                          AND column_name = 'payment_id') THEN
        v_missing := v_missing || 'a DIFFERENT public.camp_payments already exists (no payment_id column) — rename it before applying this'::text;
    END IF;

    IF array_length(v_missing, 1) > 0 THEN
        RAISE EXCEPTION E'208 cannot be applied yet. Missing:\n  - %',
            array_to_string(v_missing, E'\n  - ');
    END IF;
END
$preflight$;


-- ─── 1. the identity ────────────────────────────────────────────────────────
-- IMMUTABLE so it can be used in an index and trusted to give the same answer
-- to the backfill, the trigger and the verifier.
CREATE OR REPLACE FUNCTION public.camp_payment_identity(p_pay jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
    SELECT COALESCE(
        NULLIF(btrim(COALESCE(p_pay ->> 'id', '')), ''),
        NULLIF(btrim(COALESCE(p_pay ->> 'reference', '')), ''),
        NULLIF(btrim(COALESCE(p_pay ->> 'stripePaymentIntentId', '')), ''),
        NULLIF(btrim(COALESCE(p_pay ->> 'byopTransactionId', '')), ''),
        -- Last resort, for rows written before payments carried ids. Same
        -- construction as the canteen's _txSig: deterministic, so the backfill
        -- converges rather than inventing a new row each time it runs.
        'sig:' || concat_ws('|',
            COALESCE(p_pay ->> 'date',         ''),
            COALESCE(p_pay ->> 'amount',       ''),
            COALESCE(p_pay ->> 'family',       ''),
            COALESCE(p_pay ->> 'familyKey',    ''),
            COALESCE(p_pay ->> 'enrollmentId', ''),
            COALESCE(p_pay ->> 'method',       ''),
            COALESCE(p_pay ->> 'status',       ''),
            COALESCE(p_pay ->> 'notes',        '')));
$$;
REVOKE ALL ON FUNCTION public.camp_payment_identity(jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.camp_payment_identity(jsonb) TO authenticated, service_role;


-- ─── 2. the table ───────────────────────────────────────────────────────────
-- The extracted columns are exactly the four things the balance loop matches a
-- payment to a parent on, plus what it reads to compute and label the row. The
-- payload keeps everything, so nothing is lost by extracting a subset.
--
-- No FK to camps: written by a trigger, and an FK violation there would abort
-- the original save — the same reasoning as 202, 203 and 205.
CREATE TABLE IF NOT EXISTS public.camp_payments (
    camp_id       uuid   NOT NULL,
    payment_id    text   NOT NULL,              -- camp_payment_identity(payload)
    -- Display and history order. The array's order is meaningful, so the
    -- backfill walks it in order and later payments land after. It is never
    -- updated, so a status transition does not reshuffle a family's history.
    ordinal       bigint NOT NULL GENERATED BY DEFAULT AS IDENTITY,
    family_name   text   NOT NULL DEFAULT '',   -- payload->>'family'
    family_key    text   NOT NULL DEFAULT '',   -- payload->>'familyKey'
    enrollment_id text   NOT NULL DEFAULT '',   -- payload->>'enrollmentId'
    status        text   NOT NULL DEFAULT '',   -- '', 'pending', 'failed', ...
    amount        numeric NOT NULL DEFAULT 0,
    pay_date      text   NOT NULL DEFAULT '',   -- as the app stores it
    payload       jsonb  NOT NULL,
    first_seen    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (camp_id, payment_id)
);

-- The balance loop's four match paths.
CREATE INDEX IF NOT EXISTS idx_camp_payments_famkey
    ON public.camp_payments (camp_id, family_key);
CREATE INDEX IF NOT EXISTS idx_camp_payments_famname
    ON public.camp_payments (camp_id, family_name);
CREATE INDEX IF NOT EXISTS idx_camp_payments_enr
    ON public.camp_payments (camp_id, enrollment_id);
-- And history order per camp, for the office's ledger view.
CREATE INDEX IF NOT EXISTS idx_camp_payments_order
    ON public.camp_payments (camp_id, ordinal);

-- Deny-all, like every other money projection here: reads go through the gated
-- SECURITY DEFINER functions, and a curious authenticated SELECT sees nothing.
ALTER TABLE public.camp_payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.camp_payments FROM anon, authenticated;


-- ─── 3. the trigger that keeps it true ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.project_camp_payments()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_newMap jsonb;
    v_oldMap jsonb;
BEGIN
    -- Any save that did not touch payments costs one comparison.
    IF TG_OP <> 'INSERT'
       AND (NEW.value -> 'finance' -> 'payments')
           IS NOT DISTINCT FROM (OLD.value -> 'finance' -> 'payments') THEN
        RETURN NEW;
    END IF;

    -- REDUCE BEFORE DIFFING. Both sides collapse to one entry per identity,
    -- LAST array position winning, and only then are they compared.
    --
    -- Doing it the other way round is wrong, and quietly: filter first and a
    -- duplicated identity can have its SUPERSEDED copy survive the filter while
    -- the current one is dropped as unchanged, leaving the row holding the old
    -- value. Caught on a real server with p1 present at 100 and again at 120 —
    -- the row went back to 100 and the two sides disagreed by exactly 20.
    --
    -- The ORDER BY inside the aggregate is load-bearing: jsonb_object_agg keeps
    -- the last value for a repeated key, and without it "last" would mean
    -- whatever order the scan produced rather than the array's own order.
    SELECT COALESCE(jsonb_object_agg(public.camp_payment_identity(e.v), e.v
                                     ORDER BY e.ord), '{}'::jsonb)
      INTO v_newMap
      FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(NEW.value -> 'finance' -> 'payments') = 'array'
                  THEN NEW.value -> 'finance' -> 'payments' ELSE '[]'::jsonb END)
           WITH ORDINALITY AS e(v, ord)
     WHERE jsonb_typeof(e.v) = 'object';

    SELECT COALESCE(jsonb_object_agg(public.camp_payment_identity(e.v), e.v
                                     ORDER BY e.ord), '{}'::jsonb)
      INTO v_oldMap
      FROM jsonb_array_elements(
             CASE WHEN TG_OP = 'INSERT' THEN '[]'::jsonb
                  WHEN jsonb_typeof(OLD.value -> 'finance' -> 'payments') = 'array'
                  THEN OLD.value -> 'finance' -> 'payments' ELSE '[]'::jsonb END)
           WITH ORDINALITY AS e(v, ord)
     WHERE jsonb_typeof(e.v) = 'object';

    -- Keys are unique by construction, so no DISTINCT ON and no ordering
    -- question. `->` on a jsonb object is a binary search over sorted keys; an
    -- array with `= ANY` would be a linear scan per candidate and would rebuild
    -- 203's growth curve.
    INSERT INTO public.camp_payments
        (camp_id, payment_id, family_name, family_key, enrollment_id,
         status, amount, pay_date, payload)
    SELECT NEW.camp_id,
           n.key,
           COALESCE(n.value ->> 'family', ''),
           COALESCE(n.value ->> 'familyKey', ''),
           COALESCE(n.value ->> 'enrollmentId', ''),
           COALESCE(n.value ->> 'status', ''),
           COALESCE(public._num_or_null(n.value ->> 'amount'), 0),
           COALESCE(n.value ->> 'date', ''),
           n.value
      FROM jsonb_each(v_newMap) AS n
     -- New to this write, or patched in place (Stripe sends pending, then
     -- succeeded, for the same intent — same identity, different payload).
     WHERE (v_oldMap -> n.key) IS DISTINCT FROM n.value
    ON CONFLICT (camp_id, payment_id) DO UPDATE
       SET family_name   = EXCLUDED.family_name,
           family_key    = EXCLUDED.family_key,
           enrollment_id = EXCLUDED.enrollment_id,
           status        = EXCLUDED.status,
           amount        = EXCLUDED.amount,
           pay_date      = EXCLUDED.pay_date,
           payload       = EXCLUDED.payload,
           updated_at    = now();
           -- ordinal is deliberately NOT updated: a status transition must not
           -- move a payment in the family's history.

    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.project_camp_payments() FROM public, anon, authenticated;

-- No DELETE trigger, on purpose. A camp row going away does not make its
-- payment history untrue, and phase 2 makes this table the record. Cleaning up
-- a deleted camp stays a deliberate act.
DROP TRIGGER IF EXISTS trg_project_camp_payments ON public.camp_state_kv;
CREATE TRIGGER trg_project_camp_payments
AFTER INSERT OR UPDATE ON public.camp_state_kv
FOR EACH ROW
WHEN (NEW.key = 'campistryMe')
EXECUTE FUNCTION public.project_camp_payments();


-- ─── 4. the backfill ────────────────────────────────────────────────────────
-- In array order, so ordinal reproduces the history the office reads today.
-- Scoped to camps that still exist: camp_state_kv has no foreign key, so a
-- deleted camp can leave an orphaned row behind, and migration 200's first
-- live paste died on exactly that (ERROR 23503) with the whole file rolled
-- back. An idempotent merge, so re-running converges.
-- Two array entries can share one identity. Position comes from the FIRST of
-- them (that is where the payment sits in the family's history) and the payload
-- from the LAST (that is the current state, and it is what the trigger picks —
-- if these two disagreed, verify_camp_payments would report staleRows on data
-- nobody had touched).
INSERT INTO public.camp_payments
    (camp_id, payment_id, family_name, family_key, enrollment_id,
     status, amount, pay_date, payload)
SELECT d.camp_id,
       d.pid,
       COALESCE(d.pay ->> 'family', ''),
       COALESCE(d.pay ->> 'familyKey', ''),
       COALESCE(d.pay ->> 'enrollmentId', ''),
       COALESCE(d.pay ->> 'status', ''),
       COALESCE(public._num_or_null(d.pay ->> 'amount'), 0),
       COALESCE(d.pay ->> 'date', ''),
       d.pay
  FROM (SELECT kv.camp_id                                      AS camp_id,
               public.camp_payment_identity(p.value)           AS pid,
               min(p.ord)                                      AS first_ord,
               (array_agg(p.value ORDER BY p.ord DESC))[1]      AS pay
          FROM camp_state_kv kv
          CROSS JOIN LATERAL jsonb_array_elements(
                 CASE WHEN jsonb_typeof(kv.value -> 'finance' -> 'payments') = 'array'
                      THEN kv.value -> 'finance' -> 'payments' ELSE '[]'::jsonb END)
               WITH ORDINALITY AS p(value, ord)
         WHERE kv.key = 'campistryMe'
           AND jsonb_typeof(p.value) = 'object'
           AND EXISTS (SELECT 1 FROM camps c WHERE c.id = kv.camp_id)
         GROUP BY kv.camp_id, public.camp_payment_identity(p.value)) AS d
 -- Insertion order sets `ordinal`, so it must be the array's own order.
 ORDER BY d.camp_id, d.first_ord
ON CONFLICT (camp_id, payment_id) DO NOTHING;


-- ─── 5. the verifier ────────────────────────────────────────────────────────
-- Phase 1's whole purpose: prove on live data that the rows say what the array
-- says, before anything reads them.
--
-- Gated like 202's verifier, and for the reason that one had to be fixed: it is
-- run from the SQL Editor, which carries no JWT at all, so camp_reader() would
-- answer false for a legitimate owner. current_user is useless here — inside
-- SECURITY DEFINER it is the function's owner for every caller alike.
CREATE OR REPLACE FUNCTION public.verify_camp_payments(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_claims    text := NULLIF(current_setting('request.jwt.claims', true), '');
    v_pays      jsonb;
    -- The array reduced to one entry per identity, LAST occurrence winning —
    -- exactly how the trigger and the backfill reduce it. Every check below
    -- reads this and not the raw array. Comparing the raw array against the
    -- rows reported a superseded duplicate as "stale": the array held p1 at 100
    -- and again at 120, the row correctly held 120, and the 100 looked wrong.
    v_dedup     jsonb := '{}'::jsonb;
    v_blobCount integer := 0;
    v_rowCount  integer := 0;
    v_missing   jsonb := '[]'::jsonb;
    v_differs   jsonb := '[]'::jsonb;
    v_blobSum   numeric := 0;
    v_rowSum    numeric := 0;
BEGIN
    IF p_camp_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_camp');
    END IF;
    IF v_claims IS NOT NULL
       AND COALESCE(v_claims::jsonb ->> 'role', '') <> 'service_role'
       AND NOT public.camp_reader(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    SELECT CASE WHEN jsonb_typeof(value -> 'finance' -> 'payments') = 'array'
                THEN value -> 'finance' -> 'payments' ELSE '[]'::jsonb END
      INTO v_pays
      FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe';
    IF v_pays IS NULL THEN v_pays := '[]'::jsonb; END IF;

    -- Reduce once. jsonb_object_agg keeps the LAST value for a repeated key,
    -- and the explicit ORDER BY is what makes "last" mean the last array
    -- position rather than whatever order the scan happened to produce.
    SELECT COALESCE(jsonb_object_agg(public.camp_payment_identity(e.v), e.v
                                     ORDER BY e.ord), '{}'::jsonb)
      INTO v_dedup
      FROM jsonb_array_elements(v_pays) WITH ORDINALITY AS e(v, ord)
     WHERE jsonb_typeof(e.v) = 'object';

    -- Two array entries sharing one identity are one payment, and become one
    -- row, so the count is over identities.
    v_blobCount := (SELECT count(*)::integer FROM jsonb_object_keys(v_dedup));

    SELECT count(*) INTO v_rowCount FROM public.camp_payments WHERE camp_id = p_camp_id;

    -- In the array and NOT in the table: the failure that would lose money.
    SELECT COALESCE(jsonb_agg(k ORDER BY k), '[]'::jsonb) INTO v_missing
      FROM jsonb_object_keys(v_dedup) AS k
     WHERE NOT EXISTS (SELECT 1 FROM public.camp_payments r
                        WHERE r.camp_id = p_camp_id AND r.payment_id = k);

    -- In both, but the row does not match what the array now says — a patch the
    -- trigger did not apply.
    SELECT COALESCE(jsonb_agg(k ORDER BY k), '[]'::jsonb) INTO v_differs
      FROM jsonb_object_keys(v_dedup) AS k
      JOIN public.camp_payments r
        ON r.camp_id = p_camp_id AND r.payment_id = k
     WHERE r.payload IS DISTINCT FROM (v_dedup -> k);

    -- The number that actually matters to a family: collected money. Excludes
    -- pending and failed, the same exclusion the balance uses.
    SELECT COALESCE(sum(COALESCE(public._num_or_null(v.value ->> 'amount'), 0)), 0)
      INTO v_blobSum
      FROM jsonb_each(v_dedup) AS v
     WHERE COALESCE(v.value ->> 'status', '') NOT IN ('pending', 'failed');

    SELECT COALESCE(sum(amount), 0) INTO v_rowSum
      FROM public.camp_payments
     WHERE camp_id = p_camp_id AND status NOT IN ('pending', 'failed');

    RETURN jsonb_build_object(
        'success', true,
        'inSync', (jsonb_array_length(v_missing) = 0
                   AND jsonb_array_length(v_differs) = 0
                   AND v_blobSum = v_rowSum),
        'blobPayments', v_blobCount,
        'rowPayments', v_rowCount,
        'missingFromRows', jsonb_array_length(v_missing),
        'missingIds', v_missing,
        'staleRows', jsonb_array_length(v_differs),
        'staleIds', v_differs,
        'collectedInBlob', v_blobSum,
        'collectedInRows', v_rowSum,
        'note', 'rowPayments may EXCEED blobPayments once phase 2 lands, and '
             || 'after a stale client save that shortened the array — rows are '
             || 'never deleted. missingFromRows and staleRows are the failures.',
        'repair', 're-paste migrations/208_payments_into_rows.sql — its backfill converges');
END;
$$;
REVOKE ALL ON FUNCTION public.verify_camp_payments(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.verify_camp_payments(uuid) TO authenticated, service_role;


-- ─── what phase 1 deliberately does NOT do ──────────────────────────────────
--   * No reader is changed. get_my_balance_derived still reads the array (via
--     205's slice), the office still reads the blob. Behaviour is identical,
--     which is what makes this paste safe to apply mid-season.
--   * No writer is changed. All sixteen still take the camp-wide lock. Nothing
--     gets faster yet; the point is to earn the right to cut over.
--   * 205's camp_billing_payments projection is left alone. It becomes
--     redundant in phase 2 and gets retired there, not here, so that a rollback
--     of phase 2 has somewhere to land.
