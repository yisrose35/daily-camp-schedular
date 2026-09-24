-- ============================================================================
-- Migration 262: autopay waits for a bank debit instead of starting another.
--
-- Standalone. Paste into the Supabase SQL Editor and click Run. Safe to run
-- more than once.
--
-- ── THE PROBLEM (TED-064) ──────────────────────────────────────────────────
-- A bank-account (ACH) debit takes days to clear. Stripe answers the nightly
-- autopay charge with status "processing", and charge-due-installments
-- deliberately recorded nothing — so the next night the same instalment still
-- looked unpaid and was debited AGAIN, every night until the first cleared. A
-- $500 instalment became three or four $500 debits.
--
-- ── THE CHANGE ─────────────────────────────────────────────────────────────
-- The runner now writes the debit onto the plan as `pendingCharge`
-- ({paymentIntentId, index, dueDate, amount, since}) the moment Stripe says
-- "processing". While it is there, the runner does not charge that plan: each
-- night it asks Stripe how that one debit is doing — succeeded: record it as
-- the instalment it was for; failed: the normal decline path; still
-- processing: wait. This function is the only writer of that field.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.hold_autopay_charge(
    p_camp_id    uuid,
    p_family_key text,
    p_plan_id    text,
    p_hold       jsonb        -- NULL clears the hold
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_fam   jsonb;
    v_plans jsonb;
    v_pi    integer := NULL;
    i       integer;
BEGIN
    IF p_camp_id IS NULL OR COALESCE(p_family_key, '') = '' OR COALESCE(p_plan_id, '') = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_arguments');
    END IF;
    v_fam := public.camp_family_for_update(p_camp_id, p_family_key);
    IF v_fam IS NULL OR jsonb_typeof(v_fam) <> 'object' THEN
        RETURN jsonb_build_object('success', false, 'error', 'family_not_found');
    END IF;
    v_plans := CASE WHEN jsonb_typeof(v_fam->'plans') = 'array' THEN v_fam->'plans' ELSE '[]'::jsonb END;
    FOR i IN 0 .. GREATEST(jsonb_array_length(v_plans) - 1, -1) LOOP
        IF v_plans->i->>'id' = p_plan_id THEN v_pi := i; EXIT; END IF;
    END LOOP;
    IF v_pi IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'plan_not_found');
    END IF;

    IF p_hold IS NULL OR jsonb_typeof(p_hold) <> 'object' THEN
        v_plans := jsonb_set(v_plans, ARRAY[v_pi::text], (v_plans->v_pi) - 'pendingCharge', true);
    ELSE
        v_plans := jsonb_set(v_plans, ARRAY[v_pi::text, 'pendingCharge'], p_hold, true);
    END IF;
    v_fam := jsonb_set(v_fam, '{plans}', v_plans, true);
    PERFORM public.camp_family_save(p_camp_id, p_family_key, v_fam);
    RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public.hold_autopay_charge(uuid, text, text, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hold_autopay_charge(uuid, text, text, jsonb) TO service_role;
