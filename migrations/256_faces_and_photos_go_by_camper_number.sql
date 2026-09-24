-- ============================================================================
-- Migration 256: faces, photo tags and form responses go by camper NUMBER.
--
-- WHAT WAS LEFT. Seven functions pick rows "by name OR by number":
--
--     (camper_name = v_name OR person_id = v_id)
--
-- The OR means a row that already belongs to ANOTHER child — it carries that
-- child's number — is still picked because the names agree. Two children with
-- one name in a camp, and:
--   * withdrawing one child's facial-recognition consent deleted the other
--     child's face data and photo tags (_purge_camper_face_data);
--   * one child's consent was read from the other's face row
--     (camper_face_consent);
--   * a parent's re-uploaded headshot replaced the other child's
--     (submit_camper_headshot), confirmed faces were capped across both
--     (promote_confirmed_face), a photo tag approved or rejected for one
--     reached the other (resolve_photo_tag);
--   * re-submitting a form for one child deleted the other's response
--     (submit_link_form_response).
--
-- THE RULE, as everywhere now: a row with a number is matched by its number
-- alone. The name is used only for a row that has no number.
--
--     (person_id = v_id  OR  (person_id IS NULL AND camper_name = v_name))
--
-- And where the camper cannot be resolved to a number at all, only rows that
-- have none are touched by name.
--
-- HOW. Each function's deployed text is rewritten in place; only those
-- comparisons change.
--
-- HOW TO APPLY. Paste into the SQL Editor after 255. Changes no data.
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

SET LOCAL lock_timeout = '15s';

CREATE OR REPLACE FUNCTION pg_temp.by_number(p_name text, p_pairs text[][])
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
    f      oid;
    v_def  text;
    v_new  text;
    v_out  text := '';
    v_seen boolean;
    i      int;
BEGIN
    FOR f IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = p_name LOOP
        v_def := replace(pg_get_functiondef(f), chr(13), '');
        v_new := v_def;
        v_seen := false;
        FOR i IN 1 .. array_length(p_pairs, 1) LOOP
            IF v_new ~ p_pairs[i][1] THEN
                v_new := regexp_replace(v_new, p_pairs[i][1], p_pairs[i][2], 'g');
                v_seen := true;
            ELSIF position(p_pairs[i][3] IN v_new) > 0 THEN
                v_seen := true;                 -- already applied
            END IF;
        END LOOP;
        IF NOT v_seen THEN
            RAISE EXCEPTION '256: % — none of its name comparisons were found; nothing was changed', p_name;
        END IF;
        IF v_new <> v_def THEN
            EXECUTE v_new;
            v_out := v_out || 'rewritten ';
        ELSE
            v_out := v_out || 'already applied ';
        END IF;
    END LOOP;
    RETURN p_name || ': ' || COALESCE(NULLIF(v_out, ''), 'not on this database');
END;
$$;

SELECT pg_temp.by_number(fn, ARRAY[
    -- name OR number  →  number; name only for a row without one
    ARRAY[$p$\(camper_name = v_name\s+OR \(v_id IS NOT NULL AND person_id = v_id\)\)$p$,
          $r$((v_id IS NOT NULL AND person_id = v_id) OR (person_id IS NULL AND camper_name = v_name))$r$,
          '(person_id IS NULL AND camper_name = v_name)'],
    ARRAY[$p$\(person_id = p_person_id OR camper_name = ANY \(v_names\)\)$p$,
          $r$(person_id = p_person_id OR (person_id IS NULL AND camper_name = ANY (v_names)))$r$,
          '(person_id IS NULL AND camper_name = ANY (v_names))'],
    ARRAY[$p$f\.camper_name IN \(SELECT camper_name FROM public\._camper_face_names\(p_camp_id, p_person_id\)\)$p$,
          $r$(f.person_id = p_person_id OR (f.person_id IS NULL AND f.camper_name IN (SELECT camper_name FROM public._camper_face_names(p_camp_id, p_person_id))))$r$,
          '(f.person_id = p_person_id OR (f.person_id IS NULL'],
    -- the unresolvable-camper branches: rows with no number only
    ARRAY[$p$WHERE camp_id = p_camp_id AND camper_name = v_name;$p$,
          $r$WHERE camp_id = p_camp_id AND camper_name = v_name AND person_id IS NULL;$r$,
          'camper_name = v_name AND person_id IS NULL;'],
    ARRAY[$p$WHERE f\.camp_id = p_camp_id AND f\.camper_name = v_name;$p$,
          $r$WHERE f.camp_id = p_camp_id AND f.camper_name = v_name AND f.person_id IS NULL;$r$,
          'f.camper_name = v_name AND f.person_id IS NULL;']
]) AS "256"
  FROM unnest(ARRAY['_purge_camper_face_data', 'camper_face_consent', 'set_camper_face_consent',
                    'submit_camper_headshot', 'promote_confirmed_face', 'resolve_photo_tag',
                    'submit_link_form_response']) fn;


-- ─── the check ──────────────────────────────────────────────────────────────
-- Any function that still picks rows by "name OR number". Empty when done.
CREATE OR REPLACE FUNCTION public.verify_rows_matched_by_number()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT jsonb_build_object('still_matching_rows_by_name_or_number', COALESCE((
        SELECT jsonb_agg(DISTINCT p.proname ORDER BY p.proname)
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname NOT LIKE 'verify\_%'
           AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g')
               ~ '(\(camper_name = v_name\s+OR \(v_id IS NOT NULL|person_id = p_person_id OR camper_name = ANY|p_camp_id\s+AND f\.camper_name IN \(SELECT camper_name FROM public\._camper_face_names)'
    ), '[]'::jsonb))
$$;
REVOKE ALL ON FUNCTION public.verify_rows_matched_by_number() FROM public, anon, authenticated;
