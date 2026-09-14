-- =============================================================================
-- 150 — let the edge function actually read the templates
--
-- THE BUG
--
-- 147 gave get_bank_templates the same owner/admin gate every other deposit
-- RPC has:
--
--     IF NOT _deposit_can_admin(p_camp_id) THEN ... 'not_authorized'
--
-- which resolves auth.uid(). The deposit-inbox function calls it with the
-- SERVICE ROLE, where auth.uid() is NULL — so the check fails, the RPC returns
-- not_authorized, applyLearnedTemplate() treats that as "no template" and
-- returns null.
--
-- The effect is the worst kind: a camp teaches its bank's layout, the UI
-- confirms it saved, the template sits in the table — and every incoming email
-- is still read by the generic parser, with nothing anywhere saying why. No
-- error, no log line, no failed hit counter. Just a feature that quietly does
-- nothing.
--
-- THE FIX
--
-- A read path for the service role that does not ask who the user is, because
-- for a webhook there isn't one. The camp is already proven by the routing
-- token in the inbound address (_deposit_camp_for_token), which is how the
-- function knew which camp_id to pass in the first place — re-checking a user
-- that cannot exist adds nothing.
--
-- Deliberately NOT granted to authenticated: the browser keeps using
-- get_bank_templates, which keeps its admin gate. Two callers, two paths, each
-- checked the way that makes sense for it.
--
-- Idempotent -- safe to re-run. Run AFTER 147.
-- =============================================================================

CREATE OR REPLACE FUNCTION public._deposit_templates_for_camp(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_out jsonb;
BEGIN
    SELECT COALESCE(jsonb_agg(row_to_json(t)::jsonb ORDER BY t.scope), '[]'::jsonb)
      INTO v_out
      FROM (
        SELECT id, scope, bank_signature, bank_label, template, source
          FROM bank_templates
         WHERE (scope = 'camp' AND camp_id = p_camp_id)
            OR scope = 'shared'
      ) t;

    RETURN jsonb_build_object('success', true, 'templates', v_out);
END;
$$;

REVOKE ALL ON FUNCTION public._deposit_templates_for_camp(uuid) FROM public, anon, authenticated;

NOTIFY pgrst, 'reload schema';
