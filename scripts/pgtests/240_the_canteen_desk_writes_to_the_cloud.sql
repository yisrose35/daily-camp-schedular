-- ════════════════════════════════════════════════════════════════════════════
-- Behaviour test for 240.
--
-- The question: does money taken at the canteen desk reach the ROWS — the only
-- place it now counts from — and does the cash-out rule that used to live only in
-- the browser actually refuse?
--
-- Before 240 the desk's three writers wrote the campistrySnacks document and
-- nothing else, and cloudSaveSnacks strips accounts and transactions out of it
-- (219 made the rows the truth). The office took $40 in cash and the database
-- never heard about it.
--
-- uuids are prefixed a4000000-.
-- ════════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

-- The stubs' auth.uid() is a constant NULL, which is enough to APPLY a migration
-- and useless for testing a gate. Supabase's real definition; the inner NULLIF
-- matters because a RESET GUC reads back as the empty string and ''::json raises.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
    SELECT NULLIF(NULLIF(current_setting('request.jwt.claims', true), '')::json ->> 'sub', '')::uuid
$fn$;

BEGIN;

INSERT INTO auth.users (id, email) VALUES
    ('a4000000-0000-0000-0000-0000000000aa', 'owner@240.test'),
    ('a4000000-0000-0000-0000-0000000000bb', 'stranger@240.test'),
    ('a4000000-0000-0000-0000-0000000000cc', 'counselor@240.test');

INSERT INTO camps (id, name, owner)
VALUES ('a4000000-0000-0000-0000-000000000001', '240 camp',
        'a4000000-0000-0000-0000-0000000000aa');

INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES
    ('a4000000-0000-0000-0000-000000000001', 5001, 'camper', 'Rivky Stein', 'Rivky Stein'),
    ('a4000000-0000-0000-0000-000000000001', 5002, 'camper', 'Yossi Pearl',  'Yossi Pearl');

-- The camp's cash-out configuration, which lives in the document's `settings`
-- (219 stripped only accounts and transactions, so this is still the real home).
INSERT INTO camp_state_kv (camp_id, key, value) VALUES
 ('a4000000-0000-0000-0000-000000000001', 'campistrySnacks',
  jsonb_build_object('settings', jsonb_build_object(
      'cashDailyMax', 20, 'cashReasonRequired', true, 'cashAllowNegative', false)));

SET "request.jwt.claims" = '{"sub":"a4000000-0000-0000-0000-0000000000aa"}';


-- ─── 1. a deposit taken at the desk reaches the rows ────────────────────────
DO $$
DECLARE v jsonb; v_bal numeric; v_id text; v_kind text; v_method text;
BEGIN
    v := public.canteen_office_credit('a4000000-0000-0000-0000-000000000001'::uuid,
            'Rivky Stein', 40, 'cash', 'Week 3', '2026-07-08');
    IF NOT COALESCE((v->>'success')::boolean, false) THEN
        RAISE EXCEPTION 'the desk could not take a deposit: %', v;
    END IF;
    IF (v->>'balance')::numeric <> 40 THEN
        RAISE EXCEPTION 'expected a $40 balance back, got %', v->>'balance';
    END IF;

    -- THE POINT OF THE WHOLE FILE: the row, not the document.
    SELECT balance INTO v_bal FROM camp_canteen_accounts
     WHERE camp_id = 'a4000000-0000-0000-0000-000000000001' AND account_key = 'Rivky Stein';
    IF v_bal IS DISTINCT FROM 40 THEN
        RAISE EXCEPTION 'the account row says %, not 40 — the deposit did not reach the rows',
                        COALESCE(v_bal::text, 'no row at all');
    END IF;

    -- And the LEDGER, because _reconcileBalances rebuilds every balance from it: a
    -- balance with no row behind it is erased by the next hydration, which is the
    -- defect restated rather than fixed.
    SELECT camper_id, payload ->> 'kind', payload ->> 'method'
      INTO v_id, v_kind, v_method
      FROM canteen_transactions
     WHERE camp_id = 'a4000000-0000-0000-0000-000000000001'
       AND camper = 'Rivky Stein' AND tx_type = 'credit';
    IF v_kind IS DISTINCT FROM 'deposit' THEN
        RAISE EXCEPTION 'no deposit row in the ledger (kind=%)', COALESCE(v_kind, 'none');
    END IF;
    IF v_id IS DISTINCT FROM '5001' THEN
        RAISE EXCEPTION 'the ledger row is on person %, not 5001', COALESCE(v_id, 'nobody');
    END IF;
    IF v_method IS DISTINCT FROM 'cash' THEN
        RAISE EXCEPTION 'the payment method was not recorded: %', COALESCE(v_method, 'none');
    END IF;
