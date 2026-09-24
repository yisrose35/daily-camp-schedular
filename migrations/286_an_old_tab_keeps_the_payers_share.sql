-- ============================================================================
-- Migration 286: an office computer left open from before keeps a fund's share
-- of a split bill, and the fund's payments.
--
-- Standalone. Paste into the Supabase SQL Editor and click Run. Safe to run
-- more than once. Requires 266, 267 and 272. Run it BEFORE reloading Me.
--
-- ── THE PROBLEM (TED-177) ──────────────────────────────────────────────────
-- "Split between payers" billed a fund its share of a charge and recorded the
-- fund's cheques on the fund itself, in the camp's settings document. A second
-- office computer that had not reloaded (a laptop that was asleep) wrote its
-- older copy of that document back the next time it saved anything: the fund's
-- $800 owing and its $300 cheque were gone, and the household was still billed
-- only its own $200.
--
-- ── THE CHANGE ─────────────────────────────────────────────────────────────
-- Me now keeps a payer's share and payments on the HOUSEHOLD's family record
-- (payerLedger), which is saved as its own row and merged on the server. The
-- merge (_merge_family_from_page, as 272 left it) now also keeps every
-- payerLedger entry the server holds that the page never saw — the list only
-- ever grows; a correction is a new entry that voids an old one.
-- ============================================================================

DO $$
BEGIN
    IF to_regprocedure('public._merge_family_from_page(jsonb,jsonb)') IS NULL
       OR to_regprocedure('public._keep_charge_links(jsonb,jsonb)') IS NULL THEN
        RAISE EXCEPTION '286 needs migrations 266, 267 and 272 — apply those first';
    END IF;
END $$;

CREATE OR REPLACE FUNCTION public._keep_payer_ledger(p_server jsonb, p_merged jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_pe  jsonb;
    v_ids text[];
    e     jsonb;
BEGIN
    -- IS DISTINCT FROM, not <>: a family with no payer lines has no such key,
    -- and NULL <> 'array' is not true — it would have gained an empty list.
    IF p_server IS NULL OR jsonb_typeof(p_server->'payerLedger') IS DISTINCT FROM 'array'
       OR p_merged IS NULL OR jsonb_typeof(p_merged) IS DISTINCT FROM 'object' THEN
        RETURN p_merged;
    END IF;
    v_pe := CASE WHEN jsonb_typeof(p_merged->'payerLedger') = 'array' THEN p_merged->'payerLedger' ELSE '[]'::jsonb END;
    SELECT COALESCE(array_agg(x->>'id'), '{}') INTO v_ids FROM jsonb_array_elements(v_pe) x;
    FOR e IN SELECT * FROM jsonb_array_elements(p_server->'payerLedger') LOOP
        IF jsonb_typeof(e) = 'object' AND COALESCE(e->>'id', '') <> '' AND NOT (e->>'id' = ANY (v_ids)) THEN
            v_pe := v_pe || jsonb_build_array(e);
        END IF;
    END LOOP;
    RETURN jsonb_set(p_merged, '{payerLedger}', v_pe, true);
END;
$$;
REVOKE ALL ON FUNCTION public._keep_payer_ledger(jsonb, jsonb) FROM public, anon, authenticated;

DO $$
DECLARE
    d   text := replace(pg_get_functiondef('public._merge_family_from_page(jsonb,jsonb)'::regprocedure), chr(13), '');
    old text := 'RETURN public._keep_charge_links(p_server, v_out);';
BEGIN
    -- Pasted from Windows the patterns carry CR LF; the function text has none.
    old := replace(old, chr(13), '');
    IF position('_keep_payer_ledger' IN d) > 0 THEN
        RAISE NOTICE '286: _merge_family_from_page already keeps the payers'' entries';
        RETURN;
    END IF;
    IF position(old IN d) = 0 THEN
        RAISE EXCEPTION '286: _merge_family_from_page does not look the way this file expects (run 272 first) — send this message to the builder';
    END IF;
    EXECUTE replace(d, old, 'RETURN public._keep_charge_links(p_server, public._keep_payer_ledger(p_server, v_out));');
END $$;
