-- Behaviour test for migration 265 (TED-077): a Zelle payment posted to a
-- family reaches its ledger — through the real _deposit_record and the office's
-- re-match / ignore actions — and autopay then asks for the right amount.
\set ON_ERROR_STOP on

INSERT INTO auth.users (id, email) VALUES ('f2650000-0000-0000-0000-0000000000a1', 'o@265.test');
INSERT INTO public.camps (id, owner, name) VALUES ('f2650000-0000-0000-0000-000000000001', 'f2650000-0000-0000-0000-0000000000a1', 'Zelle Camp');
INSERT INTO public.camp_state_kv (camp_id, key, value) VALUES
('f2650000-0000-0000-0000-000000000001', 'campistryMe', jsonb_build_object('families', jsonb_build_object(
  'gold', jsonb_build_object('name','Gold','camperIds', jsonb_build_array('Avi Gold'),
     'entries', jsonb_build_array(jsonb_build_object('id','le_t','kind','charge','amount',1000,'reason','tuition','source',jsonb_build_object('enrollmentId','e1'))),
     'plans', jsonb_build_array(jsonb_build_object('id','plan_1','autopay',true,'dueDates',jsonb_build_array('2026-06-01','2026-07-01'),'nextIndex',0))),
  'stone', jsonb_build_object('name','Stone','camperIds', jsonb_build_array('Rina Stone'),
     'entries', jsonb_build_array(jsonb_build_object('id','le_t2','kind','charge','amount',500,'reason','tuition','source',jsonb_build_object('enrollmentId','e2')))))));

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $f$ SELECT NULLIF(current_setting('t265.uid', true), '')::uuid $f$;
SELECT set_config('t265.uid', 'f2650000-0000-0000-0000-0000000000a1', false);

DO $$
DECLARE c uuid := 'f2650000-0000-0000-0000-000000000001'; r jsonb; dep uuid; bal numeric; d jsonb;
BEGIN
    -- the bank's email is read: $400 by Zelle, auto-matched to Gold
    r := public._deposit_record(c, 'fp1', 40000, '{"date":"2026-05-30","payerName":"GOLD","kind":"zelle"}'::jsonb,
                                '{"decision":"auto","familyKey":"gold","confidence":95}'::jsonb);
    SELECT id INTO dep FROM bank_deposits WHERE camp_id = c;
    IF (SELECT status FROM bank_deposits WHERE id = dep) <> 'posted' THEN RAISE EXCEPTION 'setup: the deposit did not post: %', r; END IF;
    bal := public.family_ledger_balance(public.camp_families_object(c) -> 'gold');
    IF bal <> 600 THEN RAISE EXCEPTION 'TED-077: $1000 bill, $400 Zelle — ledger says %', bal; END IF;
    d := public.plan_due_for(c, 'gold', 'plan_1', '2026-06-01');
    IF (d->>'amount')::numeric <> 300 THEN RAISE EXCEPTION 'TED-077: autopay should ask 300, asks %', d; END IF;

    -- the office moves it to the right family: off Gold, onto Stone
    r := public.resolve_bank_deposit(c, dep, 'stone', false);
    IF public.family_ledger_balance(public.camp_families_object(c) -> 'gold') <> 1000 THEN
        RAISE EXCEPTION 'moving the deposit left it on Gold: %', public.family_ledger_balance(public.camp_families_object(c) -> 'gold');
    END IF;
    IF public.family_ledger_balance(public.camp_families_object(c) -> 'stone') <> 100 THEN
        RAISE EXCEPTION 'the deposit did not reach Stone: %', public.family_ledger_balance(public.camp_families_object(c) -> 'stone');
    END IF;

    -- ignoring it takes it off everyone
    r := public.ignore_bank_deposit(c, dep, 'not a camp payment');
    IF public.family_ledger_balance(public.camp_families_object(c) -> 'stone') <> 500 THEN
        RAISE EXCEPTION 'an ignored deposit still counts on Stone';
    END IF;

    -- re-running the backfill / trigger posts nothing twice
    PERFORM public._sync_deposit_to_ledger(c, 'gold', dep);
    PERFORM public._sync_deposit_to_ledger(c, 'stone', dep);
    IF public.family_ledger_balance(public.camp_families_object(c) -> 'gold') <> 1000
       OR public.family_ledger_balance(public.camp_families_object(c) -> 'stone') <> 500 THEN
        RAISE EXCEPTION 're-syncing moved a balance';
    END IF;
    RAISE NOTICE 'ok  265: Zelle 400 -> 600 (autopay 300); moved to Stone; ignored; re-sync changes nothing';
END $$;

-- a bank return (NSF) posted to a family is taken back off
DO $$
DECLARE c uuid := 'f2650000-0000-0000-0000-000000000001';
BEGIN
    INSERT INTO bank_deposits (camp_id, fingerprint, amount_cents, is_reversal, status, family_key, deposit_date)
    VALUES (c, 'fp_ret', 20000, true, 'posted', 'gold', '2026-06-10');
    IF public.family_ledger_balance(public.camp_families_object(c) -> 'gold') <> 1200 THEN
        RAISE EXCEPTION 'a returned deposit should raise the balance by 200: %', public.family_ledger_balance(public.camp_families_object(c) -> 'gold');
    END IF;
END $$;

\set verify_q `cat scripts/verify_identity_chain.sql`
BEGIN;
CREATE TEMP TABLE v265 AS :verify_q
DO $$
DECLARE r text;
BEGIN
    SELECT result INTO r FROM v265 WHERE item LIKE '265%';
    IF r IS DISTINCT FROM 'ok' THEN RAISE EXCEPTION 'the checking script''s 265 row says: %', r; END IF;
END $$;
ROLLBACK;