END $$;


-- ─── 2. a deposit of nothing is not a deposit ───────────────────────────────
DO $$
DECLARE v jsonb;
BEGIN
    FOR v IN SELECT public.canteen_office_credit(
                 'a4000000-0000-0000-0000-000000000001'::uuid, 'Rivky Stein', a)
               FROM unnest(ARRAY[0, -5]::numeric[]) a
    LOOP
        IF v->>'error' IS DISTINCT FROM 'invalid_amount' THEN
            RAISE EXCEPTION 'a non-positive deposit was not refused: %', v;
        END IF;
    END LOOP;

    -- A name nobody has is not an error worth inventing an account for.
    v := public.canteen_office_credit('a4000000-0000-0000-0000-000000000001'::uuid,
             NULL, 10);
    IF v->>'error' IS DISTINCT FROM 'missing_camper' THEN
        RAISE EXCEPTION 'a deposit with no camper was not refused: %', v;
    END IF;
END $$;


-- ─── 3. the cash-out rule refuses, in the database ──────────────────────────
-- campistry_snacks_cash.js's rule, one refusal at a time. Each of these used to be
-- enforced only in the browser, which is to say not enforced.
DO $$
DECLARE v jsonb;
BEGIN
    -- cashReasonRequired
    v := public.canteen_office_cash_out('a4000000-0000-0000-0000-000000000001'::uuid,
             'Rivky Stein', 5, NULL, 'Front desk', '2026-07-08');
    IF v->>'error' IS DISTINCT FROM 'reason_required' THEN
        RAISE EXCEPTION 'cash out with no reason was allowed: %', v;
    END IF;

    -- more than the balance
    v := public.canteen_office_cash_out('a4000000-0000-0000-0000-000000000001'::uuid,
             'Rivky Stein', 45, 'too much', 'Front desk', '2026-07-08');
    IF v->>'error' IS DISTINCT FROM 'over_available' THEN
        RAISE EXCEPTION 'cash out beyond the balance was allowed: %', v;
    END IF;

    -- a camper with no account at all has nothing to draw
    v := public.canteen_office_cash_out('a4000000-0000-0000-0000-000000000001'::uuid,
             'Yossi Pearl', 5, 'nothing there', 'Front desk', '2026-07-08');
    IF v->>'error' IS DISTINCT FROM 'no_available_balance' THEN
        RAISE EXCEPTION 'cash out from an empty account was allowed: %', v;
    END IF;
END $$;


