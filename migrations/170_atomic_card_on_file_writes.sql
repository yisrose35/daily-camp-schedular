-- ============================================================================
-- Migration 170: the last two blind blob writes in the payment functions.
--
-- 168 and 169 closed every path that records MONEY. These two record a SAVED
-- CARD, and they were left on the old read-modify-write:
--
--   stripe-webhook → handleAutopaySetup
--       families[k].savedPaymentMethods.push(...) + the legacy single-slot
--       fields, then UPSERT the whole campistryMe blob.
--   stripe-webhook → handleCanteenAutoReloadSetup
--       accounts[camper].autoReload.<card fields>, then UPSERT the whole
--       campistrySnacks blob.
--
-- Losing one of these loses no money on the day, which is exactly why it is
-- worth fixing: it silently stops autopay or auto-reload for that family, and
-- nobody notices until a month of instalments never charged. And the
-- campistrySnacks write is worse than it looks — that blob holds the canteen
-- TRANSACTION LEDGER, and the canteen balance is recomputed from it, so a
-- whole-blob upsert racing a POS sale erases a sale and the money with it.
--
-- ── A SECOND BUG, IN THE SAME LINES ────────────────────────────────────────
-- Neither handler deduped. Stripe re-delivers setup_intent.succeeded on any
-- non-2xx and on its own retry schedule, so the SAME saved card could be
-- appended to savedPaymentMethods twice — two identical rows for one card, one
-- of them nobody can explain. append_family_payment_method matches on the
-- processor token, under the lock, so a redelivery is a no-op.
--
-- The retry loop both handlers carry does not cover either bug: it retries on a
-- WRITE ERROR, and a lost update is not an error.
--
-- Idempotent. Additive — a handler still on the old path keeps working.
-- ============================================================================

-- ─── 1. append a saved card to one family, atomically and at most once ──────
-- p_method is the method record the caller built (id, type, processor, token,
-- last4, label, addedDate). isDefault is decided HERE, not by the caller: it
-- depends on whether the list is empty, which is only knowable under the lock.
--
-- p_default_fields are the legacy single-slot fields (stripeCustomerId,
-- stripePaymentMethodId, cardOnFile, paymentMethodLabel, …) that every existing
-- charge path still reads directly. They are applied ONLY when this is the
-- family's first saved card, which is exactly what the old code did — a second
-- card must not silently become what autopay charges.
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
     WHERE camp_id = p_camp_id AND key = 'campistryMe'
     FOR UPDATE;
    IF v_me IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_camp_data');
    END IF;

    -- No auto-create. A card saved against a family that no longer exists is a
    -- real problem for a human to look at, not something to invent a record
    -- for — which is what the old handler did by bailing out with an error log.
    v_fam := v_me #> ARRAY['families', p_family_key];
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

    v_me := jsonb_set(v_me, ARRAY['families', p_family_key], v_fam, true);

    UPDATE camp_state_kv SET value = v_me, updated_at = now_ts
     WHERE camp_id = p_camp_id AND key = 'campistryMe';

    RETURN jsonb_build_object('success', true, 'alreadySaved', false,
        'isFirst', v_first, 'count', jsonb_array_length(v_fam->'savedPaymentMethods'),
        'familyName', v_fam->>'name');
END;
$$;
REVOKE ALL ON FUNCTION public.append_family_payment_method(uuid, text, jsonb, jsonb)
    FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_family_payment_method(uuid, text, jsonb, jsonb)
    TO service_role;


