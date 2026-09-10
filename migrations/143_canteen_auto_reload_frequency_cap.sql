-- ============================================================================
-- 143_canteen_auto_reload_frequency_cap.sql
--
-- Lets a parent cap how OFTEN auto-reload can fire, independent of the
-- threshold/schedule trigger that decides WHEN it's due — e.g. "up to twice
-- a day" or "only 3 times every 2 weeks". Two new fields on autoReload:
--   maxReloadsPerPeriod (integer, default 1)
--   reloadPeriodDays    (integer, default 1)
-- meaning "at most maxReloadsPerPeriod charges within any reloadPeriodDays-
-- day rolling window". The default (1 per 1 day) reproduces exactly the
-- once-per-day behavior that already existed before this migration.
--
-- Enforcement itself lives in supabase/functions/canteen-auto-reload
-- (deploy that alongside this migration) — it counts entries in a new
-- `reloadHistory` array (one ISO date per successful charge, appended by
-- markSuccess) that fall within the rolling window, instead of the old
-- single lastChargedDate === today check. lastChargedDate/lastChargeAmount
-- are left untouched for display ("last topped up $X on <date>").
--
-- This migration only adds the parent-facing config fields to
-- set_canteen_auto_reload — same signature as migration 135, additive only.
-- ============================================================================

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

    INSERT INTO camp_state_kv (camp_id, key, value, updated_at)
    VALUES (inv.camp_id, 'campistrySnacks', '{"accounts":{},"transactions":[]}'::jsonb, now_ts)
    ON CONFLICT (camp_id, key) DO NOTHING;

    SELECT value INTO v_value FROM camp_state_kv
    WHERE camp_id = inv.camp_id AND key = 'campistrySnacks' FOR UPDATE;
    IF v_value IS NULL THEN v_value := '{"accounts":{},"transactions":[]}'::jsonb; END IF;
    IF v_value->'accounts' IS NULL THEN v_value := jsonb_set(v_value, '{accounts}', '{}'::jsonb); END IF;

    v_acct := COALESCE(v_value->'accounts'->p_camper_name, '{"balance":0,"dailyLimit":10,"spentToday":0}'::jsonb);
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
    v_value := jsonb_set(v_value, ARRAY['accounts', p_camper_name], v_acct, true);
    UPDATE camp_state_kv SET value = v_value, updated_at = now_ts
    WHERE camp_id = inv.camp_id AND key = 'campistrySnacks';

    RETURN jsonb_build_object(
        'success', true,
        'autoReload', v_ar,
        'cardOnFile', COALESCE((v_ar->>'cardOnFile')::boolean, false)
    );
END;
$$;
REVOKE ALL ON FUNCTION public.set_canteen_auto_reload(uuid, text, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.set_canteen_auto_reload(uuid, text, jsonb) TO authenticated;
