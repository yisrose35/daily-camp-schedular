-- ============================================================================
-- Migration 249: a parent's portal knows their children's camper IDs.
--
-- WHY. Since 248 every function that names a camper also takes p_camper_id, and
-- given one, the id decides. The parent portal could not send one: it builds its
-- children from get_parent_data_by_user / get_my_camps, which return the
-- invite's camper NAMES and a per-name snapshot — never the ids 223 stamps on
-- every invite (link_parent_invites.person_ids, one per name, same order). So
-- every canteen limit, auto-reload, health document, pickup request, camper
-- letter, tip and face-consent the portal sent identified the child by spelling.
-- And the form bridge sent the portal's own list index ("child_0") where a
-- camper id belonged.
--
-- WHAT. get_my_camper_ids(camp): the caller's children as {campId, name,
-- camperId}, one per name on each of their live invites. The id is the one
-- STAMPED on the invite at that position — nothing is resolved from a name
-- here. A slot with no stamp comes back with camperId null, and that child's
-- calls go by name as before, through the server's own gates (224/232).
--
-- The portal wraps its client's rpc() once: any call that names a camper gets
-- the camper's id attached (tests/every_camper_call_sends_an_id.test.js).
--
-- HOW TO APPLY. Paste into the SQL Editor. One function. Touches no data.
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_my_camper_ids(p_camp_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT jsonb_build_object('success', auth.uid() IS NOT NULL, 'campers', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                   'campId',   i.camp_id,
                   'name',     e.value #>> '{}',
                   'camperId', CASE WHEN jsonb_typeof(i.person_ids -> (e.ord - 1)::int) = 'number'
                                    THEN (i.person_ids ->> (e.ord - 1)::int)::bigint END)
                 ORDER BY i.camp_id, e.ord)
          FROM link_parent_invites i
          CROSS JOIN LATERAL jsonb_array_elements(
                  CASE WHEN jsonb_typeof(i.camper_names) = 'array'
                       THEN i.camper_names ELSE '[]'::jsonb END) WITH ORDINALITY AS e(value, ord)
         WHERE i.user_id = auth.uid()
           AND (i.status = 'active' OR i.billing_access = true)
           AND (i.expires_at IS NULL OR i.expires_at > now())
           AND (p_camp_id IS NULL OR i.camp_id = p_camp_id)), '[]'::jsonb))
$$;

REVOKE ALL ON FUNCTION public.get_my_camper_ids(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_my_camper_ids(uuid) TO authenticated;
