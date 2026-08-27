-- ============================================================================
-- Migration 089: pickup-alert routing — notify grade heads AND division
-- heads, not one-or-the-other
--
-- Camp Structure (Camp/Structure page) now lets an owner assign a head to
-- a GRADE, not just to its parent division — different grades in the same
-- division can genuinely report to different heads. The data model already
-- supported this (divisionHeads{} in campistryMe is just keyed by any
-- string, division or grade), but migration 065's pickup-alert trigger only
-- read the grade-level entry as a FALLBACK when the division had zero
-- heads — so as soon as a division head existed, any grade-specific head
-- under that same division was silently never notified at all.
--
-- Fix: union both levels. A pickup alert now notifies the camper's grade
-- head(s) AND their division head(s) when both are set, not just one.
-- pickup_alert_recipients already dedupes on (alert_id, recipient_email),
-- so a person who happens to be both doesn't get double-listed.
--
-- Everything else in this function (idempotent camper_bunk re-resolution,
-- bunk-staff notification) is unchanged from migration 065 — only the
-- v_heads computation below is different.
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

    -- Division head(s) AND grade head(s) — a grade can have its own head,
    -- different from (and in addition to) its division's head. Both are
    -- notified when both are set; recipients dedupe by email below.
    v_heads := coalesce(v_me -> 'divisionHeads' -> v_division, '[]'::jsonb);
    IF v_grade IS NOT NULL THEN
        v_heads := v_heads || coalesce(v_me -> 'divisionHeads' -> v_grade, '[]'::jsonb);
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

-- The trigger itself is untouched (still fires on the same event), but
-- re-declaring it here is harmless and keeps this migration fully
-- self-contained/copy-pasteable on its own.
DROP TRIGGER IF EXISTS trg_notify_pickup_alert ON parent_pickup_requests;
CREATE TRIGGER trg_notify_pickup_alert
    AFTER UPDATE ON parent_pickup_requests
    FOR EACH ROW EXECUTE FUNCTION public.notify_pickup_alert();

-- ─── Sanity check ──────────────────────────────────────────────────────────
-- After confirming a real early-pickup request for a camper whose grade AND
-- division both have a head assigned in Camp Structure:
--   SELECT * FROM pickup_alerts ORDER BY created_at DESC LIMIT 1;
--   SELECT * FROM pickup_alert_recipients WHERE alert_id = '<id above>';
--   -- expect one row per grade head AND one row per division head (deduped
--   -- by email if the same person is both).
