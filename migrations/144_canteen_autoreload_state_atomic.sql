-- ============================================================================
-- 144_canteen_autoreload_state_atomic.sql
--
-- Fixes canteen-auto-reload silently erasing its own Cardknox credit.
--
-- The Cardknox path in supabase/functions/canteen-auto-reload/index.ts does
-- TWO writes to the same campistrySnacks JSON blob per successful reload:
--   1. credit_canteen_balance_from_processor (migration 132) — an atomic,
--      FOR UPDATE-locked RPC that correctly adds the balance + the deposit
--      transaction to the row in the DB.
--   2. a final `upsert` of the ENTIRE campistrySnacks blob the function read
--      into memory at the START of the run, to persist the autoReload
--      bookkeeping (lastChargedDate / reloadHistory / consecutiveFailures
--      that markSuccess/markFailure mutate in memory).
-- Because that in-memory blob predates step 1, step 2 overwrites the row and
-- ERASES the credit step 1 just made — confirmed live: a real Cardknox
-- charge (xRefNum 11103398773) with the balance never moving and the deposit
-- appearing in neither campistrySnacks nor processor_transactions. (The
-- Stripe path doesn't hit this: it credits asynchronously via stripe-webhook,
-- so its blob upsert only ever carries autoReload bookkeeping, not a balance
-- the same run already wrote.)
--
-- Fix: this RPC persists ONLY one camper's autoReload object, under the same
-- FOR UPDATE lock every other writer to this row uses, reading the row fresh
-- so the balance/transactions credit_canteen_balance_from_processor just
-- committed are preserved untouched. The edge function calls this per camper
-- instead of blindly re-upserting the stale whole-blob snapshot.
--
-- service_role only, same lockdown as the other canteen-crediting RPCs.
-- Idempotent — safe to re-run.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.update_canteen_autoreload_state(
    p_camp_id      uuid,
    p_camper_name  text,
    p_autoreload   jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_value jsonb;
    now_ts  timestamptz := now();
BEGIN
    IF p_camp_id IS NULL OR p_camper_name IS NULL OR btrim(p_camper_name) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_params');
    END IF;
    IF p_autoreload IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_autoreload');
    END IF;

    SELECT value INTO v_value FROM camp_state_kv
    WHERE camp_id = p_camp_id AND key = 'campistrySnacks' FOR UPDATE;
    IF v_value IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_snacks_row');
    END IF;
    IF v_value->'accounts' IS NULL THEN v_value := jsonb_set(v_value, '{accounts}', '{}'::jsonb); END IF;
    IF v_value->'accounts'->p_camper_name IS NULL THEN
        v_value := jsonb_set(v_value, ARRAY['accounts', p_camper_name],
            '{"balance":0,"dailyLimit":10,"spentToday":0}'::jsonb, true);
    END IF;

    -- Only the autoReload sub-key is replaced. balance and transactions in the
    -- freshly-read row (including anything credit_canteen_balance_from_processor
    -- just committed) are left exactly as they are.
    v_value := jsonb_set(v_value, ARRAY['accounts', p_camper_name, 'autoReload'], p_autoreload, true);

    UPDATE camp_state_kv SET value = v_value, updated_at = now_ts
    WHERE camp_id = p_camp_id AND key = 'campistrySnacks';

    RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public.update_canteen_autoreload_state(uuid, text, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_canteen_autoreload_state(uuid, text, jsonb) TO service_role;
