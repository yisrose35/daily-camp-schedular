-- 121_camp_tax_id_lockdown.sql
-- Locks down camps.tax_id / camps.show_tax_id_on_statements (added in
-- migration 119) so they can no longer be read via a raw table select.
--
-- Why: those two columns carry no RLS masking of their own — they inherit
-- whatever row-level SELECT policy already exists on `camps`. That policy
-- is not tracked in this repo (it predates the migrations convention), but
-- migration 077 already tells us it's broad: it had to add
-- get_camp_stripe_status() specifically because "stripe_account_id itself
-- is deliberately never returned — no reason to hand it to the browser,"
-- which only makes sense if plain RLS would otherwise let it through to
-- any camp member. A Tax ID/EIN sits in that same "don't hand it to the
-- browser" bucket — more sensitive than the camp's name/address, which is
-- also on this table but not worth the same treatment.
--
-- Fix: revoke column-level SELECT on both columns for anon/authenticated
-- (this narrows Postgres's per-column privilege check independently of
-- RLS — a `select('*')` or `select('tax_id')` from the browser now fails
-- outright, for every role, including the camp's own owner). The ONLY way
-- to read the real values afterward is get_camp_tax_id() below, a
-- SECURITY DEFINER function that runs with the table owner's privileges
-- (bypassing the column revoke internally) and checks the caller is the
-- camp's owner before returning anything — the same bar this field's
-- EDIT already uses (dashboard.js: "Only camp owners can edit the camp
-- profile"), stricter than get_camp_stripe_status's any-camp-member read
-- bar.
--
-- Paste this whole file into the Supabase SQL Editor and run it.
-- Dashboard.js and campistry_me.js are updated in this same change to
-- call get_camp_tax_id() instead of reading the raw columns, and to stop
-- syncing the value into camp_state_kv (campGlobalSettings_v1), which was
-- readable by any staff member with Billing access.

REVOKE SELECT (tax_id, show_tax_id_on_statements) ON public.camps FROM authenticated, anon;

CREATE OR REPLACE FUNCTION public.get_camp_tax_id(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    row_data camps;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM camps c WHERE c.id = p_camp_id AND c.owner = caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_owner');
    END IF;

    SELECT * INTO row_data FROM camps WHERE id = p_camp_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'camp_not_found');
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'tax_id', row_data.tax_id,
        'show_tax_id_on_statements', row_data.show_tax_id_on_statements
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_camp_tax_id(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_camp_tax_id(uuid) TO authenticated;

-- Verify after running:
--   -- confirm the column-level revoke landed:
--   select grantee, column_name, privilege_type
--   from information_schema.column_privileges
--   where table_name = 'camps' and column_name in ('tax_id','show_tax_id_on_statements');
--   -- (authenticated/anon should NOT appear with SELECT here)
--
--   -- confirm a raw select now fails for a normal client (run this via the
--   -- app's own supabase-js client, not the SQL Editor, which runs as a
--   -- superuser and is unaffected by the revoke):
--   --   await supabase.from('camps').select('tax_id').eq('id', campId)
--   --   -> should error with a permission-denied message
--
--   -- confirm the RPC still works for the real owner:
--   --   select get_camp_tax_id('<a real camp id>'::uuid);  -- as that camp's owner
