-- ============================================================================
-- Migration 267: a charge the ledger conversion posted knows which charge it is.
--
-- Standalone. Paste into the Supabase SQL Editor and click Run. Safe to run
-- more than once.
--
-- ── THE PROBLEM (TED-082) ──────────────────────────────────────────────────
-- The ledger conversion (171/215) copied each family's extra charges onto the
-- ledger as le_conv_<family>_<n> entries with nothing saying WHICH charge each
-- one was. 263's _sync_charge_to_ledger, and the Me page's catch-up, recognise
-- a charge's entries by source.chargeId, so for a charge billed before the
-- conversion they saw nothing posted:
--   * a $40 Camp Shop order re-priced to $55 posted another $55 — the family
--     owed $95;
--   * the same order cancelled took nothing off — the family still owed $40.
--
-- ── THE CHANGE ─────────────────────────────────────────────────────────────
-- 1. _link_converted_charges(family) stamps source.chargeId on each converted
--    fee entry, matching it to one charge of the same amount (the same date
--    first) — the matching the Me page already used (TED-065) — once, one to
--    one. A charge something already carries the id of is left alone.
-- 2. Every family is linked once, now.
-- 3. The conversion itself writes source.chargeId (and source.creditId on
--    credits) from now on, so a camp converting later needs no repair.
-- 4. A page saved from a tab that loaded before the link keeps the link
--    (_merge_family_from_page, 266).
-- 5. _sync_charge_to_ledger reads the clock, so it is STABLE, not IMMUTABLE
--    (TED-087).
-- ============================================================================

CREATE OR REPLACE FUNCTION public._link_converted_charges(p_fam jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_entries jsonb;
    v_charges jsonb;
    v_linked  text[];
    v_idx     integer;
    v_cents   bigint;
    v_changed boolean := false;
    c         jsonb;
BEGIN
    -- COALESCE: a missing key's type is NULL, and "NULL <> 'array'" is not true.
    IF p_fam IS NULL OR COALESCE(jsonb_typeof(p_fam), '') <> 'object'
       OR COALESCE(jsonb_typeof(p_fam->'entries'), '') <> 'array'
       OR COALESCE(jsonb_typeof(p_fam->'charges'), '') <> 'array' THEN
        RETURN p_fam;
    END IF;
    v_entries := p_fam->'entries';
    v_charges := p_fam->'charges';
    SELECT COALESCE(array_agg(DISTINCT x->'source'->>'chargeId'), '{}') INTO v_linked
      FROM jsonb_array_elements(v_entries) x
     WHERE COALESCE(x->'source'->>'chargeId', '') <> '';

    FOR c IN SELECT * FROM jsonb_array_elements(v_charges) LOOP
        IF COALESCE(c->>'id', '') = '' OR c->>'id' = ANY (v_linked) THEN CONTINUE; END IF;
        v_cents := ROUND(COALESCE((c->>'amount')::numeric, 0) * 100);
        IF v_cents <= 0 THEN CONTINUE; END IF;
        -- an unlinked converted fee of the same amount: the same date first
        SELECT o - 1 INTO v_idx
          FROM jsonb_array_elements(v_entries) WITH ORDINALITY AS t(x, o)
         WHERE x->>'id' LIKE 'le\_conv\_%' AND x->>'kind' = 'charge' AND x->>'reason' = 'fee'
           AND COALESCE(x->'source'->>'chargeId', '') = ''
           AND ROUND(COALESCE((x->>'amount')::numeric, 0) * 100) = v_cents
         ORDER BY (COALESCE(x->>'date', '') = COALESCE(c->>'date', '')) DESC, o
         LIMIT 1;
        IF v_idx IS NULL THEN CONTINUE; END IF;
        v_entries := jsonb_set(v_entries, ARRAY[v_idx::text, 'source'],
            (CASE WHEN jsonb_typeof(v_entries->v_idx->'source') = 'object'
                  THEN v_entries->v_idx->'source' ELSE '{}'::jsonb END)
            || jsonb_build_object('chargeId', c->>'id'), true);
        v_linked := v_linked || (c->>'id');
        v_changed := true;
        v_idx := NULL;
    END LOOP;

    IF NOT v_changed THEN RETURN p_fam; END IF;
    RETURN jsonb_set(p_fam, '{entries}', v_entries, true);
END;
$$;
REVOKE ALL ON FUNCTION public._link_converted_charges(jsonb) FROM public, anon, authenticated;


-- 263's sync reads now(): STABLE (TED-087).
ALTER FUNCTION public._sync_charge_to_ledger(jsonb, text) STABLE;


-- The conversion writes the link itself from now on.
DO $$
DECLARE
    d     text := pg_get_functiondef('public.convert_family_ledgers(uuid,boolean)'::regprocedure);
    empty text := '''source'', ''{}''::jsonb';
    at    integer;
    rel   integer;
BEGIN
    IF position('chargeId'', e->>''id''' IN d) > 0 THEN
        RAISE NOTICE '267: convert_family_ledgers already links its charges';
        RETURN;
    END IF;
    at := position('''reason'', ''fee'',' IN d);
    rel := CASE WHEN at > 0 THEN position(empty IN substr(d, at)) ELSE 0 END;
    IF rel = 0 THEN
        RAISE EXCEPTION '267: convert_family_ledgers does not look the way this file expects — send this message to the builder';
    END IF;
    d := overlay(d PLACING '''source'', jsonb_strip_nulls(jsonb_build_object(''chargeId'', e->>''id''))'
                 FROM at + rel - 1 FOR length(empty));
    at := position('''reason'', ''goodwill'',' IN d);
    rel := CASE WHEN at > 0 THEN position(empty IN substr(d, at)) ELSE 0 END;
    IF rel > 0 THEN
        d := overlay(d PLACING '''source'', jsonb_strip_nulls(jsonb_build_object(''creditId'', e->>''id''))'
                     FROM at + rel - 1 FOR length(empty));
    END IF;
    EXECUTE d;
