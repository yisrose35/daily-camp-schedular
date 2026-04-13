// =================================================================
// plan_limits.js — Starter Plan Feature Limits (v1.0)
// =================================================================
// Single source of truth for plan-based feature limits.
// Load this BEFORE trial_guard.js on all app pages.
//
// Server-side enforcement (PostgreSQL triggers + RPCs) uses the same
// limits hardcoded in the database functions. If you change limits
// here, also update the SQL functions in Supabase:
//   - check_schedule_limit()       (RPC)
//   - check_camper_limit()         (RPC)
//   - enforce_starter_schedule_limit()  (trigger)
//   - enforce_starter_camper_limit()    (trigger)
// =================================================================
(function() {
    'use strict';

    // starter: unlimited time in app, but generation expires 7 calendar days
    //          after first schedule generation + max 100 campers in Me/Go.
    //          User is NOT locked out — they keep full read/view access,
    //          they just can't generate new schedules or add more campers.
    // trial (expo2026): 48-hour full access, no feature limits
    // active (justcampit2026): full access, no limits
    var PLAN_LIMITS = Object.freeze({
        starter:         Object.freeze({ generationWindowDays: 7,   maxCampers: 100      }),
        trial:           Object.freeze({ maxScheduleDays: Infinity,  maxCampers: Infinity }),
        active:          Object.freeze({ maxScheduleDays: Infinity,  maxCampers: Infinity }),
        paid:            Object.freeze({ maxScheduleDays: Infinity,  maxCampers: Infinity }),
        founding_member: Object.freeze({ maxScheduleDays: Infinity,  maxCampers: Infinity })
    });

    window.PLAN_LIMITS = PLAN_LIMITS;

    /**
     * Get limits for a plan status. Unknown plans get no limits (fail open).
     * @param {string} planStatus - e.g. 'starter', 'active', 'paid'
     * @returns {{ maxScheduleDays: number, maxCampers: number }}
     */
    window.getPlanLimits = function(planStatus) {
        return PLAN_LIMITS[planStatus] || { maxScheduleDays: Infinity, maxCampers: Infinity };
    };

    /**
     * Check if a plan has any feature limits.
     * @param {string} planStatus
     * @returns {boolean}
     */
    window.isPlanLimited = function(planStatus) {
        var limits = PLAN_LIMITS[planStatus];
        if (!limits) return false;
        return limits.maxScheduleDays !== Infinity || limits.maxCampers !== Infinity;
    };

    /**
     * Full-access plan statuses (no limits, no trial).
     */
    window.FULL_ACCESS_PLANS = Object.freeze(['active', 'paid', 'founding_member']);

    console.log('[PlanLimits] v1.0 loaded — starter: ' + PLAN_LIMITS.starter.maxScheduleDays + ' schedules, ' + PLAN_LIMITS.starter.maxCampers + ' campers');
})();

