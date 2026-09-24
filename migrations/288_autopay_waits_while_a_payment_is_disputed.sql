-- ============================================================================
-- Migration 288: while a family's payment is charged back, autopay does not
-- charge them again on its own.
--
-- Standalone. Paste into the Supabase SQL Editor and click Run. Safe to run
-- more than once. Requires 175, 213 and 286. Run it BEFORE deploying stripe-webhook
-- and charge-due-installments, and before reloading Me.
--
-- ── THE PROBLEM (TED-186) ──────────────────────────────────────────────────
-- A chargeback puts the disputed payment back on the family's bill (175) — and
-- that night's autopay charged the same card for it again, while the parent's
-- bank was still deciding: a second charge the parent is already disputing.
-- (The webhook also treated a bank's INQUIRY — a question, no money moved — as
-- a chargeback; that part is fixed in stripe-webhook: an inquiry posts nothing,
-- only a dispute that takes money does.)
--
-- ── THE CHANGE ─────────────────────────────────────────────────────────────
-- (Edited after pass 20 — TED-193/194/196/197: the pause lists every open
-- dispute; a decline mark is kept under it; the runner's own marks never
-- replace it; a dispute already won pauses nothing. Edited after pass 21 —
-- TED-200/201/202: the pause is kept on the FAMILY (disputeHold) and on every
-- plan, autopay on or not, the old single plan too; Billing, Charge Card,
-- Batch Charge, the runner and stripe-charge / payments-charge all refuse a
-- paused family; a lost dispute is marked lost, and Resume is refused while
-- another is still open. Edited after pass 22 — TED-207: the family keeps a
-- lasting disputeLog of lost and resumed disputes, so a late message never
-- re-pauses a family the office resumed, and a loss that arrives first counts.)
-- hold_autopay_for_dispute(camp, family, dispute, hold): for stripe-webhook
-- only. When a chargeback is posted, every autopay plan of that family is
-- marked collectionBlocked {reason 'chargeback', disputeId} — the nightly
-- runner skips a plan marked so, Billing shows "Autopay paused — payment
-- disputed", and the camp gets one notice. When the camp WINS, the mark comes
-- off. When the camp loses, it stays: the office decides whether to charge the
-- family again, with resume_autopay_after_dispute (someone who can edit
-- Billing), from Billing.
-- ============================================================================

DO $$
BEGIN
    IF to_regprocedure('public.camp_family_for_update(uuid,text)') IS NULL
       OR to_regprocedure('public.camp_family_save(uuid,text,jsonb)') IS NULL
       OR to_regprocedure('public.user_section_level(uuid,text)') IS NULL
       OR to_regprocedure('public._keep_payer_ledger(jsonb,jsonb)') IS NULL THEN
        RAISE EXCEPTION '288 needs migrations 213, 286 and the access resolver — apply those first';
    END IF;
END $$;

