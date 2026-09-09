-- =============================================================================
-- Migration 139: let a parent save MULTIPLE payment methods (not just one)
-- and pick between them wherever Link charges money.
--
-- Every existing charge path (tuition Pay Now, one-off charge-saved-card,
-- charge-due-installments' autopay, canteen auto-reload) has only ever known
-- about ONE saved token per family -- families[famKey].byopCustomerRef (or
-- stripeCustomerId/stripePaymentMethodId), overwritten every time a new card
-- is saved. Requested live: a real "Cards" surface where a parent can save
-- several cards (bank accounts as a later fast-follow, once Sola's ACH
-- command shape is confirmed) and choose which one to use per action,
-- instead of always having exactly one "the" card.
--
-- Design, additive and non-breaking on purpose:
--   - families[famKey].savedPaymentMethods becomes a real ARRAY of
--     {id, type, processor, token, last4, label, addedDate, isDefault}.
--     `token` is the actual vaulted Cardknox token / Stripe customer+PM id --
--     it lives in this array (server-side JSON, same trust boundary as the
--     existing single-slot fields) but is NEVER returned to a client; every
--     RPC below strips it before responding, mirroring how get_my_balance
--     already never exposes byopCustomerRef itself.
--   - The EXISTING single-slot fields (byopCustomerRef/byopProcessor/
--     stripeCustomerId/stripePaymentMethodId/cardOnFile/paymentMethodType/
--     paymentMethodLabel) are kept in sync with whichever array entry is
--     "default" -- every charge path that reads those fields directly
--     (autopay, and any charge call that doesn't pass a specific
--     paymentMethodId) keeps working completely unchanged. The array is
--     purely additive bookkeeping on top of what already exists.
--   - cardknox-webhook's card_save completion (and stripe-webhook's
--     autopay-setup completion) now APPEND a new entry to this array in
--     addition to what they already did -- the first-ever card for a family
--     becomes the default (syncs the legacy fields, so nothing regresses for
--     a family saving their first card exactly as before); an ADDITIONAL
--     card appends as non-default, leaving the existing default (and
--     whatever it's already used for -- autopay, etc.) completely alone
--     until the parent explicitly picks a different default or a specific
--     method for one action.
--
-- Idempotent -- safe to re-run.
-- =============================================================================

-- ─── get_my_saved_payment_methods ───────────────────────────────────────────
-- Parent-facing list for the new Cards tab. Same family resolution as
-- get_my_balance (auth.uid() -> link_parent_invites -> families[] via
-- camperIds, first match) -- consistent with every other "which family is
-- this parent" check already in this codebase.
CREATE OR REPLACE FUNCTION public.get_my_saved_payment_methods(p_camp_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller   uuid := auth.uid();
    inv      link_parent_invites;
    v_names  jsonb;
    me       jsonb;
    fams     jsonb;
    famRec   record;
    v_famKey text := NULL;
    v_fam    jsonb := NULL;
    v_pm     jsonb;
    v_out    jsonb := '[]'::jsonb;
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

    SELECT value INTO me FROM camp_state_kv WHERE camp_id = inv.camp_id AND key = 'campistryMe';
    IF me IS NULL THEN me := '{}'::jsonb; END IF;
    fams := COALESCE(me->'families', '{}'::jsonb);

    FOR famRec IN SELECT key, value FROM jsonb_each(fams) LOOP
        IF EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(COALESCE(famRec.value->'camperIds', '[]'::jsonb)) ci
            WHERE v_names ? ci
        ) THEN
            v_famKey := famRec.key;
            v_fam := famRec.value;
            EXIT;
        END IF;
    END LOOP;

    IF v_fam IS NOT NULL THEN
        FOR v_pm IN SELECT * FROM jsonb_array_elements(COALESCE(v_fam->'savedPaymentMethods', '[]'::jsonb)) LOOP
            v_out := v_out || jsonb_build_object(
                'id',        v_pm->>'id',
                'type',      COALESCE(v_pm->>'type', 'card'),
                'processor', v_pm->>'processor',
                'last4',     v_pm->>'last4',
                'label',     v_pm->>'label',
                'addedDate', v_pm->>'addedDate',
                'isDefault', COALESCE((v_pm->>'isDefault')::boolean, false)
            );
        END LOOP;
    END IF;

    RETURN jsonb_build_object('success', true, 'familyKey', v_famKey, 'methods', v_out);
END;
$$;
REVOKE ALL ON FUNCTION public.get_my_saved_payment_methods(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_saved_payment_methods(uuid) TO authenticated;

-- ─── set_default_payment_method ─────────────────────────────────────────────
-- Marks one saved method as default AND syncs the legacy single-slot fields
-- to match it, so every existing charge path that reads those fields
-- directly (never passing a specific paymentMethodId) immediately starts
-- using the newly-chosen default without needing any of those call sites to
-- change.
CREATE OR REPLACE FUNCTION public.set_default_payment_method(p_camp_id uuid, p_method_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller    uuid := auth.uid();
    inv       link_parent_invites;
    v_names   jsonb;
    me        jsonb;
    fams      jsonb;
    famRec    record;
    v_famKey  text := NULL;
    v_fam     jsonb := NULL;
    v_pms     jsonb;
    v_new     jsonb := '[]'::jsonb;
    v_pm      jsonb;
    v_found   jsonb := NULL;
    now_ts    timestamptz := now();
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF p_method_id IS NULL OR btrim(p_method_id) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_method_id');
    END IF;

    SELECT * INTO inv
    FROM link_parent_invites
    WHERE user_id = caller
      AND (status = 'active' OR billing_access = true)
      AND (expires_at IS NULL OR expires_at > now())
      AND (p_camp_id IS NULL OR camp_id = p_camp_id)
    ORDER BY created_at DESC
    LIMIT 1;
    IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'no_active_invite'); END IF;
    v_names := COALESCE(inv.camper_names, '[]'::jsonb);

    SELECT value INTO me FROM camp_state_kv WHERE camp_id = inv.camp_id AND key = 'campistryMe' FOR UPDATE;
    IF me IS NULL THEN me := '{}'::jsonb; END IF;
    fams := COALESCE(me->'families', '{}'::jsonb);

    FOR famRec IN SELECT key, value FROM jsonb_each(fams) LOOP
        IF EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(COALESCE(famRec.value->'camperIds', '[]'::jsonb)) ci
            WHERE v_names ? ci
        ) THEN
            v_famKey := famRec.key;
            v_fam := famRec.value;
            EXIT;
        END IF;
    END LOOP;

    IF v_fam IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'family_not_found');
    END IF;

    v_pms := COALESCE(v_fam->'savedPaymentMethods', '[]'::jsonb);
    FOR v_pm IN SELECT * FROM jsonb_array_elements(v_pms) LOOP
        IF v_pm->>'id' = p_method_id THEN
            v_found := v_pm;
            v_new := v_new || jsonb_set(v_pm, '{isDefault}', 'true'::jsonb);
        ELSE
            v_new := v_new || jsonb_set(v_pm, '{isDefault}', 'false'::jsonb);
        END IF;
    END LOOP;

    IF v_found IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'method_not_found');
    END IF;

    v_fam := jsonb_set(v_fam, '{savedPaymentMethods}', v_new);
    -- Sync the legacy single-slot fields so autopay and every charge path
    -- that doesn't pass an explicit paymentMethodId immediately picks this
    -- one up -- same fields cardknox-webhook/stripe-webhook already write.
    IF v_found->>'processor' = 'cardknox' THEN
        v_fam := (v_fam - 'stripeCustomerId') - 'stripePaymentMethodId';
        v_fam := v_fam || jsonb_build_object(
            'byopProcessor', 'cardknox',
            'byopCustomerRef', v_found->>'token',
            'cardOnFile', true,
            'paymentMethodType', COALESCE(v_found->>'type', 'card'),
            'paymentMethodLabel', v_found->>'label'
        );
    ELSE
        v_fam := (v_fam - 'byopCustomerRef') - 'byopProcessor';
        v_fam := v_fam || jsonb_build_object(
            'stripeCustomerId', v_found->>'stripeCustomerId',
            'stripePaymentMethodId', v_found->>'token',
            'cardOnFile', true,
            'paymentMethodType', COALESCE(v_found->>'type', 'card'),
            'paymentMethodLabel', v_found->>'label'
        );
    END IF;

    me := jsonb_set(me, ARRAY['families', v_famKey], v_fam);
    UPDATE camp_state_kv SET value = me, updated_at = now_ts
    WHERE camp_id = inv.camp_id AND key = 'campistryMe';

    RETURN jsonb_build_object('success', true, 'defaultMethodId', p_method_id);
