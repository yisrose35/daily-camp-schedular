-- =============================================================================
-- Migration 079: Real Stripe payments for Campistry Canteen.
--
-- Canteen's "Add Funds" flow today is entirely fake: submit_canteen_deposit
-- (migration 019) just bumps a JSON balance number by whatever amount a
-- parent typed — no payment is ever collected. Any legitimately-invited
-- parent can inflate their own kid's canteen balance for free today (bounded
-- $1-$500 per call, uncapped repeated calls). This migration closes that and
-- replaces it with a real Stripe-backed flow:
--
--   parent clicks Add Funds -> stripe-checkout creates a Checkout Session
--   (destination-routed to the camp's own connected Stripe account, see
--   migrations/077_camp_stripe_connect.sql) -> parent pays -> Stripe fires
--   payment_intent.succeeded -> stripe-webhook calls
--   credit_canteen_balance_from_stripe() below, idempotent on the
--   PaymentIntent id -> office can refund a still-unspent deposit via
--   stripe-canteen-refund, which calls refund_canteen_deposit_from_stripe()
--   below.
--
-- No platform fee (camp keeps 100%, same policy as tuition). Refund access
-- is owner+admin only, enforced in the edge function via a real session
-- (never trusts a client-supplied campId), not by these RPCs themselves --
-- these RPCs are service-role-only, reachable only from the webhook/refund
-- edge functions, never directly from a user session.
--
-- Kept the JSON-blob model (camp_state_kv.campistrySnacks) rather than
-- relationalizing -- every existing canteen code path (_reconcileBalances,
-- the POS terminal, the admin dashboard) already treats the transactions
-- array as source of truth and rebuilds balances from it.
-- =============================================================================

-- ─── 1. Close the free-money bug ────────────────────────────────────────────
-- Revoke, not drop -- keeps the function in the schema as an audit trail /
-- easy rollback point. It is now intentionally unreachable: nothing
-- legitimate should ever call this again once addFunds() switches to
-- Stripe Checkout. The office's manual deposit path (campistry_snacks.js's
-- addDep, honest bookkeeping for money already physically received) never
-- called this RPC in the first place -- it writes camp_state_kv directly
-- under an authenticated staff session -- so this revoke does not affect it.
REVOKE EXECUTE ON FUNCTION public.submit_canteen_deposit(text, numeric) FROM authenticated;

-- ─── 2. credit_canteen_balance_from_stripe ──────────────────────────────────
-- Called ONLY by stripe-webhook (service-role client) once Stripe confirms a
-- canteen-deposit PaymentIntent succeeded. Idempotent on p_payment_intent_id
-- so a webhook retry (or two overlapping deliveries of the same event) can
-- never double-credit.
CREATE OR REPLACE FUNCTION public.credit_canteen_balance_from_stripe(
    p_camp_id            uuid,
    p_camper_name        text,
    p_amount             numeric,
    p_payment_intent_id  text
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
    IF p_payment_intent_id IS NULL OR btrim(p_payment_intent_id) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_payment_intent');
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

    -- Idempotency: has this exact PaymentIntent already been credited?
    SELECT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_value->'transactions') t
        WHERE t->>'stripePaymentIntentId' = p_payment_intent_id
    ) INTO v_already;
    IF v_already THEN
        RETURN jsonb_build_object(
            'success', true, 'alreadyProcessed', true,
            'balance', COALESCE((v_value->'accounts'->p_camper_name->>'balance')::numeric, 0)
        );
    END IF;

    -- Defense-in-depth roster check -- the real gate is in stripe-checkout
    -- (campOwnsCamper, checked BEFORE the Checkout Session is even created).
    -- By the time this RPC runs, Stripe has already captured real money, so
    -- a missing roster match is logged (rosterVerified:false) for office
    -- follow-up rather than refused -- refusing here would strand captured
    -- money with nowhere to go.
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
            'method', 'stripe',
            'date',   to_char(now_ts, 'YYYY-MM-DD'),
            'stripePaymentIntentId', p_payment_intent_id,
            'timestamp', (extract(epoch from now_ts) * 1000)::bigint
        )) || COALESCE(v_value->'transactions', '[]'::jsonb)
    );

    UPDATE camp_state_kv
    SET value = v_value, updated_at = now_ts
    WHERE camp_id = p_camp_id AND key = 'campistrySnacks';

    RETURN jsonb_build_object('success', true, 'balance', v_bal, 'rosterVerified', v_roster_ok);
