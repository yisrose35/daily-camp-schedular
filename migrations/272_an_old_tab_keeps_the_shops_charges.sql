-- ============================================================================
-- Migration 272: a Billing tab left open keeps the shop's charges.
--
-- Standalone. Paste into the Supabase SQL Editor and click Run. Safe to run
-- more than once. Requires 266, 267 and 269.
--
-- ── THE PROBLEM (TED-091) ──────────────────────────────────────────────────
-- The shop bills a $40 sweatshirt to a family at lunch. An office tab opened
-- that morning adds a $10 charge and saves the family as it knew it — without
-- the sweatshirt. 266's merge kept the ledger lines and the plans but took the
-- page's list of charges as it was, so the $40 charge vanished; the next
-- Billing load then saw a posted charge with nothing behind it and took it off
-- the ledger ("Cancelled — charge"). The family owed $1,010, not $1,050.
--
-- ── THE CHANGE ─────────────────────────────────────────────────────────────
-- _merge_family_from_page (as 269 left it) also merges the charges: the page's
-- own, plus every charge the server holds that the page never saw; and the
-- shop's charges (shop_<order>) always exactly as the server has them, since
-- only the server bills, re-prices and cancels them. (The Me page, for its
-- part, no longer takes a shop charge off the ledger itself.)
-- ============================================================================

-- What an id-less plan is: when it was made and its schedule.
CREATE OR REPLACE FUNCTION public._plan_fingerprint(p jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
    SELECT COALESCE(p->>'createdAt', '') || '|' ||
           COALESCE(CASE WHEN jsonb_typeof(p->'dueDates') = 'array' THEN (p->'dueDates')::text END, '') || '|' ||
           COALESCE((SELECT string_agg(COALESCE(i->>'dueDate', '') || ':' || COALESCE(i->>'amount', ''), ',' ORDER BY o)
                       FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p->'installments') = 'array'
                                                      THEN p->'installments' ELSE '[]'::jsonb END)
                            WITH ORDINALITY AS t(i, o)), '');
$$;
REVOKE ALL ON FUNCTION public._plan_fingerprint(jsonb) FROM public, anon, authenticated;


CREATE OR REPLACE FUNCTION public._merge_family_from_page(p_server jsonb, p_page jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_out     jsonb := p_page;
    v_pe      jsonb;
    v_se      jsonb;
    v_ids     text[];
    v_plans   jsonb := '[]'::jsonb;
    v_sp      jsonb;
    p         jsonb;
    e         jsonb;
    n         integer := 0;
    v_ch      jsonb;
    v_pids    text[];
BEGIN
    IF p_server IS NULL OR jsonb_typeof(p_server) <> 'object'
       OR p_page IS NULL OR jsonb_typeof(p_page) <> 'object' THEN
        RETURN p_page;
    END IF;

    -- ── ledger entries: never lose one ───────────────────────────────────────
    v_pe := CASE WHEN jsonb_typeof(p_page->'entries') = 'array' THEN p_page->'entries' ELSE '[]'::jsonb END;
    v_se := CASE WHEN jsonb_typeof(p_server->'entries') = 'array' THEN p_server->'entries' ELSE '[]'::jsonb END;
    IF jsonb_array_length(v_se) > 0 THEN
        SELECT COALESCE(array_agg(x->>'id'), '{}') INTO v_ids FROM jsonb_array_elements(v_pe) x;
        FOR e IN SELECT * FROM jsonb_array_elements(v_se) LOOP
            IF COALESCE(e->>'id', '') <> '' AND NOT (e->>'id' = ANY (v_ids)) THEN
                v_pe := v_pe || jsonb_build_array(e);
            END IF;
        END LOOP;
        v_out := jsonb_set(v_out, '{entries}', v_pe, true);
    END IF;

    -- ── plans: the server's running state on every plan the page kept ───────
    IF jsonb_typeof(p_page->'plans') = 'array' AND jsonb_typeof(p_server->'plans') = 'array' THEN
        FOR p IN SELECT * FROM jsonb_array_elements(p_page->'plans') LOOP
            v_sp := NULL;
            IF COALESCE(p->>'id', '') <> '' THEN
                SELECT x INTO v_sp FROM jsonb_array_elements(p_server->'plans') x WHERE x->>'id' = p->>'id' LIMIT 1;
            ELSIF public._plan_fingerprint(p) <> '||' THEN
                -- No id on either: the same schedule, not the same position — a
                -- plan the office deleted must not hand its bank-debit hold to
                -- the plan that moved up into its place (TED-094).
                SELECT x INTO v_sp FROM jsonb_array_elements(p_server->'plans') x
                 WHERE COALESCE(x->>'id', '') = '' AND public._plan_fingerprint(x) = public._plan_fingerprint(p)
                 LIMIT 1;
            ELSIF jsonb_typeof(p_server->'plans'->n) = 'object'
                  AND COALESCE(p_server->'plans'->n->>'id', '') = '' THEN
                v_sp := p_server->'plans'->n;                     -- nothing else to go on: same position
            END IF;
            v_plans := v_plans || jsonb_build_array(public._merge_plan_state(v_sp, p));
            n := n + 1;
        END LOOP;
        v_out := jsonb_set(v_out, '{plans}', v_plans, true);
    END IF;

    -- ── the old single plan ──────────────────────────────────────────────────
    IF jsonb_typeof(p_page->'plan') = 'object' AND jsonb_typeof(p_server->'plan') = 'object' THEN
        v_out := jsonb_set(v_out, '{plan}', public._merge_plan_state(p_server->'plan', p_page->'plan'), true);
    END IF;

    -- ── extra charges (TED-091) ──────────────────────────────────────────────
    -- The office adds and edits its own charges; it never deletes one. The
    -- shop's (shop_<order>) belong to the server — settle_shop_order bills,
    -- re-prices and cancels them — so those are always the server's, and any
    -- other charge the server holds that this page never saw is kept.
    IF jsonb_typeof(p_server->'charges') = 'array' THEN
        v_ch := '[]'::jsonb;
        FOR e IN SELECT * FROM jsonb_array_elements(
                     CASE WHEN jsonb_typeof(p_page->'charges') = 'array' THEN p_page->'charges' ELSE '[]'::jsonb END) LOOP
            IF COALESCE(e->>'id', '') LIKE 'shop\_%' THEN CONTINUE; END IF;
            v_ch := v_ch || jsonb_build_array(e);
        END LOOP;
        SELECT COALESCE(array_agg(x->>'id'), '{}') INTO v_pids FROM jsonb_array_elements(v_ch) x;
        FOR e IN SELECT * FROM jsonb_array_elements(p_server->'charges') LOOP
            IF COALESCE(e->>'id', '') LIKE 'shop\_%'
               OR (COALESCE(e->>'id', '') <> '' AND NOT (e->>'id' = ANY (v_pids))) THEN
                v_ch := v_ch || jsonb_build_array(e);
            END IF;
        END LOOP;
        v_out := jsonb_set(v_out, '{charges}', v_ch, true);
    END IF;

    RETURN public._keep_charge_links(p_server, v_out);
END;
$$;
REVOKE ALL ON FUNCTION public._merge_family_from_page(jsonb, jsonb) FROM public, anon, authenticated;