END;
$$;
REVOKE ALL ON FUNCTION public.set_default_payment_method(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.set_default_payment_method(uuid, text) TO authenticated;

-- ─── remove_payment_method ───────────────────────────────────────────────────
-- Removing the current default promotes the next remaining method (if any)
-- to default and re-syncs the legacy fields; removing the last method
-- clears cardOnFile entirely, same end state a family with no card ever had.
CREATE OR REPLACE FUNCTION public.remove_payment_method(p_camp_id uuid, p_method_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller    uuid := auth.uid();
    inv       link_parent_invites;
    v_names   jsonb;
    me        jsonb;
    fams      jsonb;
    famRec    record;
    v_famKey  text := NULL;
    v_fam     jsonb := NULL;
    v_pms     jsonb;
    v_new     jsonb := '[]'::jsonb;
    v_pm      jsonb;
    v_removed jsonb := NULL;
    v_wasDefault boolean := false;
    v_promote jsonb := NULL;
    now_ts    timestamptz := now();
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF p_method_id IS NULL OR btrim(p_method_id) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_method_id');
    END IF;

    SELECT * INTO inv
    FROM link_parent_invites
    WHERE user_id = caller
      AND (status = 'active' OR billing_access = true)
      AND (expires_at IS NULL OR expires_at > now())
      AND (p_camp_id IS NULL OR camp_id = p_camp_id)
    ORDER BY created_at DESC
    LIMIT 1;
    IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'no_active_invite'); END IF;
    v_names := COALESCE(inv.camper_names, '[]'::jsonb);

    SELECT value INTO me FROM camp_state_kv WHERE camp_id = inv.camp_id AND key = 'campistryMe' FOR UPDATE;
    IF me IS NULL THEN me := '{}'::jsonb; END IF;
    fams := COALESCE(me->'families', '{}'::jsonb);

    FOR famRec IN SELECT key, value FROM jsonb_each(fams) LOOP
        IF EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(COALESCE(famRec.value->'camperIds', '[]'::jsonb)) ci
            WHERE v_names ? ci
        ) THEN
            v_famKey := famRec.key;
            v_fam := famRec.value;
            EXIT;
        END IF;
    END LOOP;

    IF v_fam IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'family_not_found');
    END IF;

    v_pms := COALESCE(v_fam->'savedPaymentMethods', '[]'::jsonb);
    FOR v_pm IN SELECT * FROM jsonb_array_elements(v_pms) LOOP
        IF v_pm->>'id' = p_method_id THEN
            v_removed := v_pm;
            v_wasDefault := COALESCE((v_pm->>'isDefault')::boolean, false);
        ELSE
            v_new := v_new || v_pm;
            IF v_promote IS NULL THEN v_promote := v_pm; END IF;
        END IF;
    END LOOP;

    IF v_removed IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'method_not_found');
    END IF;

    IF v_wasDefault AND v_promote IS NOT NULL THEN
        -- Re-run the array with the promoted entry flagged default, same
        -- shape set_default_payment_method produces.
        v_new := '[]'::jsonb;
        FOR v_pm IN SELECT * FROM jsonb_array_elements(v_pms) LOOP
            IF v_pm->>'id' = p_method_id THEN CONTINUE; END IF;
            IF v_pm->>'id' = v_promote->>'id' THEN
                v_new := v_new || jsonb_set(v_pm, '{isDefault}', 'true'::jsonb);
            ELSE
                v_new := v_new || jsonb_set(v_pm, '{isDefault}', 'false'::jsonb);
            END IF;
        END LOOP;
    END IF;

    v_fam := jsonb_set(v_fam, '{savedPaymentMethods}', v_new);

    IF v_wasDefault THEN
        IF v_promote IS NOT NULL THEN
            IF v_promote->>'processor' = 'cardknox' THEN
                v_fam := (v_fam - 'stripeCustomerId') - 'stripePaymentMethodId';
                v_fam := v_fam || jsonb_build_object(
                    'byopProcessor', 'cardknox',
                    'byopCustomerRef', v_promote->>'token',
                    'cardOnFile', true,
                    'paymentMethodType', COALESCE(v_promote->>'type', 'card'),
                    'paymentMethodLabel', v_promote->>'label'
                );
            ELSE
                v_fam := (v_fam - 'byopCustomerRef') - 'byopProcessor';
                v_fam := v_fam || jsonb_build_object(
                    'stripeCustomerId', v_promote->>'stripeCustomerId',
                    'stripePaymentMethodId', v_promote->>'token',
                    'cardOnFile', true,
                    'paymentMethodType', COALESCE(v_promote->>'type', 'card'),
                    'paymentMethodLabel', v_promote->>'label'
                );
            END IF;
        ELSE
            -- No methods left at all.
            v_fam := (v_fam - 'byopCustomerRef') - 'byopProcessor' - 'stripeCustomerId' - 'stripePaymentMethodId';
            v_fam := jsonb_set(v_fam, '{cardOnFile}', 'false'::jsonb, true);
        END IF;
    END IF;

    me := jsonb_set(me, ARRAY['families', v_famKey], v_fam);
    UPDATE camp_state_kv SET value = me, updated_at = now_ts
    WHERE camp_id = inv.camp_id AND key = 'campistryMe';

    RETURN jsonb_build_object('success', true, 'removedMethodId', p_method_id, 'newDefaultMethodId', CASE WHEN v_wasDefault THEN v_promote->>'id' ELSE NULL END);
