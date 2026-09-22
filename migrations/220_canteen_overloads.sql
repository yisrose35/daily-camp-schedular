-- ============================================================================
-- 220 — the four overloads 219 missed
--
-- 219's confirmation reported three functions still holding the camp-wide
-- campistrySnacks lock where one was expected. The one expected is
-- record_canteen_sale_inventory, which touches inventory and never an account.
-- The other two were superseded OVERLOADS.
--
-- WHY THEY WERE MISSED. scripts/transform_canteen_writers.py keyed each
-- function by NAME, so when two migrations defined the same name with
-- different parameter lists, only the newer file's version was seen. Postgres
-- does not work that way: submit_shop_order(4 args) and
-- submit_shop_order(5 args) are two functions, both callable, both live. The
-- script now keys by name AND arity, which is how this file was generated.
--
-- WHY IT MATTERED. After 219 the document is no longer maintained, so an
-- unconverted overload does not merely keep an old lock — it writes money into
-- a place nothing reads. And campistry_link_parent.html:2090 calls
-- submit_shop_order with four named arguments and no p_camp_id, so a parent
-- buying from the shop is exactly the caller that could have landed on one.
--
-- Nothing was lost: this project has no live camps, and 219 and this file are
-- being applied in the same sitting. On a camp with real parents the window
-- between them would be a window where shop orders and self-reported deposits
-- quietly went nowhere.
--
-- The conversion is identical to 219's — same three helpers, same rules, same
-- money arithmetic carried through untouched.
--
-- HOW TO APPLY. Paste into the SQL Editor after 219. One transaction;
-- idempotent.
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'canteen_account_lock') THEN
        RAISE EXCEPTION 'canteen_account_lock is missing — apply 219 before this file';
    END IF;
END $$;

SET LOCAL lock_timeout = '15s';
LOCK TABLE public.camp_state_kv IN ACCESS EXCLUSIVE MODE;


