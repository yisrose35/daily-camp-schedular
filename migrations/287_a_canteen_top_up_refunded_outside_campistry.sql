-- ============================================================================
-- Migration 287: a canteen top-up refunded in Stripe's own dashboard, or
-- disputed with the parent's bank, comes off the child's wallet — once — and
-- the camp is told.
--
-- Standalone. Paste into the Supabase SQL Editor and click Run. Safe to run
-- more than once. Requires 275 and 278. Run it BEFORE deploying stripe-webhook.
--
-- ── THE PROBLEM (TED-181) ──────────────────────────────────────────────────
-- A $20 canteen top-up refunded from the Stripe dashboard (not from Snacks), or
-- disputed by the parent: the parent had the $20 back, the child could still
-- spend $20, and nobody was told. stripe-webhook looked for a family payment
-- with that id, found none, and logged it.
--
-- ── THE CHANGE ─────────────────────────────────────────────────────────────
-- record_canteen_stripe_reversal(camp, payment, refund-or-dispute id, amount,
-- kind, note) — for stripe-webhook only (service role):
--   kind 'refund'      a refund made outside Campistry: that amount comes off
--                      the child's wallet as a 'refund' line naming the top-up
--                      and the refund (so the top-up can't be refunded again);
--   kind 'dispute'     the bank took the money back: the same, for the
--                      disputed amount;
--   kind 'dispute_won' the camp won: the money goes back on the wallet;
--   once per refund / dispute, however often Stripe says so; never more than
--   the top-up had left. Campistry's own canteen refunds are not touched (they
--   are already on the wallet, by their refund id); nor is a top-up with a
--   Campistry refund still waiting for an answer (the camp is told instead).
-- The camp gets a notice each time, and one saying so when the child's wallet
-- goes below zero (the child had already spent the money).
-- ============================================================================

DO $$
BEGIN
    IF to_regprocedure('public.canteen_account_lock(uuid,text)') IS NULL
       OR to_regprocedure('public.canteen_post(uuid,text,jsonb,text)') IS NULL
       OR to_regclass('public.canteen_refund_holds') IS NULL
       OR to_regprocedure('public.is_money_notice(text)') IS NULL THEN
        RAISE EXCEPTION '287 needs migrations 219, 275 and 278 — apply those first';
    END IF;
END $$;

