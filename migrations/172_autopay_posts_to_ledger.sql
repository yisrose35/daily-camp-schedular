-- ============================================================================
-- Migration 172: autopay charges a DERIVED amount and posts it to the ledger.
--
-- 169 gave the nightly runner an atomic write for the old plan model: patch the
-- instalment's `status` and append the payment together. That model is what
-- migration 171 replaced, and the reason is worth restating because it is the
-- defect this whole sequence exists to kill.
--
-- The old plan stored a FROZEN array of dated instalments each with a mutable
-- `status`, and the runner reconciled it against a recomputed balance:
--
--     if (remainingBalance <= 0.005) { inst.status = 'paid'; }
--
-- which conflates "nothing is owed at this instant" with "this instalment is
-- settled for ever". A temporary zero balance destroyed an instalment
-- permanently and nothing ever reopened it — so a family parked for three
-- months of a six-month plan came back $1,500 short with a plan that read fully
-- paid (TEST_FINDINGS.md D1).
--
-- A plan now stores WHEN, never HOW MUCH:
--
--     { id, autopay, paused, dueDates[], count, nextIndex, history[] }
--
-- and the amount is worked out at charge time as
--
--     outstanding / instalments remaining
--
-- with the last one sweeping the remainder. There is no per-instalment status
-- field left to corrupt, which is the structural reason D1 cannot recur, and
-- `history` is append-only and records `charged: 0` WITH ITS REASON — so nothing
-- is ever recorded as paid that was not charged.
--
-- ── WHY THIS NEEDS ITS OWN FUNCTION ────────────────────────────────────────
-- Each charge still has to do two things together, just different two things
-- than before: post a PAYMENT ENTRY to the family's ledger, and append the
-- history row that advances the counter. Split them and a crash between leaves
-- either a charged card with no ledger entry (money vanished) or an advanced
-- counter with no payment (an instalment silently skipped). One function, one
-- row lock, both writes.
--
-- Idempotent on (planId, index): a re-run of a failed night records nothing
-- twice, and the dedupe key stops a second payment entry for one charge.
--
-- Supersedes record_autopay_installment (169) for camps on a posted ledger. 169
-- is deliberately left in place — it is still correct for a family that has not
-- been converted yet, and dropping it would break the runner mid-rollout.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.record_autopay_charge(
    p_camp_id     uuid,
    p_family_key  text,
    p_plan_id     text,
    p_index       integer,
    p_due_date    text,
    p_amount      numeric,
    p_reason      text    DEFAULT NULL,   -- set when nothing was charged
    p_payment     jsonb   DEFAULT NULL,   -- the finance.payments row, for Billing
    p_dedupe_key  text    DEFAULT NULL,
    p_entry_note  text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    now_ts    timestamptz := now();
    v_me      jsonb;
    v_fam     jsonb;
    v_plans   jsonb;
    v_plan    jsonb;
    v_pi      integer := NULL;
    v_hist    jsonb;
    v_entries jsonb;
    v_fin     jsonb;
    v_pays    jsonb;
    v_dup     boolean := false;
    v_entryId text;
    i         integer;
BEGIN
    IF p_camp_id IS NULL OR COALESCE(p_family_key, '') = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_arguments');
    END IF;

    SELECT value INTO v_me FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe'
     FOR UPDATE;
    IF v_me IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_camp_data');
    END IF;

    v_fam := v_me #> ARRAY['families', p_family_key];
    IF v_fam IS NULL OR jsonb_typeof(v_fam) <> 'object' THEN
        RETURN jsonb_build_object('success', false, 'error', 'family_not_found');
    END IF;

    -- Locate the plan by id. Not by position: the blob is re-read under this
    -- lock, so an index captured before it can point at a different plan.
    v_plans := CASE WHEN jsonb_typeof(v_fam->'plans') = 'array'
                    THEN v_fam->'plans' ELSE '[]'::jsonb END;
    FOR i IN 0 .. GREATEST(jsonb_array_length(v_plans) - 1, -1) LOOP
        IF v_plans->i->>'id' = p_plan_id THEN v_pi := i; EXIT; END IF;
    END LOOP;
    IF v_pi IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'plan_not_found');
    END IF;
    v_plan := v_plans->v_pi;

    -- Already recorded? Idempotent on the instalment INDEX, which is what makes
    -- re-running a failed night safe.
    v_hist := CASE WHEN jsonb_typeof(v_plan->'history') = 'array'
                   THEN v_plan->'history' ELSE '[]'::jsonb END;
    FOR i IN 0 .. GREATEST(jsonb_array_length(v_hist) - 1, -1) LOOP
        IF (v_hist->i->>'index')::integer = p_index THEN
            RETURN jsonb_build_object('success', true, 'alreadyRecorded', true,
                                      'index', p_index);
        END IF;
    END LOOP;

    -- ── the ledger entry, when money actually moved ──────────────────────
    v_entryId := NULL;
    IF COALESCE(p_amount, 0) > 0 THEN
        v_entries := CASE WHEN jsonb_typeof(v_fam->'entries') = 'array'
                          THEN v_fam->'entries' ELSE '[]'::jsonb END;

        -- The same charge twice must post one entry. A processor that retries
        -- would otherwise credit the family twice over.
        IF COALESCE(p_dedupe_key, '') <> '' THEN
            SELECT EXISTS (
                SELECT 1 FROM jsonb_array_elements(v_entries) e
                 WHERE e->'source'->>'paymentId' = p_dedupe_key
                    OR e->>'id' = p_dedupe_key
            ) INTO v_dup;
        END IF;

        IF NOT v_dup THEN
            v_entryId := 'le_ap_' || COALESCE(p_plan_id, 'plan') || '_' || p_index;
            v_entries := v_entries || jsonb_build_array(jsonb_build_object(
                'id', v_entryId,
                'kind', 'payment',
                'amount', ROUND(p_amount, 2),
                'reason', 'autopay',
                'date', COALESCE(p_due_date, to_char(now_ts, 'YYYY-MM-DD')),
                'postedAt', to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                'note', COALESCE(p_entry_note, 'Autopay instalment'),
                'by', 'system',
                'source', jsonb_build_object(
                    'planId', p_plan_id,
                    'instalment', p_index,
                    'paymentId', p_dedupe_key)
            ));
            v_fam := jsonb_set(v_fam, '{entries}', v_entries, true);
        END IF;
    END IF;

    -- ── the history row, and the counter ─────────────────────────────────
    -- Appended whatever happened, including charged: 0. This is what replaces
    -- "mark it paid": a record of the outcome, never a claim it was settled.
    v_hist := v_hist || jsonb_build_array(
        jsonb_strip_nulls(jsonb_build_object(
            'index', p_index,
            'dueDate', p_due_date,
            'charged', ROUND(COALESCE(p_amount, 0), 2),
            'at', to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'reason', p_reason,
            'entryId', v_entryId,
            'paymentId', p_dedupe_key
        )));
    v_plan := jsonb_set(v_plan, '{history}', v_hist, true);
    IF p_index >= COALESCE((v_plan->>'nextIndex')::integer, 0) THEN
        v_plan := jsonb_set(v_plan, '{nextIndex}', to_jsonb(p_index + 1), true);
    END IF;
    v_plans := jsonb_set(v_plans, ARRAY[v_pi::text], v_plan, true);
    v_fam := jsonb_set(v_fam, '{plans}', v_plans, true);

    -- ── the Billing-facing payment row ───────────────────────────────────
    -- finance.payments stays the camp's payment list (every processor webhook
    -- writes it and Billing's refund action reads it). The ledger is the
    -- balance; this is the receipt.
    IF p_payment IS NOT NULL AND jsonb_typeof(p_payment) = 'object'
       AND COALESCE(p_amount, 0) > 0 AND NOT v_dup THEN
        v_fin := COALESCE(v_me->'finance', '{}'::jsonb);
        IF jsonb_typeof(v_fin) <> 'object' THEN v_fin := '{}'::jsonb; END IF;
        v_pays := COALESCE(v_fin->'payments', '[]'::jsonb);
        IF jsonb_typeof(v_pays) <> 'array' THEN v_pays := '[]'::jsonb; END IF;
        v_fin := jsonb_set(v_fin, '{payments}',
                           v_pays || jsonb_build_array(p_payment), true);
        v_me := jsonb_set(v_me, '{finance}', v_fin, true);
    END IF;

    v_me := jsonb_set(v_me, ARRAY['families', p_family_key], v_fam, true);
    UPDATE camp_state_kv SET value = v_me, updated_at = now_ts
     WHERE camp_id = p_camp_id AND key = 'campistryMe';

    RETURN jsonb_build_object('success', true, 'index', p_index,
        'charged', ROUND(COALESCE(p_amount, 0), 2),
        'entryId', v_entryId, 'alreadyRecorded', false,
        'balance', public.family_ledger_balance(v_fam));
