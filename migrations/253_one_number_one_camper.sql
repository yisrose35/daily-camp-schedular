-- ============================================================================
-- Migration 253: one number, one camper, and the server hands out the numbers.
--
-- THE RULE. In a camp, a camper number belongs to exactly one person at a time.
-- A number is taken while its camper is enrolled AND while they are departed
-- but not erased, because their history still points at it. Only erasing the
-- camper (254) frees the number.
--
-- WHAT WAS WRONG.
--
--   1. THE BROWSER MINTED THE NUMBERS. campistry_me.js takes "highest number in
--      my copy of the roster + 1". Two tabs, or two staff, adding a camper at
--      the same time both hand out the same number. 216 made the TABLE refuse
--      that: the second person kept or minted a different number. But the
--      ROSTER DOCUMENT still said the duplicate, and the document is what every
--      page reads. So two children showed the same number on every page, and
--      a page that looked a camper up by number could find either one.
--
--   2. A DEPARTED CAMPER'S NUMBER COULD BE TYPED ONTO A NEW CHILD. 216's
--      "rename" branch treats a number held by a person missing from the
--      document as the same person under a new name. A camper deleted weeks
--      ago is also missing from the document. So a new child typed in with
--      that number revived the departed row, with all of its history: canteen
--      balance, ledger, medical forms, photos and the parent's access.
--
--   3. A NUMBER TOO LONG FOR bigint (20+ digits pasted into the field) made
--      _person_id raise inside the trigger and aborted the whole roster save.
--
-- WHAT THIS DOES.
--
--   1. The numbering runs BEFORE the save and WRITES THE RESULT BACK INTO THE
--      ROSTER. Every camper in the saved document carries the number the
--      server gave them, so no two campers in the document can ever show one
--      number. A stale tab that sends a duplicate again gets corrected again,
--      to the same number, because a person keeps the number they have.
--
--   2. A number stated in the document is honoured only when:
--        - nobody holds it (it is free), or
--        - this same camper holds it (same roster entry), or
--        - it is a RENAME IN THIS SAVE: the holder was in the roster before
--          this save, is not in it after, and is the same kind of person.
--      Anything else is a conflict. The camper keeps their own number, or is
--      given a fresh one, and the document is corrected. A departed camper's
--      number is never re-issued. It stays theirs until 254 erases them.
--
--   3. Stated numbers longer than 15 digits are ignored, not fatal.
--
--   4. Staff (campistryMe.staffApplications) share the camp's number space and
--      get the same treatment. A staffId the document states is corrected when
--      someone else holds it.
--
--   5. REPAIR. Every camp whose roster disagrees with the table today (a
--      duplicate or missing number, or one that is not the camper's) is
--      renumbered once, here, by the same rules.
--
--   6. get_camper_numbers(camp): each live camper's number, plus the next free
--      one, so the Me page adopts the server's numbers after a save and never
--      proposes a taken one.
--
-- HOW TO APPLY. Paste into the SQL Editor after 252. The repair touches only
-- camps whose roster disagrees with camp_people.
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

DO $$
BEGIN
    IF to_regprocedure('public._move_person_references(uuid,bigint,bigint)') IS NULL THEN
        RAISE EXCEPTION '253 needs 237 (_move_person_references) — apply it first';
    END IF;
END $$;

-- Camp documents first, before any trigger changes (216 section 0b): a roster
-- save arriving mid-migration would otherwise deadlock against it. A busy camp
-- makes this wait 15 seconds and fail, rather than hang; paste it again.
SET LOCAL lock_timeout = '15s';
LOCK TABLE public.camp_state_kv IN ACCESS EXCLUSIVE MODE;


-- A number from the document, or NULL. Digits only, leading zeros dropped,
-- and never fatal: anything that would not fit is simply not a number.
CREATE OR REPLACE FUNCTION public._stated_person_id(p_raw text)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
    SELECT CASE WHEN d <> '' AND length(d) <= 15 THEN NULLIF(d::bigint, 0) END
      FROM (SELECT ltrim(regexp_replace(COALESCE(p_raw, ''), '\D', '', 'g'), '0') AS d) x
$$;


-- ─── the numbering ──────────────────────────────────────────────────────────
-- Returns {roster key: final number} for every entry it looked at.
-- p_all = true looks at every entry, not only the changed ones (the repair).
CREATE OR REPLACE FUNCTION public._number_people(
    p_camp_id    uuid,
    p_kind       text,
    p_old        jsonb,
    p_new        jsonb,
    p_id_field   text,
    p_name_field text,
    p_all        boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    r        record;
    h        record;
    v_stated bigint;
    v_have   bigint;
    v_name   text;
    v_id     bigint;
    v_out    jsonb := '{}'::jsonb;
BEGIN
    FOR r IN
        SELECT n.key AS k, n.value AS v
          FROM jsonb_each(p_new) AS n(key, value)
         WHERE jsonb_typeof(n.value) = 'object'
           AND (p_all OR (p_old -> n.key) IS DISTINCT FROM n.value)
         -- Stated numbers first, so a number minted for somebody without one
         -- can never take the number another entry in this same save is asking for.
         ORDER BY public._stated_person_id(n.value ->> p_id_field) IS NULL, n.key
    LOOP
        v_stated := public._stated_person_id(r.v ->> p_id_field);
        v_name   := COALESCE(NULLIF(r.v ->> p_name_field, ''), r.k);

        -- This roster entry's own live row, if it has one.
        SELECT person_id INTO v_have
          FROM camp_people
         WHERE camp_id = p_camp_id AND kind = p_kind AND source_key = r.k
           AND deleted_at IS NULL;

        IF v_stated IS NOT NULL THEN
            SELECT person_id, kind, source_key, deleted_at INTO h
              FROM camp_people
             WHERE camp_id = p_camp_id AND person_id = v_stated;

            IF NOT FOUND THEN
                NULL;                                   -- free: honour it
            ELSIF h.kind = p_kind AND h.source_key = r.k THEN
                -- The same entry. If it is departed and this entry has no live
                -- row, this is the camper coming back (Undo): revive them.
                -- If the entry already has a DIFFERENT live number, the stated
                -- one belongs to a departed person with the same name: refuse.
                IF v_have IS NOT NULL AND v_have <> v_stated THEN
                    v_stated := NULL;
                END IF;
            ELSIF h.kind = p_kind AND h.deleted_at IS NULL
                  AND v_have IS NULL
                  AND (p_old ? h.source_key) AND NOT (p_new ? h.source_key) THEN
                -- A rename in this save. The number is the person; carry the row.
                UPDATE camp_people
                   SET source_key = r.k, name = v_name, payload = r.v, updated_at = now()
                 WHERE camp_id = p_camp_id AND person_id = v_stated;
                v_out := v_out || jsonb_build_object(r.k, v_stated);
                CONTINUE;
            ELSE
                -- Somebody else's number: live elsewhere in the roster, of the
                -- other kind, or departed and not erased. Never handed over.
                v_stated := NULL;
            END IF;
        END IF;

        v_id := COALESCE(v_stated, v_have);

        IF v_id IS NULL THEN
            v_id := public.mint_person_id(p_camp_id);
            INSERT INTO camp_people (camp_id, person_id, kind, source_key, name, minted, payload)
            VALUES (p_camp_id, v_id, p_kind, r.k, v_name, true, r.v);
        ELSIF v_have IS NOT NULL AND v_id <> v_have THEN
            -- Renumbered by hand onto a free number: everything pointing at the
            -- old number comes too (237), then the row.
            -- If the move refuses (both numbers hold a canteen account), the
            -- camper keeps the number they have and the save still goes
            -- through: a roster save must never fail over a renumber.
            BEGIN
                PERFORM public._move_person_references(p_camp_id, v_have, v_id);
                UPDATE camp_people
                   SET person_id = v_id, name = v_name, payload = r.v,
                       minted = false, updated_at = now()
                 WHERE camp_id = p_camp_id AND person_id = v_have;
            EXCEPTION WHEN OTHERS THEN
                v_id := v_have;
            END;
        ELSE
            INSERT INTO camp_people (camp_id, person_id, kind, source_key, name, minted, payload)
            VALUES (p_camp_id, v_id, p_kind, r.k, v_name, false, r.v)
            ON CONFLICT (camp_id, person_id) DO UPDATE
               SET source_key = EXCLUDED.source_key,
                   name       = EXCLUDED.name,
                   payload    = EXCLUDED.payload,
                   deleted_at = NULL,
                   updated_at = now();
        END IF;

        v_out := v_out || jsonb_build_object(r.k, v_id);
    END LOOP;

    -- Gone from the document: departed. Their number stays theirs, and their
    -- history stays with it, until 254 erases them.
    UPDATE camp_people p
       SET deleted_at = now(), updated_at = now()
     WHERE p.camp_id = p_camp_id
       AND p.kind    = p_kind
       AND p.deleted_at IS NULL
       AND NOT (p_new ? p.source_key);

    RETURN v_out;
END;
$$;
REVOKE ALL ON FUNCTION public._number_people(uuid, text, jsonb, jsonb, text, text, boolean)
    FROM public, anon, authenticated;

-- Anything that still calls the old projection gets the new rules.
CREATE OR REPLACE FUNCTION public._project_people(
    p_camp_id uuid, p_kind text, p_old jsonb, p_new jsonb, p_id_field text, p_name_field text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    PERFORM public._number_people(p_camp_id, p_kind, p_old, p_new, p_id_field, p_name_field, false);
END;
$$;
REVOKE ALL ON FUNCTION public._project_people(uuid, text, jsonb, jsonb, text, text)
    FROM public, anon, authenticated;


-- ─── the triggers: number BEFORE the save, and write the numbers back ───────
CREATE OR REPLACE FUNCTION public.number_camp_campers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_old    jsonb := '{}'::jsonb;
    v_new    jsonb := '{}'::jsonb;
    v_all    boolean := COALESCE(current_setting('campistry.renumber_all', true), '') = 'on';
    v_ids    jsonb;
    e        record;
BEGIN
    IF TG_OP = 'UPDATE' AND NOT v_all AND jsonb_typeof(OLD.value -> 'camperRoster') = 'object' THEN
        v_old := OLD.value -> 'camperRoster';
    END IF;
    IF jsonb_typeof(NEW.value -> 'camperRoster') = 'object' THEN
        v_new := NEW.value -> 'camperRoster';
    END IF;

    v_ids := public._number_people(NEW.camp_id, 'camper', v_old, v_new, 'camperId', 'name', v_all);

    -- Every entry looked at now carries exactly the number it holds.
    IF v_ids <> '{}'::jsonb THEN
        FOR e IN SELECT key, value FROM jsonb_each(v_ids) LOOP
            IF (v_new #> ARRAY[e.key, 'camperId']) IS DISTINCT FROM e.value THEN
                v_new := jsonb_set(v_new, ARRAY[e.key, 'camperId'], e.value, true);
            END IF;
        END LOOP;
        NEW.value := jsonb_set(NEW.value, '{camperRoster}', v_new, true);
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.number_camp_campers() FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.number_camp_staff()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_old jsonb := '{}'::jsonb;
    v_new jsonb := '{}'::jsonb;
    v_all boolean := COALESCE(current_setting('campistry.renumber_all', true), '') = 'on';
    v_ids jsonb;
    e     record;
BEGIN
    IF TG_OP = 'UPDATE' AND NOT v_all AND jsonb_typeof(OLD.value -> 'staffApplications') = 'object' THEN
        v_old := OLD.value -> 'staffApplications';
    END IF;
    IF jsonb_typeof(NEW.value -> 'staffApplications') = 'object' THEN
        v_new := NEW.value -> 'staffApplications';
    END IF;

    v_ids := public._number_people(NEW.camp_id, 'staff', v_old, v_new, 'staffId', 'name', v_all);

    -- Only an applicant who SHOWS a staff number is corrected: the page gives
    -- one at hiring, and an applicant with none is left without one.
    IF v_ids <> '{}'::jsonb THEN
        FOR e IN SELECT key, value FROM jsonb_each(v_ids) LOOP
            IF public._stated_person_id(v_new #>> ARRAY[e.key, 'staffId']) IS NOT NULL
               AND (v_new #> ARRAY[e.key, 'staffId']) IS DISTINCT FROM e.value THEN
                v_new := jsonb_set(v_new, ARRAY[e.key, 'staffId'], e.value, true);
            END IF;
        END LOOP;
        NEW.value := jsonb_set(NEW.value, '{staffApplications}', v_new, true);
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.number_camp_staff() FROM public, anon, authenticated;

-- The old AFTER triggers could not change the document. Replaced.
-- Named to run AFTER every other BEFORE trigger, so they see the final value.
DROP TRIGGER IF EXISTS trg_project_camp_campers ON public.camp_state_kv;
DROP TRIGGER IF EXISTS trg_project_camp_staff   ON public.camp_state_kv;
DROP TRIGGER IF EXISTS trg_zz_number_camp_campers ON public.camp_state_kv;
DROP TRIGGER IF EXISTS trg_zz_number_camp_staff   ON public.camp_state_kv;
CREATE TRIGGER trg_zz_number_camp_campers
BEFORE INSERT OR UPDATE ON public.camp_state_kv
FOR EACH ROW WHEN (NEW.key = 'app1')
EXECUTE FUNCTION public.number_camp_campers();
CREATE TRIGGER trg_zz_number_camp_staff
BEFORE INSERT OR UPDATE ON public.camp_state_kv
FOR EACH ROW WHEN (NEW.key = 'campistryMe')
EXECUTE FUNCTION public.number_camp_staff();


-- ─── what the Me page asks ──────────────────────────────────────────────────
-- Each live camper's number by roster key, and the lowest number the page may
-- hand out next: above everything any person, live or departed, has ever held.
CREATE OR REPLACE FUNCTION public.get_camper_numbers(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    IF NOT public.camp_reader(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;
    RETURN jsonb_build_object(
        'success', true,
        'campers', COALESCE((SELECT jsonb_object_agg(source_key, person_id)
                               FROM camp_people
                              WHERE camp_id = p_camp_id AND kind = 'camper'
                                AND deleted_at IS NULL), '{}'::jsonb),
        'next', GREATEST(
                  COALESCE((SELECT max(person_id) + 1 FROM camp_people WHERE camp_id = p_camp_id), 1),
                  COALESCE((SELECT next_id FROM camp_person_seq WHERE camp_id = p_camp_id), 1)),
        -- Numbers still held by departed people (not erased): not free.
        'departed', COALESCE((SELECT jsonb_object_agg(person_id::text, source_key)
                                FROM camp_people
                               WHERE camp_id = p_camp_id AND deleted_at IS NOT NULL), '{}'::jsonb));
END;
$$;
REVOKE ALL ON FUNCTION public.get_camper_numbers(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_camper_numbers(uuid) TO authenticated, service_role;


-- ─── the invariant, as a question anyone can ask ────────────────────────────
-- Empty when every camp is right: no two roster entries showing one number, and
-- every entry showing exactly the number its person holds.
CREATE OR REPLACE FUNCTION public.camper_number_problems()
RETURNS TABLE (camp_id uuid, camper text, shows bigint, holds bigint, problem text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    WITH entries AS (
        SELECT k.camp_id, e.key AS camper,
               public._stated_person_id(e.value ->> 'camperId') AS shows
          FROM camp_state_kv k
          CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(k.value -> 'camperRoster') = 'object'
                                             THEN k.value -> 'camperRoster' ELSE '{}'::jsonb END) e
         WHERE k.key = 'app1' AND jsonb_typeof(e.value) = 'object')
    SELECT x.camp_id, x.camper, x.shows, p.person_id,
           CASE WHEN x.shows IS NULL THEN 'shows no number'
                WHEN p.person_id IS NULL THEN 'has no identity row'
                WHEN p.person_id <> x.shows THEN 'shows a number that is not theirs'
                ELSE 'shares a number with another camper' END
      FROM entries x
      LEFT JOIN camp_people p
        ON p.camp_id = x.camp_id AND p.kind = 'camper' AND p.source_key = x.camper
       AND p.deleted_at IS NULL
     WHERE x.shows IS NULL OR p.person_id IS NULL OR p.person_id <> x.shows
        OR EXISTS (SELECT 1 FROM entries y
                    WHERE y.camp_id = x.camp_id AND y.shows = x.shows AND y.camper <> x.camper)
$$;
REVOKE ALL ON FUNCTION public.camper_number_problems() FROM public, anon, authenticated;


-- ─── the repair ─────────────────────────────────────────────────────────────
-- Once, for every camp whose roster disagrees with the table: every entry is
-- numbered by the rules above and the document is corrected.
DO $$
DECLARE
    c   uuid;
    n   integer := 0;
BEGIN
    PERFORM set_config('campistry.renumber_all', 'on', true);
    FOR c IN SELECT DISTINCT camp_id FROM public.camper_number_problems() LOOP
        UPDATE camp_state_kv SET value = value WHERE camp_id = c AND key = 'app1';
        n := n + 1;
    END LOOP;
    PERFORM set_config('campistry.renumber_all', 'off', true);
    RAISE NOTICE '253: % camp(s) renumbered', n;
END $$;
