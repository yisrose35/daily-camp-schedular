-- ============================================================================
-- Migration 269: every kind of payment plan can hold a bank debit (and be
-- flagged), not only plans with an id.
--
-- Standalone. Paste into the Supabase SQL Editor and click Run. Safe to run
-- more than once. Run it BEFORE redeploying charge-due-installments.
--
-- ── THE PROBLEM (TED-084) ──────────────────────────────────────────────────
-- 262 holds a bank debit that is still clearing ON THE PLAN, so the nightly
-- runner asks Stripe about it instead of debiting again. It found the plan by
-- id, in plans[] only. A plan from before plans had ids, or a family still on
-- the single old-style `plan`, was never found: nothing was held, the runner
-- reported "processing_held" anyway, and the family was debited $500 again
-- every night. The decline/no-card flag (flag_plan_collection) had the same
-- blind spot, and so did the protection 266 gives the hold against an office
-- tab that loaded before it.
--
-- ── THE CHANGE ─────────────────────────────────────────────────────────────
-- A plan is named by its id, or — when it has none — by '#<position>', the
-- position the runner already uses for record_autopay_installment ('#0' is the
-- old single `plan`). _plan_path(family, ref) finds it; a position is only
-- accepted for a plan that has no id, so a list that changed underneath cannot
-- send a hold to the wrong plan. hold_autopay_charge and flag_plan_collection
-- use it, and the page-save merge keeps the running state (hold, block,
-- counter, history, paid instalments) on those plans too.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._plan_path(p_fam jsonb, p_ref text)
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_plans jsonb;
    v_i     integer;
    i       integer;
BEGIN
    IF p_fam IS NULL OR COALESCE(p_ref, '') = '' THEN RETURN NULL; END IF;
    IF jsonb_typeof(p_fam->'plans') = 'array' THEN
        v_plans := p_fam->'plans';
        IF p_ref ~ '^#[0-9]{1,6}$' THEN
            v_i := substr(p_ref, 2)::integer;
            IF v_i < jsonb_array_length(v_plans)
               AND jsonb_typeof(v_plans->v_i) = 'object'
               AND COALESCE(v_plans->v_i->>'id', '') = '' THEN
                RETURN ARRAY['plans', v_i::text];
            END IF;
            RETURN NULL;
        END IF;
        FOR i IN 0 .. jsonb_array_length(v_plans) - 1 LOOP
            IF v_plans->i->>'id' = p_ref THEN RETURN ARRAY['plans', i::text]; END IF;
        END LOOP;
        RETURN NULL;
    END IF;
    -- the old single plan
    IF jsonb_typeof(p_fam->'plan') = 'object'
       AND (p_ref = '#0' OR p_fam->'plan'->>'id' = p_ref) THEN
        RETURN ARRAY['plan'];
    END IF;
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public._plan_path(jsonb, text) FROM public, anon, authenticated;


-- 262's hold, on any plan.
CREATE OR REPLACE FUNCTION public.hold_autopay_charge(
    p_camp_id    uuid,
    p_family_key text,
    p_plan_id    text,
    p_hold       jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_fam  jsonb;
    v_path text[];
    v_plan jsonb;
BEGIN
    IF p_camp_id IS NULL OR COALESCE(p_family_key, '') = '' OR COALESCE(p_plan_id, '') = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_arguments');
    END IF;
    v_fam := public.camp_family_for_update(p_camp_id, p_family_key);
    IF v_fam IS NULL OR jsonb_typeof(v_fam) <> 'object' THEN
        RETURN jsonb_build_object('success', false, 'error', 'family_not_found');
    END IF;
    v_path := public._plan_path(v_fam, p_plan_id);
    IF v_path IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'plan_not_found');
    END IF;
    v_plan := v_fam #> v_path;
    IF p_hold IS NULL OR jsonb_typeof(p_hold) <> 'object' THEN
        v_plan := v_plan - 'pendingCharge';
    ELSE
        v_plan := jsonb_set(v_plan, '{pendingCharge}', p_hold, true);
    END IF;
    PERFORM public.camp_family_save(p_camp_id, p_family_key, jsonb_set(v_fam, v_path, v_plan, true));
    RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public.hold_autopay_charge(uuid, text, text, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hold_autopay_charge(uuid, text, text, jsonb) TO service_role;


-- flag_plan_collection (214), on any plan: the lookup and the write-back.
DO $$
DECLARE
    d  text := pg_get_functiondef('public.flag_plan_collection(uuid,text,text,text,text)'::regprocedure);
    o1 text := $o$    v_plans := CASE WHEN jsonb_typeof(v_fam->'plans') = 'array'
                    THEN v_fam->'plans' ELSE '[]'::jsonb END;
    FOR i IN 0 .. GREATEST(jsonb_array_length(v_plans) - 1, -1) LOOP
        IF v_plans->i->>'id' = p_plan_id THEN v_pi := i; EXIT; END IF;
    END LOOP;
    IF v_pi IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'plan_not_found');
    END IF;
    v_plan := v_plans->v_pi;$o$;
    n1 text := $n$    IF public._plan_path(v_fam, p_plan_id) IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'plan_not_found');
    END IF;
    v_plan := v_fam #> public._plan_path(v_fam, p_plan_id);$n$;
    o2 text := $o$    v_plans := jsonb_set(v_plans, ARRAY[v_pi::text], v_plan, true);
    v_fam := jsonb_set(v_fam, '{plans}', v_plans, true);$o$;
    n2 text := $n$    v_fam := jsonb_set(v_fam, public._plan_path(v_fam, p_plan_id), v_plan, true);$n$;
    o3 text := $o$                       WHEN 'no_processor' THEN 'the camp''s payment processor is not connected'$o$;
    n3 text := $n$                       WHEN 'no_processor' THEN 'the camp''s payment processor is not connected'
                       WHEN 'bank_debit_unheld' THEN 'a bank debit is clearing but could not be recorded on their plan, so it may be debited again'
                       WHEN 'bank_debit_stuck' THEN 'a bank debit has not cleared for over ten days'
                       WHEN 'bank_debit_unverified' THEN 'a bank debit from an earlier night cannot be checked with Stripe'
                       WHEN 'deposit_review' THEN 'autopay is waiting for you to answer a question about their card deposit'$n$;
