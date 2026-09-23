-- ============================================================================
-- Migration 247: the register charges a PERSON, and only staff can charge.
--
-- TWO DEFECTS in submit_canteen_purchase, the live register's charge.
--
-- 1. WHO MAY CHARGE. The gate was
--
--        p_camp_id = caller
--        OR the caller owns the camp
--        OR EXISTS (a camp_users row for the caller)
--
--    — any camp_users row, accepted or not. An invitation the recipient never
--    accepted was enough to ring up sales against any camper's balance. Every
--    other canteen writer uses camp_staff_member, which requires accepted_at;
--    the register's own PIN login creates its shadow account already accepted
--    (pos-pin-login inserts accepted_at), so it is unaffected. (`p_camp_id =
--    caller` compared a camp id to a user id and could only ever be false.)
--
-- 2. WHO IS CHARGED. It took only a name. The register knows each camper's id
--    (it builds its list from the roster), and a name is exactly what goes
--    wrong between two campers who share one. Now p_camper_id, resolved first,
--    with the name as the fallback for a camper who has no id — 240's order.
--
-- The signature gains a trailing DEFAULT NULL parameter, so the old 5-argument
-- signature is DROPPED in the same transaction: two overloads that differ only
-- by a defaulted argument are ambiguous to PostgREST (PGRST203 — see 220 and
-- 228), and every register would fail at once. A page that has not reloaded
-- still calls with five named arguments, which the new function accepts.
--
-- HOW TO APPLY. Paste into the SQL Editor. One transaction.
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

DO $$
BEGIN
    IF to_regprocedure('public.camp_staff_member(uuid)') IS NULL THEN
        RAISE EXCEPTION '247 needs camp_staff_member(uuid) — apply 183 first';
    END IF;
    IF to_regprocedure('public.camp_person_label(uuid,bigint)') IS NULL THEN
        RAISE EXCEPTION '247 needs camp_person_label — apply 223 first';
    END IF;
END $$;

SET LOCAL lock_timeout = '15s';

DROP FUNCTION IF EXISTS public.submit_canteen_purchase(uuid, text, numeric, text, date);

CREATE OR REPLACE FUNCTION public.submit_canteen_purchase(
    p_camp_id     uuid,
    p_camper_name text,
    p_amount      numeric,
    p_items       text   DEFAULT '',
    p_date        date   DEFAULT NULL,
    p_camper_id   bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_locked_acct jsonb;
    v_name     text;
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
    IF auth.uid() IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    IF p_camp_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'missing_camp'); END IF;
    IF p_amount IS NULL OR p_amount <= 0 OR p_amount > 1000 THEN RETURN jsonb_build_object('success', false, 'error', 'invalid_amount'); END IF;

    -- Staff of THIS camp, accepted. The register's PIN account is one.
    IF NOT public.camp_staff_member(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    -- The person first; the name only for a camper with no id.
    IF p_camper_id IS NOT NULL THEN
        v_name := public.camp_person_label(p_camp_id, p_camper_id);
        IF v_name IS NULL THEN
            RETURN jsonb_build_object('success', false, 'error', 'unknown_camper');
        END IF;
    ELSE
        v_name := NULLIF(btrim(COALESCE(p_camper_name, '')), '');
        IF v_name IS NULL THEN
            RETURN jsonb_build_object('success', false, 'error', 'missing_camper');
        END IF;
    END IF;

    -- From here, 219's body with v_name for p_camper_name.
    v_locked_acct := public.canteen_account_lock(p_camp_id, v_name);

    v_acct    := COALESCE(v_locked_acct, '{"balance":0,"dailyLimit":10,"spentToday":0}'::jsonb);
    v_balance := COALESCE((v_acct->>'balance')::numeric, 0);
    v_daily   := COALESCE((v_acct->>'dailyLimit')::numeric, 10);
    v_spent   := COALESCE((v_acct->>'spentToday')::numeric, 0);
    v_credit  := COALESCE((v_acct->>'creditLimit')::numeric, 0);
    v_floor   := COALESCE((v_acct->>'balanceFloor')::numeric, 0);
    v_lastdate := v_acct->>'lastSpendDate';

    IF v_lastdate IS DISTINCT FROM v_today THEN v_spent := 0; END IF;

    IF v_daily > 0 AND (v_spent + p_amount) > v_daily THEN
        RETURN jsonb_build_object('success', false, 'error', 'daily_limit_exceeded',
            'dailyLimit', v_daily, 'spentToday', v_spent, 'remaining', GREATEST(v_daily - v_spent, 0));
    END IF;

    v_spendable := v_balance - v_floor + v_credit;
    IF p_amount > v_spendable THEN
        RETURN jsonb_build_object('success', false, 'error', 'insufficient_balance',
            'spendable', v_spendable, 'balance', v_balance);
    END IF;

    v_balance := round(v_balance - p_amount, 2);
    v_spent   := round(v_spent + p_amount, 2);
    v_acct := v_acct
        || jsonb_build_object('balance', v_balance, 'spentToday', v_spent, 'lastSpendDate', v_today);
    PERFORM public.canteen_account_save(p_camp_id, v_name, v_acct);

    PERFORM public.canteen_post(p_camp_id, v_name,
        jsonb_build_object(
            'time',   to_char(now_ts, 'HH12:MI AM'),
            'camper', v_name,
            'items',  COALESCE(p_items, ''),
            'amount', p_amount,
            'type',   'debit',
            'date',   v_today
        ));

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
        'camper', v_name, 'needsReloadCheck', v_needs_reload_check);
END;
$$;

REVOKE ALL ON FUNCTION public.submit_canteen_purchase(uuid, text, numeric, text, date, bigint) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.submit_canteen_purchase(uuid, text, numeric, text, date, bigint) TO authenticated;

DO $$
BEGIN
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'submit_canteen_purchase') <> 1 THEN
        RAISE EXCEPTION '247: submit_canteen_purchase must have exactly one signature — PostgREST cannot choose between overloads';
    END IF;
END $$;