-- ─── 4. and it pays out when it should, once per day up to the cap ──────────
DO $$
DECLARE v jsonb; v_bal numeric; v_kind text;
BEGIN
    v := public.canteen_office_cash_out('a4000000-0000-0000-0000-000000000001'::uuid,
             'Rivky Stein', 15, 'trip money', 'Front desk', '2026-07-08');
    IF NOT COALESCE((v->>'success')::boolean, false) THEN
        RAISE EXCEPTION 'a legitimate cash out was refused: %', v;
    END IF;
    IF (v->>'balance')::numeric <> 25 THEN
        RAISE EXCEPTION 'expected 25.00 left, got %', v->>'balance';
    END IF;

    SELECT balance INTO v_bal FROM camp_canteen_accounts
     WHERE camp_id = 'a4000000-0000-0000-0000-000000000001' AND account_key = 'Rivky Stein';
    IF v_bal <> 25 THEN RAISE EXCEPTION 'the account row says %, not 25', v_bal; END IF;

    SELECT payload ->> 'kind' INTO v_kind FROM canteen_transactions
     WHERE camp_id = 'a4000000-0000-0000-0000-000000000001'
       AND camper = 'Rivky Stein' AND tx_type = 'debit';
    IF v_kind IS DISTINCT FROM 'cash_out' THEN
        RAISE EXCEPTION 'the cash out is not marked cash_out (kind=%) — revenue reporting '
                        'and the drawer cannot tell it from a sale',
                        COALESCE(v_kind, 'none');
    END IF;

    -- $15 of a $20 daily cap is gone, so $6 is over it even though $25 is on the
    -- account. THIS is the check that was only ever in the browser.
    v := public.canteen_office_cash_out('a4000000-0000-0000-0000-000000000001'::uuid,
             'Rivky Stein', 6, 'again', 'Front desk', '2026-07-08');
    IF v->>'error' IS DISTINCT FROM 'over_available' THEN
        RAISE EXCEPTION 'the daily cash cap did not bind: %', v;
    END IF;
    IF (v->>'max')::numeric <> 5 THEN
        RAISE EXCEPTION 'expected $5 of the daily cap left, the function says %', v->>'max';
    END IF;

    -- $5 exactly is fine, and then the cap is spent.
    v := public.canteen_office_cash_out('a4000000-0000-0000-0000-000000000001'::uuid,
             'Rivky Stein', 5, 'the rest', 'Front desk', '2026-07-08');
    IF NOT COALESCE((v->>'success')::boolean, false) THEN
        RAISE EXCEPTION 'the last $5 under the cap was refused: %', v;
    END IF;
    v := public.canteen_office_cash_out('a4000000-0000-0000-0000-000000000001'::uuid,
             'Rivky Stein', 1, 'one more', 'Front desk', '2026-07-08');
    IF v->>'error' IS DISTINCT FROM 'daily_cash_limit_reached' THEN
        RAISE EXCEPTION 'the exhausted cap did not say so: %', v;
    END IF;

    -- TOMORROW is a different day, and the cap resets. Counted off the ledger's
    -- tx_date, so this is the same arithmetic SnacksCash.takenOn does.
    v := public.canteen_office_cash_out('a4000000-0000-0000-0000-000000000001'::uuid,
             'Rivky Stein', 5, 'next day', 'Front desk', '2026-07-09');
    IF NOT COALESCE((v->>'success')::boolean, false) THEN
        RAISE EXCEPTION 'the cap did not reset the next day: %', v;
    END IF;
    IF (v->>'balance')::numeric <> 15 THEN
        RAISE EXCEPTION 'expected 15.00 after 40 - 15 - 5 - 5, got %', v->>'balance';
    END IF;
END $$;


-- ─── 5. a balance floor is a reserve, not a suggestion ──────────────────────
DO $$
DECLARE v jsonb;
BEGIN
    PERFORM public.canteen_account_save('a4000000-0000-0000-0000-000000000001'::uuid,
        'Yossi Pearl', '{"balance":30,"balanceFloor":25,"dailyLimit":0,"spentToday":0}'::jsonb);

    v := public.canteen_office_cash_out('a4000000-0000-0000-0000-000000000001'::uuid,
             'Yossi Pearl', 10, 'past the floor', 'Front desk', '2026-07-08');
    IF v->>'error' IS DISTINCT FROM 'over_available' THEN
        RAISE EXCEPTION 'the balance floor was ignored: %', v;
    END IF;
    IF (v->>'max')::numeric <> 5 THEN
        RAISE EXCEPTION 'expected $5 above the floor, the function says %', v->>'max';
    END IF;

    v := public.canteen_office_cash_out('a4000000-0000-0000-0000-000000000001'::uuid,
             'Yossi Pearl', 5, 'down to the floor', 'Front desk', '2026-07-08');
    IF NOT COALESCE((v->>'success')::boolean, false) THEN
        RAISE EXCEPTION 'drawing down to the floor exactly was refused: %', v;
    END IF;
