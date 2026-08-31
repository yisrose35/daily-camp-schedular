-- =============================================================================
-- Migration 096: get_my_balance also returns familyKey + autopay status +
-- the monthly plan (if any), so the parent portal can show "set up autopay"
-- / "autopay is on" without a second round trip.
--
-- Builds on migration 095 (CREATE OR REPLACE carries that fix forward
-- unchanged) and adds:
--   - familyKey: the campistryMe.families key for this parent's family —
--     needed by stripe-setup-checkout, which writes the saved payment
--     method back onto that exact family record via stripe-webhook.
--   - cardOnFile / paymentMethodType / paymentMethodLabel: mirrors the same
--     fields Me -> Billing already reads, straight off the family record.
--   - plan: the monthly plan (if the office has set one up via Me -> Billing
--     -> Monthly Plan) — total, installments, autopay flag — so Link can
--     show the parent their schedule and offer "Set up autopay" when a plan
--     exists but no payment method is on file yet.
-- =============================================================================

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

    -- Net tuition for the parent's enrolled campers.
    FOR rec IN SELECT key, value FROM jsonb_each(enr) LOOP
        e := rec.value;
        IF (v_names ? (e->>'camperName')) AND (e->>'status') IN ('enrolled', 'accepted') THEN
            -- Prefer the session's current price; fall back to the frozen
            -- snapshot only when no session with that name exists anymore.
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

    -- Manual family-ledger charges and credits (Me → Billing → Add Charge /
    -- Issue Credit) — matched by camperIds overlap, the same key
    -- buildFamilyLedgers() itself uses. Also captures the matching family's
    -- own key + payment-method-on-file status + monthly plan (new in 096).
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

    -- Payments matched to those campers (by family name or enrollmentId).
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
        'plan',               v_fam->'plan'
    );
END;
$$;
REVOKE ALL ON FUNCTION public.get_my_balance(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_balance(uuid) TO authenticated;

-- ─── Sanity check ────────────────────────────────────────────────────────
-- select get_my_balance('<a real camp id>'::uuid); -- as that parent's own
--   session — confirm familyKey/cardOnFile/plan come back correctly for a
--   family the office has set up a Monthly Plan for in Me -> Billing.
-- =============================================================================
