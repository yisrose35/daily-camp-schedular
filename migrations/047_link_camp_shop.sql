-- ============================================================================
-- Migration: get_shop_catalogue + submit_shop_order
--
-- Why: the Camp Shop (campistry_snacks_shop.js) keeps its catalogue and orders
--      as one JSON blob in camp_state_kv (key='campistryShop', shape
--      { products:[...], orders:[...], settings:{...} }). Camp staff read and
--      write it directly under an authenticated session; RLS allows that.
--
--      Parents have no such session. For a parent to buy a t-shirt from the
--      Link portal they need to READ the catalogue and APPEND an order to that
--      same blob — which is exactly the shape submit_canteen_deposit already
--      solved for canteen funds (migration 019), so this follows that pattern.
--
-- SECURITY NOTES — the parts that matter:
--
--   1. PRICES ARE COMPUTED SERVER-SIDE. The client sends product id, size,
--      colour and quantity, and nothing else. It does NOT send a price. A
--      submitted price would be trivially editable in devtools; the order total
--      is recomputed here from the stored catalogue every time.
--
--   2. The parent may only order for a camper on their own active invite —
--      same check as the canteen deposit.
--
--   3. Only ACTIVE products can be ordered, so pulling an item from sale
--      actually pulls it.
--
--   4. Stock is checked unless the camp opts into backorders
--      (settings.parentAllowBackorder). A parent ordering an Adult Medium that
--      doesn't exist just becomes a problem for the office later.
--
--   5. Paying from the canteen balance touches a SECOND blob
--      (campistrySnacks). Both rows are locked, ALWAYS in the same order
--      (campistryShop then campistrySnacks), so a shop order and a canteen
--      deposit racing each other can't deadlock.
--
-- Orders arrive as status 'placed', paid=false unless drawn from the canteen
-- balance. The office fulfils them from the Snacks -> Camp Shop screen exactly
-- as it does for orders taken at the desk.
-- ============================================================================

-- ─── 1. get_shop_catalogue ────────────────────────────────────────────────────
-- Read-only. Returns only what a storefront needs — products that are on sale,
-- plus the handful of settings the portal renders. Orders are NOT returned:
-- one parent must never see another family's purchases.
CREATE OR REPLACE FUNCTION public.get_shop_catalogue(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_value jsonb;
    v_products jsonb;
BEGIN
    SELECT value INTO v_value
    FROM camp_state_kv
    WHERE camp_id = p_camp_id AND key = 'campistryShop';

    IF v_value IS NULL THEN
        RETURN jsonb_build_object('success', true, 'products', '[]'::jsonb, 'settings', '{}'::jsonb);
    END IF;

    -- active is opt-out: a product saved before the flag existed is on sale.
    SELECT COALESCE(jsonb_agg(p), '[]'::jsonb) INTO v_products
    FROM jsonb_array_elements(COALESCE(v_value->'products', '[]'::jsonb)) AS p
    WHERE COALESCE((p->>'active')::boolean, true) IS TRUE;

    RETURN jsonb_build_object(
        'success', true,
        'products', v_products,
        'settings', COALESCE(v_value->'settings', '{}'::jsonb)
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.get_shop_catalogue(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_shop_catalogue(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_shop_catalogue(uuid) TO anon;


-- ─── 2. get_my_shop_orders ────────────────────────────────────────────────────
-- A parent's own order history, filtered to the campers on their invite.
CREATE OR REPLACE FUNCTION public.get_my_shop_orders()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    inv    link_parent_invites;
    v_value jsonb;
    v_orders jsonb;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    SELECT * INTO inv
    FROM link_parent_invites
    WHERE user_id = caller AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
    ORDER BY created_at DESC
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;

    SELECT value INTO v_value
    FROM camp_state_kv
    WHERE camp_id = inv.camp_id AND key = 'campistryShop';

    IF v_value IS NULL THEN
        RETURN jsonb_build_object('success', true, 'orders', '[]'::jsonb);
    END IF;

    SELECT COALESCE(jsonb_agg(o), '[]'::jsonb) INTO v_orders
    FROM jsonb_array_elements(COALESCE(v_value->'orders', '[]'::jsonb)) AS o
    WHERE inv.camper_names IS NULL
       OR inv.camper_names ? (o->>'camperName');

    RETURN jsonb_build_object('success', true, 'orders', v_orders);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_shop_orders() FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_shop_orders() TO authenticated;


-- ─── 3. submit_shop_order ─────────────────────────────────────────────────────
-- p_lines: [{ "productId": 1, "size": "AM", "color": "Navy", "qty": 2 }, ...]
--          Deliberately NO price field — see security note 1 above.
-- p_pay_method: 'bill' (charge to the camp bill) or 'canteen' (draw from the
--          camper's canteen balance). Card processing isn't wired anywhere in
--          Campistry yet, so there's nothing honest to offer beyond these.
CREATE OR REPLACE FUNCTION public.submit_shop_order(
    p_camper_name text,
    p_lines       jsonb,
    p_pay_method  text DEFAULT 'bill',
    p_notes       text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
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

    SELECT * INTO inv
    FROM link_parent_invites
    WHERE user_id = caller AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
    ORDER BY created_at DESC
    LIMIT 1;

    IF NOT FOUND THEN
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
        INSERT INTO camp_state_kv (camp_id, key, value, updated_at)
        VALUES (inv.camp_id, 'campistrySnacks', '{"accounts":{},"transactions":[]}'::jsonb, now_ts)
        ON CONFLICT (camp_id, key) DO NOTHING;

        SELECT value INTO v_snacks
        FROM camp_state_kv
        WHERE camp_id = inv.camp_id AND key = 'campistrySnacks'
        FOR UPDATE;

        IF v_snacks IS NULL THEN v_snacks := '{"accounts":{},"transactions":[]}'::jsonb; END IF;
        v_balance := COALESCE((v_snacks->'accounts'->p_camper_name->>'balance')::numeric, 0);

        IF v_balance < v_total THEN
            RETURN jsonb_build_object('success', false, 'error', 'insufficient_balance',
                                      'balance', v_balance, 'total', v_total);
        END IF;

        v_balance := round(v_balance - v_total, 2);
        v_snacks := jsonb_set(
            v_snacks, ARRAY['accounts', p_camper_name],
            COALESCE(v_snacks->'accounts'->p_camper_name, '{"dailyLimit":10,"spentToday":0}'::jsonb)
                || jsonb_build_object('balance', v_balance),
            true
        );
        -- kind 'shop' so canteen revenue reporting doesn't count it as a
        -- snack sale, matching how cash_out is kept separate.
        v_snacks := jsonb_set(
            v_snacks, '{transactions}',
            jsonb_build_array(jsonb_build_object(
                'time',   to_char(now_ts, 'HH12:MI AM'),
                'camper', p_camper_name,
                'items',  'Camp Shop order',
                'amount', v_total,
                'type',   'debit',
                'kind',   'shop',
                'date',   to_char(now_ts, 'YYYY-MM-DD')
            )) || COALESCE(v_snacks->'transactions', '[]'::jsonb)
        );

        UPDATE camp_state_kv
        SET value = v_snacks, updated_at = now_ts
        WHERE camp_id = inv.camp_id AND key = 'campistrySnacks';
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

REVOKE ALL ON FUNCTION public.submit_shop_order(text, jsonb, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.submit_shop_order(text, jsonb, text, text) TO authenticated;


-- ─── 4. Sanity check ──────────────────────────────────────────────────────────
--   SELECT proname FROM pg_proc
--   WHERE proname IN ('get_shop_catalogue','get_my_shop_orders','submit_shop_order');