-- The pause, on ONE plan: a dispute added to it, or taken off. The pause lists
-- every open dispute (disputeIds) and comes off only when none is left
-- (TED-193); a card-decline or no-card mark already on the plan is kept under
-- it (under) and put back when the pause lifts, so its retry date survives
-- (TED-197). Every plan is paused, autopay on or not (TED-200): autopay
-- switched on during the dispute must not charge.
CREATE OR REPLACE FUNCTION public._mark_one_plan_for_dispute(p jsonb, p_dispute_id text, p_hold boolean, p_detail text, p_since text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    b     jsonb;
    v_ids jsonb;
BEGIN
    IF jsonb_typeof(p) IS DISTINCT FROM 'object' THEN RETURN p; END IF;
    b := p -> 'collectionBlocked';
    IF COALESCE(jsonb_typeof(b) = 'object' AND b ->> 'reason' = 'chargeback', false) THEN
        v_ids := CASE WHEN jsonb_typeof(b -> 'disputeIds') = 'array' THEN b -> 'disputeIds'
                      WHEN b ? 'disputeId' THEN jsonb_build_array(b ->> 'disputeId') ELSE '[]'::jsonb END;
        IF p_hold THEN
            IF NOT v_ids ? p_dispute_id THEN
                p := jsonb_set(p, '{collectionBlocked}', b || jsonb_build_object('disputeIds', v_ids || to_jsonb(p_dispute_id)), true);
            END IF;
        ELSE
            v_ids := CASE WHEN p_dispute_id IS NULL THEN '[]'::jsonb ELSE v_ids - p_dispute_id END;
            IF jsonb_array_length(v_ids) > 0 THEN
                p := jsonb_set(p, '{collectionBlocked}', b || jsonb_build_object('disputeIds', v_ids, 'disputeId', v_ids ->> 0), true);
            ELSIF jsonb_typeof(b -> 'under') = 'object' THEN
                p := jsonb_set(p, '{collectionBlocked}', b -> 'under', true);
            ELSE
                p := p - 'collectionBlocked';
            END IF;
        END IF;
    ELSIF p_hold THEN
        p := jsonb_set(p, '{collectionBlocked}', jsonb_build_object(
                'reason', 'chargeback', 'disputeId', p_dispute_id, 'disputeIds', jsonb_build_array(p_dispute_id),
                'detail', p_detail, 'since', p_since)
             || CASE WHEN jsonb_typeof(b) = 'object' THEN jsonb_build_object('under', b) ELSE '{}'::jsonb END, true);
    END IF;
    RETURN p;
END $$;
REVOKE ALL ON FUNCTION public._mark_one_plan_for_dispute(jsonb, text, boolean, text, text) FROM public, anon, authenticated;

-- The family with a dispute added to its pause, or taken off it. The pause is
-- kept on the FAMILY (disputeHold: disputeIds, lostIds, since, detail) — so a
-- family that pays by hand, or has no plan yet, is paused too (TED-200) — and
-- on every plan, the old single plan included (TED-201). p_dispute_id NULL
-- with p_hold false: every dispute off (the office's resume).
CREATE OR REPLACE FUNCTION public._mark_plans_for_dispute(p_fam jsonb, p_dispute_id text, p_hold boolean, p_detail text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_out   jsonb := p_fam;
    v_plans jsonb := '[]'::jsonb;
    p       jsonb;
    h       jsonb;
    v_ids   jsonb;
    v_lost  jsonb;
    now_ts  text := to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
BEGIN
    IF jsonb_typeof(p_fam) IS DISTINCT FROM 'object' THEN RETURN p_fam; END IF;

    -- the family's own pause
    h := CASE WHEN jsonb_typeof(p_fam -> 'disputeHold') = 'object' THEN p_fam -> 'disputeHold' END;
    v_ids  := CASE WHEN jsonb_typeof(h -> 'disputeIds') = 'array' THEN h -> 'disputeIds' ELSE '[]'::jsonb END;
    v_lost := CASE WHEN jsonb_typeof(h -> 'lostIds') = 'array' THEN h -> 'lostIds' ELSE '[]'::jsonb END;
    IF p_hold THEN
        IF NOT v_ids ? p_dispute_id THEN v_ids := v_ids || to_jsonb(p_dispute_id); END IF;
        v_out := jsonb_set(v_out, '{disputeHold}',
                   COALESCE(h, jsonb_strip_nulls(jsonb_build_object('since', now_ts, 'detail', p_detail)))
                   || jsonb_build_object('disputeIds', v_ids, 'lostIds', v_lost), true);
    ELSE
        IF p_dispute_id IS NULL THEN
            v_ids := '[]'::jsonb;
        ELSE
            v_ids := v_ids - p_dispute_id;
            v_lost := v_lost - p_dispute_id;
        END IF;
        IF jsonb_array_length(v_ids) > 0 THEN
            v_out := jsonb_set(v_out, '{disputeHold}', h || jsonb_build_object('disputeIds', v_ids, 'lostIds', v_lost), true);
        ELSE
            v_out := v_out - 'disputeHold';
        END IF;
    END IF;

    -- every plan
    IF jsonb_typeof(p_fam -> 'plans') = 'array' THEN
        FOR p IN SELECT * FROM jsonb_array_elements(p_fam -> 'plans') LOOP
            v_plans := v_plans || jsonb_build_array(public._mark_one_plan_for_dispute(p, p_dispute_id, p_hold, p_detail, now_ts));
        END LOOP;
        v_out := jsonb_set(v_out, '{plans}', v_plans, true);
    END IF;
    IF jsonb_typeof(p_fam -> 'plan') = 'object' THEN
        v_out := jsonb_set(v_out, '{plan}', public._mark_one_plan_for_dispute(p_fam -> 'plan', p_dispute_id, p_hold, p_detail, now_ts), true);
    END IF;
    RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public._mark_plans_for_dispute(jsonb, text, boolean, text) FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.hold_autopay_for_dispute(
    p_camp_id    uuid,
    p_family_key text,
    p_dispute_id text,
    p_hold       boolean,
    p_detail     text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_fam jsonb;
    v_new jsonb;
BEGIN
    IF p_camp_id IS NULL OR NULLIF(btrim(COALESCE(p_family_key, '')), '') IS NULL
       OR NULLIF(btrim(COALESCE(p_dispute_id, '')), '') IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_argument');
    END IF;
    v_fam := public.camp_family_for_update(p_camp_id, p_family_key);
    IF v_fam IS NULL OR jsonb_typeof(v_fam) <> 'object' THEN
        RETURN jsonb_build_object('success', false, 'error', 'family_not_found');
    END IF;
    -- A late or repeated message for a dispute the camp already won pauses
    -- nothing (TED-196): the win's line is on the family's ledger.
    IF COALESCE(p_hold, false) AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_fam -> 'entries') = 'array'
                                                    THEN v_fam -> 'entries' ELSE '[]'::jsonb END) e
             WHERE e ->> 'id' = 'le_cbwon_' || p_dispute_id)
       -- ...or a canteen top-up's dispute the camp won (290, TED-210)
       OR EXISTS (SELECT 1 FROM canteen_transactions WHERE camp_id = p_camp_id AND sig = 'xref_won:' || p_dispute_id) THEN
        RETURN jsonb_build_object('success', true, 'changed', false, 'alreadyWon', true);
    END IF;
    -- ...nor one the office already resumed (TED-207): a late or routine
    -- message about it never pauses the family again behind the office's back.
    IF COALESCE(p_hold, false) AND COALESCE((v_fam -> 'disputeLog' -> 'resumed') ? p_dispute_id, false) THEN
        RETURN jsonb_build_object('success', true, 'changed', false, 'alreadyResumed', true);
    END IF;
    v_new := public._mark_plans_for_dispute(v_fam, p_dispute_id, COALESCE(p_hold, false), p_detail);
    -- A loss that arrived before the dispute itself (TED-207): already lost.
    IF COALESCE(p_hold, false) AND COALESCE((v_fam -> 'disputeLog' -> 'lost') ? p_dispute_id, false)
       AND jsonb_typeof(v_new -> 'disputeHold') = 'object'
       AND NOT COALESCE((v_new -> 'disputeHold' -> 'lostIds') ? p_dispute_id, false) THEN
        v_new := jsonb_set(v_new, '{disputeHold,lostIds}',
                   COALESCE(v_new -> 'disputeHold' -> 'lostIds', '[]'::jsonb) || to_jsonb(p_dispute_id), true);
    END IF;
    IF v_new IS NOT DISTINCT FROM v_fam THEN
        RETURN jsonb_build_object('success', true, 'changed', false);
    END IF;
    PERFORM public.camp_family_save(p_camp_id, p_family_key, v_new);
    IF p_hold AND to_regclass('public.notifications') IS NOT NULL THEN
        INSERT INTO notifications (camp_id, source, source_id, title, body, link_target)
        VALUES (p_camp_id, 'autopay_blocked', p_family_key || ':chargeback:' || p_dispute_id,
                'A payment was disputed — card charges paused',
                COALESCE(v_fam ->> 'name', p_family_key)
                  || ' disputed a payment with their bank, so their card will not be charged again — not by autopay, not from Billing. '
                  || 'If the camp wins the dispute this lifts by itself; if not, resume it from Billing once you have agreed with the family.',
                'campistry_me.html')
        ON CONFLICT (camp_id, source, source_id) DO NOTHING;
    END IF;
    RETURN jsonb_build_object('success', true, 'changed', true, 'held', COALESCE(p_hold, false));
END $$;
REVOKE ALL ON FUNCTION public.hold_autopay_for_dispute(uuid, text, text, boolean, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hold_autopay_for_dispute(uuid, text, text, boolean, text) TO service_role;

-- A dispute the camp LOST (TED-202): the pause stays, but that dispute is
-- marked lost — the office may resume once no dispute is still open.
CREATE OR REPLACE FUNCTION public.note_dispute_lost(p_camp_id uuid, p_family_key text, p_dispute_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_fam jsonb;
    v_new jsonb;
    h     jsonb;
    v_lost jsonb;
BEGIN
    IF p_camp_id IS NULL OR NULLIF(btrim(COALESCE(p_family_key, '')), '') IS NULL
       OR NULLIF(btrim(COALESCE(p_dispute_id, '')), '') IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_argument');
    END IF;
    v_fam := public.camp_family_for_update(p_camp_id, p_family_key);
    IF v_fam IS NULL OR jsonb_typeof(v_fam) <> 'object' THEN
        RETURN jsonb_build_object('success', false, 'error', 'family_not_found');
    END IF;
    -- Kept on the family for good (disputeLog), so a loss that arrives before
    -- the dispute itself, or a message after the office resumed, still knows
    -- it was lost (TED-207).
    v_new := v_fam;
    IF NOT COALESCE((v_fam -> 'disputeLog' -> 'lost') ? p_dispute_id, false) THEN
        v_new := jsonb_set(v_new, '{disputeLog}', COALESCE(v_fam -> 'disputeLog', '{}'::jsonb)
                   || jsonb_build_object('lost', COALESCE(v_fam -> 'disputeLog' -> 'lost', '[]'::jsonb) || to_jsonb(p_dispute_id)), true);
    END IF;
    h := CASE WHEN jsonb_typeof(v_new -> 'disputeHold') = 'object' THEN v_new -> 'disputeHold' END;
    IF h IS NOT NULL AND jsonb_typeof(h -> 'disputeIds') = 'array' AND (h -> 'disputeIds') ? p_dispute_id THEN
        v_lost := CASE WHEN jsonb_typeof(h -> 'lostIds') = 'array' THEN h -> 'lostIds' ELSE '[]'::jsonb END;
        IF NOT v_lost ? p_dispute_id THEN
            v_new := jsonb_set(v_new, '{disputeHold,lostIds}', v_lost || to_jsonb(p_dispute_id), true);
        END IF;
    END IF;
    IF v_new IS NOT DISTINCT FROM v_fam THEN
        RETURN jsonb_build_object('success', true, 'changed', false);
    END IF;
    PERFORM public.camp_family_save(p_camp_id, p_family_key, v_new);
    RETURN jsonb_build_object('success', true, 'changed', true);
END $$;
REVOKE ALL ON FUNCTION public.note_dispute_lost(uuid, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.note_dispute_lost(uuid, text, text) TO service_role;

-- The office's own "resume" after a dispute the camp did not win. While a
-- dispute is still open with the bank it is refused (TED-202) unless the
-- office says it is resuming anyway (p_even_open).
DROP FUNCTION IF EXISTS public.resume_autopay_after_dispute(uuid, text);
CREATE OR REPLACE FUNCTION public.resume_autopay_after_dispute(p_camp_id uuid, p_family_key text, p_even_open boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_fam  jsonb;
    v_new  jsonb;
    h      jsonb;
    v_open integer := 0;
BEGIN
    IF auth.uid() IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    IF NOT public.camp_staff_member(p_camp_id)
       OR COALESCE(public.user_section_level(p_camp_id, 'me.billing'), 'none') <> 'edit' THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized',
                                  'message', 'Only someone who can edit Billing can resume autopay.');
    END IF;
    v_fam := public.camp_family_for_update(p_camp_id, p_family_key);
    IF v_fam IS NULL OR jsonb_typeof(v_fam) <> 'object' THEN
        RETURN jsonb_build_object('success', false, 'error', 'family_not_found');
    END IF;
    h := CASE WHEN jsonb_typeof(v_fam -> 'disputeHold') = 'object' THEN v_fam -> 'disputeHold' END;
    IF jsonb_typeof(h -> 'disputeIds') = 'array' THEN
        SELECT count(*) INTO v_open FROM jsonb_array_elements_text(h -> 'disputeIds') d
         WHERE NOT (CASE WHEN jsonb_typeof(h -> 'lostIds') = 'array' THEN h -> 'lostIds' ELSE '[]'::jsonb END) ? d;
    END IF;
    IF v_open > 0 AND NOT COALESCE(p_even_open, false) THEN
        RETURN jsonb_build_object('success', false, 'error', 'dispute_open', 'open', v_open,
            'message', CASE WHEN v_open = 1 THEN 'A dispute is still open with the bank.'
                            ELSE v_open || ' disputes are still open with the bank.' END);
    END IF;
    v_new := public._mark_plans_for_dispute(v_fam, NULL, false, NULL);
    -- The disputes resumed are remembered (TED-207): a late or routine message
    -- about one of them never pauses the family again.
    IF jsonb_typeof(h -> 'disputeIds') = 'array' AND jsonb_array_length(h -> 'disputeIds') > 0 THEN
        v_new := jsonb_set(v_new, '{disputeLog}', COALESCE(v_fam -> 'disputeLog', '{}'::jsonb)
                   || jsonb_build_object('resumed', COALESCE(v_fam -> 'disputeLog' -> 'resumed', '[]'::jsonb)
                        || (SELECT COALESCE(jsonb_agg(d), '[]'::jsonb) FROM jsonb_array_elements(h -> 'disputeIds') d
                             WHERE NOT COALESCE((v_fam -> 'disputeLog' -> 'resumed') @> jsonb_build_array(d), false))), true);
    END IF;
    IF v_new IS DISTINCT FROM v_fam THEN
        PERFORM public.camp_family_save(p_camp_id, p_family_key, v_new);
    END IF;
    RETURN jsonb_build_object('success', true, 'changed', v_new IS DISTINCT FROM v_fam);
END $$;
REVOKE ALL ON FUNCTION public.resume_autopay_after_dispute(uuid, text, boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.resume_autopay_after_dispute(uuid, text, boolean) TO authenticated;

-- The family's pause is the server's (TED-200): an office computer that
-- loaded the family before the dispute (or after it was lifted) never writes
-- its own copy back. _merge_family_from_page (as 286 left it) takes the
-- server's disputeHold, or none, whatever the page sent.
CREATE OR REPLACE FUNCTION public._keep_dispute_hold(p_server jsonb, p_merged jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
BEGIN
    IF p_merged IS NULL OR jsonb_typeof(p_merged) IS DISTINCT FROM 'object'
       OR p_server IS NULL OR jsonb_typeof(p_server) IS DISTINCT FROM 'object' THEN
        RETURN p_merged;
    END IF;
    p_merged := CASE WHEN jsonb_typeof(p_server -> 'disputeLog') = 'object'
                     THEN jsonb_set(p_merged, '{disputeLog}', p_server -> 'disputeLog', true)
                     ELSE p_merged - 'disputeLog' END;
    IF jsonb_typeof(p_server -> 'disputeHold') = 'object' THEN
        RETURN jsonb_set(p_merged, '{disputeHold}', p_server -> 'disputeHold', true);
    END IF;
    RETURN p_merged - 'disputeHold';
END $$;
REVOKE ALL ON FUNCTION public._keep_dispute_hold(jsonb, jsonb) FROM public, anon, authenticated;

DO $$
DECLARE
    d   text := pg_get_functiondef('public._merge_family_from_page(jsonb,jsonb)'::regprocedure);
    old text := 'public._keep_payer_ledger(p_server, v_out)';
BEGIN
    IF position('_keep_dispute_hold' IN d) > 0 THEN
        RAISE NOTICE '288: _merge_family_from_page already keeps the dispute pause';
        RETURN;
    END IF;
    IF position(old IN d) = 0 THEN
        RAISE EXCEPTION '288: _merge_family_from_page does not look the way this file expects (run 286 first) — send this message to the builder';
    END IF;
    EXECUTE replace(d, old, 'public._keep_dispute_hold(p_server, ' || old || ')');
END $$;

-- The nightly runner's own marks (a declined card, no card on file) never
-- replace a dispute pause (TED-194): flag_plan_collection (214) keeps the
-- pause and records its mark under it, to come back when the pause lifts.
DO $$
DECLARE
    d  text := pg_get_functiondef('public.flag_plan_collection(uuid,text,text,text,text)'::regprocedure);
    a1 text := '    v_next   date;';
    b1 text := '    v_next   date;' || chr(10) || '    v_cb     jsonb;';
    a2 text := '    v_prev := v_plan->''collectionBlocked'';';
    b2 text := '    v_prev := v_plan->''collectionBlocked'';' || chr(10)
            || '    -- 288 (TED-194): under a dispute pause, work on the mark kept under it' || chr(10)
            || '    IF COALESCE(jsonb_typeof(v_prev) = ''object'' AND v_prev->>''reason'' = ''chargeback'', false) THEN' || chr(10)
            || '        v_cb := v_prev;' || chr(10)
            || '        v_prev := CASE WHEN jsonb_typeof(v_cb->''under'') = ''object'' THEN v_cb->''under'' END;' || chr(10)
            || '        v_plan := CASE WHEN v_prev IS NULL THEN v_plan - ''collectionBlocked'' ELSE jsonb_set(v_plan, ''{collectionBlocked}'', v_prev, true) END;' || chr(10)
            || '        v_had := v_prev IS NOT NULL;' || chr(10)
            || '    END IF;';
    -- (269 made the write-back go through _plan_path)
    a3 text := '    v_fam := jsonb_set(v_fam, public._plan_path(v_fam, p_plan_id), v_plan, true);';
    b3 text := '    IF v_cb IS NOT NULL THEN' || chr(10)
            || '        v_plan := jsonb_set(v_plan, ''{collectionBlocked}'', (v_cb - ''under'')' || chr(10)
            || '            || CASE WHEN v_plan ? ''collectionBlocked'' THEN jsonb_build_object(''under'', v_plan->''collectionBlocked'') ELSE ''{}''::jsonb END, true);' || chr(10)
            || '    END IF;' || chr(10)
            || '    v_fam := jsonb_set(v_fam, public._plan_path(v_fam, p_plan_id), v_plan, true);';
BEGIN
    IF position('v_cb' IN d) > 0 THEN
        RAISE NOTICE '288: flag_plan_collection already keeps a dispute pause';
        RETURN;
    END IF;
    IF position(a1 IN d) = 0 OR position(a2 IN d) = 0 OR position(a3 IN d) = 0 THEN
        RAISE EXCEPTION '288: flag_plan_collection does not look the way this file expects (run 214 and 269 first) — send this message to the builder';
    END IF;
    EXECUTE replace(replace(replace(d, a1, b1), a2, b2), a3, b3);
END $$;