// =================================================================
// SQL TO RUN IN SUPABASE DASHBOARD
// =================================================================
// PREREQUISITES:
//   ALTER TABLE camps ADD COLUMN IF NOT EXISTS first_generation_at TIMESTAMPTZ DEFAULT NULL;
//
// --- RPC: check_schedule_limit ---
// Starter plan: 7 calendar days from first generation, then no more new schedules.
// Existing schedules can still be viewed/edited. User is NOT locked out.
/*
CREATE OR REPLACE FUNCTION check_schedule_limit(p_camp_id UUID, p_date_key TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_plan_status TEXT;
    v_first_gen TIMESTAMPTZ;
    v_days_left INT;
    v_window_days INT := 7;
BEGIN
    SELECT plan_status, first_generation_at INTO v_plan_status, v_first_gen
    FROM camps WHERE id = p_camp_id;

    IF v_plan_status IS DISTINCT FROM 'starter' THEN
        RETURN jsonb_build_object('allowed', true, 'plan', COALESCE(v_plan_status, 'unknown'));
    END IF;

    -- First generation ever: allow and stamp the start time
    IF v_first_gen IS NULL THEN
        UPDATE camps SET first_generation_at = NOW() WHERE id = p_camp_id;
        RETURN jsonb_build_object('allowed', true, 'days_left', v_window_days, 'first_generation', true);
    END IF;

    -- Calculate remaining days
    v_days_left := v_window_days - EXTRACT(DAY FROM (NOW() - v_first_gen))::INT;

    IF v_days_left <= 0 THEN
        RETURN jsonb_build_object(
            'allowed', false,
            'reason', 'generation_window_expired',
            'days_left', 0,
            'first_generation_at', v_first_gen,
            'window_days', v_window_days
        );
    END IF;

    RETURN jsonb_build_object('allowed', true, 'days_left', v_days_left, 'window_days', v_window_days);
END;
$$;
*/
//
// --- RPC: check_camper_limit ---
// Starter plan: max 100 campers. User can still use app, just can't add more.
/*
CREATE OR REPLACE FUNCTION check_camper_limit(p_camp_id UUID, p_new_count INT DEFAULT 1)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_plan_status TEXT;
    v_current_count INT;
    v_max_campers INT := 100;
BEGIN
    SELECT plan_status INTO v_plan_status
    FROM camps WHERE id = p_camp_id;

    IF v_plan_status IS DISTINCT FROM 'starter' THEN
        RETURN jsonb_build_object('allowed', true, 'plan', COALESCE(v_plan_status, 'unknown'));
    END IF;

    SELECT COUNT(*) INTO v_current_count
    FROM (
        SELECT jsonb_object_keys(state->'app1'->'camperRoster')
        FROM camp_state WHERE camp_id = p_camp_id
    ) sub;

    IF (v_current_count + p_new_count) > v_max_campers THEN
        RETURN jsonb_build_object(
            'allowed', false,
            'reason', 'camper_limit_reached',
            'current', v_current_count,
            'max', v_max_campers,
            'requested', p_new_count
        );
    END IF;

    RETURN jsonb_build_object('allowed', true, 'current', v_current_count, 'max', v_max_campers);
END;
$$;
*/
//
// --- TRIGGER: enforce_starter_schedule_limit ---
// Blocks INSERT of new schedules after 7-day window expires.
// Allows updates to existing schedule rows (upsert on conflict = UPDATE, not INSERT).
/*
CREATE OR REPLACE FUNCTION enforce_starter_schedule_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_plan_status TEXT;
    v_first_gen TIMESTAMPTZ;
    v_window_days INT := 7;
BEGIN
    SELECT plan_status, first_generation_at INTO v_plan_status, v_first_gen
    FROM camps WHERE id = NEW.camp_id
    FOR UPDATE;

    IF v_plan_status IS DISTINCT FROM 'starter' THEN
        RETURN NEW;
    END IF;

    -- No first generation yet: stamp it and allow
    IF v_first_gen IS NULL THEN
        UPDATE camps SET first_generation_at = NOW() WHERE id = NEW.camp_id;
        RETURN NEW;
    END IF;

    -- Check if window expired
    IF (NOW() - v_first_gen) > (v_window_days || ' days')::INTERVAL THEN
        RAISE EXCEPTION 'Starter plan: your 7-day generation window has expired. Upgrade for unlimited scheduling.'
            USING ERRCODE = 'P0001';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_starter_schedule_limit ON daily_schedules;
CREATE TRIGGER trg_starter_schedule_limit
    BEFORE INSERT ON daily_schedules
    FOR EACH ROW
    EXECUTE FUNCTION enforce_starter_schedule_limit();
*/
//
// --- TRIGGER: enforce_starter_camper_limit ---
// Blocks camper roster saves that exceed 100. User keeps existing campers.
/*
CREATE OR REPLACE FUNCTION enforce_starter_camper_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_plan_status TEXT;
    v_new_count INT;
    v_max_campers INT := 100;
BEGIN
    SELECT plan_status INTO v_plan_status
    FROM camps WHERE id = NEW.camp_id
    FOR UPDATE;

    IF v_plan_status IS DISTINCT FROM 'starter' THEN
        RETURN NEW;
    END IF;

    SELECT COUNT(*) INTO v_new_count
    FROM jsonb_object_keys(COALESCE(NEW.state->'app1'->'camperRoster', '{}'::jsonb));

    IF v_new_count > v_max_campers THEN
        RAISE EXCEPTION 'Starter plan: maximum % campers reached. Upgrade for unlimited campers.', v_max_campers
            USING ERRCODE = 'P0001';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_starter_camper_limit ON camp_state;
CREATE TRIGGER trg_starter_camper_limit
    BEFORE INSERT OR UPDATE ON camp_state
    FOR EACH ROW
    EXECUTE FUNCTION enforce_starter_camper_limit();
*/
