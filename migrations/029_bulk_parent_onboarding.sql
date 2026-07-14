-- ============================================================================
-- Migration 029: Bulk parent onboarding — for camps that adopt Link AFTER
-- registration has closed (roster imported into Me via CSV/Excel).
--
-- FLOW
--   1. Admin (Link → Parents) bulk-generates invites for every roster family
--      using the existing upsert_parent_invite RPC (one per parent email,
--      siblings grouped). Nothing new needed server-side for that.
--   2. Mail-merge CSV export gives the camp parent_email → invite URL + code
--      to blast through their own email tool.
--   3. SELF-SERVE: a parent who simply signs up at the portal with the email
--      the camp has on file is AUTO-CLAIMED by claim_invites_by_email() —
--      no code, no personal link needed. Gated on a CONFIRMED auth email so
--      nobody can claim someone else's invite with an unverified address.
--   4. If the parent's email doesn't match (different address than on file),
--      they file a join request; the admin approves it against a family and
--      the parent is bound instantly.
-- ============================================================================

-- ─── 1. get_camp_parent_invites — staff: invite status table ─────────────────
CREATE OR REPLACE FUNCTION public.get_camp_parent_invites(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE caller uuid := auth.uid(); result jsonb;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    IF NOT EXISTS (SELECT 1 FROM camps c WHERE c.id = p_camp_id AND c.owner = caller)
       AND NOT EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = p_camp_id AND u.user_id = caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_a_member');
    END IF;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'parent_name',  i.parent_name,
        'parent_email', i.parent_email,
        'camper_names', i.camper_names,
        'token',        i.token,
        'access_code',  i.access_code,
        'claimed',      (i.user_id IS NOT NULL),
        'status',       i.status,
        'created_at',   i.created_at
    ) ORDER BY i.created_at DESC), '[]'::jsonb)
    INTO result
    FROM link_parent_invites i
    WHERE i.camp_id = p_camp_id AND i.status = 'active';

    RETURN jsonb_build_object('success', true, 'invites', result);
END;
$$;
REVOKE ALL ON FUNCTION public.get_camp_parent_invites(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_camp_parent_invites(uuid) TO authenticated;

-- ─── 2. claim_invites_by_email — parent self-serve, zero-friction ─────────────
-- Binds every active, unclaimed invite whose parent_email matches the caller's
-- CONFIRMED auth email. Idempotent; safe to call on every sign-in.
CREATE OR REPLACE FUNCTION public.claim_invites_by_email()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller  uuid := auth.uid();
    v_email text;
    v_confirmed timestamptz;
    n int;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;

    SELECT lower(u.email), u.email_confirmed_at INTO v_email, v_confirmed
    FROM auth.users u WHERE u.id = caller;

    IF v_email IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'no_email'); END IF;
    IF v_confirmed IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'email_not_confirmed'); END IF;

    UPDATE link_parent_invites
    SET user_id = caller
    WHERE lower(parent_email) = v_email
      AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
      AND (user_id IS NULL OR user_id = caller);
    GET DIAGNOSTICS n = ROW_COUNT;

    RETURN jsonb_build_object('success', true, 'claimed', n);
END;
$$;
REVOKE ALL ON FUNCTION public.claim_invites_by_email() FROM public;
GRANT EXECUTE ON FUNCTION public.claim_invites_by_email() TO authenticated;

-- ─── 3. link_join_requests — "my email didn't match" fallback queue ───────────
CREATE TABLE IF NOT EXISTS public.link_join_requests (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    camp_id      uuid        NOT NULL,
    user_id      uuid        NOT NULL,
    email        text        NOT NULL,
    name         text,
    phone        text,
    note         text,                            -- "I'm Eli & Mia Miller's father"
    status       text        NOT NULL DEFAULT 'pending',  -- pending|approved|declined
    resolved_by  uuid,
    resolved_at  timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.link_join_requests ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_link_join_requests_camp ON public.link_join_requests (camp_id, status);

-- staff manage requests directly; parents go through the RPCs
DO $$
BEGIN
    DROP POLICY IF EXISTS ljr_staff_all ON public.link_join_requests;
    CREATE POLICY ljr_staff_all ON public.link_join_requests FOR ALL
        USING (
            EXISTS (SELECT 1 FROM camps c WHERE c.id = camp_id AND c.owner = auth.uid())
            OR EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = link_join_requests.camp_id AND u.user_id = auth.uid())
        )
        WITH CHECK (
            EXISTS (SELECT 1 FROM camps c WHERE c.id = camp_id AND c.owner = auth.uid())
            OR EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = link_join_requests.camp_id AND u.user_id = auth.uid())
        );
