-- Behaviour test for 217. The promises worth exercising are the ones about
-- MONEY: no balance changes on the way into a row, an account nobody can
-- attribute is kept rather than guessed or dropped, and an attributed balance
-- is never re-pointed at somebody else later.

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION public.camp_reader(p_camp_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$ SELECT true $$;

-- 219 DROPPED the projection trigger on purpose: the canteen writers moved to
-- rows and the document became a frozen copy. Against the full chain, then,
-- writing accounts into the document projects nothing, and this test failed on
-- its first check — not because 217 regressed, but because its trigger is gone.
--
-- Most of what it tests is still LIVE: _attribute_canteen_account runs inside
-- every canteen_account_lock (227), and backfill_canteen_accounts and
-- verify_canteen_accounts still ship. So the trigger is put back for the length
-- of this test — only when it is absent, and dropped again at the end — and the
-- rest runs against the current bodies.
CREATE TEMP TABLE _217_reattached AS
SELECT NOT EXISTS (SELECT 1 FROM pg_trigger
                    WHERE tgname = 'trg_project_canteen_accounts'
                      AND tgrelid = 'public.camp_state_kv'::regclass) AS did;
DO $$
BEGIN
    IF (SELECT did FROM _217_reattached) THEN
        CREATE TRIGGER trg_project_canteen_accounts
        AFTER INSERT OR UPDATE ON public.camp_state_kv
        FOR EACH ROW
        WHEN (NEW.key = 'campistrySnacks')
        EXECUTE FUNCTION public.project_canteen_accounts();
    END IF;
END $$;

DO $$
DECLARE
    c1 uuid := '33333333-3333-3333-3333-333333333333';
    v  jsonb;
    pid bigint;
    held numeric;
BEGIN
    INSERT INTO camps (id, owner, name) VALUES (c1, NULL, 'Canteen Camp');

    -- A roster, so there is something to attribute against.
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES (c1, 'app1', jsonb_build_object(
        'camperRoster', jsonb_build_object(
            'Chaim Katz',  jsonb_build_object('camperId', '1041', 'name', 'Chaim Katz'),
            'Rivka Stern', jsonb_build_object('camperId', '1042', 'name', 'Rivka Stern'))));

    -- Accounts: one exact match, one differing only by case and space, one for
    -- a camper who is not on the roster at all but is holding $18.25 — the
    -- shape of the 354 rows in the live project.
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES (c1, 'campistrySnacks', jsonb_build_object(
        'accounts', jsonb_build_object(
            'Chaim Katz',   jsonb_build_object('balance', 12.50, 'dailyLimit', 10, 'spentToday', 3,
                                               'lastSpendDate', '2026-09-22'),
            '  rivka stern ', jsonb_build_object('balance', 7.25,  'dailyLimit', 5),
            'Gone Lastyear', jsonb_build_object('balance', 18.25, 'dailyLimit', 10),
            'Zero Orphan',   jsonb_build_object('balance', 0,     'dailyLimit', 10))));

    -- ── 1. every account became a row, with the SAME balance ────────────────
    v := public.verify_canteen_accounts(c1);
    IF (v ->> 'everyAccountHasRow') <> 'true' THEN
        RAISE EXCEPTION 'an account has no row: %', v;
    END IF;
    IF (v ->> 'balancesMatch') <> 'true' THEN
        RAISE EXCEPTION 'a balance changed on the way into a row: %', v;
    END IF;
    IF (v ->> 'heldInRows')::numeric <> (v ->> 'heldInBlob')::numeric THEN
        RAISE EXCEPTION 'the rows hold a different total than the blob: %', v;
    END IF;
    IF (v ->> 'heldInRows')::numeric <> 38.00 THEN
        RAISE EXCEPTION 'expected 38.00 held, got %', v ->> 'heldInRows';
    END IF;

    -- ── 2. attribution, including the untidy name ───────────────────────────
    IF (SELECT person_id FROM camp_canteen_accounts
         WHERE camp_id = c1 AND account_key = 'Chaim Katz') <> 1041 THEN
        RAISE EXCEPTION 'an exact roster name was not attributed';
    END IF;
    -- The blob calls it lastSpendDate. The first version of this file read
    -- `spentOn`, which exists nowhere in the app, so this column was NULL on
    -- every row in the live project — and 219's daily-limit reset would have
    -- cleared every camper's counter on every sale.
    IF (SELECT spent_on FROM camp_canteen_accounts
         WHERE camp_id = c1 AND account_key = 'Chaim Katz') IS DISTINCT FROM DATE '2026-09-22' THEN
        RAISE EXCEPTION 'the daily-spend date did not survive the move into a row';
    END IF;
    IF (SELECT person_id FROM camp_canteen_accounts
         WHERE camp_id = c1 AND account_key = '  rivka stern ') <> 1042 THEN
        RAISE EXCEPTION 'case and surrounding space defeated attribution — "  rivka stern " is Rivka Stern';
    END IF;

    -- ── 3. what cannot be attributed is KEPT, not guessed and not dropped ───
    IF (SELECT count(*) FROM camp_canteen_accounts
         WHERE camp_id = c1 AND person_id IS NULL AND deleted_at IS NULL) <> 2 THEN
        RAISE EXCEPTION 'the unattributable accounts were not kept as rows';
    END IF;
    IF (SELECT balance FROM camp_canteen_accounts
         WHERE camp_id = c1 AND account_key = 'Gone Lastyear') <> 18.25 THEN
        RAISE EXCEPTION 'an unattributable balance was lost — that is a child''s money';
    END IF;
    IF (v -> 'unattributed' ->> 'withMoney') <> '1' THEN
        RAISE EXCEPTION 'the verifier did not single out the unattributed account holding money: %', v;
    END IF;
    IF (v -> 'unattributed' ->> 'owedToCampers')::numeric <> 18.25 THEN
        RAISE EXCEPTION 'the amount needing a human decision is wrong: %', v;
    END IF;

    -- ── 4. a sale updates one row, and only that row ────────────────────────
    UPDATE camp_state_kv SET value = jsonb_set(value,
        '{accounts,Chaim Katz}', jsonb_build_object('balance', 11.00, 'dailyLimit', 10, 'spentToday', 4.50))
     WHERE camp_id = c1 AND key = 'campistrySnacks';
    IF (SELECT balance FROM camp_canteen_accounts
         WHERE camp_id = c1 AND account_key = 'Chaim Katz') <> 11.00 THEN
        RAISE EXCEPTION 'a sale did not reach the row';
    END IF;
    IF (SELECT spent_today FROM camp_canteen_accounts
         WHERE camp_id = c1 AND account_key = 'Chaim Katz') <> 4.50 THEN
        RAISE EXCEPTION 'spent_today did not follow';
    END IF;
    IF (SELECT balance FROM camp_canteen_accounts
         WHERE camp_id = c1 AND account_key = '  rivka stern ') <> 7.25 THEN
        RAISE EXCEPTION 'one camper''s sale moved another camper''s balance';
    END IF;

    -- ── 5. a hand renumber carries the account with the person ──────────────
    -- The roster keeps "Chaim Katz" and only the ID field changes, 1041 → 9999:
    -- the office editing a camper's number by hand. At 217 this section asserted
    -- the account STAYED on 1041, because a name freed for somebody else was
    -- the danger and the two could not be told apart. 237 settled it: the same
    -- live roster entry with a new id is the SAME child renumbered, and
    -- _move_person_references carries every reference with them — otherwise the
    -- account points at a person who no longer exists. A DIFFERENT child taking
    -- a departed child's name mints a new id instead; that is 237's own test.
    SELECT person_id INTO pid FROM camp_canteen_accounts
     WHERE camp_id = c1 AND account_key = 'Chaim Katz';
    IF pid IS DISTINCT FROM 1041 THEN
        RAISE EXCEPTION 'setup: Chaim Katz should be attributed to 1041 before the renumber, got %', pid;
    END IF;
    UPDATE camp_state_kv SET value = jsonb_build_object('camperRoster', jsonb_build_object(
            'Chaim Katz',  jsonb_build_object('camperId', '9999', 'name', 'Chaim Katz'),
            'Rivka Stern', jsonb_build_object('camperId', '1042', 'name', 'Rivka Stern')))
     WHERE camp_id = c1 AND key = 'app1';
    UPDATE camp_state_kv SET value = jsonb_set(value,
        '{accounts,Chaim Katz}', jsonb_build_object('balance', 10.00, 'dailyLimit', 10,
                                                    'lastSpendDate', '2026-09-22'))
     WHERE camp_id = c1 AND key = 'campistrySnacks';
    SELECT person_id INTO pid FROM camp_canteen_accounts
     WHERE camp_id = c1 AND account_key = 'Chaim Katz';
    IF pid IS DISTINCT FROM 9999 THEN
        RAISE EXCEPTION 'the renumbered camper''s account did not follow them (still on %)', pid;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM camp_people
                    WHERE camp_id = c1 AND person_id = pid AND deleted_at IS NULL) THEN
        RAISE EXCEPTION 'the account points at person %, who does not exist — a dangling reference', pid;
    END IF;
    IF (SELECT balance FROM camp_canteen_accounts
         WHERE camp_id = c1 AND account_key = 'Chaim Katz') <> 10.00 THEN
        RAISE EXCEPTION 'the renumber moved the account but not its balance';
    END IF;

    -- ── 6. an account leaving the document is stamped, not destroyed ────────
    UPDATE camp_state_kv SET value = jsonb_build_object('accounts', jsonb_build_object(
            'Chaim Katz', jsonb_build_object('balance', 10.00, 'dailyLimit', 10,
                                              'lastSpendDate', '2026-09-22')))
     WHERE camp_id = c1 AND key = 'campistrySnacks';
    IF (SELECT deleted_at FROM camp_canteen_accounts
         WHERE camp_id = c1 AND account_key = 'Gone Lastyear') IS NULL THEN
        RAISE EXCEPTION 'an account that left the document was not stamped';
    END IF;
    IF (SELECT balance FROM camp_canteen_accounts
         WHERE camp_id = c1 AND account_key = 'Gone Lastyear') <> 18.25 THEN
        RAISE EXCEPTION 'a stamped account lost its balance — absence is recorded, not obeyed';
    END IF;

    -- ── 7. re-attribution repairs, and the backfill is the tool ─────────────
    -- The expected remedy for the 354: put the camper back on the roster, then
    -- re-run the backfill. It must attribute the NULL and leave the rest alone.
    UPDATE camp_state_kv SET value = jsonb_build_object('camperRoster', jsonb_build_object(
            'Chaim Katz',    jsonb_build_object('camperId', '9999', 'name', 'Chaim Katz'),
            'Rivka Stern',   jsonb_build_object('camperId', '1042', 'name', 'Rivka Stern'),
            'Gone Lastyear', jsonb_build_object('camperId', '1050', 'name', 'Gone Lastyear')))
     WHERE camp_id = c1 AND key = 'app1';

    -- Every penny in the camp, before the repair tool runs over it.
    SELECT COALESCE(sum(balance), 0) INTO held FROM camp_canteen_accounts WHERE camp_id = c1;

    -- Damage a row the way a half-applied migration would, so the backfill has
    -- something to REPAIR. Asserting a correct value stayed correct cannot tell
    -- a field that is carried from one that is merely never touched: dropping
    -- spent_on from the ON CONFLICT list passed until this line existed.
    UPDATE camp_canteen_accounts SET spent_on = NULL, balance = 999.99
     WHERE camp_id = c1 AND account_key = 'Chaim Katz';

    PERFORM public.backfill_canteen_accounts();

    IF (SELECT person_id FROM camp_canteen_accounts
         WHERE camp_id = c1 AND account_key = 'Gone Lastyear') <> 1050 THEN
        RAISE EXCEPTION 'fixing the roster and re-running the backfill did not attribute the account';
    END IF;
    IF (SELECT person_id FROM camp_canteen_accounts
         WHERE camp_id = c1 AND account_key = 'Chaim Katz') <> pid THEN
        RAISE EXCEPTION 'the backfill re-pointed an already-attributed account';
    END IF;
    -- The repair tool runs over EVERY account with ON CONFLICT DO UPDATE. A
    -- mutation that zeroed the balance in its INSERT passed every check above,
    -- because they all asked about person_id. The tool this file tells people
    -- to run against a live camp must not be able to empty it.
    -- The total is back to what it was, which now requires the backfill to have
    -- REPAIRED the 999.99 above from the document — not merely to have left the
    -- balances alone. Dropping `balance = EXCLUDED.balance` from the ON CONFLICT
    -- list passed this check until the corruption was added.
    IF (SELECT COALESCE(sum(balance), 0) FROM camp_canteen_accounts WHERE camp_id = c1) <> held THEN
        RAISE EXCEPTION 'the backfill did not restore the money from the document (% → %)',
            held, (SELECT COALESCE(sum(balance), 0) FROM camp_canteen_accounts WHERE camp_id = c1);
    END IF;
    IF (SELECT balance FROM camp_canteen_accounts
         WHERE camp_id = c1 AND account_key = 'Gone Lastyear') <> 18.25 THEN
        RAISE EXCEPTION 'the backfill lost the balance it had just attributed';
    END IF;
    -- The backfill's ON CONFLICT list is a second, separate copy of the field
    -- mapping, and a field missing from it is a field the repair tool quietly
    -- clears. Reverting just the backfill to the wrong `spentOn` name passed
    -- every other check in this file.
    IF (SELECT spent_on FROM camp_canteen_accounts
         WHERE camp_id = c1 AND account_key = 'Chaim Katz') IS DISTINCT FROM DATE '2026-09-22' THEN
        RAISE EXCEPTION 'the backfill cleared the daily-spend date';
    END IF;

    -- ── 8. the verifier actually compares balances ──────────────────────────
    -- Nothing above ever produces a mismatch, so a verifier that looked for
    -- none would pass every check in this file. Break one deliberately.
    UPDATE camp_canteen_accounts SET balance = balance + 1
     WHERE camp_id = c1 AND account_key = 'Chaim Katz';
    v := public.verify_canteen_accounts(c1);
    IF (v ->> 'balancesMatch') <> 'false' THEN
        RAISE EXCEPTION 'the verifier did not notice a row disagreeing with the blob: %', v;
    END IF;
    IF (v -> 'balanceMismatches' -> 0 ->> 'account') <> 'Chaim Katz' THEN
        RAISE EXCEPTION 'the verifier did not name the account that disagrees: %', v;
    END IF;
    UPDATE camp_canteen_accounts SET balance = balance - 1
     WHERE camp_id = c1 AND account_key = 'Chaim Katz';

    -- ── 9. a live camper is preferred over a departed one ───────────────────
    -- Rank 2 and rank 3 in _attribute_canteen_account differ only by
    -- deleted_at, so the ordering between them is invisible unless BOTH exist.
    -- Deleting the rank-2 branch broke no test until this one.
    UPDATE camp_state_kv SET value = jsonb_build_object('camperRoster', jsonb_build_object(
            'Chaim Katz',  jsonb_build_object('camperId', '9999', 'name', 'Chaim Katz'),
            'Rivka Stern', jsonb_build_object('camperId', '1042', 'name', 'Rivka Stern'),
            'Dup Name',    jsonb_build_object('camperId', '2001', 'name', 'Dup Name')))
     WHERE camp_id = c1 AND key = 'app1';
    -- now that camper leaves, and a new one arrives under the same name in a
    -- different case: the departed row stays (ids stay spoken for), so both match.
    UPDATE camp_state_kv SET value = jsonb_build_object('camperRoster', jsonb_build_object(
            'Chaim Katz',  jsonb_build_object('camperId', '9999', 'name', 'Chaim Katz'),
            'Rivka Stern', jsonb_build_object('camperId', '1042', 'name', 'Rivka Stern'),
            'dup name',    jsonb_build_object('camperId', '2002', 'name', 'dup name')))
     WHERE camp_id = c1 AND key = 'app1';
    IF (SELECT count(*) FROM camp_people
         WHERE camp_id = c1 AND lower(btrim(source_key)) = 'dup name') < 2 THEN
        RAISE EXCEPTION 'test setup: expected a departed and a live camper sharing a normalised name';
    END IF;
    IF public._attribute_canteen_account(c1, 'Dup Name') <> 2002 THEN
        RAISE EXCEPTION 'attribution chose a departed camper over the live one (got %)',
            public._attribute_canteen_account(c1, 'Dup Name');
    END IF;

    RAISE NOTICE '217: balances survive the move to the cent, untidy names attribute,';
    RAISE NOTICE '217: unattributable money is kept and reported, one sale touches one row,';
    RAISE NOTICE '217: attributed money is never re-pointed, and the backfill repairs.';
