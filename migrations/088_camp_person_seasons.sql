-- =============================================================================
-- Migration 088: Attendance History — camp_person_seasons + camp_person_links
--
-- Campistry has never had a season/year concept: camp_id is a stable UUID
-- tied 1:1 to the owner and never recreated, and roster/staffApplications
-- live in ONE mutable camp_state_kv row that gets overwritten in place —
-- a CSV re-import (importRows()) wipes it with zero archive kept. So "show
-- a camper's/staff member's history in camp across years" needs a real,
-- durable, append-only store that survives that wipe — this table.
--
-- One row per (camp, person, season). `person_id` is the shared
-- nextPersonId sequence already unified across campers and staff earlier
-- this session (campistry_me.js) — the same stable numeric id whether this
-- person was ever a camper, staff, or (over the years) both.
--
-- camp_person_links records a CONFIRMED cross-link between a camper-side
-- person_id and a staff-side person_id for the same real human — e.g. a
-- staff member who was a camper here years ago. Suggested (not yet
-- confirmed) matches are computed on the fly by get_possible_person_links,
-- never persisted until explicitly accepted.
--
-- Same convention as every other table this session: RLS enabled, ZERO
-- client-side policies, every access goes through a SECURITY DEFINER RPC
-- that checks camp staff membership itself.
-- =============================================================================

-- ─── 1. camp_person_seasons ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS camp_person_seasons (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    camp_id       uuid NOT NULL REFERENCES camps(id) ON DELETE CASCADE,
    person_id     integer NOT NULL,
    person_type   text NOT NULL CHECK (person_type IN ('camper', 'staff')),
    season_label  text NOT NULL,
    season_year   integer,
    name          text NOT NULL,
    snapshot      jsonb NOT NULL DEFAULT '{}'::jsonb,
    archived_at   timestamptz NOT NULL DEFAULT now(),
    archived_by   uuid,
    UNIQUE (camp_id, person_id, person_type, season_label)
);
CREATE INDEX IF NOT EXISTS camp_person_seasons_lookup_idx
    ON camp_person_seasons (camp_id, person_id);
CREATE INDEX IF NOT EXISTS camp_person_seasons_name_idx
    ON camp_person_seasons (camp_id, lower(trim(name)));

ALTER TABLE camp_person_seasons ENABLE ROW LEVEL SECURITY;
-- No client-side policies — every access goes through the RPCs below.

-- ─── 2. camp_person_links — confirmed camper<->staff identity links ────────
CREATE TABLE IF NOT EXISTS camp_person_links (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    camp_id        uuid NOT NULL REFERENCES camps(id) ON DELETE CASCADE,
    person_id_a    integer NOT NULL,
    type_a         text NOT NULL CHECK (type_a IN ('camper', 'staff')),
    person_id_b    integer NOT NULL,
    type_b         text NOT NULL CHECK (type_b IN ('camper', 'staff')),
    confirmed_at   timestamptz NOT NULL DEFAULT now(),
    confirmed_by   uuid
);
-- One confirmed link per pair, regardless of which side is passed first.
CREATE UNIQUE INDEX IF NOT EXISTS camp_person_links_pair_uq
    ON camp_person_links (camp_id, LEAST(person_id_a, person_id_b), GREATEST(person_id_a, person_id_b));

ALTER TABLE camp_person_links ENABLE ROW LEVEL SECURITY;

