-- ============================================================================
-- Migration 289: a register sale keeps what it sold, by item id — so voiding
-- it puts exactly those items back in stock.
--
-- Standalone. Paste into the Supabase SQL Editor and click Run. Safe to run
-- more than once. Requires 283 and 284. Run it BEFORE reloading the register
-- (POS). A register that has not reloaded keeps working as it did.
--
-- ── THE PROBLEM (TED-192) ──────────────────────────────────────────────────
-- A sale's line said what was sold only in words ("Trail Mix 2, Chips, BBQ").
-- Voiding it (284) read the items back from those words: an item whose name
-- has a comma, or ends in a number, was never offered back to stock.
--
-- ── THE CHANGE ─────────────────────────────────────────────────────────────
-- submit_canteen_purchase_once takes the items the register sold, by id and
-- quantity (p_sold), and keeps them on the sale's line (soldItems). The void
-- (284) restocks by those ids, never more than the sale had; older sales still
-- go by their words. The old signature is replaced in the same step (two
-- versions differing by a defaulted argument confuse the API — see 247), so a
-- register that has not reloaded, which sends no p_sold, reaches this one.
-- ============================================================================

DO $$
BEGIN
    IF to_regprocedure('public.submit_canteen_purchase(uuid,text,numeric,text,date,bigint)') IS NULL
       OR to_regclass('public.canteen_sale_keys') IS NULL THEN
        RAISE EXCEPTION '289 needs migrations 247 and 283 — apply those first';
    END IF;
END $$;

DROP FUNCTION IF EXISTS public.submit_canteen_purchase_once(uuid, text, text, numeric, text, date, bigint);

CREATE OR REPLACE FUNCTION public.submit_canteen_purchase_once(
    p_camp_id     uuid,
    p_sale_key    text,
    p_camper_name text,
    p_amount      numeric,
    p_items       text   DEFAULT '',
    p_date        date   DEFAULT NULL,
    p_camper_id   bigint DEFAULT NULL,
    p_sold        jsonb  DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_key  text := NULLIF(btrim(COALESCE(p_sale_key, '')), '');
    v_fp   text := COALESCE(p_camper_id::text, 'n:' || btrim(COALESCE(p_camper_name, ''))) || '|' || round(COALESCE(p_amount, 0), 2)::text;
    v_n    integer := 0;
    v_prev public.canteen_sale_keys%ROWTYPE;
    v_sold jsonb;
    r      jsonb;
BEGIN
    IF auth.uid() IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    IF p_camp_id IS NULL OR NOT public.camp_staff_member(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    -- What was sold, cleaned: [{id, qty}] with a whole quantity 1..100.
    IF jsonb_typeof(p_sold) = 'array' THEN
        SELECT COALESCE(jsonb_agg(jsonb_build_object('id', x -> 'id', 'qty', floor((x ->> 'qty')::numeric))), '[]'::jsonb)
          INTO v_sold
          FROM jsonb_array_elements(p_sold) x
         WHERE jsonb_typeof(x) = 'object' AND x ? 'id' AND jsonb_typeof(x -> 'qty') = 'number'
           AND floor((x ->> 'qty')::numeric) BETWEEN 1 AND 100;
    END IF;

    IF v_key IS NOT NULL THEN
        -- A few days is all a retry ever needs.
        DELETE FROM canteen_sale_keys WHERE camp_id = p_camp_id AND created_at < now() - interval '3 days';
        INSERT INTO canteen_sale_keys (camp_id, sale_key, fingerprint) VALUES (p_camp_id, v_key, v_fp)
            ON CONFLICT (camp_id, sale_key) DO NOTHING;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        IF v_n = 0 THEN
            SELECT * INTO v_prev FROM canteen_sale_keys WHERE camp_id = p_camp_id AND sale_key = v_key;
            IF v_prev.fingerprint IS DISTINCT FROM v_fp THEN
                RETURN jsonb_build_object('success', false, 'error', 'sale_key_reused');
            END IF;
            IF v_prev.result IS NOT NULL THEN
                RETURN v_prev.result || jsonb_build_object('replayed', true);
            END IF;
            RETURN jsonb_build_object('success', false, 'error', 'sale_in_progress');
        END IF;
    END IF;

    r := public.submit_canteen_purchase(p_camp_id, p_camper_name, p_amount, p_items, p_date, p_camper_id);
    IF COALESCE((r ->> 'success')::boolean, false) THEN
        -- The sale's own line: posted by this call, in this transaction, under
        -- the child's wallet lock (first_seen is this transaction's clock).
        IF v_sold IS NOT NULL AND jsonb_array_length(v_sold) > 0 THEN
            UPDATE canteen_transactions
               SET payload = payload || jsonb_build_object('soldItems', v_sold)
             WHERE camp_id = p_camp_id AND first_seen = now() AND tx_type = 'debit'
               AND amount = p_amount AND NOT (payload ? 'kind');
        END IF;
        IF v_key IS NOT NULL THEN
            UPDATE canteen_sale_keys SET result = r WHERE camp_id = p_camp_id AND sale_key = v_key;
        END IF;
    ELSIF v_key IS NOT NULL THEN
        -- Nothing was charged: the same sale may be tried again.
        DELETE FROM canteen_sale_keys WHERE camp_id = p_camp_id AND sale_key = v_key;
    END IF;
    RETURN r;
END $$;
REVOKE ALL ON FUNCTION public.submit_canteen_purchase_once(uuid, text, text, numeric, text, date, bigint, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.submit_canteen_purchase_once(uuid, text, text, numeric, text, date, bigint, jsonb) TO authenticated;

DO $$
BEGIN
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'submit_canteen_purchase_once') <> 1 THEN
        RAISE EXCEPTION '289: submit_canteen_purchase_once must have exactly one signature';
    END IF;
END $$;