END;
$$;

REVOKE ALL ON FUNCTION public.credit_canteen_balance_from_stripe(uuid, text, numeric, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_canteen_balance_from_stripe(uuid, text, numeric, text) TO service_role;

-- ─── 3. refund_canteen_deposit_from_stripe ──────────────────────────────────
-- Called ONLY by stripe-canteen-refund (service-role client) after a Stripe
-- refund has already succeeded. Does NOT re-enforce the balanceFloor cap --
-- by the time this runs, real money has already left the camp's connected
-- account, so the only correct place to prevent an over-refund is the
-- pre-check inside stripe-canteen-refund itself, before calling Stripe.
CREATE OR REPLACE FUNCTION public.refund_canteen_deposit_from_stripe(
    p_camp_id            uuid,
    p_camper_name        text,
    p_amount             numeric,
    p_payment_intent_id  text,
    p_refund_id          text
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
    IF p_refund_id IS NULL OR btrim(p_refund_id) = '' THEN
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
        WHERE t->>'stripeRefundId' = p_refund_id
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
            'method', 'stripe',
            'date',   to_char(now_ts, 'YYYY-MM-DD'),
            'stripePaymentIntentId', p_payment_intent_id,
            'stripeRefundId', p_refund_id,
            'timestamp', (extract(epoch from now_ts) * 1000)::bigint
        )) || COALESCE(v_value->'transactions', '[]'::jsonb)
    );

    UPDATE camp_state_kv
    SET value = v_value, updated_at = now_ts
    WHERE camp_id = p_camp_id AND key = 'campistrySnacks';

    RETURN jsonb_build_object('success', true, 'balance', v_bal);
END;
$$;

REVOKE ALL ON FUNCTION public.refund_canteen_deposit_from_stripe(uuid, text, numeric, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_canteen_deposit_from_stripe(uuid, text, numeric, text, text) TO service_role;

-- ─── 4. get_camp_canteen_stripe_status ──────────────────────────────────────
-- A parent-safe status read -- the existing get_camp_stripe_status
-- (migration 077) requires camps.owner/camp_users membership, which a
-- parent (a link_parent_invites holder, not a camp member) will never pass.
-- Returns only what the parent portal needs to decide whether to show "Add
-- Funds" -- never stripe_account_id.
CREATE OR REPLACE FUNCTION public.get_camp_canteen_stripe_status(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    row_data camps;
BEGIN
    IF p_camp_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_camp_id');
    END IF;

    SELECT * INTO row_data FROM camps WHERE id = p_camp_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'camp_not_found');
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'connected', row_data.stripe_account_id IS NOT NULL,
        'charges_enabled', row_data.stripe_charges_enabled
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.get_camp_canteen_stripe_status(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_camp_canteen_stripe_status(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.get_camp_canteen_stripe_status(uuid) TO authenticated;

-- ─── Sanity check ────────────────────────────────────────────────────────
--   select proacl from pg_proc where proname = 'submit_canteen_deposit';
--   -- confirm 'authenticated' is no longer in the ACL
--   select credit_canteen_balance_from_stripe(
--     '<a real camp id>'::uuid, '<a real camper name>', 25.00, 'pi_test_123'
--   ); -- run twice, second call should return alreadyProcessed:true
--   select get_camp_canteen_stripe_status('<a real camp id>'::uuid);
-- =============================================================================
