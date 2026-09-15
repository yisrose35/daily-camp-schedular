-- ============================================================================
-- Migration 151: backfill savedPaymentMethods[] from the legacy single-slot
-- card fields.
--
-- Migration 139 made families[fk].savedPaymentMethods the real LIST of saved
-- cards, and get_my_saved_payment_methods (the only thing behind Link's Cards
-- tab) reads NOTHING else. But payments-save-method was writing only the legacy
-- single-slot fields (byopCustomerRef / cardOnFile / paymentMethodLabel), so a
-- card saved through Campistry's own card page was fully saved and fully
-- chargeable — autopay could use it — yet invisible in Cards. That writer is
-- fixed to append to the array going forward; this backfills the cards saved
-- before the fix so nobody has to re-enter one.
--
-- For each family that has a legacy BYOP token but no array entry carrying that
-- same token, append one. Entry shape matches cardknox-webhook / stripe-webhook
-- exactly: {id, type, processor, token, last4, label, addedDate, isDefault}.
-- The backfilled card becomes the default only when the array was empty, so a
-- family that already has cards keeps whichever default it had.
--
-- Stripe-only families are skipped: their legacy fields hold a Stripe customer
-- + payment-method pair rather than a single BYOP token, and stripe-webhook
-- already appends to the array for them.
--
-- service_role ONLY. Idempotent — re-running adds nothing, because the second
-- pass finds the token already present.
-- ============================================================================
CREATE OR REPLACE FUNCTION public._admin_backfill_saved_payment_methods(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_me     jsonb;
    v_fams   jsonb := '{}'::jsonb;
    rec      record;
    v_fam    jsonb;
    v_pms    jsonb;
    v_token  text;
    v_label  text;
    v_last4  text;
    v_added  text;
    v_proc   text;
    v_changed boolean := false;
    v_added_n int := 0;
BEGIN
    SELECT value INTO v_me FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe';
    IF v_me IS NULL OR jsonb_typeof(v_me->'families') <> 'object' THEN
        RETURN jsonb_build_object('success', true, 'added', 0, 'note', 'no families');
    END IF;

    FOR rec IN SELECT key, value FROM jsonb_each(v_me->'families') LOOP
        v_fam   := rec.value;
        v_token := NULLIF(btrim(COALESCE(v_fam->>'byopCustomerRef', '')), '');
        v_pms   := CASE WHEN jsonb_typeof(v_fam->'savedPaymentMethods') = 'array'
                        THEN v_fam->'savedPaymentMethods' ELSE '[]'::jsonb END;

        -- Only families with a legacy BYOP token whose token isn't already listed.
        IF v_token IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(v_pms) m WHERE m->>'token' = v_token
        ) THEN
            v_proc  := COALESCE(NULLIF(btrim(COALESCE(v_fam->>'byopProcessor', '')), ''), 'banquest');
            v_label := NULLIF(btrim(COALESCE(v_fam->>'paymentMethodLabel', '')), '');
            -- Recover the last 4 from whatever the label recorded ("•••• 4242",
            -- "Card ···· 4242"); blank if the label never carried digits.
            v_last4 := NULLIF(right(regexp_replace(COALESCE(v_label, ''), '[^0-9]', '', 'g'), 4), '');
            v_added := COALESCE(NULLIF(btrim(COALESCE(v_fam->>'cardSavedDate', '')), ''), now()::text);

            v_pms := v_pms || jsonb_build_object(
                'id',        'pm_' || replace(gen_random_uuid()::text, '-', ''),
                'type',      'card',
                'processor', v_proc,
                'token',     v_token,
                'last4',     COALESCE(v_last4, ''),
                'label',     COALESCE(v_label, CASE WHEN v_last4 IS NOT NULL
                                                    THEN 'Card ···· ' || v_last4
                                                    ELSE 'Card on file' END),
                'addedDate', v_added,
                'isDefault', (jsonb_array_length(v_pms) = 0)
            );
            v_fam := jsonb_set(v_fam, '{savedPaymentMethods}', v_pms, true);
            -- Cards exist now, so the flag Link reads must agree.
            v_fam := jsonb_set(v_fam, '{cardOnFile}', 'true'::jsonb, true);
            v_changed := true;
            v_added_n := v_added_n + 1;
        END IF;

        v_fams := jsonb_set(v_fams, ARRAY[rec.key], v_fam, true);
    END LOOP;

    IF v_changed THEN
        v_me := jsonb_set(v_me, '{families}', v_fams, true);
        UPDATE camp_state_kv SET value = v_me, updated_at = now()
         WHERE camp_id = p_camp_id AND key = 'campistryMe';
    END IF;

    RETURN jsonb_build_object('success', true, 'added', v_added_n);
END;
$$;

REVOKE ALL ON FUNCTION public._admin_backfill_saved_payment_methods(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._admin_backfill_saved_payment_methods(uuid) TO service_role;

-- ─── Run it for the camp whose card is missing from the Cards tab ───────────
--   select _admin_backfill_saved_payment_methods('<camp id>'::uuid);
--   -- returns {"success":true,"added":N}; reload Link -> Cards and the card
--   -- appears, with the same token autopay was already going to charge.
-- ============================================================================
