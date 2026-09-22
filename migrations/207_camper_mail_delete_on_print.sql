-- ============================================================================
-- Migration 207: Camper Mail — "delete once printed" option
--
-- By default a printed letter moves to the "Printed" tab and STAYS there until
-- someone deletes it, so nothing is ever lost. A camp that would rather have
-- letters clear themselves the moment they print can switch this on.
--
-- Idempotent — safe to re-run. Run AFTER 204.
-- ============================================================================

ALTER TABLE camp_camper_mail_settings
    ADD COLUMN IF NOT EXISTS delete_on_print boolean NOT NULL DEFAULT false;

-- ─── get settings — now also returns deleteOnPrint ──────────────────────────
CREATE OR REPLACE FUNCTION public.get_camper_mail_inbox_settings(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_row camp_camper_mail_settings;
BEGIN
    IF NOT _camper_mail_can_admin(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    INSERT INTO camp_camper_mail_settings (camp_id, inbound_token)
    VALUES (p_camp_id, replace(gen_random_uuid()::text, '-', ''))
    ON CONFLICT (camp_id) DO NOTHING;

    PERFORM _camper_mail_assign_camp_number(p_camp_id);
    SELECT * INTO v_row FROM camp_camper_mail_settings WHERE camp_id = p_camp_id;

    RETURN jsonb_build_object(
        'success', true,
        'enabled', v_row.enabled,
        'inboundToken', v_row.inbound_token,
        'campNumber', v_row.camp_number,
        'knownParentsOnly', v_row.known_parents_only,
        'deleteOnPrint', v_row.delete_on_print
    );
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_camper_mail_inbox_settings(uuid) TO authenticated;

-- ─── set settings — the 4-arg form is replaced by a 5-arg form ──────────────
-- Adding a parameter makes a new signature (a CREATE OR REPLACE can't change an
-- argument list), so drop the old one first to avoid two overloads PostgREST
-- could pick between.
DROP FUNCTION IF EXISTS public.set_camper_mail_inbox_settings(uuid, boolean, boolean, boolean);

CREATE OR REPLACE FUNCTION public.set_camper_mail_inbox_settings(
    p_camp_id            uuid,
    p_enabled            boolean DEFAULT NULL,
    p_known_parents_only boolean DEFAULT NULL,
    p_delete_on_print    boolean DEFAULT NULL,
    p_rotate_token       boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    IF NOT _camper_mail_can_admin(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    INSERT INTO camp_camper_mail_settings (camp_id, inbound_token)
    VALUES (p_camp_id, replace(gen_random_uuid()::text, '-', ''))
    ON CONFLICT (camp_id) DO NOTHING;

    UPDATE camp_camper_mail_settings SET
        enabled            = COALESCE(p_enabled, enabled),
        known_parents_only = COALESCE(p_known_parents_only, known_parents_only),
        delete_on_print    = COALESCE(p_delete_on_print, delete_on_print),
        inbound_token      = CASE WHEN p_rotate_token
                                  THEN replace(gen_random_uuid()::text, '-', '')
                                  ELSE inbound_token END,
        updated_at         = now()
     WHERE camp_id = p_camp_id;

    RETURN get_camper_mail_inbox_settings(p_camp_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.set_camper_mail_inbox_settings(uuid, boolean, boolean, boolean, boolean) TO authenticated;

NOTIFY pgrst, 'reload schema';
