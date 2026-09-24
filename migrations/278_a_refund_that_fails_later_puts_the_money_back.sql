-- ============================================================================
-- Migration 278: a Stripe refund that fails after Stripe accepted it puts the
-- money back, and tells the office.
--
-- Standalone. Paste into the Supabase SQL Editor and click Run. Safe to run
-- more than once. Run it BEFORE redeploying stripe-webhook.
--
-- ── THE PROBLEM (TED-126) ──────────────────────────────────────────────────
-- Stripe can accept a refund and fail it days later — the parent's card
-- account was closed, say. Campistry booked the refund when Stripe accepted it
-- and never heard about the failure: the family's bill (or the child's canteen
-- wallet) kept saying "refunded" while the parent got nothing. With a
-- destination charge the money lands back in Campistry's platform balance, so
-- the camp's own Stripe account never shows it either.
--
-- ── THE CHANGE ─────────────────────────────────────────────────────────────
-- stripe-webhook (redeployed) now listens for Stripe's refund.failed (and a
-- refund.updated / charge.refund.updated whose status is failed) and calls
-- this function, once per failed refund:
--
--   a canteen refund   the money goes back on the child's wallet, with a
--                      "refund failed" line on its history (its top-up can be
--                      refunded again: the refund screens subtract the line);
--   a family refund    the family's ledger gets the money back as a payment
--                      entry (the way a won chargeback is posted, 175), and
--                      the payments list gets the matching row;
--   either             a Billing notice (only people who can see Billing).
--   neither            (not on these books — made in the Stripe dashboard, or
--                      its answer was lost) still a Billing notice, and the
--                      webhook still alerts the platform (TED-131): the money
--                      is back in Campistry's Stripe balance either way.
--
-- A canteen refund put back reopens its reservation (TED-129), so the next
-- Refund All refunds that money again rather than finding it "already done".
--
-- The same failure again (Stripe re-sends events) changes nothing, and says
-- so (firstNotice false), so the platform is alerted once.
-- ============================================================================

DO $$
BEGIN
    IF to_regprocedure('public.canteen_account_lock(uuid,text)') IS NULL
       OR to_regprocedure('public.canteen_account_save(uuid,text,jsonb)') IS NULL
       OR to_regprocedure('public.canteen_post(uuid,text,jsonb,text)') IS NULL
       OR to_regprocedure('public.camp_families_object(uuid)') IS NULL
       OR to_regprocedure('public.camp_family_for_update(uuid,text)') IS NULL
       OR to_regprocedure('public.camp_payment_add(uuid,jsonb)') IS NULL
       OR to_regprocedure('public.payment_ledger_entry(jsonb)') IS NULL
       OR to_regprocedure('public.is_money_notice(text)') IS NULL THEN
        RAISE EXCEPTION '278 needs migrations 178, 215, 219, 227 and 270 — apply those first';
    END IF;
END $$;

-- ── the notice is a money notice (270): only people who can see Billing ──────
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
        'refund_failed');
$$;
GRANT EXECUTE ON FUNCTION public.is_money_notice(text) TO authenticated, service_role;


