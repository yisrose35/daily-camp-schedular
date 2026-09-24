-- ============================================================================
-- Migration 266: an office tab left open cannot undo what the server wrote.
--
-- Standalone. Paste into the Supabase SQL Editor and click Run. Safe to run
-- more than once.
--
-- ── THE PROBLEM (TED-078) ──────────────────────────────────────────────────
-- The Me page saves a family as a WHOLE object, from the copy it loaded. The
-- nightly autopay runner, the payment webhooks, the shop and the bank-deposit
-- trigger all write to the same family in between. An office tab opened
-- yesterday and saved this morning wrote yesterday's copy back over all of it:
-- the "bank debit in flight" hold (so the family was debited again that
-- night), the plan's payment counter and history, a card decline flag, and any
-- ledger entry posted since the tab loaded.
--
-- ── THE CHANGE ─────────────────────────────────────────────────────────────
-- _merge_family_from_page(server, page) keeps the office's edits and never
-- drops what only the server writes:
--   * ledger entries: every entry already on the row is kept (the ledger is
--     append-only; the page never deletes one), plus whatever the page adds;
--   * each plan the page still has (by id): pendingCharge and collectionBlocked
--     are the server's; nextIndex is the higher of the two; history is the
--     longer; an old-style instalment the server marked paid, or recorded a
--     decline on, keeps that;
--   * a plan the page removed is removed (the office cancelled it), and the
--     page's dates/amounts/autopay switch are the office's to set.
-- Both of the page's save paths use it: sync_camp_billing, and the trigger
-- that copies families out of the settings document (project_camp_families).
-- ============================================================================

-- Only when nothing newer is in place: re-running this file on its own must
-- not put back an older merge over a later migration's (TED-094).
DO $guard$
BEGIN
    IF to_regprocedure('public._merge_family_from_page(jsonb,jsonb)') IS NULL
       OR pg_get_functiondef(to_regprocedure('public._merge_family_from_page(jsonb,jsonb)')) !~ '_keep_charge_links|_merge_plan_state' THEN
        EXECUTE $fn$
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
    v_pp      jsonb;
    v_insts   jsonb;
    v_si      jsonb;
    e         jsonb;
    p         jsonb;
    i         jsonb;
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
            v_pp := p;
            v_sp := NULL;
            IF COALESCE(p->>'id', '') <> '' THEN
                SELECT x INTO v_sp FROM jsonb_array_elements(p_server->'plans') x WHERE x->>'id' = p->>'id' LIMIT 1;
            END IF;
            IF v_sp IS NOT NULL THEN
                v_pp := v_pp - 'pendingCharge' - 'collectionBlocked';
                IF v_sp ? 'pendingCharge' THEN v_pp := v_pp || jsonb_build_object('pendingCharge', v_sp->'pendingCharge'); END IF;
                IF v_sp ? 'collectionBlocked' THEN v_pp := v_pp || jsonb_build_object('collectionBlocked', v_sp->'collectionBlocked'); END IF;
                IF COALESCE((v_sp->>'nextIndex')::int, 0) > COALESCE((v_pp->>'nextIndex')::int, 0) THEN
                    v_pp := jsonb_set(v_pp, '{nextIndex}', v_sp->'nextIndex', true);
                END IF;
                IF jsonb_typeof(v_sp->'history') = 'array'
                   AND jsonb_array_length(v_sp->'history') >
                       (CASE WHEN jsonb_typeof(v_pp->'history') = 'array' THEN jsonb_array_length(v_pp->'history') ELSE 0 END) THEN
                    v_pp := jsonb_set(v_pp, '{history}', v_sp->'history', true);
                END IF;
                -- old-style instalments: what the runner recorded on each one
                IF jsonb_typeof(v_pp->'installments') = 'array' AND jsonb_typeof(v_sp->'installments') = 'array' THEN
                    v_insts := '[]'::jsonb;
                    FOR i IN SELECT * FROM jsonb_array_elements(v_pp->'installments') LOOP
                        SELECT x INTO v_si FROM jsonb_array_elements(v_sp->'installments') x
                         WHERE x->>'dueDate' = i->>'dueDate' LIMIT 1;
                        IF v_si IS NOT NULL AND v_si->>'status' = 'paid' AND COALESCE(i->>'status', 'pending') <> 'paid' THEN
                            i := v_si;
                        ELSIF v_si IS NOT NULL AND COALESCE((v_si->>'attempts')::int, 0) > COALESCE((i->>'attempts')::int, 0) THEN
                            i := i || jsonb_strip_nulls(jsonb_build_object('attempts', v_si->'attempts',
                                     'failReason', v_si->'failReason', 'lastFailedAt', v_si->'lastFailedAt'));
                        END IF;
                        v_insts := v_insts || jsonb_build_array(i);
                    END LOOP;
                    v_pp := jsonb_set(v_pp, '{installments}', v_insts, true);
                END IF;
            END IF;
            v_plans := v_plans || jsonb_build_array(v_pp);
        END LOOP;
        v_out := jsonb_set(v_out, '{plans}', v_plans, true);
    END IF;

    RETURN v_out;
END;
$$;
$fn$;
    ELSE
        RAISE NOTICE '266: a newer _merge_family_from_page is in place — left as it is';
    END IF;
END $guard$;
REVOKE ALL ON FUNCTION public._merge_family_from_page(jsonb, jsonb) FROM public, anon, authenticated;


-- Both save paths merge instead of overwrite.
DO $$
DECLARE
    d text;
BEGIN
    -- 1. sync_camp_billing (213)
    d := pg_get_functiondef('public.sync_camp_billing(uuid,jsonb,jsonb,jsonb,jsonb)'::regprocedure);
    IF position('_merge_family_from_page' IN d) = 0 THEN
        IF position('PERFORM public.camp_family_save(p_camp_id, r.key, r.value);' IN d) = 0 THEN
            RAISE EXCEPTION '266: sync_camp_billing does not look the way this file expects — send this message to the builder';
        END IF;
        EXECUTE replace(d, 'PERFORM public.camp_family_save(p_camp_id, r.key, r.value);',
            'PERFORM public.camp_family_save(p_camp_id, r.key, public._merge_family_from_page((SELECT f.payload FROM public.camp_families f WHERE f.camp_id = p_camp_id AND f.family_key = r.key AND f.deleted_at IS NULL), r.value));');
    END IF;

    -- 2. the settings-document projection (234)
    d := pg_get_functiondef('public.project_camp_families()'::regprocedure);
    IF position('_merge_family_from_page' IN d) = 0 THEN
        IF position('payload    = EXCLUDED.payload,' IN d) = 0 THEN
            RAISE EXCEPTION '266: project_camp_families does not look the way this file expects — send this message to the builder';
        END IF;
        EXECUTE replace(d, 'payload    = EXCLUDED.payload,',
            'payload    = CASE WHEN camp_families.deleted_at IS NULL THEN public._merge_family_from_page(camp_families.payload, EXCLUDED.payload) ELSE EXCLUDED.payload END,');
    END IF;
END $$;
