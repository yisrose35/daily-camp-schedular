-- =============================================================================
-- Migration 137: let a parent charge their ALREADY-SAVED card directly for a
-- one-off payment (tuition or canteen), instead of always being sent through
-- a brand-new hosted checkout page.
--
-- Confirmed this session: neither Pay Now (tuition) nor Add Funds (canteen)
-- has ever reused a saved card for a manual one-off payment, on EITHER
-- processor -- only the fully-automatic paths (charge-due-installments'
-- autopay, canteen-auto-reload) actually charge a saved token with no
-- checkout page. A parent who already saved a card (via autopay setup, or by
-- simply having paid once before) still has to re-enter it for every manual
-- payment. This closes that gap with a real "charge my card on file" action.
--
-- Two pieces:
--   1. get_my_balance gains `chargeable`/`processorKey`/`cardLabel` fields so
--      the client knows whether to offer the shortcut at all -- reuses this
--      function's EXISTING family resolution (auth.uid() -> link_parent_invites
--      -> families[] via camperIds), just adds the same byopCustomerRef-OR-
--      stripeCustomerId-and-cardOnFile check campistry_me.js's _famChargeable
--      already uses, so a parent never sees the shortcut when nothing would
--      actually be charged.
--   2. saved_card_charge_locks -- idempotency for the new charge-saved-card
--      edge function. A checkout-page charge is naturally deduped by the
--      processor's own transaction id; a direct "charge now" button has no
--      such page to dedupe against, so a client-generated idempotency key is
--      locked here BEFORE the gateway call, and the edge function reuses the
--      stored result on any retry/double-click instead of charging twice.
--      RLS enabled, zero client policies -- every access is from the
--      edge function's own service-role client, never a client request.
--
-- Idempotent -- safe to re-run.
-- =============================================================================

-- ─── 1. get_my_balance -- add chargeable/processorKey/cardLabel ────────────
-- Straight re-paste of migration 118's body (no logic changes to the existing
-- fields) plus the three new ones at the end.
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

-- ─── 2. saved_card_charge_locks -- idempotency for charge-saved-card ───────
CREATE TABLE IF NOT EXISTS saved_card_charge_locks (
    idempotency_key text PRIMARY KEY,
    camp_id         uuid NOT NULL,
    status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
    result          jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE saved_card_charge_locks ENABLE ROW LEVEL SECURITY;
-- No client-facing policies -- only ever touched by charge-saved-card's own
-- service-role client, same as cardknox_checkout_intents.

-- Best-effort housekeeping so this table doesn't grow forever -- a lock
-- older than a day is unambiguously done (charges settle in seconds, not
-- days), safe for the edge function to prune opportunistically. Not a cron
-- job; the edge function calls this on its way in.
CREATE OR REPLACE FUNCTION public._prune_saved_card_charge_locks()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    DELETE FROM saved_card_charge_locks WHERE created_at < now() - interval '1 day';
$$;
REVOKE ALL ON FUNCTION public._prune_saved_card_charge_locks() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._prune_saved_card_charge_locks() TO service_role;

-- ─── Sanity checks (run manually after applying) ───────────────────────────
--   select prosrc ilike '%chargeable%' from pg_proc where proname='get_my_balance';
--   -- expect true
--   select * from saved_card_charge_locks limit 1; -- expect empty table, no error
-- =============================================================================
