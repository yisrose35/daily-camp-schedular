-- Behaviour test for migration 275 (TED-110): a canteen refund takes its money
-- off the wallet, under the wallet's lock, before the card company is asked.
--
--   1. Reserve takes the money off; a second refund for the same money (another
--      key) is refused; the same key again takes nothing more.
--   2. A "yes" puts one refund line on the ledger and moves the balance no more.
--   3. A "no" puts the money back; "nothing went through" only for an old hold.
--   4. A refund that turns out to have gone through after all takes it off then.
--   5. The refund screens see open holds; a browser can call none of it.
--   6. A REAL race on two connections: the second refund waits for the first's
--      lock and then sees the lower balance.
\set ON_ERROR_STOP on

INSERT INTO auth.users (id, email) VALUES ('f2750000-0000-0000-0000-0000000000a1', 'o@275.test');
INSERT INTO public.camps (id, owner, name) VALUES ('f2750000-0000-0000-0000-000000000001', 'f2750000-0000-0000-0000-0000000000a1', 'Hold Camp');

DO $$
DECLARE
    c   uuid := 'f2750000-0000-0000-0000-000000000001';
    r   jsonb;
    bal numeric;
    n   int;
BEGIN
    PERFORM public.canteen_account_save(c, 'Avi', jsonb_build_object('balance', 20.00, 'balanceFloor', 0));

    -- 1. reserve
    r := public.reserve_canteen_refund(c, 'Avi', 'canteen:cref_1:X1', 20, 'cardknox', 'X1');
    IF (r->>'success')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'a $20 refund of a $20 wallet was refused: %', r; END IF;
    SELECT balance INTO bal FROM camp_canteen_accounts WHERE camp_id = c AND account_key = 'Avi';
    IF bal <> 0 THEN RAISE EXCEPTION 'TED-110: the reserved refund did not come off the wallet (balance %)', bal; END IF;
    r := public.reserve_canteen_refund(c, 'Avi', 'canteen:X1:5000:2000', 20, 'cardknox', 'X1');
    IF (r->>'success')::boolean OR r->>'error' <> 'insufficient' THEN
        RAISE EXCEPTION 'TED-110: Refund All took the same $20 a single refund already had: %', r;
    END IF;
    r := public.reserve_canteen_refund(c, 'Avi', 'canteen:cref_1:X1', 20, 'cardknox', 'X1');
    IF NOT (r->>'existing')::boolean OR r->>'state' <> 'open' THEN RAISE EXCEPTION 'the same refund again: %', r; END IF;
    SELECT balance INTO bal FROM camp_canteen_accounts WHERE camp_id = c AND account_key = 'Avi';
    IF bal <> 0 THEN RAISE EXCEPTION 'the second press took the money twice (balance %)', bal; END IF;
    r := public.reserve_canteen_refund(c, 'Avi', 'k0', 0, 'cardknox', 'X1');
    IF r->>'error' <> 'invalid_amount' THEN RAISE EXCEPTION 'a $0 refund was reserved: %', r; END IF;

    -- 2. yes: one ledger line, no second debit; a repeat changes nothing
    r := public.settle_canteen_refund_hold(c, 'canteen:cref_1:X1', 'R1');
    IF (r->>'success')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'settle: %', r; END IF;
    r := public.settle_canteen_refund_hold(c, 'canteen:cref_1:X1', 'R1');
    IF NOT (r->>'alreadyProcessed')::boolean THEN RAISE EXCEPTION 'a repeated settle: %', r; END IF;
    SELECT balance INTO bal FROM camp_canteen_accounts WHERE camp_id = c AND account_key = 'Avi';
    SELECT count(*) INTO n FROM canteen_transactions WHERE camp_id = c AND payload->>'byopRefundId' = 'R1'
       AND payload->>'kind' = 'refund' AND payload->>'byopTransactionId' = 'X1' AND amount = 20;
    IF bal <> 0 OR n <> 1 THEN RAISE EXCEPTION 'after the yes: balance % (want 0), ledger lines % (want 1)', bal, n; END IF;
    r := public.release_canteen_refund_hold(c, 'canteen:cref_1:X1');
    IF (r->>'released')::boolean THEN RAISE EXCEPTION 'a refund that went through was given back: %', r; END IF;

    -- 3. no: the money goes back; "nothing went through" waits for an old hold
    PERFORM public.canteen_account_save(c, 'Avi', jsonb_build_object('balance', 30.00, 'balanceFloor', 0));
    PERFORM public.reserve_canteen_refund(c, 'Avi', 'k2', 10, 'stripe', 'pi_2', 'stripe_key_2');
    r := public.release_canteen_refund_hold(c, 'k2', interval '3 minutes');
    IF (r->>'released')::boolean OR r->>'error' <> 'too_new' THEN
        RAISE EXCEPTION 'a refund seconds old was given back on "nothing went through": %', r;
    END IF;
    r := public.release_canteen_refund_hold(c, 'k2');
    SELECT balance INTO bal FROM camp_canteen_accounts WHERE camp_id = c AND account_key = 'Avi';
    IF NOT (r->>'released')::boolean OR bal <> 30 THEN RAISE EXCEPTION 'a declined refund: % balance %', r, bal; END IF;
    r := public.release_canteen_refund_hold(c, 'k2');
    SELECT balance INTO bal FROM camp_canteen_accounts WHERE camp_id = c AND account_key = 'Avi';
    IF (r->>'released')::boolean OR bal <> 30 THEN RAISE EXCEPTION 'a second release gave the money back twice: % %', r, bal; END IF;
    -- sent again after the no: reserved afresh
    r := public.reserve_canteen_refund(c, 'Avi', 'k2', 10, 'stripe', 'pi_2', 'stripe_key_2');
    SELECT balance INTO bal FROM camp_canteen_accounts WHERE camp_id = c AND account_key = 'Avi';
    IF (r->>'success')::boolean IS NOT TRUE OR bal <> 20 THEN RAISE EXCEPTION 'reserve after a no: % %', r, bal; END IF;
    UPDATE canteen_refund_holds SET created_at = now() - interval '4 minutes' WHERE camp_id = c AND hold_key = 'k2';
    r := public.release_canteen_refund_hold(c, 'k2', interval '3 minutes');
    IF NOT (r->>'released')::boolean THEN RAISE EXCEPTION 'an old unconfirmed hold could not be given back: %', r; END IF;

    -- 4. it had gone through after all: taken off now, once
    r := public.settle_canteen_refund_hold(c, 'k2', 're_late');
    SELECT balance INTO bal FROM camp_canteen_accounts WHERE camp_id = c AND account_key = 'Avi';
    SELECT count(*) INTO n FROM canteen_transactions WHERE camp_id = c AND payload->>'stripeRefundId' = 're_late';
    IF bal <> 20 OR n <> 1 THEN RAISE EXCEPTION 'a refund confirmed after it was given back: balance % (want 20), lines %', bal, n; END IF;

    -- the floor is respected
    PERFORM public.canteen_account_save(c, 'Avi', jsonb_build_object('balance', 20.00, 'balanceFloor', 5));
    r := public.reserve_canteen_refund(c, 'Avi', 'k3', 20, 'cardknox', 'X1');
    IF r->>'error' <> 'insufficient' OR (r->>'available')::numeric <> 15 THEN RAISE EXCEPTION 'the floor: %', r; END IF;

    -- 5. the refund screens see what is on its way
    PERFORM public.reserve_canteen_refund(c, 'Avi', 'k4', 15, 'cardknox', 'X9');
    r := public.canteen_refund_view(c);
    IF jsonb_array_length(r->'holds') <> 1 OR r->'holds'->0->>'key' <> 'k4' OR (r->'holds'->0->>'amount')::numeric <> 15
       OR r->'holds'->0->>'paymentRef' <> 'X9' THEN
        RAISE EXCEPTION 'canteen_refund_view holds: %', r->'holds';
    END IF;
    IF has_function_privilege('authenticated', 'public.reserve_canteen_refund(uuid,text,text,numeric,text,text,text,bigint)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.settle_canteen_refund_hold(uuid,text,text)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.release_canteen_refund_hold(uuid,text,interval)', 'EXECUTE')
       OR has_table_privilege('authenticated', 'public.canteen_refund_holds', 'SELECT') THEN
        RAISE EXCEPTION 'a browser can reach the refund holds';
    END IF;
    RAISE NOTICE 'ok  275: reserve / refuse / same key / yes / no / too new / late yes / floor / view / grants';
