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

    var PLAN_LIMITS = Object.freeze({
        starter:         Object.freeze({ maxScheduleDays: 7,        maxCampers: 100      }),
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
// SQL TO RUN IN SUPABASE DASHBOARD (copy each block separately)
// =================================================================
//
// --- RPC: check_schedule_limit ---
/*
CREATE OR REPLACE FUNCTION check_schedule_limit(p_camp_id UUID, p_date_key TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_plan_status TEXT;
    v_current_count INT;
    v_max_days INT := 7;
    v_date_exists BOOLEAN;
BEGIN
    SELECT plan_status INTO v_plan_status
    FROM camps WHERE id = p_camp_id;

    IF v_plan_status IS DISTINCT FROM 'starter' THEN
        RETURN jsonb_build_object('allowed', true, 'plan', COALESCE(v_plan_status, 'unknown'));
    END IF;

    SELECT EXISTS(
        SELECT 1 FROM daily_schedules
        WHERE camp_id = p_camp_id AND date_key = p_date_key
    ) INTO v_date_exists;

    IF v_date_exists THEN
        RETURN jsonb_build_object('allowed', true, 'reason', 'existing_date');
    END IF;

    SELECT COUNT(DISTINCT date_key) INTO v_current_count
    FROM daily_schedules WHERE camp_id = p_camp_id;

    IF v_current_count >= v_max_days THEN
        RETURN jsonb_build_object(
            'allowed', false,
            'reason', 'schedule_limit_reached',
            'current', v_current_count,
            'max', v_max_days
        );
    END IF;

    RETURN jsonb_build_object('allowed', true, 'current', v_current_count, 'max', v_max_days);
END;
$$;
*/
//
// --- RPC: check_camper_limit ---
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
/*
CREATE OR REPLACE FUNCTION enforce_starter_schedule_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_plan_status TEXT;
    v_current_count INT;
    v_max_days INT := 7;
    v_date_exists BOOLEAN;
BEGIN
    SELECT plan_status INTO v_plan_status
    FROM camps WHERE id = NEW.camp_id
    FOR UPDATE;

    IF v_plan_status IS DISTINCT FROM 'starter' THEN
        RETURN NEW;
    END IF;

    SELECT EXISTS(
        SELECT 1 FROM daily_schedules
        WHERE camp_id = NEW.camp_id AND date_key = NEW.date_key
        AND id IS DISTINCT FROM NEW.id
    ) INTO v_date_exists;

    IF v_date_exists THEN
        RETURN NEW;
    END IF;

    SELECT COUNT(DISTINCT date_key) INTO v_current_count
    FROM daily_schedules WHERE camp_id = NEW.camp_id;

    IF v_current_count >= v_max_days THEN
        RAISE EXCEPTION 'Starter plan limit: maximum % unique schedule days reached. Upgrade to create more schedules.', v_max_days
            USING ERRCODE = 'P0001';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_starter_schedule_limit
    BEFORE INSERT ON daily_schedules
    FOR EACH ROW
    EXECUTE FUNCTION enforce_starter_schedule_limit();
*/
//
// --- TRIGGER: enforce_starter_camper_limit ---
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
        RAISE EXCEPTION 'Starter plan limit: maximum % campers reached. Upgrade to add more campers.', v_max_campers
            USING ERRCODE = 'P0001';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_starter_camper_limit
    BEFORE INSERT OR UPDATE ON camp_state
    FOR EACH ROW
    EXECUTE FUNCTION enforce_starter_camper_limit();
*/
