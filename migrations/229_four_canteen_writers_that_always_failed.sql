-- ============================================================================
-- 229 — four canteen writers that have failed on every call since 219
--
-- ⚠ CRITICAL. Apply this. Four money functions return an error on EVERY call,
--   and have done since 219 was applied.
--
-- WHAT HAPPENED. 219 was produced by scripts/transform_canteen_writers.py, which
-- re-pointed thirteen writers off the whole-document read onto per-camper rows.
-- Its rule for the document read was to replace it with a literal NULL:
--
--     v_value := NULL::jsonb;  -- document no longer read
--     v_locked_acct := public.canteen_account_lock(p_camp_id, p_camper_name);
--
-- It did not remove the check that used to follow the read. So the next
-- statement in four functions is:
--
--     IF v_value IS NULL THEN
--         RETURN jsonb_build_object('success', false, 'error', 'no_canteen_data');
--     END IF;
--
-- v_value was just set to NULL on the line above. The guard fires every time.
--
--   refund_canteen_deposit_from_processor   → always {"error":"no_canteen_data"}
--   refund_canteen_deposit_from_stripe      → always {"error":"no_canteen_data"}
--   merge_canteen_autoreload_card           → always {"error":"no_camp_data"}
--   update_canteen_autoreload_state         → always {"error":"no_snacks_row"}
--
-- WHAT IT COSTS. The refunds are called from payments-canteen-refund,
-- payments-canteen-refund-all, stripe-canteen-refund and
-- stripe-canteen-refund-all, each AFTER the processor refund has already
-- succeeded. The parent gets their money back from the card and the child's
-- canteen balance is never reduced: the camp pays twice.
-- merge_canteen_autoreload_card is how a saved card is attached for auto-reload
-- (cardknox-webhook, payments-hosted-complete, stripe-webhook,
-- payments-save-method) — so no card is ever attached.
-- update_canteen_autoreload_state is how canteen-auto-reload records the outcome
-- of a top-up attempt, including switching auto-reload off after three declines
-- and telling the office why.
--
-- AND THE GUARD WAS THE ONLY THING PROTECTING A BALANCE. This is the part worth
-- reading twice. In update_canteen_autoreload_state the transform also lost the
-- KEY PATH of every write. 180's version set one sub-key of one account:
--
--     v_value := jsonb_set(v_value,
--         ARRAY['accounts', p_camper_name, 'autoReload'], p_autoreload, true);
--
-- and 219 turned that into:
--
--     PERFORM public.canteen_account_save(p_camp_id, p_camper_name, p_autoreload);
--
-- which passes the autoReload object as the WHOLE account. canteen_account_save
-- reads balance out of what it is given, finds none, and stores 0. The two stamps
-- after it are worse — they pass a bare jsonb STRING as the account. So if this
-- file had merely deleted the dead guard, the first auto-reload attempt would
-- have zeroed the child's canteen balance. The bug that broke the function is
-- what stopped the bug that empties accounts.
--
-- So all four are rebuilt from their pre-219 definitions (144, 180, and 219's own
-- refund bodies), re-pointed onto rows properly:
--
--   * the guard now asks whether the ACCOUNT could be locked, which is the row
--     equivalent of "this camp has no canteen data";
--   * update_canteen_autoreload_state sets autoReload on the locked account
--     object and saves that object, so balance, limits and spentToday survive;
--   * the disabledAt / disabledReason stamps go back onto autoReload where 180
--     put them, instead of replacing the account with a string;
--   * merge_canteen_autoreload_card's p_require_existing works again — the
--     transform left it unreachable, because the lock CREATES the account, so
--     the "does this camper exist" test could never fail. It is now asked before
--     the lock, which is also what makes `created` in the answer true or false.
--
-- WHY THE TESTS DID NOT CATCH IT. 219's behaviour test covers purchases,
-- deposits, the daily cap and a retried webhook credit. It never calls a refund,
-- never attaches a card and never records an auto-reload outcome — so four of the
-- thirteen converted functions were never executed once, by anything, before
-- going live. scripts/pgtests/229 calls every one of them.
--
-- HOW TO APPLY. Paste into the SQL Editor after 228. One transaction,
-- idempotent. No data is changed by applying it.
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'canteen_account_lock') THEN
        RAISE EXCEPTION 'canteen_account_lock is missing — apply 219 and 227 before this file';
    END IF;
END $$;

SET LOCAL lock_timeout = '15s';


