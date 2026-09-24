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

    -- NOT "nothing writes the document" — four functions legitimately still write
    -- staffApplications, enrollments and enrollSettings, branches that have not
    -- moved to rows. The live database reported 5 of those while this check said
    -- 0, because the sandbox does not contain them: the assertion was wrong, not
    -- the database. What must be zero is a writer that puts FAMILIES or PAYMENTS
    -- back into the document, because the triggers would project that over the rows.
    SELECT count(*), COALESCE(string_agg(p.proname, ', '), '')
      INTO n, who
      FROM pg_proc p JOIN pg_namespace nsp ON nsp.oid = p.pronamespace
     WHERE nsp.nspname = 'public' AND p.prokind = 'f'
       AND pg_get_functiondef(p.oid) ~ 'UPDATE camp_state_kv[^;]*campistryMe'
       AND pg_get_functiondef(p.oid) ~ 'jsonb_set\([^;]{0,60}(ARRAY\[''families''|''\{families\}''|''\{payments\}''|''\{finance\}''|ARRAY\[''finance'')';
    IF n <> 0 THEN
        RAISE EXCEPTION 'these still write families/payments into the document, which the triggers would project over the rows: %', who;
    END IF;
    RAISE NOTICE 'ok  nothing locks campistryMe, and nothing writes families or payments into it';
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

-- ════════════════════════════════════════════════════════════════════════════
-- (TED-060) Billing, in the real database — the pieces the TED-051..062 fixes
-- rest on, run through the functions themselves.
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO public.camps (id, owner, name)
VALUES ('f2f2f2f2-f2f2-f2f2-f2f2-f2f2f2f2f2f2', NULL, 'Billing Camp');
INSERT INTO public.camp_state_kv (camp_id, key, value) VALUES
('f2f2f2f2-f2f2-f2f2-f2f2-f2f2f2f2f2f2', 'campistryMe', jsonb_build_object('families', jsonb_build_object(
  -- $1,000 tuition, $400 paid, and a $25 late fee posted the way the Me page
  -- now posts it (TED-053: le_chg_<charge id>).
  'bf1', jsonb_build_object('name','Gold','camperIds', jsonb_build_array('Avi Gold'),
     'charges', jsonb_build_array(jsonb_build_object('id','lf_1','category','Late Fee','amount',25)),
     'entries', jsonb_build_array(
        jsonb_build_object('id','le_t1','kind','charge','amount',1000,'reason','tuition'),
        jsonb_build_object('id','le_p1','kind','payment','amount',400,'reason','card'),
        jsonb_build_object('id','le_chg_lf_1','kind','charge','amount',25,'reason','fee',
                           'source', jsonb_build_object('chargeId','lf_1')))),
  -- an office-built installments[] plan, first instalment due
  'bf2', jsonb_build_object('name','Stone','camperIds', jsonb_build_array('Rina Stone'),
     'plans', jsonb_build_array(jsonb_build_object('id','plan_o','autopay',true,
        'installments', jsonb_build_array(
           jsonb_build_object('n',1,'amount',500,'dueDate','2026-06-01','status','pending'),
           jsonb_build_object('n',2,'amount',500,'dueDate','2026-07-01','status','pending'))))),
  -- a parent-built (ledger) plan
  'bf3', jsonb_build_object('name','Katz','camperIds', jsonb_build_array('Dov Katz'),
     'entries', jsonb_build_array(jsonb_build_object('id','le_t3','kind','charge','amount',900,'reason','tuition')),
     'plans', jsonb_build_array(jsonb_build_object('id','plan_p','autopay',true,'paused',false,
        'dueDates', jsonb_build_array('2026-06-01','2026-07-01','2026-08-01'),'count',3,'nextIndex',0,
        'history','[]'::jsonb))))));

