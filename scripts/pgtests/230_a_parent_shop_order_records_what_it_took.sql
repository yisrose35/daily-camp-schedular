-- Behaviour test for 230. The double-charge lives here rather than in 229's file
-- because it is 230 that fixes it: until this migration, settling a parent's
-- canteen-paid shop order took the total a second time, and asserting that from
-- 229 would be asserting 230's work one file early.
--
--   1. An order is priced from the STORED catalogue, not from what the client
--      sent — two tees at 12.50 is 25.00.
--   2. Stock is checked before any money moves.
--   3. The canteen balance is drawn exactly once, and the ledger records it as
--      kind=shop rather than as a snack sale.
--   4. SETTLING IT AGAIN COSTS NOTHING. This is the fix: the order now carries the
--      settlement 167 reads, so the same method at the same amount is the
--      "nothing changed" case.
--   5. Cancelling returns exactly what was taken, once.
--   6. A caller settling in a camp they are not in is refused.
--   7. The order carries the camper's id, and a renamed camper's parent can still
--      order — the fourth copy of the name-containment check is gone.

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;

-- 229's camp, roster, canteen balances and parent invite are this test's
-- fixture. Run on its own, this file used to fail at the first order with
-- no_active_invite, because nothing had created them; now it builds them by
-- running 229's test first, which is itself green on the full chain.
SELECT NOT EXISTS (SELECT 1 FROM camps WHERE id = 'f2900000-0000-0000-0000-000000000001')
       AS need_229 \gset
\if :need_229
    \ir 229_four_canteen_writers_that_always_failed.sql
\endif

-- A second camp, owned by somebody else, for the refusal in section 6. It used
-- to be simulated by stubbing get_user_camp_id() from a session setting — a
-- stub that REPLACED the real resolver for every test run after this one, and
-- turned 239, 240 and 242 into "not_authorized" in a shared database. The real
-- resolver (verbatim in scripts/pgstubs.sql) answers from camps.owner, which is
-- all this needs.
INSERT INTO auth.users (id, email)
VALUES ('f2900000-0000-0000-0000-0000000000ee', 'other-owner@230.test')
ON CONFLICT DO NOTHING;
INSERT INTO camps (id, owner, name)
VALUES ('f2900000-0000-0000-0000-00000000dead', 'f2900000-0000-0000-0000-0000000000ee', 'Another camp')
ON CONFLICT DO NOTHING;


-- ── 11. the shop order, placed and settled ──────────────────────────────────

DO $$
DECLARE
    camp uuid := 'f2900000-0000-0000-0000-000000000001';
    r    jsonb;
    bal0 numeric;
    bal1 numeric;
    oid  text;
