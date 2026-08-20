-- ============================================================================
-- Migration 066: push_targets_for_staff_emails
--
-- push_targets_for_camp_v2 (055) only resolves PARENT devices, joined
-- against link_parent_invites. Lite (staff/counselor) devices already
-- register tokens the same way (link_push_tokens.app='lite'), but there has
-- been no way to actually reach them — a staff user_id is invisible to that
-- function's query. This is the staff-side equivalent: given a camp and a
-- list of staff emails (as stored in campistryMe.bunkStaff / divisionHeads /
-- leaguesByName.teamCaptains), resolve their registered device tokens.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.push_targets_for_staff_emails(
    p_camp_id uuid,
    p_emails  text[]
)
RETURNS TABLE (token text, platform text, app text, user_id uuid, matched_email text)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
    SELECT t.token, t.platform, t.app, t.user_id, lower(u.email)
    FROM link_push_tokens t
    JOIN auth.users u ON u.id = t.user_id
    WHERE lower(u.email) = ANY (SELECT lower(x) FROM unnest(p_emails) x)
      AND (
        EXISTS (
            SELECT 1 FROM camp_users cu
            WHERE cu.user_id = t.user_id AND cu.camp_id = p_camp_id AND cu.accepted_at IS NOT NULL
        )
        OR EXISTS (
            SELECT 1 FROM camps c WHERE c.id = p_camp_id AND c.owner = t.user_id
        )
      );
$$;

-- Service role ONLY — same rationale as push_targets_for_camp_v2 (055):
-- returns other people's device tokens/user ids, and Supabase grants EXECUTE
-- to anon by default on new functions, so anon must be explicitly revoked
-- too, not just public/authenticated.
REVOKE ALL ON FUNCTION public.push_targets_for_staff_emails(uuid, text[]) FROM public;
REVOKE ALL ON FUNCTION public.push_targets_for_staff_emails(uuid, text[]) FROM anon;
REVOKE ALL ON FUNCTION public.push_targets_for_staff_emails(uuid, text[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.push_targets_for_staff_emails(uuid, text[]) TO service_role;

-- ─── Sanity check ──────────────────────────────────────────────────────────
--   SELECT * FROM push_targets_for_staff_emails('<camp_id>', ARRAY['someone@example.com']);
