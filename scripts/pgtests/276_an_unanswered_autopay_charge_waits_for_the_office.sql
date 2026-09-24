-- Behaviour test for migration 276 (TED-113): an autopay charge the card
-- company never answered is held on the plan until the office answers it.
--   1. "It went through" records the instalment once, with the reference, and
--      clears the hold; asking again finds nothing to answer.
--   2. "It did not" clears the hold and records nothing.
--   3. An old-style instalment plan the same.
--   4. Someone who cannot edit Billing cannot answer; a reference is required.
\set ON_ERROR_STOP on

INSERT INTO auth.users (id, email) VALUES
  ('f2760000-0000-0000-0000-0000000000a1', 'o@276.test'),
  ('f2760000-0000-0000-0000-0000000000b1', 'x@276.test');
INSERT INTO public.camps (id, owner, name) VALUES ('f2760000-0000-0000-0000-000000000001', 'f2760000-0000-0000-0000-0000000000a1', 'Autopay Camp');

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $f$ SELECT NULLIF(current_setting('t276.uid', true), '')::uuid $f$;
SELECT set_config('t276.uid', 'f2760000-0000-0000-0000-0000000000a1', false);
SELECT set_config('request.jwt.claims', '{"sub":"f2760000-0000-0000-0000-0000000000a1"}', false);

INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('f2760000-0000-0000-0000-000000000001', 'campistryMe', jsonb_build_object(
  'families', jsonb_build_object(
    'gold', jsonb_build_object('name', 'Gold', 'camperIds', jsonb_build_array('Avi Gold'),
       'entries', jsonb_build_array(jsonb_build_object('id', 'le_t', 'kind', 'charge', 'amount', 1000, 'reason', 'tuition')),
       'plans', jsonb_build_array(jsonb_build_object('id', 'plan_g', 'autopay', true,
            'dueDates', jsonb_build_array('2026-06-01', '2026-07-01'), 'nextIndex', 0))),
    'silver', jsonb_build_object('name', 'Silver', 'camperIds', jsonb_build_array('Dina Silver'),
       'plans', jsonb_build_array(jsonb_build_object('id', 'plan_s', 'autopay', true,
            'dueDates', jsonb_build_array('2026-06-01'), 'nextIndex', 0))),
    'blue', jsonb_build_object('name', 'Blue', 'camperIds', jsonb_build_array('Dov Blue'),
       'plans', jsonb_build_array(jsonb_build_object('autopay', true,
            'installments', jsonb_build_array(jsonb_build_object('dueDate', '2026-06-01', 'amount', 300, 'status', 'pending'))))))));

