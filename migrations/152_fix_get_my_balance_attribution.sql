-- ============================================================================
-- Migration 152: fix two balance defects in get_my_balance.
--
-- Found by auditing why Link and the Me page reported different balances for
-- the same family.
--
-- 1. PAYMENTS WERE MOSTLY NOT CREDITED. A payment was attributed to this parent
--    only if finance.payments[].family was an exact CAMPER name, or the row
--    carried an enrollmentId this parent owns. familyKey was never consulted.
--    But of all the writers, only charge-due-installments (autopay) stores a
--    camper name in `family`; manual Record Payment, charge-saved-card,
--    payments-charge-nonce and the Stripe/Cardknox webhooks all store the
--    FAMILY name, and most also store familyKey. So in the common case the
--    portal showed a parent a balance that ignored what they had already paid.
--    Now matched on familyKey first, then the family's own name, with the
--    camper-name and enrollmentId paths kept for autopay and legacy rows.
--
-- 2. CHARGES WERE SUMMED ACROSS FAMILIES THAT WEREN'T REPORTED. The families
--    loop added charges[] and credits[] from every families[] entry containing
--    one of this parent's campers, but returned only the FIRST as familyKey
--    (and took plans/cardOnFile from it). A household split across two family
--    records got a total belonging to neither, reconciling against nothing the
--    office sees. Only the reported family contributes now.
--
-- Deliberately NOT changed: the camper filter (an enrollment still counts only
-- when the camper is on this parent's invite). That is the parent's
-- authorization scope, not a bug -- a parent should not be shown tuition for a
-- camper that isn't theirs.
--
-- Everything else -- the enrolled/accepted status filter, live-session-price
-- vs frozen sessionTuition, the discount formula, pending/failed exclusion,
-- negative-amount refund handling, plans normalization -- is a byte-for-byte
-- re-paste of migration 137's body.
--
-- Idempotent.
-- ============================================================================

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
    v_famName text := '';
    v_fam     jsonb := NULL;
    v_myEnr   jsonb := '[]'::jsonb;
    v_plans   jsonb;
    v_chargeable  boolean := false;
    v_processorKey text := NULL;
    v_cardLabel   text := NULL;
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

        -- Only the family we actually REPORT contributes charges/credits. This
        -- loop used to sum them from EVERY families[] entry holding one of this
        -- parent's campers while returning only the first as familyKey, so a
        -- household split across two family records produced a balance that
        -- belonged to neither of them and matched nothing the office sees.
        IF v_famKey IS NULL THEN
            v_famKey  := famRec.key;
            v_fam     := fam;
            v_famName := COALESCE(fam->>'name', '');
        ELSE
            CONTINUE;
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
        -- Attribution used to require `family` to be an exact CAMPER name (or an
        -- enrollmentId). But only autopay writes a camper name there --
        -- manual Record Payment, charge-saved-card, payments-charge-nonce and
        -- the Stripe/Cardknox webhooks all store the FAMILY name, and most also
        -- store familyKey. So nearly every real payment was invisible here and
        -- the portal told parents they still owed money they had already paid.
        -- Match the stored familyKey first (authoritative), then the family's
        -- own name, keeping the camper-name and enrollmentId paths for autopay
        -- and for older rows that carry neither.
        IF (v_names ? v_family)
           OR (v_enrIds ? COALESCE(p->>'enrollmentId', ''))
           OR (v_famKey IS NOT NULL AND COALESCE(p->>'familyKey', '') = v_famKey)
           OR (v_famName <> '' AND v_family = v_famName)
        THEN
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

    IF v_fam IS NOT NULL AND v_fam ? 'plans' AND jsonb_typeof(v_fam->'plans') = 'array' THEN
        v_plans := v_fam->'plans';
    ELSIF v_fam IS NOT NULL AND v_fam ? 'plan' AND v_fam->'plan' <> 'null'::jsonb THEN
        v_plans := jsonb_build_array((v_fam->'plan') || jsonb_build_object('enrollmentIds', NULL));
    ELSE
        v_plans := '[]'::jsonb;
    END IF;

    -- Same shape as campistry_me.js's _famChargeable(f): a real vaulted BYOP
    -- token always wins; otherwise a Stripe customer + the cardOnFile flag.
    -- Only ever tells the client YES/NO + which processor -- never returns
    -- the token/customer id itself.
    IF v_fam IS NOT NULL THEN
        IF v_fam->>'byopCustomerRef' IS NOT NULL AND v_fam->>'byopCustomerRef' <> '' THEN
            v_chargeable := true;
            v_processorKey := COALESCE(v_fam->>'byopProcessor', 'cardknox');
        ELSIF v_fam->>'stripeCustomerId' IS NOT NULL AND v_fam->>'stripeCustomerId' <> ''
              AND COALESCE((v_fam->>'cardOnFile')::boolean, false) THEN
            v_chargeable := true;
            v_processorKey := 'stripe';
        END IF;
        v_cardLabel := v_fam->>'paymentMethodLabel';
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
        'allowParentPaymentPlans', COALESCE((me #>> '{enrollSettings,allowParentPaymentPlans}')::boolean, false),
        'chargeable',         v_chargeable,
        'processorKey',       v_processorKey,
        'cardLabel',          v_cardLabel
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_balance(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_balance(uuid) TO authenticated;

-- ─── Sanity check after applying ───────────────────────────────────────────
--   select prosrc ilike '%familyKey%' as credits_payments_by_family_key
--     from pg_proc where proname = 'get_my_balance';
--   -- expect true. Then reload Link -> Payments: a family whose payments were
--   -- recorded manually or through hosted checkout should now show them
--   -- credited, and the balance should agree with Me -> Billing.
-- ============================================================================
