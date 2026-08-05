-- ============================================================================
-- Migration 050: medication STATUS for counselors, without the health record
-- ----------------------------------------------------------------------------
-- Two things, and the second is a hole 049 left open.
--
-- 1. A counselor should be able to see that their camper needs medication and
--    whether it has been given today. That is the medStatus toggle in the
--    visibility policy — deliberately separate from medication DETAIL (drug
--    names and doses), which stays behind its own toggle and is off by default.
--
-- 2. 049 took app1 and campistryMe away from counselors but left campistryHealth
--    readable. That blob holds dispensingLog, sickVisits, doctorVisits,
--    bedwettingLog and medicalForms — for EVERY camper in the camp. A counselor
--    could read the lot. Closing that here.
--
-- The status a counselor legitimately needs is computed server-side and folded
-- into the camper record as two booleans, so they get the operational fact
-- ("Yossi has meds, the nurse hasn't given them yet") without the clinical
-- record behind it.
--
-- Idempotent. Safe to re-run. Requires 049.
-- ============================================================================

-- ─── 1. Rebuild lite_counselor_state() with medication status ──────────────
CREATE OR REPLACE FUNCTION public.lite_counselor_state()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_camp    uuid := get_user_camp_id();
    v_role    text := get_user_role();
    v_app1    jsonb;
    v_me      jsonb;
    v_health  jsonb;
    v_bunks   text[];
    v_fields  text[];
    v_roster  jsonb := '{}'::jsonb;
    v_staff   jsonb := '{}'::jsonb;
    v_today   text;
    r         record;
    v_camper  jsonb;
    v_needs   boolean;
    v_given   boolean;
    v_medtxt  text;
BEGIN
    IF v_camp IS NULL THEN RETURN '{}'::jsonb; END IF;

    SELECT value INTO v_app1   FROM camp_state_kv WHERE camp_id = v_camp AND key = 'app1';
    SELECT value INTO v_me     FROM camp_state_kv WHERE camp_id = v_camp AND key = 'campistryMe';
    SELECT value INTO v_health FROM camp_state_kv WHERE camp_id = v_camp AND key = 'campistryHealth';
    v_app1   := coalesce(v_app1, '{}'::jsonb);
    v_me     := coalesce(v_me, '{}'::jsonb);
    v_health := coalesce(v_health, '{}'::jsonb);

    IF v_role <> 'counselor' THEN
        RETURN jsonb_build_object('app1', v_app1, 'campistryMe', v_me);
    END IF;

    v_bunks  := lite_my_bunks();
    v_fields := lite_visible_camper_fields(v_me -> 'counselorVisibility');
    -- Camp-local date. The dispensing log is written with the camp's own day
    -- key, so comparing against UTC would roll over mid-evening for US camps.
    v_today  := to_char(now() AT TIME ZONE coalesce(v_app1 ->> 'timezone', 'America/New_York'), 'YYYY-MM-DD');

    FOR r IN SELECT * FROM jsonb_each(coalesce(v_app1 -> 'camperRoster', '{}'::jsonb)) LOOP
        IF (r.value ->> 'bunk') = ANY (v_bunks) THEN
            SELECT coalesce(jsonb_object_agg(k, v), '{}'::jsonb) INTO v_camper
              FROM jsonb_each(r.value) AS e(k, v)
             WHERE k = ANY (v_fields);

            -- Status only when the head counselor shares it. Booleans, never
            -- the drug name — that is the `medications` toggle's business.
            IF '_needsMeds' = ANY (v_fields) THEN
                v_medtxt := coalesce(r.value ->> 'medications', '');
                v_needs  := length(btrim(v_medtxt)) > 0;
                v_given  := FALSE;
                IF v_needs THEN
                    SELECT EXISTS (
                        SELECT 1
                          FROM jsonb_array_elements(coalesce(v_health -> 'dispensingLog', '[]'::jsonb)) d
                         WHERE d.value ->> 'camperName' = r.key
                           AND d.value ->> 'date' = v_today
                           AND coalesce(d.value ->> 'status', 'Given') = 'Given'
                    ) INTO v_given;
                END IF;
                v_camper := v_camper
                    || jsonb_build_object('_needsMeds', v_needs)
                    || jsonb_build_object('_medsGivenToday', v_given);
            END IF;

            v_roster := v_roster || jsonb_build_object(r.key, v_camper);
        END IF;
    END LOOP;

    FOR r IN SELECT * FROM jsonb_each(coalesce(v_me -> 'bunkStaff', '{}'::jsonb)) LOOP
        IF r.key = ANY (v_bunks) THEN
            v_staff := v_staff || jsonb_build_object(r.key, r.value);
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'app1', jsonb_build_object(
            'divisions',         coalesce(v_app1 -> 'divisions', '{}'::jsonb),
            'fields',            coalesce(v_app1 -> 'fields', '[]'::jsonb),
            'specialActivities', coalesce(v_app1 -> 'specialActivities', '[]'::jsonb),
            'camperRoster',      v_roster
        ),
        'campistryMe', jsonb_build_object(
            'bunkStaff',            v_staff,
            'counselorVisibility',  coalesce(v_me -> 'counselorVisibility', 'null'::jsonb)
        )
    );
END;
$$;

REVOKE ALL ON FUNCTION public.lite_counselor_state() FROM public;
GRANT EXECUTE ON FUNCTION public.lite_counselor_state() TO authenticated;

-- ─── 2. Close campistryHealth to counselors ────────────────────────────────
-- dispensingLog / sickVisits / doctorVisits / bedwettingLog / medicalForms for
-- the whole camp. The two booleans above are the part of it a counselor needs.
DROP POLICY IF EXISTS camp_state_kv_select ON camp_state_kv;
CREATE POLICY camp_state_kv_select ON camp_state_kv
    FOR SELECT
    USING (
        camp_id = get_user_camp_id()
        AND (
            get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'scheduler'::text])
            OR (
                get_user_role() = 'counselor'::text
                AND key <> ALL (ARRAY['app1'::text, 'campistryMe'::text, 'campistryHealth'::text])
            )
        )
    );

-- ─── Sanity checks (run manually, signed in as a counselor) ────────────────
--   -- all three must return zero rows:
--   SELECT key FROM camp_state_kv
--    WHERE key IN ('app1','campistryMe','campistryHealth');
--
--   -- campers carry the two status booleans but no drug names (with the
--   -- default policy, where medication DETAIL is off):
--   SELECT jsonb_pretty(lite_counselor_state() -> 'app1' -> 'camperRoster');
