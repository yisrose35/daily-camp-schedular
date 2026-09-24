-- ============================================================================
-- Migration 275: a canteen refund takes its money out of the wallet FIRST.
--
-- Standalone. Paste into the Supabase SQL Editor and click Run. Safe to run
-- more than once. Run it BEFORE redeploying payments-canteen-refund,
-- payments-canteen-refund-all, stripe-canteen-refund and
-- stripe-canteen-refund-all — the redeployed functions call it.
--
-- ── THE PROBLEM (TED-110) ──────────────────────────────────────────────────
-- Every canteen refund read the child's balance, asked the card company, and
-- only then took the money off the wallet. Two refunds for the same child at
-- once — "Refund All" running while someone refunds that child, or two office
-- computers — both read the same $20, both sent $20 to the parent, and the
-- wallet ended at -$20. Refund All reads every balance once at the start and
-- runs for minutes at a big camp, so the window was wide; a canteen sale
-- during the run was over-refunded the same way.
--
-- ── THE CHANGE ─────────────────────────────────────────────────────────────
-- A refund now RESERVES its money in one locked step before the card company
-- is asked: the child's wallet row is locked, what is left above the floor is
-- checked, and the amount comes off the balance there and then. A second
-- refund (or a sale) waits for the lock and sees the lower balance. The
-- reservation is a row in canteen_refund_holds:
--
--   open      the money is off the wallet; the card company has been (or is
--             being) asked
--   posted    the card company said yes: the refund line is on the ledger
--   released  the card company said a definite no: the money went back on
--             the wallet
--
-- An answer that never came back leaves the hold OPEN — the money stays off
-- the wallet, because it may have gone to the parent. Stripe holds are
-- re-asked with the same Idempotency-Key and settle themselves; a
-- Cardknox/Banquest one waits for the office to check the processor.
--
-- The hold key is the refund claim's key (refund_intents, 198), so a retry of
-- the same refund meets its own hold and never takes the money twice.
-- ============================================================================

DO $$
BEGIN
    IF to_regprocedure('public.canteen_account_lock(uuid,text)') IS NULL
       OR to_regprocedure('public.canteen_account_save(uuid,text,jsonb)') IS NULL
       OR to_regprocedure('public.canteen_post(uuid,text,jsonb,text)') IS NULL
       OR to_regprocedure('public.canteen_account_key_for(uuid,text)') IS NULL
       OR to_regprocedure('public.camp_person_name_for(uuid,bigint)') IS NULL THEN
        RAISE EXCEPTION '275 needs the canteen row writers (219, 227) and camp_person_name_for (257) — apply those first';
    END IF;
END $$;

SET LOCAL lock_timeout = '15s';

CREATE TABLE IF NOT EXISTS public.canteen_refund_holds (
    camp_id     uuid          NOT NULL,
    hold_key    text          NOT NULL,     -- the refund claim's key
    account_key text          NOT NULL,     -- the wallet the money came off
    amount      numeric(12,2) NOT NULL CHECK (amount > 0),
    method      text          NOT NULL,     -- 'stripe', 'cardknox', 'banquest'
    payment_ref text          NOT NULL,     -- the top-up it is refunded from
    stripe_key  text,                       -- the Idempotency-Key Stripe was sent
    state       text          NOT NULL DEFAULT 'open'
                              CHECK (state IN ('open', 'posted', 'released')),
    refund_id   text,                       -- the card company's refund reference
    created_at  timestamptz   NOT NULL DEFAULT now(),
    settled_at  timestamptz,
    PRIMARY KEY (camp_id, hold_key)
);
CREATE INDEX IF NOT EXISTS idx_canteen_refund_holds_open
    ON public.canteen_refund_holds (camp_id, account_key) WHERE state = 'open';

ALTER TABLE public.canteen_refund_holds ENABLE ROW LEVEL SECURITY;
-- No policies: only the refund functions (service role) read or write it.
REVOKE ALL ON TABLE public.canteen_refund_holds FROM anon, authenticated;


