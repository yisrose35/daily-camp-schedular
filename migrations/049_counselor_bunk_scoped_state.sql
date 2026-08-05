-- ============================================================================
-- Migration 049: counselors only receive their own bunks' data
-- ----------------------------------------------------------------------------
-- THE PROBLEM
--
-- Migration 018 gave the counselor role a blanket SELECT on camp_state_kv so
-- Campistry Lite could load. camp_state_kv is a key/value store of large JSON
-- blobs, and two of those blobs are not safe to hand to a counselor:
--
--   app1         → camperRoster: EVERY camper in the camp, with home address,
--                  parent phone/email, allergies, medications and medical notes.
--   campistryMe  → families, payments, payroll (staff salaries), leads and
--                  staff applications.
--
-- Campistry Lite filters campers down to the counselor's bunks in JavaScript,
-- and 048's visibility policy strips fields the head counselor withheld. Both
-- run in the browser, on data the browser already holds. Anyone who opens
-- devtools — or reads the network tab — sees the unfiltered payload. That is a
-- user-interface convenience, not access control.
--
-- THE FIX
--
-- Stop sending it. Counselors lose direct SELECT on those two keys and instead
-- call lite_counselor_state(), a SECURITY DEFINER function that assembles a
-- payload containing only the bunks they staff, with the head counselor's
-- visibility policy applied before the rows ever leave Postgres.
--
-- Every other key (campStructure, leaguesByName, fields, camp_name,
-- liteStaffAssignments, liteSmsSettings) stays directly readable — none of it
-- is personal data, and Lite needs it to render a schedule.
--
-- NOTE ON DUPLICATION
-- The field catalogue below mirrors campistry_visibility.js. Two copies is a
-- drift risk and it is deliberate: the server copy is the one that actually
-- enforces, the client copy exists so the UI can grey out a toggle without a
-- round trip. If you add a field to one, add it to the other. The server is
-- authoritative, and it FAILS CLOSED — a field it doesn't recognise is not
-- returned.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

-- ─── 1. Which camper fields a counselor may see ────────────────────────────
-- Returns the property names permitted under `policy` (the camp's saved
-- counselorVisibility object; NULL/absent keys fall back to the default here,
-- never to "allowed" — a newly added field must not become visible on camps
-- that saved a policy before it existed).
CREATE OR REPLACE FUNCTION public.lite_visible_camper_fields(policy jsonb)
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
    v_out text[] := ARRAY['name','firstName','lastName','bunk','grade','division'];
    v_pol jsonb := coalesce(policy, '{}'::jsonb);

    -- key, default, fields
    v_cat  text[][] := ARRAY[
        ARRAY['leagueTeam','true','team,teams'],
        ARRAY['allergies','true','allergies'],
        ARRAY['dietary','true','dietary'],
        ARRAY['medStatus','true','_needsMeds,_medsGivenToday'],
        ARRAY['emergency','true','emergencyName,emergencyRel,emergencyPhone'],
        ARRAY['swim','true','swimLevel'],
        ARRAY['medications','false','medications'],
        ARRAY['medicalNotes','false','medicalNotes'],
        ARRAY['physician','false','physician,physicianPhone,insuranceProvider,insurancePolicy'],
        ARRAY['parent','false','parent1Name,parent1Phone,parent1Email,parent2Name,parent2Phone,parent2Email'],
        ARRAY['homeAddress','false','street,city,state,zip'],
        ARRAY['summerAddress','false','summerStreet,summerCity,summerState,summerZip,summerPhone,summerSameAsHome'],
        ARRAY['birthday','false','dob'],
        ARRAY['school','false','school,schoolGrade,teacher'],
        ARRAY['bunkmates','false','bunkmateRequest,separateFrom'],
        ARRAY['shirtSize','false','shirtSize,camperType'],
        ARRAY['notes','false','notes,adminNotes']
    ];
    i int;
    v_key text;
    v_on boolean;
BEGIN
    FOR i IN 1 .. array_length(v_cat, 1) LOOP
        v_key := v_cat[i][1];
        IF v_pol ? v_key THEN
            v_on := coalesce((v_pol ->> v_key)::boolean, false);
        ELSE
            v_on := (v_cat[i][2] = 'true');
        END IF;
        IF v_on THEN
            v_out := v_out || string_to_array(v_cat[i][3], ',');
        END IF;
    END LOOP;
    RETURN v_out;
END;
$$;