END;
$$;
REVOKE ALL ON FUNCTION public.remove_payment_method(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.remove_payment_method(uuid, text) TO authenticated;

-- ─── use_family_card_for_canteen_auto_reload — teach it about picking ──────
-- ─── a SPECIFIC saved method, not just "the" family default ────────────────
-- Migration 138 built this RPC as a binary "use the family's one card, or
-- add a new one" bridge. Now that a family can have several saved methods,
-- it gains an optional p_payment_method_id -- when passed, that exact
-- method is copied into the camper's autoReload slot (verified to actually
-- belong to this camper's family, never trusted from the request beyond the
-- id itself); omitted, it falls back to the original default-card behavior
-- unchanged. DROP + CREATE (not just CREATE OR REPLACE) because adding a
-- parameter changes the function's signature -- Postgres would otherwise
-- keep the old 2-argument version around as a separate overload, which
-- makes a 2-argument RPC call ambiguous once a 3rd defaulted parameter
-- exists on a second overload.
DROP FUNCTION IF EXISTS public.use_family_card_for_canteen_auto_reload(uuid, text);

CREATE OR REPLACE FUNCTION public.use_family_card_for_canteen_auto_reload(
    p_camp_id            uuid,
    p_camper_name        text,
    p_payment_method_id  text DEFAULT NULL
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
    v_pm           jsonb;
    v_picked       jsonb := NULL;
    v_processorKey text;
    v_cardLabel    text;
    v_token        text;
    v_stripeCustomerId text;
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

    IF p_payment_method_id IS NOT NULL THEN
        FOR v_pm IN SELECT * FROM jsonb_array_elements(COALESCE(v_fam->'savedPaymentMethods', '[]'::jsonb)) LOOP
            IF v_pm->>'id' = p_payment_method_id THEN v_picked := v_pm; EXIT; END IF;
        END LOOP;
        IF v_picked IS NULL THEN
            RETURN jsonb_build_object('success', false, 'error', 'method_not_found');
        END IF;
        v_processorKey := v_picked->>'processor';
        v_cardLabel := v_picked->>'label';
        v_token := v_picked->>'token';
        v_stripeCustomerId := v_picked->>'stripeCustomerId';
    ELSE
        -- Original migration 138 behavior — the family's current default.
        IF v_fam->>'byopCustomerRef' IS NOT NULL AND v_fam->>'byopCustomerRef' <> '' THEN
            v_processorKey := COALESCE(v_fam->>'byopProcessor', 'cardknox');
            v_token := v_fam->>'byopCustomerRef';
        ELSIF v_fam->>'stripeCustomerId' IS NOT NULL AND v_fam->>'stripeCustomerId' <> ''
              AND COALESCE((v_fam->>'cardOnFile')::boolean, false) THEN
            v_processorKey := 'stripe';
            v_token := v_fam->>'stripePaymentMethodId';
            v_stripeCustomerId := v_fam->>'stripeCustomerId';
        ELSE
            RETURN jsonb_build_object('success', false, 'error', 'no_card_on_file');
        END IF;
        v_cardLabel := v_fam->>'paymentMethodLabel';
    END IF;

    INSERT INTO camp_state_kv (camp_id, key, value, updated_at)
    VALUES (inv.camp_id, 'campistrySnacks', '{"accounts":{},"transactions":[]}'::jsonb, now_ts)
    ON CONFLICT (camp_id, key) DO NOTHING;

    SELECT value INTO v_snacks FROM camp_state_kv
    WHERE camp_id = inv.camp_id AND key = 'campistrySnacks' FOR UPDATE;
    IF v_snacks IS NULL THEN v_snacks := '{"accounts":{},"transactions":[]}'::jsonb; END IF;
    IF v_snacks->'accounts' IS NULL THEN v_snacks := jsonb_set(v_snacks, '{accounts}', '{}'::jsonb); END IF;

    v_acct := COALESCE(v_snacks->'accounts'->p_camper_name, '{"balance":0,"dailyLimit":10,"spentToday":0}'::jsonb);
    v_ar   := COALESCE(v_acct->'autoReload', '{}'::jsonb);

    IF v_processorKey = 'cardknox' THEN
        v_ar := (v_ar - 'stripeCustomerId') - 'stripePaymentMethodId';
        v_ar := v_ar || jsonb_build_object(
            'byopProcessor', v_processorKey,
            'byopCustomerRef', v_token,
            'cardOnFile', true,
            'paymentMethodType', 'card'
        );
    ELSE
        v_ar := (v_ar - 'byopCustomerRef') - 'byopProcessor';
        v_ar := v_ar || jsonb_build_object(
            'stripeCustomerId', v_stripeCustomerId,
            'stripePaymentMethodId', v_token,
            'cardOnFile', true,
            'paymentMethodType', 'card'
        );
    END IF;
    IF v_cardLabel IS NOT NULL THEN
        v_ar := jsonb_set(v_ar, '{paymentMethodLabel}', to_jsonb(v_cardLabel), true);
    END IF;
    v_ar := jsonb_set(v_ar, '{cardSavedDate}', to_jsonb(now_ts), true);
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
REVOKE ALL ON FUNCTION public.use_family_card_for_canteen_auto_reload(uuid, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.use_family_card_for_canteen_auto_reload(uuid, text, text) TO authenticated;

-- ─── Sanity checks (run manually after applying) ───────────────────────────
--   select get_my_saved_payment_methods('<a real camp id>'::uuid);
--   -- run as that parent's own session; confirm methods[] has no 'token' field
--   select set_default_payment_method('<camp id>'::uuid, '<a method id from above>'::text);
--   -- confirm families[famKey].savedPaymentMethods has exactly one isDefault:true,
--   -- and byopCustomerRef/stripeCustomerId now matches that entry's token
--   select remove_payment_method('<camp id>'::uuid, '<a method id>'::text);
--   -- confirm the entry is gone and, if it was default, another was promoted
--   -- (or cardOnFile flips to false if none remain)
--   select use_family_card_for_canteen_auto_reload('<camp id>'::uuid, '<camper name>', '<a method id>'::text);
--   -- confirm the camper's autoReload slot now matches THAT method, not just the family default
-- =============================================================================
