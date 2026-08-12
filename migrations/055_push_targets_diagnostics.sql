-- ============================================================================
-- Migration 055: make a push that reaches nobody explain itself.
--
-- push_targets_for_camp (054) returns only the devices that should be sent to.
-- That is the correct shape for sending, and a terrible shape for diagnosis:
-- an empty result is indistinguishable between
--
--     * the camp has no registered devices at all,
--     * the parents' invites are revoked or expired,
--     * the parents switched this notification type off,
--     * the message is addressed to an email nobody signed up with.
--
-- Those need four different fixes, and the ambiguity cost a full debugging
-- session: a live device with a valid token and granted permission received
-- nothing, because its parent's invite had been revoked and the send reported
-- a cheerful "sent: 0".
--
-- v2 therefore returns EVERY device belonging to anyone this camp has ever
-- invited, each with the reason it does or does not qualify. The Edge Function
-- filters on the flags to send, and counts them to explain a zero.
--
-- 054's function is left in place and still used by nothing else; it is kept so
-- this migration cannot break a caller that has not been redeployed yet.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.push_targets_for_camp_v2(
    p_camp_id uuid,
    p_pref    text,
    p_email   text DEFAULT NULL
)
RETURNS TABLE (
    token         text,
    platform      text,
    app           text,
    user_id       uuid,
    invite_active boolean,
    pref_on       boolean,
    email_match   boolean
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
    -- One row per parent this camp knows, regardless of invite state, so a
    -- revoked parent's devices are still counted and reported rather than
    -- disappearing from the result entirely.
    WITH camp_parents AS (
        SELECT i.user_id,
               bool_or(
                   i.status = 'active'
                   AND (i.expires_at IS NULL OR i.expires_at > now())
               ) AS active
        FROM link_parent_invites i
        WHERE i.camp_id = p_camp_id
          AND i.user_id IS NOT NULL
        GROUP BY i.user_id
    )
    SELECT
        t.token,
        t.platform,
        t.app,
        t.user_id,
        cp.active AS invite_active,
        -- Absent preference = on, matching the app's own default.
        COALESCE(
            (SELECT (p.prefs ->> p_pref)::boolean
             FROM link_parent_profiles p WHERE p.user_id = t.user_id),
            true
        ) IS TRUE AS pref_on,
        -- A direct message names one family; a broadcast names none. An email
        -- that matches no account is the interesting case and is reported as
        -- false rather than silently returning nothing.
        --
        -- Matched against the INVITE's parent_email first: that is the camp's
        -- own record of the family, and it is the same value link_messages
        -- addresses the message to, so the two always agree. The login email is
        -- also accepted because a parent may well have signed up with a
        -- different address than the office has on file — insisting on one or
        -- the other would drop notifications for a family that is perfectly
        -- correctly set up.
        (
            p_email IS NULL
            OR btrim(p_email) = ''
            OR EXISTS (
                SELECT 1 FROM link_parent_invites i2
                WHERE i2.camp_id = p_camp_id
                  AND i2.user_id = t.user_id
                  AND lower(i2.parent_email) = lower(btrim(p_email))
            )
            OR EXISTS (
                SELECT 1 FROM auth.users u
                WHERE u.id = t.user_id
                  AND lower(u.email) = lower(btrim(p_email))
            )
        ) AS email_match
    FROM link_push_tokens t
    JOIN camp_parents cp ON cp.user_id = t.user_id;
$$;

-- Service role ONLY — this returns other people's device tokens and user ids.
-- Revoking from public and authenticated is NOT enough: Supabase also grants
-- EXECUTE on new functions to anon, which is how 054's original grant left this
-- readable by an anonymous caller. Verified against the live database.
REVOKE ALL ON FUNCTION public.push_targets_for_camp_v2(uuid, text, text) FROM public;
REVOKE ALL ON FUNCTION public.push_targets_for_camp_v2(uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.push_targets_for_camp_v2(uuid, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.push_targets_for_camp_v2(uuid, text, text) TO service_role;