-- ─── reserve: take the money off the wallet, under the wallet's lock ───────
CREATE OR REPLACE FUNCTION public.reserve_canteen_refund(
    p_camp_id     uuid,
    p_camper_name text,
    p_hold_key    text,
    p_amount      numeric,
    p_method      text,
    p_payment_ref text,
    p_stripe_key  text   DEFAULT NULL,
    p_camper_id   bigint DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_name  text := NULLIF(btrim(COALESCE(p_camper_name, '')), '');
    v_key   text := NULLIF(btrim(COALESCE(p_hold_key, '')), '');
    v_amt   numeric := round(COALESCE(p_amount, 0), 2);
    v_acct  jsonb;
    v_hold  canteen_refund_holds;
    v_have  boolean;
    v_avail numeric;
    v_bal   numeric;
BEGIN
    IF p_camper_id IS NOT NULL THEN
        -- The number decides, and is pinned for this call (257), so the name it
        -- resolves to reaches this child's wallet even when another child
        -- shares the name.
        v_name := public.camp_person_name_for(p_camp_id, p_camper_id);
        IF v_name IS NULL THEN
            RETURN jsonb_build_object('success', false, 'error', 'unknown_camper');
        END IF;
    END IF;
    IF p_camp_id IS NULL OR v_name IS NULL OR v_key IS NULL
       OR NULLIF(btrim(COALESCE(p_payment_ref, '')), '') IS NULL
       OR NULLIF(btrim(COALESCE(p_method, '')), '') IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_params');
    END IF;
    IF v_amt <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_amount');
    END IF;

    -- The wallet's lock first: every reserve, settle and release for this
    -- child queues here, and so does every sale (they take the same lock).
    v_acct := public.canteen_account_lock(p_camp_id, v_name);
    IF v_acct IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_canteen_data');
    END IF;

    SELECT * INTO v_hold FROM canteen_refund_holds
     WHERE camp_id = p_camp_id AND hold_key = v_key FOR UPDATE;
    v_have := FOUND;
    -- The same refund again (a retry, or its second press): its money is
    -- already off the wallet, or already refunded. Never take it twice.
    IF v_have AND v_hold.state IN ('open', 'posted') THEN
        RETURN jsonb_build_object('success', true, 'existing', true, 'state', v_hold.state,
                                  'amount', v_hold.amount, 'refundId', v_hold.refund_id,
                                  'balance', COALESCE((v_acct ->> 'balance')::numeric, 0));
    END IF;

    v_avail := round(COALESCE(NULLIF(v_acct ->> 'balance', '')::numeric, 0)
                   - COALESCE(NULLIF(v_acct ->> 'balanceFloor', '')::numeric, 0), 2);
    IF v_amt > v_avail THEN
        RETURN jsonb_build_object('success', false, 'error', 'insufficient',
                                  'available', GREATEST(v_avail, 0));
    END IF;

    v_bal := round(COALESCE(NULLIF(v_acct ->> 'balance', '')::numeric, 0) - v_amt, 2);
    PERFORM public.canteen_account_save(p_camp_id, v_name, v_acct || jsonb_build_object('balance', v_bal));

    IF v_have THEN
        -- Given back after a "no" and now sent again: reserved afresh.
        UPDATE canteen_refund_holds
           SET amount = v_amt, method = p_method, payment_ref = p_payment_ref,
               stripe_key = p_stripe_key, state = 'open', refund_id = NULL,
               created_at = now(), settled_at = NULL
         WHERE camp_id = p_camp_id AND hold_key = v_key;
    ELSE
        INSERT INTO canteen_refund_holds
            (camp_id, hold_key, account_key, amount, method, payment_ref, stripe_key)
        VALUES (p_camp_id, v_key, public.canteen_account_key_for(p_camp_id, v_name),
                v_amt, p_method, p_payment_ref, p_stripe_key);
    END IF;

    RETURN jsonb_build_object('success', true, 'balance', v_bal);
END $$;
REVOKE ALL ON FUNCTION public.reserve_canteen_refund(uuid, text, text, numeric, text, text, text, bigint)
    FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_canteen_refund(uuid, text, text, numeric, text, text, text, bigint)
    TO service_role;


-- ─── settle: the card company said yes — the refund goes on the ledger ─────
-- The money is already off the wallet, so the balance does not move again.
-- A hold that had been given back (the office said "nothing went through",
-- and the card company later turned out to have refunded after all) takes the
-- money off now: it did go to the parent.
CREATE OR REPLACE FUNCTION public.settle_canteen_refund_hold(
    p_camp_id   uuid,
    p_hold_key  text,
    p_refund_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_hold   canteen_refund_holds;
    v_acct   jsonb;
    v_bal    numeric;
    v_ref    text := NULLIF(btrim(COALESCE(p_refund_id, '')), '');
    v_posted boolean;
    now_ts   timestamptz := now();
BEGIN
    SELECT * INTO v_hold FROM canteen_refund_holds WHERE camp_id = p_camp_id AND hold_key = p_hold_key;
    IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'no_hold'); END IF;
    IF v_ref IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'missing_refund_id'); END IF;

    v_acct := public.canteen_account_lock(p_camp_id, v_hold.account_key);
    SELECT * INTO v_hold FROM canteen_refund_holds
     WHERE camp_id = p_camp_id AND hold_key = p_hold_key FOR UPDATE;
    IF v_hold.state = 'posted' THEN
        RETURN jsonb_build_object('success', true, 'alreadyProcessed', true,
                                  'balance', COALESCE((v_acct ->> 'balance')::numeric, 0));
    END IF;
    v_bal := COALESCE(NULLIF(v_acct ->> 'balance', '')::numeric, 0);

    -- Already on the ledger under this refund reference (an older function
    -- posted it, and took the money off itself): nothing more comes off.
    SELECT EXISTS (
        SELECT 1 FROM canteen_transactions t
         WHERE t.camp_id = p_camp_id
           AND (t.payload ->> 'stripeRefundId' = v_ref OR t.payload ->> 'byopRefundId' = v_ref)
    ) INTO v_posted;

    IF v_posted AND v_hold.state = 'open' THEN
        v_bal := round(v_bal + v_hold.amount, 2);       -- that post already took it
        PERFORM public.canteen_account_save(p_camp_id, v_hold.account_key, v_acct || jsonb_build_object('balance', v_bal));
    ELSIF NOT v_posted THEN
        IF v_hold.state = 'released' THEN
            v_bal := round(v_bal - v_hold.amount, 2);
            PERFORM public.canteen_account_save(p_camp_id, v_hold.account_key, v_acct || jsonb_build_object('balance', v_bal));
        END IF;
        PERFORM public.canteen_post(p_camp_id, v_hold.account_key,
            jsonb_build_object(
                'time',   to_char(now_ts, 'HH12:MI AM'),
                'camper', v_hold.account_key,
                'items',  'Refund — deposit reversed',
                'amount', v_hold.amount,
                'type',   'debit',
                'kind',   'refund',
                'method', v_hold.method,
                'date',   to_char(now_ts, 'YYYY-MM-DD'),
                'refundHold', v_hold.hold_key,
                'timestamp', (extract(epoch from now_ts) * 1000)::bigint)
            || CASE WHEN v_hold.method = 'stripe'
                    THEN jsonb_build_object('stripePaymentIntentId', v_hold.payment_ref, 'stripeRefundId', v_ref)
                    ELSE jsonb_build_object('byopTransactionId', v_hold.payment_ref, 'byopRefundId', v_ref) END);
    END IF;

    UPDATE canteen_refund_holds SET state = 'posted', refund_id = v_ref, settled_at = now_ts
     WHERE camp_id = p_camp_id AND hold_key = p_hold_key;
    RETURN jsonb_build_object('success', true, 'balance', v_bal);