END $$;

-- ─── 4. submit_join_request — parent files a request for a specific camp ──────
CREATE OR REPLACE FUNCTION public.submit_join_request(
    p_camp_id uuid,
    p_name    text,
    p_phone   text,
    p_note    text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller  uuid := auth.uid();
    v_email text;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    IF NOT EXISTS (SELECT 1 FROM camps c WHERE c.id = p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_such_camp');
    END IF;
    SELECT lower(u.email) INTO v_email FROM auth.users u WHERE u.id = caller;
    IF v_email IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'no_email'); END IF;

    -- one pending request per user per camp
    IF EXISTS (SELECT 1 FROM link_join_requests r
               WHERE r.camp_id = p_camp_id AND r.user_id = caller AND r.status = 'pending') THEN
        RETURN jsonb_build_object('success', true, 'already_pending', true);
    END IF;

    INSERT INTO link_join_requests (camp_id, user_id, email, name, phone, note)
    VALUES (p_camp_id, caller, v_email,
            left(coalesce(p_name,''), 120), left(coalesce(p_phone,''), 40), left(coalesce(p_note,''), 1000));

    RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public.submit_join_request(uuid, text, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.submit_join_request(uuid, text, text, text) TO authenticated;

-- ─── 5. resolve_join_request — admin approves (binding user) or declines ──────
-- Approve: p_parent_email names the family's invite (bulk-generated earlier, or
-- created by the admin just before calling this). The requester's user_id is
-- bound to that invite, giving them instant portal access.
CREATE OR REPLACE FUNCTION public.resolve_join_request(
    p_request_id   uuid,
    p_action       text,               -- 'approve' | 'decline'
    p_parent_email text DEFAULT NULL   -- required for approve
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    req    link_join_requests;
    n int;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;

    SELECT * INTO req FROM link_join_requests WHERE id = p_request_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'no_such_request'); END IF;

    IF NOT EXISTS (SELECT 1 FROM camps c WHERE c.id = req.camp_id AND c.owner = caller)
       AND NOT EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = req.camp_id AND u.user_id = caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_a_member');
    END IF;
    IF req.status <> 'pending' THEN
        RETURN jsonb_build_object('success', false, 'error', 'already_resolved');
    END IF;

    IF p_action = 'decline' THEN
        UPDATE link_join_requests SET status = 'declined', resolved_by = caller, resolved_at = now()
        WHERE id = p_request_id;
        RETURN jsonb_build_object('success', true, 'status', 'declined');
    END IF;

    IF p_action <> 'approve' OR p_parent_email IS NULL OR btrim(p_parent_email) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_action');
    END IF;

    -- Bind the requester to the family's active invite.
    UPDATE link_parent_invites
    SET user_id = req.user_id
    WHERE camp_id = req.camp_id
      AND lower(parent_email) = lower(p_parent_email)
      AND status = 'active'
      AND (user_id IS NULL OR user_id = req.user_id);
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n = 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_matching_invite');
    END IF;

    UPDATE link_join_requests SET status = 'approved', resolved_by = caller, resolved_at = now()
    WHERE id = p_request_id;

    RETURN jsonb_build_object('success', true, 'status', 'approved', 'bound', n);
END;
$$;
REVOKE ALL ON FUNCTION public.resolve_join_request(uuid, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.resolve_join_request(uuid, text, text) TO authenticated;