END $$;

-- ── 8. the trigger diffs ────────────────────────────────────────────────────
-- Outside the block: now() is the transaction clock, so an in-transaction
-- re-save cannot tell a diffing trigger from one that rewrites everything.
-- This matters more here than anywhere else — the snacks document is rewritten
-- on EVERY sale, and re-deriving every account per sale is precisely the decay
-- that took the canteen from 84 to 26 sales a second before 206.
CREATE TEMP TABLE _c AS
SELECT max(updated_at) AS before FROM camp_canteen_accounts
 WHERE camp_id = '33333333-3333-3333-3333-333333333333';

UPDATE camp_state_kv SET value = value
 WHERE camp_id = '33333333-3333-3333-3333-333333333333' AND key = 'campistrySnacks';

DO $$
DECLARE b timestamptz; a timestamptz;
BEGIN
    SELECT before INTO b FROM _c;
    SELECT max(updated_at) INTO a FROM camp_canteen_accounts
     WHERE camp_id = '33333333-3333-3333-3333-333333333333';
    IF a IS DISTINCT FROM b THEN
        RAISE EXCEPTION 'an unchanged snacks save rewrote its rows (% → %) — the trigger is not diffing', b, a;
    END IF;
    RAISE NOTICE '217: an unchanged save touches no rows.';
END $$;

-- Leave the chain as 219 left it.
DO $$
BEGIN
    IF (SELECT did FROM _217_reattached) THEN
        DROP TRIGGER trg_project_canteen_accounts ON public.camp_state_kv;
    END IF;
END $$;
