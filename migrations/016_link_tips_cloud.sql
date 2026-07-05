-- ============================================================================
-- Migration: link_tips — counselor tips recorded in the cloud
--
-- The parent portal's Tips feature previously wrote only to the parent's own
-- browser localStorage, so the camp never saw a tip. This migration gives it
-- a real backend:
--
--   link_tips table            — one row per tip (parent → staff member)
--   submit_link_tip()          — parent write path (invite-auth, like 013/015)
--   get_my_tips()              — parent's own tip history across devices
--   get_link_tips_config()     — tip amounts/categories configured by the
--                                camp (camp_state_kv key 'link_tips_config'),
--                                readable by parents — previously parents
--                                could never see the camp's config at all
--
-- Admins read/manage rows directly under camp-staff RLS and use the payout
-- report in the Link admin portal (totals per staff member, CSV/Excel).
-- ============================================================================

-- ─── 1. Table ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS link_tips (
    id             uuid        NOT NULL DEFAULT gen_random_uuid(),
    camp_id        uuid        NOT NULL,
    invite_id      uuid,
    user_id        uuid,
    camper_name    text,
    parent_name    text,
    parent_email   text,
    recipient_name text        NOT NULL,
    recipient_role text,
    amount         numeric(8,2) NOT NULL,
    status         text        NOT NULL DEFAULT 'recorded',  -- recorded | paid_out
    created_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_link_tips_camp
    ON link_tips (camp_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_link_tips_camp_recipient
    ON link_tips (camp_id, recipient_name);

CREATE INDEX IF NOT EXISTS idx_link_tips_user
    ON link_tips (user_id);

-- ─── 2. RLS — camp staff read/update/delete; parents write via RPC ───────────
ALTER TABLE link_tips ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS link_tips_select ON link_tips;
CREATE POLICY link_tips_select ON link_tips
    FOR SELECT
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'scheduler'::text])
    );

DROP POLICY IF EXISTS link_tips_update ON link_tips;
CREATE POLICY link_tips_update ON link_tips
    FOR UPDATE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text])
    );

DROP POLICY IF EXISTS link_tips_delete ON link_tips;
CREATE POLICY link_tips_delete ON link_tips
    FOR DELETE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text])
    );

-- ─── 3. RPC: submit_link_tip ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.submit_link_tip(
    p_recipient_name text,
    p_recipient_role text DEFAULT '',
    p_amount         numeric DEFAULT 0,
    p_camper_name    text DEFAULT NULL
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

    SELECT * INTO inv
    FROM link_parent_invites
    WHERE user_id = caller
      AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
    ORDER BY created_at DESC
    LIMIT 1;

    IF NOT FOUND THEN
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

    RETURN jsonb_build_object('success', true, 'id', new_id);
END;
$$;

REVOKE ALL ON FUNCTION public.submit_link_tip(text, text, numeric, text) FROM public;
GRANT EXECUTE ON FUNCTION public.submit_link_tip(text, text, numeric, text) TO authenticated;

-- ─── 4. RPC: get_my_tips ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_my_tips()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    result jsonb;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id',             t.id,
        'camper_name',    t.camper_name,
        'recipient_name', t.recipient_name,
        'recipient_role', t.recipient_role,
        'amount',         t.amount,
        'created_at',     t.created_at
    ) ORDER BY t.created_at DESC), '[]'::jsonb)
    INTO result
    FROM link_tips t
    WHERE t.user_id = caller;

    RETURN jsonb_build_object('success', true, 'tips', result);
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_tips() FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_tips() TO authenticated;

-- ─── 5. RPC: get_link_tips_config ─────────────────────────────────────────────
-- The Link admin portal already saves tip amounts/categories to camp_state_kv
-- under 'link_tips_config'; this lets parent devices read them.
CREATE OR REPLACE FUNCTION public.get_link_tips_config(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_value text;
BEGIN
    SELECT value INTO v_value
    FROM camp_state_kv
    WHERE camp_id = p_camp_id
      AND key     = 'link_tips_config'
    LIMIT 1;

    IF NOT FOUND OR v_value IS NULL THEN
        RETURN jsonb_build_object('success', true, 'config', NULL);
    END IF;

    RETURN jsonb_build_object('success', true, 'config', v_value::jsonb);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.get_link_tips_config(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_link_tips_config(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_link_tips_config(uuid) TO anon;

-- ─── 6. Sanity check ──────────────────────────────────────────────────────────
--   SELECT tablename, rowsecurity FROM pg_tables
--   WHERE tablename = 'link_tips' AND schemaname = 'public';
-- ============================================================================
