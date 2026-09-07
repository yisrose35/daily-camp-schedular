-- =============================================================================
-- Migration 117: revert self-serve payment plans to whole-family scope.
--
-- Bounced back from migration 116's per-camper/enrollment scoping, on the
-- camp's own explicit direction: "each family is going to owe X amount of
-- dollars to this camp. I don't care how many kids it comes from and I
-- don't care if 1 kid was set up with a payment plan and another wasn't.
-- The family owes X amount of dollars, the bill goes up as more kids
-- come. The camp can just edit and set up a new payment plan if they
-- wish." A family gets AT MOST ONE plan again, and it always covers the
-- family's real outstanding balance — not a sum of specific enrollments'
-- tuition. campistry_me.js (office) and campistry_link_parent.html
-- (self-serve) were already reverted client-side to this model; this
-- migration brings set_my_payment_plan's server-side target computation
-- in line with it.
--
-- Two things this fixes that migration 116's per-enrollment target could
-- not have gotten right even if the client still asked for "every
-- enrollment": that RPC summed gross tuition across the requested
-- enrollment ids, which ignores prior payments, family-level charges, and
-- credits — exactly the figures get_my_balance already nets together into
-- "balance". A parent who'd already paid $500 toward tuition outside a
-- plan would have had a self-serve plan try to schedule the ORIGINAL
-- gross tuition, not what's actually still owed. This migration computes
-- the target the same way get_my_balance does (billed - paid - credits),
-- so "the bill" a plan schedules is always the real number on the ledger.
--
-- set_my_payment_plan keeps its existing 3-arg signature (p_camp_id,
-- p_enrollment_ids, p_installments) so the client doesn't need a new RPC
-- name — p_enrollment_ids is now accepted but IGNORED (the client passes
-- NULL going forward); every plan created here is enrollmentIds:NULL
-- (whole family). A family that already has ANY plan (per-camper test
-- data from before this migration included) is rejected with
-- plan_already_exists — same message as before, edit or cancel the
-- existing one first.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.set_my_payment_plan(
    p_camp_id        uuid,
    p_enrollment_ids jsonb,   -- accepted for signature compatibility, IGNORED
    p_installments   jsonb    -- [{amount numeric, dueDate text}, ...]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller     uuid := auth.uid();
    inv        link_parent_invites;
    v_names    jsonb;
    me         jsonb;
    enr        jsonb;
    fams       jsonb;
    sess_list  jsonb;
    pays       jsonb;
    rec        record;
    famRec     record;
    e          jsonb;
    fam        jsonb;
    ch         jsonb;
    cr         jsonb;
    p          jsonb;
    v_tuition  numeric;
    v_liveT    numeric;
    v_disc     numeric;
    v_amt      numeric;
    v_status   text;
    v_family   text;
    v_enrIds   jsonb := '[]'::jsonb;
    v_billed   numeric := 0;
    v_paid     numeric := 0;
    v_credits  numeric := 0;
    v_target   numeric := 0;
    v_belongs  boolean;
    v_famKey   text := NULL;
    v_fam      jsonb := NULL;
    v_count    integer := 0;
    v_sum      numeric := 0;
    inst       jsonb;
    v_insts    jsonb := '[]'::jsonb;
    v_n        integer := 0;
    v_total    numeric := 0;
    v_famName  text;
    v_existingPlans jsonb;
    v_newPlan  jsonb;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF p_camp_id IS NULL OR p_installments IS NULL OR jsonb_typeof(p_installments) <> 'array' THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_payload');
    END IF;

    SELECT * INTO inv
    FROM link_parent_invites
    WHERE user_id = caller
      AND (status = 'active' OR billing_access = true)
      AND (expires_at IS NULL OR expires_at > now())
      AND camp_id = p_camp_id
    ORDER BY created_at DESC
    LIMIT 1;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;
    v_names := COALESCE(inv.camper_names, '[]'::jsonb);

    SELECT value INTO me FROM camp_state_kv
    WHERE camp_id = p_camp_id AND key = 'campistryMe' FOR UPDATE;
    IF me IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'camp_not_found');
    END IF;

    IF NOT COALESCE((me #>> '{enrollSettings,allowParentPaymentPlans}')::boolean, false) THEN
        RETURN jsonb_build_object('success', false, 'error', 'self_serve_not_enabled');
    END IF;

    enr       := COALESCE(me->'enrollments', '{}'::jsonb);
    fams      := COALESCE(me->'families', '{}'::jsonb);
    sess_list := COALESCE(me->'sessions', '[]'::jsonb);
    pays      := COALESCE(me->'finance'->'payments', '[]'::jsonb);

    -- Target = this family's real outstanding balance, computed exactly
    -- like get_my_balance does (billed - paid - credits) — never a sum of
    -- specific enrollments' tuition, which would ignore prior payments,
    -- family-level charges, and credits already on the ledger.
    FOR rec IN SELECT key, value FROM jsonb_each(enr) LOOP
        e := rec.value;
        IF (v_names ? (e->>'camperName')) AND (e->>'status') IN ('enrolled', 'accepted') THEN
            v_liveT := (SELECT (s->>'tuition')::numeric FROM jsonb_array_elements(sess_list) s WHERE s->>'name' = e->>'session' LIMIT 1);
            v_tuition := CASE WHEN v_liveT IS NOT NULL AND v_liveT > 0 THEN v_liveT
                              ELSE COALESCE((e->>'sessionTuition')::numeric, 0) END;
            v_disc := 0;
            IF e->'discount' IS NOT NULL AND e->'discount' <> 'null'::jsonb THEN
                v_disc := COALESCE((e->'discount'->>'amt')::numeric, 0)
                        + ROUND(v_tuition * COALESCE((e->'discount'->>'pct')::numeric, 0) / 100);
            END IF;
            v_billed := v_billed + (v_tuition - v_disc);
            v_enrIds := v_enrIds || to_jsonb(rec.key);
        END IF;
    END LOOP;

    FOR famRec IN SELECT key, value FROM jsonb_each(fams) LOOP
        fam := famRec.value;
        v_belongs := EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(COALESCE(fam->'camperIds', '[]'::jsonb)) ci
            WHERE v_names ? ci
        );
        IF NOT v_belongs THEN CONTINUE; END IF;
        IF v_famKey IS NULL THEN v_famKey := famRec.key; v_fam := fam; END IF;

        FOR ch IN SELECT * FROM jsonb_array_elements(COALESCE(fam->'charges', '[]'::jsonb)) LOOP
            v_billed := v_billed + COALESCE((ch->>'amount')::numeric, 0);
        END LOOP;
        FOR cr IN SELECT * FROM jsonb_array_elements(COALESCE(fam->'credits', '[]'::jsonb)) LOOP
            v_credits := v_credits + COALESCE((cr->>'amount')::numeric, 0);
        END LOOP;
    END LOOP;

    IF v_famKey IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_family_on_file');
    END IF;

    FOR p IN SELECT * FROM jsonb_array_elements(pays) LOOP
        v_family := COALESCE(p->>'family', '');
        IF (v_names ? v_family) OR (v_enrIds ? COALESCE(p->>'enrollmentId', '')) THEN
            v_amt := COALESCE((p->>'amount')::numeric, 0);
            v_status := COALESCE(p->>'status', '');
            IF v_status NOT IN ('pending', 'failed') THEN v_paid := v_paid + v_amt; END IF;
        END IF;
    END LOOP;

    v_target := v_billed - v_paid - v_credits;
    IF v_target <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'nothing_owed');
    END IF;

    -- Only one plan per family, full stop — reject if any plan already
    -- exists (per-camper or legacy whole-family), same as before.
    IF v_fam ? 'plans' AND jsonb_typeof(v_fam->'plans') = 'array' THEN
        v_existingPlans := v_fam->'plans';
    ELSIF v_fam ? 'plan' AND v_fam->'plan' <> 'null'::jsonb THEN
        v_existingPlans := jsonb_build_array(v_fam->'plan');
    ELSE
        v_existingPlans := '[]'::jsonb;
    END IF;
    IF jsonb_array_length(v_existingPlans) > 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'plan_already_exists');
    END IF;

    FOR inst IN SELECT * FROM jsonb_array_elements(p_installments) LOOP
        v_amt := COALESCE((inst->>'amount')::numeric, 0);
        IF v_amt <= 0 OR (inst->>'dueDate') IS NULL OR (inst->>'dueDate') = '' THEN CONTINUE; END IF;
        v_count := v_count + 1;
        v_sum := v_sum + v_amt;
    END LOOP;
    IF v_count < 1 OR v_count > 60 THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_installment_count');
    END IF;
    IF abs(v_sum - v_target) > 0.05 THEN
        RETURN jsonb_build_object('success', false, 'error', 'total_mismatch', 'expected', v_target, 'submitted', v_sum);
    END IF;

    FOR inst IN SELECT * FROM jsonb_array_elements(p_installments) ORDER BY (value->>'dueDate') LOOP
        v_amt := COALESCE((inst->>'amount')::numeric, 0);
        IF v_amt <= 0 OR (inst->>'dueDate') IS NULL OR (inst->>'dueDate') = '' THEN CONTINUE; END IF;
        v_n := v_n + 1;
        v_total := v_total + v_amt;
        v_insts := v_insts || jsonb_build_object(
            'n', v_n, 'amount', round(v_amt, 2), 'dueDate', inst->>'dueDate',
            'status', 'pending', 'paymentId', NULL
        );
    END LOOP;

    v_famName := coalesce(v_fam->>'name', v_names->>0, inv.parent_name, 'Family');
    v_newPlan := jsonb_build_object(
        'id', 'plan_' || replace(gen_random_uuid()::text, '-', ''),
        'enrollmentIds', NULL,
        'installments', v_insts, 'autopay', false, 'total', round(v_total, 2),
        'createdAt', now()::text, 'source', 'parent'
    );
    fams := jsonb_set(fams, ARRAY[v_famKey, 'plans'], jsonb_build_array(v_newPlan));
    fams := fams #- ARRAY[v_famKey, 'plan'];
    me := jsonb_set(me, ARRAY['families'], fams);

    UPDATE camp_state_kv SET value = me, updated_at = now()
    WHERE camp_id = p_camp_id AND key = 'campistryMe';

    INSERT INTO notifications (camp_id, source, source_id, title, body, link_target)
    VALUES (p_camp_id, 'parent_payment_plan_created', v_newPlan->>'id',
            'Family set up their own payment plan',
            v_famName || ' built a ' || v_n || '-payment plan (' || to_char(round(v_total,2), 'FM$999,999,990.00') || ' total) in Link.',
            'campistry_me.html')
    ON CONFLICT (camp_id, source, source_id) DO NOTHING;

    RETURN jsonb_build_object('success', true, 'plan', v_newPlan);
END;
$$;
REVOKE ALL ON FUNCTION public.set_my_payment_plan(uuid, jsonb, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.set_my_payment_plan(uuid, jsonb, jsonb) TO authenticated;

-- ─── Sanity check ────────────────────────────────────────────────────────
--   select proacl from pg_proc where proname = 'set_my_payment_plan';
--   -- authenticated only, never anon.
--   -- As a parent's session, with a family that has a real outstanding
--   -- balance and no plan yet:
--   select set_my_payment_plan('<a real camp id>'::uuid, null,
--     '[{"amount": 100, "dueDate": "2026-10-01"}]'::jsonb);
--   -- should reject with total_mismatch unless 100 happens to equal the
--   -- family's real balance — confirms the target is the ledger balance,
--   -- not a per-enrollment tuition sum.
-- =============================================================================
