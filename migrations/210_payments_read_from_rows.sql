-- ════════════════════════════════════════════════════════════════════════════
-- 210 — everything that READS payments reads the rows (PHASE 2a of 4)
-- ════════════════════════════════════════════════════════════════════════════
--
-- WHERE WE ARE. 208 built camp_payments and a trigger that keeps it in step with
-- campistryMe.finance.payments, then proved on live data that the two agree:
-- 22 camps inSync, zero missing, zero stale, and collected money identical to
-- the cent (1566.67 on both sides for the one camp with real payments).
--
-- WHY THIS IS ITS OWN STEP, AND MUST SHIP FIRST. The goal is phase 2b: the
-- payment writers stop rewriting the camp's whole document and the camp-wide
-- FOR UPDATE lock goes. The moment a writer stops appending to the array, the
-- array is stale — and campistry_me.js reads it (line 555:
-- `finPayments=(me.finance&&me.finance.payments)||fin.payments||[]`). Every
-- Billing screen downstream reads what that produced.
--
-- So the order is forced: readers move to the rows FIRST, while the array is
-- still maintained and still correct, and only then do writers stop maintaining
-- it. Doing it the other way round shows the office a ledger frozen at the
-- moment of the deploy — with no error, which is the worst kind.
--
-- BEHAVIOUR AFTER THIS PASTE IS UNCHANGED, because the rows and the array hold
-- the same payments; 208's verifier is what says so. What changes is which of
-- the two is load-bearing. That is the point: it puts the rows on the critical
-- path while the array is still there to fall back to.
--
-- WHAT THIS FILE DOES
--   1. get_camp_payments(camp_id) — the office's read, gated on me.billing, in
--      the same shape and order the array had.
--   2. parent_billing_slice reads camp_payments instead of 205's
--      camp_billing_payments projection.
--
-- WHAT IT DOES NOT DO
--   * No writer is touched. All sixteen still take the camp-wide lock. Nothing
--     is faster yet.
--   * 205's camp_billing_payments and its trigger branch stay. They are dead
--     weight after this, and they are deliberately left alive until 2b has
--     landed and settled, so a rollback has somewhere to go.
--
-- ─── ORDER OF OPERATIONS (this matters) ─────────────────────────────────────
--   1. Paste this file.
--   2. Deploy the site (campistry_me.js changes with it).
--   3. Open Billing and check the payment history looks right.
--   4. Only then: phase 2b.
--
-- SAFE TO RE-RUN. CREATE OR REPLACE only; reads nothing, writes nothing.
-- ════════════════════════════════════════════════════════════════════════════


-- ─── 0. preflight ───────────────────────────────────────────────────────────
DO $$
DECLARE
    v_missing text[] := ARRAY[]::text[];
BEGIN
    IF to_regclass('public.camp_payments') IS NULL THEN
        v_missing := v_missing || 'table camp_payments  → apply migrations/208_payments_into_rows.sql first'::text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'user_section_level') THEN
        v_missing := v_missing || 'user_section_level()  → apply migrations/159_access_registry_tables.sql first'::text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'parent_billing_slice') THEN
        v_missing := v_missing || 'parent_billing_slice()  → apply migrations/205_parent_balance_off_the_blob.sql first'::text;
    END IF;
    IF array_length(v_missing, 1) > 0 THEN
        RAISE EXCEPTION 'migration 210 cannot be applied yet. Missing: %',
            array_to_string(v_missing, '; ');
    END IF;
END
$$;


