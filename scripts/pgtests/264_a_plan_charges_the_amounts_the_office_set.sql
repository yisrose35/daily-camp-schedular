-- Behaviour test for migration 264 (TED-068): a plan charges the amounts the
-- office set, never more than is owed; a plan without amounts splits evenly.
\set ON_ERROR_STOP on

DO $$
DECLARE fam jsonb := jsonb_build_object('entries', jsonb_build_array(
            jsonb_build_object('id','t','kind','charge','amount',1400,'reason','tuition')));
        d jsonb;
BEGIN
    -- $1,000 / $200 / $200 typed by the office
    d := public.plan_due(fam, '{"autopay":true,"dueDates":["2026-06-01","2026-07-01","2026-08-01"],"amounts":[1000,200,200],"nextIndex":0}'::jsonb, '2026-06-02');
    IF (d->>'amount')::numeric <> 1000 THEN RAISE EXCEPTION 'TED-068: first instalment should be 1000, got %', d; END IF;
    -- $600 of a $1,400 balance, in two
    d := public.plan_due(fam, '{"autopay":true,"dueDates":["2026-06-01","2026-07-01"],"amounts":[300,300],"nextIndex":0}'::jsonb, '2026-06-02');
    IF (d->>'amount')::numeric <> 300 THEN RAISE EXCEPTION 'TED-068: a $600 plan charged %, not 300', d; END IF;
    -- never more than is owed
    d := public.plan_due(jsonb_build_object('entries', jsonb_build_array(jsonb_build_object('id','t','kind','charge','amount',120,'reason','tuition'))),
                         '{"autopay":true,"dueDates":["2026-06-01"],"amounts":[500],"nextIndex":0}'::jsonb, '2026-06-02');
    IF (d->>'amount')::numeric <> 120 THEN RAISE EXCEPTION 'charged more than is owed: %', d; END IF;
    -- a plan without amounts (a parent's) splits evenly, as before
    d := public.plan_due(fam, '{"autopay":true,"dueDates":["2026-06-01","2026-07-01"],"nextIndex":0}'::jsonb, '2026-06-02');
    IF (d->>'amount')::numeric <> 700 THEN RAISE EXCEPTION 'an even plan changed: %', d; END IF;
    -- a null amount for this instalment falls back to the even split
    d := public.plan_due(fam, '{"autopay":true,"dueDates":["2026-06-01","2026-07-01"],"amounts":[null,300],"nextIndex":0}'::jsonb, '2026-06-02');
    IF (d->>'amount')::numeric <> 700 THEN RAISE EXCEPTION 'a missing amount did not fall back: %', d; END IF;
    RAISE NOTICE 'ok  264: 1000/200/200 kept; $600 of $1400 = 300; capped at owed; even plans unchanged';
END $$;

\set verify_q `cat scripts/verify_identity_chain.sql`
BEGIN;
CREATE TEMP TABLE v264 AS :verify_q
DO $$
DECLARE r text;
BEGIN
    SELECT result INTO r FROM v264 WHERE item LIKE '264%';
    IF r IS DISTINCT FROM 'ok' THEN RAISE EXCEPTION 'the checking script''s 264 row says: %', r; END IF;
END $$;
ROLLBACK;
