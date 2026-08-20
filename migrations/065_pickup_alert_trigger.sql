-- ============================================================================
-- Migration 065: routing trigger — parent_pickup_requests -> pickup_alerts
--
-- Fires when an 'early' pickup request's status transitions to 'Confirmed'.
-- Creates the pickup_alerts row and one pickup_alert_recipients row per
-- resolved division head and bunk staff member.
--
-- Deliberately does NOT trust parent_pickup_requests.camper_bunk — confirmed
-- against campistry_link_parent.html's submitPickup('early') and migration
-- 025's submit_pickup_request: camper_bunk is populated from
-- p_details->>'childBunk', which the early-pickup form never sets. It is
-- empty on real rows today. Bunk/division are instead re-resolved fresh from
-- app1.camperRoster by camper name — both more correct (current assignment,
-- not a submit-time snapshot) and not dependent on a value that's silently
-- blank in production.
--
-- League-captain matching is NOT done here (see the plan this migration
-- implements) — that logic already exists correctly in
-- campistry_live_locator.js (JS, with schedule-format parsing/fallbacks not
-- worth re-implementing in plpgsql) and is wired client-side instead, in
-- campistry_live.html's confirm handler, via the add_pickup_alert_league_
-- recipients RPC (a later migration).
--
-- Idempotent. Safe to re-run.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.notify_pickup_alert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_app1     jsonb;
    v_me       jsonb;
    v_camper   jsonb;
    v_bunk     text;
    v_division text;
    v_grade    text;
    v_tz       text;
    v_alert_id uuid;
    v_heads    jsonb;
    v_bunkstaff jsonb;
    r          record;
BEGIN
    IF NEW.status <> 'Confirmed' OR OLD.status IS NOT DISTINCT FROM 'Confirmed' THEN RETURN NEW; END IF;
    IF NEW.type <> 'early' OR coalesce(NEW.details ->> 'pickupTime', '') = '' THEN RETURN NEW; END IF;

    SELECT value INTO v_app1 FROM camp_state_kv WHERE camp_id = NEW.camp_id AND key = 'app1';
    SELECT value INTO v_me   FROM camp_state_kv WHERE camp_id = NEW.camp_id AND key = 'campistryMe';
    v_app1 := coalesce(v_app1, '{}'::jsonb);
    v_me   := coalesce(v_me,   '{}'::jsonb);
    v_camper := (v_app1 -> 'camperRoster') -> NEW.camper_name;

    v_bunk     := coalesce(v_camper ->> 'bunk', NEW.camper_bunk);
    v_division := v_camper ->> 'division';
    v_grade    := v_camper ->> 'grade';

    SELECT timezone INTO v_tz FROM camps WHERE id = NEW.camp_id;
    v_tz := coalesce(v_tz, 'America/New_York');

    INSERT INTO pickup_alerts (
        camp_id, pickup_request_id, camper_name, camper_bunk, camper_division,
        camper_grade, pickup_time, pickup_at, request_date, created_by
    )
    VALUES (
        NEW.camp_id, NEW.id, NEW.camper_name, v_bunk, v_division, v_grade,
        NEW.details ->> 'pickupTime',
        (NEW.request_date::text || ' ' || (NEW.details ->> 'pickupTime') || ':00')::timestamp
            AT TIME ZONE v_tz,
        NEW.request_date, NEW.reviewed_by
    )
    ON CONFLICT (pickup_request_id) DO NOTHING
    RETURNING id INTO v_alert_id;

    IF v_alert_id IS NULL THEN RETURN NEW; END IF;   -- already handled — belt & suspenders

    -- Division head(s) — by division name, falling back to grade name, the
    -- same dual-level acceptance pattern used elsewhere (e.g. league
    -- division matching).
    v_heads := coalesce(v_me -> 'divisionHeads' -> v_division, '[]'::jsonb);
    IF jsonb_array_length(v_heads) = 0 AND v_grade IS NOT NULL THEN
        v_heads := coalesce(v_me -> 'divisionHeads' -> v_grade, '[]'::jsonb);
    END IF;
    FOR r IN SELECT * FROM jsonb_array_elements(v_heads) LOOP
        IF coalesce(r.value ->> 'email', '') <> '' THEN
            INSERT INTO pickup_alert_recipients (alert_id, camp_id, recipient_role, recipient_name, recipient_email)
            VALUES (v_alert_id, NEW.camp_id, 'division_head', r.value ->> 'name', lower(r.value ->> 'email'))
            ON CONFLICT (alert_id, recipient_email) DO NOTHING;
        END IF;
    END LOOP;

    -- Bunk staff (counselor + JC).
    v_bunkstaff := coalesce(v_me -> 'bunkStaff' -> v_bunk, '[]'::jsonb);
    FOR r IN SELECT * FROM jsonb_array_elements(v_bunkstaff) LOOP
        IF coalesce(r.value ->> 'email', '') <> '' THEN
            INSERT INTO pickup_alert_recipients (alert_id, camp_id, recipient_role, recipient_name, recipient_email)
            VALUES (v_alert_id, NEW.camp_id, 'bunk_staff', r.value ->> 'name', lower(r.value ->> 'email'))
            ON CONFLICT (alert_id, recipient_email) DO NOTHING;
        END IF;
    END LOOP;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_pickup_alert ON parent_pickup_requests;
CREATE TRIGGER trg_notify_pickup_alert
    AFTER UPDATE ON parent_pickup_requests
    FOR EACH ROW EXECUTE FUNCTION public.notify_pickup_alert();

-- ─── Sanity check ──────────────────────────────────────────────────────────
-- After confirming a real early-pickup request in Live:
--   SELECT * FROM pickup_alerts ORDER BY created_at DESC LIMIT 1;
--   SELECT * FROM pickup_alert_recipients WHERE alert_id = '<id above>';
