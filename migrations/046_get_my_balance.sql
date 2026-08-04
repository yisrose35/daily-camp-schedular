-- =============================================================================
-- Migration 046: get_my_balance — a parent sees ONLY their own family's balance
--
-- The parent portal (Campistry Link) needs to show a family their tuition
-- balance and payment history so they can pay online. Financial data lives in
-- camp_state_kv.campistryMe (enrollments + finance.payments) which a parent must
-- never read wholesale (it holds every family's money). This SECURITY DEFINER
-- RPC resolves the calling parent via their active invite, then returns only the
-- numbers for THEIR campers — mirroring how the office computes them (net tuition
-- from enrollments, minus settled payments; pending/failed excluded).
--
-- Matches the parent-resolution + camp_state_kv-read pattern in migration 026.
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
    pays      jsonb;
    v_names   jsonb;
    rec       record;
    e         jsonb;
    p         jsonb;
    v_billed  numeric := 0;
    v_paid    numeric := 0;
    v_tuition numeric;
    v_disc    numeric;
    v_amt     numeric;
    v_status  text;
    v_family  text;
    v_enrIds  jsonb := '[]'::jsonb;
    v_history jsonb := '[]'::jsonb;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    SELECT * INTO inv
    FROM link_parent_invites
    WHERE user_id = caller AND status = 'active'
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
    enr  := COALESCE(me->'enrollments', '{}'::jsonb);
    pays := COALESCE(me->'finance'->'payments', '[]'::jsonb);

    -- Net tuition for the parent's enrolled campers.
    FOR rec IN SELECT key, value FROM jsonb_each(enr) LOOP
        e := rec.value;
        IF (v_names ? (e->>'camperName')) AND (e->>'status') IN ('enrolled', 'accepted') THEN
            v_tuition := COALESCE((e->>'sessionTuition')::numeric, 0);
            v_disc := 0;
            IF e->'discount' IS NOT NULL AND e->'discount' <> 'null'::jsonb THEN
                v_disc := COALESCE((e->'discount'->>'amt')::numeric, 0)
                        + ROUND(v_tuition * COALESCE((e->'discount'->>'pct')::numeric, 0) / 100);
            END IF;
            v_billed := v_billed + (v_tuition - v_disc);
            v_enrIds := v_enrIds || to_jsonb(rec.key);
        END IF;
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
        'success',    true,
        'camp_id',    inv.camp_id,
        'familyName', COALESCE(v_names->>0, inv.parent_name),
        'campers',    v_names,
        'billed',     v_billed,
        'paid',       v_paid,
        'balance',    v_billed - v_paid,
        'payments',   v_history
    );
END;
$$;
REVOKE ALL ON FUNCTION public.get_my_balance(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_balance(uuid) TO authenticated;
