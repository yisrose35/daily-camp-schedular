-- ════════════════════════════════════════════════════════════════════════════
-- 214 — the eleven family-only writers stop locking the camp
-- ════════════════════════════════════════════════════════════════════════════
--
-- WHERE WE ARE.
--   208 ✓ payments → rows            (22 camps inSync, 1566.67 = 1566.67)
--   210 ✓ payment readers → rows     (sameOrderAndContent, 18 = 18)
--   211 ✓ families → rows            (65 live rows / 5 camps, 2000 = 2000)
--   212 ✓ family readers → rows      (5 readers moved, accessor_leaks false)
--   213 ✓ append_camp_payment        (still_locks_the_camp false, noDoubleCounting true)
--   214   (here) the ELEVEN writers that touch families but not payments
--   next  the SEVEN that touch both, then the load test measures the result
--
-- Every one of these took SELECT ... FOR UPDATE on camp_state_kv(campistryMe) to
-- edit ONE family inside it, so a card-on-file change queued behind a dunning
-- sweep behind a shop settlement, camp-wide. They now lock one family row.
--
-- ─── HOW THEY WERE CHANGED: BY RULE, NOT BY HAND ────────────────────────────
-- 2,375 lines across eighteen functions. Hand-transcribing that much money logic
-- is where a silent error hides: not a syntax error, a wrong number on a bill.
-- scripts/transform_family_writers.py applies the change by rule and reports
-- what it cannot handle, and tests/family_writers_row_truth.test.js diffs every
-- result below against the migration that last defined it, failing on any line
-- that is not part of an expected rule.
--
--   R6  drop the create-the-campistryMe-row preamble
--   R1  drop FOR UPDATE — from the campistryMe read ONLY
--   R2  <doc>->'families'             -> camp_families_object(camp)
--   R3  <doc> #> ARRAY['families', K] -> camp_family_for_update(camp, K)
--   R4  <doc> := jsonb_set(<doc>, ARRAY['families', K], V)
--                                     -> PERFORM camp_family_save(camp, K, V)
--   R4b the accumulator idiom: a whole replacement families object built in a
--       loop and written once becomes a save per iteration
--   R5  drop the UPDATE camp_state_kv for campistryMe
--
-- ─── TWO BUGS THE RULES CAUGHT BEFORE THIS FILE EXISTED ─────────────────────
--
-- 1. A BLANKET R1 WOULD HAVE LOST A LOCK THAT MATTERS. The first version stripped
--    FOR UPDATE from every camp_state_kv read. Three of those reads are of
--    campistryShop and campistrySnacks — in settle_shop_order and
--    use_family_card_for_canteen_auto_reload — and those blobs are STILL
--    read-modify-written, so it would have introduced a lost update on the shop
--    and canteen ledgers. Those two locks are deliberately still here. A rule
--    that looks uniform across a file is not uniform across the KEYS it touches.
--
-- 2. THE TWO _admin_* FUNCTIONS WOULD HAVE SILENTLY DONE NOTHING. They do not
--    save each family as they go; they build a whole replacement families object
--    in a loop and write the branch once. R4 does not match that, so R5 dropped
--    their write and nothing replaced it: a backfill that applies, reports
--    success, and changes no card on file. R4b handles the idiom, and the script
--    now fails any function that wrote families and saves none.
--
-- ─── WHAT IS NOT CHANGED ────────────────────────────────────────────────────
--   * Every DECISION in every function. Only where the family comes from and
--     where it goes. The diff test is what holds that.
--   * The campistryShop and campistrySnacks reads, writes and locks.
--   * Signatures, LANGUAGE, SECURITY DEFINER, search_path and existing grants —
--     CREATE OR REPLACE keeps the grants these functions already have.
--
-- SAFE TO RE-RUN. CREATE OR REPLACE only; reads nothing, writes nothing.
--
-- ─── HOW TO APPLY ───────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → New query → paste this whole file → Run.
-- You will get one confirmation row; locked_on_campistryme must read 0.
-- ════════════════════════════════════════════════════════════════════════════


-- ─── 0. preflight ───────────────────────────────────────────────────────────
DO $$
DECLARE
    v_missing text[] := ARRAY[]::text[];
BEGIN
    IF to_regclass('public.camp_families') IS NULL THEN
        v_missing := v_missing || 'table camp_families  → apply migrations/211_families_into_rows.sql first'::text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'camp_families_object') THEN
        v_missing := v_missing || 'camp_families_object()  → apply migrations/212_families_read_from_rows.sql first'::text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'camp_family_for_update') THEN
        v_missing := v_missing || 'camp_family_for_update()  → apply migrations/213_payments_row_truth.sql first'::text;
    END IF;
    IF array_length(v_missing, 1) > 0 THEN
        RAISE EXCEPTION 'migration 214 cannot be applied yet. Missing: %',
            array_to_string(v_missing, '; ');
    END IF;
