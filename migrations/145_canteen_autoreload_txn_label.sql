-- ============================================================================
-- Migration 145: label auto-reload top-ups distinctly in the canteen ledger
--
-- Auto-reload deposits and parent-initiated "Add Funds" deposits both flow
-- through credit_canteen_balance_from_processor (migration 132), so both were
-- written to the transactions ledger as "Funds added by parent (online)" with
-- kind:'deposit'. A parent looking at Recent Transactions couldn't tell an
-- automatic top-up apart from one they added by hand.
--
-- This adds an optional p_source parameter. When the caller is the auto-reload
-- cron (canteen-auto-reload edge function) it passes p_source => 'autoreload',
-- and the ledger row is written with items:'Auto-reload top-up' and
-- kind:'autoreload'. The parent portal renders those rows with an "Auto-Pay"
-- tag (campistry_link_parent.html _mapCanteenTx).
--
-- Backward compatible: p_source defaults to 'parent', so the existing 5-arg
-- callers (payments-canteen-checkout) keep writing the same
-- "Funds added by parent (online)" / kind:'deposit' rows with no change.
--
-- Implementation note: a defaulted trailing parameter changes the function's
-- signature, and CREATE OR REPLACE cannot change a signature, so the old
-- 5-arg version is dropped first and the 6-arg version created in its place.
-- Postgres still resolves 5-argument calls to the new function (filling
-- p_source with its default), so no caller breaks.
-- ============================================================================

DROP FUNCTION IF EXISTS public.credit_canteen_balance_from_processor(uuid, text, numeric, text, text);

CREATE OR REPLACE FUNCTION public.credit_canteen_balance_from_processor(
    p_camp_id                  uuid,
    p_camper_name              text,
    p_amount                   numeric,
    p_processor_key            text,
    p_external_transaction_id  text,
    p_source                   text DEFAULT 'parent'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_value      jsonb;
    v_bal        numeric;
    v_already    boolean;
    v_roster_ok  boolean;
    v_is_auto    boolean := (p_source = 'autoreload');
    v_items      text;
    v_kind       text;
    now_ts       timestamptz := now();
BEGIN
    IF p_camp_id IS NULL OR p_camper_name IS NULL OR btrim(p_camper_name) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_params');
    END IF;
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_amount');
    END IF;
    IF p_external_transaction_id IS NULL OR btrim(p_external_transaction_id) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_transaction_id');
    END IF;

    INSERT INTO camp_state_kv (camp_id, key, value, updated_at)
    VALUES (p_camp_id, 'campistrySnacks', '{"accounts":{},"transactions":[]}'::jsonb, now_ts)
    ON CONFLICT (camp_id, key) DO NOTHING;

    SELECT value INTO v_value
    FROM camp_state_kv
    WHERE camp_id = p_camp_id AND key = 'campistrySnacks'
    FOR UPDATE;

    IF v_value IS NULL THEN v_value := '{"accounts":{},"transactions":[]}'::jsonb; END IF;
    IF v_value->'accounts' IS NULL THEN v_value := jsonb_set(v_value, '{accounts}', '{}'::jsonb); END IF;
    IF v_value->'transactions' IS NULL THEN v_value := jsonb_set(v_value, '{transactions}', '[]'::jsonb); END IF;

    SELECT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_value->'transactions') t
        WHERE t->>'byopTransactionId' = p_external_transaction_id
    ) INTO v_already;
    IF v_already THEN
        RETURN jsonb_build_object(
            'success', true, 'alreadyProcessed', true,
            'balance', COALESCE((v_value->'accounts'->p_camper_name->>'balance')::numeric, 0)
        );
    END IF;

    -- Defense-in-depth roster check (same as migration 132).
    SELECT (value->'app1'->'camperRoster' ? p_camper_name) INTO v_roster_ok
    FROM camp_state_kv WHERE camp_id = p_camp_id AND key = 'app1';
    v_roster_ok := COALESCE(v_roster_ok, false);

    v_bal := round(COALESCE((v_value->'accounts'->p_camper_name->>'balance')::numeric, 0) + p_amount, 2);

    v_value := jsonb_set(
        v_value, ARRAY['accounts', p_camper_name],
        COALESCE(v_value->'accounts'->p_camper_name, '{"dailyLimit":10,"spentToday":0}'::jsonb)
            || jsonb_build_object('balance', v_bal),
        true
    );

    v_items := CASE WHEN v_is_auto THEN 'Auto-reload top-up' ELSE 'Funds added by parent (online)' END;
    v_kind  := CASE WHEN v_is_auto THEN 'autoreload' ELSE 'deposit' END;

    v_value := jsonb_set(
        v_value, '{transactions}',
        jsonb_build_array(jsonb_build_object(
            'time',   to_char(now_ts, 'HH12:MI AM'),
            'camper', p_camper_name,
            'items',  v_items,
            'amount', p_amount,
            'type',   'credit',
            'kind',   v_kind,
            'method', p_processor_key,
            'date',   to_char(now_ts, 'YYYY-MM-DD'),
            'byopTransactionId', p_external_transaction_id,
            'timestamp', (extract(epoch from now_ts) * 1000)::bigint
        )) || COALESCE(v_value->'transactions', '[]'::jsonb)
    );

    UPDATE camp_state_kv
    SET value = v_value, updated_at = now_ts
    WHERE camp_id = p_camp_id AND key = 'campistrySnacks';

    RETURN jsonb_build_object('success', true, 'balance', v_bal, 'rosterVerified', v_roster_ok);
END;
$$;

REVOKE ALL ON FUNCTION public.credit_canteen_balance_from_processor(uuid, text, numeric, text, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_canteen_balance_from_processor(uuid, text, numeric, text, text, text) TO service_role;