-- the holds, written the way the nightly runner writes them (a page save
-- cannot put one on a plan: 269 keeps the server's)
SELECT public.hold_autopay_charge('f2760000-0000-0000-0000-000000000001', 'gold', 'plan_g',
  '{"unconfirmed":true,"processor":"cardknox","amount":500,"index":0,"planId":"plan_g","dueDate":"2026-06-01","since":"2026-06-01","why":"connection reset"}');
SELECT public.hold_autopay_charge('f2760000-0000-0000-0000-000000000001', 'silver', 'plan_s',
  '{"unconfirmed":true,"processor":"banquest","amount":400,"index":0,"planId":"plan_s","dueDate":"2026-06-01","since":"2026-06-01","why":"HTTP 504"}');
SELECT public.hold_autopay_charge('f2760000-0000-0000-0000-000000000001', 'blue', '#0',
  '{"unconfirmed":true,"processor":"stripe","amount":300,"planIndex":0,"dueDate":"2026-06-01","since":"2026-06-01","why":"no answer"}');

DO $$
DECLARE c uuid := 'f2760000-0000-0000-0000-000000000001'; r jsonb; fam jsonb; n int;
BEGIN
    -- 4. the rules first
    r := public.resolve_unconfirmed_autopay(c, 'gold', 'plan_g', true, NULL);
    IF r->>'error' IS DISTINCT FROM 'reference_required' THEN RAISE EXCEPTION '"went through" with no reference: %', r; END IF;
    PERFORM set_config('t276.uid', 'f2760000-0000-0000-0000-0000000000b1', false);
    r := public.resolve_unconfirmed_autopay(c, 'gold', 'plan_g', false);
    IF r->>'error' IS DISTINCT FROM 'not_authorized' THEN RAISE EXCEPTION 'a stranger answered an autopay charge: %', r; END IF;
    PERFORM set_config('t276.uid', 'f2760000-0000-0000-0000-0000000000a1', false);

    -- 1. it went through: recorded once, with its reference
    r := public.resolve_unconfirmed_autopay(c, 'gold', 'plan_g', true, '9001');
    IF (r->>'success')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'went through: %', r; END IF;
    fam := public.camp_family(c, 'gold');
    IF fam #> '{plans,0,pendingCharge}' IS NOT NULL THEN RAISE EXCEPTION 'the hold stayed: %', fam->'plans'; END IF;
    IF (fam #>> '{plans,0,nextIndex}')::int <> 1 THEN RAISE EXCEPTION 'the instalment was not recorded: %', fam->'plans'; END IF;
    SELECT count(*) INTO n FROM jsonb_array_elements(fam->'entries') e
     WHERE e->>'kind' = 'payment' AND (e->>'amount')::numeric = 500 AND e #>> '{source,paymentId}' = '9001';
    IF n <> 1 THEN RAISE EXCEPTION 'the $500 is not on the ledger once (%): %', n, fam->'entries'; END IF;
    r := public.resolve_unconfirmed_autopay(c, 'gold', 'plan_g', true, '9001');
    IF r->>'error' IS DISTINCT FROM 'nothing_to_answer' THEN RAISE EXCEPTION 'answered twice: %', r; END IF;

    -- 2. it did not: the hold goes, nothing is recorded
    r := public.resolve_unconfirmed_autopay(c, 'silver', 'plan_s', false);
    fam := public.camp_family(c, 'silver');
    IF (r->>'success')::boolean IS NOT TRUE OR fam #> '{plans,0,pendingCharge}' IS NOT NULL
       OR COALESCE((fam #>> '{plans,0,nextIndex}')::int, 0) <> 0 OR jsonb_array_length(COALESCE(fam->'entries', '[]')) <> 0 THEN
        RAISE EXCEPTION 'did not go through: % %', r, fam;
    END IF;

    -- TED-120: on Stripe, only the payment's own id is taken — a charge id
    -- (ch_) would be booked beside the webhook's copy and counted twice
    r := public.resolve_unconfirmed_autopay(c, 'blue', '#0', true, 'ch_276');
    IF r->>'error' IS DISTINCT FROM 'stripe_needs_payment_id' THEN RAISE EXCEPTION 'TED-120: a ch_ id was taken: %', r; END IF;
    INSERT INTO camp_payments (camp_id, payment_id, payload)
    VALUES (c, 'pi_pi_other', '{"id":"pi_pi_other","familyKey":"blue","amount":999,"stripePaymentIntentId":"pi_other","status":"succeeded"}'::jsonb);
    r := public.resolve_unconfirmed_autopay(c, 'blue', '#0', true, 'pi_other');
    IF r->>'error' IS DISTINCT FROM 'reference_is_another_payment' THEN RAISE EXCEPTION 'TED-120: another payment''s id was taken: %', r; END IF;

    -- 3. an old-style instalment plan, by position — a Stripe one is recorded
    -- through the server's door once stripe-charge has checked it (279)
    r := public.resolve_unconfirmed_autopay(c, 'blue', '#0', true, 'pi_276');
    IF r->>'error' IS DISTINCT FROM 'stripe_check_needed' THEN RAISE EXCEPTION '279: a Stripe answer taken from the browser: %', r; END IF;
    r := public.resolve_unconfirmed_autopay_checked(c, 'blue', '#0', 'pi_276');
    fam := public.camp_family(c, 'blue');
    IF (r->>'success')::boolean IS NOT TRUE OR fam #>> '{plans,0,installments,0,status}' <> 'paid'
       OR fam #>> '{plans,0,installments,0,stripePaymentIntentId}' <> 'pi_276' OR fam #> '{plans,0,pendingCharge}' IS NOT NULL THEN
        RAISE EXCEPTION 'old-style plan: % %', r, fam->'plans';
    END IF;

    IF has_function_privilege('anon', 'public.resolve_unconfirmed_autopay(uuid,text,text,boolean,text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'anyone can answer autopay charges';
    END IF;
    RAISE NOTICE 'ok  276: went through (once) / did not / old-style plan / strangers and missing references refused';
END $$;

\set verify_q `cat scripts/verify_identity_chain.sql`
BEGIN;
CREATE TEMP TABLE v276 AS :verify_q
DO $$
DECLARE r text;
BEGIN
    SELECT result INTO r FROM v276 WHERE item LIKE '276%';
    IF r IS DISTINCT FROM 'ok' THEN RAISE EXCEPTION 'the checking script''s 276 row says: %', r; END IF;
END $$;
ROLLBACK;
