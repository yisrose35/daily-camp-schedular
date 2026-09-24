-- Behaviour test for migration 279 (TED-120, what was left): "the autopay
-- charge went through" is checked before it is recorded.
--   1. Another family's payment — same amount — pasted for this family is
--      refused (Stripe and Sola alike).
--   2. On Stripe the browser can no longer record it at all: it must come
--      through stripe-charge, which checks it with Stripe first.
--   3. Through the server's door a checked payment is recorded once.
--   4. Neither the server's door nor the work behind it can be called by a browser.
\set ON_ERROR_STOP on

INSERT INTO auth.users (id, email) VALUES ('f2790000-0000-0000-0000-0000000000a1', 'o@279.test');
INSERT INTO public.camps (id, owner, name) VALUES ('f2790000-0000-0000-0000-000000000001', 'f2790000-0000-0000-0000-0000000000a1', 'Check Camp');

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $f$ SELECT NULLIF(current_setting('t279.uid', true), '')::uuid $f$;
SELECT set_config('t279.uid', 'f2790000-0000-0000-0000-0000000000a1', false);
SELECT set_config('request.jwt.claims', '{"sub":"f2790000-0000-0000-0000-0000000000a1"}', false);

INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('f2790000-0000-0000-0000-000000000001', 'campistryMe', jsonb_build_object(
  'families', jsonb_build_object(
    'gold', jsonb_build_object('name', 'Gold', 'camperIds', jsonb_build_array('Avi Gold'), 'stripeCustomerId', 'cus_gold',
       'entries', jsonb_build_array(jsonb_build_object('id', 'le_t', 'kind', 'charge', 'amount', 1000, 'reason', 'tuition')),
       'plans', jsonb_build_array(jsonb_build_object('id', 'plan_g', 'autopay', true,
            'dueDates', jsonb_build_array('2026-06-01', '2026-07-01'), 'nextIndex', 0))),
    'silver', jsonb_build_object('name', 'Silver', 'camperIds', jsonb_build_array('Dina Silver'),
       'entries', jsonb_build_array(
            jsonb_build_object('id', 'le_t', 'kind', 'charge', 'amount', 500, 'reason', 'tuition'),
            jsonb_build_object('id', 'le_pay_pi_SILVER', 'kind', 'payment', 'amount', 500, 'reason', 'card', 'source', jsonb_build_object('paymentId', 'pi_SILVER')))),
    'blue', jsonb_build_object('name', 'Blue', 'camperIds', jsonb_build_array('Dov Blue'),
       'entries', jsonb_build_array(jsonb_build_object('id', 'le_t', 'kind', 'charge', 'amount', 600, 'reason', 'tuition')),
       'plans', jsonb_build_array(jsonb_build_object('id', 'plan_b', 'autopay', true,
            'dueDates', jsonb_build_array('2026-06-01', '2026-07-01'), 'nextIndex', 0))))));
INSERT INTO camp_payments (camp_id, payment_id, family_key, amount, payload) VALUES
  ('f2790000-0000-0000-0000-000000000001', 'pi_SILVER', 'silver', 500,
   '{"id":"pi_SILVER","familyKey":"silver","amount":500,"stripePaymentIntentId":"pi_SILVER","status":"succeeded"}'),
  ('f2790000-0000-0000-0000-000000000001', 'byop_X77', 'silver', 300,
   '{"id":"byop_X77","familyKey":"silver","amount":300,"byopTransactionId":"X77","status":"succeeded"}');

SELECT public.hold_autopay_charge('f2790000-0000-0000-0000-000000000001', 'gold', 'plan_g',
  '{"unconfirmed":true,"processor":"stripe","amount":500,"index":0,"planId":"plan_g","dueDate":"2026-06-01","since":"2026-06-01","why":"no answer"}');
SELECT public.hold_autopay_charge('f2790000-0000-0000-0000-000000000001', 'blue', 'plan_b',
  '{"unconfirmed":true,"processor":"cardknox","amount":300,"index":0,"planId":"plan_b","dueDate":"2026-06-01","since":"2026-06-01","why":"connection reset"}');

