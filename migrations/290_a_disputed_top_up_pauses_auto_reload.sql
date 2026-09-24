-- ============================================================================
-- Migration 290: a canteen top-up disputed with the bank switches that child's
-- auto-reload off, until the parent switches it back on.
--
-- Standalone. Paste into the Supabase SQL Editor and click Run. Safe to run
-- more than once. Requires 229, 248, 282 and 287. Run it BEFORE deploying
-- stripe-webhook and canteen-auto-reload.
--
-- ── THE PROBLEM (TED-205) ──────────────────────────────────────────────────
-- A parent disputed a $20 auto-reload. The dispute correctly took the $20 off
-- the child's wallet (287) — which left it empty, exactly what auto-reload
-- answers: the next day it charged the same card $20 again, and again each
-- time it ran low, while the parent's bank was still deciding. Nobody was told.
--
-- ── THE CHANGE ─────────────────────────────────────────────────────────────
-- pause_canteen_autoreload_for_dispute (stripe-webhook only): the child whose
-- top-up it was has auto-reload switched off, with a note Link shows the
-- parent ("switched off because a top-up was disputed …"), and the camp gets a
-- notice. The nightly run's own bookkeeping write (update_canteen_autoreload_
-- state), which carries the copy it read before the dispute, keeps it off; only
-- the parent's own save in Link (set_canteen_auto_reload) switches it back on.
-- (A family whose tuition payment is disputed — 288 — is skipped by the
-- nightly auto-reload run itself, in canteen-auto-reload.)
-- ============================================================================

DO $$
BEGIN
    IF to_regprocedure('public.record_canteen_stripe_reversal(uuid,text,text,numeric,text,text)') IS NULL
       OR to_regprocedure('public.canteen_account_lock(uuid,text)') IS NULL
       OR to_regprocedure('public.set_canteen_auto_reload(uuid,text,jsonb,bigint)') IS NULL
       OR COALESCE(to_regprocedure('public._update_canteen_autoreload_state__by_name(uuid,text,jsonb)'),
                   to_regprocedure('public.update_canteen_autoreload_state(uuid,text,jsonb)')) IS NULL THEN
        RAISE EXCEPTION '290 needs migrations 229, 231, 248 and 287 — apply those first';
    END IF;
END $$;

