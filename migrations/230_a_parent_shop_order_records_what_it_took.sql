-- ============================================================================
-- 230 — a parent's shop order records what it took, so the office cannot
--        charge for it twice
--
-- THE DEFECT. Migration 167 built settle_shop_order around one idea, and says so
-- in its own header: "the order carries a `settlement` record of what was
-- ACTUALLY taken, and this function moves it from where it is to where it should
-- be". Same method, new total → post the difference. Cancelled → reverse in
-- full. Nothing changed → do nothing at all.
--
-- submit_shop_order is the PARENT's path and predates 167 by a hundred
-- migrations. When a parent pays from the canteen it debits the balance, posts
-- the ledger row, and writes the order as
--
--     'paid',      true,
--     'payMethod', 'canteen',
--
-- and no `settlement`. So settle_shop_order reads method 'none', amount 0, sees
-- a 25.00 canteen settlement as the NEW state, and charges the camper 25.00 —
-- the second time.
--
-- The office does not have to do anything unusual to trigger it. Opening a
-- parent's order and saving it is enough; that is what settle_shop_order is for.
-- The child's canteen balance goes 10.00 → −15.00 for one order of two tees.
--
-- Found by calling the function. tests/transform_leftovers.test.js now refuses to
-- let a script-converted writer sit uncalled, which is how this surfaced: it was
-- on the list of six that 219's transform rewrote and no behaviour test had ever
-- executed. Four of that six turned out to fail on every call (229); this one
-- turned out to charge twice.
--
-- THE FIX is one field. The parent path DID settle by canteen, for the order
-- total, at that moment — so it says so, in the shape 167 reads. Then a
-- settlement at the same method and amount is the "nothing changed" case and
-- costs nothing, a change of method reverses correctly, and a cancellation
-- returns exactly what was taken.
--
-- WHILE THE BODY IS BEING RESTATED, two other things go with it, because they are
-- the same function and leaving them would mean restating it twice:
--
--   * the inline name-containment check becomes 224's shared gate. This was the
--     FOURTH copy of `IF inv.camper_names IS NOT NULL AND NOT (inv.camper_names
--     ? p_camper_name)` — 224 fixed one, 225 found three, 226 found a fifth in
--     tips. So a renamed camper's parent can order again, and a name that means
--     two children is refused rather than guessed.
--   * it takes p_camper_id, derives the label from the roster rather than from
--     the name passed beside the id, and stamps camperId on the order.
--
-- The pricing, the variant-key computation, the stock check, the 50-per-line and
-- 40-line caps, the insufficient-balance refusal and the ledger row are COPIED,
-- not retyped: this file was produced by transforming 220's body with five
-- textual rules, each asserted to have matched exactly once. The money arithmetic
-- is byte-for-byte what it was, and scripts/pgtests/229 checks the numbers either
-- way — 2 × 12.50 = 25.00, three in stock refusing an order for nine, and the
-- balance moving exactly once.
--
-- THE OLD FIVE-ARGUMENT SIGNATURE IS DROPPED, by name, because adding
-- p_camper_id would otherwise leave two overloads PostgREST cannot choose
-- between — which is what 228 was for.
--
-- HOW TO APPLY. Paste into the SQL Editor after 229. One transaction,
-- idempotent.
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = '_parent_invite_for') THEN
        RAISE EXCEPTION '_parent_invite_for is missing — apply migration 225 before this file';
    END IF;
END $$;

SET LOCAL lock_timeout = '15s';


