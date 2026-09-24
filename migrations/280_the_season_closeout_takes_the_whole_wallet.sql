-- ============================================================================
-- Migration 280: the season close-out takes a child's canteen money off in
-- full, with its own write — not the till's cash-out.
--
-- Standalone. Paste into the Supabase SQL Editor and click Run. Safe to run
-- more than once. Run it BEFORE reloading Me.
--
-- ── THE PROBLEM (TED-142, TED-145, TED-143) ─────────────────────────────────
-- Me's "Close out…" took a child's canteen money off through
-- canteen_office_cash_out — the register's cash-out, with the register's
-- rules: the Snacks default of $20 cash a day per child, and the parent's
-- balance floor. So a close-out of more than $20 took nothing ("over_available")
-- and a child with a $10 floor could never be closed out in full. And a child
-- closed out kept auto-reload on, so the parent's card topped the emptied
-- wallet straight back up.
--
-- ── THE CHANGE ─────────────────────────────────────────────────────────────
-- canteen_season_closeout takes up to the WHOLE balance (never more), under the
-- wallet's lock, whatever the till's daily cash limit or the parent's floor —
-- the floor limits what a child may SPEND; at the end of the season the money
-- goes back to the family. It posts one 'closeout' line on the child's
-- history, switches the child's auto-reload off (saying why, for the parent's
-- Link page), and answers in words.
--
-- Only a member of the camp who can edit Billing can call it (the same rule as
-- the rest of Me's billing actions).
-- ============================================================================

DO $$
BEGIN
    IF to_regprocedure('public.canteen_account_lock(uuid,text)') IS NULL
       OR to_regprocedure('public.canteen_post(uuid,text,jsonb,text)') IS NULL
       OR to_regprocedure('public.camp_person_name_for(uuid,bigint)') IS NULL
       OR to_regprocedure('public.camp_staff_member(uuid)') IS NULL
       OR to_regprocedure('public.user_section_level(uuid,text)') IS NULL THEN
        RAISE EXCEPTION '280 needs migrations 219, 227, 257 and the access resolver — apply those first';
    END IF;
END $$;

CREATE OR REPLACE FUNCTION public.canteen_season_closeout(
    p_camp_id     uuid,
    p_camper_id   bigint,
    p_camper_name text,
    p_amount      numeric,
    p_note        text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_name  text := NULLIF(btrim(COALESCE(p_camper_name, '')), '');
    v_amt   numeric := round(COALESCE(p_amount, 0), 2);
    v_acct  jsonb;
    v_bal   numeric;
    v_ar    jsonb;
    v_note  text := COALESCE(NULLIF(btrim(COALESCE(p_note, '')), ''), 'Season close-out');
    now_ts  timestamptz := now();
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated',
                                  'message', 'Not signed in.');
    END IF;
    IF NOT public.camp_staff_member(p_camp_id)
       OR COALESCE(public.user_section_level(p_camp_id, 'me.billing'), 'none') <> 'edit' THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized',
                                  'message', 'Only someone who can edit Billing can close out canteen money.');
    END IF;
    IF p_camper_id IS NOT NULL THEN
        -- The number decides, pinned for this call (257).
        v_name := public.camp_person_name_for(p_camp_id, p_camper_id);
        IF v_name IS NULL THEN
            RETURN jsonb_build_object('success', false, 'error', 'unknown_camper',
                                      'message', 'That child is not on this camp''s roster.');
        END IF;
    END IF;
    IF v_name IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_camper', 'message', 'Which child?');
    END IF;
    IF v_amt <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_amount', 'message', 'Nothing to close out.');
    END IF;

    v_acct := public.canteen_account_lock(p_camp_id, v_name);
    IF v_acct IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_canteen_account',
                                  'message', 'This child has no canteen account.');
    END IF;
    v_bal := round(COALESCE(NULLIF(v_acct ->> 'balance', '')::numeric, 0), 2);
    -- The whole balance, never more — no till limit, no floor (TED-142/145).
    IF v_amt > v_bal THEN
        RETURN jsonb_build_object('success', false, 'error', 'over_balance', 'balance', v_bal,
            'message', 'Only $' || to_char(GREATEST(v_bal, 0), 'FM999999990.00') || ' is on the canteen account now — reopen the close-out to see the current figure.');
    END IF;

    v_bal := round(v_bal - v_amt, 2);
    v_acct := v_acct || jsonb_build_object('balance', v_bal);
    -- Auto-reload off (TED-143): the wallet is being emptied for the season.
    v_ar := v_acct -> 'autoReload';
    IF jsonb_typeof(v_ar) = 'object' AND COALESCE((v_ar ->> 'enabled')::boolean, false) THEN
        v_acct := jsonb_set(v_acct, '{autoReload}', v_ar || jsonb_build_object(
            'enabled', false,
            'disabledAt', to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'disabledReason', 'switched off when the camp closed out the canteen balance for the season — switch it back on if you still want it'), true);
    END IF;
    PERFORM public.canteen_account_save(p_camp_id, v_name, v_acct);
    PERFORM public.canteen_post(p_camp_id, v_name,
        jsonb_build_object(
            'time',   to_char(now_ts, 'HH12:MI AM'),
            'camper', v_name,
            'items',  v_note,
            'amount', v_amt,
            'type',   'debit',
            'kind',   'closeout',
            'note',   v_note,
            'by',     'office (close-out)',
            'date',   to_char(now_ts, 'YYYY-MM-DD'),
            'timestamp', (extract(epoch FROM now_ts) * 1000)::bigint)
        || CASE WHEN p_camper_id IS NOT NULL THEN jsonb_build_object('camperId', p_camper_id) ELSE '{}'::jsonb END);
    RETURN jsonb_build_object('success', true, 'balance', v_bal, 'amount', v_amt, 'camper', v_name);
END $$;
REVOKE ALL ON FUNCTION public.canteen_season_closeout(uuid, bigint, text, numeric, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.canteen_season_closeout(uuid, bigint, text, numeric, text) TO authenticated, service_role;