-- ─── 2. merge canteen auto-reload card fields, atomically ───────────────────
-- A SHALLOW merge onto accounts[camper].autoReload, so the parent's trigger
-- config (enabled, threshold*, schedule*) set by set_canteen_auto_reload
-- (migration 109) survives a card save that lands at the same moment.
--
-- The blob-level lock matters more here than anywhere else in this migration:
-- campistrySnacks holds the canteen TRANSACTION LEDGER, and the canteen balance
-- is recomputed from it (`balance === Σ transactions`). A whole-blob upsert
-- racing a POS sale does not just lose a card field — it erases a sale.
-- p_require_existing preserves a real difference between the two callers.
-- stripe-webhook and cardknox-webhook CREATE the camper's account if a parent
-- saves a card before the canteen has ever seen them; payments-hosted-complete
-- refuses with "Camper no longer exists", because it is completing a hosted
-- page the parent is still looking at and a silently-invented account would
-- take a card for a camper who is not enrolled.
CREATE OR REPLACE FUNCTION public.merge_canteen_autoreload_card(
    p_camp_id          uuid,
    p_camper           text,
    p_fields           jsonb,
    p_require_existing boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    now_ts    timestamptz := now();
    v_snacks  jsonb;
    v_accts   jsonb;
    v_acct    jsonb;
    v_ar      jsonb;
    v_created boolean := false;
BEGIN
    IF p_camp_id IS NULL OR COALESCE(p_camper, '') = ''
       OR p_fields IS NULL OR jsonb_typeof(p_fields) <> 'object' THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_arguments');
    END IF;

    -- A camp that has never opened the canteen has no row yet, and a parent can
    -- still save a card first. Same shape the handler created by hand. Not
    -- created when the caller requires an existing camper — there would be
    -- nothing to attach the card to anyway.
    IF NOT p_require_existing THEN
        INSERT INTO camp_state_kv (camp_id, key, value, updated_at)
        VALUES (p_camp_id, 'campistrySnacks',
                '{"accounts":{},"transactions":[]}'::jsonb, now_ts)
        ON CONFLICT (camp_id, key) DO NOTHING;
    END IF;

    SELECT value INTO v_snacks FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistrySnacks'
     FOR UPDATE;
    IF v_snacks IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_camp_data');
    END IF;
    IF jsonb_typeof(v_snacks) <> 'object' THEN
        v_snacks := '{"accounts":{},"transactions":[]}'::jsonb;
    END IF;

    v_accts := COALESCE(v_snacks->'accounts', '{}'::jsonb);
    IF jsonb_typeof(v_accts) <> 'object' THEN v_accts := '{}'::jsonb; END IF;

    -- balance 0 on a brand-new account is not an opening figure, it is the sum
    -- of no transactions — the ledger is the source of truth (_reconcileBalances
    -- recomputes it), so this can never be anything else.
    v_acct := v_accts->p_camper;
    IF v_acct IS NULL OR jsonb_typeof(v_acct) <> 'object' THEN
        IF p_require_existing THEN
            RETURN jsonb_build_object('success', false, 'error', 'camper_not_found');
        END IF;
        v_acct := '{"balance":0,"dailyLimit":10,"spentToday":0}'::jsonb;
        v_created := true;
    END IF;

    v_ar := COALESCE(v_acct->'autoReload', '{}'::jsonb);
    IF jsonb_typeof(v_ar) <> 'object' THEN v_ar := '{}'::jsonb; END IF;

    v_acct   := jsonb_set(v_acct, '{autoReload}', v_ar || p_fields, true);
    v_snacks := jsonb_set(v_snacks, ARRAY['accounts', p_camper], v_acct, true);

    UPDATE camp_state_kv SET value = v_snacks, updated_at = now_ts
     WHERE camp_id = p_camp_id AND key = 'campistrySnacks';

    RETURN jsonb_build_object('success', true, 'camper', p_camper, 'created', v_created);
END;
$$;
-- No earlier 3-argument version shipped, but drop it anyway so a hand-applied
-- draft cannot linger beside this one and win overload resolution.
DROP FUNCTION IF EXISTS public.merge_canteen_autoreload_card(uuid, text, jsonb);
REVOKE ALL ON FUNCTION public.merge_canteen_autoreload_card(uuid, text, jsonb, boolean)
    FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_canteen_autoreload_card(uuid, text, jsonb, boolean)
    TO service_role;


-- ─── Checking it ───────────────────────────────────────────────────────────
-- The same card twice must land once, and must not become the default twice:
--   select append_family_payment_method('<camp>'::uuid, '<famKey>',
--       '{"id":"pm_a","token":"pm_stripe_1","label":"Visa ···· 4242"}'::jsonb,
--       '{"cardOnFile":true,"stripePaymentMethodId":"pm_stripe_1"}'::jsonb);
--   -- first:  isFirst true,  alreadySaved false
--   -- second: isFirst false, alreadySaved true, count unchanged
--
-- A SECOND, different card appends without touching the legacy slot:
--   select append_family_payment_method('<camp>'::uuid, '<famKey>',
--       '{"id":"pm_b","token":"pm_stripe_2"}'::jsonb,
--       '{"stripePaymentMethodId":"SHOULD_NOT_APPEAR"}'::jsonb);
--   select value #> '{families,<famKey>,stripePaymentMethodId}'
--     from camp_state_kv where key='campistryMe';   -- still pm_stripe_1
--
-- And the canteen merge must leave the ledger and the trigger config alone:
--   select jsonb_array_length(value->'transactions'),
--          value #> '{accounts,<camper>,autoReload}'
--     from camp_state_kv where key='campistrySnacks';
-- ============================================================================
