-- ============================================================================
-- Migration: server-side canteen SPENDING CAPS + atomic PURCHASE enforcement
--
-- Two hard problems this fixes, both critical once real card money flows:
--
-- 1. A parent's spending caps (daily limit / overdraft credit limit / balance
--    floor) were only ever written to that parent's own localStorage — they
--    NEVER reached the cloud campistrySnacks blob the POS reads, so the POS
--    enforced default caps, not the parent's. set_canteen_limits() gives the
--    parent a cloud path (SECURITY DEFINER, validates the camper is on their
--    invite), so the caps actually apply at the register.
--
-- 2. The POS enforced caps CLIENT-SIDE only, with a non-atomic read-modify-write
--    of the whole snacks blob — bypassable and race-prone (two registers, or a
--    charge racing a parent deposit, could overspend or corrupt spentToday).
--    submit_canteen_purchase() re-checks the daily limit AND the spendable
--    amount (balance - floor + credit) under FOR UPDATE, resets spentToday at
--    the day boundary, then deducts and logs — atomically. It is the single
--    authority; the POS's client check is now just a fast UX pre-check.
--
-- Balances/limits live in camp_state_kv.campistrySnacks.accounts[camperName]:
--   { balance, dailyLimit, spentToday, lastSpendDate, creditLimit, balanceFloor }
-- ============================================================================

-- ─── 1. set_canteen_limits — parent sets caps (reaches the POS) ───────────────
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

    INSERT INTO camp_state_kv (camp_id, key, value, updated_at)
    VALUES (inv.camp_id, 'campistrySnacks', '{"accounts":{},"transactions":[]}'::jsonb, now_ts)
    ON CONFLICT (camp_id, key) DO NOTHING;

    SELECT value INTO v_value FROM camp_state_kv
    WHERE camp_id = inv.camp_id AND key = 'campistrySnacks' FOR UPDATE;
    IF v_value IS NULL THEN v_value := '{"accounts":{},"transactions":[]}'::jsonb; END IF;
    IF v_value->'accounts' IS NULL THEN v_value := jsonb_set(v_value, '{accounts}', '{}'::jsonb); END IF;

    v_acct := COALESCE(v_value->'accounts'->p_camper_name, '{"balance":0,"dailyLimit":10,"spentToday":0}'::jsonb);
    IF p_daily_limit   IS NOT NULL THEN v_acct := jsonb_set(v_acct, '{dailyLimit}',   to_jsonb(p_daily_limit));   END IF;
    IF p_credit_limit  IS NOT NULL THEN v_acct := jsonb_set(v_acct, '{creditLimit}',  to_jsonb(p_credit_limit));  END IF;
    IF p_balance_floor IS NOT NULL THEN v_acct := jsonb_set(v_acct, '{balanceFloor}', to_jsonb(p_balance_floor)); END IF;

    v_value := jsonb_set(v_value, ARRAY['accounts', p_camper_name], v_acct, true);
    UPDATE camp_state_kv SET value = v_value, updated_at = now_ts
    WHERE camp_id = inv.camp_id AND key = 'campistrySnacks';

    RETURN jsonb_build_object('success', true,
        'dailyLimit',   v_acct->>'dailyLimit',
        'creditLimit',  v_acct->>'creditLimit',
        'balanceFloor', v_acct->>'balanceFloor');
END;
$$;
REVOKE ALL ON FUNCTION public.set_canteen_limits(text, numeric, numeric, numeric, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.set_canteen_limits(text, numeric, numeric, numeric, uuid) TO authenticated;

-- ─── 2. submit_canteen_purchase — atomic, enforced charge at the POS ──────────
-- Called by camp staff (owner/admin/scheduler) at the register. The daily limit
-- and overdraft are the PARENT'S settings; this is the one place they are
-- guaranteed to be enforced. Rejects the whole charge if either cap would be
-- breached — no partial spends.
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
    v_balance  numeric;
    v_daily    numeric;
    v_spent    numeric;
    v_credit   numeric;
    v_floor    numeric;
    v_lastdate text;
    v_today    text := COALESCE(p_date, (now() AT TIME ZONE 'utc')::date)::text;
    v_spendable numeric;
    now_ts     timestamptz := now();
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    IF p_camp_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'missing_camp'); END IF;
    IF p_camper_name IS NULL OR btrim(p_camper_name) = '' THEN RETURN jsonb_build_object('success', false, 'error', 'missing_camper'); END IF;
    IF p_amount IS NULL OR p_amount <= 0 OR p_amount > 1000 THEN RETURN jsonb_build_object('success', false, 'error', 'invalid_amount'); END IF;

    -- Only camp staff (owner/admin/scheduler) may charge a register.
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

    RETURN jsonb_build_object('success', true, 'balance', v_balance, 'spentToday', v_spent);
END;
$$;
REVOKE ALL ON FUNCTION public.submit_canteen_purchase(uuid, text, numeric, text, date) FROM public;
GRANT EXECUTE ON FUNCTION public.submit_canteen_purchase(uuid, text, numeric, text, date) TO authenticated;