END $$;


-- A save from a tab that loaded before the link keeps the link: an entry the
-- page and the server both hold is the page's, except that the server's
-- source.chargeId (which only this repair and the database ever add) stays.
CREATE OR REPLACE FUNCTION public._keep_charge_links(p_server jsonb, p_merged jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_out jsonb := '[]'::jsonb;
    v_cid text;
    e     jsonb;
BEGIN
    IF p_server IS NULL OR p_merged IS NULL
       OR COALESCE(jsonb_typeof(p_server->'entries'), '') <> 'array'
       OR COALESCE(jsonb_typeof(p_merged->'entries'), '') <> 'array' THEN
        RETURN p_merged;
    END IF;
    FOR e IN SELECT * FROM jsonb_array_elements(p_merged->'entries') LOOP
        IF COALESCE(e->'source'->>'chargeId', '') = '' AND COALESCE(e->>'id', '') <> '' THEN
            SELECT x->'source'->>'chargeId' INTO v_cid
              FROM jsonb_array_elements(p_server->'entries') x
             WHERE x->>'id' = e->>'id' AND COALESCE(x->'source'->>'chargeId', '') <> ''
             LIMIT 1;
            IF v_cid IS NOT NULL THEN
                e := jsonb_set(e, '{source}',
                    (CASE WHEN jsonb_typeof(e->'source') = 'object' THEN e->'source' ELSE '{}'::jsonb END)
                    || jsonb_build_object('chargeId', v_cid), true);
            END IF;
            v_cid := NULL;
        END IF;
        v_out := v_out || jsonb_build_array(e);
    END LOOP;
    RETURN jsonb_set(p_merged, '{entries}', v_out, true);
END;
$$;
REVOKE ALL ON FUNCTION public._keep_charge_links(jsonb, jsonb) FROM public, anon, authenticated;

DO $$
DECLARE
    d   text := pg_get_functiondef('public._merge_family_from_page(jsonb,jsonb)'::regprocedure);
    old text := '    RETURN v_out;' || chr(10) || 'END;';
BEGIN
    IF position('_keep_charge_links' IN d) > 0 THEN
        RAISE NOTICE '267: _merge_family_from_page already keeps charge links';
        RETURN;
    END IF;
    IF position(old IN d) = 0 THEN
        RAISE EXCEPTION '267: _merge_family_from_page does not look the way this file expects (run 266 first) — send this message to the builder';
    END IF;
    EXECUTE replace(d, old, '    RETURN public._keep_charge_links(p_server, v_out);' || chr(10) || 'END;');
END $$;


-- Every family, once.
DO $$
DECLARE
    r     record;
    v_new jsonb;
BEGIN
    FOR r IN SELECT camp_id, family_key, payload FROM public.camp_families
              WHERE deleted_at IS NULL
                AND jsonb_typeof(payload->'entries') = 'array'
                AND jsonb_typeof(payload->'charges') = 'array' LOOP
        v_new := public._link_converted_charges(r.payload);
        IF v_new IS DISTINCT FROM r.payload THEN
            v_new := public._link_converted_charges(public.camp_family_for_update(r.camp_id, r.family_key));
            PERFORM public.camp_family_save(r.camp_id, r.family_key, v_new);
        END IF;
    END LOOP;
END $$;
