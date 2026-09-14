-- ============================================================================
-- Migration 147: clear stale saved cards when a camp (re)connects a processor
--
-- A saved card is tied to the processor it was tokenized on — a Cardknox
-- token can't be charged through Banquest, a Stripe customer can't be charged
-- through a BYOP gateway, etc. When a camp switches processors, every
-- family's/camper's saved card from the OLD processor becomes dead weight:
-- it still shows as "card on file" in Link and Me, and any charge against it
-- just declines. This function scrubs those mismatched cards so the only card
-- ever shown/charged is one that actually works on the camp's CURRENT
-- processor. Cards that DO match the current processor are left untouched
-- (so reconnecting the same processor is a no-op).
--
-- admin-connect-processor calls this (best-effort) right after a successful
-- connect. It's also safe to call by hand for a camp that switched before
-- this existed:
--     select _admin_clear_stale_byop_cards('<camp id>'::uuid, 'banquest');
--
-- service_role ONLY. Idempotent.
-- ============================================================================
CREATE OR REPLACE FUNCTION public._admin_clear_stale_byop_cards(p_camp_id uuid, p_processor_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_me      jsonb;
    v_snacks  jsonb;
    v_fams    jsonb := '{}'::jsonb;
    v_accts   jsonb := '{}'::jsonb;
    rec       record;
    v_obj     jsonb;
    v_ar      jsonb;
    v_pms     jsonb;
    v_famsChanged   boolean := false;
    v_acctsChanged  boolean := false;
    v_cleared int := 0;
BEGIN
    -- ── Tuition cards on each family (campistryMe.families) ──────────────────
    SELECT value INTO v_me FROM camp_state_kv WHERE camp_id = p_camp_id AND key = 'campistryMe';
    IF v_me IS NOT NULL AND jsonb_typeof(v_me->'families') = 'object' THEN
        FOR rec IN SELECT key, value FROM jsonb_each(v_me->'families') LOOP
            v_obj := rec.value;

            -- Keep only saved methods that belong to the current processor.
            IF jsonb_typeof(v_obj->'savedPaymentMethods') = 'array' THEN
                SELECT COALESCE(jsonb_agg(m), '[]'::jsonb) INTO v_pms
                  FROM jsonb_array_elements(v_obj->'savedPaymentMethods') m
                 WHERE (m->>'processor') = p_processor_key;
                IF v_pms IS DISTINCT FROM (v_obj->'savedPaymentMethods') THEN
                    v_obj := jsonb_set(v_obj, '{savedPaymentMethods}', v_pms, true);
                    v_famsChanged := true;
                END IF;
            END IF;

            -- Strip the legacy single-slot fields when they point at a
            -- DIFFERENT processor than the one now connected (a stale BYOP
            -- token, or a Stripe customer on a now-BYOP camp).
            IF ( (v_obj ? 'byopProcessor') AND (v_obj->>'byopProcessor') IS DISTINCT FROM p_processor_key )
               OR ( COALESCE(v_obj->>'stripeCustomerId','') <> '' AND p_processor_key <> 'stripe' )
            THEN
                v_obj := (((((( v_obj - 'byopCustomerRef') - 'byopProcessor') - 'cardSavedDate')
                            - 'stripeCustomerId') - 'stripePaymentMethodId') - 'paymentMethodLabel') - 'paymentMethodType';
                v_obj := jsonb_set(
                    v_obj, '{cardOnFile}',
                    CASE WHEN jsonb_typeof(v_obj->'savedPaymentMethods') = 'array'
                              AND jsonb_array_length(v_obj->'savedPaymentMethods') > 0
                         THEN 'true'::jsonb ELSE 'false'::jsonb END,
                    true);
                v_famsChanged := true;
                v_cleared := v_cleared + 1;
            END IF;

            v_fams := jsonb_set(v_fams, ARRAY[rec.key], v_obj, true);
        END LOOP;

        IF v_famsChanged THEN
            v_me := jsonb_set(v_me, '{families}', v_fams, true);
            UPDATE camp_state_kv SET value = v_me, updated_at = now()
             WHERE camp_id = p_camp_id AND key = 'campistryMe';
        END IF;
    END IF;

    -- ── Canteen auto-reload cards (campistrySnacks.accounts[*].autoReload) ────
    SELECT value INTO v_snacks FROM camp_state_kv WHERE camp_id = p_camp_id AND key = 'campistrySnacks';
    IF v_snacks IS NOT NULL AND jsonb_typeof(v_snacks->'accounts') = 'object' THEN
        FOR rec IN SELECT key, value FROM jsonb_each(v_snacks->'accounts') LOOP
            v_obj := rec.value;
            v_ar  := v_obj->'autoReload';
            IF v_ar IS NOT NULL AND jsonb_typeof(v_ar) = 'object'
               AND ( ( (v_ar ? 'byopProcessor') AND (v_ar->>'byopProcessor') IS DISTINCT FROM p_processor_key )
                     OR ( COALESCE(v_ar->>'stripeCustomerId','') <> '' AND p_processor_key <> 'stripe' ) )
            THEN
                v_ar := ((((( v_ar - 'byopCustomerRef') - 'byopProcessor') - 'stripeCustomerId')
                          - 'stripePaymentMethodId') - 'paymentMethodLabel') - 'paymentMethodType';
                v_ar := jsonb_set(v_ar, '{cardOnFile}', 'false'::jsonb, true);
                v_obj := jsonb_set(v_obj, '{autoReload}', v_ar, true);
                v_acctsChanged := true;
                v_cleared := v_cleared + 1;
            END IF;
            v_accts := jsonb_set(v_accts, ARRAY[rec.key], v_obj, true);
        END LOOP;

        IF v_acctsChanged THEN
            v_snacks := jsonb_set(v_snacks, '{accounts}', v_accts, true);
            UPDATE camp_state_kv SET value = v_snacks, updated_at = now()
             WHERE camp_id = p_camp_id AND key = 'campistrySnacks';
        END IF;
    END IF;

    RETURN jsonb_build_object('success', true, 'cleared', v_cleared);
END;
$$;

REVOKE ALL ON FUNCTION public._admin_clear_stale_byop_cards(uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._admin_clear_stale_byop_cards(uuid, text) TO service_role;

-- ─── One-time cleanup for a camp that switched BEFORE this existed ──────────
-- (e.g. the Banquest sandbox test camp):
--   select _admin_clear_stale_byop_cards('<TEST_CAMP_ID>'::uuid, 'banquest');
--   -- returns {"success":true,"cleared":N}; families/campers then show no
--   -- stale card and can add a fresh one on the current processor.
-- ============================================================================