END $$;


-- ─── 6. cashAllowNegative is the camp's own override ────────────────────────
DO $$
DECLARE v jsonb;
BEGIN
    UPDATE camp_state_kv
       SET value = jsonb_set(value, ARRAY['settings', 'cashAllowNegative'], 'true'::jsonb)
     WHERE camp_id = 'a4000000-0000-0000-0000-000000000001' AND key = 'campistrySnacks';

    -- Yossi is at the floor with nothing above it, and the daily cap still binds,
    -- so this proves the override reaches the BALANCE test and not the cap.
    v := public.canteen_office_cash_out('a4000000-0000-0000-0000-000000000001'::uuid,
             'Yossi Pearl', 10, 'camp says it is fine', 'Front desk', '2026-07-10');
    IF NOT COALESCE((v->>'success')::boolean, false) THEN
        RAISE EXCEPTION 'cashAllowNegative did not lift the balance check: %', v;
    END IF;
    IF (v->>'balance')::numeric <> 15 THEN
        RAISE EXCEPTION 'expected 25 - 10 = 15, got %', v->>'balance';
    END IF;

    UPDATE camp_state_kv
       SET value = jsonb_set(value, ARRAY['settings', 'cashAllowNegative'], 'false'::jsonb)
     WHERE camp_id = 'a4000000-0000-0000-0000-000000000001' AND key = 'campistrySnacks';
END $$;


-- ─── 7. a spending cap, with zero meaning "no cap" ──────────────────────────
DO $$
DECLARE v jsonb; v_lim numeric;
BEGIN
    v := public.canteen_office_set_limit('a4000000-0000-0000-0000-000000000001'::uuid,
             'Rivky Stein', 12.50);
    IF NOT COALESCE((v->>'success')::boolean, false) THEN
        RAISE EXCEPTION 'the limit could not be set: %', v;
    END IF;
    SELECT daily_limit INTO v_lim FROM camp_canteen_accounts
     WHERE camp_id = 'a4000000-0000-0000-0000-000000000001' AND account_key = 'Rivky Stein';
    IF v_lim IS DISTINCT FROM 12.50 THEN
        RAISE EXCEPTION 'the limit row says %, not 12.50', COALESCE(v_lim::text, 'null');
    END IF;

    -- ZERO IS MEANINGFUL: submit_canteen_purchase reads dailyLimit <= 0 as no cap
    -- at all. The browser's setLimit used to reject it with `!amt` and so could
    -- never express "no limit"; that must not come back on the server side.
    v := public.canteen_office_set_limit('a4000000-0000-0000-0000-000000000001'::uuid,
             'Rivky Stein', 0);
    IF NOT COALESCE((v->>'success')::boolean, false) THEN
        RAISE EXCEPTION 'a limit of 0 (meaning no cap) was refused: %', v;
    END IF;
    SELECT daily_limit INTO v_lim FROM camp_canteen_accounts
     WHERE camp_id = 'a4000000-0000-0000-0000-000000000001' AND account_key = 'Rivky Stein';
    IF v_lim IS DISTINCT FROM 0 THEN
        RAISE EXCEPTION 'a limit of 0 did not stick: %', COALESCE(v_lim::text, 'null');
    END IF;

    v := public.canteen_office_set_limit('a4000000-0000-0000-0000-000000000001'::uuid,
             'Rivky Stein', -1);
    IF v->>'error' IS DISTINCT FROM 'invalid_limit' THEN
        RAISE EXCEPTION 'a negative limit was accepted: %', v;
    END IF;

    -- And the balance is untouched by a limit change. Obvious, and the kind of
    -- obvious that a shared `|| jsonb_build_object(...)` merge can break.
    IF (SELECT balance FROM camp_canteen_accounts
         WHERE camp_id = 'a4000000-0000-0000-0000-000000000001'
           AND account_key = 'Rivky Stein') <> 15 THEN
        RAISE EXCEPTION 'setting a limit moved the balance';
    END IF;