-- ─── 2. The bunks this user staffs ─────────────────────────────────────────
-- Read from campistryMe.bunkStaff, matched on email — the same join key Me
-- writes and Lite reads, so there is one answer to "whose bunk is this".
CREATE OR REPLACE FUNCTION public.lite_my_bunks()
RETURNS text[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_camp  uuid := get_user_camp_id();
    v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
    v_me    jsonb;
    v_out   text[] := ARRAY[]::text[];
    r       record;
BEGIN
    IF v_camp IS NULL OR v_email = '' THEN RETURN v_out; END IF;

    SELECT value INTO v_me FROM camp_state_kv
     WHERE camp_id = v_camp AND key = 'campistryMe';
    IF v_me IS NULL THEN RETURN v_out; END IF;

    FOR r IN SELECT * FROM jsonb_each(coalesce(v_me -> 'bunkStaff', '{}'::jsonb)) LOOP
        IF EXISTS (
            SELECT 1 FROM jsonb_array_elements(r.value) s
             WHERE lower(coalesce(s.value ->> 'email', '')) = v_email
        ) THEN
            v_out := v_out || r.key;
        END IF;
    END LOOP;

    -- Fall back to the older liteStaffAssignments map so camps set up before
    -- the Me directory existed don't lose access on upgrade.
    IF array_length(v_out, 1) IS NULL THEN
        SELECT array(
            SELECT jsonb_array_elements_text(coalesce(value -> v_email -> 'bunks', '[]'::jsonb))
        ) INTO v_out
        FROM camp_state_kv
        WHERE camp_id = v_camp AND key = 'liteStaffAssignments';
    END IF;

    RETURN coalesce(v_out, ARRAY[]::text[]);
END;
$$;

-- ─── 3. The counselor's whole world, already filtered ──────────────────────
-- Returns { app1: {...}, campistryMe: {...} } holding ONLY what this counselor
-- may have. Head staff get the untouched blobs, because their direct SELECT is
-- unchanged and this function is simply how Lite asks.
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
    v_bunks   text[];
    v_fields  text[];
    v_roster  jsonb := '{}'::jsonb;
    v_staff   jsonb := '{}'::jsonb;
    r         record;
    v_camper  jsonb;
BEGIN
    IF v_camp IS NULL THEN RETURN '{}'::jsonb; END IF;

    SELECT value INTO v_app1 FROM camp_state_kv WHERE camp_id = v_camp AND key = 'app1';
    SELECT value INTO v_me   FROM camp_state_kv WHERE camp_id = v_camp AND key = 'campistryMe';
    v_app1 := coalesce(v_app1, '{}'::jsonb);
    v_me   := coalesce(v_me,   '{}'::jsonb);

    IF v_role <> 'counselor' THEN
        RETURN jsonb_build_object('app1', v_app1, 'campistryMe', v_me);
    END IF;

    v_bunks  := lite_my_bunks();
    v_fields := lite_visible_camper_fields(v_me -> 'counselorVisibility');

    -- Campers: only this counselor's bunks, only permitted properties.
    FOR r IN SELECT * FROM jsonb_each(coalesce(v_app1 -> 'camperRoster', '{}'::jsonb)) LOOP
        IF (r.value ->> 'bunk') = ANY (v_bunks) THEN
            SELECT coalesce(jsonb_object_agg(k, v), '{}'::jsonb) INTO v_camper
              FROM jsonb_each(r.value) AS e(k, v)
             WHERE k = ANY (v_fields);
            v_roster := v_roster || jsonb_build_object(r.key, v_camper);
        END IF;
    END LOOP;

    -- Staff directory: only the bunks they're on, so the app can show who they
    -- work with without handing over the camp's entire staff contact list.
    FOR r IN SELECT * FROM jsonb_each(coalesce(v_me -> 'bunkStaff', '{}'::jsonb)) LOOP
        IF r.key = ANY (v_bunks) THEN
            v_staff := v_staff || jsonb_build_object(r.key, r.value);
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        -- Structural config only: divisions/fields/specials are needed to draw
        -- a schedule and name nothing personal. camperRoster is the filtered
        -- one built above; everything else in app1 is dropped, not passed on.
        'app1', jsonb_build_object(
            'divisions',         coalesce(v_app1 -> 'divisions', '{}'::jsonb),
            'fields',            coalesce(v_app1 -> 'fields', '[]'::jsonb),
            'specialActivities', coalesce(v_app1 -> 'specialActivities', '[]'::jsonb),
            'camperRoster',      v_roster
        ),
        -- No families, payments, payroll, leads or staff applications.
        'campistryMe', jsonb_build_object(
            'bunkStaff',            v_staff,
            'counselorVisibility',  coalesce(v_me -> 'counselorVisibility', 'null'::jsonb)
        )
    );
END;
$$;

REVOKE ALL ON FUNCTION public.lite_counselor_state()          FROM public;
REVOKE ALL ON FUNCTION public.lite_my_bunks()                 FROM public;
REVOKE ALL ON FUNCTION public.lite_visible_camper_fields(jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.lite_counselor_state()          TO authenticated;
GRANT EXECUTE ON FUNCTION public.lite_my_bunks()                 TO authenticated;
GRANT EXECUTE ON FUNCTION public.lite_visible_camper_fields(jsonb) TO authenticated;

-- ─── 4. Take the raw blobs away from counselors ────────────────────────────
-- Everything else stays readable. Without this the function above is decoration:
-- the client could simply ask for app1 directly, as it does today.
DROP POLICY IF EXISTS camp_state_kv_select ON camp_state_kv;
CREATE POLICY camp_state_kv_select ON camp_state_kv
    FOR SELECT
    USING (
        camp_id = get_user_camp_id()
        AND (
            get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'scheduler'::text])
            OR (
                get_user_role() = 'counselor'::text
                AND key <> ALL (ARRAY['app1'::text, 'campistryMe'::text])
            )
        )
    );

-- ─── Sanity checks (run manually after applying) ───────────────────────────
--   -- as a counselor, both must return zero rows:
--   SELECT key FROM camp_state_kv WHERE key IN ('app1','campistryMe');
--
--   -- and this must return only their own bunks' campers:
--   SELECT jsonb_object_keys(lite_counselor_state() -> 'app1' -> 'camperRoster');
--
--   SELECT policyname, cmd, qual FROM pg_policies
--    WHERE tablename = 'camp_state_kv' AND policyname = 'camp_state_kv_select';
