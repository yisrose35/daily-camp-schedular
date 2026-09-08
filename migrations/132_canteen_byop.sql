-- =============================================================================
-- Migration 132: Canteen deposits/refunds for BYOP camps.
--
-- Canteen's "Add Funds"/refund flow was Stripe-only (migration 079) —
-- flagged explicitly in BYOP_SETUP.md as a deferred gap for camps on a
-- connected non-Stripe processor (Banquest/Cardknox-Sola). This closes it,
-- mirroring migration 079's shape exactly but processor-generic:
--
--   parent taps Add Funds -> (BYOP camp) opens campistry_card_setup.html in
--   its canteen mode -> tokenizes the card via that processor's own widget
--   -> payments-canteen-checkout (new edge function) tokenizes+saves+charges
--   in one call, no session needed (the parent has none) -> calls
--   credit_canteen_balance_from_processor() below, idempotent on the
--   processor's own transaction id -> office can refund a still-unspent
--   deposit via payments-canteen-refund (new edge function, mirrors
--   stripe-canteen-refund's multi-deposit apportionment), which calls
--   refund_canteen_deposit_from_processor() below.
--
-- Kept the JSON-blob model (camp_state_kv.campistrySnacks) — same reasoning
-- as migration 079, every existing canteen code path already treats the
-- transactions array as source of truth. A BYOP deposit/refund transaction
-- is tagged method:'<processorKey>' (not 'stripe') and carries
-- byopTransactionId/byopRefundId instead of stripePaymentIntentId/
-- stripeRefundId — get_canteen_accounts (unchanged) returns both kinds
-- side by side, so a family that deposited before AND after a processor
-- switch sees one unified transaction history either way.
--
-- Idempotent — safe to re-run.
-- =============================================================================

-- ─── 1. credit_canteen_balance_from_processor ───────────────────────────────
-- Called ONLY by payments-canteen-checkout (service-role client) once that
-- processor's charge call succeeds. Idempotent on p_external_transaction_id
-- so a retried request can never double-credit.
CREATE OR REPLACE FUNCTION public.credit_canteen_balance_from_processor(
    p_camp_id                 uuid,
    p_camper_name              text,
    p_amount                   numeric,
    p_processor_key            text,
    p_external_transaction_id  text
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

    -- Defense-in-depth roster check -- the real gate is in
    -- payments-canteen-checkout (campOwnsCamper, checked BEFORE the charge
    -- is even attempted). By the time this RPC runs, the processor has
    -- already captured real money, so a missing roster match is logged
    -- (rosterVerified:false) for office follow-up rather than refused.
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

    v_value := jsonb_set(
        v_value, '{transactions}',
        jsonb_build_array(jsonb_build_object(
            'time',   to_char(now_ts, 'HH12:MI AM'),
            'camper', p_camper_name,
            'items',  'Funds added by parent (online)',
            'amount', p_amount,
            'type',   'credit',
            'kind',   'deposit',
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

REVOKE ALL ON FUNCTION public.credit_canteen_balance_from_processor(uuid, text, numeric, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_canteen_balance_from_processor(uuid, text, numeric, text, text) TO service_role;


-- ─── 2. refund_canteen_deposit_from_processor ───────────────────────────────
-- Called ONLY by payments-canteen-refund (service-role client) after that
-- processor's refund call has already succeeded. Does NOT re-enforce the
-- balanceFloor cap -- same reasoning as refund_canteen_deposit_from_stripe:
-- by the time this runs, real money has already left the camp's account, so
-- the only correct place to prevent an over-refund is the pre-check inside
-- payments-canteen-refund itself, before calling the processor.
CREATE OR REPLACE FUNCTION public.refund_canteen_deposit_from_processor(
    p_camp_id                     uuid,
    p_camper_name                  text,
    p_amount                       numeric,
    p_processor_key                text,
    p_external_transaction_id      text,
    p_refund_external_id           text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_value    jsonb;
    v_bal      numeric;
    v_already  boolean;
    now_ts     timestamptz := now();
BEGIN
    IF p_camp_id IS NULL OR p_camper_name IS NULL OR btrim(p_camper_name) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_params');
    END IF;
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_amount');
    END IF;
    IF p_refund_external_id IS NULL OR btrim(p_refund_external_id) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_refund_id');
    END IF;

    SELECT value INTO v_value
    FROM camp_state_kv
    WHERE camp_id = p_camp_id AND key = 'campistrySnacks'
    FOR UPDATE;

    IF v_value IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_canteen_data');
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(v_value->'transactions', '[]'::jsonb)) t
        WHERE t->>'byopRefundId' = p_refund_external_id
    ) INTO v_already;
    IF v_already THEN
        RETURN jsonb_build_object(
            'success', true, 'alreadyProcessed', true,
            'balance', COALESCE((v_value->'accounts'->p_camper_name->>'balance')::numeric, 0)
        );
    END IF;

    v_bal := round(COALESCE((v_value->'accounts'->p_camper_name->>'balance')::numeric, 0) - p_amount, 2);

    v_value := jsonb_set(
        v_value, ARRAY['accounts', p_camper_name],
        COALESCE(v_value->'accounts'->p_camper_name, '{"dailyLimit":10,"spentToday":0}'::jsonb)
            || jsonb_build_object('balance', v_bal),
        true
    );

    v_value := jsonb_set(
        v_value, '{transactions}',
        jsonb_build_array(jsonb_build_object(
            'time',   to_char(now_ts, 'HH12:MI AM'),
            'camper', p_camper_name,
            'items',  'Refund — deposit reversed',
            'amount', p_amount,
            'type',   'debit',
            'kind',   'refund',
            'method', p_processor_key,
            'date',   to_char(now_ts, 'YYYY-MM-DD'),
            'byopTransactionId', p_external_transaction_id,
            'byopRefundId', p_refund_external_id,
            'timestamp', (extract(epoch from now_ts) * 1000)::bigint
        )) || COALESCE(v_value->'transactions', '[]'::jsonb)
    );

    UPDATE camp_state_kv
    SET value = v_value, updated_at = now_ts
    WHERE camp_id = p_camp_id AND key = 'campistrySnacks';

    RETURN jsonb_build_object('success', true, 'balance', v_bal);
END;
$$;

REVOKE ALL ON FUNCTION public.refund_canteen_deposit_from_processor(uuid, text, numeric, text, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_canteen_deposit_from_processor(uuid, text, numeric, text, text, text) TO service_role;


-- ─── 3. get_camp_canteen_stripe_status — teach it about BYOP too ───────────
-- Same parent-safe RPC campistry_link_parent.html already calls to decide
-- whether to show "Add Funds" (migration 079) — extended in place rather
-- than adding a second one, so there's still exactly one gate function.
-- `connected` is now true for EITHER a charges-enabled Stripe account OR a
-- verified BYOP credential; `processorKey` tells the client which flow to
-- use. Every existing Stripe camp's response is byte-for-byte unchanged
-- (payment_processor_key defaults to 'stripe', camp_processor_credentials
-- has no row for them, so the new OR branch is simply false).
CREATE OR REPLACE FUNCTION public.get_camp_canteen_stripe_status(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    row_data     camps;
    v_byop_ok    boolean;
BEGIN
    IF p_camp_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_camp_id');
    END IF;

    SELECT * INTO row_data FROM camps WHERE id = p_camp_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'camp_not_found');
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM camp_processor_credentials
        WHERE camp_id = p_camp_id AND status = 'verified'
          AND processor_key = row_data.payment_processor_key
    ) INTO v_byop_ok;

    RETURN jsonb_build_object(
        'success', true,
        'connected', (row_data.stripe_account_id IS NOT NULL) OR COALESCE(v_byop_ok, false),
        'charges_enabled', COALESCE(row_data.stripe_charges_enabled, false) OR COALESCE(v_byop_ok, false),
        'processorKey', row_data.payment_processor_key
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.get_camp_canteen_stripe_status(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_camp_canteen_stripe_status(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.get_camp_canteen_stripe_status(uuid) TO authenticated;

-- ─── Sanity checks ──────────────────────────────────────────────────────────
--   select credit_canteen_balance_from_processor(
--     '<a real camp id>'::uuid, '<a real camper name>', 25.00, 'cardknox', 'txn_test_123'
--   ); -- run twice, second call should return alreadyProcessed:true
--   select get_camp_canteen_stripe_status('<a real BYOP-connected camp id>'::uuid);
--   -- expect connected:true, charges_enabled:true, processorKey the BYOP key
--   select get_camp_canteen_stripe_status('<a real Stripe-only camp id>'::uuid);
--   -- expect byte-for-byte the same result as before this migration
-- =============================================================================
