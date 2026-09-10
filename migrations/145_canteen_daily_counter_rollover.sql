-- ============================================================================
-- 145_canteen_daily_counter_rollover.sql
--
-- campistrySnacks carries two "today" counters that nothing ever reset:
--   • inventory[].soldToday  — the Menu Items tab's "Sold Today" column
--   • hourlyActivity         — the Analytics tab's by-hour chart
--
-- account.spentToday has always rolled over off its own lastSpendDate stamp.
-- These two never did, so they simply accumulated for the life of the camp,
-- while the dashboard's "Revenue Today" tile (correctly filtered to
-- transactions where date = today) reported the real figure. The two then
-- disagreed by however many days the counters had been running — observed
-- live as a dashboard reading $8.00 across 3 transactions sitting above a
-- Menu Items table whose own per-item counts added up to $31.75.
--
-- The client now stamps the blob with countersDay and zeroes the counters when
-- that stamp is stale. That alone is NOT enough for the register: the POS's
-- sale path deliberately does not write the blob (see migration 142 — a blind
-- upsert from the POS could clobber a concurrent, row-locked balance write),
-- it only sends inventory deltas through record_canteen_sale_inventory. So a
-- register making the day's first sale at 8am would have its locally-rolled
-- zero ignored and the delta added on top of yesterday's server-side total.
--
-- This migration moves the rollover INTO that RPC, under the same FOR UPDATE
-- row lock that applies the deltas: if the stored countersDay differs from the
-- day the register is selling on, every soldToday is zeroed and hourlyActivity
-- cleared BEFORE the deltas are applied, all in one transaction.
--
-- p_day defaults to NULL, which means "don't roll" — byte-identical behaviour
-- to migration 142 for any caller that doesn't pass it. The old three-argument
-- function is dropped first so a three-argument call resolves to this one via
-- the default rather than becoming an ambiguous overload.
-- ============================================================================

DROP FUNCTION IF EXISTS public.record_canteen_sale_inventory(uuid, jsonb, integer);

CREATE OR REPLACE FUNCTION public.record_canteen_sale_inventory(
    p_camp_id uuid,
    p_items   jsonb,   -- array of {"id": text, "qty": integer}
    p_hour    integer DEFAULT NULL,
    p_day     text    DEFAULT NULL   -- 'YYYY-MM-DD' in the register's local time
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller    uuid := auth.uid();
    is_staff  boolean;
    v_value   jsonb;
    v_inv     jsonb;
    v_item    jsonb;
    v_rolled  boolean := false;
    i         int;
    now_ts    timestamptz := now();
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

    -- ── Day rollover, before any delta is applied ──────────────────────────
    -- Only when the caller told us what day it is AND the stored stamp says a
    -- different one. A blob that has never carried countersDay (every camp,
    -- until this ships) just gets stamped: its counters may well be today's,
    -- and zeroing them on the strength of a missing stamp would throw away a
    -- real day's numbers.
    IF p_day IS NOT NULL AND v_value->>'countersDay' IS DISTINCT FROM p_day THEN
        IF v_value->>'countersDay' IS NOT NULL THEN
            v_inv := (
                SELECT COALESCE(jsonb_agg(elem || jsonb_build_object('soldToday', 0)), '[]'::jsonb)
                FROM jsonb_array_elements(v_inv) elem
            );
            v_value := jsonb_set(v_value, '{hourlyActivity}', '{}'::jsonb);
            v_rolled := true;
        END IF;
        v_value := jsonb_set(v_value, '{countersDay}', to_jsonb(p_day), true);
    END IF;

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

    RETURN jsonb_build_object('success', true, 'rolled', v_rolled);
END;
$$;
REVOKE ALL ON FUNCTION public.record_canteen_sale_inventory(uuid, jsonb, integer, text) FROM public;
GRANT EXECUTE ON FUNCTION public.record_canteen_sale_inventory(uuid, jsonb, integer, text) TO authenticated;
