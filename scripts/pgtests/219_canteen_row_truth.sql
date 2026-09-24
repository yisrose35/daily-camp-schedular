-- Behaviour test for 219. The conversion moved thirteen money functions off a
-- camp-wide lock. What must be proved is that NOTHING ELSE moved: the same
-- purchase is refused for the same reasons, the same deposit credits the same
-- amount, and the duplicate guard still refuses the same retry.
--
-- These are all "did the transformation change a number" questions, which is
-- exactly what a rule-based rewrite cannot be trusted about on its own.

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION public.camp_reader(p_camp_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$ SELECT true $$;

-- submit_canteen_purchase authenticates through auth.uid() and camps.owner.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT '99999999-9999-9999-9999-999999999999'::uuid $$;

DO $$
DECLARE
    c   uuid := '55555555-5555-5555-5555-555555555555';
    me  uuid := '99999999-9999-9999-9999-999999999999';
    r   jsonb;
    bal numeric;
BEGIN
    INSERT INTO camps (id, owner, name) VALUES (c, me, 'Till Camp');
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES (c, 'app1', jsonb_build_object(
        'camperRoster', jsonb_build_object(
            'Ayala Weiss', jsonb_build_object('camperId', '880', 'name', 'Ayala Weiss'),
            'Dov Lerner',  jsonb_build_object('camperId', '881', 'name', 'Dov Lerner'))));

    -- ── 1. a purchase debits the right camper, and only that camper ─────────
    -- No account exists yet: canteen_account_lock must create it, the way the
    -- document's INSERT ... ON CONFLICT DO NOTHING used to.
    -- canteen_account_save is an upsert, so seeding needs no prior lock. The
    -- first version of this test called save on a row that did not exist yet
    -- and the seed silently did nothing — which is what made save an upsert.
    PERFORM public.canteen_account_save(c, 'Ayala Weiss',
        jsonb_build_object('balance', 20.00, 'dailyLimit', 10, 'spentToday', 0));
    PERFORM public.canteen_account_save(c, 'Dov Lerner',
        jsonb_build_object('balance', 5.00, 'dailyLimit', 10, 'spentToday', 0));
    IF (SELECT balance FROM camp_canteen_accounts
         WHERE camp_id = c AND account_key = 'Ayala Weiss') IS DISTINCT FROM 20.00 THEN
        RAISE EXCEPTION 'canteen_account_save did not create a missing row — a save that '
                        'lands nowhere and reports success is the bug this chain keeps finding';
    END IF;

    r := public.submit_canteen_purchase(c, 'Ayala Weiss', 3.00, 'Ices');
    IF (r ->> 'success') IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'a valid purchase was refused: %', r;
    END IF;
    SELECT balance INTO bal FROM camp_canteen_accounts
     WHERE camp_id = c AND account_key = 'Ayala Weiss';
    IF bal IS DISTINCT FROM 17.00 THEN
        RAISE EXCEPTION 'balance after a 3.00 purchase on 20.00 is %, expected 17.00', bal;
    END IF;
    IF (SELECT balance FROM camp_canteen_accounts
         WHERE camp_id = c AND account_key = 'Dov Lerner') IS DISTINCT FROM 5.00 THEN
        RAISE EXCEPTION 'one camper''s purchase moved another camper''s balance';
    END IF;

    -- ── 2. the sale reached the ledger ──────────────────────────────────────
    IF (SELECT count(*) FROM canteen_transactions
         WHERE camp_id = c AND camper = 'Ayala Weiss' AND amount = 3.00) <> 1 THEN
        RAISE EXCEPTION 'the purchase did not reach canteen_transactions';
    END IF;
    -- and carries the camper's id, which is the whole point of 216
    IF (SELECT camper_id FROM canteen_transactions
         WHERE camp_id = c AND camper = 'Ayala Weiss' LIMIT 1) IS DISTINCT FROM '880' THEN
        RAISE EXCEPTION 'the ledger row did not record the camper id';
    END IF;

    -- ── 3. the daily cap still bites, with the same arithmetic ──────────────
    -- 3.00 spent of a 10.00 cap; 8.00 more must be refused, 7.00 allowed.
    r := public.submit_canteen_purchase(c, 'Ayala Weiss', 8.00, 'Too much');
    IF (r ->> 'error') IS DISTINCT FROM 'daily_limit_exceeded' THEN
        RAISE EXCEPTION 'the daily cap did not refuse an over-cap purchase: %', r;
    END IF;
    IF (r ->> 'remaining')::numeric IS DISTINCT FROM 7.00 THEN
        RAISE EXCEPTION 'the cap refusal reported the wrong remaining amount: %', r;
    END IF;
    IF (SELECT balance FROM camp_canteen_accounts
         WHERE camp_id = c AND account_key = 'Ayala Weiss') IS DISTINCT FROM 17.00 THEN
        RAISE EXCEPTION 'a REFUSED purchase still moved the balance';
    END IF;

    -- ── 4. the daily counter belongs to a day ───────────────────────────────
    -- This is what spent_on/lastSpendDate is for, and what the `spentOn`
    -- mistake in 217 would have broken: yesterday's spend must not count
    -- against today's cap.
    IF (SELECT spent_on FROM camp_canteen_accounts
         WHERE camp_id = c AND account_key = 'Ayala Weiss') IS NULL THEN
        RAISE EXCEPTION 'a purchase did not stamp the day it was spent on';
    END IF;
    UPDATE camp_canteen_accounts
       SET spent_on = current_date - 1, payload = payload || jsonb_build_object(
            'lastSpendDate', (current_date - 1)::text)
     WHERE camp_id = c AND account_key = 'Ayala Weiss';
    r := public.submit_canteen_purchase(c, 'Ayala Weiss', 8.00, 'New day');
    IF (r ->> 'success') IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'yesterday''s spending counted against today''s cap: %', r;
    END IF;

    -- ── 5. insufficient balance is still insufficient ───────────────────────
    -- 8.00 is under Dov's 10.00 daily cap and over his 5.00 balance, so it can
    -- only be refused for the balance.
    r := public.submit_canteen_purchase(c, 'Dov Lerner', 8.00, 'Spree');
    IF (r ->> 'error') IS DISTINCT FROM 'insufficient_balance' THEN
        RAISE EXCEPTION 'a purchase beyond the balance was allowed: %', r;
    END IF;

    -- ...and the two caps are still checked in the ORIGINAL order. 50.00
    -- breaches both; the original tests the daily cap first, and a camper told
    -- "insufficient balance" when the real problem is their daily limit is a
    -- camper sent to top up money they already have.
    r := public.submit_canteen_purchase(c, 'Dov Lerner', 50.00, 'Both caps');
    IF (r ->> 'error') IS DISTINCT FROM 'daily_limit_exceeded' THEN
        RAISE EXCEPTION 'the two spending caps swapped order in the conversion: %', r;
    END IF;

    -- ── 6. the duplicate guard, the most dangerous line in the file ─────────
    -- A payment webhook retried with the same reference must credit ONCE. The
    -- transformer's first output left this guard reading a NULL document,
    -- where it answered "no duplicate" every time — a retried webhook would
    -- have credited a camper twice, with no error anywhere.
    r := public.credit_canteen_balance_from_stripe(c, 'Dov Lerner', 25.00, 'pi_test_abc');
    IF (r ->> 'success') IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'a first credit failed: %', r;
    END IF;
    SELECT balance INTO bal FROM camp_canteen_accounts
     WHERE camp_id = c AND account_key = 'Dov Lerner';
    IF bal IS DISTINCT FROM 30.00 THEN
        RAISE EXCEPTION 'a 25.00 credit on 5.00 gave %, expected 30.00', bal;
    END IF;

    r := public.credit_canteen_balance_from_stripe(c, 'Dov Lerner', 25.00, 'pi_test_abc');
    IF (r ->> 'alreadyProcessed') IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'the duplicate guard did not recognise a retried webhook: %', r;
    END IF;
    SELECT balance INTO bal FROM camp_canteen_accounts
     WHERE camp_id = c AND account_key = 'Dov Lerner';
    IF bal IS DISTINCT FROM 30.00 THEN
        RAISE EXCEPTION 'a RETRIED webhook credited twice: balance is % — this is the bug '
                        'the first transformer output would have shipped', bal;
    END IF;

    -- ── 7. the guard is scoped to the camp ──────────────────────────────────
    -- Re-aiming it at a shared table introduced a way for one camp's reference
    -- to mask another's. The camp predicate is what stops that.
    IF (SELECT count(*) FROM canteen_transactions
         WHERE camp_id = c AND payload->>'stripePaymentIntentId' = 'pi_test_abc') <> 1 THEN
        RAISE EXCEPTION 'the credit was not recorded exactly once in the ledger';
    END IF;

    -- ── 7b. one camp's reference must not mask another's ────────────────────
    -- The guard used to scan a document that belonged to ONE camp, so camp
    -- scoping was implicit. Re-aimed at a shared table it has to be stated —
    -- and with a single camp in the fixture, a guard that lost its scope looks
    -- exactly like one that kept it. Two processors really can issue the same
    -- reference to two camps; more to the point, a guard that matches another
    -- camp's row silently refuses a legitimate top-up and the money is simply
    -- never credited.
    INSERT INTO camps (id, owner, name)
    VALUES ('66666666-6666-6666-6666-666666666666', me, 'Other Till');
    PERFORM public.canteen_account_save('66666666-6666-6666-6666-666666666666'::uuid,
        'Dov Lerner', jsonb_build_object('balance', 1.00, 'dailyLimit', 10, 'spentToday', 0));
    r := public.credit_canteen_balance_from_stripe(
            '66666666-6666-6666-6666-666666666666'::uuid, 'Dov Lerner', 7.00, 'pi_test_abc');
    IF (r ->> 'alreadyProcessed') = 'true' THEN
        RAISE EXCEPTION 'another camp''s reference masked this one — the duplicate guard '
                        'lost its camp scope, and a real top-up was silently refused';
    END IF;
    IF (SELECT balance FROM camp_canteen_accounts
         WHERE camp_id = '66666666-6666-6666-6666-666666666666' AND account_key = 'Dov Lerner')
       IS DISTINCT FROM 8.00 THEN
        RAISE EXCEPTION 'the second camp''s credit did not land';
    END IF;

    -- ── 8. limits are still settable, and still mean what they meant ────────
    PERFORM public.canteen_account_lock(c, 'Ayala Weiss');
    IF (SELECT daily_limit FROM camp_canteen_accounts
         WHERE camp_id = c AND account_key = 'Ayala Weiss') IS DISTINCT FROM 10 THEN
        RAISE EXCEPTION 'the daily limit was lost somewhere in the conversion';
    END IF;

    RAISE NOTICE '219: purchases debit one camper and reach the ledger with their id,';
    RAISE NOTICE '219: the daily cap and its per-day reset are unchanged, an over-spend';
    RAISE NOTICE '219: is refused without moving money, and a retried webhook credits once.';
END $$;

-- ── 9. nothing projects the document into the rows any more ─────────────────
-- With the writers on rows, a projection running the other way lets a stale
-- document save overwrite live balances — including the staff client's
-- compare-and-set of the whole document.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_trigger
                WHERE tgname IN ('trg_project_canteen_accounts', 'trg_canteen_archive')) THEN
        RAISE EXCEPTION 'a document → rows projection survived; a stale document save '
                        'can now overwrite live balances';
    END IF;
    RAISE NOTICE '219: the document no longer writes back into the rows.';