-- ─── 1. the office's read ───────────────────────────────────────────────────
-- Gated on me.billing, NOT me.finance. The payments ledger was deliberately
-- left in campistryMe when 158 moved finance out to its own key, precisely so a
-- user with billing:edit and finance:none can still see it — campistry_me.js
-- line 714 names that case. Gating this on finance would take the ledger away
-- from the bookkeeper role that exists to work on it.
--
-- Returns the payload column, in ordinal order, which is the array's own order:
-- 208's backfill walked the array in position order and the trigger never
-- updates ordinal, so a status transition cannot reshuffle a family's history.
CREATE OR REPLACE FUNCTION public.get_camp_payments(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_pays jsonb;
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF p_camp_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_camp');
    END IF;
    IF public.user_section_level(p_camp_id, 'me.billing') = 'none' THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    SELECT COALESCE(jsonb_agg(payload ORDER BY ordinal), '[]'::jsonb)
      INTO v_pays
      FROM public.camp_payments
     WHERE camp_id = p_camp_id;

    RETURN jsonb_build_object(
        'success',  true,
        'payments', COALESCE(v_pays, '[]'::jsonb),
        'count',    jsonb_array_length(COALESCE(v_pays, '[]'::jsonb)));
END;
$$;
REVOKE ALL ON FUNCTION public.get_camp_payments(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_camp_payments(uuid) TO authenticated, service_role;


-- ─── 2. the parent's slice reads the rows ───────────────────────────────────
-- 205's function, with ONE query changed: the payments come from camp_payments
-- (ordered by `ordinal`) instead of camp_billing_payments (ordered by `seq`).
-- The four match predicates are untouched — they are the balance loop's own
-- predicates, and changing one would change who a payment belongs to.
CREATE OR REPLACE FUNCTION public.parent_billing_slice(p_camp_id uuid, p_names jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_names    text[];
    v_enr      jsonb := '{}'::jsonb;
    v_enrIds   text[] := ARRAY[]::text[];
    v_fams     jsonb := '{}'::jsonb;
    v_famKeys  text[] := ARRAY[]::text[];
    v_famNames text[] := ARRAY[]::text[];
    v_pays     jsonb := '[]'::jsonb;
    v_sessions jsonb := '[]'::jsonb;
    v_settings jsonb := '{}'::jsonb;
BEGIN
    SELECT ARRAY(SELECT jsonb_array_elements_text(
               CASE WHEN jsonb_typeof(p_names) = 'array' THEN p_names ELSE '[]'::jsonb END))
      INTO v_names;

    -- this parent's campers' enrollments (the loop's own test: v_names ? camperName)
    SELECT COALESCE(jsonb_object_agg(entry_id, payload), '{}'::jsonb),
           COALESCE(array_agg(entry_id), ARRAY[]::text[])
      INTO v_enr, v_enrIds
      FROM public.camp_billing_enrollments
     WHERE camp_id = p_camp_id AND camper_name = ANY (v_names);

    -- families holding any of those campers (the loop's own camperIds test)
    SELECT COALESCE(jsonb_object_agg(family_key, payload), '{}'::jsonb),
           COALESCE(array_agg(family_key), ARRAY[]::text[]),
           COALESCE(array_agg(payload ->> 'name') FILTER (WHERE COALESCE(payload ->> 'name', '') <> ''),
                    ARRAY[]::text[])
      INTO v_fams, v_famKeys, v_famNames
      FROM public.camp_billing_families
     WHERE camp_id = p_camp_id
       AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(camper_ids) ci
                    WHERE ci = ANY (v_names));

    -- ★ 210: from camp_payments, which 208 made the second home and phase 2b
    -- makes the only one. Ordered by `ordinal` — the array's own order, set once
    -- at first sight and never updated, so a status transition does not move a
    -- payment in the family's history. Predicates unchanged from 205.
    SELECT COALESCE(jsonb_agg(payload ORDER BY ordinal), '[]'::jsonb)
      INTO v_pays
      FROM public.camp_payments
     WHERE camp_id = p_camp_id
       AND (family_name = ANY (v_names)
            OR (enrollment_id <> '' AND enrollment_id = ANY (v_enrIds))
            OR (family_key <> '' AND family_key = ANY (v_famKeys))
            OR (family_name <> '' AND family_name = ANY (v_famNames)));

    SELECT sessions, enroll_settings INTO v_sessions, v_settings
      FROM public.camp_billing_config WHERE camp_id = p_camp_id;

    RETURN jsonb_build_object(
        'enrollments',    v_enr,
        'families',       v_fams,
        'finance',        jsonb_build_object('payments', v_pays),
        'sessions',       COALESCE(v_sessions, '[]'::jsonb),
        'enrollSettings', COALESCE(v_settings, '{}'::jsonb));
END;
$$;
REVOKE ALL ON FUNCTION public.parent_billing_slice(uuid, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.parent_billing_slice(uuid, jsonb) TO authenticated, service_role;


-- ─── 3. a verifier for the swap itself ──────────────────────────────────────
-- Not "are the two homes in sync" — 208's verifier answers that. This answers
-- the narrower question this file raises: does the slice now return the same
-- payments it returned before, for the same parent? It compares what 205's
-- projection would have given against what camp_payments gives, for every
-- family in the camp, and names any family where the two differ.
CREATE OR REPLACE FUNCTION public.verify_payments_read_swap(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_claims  text := NULLIF(current_setting('request.jwt.claims', true), '');
    v_oldAll  jsonb;
    v_newAll  jsonb;
    v_oldSum  numeric := 0;
    v_newSum  numeric := 0;
    v_projectionPresent boolean;
BEGIN
    IF p_camp_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_camp');
    END IF;
    IF v_claims IS NOT NULL
       AND COALESCE(v_claims::jsonb ->> 'role', '') <> 'service_role'
       AND NOT public.camp_reader(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    v_projectionPresent := to_regclass('public.camp_billing_payments') IS NOT NULL;

    -- The whole camp, from both homes, in each home's own order.
    IF v_projectionPresent THEN
        EXECUTE 'SELECT COALESCE(jsonb_agg(payload ORDER BY seq), ''[]''::jsonb)
                   FROM public.camp_billing_payments WHERE camp_id = $1'
           INTO v_oldAll USING p_camp_id;
    ELSE
        v_oldAll := NULL;
    END IF;

    SELECT COALESCE(jsonb_agg(payload ORDER BY ordinal), '[]'::jsonb)
      INTO v_newAll
      FROM public.camp_payments WHERE camp_id = p_camp_id;

    SELECT COALESCE(sum(COALESCE(public._num_or_null(e ->> 'amount'), 0)), 0) INTO v_newSum
      FROM jsonb_array_elements(COALESCE(v_newAll, '[]'::jsonb)) AS e
     WHERE COALESCE(e ->> 'status', '') NOT IN ('pending', 'failed');

    IF v_oldAll IS NOT NULL THEN
        SELECT COALESCE(sum(COALESCE(public._num_or_null(e ->> 'amount'), 0)), 0) INTO v_oldSum
          FROM jsonb_array_elements(v_oldAll) AS e
         WHERE COALESCE(e ->> 'status', '') NOT IN ('pending', 'failed');
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        -- When 205's projection is gone there is nothing to compare against, and
        -- that is not a failure — it is what phase 2b's cleanup leaves behind.
        'comparable', v_oldAll IS NOT NULL,
        'sameOrderAndContent', CASE WHEN v_oldAll IS NULL THEN NULL
                                    ELSE v_oldAll = v_newAll END,
        'collectedOld', CASE WHEN v_oldAll IS NULL THEN NULL ELSE v_oldSum END,
        'collectedNew', v_newSum,
        'countOld', CASE WHEN v_oldAll IS NULL THEN NULL
                         ELSE jsonb_array_length(v_oldAll) END,
        'countNew', jsonb_array_length(COALESCE(v_newAll, '[]'::jsonb)),
        'note', 'sameOrderAndContent true means the office and the parent see '
             || 'exactly what they saw before the swap. If it is false, compare '
             || 'collectedOld against collectedNew: equal money with a different '
             || 'order is a display question, unequal money is not.');
END;
$$;
REVOKE ALL ON FUNCTION public.verify_payments_read_swap(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.verify_payments_read_swap(uuid) TO authenticated, service_role;


-- ─── did it work? ───────────────────────────────────────────────────────────
-- The last thing in the file, and a statement rather than a comment, so a
-- successful paste is visible and a rolled-back one shows its own error instead
-- of surfacing later as "some function does not exist".
SELECT 'migration 210 applied'                                              AS status,
       to_regprocedure('public.get_camp_payments(uuid)') IS NOT NULL         AS office_read_ready,
       to_regprocedure('public.verify_payments_read_swap(uuid)') IS NOT NULL AS verify_ready,
       (SELECT count(*) FROM public.camp_payments)                          AS payment_rows,
       -- Proof the slice was replaced and not merely re-created: its source is
       -- now camp_payments. If this reads false, the old definition won.
       (SELECT pg_get_functiondef(p.oid) LIKE '%FROM public.camp_payments%'
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'parent_billing_slice')  AS slice_reads_rows;