CREATE OR REPLACE FUNCTION public.credit_canteen_balance_from_processor(
    p_camp_id                 uuid,
    p_camper_name              text,
    p_amount                   numeric,
    p_processor_key            text,
    p_external_transaction_id  text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_locked_acct jsonb;
    v_value      jsonb;
    v_bal        numeric;
    v_already    boolean;
    v_roster_ok  boolean;
    now_ts       timestamptz := now();
BEGIN
    IF p_camp_id IS NULL OR p_camper_name IS NULL OR btrim(p_camper_name) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_params');
    END IF;
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_amount');
    END IF;
    IF p_external_transaction_id IS NULL OR btrim(p_external_transaction_id) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_transaction_id');
    END IF;


    -- 219: one camper's row, not the camp's document.
    v_value := NULL::jsonb;  -- document no longer read
    v_locked_acct := public.canteen_account_lock(p_camp_id, p_camper_name);


    SELECT EXISTS (
        SELECT 1 FROM canteen_transactions t
         WHERE t.camp_id = p_camp_id AND t.payload->>'byopTransactionId' = p_external_transaction_id
    ) INTO v_already;
    IF v_already THEN
        RETURN jsonb_build_object(
            'success', true, 'alreadyProcessed', true,
            'balance', COALESCE((v_locked_acct->>'balance')::numeric, 0)
        );
    END IF;

    -- Defense-in-depth roster check -- the real gate is in
    -- payments-canteen-checkout (campOwnsCamper, checked BEFORE the charge
    -- is even attempted). By the time this RPC runs, the processor has
    -- already captured real money, so a missing roster match is logged
    -- (rosterVerified:false) for office follow-up rather than refused.
    SELECT (value->'app1'->'camperRoster' ? p_camper_name) INTO v_roster_ok
    FROM camp_state_kv WHERE camp_id = p_camp_id AND key = 'app1';
    v_roster_ok := COALESCE(v_roster_ok, false);

    v_bal := round(COALESCE((v_locked_acct->>'balance')::numeric, 0) + p_amount, 2);

    PERFORM public.canteen_account_save(p_camp_id, p_camper_name,
        COALESCE(v_locked_acct, '{"dailyLimit":10,"spentToday":0}'::jsonb)
            || jsonb_build_object('balance', v_bal));

    PERFORM public.canteen_post(p_camp_id, p_camper_name,
        jsonb_build_object(
            'time',   to_char(now_ts, 'HH12:MI AM'),
            'camper', p_camper_name,
            'items',  'Funds added by parent (online)',
            'amount', p_amount,
            'type',   'credit',
            'kind',   'deposit',
            'method', p_processor_key,
            'date',   to_char(now_ts, 'YYYY-MM-DD'),
            'byopTransactionId', p_external_transaction_id,
            'timestamp', (extract(epoch from now_ts) * 1000)::bigint
        ));


    RETURN jsonb_build_object('success', true, 'balance', v_bal, 'rosterVerified', v_roster_ok);
END;
$$;

CREATE OR REPLACE FUNCTION public.submit_canteen_deposit(
    p_camper_name text,
    p_amount      numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_locked_acct jsonb;
    caller  uuid := auth.uid();
    inv     link_parent_invites;
    v_value jsonb;
    v_bal   numeric;
    now_ts  timestamptz := now();
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF p_camper_name IS NULL OR btrim(p_camper_name) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_camper');
    END IF;
    IF p_amount IS NULL OR p_amount < 1 OR p_amount > 500 THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_amount');
    END IF;

    SELECT * INTO inv
    FROM link_parent_invites
    WHERE user_id = caller
      AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
    ORDER BY created_at DESC
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;

    IF inv.camper_names IS NOT NULL AND NOT (inv.camper_names ? p_camper_name) THEN
        RETURN jsonb_build_object('success', false, 'error', 'camper_not_on_invite');
    END IF;

    -- Ensure a row exists so there's always something to lock, then lock it.

    -- 219: one camper's row, not the camp's document.
    v_value := NULL::jsonb;  -- document no longer read
    v_locked_acct := public.canteen_account_lock(inv.camp_id, p_camper_name);


    v_bal := round(COALESCE((v_locked_acct->>'balance')::numeric, 0) + p_amount, 2);

    PERFORM public.canteen_account_save(inv.camp_id, p_camper_name,
        COALESCE(v_locked_acct, '{"dailyLimit":10,"spentToday":0}'::jsonb)
            || jsonb_build_object('balance', v_bal));

    PERFORM public.canteen_post(inv.camp_id, p_camper_name,
        jsonb_build_object(
            'time',   to_char(now_ts, 'HH12:MI AM'),
            'camper', p_camper_name,
            'items',  'Funds added by parent',
            'amount', p_amount,
            'type',   'credit',
            'date',   to_char(now_ts, 'YYYY-MM-DD')
        ));


    RETURN jsonb_build_object('success', true, 'balance', v_bal);
END;
$$;

CREATE OR REPLACE FUNCTION public.submit_shop_order(
    p_camper_name text,
    p_lines       jsonb,
    p_pay_method  text DEFAULT 'bill',
    p_notes       text DEFAULT NULL,
    p_camp_id     text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_locked_acct jsonb;
    caller     uuid := auth.uid();
    inv        link_parent_invites;
    v_shop     jsonb;
    v_snacks   jsonb;
    v_line     jsonb;
    v_product  jsonb;
    v_variant  text;
    v_qty      int;
    v_unit     numeric;
    v_delta    numeric;
    v_stock    int;
    v_backorder boolean;
    v_lines    jsonb := '[]'::jsonb;
    v_total    numeric := 0;
    v_count    int := 0;
    v_balance  numeric;
    v_order_id text;
    v_bunk     text;
    now_ts     timestamptz := now();
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF p_camper_name IS NULL OR btrim(p_camper_name) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_camper');
    END IF;
    IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'empty_order');
    END IF;
    IF jsonb_array_length(p_lines) > 40 THEN
        RETURN jsonb_build_object('success', false, 'error', 'too_many_lines');
    END IF;
    IF p_pay_method IS NULL OR p_pay_method NOT IN ('bill', 'canteen') THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_pay_method');
    END IF;

    -- Prefer the invite for the requested camp (multi-camp); else most-recent.
    -- Same resolution migration 043 gave tips.
    IF p_camp_id IS NOT NULL AND btrim(p_camp_id) <> '' THEN
        SELECT * INTO inv FROM link_parent_invites
        WHERE user_id = caller AND status = 'active'
          AND (expires_at IS NULL OR expires_at > now())
          AND camp_id = p_camp_id::uuid
        ORDER BY created_at DESC LIMIT 1;
    END IF;
    IF inv.id IS NULL THEN
        SELECT * INTO inv FROM link_parent_invites
        WHERE user_id = caller AND status = 'active'
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY created_at DESC LIMIT 1;
    END IF;

    IF inv.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;
    IF inv.camper_names IS NOT NULL AND NOT (inv.camper_names ? p_camper_name) THEN
        RETURN jsonb_build_object('success', false, 'error', 'camper_not_on_invite');
    END IF;

    -- Guarantee a row exists, then lock it. Lock order is always
    -- campistryShop -> campistrySnacks (see security note 5).
    INSERT INTO camp_state_kv (camp_id, key, value, updated_at)
    VALUES (inv.camp_id, 'campistryShop', '{"products":[],"orders":[],"settings":{}}'::jsonb, now_ts)
    ON CONFLICT (camp_id, key) DO NOTHING;

    SELECT value INTO v_shop
    FROM camp_state_kv
    WHERE camp_id = inv.camp_id AND key = 'campistryShop'
    FOR UPDATE;

    IF v_shop IS NULL THEN v_shop := '{"products":[],"orders":[],"settings":{}}'::jsonb; END IF;
    v_backorder := COALESCE((v_shop->'settings'->>'parentAllowBackorder')::boolean, false);

    -- ── price and validate every line from the STORED catalogue ──
    FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
    LOOP
        v_qty := GREATEST(0, COALESCE((v_line->>'qty')::int, 0));
        CONTINUE WHEN v_qty = 0;
        IF v_qty > 50 THEN
            RETURN jsonb_build_object('success', false, 'error', 'qty_too_large');
        END IF;

        v_product := NULL;   -- explicit: never inherit the previous iteration's row
        SELECT p INTO v_product
        FROM jsonb_array_elements(COALESCE(v_shop->'products', '[]'::jsonb)) AS p
        WHERE p->>'id' = v_line->>'productId'
          AND COALESCE((p->>'active')::boolean, true) IS TRUE
        LIMIT 1;

        IF v_product IS NULL THEN
            RETURN jsonb_build_object('success', false, 'error', 'product_unavailable',
                                      'productId', v_line->>'productId');
        END IF;

        -- Variant id mirrors ShopCore.variantId(): slug(sku|id):slug(size):slug(color)
        -- Each segment is trimmed SEPARATELY, exactly as slug() does in JS.
        -- Trimming the joined string instead would leave 'tee-:am:navy' for a
        -- sku like "TEE!", which matches nothing in the stock map — the stock
        -- check would then silently pass on every order.
        v_variant :=
            btrim(regexp_replace(lower(COALESCE(NULLIF(v_product->>'sku',''), v_product->>'id')), '[^a-z0-9]+', '-', 'g'), '-')
            || ':' ||
            btrim(regexp_replace(lower(COALESCE(NULLIF(v_line->>'size',''), 'onesize')), '[^a-z0-9]+', '-', 'g'), '-')
            || ':' ||
            btrim(regexp_replace(lower(COALESCE(NULLIF(v_line->>'color',''), 'default')), '[^a-z0-9]+', '-', 'g'), '-');

        v_delta := COALESCE((v_product->'priceDeltas'->>(v_line->>'size'))::numeric, 0);
        v_unit  := round(COALESCE((v_product->>'price')::numeric, 0) + v_delta, 2);

        IF NOT v_backorder THEN
            v_stock := COALESCE((v_product->'stock'->>v_variant)::int, 0);
            IF v_qty > v_stock THEN
                RETURN jsonb_build_object('success', false, 'error', 'out_of_stock',
                    'product', v_product->>'name', 'size', v_line->>'size',
                    'available', v_stock, 'wanted', v_qty);
            END IF;
        END IF;

        v_total := v_total + (v_unit * v_qty);
        v_count := v_count + v_qty;
        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
            'productId', (v_product->>'id')::int,
            'name',      v_product->>'name',
            'size',      COALESCE(v_line->>'size', ''),
            'color',     COALESCE(v_line->>'color', ''),
            'qty',       v_qty,
            'unitPrice', v_unit
        ));
    END LOOP;

    IF jsonb_array_length(v_lines) = 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'empty_order');
    END IF;
    v_total := round(v_total, 2);

    -- ── canteen payment: draw the total from the camper's balance ──
    IF p_pay_method = 'canteen' THEN

    -- 219: one camper's row, not the camp's document.
    v_snacks := NULL::jsonb;  -- document no longer read
    v_locked_acct := public.canteen_account_lock(inv.camp_id, p_camper_name);

        v_balance := COALESCE((v_locked_acct->>'balance')::numeric, 0);

        IF v_balance < v_total THEN
            RETURN jsonb_build_object('success', false, 'error', 'insufficient_balance',
                                      'balance', v_balance, 'total', v_total);
        END IF;

        v_balance := round(v_balance - v_total, 2);
    PERFORM public.canteen_account_save(inv.camp_id, p_camper_name,
        COALESCE(v_locked_acct, '{"dailyLimit":10,"spentToday":0}'::jsonb)
                || jsonb_build_object('balance', v_balance));
        -- kind 'shop' so canteen revenue reporting doesn't count it as a
        -- snack sale, matching how cash_out is kept separate.
    PERFORM public.canteen_post(inv.camp_id, p_camper_name,
        jsonb_build_object(
                'time',   to_char(now_ts, 'HH12:MI AM'),
                'camper', p_camper_name,
                'items',  'Camp Shop order',
                'amount', v_total,
                'type',   'debit',
                'kind',   'shop',
                'date',   to_char(now_ts, 'YYYY-MM-DD')
            ));

    END IF;

    -- Bunk, so the office's pick list groups the order without a lookup.
    SELECT value->'camperRoster'->p_camper_name->>'bunk' INTO v_bunk
    FROM camp_state_kv WHERE camp_id = inv.camp_id AND key = 'app1';

    v_order_id := 'ord_p_' || replace(gen_random_uuid()::text, '-', '');

    v_shop := jsonb_set(
        v_shop, '{orders}',
        COALESCE(v_shop->'orders', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
            'id',          v_order_id,
            'camperName',  p_camper_name,
            'bunk',        COALESCE(v_bunk, ''),
            'lines',       v_lines,
            'status',      'placed',
            'paid',        (p_pay_method = 'canteen'),
            'payMethod',   p_pay_method,
            'notes',       COALESCE(p_notes, ''),
            'placedAt',    to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'source',      'parent'
        )),
        true
    );

    UPDATE camp_state_kv
    SET value = v_shop, updated_at = now_ts
    WHERE camp_id = inv.camp_id AND key = 'campistryShop';

    RETURN jsonb_build_object(
        'success', true, 'orderId', v_order_id,
        'total', v_total, 'items', v_count,
        'paid', (p_pay_method = 'canteen'),
        'balance', v_balance
    );
