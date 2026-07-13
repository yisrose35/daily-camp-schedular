-- ============================================================================
-- Migration: parent_pickup_requests — cloud channel for parent late/pickup
-- requests so they reach Campistry Live across devices.
--
-- supabase_data_layer.js already references a `parent_pickup_requests` table
-- (getParentPickupRequests / submitParentPickupRequest / reviewParentPickupRequest)
-- but the table was never created, so every call silently fell back to
-- localStorage. Result: a parent's "running late" / early-pickup / dismissal-
-- change request written in Campistry Link only ever lived on the parent's own
-- device and NEVER reached Live (which also read the same localStorage key).
--
-- This creates the table + RLS, and a SECURITY DEFINER RPC the parent portal
-- calls (parents can't INSERT directly; the RPC validates the camper is on the
-- caller's invite, mirroring submit_canteen_deposit / submit_camper_mail). Live
-- (owner/admin) reads and reviews the rows directly under RLS.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.parent_pickup_requests (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    camp_id      uuid NOT NULL,
    request_date date NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
    type         text NOT NULL,                 -- early | change | friend | late
    label        text,
    camper_name  text NOT NULL,
    camper_bunk  text,
    parent_name  text,
    parent_email text,
    details      jsonb NOT NULL DEFAULT '{}'::jsonb,
    status       text NOT NULL DEFAULT 'Pending',
    reviewed_at  timestamptz,
    reviewed_by  uuid,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ppr_camp_date
    ON public.parent_pickup_requests (camp_id, request_date DESC);

ALTER TABLE public.parent_pickup_requests ENABLE ROW LEVEL SECURITY;

-- Owner/admin/scheduler of the camp can read + review (update) their camp's rows.
-- Reuses the same membership check the rest of the app uses (camps.owner or a
-- camp_users row). Kept permissive-read for any camp the caller belongs to.
DROP POLICY IF EXISTS ppr_admin_read  ON public.parent_pickup_requests;
DROP POLICY IF EXISTS ppr_admin_write ON public.parent_pickup_requests;
CREATE POLICY ppr_admin_read ON public.parent_pickup_requests
    FOR SELECT USING (
        camp_id = auth.uid()
        OR EXISTS (SELECT 1 FROM camps c WHERE c.id = parent_pickup_requests.camp_id AND c.owner = auth.uid())
        OR EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = parent_pickup_requests.camp_id AND u.user_id = auth.uid())
    );
CREATE POLICY ppr_admin_write ON public.parent_pickup_requests
    FOR UPDATE USING (
        camp_id = auth.uid()
        OR EXISTS (SELECT 1 FROM camps c WHERE c.id = parent_pickup_requests.camp_id AND c.owner = auth.uid())
        OR EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = parent_pickup_requests.camp_id AND u.user_id = auth.uid())
    );

-- A parent may SELECT their own submitted rows (so the portal can show status).
DROP POLICY IF EXISTS ppr_parent_read ON public.parent_pickup_requests;
CREATE POLICY ppr_parent_read ON public.parent_pickup_requests
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM link_parent_invites i
            WHERE i.user_id = auth.uid()
              AND i.camp_id = parent_pickup_requests.camp_id
              AND i.parent_email = parent_pickup_requests.parent_email
        )
    );

-- ─── RPC: submit_pickup_request — the parent portal writes through this ────────
CREATE OR REPLACE FUNCTION public.submit_pickup_request(
    p_type        text,
    p_camper_name text,
    p_details     jsonb DEFAULT '{}'::jsonb,
    p_label       text  DEFAULT NULL,
    p_camp_id     uuid  DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    inv    link_parent_invites;
    new_id uuid := gen_random_uuid();
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF p_type IS NULL OR btrim(p_type) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_type');
    END IF;

    SELECT * INTO inv
    FROM link_parent_invites
    WHERE user_id = caller
      AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
      AND (p_camp_id IS NULL OR camp_id = p_camp_id)
    ORDER BY created_at DESC
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;

    IF p_camper_name IS NOT NULL AND inv.camper_names IS NOT NULL
       AND NOT (inv.camper_names ? p_camper_name) THEN
        RETURN jsonb_build_object('success', false, 'error', 'camper_not_on_invite');
    END IF;

    INSERT INTO parent_pickup_requests (
        id, camp_id, request_date, type, label, camper_name, camper_bunk,
        parent_name, parent_email, details, status
    ) VALUES (
        new_id, inv.camp_id, (now() AT TIME ZONE 'utc')::date, p_type,
        coalesce(p_label, p_type), p_camper_name, coalesce(p_details->>'childBunk',''),
        inv.parent_name, inv.parent_email, coalesce(p_details, '{}'::jsonb), 'Pending'
    );

    RETURN jsonb_build_object('success', true, 'id', new_id);
END;
$$;

REVOKE ALL ON FUNCTION public.submit_pickup_request(text, text, jsonb, text, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.submit_pickup_request(text, text, jsonb, text, uuid) TO authenticated;

-- Realtime so Live updates instantly (optional; poll is the fallback).
ALTER TABLE public.parent_pickup_requests REPLICA IDENTITY FULL;
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND tablename = 'parent_pickup_requests'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.parent_pickup_requests;
    END IF;
END $$;