BEGIN
    -- A catalogue with one product and three in stock. The variant key is
    -- slug(sku):slug(size):slug(color), which submit_shop_order recomputes.
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES (camp, 'campistryShop',
        jsonb_build_object(
            'products', jsonb_build_array(jsonb_build_object(
                'id', 1, 'sku', 'TEE', 'name', 'Camp tee', 'price', 12.50,
                'active', true,
                'stock', jsonb_build_object('tee:medium:navy', 3))),
            'orders', '[]'::jsonb,
            'settings', jsonb_build_object('parentAllowBackorder', false)))
    ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value;

    PERFORM set_config('test.uid', 'f2900000-0000-0000-0000-00000000e001', false);
    SELECT balance INTO bal0 FROM camp_canteen_accounts
     WHERE camp_id = camp AND account_key = 'Ayala Weiss';

    -- Out of stock is refused, and refuses BEFORE any money moves.
    r := public.submit_shop_order('Ayala Weiss',
             jsonb_build_array(jsonb_build_object('productId', '1', 'qty', 9,
                                                  'size', 'medium', 'color', 'navy')),
             'canteen', NULL, camp::text);
    IF (r ->> 'error') <> 'out_of_stock' THEN
        RAISE EXCEPTION 'an order for 9 of 3 in stock was accepted: %', r;
    END IF;
    IF (SELECT balance FROM camp_canteen_accounts
         WHERE camp_id = camp AND account_key = 'Ayala Weiss') IS DISTINCT FROM bal0 THEN
        RAISE EXCEPTION 'a refused order still took the money';
    END IF;

    -- Two tees at 12.50 is 25.00, drawn from the canteen balance.
    r := public.submit_shop_order('Ayala Weiss',
             jsonb_build_array(jsonb_build_object('productId', '1', 'qty', 2,
                                                  'size', 'medium', 'color', 'navy')),
             'canteen', 'leave at the office', camp::text);
    IF (r ->> 'success') IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'a shop order was refused: %', r;
    END IF;
    IF (r ->> 'total')::numeric IS DISTINCT FROM 25.00 OR (r ->> 'items')::int <> 2 THEN
        RAISE EXCEPTION 'the order priced at % for % items', r ->> 'total', r ->> 'items';
    END IF;
    SELECT balance INTO bal1 FROM camp_canteen_accounts
     WHERE camp_id = camp AND account_key = 'Ayala Weiss';
    IF bal1 IS DISTINCT FROM bal0 - 25.00 THEN
        RAISE EXCEPTION 'the canteen balance went from % to %, expected %', bal0, bal1, bal0 - 25.00;
    END IF;
    -- and the ledger records it as shop, not as a snack sale
    IF NOT EXISTS (SELECT 1 FROM canteen_transactions
                    WHERE camp_id = camp AND payload ->> 'kind' = 'shop' AND amount = 25.00) THEN
        RAISE EXCEPTION 'the shop charge is not in the ledger as kind=shop';
    END IF;
    oid := r ->> 'orderId';

    -- More than the balance is refused.
    r := public.submit_shop_order('Ayala Weiss',
             jsonb_build_array(jsonb_build_object('productId', '1', 'qty', 1,
                                                  'size', 'medium', 'color', 'navy')),
             'canteen', NULL, camp::text);
    IF (r ->> 'success') <> 'true' AND (r ->> 'error') <> 'insufficient_balance' THEN
        RAISE EXCEPTION 'unexpected answer to a third order: %', r;
    END IF;

    -- ── settle_shop_order, staff side ──────────────────────────────────────
    PERFORM set_config('test.uid', 'f2900000-0000-0000-0000-0000000000ff', false);
    IF public.get_user_camp_id() IS DISTINCT FROM camp THEN
        RAISE EXCEPTION 'setup: the owner does not resolve to their camp (%)', public.get_user_camp_id();
    END IF;
    r := public.settle_shop_order(camp, oid, 'canteen', 25.00, false);
    IF (r ->> 'success') IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'settling the order it already paid for was refused: %', r;
    END IF;
    -- Already charged at the same method and amount, so nothing moves again.
    IF (SELECT balance FROM camp_canteen_accounts
         WHERE camp_id = camp AND account_key = 'Ayala Weiss') IS DISTINCT FROM bal1 THEN
        RAISE EXCEPTION 'settling an already-paid order charged the camper twice: % vs %',
            (SELECT balance FROM camp_canteen_accounts
              WHERE camp_id = camp AND account_key = 'Ayala Weiss'), bal1;
    END IF;

    -- Cancelling it gives the money back.
    r := public.settle_shop_order(camp, oid, 'canteen', 25.00, true);
    IF (r ->> 'success') IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'cancelling the order was refused: %', r;
    END IF;
    IF (SELECT balance FROM camp_canteen_accounts
         WHERE camp_id = camp AND account_key = 'Ayala Weiss') IS DISTINCT FROM bal1 + 25.00 THEN
        RAISE EXCEPTION 'cancelling did not return the 25.00: balance is %',
            (SELECT balance FROM camp_canteen_accounts
              WHERE camp_id = camp AND account_key = 'Ayala Weiss');
    END IF;

    -- A camp the caller is not in is refused: the owner of ANOTHER camp.
    PERFORM set_config('test.uid', 'f2900000-0000-0000-0000-0000000000ee', false);
    IF public.get_user_camp_id() IS DISTINCT FROM 'f2900000-0000-0000-0000-00000000dead'::uuid THEN
        RAISE EXCEPTION 'setup: the other owner does not resolve to their own camp';
    END IF;
    IF (public.settle_shop_order(camp, oid, 'canteen', 25.00, false) ->> 'error')
       IS DISTINCT FROM 'not_authorized' THEN
        RAISE EXCEPTION 'a caller settled an order in a camp they are not in';
    END IF;
    PERFORM set_config('test.uid', 'f2900000-0000-0000-0000-0000000000ff', false);

    -- 7. The order records the camper's id, not just their name.
    IF (SELECT o ->> 'camperId'
          FROM camp_state_kv,
               LATERAL jsonb_array_elements(value -> 'orders') o
         WHERE camp_id = camp AND key = 'campistryShop' AND o ->> 'id' = oid)
       IS DISTINCT FROM '880' THEN
        RAISE EXCEPTION 'the order does not carry the camper id: %',
            (SELECT o FROM camp_state_kv, LATERAL jsonb_array_elements(value -> 'orders') o
              WHERE camp_id = camp AND key = 'campistryShop' AND o ->> 'id' = oid);
    END IF;

    RAISE NOTICE '230: a shop order prices from the catalogue, checks stock, draws the canteen '
                 'balance once, settles without double-charging, refunds on cancel, and carries '
                 'the camper id';
END $$;


-- ── 7b. and a renamed camper's parent can still order ───────────────────────
-- The fourth copy of the name-containment check is gone, so the invite still
-- saying the old spelling no longer refuses the order.
DO $$
DECLARE
    camp uuid := 'f2900000-0000-0000-0000-000000000001';
    r    jsonb;
    bal  numeric;