DO $$
DECLARE c uuid := 'f2790000-0000-0000-0000-000000000001'; r jsonb; fam jsonb; n int;
BEGIN
    -- 1. Silver's payment, same $500, pasted for Gold
    r := public.resolve_unconfirmed_autopay(c, 'gold', 'plan_g', true, 'pi_SILVER');
    IF r->>'error' IS DISTINCT FROM 'reference_is_another_payment' THEN
        RAISE EXCEPTION 'TED-120: another family''s same-amount payment was taken for Gold: %', r;
    END IF;
    -- ...and on Sola, Silver's X77 ($300, the same as Blue's instalment)
    r := public.resolve_unconfirmed_autopay(c, 'blue', 'plan_b', true, 'X77');
    IF r->>'error' IS DISTINCT FROM 'reference_is_another_payment' THEN
        RAISE EXCEPTION 'TED-120: another family''s Sola payment was taken for Blue: %', r;
    END IF;

    -- 2. Gold's own pi_, from the browser: not recorded — Stripe must check it
    r := public.resolve_unconfirmed_autopay(c, 'gold', 'plan_g', true, 'pi_GOLD');
    fam := public.camp_family(c, 'gold');
    IF r->>'error' IS DISTINCT FROM 'stripe_check_needed' OR fam #> '{plans,0,pendingCharge}' IS NULL THEN
        RAISE EXCEPTION 'TED-120: a Stripe payment was recorded from the browser unchecked: % %', r, fam->'plans';
    END IF;

    -- 3. the server's door, after stripe-charge checked it with Stripe
    r := public.resolve_unconfirmed_autopay_checked(c, 'gold', 'plan_g', 'pi_GOLD');
    fam := public.camp_family(c, 'gold');
    IF (r->>'success')::boolean IS NOT TRUE OR fam #> '{plans,0,pendingCharge}' IS NOT NULL
       OR (fam #>> '{plans,0,nextIndex}')::int <> 1 THEN
        RAISE EXCEPTION 'the checked payment was not recorded: % %', r, fam->'plans';
    END IF;
    SELECT count(*) INTO n FROM jsonb_array_elements(fam->'entries') e
     WHERE e->>'kind' = 'payment' AND (e->>'amount')::numeric = 500 AND e #>> '{source,paymentId}' = 'pi_GOLD';
    IF n <> 1 THEN RAISE EXCEPTION 'the $500 is not on Gold''s ledger once (%): %', n, fam->'entries'; END IF;
    r := public.resolve_unconfirmed_autopay_checked(c, 'gold', 'plan_g', 'pi_GOLD');
    IF r->>'error' IS DISTINCT FROM 'nothing_to_answer' THEN RAISE EXCEPTION 'recorded twice: %', r; END IF;
    -- even the server's door refuses another family's payment
    PERFORM public.hold_autopay_charge(c, 'gold', 'plan_g',
      '{"unconfirmed":true,"processor":"stripe","amount":500,"index":1,"planId":"plan_g","dueDate":"2026-07-01","since":"2026-07-01"}');
    r := public.resolve_unconfirmed_autopay_checked(c, 'gold', 'plan_g', 'pi_SILVER');
    IF r->>'error' IS DISTINCT FROM 'reference_is_another_payment' THEN RAISE EXCEPTION 'server door took Silver''s payment: %', r; END IF;

    -- Blue's own Sola reference is still recorded from Billing
    r := public.resolve_unconfirmed_autopay(c, 'blue', 'plan_b', true, 'X88');
    IF (r->>'success')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'Blue''s own Sola reference: %', r; END IF;

    -- 4. only the server
    IF has_function_privilege('authenticated', 'public.resolve_unconfirmed_autopay_checked(uuid,text,text,text)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.resolve_unconfirmed_autopay_checked(uuid,text,text,text)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public._record_autopay_answer(uuid,text,text,boolean,text,boolean)', 'EXECUTE') THEN
        RAISE EXCEPTION 'a browser can record a Stripe payment without Stripe checking it';
    END IF;
    RAISE NOTICE 'ok  279: another family''s payment refused / Stripe needs the check / checked recorded once / grants';
END $$;

\set verify_q `cat scripts/verify_identity_chain.sql`
BEGIN;
CREATE TEMP TABLE v279 AS :verify_q
DO $$
DECLARE r text;
BEGIN
    SELECT result INTO r FROM v279 WHERE item LIKE '279%';
    IF r IS DISTINCT FROM 'ok' THEN RAISE EXCEPTION 'the checking script''s 279 row says: %', r; END IF;
END $$;
ROLLBACK;