CREATE OR REPLACE FUNCTION public.submit_shop_order(
    p_camper_name text,
    p_lines       jsonb,
    p_pay_method  text DEFAULT 'bill',
    p_notes       text DEFAULT NULL,
    p_camp_id     text   DEFAULT NULL,
    p_camper_id   bigint DEFAULT NULL
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
    v_id       bigint := p_camper_id;
    v_name     text;
    v_camp     uuid;
    now_ts     timestamptz := now();
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF COALESCE(btrim(p_camper_name), '') = '' AND v_id IS NULL THEN
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

    -- 224's gate, not a fourth copy of the name-containment check. The invite
    -- that COVERS this child, preferring one that names them over the camp-wide
    -- wildcard, rather than whichever the parent created most recently.
    IF COALESCE(btrim(p_camp_id), '') <> '' THEN
        BEGIN
            v_camp := p_camp_id::uuid;
        EXCEPTION WHEN invalid_text_representation THEN
            -- A camp id that is not a camp must refuse, not widen the search to
            -- every camp this parent belongs to.
            RETURN jsonb_build_object('success', false, 'error', 'bad_camp');
        END;
    END IF;

    inv := public._parent_invite_for(v_camp, v_id, p_camper_name);
    IF inv.id IS NULL THEN
        -- Told apart, so a parent is not sent to the camp about a missing invite
        -- they do have.
        IF EXISTS (SELECT 1 FROM link_parent_invites
                    WHERE user_id = caller AND status = 'active'
                      AND (expires_at IS NULL OR expires_at > now())
                      AND (v_camp IS NULL OR camp_id = v_camp)) THEN
            RETURN jsonb_build_object('success', false, 'error', 'camper_not_on_invite');
        END IF;
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;

    -- The label comes from the roster when an id was given, never from the name
    -- beside it.
    IF v_id IS NOT NULL THEN
        v_name := public.camp_person_label(inv.camp_id, v_id);
        IF v_name IS NULL THEN
            RETURN jsonb_build_object('success', false, 'error', 'unknown_camper');
        END IF;
    ELSE
        v_name := p_camper_name;
        v_id   := public.camp_person_by_name(inv.camp_id, v_name);
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
    v_locked_acct := public.canteen_account_lock(inv.camp_id, v_name);

        v_balance := COALESCE((v_locked_acct->>'balance')::numeric, 0);

        IF v_balance < v_total THEN
            RETURN jsonb_build_object('success', false, 'error', 'insufficient_balance',
                                      'balance', v_balance, 'total', v_total);
        END IF;

        v_balance := round(v_balance - v_total, 2);
    PERFORM public.canteen_account_save(inv.camp_id, v_name,
        COALESCE(v_locked_acct, '{"dailyLimit":10,"spentToday":0}'::jsonb)
                || jsonb_build_object('balance', v_balance));
        -- kind 'shop' so canteen revenue reporting doesn't count it as a
        -- snack sale, matching how cash_out is kept separate.
    PERFORM public.canteen_post(inv.camp_id, v_name,
        jsonb_build_object(
                'time',   to_char(now_ts, 'HH12:MI AM'),
                'camper', v_name,
                'items',  'Camp Shop order',
                'amount', v_total,
                'type',   'debit',
                'kind',   'shop',
                'date',   to_char(now_ts, 'YYYY-MM-DD')
            ));

    END IF;

    -- Bunk, so the office's pick list groups the order without a lookup.
    SELECT value->'camperRoster'->v_name->>'bunk' INTO v_bunk
    FROM camp_state_kv WHERE camp_id = inv.camp_id AND key = 'app1';

    v_order_id := 'ord_p_' || replace(gen_random_uuid()::text, '-', '');

    v_shop := jsonb_set(
        v_shop, '{orders}',
        COALESCE(v_shop->'orders', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
            'id',          v_order_id,
            'camperName',  v_name,
            'bunk',        COALESCE(v_bunk, ''),
            'lines',       v_lines,
            'status',      'placed',
            'paid',        (p_pay_method = 'canteen'),
            'payMethod',   p_pay_method,
            'camperId',    v_id,
            -- THE FIX. 167 built settle_shop_order around the order carrying a
            -- `settlement` record of what was ACTUALLY taken, so a re-save posts
            -- only the DIFFERENCE. This function predates 167: it took the money
            -- from the canteen and wrote no settlement, so the first time the
            -- office saved a parent's canteen-paid order settle_shop_order read
            -- method 'none' and amount 0, and charged the camper the whole total
            -- a SECOND time.
            'settlement',  CASE WHEN p_pay_method = 'canteen'
                                THEN jsonb_build_object(
                                    'method', 'canteen',
                                    'amount', v_total,
                                    'familyKey', NULL,
                                    'at', to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
                           END,
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
$$;REVOKE ALL ON FUNCTION public.submit_shop_order(text, jsonb, text, text, text, bigint)
    FROM public, anon;
GRANT EXECUTE ON FUNCTION public.submit_shop_order(text, jsonb, text, text, text, bigint)
    TO authenticated;

-- The signature this replaces. Adding a defaulted parameter and keeping the old
-- form is exactly the PGRST203 trap 228 exists to close.
DROP FUNCTION IF EXISTS public.submit_shop_order(text, jsonb, text, text, text);

DO $$
DECLARE n integer;
BEGIN
    SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public' AND p.proname = 'submit_shop_order';
    IF n <> 1 THEN
        RAISE EXCEPTION 'submit_shop_order has % overloads', n;
    END IF;
END $$;


-- ─── did it work? ───────────────────────────────────────────────────────────
SELECT 'migration 230 applied' AS status,
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'submit_shop_order')          AS overloads,
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'submit_shop_order'
           AND p.prosrc ~ 'settlement')                                            AS records_settlement;
