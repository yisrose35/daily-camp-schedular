-- ============================================================================
-- Migration 288: while a family's payment is charged back, autopay does not
-- charge them again on its own.
--
-- Standalone. Paste into the Supabase SQL Editor and click Run. Safe to run
-- more than once. Requires 175 and 213. Run it BEFORE deploying stripe-webhook
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
-- replace it; a dispute already won pauses nothing.)
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
       OR to_regprocedure('public.user_section_level(uuid,text)') IS NULL THEN
        RAISE EXCEPTION '288 needs migrations 213 and the access resolver — apply those first';
    END IF;
END $$;

-- The plans of a family with a dispute added to their pause, or taken off it.
-- The pause lists every open dispute (disputeIds) and comes off only when none
-- is left (TED-193); a card-decline or no-card mark already on the plan is
-- kept under it (under) and put back when the pause lifts, so its retry date
-- survives (TED-197). p_dispute_id NULL with p_hold false: the office's resume
-- — every dispute off.
CREATE OR REPLACE FUNCTION public._mark_plans_for_dispute(p_fam jsonb, p_dispute_id text, p_hold boolean, p_detail text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_plans jsonb := '[]'::jsonb;
    p       jsonb;
    b       jsonb;
    v_ids   jsonb;
    now_ts  text := to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
BEGIN
    IF jsonb_typeof(p_fam -> 'plans') IS DISTINCT FROM 'array' THEN RETURN p_fam; END IF;
    FOR p IN SELECT * FROM jsonb_array_elements(p_fam -> 'plans') LOOP
        IF jsonb_typeof(p) = 'object' THEN
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
            ELSIF p_hold AND COALESCE((p ->> 'autopay')::boolean, false) THEN
                p := jsonb_set(p, '{collectionBlocked}', jsonb_build_object(
                        'reason', 'chargeback', 'disputeId', p_dispute_id, 'disputeIds', jsonb_build_array(p_dispute_id),
                        'detail', p_detail, 'since', now_ts)
                     || CASE WHEN jsonb_typeof(b) = 'object' THEN jsonb_build_object('under', b) ELSE '{}'::jsonb END, true);
            END IF;
        END IF;
        v_plans := v_plans || jsonb_build_array(p);
    END LOOP;
    RETURN jsonb_set(p_fam, '{plans}', v_plans, true);
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
             WHERE e ->> 'id' = 'le_cbwon_' || p_dispute_id) THEN
        RETURN jsonb_build_object('success', true, 'changed', false, 'alreadyWon', true);
    END IF;
    v_new := public._mark_plans_for_dispute(v_fam, p_dispute_id, COALESCE(p_hold, false), p_detail);
    IF v_new IS NOT DISTINCT FROM v_fam THEN
        RETURN jsonb_build_object('success', true, 'changed', false);
    END IF;
    PERFORM public.camp_family_save(p_camp_id, p_family_key, v_new);
    IF p_hold AND to_regclass('public.notifications') IS NOT NULL THEN
        INSERT INTO notifications (camp_id, source, source_id, title, body, link_target)
        VALUES (p_camp_id, 'autopay_blocked', p_family_key || ':chargeback:' || p_dispute_id,
                'Autopay paused — a payment was disputed',
                COALESCE(v_fam ->> 'name', p_family_key)
                  || ' disputed a payment with their bank, so autopay will not charge them again on its own. '
                  || 'If the camp wins the dispute it starts again by itself; if not, resume it from Billing once you have agreed with the family.',
                'campistry_me.html')
        ON CONFLICT (camp_id, source, source_id) DO NOTHING;
    END IF;
    RETURN jsonb_build_object('success', true, 'changed', true, 'held', COALESCE(p_hold, false));
END $$;
REVOKE ALL ON FUNCTION public.hold_autopay_for_dispute(uuid, text, text, boolean, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hold_autopay_for_dispute(uuid, text, text, boolean, text) TO service_role;

-- The office's own "resume autopay" after a dispute the camp did not win.
CREATE OR REPLACE FUNCTION public.resume_autopay_after_dispute(p_camp_id uuid, p_family_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_fam jsonb;
    v_new jsonb;
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
    v_new := public._mark_plans_for_dispute(v_fam, NULL, false, NULL);
    IF v_new IS DISTINCT FROM v_fam THEN
        PERFORM public.camp_family_save(p_camp_id, p_family_key, v_new);
    END IF;
    RETURN jsonb_build_object('success', true, 'changed', v_new IS DISTINCT FROM v_fam);
END $$;
REVOKE ALL ON FUNCTION public.resume_autopay_after_dispute(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.resume_autopay_after_dispute(uuid, text) TO authenticated;

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