END;
$$;
REVOKE ALL ON FUNCTION public.record_autopay_charge(uuid, text, text, integer, text, numeric, text, jsonb, text, text)
    FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_autopay_charge(uuid, text, text, integer, text, numeric, text, jsonb, text, text)
    TO service_role;


-- ─── Reading a plan's next instalment, server-side ──────────────────────────
-- The same arithmetic as BillingCore.planDue, so the runner does not have to
-- reimplement it and cannot disagree with the browser about what is due.
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

    -- Nothing owed: due nothing, and — crucially — destroy nothing. The old
    -- model wrote status:'paid' here and that is the bug.
    IF v_bal <= 0.005 THEN
        RETURN jsonb_build_object('index', v_i, 'dueDate', v_due,
                                  'amount', 0, 'remaining', v_rem,
                                  'reason', 'nothing_owed');
    END IF;

    -- The last instalment sweeps the remainder, so rounding cannot leave cents
    -- uncollectable at the end of every plan.
    v_amt := CASE WHEN v_rem <= 1 THEN v_bal ELSE ROUND(v_bal / v_rem, 2) END;
    IF v_amt > v_bal THEN v_amt := v_bal; END IF;

    RETURN jsonb_build_object('index', v_i, 'dueDate', v_due,
                              'amount', v_amt, 'remaining', v_rem);