END $$;

-- ── 10. and no canteen writer holds the camp-wide lock ──────────────────────
DO $$
DECLARE v_left text[];
BEGIN
    SELECT COALESCE(array_agg(p.proname ORDER BY p.proname), '{}') INTO v_left
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind = 'f'
       AND pg_get_functiondef(p.oid) ~ 'campistrySnacks''[^;]*FOR UPDATE'
       AND p.proname <> 'record_canteen_sale_inventory';
    IF v_left <> '{}' THEN
        RAISE EXCEPTION 'these still serialize the whole camp: %', v_left;
    END IF;
    -- The exclusion above names record_canteen_sale_inventory, which keeps its
    -- document lock on purpose: it touches inventory, never an account, so its
    -- lock is not the one causing the ceiling. It is defined in migration 142,
    -- which this harness does not apply — so this asserts the EXCLUSION is
    -- narrow rather than asserting the function exists. A blanket exclusion
    -- would hide a real writer that happened to be renamed.
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prokind = 'f'
           AND pg_get_functiondef(p.oid) ~ 'campistrySnacks''[^;]*FOR UPDATE') > 1 THEN
        RAISE EXCEPTION 'more than one function still holds the camp-wide snacks lock';
    END IF;
    RAISE NOTICE '219: no account writer holds the camp-wide lock.';
END $$;
