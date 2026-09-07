-- =============================================================================
-- Migration 118: re-apply get_my_balance's `plans[]` output (fixes a migration
-- that silently didn't take).
--
-- Live debugging found that migration 116's redefinition of get_my_balance
-- never actually took effect in production, even though 116 was pasted into
-- the SQL Editor -- confirmed by querying pg_proc directly: the live function
-- body contained no `'plans'` key in its output. Whatever else in that same
-- paste succeeded (set_my_payment_plan's 3-arg signature from 116/117 is
-- correctly live), this one CREATE FUNCTION statement did not stick.
--
-- Real-world impact: a parent successfully created a payment plan via
-- set_my_payment_plan (it wrote correctly to families[fk].plans[]), but
-- get_my_balance -- still running its pre-116 body -- had no `plans` field in
-- its return value at all, so the Link parent app could never show that a
-- plan existed. The data was always correct; only the read was stale.
--
-- This migration is a straight re-paste of 116's get_my_balance (no logic
-- changes) -- run it standalone to force the fix to actually apply this time.
-- Safe to run even if 116 somehow HAD taken effect already: identical body,
-- CREATE OR REPLACE is a no-op in that case.
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

-- Sanity check after running: this should now return true.
--   select prosrc ilike '%''plans'',%' as returns_plans_array
--   from pg_proc where proname = 'get_my_balance';
