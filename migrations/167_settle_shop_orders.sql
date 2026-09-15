-- ============================================================================
-- Migration 167: make the Camp Shop actually take the money.
--
-- THE DEFECT: the admin shop's order form offers five payment methods, two of
-- which promise to move money —
--
--     "Charge to canteen account"  -> debit the camper's canteen wallet
--     "Charge to camp bill"        -> post the amount to the family's Billing
--
-- and NEITHER did anything. campistry_snacks_shop.js stored `payMethod` on the
-- order, displayed it, exported it to CSV — and never settled it. The camp
-- handed over a sweatshirt and the money was recorded nowhere: the camper's
-- canteen balance was untouched, the family's balance was untouched, and the
-- parent never saw a charge. The order sat there marked with a payment method
-- that had never been collected.
--
-- The parent-facing shop (migration 122's place_shop_order) does this
-- correctly — it debits the wallet and appends a 'debit'/'shop' transaction —
-- which is how we know the intended behaviour. The admin path simply never got
-- implemented.
--
-- ── WHY THIS IS SERVER-SIDE ────────────────────────────────────────────────
-- Two reasons, and the first is now structural:
--
--   1. ACCESS. Since phase 3, campistryMe and campistrySnacks are gated per
--      user in RLS. The shop lives inside the Snacks page, so a canteen worker
--      with snacks.shop can reach it — but cannot write campistryMe. A
--      client-side "charge to camp bill" would be silently denied for exactly
--      the people who take shop orders. SECURITY DEFINER settles that.
--   2. ATOMICITY. Debiting a wallet and marking an order settled must not be
--      two separate blob writes that a stale tab can half-apply.
--
-- ── IDEMPOTENCY IS THE WHOLE DESIGN ────────────────────────────────────────
-- An order gets EDITED — a size changes, a line is added, the method switches
-- from canteen to camp bill, the order is cancelled. A naive "charge on save"
-- double-charges on the second save. So the order carries a `settlement`
-- record of what was ACTUALLY taken, and this function moves it from where it
-- is to where it should be:
--
--     same method, new total  -> post the DIFFERENCE
--     method changed          -> reverse the old in full, apply the new
--     cancelled               -> reverse in full
--     nothing changed         -> do nothing at all
--
-- Canteen adjustments are append-only transactions (a reversal is its own
-- 'credit' row) because the canteen balance is RECOMPUTED from that ledger by
-- _reconcileBalances — a balance edit without a matching transaction is erased
-- by the next merge. A camp bill is a SET of one charge keyed to the order, so
-- re-settling replaces rather than stacks.
--
-- ── WHAT DOES NOT SETTLE ───────────────────────────────────────────────────
-- credit / cash / check are collected outside Campistry. Nothing is posted for
-- them — but switching TO one still reverses a previous canteen or bill
-- settlement, which is the case that would otherwise leave money taken for an
-- order now marked "paid by cash".
--
-- Idempotent. Requires 122 (shop orders) and the campistrySnacks ledger shape.
-- ============================================================================

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
    SELECT value INTO v_shop FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryShop';
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
         WHERE camp_id = p_camp_id AND key = 'campistrySnacks';
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
          FROM jsonb_each(COALESCE(v_me->'families', '{}'::jsonb)) f
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
            v_charges  := COALESCE(v_me #> ARRAY['families', v_famKey, 'charges'], '[]'::jsonb);

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

            v_me := jsonb_set(v_me, ARRAY['families', v_famKey, 'charges'], v_kept, true);
            UPDATE camp_state_kv SET value = v_me, updated_at = now_ts
             WHERE camp_id = p_camp_id AND key = 'campistryMe';
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
REVOKE ALL ON FUNCTION public.settle_shop_order(uuid, text, text, numeric, boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.settle_shop_order(uuid, text, text, numeric, boolean) TO authenticated;

-- ─── Checking it on a live camp ────────────────────────────────────────────
-- The canteen invariant — balance must equal the sum of the ledger — holds
-- after a shop order, a shop edit and a cancellation:
--
--   select p_camper,
--          (value->'accounts'->p_camper->>'balance')::numeric as stored,
--          (select sum(case when t->>'type' = 'credit'
--                           then (t->>'amount')::numeric
--                           else -(t->>'amount')::numeric end)
--             from jsonb_array_elements(value->'transactions') t
--            where t->>'camper' = p_camper) as from_ledger
--     from camp_state_kv where key = 'campistrySnacks';
--   -- stored must equal from_ledger
--
-- A camp-bill order appears exactly once on the family, however many times the
-- order is saved:
--   select f.key, c->>'id', c->>'amount'
--     from camp_state_kv k,
--          jsonb_each(k.value->'families') f,
--          jsonb_array_elements(f.value->'charges') c
--    where k.key = 'campistryMe' and c->>'shopOrderId' is not null;
--   -- one row per order, never two
-- ============================================================================
