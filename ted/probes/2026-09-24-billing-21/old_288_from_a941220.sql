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

-- The plans of a family with a dispute's mark set, or taken off (only that
-- dispute's mark; a card-decline or no-card mark is left alone).
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
    now_ts  text := to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
BEGIN
    IF jsonb_typeof(p_fam -> 'plans') IS DISTINCT FROM 'array' THEN RETURN p_fam; END IF;
    FOR p IN SELECT * FROM jsonb_array_elements(p_fam -> 'plans') LOOP
        IF jsonb_typeof(p) = 'object' THEN
            b := p -> 'collectionBlocked';
            IF p_hold THEN
                -- COALESCE: with no mark yet b is NULL, and NOT (NULL …) is not true
                IF COALESCE((p ->> 'autopay')::boolean, false)
                   AND NOT COALESCE(jsonb_typeof(b) = 'object' AND b ->> 'reason' = 'chargeback', false) THEN
                    p := jsonb_set(p, '{collectionBlocked}', jsonb_build_object(
                        'reason', 'chargeback', 'disputeId', p_dispute_id, 'detail', p_detail, 'since', now_ts), true);
                END IF;
            ELSIF COALESCE(jsonb_typeof(b) = 'object' AND b ->> 'reason' = 'chargeback'
                  AND (p_dispute_id IS NULL OR b ->> 'disputeId' = p_dispute_id), false) THEN
                p := p - 'collectionBlocked';
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