END $$;


-- ─── 8. by ID, so a renamed camper's money goes to their own account ────────
DO $$
DECLARE v jsonb; v_rows integer;
BEGIN
    -- She is now spelled differently on the roster. Her account key cannot change
    -- (it is the primary key and every historical sale carries it), so a deposit
    -- taken under the NEW name must still land on the OLD key.
    UPDATE camp_people SET name = 'Rivky Stein-Katz'
     WHERE camp_id = 'a4000000-0000-0000-0000-000000000001' AND person_id = 5001;

    v := public.canteen_office_credit('a4000000-0000-0000-0000-000000000001'::uuid,
             NULL, 10, 'cash', 'after the rename', '2026-07-11', 5001);
    IF NOT COALESCE((v->>'success')::boolean, false) THEN
        RAISE EXCEPTION 'a deposit by camper id failed: %', v;
    END IF;

    SELECT count(*) INTO v_rows FROM camp_canteen_accounts
     WHERE camp_id = 'a4000000-0000-0000-0000-000000000001' AND person_id = 5001;
    IF v_rows <> 1 THEN
        RAISE EXCEPTION 'the rename produced % accounts for one person — her money is split',
                        v_rows;
    END IF;
    IF (SELECT balance FROM camp_canteen_accounts
         WHERE camp_id = 'a4000000-0000-0000-0000-000000000001' AND person_id = 5001) <> 25 THEN
        RAISE EXCEPTION 'expected 15 + 10 = 25 on her one account';
    END IF;

    -- An id nobody has is refused rather than opening an account.
    v := public.canteen_office_credit('a4000000-0000-0000-0000-000000000001'::uuid,
             NULL, 10, 'cash', NULL, NULL, 9999);
    IF v->>'error' IS DISTINCT FROM 'unknown_camper' THEN
        RAISE EXCEPTION 'a deposit for a person who does not exist was allowed: %', v;
    END IF;
END $$;


-- ─── 9. the gate ────────────────────────────────────────────────────────────
SET "request.jwt.claims" = '{"sub":"a4000000-0000-0000-0000-0000000000bb"}';
DO $$
DECLARE v jsonb; v_bal numeric;
BEGIN
    SELECT balance INTO v_bal FROM camp_canteen_accounts
     WHERE camp_id = 'a4000000-0000-0000-0000-000000000001' AND person_id = 5001;

    v := public.canteen_office_credit('a4000000-0000-0000-0000-000000000001'::uuid,
             'Rivky Stein-Katz', 100);
    IF v->>'error' IS DISTINCT FROM 'not_authorized' THEN
        RAISE EXCEPTION 'a stranger credited another camp''s camper: %', v;
    END IF;
    v := public.canteen_office_cash_out('a4000000-0000-0000-0000-000000000001'::uuid,
             'Rivky Stein-Katz', 5, 'mine now', 'me', '2026-07-12');
    IF v->>'error' IS DISTINCT FROM 'not_authorized' THEN
        RAISE EXCEPTION 'a stranger took cash out of another camp''s camper: %', v;
    END IF;
    v := public.canteen_office_set_limit('a4000000-0000-0000-0000-000000000001'::uuid,
             'Rivky Stein-Katz', 999);
    IF v->>'error' IS DISTINCT FROM 'not_authorized' THEN
        RAISE EXCEPTION 'a stranger raised another camp''s spending limit: %', v;
    END IF;

    IF (SELECT balance FROM camp_canteen_accounts
         WHERE camp_id = 'a4000000-0000-0000-0000-000000000001' AND person_id = 5001)
       IS DISTINCT FROM v_bal THEN
        RAISE EXCEPTION 'the balance moved on a refused call';
    END IF;
END $$;

