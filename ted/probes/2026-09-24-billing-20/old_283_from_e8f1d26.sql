-- ============================================================================
-- Migration 283: a canteen register sale is charged once, however often the
-- Charge button's request arrives.
--
-- Standalone. Paste into the Supabase SQL Editor and click Run. Safe to run
-- more than once. Run it BEFORE reloading the Snacks register (POS).
--
-- ── THE PROBLEM (TED-159) ──────────────────────────────────────────────────
-- Every call to submit_canteen_purchase is a new debit. On slow camp wifi a
-- counselor tapped "Charge $2.50" twice and the child was charged twice; or
-- the answer was lost after the server had charged, the register said "Charge
-- failed", the counselor tapped again — charged twice.
--
-- ── THE CHANGE ─────────────────────────────────────────────────────────────
-- The register sends a key for each sale it means to make (the same key on a
-- retry of that sale). submit_canteen_purchase_once remembers the answer of a
-- sale that went through under its key, for this camp, and answers a repeat
-- with that first answer (replayed: true) instead of charging again. Two
-- requests with the same key at the same moment: the second waits for the
-- first and gets its answer. A sale that was refused (over the daily limit,
-- not enough balance) is not remembered, so it can be tried again. A key sent
-- again for a DIFFERENT child or amount is refused.
--
-- submit_canteen_purchase itself is unchanged (247); this calls it.
-- ============================================================================

DO $$
BEGIN
    IF to_regprocedure('public.submit_canteen_purchase(uuid,text,numeric,text,date,bigint)') IS NULL
       OR to_regprocedure('public.camp_staff_member(uuid)') IS NULL THEN
        RAISE EXCEPTION '283 needs migration 247 — apply it first';
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.canteen_sale_keys (
    camp_id     uuid        NOT NULL,
    sale_key    text        NOT NULL,
    fingerprint text        NOT NULL,
    result      jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (camp_id, sale_key)
);
ALTER TABLE public.canteen_sale_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.canteen_sale_keys FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.submit_canteen_purchase_once(
    p_camp_id     uuid,
    p_sale_key    text,
    p_camper_name text,
    p_amount      numeric,
    p_items       text   DEFAULT '',
    p_date        date   DEFAULT NULL,
    p_camper_id   bigint DEFAULT NULL)
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
    r      jsonb;
BEGIN
    IF auth.uid() IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    IF p_camp_id IS NULL OR NOT public.camp_staff_member(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;
    IF v_key IS NULL THEN
        RETURN public.submit_canteen_purchase(p_camp_id, p_camper_name, p_amount, p_items, p_date, p_camper_id);
    END IF;

    -- A few days is all a retry ever needs.
    DELETE FROM canteen_sale_keys WHERE camp_id = p_camp_id AND created_at < now() - interval '3 days';

    -- Claim the key. A second request with the same key waits here until the
    -- first has finished, then finds its row.
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
        -- Not reachable once the first request has finished (it either kept
        -- its answer or gave the key back) — never charge on a guess.
        RETURN jsonb_build_object('success', false, 'error', 'sale_in_progress');
    END IF;

    r := public.submit_canteen_purchase(p_camp_id, p_camper_name, p_amount, p_items, p_date, p_camper_id);
    IF COALESCE((r ->> 'success')::boolean, false) THEN
        UPDATE canteen_sale_keys SET result = r WHERE camp_id = p_camp_id AND sale_key = v_key;
    ELSE
        -- Nothing was charged: the same sale may be tried again.
        DELETE FROM canteen_sale_keys WHERE camp_id = p_camp_id AND sale_key = v_key;
    END IF;
    RETURN r;
END $$;
REVOKE ALL ON FUNCTION public.submit_canteen_purchase_once(uuid, text, text, numeric, text, date, bigint) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.submit_canteen_purchase_once(uuid, text, text, numeric, text, date, bigint) TO authenticated;
