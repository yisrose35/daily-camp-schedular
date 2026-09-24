-- ============================================================================
-- Migration 264: a payment plan charges the amounts the office set.
--
-- Standalone. Paste into the Supabase SQL Editor and click Run. Safe to run
-- more than once.
--
-- ── THE PROBLEM (TED-068) ──────────────────────────────────────────────────
-- A ledger plan (172/181) stores only dates; each instalment is worked out at
-- charge time as "what is still owed / instalments left". The office's plan
-- editor asks for an amount per payment — $1,000 then $200 and $200, or $600
-- of a $1,400 balance — and those amounts were thrown away: autopay charged
-- $466.67 three times, or $700 + $700.
--
-- ── THE CHANGE ─────────────────────────────────────────────────────────────
-- A plan may carry `amounts`, one per due date. When the instalment being
-- charged has one, that is what is charged — never more than is still owed.
-- A plan without amounts (every plan a parent builds) is worked out exactly as
-- before. 172's plan_due with that one branch added; the rest is unchanged.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.plan_due(p_fam jsonb, p_plan jsonb, p_as_of text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_dates jsonb;
    v_i     integer;
    v_due   text;
    v_bal   numeric;
    v_rem   integer;
    v_amt   numeric;
    v_fixed numeric;
BEGIN
    IF p_plan IS NULL OR jsonb_typeof(p_plan) <> 'object' THEN RETURN NULL; END IF;
    IF COALESCE((p_plan->>'paused')::boolean, false) THEN RETURN NULL; END IF;
    IF NOT COALESCE((p_plan->>'autopay')::boolean, true) THEN RETURN NULL; END IF;

    v_dates := CASE WHEN jsonb_typeof(p_plan->'dueDates') = 'array'
                    THEN p_plan->'dueDates' ELSE '[]'::jsonb END;
    v_i := COALESCE((p_plan->>'nextIndex')::integer, 0);
    IF v_i >= jsonb_array_length(v_dates) THEN RETURN NULL; END IF;

    v_due := v_dates->>v_i;
    IF v_due IS NULL OR (p_as_of IS NOT NULL AND v_due > p_as_of) THEN RETURN NULL; END IF;

    v_bal := public.family_ledger_balance(p_fam);
    v_rem := jsonb_array_length(v_dates) - v_i;

    -- Nothing owed: due nothing, and — crucially — destroy nothing.
    IF v_bal <= 0.005 THEN
        RETURN jsonb_build_object('index', v_i, 'dueDate', v_due,
                                  'amount', 0, 'remaining', v_rem,
                                  'reason', 'nothing_owed');
    END IF;

    -- The amount the office set for this instalment, when it set one (TED-068).
    IF jsonb_typeof(p_plan->'amounts') = 'array'
       AND jsonb_typeof(p_plan->'amounts'->v_i) = 'number' THEN
        v_fixed := (p_plan->'amounts'->>v_i)::numeric;
    END IF;

    IF v_fixed IS NOT NULL AND v_fixed > 0 THEN
        v_amt := LEAST(ROUND(v_fixed, 2), v_bal);
    ELSE
        -- The last instalment sweeps the remainder, so rounding cannot leave
        -- cents uncollectable at the end of every plan.
        v_amt := CASE WHEN v_rem <= 1 THEN v_bal ELSE ROUND(v_bal / v_rem, 2) END;
        IF v_amt > v_bal THEN v_amt := v_bal; END IF;
    END IF;

    RETURN jsonb_build_object('index', v_i, 'dueDate', v_due,
                              'amount', v_amt, 'remaining', v_rem);
END;
$$;
REVOKE ALL ON FUNCTION public.plan_due(jsonb, jsonb, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.plan_due(jsonb, jsonb, text) TO authenticated, service_role;