BEGIN
    PERFORM set_config('test.uid', 'f2900000-0000-0000-0000-00000000e001', false);

    UPDATE camp_state_kv
       SET value = jsonb_set(value, '{camperRoster}',
                             (value -> 'camperRoster') - 'Ayala Weiss'
                             || jsonb_build_object('A Weiss-Katz',
                                  jsonb_build_object('camperId', '880', 'name', 'A Weiss-Katz')))
     WHERE camp_id = camp AND key = 'app1';
    IF (SELECT camper_names FROM link_parent_invites
         WHERE user_id = 'f2900000-0000-0000-0000-00000000e001')
       IS DISTINCT FROM jsonb_build_array('Ayala Weiss') THEN
        RAISE EXCEPTION 'the invite was rewritten, so the rename case is not being tested';
    END IF;

    SELECT balance INTO bal FROM camp_canteen_accounts
     WHERE camp_id = camp AND account_key = 'Ayala Weiss';

    -- By her NEW name, which the invite has never heard of.
    r := public.submit_shop_order('A Weiss-Katz',
             jsonb_build_array(jsonb_build_object('productId', '1', 'qty', 1,
                                                  'size', 'medium', 'color', 'navy')),
             'canteen', NULL, camp::text, NULL);
    IF (r ->> 'success') IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'a renamed camper''s parent could not place an order: %', r;
    END IF;
    IF (SELECT balance FROM camp_canteen_accounts
         WHERE camp_id = camp AND account_key = 'Ayala Weiss') IS DISTINCT FROM bal - 12.50 THEN
        RAISE EXCEPTION 'the order did not draw her own balance: % from %',
            (SELECT balance FROM camp_canteen_accounts
              WHERE camp_id = camp AND account_key = 'Ayala Weiss'), bal;
    END IF;

    -- And by id, with no name at all.
    r := public.submit_shop_order(NULL,
             jsonb_build_array(jsonb_build_object('productId', '1', 'qty', 1,
                                                  'size', 'medium', 'color', 'navy')),
             'canteen', NULL, camp::text, 880);
    IF (r ->> 'success') IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'an order placed by camper id was refused: %', r;
    END IF;

    -- An id with a MISMATCHED name beside it: the id wins and the order is
    -- labelled from the roster, not from the name the caller sent. Otherwise a
    -- caller could file one child's order under another child's name while
    -- drawing the first one's balance.
    --
    -- Topped up first, so the assertion is about the LABEL and not about the
    -- balance the previous orders happened to leave.
    PERFORM public.canteen_account_save(camp, 'Ayala Weiss',
        public.canteen_account_lock(camp, 'Ayala Weiss')
            || jsonb_build_object('balance', 40.00));
    SELECT balance INTO bal FROM camp_canteen_accounts
     WHERE camp_id = camp AND account_key = 'Ayala Weiss';
    r := public.submit_shop_order('Dov Lerner',
             jsonb_build_array(jsonb_build_object('productId', '1', 'qty', 1,
                                                 'size', 'medium', 'color', 'navy')),
             'canteen', NULL, camp::text, 880);
    IF (r ->> 'success') IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'the id path was refused because of the name beside it: %', r;
    END IF;
    IF (SELECT o ->> 'camperName'
          FROM camp_state_kv, LATERAL jsonb_array_elements(value -> 'orders') o
         WHERE camp_id = camp AND key = 'campistryShop'
           AND o ->> 'id' = (r ->> 'orderId')) IS DISTINCT FROM 'A Weiss-Katz' THEN
        RAISE EXCEPTION 'the order was labelled with the name beside the id, not the roster key: %',
            (SELECT o ->> 'camperName'
               FROM camp_state_kv, LATERAL jsonb_array_elements(value -> 'orders') o
              WHERE camp_id = camp AND key = 'campistryShop'
                AND o ->> 'id' = (r ->> 'orderId'));
    END IF;
    IF (SELECT balance FROM camp_canteen_accounts
         WHERE camp_id = camp AND account_key = 'Ayala Weiss') IS DISTINCT FROM bal - 12.50 THEN
        RAISE EXCEPTION 'the mismatched-name order did not draw the id''s own balance';
    END IF;

    -- Another family's child is still refused, by id.
    IF (public.submit_shop_order(NULL,
            jsonb_build_array(jsonb_build_object('productId', '1', 'qty', 1,
                                                'size', 'medium', 'color', 'navy')),
            'canteen', NULL, camp::text, 881) ->> 'error') <> 'camper_not_on_invite' THEN
        RAISE EXCEPTION 'a parent ordered against another family''s child';
    END IF;
    RAISE NOTICE '230: a renamed camper''s parent can order, by either name or by id, and '
                 'another family''s child is still refused';
END $$;