-- ─── 3. archive_camp_season — snapshot every current person for one season ──
-- Client builds p_people from the CURRENT roster + hiredStaff() (that's
-- where division/grade/bunk/position/school/parent data already lives —
-- no reason to duplicate that read server-side). Idempotent per
-- (camp_id, person_id, person_type, season_label): re-archiving the same
-- label just updates the snapshot, never duplicates a row — safe to call
-- more than once for the same season (e.g. re-running before the actual
-- wipe, or a manual mid-season snapshot).
--
-- Deliberately server-side-only — reads camp_state_kv('campistryMe')
-- directly rather than accepting a client-built people list. Two reasons:
-- (1) it needs to be callable from ANY page (a Dashboard "Archive Current
-- Season" button, not just campistry_me.js, which is the only script with
-- `roster`/`staffApplications` loaded into memory) without duplicating
-- that read client-side; (2) it can't be handed fabricated snapshot data.
-- roster/staffApplications are already saved on every edit throughout this
-- app (no batched/delayed writes), so reading the DB copy at archive time
-- reflects the same state the in-memory one would.
CREATE OR REPLACE FUNCTION public.archive_camp_season(
    p_camp_id      uuid,
    p_season_label text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller    uuid := auth.uid();
    kv_value  jsonb;
    camper_kv record;
    staff_kv  record;
    n_saved   integer := 0;
    v_year    integer := extract(year from now())::integer;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    IF NOT EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = p_camp_id AND u.user_id = caller)
       AND NOT EXISTS (SELECT 1 FROM camps c WHERE c.id = p_camp_id AND c.owner = caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_a_member');
    END IF;
    IF p_season_label IS NULL OR trim(p_season_label) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'season_label_required');
    END IF;

    SELECT value INTO kv_value FROM camp_state_kv WHERE camp_id = p_camp_id AND key = 'campistryMe';
    IF kv_value IS NULL THEN
        RETURN jsonb_build_object('success', true, 'saved', 0);
    END IF;

    FOR camper_kv IN SELECT * FROM jsonb_each(coalesce(kv_value->'roster', '{}'::jsonb))
    LOOP
        IF (camper_kv.value->>'camperId') IS NULL THEN CONTINUE; END IF; -- no stable id, nothing to key the row on
        INSERT INTO camp_person_seasons
            (camp_id, person_id, person_type, season_label, season_year, name, snapshot, archived_by)
        VALUES (
            p_camp_id, (camper_kv.value->>'camperId')::integer, 'camper', trim(p_season_label), v_year, camper_kv.key,
            jsonb_build_object(
                'division', camper_kv.value->>'division', 'grade', camper_kv.value->>'grade', 'bunk', camper_kv.value->>'bunk',
                'dob', camper_kv.value->>'dob', 'school', camper_kv.value->>'school', 'schoolGrade', camper_kv.value->>'schoolGrade',
                'parentName', camper_kv.value->>'parent1Name', 'parentEmail', camper_kv.value->>'parent1Email'
            ),
            caller
        )
        ON CONFLICT (camp_id, person_id, person_type, season_label)
        DO UPDATE SET name = EXCLUDED.name, season_year = EXCLUDED.season_year, snapshot = EXCLUDED.snapshot,
            archived_at = now(), archived_by = EXCLUDED.archived_by;
        n_saved := n_saved + 1;
    END LOOP;

    -- Only HIRED applicants — same "arrived, not just applied" boundary
    -- Staff ID itself uses (setStaffStatus in campistry_me.js).
    FOR staff_kv IN SELECT * FROM jsonb_each(coalesce(kv_value->'staffApplications', '{}'::jsonb))
    LOOP
        IF (staff_kv.value->>'status') IS DISTINCT FROM 'hired' THEN CONTINUE; END IF;
        IF (staff_kv.value->>'staffId') IS NULL THEN CONTINUE; END IF;
        INSERT INTO camp_person_seasons
            (camp_id, person_id, person_type, season_label, season_year, name, snapshot, archived_by)
        VALUES (
            p_camp_id, (staff_kv.value->>'staffId')::integer, 'staff', trim(p_season_label), v_year,
            coalesce(nullif(staff_kv.value->>'name',''), trim(coalesce(staff_kv.value->>'first','')||' '||coalesce(staff_kv.value->>'last',''))),
            jsonb_build_object(
                'position', staff_kv.value->'positions', 'dob', staff_kv.value->>'dob',
                'school', staff_kv.value->>'school', 'schoolGrade', staff_kv.value->>'schoolGrade',
                'parentName', staff_kv.value->>'parentName', 'parentEmail', staff_kv.value->>'parentEmail'
            ),
            caller
        )
        ON CONFLICT (camp_id, person_id, person_type, season_label)
        DO UPDATE SET name = EXCLUDED.name, season_year = EXCLUDED.season_year, snapshot = EXCLUDED.snapshot,
            archived_at = now(), archived_by = EXCLUDED.archived_by;
        n_saved := n_saved + 1;
    END LOOP;

    RETURN jsonb_build_object('success', true, 'saved', n_saved);
END;
$$;
REVOKE ALL ON FUNCTION public.archive_camp_season(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.archive_camp_season(uuid, text) TO authenticated;

-- ─── 4. get_person_history — a person's seasons, plus any linked person's ──
CREATE OR REPLACE FUNCTION public.get_person_history(
    p_camp_id   uuid,
    p_person_id integer
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller       uuid := auth.uid();
    linked_id    integer;
    linked_type  text;
    seasons      jsonb;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    IF NOT EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = p_camp_id AND u.user_id = caller)
       AND NOT EXISTS (SELECT 1 FROM camps c WHERE c.id = p_camp_id AND c.owner = caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_a_member');
    END IF;

    SELECT CASE WHEN person_id_a = p_person_id THEN person_id_b ELSE person_id_a END,
           CASE WHEN person_id_a = p_person_id THEN type_b ELSE type_a END
    INTO linked_id, linked_type
    FROM camp_person_links
    WHERE camp_id = p_camp_id AND (person_id_a = p_person_id OR person_id_b = p_person_id)
    LIMIT 1;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'personId', s.person_id, 'personType', s.person_type,
        'seasonLabel', s.season_label, 'seasonYear', s.season_year,
        'name', s.name, 'snapshot', s.snapshot, 'archivedAt', s.archived_at
    ) ORDER BY s.season_year DESC NULLS LAST, s.archived_at DESC), '[]'::jsonb)
    INTO seasons
    FROM camp_person_seasons s
    WHERE s.camp_id = p_camp_id
      AND (s.person_id = p_person_id OR (linked_id IS NOT NULL AND s.person_id = linked_id));

    RETURN jsonb_build_object(
        'success', true, 'seasons', seasons,
        'linkedPersonId', linked_id, 'linkedPersonType', linked_type
    );
