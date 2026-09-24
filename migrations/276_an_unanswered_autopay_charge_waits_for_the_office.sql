-- ============================================================================
-- Migration 276: an autopay charge the card company never answered waits for
-- the office.
--
-- Standalone. Paste into the Supabase SQL Editor and click Run. Safe to run
-- more than once. Run it BEFORE redeploying charge-due-installments.
--
-- ── THE PROBLEM (TED-113) ──────────────────────────────────────────────────
-- One card-company call that dropped during the nightly autopay run stopped the
-- whole run: every family after it, at every camp, was charged a night late.
-- The dropped family's charge was never recorded, so on Cardknox/Banquest the
-- next night charged them again; a Banquest gateway timeout was booked as a
-- decline.
--
-- ── THE CHANGE ─────────────────────────────────────────────────────────────
-- The runner (redeployed) now holds such a charge ON THE PLAN — the same
-- pendingCharge slot a clearing bank debit uses (269), marked `unconfirmed` —
-- and tells the office in Billing. Nothing more is charged on that plan until
-- the office answers, which is this function:
--
--   went through      the instalment is recorded as paid, with the processor's
--                     reference, exactly as the runner would have recorded it;
--   did not go through the hold is cleared, and autopay tries again on its
--                     next run.
--
-- Only a member of the camp who can edit Billing can answer (the same rule as
-- recording a payment by hand, with 277's membership check).
-- ============================================================================

DO $$
BEGIN
    IF to_regprocedure('public.hold_autopay_charge(uuid,text,text,jsonb)') IS NULL
       OR to_regprocedure('public._plan_path(jsonb,text)') IS NULL
       OR to_regprocedure('public.record_autopay_charge(uuid,text,text,integer,text,numeric,text,jsonb,text,text)') IS NULL
       OR to_regprocedure('public.record_autopay_installment(uuid,text,text,integer,text,jsonb,jsonb,text)') IS NULL
       OR to_regprocedure('public.user_section_level(uuid,text)') IS NULL
       OR to_regprocedure('public.camp_staff_member(uuid)') IS NULL THEN
        RAISE EXCEPTION '276 needs migrations 183, 215, 233 and 269 (and the access resolver) — apply those first';
    END IF;
END $$;

CREATE OR REPLACE FUNCTION public.resolve_unconfirmed_autopay(
    p_camp_id      uuid,
    p_family_key   text,
    p_plan_ref     text,          -- the plan's id, or '#<position>' (269)
    p_went_through boolean,
    p_reference    text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_fam   jsonb;
    v_path  text[];
    v_plan  jsonb;
    v_hold  jsonb;
    v_ref   text := NULLIF(btrim(COALESCE(p_reference, '')), '');
    v_proc  text;
    v_amt   numeric;
    v_pay   jsonb;
    v_note  text := 'Autopay instalment — confirmed by the office (the card company never answered)';
    r       jsonb;
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF p_camp_id IS NULL OR COALESCE(p_family_key, '') = '' OR COALESCE(p_plan_ref, '') = '' OR p_went_through IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_arguments');
    END IF;
    -- A member of THIS camp first: the section resolver answers "edit" for a
    -- caller it cannot place at all (it leaves membership to its callers).
    IF NOT public.camp_staff_member(p_camp_id)
       OR COALESCE(public.user_section_level(p_camp_id, 'me.billing'), 'none') <> 'edit' THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    v_fam := public.camp_family_for_update(p_camp_id, p_family_key);
    IF v_fam IS NULL OR jsonb_typeof(v_fam) <> 'object' THEN
        RETURN jsonb_build_object('success', false, 'error', 'family_not_found');
    END IF;
    v_path := public._plan_path(v_fam, p_plan_ref);
    IF v_path IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'plan_not_found');
    END IF;
    v_plan := v_fam #> v_path;
    v_hold := v_plan -> 'pendingCharge';
    IF v_hold IS NULL OR jsonb_typeof(v_hold) <> 'object' OR COALESCE((v_hold->>'unconfirmed')::boolean, false) IS NOT TRUE THEN
        RETURN jsonb_build_object('success', false, 'error', 'nothing_to_answer');
    END IF;

    IF p_went_through THEN
        IF v_ref IS NULL THEN
            RETURN jsonb_build_object('success', false, 'error', 'reference_required');
        END IF;
        v_proc := COALESCE(v_hold->>'processor', '');
        v_amt  := round(COALESCE((v_hold->>'amount')::numeric, 0), 2);
        IF v_amt <= 0 THEN
            RETURN jsonb_build_object('success', false, 'error', 'no_amount');
        END IF;
        -- Stripe: the payment's own id, and nothing else (TED-120). It is what
        -- the webhook books the same money under, so the two meet as one
        -- payment; a charge id (ch_…) or anything else would be counted twice.
        IF v_proc = 'stripe' AND v_ref !~ '^pi_[A-Za-z0-9]+$' THEN
            RETURN jsonb_build_object('success', false, 'error', 'stripe_needs_payment_id');
        END IF;
        -- A reference already booked for a DIFFERENT amount is another payment.
        IF EXISTS (SELECT 1 FROM camp_payments p
                    WHERE p.camp_id = p_camp_id AND p.deleted_at IS NULL
                      AND (p.payload->>'stripePaymentIntentId' = v_ref OR p.payload->>'byopTransactionId' = v_ref
                           OR p.payload->>'reference' = v_ref)
                      AND round(COALESCE((p.payload->>'amount')::numeric, 0), 2) <> v_amt) THEN
            RETURN jsonb_build_object('success', false, 'error', 'reference_is_another_payment');
        END IF;
        v_pay := jsonb_build_object(
            'id', CASE WHEN v_proc = 'stripe' THEN 'auto_' ELSE 'auto_byop_' END || v_ref,
            'familyKey', p_family_key, 'amount', v_amt,
            'date', COALESCE(v_hold->>'since', to_char(now(), 'YYYY-MM-DD')),
            'method', 'Autopay (card)', 'reference', v_ref, 'notes', v_note,
            'status', 'succeeded', 'timestamp', (extract(epoch FROM now()) * 1000)::bigint)
          || CASE WHEN v_proc = 'stripe'
                  THEN jsonb_build_object('stripePaymentIntentId', v_ref)
                  ELSE jsonb_build_object('byopTransactionId', v_ref, 'byopProcessor', v_proc) END;

        IF jsonb_typeof(v_plan->'dueDates') = 'array' AND (v_hold->>'index') IS NOT NULL THEN
            r := public.record_autopay_charge(p_camp_id, p_family_key,
                    COALESCE(NULLIF(v_hold->>'planId', ''), v_plan->>'id'),
                    (v_hold->>'index')::integer, v_hold->>'dueDate', v_amt,
                    NULL, v_pay, v_ref, v_note);
        ELSIF jsonb_typeof(v_plan->'installments') = 'array' THEN
            r := public.record_autopay_installment(p_camp_id, p_family_key,
                    NULLIF(COALESCE(NULLIF(v_hold->>'planId', ''), v_plan->>'id'), ''),
                    (v_hold->>'planIndex')::integer, v_hold->>'dueDate',
                    jsonb_build_object('status', 'paid', 'paidDate', COALESCE(v_hold->>'since', to_char(now(), 'YYYY-MM-DD')))
                      || CASE WHEN v_proc = 'stripe' THEN jsonb_build_object('stripePaymentIntentId', v_ref)
                              ELSE jsonb_build_object('byopTransactionId', v_ref) END,
                    v_pay, v_ref);
        ELSE
            RETURN jsonb_build_object('success', false, 'error', 'plan_shape_unknown');
        END IF;
        IF r IS NULL OR COALESCE((r->>'success')::boolean, false) IS NOT TRUE THEN
            RETURN jsonb_build_object('success', false, 'error', COALESCE(r->>'error', 'not_recorded'));
        END IF;
    END IF;

    -- Either way the question is answered: the hold goes.
    r := public.hold_autopay_charge(p_camp_id, p_family_key, p_plan_ref, NULL);
    IF COALESCE((r->>'success')::boolean, false) IS NOT TRUE THEN
        RETURN jsonb_build_object('success', false, 'error', COALESCE(r->>'error', 'hold_not_cleared'));
    END IF;
    RETURN jsonb_build_object('success', true, 'recorded', p_went_through);
END $$;
REVOKE ALL ON FUNCTION public.resolve_unconfirmed_autopay(uuid, text, text, boolean, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.resolve_unconfirmed_autopay(uuid, text, text, boolean, text) TO authenticated, service_role;
