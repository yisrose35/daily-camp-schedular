-- ============================================================================
-- Migration 093: ETA follow-up + future-dated requests for parent_pickup_requests
--
-- Two additions, both to the parent-request flow in Campistry Link/Live:
--
-- 1. Late Arrival gains a real "estimated time of arrival" (details.estArrival)
--    distinct from "I just dropped them off" (details.arrivedAt, unchanged).
--    A parent who submitted an ETA gets a follow-up "Dropped Off" action once
--    they've actually arrived, so the office knows the real arrival time
--    rather than just the promise. That follow-up needs a write path a parent
--    is allowed to use on their OWN row without the full office UPDATE grant
--    (ppr_admin_write, migration 025, is staff-only) — hence report_dropped_off
--    below, scoped to exactly one jsonb key on rows the caller's own invite
--    covers.
--
-- 2. submit_pickup_request already writes into a `request_date` column
--    (migration 025) — it just never let the CALLER set it, always defaulting
--    to today. Adding an optional p_request_date parameter (appended at the
--    end, existing callers unaffected) lets a parent submit an early pickup /
--    bus change / late arrival for a future date, so a family can tell camp
--    "picking up early on Thursday" ahead of time instead of only same-day.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

-- ─── 1. submit_pickup_request — accept an optional future request date ─────
CREATE OR REPLACE FUNCTION public.submit_pickup_request(
    p_type          text,
    p_camper_name   text,
    p_details       jsonb DEFAULT '{}'::jsonb,
    p_label         text  DEFAULT NULL,
    p_camp_id       uuid  DEFAULT NULL,
    p_request_date  date  DEFAULT NULL
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
    -- A request more than a year out is almost certainly a bad client-side
    -- date computation, not a real ask — reject rather than silently file it.
    IF p_request_date IS NOT NULL AND
       (p_request_date < (now() AT TIME ZONE 'utc')::date
        OR p_request_date > (now() AT TIME ZONE 'utc')::date + interval '1 year') THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_request_date');
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
        new_id, inv.camp_id,
        coalesce(p_request_date, (now() AT TIME ZONE 'utc')::date),
        p_type, coalesce(p_label, p_type), p_camper_name, coalesce(p_details->>'childBunk',''),
        inv.parent_name, inv.parent_email, coalesce(p_details, '{}'::jsonb), 'Pending'
    );

    RETURN jsonb_build_object('success', true, 'id', new_id);
END;
$$;

REVOKE ALL ON FUNCTION public.submit_pickup_request(text, text, jsonb, text, uuid, date) FROM public;
GRANT EXECUTE ON FUNCTION public.submit_pickup_request(text, text, jsonb, text, uuid, date) TO authenticated;

-- The 5-arg overload from migration 025 stops existing once CREATE OR REPLACE
-- above redefines the same name with 6 params in Postgres' eyes only if the
-- signature truly matches — it does NOT (different arg count), so both
-- co-exist as overloads. Drop the old 5-arg one explicitly so there's a single
-- version of this RPC going forward (every existing caller already only ever
-- passed named/positional args compatible with the 6-arg version's defaults).
DROP FUNCTION IF EXISTS public.submit_pickup_request(text, text, jsonb, text, uuid);

-- ─── 2. report_dropped_off — parent-writable follow-up on their own row ────
-- Scoped tight on purpose: only sets details.droppedOffAt, only on a row
-- whose parent_email matches one of the caller's own active invites, only
-- once (a second call is a no-op success, not an error — a parent tapping
-- the button twice shouldn't see a failure).
CREATE OR REPLACE FUNCTION public.report_dropped_off(
    p_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    row_rec parent_pickup_requests;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    SELECT * INTO row_rec FROM parent_pickup_requests WHERE id = p_request_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_found');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM link_parent_invites i
        WHERE i.user_id = caller
          AND i.camp_id = row_rec.camp_id
          AND i.parent_email = row_rec.parent_email
    ) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_your_request');
    END IF;

    UPDATE parent_pickup_requests
    SET details = details || jsonb_build_object('droppedOffAt', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
    WHERE id = p_request_id
      AND NOT (details ? 'droppedOffAt');

    RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.report_dropped_off(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.report_dropped_off(uuid) TO authenticated;

-- ─── Sanity check ──────────────────────────────────────────────────────────
--   SELECT proname, pronargs FROM pg_proc WHERE proname = 'submit_pickup_request';
--     -- should show exactly one row, pronargs = 6
--   SELECT proname FROM pg_proc WHERE proname = 'report_dropped_off';
