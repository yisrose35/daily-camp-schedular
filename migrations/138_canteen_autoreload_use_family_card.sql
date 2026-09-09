-- =============================================================================
-- Migration 138: let a parent reuse their FAMILY's already-saved card for
-- canteen auto-reload, instead of always being sent through a brand-new
-- card-entry page even when a card is already on file.
--
-- Canteen auto-reload's card lives on
-- campistrySnacks.accounts[camperName].autoReload (per-CAMPER, migration 109)
-- -- a completely separate slot from the family's own byopCustomerRef/
-- stripeCustomerId (used by tuition Pay Now, charge-saved-card, and one-off
-- canteen deposits, migration 137). That's why a parent who already has a
-- family card on file for those still had to add a NEW card just for
-- auto-reload -- the two token slots have never been connected. Reported
-- live: "I already have a card on file so we need [to ask] if the user
-- wants to use the same one or add a different one." This adds the RPC that
-- copies the family's existing token into the camper's autoReload slot on
-- request, instead of forcing a fresh card-entry round trip every time.
--
-- Resolution mirrors get_my_balance's own family lookup (auth.uid() ->
-- link_parent_invites -> families[] via camperIds), but scoped to the ONE
-- camper being set up rather than "the first family on this invite" --
-- correct even for a parent whose kids sit in different family records,
-- which get_my_balance's own single-family shortcut doesn't guarantee.
--
-- Idempotent -- safe to re-run.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.use_family_card_for_canteen_auto_reload(
    p_camp_id     uuid,
    p_camper_name text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller         uuid := auth.uid();
    inv            link_parent_invites;
    me             jsonb;
    fams           jsonb;
    famRec         record;
    v_fam          jsonb := NULL;
    v_snacks       jsonb;
    v_acct         jsonb;
    v_ar           jsonb;
    v_processorKey text;
    v_cardLabel    text;
    now_ts         timestamptz := now();
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF p_camper_name IS NULL OR btrim(p_camper_name) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_camper');
    END IF;

    SELECT * INTO inv
    FROM link_parent_invites
    WHERE user_id = caller AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
      AND (p_camp_id IS NULL OR camp_id = p_camp_id)
    ORDER BY created_at DESC
    LIMIT 1;
    IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'no_active_invite'); END IF;

    IF inv.camper_names IS NOT NULL AND NOT (inv.camper_names ? p_camper_name) THEN
        RETURN jsonb_build_object('success', false, 'error', 'camper_not_on_invite');
    END IF;

    SELECT value INTO me FROM camp_state_kv WHERE camp_id = inv.camp_id AND key = 'campistryMe';
    IF me IS NULL THEN me := '{}'::jsonb; END IF;
    fams := COALESCE(me->'families', '{}'::jsonb);

    -- Find the family that actually contains THIS camper -- not just the
    -- first family on the invite (fine for get_my_balance's single aggregate
    -- balance view, wrong here where attaching the wrong family's card to
    -- this camper's auto-reload would be a real money-routing mistake).
    FOR famRec IN SELECT key, value FROM jsonb_each(fams) LOOP
        IF EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(COALESCE(famRec.value->'camperIds', '[]'::jsonb)) ci
            WHERE ci = p_camper_name
        ) THEN
            v_fam := famRec.value;
            EXIT;
        END IF;
    END LOOP;

    IF v_fam IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'family_not_found');
    END IF;

    -- Same chargeable check campistry_me.js's _famChargeable / get_my_balance
    -- (migration 137) already use -- a real vaulted BYOP token wins,
    -- otherwise a Stripe customer with cardOnFile set.
    IF v_fam->>'byopCustomerRef' IS NOT NULL AND v_fam->>'byopCustomerRef' <> '' THEN
        v_processorKey := COALESCE(v_fam->>'byopProcessor', 'cardknox');
    ELSIF v_fam->>'stripeCustomerId' IS NOT NULL AND v_fam->>'stripeCustomerId' <> ''
          AND COALESCE((v_fam->>'cardOnFile')::boolean, false) THEN
        v_processorKey := 'stripe';
    ELSE
        RETURN jsonb_build_object('success', false, 'error', 'no_card_on_file');
    END IF;
    v_cardLabel := v_fam->>'paymentMethodLabel';

    INSERT INTO camp_state_kv (camp_id, key, value, updated_at)
    VALUES (inv.camp_id, 'campistrySnacks', '{"accounts":{},"transactions":[]}'::jsonb, now_ts)
    ON CONFLICT (camp_id, key) DO NOTHING;

    SELECT value INTO v_snacks FROM camp_state_kv
    WHERE camp_id = inv.camp_id AND key = 'campistrySnacks' FOR UPDATE;
    IF v_snacks IS NULL THEN v_snacks := '{"accounts":{},"transactions":[]}'::jsonb; END IF;
    IF v_snacks->'accounts' IS NULL THEN v_snacks := jsonb_set(v_snacks, '{accounts}', '{}'::jsonb); END IF;

    v_acct := COALESCE(v_snacks->'accounts'->p_camper_name, '{"balance":0,"dailyLimit":10,"spentToday":0}'::jsonb);
    v_ar   := COALESCE(v_acct->'autoReload', '{}'::jsonb);

    -- Only ever touches the card/attempt bookkeeping fields -- never the
    -- parent's own trigger config (enabled/threshold*/schedule*), same
    -- separation set_canteen_auto_reload and the webhook's own card-save
    -- writes already keep. Clears whichever processor's fields don't apply
    -- so a camper can never end up with both a stale Stripe token and a new
    -- Cardknox one (or vice versa) after switching.
    IF v_processorKey = 'cardknox' THEN
        v_ar := (v_ar - 'stripeCustomerId') - 'stripePaymentMethodId';
        v_ar := v_ar || jsonb_build_object(
            'byopProcessor', v_processorKey,
            'byopCustomerRef', v_fam->>'byopCustomerRef',
            'cardOnFile', true,
            'paymentMethodType', COALESCE(v_fam->>'paymentMethodType', 'card')
        );
    ELSE
        v_ar := (v_ar - 'byopCustomerRef') - 'byopProcessor';
        v_ar := v_ar || jsonb_build_object(
            'stripeCustomerId', v_fam->>'stripeCustomerId',
            'stripePaymentMethodId', v_fam->>'stripePaymentMethodId',
            'cardOnFile', true,
            'paymentMethodType', COALESCE(v_fam->>'paymentMethodType', 'card')
        );
    END IF;
    IF v_cardLabel IS NOT NULL THEN
        v_ar := jsonb_set(v_ar, '{paymentMethodLabel}', to_jsonb(v_cardLabel), true);
    END IF;
    v_ar := jsonb_set(v_ar, '{cardSavedDate}', to_jsonb(now_ts), true);
    -- A fresh/reused card clears any prior decline state, same reasoning
    -- set_canteen_auto_reload already applies when re-enabling.
    v_ar := (v_ar - 'lastFailureDate') - 'lastFailureReason';
    v_ar := jsonb_set(v_ar, '{consecutiveFailures}', '0'::jsonb, true);

    v_acct   := jsonb_set(v_acct, '{autoReload}', v_ar, true);
    v_snacks := jsonb_set(v_snacks, ARRAY['accounts', p_camper_name], v_acct, true);
    UPDATE camp_state_kv SET value = v_snacks, updated_at = now_ts
    WHERE camp_id = inv.camp_id AND key = 'campistrySnacks';

    RETURN jsonb_build_object(
        'success', true,
        'processorKey', v_processorKey,
        'cardLabel', v_cardLabel,
        'autoReload', v_ar
    );
END;
$$;
REVOKE ALL ON FUNCTION public.use_family_card_for_canteen_auto_reload(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.use_family_card_for_canteen_auto_reload(uuid, text) TO authenticated;

-- ─── Sanity checks (run manually after applying) ───────────────────────────
--   select use_family_card_for_canteen_auto_reload('<a real camp id>'::uuid, '<a real camper name>');
--   -- run as that camper's own parent session (RLS/auth.uid() applies);
--   -- expect success:true, processorKey/cardLabel matching the family's own
--   -- saved card, and campistrySnacks.accounts[camper].autoReload.cardOnFile
--   -- now true without touching enabled/threshold*/schedule* fields.
--   select use_family_card_for_canteen_auto_reload('<a real camp id>'::uuid, 'Nobody Real');
--   -- expect success:false, error:'family_not_found'
-- =============================================================================