END
$$;

-- ─── 1. merge_camp_family_fields (168) — rules: R1, R3, R4, R5
CREATE OR REPLACE FUNCTION public.merge_camp_family_fields(
    p_camp_id    uuid,
    p_family_key text,
    p_fields     jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    now_ts timestamptz := now();
    v_me   jsonb;
    v_fam  jsonb;
BEGIN
    IF p_camp_id IS NULL OR COALESCE(p_family_key, '') = ''
       OR p_fields IS NULL OR jsonb_typeof(p_fields) <> 'object' THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_arguments');
    END IF;

    SELECT value INTO v_me FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe';
    IF v_me IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_camp_data');
    END IF;

    v_fam := public.camp_family_for_update(p_camp_id, p_family_key);
    IF v_fam IS NULL OR jsonb_typeof(v_fam) <> 'object' THEN
        RETURN jsonb_build_object('success', false, 'error', 'family_not_found');
    END IF;

    PERFORM public.camp_family_save(p_camp_id, p_family_key, v_fam || p_fields);


    RETURN jsonb_build_object('success', true, 'familyKey', p_family_key);
END;
$$;


-- ─── 2. append_family_payment_method (170) — rules: R1, R3, R4, R5
CREATE OR REPLACE FUNCTION public.append_family_payment_method(
    p_camp_id        uuid,
    p_family_key     text,
    p_method         jsonb,
    p_default_fields jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    now_ts    timestamptz := now();
    v_me      jsonb;
    v_fam     jsonb;
    v_list    jsonb;
    v_token   text;
    v_dup     boolean := false;
    v_first   boolean;
BEGIN
    IF p_camp_id IS NULL OR COALESCE(p_family_key, '') = ''
       OR p_method IS NULL OR jsonb_typeof(p_method) <> 'object' THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_arguments');
    END IF;

    SELECT value INTO v_me FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe';
    IF v_me IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_camp_data');
    END IF;

    -- No auto-create. A card saved against a family that no longer exists is a
    -- real problem for a human to look at, not something to invent a record
    -- for — which is what the old handler did by bailing out with an error log.
    v_fam := public.camp_family_for_update(p_camp_id, p_family_key);
    IF v_fam IS NULL OR jsonb_typeof(v_fam) <> 'object' THEN
        RETURN jsonb_build_object('success', false, 'error', 'family_not_found');
    END IF;

    v_list := COALESCE(v_fam->'savedPaymentMethods', '[]'::jsonb);
    IF jsonb_typeof(v_list) <> 'array' THEN v_list := '[]'::jsonb; END IF;

    -- Already saved? Stripe redelivers setup_intent.succeeded freely, and the
    -- processor token is the one field that identifies the same card twice.
    v_token := p_method->>'token';
    IF COALESCE(v_token, '') <> '' THEN
        SELECT EXISTS (
            SELECT 1 FROM jsonb_array_elements(v_list) m
             WHERE m->>'token' = v_token
        ) INTO v_dup;
    END IF;
    IF v_dup THEN
        RETURN jsonb_build_object('success', true, 'alreadySaved', true,
            'isFirst', false, 'count', jsonb_array_length(v_list),
            'familyName', v_fam->>'name');
    END IF;

    v_first := jsonb_array_length(v_list) = 0;
    v_fam := jsonb_set(v_fam, '{savedPaymentMethods}',
        v_list || jsonb_build_array(p_method || jsonb_build_object('isDefault', v_first)), true);

    IF v_first AND p_default_fields IS NOT NULL AND jsonb_typeof(p_default_fields) = 'object' THEN
        v_fam := v_fam || p_default_fields;
    END IF;

    PERFORM public.camp_family_save(p_camp_id, p_family_key, v_fam);


    RETURN jsonb_build_object('success', true, 'alreadySaved', false,
        'isFirst', v_first, 'count', jsonb_array_length(v_fam->'savedPaymentMethods'),
        'familyName', v_fam->>'name');
END;
$$;


-- ─── 3. remove_payment_method (139) — rules: R1, R2, R4, R5
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

    SELECT value INTO me FROM camp_state_kv WHERE camp_id = inv.camp_id AND key = 'campistryMe';
    IF me IS NULL THEN me := '{}'::jsonb; END IF;
    fams := public.camp_families_object(inv.camp_id);

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

    PERFORM public.camp_family_save(inv.camp_id, v_famKey, v_fam);

    RETURN jsonb_build_object('success', true, 'removedMethodId', p_method_id, 'newDefaultMethodId', CASE WHEN v_wasDefault THEN v_promote->>'id' ELSE NULL END);
END;
$$;


-- ─── 4. set_default_payment_method (139) — rules: R1, R2, R4, R5
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

    SELECT value INTO me FROM camp_state_kv WHERE camp_id = inv.camp_id AND key = 'campistryMe';
    IF me IS NULL THEN me := '{}'::jsonb; END IF;
    fams := public.camp_families_object(inv.camp_id);

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

    PERFORM public.camp_family_save(inv.camp_id, v_famKey, v_fam);

    RETURN jsonb_build_object('success', true, 'defaultMethodId', p_method_id);
END;
$$;


-- ─── 5. use_family_card_for_canteen_auto_reload (139) — rules: R2
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
    fams := public.camp_families_object(inv.camp_id);

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


-- ─── 6. flag_expiring_cards (179) — rules: R1, R2, R4, R5
CREATE OR REPLACE FUNCTION public.flag_expiring_cards(
    p_camp_id uuid,
    p_as_of   date DEFAULT NULL,
    p_days    integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    now_ts    timestamptz := now();
    v_as_of   date := COALESCE(p_as_of, (now() AT TIME ZONE 'UTC')::date);
    v_me      jsonb;
    famRec    record;
    v_fam     jsonb;
    v_methods jsonb;
    m         jsonb;
    v_status  text;
    v_worst   text;
    v_label   text;
    v_changed boolean := false;
    v_expired integer := 0;
    v_expiring integer := 0;
    v_report  jsonb := '[]'::jsonb;
    v_autopay boolean;
    i         integer;
BEGIN
    IF p_camp_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_arguments');
    END IF;

    SELECT value INTO v_me FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe';
    IF v_me IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_camp_data');
    END IF;

    FOR famRec IN SELECT key, value FROM jsonb_each(
                      public.camp_families_object(p_camp_id)) LOOP
        IF jsonb_typeof(famRec.value) <> 'object' THEN CONTINUE; END IF;
        v_fam := famRec.value;

        SELECT EXISTS (
            SELECT 1 FROM jsonb_array_elements(
                     CASE WHEN jsonb_typeof(v_fam->'plans') = 'array'
                          THEN v_fam->'plans' ELSE '[]'::jsonb END) p
             WHERE COALESCE((p->>'autopay')::boolean, false)
               AND NOT COALESCE((p->>'paused')::boolean, false)
        ) INTO v_autopay;
        IF NOT v_autopay THEN CONTINUE; END IF;

        v_methods := CASE WHEN jsonb_typeof(v_fam->'savedPaymentMethods') = 'array'
                          THEN v_fam->'savedPaymentMethods' ELSE '[]'::jsonb END;
        v_worst := NULL; v_label := NULL;

        FOR i IN 0 .. GREATEST(jsonb_array_length(v_methods) - 1, -1) LOOP
            m := v_methods->i;
            IF jsonb_typeof(m) <> 'object' THEN CONTINUE; END IF;
            v_status := public.card_expiry_status(m, v_as_of, p_days);
            -- The DEFAULT card is the one autopay will charge, so it decides.
            -- A spare card expiring is not what stops collection.
            IF COALESCE((m->>'default')::boolean, false) OR jsonb_array_length(v_methods) = 1 THEN
                IF v_status IN ('expired', 'expiring') THEN
                    v_worst := v_status;
                    v_label := COALESCE(NULLIF(m->>'label', ''), 'Card on file');
                END IF;
            END IF;
        END LOOP;

        IF v_worst IS NULL THEN
            -- Nothing wrong: clear any stale flag rather than leaving a warning
            -- about a card that has since been replaced.
            IF v_fam ? 'cardExpiry' THEN
                v_fam := v_fam - 'cardExpiry';
                PERFORM public.camp_family_save(p_camp_id, famRec.key, v_fam);
                v_changed := true;
            END IF;
            CONTINUE;
        END IF;

        v_fam := jsonb_set(v_fam, '{cardExpiry}', jsonb_build_object(
            'status', v_worst, 'label', v_label,
            'checkedAt', to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')), true);
        PERFORM public.camp_family_save(p_camp_id, famRec.key, v_fam);
        v_changed := true;

        IF v_worst = 'expired' THEN v_expired := v_expired + 1;
        ELSE v_expiring := v_expiring + 1; END IF;
        v_report := v_report || jsonb_build_array(jsonb_build_object(
            'famKey', famRec.key, 'name', v_fam->>'name',
            'status', v_worst, 'label', v_label));

        INSERT INTO notifications (camp_id, source, source_id, title, body, link_target)
        VALUES (p_camp_id, 'card_expiry',
                -- Per card per MONTH: said once, and said again next month if
                -- nobody has done anything about it.
                famRec.key || ':' || v_worst || ':' || to_char(v_as_of, 'YYYY-MM'),
                CASE WHEN v_worst = 'expired'
                     THEN 'A card on autopay has expired'
                     ELSE 'A card on autopay expires soon' END,
                COALESCE(v_fam->>'name', famRec.key) || ' — ' || v_label
                  || CASE WHEN v_worst = 'expired'
                          THEN ' has expired, so their next instalment will be declined.'
                          ELSE ' expires within ' || p_days || ' days.' END
                  || ' Ask them to add a new card before the next instalment is due.',
                'campistry_me.html')
        ON CONFLICT (camp_id, source, source_id) DO NOTHING;
    END LOOP;

    IF v_changed THEN
    END IF;

    RETURN jsonb_build_object('success', true, 'asOf', v_as_of,
        'expired', v_expired, 'expiringSoon', v_expiring, 'detail', v_report);
END;
$$;


-- ─── 7. flag_plan_collection (179) — rules: R1, R3, R4, R5
CREATE OR REPLACE FUNCTION public.flag_plan_collection(
    p_camp_id    uuid,
    p_family_key text,
    p_plan_id    text,
    p_reason     text DEFAULT NULL,
    p_detail     text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    now_ts   timestamptz := now();
    v_me     jsonb;
    v_fam    jsonb;
    v_plans  jsonb;
    v_plan   jsonb;
    v_pi     integer := NULL;
    v_had    boolean;
    v_same   boolean := false;
    v_prev   jsonb;
    v_att    integer := 1;
    v_esc    boolean := false;
    v_was    boolean := false;
    v_next   date;
    i        integer;
BEGIN
    IF p_camp_id IS NULL OR COALESCE(p_family_key, '') = ''
       OR COALESCE(p_plan_id, '') = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_arguments');
    END IF;

    SELECT value INTO v_me FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe';
    IF v_me IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_camp_data');
    END IF;

    v_fam := public.camp_family_for_update(p_camp_id, p_family_key);
    IF v_fam IS NULL OR jsonb_typeof(v_fam) <> 'object' THEN
        RETURN jsonb_build_object('success', false, 'error', 'family_not_found');
    END IF;

    v_plans := CASE WHEN jsonb_typeof(v_fam->'plans') = 'array'
                    THEN v_fam->'plans' ELSE '[]'::jsonb END;
    FOR i IN 0 .. GREATEST(jsonb_array_length(v_plans) - 1, -1) LOOP
        IF v_plans->i->>'id' = p_plan_id THEN v_pi := i; EXIT; END IF;
    END LOOP;
    IF v_pi IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'plan_not_found');
    END IF;
    v_plan := v_plans->v_pi;
    v_had  := (v_plan ? 'collectionBlocked');
    v_prev := v_plan->'collectionBlocked';
    v_same := v_had AND v_prev->>'reason' = p_reason;

    IF COALESCE(p_reason, '') = '' THEN
        -- Collected. The block, the count and the schedule all go together: a
        -- parent who fixes their own card needs nobody to dismiss anything.
        IF NOT v_had THEN
            RETURN jsonb_build_object('success', true, 'changed', false);
        END IF;
        v_plan := v_plan - 'collectionBlocked';
    ELSE
        -- Consecutive failures OF THE SAME KIND. A different reason is a
        -- different problem and starts its own count — "declined" three times
        -- is a dead card; declined, then no_processor, then declined is not.
        v_att := CASE WHEN v_same
                      THEN COALESCE((v_prev->>'attempts')::integer, 1) + 1
                      ELSE 1 END;
        v_was := v_same AND COALESCE((v_prev->>'escalated')::boolean, false);
        v_esc := v_att >= public.collection_escalate_after();
        v_next := (now_ts AT TIME ZONE 'UTC')::date
                  + public.collection_retry_days(v_att);

        v_plan := jsonb_set(v_plan, '{collectionBlocked}', jsonb_build_object(
            'reason', p_reason,
            'detail', p_detail,
            -- Keep the ORIGINAL `since` when the reason has not changed, so the
            -- office can see how long a plan has been stuck rather than a date
            -- that resets every night.
            'since', CASE WHEN v_same THEN v_prev->>'since'
                          ELSE to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') END,
            'attempts', v_att,
            'lastAttemptAt', to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'nextRetryAt', to_char(v_next, 'YYYY-MM-DD'),
            'escalated', v_esc
        ), true);
    END IF;

    v_plans := jsonb_set(v_plans, ARRAY[v_pi::text], v_plan, true);
    v_fam := jsonb_set(v_fam, '{plans}', v_plans, true);
    PERFORM public.camp_family_save(p_camp_id, p_family_key, v_fam);


    IF COALESCE(p_reason, '') <> '' THEN
        INSERT INTO notifications (camp_id, source, source_id, title, body, link_target)
        VALUES (p_camp_id, 'autopay_blocked',
                p_family_key || ':' || p_plan_id || ':' || p_reason,
                'Autopay cannot collect',
                COALESCE(v_fam->>'name', p_family_key) || ' — '
                  || CASE p_reason
                       WHEN 'no_card' THEN 'their payment plan is still active but there is no card on file, so nothing is being collected'
                       WHEN 'declined' THEN 'their card was declined'
                       WHEN 'no_processor' THEN 'the camp''s payment processor is not connected'
                       ELSE p_reason END
                  || COALESCE('. ' || p_detail, '') || '.',
                'campistry_me.html')
        ON CONFLICT (camp_id, source, source_id) DO NOTHING;

        -- The escalation. Its own source_id, because the first notification was
        -- already sent and deduped — without a distinct key the message that
        -- actually matters would be swallowed by the one that no longer does.
        -- Sent once, on the attempt that crosses the line, not every time after.
        IF v_esc AND NOT v_was THEN
            INSERT INTO notifications (camp_id, source, source_id, title, body, link_target)
            VALUES (p_camp_id, 'autopay_blocked',
                    p_family_key || ':' || p_plan_id || ':' || p_reason || ':escalated',
                    'This card is not going to start working',
                    COALESCE(v_fam->>'name', p_family_key) || ' — ' || v_att
                      || ' attempts have now failed'
                      || COALESCE(' (' || p_detail || ')', '')
                      || '. Automatic retries continue every '
                      || public.collection_retry_days(v_att)
                      || ' days, but nothing will be collected until someone '
                      || 'contacts the family for a new card.',
                    'campistry_me.html')
            ON CONFLICT (camp_id, source, source_id) DO NOTHING;
        END IF;
    END IF;

    RETURN jsonb_build_object('success', true, 'changed', true,
                              'blocked', COALESCE(p_reason, '') <> '',
                              'attempts', CASE WHEN COALESCE(p_reason,'') = '' THEN 0 ELSE v_att END,
                              'escalated', v_esc,
                              'nextRetryAt', v_next);
END;
$$;


-- ─── 8. resolve_chargeback (175) — rules: R1, R3, R2, R4, R5
CREATE OR REPLACE FUNCTION public.resolve_chargeback(
    p_camp_id    uuid,
    p_dispute_id text,
    p_won        boolean,
    p_status     text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    now_ts    timestamptz := now();
    v_me      jsonb;
    famRec    record;
    v_fam     jsonb;
    v_famKey  text := NULL;
    v_cb      jsonb := NULL;
    v_winId   text;
BEGIN
    IF p_camp_id IS NULL OR COALESCE(p_dispute_id, '') = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_arguments');
    END IF;

    SELECT value INTO v_me FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe';
    IF v_me IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_camp_data');
    END IF;

    v_winId := 'le_cbwon_' || p_dispute_id;

    FOR famRec IN SELECT key, value FROM jsonb_each(
                      public.camp_families_object(p_camp_id)) LOOP
        IF jsonb_typeof(famRec.value) <> 'object' THEN CONTINUE; END IF;
        SELECT e INTO v_cb
          FROM jsonb_array_elements(
                 CASE WHEN jsonb_typeof(famRec.value->'entries') = 'array'
                      THEN famRec.value->'entries' ELSE '[]'::jsonb END) e
         WHERE e->>'id' = 'le_cb_' || p_dispute_id
         LIMIT 1;
        IF v_cb IS NOT NULL THEN v_famKey := famRec.key; EXIT; END IF;
    END LOOP;

    IF v_famKey IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'chargeback_not_found');
    END IF;
    v_fam := public.camp_family_for_update(p_camp_id, v_famKey);

    IF NOT COALESCE(p_won, false) THEN
        -- Lost: the refund already reflects it. Nothing to post.
        RETURN jsonb_build_object('success', true, 'familyKey', v_famKey,
                                  'posted', false, 'outcome', 'lost');
    END IF;

    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_fam->'entries') e
                WHERE e->>'id' = v_winId) THEN
        RETURN jsonb_build_object('success', true, 'alreadyRecorded', true,
                                  'familyKey', v_famKey);
    END IF;

    v_fam := jsonb_set(v_fam, '{entries}', v_fam->'entries' ||
        jsonb_build_array(jsonb_build_object(
            'id', v_winId,
            'kind', 'payment',
            'amount', v_cb->'amount',
            'reason', 'chargeback',
            'date', to_char(now_ts, 'YYYY-MM-DD'),
            'postedAt', to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'note', 'Chargeback reversed — the camp won the dispute',
            'by', 'system',
            'source', jsonb_build_object('disputeId', p_dispute_id,
                                         'reverses', v_cb->>'id'))), true);
    PERFORM public.camp_family_save(p_camp_id, v_famKey, v_fam);


    RETURN jsonb_build_object('success', true, 'familyKey', v_famKey,
        'posted', true, 'outcome', 'won',
        'balance', public.family_ledger_balance(v_fam));
END;
$$;


-- ─── 9. settle_shop_order (167) — rules: R1, R3, R2, R4, R5
CREATE OR REPLACE FUNCTION public.settle_shop_order(
    p_camp_id     uuid,
    p_order_id    text,
    p_pay_method  text,
    p_total       numeric,
    p_cancelled   boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    now_ts       timestamptz := now();
    v_role       text;
    v_shop       jsonb;
    v_snacks     jsonb;
    v_me         jsonb;
    v_orders     jsonb;
    v_order      jsonb := NULL;
    v_idx        integer := NULL;
    i            integer;
    v_camper     text;
    v_famKey     text := NULL;
    v_cur_method text := 'none';
    v_cur_amt    numeric := 0;
    v_new_method text;
    v_new_amt    numeric;
    v_delta      numeric;
    v_bal        numeric;
    v_charges    jsonb;
    v_kept       jsonb;
    c            jsonb;
    v_chargeId   text;
BEGIN
    IF p_camp_id IS NULL OR p_camp_id <> get_user_camp_id() THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;
    v_role := get_user_role();
    IF v_role IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    v_new_method := CASE WHEN p_cancelled THEN 'none' ELSE COALESCE(p_pay_method, 'none') END;
    v_new_amt    := CASE WHEN p_cancelled THEN 0 ELSE round(COALESCE(p_total, 0), 2) END;
    IF v_new_amt < 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'negative_total');
    END IF;

    -- ── find the order ─────────────────────────────────────────────────────
    -- ── LOCK ORDER: campistryShop -> campistrySnacks -> campistryMe ────────
    -- Every SELECT below takes FOR UPDATE and holds it to the end of the
    -- function, because all three writes are read-modify-write on a JSONB blob.
    -- Without the lock two concurrent settlements — or a settlement racing a
    -- POS sale or a parent deposit — both read the same ledger, both append
    -- their own row, and the second write silently discards the first. The
    -- canteen balance is RECOMPUTED from that ledger, so a lost transaction is
    -- lost money, not just a lost audit line.
    --
    -- The ORDER is load-bearing and matches migration 122's place_shop_order
    -- (Shop then Snacks). Two functions taking the same two locks in opposite
    -- orders deadlock; keep any new writer on this order.
    SELECT value INTO v_shop FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryShop'
     FOR UPDATE;
    IF v_shop IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_shop_data');
    END IF;
    v_orders := COALESCE(v_shop->'orders', '[]'::jsonb);

    FOR i IN 0 .. jsonb_array_length(v_orders) - 1 LOOP
        IF v_orders->i->>'id' = p_order_id THEN
            v_order := v_orders->i;
            v_idx := i;
            EXIT;
        END IF;
    END LOOP;
    IF v_order IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'order_not_found');
    END IF;

    v_camper := COALESCE(v_order->>'camperName', '');
    IF v_order->'settlement' IS NOT NULL AND v_order->'settlement' <> 'null'::jsonb THEN
        v_cur_method := COALESCE(v_order->'settlement'->>'method', 'none');
        v_cur_amt    := round(COALESCE((v_order->'settlement'->>'amount')::numeric, 0), 2);
    END IF;

    -- Nothing to do. This is the common case on a re-save and it must be free
    -- of side effects, or every edit to an unrelated field re-posts money.
    IF v_cur_method = v_new_method AND v_cur_amt = v_new_amt THEN
        RETURN jsonb_build_object('success', true, 'unchanged', true,
                                  'method', v_cur_method, 'amount', v_cur_amt);
    END IF;

    -- Posting to the family's bill writes campistryMe, which is a billing
    -- action — a counselor running the shop must not be able to do it. The
    -- canteen path stays open to them, because taking canteen payment IS the
    -- job. (RLS is bypassed here by SECURITY DEFINER, so this check is the
    -- boundary, not a convenience.)
    IF (v_new_method = 'bill' OR v_cur_method = 'bill')
       AND v_role NOT IN ('owner', 'admin', 'manager') THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized_for_billing');
    END IF;

    -- ── canteen ────────────────────────────────────────────────────────────
    IF v_cur_method = 'canteen' OR v_new_method = 'canteen' THEN
        SELECT value INTO v_snacks FROM camp_state_kv
         WHERE camp_id = p_camp_id AND key = 'campistrySnacks'
         FOR UPDATE;
        IF v_snacks IS NULL THEN v_snacks := '{}'::jsonb; END IF;
        IF v_snacks->'accounts' IS NULL THEN
            v_snacks := jsonb_set(v_snacks, '{accounts}', '{}'::jsonb, true);
        END IF;
        IF v_snacks->'transactions' IS NULL THEN
            v_snacks := jsonb_set(v_snacks, '{transactions}', '[]'::jsonb, true);
        END IF;

        -- How much MORE to take. Same method: just the difference. Method
        -- changed away from canteen: give all of it back. Changed to canteen:
        -- take the whole new amount.
        v_delta := (CASE WHEN v_new_method = 'canteen' THEN v_new_amt ELSE 0 END)
                 - (CASE WHEN v_cur_method = 'canteen' THEN v_cur_amt ELSE 0 END);

        IF v_delta <> 0 AND v_camper <> '' THEN
            v_bal := round(COALESCE((v_snacks->'accounts'->v_camper->>'balance')::numeric, 0)
                           - v_delta, 2);
            v_snacks := jsonb_set(
                v_snacks, ARRAY['accounts', v_camper],
                COALESCE(v_snacks->'accounts'->v_camper, '{"dailyLimit":10,"spentToday":0}'::jsonb)
                    || jsonb_build_object('balance', v_bal),
                true);

            -- Append-only, because _reconcileBalances rebuilds every balance
            -- from this ledger. A positive delta is a debit; a negative one is
            -- money going back, which is a credit.
            v_snacks := jsonb_set(v_snacks, '{transactions}',
                jsonb_build_array(jsonb_build_object(
                    'time',   to_char(now_ts, 'HH12:MI AM'),
                    'camper', v_camper,
                    'items',  CASE WHEN v_delta > 0 THEN 'Camp Shop order'
                                   ELSE 'Camp Shop order — reversed' END,
                    'amount', abs(v_delta),
                    'type',   CASE WHEN v_delta > 0 THEN 'debit' ELSE 'credit' END,
                    'kind',   'shop',
                    'date',   to_char(now_ts, 'YYYY-MM-DD'),
                    'shopOrderId', p_order_id,
                    'timestamp', (extract(epoch from now_ts) * 1000)::bigint
                )) || COALESCE(v_snacks->'transactions', '[]'::jsonb));

            UPDATE camp_state_kv SET value = v_snacks, updated_at = now_ts
             WHERE camp_id = p_camp_id AND key = 'campistrySnacks';
        END IF;
    END IF;

    -- ── camp bill ──────────────────────────────────────────────────────────
    IF v_cur_method = 'bill' OR v_new_method = 'bill' THEN
        SELECT value INTO v_me FROM camp_state_kv
         WHERE camp_id = p_camp_id AND key = 'campistryMe';
        IF v_me IS NULL THEN v_me := '{}'::jsonb; END IF;

        -- Whose family? Resolved here rather than trusted from the client:
        -- the camper's membership is what decides who gets billed.
        SELECT f.key INTO v_famKey
          FROM jsonb_each(public.camp_families_object(p_camp_id)) f
         WHERE EXISTS (
             SELECT 1 FROM jsonb_array_elements_text(
                 COALESCE(f.value->'camperIds', '[]'::jsonb)) ci
              WHERE ci = v_camper)
         ORDER BY f.key
         LIMIT 1;

        IF v_famKey IS NULL AND v_new_method = 'bill' THEN
            -- No family to bill. Refuse rather than silently dropping the
            -- charge — an unbilled sweatshirt is the bug being fixed.
            RETURN jsonb_build_object('success', false, 'error', 'no_family_for_camper',
                'detail', 'No family record lists ' || v_camper ||
                          '. Add them to a family before charging the camp bill.');
        END IF;

        IF v_famKey IS NOT NULL THEN
            v_chargeId := 'shop_' || p_order_id;
            v_charges  := COALESCE(public.camp_family_for_update(p_camp_id, v_famKey, 'charges'), '[]'::jsonb);

            -- Drop any previous charge for this order, then re-add at the new
            -- amount. A SET, not an append — re-settling must replace, never
            -- stack a second sweatshirt onto the family's balance.
            v_kept := '[]'::jsonb;
            FOR c IN SELECT * FROM jsonb_array_elements(v_charges) LOOP
                IF COALESCE(c->>'id', '') <> v_chargeId THEN
                    v_kept := v_kept || jsonb_build_array(c);
                END IF;
            END LOOP;

            IF v_new_method = 'bill' AND v_new_amt > 0 THEN
                v_kept := v_kept || jsonb_build_array(jsonb_build_object(
                    'id',          v_chargeId,
                    'category',    'Camp Shop',
                    'description', 'Camp Shop order' ||
                                   CASE WHEN v_camper <> '' THEN ' — ' || v_camper ELSE '' END,
                    'amount',      v_new_amt,
                    'date',        to_char(now_ts, 'YYYY-MM-DD'),
                    'shopOrderId', p_order_id,
                    'timestamp',   (extract(epoch from now_ts) * 1000)::bigint
                ));
            END IF;

            PERFORM public.camp_family_save(p_camp_id, v_famKey, 'charges', v_kept);
        END IF;
    END IF;

    -- ── record what was taken ──────────────────────────────────────────────
    v_order := v_order || jsonb_build_object(
        'settlement', jsonb_build_object(
            'method',   v_new_method,
            'amount',   v_new_amt,
            'familyKey', v_famKey,
            'at',       to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
        -- 'paid' means the money is actually in. Cash/cheque/card are collected
        -- outside Campistry, so the office ticks those by hand; the two methods
        -- this function settles are paid by definition once posted.
        'paid', CASE WHEN v_new_method IN ('canteen', 'bill') THEN true
                     ELSE COALESCE((v_order->>'paid')::boolean, false) END
    );

    v_shop := jsonb_set(v_shop, ARRAY['orders', v_idx::text], v_order, true);
    UPDATE camp_state_kv SET value = v_shop, updated_at = now_ts
     WHERE camp_id = p_camp_id AND key = 'campistryShop';

    RETURN jsonb_build_object('success', true,
        'method', v_new_method, 'amount', v_new_amt,
        'previousMethod', v_cur_method, 'previousAmount', v_cur_amt,
        'familyKey', v_famKey, 'balance', v_bal);
END;
$$;


-- ─── 10. _admin_backfill_saved_payment_methods (151) — rules: R2, R4b, R5b, R5
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
    IF v_me IS NULL OR jsonb_typeof(public.camp_families_object(p_camp_id)) <> 'object' THEN
        RETURN jsonb_build_object('success', true, 'added', 0, 'note', 'no families');
    END IF;

    FOR rec IN SELECT key, value FROM jsonb_each(public.camp_families_object(p_camp_id)) LOOP
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

        PERFORM public.camp_family_save(p_camp_id, rec.key, v_fam);
    END LOOP;

    IF v_changed THEN
    END IF;

    RETURN jsonb_build_object('success', true, 'added', v_added_n);
END;
$$;


-- ─── 11. _admin_clear_stale_byop_cards (147) — rules: R2, R4b, R5b, R5
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
    IF v_me IS NOT NULL AND jsonb_typeof(public.camp_families_object(p_camp_id)) = 'object' THEN
        FOR rec IN SELECT key, value FROM jsonb_each(public.camp_families_object(p_camp_id)) LOOP
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

            PERFORM public.camp_family_save(p_camp_id, rec.key, v_obj);
        END LOOP;

        IF v_famsChanged THEN
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


-- ─── the confirmation ───────────────────────────────────────────────────────
-- A statement, and last, so a successful paste is visible. The number that
-- matters is locked_on_campistryme: these eleven must no longer hold a lock on
-- the camp's document. It is asked of the LIVE definitions, not of this file.
SELECT 'migration 214 applied' AS status,
       count(*) FILTER (WHERE def LIKE '%camp_family_for_update%'
                           OR def LIKE '%camp_family_save%'
                           OR def LIKE '%camp_families_object%')          AS on_rows,
       count(*)                                                          AS functions_checked,
       count(*) FILTER (WHERE def ~ 'key = ''campistryMe''[^;]*FOR UPDATE'
                           OR def ~ 'FOR UPDATE[^;]*campistryMe')        AS locked_on_campistryme,
       count(*) FILTER (WHERE def ~ 'UPDATE camp_state_kv[^;]*campistryMe')
                                                                         AS still_writes_the_document,
       -- The shop and canteen locks MUST survive: those blobs are still
       -- read-modify-written, and removing their lock would lose money.
       count(*) FILTER (WHERE def LIKE '%campistryShop%' OR def LIKE '%campistrySnacks%')
                                                                         AS touch_other_blobs
  FROM (SELECT pg_get_functiondef(p.oid) AS def
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('merge_camp_family_fields','append_family_payment_method',
                             'remove_payment_method','set_default_payment_method',
                             'use_family_card_for_canteen_auto_reload','flag_expiring_cards',
                             'flag_plan_collection','resolve_chargeback','settle_shop_order',
                             '_admin_backfill_saved_payment_methods',
                             '_admin_clear_stale_byop_cards')) AS f;