-- A failed refund that is not on these books: the office is told, once.
-- Returns whether this was the first time (so the platform is alerted once).
DROP FUNCTION IF EXISTS public._notice_unbooked_refund_failure(uuid, text, text, numeric, text);
CREATE OR REPLACE FUNCTION public._notice_unbooked_refund_failure(
    p_camp_id     uuid,
    p_refund_id   text,
    p_reason      text,
    p_amount      numeric,
    p_payment_ref text,
    p_hold_key    text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_n       integer := 0;
    v_waiting canteen_refund_holds;
    v_what    text := 'Stripe could not send a ' || COALESCE('$' || to_char(round(p_amount, 2), 'FM999999990.00') || ' ', '')
                      || 'refund (' || p_refund_id || COALESCE(', on payment ' || NULLIF(p_payment_ref, ''), '') || ')'
                      || COALESCE(' — ' || NULLIF(p_reason, ''), '') || '. The parent did not get it. ';
BEGIN
    IF to_regclass('public.notifications') IS NULL THEN RETURN true; END IF;
    -- Campistry's own canteen refund whose answer was lost (TED-138): its money
    -- is still held off the child's wallet, and the next look-up (Refund All,
    -- or that child's Refund) puts it back and sends it again. Refunding it by
    -- hand as well would pay the parent twice.
    IF NULLIF(p_hold_key, '') IS NOT NULL THEN
        SELECT * INTO v_waiting FROM canteen_refund_holds
         WHERE camp_id = p_camp_id AND hold_key = p_hold_key AND state = 'open';
    END IF;
    INSERT INTO notifications (camp_id, source, source_id, title, body, link_target)
    VALUES (p_camp_id, 'refund_failed', p_refund_id,
            CASE WHEN v_waiting.hold_key IS NOT NULL THEN 'A canteen refund failed' ELSE 'A refund failed' END,
            v_what
              || CASE WHEN v_waiting.hold_key IS NOT NULL
                      THEN 'It was a canteen refund of ' || regexp_replace(v_waiting.account_key, '\s#\d+$', '')
                           || '''s money that Campistry was still waiting to hear about. Its money is held off the wallet: '
                           || 'the next Refund All in Snacks (or that child''s Refund) looks it up, puts it back on the wallet and sends it again. '
                           || 'Do NOT refund it by hand as well — the parent would be paid twice. '
                      ELSE 'It is not on Campistry''s books (it may have been made in the Stripe dashboard), so nothing was changed here: '
                           || 'find the payment in Stripe, then refund it again or record it by hand. ' END
              || 'Stripe returned the money to Campistry''s platform account; Campistry has been alerted to pass it back to yours.',
            CASE WHEN v_waiting.hold_key IS NOT NULL THEN 'campistry_snacks.html' ELSE 'campistry_me.html' END)
    ON CONFLICT (camp_id, source, source_id) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n > 0;
END $$;
REVOKE ALL ON FUNCTION public._notice_unbooked_refund_failure(uuid, text, text, numeric, text, text) FROM public, anon, authenticated;

-- A failed refund no camp could be found for: the platform is alerted once
-- (TED-137) — Stripe sends the failure several times (refund.failed,
-- refund.updated, charge.refund.updated, and retries).
CREATE TABLE IF NOT EXISTS public.refund_failure_alerts (
    refund_id  text        PRIMARY KEY,
    first_seen timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.refund_failure_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.refund_failure_alerts FROM public, anon, authenticated;
CREATE OR REPLACE FUNCTION public.claim_refund_failure_alert(p_refund_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE v_n integer := 0;
BEGIN
    IF NULLIF(btrim(COALESCE(p_refund_id, '')), '') IS NULL THEN RETURN true; END IF;
    INSERT INTO refund_failure_alerts (refund_id) VALUES (p_refund_id) ON CONFLICT (refund_id) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n > 0;
END $$;
REVOKE ALL ON FUNCTION public.claim_refund_failure_alert(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_refund_failure_alert(text) TO service_role;

DROP FUNCTION IF EXISTS public.reverse_failed_stripe_refund(uuid, text, text);
DROP FUNCTION IF EXISTS public.reverse_failed_stripe_refund(uuid, text, text, numeric, text);
CREATE OR REPLACE FUNCTION public.reverse_failed_stripe_refund(
    p_camp_id     uuid,
    p_refund_id   text,
    p_reason      text    DEFAULT NULL,
    p_amount      numeric DEFAULT NULL,    -- Stripe's, for a refund not on these books
    p_payment_ref text    DEFAULT NULL,    -- the payment it was refunding, likewise
    p_hold_key    text    DEFAULT NULL)    -- its metadata.campistryHold, when Campistry sent it
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    now_ts   timestamptz := now();
    v_ref    text := NULLIF(btrim(COALESCE(p_refund_id, '')), '');
    v_why    text := NULLIF(btrim(COALESCE(p_reason, '')), '');
    v_tx     record;
    v_key    text;
    v_acct   jsonb;
    v_bal    numeric;
    v_amt    numeric;
    famRec   record;
    v_famKey text;
    v_entry  jsonb;
    v_fam    jsonb;
    v_row    jsonb;
    v_rev    jsonb;
    v_who    text;
    v_first  boolean := false;
    v_n      integer;
BEGIN
    IF p_camp_id IS NULL OR v_ref IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_arguments');
    END IF;

    -- ── a canteen refund: the money goes back on the child's wallet ─────────
    SELECT camper, amount, payload INTO v_tx
      FROM canteen_transactions
     WHERE camp_id = p_camp_id AND payload ->> 'stripeRefundId' = v_ref
       AND payload ->> 'kind' = 'refund'
     LIMIT 1;
    IF FOUND THEN
        v_key  := public.canteen_account_key_for(p_camp_id, v_tx.camper);
        v_acct := public.canteen_account_lock(p_camp_id, v_key);
        IF v_acct IS NULL THEN
            v_first := public._notice_unbooked_refund_failure(p_camp_id, v_ref, v_why, COALESCE(p_amount, v_tx.amount), p_payment_ref, p_hold_key);
            RETURN jsonb_build_object('success', false, 'error', 'account_not_found', 'firstNotice', v_first);
        END IF;
        -- once, under the wallet's lock
        IF EXISTS (SELECT 1 FROM canteen_transactions
                    WHERE camp_id = p_camp_id AND sig = 'refail:' || v_ref) THEN
            RETURN jsonb_build_object('success', true, 'alreadyRecorded', true, 'canteen', true);
        END IF;
        v_amt := round(COALESCE(v_tx.amount, NULLIF(v_tx.payload ->> 'amount', '')::numeric, 0), 2);
        IF v_amt <= 0 THEN
            RETURN jsonb_build_object('success', false, 'error', 'no_amount');
        END IF;
        v_bal := round(COALESCE(NULLIF(v_acct ->> 'balance', '')::numeric, 0) + v_amt, 2);
        PERFORM public.canteen_account_save(p_camp_id, v_key, v_acct || jsonb_build_object('balance', v_bal));
        PERFORM public.canteen_post(p_camp_id, v_key,
            jsonb_build_object(
                'time',   to_char(now_ts, 'HH12:MI AM'),
                'camper', v_key,
                'items',  'Refund failed at the card company — the money is back on the wallet',
                'amount', v_amt,
                'type',   'credit',
                'kind',   'refund_failed',
                'method', 'stripe',
                'date',   to_char(now_ts, 'YYYY-MM-DD'),
                'stripePaymentIntentId', v_tx.payload ->> 'stripePaymentIntentId',
                'failedRefundId', v_ref,
                'timestamp', (extract(epoch FROM now_ts) * 1000)::bigint)
            || CASE WHEN v_tx.payload ? 'camperId'
                    THEN jsonb_build_object('camperId', v_tx.payload -> 'camperId') ELSE '{}'::jsonb END,
            'refail:' || v_ref);
        -- The reservation this refund settled is open for a new refund again
        -- (TED-129): "posted" told the next Refund All the money was already
        -- sent, and it skipped the child. Released is the truth — the money is
        -- back on the wallet — and a reserve under the same key takes it afresh.
        UPDATE canteen_refund_holds SET state = 'released', settled_at = now_ts
         WHERE camp_id = p_camp_id AND refund_id = v_ref AND state = 'posted';
        v_who := COALESCE(NULLIF(v_acct ->> 'camperName', ''), regexp_replace(v_key, '\s#\d+$', ''));
        IF to_regclass('public.notifications') IS NOT NULL THEN
            INSERT INTO notifications (camp_id, source, source_id, title, body, link_target)
            VALUES (p_camp_id, 'refund_failed', v_ref,
                    'A canteen refund failed',
                    'Stripe could not send the $' || to_char(v_amt, 'FM999999990.00') || ' canteen refund for ' || v_who
                      || ' (' || v_ref || ')' || COALESCE(' — ' || v_why, '') || '. The parent did not get it. '
                      || 'The money is back on the child''s canteen wallet: refund it again (Snacks → Refund) or pay it out. '
                      || 'Stripe returned it to Campistry''s platform account; Campistry has been alerted to pass it back to yours.',
                    'campistry_snacks.html')
            ON CONFLICT (camp_id, source, source_id) DO NOTHING;
            GET DIAGNOSTICS v_n = ROW_COUNT;
            v_first := v_n > 0;
        END IF;
        RETURN jsonb_build_object('success', true, 'canteen', true, 'account', v_key,
                                  'amount', v_amt, 'balance', v_bal, 'firstNotice', v_first);
    END IF;

    -- ── a family refund: the ledger gets the money back ─────────────────────
    FOR famRec IN SELECT key, value FROM jsonb_each(public.camp_families_object(p_camp_id)) LOOP
        IF jsonb_typeof(famRec.value) <> 'object' OR jsonb_typeof(famRec.value -> 'entries') <> 'array' THEN CONTINUE; END IF;
        SELECT e INTO v_entry
          FROM jsonb_array_elements(famRec.value -> 'entries') e
         WHERE e ->> 'kind' = 'refund'
           AND (e ->> 'id' = 'le_pay_' || v_ref OR e -> 'source' ->> 'paymentId' = v_ref)
         LIMIT 1;
        IF v_entry IS NOT NULL THEN v_famKey := famRec.key; EXIT; END IF;
    END LOOP;

    IF v_famKey IS NULL THEN
        -- Not on these books: made in the Stripe dashboard, or its answer was
        -- lost (a canteen refund still waiting is settled by its look-up).
        -- Nothing to put back here — but the parent did not get it and the
        -- money is in Campistry's Stripe balance, so the office is told
        -- (TED-131), once.
        v_first := public._notice_unbooked_refund_failure(p_camp_id, v_ref, v_why, p_amount, p_payment_ref, p_hold_key);
        RETURN jsonb_build_object('success', false, 'error', 'refund_not_found', 'firstNotice', v_first);
    END IF;

    v_fam := public.camp_family_for_update(p_camp_id, v_famKey);
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(v_fam -> 'entries', '[]'::jsonb)) e
                WHERE e ->> 'id' = 'le_pay_refail_' || v_ref OR e -> 'source' ->> 'paymentId' = 'refail_' || v_ref) THEN
        RETURN jsonb_build_object('success', true, 'alreadyRecorded', true, 'familyKey', v_famKey);
    END IF;
    v_amt := round(COALESCE((v_entry ->> 'amount')::numeric, 0), 2);
    IF v_amt <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_amount');
    END IF;

    -- the payments list's row, and the ledger entry made from it — the same
    -- pair every payment writer posts, so sync_family_ledger_payments sees it
    -- as covered and never posts it twice
    v_row := jsonb_build_object(
        'id',        'refail_' || v_ref,
        'family',    COALESCE(v_fam ->> 'name', v_famKey),
        'familyKey', v_famKey,
        'amount',    v_amt,
        'date',      to_char(now_ts, 'YYYY-MM-DD'),
        'method',    'Refund failed',
        'reference', 'refail_' || v_ref,
        'failedRefundId', v_ref,
        'status',    'succeeded',
        'notes',     'Refund ' || v_ref || ' failed at Stripe' || COALESCE(' (' || v_why || ')', '')
                     || ' — the parent did not get it; the money is back on the account',
        'offline',   false,
        'timestamp', (extract(epoch FROM now_ts) * 1000)::bigint);
    v_rev := public.payment_ledger_entry(v_row)
             || jsonb_build_object('reason', 'refund_failed',
                                   'source', jsonb_build_object('paymentId', 'refail_' || v_ref, 'reverses', v_entry ->> 'id'));
    v_fam := jsonb_set(v_fam, '{entries}', COALESCE(v_fam -> 'entries', '[]'::jsonb) || jsonb_build_array(v_rev), true);
    PERFORM public.camp_family_save(p_camp_id, v_famKey, v_fam);
    PERFORM public.camp_payment_add(p_camp_id, v_row);

    IF to_regclass('public.notifications') IS NOT NULL THEN
        INSERT INTO notifications (camp_id, source, source_id, title, body, link_target)
        VALUES (p_camp_id, 'refund_failed', v_ref,
                'A refund failed',
                'Stripe could not send the $' || to_char(v_amt, 'FM999999990.00') || ' refund to '
                  || COALESCE(v_fam ->> 'name', v_famKey) || ' (' || v_ref || ')' || COALESCE(' — ' || v_why, '')
                  || '. The parent did not get it. It is back on the family''s account as a credit: refund it again from Billing, '
                  || 'or ask the family for other bank details. Stripe returned it to Campistry''s platform account; '
                  || 'Campistry has been alerted to pass it back to yours.',
                'campistry_me.html')
        ON CONFLICT (camp_id, source, source_id) DO NOTHING;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_first := v_n > 0;
    END IF;
    RETURN jsonb_build_object('success', true, 'family', true, 'familyKey', v_famKey, 'amount', v_amt,
                              'balance', public.family_ledger_balance(v_fam), 'firstNotice', v_first);
END $$;
REVOKE ALL ON FUNCTION public.reverse_failed_stripe_refund(uuid, text, text, numeric, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reverse_failed_stripe_refund(uuid, text, text, numeric, text, text) TO service_role;
