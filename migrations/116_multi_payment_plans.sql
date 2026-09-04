-- =============================================================================
-- Migration 116: multiple payment plans per family, each scoped to specific
-- camper(s)/enrollment(s).
--
-- Real gap found live: families[fk].plan was a SINGLE object covering the
-- family's whole balance. That's fine for one enrolled kid, but breaks the
-- moment a second sibling is accepted later — there was no way to represent
-- "kid A already has plan X (or no plan), now the parent wants a plan for
-- kid B only" or "one combined plan covering both." Both scenarios needed
-- attributing an installment schedule to SPECIFIC campers, which the
-- singular `plan` field had no room for.
--
-- Fix: families[fk].plan (singular) -> families[fk].plans[] (array), each
-- entry {id, enrollmentIds, installments, autopay, total, createdAt,
-- source}. A combined plan just lists both enrollment ids; a per-kid plan
-- lists one. Payment METHOD stays exactly where it already was — one
-- Stripe customer/saved card per FAMILY (cardOnFile/stripeCustomerId/
-- stripePaymentMethodId) — so a parent still only ever does ONE checkout
-- (stripe-setup-checkout, unchanged) to save a card, and that one saved
-- method can autopay any number of plans they have. Nothing about the
-- card-saving flow changes in this migration.
--
-- Backward compatible: a family that still only has the legacy singular
-- `plan` (every family created before this migration) is synthesized into
-- a one-item `plans` array on read, tagged enrollmentIds:null ("covers the
-- whole family" — the only thing a legacy plan could ever mean, since it
-- never recorded which camper it was for). campistry_me.js does the same
-- synthesis client-side the first time it touches a family's plans, and
-- persists the migrated shape from then on.
-- =============================================================================

