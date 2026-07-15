-- ============================================================================
-- Migration 043: Camp-scope tips for multi-camp parents.
--
-- submit_link_tip (017) resolved the caller's invite as the single most-recent
-- one (ORDER BY created_at DESC LIMIT 1). For a parent with kids in DIFFERENT
-- camps that means a tip for the OTHER camp's child either credits the wrong
-- camp's staff account or is rejected (camper_not_on_invite), and there's no way
-- to tip a camp whose invite isn't the most recent. Add an optional trailing
-- p_camp_id: when present the invite (and therefore the credited staff account)
-- is resolved for THAT camp. The client passes the tipped child's own campId.
-- Trailing DEFAULT NULL keeps every existing 4-arg caller working.
-- ============================================================================

DROP FUNCTION IF EXISTS public.submit_link_tip(text, text, numeric, text);
CREATE OR REPLACE FUNCTION public.submit_link_tip(
    p_recipient_name text,
    p_recipient_role text DEFAULT '',
    p_amount         numeric DEFAULT 0,
    p_camper_name    text DEFAULT NULL,
    p_camp_id        text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    inv    link_parent_invites;
    new_id uuid;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF p_recipient_name IS NULL OR btrim(p_recipient_name) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_recipient');
    END IF;
    IF p_amount IS NULL OR p_amount < 1 OR p_amount > 500 THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_amount');
    END IF;

    -- Prefer the invite for the requested camp (multi-camp); else most-recent.
    IF p_camp_id IS NOT NULL AND btrim(p_camp_id) <> '' THEN
        SELECT * INTO inv FROM link_parent_invites
        WHERE user_id = caller AND status = 'active'
          AND (expires_at IS NULL OR expires_at > now())
          AND camp_id = p_camp_id::uuid
        ORDER BY created_at DESC LIMIT 1;
    END IF;
    IF inv.id IS NULL THEN
        SELECT * INTO inv FROM link_parent_invites
        WHERE user_id = caller AND status = 'active'
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY created_at DESC LIMIT 1;
    END IF;

    IF inv.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;

    IF p_camper_name IS NOT NULL AND inv.camper_names IS NOT NULL
       AND NOT (inv.camper_names ? p_camper_name) THEN
        RETURN jsonb_build_object('success', false, 'error', 'camper_not_on_invite');
    END IF;

    INSERT INTO link_tips (
        camp_id, invite_id, user_id, camper_name,
        parent_name, parent_email, recipient_name, recipient_role, amount
    ) VALUES (
        inv.camp_id, inv.id, caller, p_camper_name,
        inv.parent_name, inv.parent_email,
        btrim(p_recipient_name), coalesce(p_recipient_role, ''), round(p_amount, 2)
    )
    RETURNING id INTO new_id;

    -- Credit the recipient's account in the SAME camp as the resolved invite
    INSERT INTO link_staff_accounts (camp_id, staff_name, role, balance, total_earned)
    VALUES (inv.camp_id, btrim(p_recipient_name), coalesce(p_recipient_role, ''), round(p_amount, 2), round(p_amount, 2))
    ON CONFLICT (camp_id, lower(staff_name)) DO UPDATE
    SET balance      = link_staff_accounts.balance      + EXCLUDED.balance,
        total_earned = link_staff_accounts.total_earned + EXCLUDED.total_earned,
        role         = CASE WHEN link_staff_accounts.role = '' THEN EXCLUDED.role ELSE link_staff_accounts.role END,
        updated_at   = now();

    RETURN jsonb_build_object('success', true, 'id', new_id);
END;
$$;
REVOKE ALL ON FUNCTION public.submit_link_tip(text, text, numeric, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.submit_link_tip(text, text, numeric, text, text) TO authenticated;
