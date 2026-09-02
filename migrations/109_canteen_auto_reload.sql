-- ============================================================================
-- Migration 109: Canteen AUTO-RELOAD (real recurring/threshold top-ups).
--
-- The parent portal's "Auto-Reload" button (campistry_link_parent.html) has
-- always been a decorative no-op (onclick="toast('Auto-reload enabled!')") --
-- a documented gap, see CANTEEN_STRIPE_DEPOSITS_SETUP.md. This migration adds
-- the server side of the real feature: a parent can ask for their camper's
-- canteen balance to be topped up automatically, either
--   - THRESHOLD: "reload $Y whenever the balance drops below $X", and/or
--   - SCHEDULE:  "reload $Y every week/month",
-- charged off-session to a saved card via a new cron Edge Function
-- (canteen-auto-reload). See CANTEEN_AUTORELOAD_SETUP.md for the full
-- Edge Function + pg_cron setup this migration is one piece of.
--
-- Storage: reuses the existing camp_state_kv.campistrySnacks.accounts[camperName]
-- object (migration 026) -- adds a nested `autoReload` object rather than a
-- new table, same "current state in one JSON blob" model the rest of canteen
-- uses. Shape:
--   accounts[camperName].autoReload = {
--     enabled, thresholdEnabled, thresholdAmount, thresholdReloadAmount,
--     scheduleEnabled, scheduleFrequency ('weekly'|'monthly'), scheduleDay, scheduleReloadAmount,
--     -- written ONLY by the webhook/cron (service_role), never by this RPC:
--     stripeCustomerId, stripePaymentMethodId, cardOnFile, paymentMethodType,
--     paymentMethodLabel, lastChargedDate, lastChargeAmount, lastFailureDate,
--     lastFailureReason, consecutiveFailures
--   }
--
-- Crediting a successful auto-reload charge reuses the EXISTING
-- credit_canteen_balance_from_stripe() RPC (migration 079) via the existing
-- stripe-webhook handleCanteenDeposit path -- the cron function tags its
-- PaymentIntents with the same metadata.source='campistry-canteen-deposit'
-- a manual "Add Funds" deposit uses, so no new crediting RPC is needed here.
-- ============================================================================

-- ─── set_canteen_auto_reload — parent sets/updates auto-reload config ────────
-- Only merges the parent-editable trigger fields (enabled/threshold*/schedule*).
-- Card/attempt bookkeeping (stripeCustomerId, cardOnFile, lastChargedDate,
-- consecutiveFailures, ...) is written exclusively by the webhook/cron under
-- service_role and is never touched by this function, so a parent saving
-- their trigger settings can never clobber that state.
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
        'scheduleReloadAmount', v_sc_reload
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

-- ─── Sanity check ────────────────────────────────────────────────────────
--   select set_canteen_auto_reload('<camp id>'::uuid, '<camper name>',
--     '{"enabled":true,"thresholdEnabled":true,"thresholdAmount":5,"thresholdReloadAmount":20,
--       "scheduleEnabled":false}'::jsonb);
--   -- run as the parent's own session (RLS/auth.uid() applies); confirm
--   -- accounts[camperName].autoReload appears in get_canteen_accounts()
--   -- without disturbing dailyLimit/creditLimit/balanceFloor/balance.
-- ============================================================================