RESET "request.jwt.claims";
DO $$
DECLARE v jsonb;
BEGIN
    v := public.canteen_office_credit('a4000000-0000-0000-0000-000000000001'::uuid,
             'Rivky Stein-Katz', 100);
    IF v->>'error' IS DISTINCT FROM 'not_authorized' THEN
        RAISE EXCEPTION 'an unauthenticated caller credited an account: %', v;
    END IF;
END $$;


-- ─── 10. a staff member without edit on the section is refused ──────────────
-- The section resolver is a STUB here that answers 'edit' to everyone (see
-- scripts/pgstubs.sql), so this swaps it for one that answers 'view' and checks
-- the gate's own branch. It tests 240's logic against a controlled resolver, not
-- the registry's resolution — that is 159/160's own ground.
INSERT INTO camp_users (camp_id, user_id, role, accepted_at)
VALUES ('a4000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-0000000000cc',
        'counselor', now());

CREATE OR REPLACE FUNCTION public.user_section_level(p_camp_id uuid, p_section text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog AS $fn$ SELECT 'view'::text $fn$;

SET "request.jwt.claims" = '{"sub":"a4000000-0000-0000-0000-0000000000cc"}';
DO $$
DECLARE v jsonb;
BEGIN
    IF public.get_user_camp_id() <> 'a4000000-0000-0000-0000-000000000001' THEN
        RAISE EXCEPTION 'the counselor does not resolve to the camp, so this check is moot';
    END IF;
    IF public.get_user_role() <> 'counselor' THEN
        RAISE EXCEPTION 'the counselor reads as %, so the role list may be answering '
                        'instead of the section level', public.get_user_role();
    END IF;

    v := public.canteen_office_credit('a4000000-0000-0000-0000-000000000001'::uuid,
             'Rivky Stein-Katz', 5);
    IF v->>'error' IS DISTINCT FROM 'not_authorized' THEN
        RAISE EXCEPTION 'view-only access to snacks.accounts still took a deposit: %', v;
    END IF;
END $$;

-- With edit, the same person may.
CREATE OR REPLACE FUNCTION public.user_section_level(p_camp_id uuid, p_section text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog AS $fn$ SELECT 'edit'::text $fn$;

DO $$
DECLARE v jsonb;
BEGIN
    v := public.canteen_office_credit('a4000000-0000-0000-0000-000000000001'::uuid,
             'Rivky Stein-Katz', 5, 'cash', NULL, '2026-07-12');
    IF NOT COALESCE((v->>'success')::boolean, false) THEN
        RAISE EXCEPTION 'edit access on snacks.accounts was refused: %', v;
    END IF;
END $$;


-- ─── 11. the verifier counts what is in the rows ────────────────────────────
SET "request.jwt.claims" = '{"sub":"a4000000-0000-0000-0000-0000000000aa"}';
DO $$
DECLARE v jsonb;
BEGIN
    v := public.verify_office_canteen_writers('a4000000-0000-0000-0000-000000000001'::uuid);
    IF (v->>'writers_ready')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'the verifier cannot see the three writers: %', v;
    END IF;
    IF (v->>'desk_deposits_in_rows')::bigint < 3 THEN
        RAISE EXCEPTION 'expected at least 3 desk deposits in the ledger, got %: %',
                        v->>'desk_deposits_in_rows', v;
    END IF;
    IF (v->>'cash_outs_in_rows')::bigint < 4 THEN
        RAISE EXCEPTION 'expected at least 4 cash outs in the ledger, got %: %',
                        v->>'cash_outs_in_rows', v;
    END IF;
    -- The camp never wrote accounts into the document in this test, so there is
    -- nothing stale to report. A live camp from before 219 will show a count here,
    -- and that is information, not a fault.
    IF (v->>'stale_document_accounts')::int <> 0 THEN
        RAISE EXCEPTION 'the document grew an accounts branch: %', v;
    END IF;
    IF (v -> 'cash_settings' ->> 'cashDailyMax')::numeric <> 20 THEN
        RAISE EXCEPTION 'the verifier read the wrong cash settings: %', v;
    END IF;
END $$;

ROLLBACK;