-- The camp's bell shows money notices by this list (278); one more kind.
CREATE OR REPLACE FUNCTION public.is_money_notice(p_source text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
    SELECT COALESCE(p_source, '') IN (
        'payment_unmatched', 'autopay_blocked', 'chargeback', 'card_expiry',
        'parent_payment_plan_created', 'payout_failed', 'charge_unconfirmed',
        'canteen_autoreload_off', 'tip_transfer_failed', 'telnyx_fee_failed', 'autopay_setup',
        'refund_failed', 'canteen_reversed');
$$;

CREATE OR REPLACE FUNCTION public.record_canteen_stripe_reversal(
    p_camp_id           uuid,
    p_payment_intent_id text,
    p_ref_id            text,
    p_amount            numeric,
    p_kind              text,
    p_note              text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_pi    text := NULLIF(btrim(COALESCE(p_payment_intent_id, '')), '');
    v_ref   text := NULLIF(btrim(COALESCE(p_ref_id, '')), '');
    dep     canteen_transactions%ROWTYPE;
    v_acct  jsonb;
    v_bal   numeric;
    v_left  numeric;
    v_amt   numeric;
    v_who   text;
    v_sig   text;
    v_n     integer;
    now_ts  timestamptz := now();
BEGIN
    IF p_camp_id IS NULL OR v_pi IS NULL OR v_ref IS NULL OR p_kind NOT IN ('refund', 'dispute', 'dispute_won') THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_argument');
    END IF;
    SELECT * INTO dep FROM canteen_transactions
     WHERE camp_id = p_camp_id AND payload ->> 'stripePaymentIntentId' = v_pi
       AND tx_type = 'credit' AND COALESCE(payload ->> 'kind', '') = 'deposit'
     ORDER BY first_seen LIMIT 1;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'deposit_not_found');
    END IF;
    v_who := regexp_replace(COALESCE(NULLIF(dep.payload ->> 'camper', ''), dep.camper), '\s#\d+$', '');

    -- the child's wallet lock: two deliveries of the same event queue here
    v_acct := public.canteen_account_lock(p_camp_id, dep.camper);

    IF p_kind = 'dispute_won' THEN
        IF NOT EXISTS (SELECT 1 FROM canteen_transactions WHERE camp_id = p_camp_id AND sig = 'xref:' || v_ref) THEN
            RETURN jsonb_build_object('success', true, 'nothing', 'never_taken');
        END IF;
        v_sig := 'xref_won:' || v_ref;
        IF EXISTS (SELECT 1 FROM canteen_transactions WHERE camp_id = p_camp_id AND sig = v_sig) THEN
            RETURN jsonb_build_object('success', true, 'alreadyRecorded', true);
        END IF;
        SELECT amount INTO v_amt FROM canteen_transactions WHERE camp_id = p_camp_id AND sig = 'xref:' || v_ref;
        v_bal := round(COALESCE(NULLIF(v_acct ->> 'balance', '')::numeric, 0) + v_amt, 2);
        PERFORM public.canteen_account_save(p_camp_id, dep.camper, v_acct || jsonb_build_object('balance', v_bal));
        PERFORM public.canteen_post(p_camp_id, dep.camper, jsonb_build_object(
            'time', to_char(now_ts, 'HH12:MI AM'), 'camper', dep.payload ->> 'camper',
            'items', 'Dispute won — the $' || to_char(v_amt, 'FM999999990.00') || ' is back on the wallet',
            'amount', v_amt, 'type', 'credit', 'kind', 'refund_failed', 'disputeWon', true,
            'stripePaymentIntentId', v_pi, 'stripeDisputeId', v_ref,
            'date', to_char(now_ts, 'YYYY-MM-DD'), 'timestamp', (extract(epoch FROM now_ts) * 1000)::bigint)
            || CASE WHEN dep.camper_id IS NOT NULL AND dep.camper_id ~ '^[0-9]+$' THEN jsonb_build_object('camperId', dep.camper_id::bigint) ELSE '{}'::jsonb END,
            v_sig);
        IF to_regclass('public.notifications') IS NOT NULL THEN
            INSERT INTO notifications (camp_id, source, source_id, title, body, link_target)
            VALUES (p_camp_id, 'canteen_reversed', v_sig, 'A canteen dispute was won',
                    'The bank ruled for the camp on ' || v_who || '''s $' || to_char(v_amt, 'FM999999990.00')
                      || ' top-up, so it is back on ' || v_who || '''s canteen wallet.', 'campistry_snacks.html')
            ON CONFLICT (camp_id, source, source_id) DO NOTHING;
        END IF;
        RETURN jsonb_build_object('success', true, 'amount', v_amt, 'balance', v_bal, 'camper', v_who);
    END IF;

    -- Campistry's own refund: already on the wallet by its id.
    IF p_kind = 'refund' AND EXISTS (SELECT 1 FROM canteen_transactions
                                      WHERE camp_id = p_camp_id AND payload ->> 'stripeRefundId' = v_ref) THEN
        RETURN jsonb_build_object('success', true, 'alreadyRecorded', true, 'own', true);
    END IF;
    v_sig := 'xref:' || v_ref;
    IF EXISTS (SELECT 1 FROM canteen_transactions WHERE camp_id = p_camp_id AND sig = v_sig) THEN
        RETURN jsonb_build_object('success', true, 'alreadyRecorded', true);
    END IF;
    -- A Campistry refund of this top-up still waiting for its answer: its
    -- money is already held off the wallet, and this may be it. Tell, don't take.
    IF p_kind = 'refund' AND EXISTS (SELECT 1 FROM canteen_refund_holds
                                      WHERE camp_id = p_camp_id AND state = 'open' AND payment_ref = v_pi) THEN
        IF to_regclass('public.notifications') IS NOT NULL THEN
            INSERT INTO notifications (camp_id, source, source_id, title, body, link_target)
            VALUES (p_camp_id, 'canteen_reversed', v_sig, 'Check a canteen refund',
                    'A $' || to_char(round(COALESCE(p_amount, 0), 2), 'FM999999990.00') || ' refund of ' || v_who
                      || '''s top-up was made in Stripe while a refund from Snacks was still waiting for an answer. '
                      || 'Open Snacks → Refund All: it looks the waiting refund up. If they are two different refunds, take the second one off '
                      || v_who || '''s wallet by hand.', 'campistry_snacks.html')
            ON CONFLICT (camp_id, source, source_id) DO NOTHING;
        END IF;
        RETURN jsonb_build_object('success', true, 'held', true);
    END IF;

    -- never more than the top-up has left (less what was refunded before, plus
    -- any refund that failed and came back)
    SELECT dep.amount
         - COALESCE(sum(CASE WHEN t.payload ->> 'kind' = 'refund' THEN t.amount ELSE 0 END), 0)
         + COALESCE(sum(CASE WHEN t.payload ->> 'kind' = 'refund_failed' THEN t.amount ELSE 0 END), 0)
      INTO v_left
      FROM canteen_transactions t
     WHERE t.camp_id = p_camp_id AND t.payload ->> 'stripePaymentIntentId' = v_pi
       AND t.payload ->> 'kind' IN ('refund', 'refund_failed');
    v_amt := round(LEAST(GREATEST(COALESCE(p_amount, 0), 0), GREATEST(COALESCE(v_left, dep.amount), 0)), 2);
    IF v_amt <= 0 THEN
        RETURN jsonb_build_object('success', true, 'nothing', 'already_refunded');
    END IF;

    v_bal := round(COALESCE(NULLIF(v_acct ->> 'balance', '')::numeric, 0) - v_amt, 2);
    PERFORM public.canteen_account_save(p_camp_id, dep.camper, v_acct || jsonb_build_object('balance', v_bal));
    PERFORM public.canteen_post(p_camp_id, dep.camper, jsonb_build_object(
        'time', to_char(now_ts, 'HH12:MI AM'), 'camper', dep.payload ->> 'camper',
        'items', CASE WHEN p_kind = 'dispute' THEN 'Top-up disputed with the bank' ELSE 'Top-up refunded in Stripe' END,
        'amount', v_amt, 'type', 'debit', 'kind', 'refund', 'external', true,
        'stripePaymentIntentId', v_pi,
        'note', COALESCE(NULLIF(btrim(COALESCE(p_note, '')), ''), CASE WHEN p_kind = 'dispute' THEN 'Disputed' ELSE 'Refunded outside Campistry' END),
        'by', 'Stripe',
        'date', to_char(now_ts, 'YYYY-MM-DD'), 'timestamp', (extract(epoch FROM now_ts) * 1000)::bigint)
        || CASE WHEN p_kind = 'dispute' THEN jsonb_build_object('stripeDisputeId', v_ref) ELSE jsonb_build_object('stripeRefundId', v_ref) END
        || CASE WHEN dep.camper_id IS NOT NULL AND dep.camper_id ~ '^[0-9]+$' THEN jsonb_build_object('camperId', dep.camper_id::bigint) ELSE '{}'::jsonb END,
        v_sig);

    IF to_regclass('public.notifications') IS NOT NULL THEN
        INSERT INTO notifications (camp_id, source, source_id, title, body, link_target)
        VALUES (p_camp_id, 'canteen_reversed', v_sig,
                CASE WHEN p_kind = 'dispute' THEN 'A canteen top-up was disputed' ELSE 'A canteen top-up was refunded in Stripe' END,
                CASE WHEN p_kind = 'dispute'
                     THEN 'The parent disputed ' || v_who || '''s $' || to_char(v_amt, 'FM999999990.00') || ' top-up with their bank, so it has come off ' || v_who || '''s canteen wallet. If the camp wins the dispute it goes back on. '
                     ELSE 'A $' || to_char(v_amt, 'FM999999990.00') || ' refund of ' || v_who || '''s top-up was made in the Stripe dashboard, so it has come off ' || v_who || '''s canteen wallet. Next time, refund from Snacks. ' END
                  || CASE WHEN v_bal < 0 THEN v_who || ' had already spent it: the wallet is now $' || to_char(v_bal, 'FM999999990.00') || ' — the family owes the canteen that much.' ELSE '' END,
                'campistry_snacks.html')
        ON CONFLICT (camp_id, source, source_id) DO NOTHING;
    END IF;
    RETURN jsonb_build_object('success', true, 'amount', v_amt, 'balance', v_bal, 'camper', v_who, 'overdrawn', v_bal < 0);
END $$;
REVOKE ALL ON FUNCTION public.record_canteen_stripe_reversal(uuid, text, text, numeric, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_canteen_stripe_reversal(uuid, text, text, numeric, text, text) TO service_role;
