-- ============================================================================
-- Migration 251: camper mail finds the camper by ID.
--
-- THE DEFECT. camper-mail-inbox pins a parent's letter to a child two ways:
--   * by the <camp number>-<camper id> code in the subject — through
--     _camper_mail_by_camper_number, which read campistryMe.roster. There is no
--     such roster: the camper roster is app1.camperRoster, and the ids live in
--     camp_people (216). So a correct code never matched, and every coded
--     letter fell through to the email guess or the unassigned pile.
--   * by the sender's email — through _camper_mail_candidates, which answered
--     with the invite's camper NAMES only, though 223 stamps the matching ids
--     beside them (link_parent_invites.person_ids, same order).
-- Either way the letter was stored by spelling.
--
-- THE FIX. Both lookups answer with camperId, and the edge function passes it to
-- _camper_mail_record (p_camper_id, 248), which files the letter on that camper.
--   * by code: camp_people, the one place a camper's number is kept — a live
--     camper row with that person_id. Placement (division/grade/bunk) comes from
--     that camper's roster entry, found by its source_key, not by name.
--   * by email: the id stamped at the name's position on the invite; null where
--     the invite has no stamp (the letter then goes by name, as before).
--
-- HOW TO APPLY. Paste into the SQL Editor after 248, then redeploy
-- camper-mail-inbox. Touches no data.
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._camper_mail_by_camper_number(
    p_camp_id        uuid,
    p_camper_number  text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    -- Leading zeros are ignored, so "0057" and "57" are the same camper.
    v_want text := ltrim(regexp_replace(coalesce(p_camper_number, ''), '\D', '', 'g'), '0');
    v_p    camp_people%ROWTYPE;
    v_c    jsonb;
BEGIN
    IF v_want = '' OR length(v_want) > 18 THEN
        RETURN jsonb_build_object('success', true, 'found', false);
    END IF;

    SELECT * INTO v_p FROM camp_people
     WHERE camp_id = p_camp_id AND kind = 'camper'
       AND person_id = v_want::bigint AND deleted_at IS NULL;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', true, 'found', false);
    END IF;

    SELECT value -> 'camperRoster' -> v_p.source_key INTO v_c
      FROM camp_state_kv WHERE camp_id = p_camp_id AND key = 'app1';
    v_c := COALESCE(v_c, '{}'::jsonb);

    RETURN jsonb_build_object('success', true, 'found', true,
        'camperId', v_p.person_id,
        'name',     COALESCE(NULLIF(btrim(v_c ->> 'displayName'), ''),
                             NULLIF(btrim(v_p.name), ''),
                             regexp_replace(v_p.source_key, '\s#\d+$', '')),
        'division', COALESCE(v_c ->> 'division', ''),
        'grade',    COALESCE(v_c ->> 'grade', ''),
        'bunk',     COALESCE(v_c ->> 'bunk', ''));
END;
$$;
REVOKE ALL ON FUNCTION public._camper_mail_by_camper_number(uuid, text) FROM public, anon, authenticated;


CREATE OR REPLACE FUNCTION public._camper_mail_candidates(
    p_camp_id      uuid,
    p_sender_email text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_email text := lower(btrim(coalesce(p_sender_email, '')));
    v_cands jsonb := '[]'::jsonb;
    v_seen  jsonb := '{}'::jsonb;
    r       RECORD;
    v_key   text;
BEGIN
    IF v_email = '' THEN
        RETURN jsonb_build_object('success', true, 'candidates', v_cands);
    END IF;

    FOR r IN
        SELECT e.value #>> '{}' AS nm,
               COALESCE(i.camper_data -> (e.value #>> '{}'), '{}'::jsonb) AS cd,
               CASE WHEN jsonb_typeof(i.person_ids -> (e.ord - 1)::int) = 'number'
                    THEN (i.person_ids ->> (e.ord - 1)::int)::bigint END AS pid
          FROM link_parent_invites i
          CROSS JOIN LATERAL jsonb_array_elements(
                  CASE WHEN jsonb_typeof(i.camper_names) = 'array'
                       THEN i.camper_names ELSE '[]'::jsonb END) WITH ORDINALITY AS e(value, ord)
         WHERE i.camp_id = p_camp_id
           AND lower(btrim(i.parent_email)) = v_email
           AND i.status = 'active'
           AND (i.expires_at IS NULL OR i.expires_at > now())
         ORDER BY i.created_at NULLS LAST, e.ord
    LOOP
        -- One candidate per child: by id where the invite has one, else by name.
        v_key := COALESCE(r.pid::text, 'n:' || r.nm);
        IF v_seen ? v_key THEN CONTINUE; END IF;
        v_seen := v_seen || jsonb_build_object(v_key, true);
        v_cands := v_cands || jsonb_build_array(jsonb_build_object(
            'name',     r.nm,
            'camperId', r.pid,
            'division', COALESCE(r.cd ->> 'division', ''),
            'grade',    COALESCE(r.cd ->> 'grade', ''),
            'bunk',     COALESCE(r.cd ->> 'bunk', '')));
    END LOOP;

    RETURN jsonb_build_object('success', true, 'candidates', v_cands);
END;
$$;
REVOKE ALL ON FUNCTION public._camper_mail_candidates(uuid, text) FROM public, anon, authenticated;