-- ─── 1. get_my_balance — return plans[] + per-enrollment detail ───────────
CREATE OR REPLACE FUNCTION public.get_my_balance(p_camp_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller    uuid := auth.uid();
    inv       link_parent_invites;
    me        jsonb;
    enr       jsonb;
    fams      jsonb;
    pays      jsonb;
    sess_list jsonb;
    v_names   jsonb;
    rec       record;
    famRec    record;
    e         jsonb;
    p         jsonb;
    fam       jsonb;
    ch        jsonb;
    cr        jsonb;
    v_billed  numeric := 0;
    v_paid    numeric := 0;
    v_credits numeric := 0;
    v_tuition numeric;
    v_liveT   numeric;
    v_disc    numeric;
    v_amt     numeric;
    v_status  text;
    v_family  text;
    v_enrIds  jsonb := '[]'::jsonb;
    v_history jsonb := '[]'::jsonb;
    v_belongs boolean;
    v_famKey  text := NULL;
    v_fam     jsonb := NULL;
    v_myEnr   jsonb := '[]'::jsonb;
    v_plans   jsonb;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    SELECT * INTO inv
    FROM link_parent_invites
    WHERE user_id = caller
      AND (status = 'active' OR billing_access = true)
      AND (expires_at IS NULL OR expires_at > now())
      AND (p_camp_id IS NULL OR camp_id = p_camp_id)
    ORDER BY created_at DESC
    LIMIT 1;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;
    v_names := COALESCE(inv.camper_names, '[]'::jsonb);

    SELECT value INTO me FROM camp_state_kv
    WHERE camp_id = inv.camp_id AND key = 'campistryMe';
    IF me IS NULL THEN me := '{}'::jsonb; END IF;
    enr       := COALESCE(me->'enrollments', '{}'::jsonb);
    fams      := COALESCE(me->'families', '{}'::jsonb);
    pays      := COALESCE(me->'finance'->'payments', '[]'::jsonb);
    sess_list := COALESCE(me->'sessions', '[]'::jsonb);

    FOR rec IN SELECT key, value FROM jsonb_each(enr) LOOP
        e := rec.value;
        IF (v_names ? (e->>'camperName')) AND (e->>'status') IN ('enrolled', 'accepted') THEN
            -- Prefer the session's CURRENT price, but only when it's
            -- actually positive — a live session match that resolves to $0
            -- (a stale/duplicate same-named session) must not override a
            -- genuinely positive frozen sessionTuition snapshot. See the
            -- identical fix already applied to enrollCamper()/
            -- buildFamilyLedgers() in campistry_me.js.
            v_liveT := (SELECT (s->>'tuition')::numeric
                          FROM jsonb_array_elements(sess_list) s
                         WHERE s->>'name' = e->>'session'
                         LIMIT 1);
            v_tuition := CASE WHEN v_liveT IS NOT NULL AND v_liveT > 0 THEN v_liveT
                              ELSE COALESCE((e->>'sessionTuition')::numeric, 0) END;
            v_disc := 0;
            IF e->'discount' IS NOT NULL AND e->'discount' <> 'null'::jsonb THEN
                v_disc := COALESCE((e->'discount'->>'amt')::numeric, 0)
                        + ROUND(v_tuition * COALESCE((e->'discount'->>'pct')::numeric, 0) / 100);
            END IF;
            v_billed := v_billed + (v_tuition - v_disc);
            v_enrIds := v_enrIds || to_jsonb(rec.key);
            -- Per-enrollment detail — lets the parent portal label each plan
            -- by camper name and offer a per-kid picker when building a new one.
            v_myEnr := v_myEnr || jsonb_build_object(
                'id', rec.key, 'camperName', e->>'camperName',
                'session', e->>'session', 'net', v_tuition - v_disc
            );
        END IF;
    END LOOP;

    FOR famRec IN SELECT key, value FROM jsonb_each(fams) LOOP
        fam := famRec.value;
        v_belongs := EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(COALESCE(fam->'camperIds', '[]'::jsonb)) ci
            WHERE v_names ? ci
        );
        IF NOT v_belongs THEN CONTINUE; END IF;

        IF v_famKey IS NULL THEN
            v_famKey := famRec.key;
            v_fam := fam;
        END IF;

        FOR ch IN SELECT * FROM jsonb_array_elements(COALESCE(fam->'charges', '[]'::jsonb)) LOOP
            v_amt := COALESCE((ch->>'amount')::numeric, 0);
            v_billed := v_billed + v_amt;
            v_history := v_history || jsonb_build_object(
                'date',   COALESCE(ch->>'date', ''),
                'desc',   COALESCE(NULLIF(ch->>'description', ''), COALESCE(ch->>'category', 'Charge')),
                'amt',    v_amt,
                'status', 'charge'
            );
        END LOOP;

        FOR cr IN SELECT * FROM jsonb_array_elements(COALESCE(fam->'credits', '[]'::jsonb)) LOOP
            v_amt := COALESCE((cr->>'amount')::numeric, 0);
            v_credits := v_credits + v_amt;
            v_history := v_history || jsonb_build_object(
                'date',   COALESCE(cr->>'date', ''),
                'desc',   COALESCE(NULLIF(cr->>'reason', ''), 'Credit'),
                'amt',    v_amt,
                'status', 'credit'
            );
        END LOOP;
    END LOOP;

    FOR p IN SELECT * FROM jsonb_array_elements(pays) LOOP
        v_family := COALESCE(p->>'family', '');
        IF (v_names ? v_family) OR (v_enrIds ? COALESCE(p->>'enrollmentId', '')) THEN
            v_amt := COALESCE((p->>'amount')::numeric, 0);
            v_status := COALESCE(p->>'status', '');
            IF v_status NOT IN ('pending', 'failed') THEN v_paid := v_paid + v_amt; END IF;
            v_history := v_history || jsonb_build_object(
                'date',   COALESCE(p->>'date', ''),
                'desc',   COALESCE(NULLIF(p->>'notes', ''), COALESCE(p->>'method', 'Payment')),
                'amt',    v_amt,
                'status', CASE WHEN v_amt < 0 THEN 'refunded'
                               WHEN v_status = 'pending' THEN 'pending'
                               WHEN v_status = 'failed' THEN 'failed'
                               ELSE 'paid' END
            );
        END IF;
    END LOOP;

    -- Normalize plans: prefer the new array; synthesize a one-item array
    -- from the legacy singular `plan` (enrollmentIds:null = "whole family",
    -- the only thing a legacy plan could ever mean) when `plans` is absent.
    IF v_fam IS NOT NULL AND v_fam ? 'plans' AND jsonb_typeof(v_fam->'plans') = 'array' THEN
        v_plans := v_fam->'plans';
    ELSIF v_fam IS NOT NULL AND v_fam ? 'plan' AND v_fam->'plan' <> 'null'::jsonb THEN
        v_plans := jsonb_build_array((v_fam->'plan') || jsonb_build_object('enrollmentIds', NULL));
    ELSE
        v_plans := '[]'::jsonb;
    END IF;

    RETURN jsonb_build_object(
        'success',            true,
        'camp_id',            inv.camp_id,
        'familyName',         COALESCE(v_names->>0, inv.parent_name),
        'campers',            v_names,
        'billed',             v_billed,
        'paid',               v_paid,
        'credits',            v_credits,
        'balance',            v_billed - v_paid - v_credits,
        'payments',           v_history,
        'familyKey',          v_famKey,
        'cardOnFile',         COALESCE(v_fam->'cardOnFile', 'false'::jsonb)::boolean,
        'paymentMethodType',  v_fam->>'paymentMethodType',
        'paymentMethodLabel', v_fam->>'paymentMethodLabel',
        'plans',              v_plans,
        'enrollments',        v_myEnr,
        'allowParentPaymentPlans', COALESCE((me #>> '{enrollSettings,allowParentPaymentPlans}')::boolean, false)
    );
END;
$$;
REVOKE ALL ON FUNCTION public.get_my_balance(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_balance(uuid) TO authenticated;

-- ─── 2. set_my_payment_plan — now scoped to specific enrollment ids ───────
DROP FUNCTION IF EXISTS public.set_my_payment_plan(uuid, jsonb);
CREATE OR REPLACE FUNCTION public.set_my_payment_plan(
    p_camp_id        uuid,
    p_enrollment_ids jsonb,  -- ["enr_...", ...] — which of the parent's OWN campers this plan covers
    p_installments   jsonb   -- [{amount numeric, dueDate text}, ...]
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
    famRec     record;
    e          jsonb;
    fam        jsonb;
    v_tuition  numeric;
    v_liveT    numeric;
    v_disc     numeric;
    v_amt      numeric;
    v_belongs  boolean;
    v_famKey   text := NULL;
    v_fam      jsonb := NULL;
    v_target   numeric := 0;
    v_sum      numeric := 0;
    v_count    integer := 0;
    inst       jsonb;
    v_insts    jsonb := '[]'::jsonb;
    v_n        integer := 0;
    v_total    numeric := 0;
    v_famName  text;
    v_eid      text;
    v_row      jsonb;
    v_existingPlans jsonb;
    v_plan     jsonb;
    v_names_list text[] := '{}';
    v_newPlan  jsonb;
    v_camperNames text;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF p_camp_id IS NULL OR p_installments IS NULL OR jsonb_typeof(p_installments) <> 'array'
       OR p_enrollment_ids IS NULL OR jsonb_typeof(p_enrollment_ids) <> 'array' OR jsonb_array_length(p_enrollment_ids) = 0 THEN
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

    -- Every requested enrollment id must be one of THIS parent's own
    -- enrolled/accepted campers — never trust the client's claim about
    -- ownership. Compute the target total as the sum of net tuition for
    -- exactly those enrollments (server-side, never the client's number).
    FOR v_row IN SELECT * FROM jsonb_array_elements(p_enrollment_ids) LOOP
        v_eid := v_row #>> '{}';
        e := enr -> v_eid;
        IF e IS NULL OR NOT (v_names ? (e->>'camperName')) OR (e->>'status') NOT IN ('enrolled', 'accepted') THEN
            RETURN jsonb_build_object('success', false, 'error', 'enrollment_not_yours', 'enrollmentId', v_eid);
        END IF;
        v_liveT := (SELECT (s->>'tuition')::numeric FROM jsonb_array_elements(sess_list) s WHERE s->>'name' = e->>'session' LIMIT 1);
        v_tuition := CASE WHEN v_liveT IS NOT NULL AND v_liveT > 0 THEN v_liveT
                          ELSE COALESCE((e->>'sessionTuition')::numeric, 0) END;
        v_disc := 0;
        IF e->'discount' IS NOT NULL AND e->'discount' <> 'null'::jsonb THEN
            v_disc := COALESCE((e->'discount'->>'amt')::numeric, 0)
                    + ROUND(v_tuition * COALESCE((e->'discount'->>'pct')::numeric, 0) / 100);
        END IF;
        v_target := v_target + (v_tuition - v_disc);
        v_names_list := array_append(v_names_list, e->>'camperName');
    END LOOP;
    IF v_target <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'nothing_owed');
    END IF;

    -- Find the parent's family record.
    FOR famRec IN SELECT key, value FROM jsonb_each(fams) LOOP
        fam := famRec.value;
        v_belongs := EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(COALESCE(fam->'camperIds', '[]'::jsonb)) ci
            WHERE v_names ? ci
        );
        IF v_belongs THEN v_famKey := famRec.key; v_fam := fam; EXIT; END IF;
    END LOOP;
    IF v_famKey IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_family_on_file');
    END IF;

    -- Existing plans (normalize legacy singular `plan` the same way
    -- get_my_balance does) — a requested enrollment id already covered by
    -- ANY existing plan can't be double-scheduled. A legacy family-wide
    -- plan (enrollmentIds:null) is treated as covering every enrollment,
    -- since that's the only thing it could have meant.
    IF v_fam ? 'plans' AND jsonb_typeof(v_fam->'plans') = 'array' THEN
        v_existingPlans := v_fam->'plans';
    ELSIF v_fam ? 'plan' AND v_fam->'plan' <> 'null'::jsonb THEN
        v_existingPlans := jsonb_build_array((v_fam->'plan') || jsonb_build_object('enrollmentIds', NULL));
    ELSE
        v_existingPlans := '[]'::jsonb;
    END IF;

    FOR v_plan IN SELECT * FROM jsonb_array_elements(v_existingPlans) LOOP
        IF v_plan->'enrollmentIds' IS NULL OR v_plan->'enrollmentIds' = 'null'::jsonb THEN
            RETURN jsonb_build_object('success', false, 'error', 'plan_already_exists');
        END IF;
        FOR v_row IN SELECT * FROM jsonb_array_elements(p_enrollment_ids) LOOP
            IF v_plan->'enrollmentIds' ? (v_row #>> '{}') THEN
                RETURN jsonb_build_object('success', false, 'error', 'plan_already_exists');
            END IF;
        END LOOP;
    END LOOP;

    -- Validate + normalize submitted installments against the server
    -- computed target (a couple cents of rounding slack, same as the
    -- office's own generator allows).
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
    v_camperNames := array_to_string(v_names_list, ' & ');
    v_newPlan := jsonb_build_object(
        'id', 'plan_' || replace(gen_random_uuid()::text, '-', ''),
        'enrollmentIds', p_enrollment_ids,
        'installments', v_insts, 'autopay', false, 'total', round(v_total, 2),
        'createdAt', now()::text, 'source', 'parent'
    );
    fams := jsonb_set(fams, ARRAY[v_famKey, 'plans'], v_existingPlans || jsonb_build_array(v_newPlan));
    -- Drop the legacy singular field once migrated onto the array, so this
    -- family never carries both shapes going forward.
    fams := fams #- ARRAY[v_famKey, 'plan'];
    me := jsonb_set(me, ARRAY['families'], fams);

    UPDATE camp_state_kv SET value = me, updated_at = now()
    WHERE camp_id = p_camp_id AND key = 'campistryMe';

    INSERT INTO notifications (camp_id, source, source_id, title, body, link_target)
    VALUES (p_camp_id, 'parent_payment_plan_created', v_newPlan->>'id',
            'Family set up their own payment plan',
            v_famName || ' built a ' || v_n || '-payment plan for ' || v_camperNames
                || ' (' || to_char(round(v_total,2), 'FM$999,999,990.00') || ' total) in Link.',
            'campistry_me.html')
    ON CONFLICT (camp_id, source, source_id) DO NOTHING;

    RETURN jsonb_build_object('success', true, 'plan', v_newPlan);
END;
$$;
REVOKE ALL ON FUNCTION public.set_my_payment_plan(uuid, jsonb, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.set_my_payment_plan(uuid, jsonb, jsonb) TO authenticated;

-- ─── Sanity check ────────────────────────────────────────────────────────
--   select proacl from pg_proc where proname in ('get_my_balance','set_my_payment_plan');
--   -- both should show authenticated only, never anon.
--   select get_my_balance('<a real camp id>'::uuid); -- as that parent's session
--   -- confirm "plans" is an array and "enrollments" lists that parent's own
--   -- campers with net tuition figures.
-- =============================================================================
