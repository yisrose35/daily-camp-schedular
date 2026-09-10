-- ============================================================================
-- 141_canteen_instant_autoreload_utc_fix.sql
--
-- Fixes a timezone bug in migration 140's `needsReloadCheck` pre-check:
-- it compared the account's `autoReload.lastChargedDate` (always written in
-- UTC, by canteen-auto-reload's own todayISO()) against `v_today`, which is
-- the CLIENT's local date (campistry_snacks_pos.js's todayStr() uses
-- getFullYear()/getMonth()/getDate() — browser-local, not UTC) — reused from
-- the pre-existing daily-spend-limit logic, where local-time is fine, but
-- wrong for this new comparison.
--
-- Confirmed live: tested in the evening US-local time while it was already
-- past midnight UTC. The account was genuinely due again by the edge
-- function's own UTC-based clock, but the local/UTC mismatch made this
-- pre-check think "already charged today" and never fired the instant call
-- at all — the account just silently fell back to waiting for the next
-- cron tick, exactly the slow behavior this feature was built to avoid.
--
-- Fix: compute the lastChargedDate comparison against UTC 'today',
-- independently of v_today (which stays local-time and unchanged for the
-- daily-limit reset it already correctly gates). Everything else in this
-- function is identical to migration 140.
--
-- Idempotent — safe to re-run.
-- ============================================================================

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

    INSERT INTO camp_state_kv (camp_id, key, value, updated_at)
    VALUES (p_camp_id, 'campistrySnacks', '{"accounts":{},"transactions":[]}'::jsonb, now_ts)
    ON CONFLICT (camp_id, key) DO NOTHING;

    SELECT value INTO v_value FROM camp_state_kv
    WHERE camp_id = p_camp_id AND key = 'campistrySnacks' FOR UPDATE;
    IF v_value IS NULL THEN v_value := '{"accounts":{},"transactions":[]}'::jsonb; END IF;
    IF v_value->'accounts' IS NULL THEN v_value := jsonb_set(v_value, '{accounts}', '{}'::jsonb); END IF;
    IF v_value->'transactions' IS NULL THEN v_value := jsonb_set(v_value, '{transactions}', '[]'::jsonb); END IF;

    v_acct    := COALESCE(v_value->'accounts'->p_camper_name, '{"balance":0,"dailyLimit":10,"spentToday":0}'::jsonb);
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
    v_value := jsonb_set(v_value, ARRAY['accounts', p_camper_name], v_acct, true);

    v_value := jsonb_set(v_value, '{transactions}',
        jsonb_build_array(jsonb_build_object(
            'time',   to_char(now_ts, 'HH12:MI AM'),
            'camper', p_camper_name,
            'items',  COALESCE(p_items, ''),
            'amount', p_amount,
            'type',   'debit',
            'date',   v_today
        )) || COALESCE(v_value->'transactions', '[]'::jsonb));

    UPDATE camp_state_kv SET value = v_value, updated_at = now_ts
    WHERE camp_id = p_camp_id AND key = 'campistrySnacks';

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
REVOKE ALL ON FUNCTION public.submit_canteen_purchase(uuid, text, numeric, text, date) FROM public;
GRANT EXECUTE ON FUNCTION public.submit_canteen_purchase(uuid, text, numeric, text, date) TO authenticated;
