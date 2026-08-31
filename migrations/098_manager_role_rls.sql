-- ============================================================================
-- Migration 098: the 'manager' role — RLS grants (companion to 097)
--
-- Migration 097 added the 'manager' role's meaning (product_access +
-- section_access resolution via camp_access_groups). This migration gives it
-- the actual database-level write/read access it needs to be a real role,
-- not a UI illusion — the same baseline grant 'scheduler' already has on
-- every NON-Flow-specific table. Deliberately does NOT touch
-- daily_schedules / schedule_proposals / rotation_counts or any Flow-RBAC
-- logic in access_control.js — a manager with no 'flow' in their
-- product_access never reaches those code paths at all (product_access_guard.js
-- only special-cases 'admin'; everyone else, including this new role, goes
-- through the normal product_access array check with zero changes needed
-- there). Flow-app parity for a manager who IS given flow access is a
-- separate, explicit fast-follow, not silently included here.
--
-- Every policy below is a straight copy of the current 'scheduler' grant on
-- that table (verified against the latest migration that defines each one)
-- with 'manager' added to the same role array — same DROP POLICY IF EXISTS /
-- CREATE POLICY idempotent pattern already used throughout this codebase.
-- ============================================================================

-- ─── 1. camp_users.role — allow 'manager' ──────────────────────────────────
ALTER TABLE camp_users DROP CONSTRAINT IF EXISTS camp_users_role_check;
ALTER TABLE camp_users ADD CONSTRAINT camp_users_role_check
    CHECK (role = ANY (ARRAY[
        'admin'::text,
        'manager'::text,
        'scheduler'::text,
        'viewer'::text,
        'counselor'::text
    ]));

-- ─── 2. camp_state_kv — Me/Snacks/Health/Go/Notes/Guard app data ───────────
-- INSERT/UPDATE: migration 009's grant, + manager.
DROP POLICY IF EXISTS camp_state_kv_insert ON camp_state_kv;
CREATE POLICY camp_state_kv_insert ON camp_state_kv
    FOR INSERT
    WITH CHECK (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'manager'::text, 'scheduler'::text])
    );

DROP POLICY IF EXISTS camp_state_kv_update ON camp_state_kv;
CREATE POLICY camp_state_kv_update ON camp_state_kv
    FOR UPDATE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'manager'::text, 'scheduler'::text])
    );

-- SELECT: migration 050's grant (the latest — includes the counselor
-- carve-out for campistryHealth/app1/campistryMe), + manager.
DROP POLICY IF EXISTS camp_state_kv_select ON camp_state_kv;
CREATE POLICY camp_state_kv_select ON camp_state_kv
    FOR SELECT
    USING (
        camp_id = get_user_camp_id()
        AND (
            get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'manager'::text, 'scheduler'::text])
            OR (
                get_user_role() = 'counselor'::text
                AND key <> ALL (ARRAY['app1'::text, 'campistryMe'::text, 'campistryHealth'::text])
            )
        )
    );

-- DELETE intentionally UNCHANGED (owner-only, from migration 001).

-- ─── 3. Link app tables ─────────────────────────────────────────────────────

DROP POLICY IF EXISTS link_outbox_select ON link_outbox;
CREATE POLICY link_outbox_select ON link_outbox
    FOR SELECT
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'manager'::text, 'scheduler'::text])
    );

DROP POLICY IF EXISTS link_broadcasts_select ON link_broadcasts;
CREATE POLICY link_broadcasts_select ON link_broadcasts
    FOR SELECT
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'manager'::text, 'scheduler'::text])
    );

DROP POLICY IF EXISTS link_parent_invites_select ON link_parent_invites;
CREATE POLICY link_parent_invites_select ON link_parent_invites
    FOR SELECT
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'manager'::text, 'scheduler'::text])
    );

DROP POLICY IF EXISTS link_form_responses_select ON link_form_responses;
CREATE POLICY link_form_responses_select ON link_form_responses
    FOR SELECT
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'manager'::text, 'scheduler'::text])
    );

DROP POLICY IF EXISTS link_camper_mail_select ON link_camper_mail;
CREATE POLICY link_camper_mail_select ON link_camper_mail
    FOR SELECT
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'manager'::text, 'scheduler'::text])
    );

DROP POLICY IF EXISTS link_tips_select ON link_tips;
CREATE POLICY link_tips_select ON link_tips
    FOR SELECT
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'manager'::text, 'scheduler'::text])
    );

DROP POLICY IF EXISTS link_staff_accounts_select ON link_staff_accounts;
CREATE POLICY link_staff_accounts_select ON link_staff_accounts
    FOR SELECT
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'manager'::text, 'scheduler'::text])
    );

DROP POLICY IF EXISTS link_messages_select ON link_messages;
CREATE POLICY link_messages_select ON link_messages
    FOR SELECT
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'manager'::text, 'scheduler'::text])
    );