-- ─── 1. refund_canteen_deposit_from_processor ───────────────────────────────
CREATE OR REPLACE FUNCTION public.refund_canteen_deposit_from_processor(
    p_camp_id                 uuid,
    p_camper_name             text,
    p_amount                  numeric,
    p_processor_key           text,
    p_external_transaction_id text,
    p_refund_external_id      text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_acct    jsonb;
    v_bal     numeric;
    v_already boolean;
    now_ts    timestamptz := now();
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

    v_acct := public.canteen_account_lock(p_camp_id, p_camper_name);
    -- The row equivalent of 219's "no_canteen_data": there is no account to
    -- reduce. 219 asked this of a variable it had just set to NULL, so the
    -- answer was always yes.
    IF v_acct IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_canteen_data');
    END IF;

    -- Idempotency comes first and is unchanged: the same refund id twice reports
    -- the balance and moves nothing.
    SELECT EXISTS (
        SELECT 1 FROM canteen_transactions t
         WHERE t.camp_id = p_camp_id
           AND t.payload ->> 'byopRefundId' = p_refund_external_id
    ) INTO v_already;
    IF v_already THEN
        RETURN jsonb_build_object('success', true, 'alreadyProcessed', true,
                                  'balance', COALESCE((v_acct ->> 'balance')::numeric, 0));
    END IF;

    v_bal := round(COALESCE((v_acct ->> 'balance')::numeric, 0) - p_amount, 2);

    PERFORM public.canteen_account_save(p_camp_id, p_camper_name,
        v_acct || jsonb_build_object('balance', v_bal));

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
            'timestamp', (extract(epoch from now_ts) * 1000)::bigint));

    RETURN jsonb_build_object('success', true, 'balance', v_bal);
END;
$$;
REVOKE ALL ON FUNCTION public.refund_canteen_deposit_from_processor(
    uuid, text, numeric, text, text, text) FROM public, anon, authenticated;


-- ─── 2. refund_canteen_deposit_from_stripe ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.refund_canteen_deposit_from_stripe(
    p_camp_id           uuid,
    p_camper_name       text,
    p_amount            numeric,
    p_payment_intent_id text,
    p_refund_id         text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_acct    jsonb;
    v_bal     numeric;
    v_already boolean;
    now_ts    timestamptz := now();
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

    v_acct := public.canteen_account_lock(p_camp_id, p_camper_name);
    IF v_acct IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_canteen_data');
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM canteen_transactions t
         WHERE t.camp_id = p_camp_id
           AND t.payload ->> 'stripeRefundId' = p_refund_id
    ) INTO v_already;
    IF v_already THEN
        RETURN jsonb_build_object('success', true, 'alreadyProcessed', true,
                                  'balance', COALESCE((v_acct ->> 'balance')::numeric, 0));
    END IF;

    v_bal := round(COALESCE((v_acct ->> 'balance')::numeric, 0) - p_amount, 2);

    PERFORM public.canteen_account_save(p_camp_id, p_camper_name,
        v_acct || jsonb_build_object('balance', v_bal));

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
            'timestamp', (extract(epoch from now_ts) * 1000)::bigint));

    RETURN jsonb_build_object('success', true, 'balance', v_bal);
END;
$$;
REVOKE ALL ON FUNCTION public.refund_canteen_deposit_from_stripe(
    uuid, text, numeric, text, text) FROM public, anon, authenticated;