END $$;

-- 6. the race, on two real connections
CREATE EXTENSION IF NOT EXISTS dblink;
SELECT public.canteen_account_save('f2750000-0000-0000-0000-000000000001', 'Bea',
       jsonb_build_object('balance', 20.00, 'balanceFloor', 0));
SELECT dblink_connect('other', format('dbname=%s host=%s port=%s user=postgres',
       current_database(), split_part(current_setting('unix_socket_directories'), ',', 1), current_setting('port')));
BEGIN;
-- this connection: Refund All reaches Bea and reserves her $20, still running
SELECT public.reserve_canteen_refund('f2750000-0000-0000-0000-000000000001', 'Bea', 'all:Y1', 20, 'cardknox', 'Y1');
-- the other: a single refund of Bea's $20, sent at the same moment
SELECT dblink_send_query('other', $q$SELECT public.reserve_canteen_refund('f2750000-0000-0000-0000-000000000001', 'Bea', 'one:Y1', 20, 'cardknox', 'Y1')::text$q$);
SELECT pg_sleep(0.5);
DO $$
BEGIN
    IF dblink_is_busy('other') <> 1 THEN
        RAISE EXCEPTION 'TED-110: the second refund did not wait for the first one''s lock';
    END IF;
END $$;
COMMIT;
DO $$
DECLARE r jsonb; bal numeric;
BEGIN
    SELECT x::jsonb INTO r FROM dblink_get_result('other') AS t(x text);
    IF (r->>'success')::boolean OR r->>'error' <> 'insufficient' THEN
        RAISE EXCEPTION 'TED-110: two refunds at once both took Bea''s $20: %', r;
    END IF;
    SELECT balance INTO bal FROM camp_canteen_accounts
     WHERE camp_id = 'f2750000-0000-0000-0000-000000000001' AND account_key = 'Bea';
    IF bal <> 0 THEN RAISE EXCEPTION 'Bea''s wallet after the race: % (want 0)', bal; END IF;
    RAISE NOTICE 'ok  275: two refunds at once on two connections — one waited, then was refused';
END $$;
SELECT dblink_disconnect('other');

\set verify_q `cat scripts/verify_identity_chain.sql`
BEGIN;
CREATE TEMP TABLE v275 AS :verify_q
DO $$
DECLARE r text;
BEGIN
    SELECT result INTO r FROM v275 WHERE item LIKE '275%';
    IF r IS DISTINCT FROM 'ok' THEN RAISE EXCEPTION 'the checking script''s 275 row says: %', r; END IF;
END $$;
ROLLBACK;