END;
$$;
REVOKE ALL ON FUNCTION public.get_person_history(uuid, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.get_person_history(uuid, integer) TO authenticated;

-- ─── 5. get_possible_person_links — suggest a same-person match ────────────
-- Only ever looks at the OPPOSITE person_type's archived seasons (a camper
-- gets suggested staff matches and vice versa) — this is specifically for
-- "was this staff member a camper here" (and the reverse), not general
-- dedupe. Name match is a normalized exact compare (same rigor as the rest
-- of this codebase's matching logic — no fuzzy-string extension assumed
-- installed). DOB (read from snapshot->>'dob') is a strong disambiguator:
-- a DOB conflict excludes the candidate outright; a DOB match on both
-- sides is 'high' confidence; anything else with a name match is 'medium'.
CREATE OR REPLACE FUNCTION public.get_possible_person_links(
    p_camp_id   uuid,
    p_person_id integer,
    p_type      text,
    p_name      text,
    p_dob       text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller     uuid := auth.uid();
    other_type text := CASE WHEN p_type = 'camper' THEN 'staff' ELSE 'camper' END;
    result     jsonb;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    IF NOT EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = p_camp_id AND u.user_id = caller)
       AND NOT EXISTS (SELECT 1 FROM camps c WHERE c.id = p_camp_id AND c.owner = caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_a_member');
    END IF;
    IF p_name IS NULL OR trim(p_name) = '' OR p_type NOT IN ('camper','staff') THEN
        RETURN jsonb_build_object('success', true, 'candidates', '[]'::jsonb);
    END IF;
    -- Already linked — nothing to suggest.
    IF EXISTS (
        SELECT 1 FROM camp_person_links
        WHERE camp_id = p_camp_id AND (person_id_a = p_person_id OR person_id_b = p_person_id)
    ) THEN
        RETURN jsonb_build_object('success', true, 'candidates', '[]'::jsonb);
    END IF;

    WITH candidates AS (
        SELECT s.person_id, s.person_type, s.name,
               array_agg(DISTINCT s.season_label) AS labels,
               (array_agg(s.snapshot->>'dob') FILTER (WHERE s.snapshot->>'dob' IS NOT NULL))[1] AS dob
        FROM camp_person_seasons s
        WHERE s.camp_id = p_camp_id
          AND s.person_type = other_type
          AND s.person_id <> p_person_id
          AND lower(trim(s.name)) = lower(trim(p_name))
        GROUP BY s.person_id, s.person_type, s.name
    )
    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'personId', c.person_id, 'personType', c.person_type, 'name', c.name,
        'seasonLabels', to_jsonb(c.labels),
        'confidence', CASE
            WHEN p_dob IS NOT NULL AND c.dob IS NOT NULL AND p_dob = c.dob THEN 'high'
            ELSE 'medium'
        END
    )), '[]'::jsonb)
    INTO result
    FROM candidates c
    -- Exclude only on a genuine DOB CONFLICT (both known, both different) —
    -- an unknown DOB on either side never excludes, only downgrades confidence.
    WHERE NOT (p_dob IS NOT NULL AND c.dob IS NOT NULL AND p_dob <> c.dob);

    RETURN jsonb_build_object('success', true, 'candidates', coalesce(result, '[]'::jsonb));
END;
$$;
REVOKE ALL ON FUNCTION public.get_possible_person_links(uuid, integer, text, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.get_possible_person_links(uuid, integer, text, text, text) TO authenticated;

-- ─── 6. confirm_person_link — accept a suggested match ─────────────────────
CREATE OR REPLACE FUNCTION public.confirm_person_link(
    p_camp_id     uuid,
    p_person_id_a integer,
    p_type_a      text,
    p_person_id_b integer,
    p_type_b      text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    IF NOT EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = p_camp_id AND u.user_id = caller)
       AND NOT EXISTS (SELECT 1 FROM camps c WHERE c.id = p_camp_id AND c.owner = caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_a_member');
    END IF;
    IF p_person_id_a IS NULL OR p_person_id_b IS NULL OR p_person_id_a = p_person_id_b THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_payload');
    END IF;

    INSERT INTO camp_person_links (camp_id, person_id_a, type_a, person_id_b, type_b, confirmed_by)
    VALUES (p_camp_id, p_person_id_a, p_type_a, p_person_id_b, p_type_b, caller)
    ON CONFLICT (camp_id, LEAST(person_id_a, person_id_b), GREATEST(person_id_a, person_id_b)) DO NOTHING;

    RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public.confirm_person_link(uuid, integer, text, integer, text) FROM public;
GRANT EXECUTE ON FUNCTION public.confirm_person_link(uuid, integer, text, integer, text) TO authenticated;

-- ─── Sanity check ────────────────────────────────────────────────────────
--   select proname from pg_proc where proname in
--     ('archive_camp_season','get_person_history','get_possible_person_links','confirm_person_link');
--   select archive_camp_season('<camp id>'::uuid, 'Summer 2026');
--   select * from camp_person_seasons where camp_id = '<camp id>'::uuid;
--   select get_person_history('<camp id>'::uuid, 1);
-- =============================================================================
