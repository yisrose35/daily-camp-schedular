-- ============================================================================
-- 219 — the canteen becomes rows, and the camp-wide lock goes
--
-- ⚠ DO NOT PASTE THIS YET. It is a COUPLED release: campistry_snacks.js must
--   ship in the same deploy. See "THE CLIENT MOVES WITH IT" below. Applying
--   this alone leaves the POS reading balances frozen at the moment it ran.
--
-- WHAT IS WRONG TODAY. Every canteen writer does the same thing:
--
--     SELECT value ... WHERE key = 'campistrySnacks' FOR UPDATE;   -- the camp
--     ... change ONE camper's account inside the document ...
--     UPDATE camp_state_kv SET value = <the whole document>;
--
-- so every sale in a camp queues behind every other one, whoever it belongs
-- to. Measured: ~42 sales a second, camp-wide, and adding registers cannot
-- raise it because the lock is held per sale.
--
-- WHY A MIRROR CANNOT FIX IT. The obvious gentler plan — write rows AND keep
-- the document updated, so no client has to change — does not work, and the
-- reason is the whole point: writing the document IS the lock. jsonb_set on
-- accounts → <name> means UPDATE camp_state_kv on the camp's one row. Keeping
-- the mirror keeps the ceiling exactly where it is.
--
-- WHY THE LEDGER MOVES TOO. submit_canteen_purchase appends to the document's
-- `transactions` array in the same statement. That is the same camp-wide lock
-- under a different name, so balances and ledger are inseparable here.
-- canteen_transactions (203) stops being a projection of the document and
-- becomes the ledger itself.
--
-- WHY ALL THIRTEEN WRITERS AT ONCE. 217's trigger diffs per key, so a writer
-- still on the document cannot clobber an account it does not touch. But the
-- moment one account is purchased (rows) and topped up (document), the deposit
-- reads a stale balance and writes it back through the trigger, and the
-- purchases in between are gone. Mixed truth is only safe if no account is
-- ever written by both regimes — which deposits and purchases violate by
-- definition.
--
-- THE CLIENT MOVES WITH IT. campistry_snacks.js reads camp_state_kv directly
-- (:306, :1668) and writes the whole document back with a compare-and-set
-- (:1773). After this file:
--   * that compare-and-set must stop carrying `accounts` and `transactions`,
--     or it will push a stale snapshot over live balances;
--   * account reads must go through get_canteen_accounts, which 218 already
--     made row-backed.
-- The document keeps its other branches — inventory, POS config — and
-- record_canteen_sale_inventory is deliberately left alone, because it never
-- touches accounts.
--
-- Standalone. NOT part of APPLY_BUNDLE.sql. Requires 216, 217, 218.
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_name = 'camp_canteen_accounts') THEN
        RAISE EXCEPTION 'camp_canteen_accounts is missing — apply 217 before this file';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = '_canteen_account_json') THEN
        RAISE EXCEPTION '_canteen_account_json is missing — apply 218 before this file';
    END IF;
END $$;

SET LOCAL lock_timeout = '15s';
LOCK TABLE public.camp_state_kv IN ACCESS EXCLUSIVE MODE;


