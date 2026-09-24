-- ============================================================================
-- Migration 246: the two remaining readers of me->'finance'->'payments'.
--
-- THE DEFECT. Migration 158 moved Finance out of the campistryMe document into
-- its own key, and the payments ledger has lived at campistryMe.payments — and,
-- since 208-213, in camp_payments rows — ever since. `me->'finance'->'payments'`
-- has been NULL on every camp from that day. Two functions still read it:
--
--   get_my_balance_derived     the parent's balance, whenever the ledger is not
--                              complete (get_my_balance falls back to it). Its
--                              projection path reads rows through
--                              parent_billing_slice and is right; its DOCUMENT
--                              path — taken when the projection stamp does not
--                              match, e.g. after a restore or a write that
--                              skipped the trigger — counted every payment as
--                              zero, so a parent who had paid was shown the full
--                              amount owing. It also took families from the
--                              document, which lags every server-side write.
--
--   report_plan_undercollection  the office's "instalments marked paid that
--                              were never charged" report. It compared against
--                              zero payments, so every family it looked at
--                              looked short.
--
-- THE FIX. Both read payments from camp_payments_array(camp) and families from
-- camp_families_object(camp) — the rows. The functions are long and their only
-- source is migration 173's rename of an older body, so this rewrites the stale
-- expressions IN THE DEPLOYED BODY, and refuses (rolling the whole file back) if
-- any expression is not found exactly once. A partial rewrite is not possible.
--
-- HOW TO APPLY. Paste into the SQL Editor. One transaction; touches no data.
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

DO $$
BEGIN
    IF to_regprocedure('public.camp_payments_array(uuid)') IS NULL
       OR to_regprocedure('public.camp_families_object(uuid)') IS NULL THEN
        RAISE EXCEPTION '246 needs camp_payments_array and camp_families_object — apply 212 and 215 first';
    END IF;
END $$;

SET LOCAL lock_timeout = '15s';


-- Rewrite one deployed function: each (old, new) pair must occur EXACTLY once
-- in the body, or nothing is changed. Idempotent: a body that already carries
-- every NEW text and none of the OLD is left alone.
CREATE OR REPLACE FUNCTION pg_temp.rewrite_body(p_fn regprocedure, p_pairs text[][])
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
    v_def  text := pg_get_functiondef(p_fn);
    v_old  text;
    v_new  text;
    v_hits int;
    v_done int := 0;
    i      int;
BEGIN
    FOR i IN 1 .. array_length(p_pairs, 1) LOOP
        v_old := p_pairs[i][1];
        v_new := p_pairs[i][2];
        v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
        IF v_hits = 0 AND position(v_new IN v_def) > 0 THEN
            v_done := v_done + 1;          -- already rewritten
            CONTINUE;
        END IF;
        IF v_hits <> 1 THEN
            RAISE EXCEPTION '246: % — expected this text exactly once, found % times; nothing was changed: %',
                            p_fn, v_hits, v_old;
        END IF;
        v_def := replace(v_def, v_old, v_new);
    END LOOP;
    IF v_done = array_length(p_pairs, 1) THEN
        RETURN p_fn::text || ': already applied';
    END IF;
    EXECUTE v_def;
    RETURN p_fn::text || ': rewritten';
END;
$$;


SELECT pg_temp.rewrite_body('public.get_my_balance_derived(uuid)'::regprocedure, ARRAY[
    ARRAY[$o$fams      := COALESCE(me->'families', '{}'::jsonb);$o$,
          $n$fams      := COALESCE(public.camp_families_object(inv.camp_id), '{}'::jsonb);$n$],
    ARRAY[$o$pays      := COALESCE(me->'finance'->'payments', '[]'::jsonb);$o$,
          $n$pays      := COALESCE(public.camp_payments_array(inv.camp_id), '[]'::jsonb);$n$]
]) AS "246";

SELECT pg_temp.rewrite_body('public.report_plan_undercollection(uuid)'::regprocedure, ARRAY[
    ARRAY[$o$FROM jsonb_array_elements(COALESCE(v_me->'finance'->'payments', '[]'::jsonb)) e$o$,
          $n$FROM jsonb_array_elements(COALESCE(public.camp_payments_array(p_camp_id), '[]'::jsonb)) e$n$]
]) AS "246";


-- ─── the check ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.verify_no_finance_payments_readers()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT jsonb_build_object(
        'still_reading_finance_payments', COALESCE((
            SELECT jsonb_agg(p.proname ORDER BY p.proname)
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public'
               AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~ '''finance''\s*->\s*''payments'''
               AND p.proname NOT LIKE 'verify\_%'
               -- The document-to-row projection triggers read the OLD document
               -- shape on purpose: they only ever upsert, and with the branch
               -- absent on both sides they do nothing. Not readers of a balance.
               AND p.proname NOT IN ('project_camp_payments', 'project_camp_billing',
                                     'project_campistry_me')), '[]'::jsonb))
$$;
REVOKE ALL ON FUNCTION public.verify_no_finance_payments_readers() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.verify_no_finance_payments_readers() TO authenticated, service_role;

SELECT public.verify_no_finance_payments_readers()
       AS "246 check — still_reading_finance_payments should be []";