-- ─── 3. merge_canteen_autoreload_card ───────────────────────────────────────
-- p_require_existing works again. 219's version asked "does this camper have an
-- account" AFTER the lock, and the lock creates one, so the answer was always
-- yes and the flag did nothing — which also made `created` in the answer always
-- false.
CREATE OR REPLACE FUNCTION public.merge_canteen_autoreload_card(
    p_camp_id          uuid,
    p_camper           text,
    p_fields           jsonb,
    p_require_existing boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_acct    jsonb;
    v_ar      jsonb;
    v_key     text;
    v_existed boolean;
BEGIN
    IF p_camp_id IS NULL OR COALESCE(p_camper, '') = ''
       OR p_fields IS NULL OR jsonb_typeof(p_fields) <> 'object' THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_arguments');
    END IF;

    -- Asked BEFORE the lock, because the lock creates the row. This is both the
    -- p_require_existing test and where `created` comes from.
    v_key := public.canteen_account_key_for(p_camp_id, p_camper);
    SELECT EXISTS (SELECT 1 FROM camp_canteen_accounts
                    WHERE camp_id = p_camp_id AND account_key = v_key)
      INTO v_existed;

    IF p_require_existing AND NOT v_existed THEN
        RETURN jsonb_build_object('success', false, 'error', 'camper_not_found');
    END IF;

    v_acct := public.canteen_account_lock(p_camp_id, p_camper);
    IF v_acct IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_camp_data');
    END IF;

    -- balance 0 on a brand-new account is not an opening figure, it is the sum
    -- of no transactions — the ledger is the source of truth.
    IF jsonb_typeof(v_acct) <> 'object' OR v_acct = '{}'::jsonb THEN
        v_acct := '{"balance":0,"dailyLimit":10,"spentToday":0}'::jsonb;
    END IF;

    v_ar := COALESCE(v_acct -> 'autoReload', '{}'::jsonb);
    IF jsonb_typeof(v_ar) <> 'object' THEN v_ar := '{}'::jsonb; END IF;

    -- MERGE, not replace: the caller sends only the card fields it knows about,
    -- and the enabled/threshold/amount a parent configured must survive.
    v_acct := jsonb_set(v_acct, '{autoReload}', v_ar || p_fields, true);

    PERFORM public.canteen_account_save(p_camp_id, p_camper, v_acct);

    RETURN jsonb_build_object('success', true, 'camper', p_camper,
                              'created', NOT v_existed);
END;
$$;
REVOKE ALL ON FUNCTION public.merge_canteen_autoreload_card(uuid, text, jsonb, boolean)
    FROM public, anon, authenticated;


-- ─── 4. update_canteen_autoreload_state ─────────────────────────────────────
-- Rebuilt from 180. The three writes 219 produced would each have replaced the
-- whole account: the first with the autoReload object, the other two with a bare
-- string. Every one of them sets balance to 0.
CREATE OR REPLACE FUNCTION public.update_canteen_autoreload_state(
    p_camp_id     uuid,
    p_camper_name text,
    p_autoreload  jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_acct   jsonb;
    now_ts   timestamptz := now();
    v_prev   jsonb;
    v_was_on boolean;
    v_now_on boolean;
    v_fails  integer;
    v_reason text;
    v_notify boolean := false;
BEGIN
    IF p_camp_id IS NULL OR p_camper_name IS NULL OR btrim(p_camper_name) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_params');
    END IF;
    IF p_autoreload IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_autoreload');
    END IF;

    v_acct := public.canteen_account_lock(p_camp_id, p_camper_name);
    IF v_acct IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_snacks_row');
    END IF;
    IF jsonb_typeof(v_acct) <> 'object' OR v_acct = '{}'::jsonb THEN
        v_acct := '{"balance":0,"dailyLimit":10,"spentToday":0}'::jsonb;
    END IF;

    -- The transition, read under the lock we already hold. Only ON -> OFF
    -- matters: a parent switching it off themselves never reaches this function,
    -- and an already-off card failing again is not news.
    v_prev   := v_acct -> 'autoReload';
    v_was_on := COALESCE((v_prev ->> 'enabled')::boolean, false);
    v_now_on := COALESCE((p_autoreload ->> 'enabled')::boolean, false);
    v_fails  := COALESCE((p_autoreload ->> 'consecutiveFailures')::integer, 0);
    v_reason := NULLIF(p_autoreload ->> 'lastFailureReason', '');
    v_notify := v_was_on AND NOT v_now_on AND v_fails >= 3;

    -- ONLY the autoReload sub-key is replaced. balance, limits and spentToday —
    -- including anything credit_canteen_balance_from_processor committed a
    -- moment ago — are left exactly as they are. THIS is the line 219 lost.
    v_acct := jsonb_set(v_acct, '{autoReload}', p_autoreload, true);

    -- A stamp any screen can read, so the reason survives past the notification
    -- and a parent's Link page can explain itself too. On autoReload, where 180
    -- put it.
    IF v_notify THEN
        v_acct := jsonb_set(v_acct, '{autoReload,disabledAt}',
                            to_jsonb(to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')), true);
        v_acct := jsonb_set(v_acct, '{autoReload,disabledReason}',
                            to_jsonb(COALESCE(v_reason, 'the card was declined three times')), true);
    END IF;

    PERFORM public.canteen_account_save(p_camp_id, p_camper_name, v_acct);

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
REVOKE ALL ON FUNCTION public.update_canteen_autoreload_state(uuid, text, jsonb)
    FROM public, anon, authenticated;


-- ─── 5. and no other converted writer guards on a retired variable ──────────
-- The rule, not the list. Any function whose body sets a variable to NULL::jsonb
-- and then returns on that variable being NULL can never do anything, and there
-- is no reason for such a pair to exist on purpose.
DO $$
DECLARE
    r     record;
    v_bad text := NULL;
BEGIN
    SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_bad
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind = 'f'
       AND p.prosrc ~ '(\w+)\s*:=\s*NULL::jsonb;'
       AND EXISTS (
            SELECT 1
              FROM regexp_matches(p.prosrc, '(\w+)\s*:=\s*NULL::jsonb;', 'g') AS m(g)
             WHERE p.prosrc ~ ('IF\s+' || m.g[1] || '\s+IS\s+NULL\s+THEN[^;]*RETURN'));

    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'these still return on a variable set to NULL a line earlier: %', v_bad;
    END IF;
END $$;


-- ─── did it work? ───────────────────────────────────────────────────────────
SELECT 'migration 229 applied' AS status,
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('refund_canteen_deposit_from_processor',
                             'refund_canteen_deposit_from_stripe',
                             'merge_canteen_autoreload_card',
                             'update_canteen_autoreload_state')
           AND p.prosrc !~ 'NULL::jsonb;')  AS rebuilt_without_the_dead_guard;
