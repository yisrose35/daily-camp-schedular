-- =============================================================================
-- 164 — tell the registration form what deposit the camp requires
--
-- A camp can now require money to hold a place: a flat amount, a share of
-- tuition, or whatever the session carries; once per camper or once per
-- household; payable before the form will submit or inside a set number of
-- days. The rule lives in enrollSettings.depositPolicy.
--
-- The public registration form is anonymous, so everything it knows comes
-- through get_public_form_config. Without the policy here the form cannot say
-- what is owed and cannot hold an application that has not paid -- the setting
-- would appear to save and then do nothing at all.
--
-- Only the RULE crosses this line, never a family's standing against it. It is
-- a price, the same one a camp would print on a brochure.
--
-- Idempotent -- safe to re-run. Replaces the function as defined in 115.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_public_form_config(
    p_camp_id uuid,
    p_kind    text   -- 'registration' | 'staff'
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    camp_row  record;
    kv_value  jsonb;
BEGIN
    IF p_kind NOT IN ('registration', 'staff') THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_kind');
    END IF;
    IF p_camp_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_payload');
    END IF;

    SELECT id, name INTO camp_row FROM camps WHERE id = p_camp_id;
    IF camp_row.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'camp_not_found');
    END IF;

    SELECT value INTO kv_value
    FROM camp_state_kv
    WHERE camp_id = p_camp_id AND key = 'campistryMe';

    IF p_kind = 'registration' THEN
        RETURN jsonb_build_object(
            'success', true,
            'campName', camp_row.name,
            'formConfig', coalesce(kv_value -> 'formConfig', '{}'::jsonb),
            'sessions', coalesce(kv_value -> 'sessions', '[]'::jsonb),
            'sessionBundles', coalesce(kv_value -> 'sessionBundles', '[]'::jsonb),
            'promoCodes', coalesce(kv_value -> 'promoCodes', '{}'::jsonb),
            'schoolGrades', coalesce(kv_value #> '{bunkGenConfig,schoolGrades}', '[]'::jsonb),
            'allowParentPaymentPlans', coalesce(kv_value #> '{enrollSettings,allowParentPaymentPlans}', 'false'::jsonb),
            -- The deposit a family must put down to hold a place. The public
            -- form has to know the rule to state the amount and, where the
            -- camp requires it up front, to hold the application until it is
            -- paid. Safe to expose: it is a price, the same one the form would
            -- print on a brochure, and it carries nothing about any family.
            'depositPolicy', coalesce(kv_value #> '{enrollSettings,depositPolicy}', '{}'::jsonb)
        );
    ELSE
        RETURN jsonb_build_object(
            'success', true,
            'campName', camp_row.name,
            'staffFormConfig', coalesce(kv_value -> 'staffFormConfig', '{}'::jsonb),
            'sessions', coalesce(kv_value -> 'sessions', '[]'::jsonb)
        );
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.get_public_form_config(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.get_public_form_config(uuid, text) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
