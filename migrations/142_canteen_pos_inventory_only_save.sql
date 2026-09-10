-- ============================================================================
-- 142_canteen_pos_inventory_only_save.sql
--
-- Root cause of a more serious problem than migrations 140/141 fixed: the
-- POS's own cloud-save cycle (campistry_snacks_pos.js's cloudSaveSnacks) does
-- a plain SELECT-then-merge-then-blind-UPSERT of the ENTIRE campistrySnacks
-- blob, with no row lock and no version check. If a server-side, row-locked
-- writer (submit_canteen_purchase, credit_canteen_balance_from_processor)
-- commits its own change to accounts/transactions in the narrow window
-- between the POS's SELECT and its later UPSERT, the POS's blind write can
-- silently OVERWRITE that entire change — not just the autoReload field
-- migration 141's client fix already protects, but a whole newly-credited
-- transaction and balance increment, vanishing completely.
--
-- Confirmed live via the camp's real Cardknox merchant transaction log: 3 of
-- 9 approved charges that day never appeared anywhere in campistrySnacks —
-- real money taken off the card with zero record of it in the app.
--
-- The POS's purchase-completion save only ever legitimately needs to persist
-- TWO things after a sale: per-item inventory counters (stock/soldToday/
-- totalSold) and the hourly-activity counter. Balance and the transaction
-- itself are ALREADY safely, atomically written by submit_canteen_purchase
-- (migration 026) — the POS never needed to touch accounts/transactions on
-- this path at all. This RPC gives it a way to persist just the inventory
-- delta, atomically, under the same FOR UPDATE row lock every other writer
-- to this row already uses — so it can never again race with or clobber a
-- concurrent balance/transaction write from anywhere else.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.record_canteen_sale_inventory(
    p_camp_id uuid,
    p_items   jsonb,   -- array of {"id": text, "qty": integer}
    p_hour    integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller   uuid := auth.uid();
    is_staff boolean;
    v_value  jsonb;
    v_inv    jsonb;
    v_item   jsonb;
    i        int;
    now_ts   timestamptz := now();
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    IF p_camp_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'missing_camp'); END IF;

    -- Same staff bar as submit_canteen_purchase (owner, or any camp_users row).
    SELECT (p_camp_id = caller
            OR EXISTS (SELECT 1 FROM camps c WHERE c.id = p_camp_id AND c.owner = caller)
            OR EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = p_camp_id AND u.user_id = caller))
      INTO is_staff;
    IF NOT is_staff THEN RETURN jsonb_build_object('success', false, 'error', 'not_authorized'); END IF;

    SELECT value INTO v_value FROM camp_state_kv
    WHERE camp_id = p_camp_id AND key = 'campistrySnacks' FOR UPDATE;
    IF v_value IS NULL THEN RETURN jsonb_build_object('success', true); END IF;
    IF v_value->'inventory' IS NULL THEN v_value := jsonb_set(v_value, '{inventory}', '[]'::jsonb); END IF;

    v_inv := v_value->'inventory';
    FOR i IN 0 .. jsonb_array_length(COALESCE(p_items, '[]'::jsonb)) - 1 LOOP
        v_item := p_items->i;
        v_inv := (
            SELECT COALESCE(jsonb_agg(
                CASE WHEN elem->>'id' = v_item->>'id' THEN
                    elem || jsonb_build_object(
                        'stock', CASE WHEN elem->'stock' IS NOT NULL AND elem->'stock' IS DISTINCT FROM 'null'::jsonb
                                      THEN to_jsonb(GREATEST(0, COALESCE((elem->>'stock')::numeric, 0) - COALESCE((v_item->>'qty')::numeric, 0)))
                                      ELSE elem->'stock' END,
                        'soldToday', COALESCE((elem->>'soldToday')::numeric, 0) + COALESCE((v_item->>'qty')::numeric, 0),
                        'totalSold', COALESCE((elem->>'totalSold')::numeric, 0) + COALESCE((v_item->>'qty')::numeric, 0)
                    )
                ELSE elem END
            ), '[]'::jsonb)
            FROM jsonb_array_elements(v_inv) elem
        );
    END LOOP;
    v_value := jsonb_set(v_value, '{inventory}', v_inv);

    IF p_hour IS NOT NULL THEN
        IF v_value->'hourlyActivity' IS NULL THEN v_value := jsonb_set(v_value, '{hourlyActivity}', '{}'::jsonb); END IF;
        v_value := jsonb_set(v_value, ARRAY['hourlyActivity', p_hour::text],
            to_jsonb(COALESCE((v_value->'hourlyActivity'->>(p_hour::text))::numeric, 0) + 1));
    END IF;

    UPDATE camp_state_kv SET value = v_value, updated_at = now_ts
    WHERE camp_id = p_camp_id AND key = 'campistrySnacks';

    RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public.record_canteen_sale_inventory(uuid, jsonb, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.record_canteen_sale_inventory(uuid, jsonb, integer) TO authenticated;
