-- ============================================================================
-- Migration 240: the canteen desk's own money reaches the database.
--
-- THE DEFECT. Three writers on the Snacks manager page move money or change a
-- cap, and all three write the campistrySnacks DOCUMENT and nothing else:
--
--     addDep()    + $40 onto a camper's balance, and a 'credit' ledger row
--     cashOut()   - $x  off it, and a 'debit'/'cash_out' ledger row
--     setLimit()  a camper's dailyLimit
--
-- 219 made the ROWS the truth and froze the document's copy. campistry_snacks.js
-- honours that on the way out —
--
--     function _withoutRowBackedBranches(data) {
--         delete copy.accounts;
--         delete copy.transactions;
--
-- — so every one of those writes is stripped before the upsert. The office takes
-- $40 in cash at the desk, the screen says "Added $40.00", and the database never
-- hears about it. Worse than lost: _reconcileBalances rebuilds each balance from
-- the cloud ledger, so the next hydration sets that camper back to what they had
-- before the deposit. The money is gone and the camper is short.
--
-- Same for a cash-out — the camper walks away with physical money and their
-- balance recovers — and for a spending limit, which silently reverts.
--
-- This is the shape 229 and 231 were about: writers moved to rows and one set
-- never came along. 231 moved the five PARENT-facing writers onto the shared
-- gate. These three are the OFFICE's, and nothing was ever written for them:
-- submit_canteen_deposit is parent-only (it resolves the caller's invite and
-- refuses without one), so the desk had nothing to call.
--
-- HOW IT WAS FOUND. tests/money_path.e2e.js drives the real page in a browser
-- against a real Postgres. It clicked "+ Add Deposit", entered $40, clicked "Add
-- Deposit", and then looked in the database: campistrySnacks carried no accounts
-- and no transactions, camp_canteen_accounts was empty, canteen_transactions was
-- empty. Nothing in the JS suite or the pgtests can see that, because each layer
-- is correct on its own.
--
-- WHAT THIS FILE DOES. Three SECURITY DEFINER writers for the desk, on the same
-- lock/save/post trio every other canteen writer now uses, plus the one gate they
-- share. The cash-out rule is campistry_snacks_cash.js's rule — the same balance
-- floor, the same cashDailyMax, the same cashAllowNegative override — ENFORCED
-- here rather than suggested in the browser. That module's own header says it
-- exists "so the manager dashboard, the POS terminal and (eventually) a server
-- RPC all agree on the same answer"; this is the eventually.
--
-- WHAT IT DOES NOT DO. It does not go looking for deposits already lost. There
-- is no way to tell a deposit that was taken and dropped from one that was never
-- typed, and no camp is live yet.
--
-- HOW TO APPLY. Paste into the SQL Editor. One transaction, idempotent, and it
-- touches no data — six CREATE OR REPLACEs, the grants, and a check.
--
-- APPLY 239 FIRST. It closes an authorization hole in settle_shop_order that this
-- file's gate was written to avoid repeating, and the two are easier to read in
-- that order.
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

-- ─── 0. preflight ───────────────────────────────────────────────────────────
-- The signatures this file writes calls to. Missing, the fix would compile and
-- fail at the first deposit — which is precisely the class of bug 233 was.
DO $$
DECLARE missing text := '';
BEGIN
    IF to_regprocedure('public.canteen_account_lock(uuid,text)') IS NULL THEN
        missing := missing || ' canteen_account_lock(uuid,text)'; END IF;
    IF to_regprocedure('public.canteen_account_save(uuid,text,jsonb)') IS NULL THEN
        missing := missing || ' canteen_account_save(uuid,text,jsonb)'; END IF;
    IF to_regprocedure('public.canteen_post(uuid,text,jsonb,text)') IS NULL THEN
        missing := missing || ' canteen_post(uuid,text,jsonb,text)'; END IF;
    IF to_regprocedure('public.camp_person_by_name(uuid,text)') IS NULL THEN
        missing := missing || ' camp_person_by_name(uuid,text)'; END IF;
    IF to_regprocedure('public.camp_person_label(uuid,bigint)') IS NULL THEN
        missing := missing || ' camp_person_label(uuid,bigint)'; END IF;
    IF missing <> '' THEN
        RAISE EXCEPTION '240 needs:% — apply 216, 219, 223 and 227 first', missing;
    END IF;
END $$;

SET LOCAL lock_timeout = '15s';


-- ─── 1. the one gate the three writers share ────────────────────────────────
-- Staff of THIS camp, with edit on the section the buttons live in. Owners,
-- admins and managers pass regardless, the same list settle_shop_order uses for
-- its camp-bill branch — a camp whose section registry has not been set up must
-- not lock its own owner out of the canteen.
--
-- It is a function rather than three copies of the same IF, because the next
-- desk writer will need it too and a fourth copy is how two of them drift.
CREATE OR REPLACE FUNCTION public._canteen_office_may_edit(p_camp_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE v_level text;
BEGIN
    IF p_camp_id IS NULL OR auth.uid() IS NULL THEN RETURN false; END IF;
    -- IS DISTINCT FROM, not <>. For a caller who belongs to no camp
    -- get_user_camp_id() is NULL, `p_camp_id <> NULL` is NULL, and `IF NULL THEN`
    -- does not fire — a guard that looks like a guard and bounds nothing. That is
    -- exactly how settle_shop_order let a signed-in stranger debit another camp's
    -- canteen; see migration 239.
    IF p_camp_id IS DISTINCT FROM public.get_user_camp_id() THEN RETURN false; END IF;
    IF NOT public.camp_staff_member(p_camp_id) THEN RETURN false; END IF;
    IF public.get_user_role() IN ('owner', 'admin', 'manager') THEN RETURN true; END IF;

    -- The same key the page itself gates on: _secEdit('accounts') resolves to
    -- 'snacks.accounts' through campistry_access_sections.js.
    BEGIN
        v_level := public.user_section_level(p_camp_id, 'snacks.accounts');
    EXCEPTION WHEN undefined_function THEN
        -- A camp that has not applied the registry migrations has no per-section
        -- answer. Fall back to the role list above, which already said no.
        RETURN false;
    END;
    RETURN COALESCE(v_level, '') = 'edit';
END;
$$;


-- ─── 2. the cash-out settings, with campistry_snacks_cash.js's defaults ─────
-- The document still holds `settings` (219 stripped only accounts and
-- transactions), so this is the same configuration the page reads. The DEFAULTS
-- object in that file is the authority for what a camp that never set them gets.
CREATE OR REPLACE FUNCTION public._canteen_cash_settings(p_camp_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT jsonb_build_object(
               'cashDailyMax',       20,
               'cashReasonRequired', true,
               'cashAllowNegative',  false)
           || COALESCE(
                  (SELECT value -> 'settings' FROM camp_state_kv
                    WHERE camp_id = p_camp_id AND key = 'campistrySnacks'
                      AND jsonb_typeof(value -> 'settings') = 'object'),
                  '{}'::jsonb)
$$;


-- ─── 3. cash already taken out today ────────────────────────────────────────
-- SnacksCash.takenOn, against the ledger rather than the document's copy of it.
-- Matched on the ACCOUNT KEY, which is what canteen_post writes into `camper`
-- and is stable across a rename; the amount is summed absolute because a cash
-- out is stored as a positive debit.
CREATE OR REPLACE FUNCTION public._canteen_cash_taken_on(
    p_camp_id uuid, p_key text, p_date text)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT round(COALESCE(SUM(abs(t.amount)), 0), 2)
      FROM canteen_transactions t
     WHERE t.camp_id = p_camp_id
       AND t.camper  = public.canteen_account_key_for(p_camp_id, p_key)
       AND t.payload ->> 'kind' = 'cash_out'
       AND (p_date IS NULL OR t.tx_date = p_date)
$$;


-- ─── 4. a deposit taken at the desk ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.canteen_office_credit(
    p_camp_id     uuid,
    p_camper_name text,
    p_amount      numeric,
    p_method      text   DEFAULT NULL,
    p_note        text   DEFAULT NULL,
    p_date        text   DEFAULT NULL,
    p_camper_id   bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_id     bigint := p_camper_id;
    v_name   text;
    v_acct   jsonb;
    v_bal    numeric;
    v_amt    numeric;
    v_date   text := COALESCE(NULLIF(btrim(p_date), ''),
                              (now() AT TIME ZONE 'utc')::date::text);
    now_ts   timestamptz := now();
BEGIN
    IF NOT public._canteen_office_may_edit(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    -- NO UPPER BOUND, unlike the parent-facing submit_canteen_deposit's $500.
    -- That cap is there because the public can reach that function; this one is
    -- the desk recording cash it has already been handed, and a camp that takes
    -- a $600 season deposit must be able to record it.
    v_amt := round(COALESCE(p_amount, 0), 2);
    IF v_amt <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_amount');
    END IF;

    -- The label comes from the roster when an id was given, never from the name
    -- beside it — 231's rule, so a renamed camper's deposit still lands on their
    -- account rather than opening a second one under the old spelling.
    IF v_id IS NOT NULL THEN
        v_name := public.camp_person_label(p_camp_id, v_id);
        IF v_name IS NULL THEN
            RETURN jsonb_build_object('success', false, 'error', 'unknown_camper');
        END IF;
    ELSE
        v_name := NULLIF(btrim(COALESCE(p_camper_name, '')), '');
        IF v_name IS NULL THEN
            RETURN jsonb_build_object('success', false, 'error', 'missing_camper');
        END IF;
        v_id := public.camp_person_by_name(p_camp_id, v_name);
    END IF;

    v_acct := public.canteen_account_lock(p_camp_id, v_name);
    v_bal  := round(COALESCE((v_acct ->> 'balance')::numeric, 0) + v_amt, 2);

    PERFORM public.canteen_account_save(p_camp_id, v_name,
        COALESCE(v_acct, '{"dailyLimit":10,"spentToday":0}'::jsonb)
            || jsonb_build_object('balance', v_bal));

    -- The same row shape addDep built in the browser, so the ledger reads the
    -- same whichever path put the money on.
    PERFORM public.canteen_post(p_camp_id, v_name,
        jsonb_build_object(
            'time',   to_char(now_ts, 'HH12:MI AM'),
            'camper', v_name,
            'items',  'Deposit' || CASE WHEN COALESCE(btrim(p_note), '') <> ''
                                        THEN ' — ' || btrim(p_note) ELSE '' END,
            'amount', v_amt,
            'type',   'credit',
            'kind',   'deposit',
            'method', COALESCE(NULLIF(btrim(p_method), ''), 'cash'),
            'note',   COALESCE(btrim(p_note), ''),
            'date',   v_date
        ));

    RETURN jsonb_build_object('success', true, 'balance', v_bal,
                              'camper', v_name, 'camperId', v_id, 'amount', v_amt);
END;
$$;


-- ─── 5. cash handed back over the counter ───────────────────────────────────
-- campistry_snacks_cash.js's rule, enforced. Every refusal it can give is a
-- refusal here, with the numbers, so the page can say the same thing.
CREATE OR REPLACE FUNCTION public.canteen_office_cash_out(
    p_camp_id     uuid,
    p_camper_name text,
    p_amount      numeric,
    p_note        text   DEFAULT NULL,
    p_by          text   DEFAULT NULL,
    p_date        text   DEFAULT NULL,
    p_camper_id   bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_id      bigint := p_camper_id;
    v_name    text;
    v_acct    jsonb;
    v_cfg     jsonb;
    v_amt     numeric;
    v_bal     numeric;
    v_floor   numeric;
    v_taken   numeric;
    v_max     numeric;          -- NULL means "no ceiling" (cashAllowNegative)
    v_dailym  numeric;
    v_left    numeric;
    v_note    text;
    v_date    text := COALESCE(NULLIF(btrim(p_date), ''),
                               (now() AT TIME ZONE 'utc')::date::text);
    now_ts    timestamptz := now();
BEGIN
    IF NOT public._canteen_office_may_edit(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    v_amt  := round(COALESCE(p_amount, 0), 2);
    v_note := COALESCE(btrim(p_note), '');
    IF v_amt <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_amount');
    END IF;

    IF v_id IS NOT NULL THEN
        v_name := public.camp_person_label(p_camp_id, v_id);
        IF v_name IS NULL THEN
            RETURN jsonb_build_object('success', false, 'error', 'unknown_camper');
        END IF;
    ELSE
        v_name := NULLIF(btrim(COALESCE(p_camper_name, '')), '');
        IF v_name IS NULL THEN
            RETURN jsonb_build_object('success', false, 'error', 'missing_camper');
        END IF;
        v_id := public.camp_person_by_name(p_camp_id, v_name);
    END IF;

    v_cfg := public._canteen_cash_settings(p_camp_id);
    IF COALESCE((v_cfg ->> 'cashReasonRequired')::boolean, true) AND v_note = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'reason_required');
    END IF;

    -- The lock comes BEFORE the arithmetic, and holds to the end: the modal can
    -- sit open while a POS charge lands from another device, and the client's own
    -- re-validation reads a balance it cannot hold still.
    v_acct  := public.canteen_account_lock(p_camp_id, v_name);
    v_bal   := round(COALESCE((v_acct ->> 'balance')::numeric, 0), 2);
    v_floor := round(COALESCE((v_acct ->> 'balanceFloor')::numeric, 0), 2);
    v_taken := public._canteen_cash_taken_on(p_camp_id, v_name, v_date);

    -- SnacksCash.limit: cash draws physical money, so a CREDIT limit does not
    -- apply — credit exists to let someone finish a purchase, not to hand out
    -- cash. A balanceFloor does apply.
    IF COALESCE((v_cfg ->> 'cashAllowNegative')::boolean, false) THEN
        v_max := NULL;
    ELSE
        v_max := GREATEST(0, round(v_bal - v_floor, 2));
        IF v_max = 0 THEN
            RETURN jsonb_build_object('success', false, 'error', 'no_available_balance',
                'balance', v_bal, 'max', 0, 'takenToday', v_taken);
        END IF;
    END IF;

    v_dailym := round(COALESCE((v_cfg ->> 'cashDailyMax')::numeric, 0), 2);
    IF v_dailym > 0 THEN
        v_left := GREATEST(0, round(v_dailym - v_taken, 2));
        IF v_left = 0 THEN
            RETURN jsonb_build_object('success', false, 'error', 'daily_cash_limit_reached',
                'balance', v_bal, 'max', 0, 'takenToday', v_taken, 'cashDailyMax', v_dailym);
        END IF;
        IF v_max IS NULL OR v_left < v_max THEN v_max := v_left; END IF;
    END IF;

    IF v_max IS NOT NULL AND v_amt > v_max THEN
        RETURN jsonb_build_object('success', false, 'error', 'over_available',
            'balance', v_bal, 'max', v_max, 'takenToday', v_taken);
    END IF;

    v_bal := round(v_bal - v_amt, 2);

    -- spentToday is deliberately untouched: dailyLimit caps canteen SPENDING and
    -- cash out has its own cap. Same note as the browser version it replaces.
    PERFORM public.canteen_account_save(p_camp_id, v_name,
        COALESCE(v_acct, '{"dailyLimit":10,"spentToday":0}'::jsonb)
            || jsonb_build_object('balance', v_bal));

    -- SnacksCash.buildTransaction's shape, field for field. `kind:'cash_out'` is
    -- what lets revenue reporting and the drawer tell this from a sale, and is
    -- what _canteen_cash_taken_on counts.
    PERFORM public.canteen_post(p_camp_id, v_name,
        jsonb_build_object(
            'time',   to_char(now_ts, 'HH12:MI AM'),
            'camper', v_name,
            'items',  'Cash out' || CASE WHEN v_note <> '' THEN ' — ' || v_note ELSE '' END,
            'amount', v_amt,
            'type',   'debit',
            'kind',   'cash_out',
            'note',   v_note,
            'by',     COALESCE(btrim(p_by), ''),
            'date',   v_date
        ));

    RETURN jsonb_build_object('success', true, 'balance', v_bal,
                              'camper', v_name, 'camperId', v_id, 'amount', v_amt,
                              'takenToday', round(v_taken + v_amt, 2));
END;
$$;


-- ─── 6. a camper's daily spending cap ───────────────────────────────────────
-- Not money, but lost the same way and with the same consequence: an office that
-- lowers a camper's limit and watches it revert has no reason to believe the
-- screen about anything else either.
CREATE OR REPLACE FUNCTION public.canteen_office_set_limit(
    p_camp_id     uuid,
    p_camper_name text,
    p_daily_limit numeric,
    p_camper_id   bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_id    bigint := p_camper_id;
    v_name  text;
    v_acct  jsonb;
    v_limit numeric;
BEGIN
    IF NOT public._canteen_office_may_edit(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    -- 0 is MEANINGFUL, not blank: submit_canteen_purchase's convention is that
    -- dailyLimit <= 0 means no daily cap at all. setLimit in the browser used to
    -- reject it with `!amt` and so could never express "no limit"; that is fixed
    -- there and must not come back here.
    IF p_daily_limit IS NULL OR p_daily_limit < 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_limit');
    END IF;
    v_limit := round(p_daily_limit, 2);

    IF v_id IS NOT NULL THEN
        v_name := public.camp_person_label(p_camp_id, v_id);
        IF v_name IS NULL THEN
            RETURN jsonb_build_object('success', false, 'error', 'unknown_camper');
        END IF;
    ELSE
        v_name := NULLIF(btrim(COALESCE(p_camper_name, '')), '');
        IF v_name IS NULL THEN
            RETURN jsonb_build_object('success', false, 'error', 'missing_camper');
        END IF;
        v_id := public.camp_person_by_name(p_camp_id, v_name);
    END IF;

    v_acct := public.canteen_account_lock(p_camp_id, v_name);
    PERFORM public.canteen_account_save(p_camp_id, v_name,
        COALESCE(v_acct, '{"balance":0,"spentToday":0}'::jsonb)
            || jsonb_build_object('dailyLimit', v_limit));

    RETURN jsonb_build_object('success', true, 'dailyLimit', v_limit,
                              'camper', v_name, 'camperId', v_id);
END;
$$;


-- ─── 7. grants ──────────────────────────────────────────────────────────────
-- authenticated, not anon: every one of them refuses a caller who is not staff
-- of the camp, and _canteen_office_may_edit is where that is decided.
REVOKE ALL ON FUNCTION public.canteen_office_credit(uuid, text, numeric, text, text, text, bigint)
    FROM public, anon;
GRANT EXECUTE ON FUNCTION public.canteen_office_credit(uuid, text, numeric, text, text, text, bigint)
    TO authenticated;

REVOKE ALL ON FUNCTION public.canteen_office_cash_out(uuid, text, numeric, text, text, text, bigint)
    FROM public, anon;
GRANT EXECUTE ON FUNCTION public.canteen_office_cash_out(uuid, text, numeric, text, text, text, bigint)
    TO authenticated;

REVOKE ALL ON FUNCTION public.canteen_office_set_limit(uuid, text, numeric, bigint)
    FROM public, anon;
GRANT EXECUTE ON FUNCTION public.canteen_office_set_limit(uuid, text, numeric, bigint)
    TO authenticated;

REVOKE ALL ON FUNCTION public._canteen_office_may_edit(uuid) FROM public, anon;
REVOKE ALL ON FUNCTION public._canteen_cash_settings(uuid) FROM public, anon;
REVOKE ALL ON FUNCTION public._canteen_cash_taken_on(uuid, text, text) FROM public, anon;


-- ─── 8. the verifier ────────────────────────────────────────────────────────
-- The narrow question this file raises: is the desk's money in the ROWS, or only
-- in a document that no longer carries it. A camp that has been taking deposits
-- since before this migration will read a document-only figure here.
CREATE OR REPLACE FUNCTION public.verify_office_canteen_writers(p_camp_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT jsonb_build_object(
        'writers_ready',
            to_regprocedure('public.canteen_office_credit(uuid,text,numeric,text,text,text,bigint)') IS NOT NULL
        AND to_regprocedure('public.canteen_office_cash_out(uuid,text,numeric,text,text,text,bigint)') IS NOT NULL
        AND to_regprocedure('public.canteen_office_set_limit(uuid,text,numeric,bigint)') IS NOT NULL,

        -- Deposits and cash-outs that ARE in the ledger, which is the only place
        -- they now count from.
        'desk_deposits_in_rows',
            (SELECT count(*) FROM canteen_transactions
              WHERE camp_id = p_camp_id AND payload ->> 'kind' = 'deposit'),
        'cash_outs_in_rows',
            (SELECT count(*) FROM canteen_transactions
              WHERE camp_id = p_camp_id AND payload ->> 'kind' = 'cash_out'),

        -- The document's leftovers, if any. 219 stopped writing these, so a
        -- non-zero count here is from before that and is NOT the balance anyone
        -- is being charged against — it is a frozen copy, reported so nobody
        -- mistakes it for money that is missing from the rows.
        'stale_document_accounts',
            (SELECT COALESCE(jsonb_array_length(
                        COALESCE(jsonb_path_query_array(value, '$.accounts.keyvalue()'), '[]'::jsonb)), 0)
               FROM camp_state_kv
              WHERE camp_id = p_camp_id AND key = 'campistrySnacks'),

        'cash_settings', public._canteen_cash_settings(p_camp_id)
    )
$$;

REVOKE ALL ON FUNCTION public.verify_office_canteen_writers(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.verify_office_canteen_writers(uuid) TO authenticated, service_role;


-- ─── 9. did it take ─────────────────────────────────────────────────────────
-- Not "does the function exist" — 233's whole lesson is that a function can
-- exist and call nothing. Each writer must reach the ROW trio, and none of them
-- may touch the document's accounts or transactions.
DO $$
DECLARE
    v_missing text := '';
    v_doc     text := '';
    r         record;
BEGIN
    FOR r IN
        SELECT p.proname, p.prosrc
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('canteen_office_credit', 'canteen_office_cash_out',
                             'canteen_office_set_limit')
    LOOP
        IF r.prosrc !~ 'canteen_account_save' OR r.prosrc !~ 'canteen_account_lock' THEN
            v_missing := v_missing || ' ' || r.proname;
        END IF;
        -- The document branches this migration exists to stop writing. Matched on
        -- a jsonb path build rather than the bare word, because the PROSE above
        -- says "accounts" and "transactions" and prosrc includes comments — that
        -- mistake has been made three times in this chain already.
        IF r.prosrc ~ $re$ARRAY\[\s*'(accounts|transactions)'$re$ THEN
            v_doc := v_doc || ' ' || r.proname;
        END IF;
    END LOOP;

    IF v_missing <> '' THEN
        RAISE EXCEPTION '240 did not take: these writers do not reach the row trio:%', v_missing;
    END IF;
    IF v_doc <> '' THEN
        RAISE EXCEPTION '240 did not take: these writers still write the document:%', v_doc;
    END IF;

    -- And the credit writer must post to the ledger, not only move the balance.
    -- A balance without a row is erased by the next _reconcileBalances, which is
    -- the defect restated.
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'canteen_office_credit'
           AND p.prosrc ~ 'canteen_post') THEN
        RAISE EXCEPTION '240 did not take: canteen_office_credit moves a balance '
                        'without writing a ledger row';
    END IF;
END $$;