CREATE OR REPLACE FUNCTION public.pause_canteen_autoreload_for_dispute(
    p_camp_id           uuid,
    p_payment_intent_id text,
    p_dispute_id        text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_pi   text := NULLIF(btrim(COALESCE(p_payment_intent_id, '')), '');
    v_ref  text := NULLIF(btrim(COALESCE(p_dispute_id, '')), '');
    dep    canteen_transactions%ROWTYPE;
    v_acct jsonb;
    v_ar   jsonb;
    v_who  text;
    now_ts text := to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
BEGIN
    IF p_camp_id IS NULL OR v_pi IS NULL OR v_ref IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_argument');
    END IF;
    SELECT * INTO dep FROM canteen_transactions
     WHERE camp_id = p_camp_id AND payload ->> 'stripePaymentIntentId' = v_pi
       AND tx_type = 'credit' AND COALESCE(payload ->> 'kind', '') = 'deposit'
     ORDER BY first_seen LIMIT 1;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'deposit_not_found');
    END IF;
    v_who := regexp_replace(COALESCE(NULLIF(dep.payload ->> 'camper', ''), dep.camper), '\s#\d+$', '');

    v_acct := public.canteen_account_lock(p_camp_id, dep.camper);
    v_ar := CASE WHEN jsonb_typeof(v_acct) = 'object' THEN v_acct -> 'autoReload' END;
    IF jsonb_typeof(v_ar) IS DISTINCT FROM 'object' OR NOT COALESCE((v_ar ->> 'enabled')::boolean, false) THEN
        RETURN jsonb_build_object('success', true, 'changed', false, 'reason', 'auto_reload_off');
    END IF;
    PERFORM public.canteen_account_save(p_camp_id, dep.camper, jsonb_set(v_acct, '{autoReload}', v_ar || jsonb_build_object(
        'enabled', false,
        'disputePausedAt', now_ts, 'disputeId', v_ref,
        'disabledAt', now_ts,
        'disabledReason', 'switched off because a top-up was disputed with the bank — switch it back on once that is settled'), true));
    IF to_regclass('public.notifications') IS NOT NULL THEN
        INSERT INTO notifications (camp_id, source, source_id, title, body, link_target)
        VALUES (p_camp_id, 'canteen_autoreload_off', dep.camper || ':dispute:' || v_ref,
                'Canteen auto-reload switched off — a top-up was disputed',
                v_who || '''s parent disputed a canteen top-up with their bank, so auto-reload has been switched off '
                  || 'and will not charge that card again. It stays off until the parent switches it back on in Link.',
                'campistry_snacks.html')
        ON CONFLICT (camp_id, source, source_id) DO NOTHING;
    END IF;
    RETURN jsonb_build_object('success', true, 'changed', true, 'camper', v_who);
END $$;
REVOKE ALL ON FUNCTION public.pause_canteen_autoreload_for_dispute(uuid, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pause_canteen_autoreload_for_dispute(uuid, text, text) TO service_role;

-- The nightly run writes back the copy it read: that copy never switches a
-- dispute pause back on.
DO $$
DECLARE
    p   regprocedure := COALESCE(to_regprocedure('public._update_canteen_autoreload_state__by_name(uuid,text,jsonb)'),
                                 to_regprocedure('public.update_canteen_autoreload_state(uuid,text,jsonb)'));
    d   text := pg_get_functiondef(p);
    old text := $o$    v_acct := jsonb_set(v_acct, '{autoReload}', p_autoreload, true);$o$;
    new text := $n$    -- 290 (TED-205): a dispute pause stays off until the parent's own save.
    IF jsonb_typeof(v_prev) = 'object' AND v_prev ? 'disputePausedAt' AND NOT p_autoreload ? 'disputePausedAt' THEN
        p_autoreload := p_autoreload || jsonb_build_object('enabled', false,
            'disputePausedAt', v_prev -> 'disputePausedAt', 'disputeId', v_prev -> 'disputeId',
            'disabledAt', v_prev -> 'disabledAt', 'disabledReason', v_prev -> 'disabledReason');
    END IF;
    v_acct := jsonb_set(v_acct, '{autoReload}', p_autoreload, true);$n$;
BEGIN
    IF position('disputePausedAt' IN d) > 0 THEN
        RAISE NOTICE '290: the nightly run''s write already keeps a dispute pause';
        RETURN;
    END IF;
    IF position(old IN d) = 0 THEN
        RAISE EXCEPTION '290: update_canteen_autoreload_state does not look the way this file expects — send this message to the builder';
    END IF;
    EXECUTE replace(d, old, new);
END $$;

-- The parent's own save in Link switches it back on: the pause note goes (as
-- 282 does for the camp's other notes).
DO $$
DECLARE
    d   text := pg_get_functiondef('public.set_canteen_auto_reload(uuid,text,jsonb,bigint)'::regprocedure);
    old text := $o$    v_ar := (v_ar - 'disabledReason') - 'disabledAt';$o$;
    new text := $n$    v_ar := (((v_ar - 'disabledReason') - 'disabledAt') - 'disputePausedAt') - 'disputeId';$n$;
BEGIN
    IF position('disputePausedAt' IN d) > 0 THEN
        RAISE NOTICE '290: a parent''s save already clears the dispute pause';
        RETURN;
    END IF;
    IF position(old IN d) = 0 THEN
        RAISE EXCEPTION '290: set_canteen_auto_reload does not look the way this file expects (run 282 first) — send this message to the builder';
    END IF;
    EXECUTE replace(d, old, new);
END $$;