END $$;
REVOKE ALL ON FUNCTION public.settle_canteen_refund_hold(uuid, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_canteen_refund_hold(uuid, text, text) TO service_role;


-- ─── release: a definite "no" — the money goes back on the wallet ──────────
-- p_min_age is for "the office checked and nothing went through": only a hold
-- that has waited that long (longer than any refund call runs) is given back,
-- never one still on its way.
CREATE OR REPLACE FUNCTION public.release_canteen_refund_hold(
    p_camp_id  uuid,
    p_hold_key text,
    p_min_age  interval DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_hold canteen_refund_holds;
    v_acct jsonb;
    v_bal  numeric;
BEGIN
    SELECT * INTO v_hold FROM canteen_refund_holds WHERE camp_id = p_camp_id AND hold_key = p_hold_key;
    IF NOT FOUND THEN RETURN jsonb_build_object('released', false, 'error', 'no_hold'); END IF;

    v_acct := public.canteen_account_lock(p_camp_id, v_hold.account_key);
    SELECT * INTO v_hold FROM canteen_refund_holds
     WHERE camp_id = p_camp_id AND hold_key = p_hold_key FOR UPDATE;
    IF v_hold.state <> 'open' THEN
        RETURN jsonb_build_object('released', false, 'state', v_hold.state);
    END IF;
    IF p_min_age IS NOT NULL
       AND v_hold.created_at > now() - GREATEST(p_min_age, interval '1 minute') THEN
        RETURN jsonb_build_object('released', false, 'error', 'too_new');
    END IF;

    v_bal := round(COALESCE(NULLIF(v_acct ->> 'balance', '')::numeric, 0) + v_hold.amount, 2);
    PERFORM public.canteen_account_save(p_camp_id, v_hold.account_key, v_acct || jsonb_build_object('balance', v_bal));
    UPDATE canteen_refund_holds SET state = 'released', settled_at = now()
     WHERE camp_id = p_camp_id AND hold_key = p_hold_key;
    RETURN jsonb_build_object('released', true, 'balance', v_bal, 'amount', v_hold.amount);
END $$;
REVOKE ALL ON FUNCTION public.release_canteen_refund_hold(uuid, text, interval) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_canteen_refund_hold(uuid, text, interval) TO service_role;


-- ─── the refund screens see what is on its way ─────────────────────────────
-- canteen_refund_view (250) also lists the open holds, so a refund counts
-- money already on its way to a parent against the top-up it came from, and
-- can tell the office about one the card company never confirmed.
CREATE OR REPLACE FUNCTION public.canteen_refund_view(p_camp_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT jsonb_build_object(
        'success', true,
        'accounts', COALESCE((
            SELECT jsonb_object_agg(a.account_key, public._canteen_account_json(a)
                       || CASE WHEN a.person_id IS NULL THEN '{}'::jsonb
                               ELSE jsonb_build_object('camperId', a.person_id) END)
              FROM camp_canteen_accounts a
             WHERE a.camp_id = p_camp_id AND a.deleted_at IS NULL), '{}'::jsonb),
        'transactions', COALESCE((
            SELECT jsonb_agg(public._canteen_tx_json(t) ORDER BY t.tx_date, t.first_seen)
              FROM canteen_transactions t
             WHERE t.camp_id = p_camp_id
               AND (t.tx_type = 'credit' OR t.payload ->> 'kind' = 'refund')), '[]'::jsonb),
        'holds', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                       'key', h.hold_key, 'accountKey', h.account_key,
                       'camperId', a.person_id, 'amount', h.amount, 'method', h.method,
                       'paymentRef', h.payment_ref, 'stripeKey', h.stripe_key,
                       'createdAt', h.created_at,
                       'ageSeconds', floor(extract(epoch FROM now() - h.created_at)))
                     ORDER BY h.created_at)
              FROM canteen_refund_holds h
              LEFT JOIN camp_canteen_accounts a
                     ON a.camp_id = h.camp_id AND a.account_key = h.account_key
             WHERE h.camp_id = p_camp_id AND h.state = 'open'), '[]'::jsonb))
$$;
REVOKE ALL ON FUNCTION public.canteen_refund_view(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.canteen_refund_view(uuid) TO service_role;
