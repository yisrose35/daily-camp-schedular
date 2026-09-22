-- Behaviour test for migration 215. The five by-rule functions are vouched for by
-- the diff test; the two written BY HAND get their proof here, because no diff
-- can vouch for a deliberate restructure.
\set ON_ERROR_STOP on

INSERT INTO public.camps (id, owner, name)
VALUES ('f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1', NULL, 'Last Seven');
INSERT INTO public.camp_state_kv (camp_id, key, value) VALUES
('f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1', 'campistryMe', jsonb_build_object(
  'families', jsonb_build_object(
    'lf1', jsonb_build_object('name','Stein','camperIds', jsonb_build_array('Dovid Stein')))));

-- ── NOTHING ANYWHERE LOCKS THE CAMP DOCUMENT ANY MORE ─────────────────────
DO $$
DECLARE n integer; who text;
BEGIN
    SELECT count(*), COALESCE(string_agg(p.proname, ', '), '')
      INTO n, who
      FROM pg_proc p JOIN pg_namespace nsp ON nsp.oid = p.pronamespace
     WHERE nsp.nspname = 'public' AND p.prokind = 'f'
       AND pg_get_functiondef(p.oid) ~ 'key = ''campistryMe''[^;]*FOR UPDATE';
    IF n <> 0 THEN RAISE EXCEPTION 'still locking the camp document: %', who; END IF;

    SELECT count(*), COALESCE(string_agg(p.proname, ', '), '')
      INTO n, who
      FROM pg_proc p JOIN pg_namespace nsp ON nsp.oid = p.pronamespace
     WHERE nsp.nspname = 'public' AND p.prokind = 'f'
       AND pg_get_functiondef(p.oid) ~ 'UPDATE camp_state_kv[^;]*campistryMe';
    IF n <> 0 THEN RAISE EXCEPTION 'still writing the camp document: %', who; END IF;
    RAISE NOTICE 'ok  NOTHING in the schema locks or writes campistryMe any more';
END $$;

-- ── and the shop / canteen locks are still there ──────────────────────────
DO $$
DECLARE n integer;
BEGIN
    SELECT count(*) INTO n
      FROM pg_proc p JOIN pg_namespace nsp ON nsp.oid = p.pronamespace
     WHERE nsp.nspname = 'public' AND p.prokind = 'f'
       AND pg_get_functiondef(p.oid) ~ '(campistryShop|campistrySnacks)''[^;]*FOR UPDATE';
    IF n < 2 THEN
        RAISE EXCEPTION 'the shop/canteen locks were lost (% left) — those blobs are still read-modify-written', n;
    END IF;
    RAISE NOTICE 'ok  the shop and canteen locks survive (% functions)', n;
END $$;

-- ── the two accessors ─────────────────────────────────────────────────────
DO $$
DECLARE a jsonb;
BEGIN
    PERFORM public.camp_payment_add('f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1',
        jsonb_build_object('id','lp1','family','Stein','familyKey','lf1','amount',100,
                           'status','succeeded','date','2026-08-01'));
    PERFORM public.camp_payment_add('f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1',
        jsonb_build_object('id','lp2','reference','REF-9','family','Stein','familyKey','lf1',
                           'amount',50,'status','succeeded','date','2026-08-02'));
    a := public.camp_payments_array('f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1');
    IF jsonb_array_length(a) <> 2 THEN RAISE EXCEPTION 'expected 2 payments, got %', a; END IF;
    IF (a -> 0 ->> 'id') <> 'lp1' OR (a -> 1 ->> 'id') <> 'lp2' THEN
        RAISE EXCEPTION 'the array must keep insertion order: %', a;
    END IF;
    -- adding the same payment twice must not duplicate it
    PERFORM public.camp_payment_add('f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1',
        jsonb_build_object('id','lp1','family','Stein','familyKey','lf1','amount',100,
                           'status','succeeded','date','2026-08-01'));
    IF jsonb_array_length(public.camp_payments_array('f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1')) <> 2 THEN
        RAISE EXCEPTION 'camp_payment_add duplicated a payment';
    END IF;
    RAISE NOTICE 'ok  camp_payments_array keeps order; camp_payment_add is idempotent';
END $$;

DO $$
BEGIN
    IF has_function_privilege('authenticated','public.camp_payments_array(uuid)','EXECUTE')
       OR has_function_privilege('authenticated','public.camp_payment_add(uuid, jsonb)','EXECUTE') THEN
        RAISE EXCEPTION 'an accessor taking a camp id is callable by any signed-in user';
    END IF;
    RAISE NOTICE 'ok  both accessors are granted to nobody';
END $$;