DROP POLICY IF EXISTS link_messages_insert ON link_messages;
CREATE POLICY link_messages_insert ON link_messages
    FOR INSERT
    WITH CHECK (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'manager'::text, 'scheduler'::text])
    );

DROP POLICY IF EXISTS link_messages_update ON link_messages;
CREATE POLICY link_messages_update ON link_messages
    FOR UPDATE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'manager'::text, 'scheduler'::text])
    );

-- ─── 4. Notifications ───────────────────────────────────────────────────────

DROP POLICY IF EXISTS notifications_select ON notifications;
CREATE POLICY notifications_select ON notifications
    FOR SELECT
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'manager'::text, 'scheduler'::text])
    );

DROP POLICY IF EXISTS notifications_insert ON notifications;
CREATE POLICY notifications_insert ON notifications
    FOR INSERT
    WITH CHECK (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'manager'::text, 'scheduler'::text])
    );

-- ─── 5. Pickup alerts (Live app) ────────────────────────────────────────────

DROP POLICY IF EXISTS pa_office_select ON public.pickup_alerts;
CREATE POLICY pa_office_select ON public.pickup_alerts FOR SELECT USING (
    camp_id = get_user_camp_id() AND get_user_role() = ANY (ARRAY['owner','admin','manager','scheduler'])
);

DROP POLICY IF EXISTS par_office_select ON public.pickup_alert_recipients;
CREATE POLICY par_office_select ON public.pickup_alert_recipients FOR SELECT USING (
    camp_id = get_user_camp_id() AND get_user_role() = ANY (ARRAY['owner','admin','manager','scheduler'])
);

CREATE OR REPLACE FUNCTION public.add_pickup_alert_league_recipients(
    p_camp_id     uuid,
    p_camper_name text,
    p_captain_ids text[],
    p_league_name text,
    p_team        text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_role     text := get_user_role();
    v_alert_id uuid;
    v_id       text;
    v_email    text;
    v_name     text;
BEGIN
    IF get_user_camp_id() IS DISTINCT FROM p_camp_id OR v_role NOT IN ('owner','admin','manager','scheduler') THEN
        RETURN jsonb_build_object('success', false, 'error', 'forbidden');
    END IF;

    SELECT id INTO v_alert_id FROM pickup_alerts
     WHERE camp_id = p_camp_id AND camper_name = p_camper_name
     ORDER BY created_at DESC LIMIT 1;
    IF v_alert_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_matching_alert');
    END IF;

    FOREACH v_id IN ARRAY coalesce(p_captain_ids, ARRAY[]::text[]) LOOP
        IF v_id LIKE '%@%' THEN
            v_email := lower(v_id);
            v_name  := NULL;
        ELSE
            v_email := '';
            v_name  := split_part(v_id, '|', 1);
        END IF;
        IF v_email <> '' THEN
            INSERT INTO pickup_alert_recipients (alert_id, camp_id, recipient_role, recipient_name, recipient_email)
            VALUES (v_alert_id, p_camp_id, 'league_captain', v_name, v_email)
            ON CONFLICT (alert_id, recipient_email) DO NOTHING;
        END IF;
    END LOOP;

    UPDATE pickup_alerts SET league_check_state = 'checked_match' WHERE id = v_alert_id;
    RETURN jsonb_build_object('success', true, 'alertId', v_alert_id);
END;
$$;

REVOKE ALL ON FUNCTION public.add_pickup_alert_league_recipients(uuid, text, text[], text, text) FROM public;
REVOKE ALL ON FUNCTION public.add_pickup_alert_league_recipients(uuid, text, text[], text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.add_pickup_alert_league_recipients(uuid, text, text[], text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.mark_pickup_alert_league_checked(
    p_camp_id     uuid,
    p_camper_name text,
    p_state       text DEFAULT 'checked_no_match'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    IF get_user_camp_id() IS DISTINCT FROM p_camp_id OR get_user_role() NOT IN ('owner','admin','manager','scheduler') THEN
        RETURN jsonb_build_object('success', false, 'error', 'forbidden');
    END IF;
    UPDATE pickup_alerts SET league_check_state = coalesce(p_state, 'checked_no_match')
     WHERE camp_id = p_camp_id AND camper_name = p_camper_name
       AND id = (SELECT id FROM pickup_alerts WHERE camp_id = p_camp_id AND camper_name = p_camper_name
                 ORDER BY created_at DESC LIMIT 1);
    RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.mark_pickup_alert_league_checked(uuid, text, text) FROM public;
REVOKE ALL ON FUNCTION public.mark_pickup_alert_league_checked(uuid, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.mark_pickup_alert_league_checked(uuid, text, text) TO authenticated;

-- ─── Sanity checks ──────────────────────────────────────────────────────────
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid = 'camp_users'::regclass AND conname = 'camp_users_role_check';
--   -- expect 'manager' in the list
--
--   SELECT policyname, roles, qual, with_check FROM pg_policies
--   WHERE tablename = 'camp_state_kv' ORDER BY policyname;
--   -- expect 'manager' present in every USING/WITH CHECK clause above
-- ============================================================================
