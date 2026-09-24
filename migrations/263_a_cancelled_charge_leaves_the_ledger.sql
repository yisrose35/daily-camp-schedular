-- ============================================================================
-- Migration 263: a charge that is cancelled or re-priced leaves the ledger too.
--
-- Standalone. Paste into the Supabase SQL Editor and click Run. Safe to run
-- more than once.
--
-- ── THE PROBLEM (TED-066) ──────────────────────────────────────────────────
-- A family's extra charges (a Camp Shop order billed to the family, a late fee)
-- live in families[].charges AND, since the office's Billing started posting
-- them (TED-053), on the family's ledger — which is what both balances read.
-- Cancelling a Camp Shop order removed it from charges[] only, so a $40 order
-- that was cancelled kept billing the family $40.
--
-- ── THE CHANGE ─────────────────────────────────────────────────────────────
-- _sync_charge_to_ledger(family, chargeId) makes the ledger agree with what
-- charges[] now says for that one charge: it adds up what the ledger already
-- holds for it (entries whose source.chargeId is that id) and posts the
-- difference — nothing when they agree. The first posting uses the id the Me
-- page uses (le_chg_<id>), later ones le_chgadj_<id>_<n>, so the database and
-- the Me page can never post the same charge twice. A family with no ledger
-- yet is left alone (its balance still comes from charges[]).
--
-- settle_shop_order (239) now runs it on the family it saves.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._sync_charge_to_ledger(p_fam jsonb, p_charge_id text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_entries jsonb := CASE WHEN jsonb_typeof(p_fam->'entries') = 'array' THEN p_fam->'entries' ELSE '[]'::jsonb END;
    v_target  numeric := 0;
    v_posted  numeric := 0;
    v_any     boolean := false;
    v_n       integer := 0;
    v_diff    numeric;
    v_desc    text := '';
    v_date    text;
    c         jsonb;
    e         jsonb;
BEGIN
    IF p_fam IS NULL OR COALESCE(p_charge_id, '') = '' OR jsonb_array_length(v_entries) = 0 THEN
        RETURN p_fam;
    END IF;
    FOR c IN SELECT * FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_fam->'charges') = 'array'
                                                     THEN p_fam->'charges' ELSE '[]'::jsonb END) LOOP
        IF c->>'id' = p_charge_id THEN
            v_target := v_target + GREATEST(COALESCE((c->>'amount')::numeric, 0), 0);
            v_desc := COALESCE(c->>'description', c->>'category', 'Charge');
        END IF;
    END LOOP;
    FOR e IN SELECT * FROM jsonb_array_elements(v_entries) LOOP
        IF e->'source'->>'chargeId' = p_charge_id THEN
            v_any := true;
            v_n := v_n + 1;
            v_posted := v_posted + CASE e->>'kind'
                WHEN 'charge' THEN COALESCE((e->>'amount')::numeric, 0)
                WHEN 'credit' THEN -COALESCE((e->>'amount')::numeric, 0)
                ELSE 0 END;
        END IF;
    END LOOP;
    v_diff := round(v_target - v_posted, 2);
    IF v_diff = 0 THEN RETURN p_fam; END IF;
    v_date := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD');
    RETURN jsonb_set(p_fam, '{entries}', v_entries || jsonb_build_array(jsonb_build_object(
        'id', CASE WHEN v_any THEN 'le_chgadj_' || p_charge_id || '_' || v_n ELSE 'le_chg_' || p_charge_id END,
        'kind', CASE WHEN v_diff > 0 THEN 'charge' ELSE 'credit' END,
        'amount', abs(v_diff),
        'reason', CASE WHEN v_diff > 0 THEN (CASE WHEN v_any THEN 'other' ELSE 'fee' END) ELSE 'reversal' END,
        'date', v_date,
        'postedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'note', CASE WHEN v_target = 0 THEN 'Cancelled — ' || COALESCE(NULLIF(v_desc, ''), 'charge')
                     WHEN v_any THEN 'Changed — ' || v_desc ELSE v_desc END,
        'by', 'system',
        'source', jsonb_build_object('chargeId', p_charge_id)
    )), true);
END;
$$;
REVOKE ALL ON FUNCTION public._sync_charge_to_ledger(jsonb, text) FROM public, anon, authenticated;


-- settle_shop_order: sync the order's charge onto the ledger in the same save.
DO $$
DECLARE
    d   text := pg_get_functiondef('public.settle_shop_order(uuid,text,text,numeric,boolean)'::regprocedure);
    old text := $o$v_fam || jsonb_build_object('charges', v_kept));$o$;
    new text := $n$public._sync_charge_to_ledger(v_fam || jsonb_build_object('charges', v_kept), v_chargeId));$n$;
BEGIN
    IF position('_sync_charge_to_ledger' IN d) > 0 THEN
        RAISE NOTICE '263: settle_shop_order already syncs the ledger';
        RETURN;
    END IF;
    IF position(old IN d) = 0 THEN
        RAISE EXCEPTION '263: settle_shop_order does not look the way this file expects — send this message to the builder';
    END IF;
    EXECUTE replace(d, old, new);
END $$;