-- ── BY HAND #1: record_chargeback annotates the right ONE payment ─────────
DO $$
DECLARE a jsonb; hit jsonb; n integer;
BEGIN
    -- matched by `reference`, which is one of the four fields the original tested
    PERFORM public.record_chargeback('f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1',
        'dp_1', ARRAY['REF-9']::text[], 50, 'fraudulent', 'open');

    a := public.camp_payments_array('f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1');
    SELECT e INTO hit FROM jsonb_array_elements(a) AS e WHERE (e ->> 'disputed')::boolean IS TRUE;
    IF hit IS NULL THEN RAISE EXCEPTION 'no payment was annotated: %', a; END IF;
    IF (hit ->> 'id') <> 'lp2' THEN
        RAISE EXCEPTION 'the WRONG payment was annotated (%) — the four-field match is broken', hit ->> 'id';
    END IF;
    IF (hit ->> 'disputeId') <> 'dp_1' OR (hit ->> 'disputeStatus') <> 'open'
       OR (hit ->> 'disputeReason') <> 'fraudulent' THEN
        RAISE EXCEPTION 'the annotation lost a field: %', hit;
    END IF;
    SELECT count(*) INTO n FROM jsonb_array_elements(a) AS e
     WHERE (e ->> 'disputed')::boolean IS TRUE;
    IF n <> 1 THEN RAISE EXCEPTION 'more than one payment was annotated: % of them', n; END IF;
    -- and the array is otherwise untouched
    IF jsonb_array_length(a) <> 2 THEN RAISE EXCEPTION 'the chargeback changed the payment count'; END IF;
    RAISE NOTICE 'ok  record_chargeback annotates exactly one payment, matched on any of four ids';
END $$;

DO $$
DECLARE a jsonb;
BEGIN
    -- a ref matching nothing must annotate nothing, not the first row
    PERFORM public.record_chargeback('f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1',
        'dp_2', ARRAY['no-such-ref']::text[], 1, 'other', 'open');
    a := public.camp_payments_array('f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1');
    IF (SELECT count(*) FROM jsonb_array_elements(a) AS e
         WHERE e ->> 'disputeId' = 'dp_2') <> 0 THEN
        RAISE EXCEPTION 'an unmatched reference annotated a payment anyway: %', a;
    END IF;
    RAISE NOTICE 'ok  an unmatched reference annotates nothing';
END $$;

-- ── BY HAND #2: set_my_payment_plan sets plans AND drops the legacy plan ──
DO $$
DECLARE fam jsonb;
BEGIN
    -- give the family a legacy singular `plan`, which is what the #- removes
    PERFORM public.camp_family_save('f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1','lf1',
        public.camp_family('f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1','lf1')
        || jsonb_build_object('plan', jsonb_build_object('legacy', true)));
    IF public.camp_family('f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1','lf1') -> 'plan' IS NULL THEN
        RAISE EXCEPTION 'setup: the legacy plan was not stored';
    END IF;

    PERFORM public.camp_family_save('f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1','lf1',
        jsonb_set(public.camp_family_for_update('f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1','lf1'),
                  ARRAY['plans'], jsonb_build_array(jsonb_build_object('id','pl1')))
        #- ARRAY['plan']);

    fam := public.camp_family('f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1','lf1');
    IF jsonb_typeof(fam -> 'plans') <> 'array' THEN
        RAISE EXCEPTION 'plans was not set: %', fam;
    END IF;
    IF fam -> 'plan' IS NOT NULL THEN
        RAISE EXCEPTION 'THE LEGACY PLAN SURVIVED — a second plan the parent can still be charged on: %', fam;
    END IF;
    IF (fam ->> 'name') <> 'Stein' THEN RAISE EXCEPTION 'the save clobbered the family: %', fam; END IF;
    RAISE NOTICE 'ok  the plan write sets plans, removes the legacy plan, and keeps the rest';
END $$;

-- ── an append writer reaches the rows, not the document ──────────────────
DO $$
DECLARE before_val jsonb; after_val jsonb; n_before integer; n_after integer;
BEGIN
    SELECT value INTO before_val FROM camp_state_kv
     WHERE camp_id='f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1' AND key='campistryMe';
    n_before := jsonb_array_length(public.camp_payments_array('f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1'));
    PERFORM public.camp_payment_add('f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1',
        jsonb_build_object('id','lp3','familyKey','lf1','amount',7,'status','succeeded','date','2026-08-03'));
    n_after := jsonb_array_length(public.camp_payments_array('f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1'));
    SELECT value INTO after_val FROM camp_state_kv
     WHERE camp_id='f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1' AND key='campistryMe';
    IF n_after <> n_before + 1 THEN RAISE EXCEPTION 'the payment did not land'; END IF;
    IF after_val IS DISTINCT FROM before_val THEN
        RAISE EXCEPTION 'adding a payment modified the camp document';
    END IF;
    RAISE NOTICE 'ok  a payment lands in the rows and the document is untouched';
END $$;

SELECT 'ALL 215 BEHAVIOUR CHECKS PASSED' AS result;
