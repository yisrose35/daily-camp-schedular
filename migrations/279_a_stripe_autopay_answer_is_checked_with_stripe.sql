-- ============================================================================
-- Migration 279: "the autopay charge went through" is checked before it is
-- recorded.
--
-- Standalone. Paste into the Supabase SQL Editor and click Run. Safe to run
-- more than once. Run it BEFORE redeploying stripe-charge, and reload Me after.
--
-- ── THE PROBLEM (TED-120, what was left) ───────────────────────────────────
-- When an autopay charge was never answered (276), the office records it with
-- the processor's reference. 276 refused a Stripe charge id (ch_) and a
-- reference booked for a DIFFERENT AMOUNT — but on an autopay night many
-- families pay the same $500, so the Stripe payments list is full of rows that
-- look alike. Pasting Silver's pi_ for Gold credited Gold twice (the next
-- instalment said "nothing owed") and showed Silver's $500 twice in the
-- exports; a mistyped pi_ did the same once Gold's real payment arrived; and
-- if Gold's charge had really failed, Gold was marked paid for money never
-- collected.
--
-- ── THE CHANGE ─────────────────────────────────────────────────────────────
--   1. Any processor: a reference already booked for ANOTHER family — on the
--      payments list or on another family's ledger — is refused, whatever the
--      amount.
--   2. Stripe: "it went through" is no longer taken from the browser at all.
--      Billing sends it to stripe-charge (redeployed), which asks Stripe for
--      that payment and records it only if it succeeded, is this family's
--      customer, is for this instalment's amount, was made on or after the day
--      autopay tried, and (when it carries Campistry's stamp) is this camp's
--      and this family's. Only then does it call
--      resolve_unconfirmed_autopay_checked, which the server alone can call.
--   "Nothing went through" is unchanged, on every processor.
-- ============================================================================

DO $$
BEGIN
    IF to_regprocedure('public.resolve_unconfirmed_autopay(uuid,text,text,boolean,text)') IS NULL THEN
        RAISE EXCEPTION '279 needs migration 276 — apply it first';
    END IF;
END $$;

-- ── the work, behind both doors (no gate of its own: never granted) ──────────
CREATE OR REPLACE FUNCTION public._record_autopay_answer(
    p_camp_id      uuid,
    p_family_key   text,
    p_plan_ref     text,
    p_went_through boolean,
    p_reference    text,
    p_from_server  boolean)
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
    IF p_camp_id IS NULL OR COALESCE(p_family_key, '') = '' OR COALESCE(p_plan_ref, '') = '' OR p_went_through IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_arguments');
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
        -- Stripe: the payment's own id, and nothing else (TED-120).
        IF v_proc = 'stripe' AND v_ref !~ '^pi_[A-Za-z0-9]+$' THEN
            RETURN jsonb_build_object('success', false, 'error', 'stripe_needs_payment_id');
        END IF;
        -- Booked already for another family — any amount — or for this family
        -- at another amount: it is another payment.
        IF EXISTS (SELECT 1 FROM camp_payments p
                    WHERE p.camp_id = p_camp_id AND p.deleted_at IS NULL
                      AND (p.payload->>'stripePaymentIntentId' = v_ref OR p.payload->>'byopTransactionId' = v_ref
                           OR p.payload->>'reference' = v_ref)
                      AND (COALESCE(p.payload->>'familyKey', p.family_key, '') <> p_family_key
                           OR round(COALESCE((p.payload->>'amount')::numeric, 0), 2) <> v_amt))
           OR EXISTS (SELECT 1 FROM jsonb_each(public.camp_families_object(p_camp_id)) f,
                             jsonb_array_elements(CASE WHEN jsonb_typeof(f.value->'entries') = 'array'
                                                       THEN f.value->'entries' ELSE '[]'::jsonb END) e
                       WHERE f.key <> p_family_key
                         AND (e->>'id' = 'le_pay_' || v_ref OR e->'source'->>'paymentId' = v_ref)) THEN
            RETURN jsonb_build_object('success', false, 'error', 'reference_is_another_payment');
        END IF;
        -- Stripe's answer is checked with Stripe, by the server (stripe-charge).
        IF v_proc = 'stripe' AND NOT p_from_server THEN
            RETURN jsonb_build_object('success', false, 'error', 'stripe_check_needed');
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
REVOKE ALL ON FUNCTION public._record_autopay_answer(uuid, text, text, boolean, text, boolean) FROM public, anon, authenticated;


-- ── the office's door (Billing) ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.resolve_unconfirmed_autopay(
    p_camp_id      uuid,
    p_family_key   text,
    p_plan_ref     text,
    p_went_through boolean,
    p_reference    text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    -- A member of THIS camp first: the section resolver answers "edit" for a
    -- caller it cannot place at all (it leaves membership to its callers).
    IF NOT public.camp_staff_member(p_camp_id)
       OR COALESCE(public.user_section_level(p_camp_id, 'me.billing'), 'none') <> 'edit' THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;
    RETURN public._record_autopay_answer(p_camp_id, p_family_key, p_plan_ref, p_went_through, p_reference, false);
END $$;
REVOKE ALL ON FUNCTION public.resolve_unconfirmed_autopay(uuid, text, text, boolean, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.resolve_unconfirmed_autopay(uuid, text, text, boolean, text) TO authenticated, service_role;


-- ── the server's door: a Stripe payment stripe-charge has checked ───────────
CREATE OR REPLACE FUNCTION public.resolve_unconfirmed_autopay_checked(
    p_camp_id    uuid,
    p_family_key text,
    p_plan_ref   text,
    p_reference  text)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT public._record_autopay_answer(p_camp_id, p_family_key, p_plan_ref, true, p_reference, true);
$$;
REVOKE ALL ON FUNCTION public.resolve_unconfirmed_autopay_checked(uuid, text, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_unconfirmed_autopay_checked(uuid, text, text, text) TO service_role;
