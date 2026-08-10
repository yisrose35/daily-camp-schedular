-- ============================================================================
-- Migration 052: Camp-scope the Camp Shop for multi-camp parents.
--
-- Exactly the bug migration 043 fixed for tips, still present in the shop.
-- Both shop RPCs resolve the caller's invite as the single most-recent one
-- (ORDER BY created_at DESC LIMIT 1) with no way to say which camp is meant:
--
--   submit_shop_order   — a parent browsing Camp A's catalogue (the client DOES
--                         pass p_camp_id there) places an order that is written
--                         against whichever invite happens to be newest. The
--                         wrong camp's stock is decremented, the wrong camp
--                         bills the family, and Camp A never sees the order.
--   get_my_shop_orders  — shows one camp's orders only, and not necessarily the
--                         camp the parent is looking at.
--
-- submit_shop_order gains an optional trailing p_camp_id, resolved the same way
-- as in 043. get_my_shop_orders instead returns orders across ALL of the
-- parent's active camps when no camp is given — for a read, "everything of
-- mine" is the honest answer, and each order is tagged with its camp so the
-- client can group them.
--
-- Trailing DEFAULTs keep every existing caller working.
-- ============================================================================

-- ─── 1. submit_shop_order ────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.submit_shop_order(text, jsonb, text, text);
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

REVOKE ALL ON FUNCTION public.submit_shop_order(text, jsonb, text, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.submit_shop_order(text, jsonb, text, text, text) TO authenticated;


-- ─── 2. get_my_shop_orders ───────────────────────────────────────────────────
-- No camp given = every camp this parent has an active invite for. Each order
-- carries its camp_id so the client can group or filter.
DROP FUNCTION IF EXISTS public.get_my_shop_orders();
CREATE OR REPLACE FUNCTION public.get_my_shop_orders(p_camp_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller   uuid := auth.uid();
    inv      link_parent_invites;
    v_value  jsonb;
    v_part   jsonb;
    v_orders jsonb := '[]'::jsonb;
    v_any    boolean := false;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    FOR inv IN
        SELECT * FROM link_parent_invites
        WHERE user_id = caller AND status = 'active'
          AND (expires_at IS NULL OR expires_at > now())
          AND (p_camp_id IS NULL OR camp_id = p_camp_id)
        ORDER BY created_at DESC
    LOOP
        v_any := true;

        SELECT value INTO v_value FROM camp_state_kv
        WHERE camp_id = inv.camp_id AND key = 'campistryShop';
        IF v_value IS NULL THEN CONTINUE; END IF;

        SELECT COALESCE(jsonb_agg(o || jsonb_build_object('campId', inv.camp_id)), '[]'::jsonb)
        INTO v_part
        FROM jsonb_array_elements(COALESCE(v_value->'orders', '[]'::jsonb)) AS o
        WHERE inv.camper_names IS NULL
           OR inv.camper_names ? (o->>'camperName');

        v_orders := v_orders || v_part;
    END LOOP;

    IF NOT v_any THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;

    RETURN jsonb_build_object('success', true, 'orders', v_orders);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_shop_orders(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_shop_orders(uuid) TO authenticated;