-- ─── 1. lock ONE account ────────────────────────────────────────────────────
-- The replacement for `SELECT value ... FOR UPDATE` on the whole document.
--
-- Returns the account as the same jsonb object the writers already manipulate,
-- so every writer's money arithmetic stays byte-for-byte what it was — the
-- only thing that changes is what was locked to get it. Two campers at two
-- registers now contend with nobody.
--
-- Creates the row if it is missing, because a camper's first purchase or first
-- deposit legitimately arrives before any account exists. That mirrors the
-- INSERT ... ON CONFLICT DO NOTHING every writer does today against the
-- document.
--
-- WHY IT RETURNS jsonb AND NOT THE ROW: the writers read and write
-- v_acct->>'balance', v_acct->>'dailyLimit' and so on, including fields with
-- no column at all (autoReload, byop handles). Handing back the row would
-- force thirteen functions to be rewritten rather than re-pointed, and every
-- rewrite is a chance to change a number.
CREATE OR REPLACE FUNCTION public.canteen_account_lock(p_camp_id uuid, p_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_row camp_canteen_accounts;
BEGIN
    IF p_camp_id IS NULL OR p_key IS NULL OR btrim(p_key) = '' THEN
        RETURN NULL;
    END IF;

    INSERT INTO camp_canteen_accounts (camp_id, account_key, person_id, camper_name, payload)
    VALUES (p_camp_id, p_key,
            public._attribute_canteen_account(p_camp_id, p_key),
            p_key, '{}'::jsonb)
    ON CONFLICT (camp_id, account_key) DO NOTHING;

    -- THE lock, and the whole point of the file: one camper's row, not the
    -- camp's document.
    --
    -- ON TESTING IT. Deleting `FOR UPDATE` here breaks no test, and cannot:
    -- a row lock is invisible to a single connection, and the behaviour test
    -- runs in one. The same is true of mint_person_id's skip loop in 216. It
    -- is recorded rather than papered over — the alternative is a test that
    -- looks like coverage and is not. What a lost lock would actually cost:
    -- two registers ringing up the SAME camper at the same instant would both
    -- read the balance before either wrote, and one sale would be given away
    -- free. Different campers never contend either way, which is the gain.
    SELECT * INTO v_row FROM camp_canteen_accounts
     WHERE camp_id = p_camp_id AND account_key = p_key
     FOR UPDATE;

    IF NOT FOUND THEN RETURN NULL; END IF;

    -- A stamped account coming back to life: somebody is putting money on it
    -- again, so it is present again. Absence was recorded, not obeyed.
    IF v_row.deleted_at IS NOT NULL THEN
        UPDATE camp_canteen_accounts SET deleted_at = NULL, updated_at = now()
         WHERE camp_id = p_camp_id AND account_key = p_key;
    END IF;

    RETURN public._canteen_account_json(v_row);
END;
$$;
REVOKE ALL ON FUNCTION public.canteen_account_lock(uuid, text) FROM public, anon, authenticated;


-- ─── 2. save it back ────────────────────────────────────────────────────────
-- The replacement for jsonb_set(v_value, ARRAY['accounts', name], ...) plus
-- the UPDATE of the whole document.
--
-- Columns are extracted from the object so the reader, the verifier and any
-- future query can use them; the object itself is kept in payload so fields
-- with no column survive untouched. _canteen_account_json layers the columns
-- back over the payload on the way out, which is what makes the columns
-- authoritative rather than merely a copy.
--
-- NOTE the limits are stored as NULL when absent, NOT as 0. An absent
-- dailyLimit means the writer's default of 10; a dailyLimit of 0 means no cap
-- at all (submit_canteen_purchase: `IF v_daily > 0 AND ...`). Coalescing would
-- turn a capped camper into an uncapped one.
-- IT IS AN UPSERT, NOT AN UPDATE. A bare UPDATE against a row that does not
-- exist changes nothing and reports nothing — the same shape as every other
-- bug this migration chain has been unpicking: a write that lands nowhere and
-- says so to no one. The converted writers always lock (which creates) before
-- saving, so in practice the row is there; but "in practice" is how a silent
-- no-op survives until the one path that skipped the lock finds it, and then
-- a camper's purchase simply does not happen.
CREATE OR REPLACE FUNCTION public.canteen_account_save(p_camp_id uuid, p_key text, p_acct jsonb)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    INSERT INTO camp_canteen_accounts AS a
        (camp_id, account_key, person_id, camper_name, balance, daily_limit,
         credit_limit, balance_floor, spent_today, spent_on, payload)
    VALUES (
        p_camp_id, p_key,
        public._attribute_canteen_account(p_camp_id, p_key),
        p_key,
        COALESCE(NULLIF(p_acct ->> 'balance', '')::numeric, 0),
        NULLIF(p_acct ->> 'dailyLimit',   '')::numeric,
        NULLIF(p_acct ->> 'creditLimit',  '')::numeric,
        NULLIF(p_acct ->> 'balanceFloor', '')::numeric,
        COALESCE(NULLIF(p_acct ->> 'spentToday', '')::numeric, 0),
        NULLIF(p_acct ->> 'lastSpendDate', '')::date,
        p_acct)
    ON CONFLICT (camp_id, account_key) DO UPDATE SET
        balance       = COALESCE(NULLIF(p_acct ->> 'balance', '')::numeric, 0),
        daily_limit   = NULLIF(p_acct ->> 'dailyLimit',   '')::numeric,
        credit_limit  = NULLIF(p_acct ->> 'creditLimit',  '')::numeric,
        balance_floor = NULLIF(p_acct ->> 'balanceFloor', '')::numeric,
        spent_today   = COALESCE(NULLIF(p_acct ->> 'spentToday', '')::numeric, 0),
        spent_on      = NULLIF(p_acct ->> 'lastSpendDate', '')::date,
        payload       = p_acct,
        -- Saving to a stamped account revives it: somebody is putting money on
        -- it again, so it is present again. Same rule as the lock.
        deleted_at    = NULL,
        updated_at    = now();
$$;
REVOKE ALL ON FUNCTION public.canteen_account_save(uuid, text, jsonb) FROM public, anon, authenticated;


-- ─── 3. post to the ledger ──────────────────────────────────────────────────
-- The replacement for prepending to the document's `transactions` array.
--
-- canteen_transactions has been a PROJECTION of that array since 203. This
-- makes it the ledger, which is why 206's projection trigger is dropped below:
-- with both in place, a document save would re-derive rows that are now
-- written directly, and the archive would grow a duplicate of every sale.
--
-- sig is the archive's primary key and was computed from the client's own
-- _txSig. A row written here has no document entry to derive one from, so it
-- gets a synthetic signature that cannot collide with a derived one — and the
-- PK still makes a double-post impossible if a writer is retried.
CREATE OR REPLACE FUNCTION public.canteen_post(
    p_camp_id uuid,
    p_key     text,
    p_tx      jsonb,
    p_sig     text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_sig text := COALESCE(p_sig,
        'row:' || encode(digest(p_camp_id::text || '|' || p_key || '|' || p_tx::text
                                || '|' || clock_timestamp()::text, 'sha256'), 'hex'));
BEGIN
    INSERT INTO canteen_transactions
        (camp_id, sig, camper, camper_id, tx_type, amount, tx_date, tx_time, items, payload)
    VALUES (
        p_camp_id, v_sig,
        p_key,
        (SELECT person_id::text FROM camp_canteen_accounts
          WHERE camp_id = p_camp_id AND account_key = p_key),
        COALESCE(p_tx ->> 'type', ''),
        COALESCE(NULLIF(p_tx ->> 'amount', '')::numeric, 0),
        COALESCE(p_tx ->> 'date', (now() AT TIME ZONE 'utc')::date::text),
        COALESCE(p_tx ->> 'time', ''),
        COALESCE(p_tx ->> 'items', ''),
        p_tx)
    ON CONFLICT (camp_id, sig) DO NOTHING;
END;
$$;
REVOKE ALL ON FUNCTION public.canteen_post(uuid, text, jsonb, text) FROM public, anon, authenticated;


-- ─── 4. the projections stop ────────────────────────────────────────────────
-- 217's trigger copies document → account rows, and 203/206's copies document
-- → ledger rows. Both ran in the right direction while the document was the
-- truth. From here the rows ARE the truth, so leaving either in place means a
-- document write — including the client's compare-and-set — can push a stale
-- snapshot over live balances. That is the money-losing path this file exists
-- to close, so they go.
DROP TRIGGER IF EXISTS trg_project_canteen_accounts ON public.camp_state_kv;
DROP TRIGGER IF EXISTS trg_canteen_archive          ON public.camp_state_kv;
DROP TRIGGER IF EXISTS trg_project_canteen_tx       ON public.camp_state_kv;



-- ─── 5. the thirteen writers ────────────────────────────────────────────────
-- Converted by scripts/transform_canteen_writers.py, by RULE rather than by
-- hand: thirteen functions of money arithmetic that must not change by a
-- character, so the rules are applied uniformly and the result is diffed.
--
-- What changed in each, and nothing else:
--   the camp-wide SELECT ... FOR UPDATE  →  canteen_account_lock() on ONE row
--   jsonb_set(doc, accounts → name, X)   →  canteen_account_save(camp, name, X)
--   jsonb_set(doc, '{transactions}', …)  →  canteen_post(camp, name, tx)
--   the duplicate guard, which scanned   →  the same question put to
--     the document's transactions array      canteen_transactions
--
-- That last one is the most dangerous statement in the file: it is what stops
-- a retried webhook crediting a camper twice. The transformer's first run left
-- it reading a document variable the conversion had just set to NULL, where it
-- silently answered "no duplicate" every time. The script now refuses to emit
-- any function that still reads or writes the document. Converted, the guard
-- is STRONGER than it was — canteen_transactions has a primary key and an
-- index, and its rows outlive any one document save.
--
-- record_canteen_sale_inventory is deliberately absent: it locks the document
-- but touches only inventory, never an account.

CREATE OR REPLACE FUNCTION public.credit_canteen_balance_from_processor(
    p_camp_id                  uuid,
    p_camper_name              text,
    p_amount                   numeric,
    p_processor_key            text,
    p_external_transaction_id  text,
    p_source                   text DEFAULT 'parent'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_locked_acct jsonb;
    v_value      jsonb;
    v_bal        numeric;
    v_already    boolean;
    v_roster_ok  boolean;
    v_is_auto    boolean := (p_source = 'autoreload');
    v_items      text;
    v_kind       text;
    now_ts       timestamptz := now();
BEGIN
    IF p_camp_id IS NULL OR p_camper_name IS NULL OR btrim(p_camper_name) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_params');
    END IF;
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_amount');
    END IF;
    IF p_external_transaction_id IS NULL OR btrim(p_external_transaction_id) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_transaction_id');
    END IF;


    -- 219: one camper's row, not the camp's document.
    v_value := NULL::jsonb;  -- document no longer read
    v_locked_acct := public.canteen_account_lock(p_camp_id, p_camper_name);


    SELECT EXISTS (
        SELECT 1 FROM canteen_transactions t
         WHERE t.camp_id = p_camp_id AND t.payload->>'byopTransactionId' = p_external_transaction_id
    ) INTO v_already;
    IF v_already THEN
        RETURN jsonb_build_object(
            'success', true, 'alreadyProcessed', true,
            'balance', COALESCE((v_locked_acct->>'balance')::numeric, 0)
        );
    END IF;

    -- Defense-in-depth roster check (same as migration 132).
    SELECT (value->'app1'->'camperRoster' ? p_camper_name) INTO v_roster_ok
    FROM camp_state_kv WHERE camp_id = p_camp_id AND key = 'app1';
    v_roster_ok := COALESCE(v_roster_ok, false);

    v_bal := round(COALESCE((v_locked_acct->>'balance')::numeric, 0) + p_amount, 2);

    PERFORM public.canteen_account_save(p_camp_id, p_camper_name,
        COALESCE(v_locked_acct, '{"dailyLimit":10,"spentToday":0}'::jsonb)
            || jsonb_build_object('balance', v_bal));

    v_items := CASE WHEN v_is_auto THEN 'Auto-reload top-up' ELSE 'Funds added by parent (online)' END;
    v_kind  := CASE WHEN v_is_auto THEN 'autoreload' ELSE 'deposit' END;

    PERFORM public.canteen_post(p_camp_id, p_camper_name,
        jsonb_build_object(
            'time',   to_char(now_ts, 'HH12:MI AM'),
            'camper', p_camper_name,
            'items',  v_items,
            'amount', p_amount,
            'type',   'credit',
            'kind',   v_kind,
            'method', p_processor_key,
            'date',   to_char(now_ts, 'YYYY-MM-DD'),
            'byopTransactionId', p_external_transaction_id,
            'timestamp', (extract(epoch from now_ts) * 1000)::bigint
        ));


    RETURN jsonb_build_object('success', true, 'balance', v_bal, 'rosterVerified', v_roster_ok);
END;
$$;

CREATE OR REPLACE FUNCTION public.credit_canteen_balance_from_stripe(
    p_camp_id            uuid,
    p_camper_name        text,
    p_amount             numeric,
    p_payment_intent_id  text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_locked_acct jsonb;
    v_value      jsonb;
    v_bal        numeric;
    v_already    boolean;
    v_roster_ok  boolean;
    now_ts       timestamptz := now();
BEGIN
    IF p_camp_id IS NULL OR p_camper_name IS NULL OR btrim(p_camper_name) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_params');
    END IF;
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_amount');
    END IF;
    IF p_payment_intent_id IS NULL OR btrim(p_payment_intent_id) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_payment_intent');
    END IF;


    -- 219: one camper's row, not the camp's document.
    v_value := NULL::jsonb;  -- document no longer read
    v_locked_acct := public.canteen_account_lock(p_camp_id, p_camper_name);


    -- Idempotency: has this exact PaymentIntent already been credited?
    SELECT EXISTS (
        SELECT 1 FROM canteen_transactions t
         WHERE t.camp_id = p_camp_id AND t.payload->>'stripePaymentIntentId' = p_payment_intent_id
    ) INTO v_already;
    IF v_already THEN
        RETURN jsonb_build_object(
            'success', true, 'alreadyProcessed', true,
            'balance', COALESCE((v_locked_acct->>'balance')::numeric, 0)
        );
    END IF;

    -- Defense-in-depth roster check -- the real gate is in stripe-checkout
    -- (campOwnsCamper, checked BEFORE the Checkout Session is even created).
    -- By the time this RPC runs, Stripe has already captured real money, so
    -- a missing roster match is logged (rosterVerified:false) for office
    -- follow-up rather than refused -- refusing here would strand captured
    -- money with nowhere to go.
    SELECT (value->'app1'->'camperRoster' ? p_camper_name) INTO v_roster_ok
    FROM camp_state_kv WHERE camp_id = p_camp_id AND key = 'app1';
    v_roster_ok := COALESCE(v_roster_ok, false);

    v_bal := round(COALESCE((v_locked_acct->>'balance')::numeric, 0) + p_amount, 2);

    PERFORM public.canteen_account_save(p_camp_id, p_camper_name,
        COALESCE(v_locked_acct, '{"dailyLimit":10,"spentToday":0}'::jsonb)
            || jsonb_build_object('balance', v_bal));

    PERFORM public.canteen_post(p_camp_id, p_camper_name,
        jsonb_build_object(
            'time',   to_char(now_ts, 'HH12:MI AM'),
            'camper', p_camper_name,
            'items',  'Funds added by parent (online)',
            'amount', p_amount,
            'type',   'credit',
            'kind',   'deposit',
            'method', 'stripe',
            'date',   to_char(now_ts, 'YYYY-MM-DD'),
            'stripePaymentIntentId', p_payment_intent_id,
            'timestamp', (extract(epoch from now_ts) * 1000)::bigint
        ));


    RETURN jsonb_build_object('success', true, 'balance', v_bal, 'rosterVerified', v_roster_ok);
END;
$$;

CREATE OR REPLACE FUNCTION public.merge_canteen_autoreload_card(
    p_camp_id          uuid,
    p_camper           text,
    p_fields           jsonb,
    p_require_existing boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_locked_acct jsonb;
    now_ts    timestamptz := now();
    v_snacks  jsonb;
    v_accts   jsonb;
    v_acct    jsonb;
    v_ar      jsonb;
    v_created boolean := false;
BEGIN
    IF p_camp_id IS NULL OR COALESCE(p_camper, '') = ''
       OR p_fields IS NULL OR jsonb_typeof(p_fields) <> 'object' THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_arguments');
    END IF;

    -- A camp that has never opened the canteen has no row yet, and a parent can
    -- still save a card first. Same shape the handler created by hand. Not
    -- created when the caller requires an existing camper — there would be
    -- nothing to attach the card to anyway.
    IF NOT p_require_existing THEN
    END IF;

    -- 219: one camper's row, not the camp's document.
    v_snacks := NULL::jsonb;  -- document no longer read
    v_locked_acct := public.canteen_account_lock(p_camp_id, p_camper);
    IF v_snacks IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_camp_data');
    END IF;
    IF jsonb_typeof(v_snacks) <> 'object' THEN
        v_snacks := '{"accounts":{},"transactions":[]}'::jsonb;
    END IF;

    v_accts := jsonb_build_object(p_camper, COALESCE(v_locked_acct, '{}'::jsonb));
    IF jsonb_typeof(v_accts) <> 'object' THEN v_accts := '{}'::jsonb; END IF;

    -- balance 0 on a brand-new account is not an opening figure, it is the sum
    -- of no transactions — the ledger is the source of truth (_reconcileBalances
    -- recomputes it), so this can never be anything else.
    v_acct := v_accts->p_camper;
    IF v_acct IS NULL OR jsonb_typeof(v_acct) <> 'object' THEN
        IF p_require_existing THEN
            RETURN jsonb_build_object('success', false, 'error', 'camper_not_found');
        END IF;
        v_acct := '{"balance":0,"dailyLimit":10,"spentToday":0}'::jsonb;
        v_created := true;
    END IF;

    v_ar := COALESCE(v_acct->'autoReload', '{}'::jsonb);
    IF jsonb_typeof(v_ar) <> 'object' THEN v_ar := '{}'::jsonb; END IF;

    v_acct   := jsonb_set(v_acct, '{autoReload}', v_ar || p_fields, true);
    PERFORM public.canteen_account_save(p_camp_id, p_camper,
        v_acct);


    RETURN jsonb_build_object('success', true, 'camper', p_camper, 'created', v_created);
END;
$$;

CREATE OR REPLACE FUNCTION public.refund_canteen_deposit_from_processor(
    p_camp_id                     uuid,
    p_camper_name                  text,
    p_amount                       numeric,
    p_processor_key                text,
    p_external_transaction_id      text,
    p_refund_external_id           text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_locked_acct jsonb;
    v_value    jsonb;
    v_bal      numeric;
    v_already  boolean;
    now_ts     timestamptz := now();
BEGIN
    IF p_camp_id IS NULL OR p_camper_name IS NULL OR btrim(p_camper_name) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_params');
    END IF;
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_amount');
    END IF;
    IF p_refund_external_id IS NULL OR btrim(p_refund_external_id) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_refund_id');
    END IF;

    -- 219: one camper's row, not the camp's document.
    v_value := NULL::jsonb;  -- document no longer read
    v_locked_acct := public.canteen_account_lock(p_camp_id, p_camper_name);

    IF v_value IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_canteen_data');
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM canteen_transactions t
         WHERE t.camp_id = p_camp_id AND t.payload->>'byopRefundId' = p_refund_external_id
    ) INTO v_already;
    IF v_already THEN
        RETURN jsonb_build_object(
            'success', true, 'alreadyProcessed', true,
            'balance', COALESCE((v_locked_acct->>'balance')::numeric, 0)
        );
    END IF;

    v_bal := round(COALESCE((v_locked_acct->>'balance')::numeric, 0) - p_amount, 2);

    PERFORM public.canteen_account_save(p_camp_id, p_camper_name,
        COALESCE(v_locked_acct, '{"dailyLimit":10,"spentToday":0}'::jsonb)
            || jsonb_build_object('balance', v_bal));

    PERFORM public.canteen_post(p_camp_id, p_camper_name,
        jsonb_build_object(
            'time',   to_char(now_ts, 'HH12:MI AM'),
            'camper', p_camper_name,
            'items',  'Refund — deposit reversed',
            'amount', p_amount,
            'type',   'debit',
            'kind',   'refund',
            'method', p_processor_key,
            'date',   to_char(now_ts, 'YYYY-MM-DD'),
            'byopTransactionId', p_external_transaction_id,
            'byopRefundId', p_refund_external_id,
            'timestamp', (extract(epoch from now_ts) * 1000)::bigint
        ));


    RETURN jsonb_build_object('success', true, 'balance', v_bal);
END;
$$;

CREATE OR REPLACE FUNCTION public.refund_canteen_deposit_from_stripe(
    p_camp_id            uuid,
    p_camper_name        text,
    p_amount             numeric,
    p_payment_intent_id  text,
    p_refund_id          text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_locked_acct jsonb;
    v_value    jsonb;
    v_bal      numeric;
    v_already  boolean;
    now_ts     timestamptz := now();
BEGIN
    IF p_camp_id IS NULL OR p_camper_name IS NULL OR btrim(p_camper_name) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_params');
    END IF;
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_amount');
    END IF;
    IF p_refund_id IS NULL OR btrim(p_refund_id) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_refund_id');
    END IF;

    -- 219: one camper's row, not the camp's document.
    v_value := NULL::jsonb;  -- document no longer read
    v_locked_acct := public.canteen_account_lock(p_camp_id, p_camper_name);

    IF v_value IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_canteen_data');
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM canteen_transactions t
         WHERE t.camp_id = p_camp_id AND t.payload->>'stripeRefundId' = p_refund_id
    ) INTO v_already;
    IF v_already THEN
        RETURN jsonb_build_object(
            'success', true, 'alreadyProcessed', true,
            'balance', COALESCE((v_locked_acct->>'balance')::numeric, 0)
        );
    END IF;

    v_bal := round(COALESCE((v_locked_acct->>'balance')::numeric, 0) - p_amount, 2);

    PERFORM public.canteen_account_save(p_camp_id, p_camper_name,
        COALESCE(v_locked_acct, '{"dailyLimit":10,"spentToday":0}'::jsonb)
            || jsonb_build_object('balance', v_bal));

    PERFORM public.canteen_post(p_camp_id, p_camper_name,
        jsonb_build_object(
            'time',   to_char(now_ts, 'HH12:MI AM'),
            'camper', p_camper_name,
            'items',  'Refund — deposit reversed',
            'amount', p_amount,
            'type',   'debit',
            'kind',   'refund',
            'method', 'stripe',
            'date',   to_char(now_ts, 'YYYY-MM-DD'),
            'stripePaymentIntentId', p_payment_intent_id,
            'stripeRefundId', p_refund_id,
            'timestamp', (extract(epoch from now_ts) * 1000)::bigint
        ));


    RETURN jsonb_build_object('success', true, 'balance', v_bal);
END;
$$;

CREATE OR REPLACE FUNCTION public.set_canteen_auto_reload(
    p_camp_id     uuid,
    p_camper_name text,
    p_config      jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_locked_acct jsonb;
    caller       uuid := auth.uid();
    inv          link_parent_invites;
    v_value      jsonb;
    v_acct       jsonb;
    v_ar         jsonb;
    v_enabled    boolean;
    v_th_enabled boolean;
    v_th_amount  numeric;
    v_th_reload  numeric;
    v_sc_enabled boolean;
    v_sc_freq    text;
    v_sc_day     int;
    v_sc_reload  numeric;
    v_start_date text;
    v_stop_date  text;
    v_max_per_period  int;
    v_period_days     int;
    now_ts       timestamptz := now();
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF p_camper_name IS NULL OR btrim(p_camper_name) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_camper');
    END IF;
    IF p_config IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_config');
    END IF;

    v_enabled    := COALESCE((p_config->>'enabled')::boolean, false);
    v_th_enabled := COALESCE((p_config->>'thresholdEnabled')::boolean, false);
    v_th_amount  := (p_config->>'thresholdAmount')::numeric;
    v_th_reload  := (p_config->>'thresholdReloadAmount')::numeric;
    v_sc_enabled := COALESCE((p_config->>'scheduleEnabled')::boolean, false);
    v_sc_freq    := p_config->>'scheduleFrequency';
    v_sc_day     := (p_config->>'scheduleDay')::int;
    v_sc_reload  := (p_config->>'scheduleReloadAmount')::numeric;
    v_start_date := NULLIF(btrim(COALESCE(p_config->>'startDate', '')), '');
    v_stop_date  := NULLIF(btrim(COALESCE(p_config->>'stopDate', '')), '');
    v_max_per_period := COALESCE((p_config->>'maxReloadsPerPeriod')::int, 1);
    v_period_days    := COALESCE((p_config->>'reloadPeriodDays')::int, 1);

    -- Validation -- same sane-bounds philosophy as set_canteen_limits (a bad
    -- client can't set nonsense). Reload amounts capped at $500/trigger,
    -- matching the existing $1-$500 manual-deposit range noted in migration 079.
    IF v_enabled AND NOT v_th_enabled AND NOT v_sc_enabled THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_trigger_selected');
    END IF;
    IF v_th_enabled AND (v_th_amount IS NULL OR v_th_amount < 0 OR v_th_amount > 1000) THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_threshold_amount');
    END IF;
    IF v_th_enabled AND (v_th_reload IS NULL OR v_th_reload <= 0 OR v_th_reload > 500) THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_threshold_reload_amount');
    END IF;
    IF v_sc_enabled AND v_sc_freq NOT IN ('weekly', 'monthly') THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_schedule_frequency');
    END IF;
    IF v_sc_enabled AND v_sc_freq = 'weekly' AND (v_sc_day IS NULL OR v_sc_day < 0 OR v_sc_day > 6) THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_schedule_day');
    END IF;
    IF v_sc_enabled AND v_sc_freq = 'monthly' AND (v_sc_day IS NULL OR v_sc_day < 1 OR v_sc_day > 28) THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_schedule_day');
    END IF;
    IF v_sc_enabled AND (v_sc_reload IS NULL OR v_sc_reload <= 0 OR v_sc_reload > 500) THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_schedule_reload_amount');
    END IF;
    IF v_start_date IS NOT NULL AND v_start_date !~ '^\d{4}-\d{2}-\d{2}$' THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_start_date');
    END IF;
    IF v_stop_date IS NOT NULL AND v_stop_date !~ '^\d{4}-\d{2}-\d{2}$' THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_stop_date');
    END IF;
    -- Confirms each is a real calendar date (regex above only checks shape).
    BEGIN
        IF v_start_date IS NOT NULL THEN PERFORM v_start_date::date; END IF;
        IF v_stop_date IS NOT NULL THEN PERFORM v_stop_date::date; END IF;
    EXCEPTION WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_date');
    END;
    IF v_start_date IS NOT NULL AND v_stop_date IS NOT NULL AND v_start_date::date > v_stop_date::date THEN
        RETURN jsonb_build_object('success', false, 'error', 'start_after_stop');
    END IF;
    IF v_max_per_period < 1 OR v_max_per_period > 20 THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_max_reloads_per_period');
    END IF;
    IF v_period_days < 1 OR v_period_days > 90 THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_reload_period_days');
    END IF;

    SELECT * INTO inv
    FROM link_parent_invites
    WHERE user_id = caller AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
      AND (p_camp_id IS NULL OR camp_id = p_camp_id)
    ORDER BY created_at DESC
    LIMIT 1;
    IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'no_active_invite'); END IF;

    IF inv.camper_names IS NOT NULL AND NOT (inv.camper_names ? p_camper_name) THEN
        RETURN jsonb_build_object('success', false, 'error', 'camper_not_on_invite');
    END IF;


    -- 219: one camper's row, not the camp's document.
    v_value := NULL::jsonb;  -- document no longer read
    v_locked_acct := public.canteen_account_lock(inv.camp_id, p_camper_name);

    v_acct := COALESCE(v_locked_acct, '{"balance":0,"dailyLimit":10,"spentToday":0}'::jsonb);
    v_ar   := COALESCE(v_acct->'autoReload', '{}'::jsonb);
    v_ar   := v_ar || jsonb_build_object(
        'enabled', v_enabled,
        'thresholdEnabled', v_th_enabled,
        'thresholdAmount', v_th_amount,
        'thresholdReloadAmount', v_th_reload,
        'scheduleEnabled', v_sc_enabled,
        'scheduleFrequency', v_sc_freq,
        'scheduleDay', v_sc_day,
        'scheduleReloadAmount', v_sc_reload,
        'startDate', v_start_date,
        'stopDate', v_stop_date,
        'maxReloadsPerPeriod', v_max_per_period,
        'reloadPeriodDays', v_period_days
    );
    -- Re-enabling clears a prior auto-disable-on-failures state -- a parent
    -- who just fixed/updated their card gets a clean slate, not an
    -- immediate re-disable on the next cron run's stale failure count.
    IF v_enabled THEN
        v_ar := (v_ar - 'lastFailureDate') - 'lastFailureReason';
        v_ar := jsonb_set(v_ar, '{consecutiveFailures}', '0'::jsonb, true);
    END IF;

    v_acct  := jsonb_set(v_acct, '{autoReload}', v_ar, true);
    PERFORM public.canteen_account_save(inv.camp_id, p_camper_name,
        v_acct);

    RETURN jsonb_build_object(
        'success', true,
        'autoReload', v_ar,
        'cardOnFile', COALESCE((v_ar->>'cardOnFile')::boolean, false)
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.set_canteen_limits(
    p_camper_name   text,
    p_daily_limit   numeric DEFAULT NULL,
    p_credit_limit  numeric DEFAULT NULL,
    p_balance_floor numeric DEFAULT NULL,
    p_camp_id       uuid    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_locked_acct jsonb;
    caller  uuid := auth.uid();
    inv     link_parent_invites;
    v_value jsonb;
    v_acct  jsonb;
    now_ts  timestamptz := now();
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF p_camper_name IS NULL OR btrim(p_camper_name) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_camper');
    END IF;
    -- Clamp to sane, non-negative bounds so a bad client can't set nonsense.
    IF p_daily_limit   IS NOT NULL AND (p_daily_limit   < 0 OR p_daily_limit   > 1000) THEN RETURN jsonb_build_object('success', false, 'error', 'bad_daily_limit');   END IF;
    IF p_credit_limit  IS NOT NULL AND (p_credit_limit  < 0 OR p_credit_limit  > 1000) THEN RETURN jsonb_build_object('success', false, 'error', 'bad_credit_limit');  END IF;
    IF p_balance_floor IS NOT NULL AND (p_balance_floor < 0 OR p_balance_floor > 1000) THEN RETURN jsonb_build_object('success', false, 'error', 'bad_balance_floor'); END IF;

    SELECT * INTO inv
    FROM link_parent_invites
    WHERE user_id = caller AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
      AND (p_camp_id IS NULL OR camp_id = p_camp_id)
    ORDER BY created_at DESC
    LIMIT 1;
    IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'no_active_invite'); END IF;

    IF inv.camper_names IS NOT NULL AND NOT (inv.camper_names ? p_camper_name) THEN
        RETURN jsonb_build_object('success', false, 'error', 'camper_not_on_invite');
    END IF;


    -- 219: one camper's row, not the camp's document.
    v_value := NULL::jsonb;  -- document no longer read
    v_locked_acct := public.canteen_account_lock(inv.camp_id, p_camper_name);

    v_acct := COALESCE(v_locked_acct, '{"balance":0,"dailyLimit":10,"spentToday":0}'::jsonb);
    IF p_daily_limit   IS NOT NULL THEN v_acct := jsonb_set(v_acct, '{dailyLimit}',   to_jsonb(p_daily_limit));   END IF;
    IF p_credit_limit  IS NOT NULL THEN v_acct := jsonb_set(v_acct, '{creditLimit}',  to_jsonb(p_credit_limit));  END IF;
    IF p_balance_floor IS NOT NULL THEN v_acct := jsonb_set(v_acct, '{balanceFloor}', to_jsonb(p_balance_floor)); END IF;

    PERFORM public.canteen_account_save(inv.camp_id, p_camper_name,
        v_acct);

    RETURN jsonb_build_object('success', true,
        'dailyLimit',   v_acct->>'dailyLimit',
        'creditLimit',  v_acct->>'creditLimit',
        'balanceFloor', v_acct->>'balanceFloor');
END;
$$;

CREATE OR REPLACE FUNCTION public.settle_shop_order(
    p_camp_id     uuid,
    p_order_id    text,
    p_pay_method  text,
    p_total       numeric,
    p_cancelled   boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_locked_acct jsonb;
    now_ts       timestamptz := now();
    v_role       text;
    v_shop       jsonb;
    v_snacks     jsonb;
    v_me         jsonb;
    v_orders     jsonb;
    v_order      jsonb := NULL;
    v_idx        integer := NULL;
    i            integer;
    v_camper     text;
    v_famKey     text := NULL;
    v_cur_method text := 'none';
    v_cur_amt    numeric := 0;
    v_new_method text;
    v_new_amt    numeric;
    v_delta      numeric;
    v_bal        numeric;
    v_charges    jsonb;
    v_kept       jsonb;
    c            jsonb;
    v_chargeId   text;
BEGIN
    IF p_camp_id IS NULL OR p_camp_id <> get_user_camp_id() THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;
    v_role := get_user_role();
    IF v_role IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    v_new_method := CASE WHEN p_cancelled THEN 'none' ELSE COALESCE(p_pay_method, 'none') END;
    v_new_amt    := CASE WHEN p_cancelled THEN 0 ELSE round(COALESCE(p_total, 0), 2) END;
    IF v_new_amt < 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'negative_total');
    END IF;

    -- ── find the order ─────────────────────────────────────────────────────
    -- ── LOCK ORDER: campistryShop -> campistrySnacks -> campistryMe ────────
    -- Every SELECT below takes FOR UPDATE and holds it to the end of the
    -- function, because all three writes are read-modify-write on a JSONB blob.
    -- Without the lock two concurrent settlements — or a settlement racing a
    -- POS sale or a parent deposit — both read the same ledger, both append
    -- their own row, and the second write silently discards the first. The
    -- canteen balance is RECOMPUTED from that ledger, so a lost transaction is
    -- lost money, not just a lost audit line.
    --
    -- The ORDER is load-bearing and matches migration 122's place_shop_order
    -- (Shop then Snacks). Two functions taking the same two locks in opposite
    -- orders deadlock; keep any new writer on this order.
    SELECT value INTO v_shop FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryShop'
     FOR UPDATE;
    IF v_shop IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_shop_data');
    END IF;
    v_orders := COALESCE(v_shop->'orders', '[]'::jsonb);

    FOR i IN 0 .. jsonb_array_length(v_orders) - 1 LOOP
        IF v_orders->i->>'id' = p_order_id THEN
            v_order := v_orders->i;
            v_idx := i;
            EXIT;
        END IF;
    END LOOP;
    IF v_order IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'order_not_found');
    END IF;

    v_camper := COALESCE(v_order->>'camperName', '');
    IF v_order->'settlement' IS NOT NULL AND v_order->'settlement' <> 'null'::jsonb THEN
        v_cur_method := COALESCE(v_order->'settlement'->>'method', 'none');
        v_cur_amt    := round(COALESCE((v_order->'settlement'->>'amount')::numeric, 0), 2);
    END IF;

    -- Nothing to do. This is the common case on a re-save and it must be free
    -- of side effects, or every edit to an unrelated field re-posts money.
    IF v_cur_method = v_new_method AND v_cur_amt = v_new_amt THEN
        RETURN jsonb_build_object('success', true, 'unchanged', true,
                                  'method', v_cur_method, 'amount', v_cur_amt);
    END IF;

    -- Posting to the family's bill writes campistryMe, which is a billing
    -- action — a counselor running the shop must not be able to do it. The
    -- canteen path stays open to them, because taking canteen payment IS the
    -- job. (RLS is bypassed here by SECURITY DEFINER, so this check is the
    -- boundary, not a convenience.)
    IF (v_new_method = 'bill' OR v_cur_method = 'bill')
       AND v_role NOT IN ('owner', 'admin', 'manager') THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized_for_billing');
    END IF;

    -- ── canteen ────────────────────────────────────────────────────────────
    IF v_cur_method = 'canteen' OR v_new_method = 'canteen' THEN
    -- 219: one camper's row, not the camp's document.
    v_snacks := NULL::jsonb;  -- document no longer read
    v_locked_acct := public.canteen_account_lock(p_camp_id, v_camper);
        IF v_snacks IS NULL THEN v_snacks := '{}'::jsonb; END IF;

        -- How much MORE to take. Same method: just the difference. Method
        -- changed away from canteen: give all of it back. Changed to canteen:
        -- take the whole new amount.
        v_delta := (CASE WHEN v_new_method = 'canteen' THEN v_new_amt ELSE 0 END)
                 - (CASE WHEN v_cur_method = 'canteen' THEN v_cur_amt ELSE 0 END);

        IF v_delta <> 0 AND v_camper <> '' THEN
            v_bal := round(COALESCE((v_locked_acct->>'balance')::numeric, 0)
                           - v_delta, 2);
    PERFORM public.canteen_account_save(p_camp_id, v_camper,
        COALESCE(v_locked_acct, '{"dailyLimit":10,"spentToday":0}'::jsonb)
                    || jsonb_build_object('balance', v_bal));

            -- Append-only, because _reconcileBalances rebuilds every balance
            -- from this ledger. A positive delta is a debit; a negative one is
            -- money going back, which is a credit.
    PERFORM public.canteen_post(p_camp_id, v_camper,
        jsonb_build_object(
                    'time',   to_char(now_ts, 'HH12:MI AM'),
                    'camper', v_camper,
                    'items',  CASE WHEN v_delta > 0 THEN 'Camp Shop order'
                                   ELSE 'Camp Shop order — reversed' END,
                    'amount', abs(v_delta),
                    'type',   CASE WHEN v_delta > 0 THEN 'debit' ELSE 'credit' END,
                    'kind',   'shop',
                    'date',   to_char(now_ts, 'YYYY-MM-DD'),
                    'shopOrderId', p_order_id,
                    'timestamp', (extract(epoch from now_ts) * 1000)::bigint
                ));

        END IF;
    END IF;

    -- ── camp bill ──────────────────────────────────────────────────────────
    IF v_cur_method = 'bill' OR v_new_method = 'bill' THEN
        SELECT value INTO v_me FROM camp_state_kv
         WHERE camp_id = p_camp_id AND key = 'campistryMe';
        IF v_me IS NULL THEN v_me := '{}'::jsonb; END IF;

        -- Whose family? Resolved here rather than trusted from the client:
        -- the camper's membership is what decides who gets billed.
        SELECT f.key INTO v_famKey
          FROM jsonb_each(public.camp_families_object(p_camp_id)) f
         WHERE EXISTS (
             SELECT 1 FROM jsonb_array_elements_text(
                 COALESCE(f.value->'camperIds', '[]'::jsonb)) ci
              WHERE ci = v_camper)
         ORDER BY f.key
         LIMIT 1;

        IF v_famKey IS NULL AND v_new_method = 'bill' THEN
            -- No family to bill. Refuse rather than silently dropping the
            -- charge — an unbilled sweatshirt is the bug being fixed.
            RETURN jsonb_build_object('success', false, 'error', 'no_family_for_camper',
                'detail', 'No family record lists ' || v_camper ||
                          '. Add them to a family before charging the camp bill.');
        END IF;

        IF v_famKey IS NOT NULL THEN
            v_chargeId := 'shop_' || p_order_id;
            v_charges  := COALESCE(public.camp_family_for_update(p_camp_id, v_famKey, 'charges'), '[]'::jsonb);

            -- Drop any previous charge for this order, then re-add at the new
            -- amount. A SET, not an append — re-settling must replace, never
            -- stack a second sweatshirt onto the family's balance.
            v_kept := '[]'::jsonb;
            FOR c IN SELECT * FROM jsonb_array_elements(v_charges) LOOP
                IF COALESCE(c->>'id', '') <> v_chargeId THEN
                    v_kept := v_kept || jsonb_build_array(c);
                END IF;
            END LOOP;

            IF v_new_method = 'bill' AND v_new_amt > 0 THEN
                v_kept := v_kept || jsonb_build_array(jsonb_build_object(
                    'id',          v_chargeId,
                    'category',    'Camp Shop',
                    'description', 'Camp Shop order' ||
                                   CASE WHEN v_camper <> '' THEN ' — ' || v_camper ELSE '' END,
                    'amount',      v_new_amt,
                    'date',        to_char(now_ts, 'YYYY-MM-DD'),
                    'shopOrderId', p_order_id,
                    'timestamp',   (extract(epoch from now_ts) * 1000)::bigint
                ));
            END IF;

            PERFORM public.camp_family_save(p_camp_id, v_famKey, 'charges', v_kept);
        END IF;
    END IF;

    -- ── record what was taken ──────────────────────────────────────────────
    v_order := v_order || jsonb_build_object(
        'settlement', jsonb_build_object(
            'method',   v_new_method,
            'amount',   v_new_amt,
            'familyKey', v_famKey,
            'at',       to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
        -- 'paid' means the money is actually in. Cash/cheque/card are collected
        -- outside Campistry, so the office ticks those by hand; the two methods
        -- this function settles are paid by definition once posted.
        'paid', CASE WHEN v_new_method IN ('canteen', 'bill') THEN true
                     ELSE COALESCE((v_order->>'paid')::boolean, false) END
    );

    v_shop := jsonb_set(v_shop, ARRAY['orders', v_idx::text], v_order, true);
    UPDATE camp_state_kv SET value = v_shop, updated_at = now_ts
     WHERE camp_id = p_camp_id AND key = 'campistryShop';

    RETURN jsonb_build_object('success', true,
        'method', v_new_method, 'amount', v_new_amt,
        'previousMethod', v_cur_method, 'previousAmount', v_cur_amt,
        'familyKey', v_famKey, 'balance', v_bal);
END;
$$;

CREATE OR REPLACE FUNCTION public.submit_canteen_deposit(
    p_camper_name text,
    p_amount      numeric,
    p_camp_id     uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_locked_acct jsonb;
    caller  uuid := auth.uid();
    inv     link_parent_invites;
    v_value jsonb;
    v_bal   numeric;
    now_ts  timestamptz := now();
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF p_camper_name IS NULL OR btrim(p_camper_name) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_camper');
    END IF;
    IF p_amount IS NULL OR p_amount < 1 OR p_amount > 500 THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_amount');
    END IF;

    SELECT * INTO inv
    FROM link_parent_invites
    WHERE user_id = caller
      AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
      AND (p_camp_id IS NULL OR camp_id = p_camp_id)
    ORDER BY created_at DESC
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;

    IF inv.camper_names IS NOT NULL AND NOT (inv.camper_names ? p_camper_name) THEN
        RETURN jsonb_build_object('success', false, 'error', 'camper_not_on_invite');
    END IF;


    -- 219: one camper's row, not the camp's document.
    v_value := NULL::jsonb;  -- document no longer read
    v_locked_acct := public.canteen_account_lock(inv.camp_id, p_camper_name);


    v_bal := round(COALESCE((v_locked_acct->>'balance')::numeric, 0) + p_amount, 2);

    PERFORM public.canteen_account_save(inv.camp_id, p_camper_name,
        COALESCE(v_locked_acct, '{"dailyLimit":10,"spentToday":0}'::jsonb)
            || jsonb_build_object('balance', v_bal));

    PERFORM public.canteen_post(inv.camp_id, p_camper_name,
        jsonb_build_object(
            'time',   to_char(now_ts, 'HH12:MI AM'),
            'camper', p_camper_name,
            'items',  'Funds added by parent',
            'amount', p_amount,
            'type',   'credit',
            'date',   to_char(now_ts, 'YYYY-MM-DD')
        ));


    RETURN jsonb_build_object('success', true, 'balance', v_bal);
END;
$$;

CREATE OR REPLACE FUNCTION public.submit_canteen_purchase(
    p_camp_id     uuid,
    p_camper_name text,
    p_amount      numeric,
    p_items       text DEFAULT '',
    p_date        date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_locked_acct jsonb;
    caller     uuid := auth.uid();
    is_staff   boolean;
    v_value    jsonb;
    v_acct     jsonb;
    v_ar       jsonb;
    v_balance  numeric;
    v_daily    numeric;
    v_spent    numeric;
    v_credit   numeric;
    v_floor    numeric;
    v_lastdate text;
    v_today    text := COALESCE(p_date, (now() AT TIME ZONE 'utc')::date)::text;
    v_utc_today text := (now() AT TIME ZONE 'utc')::date::text;
    v_spendable numeric;
    v_needs_reload_check boolean := false;
    now_ts     timestamptz := now();
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    IF p_camp_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'missing_camp'); END IF;
    IF p_camper_name IS NULL OR btrim(p_camper_name) = '' THEN RETURN jsonb_build_object('success', false, 'error', 'missing_camper'); END IF;
    IF p_amount IS NULL OR p_amount <= 0 OR p_amount > 1000 THEN RETURN jsonb_build_object('success', false, 'error', 'invalid_amount'); END IF;

    -- Only camp staff (owner/admin/scheduler/counselor) may charge a register.
    SELECT (p_camp_id = caller
            OR EXISTS (SELECT 1 FROM camps c WHERE c.id = p_camp_id AND c.owner = caller)
            OR EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = p_camp_id AND u.user_id = caller))
      INTO is_staff;
    IF NOT is_staff THEN RETURN jsonb_build_object('success', false, 'error', 'not_authorized'); END IF;


    -- 219: one camper's row, not the camp's document.
    v_value := NULL::jsonb;  -- document no longer read
    v_locked_acct := public.canteen_account_lock(p_camp_id, p_camper_name);

    v_acct    := COALESCE(v_locked_acct, '{"balance":0,"dailyLimit":10,"spentToday":0}'::jsonb);
    v_balance := COALESCE((v_acct->>'balance')::numeric, 0);
    v_daily   := COALESCE((v_acct->>'dailyLimit')::numeric, 10);
    v_spent   := COALESCE((v_acct->>'spentToday')::numeric, 0);
    v_credit  := COALESCE((v_acct->>'creditLimit')::numeric, 0);
    v_floor   := COALESCE((v_acct->>'balanceFloor')::numeric, 0);
    v_lastdate := v_acct->>'lastSpendDate';

    -- New day → reset the daily counter before checking the cap.
    IF v_lastdate IS DISTINCT FROM v_today THEN v_spent := 0; END IF;

    -- HARD CAP 1: daily spending limit (0 or absent = no daily cap).
    IF v_daily > 0 AND (v_spent + p_amount) > v_daily THEN
        RETURN jsonb_build_object('success', false, 'error', 'daily_limit_exceeded',
            'dailyLimit', v_daily, 'spentToday', v_spent, 'remaining', GREATEST(v_daily - v_spent, 0));
    END IF;

    -- HARD CAP 2: spendable = balance - floor + credit (overdraft allowance).
    v_spendable := v_balance - v_floor + v_credit;
    IF p_amount > v_spendable THEN
        RETURN jsonb_build_object('success', false, 'error', 'insufficient_balance',
            'spendable', v_spendable, 'balance', v_balance);
    END IF;

    -- Passed both caps → commit atomically.
    v_balance := round(v_balance - p_amount, 2);
    v_spent   := round(v_spent + p_amount, 2);
    v_acct := v_acct
        || jsonb_build_object('balance', v_balance, 'spentToday', v_spent, 'lastSpendDate', v_today);
    PERFORM public.canteen_account_save(p_camp_id, p_camper_name,
        v_acct);

    PERFORM public.canteen_post(p_camp_id, p_camper_name,
        jsonb_build_object(
            'time',   to_char(now_ts, 'HH12:MI AM'),
            'camper', p_camper_name,
            'items',  COALESCE(p_items, ''),
            'amount', p_amount,
            'type',   'debit',
            'date',   v_today
        ));


    -- Cheap pre-check only — see header comment. The Edge Function is the
    -- sole authority on whether a charge actually fires. lastChargedDate is
    -- compared in UTC (v_utc_today), matching how canteen-auto-reload
    -- itself defines "today" — NOT v_today, which is local-time.
    v_ar := v_acct->'autoReload';
    IF v_ar IS NOT NULL
       AND (v_ar->>'enabled')::boolean IS TRUE
       AND (v_ar->>'cardOnFile')::boolean IS TRUE
       AND (v_ar->>'stripeCustomerId' IS NOT NULL OR v_ar->>'byopCustomerRef' IS NOT NULL)
       AND (v_ar->>'thresholdEnabled')::boolean IS TRUE
       AND (v_ar->>'thresholdAmount') IS NOT NULL
       AND v_balance < (v_ar->>'thresholdAmount')::numeric
       AND (v_ar->>'lastChargedDate') IS DISTINCT FROM v_utc_today
    THEN
        v_needs_reload_check := true;
    END IF;

    RETURN jsonb_build_object('success', true, 'balance', v_balance, 'spentToday', v_spent,
        'needsReloadCheck', v_needs_reload_check);
END;
$$;

CREATE OR REPLACE FUNCTION public.submit_shop_order(
    p_camper_name text,
    p_lines       jsonb,
    p_pay_method  text DEFAULT 'bill',
    p_notes       text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_locked_acct jsonb;
    caller     uuid := auth.uid();
    inv        link_parent_invites;
    v_shop     jsonb;
    v_snacks   jsonb;
    v_line     jsonb;
    v_product  jsonb;
    v_variant  text;
    v_qty      int;
    v_unit     numeric;
    v_delta    numeric;
    v_stock    int;
    v_backorder boolean;
    v_lines    jsonb := '[]'::jsonb;
    v_total    numeric := 0;
    v_count    int := 0;
    v_balance  numeric;
    v_order_id text;
    v_bunk     text;
    now_ts     timestamptz := now();
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF p_camper_name IS NULL OR btrim(p_camper_name) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_camper');
    END IF;
    IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'empty_order');
    END IF;
    IF jsonb_array_length(p_lines) > 40 THEN
        RETURN jsonb_build_object('success', false, 'error', 'too_many_lines');
    END IF;
    IF p_pay_method IS NULL OR p_pay_method NOT IN ('bill', 'canteen') THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_pay_method');
    END IF;

    SELECT * INTO inv
    FROM link_parent_invites
    WHERE user_id = caller AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
    ORDER BY created_at DESC
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;
    IF inv.camper_names IS NOT NULL AND NOT (inv.camper_names ? p_camper_name) THEN
        RETURN jsonb_build_object('success', false, 'error', 'camper_not_on_invite');
    END IF;

    -- NEW: this parent's connection to the camp ended (their last camper
    -- left) — no new canteen/bill order can be started, same rule as the
    -- program-disabled check right below.
    IF NOT inv.camp_connected THEN
        RETURN jsonb_build_object('success', false, 'error', 'camp_disconnected');
    END IF;

    -- Camp-wide "does this camp even run a Camp Shop" gate. Checked after
    -- the invite/camper-ownership checks above (so those keep taking
    -- priority) and before touching campistryShop at all.
    IF NOT public._link_program_enabled(inv.camp_id, 'shop') THEN
        RETURN jsonb_build_object('success', false, 'error', 'program_disabled');
    END IF;

    -- Guarantee a row exists, then lock it. Lock order is always
    -- campistryShop -> campistrySnacks (see security note 5).
    INSERT INTO camp_state_kv (camp_id, key, value, updated_at)
    VALUES (inv.camp_id, 'campistryShop', '{"products":[],"orders":[],"settings":{}}'::jsonb, now_ts)
    ON CONFLICT (camp_id, key) DO NOTHING;

    SELECT value INTO v_shop
    FROM camp_state_kv
    WHERE camp_id = inv.camp_id AND key = 'campistryShop'
    FOR UPDATE;

    IF v_shop IS NULL THEN v_shop := '{"products":[],"orders":[],"settings":{}}'::jsonb; END IF;
    v_backorder := COALESCE((v_shop->'settings'->>'parentAllowBackorder')::boolean, false);

    -- ── price and validate every line from the STORED catalogue ──
    FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
    LOOP
        v_qty := GREATEST(0, COALESCE((v_line->>'qty')::int, 0));
        CONTINUE WHEN v_qty = 0;
        IF v_qty > 50 THEN
            RETURN jsonb_build_object('success', false, 'error', 'qty_too_large');
        END IF;

        v_product := NULL;   -- explicit: never inherit the previous iteration's row
        SELECT p INTO v_product
        FROM jsonb_array_elements(COALESCE(v_shop->'products', '[]'::jsonb)) AS p
        WHERE p->>'id' = v_line->>'productId'
          AND COALESCE((p->>'active')::boolean, true) IS TRUE
        LIMIT 1;

        IF v_product IS NULL THEN
            RETURN jsonb_build_object('success', false, 'error', 'product_unavailable',
                                      'productId', v_line->>'productId');
        END IF;

        v_variant :=
            btrim(regexp_replace(lower(COALESCE(NULLIF(v_product->>'sku',''), v_product->>'id')), '[^a-z0-9]+', '-', 'g'), '-')
            || ':' ||
            btrim(regexp_replace(lower(COALESCE(NULLIF(v_line->>'size',''), 'onesize')), '[^a-z0-9]+', '-', 'g'), '-')
            || ':' ||
            btrim(regexp_replace(lower(COALESCE(NULLIF(v_line->>'color',''), 'default')), '[^a-z0-9]+', '-', 'g'), '-');

        v_delta := COALESCE((v_product->'priceDeltas'->>(v_line->>'size'))::numeric, 0);
        v_unit  := round(COALESCE((v_product->>'price')::numeric, 0) + v_delta, 2);

        IF NOT v_backorder THEN
            v_stock := COALESCE((v_product->'stock'->>v_variant)::int, 0);
            IF v_qty > v_stock THEN
                RETURN jsonb_build_object('success', false, 'error', 'out_of_stock',
                    'product', v_product->>'name', 'size', v_line->>'size',
                    'available', v_stock, 'wanted', v_qty);
            END IF;
        END IF;

        v_total := v_total + (v_unit * v_qty);
        v_count := v_count + v_qty;
        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
            'productId', (v_product->>'id')::int,
            'name',      v_product->>'name',
            'size',      COALESCE(v_line->>'size', ''),
            'color',     COALESCE(v_line->>'color', ''),
            'qty',       v_qty,
            'unitPrice', v_unit
        ));
    END LOOP;

    IF jsonb_array_length(v_lines) = 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'empty_order');
    END IF;
    v_total := round(v_total, 2);

    -- ── canteen payment: draw the total from the camper's balance ──
    IF p_pay_method = 'canteen' THEN

    -- 219: one camper's row, not the camp's document.
    v_snacks := NULL::jsonb;  -- document no longer read
    v_locked_acct := public.canteen_account_lock(inv.camp_id, p_camper_name);

        v_balance := COALESCE((v_locked_acct->>'balance')::numeric, 0);

        IF v_balance < v_total THEN
            RETURN jsonb_build_object('success', false, 'error', 'insufficient_balance',
                                      'balance', v_balance, 'total', v_total);
        END IF;

        v_balance := round(v_balance - v_total, 2);
    PERFORM public.canteen_account_save(inv.camp_id, p_camper_name,
        COALESCE(v_locked_acct, '{"dailyLimit":10,"spentToday":0}'::jsonb)
                || jsonb_build_object('balance', v_balance));
    PERFORM public.canteen_post(inv.camp_id, p_camper_name,
        jsonb_build_object(
                'time',   to_char(now_ts, 'HH12:MI AM'),
                'camper', p_camper_name,
                'items',  'Camp Shop order',
                'amount', v_total,
                'type',   'debit',
                'kind',   'shop',
                'date',   to_char(now_ts, 'YYYY-MM-DD')
            ));

    END IF;

    -- Bunk, so the office's pick list groups the order without a lookup.
    SELECT value->'camperRoster'->p_camper_name->>'bunk' INTO v_bunk
    FROM camp_state_kv WHERE camp_id = inv.camp_id AND key = 'app1';

    v_order_id := 'ord_p_' || replace(gen_random_uuid()::text, '-', '');

    v_shop := jsonb_set(
        v_shop, '{orders}',
        COALESCE(v_shop->'orders', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
            'id',          v_order_id,
            'camperName',  p_camper_name,
            'bunk',        COALESCE(v_bunk, ''),
            'lines',       v_lines,
            'status',      'placed',
            'paid',        (p_pay_method = 'canteen'),
            'payMethod',   p_pay_method,
            'notes',       COALESCE(p_notes, ''),
            'placedAt',    to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'source',      'parent'
        )),
        true
    );

    UPDATE camp_state_kv
    SET value = v_shop, updated_at = now_ts
    WHERE camp_id = inv.camp_id AND key = 'campistryShop';

    RETURN jsonb_build_object(
        'success', true, 'orderId', v_order_id,
        'total', v_total, 'items', v_count,
        'paid', (p_pay_method = 'canteen'),
        'balance', v_balance
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.update_canteen_autoreload_state(
    p_camp_id      uuid,
    p_camper_name  text,
    p_autoreload   jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_locked_acct jsonb;
    v_value   jsonb;
    now_ts    timestamptz := now();
    v_prev    jsonb;
    v_was_on  boolean;
    v_now_on  boolean;
    v_fails   integer;
    v_reason  text;
    v_notify  boolean := false;
BEGIN
    IF p_camp_id IS NULL OR p_camper_name IS NULL OR btrim(p_camper_name) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_params');
    END IF;
    IF p_autoreload IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_autoreload');
    END IF;

    -- 219: one camper's row, not the camp's document.
    v_value := NULL::jsonb;  -- document no longer read
    v_locked_acct := public.canteen_account_lock(p_camp_id, p_camper_name);
    IF v_value IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_snacks_row');
    END IF;

    -- The transition, read under the lock we already hold. Only ON -> OFF
    -- matters: a parent switching it off themselves never reaches this
    -- function, and an already-off card failing again is not news.
    v_prev   := v_locked_acct #> ARRAY['autoReload'];
    v_was_on := COALESCE((v_prev->>'enabled')::boolean, false);
    v_now_on := COALESCE((p_autoreload->>'enabled')::boolean, false);
    v_fails  := COALESCE((p_autoreload->>'consecutiveFailures')::integer, 0);
    v_reason := NULLIF(p_autoreload->>'lastFailureReason', '');
    v_notify := v_was_on AND NOT v_now_on AND v_fails >= 3;

    -- Only the autoReload sub-key is replaced. balance and transactions in the
    -- freshly-read row (including anything credit_canteen_balance_from_processor
    -- just committed) are left exactly as they are.
    PERFORM public.canteen_account_save(p_camp_id, p_camper_name,
        p_autoreload);

    -- A stamp any screen can read, so the reason survives past the
    -- notification and a parent's Link page can explain itself too.
    IF v_notify THEN
    PERFORM public.canteen_account_save(p_camp_id, p_camper_name,
        to_jsonb(to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')));
    PERFORM public.canteen_account_save(p_camp_id, p_camper_name,
        to_jsonb(COALESCE(v_reason, 'the card was declined three times')));
    END IF;


    IF v_notify THEN
        -- Deduped per camper per SWITCH-OFF DAY. A card re-enabled and failing
        -- again weeks later is a new problem worth a new message; the same
        -- switch-off reported twice in one night is not.
        INSERT INTO notifications (camp_id, source, source_id, title, body, link_target)
        VALUES (p_camp_id, 'canteen_autoreload_off',
                p_camper_name || ':' || to_char(now_ts, 'YYYY-MM-DD'),
                'Canteen auto-reload switched off',
                p_camper_name || ' — their card was declined ' || v_fails
                  || ' times in a row, so canteen auto-reload has been turned off'
                  || COALESCE(' (' || v_reason || ')', '')
                  || '. Their balance will not top up again, and they will be '
                  || 'declined at the register once it runs out. Ask the family '
                  || 'for a new card.',
                'campistry_snacks.html')
        ON CONFLICT (camp_id, source, source_id) DO NOTHING;
    END IF;

    RETURN jsonb_build_object('success', true, 'autoReloadDisabled', v_notify);
END;
$$;

CREATE OR REPLACE FUNCTION public.use_family_card_for_canteen_auto_reload(
    p_camp_id            uuid,
    p_camper_name        text,
    p_payment_method_id  text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_locked_acct jsonb;
    caller         uuid := auth.uid();
    inv            link_parent_invites;
    me             jsonb;
    fams           jsonb;
    famRec         record;
    v_fam          jsonb := NULL;
    v_snacks       jsonb;
    v_acct         jsonb;
    v_ar           jsonb;
    v_pm           jsonb;
    v_picked       jsonb := NULL;
    v_processorKey text;
    v_cardLabel    text;
    v_token        text;
    v_stripeCustomerId text;
    now_ts         timestamptz := now();
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF p_camper_name IS NULL OR btrim(p_camper_name) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_camper');
    END IF;

    SELECT * INTO inv
    FROM link_parent_invites
    WHERE user_id = caller AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
      AND (p_camp_id IS NULL OR camp_id = p_camp_id)
    ORDER BY created_at DESC
    LIMIT 1;
    IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'no_active_invite'); END IF;

    IF inv.camper_names IS NOT NULL AND NOT (inv.camper_names ? p_camper_name) THEN
        RETURN jsonb_build_object('success', false, 'error', 'camper_not_on_invite');
    END IF;

    SELECT value INTO me FROM camp_state_kv WHERE camp_id = inv.camp_id AND key = 'campistryMe';
    IF me IS NULL THEN me := '{}'::jsonb; END IF;
    fams := public.camp_families_object(inv.camp_id);

    FOR famRec IN SELECT key, value FROM jsonb_each(fams) LOOP
        IF EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(COALESCE(famRec.value->'camperIds', '[]'::jsonb)) ci
            WHERE ci = p_camper_name
        ) THEN
            v_fam := famRec.value;
            EXIT;
        END IF;
    END LOOP;

    IF v_fam IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'family_not_found');
    END IF;

    IF p_payment_method_id IS NOT NULL THEN
        FOR v_pm IN SELECT * FROM jsonb_array_elements(COALESCE(v_fam->'savedPaymentMethods', '[]'::jsonb)) LOOP
            IF v_pm->>'id' = p_payment_method_id THEN v_picked := v_pm; EXIT; END IF;
        END LOOP;
        IF v_picked IS NULL THEN
            RETURN jsonb_build_object('success', false, 'error', 'method_not_found');
        END IF;
        v_processorKey := v_picked->>'processor';
        v_cardLabel := v_picked->>'label';
        v_token := v_picked->>'token';
        v_stripeCustomerId := v_picked->>'stripeCustomerId';
    ELSE
        -- Original migration 138 behavior — the family's current default.
        IF v_fam->>'byopCustomerRef' IS NOT NULL AND v_fam->>'byopCustomerRef' <> '' THEN
            v_processorKey := COALESCE(v_fam->>'byopProcessor', 'cardknox');
            v_token := v_fam->>'byopCustomerRef';
        ELSIF v_fam->>'stripeCustomerId' IS NOT NULL AND v_fam->>'stripeCustomerId' <> ''
              AND COALESCE((v_fam->>'cardOnFile')::boolean, false) THEN
            v_processorKey := 'stripe';
            v_token := v_fam->>'stripePaymentMethodId';
            v_stripeCustomerId := v_fam->>'stripeCustomerId';
        ELSE
            RETURN jsonb_build_object('success', false, 'error', 'no_card_on_file');
        END IF;
        v_cardLabel := v_fam->>'paymentMethodLabel';
    END IF;


    -- 219: one camper's row, not the camp's document.
    v_snacks := NULL::jsonb;  -- document no longer read
    v_locked_acct := public.canteen_account_lock(inv.camp_id, p_camper_name);

    v_acct := COALESCE(v_locked_acct, '{"balance":0,"dailyLimit":10,"spentToday":0}'::jsonb);
    v_ar   := COALESCE(v_acct->'autoReload', '{}'::jsonb);

    IF v_processorKey = 'cardknox' THEN
        v_ar := (v_ar - 'stripeCustomerId') - 'stripePaymentMethodId';
        v_ar := v_ar || jsonb_build_object(
            'byopProcessor', v_processorKey,
            'byopCustomerRef', v_token,
            'cardOnFile', true,
            'paymentMethodType', 'card'
        );
    ELSE
        v_ar := (v_ar - 'byopCustomerRef') - 'byopProcessor';
        v_ar := v_ar || jsonb_build_object(
            'stripeCustomerId', v_stripeCustomerId,
            'stripePaymentMethodId', v_token,
            'cardOnFile', true,
            'paymentMethodType', 'card'
        );
    END IF;
    IF v_cardLabel IS NOT NULL THEN
        v_ar := jsonb_set(v_ar, '{paymentMethodLabel}', to_jsonb(v_cardLabel), true);
    END IF;
    v_ar := jsonb_set(v_ar, '{cardSavedDate}', to_jsonb(now_ts), true);
    v_ar := (v_ar - 'lastFailureDate') - 'lastFailureReason';
    v_ar := jsonb_set(v_ar, '{consecutiveFailures}', '0'::jsonb, true);

    v_acct   := jsonb_set(v_acct, '{autoReload}', v_ar, true);
    PERFORM public.canteen_account_save(inv.camp_id, p_camper_name,
        v_acct);

    RETURN jsonb_build_object(
        'success', true,
        'processorKey', v_processorKey,
        'cardLabel', v_cardLabel,
        'autoReload', v_ar
    );
END;
$$;

-- ─── did it work? ───────────────────────────────────────────────────────────
-- NOTE: this file is INCOMPLETE as it stands — the thirteen writers are
-- converted in the section that follows in the finished migration. Applying it
-- now would leave the writers on the document with the projection triggers
-- gone, which is the one combination that silently loses money.
SELECT 'migration 219 applied'                                              AS status,
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prokind = 'f'
           AND p.proname IN ('canteen_account_lock','canteen_account_save','canteen_post')) AS helpers,
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prokind = 'f'
           AND pg_get_functiondef(p.oid) ~ 'campistrySnacks''[^;]*FOR UPDATE')              AS still_locking_the_camp,
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prokind = 'f'
           AND pg_get_functiondef(p.oid) ~ 'canteen_account_lock')                          AS writers_on_rows,
       (SELECT count(*) FROM pg_trigger
         WHERE tgname IN ('trg_project_canteen_accounts','trg_canteen_archive'))            AS projections_left;
