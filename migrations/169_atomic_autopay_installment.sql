-- ============================================================================
-- Migration 169: close the widest lost-update window in the app.
--
-- charge-due-installments is the nightly autopay runner, and its write pattern
-- was the worst of the seven:
--
--     SELECT camp_id, value ... WHERE key='campistryMe'   -- EVERY camp, once
--     ...charge cards for the whole run, mutating `me` in memory...
--     UPSERT value = me                                   -- per camp, at the end
--
-- The other six hold a stale blob for a few milliseconds. This one holds it for
-- the length of the run — every card charge, every network round trip, for
-- every family in the camp. Anything that writes campistryMe during that window
-- is discarded by the final upsert: a parent paying online, a card webhook, the
-- office recording a cheque. And in the other direction, if the office saves
-- while the run is in flight, the run's OWN charges are lost — cards charged,
-- no record.
--
-- 168's append_camp_payment is not enough on its own here, because each charge
-- has to do TWO things together: append the payment AND mark the installment
-- paid. Doing those as two calls would leave a window where a family is charged
-- and the installment still reads 'pending', so the next night charges it
-- again. One function, one lock, both writes.
--
-- ── IDENTIFYING THE INSTALLMENT ────────────────────────────────────────────
-- Not by array index. The function re-reads the blob under its own lock, so an
-- index captured before the lock can point at a different installment by the
-- time it is used. It matches on the plan (by id, else by position) and then
-- the installment's dueDate, and only ever patches one that is still 'pending'.
--
-- That last condition is what makes a retried run safe: once an installment is
-- 'paid', a second attempt matches nothing and changes nothing, and the payment
-- dedupe in the same call stops a second payment row. A failed run can be
-- re-run without charging anyone twice.
--
-- Idempotent.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.record_autopay_installment(
    p_camp_id     uuid,
    p_family_key  text,
    p_plan_id     text,
    p_plan_index  integer,
    p_due_date    text,
    p_patch       jsonb,
    p_payment     jsonb DEFAULT NULL,
    p_dedupe_key  text  DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    now_ts     timestamptz := now();
    v_me       jsonb;
    v_fam      jsonb;
    v_plans    jsonb;
    v_legacy   boolean := false;
    v_pi       integer := NULL;
    v_plan     jsonb;
    v_insts    jsonb;
    v_ii       integer := NULL;
    i          integer;
    v_fin      jsonb;
    v_pays     jsonb;
    v_dup      boolean := false;
    v_patched  boolean := false;
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

    -- A family can have MULTIPLE plans (migration 116); a pre-116 family has a
    -- single `plan` object instead. Normalise, remembering which shape it is so
    -- the write goes back to the right place.
    IF jsonb_typeof(v_fam->'plans') = 'array' THEN
        v_plans := v_fam->'plans';
    ELSIF jsonb_typeof(v_fam->'plan') = 'object'
          AND jsonb_typeof(v_fam->'plan'->'installments') = 'array' THEN
        v_plans := jsonb_build_array(v_fam->'plan');
        v_legacy := true;
    ELSE
        RETURN jsonb_build_object('success', false, 'error', 'no_plans');
    END IF;

    -- Locate the plan: by id when it has one, else by the position the caller
    -- saw. Re-resolved here rather than trusted, because the blob may have
    -- changed between the caller's read and this lock.
    IF COALESCE(p_plan_id, '') <> '' THEN
        FOR i IN 0 .. jsonb_array_length(v_plans) - 1 LOOP
            IF v_plans->i->>'id' = p_plan_id THEN v_pi := i; EXIT; END IF;
        END LOOP;
    END IF;
    IF v_pi IS NULL AND p_plan_index IS NOT NULL
       AND p_plan_index >= 0 AND p_plan_index < jsonb_array_length(v_plans) THEN
        v_pi := p_plan_index;
    END IF;
    IF v_pi IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'plan_not_found');
    END IF;

    v_plan  := v_plans->v_pi;
    v_insts := COALESCE(v_plan->'installments', '[]'::jsonb);

    -- The first installment on that due date that is STILL PENDING. Once it is
    -- paid, a re-run matches nothing — which is what makes re-running a failed
    -- run safe instead of charging the family a second time.
    FOR i IN 0 .. jsonb_array_length(v_insts) - 1 LOOP
        IF v_insts->i->>'dueDate' = p_due_date
           AND COALESCE(v_insts->i->>'status', 'pending') = 'pending' THEN
            v_ii := i; EXIT;
        END IF;
    END LOOP;

    IF v_ii IS NOT NULL AND p_patch IS NOT NULL AND jsonb_typeof(p_patch) = 'object' THEN
        v_insts := jsonb_set(v_insts, ARRAY[v_ii::text], (v_insts->v_ii) || p_patch, true);
        v_plan  := jsonb_set(v_plan, '{installments}', v_insts, true);
        IF v_legacy THEN
            v_me := jsonb_set(v_me, ARRAY['families', p_family_key, 'plan'], v_plan, true);
        ELSE
            v_me := jsonb_set(v_me, ARRAY['families', p_family_key, 'plans', v_pi::text], v_plan, true);
        END IF;
        v_patched := true;
    END IF;

    -- The payment, in the SAME transaction as the installment patch. Two calls
    -- would leave a window where the card is charged and the installment still
    -- reads 'pending', and the next night would charge it again.
    IF p_payment IS NOT NULL AND jsonb_typeof(p_payment) = 'object' THEN
        v_fin  := COALESCE(v_me->'finance', '{}'::jsonb);
        IF jsonb_typeof(v_fin) <> 'object' THEN v_fin := '{}'::jsonb; END IF;
        v_pays := COALESCE(v_fin->'payments', '[]'::jsonb);
        IF jsonb_typeof(v_pays) <> 'array' THEN v_pays := '[]'::jsonb; END IF;

        IF COALESCE(p_dedupe_key, '') <> '' THEN
            SELECT EXISTS (
                SELECT 1 FROM jsonb_array_elements(v_pays) p
                 WHERE p->>'id' = p_dedupe_key
                    OR p->>'reference' = p_dedupe_key
                    OR p->>'byopTransactionId' = p_dedupe_key
                    OR p->>'stripePaymentIntentId' = p_dedupe_key
            ) INTO v_dup;
        END IF;

        IF NOT v_dup THEN
            v_fin := jsonb_set(v_fin, '{payments}', v_pays || jsonb_build_array(p_payment), true);
            v_me  := jsonb_set(v_me, '{finance}', v_fin, true);
        END IF;
    END IF;

    UPDATE camp_state_kv SET value = v_me, updated_at = now_ts
     WHERE camp_id = p_camp_id AND key = 'campistryMe';

    RETURN jsonb_build_object('success', true,
        'patched', v_patched, 'alreadyRecorded', v_dup,
        'planIndex', v_pi, 'installmentIndex', v_ii);
END;
$$;
REVOKE ALL ON FUNCTION public.record_autopay_installment(uuid, text, text, integer, text, jsonb, jsonb, text)
    FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_autopay_installment(uuid, text, text, integer, text, jsonb, jsonb, text)
    TO service_role;

-- ─── Checking it ───────────────────────────────────────────────────────────
-- Re-running the same charge must change nothing the second time:
--   select record_autopay_installment('<camp>'::uuid, '<famKey>', '<planId>', 0,
--       '2026-07-01', '{"status":"paid"}'::jsonb,
--       '{"id":"auto_x","amount":100,"status":"succeeded"}'::jsonb, 'auto_x');
--   -- first:  patched true,  alreadyRecorded false
--   -- second: patched false, alreadyRecorded true
--
-- And the installment and the payment must move together — never one without
-- the other:
--   select jsonb_array_length(value->'finance'->'payments'),
--          value #> '{families,<famKey>,plans,0,installments}'
--     from camp_state_kv where key='campistryMe';
-- ============================================================================
