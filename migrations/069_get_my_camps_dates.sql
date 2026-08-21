-- ============================================================================
-- Migration 069: get_my_camps() also returns each camp's campDates.
--
-- Purely additive — one new key (`camp_dates`) on each camp object already
-- returned by get_my_camps() (migration 041). Nothing else about the
-- function's signature or existing fields changes, so no caller breaks.
--
-- Why: a parent whose kids attended different camps in different years sees
-- ALL of those camps in the Link portal today (get_my_camps already returns
-- every camp they're linked to, indefinitely — link_parent_invites rows
-- aren't tied to "current enrollment", they just stay active until
-- explicitly revoked). That already works for messages, forms, and even
-- payment balances (campistry_link_parent.html's loadPayments() already
-- loops per camp). What's missing is a way for the client to tell "this
-- year's camp" apart from "camp from two summers ago" so the payments view
-- can put the current camp's balance front-and-center instead of burying it
-- in a flat stack of mostly-paid-off history. campDates (already tracked
-- per camp under camp_state_kv key 'campDates' — see dashboard.js) is
-- exactly the field needed for that, just never surfaced to this RPC.
--
-- SECURITY DEFINER + STABLE already lets this function read across every
-- camp the caller is linked to (not just camps they belong to as staff) —
-- reading one more key per camp from camp_state_kv is not a new class of
-- access, it's the same bypass-RLS-via-function-owner pattern the function
-- already relies on for link_parent_invites/campistryMe.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_my_camps()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    result jsonb;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'camp_id',      i.camp_id,
        'camp_name',    coalesce(NULLIF(btrim(c.name), ''), 'Camp'),
        'parent_name',  i.parent_name,
        'parent_email', i.parent_email,
        'family_id',    i.family_id,
        'camper_names', i.camper_names,
        'camper_data',  i.camper_data,
        'camp_dates',   cd.value
    ) ORDER BY coalesce(c.name,''), i.created_at), '[]'::jsonb)
    INTO result
    FROM link_parent_invites i
    LEFT JOIN camps c ON c.id = i.camp_id
    LEFT JOIN camp_state_kv cd ON cd.camp_id = i.camp_id AND cd.key = 'campDates'
    WHERE i.user_id = caller
      AND i.status = 'active'
      AND (i.expires_at IS NULL OR i.expires_at > now());

    RETURN jsonb_build_object('success', true, 'camps', result);
END;
$$;
REVOKE ALL ON FUNCTION public.get_my_camps() FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_camps() TO authenticated;

-- Sanity check after running:
--   SELECT proname FROM pg_proc WHERE proname = 'get_my_camps';
--   -- then from a parent session: select get_my_camps() and confirm each
--   -- camp object now has a "camp_dates" key (null is fine for camps that
--   -- never configured camp dates).
