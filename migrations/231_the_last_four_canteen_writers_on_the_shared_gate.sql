-- ============================================================================
-- 231 — the last four canteen writers stop asking the question themselves
--
-- THE LINE, FOR THE SIXTH AND LAST TIME — and while removing it, two more live
-- defects in the same functions, and a third in the admin sweep beside them:
--
--     IF inv.camper_names IS NOT NULL AND NOT (inv.camper_names ? p_camper_name)
--
-- 224 replaced it in _parent_owns_camper. 225 found three more copies in
-- submit_pickup_request, submit_camper_mail and submit_link_form_response. 226
-- found a fifth in submit_link_tip. 230 found a sixth in submit_shop_order. These
-- four are the rest:
--
--     submit_canteen_deposit
--     set_canteen_limits
--     set_canteen_auto_reload
--     use_family_card_for_canteen_auto_reload
--
-- Every one is a parent moving or configuring money. A jsonb string match on a
-- name means a renamed camper's parent is refused with camper_not_on_invite
-- before any account is touched — so the child cannot be topped up, their limit
-- cannot be changed, auto-reload cannot be set and the family card cannot be
-- attached, for the rest of the season. Two children sharing a name means either
-- parent reaches either child's balance.
--
-- All four also loaded the parent's most recently CREATED invite and then tested
-- the camper against that one, so a parent holding two invites in a camp was
-- answered from whichever happened to be newer.
--
-- They now call _parent_invite_for, which returns the invite that actually covers
-- the child and prefers one that names them over the camp-wide wildcard, and they
-- take p_camper_id, deriving the label from the roster rather than trusting the
-- name passed beside the id.
--
-- TWO THINGS NEEDED MORE THAN A SUBSTITUTION, both found by calling the
-- functions rather than by reading them.
--
-- 1. THE SURVIVING use_family_card_for_canteen_auto_reload WAS NEVER CONVERTED.
--    219 moved the canteen off the campistrySnacks document onto
--    camp_canteen_accounts rows, and converted the TWO-argument version of this
--    function. The three-argument version from 214 — the one that is actually
--    live, and the one 228 leaves standing — reads and writes the document.
--    Since 219 nothing reads that document: campistry_snacks.js strips accounts
--    out of every save. So attaching a family card for canteen auto-reload has
--    been writing the card where no reader looks, and auto-reload has never
--    found a card on file for anybody who attached one this way. It also took a
--    camp-wide FOR UPDATE on campistrySnacks, which is the contention 219
--    existed to remove. It is now on the row lock and the row save.
--
-- 2. THE FAMILY LOOKUP CANNOT BE FIXED BY RENAMING A VARIABLE. It finds the
--    family containing the camper by scanning each family's camperIds, which
--    holds NAMES despite the name and is not rewritten when a camp renames a
--    camper. Matching the CURRENT roster key alone answers family_not_found for
--    exactly the children this file exists to unblock. Three ways to recognise
--    the child are now tried, in the order they can be trusted: the current key,
--    an entry that still resolves to the same person, and the name this parent's
--    INVITE was written with for this child — an invite and a family snapshot are
--    produced by the same office sync from the same roster keys, so when
--    camperIds holds a spelling the roster has since dropped, the invite holds it
--    too and 223 stamped that slot with the id. Migration 232 replaces all three
--    with one comparison, once camp_families carries person ids of its own.
--
-- AND A SIXTH FUNCTION IS HERE FOR THE SAME REASON AS THE FIRST.
-- _admin_clear_stale_byop_cards is what runs when an owner connects a different
-- payment processor: it strips tokens for the processor the camp has left, on
-- each family AND on each canteen auto-reload. 214 converted the families half
-- onto rows and left the canteen half iterating campistrySnacks.accounts — an
-- object nothing has written since 219. So it cleared nothing, and every camper
-- kept a token for a processor the camp no longer uses, which canteen auto-reload
-- then kept trying to charge. It is now on the rows, one at a time, locking only
-- the rows that need changing.
--
-- HOW THIS FILE WAS BUILT. Not retyped. Five textual rules applied to the live
-- bodies (219's deposit, limits and auto-reload; 214's family card), each rule
-- asserted to have matched exactly once per function, and each output checked to
-- mention p_camper_name in exactly the four places it should: the signature, the
-- missing-camper guard, the gate call and the fallback assignment. Every amount,
-- bound and clamp is byte-for-byte what it was — the $1–$500 deposit range, the
-- 0–1000 limit clamps, the whole auto-reload validation ladder, the processor
-- choice and the field-clearing on a card switch.
--
-- The money assertions were already in place before the change:
-- scripts/pgtests/229 has called all four since the previous commit, checking that
-- a deposit lands, that setting a limit does not move the balance, that
-- auto-reload keeps it, and that attaching the family card does not wipe the
-- parent's trigger config.
--
-- THE FOUR OLD SIGNATURES ARE DROPPED BY NAME, because adding a defaulted
-- parameter and keeping the old form is the PGRST203 trap 228 exists to close.
--
-- HOW TO APPLY. Paste into the SQL Editor after 230. One transaction, idempotent.
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = '_parent_invite_for') THEN
        RAISE EXCEPTION '_parent_invite_for is missing — apply migration 225 before this file';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'camp_families_object') THEN
        RAISE EXCEPTION 'camp_families_object is missing — apply migration 212 before this file';
    END IF;