DO $$
DECLARE c uuid := 'f2f2f2f2-f2f2-f2f2-f2f2-f2f2f2f2f2f2'; fam jsonb; r jsonb; inst jsonb; d jsonb;
BEGIN
    -- TED-053: the parent's balance counts the late fee
    fam := public.camp_families_object(c) -> 'bf1';
    IF fam IS NULL THEN RAISE EXCEPTION 'the family did not reach its row'; END IF;
    IF public.family_ledger_balance(fam) <> 625 THEN
        RAISE EXCEPTION 'TED-053: the balance with a $25 late fee is %, not 625', public.family_ledger_balance(fam);
    END IF;
    IF (public.family_ledger_summary(fam) ->> 'billed')::numeric <> 1025 THEN
        RAISE EXCEPTION 'TED-053: billed is %, not 1025', public.family_ledger_summary(fam);
    END IF;
    RAISE NOTICE 'ok  TED-053: a posted $25 late fee takes the parent balance from 600 to 625';

    -- TED-055: a declined legacy instalment stays PENDING with its reason...
    r := public.record_autopay_installment(c, 'bf2', 'plan_o', 0, '2026-06-01',
            jsonb_build_object('failReason','Your card was declined.','attempts',1), NULL, NULL);
    IF NOT (r ->> 'success')::boolean OR NOT (r ->> 'patched')::boolean THEN
        RAISE EXCEPTION 'TED-055: the decline was not written: %', r;
    END IF;
    inst := public.camp_families_object(c) #> '{bf2,plans,0,installments,0}';
    IF inst ->> 'status' <> 'pending' OR inst ->> 'failReason' IS NULL THEN
        RAISE EXCEPTION 'TED-055: a declined instalment must stay pending with its reason: %', inst;
    END IF;
    -- ...the plan is flagged (the office is told, a retry date is set)...
    r := public.flag_plan_collection(c, 'bf2', 'plan_o', 'declined', 'Your card was declined.');
    IF NOT (r ->> 'success')::boolean THEN RAISE EXCEPTION 'TED-055: flagging an installments[] plan failed: %', r; END IF;
    IF (public.camp_families_object(c) #>> '{bf2,plans,0,collectionBlocked,nextRetryAt}') IS NULL THEN
        RAISE EXCEPTION 'TED-055: the plan has no retry date';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM notifications WHERE camp_id = c AND source = 'autopay_blocked') THEN
        RAISE EXCEPTION 'TED-055: the office was not notified';
    END IF;
    -- ...and the retry can mark it PAID, recording the payment with it.
    r := public.record_autopay_installment(c, 'bf2', 'plan_o', 0, '2026-06-01',
            jsonb_build_object('status','paid','paidDate','2026-06-04'),
            jsonb_build_object('id','auto_pi_2','familyKey','bf2','amount',500,'status','succeeded','date','2026-06-04',
                               'stripePaymentIntentId','pi_2'), 'pi_2');
    inst := public.camp_families_object(c) #> '{bf2,plans,0,installments,0}';
    IF inst ->> 'status' <> 'paid' THEN RAISE EXCEPTION 'TED-055: the retry could not mark it paid: %', inst; END IF;
    r := public.flag_plan_collection(c, 'bf2', 'plan_o', NULL, NULL);
    IF (public.camp_families_object(c) #> '{bf2,plans,0}') ? 'collectionBlocked' THEN
        RAISE EXCEPTION 'TED-055: collecting did not clear the flag';
    END IF;
    RAISE NOTICE 'ok  TED-055: decline stays pending + flagged + notified; the retry pays it and clears the flag';

    -- TED-051: a parent-built plan has an amount due, worked out from what is owed
    d := public.plan_due_for(c, 'bf3', 'plan_p', '2026-06-02');
    IF d IS NULL OR (d ->> 'amount')::numeric <> 300 THEN
        RAISE EXCEPTION 'TED-051: the parent plan should have $300 due (900 over 3): %', d;
    END IF;
    RAISE NOTICE 'ok  TED-051: a parent-built plan has $300 due on its first date';
END $$;