BEGIN
    IF position('_plan_path' IN d) > 0 THEN
        RAISE NOTICE '269: flag_plan_collection already finds every plan';
        RETURN;
    END IF;
    IF position(o1 IN d) = 0 OR position(o2 IN d) = 0 OR position(o3 IN d) = 0 THEN
        RAISE EXCEPTION '269: flag_plan_collection does not look the way this file expects — send this message to the builder';
    END IF;
    EXECUTE replace(replace(replace(d, o1, n1), o2, n2), o3, n3);
END $$;


-- The running state the server writes on a plan, kept over a page's copy of it.
CREATE OR REPLACE FUNCTION public._merge_plan_state(p_sp jsonb, p_pp jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_pp    jsonb := p_pp;
    v_insts jsonb;
    v_si    jsonb;
    i       jsonb;
BEGIN
    IF p_sp IS NULL OR jsonb_typeof(p_sp) <> 'object' OR p_pp IS NULL OR jsonb_typeof(p_pp) <> 'object' THEN
        RETURN p_pp;
    END IF;
    v_pp := v_pp - 'pendingCharge' - 'collectionBlocked';
    IF p_sp ? 'pendingCharge' THEN v_pp := v_pp || jsonb_build_object('pendingCharge', p_sp->'pendingCharge'); END IF;
    IF p_sp ? 'collectionBlocked' THEN v_pp := v_pp || jsonb_build_object('collectionBlocked', p_sp->'collectionBlocked'); END IF;
    IF COALESCE((p_sp->>'nextIndex')::int, 0) > COALESCE((v_pp->>'nextIndex')::int, 0) THEN
        v_pp := jsonb_set(v_pp, '{nextIndex}', p_sp->'nextIndex', true);
    END IF;
    IF jsonb_typeof(p_sp->'history') = 'array'
       AND jsonb_array_length(p_sp->'history') >
           (CASE WHEN jsonb_typeof(v_pp->'history') = 'array' THEN jsonb_array_length(v_pp->'history') ELSE 0 END) THEN
        v_pp := jsonb_set(v_pp, '{history}', p_sp->'history', true);
    END IF;
    IF jsonb_typeof(v_pp->'installments') = 'array' AND jsonb_typeof(p_sp->'installments') = 'array' THEN
        v_insts := '[]'::jsonb;
        FOR i IN SELECT * FROM jsonb_array_elements(v_pp->'installments') LOOP
            SELECT x INTO v_si FROM jsonb_array_elements(p_sp->'installments') x
             WHERE x->>'dueDate' = i->>'dueDate' LIMIT 1;
            IF v_si IS NOT NULL AND v_si->>'status' = 'paid' AND COALESCE(i->>'status', 'pending') <> 'paid' THEN
                i := v_si;
            ELSIF v_si IS NOT NULL AND COALESCE((v_si->>'attempts')::int, 0) > COALESCE((i->>'attempts')::int, 0) THEN
                i := i || jsonb_strip_nulls(jsonb_build_object('attempts', v_si->'attempts',
                         'failReason', v_si->'failReason', 'lastFailedAt', v_si->'lastFailedAt'));
            END IF;
            v_insts := v_insts || jsonb_build_array(i);
            v_si := NULL;
        END LOOP;
        v_pp := jsonb_set(v_pp, '{installments}', v_insts, true);
    END IF;
    RETURN v_pp;
END;
$$;
REVOKE ALL ON FUNCTION public._merge_plan_state(jsonb, jsonb) FROM public, anon, authenticated;


-- 266's merge, with plans matched by id OR (both without one) by position, and
-- the old single plan kept too. Entries and charge links as 266/267 had them.
-- Only when nothing newer is in place: re-running this file on its own must
-- not put back an older merge over a later migration's (TED-094).
DO $guard$
BEGIN
    IF to_regprocedure('public._merge_family_from_page(jsonb,jsonb)') IS NULL
       OR pg_get_functiondef(to_regprocedure('public._merge_family_from_page(jsonb,jsonb)')) !~ 'LIKE ''shop' THEN
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
    p         jsonb;
    e         jsonb;
    n         integer := 0;
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
            ELSIF jsonb_typeof(p_server->'plans'->n) = 'object'
                  AND COALESCE(p_server->'plans'->n->>'id', '') = '' THEN
                v_sp := p_server->'plans'->n;                     -- no id on either: same position
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

    RETURN public._keep_charge_links(p_server, v_out);
END;
$$;
$fn$;
    ELSE
        RAISE NOTICE '269: a newer _merge_family_from_page is in place — left as it is';
    END IF;
END $guard$;
REVOKE ALL ON FUNCTION public._merge_family_from_page(jsonb, jsonb) FROM public, anon, authenticated;