END $$;

SET LOCAL lock_timeout = '15s';


-- ─── 1. submit_canteen_deposit ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.submit_canteen_deposit(
    p_camper_name text,
    p_amount      numeric,
    p_camp_id     uuid DEFAULT NULL,
    p_camper_id   bigint   DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_id       bigint := p_camper_id;
    v_name     text;
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
    IF COALESCE(btrim(p_camper_name), '') = '' AND v_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_camper');
    END IF;
    IF p_amount IS NULL OR p_amount < 1 OR p_amount > 500 THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_amount');
    END IF;

    -- 224's gate, not another copy of the name-containment check. The invite that
    -- COVERS this child, preferring one that names them over the camp-wide
    -- wildcard, rather than whichever the parent created most recently.
    inv := public._parent_invite_for(p_camp_id, v_id, p_camper_name);
    IF inv.id IS NULL THEN
        -- Told apart, so a parent is not sent to the camp about a missing invite
        -- they do have.
        IF EXISTS (SELECT 1 FROM link_parent_invites
                    WHERE user_id = caller AND status = 'active'
                      AND (expires_at IS NULL OR expires_at > now())
                      AND (p_camp_id IS NULL OR camp_id = p_camp_id)) THEN
            RETURN jsonb_build_object('success', false, 'error', 'camper_not_on_invite');
        END IF;
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;

    -- The label comes from the roster when an id was given, never from the name
    -- beside it.
    IF v_id IS NOT NULL THEN
        v_name := public.camp_person_label(inv.camp_id, v_id);
        IF v_name IS NULL THEN
            RETURN jsonb_build_object('success', false, 'error', 'unknown_camper');
        END IF;
    ELSE
        v_name := p_camper_name;
        v_id   := public.camp_person_by_name(inv.camp_id, v_name);
    END IF;


    -- 219: one camper's row, not the camp's document.
    v_value := NULL::jsonb;  -- document no longer read
    v_locked_acct := public.canteen_account_lock(inv.camp_id, v_name);


    v_bal := round(COALESCE((v_locked_acct->>'balance')::numeric, 0) + p_amount, 2);

    PERFORM public.canteen_account_save(inv.camp_id, v_name,
        COALESCE(v_locked_acct, '{"dailyLimit":10,"spentToday":0}'::jsonb)
            || jsonb_build_object('balance', v_bal));

    PERFORM public.canteen_post(inv.camp_id, v_name,
        jsonb_build_object(
            'time',   to_char(now_ts, 'HH12:MI AM'),
            'camper', v_name,
            'items',  'Funds added by parent',
            'amount', p_amount,
            'type',   'credit',
            'date',   to_char(now_ts, 'YYYY-MM-DD')
        ));


    RETURN jsonb_build_object('success', true, 'balance', v_bal);
END;
$$;REVOKE ALL ON FUNCTION public.submit_canteen_deposit(text, numeric, uuid, bigint)
    FROM public, anon;
GRANT EXECUTE ON FUNCTION public.submit_canteen_deposit(text, numeric, uuid, bigint)
    TO authenticated;


-- ─── 2. set_canteen_limits ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_canteen_limits(
    p_camper_name   text,
    p_daily_limit   numeric DEFAULT NULL,
    p_credit_limit  numeric DEFAULT NULL,
    p_balance_floor numeric DEFAULT NULL,
    p_camp_id       uuid    DEFAULT NULL,
    p_camper_id   bigint   DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_id       bigint := p_camper_id;
    v_name     text;
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
    IF COALESCE(btrim(p_camper_name), '') = '' AND v_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_camper');
    END IF;
    -- Clamp to sane, non-negative bounds so a bad client can't set nonsense.
    IF p_daily_limit   IS NOT NULL AND (p_daily_limit   < 0 OR p_daily_limit   > 1000) THEN RETURN jsonb_build_object('success', false, 'error', 'bad_daily_limit');   END IF;
    IF p_credit_limit  IS NOT NULL AND (p_credit_limit  < 0 OR p_credit_limit  > 1000) THEN RETURN jsonb_build_object('success', false, 'error', 'bad_credit_limit');  END IF;
    IF p_balance_floor IS NOT NULL AND (p_balance_floor < 0 OR p_balance_floor > 1000) THEN RETURN jsonb_build_object('success', false, 'error', 'bad_balance_floor'); END IF;

    -- 224's gate, not another copy of the name-containment check. The invite that
    -- COVERS this child, preferring one that names them over the camp-wide
    -- wildcard, rather than whichever the parent created most recently.
    inv := public._parent_invite_for(p_camp_id, v_id, p_camper_name);
    IF inv.id IS NULL THEN
        -- Told apart, so a parent is not sent to the camp about a missing invite
        -- they do have.
        IF EXISTS (SELECT 1 FROM link_parent_invites
                    WHERE user_id = caller AND status = 'active'
                      AND (expires_at IS NULL OR expires_at > now())
                      AND (p_camp_id IS NULL OR camp_id = p_camp_id)) THEN
            RETURN jsonb_build_object('success', false, 'error', 'camper_not_on_invite');
        END IF;
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;

    -- The label comes from the roster when an id was given, never from the name
    -- beside it.
    IF v_id IS NOT NULL THEN
        v_name := public.camp_person_label(inv.camp_id, v_id);
        IF v_name IS NULL THEN
            RETURN jsonb_build_object('success', false, 'error', 'unknown_camper');
        END IF;
    ELSE
        v_name := p_camper_name;
        v_id   := public.camp_person_by_name(inv.camp_id, v_name);
    END IF;


    -- 219: one camper's row, not the camp's document.
    v_value := NULL::jsonb;  -- document no longer read
    v_locked_acct := public.canteen_account_lock(inv.camp_id, v_name);

    v_acct := COALESCE(v_locked_acct, '{"balance":0,"dailyLimit":10,"spentToday":0}'::jsonb);
    IF p_daily_limit   IS NOT NULL THEN v_acct := jsonb_set(v_acct, '{dailyLimit}',   to_jsonb(p_daily_limit));   END IF;
    IF p_credit_limit  IS NOT NULL THEN v_acct := jsonb_set(v_acct, '{creditLimit}',  to_jsonb(p_credit_limit));  END IF;
    IF p_balance_floor IS NOT NULL THEN v_acct := jsonb_set(v_acct, '{balanceFloor}', to_jsonb(p_balance_floor)); END IF;

    PERFORM public.canteen_account_save(inv.camp_id, v_name,
        v_acct);

    RETURN jsonb_build_object('success', true,
        'dailyLimit',   v_acct->>'dailyLimit',
        'creditLimit',  v_acct->>'creditLimit',
        'balanceFloor', v_acct->>'balanceFloor');
END;
$$;REVOKE ALL ON FUNCTION public.set_canteen_limits(text, numeric, numeric, numeric, uuid, bigint)
    FROM public, anon;
GRANT EXECUTE ON FUNCTION public.set_canteen_limits(text, numeric, numeric, numeric, uuid, bigint)
    TO authenticated;


-- ─── 3. set_canteen_auto_reload ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_canteen_auto_reload(
    p_camp_id     uuid,
    p_camper_name text,
    p_config      jsonb,
    p_camper_id   bigint   DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_id       bigint := p_camper_id;
    v_name     text;
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
    IF COALESCE(btrim(p_camper_name), '') = '' AND v_id IS NULL THEN
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

    -- 224's gate, not another copy of the name-containment check. The invite that
    -- COVERS this child, preferring one that names them over the camp-wide
    -- wildcard, rather than whichever the parent created most recently.
    inv := public._parent_invite_for(p_camp_id, v_id, p_camper_name);
    IF inv.id IS NULL THEN
        -- Told apart, so a parent is not sent to the camp about a missing invite
        -- they do have.
        IF EXISTS (SELECT 1 FROM link_parent_invites
                    WHERE user_id = caller AND status = 'active'
                      AND (expires_at IS NULL OR expires_at > now())
                      AND (p_camp_id IS NULL OR camp_id = p_camp_id)) THEN
            RETURN jsonb_build_object('success', false, 'error', 'camper_not_on_invite');
        END IF;
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;

    -- The label comes from the roster when an id was given, never from the name
    -- beside it.
    IF v_id IS NOT NULL THEN
        v_name := public.camp_person_label(inv.camp_id, v_id);
        IF v_name IS NULL THEN
            RETURN jsonb_build_object('success', false, 'error', 'unknown_camper');
        END IF;
    ELSE
        v_name := p_camper_name;
        v_id   := public.camp_person_by_name(inv.camp_id, v_name);
    END IF;


    -- 219: one camper's row, not the camp's document.
    v_value := NULL::jsonb;  -- document no longer read
    v_locked_acct := public.canteen_account_lock(inv.camp_id, v_name);

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
    PERFORM public.canteen_account_save(inv.camp_id, v_name,
        v_acct);

    RETURN jsonb_build_object(
        'success', true,
        'autoReload', v_ar,
        'cardOnFile', COALESCE((v_ar->>'cardOnFile')::boolean, false)
    );
END;
$$;REVOKE ALL ON FUNCTION public.set_canteen_auto_reload(uuid, text, jsonb, bigint)
    FROM public, anon;
GRANT EXECUTE ON FUNCTION public.set_canteen_auto_reload(uuid, text, jsonb, bigint)
    TO authenticated;


-- ─── 4. use_family_card_for_canteen_auto_reload ─────────────────────────────
CREATE OR REPLACE FUNCTION public.use_family_card_for_canteen_auto_reload(
    p_camp_id            uuid,
    p_camper_name        text,
    p_payment_method_id  text DEFAULT NULL,
    p_camper_id   bigint   DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_id       bigint := p_camper_id;
    v_name     text;
    caller         uuid := auth.uid();
    inv            link_parent_invites;
    me             jsonb;
    fams           jsonb;
    famRec         record;
    v_fam          jsonb := NULL;
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
    IF COALESCE(btrim(p_camper_name), '') = '' AND v_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_camper');
    END IF;

    -- 224's gate, not another copy of the name-containment check. The invite that
    -- COVERS this child, preferring one that names them over the camp-wide
    -- wildcard, rather than whichever the parent created most recently.
    inv := public._parent_invite_for(p_camp_id, v_id, p_camper_name);
    IF inv.id IS NULL THEN
        -- Told apart, so a parent is not sent to the camp about a missing invite
        -- they do have.
        IF EXISTS (SELECT 1 FROM link_parent_invites
                    WHERE user_id = caller AND status = 'active'
                      AND (expires_at IS NULL OR expires_at > now())
                      AND (p_camp_id IS NULL OR camp_id = p_camp_id)) THEN
            RETURN jsonb_build_object('success', false, 'error', 'camper_not_on_invite');
        END IF;
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;

    -- The label comes from the roster when an id was given, never from the name
    -- beside it.
    IF v_id IS NOT NULL THEN
        v_name := public.camp_person_label(inv.camp_id, v_id);
        IF v_name IS NULL THEN
            RETURN jsonb_build_object('success', false, 'error', 'unknown_camper');
        END IF;
    ELSE
        v_name := p_camper_name;
        v_id   := public.camp_person_by_name(inv.camp_id, v_name);
    END IF;

    SELECT value INTO me FROM camp_state_kv WHERE camp_id = inv.camp_id AND key = 'campistryMe';
    IF me IS NULL THEN me := '{}'::jsonb; END IF;
    fams := public.camp_families_object(inv.camp_id);

    FOR famRec IN SELECT key, value FROM jsonb_each(fams) LOOP
        IF EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(COALESCE(famRec.value->'camperIds', '[]'::jsonb)) ci
            -- camperIds holds NAMES despite its name, and a family's list is not
            -- rewritten when a camp renames a camper. Three ways to recognise the
            -- child, in the order they can be trusted:
            --
            --   1. the current roster key — the ordinary case, and the only one
            --      that works for a camper the roster cannot resolve at all;
            --   2. an entry that resolves to the same person, which catches a
            --      family list written under a DIFFERENT still-valid spelling;
            --   3. the name this parent's INVITE was written with for this child.
            --      An invite and a family snapshot are produced by the same office
            --      sync from the same roster keys, so they are the same vintage:
            --      when camperIds holds a spelling the roster has since dropped,
            --      the invite holds it too, and 223 stamped that slot with the id.
            --      Without this, family_not_found is the answer for exactly the
            --      renamed children this file exists to unblock.
            --
            -- Migration 232 replaces all three with one id comparison, once
            -- camp_families carries person ids of its own.
            WHERE ci = v_name
               OR (v_id IS NOT NULL
                   AND public.camp_person_by_name(inv.camp_id, ci) = v_id)
               OR (v_id IS NOT NULL AND jsonb_typeof(inv.camper_names) = 'array' AND EXISTS (
                     SELECT 1
                       FROM jsonb_array_elements(inv.camper_names) WITH ORDINALITY AS e(value, ord)
                      WHERE e.value #>> '{}' = ci
                        AND COALESCE(inv.person_ids -> (e.ord - 1)::int, 'null'::jsonb)
                            = to_jsonb(v_id)))
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

    -- THE SECOND DEFECT IN THIS FUNCTION, and the one with teeth. 219 moved the
    -- canteen off the campistrySnacks document onto camp_canteen_accounts rows,
    -- and converted the TWO-argument version of this function. The
    -- three-argument version from 214 — the one that is actually live — was
    -- never converted. It has been reading and writing the document ever since,
    -- and since 219 nothing reads that document: the card was written where no
    -- reader looks, so auto-reload has never found a card on file for anyone who
    -- attached one this way. It also took a camp-wide lock on campistrySnacks,
    -- which is the contention 219 existed to remove.
    v_acct := COALESCE(public.canteen_account_lock(inv.camp_id, v_name),
                       '{"balance":0,"dailyLimit":10,"spentToday":0}'::jsonb);
    IF jsonb_typeof(v_acct) <> 'object' OR v_acct = '{}'::jsonb THEN
        v_acct := '{"balance":0,"dailyLimit":10,"spentToday":0}'::jsonb;
    END IF;
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
    PERFORM public.canteen_account_save(inv.camp_id, v_name, v_acct);

    RETURN jsonb_build_object(
        'success', true,
        'processorKey', v_processorKey,
        'cardLabel', v_cardLabel,
        'autoReload', v_ar
    );
END;
$$;REVOKE ALL ON FUNCTION public.use_family_card_for_canteen_auto_reload(uuid, text, text, bigint)
    FROM public, anon;
GRANT EXECUTE ON FUNCTION public.use_family_card_for_canteen_auto_reload(uuid, text, text, bigint)
    TO authenticated;


-- ─── 5. _admin_clear_stale_byop_cards, on rows ──────────────────────────────
-- Not a parent function, and it was never on the containment check — it is here
-- because it is the OTHER half of the same defect as section 4, and leaving it
-- would mean a camp that switched processor still had every camper's stale token
-- on file.
CREATE OR REPLACE FUNCTION public._admin_clear_stale_byop_cards(p_camp_id uuid, p_processor_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_me      jsonb;
    v_fams    jsonb := '{}'::jsonb;
    rec       record;
    v_obj     jsonb;
    v_ar      jsonb;
    v_pms     jsonb;
    v_famsChanged   boolean := false;
    v_acctsChanged  boolean := false;
    v_cleared int := 0;
BEGIN
    -- ── Tuition cards on each family (campistryMe.families) ──────────────────
    SELECT value INTO v_me FROM camp_state_kv WHERE camp_id = p_camp_id AND key = 'campistryMe';
    IF v_me IS NOT NULL AND jsonb_typeof(public.camp_families_object(p_camp_id)) = 'object' THEN
        FOR rec IN SELECT key, value FROM jsonb_each(public.camp_families_object(p_camp_id)) LOOP
            v_obj := rec.value;

            -- Keep only saved methods that belong to the current processor.
            IF jsonb_typeof(v_obj->'savedPaymentMethods') = 'array' THEN
                SELECT COALESCE(jsonb_agg(m), '[]'::jsonb) INTO v_pms
                  FROM jsonb_array_elements(v_obj->'savedPaymentMethods') m
                 WHERE (m->>'processor') = p_processor_key;
                IF v_pms IS DISTINCT FROM (v_obj->'savedPaymentMethods') THEN
                    v_obj := jsonb_set(v_obj, '{savedPaymentMethods}', v_pms, true);
                    v_famsChanged := true;
                END IF;
            END IF;

            -- Strip the legacy single-slot fields when they point at a
            -- DIFFERENT processor than the one now connected (a stale BYOP
            -- token, or a Stripe customer on a now-BYOP camp).
            IF ( (v_obj ? 'byopProcessor') AND (v_obj->>'byopProcessor') IS DISTINCT FROM p_processor_key )
               OR ( COALESCE(v_obj->>'stripeCustomerId','') <> '' AND p_processor_key <> 'stripe' )
            THEN
                v_obj := (((((( v_obj - 'byopCustomerRef') - 'byopProcessor') - 'cardSavedDate')
                            - 'stripeCustomerId') - 'stripePaymentMethodId') - 'paymentMethodLabel') - 'paymentMethodType';
                v_obj := jsonb_set(
                    v_obj, '{cardOnFile}',
                    CASE WHEN jsonb_typeof(v_obj->'savedPaymentMethods') = 'array'
                              AND jsonb_array_length(v_obj->'savedPaymentMethods') > 0
                         THEN 'true'::jsonb ELSE 'false'::jsonb END,
                    true);
                v_famsChanged := true;
                v_cleared := v_cleared + 1;
            END IF;

            PERFORM public.camp_family_save(p_camp_id, rec.key, v_obj);
        END LOOP;

        IF v_famsChanged THEN
        END IF;
    END IF;

    -- ── Canteen auto-reload cards ────────────────────────────────────────────
    -- On ROWS, not on campistrySnacks.accounts. This half of the function was left
    -- on the document by 214 and never converted: since 219 the accounts live in
    -- camp_canteen_accounts and campistry_snacks.js no longer writes them into the
    -- document at all, so this loop iterated an empty object and cleared nothing.
    -- An owner switching processor kept every camper's stale token, and canteen
    -- auto-reload went on trying to charge through a processor the camp had left.
    --
    -- One row at a time, and only the rows that need changing — a camp-wide
    -- unconditional rewrite is the contention 219 removed.
    FOR rec IN
        SELECT a.account_key AS key, public._canteen_account_json(a) AS value
          FROM camp_canteen_accounts a
         WHERE a.camp_id = p_camp_id AND a.deleted_at IS NULL
    LOOP
        v_ar := rec.value -> 'autoReload';
        IF v_ar IS NULL OR jsonb_typeof(v_ar) <> 'object' THEN
            CONTINUE;
        END IF;
        IF NOT ( ( (v_ar ? 'byopProcessor') AND (v_ar->>'byopProcessor') IS DISTINCT FROM p_processor_key )
                 OR ( COALESCE(v_ar->>'stripeCustomerId','') <> '' AND p_processor_key <> 'stripe' ) ) THEN
            CONTINUE;
        END IF;

        -- Lock the row before rewriting it, so a parent attaching a card at this
        -- instant does not have it cleared from under them by a read that
        -- predates it.
        v_obj := public.canteen_account_lock(p_camp_id, rec.key);
        IF v_obj IS NULL THEN
            CONTINUE;
        END IF;
        v_ar := v_obj -> 'autoReload';
        IF v_ar IS NULL OR jsonb_typeof(v_ar) <> 'object' THEN
            CONTINUE;
        END IF;

        v_ar := ((((( v_ar - 'byopCustomerRef') - 'byopProcessor') - 'stripeCustomerId')
                  - 'stripePaymentMethodId') - 'paymentMethodLabel') - 'paymentMethodType';
        v_ar := jsonb_set(v_ar, '{cardOnFile}', 'false'::jsonb, true);
        v_obj := jsonb_set(v_obj, '{autoReload}', v_ar, true);
        PERFORM public.canteen_account_save(p_camp_id, rec.key, v_obj);
        v_acctsChanged := true;
        v_cleared := v_cleared + 1;
    END LOOP;

    RETURN jsonb_build_object('success', true, 'cleared', v_cleared);
END;
$$;REVOKE ALL ON FUNCTION public._admin_clear_stale_byop_cards(uuid, text)
    FROM public, anon, authenticated;


-- ─── 6. the four signatures these replace ───────────────────────────────────
DROP FUNCTION IF EXISTS public.submit_canteen_deposit(text, numeric, uuid);
DROP FUNCTION IF EXISTS public.set_canteen_limits(text, numeric, numeric, numeric, uuid);
DROP FUNCTION IF EXISTS public.set_canteen_auto_reload(uuid, text, jsonb);
DROP FUNCTION IF EXISTS public.use_family_card_for_canteen_auto_reload(uuid, text, text);

DO $$
DECLARE
    r     record;
    names text[] := ARRAY['submit_canteen_deposit', 'set_canteen_limits',
                          'set_canteen_auto_reload',
                          'use_family_card_for_canteen_auto_reload'];
BEGIN
    FOR r IN
        SELECT p.proname, count(*) AS c
          FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
         WHERE ns.nspname = 'public' AND p.proname = ANY (names)
         GROUP BY p.proname
    LOOP
        IF r.c <> 1 THEN
            RAISE EXCEPTION 'public.% has % overloads — PostgREST cannot choose', r.proname, r.c;
        END IF;
    END LOOP;

    -- And the line is gone from all of them. This is the whole file, asked of the
    -- catalog rather than of the diff.
    FOR r IN
        SELECT p.proname
          FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
         WHERE ns.nspname = 'public' AND p.proname = ANY (names)
           AND p.prosrc ~ 'camper_names \?'
    LOOP
        RAISE EXCEPTION 'public.% still tests camper_names ? by hand', r.proname;
    END LOOP;
END $$;


-- ─── did it work? ───────────────────────────────────────────────────────────
-- Camp-wide: no parent-facing canteen writer asks the question itself any more.
SELECT 'migration 231 applied' AS status,
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prokind = 'f'
           AND p.prosrc ~ 'camper_names \?')                        AS still_matching_names_by_hand,
       (SELECT COALESCE(jsonb_agg(DISTINCT p.proname), '[]'::jsonb)
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prokind = 'f'
           AND p.prosrc ~ 'camper_names \?')                        AS which;
