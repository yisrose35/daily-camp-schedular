-- ============================================================================
-- 140_canteen_instant_autoreload_flag.sql
--
-- Auto-reload today only runs on a pg_cron poll (every 30 min, see
-- CANTEEN_AUTORELOAD_SETUP.md) — a camper can sit under their threshold for
-- up to ~30 minutes before the next tick catches it. This migration is half
-- of making it instant: `submit_canteen_purchase` (migration 026) already
-- has the camper's `autoReload` sub-object and the just-updated balance in
-- scope at the moment a POS sale pushes them under threshold — it just never
-- looked at it. Add a cheap, non-authoritative pre-check to its response so
-- the POS client (campistry_snacks_pos.js) knows to immediately ping the
-- canteen-auto-reload Edge Function for just this one camper instead of
-- waiting for the next cron tick.
--
-- Deliberately NOT authoritative — this only mirrors the CHEAP part of the
-- Edge Function's own dueAmount() (enabled + cardOnFile + a saved
-- customer ref + threshold crossed + not already charged today). It skips
-- the start/stop date window check the Edge Function also applies, so a
-- false positive here just costs one harmless extra network call that the
-- Edge Function itself will no-op — it can NEVER cause a wrong charge,
-- because the Edge Function is still the only place that ever actually
-- charges anything. This is purely "is it worth pinging" not "should this
-- be charged".
--
-- Idempotent — safe to re-run. Same signature as migration 026, so no
-- client call site needs to change to pick this up automatically; only
-- campistry_snacks_pos.js is updated (separately) to actually read the new
-- field and act on it.
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
    -- sole authority on whether a charge actually fires.
    v_ar := v_acct->'autoReload';
    IF v_ar IS NOT NULL
       AND (v_ar->>'enabled')::boolean IS TRUE
       AND (v_ar->>'cardOnFile')::boolean IS TRUE
       AND (v_ar->>'stripeCustomerId' IS NOT NULL OR v_ar->>'byopCustomerRef' IS NOT NULL)
       AND (v_ar->>'thresholdEnabled')::boolean IS TRUE
       AND (v_ar->>'thresholdAmount') IS NOT NULL
       AND v_balance < (v_ar->>'thresholdAmount')::numeric
       AND (v_ar->>'lastChargedDate') IS DISTINCT FROM v_today
    THEN
        v_needs_reload_check := true;
    END IF;

    RETURN jsonb_build_object('success', true, 'balance', v_balance, 'spentToday', v_spent,
        'needsReloadCheck', v_needs_reload_check);
END;
$$;
REVOKE ALL ON FUNCTION public.submit_canteen_purchase(uuid, text, numeric, text, date) FROM public;
GRANT EXECUTE ON FUNCTION public.submit_canteen_purchase(uuid, text, numeric, text, date) TO authenticated;