END;
$$;

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
    v_locked_acct jsonb;
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


    -- 219: one camper's row, not the camp's document.
    v_snacks := NULL::jsonb;  -- document no longer read
    v_locked_acct := public.canteen_account_lock(inv.camp_id, p_camper_name);

    v_acct := COALESCE(v_locked_acct, '{"balance":0,"dailyLimit":10,"spentToday":0}'::jsonb);
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
    PERFORM public.canteen_account_save(inv.camp_id, p_camper_name,
        v_acct);

    RETURN jsonb_build_object(
        'success', true,
        'processorKey', v_processorKey,
        'cardLabel', v_cardLabel,
        'autoReload', v_ar
    );
END;
$$;

-- ─── did it work? ───────────────────────────────────────────────────────────
-- still_locking_the_camp should now be 1: record_canteen_sale_inventory, which
-- keeps its lock deliberately. Anything above that is another overload nobody
-- has noticed yet.
SELECT 'migration 220 applied'                                              AS status,
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prokind = 'f'
           AND pg_get_functiondef(p.oid) ~ 'campistrySnacks''[^;]*FOR UPDATE')           AS still_locking_the_camp,
       (SELECT COALESCE(string_agg(p.proname || '(' ||
                 pg_get_function_identity_arguments(p.oid) || ')', ', '), '(none)')
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prokind = 'f'
           AND pg_get_functiondef(p.oid) ~ 'campistrySnacks''[^;]*FOR UPDATE')           AS which_ones;