END;
$$;
REVOKE ALL ON FUNCTION public.plan_due(jsonb, jsonb, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.plan_due(jsonb, jsonb, text) TO authenticated, service_role;


-- The version the nightly runner calls. It reads the CURRENT blob rather than
-- being handed one, which matters: the runner reads every camp up front and
-- then charges cards for the length of the run, so anything it captured at the
-- start is stale by the time it gets here. Asking the database for the amount
-- immediately before charging the card keeps the window as small as it can be.
--
-- It cannot be zero. A parent who pays between this call and the charge landing
-- will leave a small credit on the account — visible, refundable, and the
-- correct outcome. The alternative, clamping the RECORDED amount to the balance
-- after the fact, would make the ledger disagree with the processor about what
-- was actually taken, which is worse than a credit.
CREATE OR REPLACE FUNCTION public.plan_due_for(
    p_camp_id    uuid,
    p_family_key text,
    p_plan_id    text,
    p_as_of      text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_me   jsonb;
    v_fam  jsonb;
    v_plan jsonb;
    i      integer;
BEGIN
    SELECT value INTO v_me FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe';
    IF v_me IS NULL THEN RETURN NULL; END IF;

    v_fam := v_me #> ARRAY['families', p_family_key];
    IF v_fam IS NULL OR jsonb_typeof(v_fam) <> 'object' THEN RETURN NULL; END IF;

    FOR i IN 0 .. GREATEST(jsonb_array_length(
                 CASE WHEN jsonb_typeof(v_fam->'plans') = 'array'
                      THEN v_fam->'plans' ELSE '[]'::jsonb END) - 1, -1) LOOP
        IF v_fam->'plans'->i->>'id' = p_plan_id THEN
            v_plan := v_fam->'plans'->i;
            EXIT;
        END IF;
    END LOOP;
    IF v_plan IS NULL THEN RETURN NULL; END IF;

    RETURN public.plan_due(v_fam, v_plan, p_as_of);
END;
$$;
REVOKE ALL ON FUNCTION public.plan_due_for(uuid, text, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.plan_due_for(uuid, text, text, text) TO service_role;


-- ─── Checking it ───────────────────────────────────────────────────────────
-- Re-running one night must change nothing the second time:
--   select record_autopay_charge('<camp>'::uuid, '<famKey>', '<planId>', 0,
--       '2026-07-01', 500, null, '{"id":"auto_1","amount":500}'::jsonb, 'auto_1');
--   -- first:  alreadyRecorded false, balance down by 500
--   -- second: alreadyRecorded true,  balance unchanged
--
-- And the amount must track the balance rather than a frozen number:
--   select plan_due(value #> '{families,<famKey>}',
--                   value #> '{families,<famKey>,plans,0}', '2026-08-01')
--     from camp_state_kv where camp_id='<camp>'::uuid and key='campistryMe';
--   -- pay something extra by hand, run it again: the amount SHRINKS.
-- ============================================================================
