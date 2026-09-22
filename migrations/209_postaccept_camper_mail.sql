-- ============================================================================
-- Migration 209: hand the post-acceptance form the Camper Mail address + code
--
-- When a camp turns on the Camper Mail section of its post-acceptance form, the
-- parent-facing form shows the camp's letter address and (when the camper has a
-- number yet) that child's code. The form is anon-loaded through
-- get_postaccept_bootstrap (migration 084), so the address has to travel in that
-- same anon-safe slice. Nothing here is secret — the address and code are
-- meant to be shared with parents.
--
-- Idempotent — safe to re-run. Run AFTER 084 and 204.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_postaccept_bootstrap(
    p_camp_id   uuid,
    p_enroll_id text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    camp_row     record;
    kv_value     jsonb;
    enroll_row   jsonb;
    v_cm_token   text;
    v_cm_num     text;
    v_cm_on      boolean;
    v_camper_nm  text;
    v_cid        text;
    v_camper_mail jsonb;
BEGIN
    IF p_camp_id IS NULL OR p_enroll_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_payload');
    END IF;

    SELECT id, name INTO camp_row FROM camps WHERE id = p_camp_id;
    IF camp_row.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'camp_not_found');
    END IF;

    SELECT value INTO kv_value
    FROM camp_state_kv
    WHERE camp_id = p_camp_id AND key = 'campistryMe';

    enroll_row := kv_value -> 'enrollments' -> p_enroll_id;
    IF enroll_row IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'enrollment_not_found');
    END IF;
    IF (enroll_row ->> 'status') NOT IN ('accepted', 'enrolled') THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_accepted');
    END IF;

    -- ── Camper Mail address + this camper's code ────────────────────────────
    -- Reads the per-camp settings (RLS-protected, reachable here because this
    -- function is SECURITY DEFINER). The code's second half is the camper's own
    -- number from the roster; if the camper has no number yet, camperCode is
    -- null and the form falls back to "put your camper's name in the subject".
    v_camper_mail := jsonb_build_object('enabled', false);
    BEGIN
        SELECT inbound_token, camp_number, enabled
          INTO v_cm_token, v_cm_num, v_cm_on
          FROM camp_camper_mail_settings WHERE camp_id = p_camp_id;

        IF v_cm_on IS TRUE AND coalesce(v_cm_token, '') <> '' THEN
            v_camper_nm := coalesce(enroll_row ->> 'camperName', '');
            v_cid := coalesce(
                kv_value #>> ARRAY['roster', v_camper_nm, 'camperId'],
                enroll_row ->> 'camperId',
                ''
            );
            v_cid := regexp_replace(coalesce(v_cid, ''), '\D', '', 'g');
            v_camper_mail := jsonb_build_object(
                'enabled', true,
                'inboundToken', v_cm_token,
                'campNumber', coalesce(v_cm_num, ''),
                'camperCode', CASE
                    WHEN coalesce(v_cm_num, '') <> '' AND v_cid <> ''
                    THEN v_cm_num || '-' || v_cid
                    ELSE NULL END
            );
        END IF;
    EXCEPTION WHEN undefined_table OR undefined_column THEN
        v_camper_mail := jsonb_build_object('enabled', false);
    END;

    RETURN jsonb_build_object(
        'success', true,
        'campName', camp_row.name,
        'camperName', coalesce(enroll_row ->> 'camperName', ''),
        'alreadySubmitted', (enroll_row -> 'postAccept') IS NOT NULL,
        'submittedDate', enroll_row #>> '{postAccept,submittedDate}',
        'postAcceptFormConfig', coalesce(kv_value -> 'postAcceptFormConfig', '{}'::jsonb),
        'camperMail', v_camper_mail,
        'bunkGenConfig', jsonb_build_object(
            'requestsEnabled', coalesce(kv_value #> '{bunkGenConfig,requestsEnabled}', 'true'::jsonb),
            'maxRequests', coalesce(kv_value #> '{bunkGenConfig,maxRequests}', '2'::jsonb),
            'honoredRequests', coalesce(kv_value #> '{bunkGenConfig,honoredRequests}', '2'::jsonb),
            'doNotBunkEnabled', coalesce(kv_value #> '{bunkGenConfig,doNotBunkEnabled}', 'true'::jsonb),
            'maxDoNotBunk', coalesce(kv_value #> '{bunkGenConfig,maxDoNotBunk}', '2'::jsonb)
        )
    );
END;
$$;

NOTIFY pgrst, 'reload schema';
