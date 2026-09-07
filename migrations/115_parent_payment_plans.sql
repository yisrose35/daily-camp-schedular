-- =============================================================================
-- Migration 115: parent-facing payment-preference feature.
--
-- On the registration form a parent already states how they want to pay
-- (credit_card / ach / zelle / check / payment_plan — campistry_register.html,
-- e.paymentMethod). Today that's purely decorative: the office sees a label
-- on the application and nothing else happens automatically. This migration
-- adds the server-side pieces for real follow-through:
--
--   1. A new camp-wide toggle, enrollSettings.allowParentPaymentPlans — when
--      ON, an accepted/enrolled family can build their own installment
--      schedule from their Link portal; when OFF, the office gets flagged to
--      reach out and build one manually (the existing staff-only
--      monthlyPlan() flow in campistry_me.js).
--   2. get_public_form_config (migration 114) extended to surface that flag
--      to the anonymous registration form.
--   3. flag_application_payment_followup — an anon-safe RPC the register
--      form calls right after a successful submission. It reads the
--      SUBMITTED enrollment's own paymentMethod and the camp's OWN
--      allowParentPaymentPlans setting server-side (never trusts the
--      client's claim about either) and creates a notification for the
--      office when — and only when — real action is needed: "payment_plan"
--      chosen while self-serve is off, or "zelle"/"check" chosen (so the
--      office knows to watch for an offline payment and mark it received).
--      credit_card/ach need no flag — Link's existing pay-balance flow
--      (stripe-checkout, campistry_link_parent.html's payNow()) already
--      offers both, nothing new to build there.
--   4. get_my_balance (migration 096) extended to also return
--      allowParentPaymentPlans, so Link knows whether to offer the
--      self-serve builder.
--   5. set_my_payment_plan — the actual self-serve builder's write path.
--      Authenticated parent only, re-derives the caller's family the exact
--      same way get_my_balance already does (never trusts a client-supplied
--      familyKey), rejects if the camp hasn't turned self-serve on, rejects
--      if a plan already exists (an office-built plan is never silently
--      overwritten by the parent — they'd need to contact the camp), and
--      validates the submitted installment total against the SAME balance
--      math get_my_balance computes server-side (a parent can't invent an
--      arbitrary total different from what they actually owe). Writes into
--      families[fk].plan in the exact shape monthlyPlan() already writes
--      (installments[]/autopay/total/createdAt) so every existing reader —
--      Me -> Billing's _planCardHtml, Link's _autopaySectionHtml — needs no
--      changes at all to display a parent-built plan. Also notifies the
--      office so a parent-built plan doesn't go unnoticed.
-- =============================================================================

-- ─── 1. get_public_form_config — add allowParentPaymentPlans ──────────────
CREATE OR REPLACE FUNCTION public.get_public_form_config(
    p_camp_id uuid,
    p_kind    text   -- 'registration' | 'staff'
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    camp_row  record;
    kv_value  jsonb;
BEGIN
    IF p_kind NOT IN ('registration', 'staff') THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_kind');
    END IF;
    IF p_camp_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_payload');
    END IF;

    SELECT id, name INTO camp_row FROM camps WHERE id = p_camp_id;
    IF camp_row.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'camp_not_found');
    END IF;

    SELECT value INTO kv_value
    FROM camp_state_kv
    WHERE camp_id = p_camp_id AND key = 'campistryMe';

    IF p_kind = 'registration' THEN
        RETURN jsonb_build_object(
            'success', true,
            'campName', camp_row.name,
            'formConfig', coalesce(kv_value -> 'formConfig', '{}'::jsonb),
            'sessions', coalesce(kv_value -> 'sessions', '[]'::jsonb),
            'sessionBundles', coalesce(kv_value -> 'sessionBundles', '[]'::jsonb),
            'promoCodes', coalesce(kv_value -> 'promoCodes', '{}'::jsonb),
            'schoolGrades', coalesce(kv_value #> '{bunkGenConfig,schoolGrades}', '[]'::jsonb),
            'allowParentPaymentPlans', coalesce(kv_value #> '{enrollSettings,allowParentPaymentPlans}', 'false'::jsonb)
        );
    ELSE
        RETURN jsonb_build_object(
            'success', true,
            'campName', camp_row.name,
            'staffFormConfig', coalesce(kv_value -> 'staffFormConfig', '{}'::jsonb),
            'sessions', coalesce(kv_value -> 'sessions', '[]'::jsonb)
        );
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.get_public_form_config(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.get_public_form_config(uuid, text) TO anon, authenticated;

-- ─── 2. flag_application_payment_followup — anon-safe, office notification ──
CREATE OR REPLACE FUNCTION public.flag_application_payment_followup(
    p_camp_id uuid,
    p_app_id  text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    kv_value    jsonb;
    app_row     jsonb;
    v_allow     boolean;
    v_method    text;
    v_camper    text;
    v_title     text;
    v_body      text;
    v_source    text;
BEGIN
    IF p_camp_id IS NULL OR p_app_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_payload');
    END IF;

    SELECT value INTO kv_value
    FROM camp_state_kv
    WHERE camp_id = p_camp_id AND key = 'campistryMe';

    app_row := kv_value -> 'enrollments' -> p_app_id;
    IF app_row IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'application_not_found');
    END IF;

    v_method := coalesce(app_row ->> 'paymentMethod', '');
    v_camper := coalesce(app_row ->> 'camperName', 'An applicant');
    v_allow  := coalesce((kv_value #>> '{enrollSettings,allowParentPaymentPlans}')::boolean, false);

    IF v_method = 'payment_plan' AND NOT v_allow THEN
        v_source := 'payment_plan_followup';
        v_title  := 'Payment plan requested';
        v_body   := v_camper || '''s family wants to set up a payment plan — reach out to arrange it.';
    ELSIF v_method IN ('zelle', 'check') THEN
        v_source := 'manual_payment_expected';
        v_title  := 'Manual payment expected (' || initcap(v_method) || ')';
        v_body   := v_camper || '''s family plans to pay by ' || initcap(v_method) || ' — watch for it and mark it received once it arrives.';
    ELSE
        RETURN jsonb_build_object('success', true, 'flagged', false);
    END IF;

    INSERT INTO notifications (camp_id, source, source_id, title, body, link_target)
    VALUES (p_camp_id, v_source, p_app_id, v_title, v_body, 'campistry_me.html')
    ON CONFLICT (camp_id, source, source_id) DO NOTHING;

    RETURN jsonb_build_object('success', true, 'flagged', true);
END;
$$;
REVOKE ALL ON FUNCTION public.flag_application_payment_followup(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.flag_application_payment_followup(uuid, text) TO anon, authenticated;

-- ─── 3. get_my_balance — add allowParentPaymentPlans ───────────────────────
-- CREATE OR REPLACE carries migrations 070/094/095/096 forward unchanged,
-- just adding one more field to the final jsonb_build_object.
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
    v_disc    numeric;
    v_amt     numeric;
    v_status  text;
    v_family  text;
    v_enrIds  jsonb := '[]'::jsonb;
    v_history jsonb := '[]'::jsonb;
    v_belongs boolean;
    v_famKey  text := NULL;
    v_fam     jsonb := NULL;
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
            v_tuition := COALESCE(
                (SELECT (s->>'tuition')::numeric
                   FROM jsonb_array_elements(sess_list) s
                  WHERE s->>'name' = e->>'session'
                  LIMIT 1),
                (e->>'sessionTuition')::numeric,
                0
            );
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
            IF v_status NOT IN ('pending', 'failed') THEN
                v_paid := v_paid + v_amt;
            END IF;
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
        'plan',               v_fam->'plan',
        'allowParentPaymentPlans', COALESCE((me #>> '{enrollSettings,allowParentPaymentPlans}')::boolean, false)
    );
END;
$$;
REVOKE ALL ON FUNCTION public.get_my_balance(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_balance(uuid) TO authenticated;

-- ─── 4. set_my_payment_plan — the self-serve builder's write path ─────────
CREATE OR REPLACE FUNCTION public.set_my_payment_plan(
    p_camp_id      uuid,
    p_installments jsonb   -- [{amount numeric, dueDate text}, ...]
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
    pays       jsonb;
    sess_list  jsonb;
    rec        record;
    famRec     record;
    e          jsonb;
    p          jsonb;
    fam        jsonb;
    v_billed   numeric := 0;
    v_paid     numeric := 0;
    v_credits  numeric := 0;
    v_tuition  numeric;
    v_disc     numeric;
    v_amt      numeric;
    v_status   text;
    v_family   text;
    v_enrIds   jsonb := '[]'::jsonb;
    v_belongs  boolean;
    v_famKey   text := NULL;
    v_fam      jsonb := NULL;
    v_balance  numeric;
    v_sum      numeric := 0;
    v_count    integer := 0;
    inst       jsonb;
    v_insts    jsonb := '[]'::jsonb;
    v_n        integer := 0;
    v_total    numeric := 0;
    v_famName  text;
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

    -- Lock the row for the whole read-modify-write — two submits racing
    -- (double-click, two tabs) must not both succeed.
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
    pays      := COALESCE(me->'finance'->'payments', '[]'::jsonb);
    sess_list := COALESCE(me->'sessions', '[]'::jsonb);

    -- Recompute the SAME balance math get_my_balance uses — never trust a
    -- client-supplied total.
    FOR rec IN SELECT key, value FROM jsonb_each(enr) LOOP
        e := rec.value;
        IF (v_names ? (e->>'camperName')) AND (e->>'status') IN ('enrolled', 'accepted') THEN
            v_tuition := COALESCE(
                (SELECT (s->>'tuition')::numeric FROM jsonb_array_elements(sess_list) s WHERE s->>'name' = e->>'session' LIMIT 1),
                (e->>'sessionTuition')::numeric, 0
            );
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

        v_billed := v_billed + (SELECT COALESCE(SUM((c->>'amount')::numeric), 0) FROM jsonb_array_elements(COALESCE(fam->'charges', '[]'::jsonb)) c);
        v_credits := v_credits + (SELECT COALESCE(SUM((c->>'amount')::numeric), 0) FROM jsonb_array_elements(COALESCE(fam->'credits', '[]'::jsonb)) c);
    END LOOP;

    IF v_famKey IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_family_on_file');
    END IF;
    IF v_fam ? 'plan' AND v_fam -> 'plan' <> 'null'::jsonb THEN
        RETURN jsonb_build_object('success', false, 'error', 'plan_already_exists');
    END IF;

    FOR p IN SELECT * FROM jsonb_array_elements(pays) LOOP
        v_family := COALESCE(p->>'family', '');
        IF (v_names ? v_family) OR (v_enrIds ? COALESCE(p->>'enrollmentId', '')) THEN
            v_amt := COALESCE((p->>'amount')::numeric, 0);
            v_status := COALESCE(p->>'status', '');
            IF v_status NOT IN ('pending', 'failed') THEN v_paid := v_paid + v_amt; END IF;
        END IF;
    END LOOP;

    v_balance := v_billed - v_paid - v_credits;
    IF v_balance <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'nothing_owed');
    END IF;

    -- Validate + normalize the submitted rows.
    FOR inst IN SELECT * FROM jsonb_array_elements(p_installments) LOOP
        v_amt := COALESCE((inst->>'amount')::numeric, 0);
        IF v_amt <= 0 OR (inst->>'dueDate') IS NULL OR (inst->>'dueDate') = '' THEN CONTINUE; END IF;
        v_count := v_count + 1;
        v_sum := v_sum + v_amt;
    END LOOP;
    IF v_count < 1 OR v_count > 60 THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_installment_count');
    END IF;
    -- Allow a couple cents of rounding slack, same tolerance the office's
    -- own installment generator (_mpGenRows) already produces.
    IF abs(v_sum - v_balance) > 0.05 THEN
        RETURN jsonb_build_object('success', false, 'error', 'total_mismatch', 'expected', v_balance, 'submitted', v_sum);
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
    fams := jsonb_set(
        fams, ARRAY[v_famKey, 'plan'],
        jsonb_build_object(
            'installments', v_insts, 'autopay', false, 'total', round(v_total, 2),
            'createdAt', now()::text, 'source', 'parent'
        )
    );
    me := jsonb_set(me, ARRAY['families'], fams);

    UPDATE camp_state_kv SET value = me, updated_at = now()
    WHERE camp_id = p_camp_id AND key = 'campistryMe';

    INSERT INTO notifications (camp_id, source, source_id, title, body, link_target)
    VALUES (p_camp_id, 'parent_payment_plan_created', v_famKey || ':' || now()::text,
            'Family set up their own payment plan',
            v_famName || ' built their own ' || v_n || '-payment plan (' || to_char(round(v_total,2), 'FM$999,999,990.00') || ' total) in Link.',
            'campistry_me.html')
    ON CONFLICT (camp_id, source, source_id) DO NOTHING;

    RETURN jsonb_build_object('success', true, 'installments', v_insts, 'total', round(v_total, 2));
END;
$$;
REVOKE ALL ON FUNCTION public.set_my_payment_plan(uuid, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.set_my_payment_plan(uuid, jsonb) TO authenticated;

-- ─── Sanity check ────────────────────────────────────────────────────────
--   select proacl from pg_proc where proname in
--     ('get_public_form_config','flag_application_payment_followup',
--      'get_my_balance','set_my_payment_plan');
--   -- flag_application_payment_followup should show anon; set_my_payment_plan
--   -- and get_my_balance should show authenticated only (never anon).
-- =============================================================================
