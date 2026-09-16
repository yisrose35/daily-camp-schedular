-- =============================================================================
-- 166 — let a parent save the card they paid the deposit with
--
-- A family paying a deposit has already typed their card into the camp's
-- processor. Asking them to type it again in July, to set up a plan or pay an
-- instalment, is work nobody needs to do twice -- so if they say yes, the
-- processor keeps it and the token is recorded against the application.
--
-- ON THE APPLICATION, NOT A FAMILY. There is no family record until the office
-- accepts. The vault reference waits on the application and is carried onto
-- the family by enrollCamper, at the moment the family first exists.
--
-- NEVER A CARD NUMBER. The only things stored are the processor's own
-- references and the last four digits, which is what every existing card-on-
-- file path here already holds. The number never reaches Campistry at all --
-- the parent types it on the processor's page.
--
-- Idempotent -- safe to re-run. Requires 165.
-- =============================================================================

CREATE OR REPLACE FUNCTION public._record_registration_card(
    p_camp_id    uuid,
    p_enroll_id  text,
    p_processor  text,
    p_customer   text,
    p_method     text,
    p_last4      text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_enr jsonb;
BEGIN
    SELECT value #> ARRAY['enrollments', p_enroll_id]
      INTO v_enr
      FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe';

    IF v_enr IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'application_not_found');
    END IF;

    -- One path at a time, set in place. A read-modify-write of the whole
    -- document here would lose whatever the office saved while the parent was
    -- on the processor's page -- the defect that erased autopay charges.
    UPDATE camp_state_kv
       SET value = jsonb_set(
               jsonb_set(
                   jsonb_set(
                       jsonb_set(value,
                           ARRAY['enrollments', p_enroll_id, 'savedCardProcessor'],
                           to_jsonb(COALESCE(p_processor, '')), true),
                       ARRAY['enrollments', p_enroll_id, 'savedCardCustomer'],
                       to_jsonb(COALESCE(p_customer, '')), true),
                   ARRAY['enrollments', p_enroll_id, 'savedCardMethod'],
                   to_jsonb(COALESCE(p_method, '')), true),
               ARRAY['enrollments', p_enroll_id, 'savedCardLast4'],
               to_jsonb(COALESCE(p_last4, '')), true),
           updated_at = now()
     WHERE camp_id = p_camp_id AND key = 'campistryMe';

    RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public._record_registration_card(uuid, text, text, text, text, text)
    FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._record_registration_card(uuid, text, text, text, text, text)
    TO service_role;

NOTIFY pgrst, 'reload schema';
