-- ============================================================================
-- Migration 281: a refund that fails later takes its card-surcharge share back
-- off the family's bill; and the platform's failed-refund email is sent again
-- when it did not go.
--
-- Standalone. Paste into the Supabase SQL Editor and click Run. Safe to run
-- more than once. Run it BEFORE deploying stripe-webhook and reloading Me.
--
-- ── THE PROBLEMS ───────────────────────────────────────────────────────────
-- TED-148. Slate paid $1,030 ($1,000 + a $30 card surcharge). The office
-- refunded $1,000, and Billing took $29.13 of the surcharge off Slate's bill
-- (the card brands' rule: the fee goes back in proportion). Three days later
-- Stripe failed the refund and 278 put the $1,000 back — but the $29.13 stayed
-- credited, so Slate showed $29.13 in credit for a refund that never reached
-- the card.
--
-- TED-150. The platform is emailed once per failed refund (TED-137), and the
-- "once" was claimed BEFORE the email was sent. One email-service hiccup and
-- the alert was never sent: every later delivery of the same failure found it
-- already claimed.
--
-- ── THE CHANGES ────────────────────────────────────────────────────────────
-- undo_card_fee_return(camp, family, refund): Billing now tags each surcharge
-- credit with the refund it went with (refundId). When that refund fails, this
-- puts a charge of the same amount back on the bill ("Card surcharge back on
-- the bill — the refund it went with failed"), on the family's charges and its
-- ledger, once per credit. stripe-webhook calls it right after 278's put-back.
-- Likewise the "not paying by card" discount Billing took back with a refund
-- (TED-160) is given back to the family as a credit when that refund fails.
--
-- release_refund_failure_alert(refund): gives back the once-only claim when
-- the email did not send, so the next delivery of the failure sends it.
--
-- Both are for the webhook only (service role).
-- ============================================================================

DO $$
BEGIN
    IF to_regprocedure('public.camp_family_for_update(uuid,text)') IS NULL
       OR to_regprocedure('public.camp_family_save(uuid,text,jsonb)') IS NULL
       OR to_regprocedure('public._sync_charge_to_ledger(jsonb,text)') IS NULL
       OR to_regclass('public.refund_failure_alerts') IS NULL THEN
        RAISE EXCEPTION '281 needs migrations 213, 263 and 278 — apply those first';
    END IF;
END $$;

CREATE OR REPLACE FUNCTION public.undo_card_fee_return(
    p_camp_id    uuid,
    p_family_key text,
    p_refund_id  text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_ref    text := NULLIF(btrim(COALESCE(p_refund_id, '')), '');
    v_fam    jsonb;
    v_chg    jsonb;
    c        jsonb;
    v_id     text;
    v_amt    numeric;
    v_total  numeric := 0;
    v_back   numeric := 0;
    v_cr     jsonb;
    v_n      integer := 0;
    now_ts   timestamptz := now();
BEGIN
    IF p_camp_id IS NULL OR NULLIF(btrim(COALESCE(p_family_key, '')), '') IS NULL OR v_ref IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_argument');
    END IF;
    v_fam := public.camp_family_for_update(p_camp_id, p_family_key);
    IF v_fam IS NULL OR jsonb_typeof(v_fam) <> 'object' THEN
        RETURN jsonb_build_object('success', false, 'error', 'family_not_found');
    END IF;
    FOR c IN SELECT * FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_fam -> 'credits') = 'array'
                                                     THEN v_fam -> 'credits' ELSE '[]'::jsonb END) LOOP
        IF jsonb_typeof(c) <> 'object'
           OR COALESCE(c ->> 'cardFeeReturn', '') <> 'true'
           OR c ->> 'refundId' IS DISTINCT FROM v_ref THEN
            CONTINUE;
        END IF;
        v_id := 'cfr_undo_' || COALESCE(c ->> 'id', v_ref);
        v_chg := CASE WHEN jsonb_typeof(v_fam -> 'charges') = 'array' THEN v_fam -> 'charges' ELSE '[]'::jsonb END;
        -- once per credit, however many times Stripe sends the failure
        IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_chg) x WHERE x ->> 'id' = v_id) THEN CONTINUE; END IF;
        v_amt := round(COALESCE(NULLIF(c ->> 'amount', '')::numeric, 0), 2);
        IF v_amt <= 0 THEN CONTINUE; END IF;
        v_fam := jsonb_set(v_fam, '{charges}', v_chg || jsonb_build_array(jsonb_build_object(
            'id',          v_id,
            'category',    'Card Fee',
            'description', 'Card surcharge back on the bill — the refund it went with (' || v_ref || ') failed, so the family kept the payment',
            'amount',      v_amt,
            'date',        to_char(now_ts, 'YYYY-MM-DD'),
            'timestamp',   (extract(epoch FROM now_ts) * 1000)::bigint,
            'cardFeeUndo', true,
            'refundId',    v_ref,
            'creditId',    c ->> 'id')), true);
        -- the ledger, the way Billing posts any charge (263): le_chg_<id>
        v_fam := public._sync_charge_to_ledger(v_fam, v_id);
        v_total := v_total + v_amt;
        v_n := v_n + 1;
    END LOOP;

    -- The "not paying by card" discount Billing took back with this refund
    -- (TED-160) goes back to the family too: the refund never happened. A
    -- credit, on the family's credits and its ledger, once per charge.
    FOR c IN SELECT * FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_fam -> 'charges') = 'array'
                                                     THEN v_fam -> 'charges' ELSE '[]'::jsonb END) LOOP
        IF jsonb_typeof(c) <> 'object'
           OR COALESCE(c ->> 'cashDiscountBack', '') <> 'true'
           OR c ->> 'refundId' IS DISTINCT FROM v_ref THEN
            CONTINUE;
        END IF;
        v_id := 'cdback_undo_' || COALESCE(c ->> 'id', v_ref);
        v_cr := CASE WHEN jsonb_typeof(v_fam -> 'credits') = 'array' THEN v_fam -> 'credits' ELSE '[]'::jsonb END;
        IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_cr) x WHERE x ->> 'id' = v_id) THEN CONTINUE; END IF;
        v_amt := round(COALESCE(NULLIF(c ->> 'amount', '')::numeric, 0), 2);
        IF v_amt <= 0 THEN CONTINUE; END IF;
        v_fam := jsonb_set(v_fam, '{credits}', v_cr || jsonb_build_array(jsonb_build_object(
            'id',       v_id,
            'amount',   v_amt,
            'reason',   'reversal',
            'note',     'Discount for not paying by card given back — the refund it went with (' || v_ref || ') failed',
            'date',     to_char(now_ts, 'YYYY-MM-DD'),
            'timestamp', (extract(epoch FROM now_ts) * 1000)::bigint,
            'cashDiscountUndo', true,
            'refundId', v_ref,
            'chargeId', c ->> 'id')), true);
        -- on the ledger the way Billing posts a credit (le_<credit id>), when
        -- the family has one
        IF jsonb_typeof(v_fam -> 'entries') = 'array' AND jsonb_array_length(v_fam -> 'entries') > 0
           AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_fam -> 'entries') e WHERE e ->> 'id' = 'le_' || v_id) THEN
            v_fam := jsonb_set(v_fam, '{entries}', (v_fam -> 'entries') || jsonb_build_array(jsonb_build_object(
                'id',       'le_' || v_id,
                'kind',     'credit',
                'amount',   v_amt,
                'reason',   'reversal',
                'date',     to_char(now_ts, 'YYYY-MM-DD'),
                'postedAt', to_char(now_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                'note',     'Discount given back — the refund it went with failed',
                'by',       'system',
                'source',   jsonb_build_object('creditId', v_id))), true);
        END IF;
        v_back := v_back + v_amt;
        v_n := v_n + 1;
    END LOOP;

    IF v_n > 0 THEN
        PERFORM public.camp_family_save(p_camp_id, p_family_key, v_fam);
    END IF;
    RETURN jsonb_build_object('success', true, 'undone', v_n, 'amount', v_total, 'discountBack', v_back);
END $$;
REVOKE ALL ON FUNCTION public.undo_card_fee_return(uuid, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.undo_card_fee_return(uuid, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.release_refund_failure_alert(p_refund_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE v_n integer := 0;
BEGIN
    DELETE FROM refund_failure_alerts WHERE refund_id = p_refund_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n > 0;
END $$;
REVOKE ALL ON FUNCTION public.release_refund_failure_alert(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_refund_failure_alert(text) TO service_role;
