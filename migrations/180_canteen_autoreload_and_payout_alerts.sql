-- ============================================================================
-- Migration 180: two ways money quietly stops, both of which currently tell
-- nobody.
--
-- NOT PART OF APPLY_BUNDLE.sql. From here on migrations are pasted
-- individually — run this file on its own in the SQL Editor. It is idempotent,
-- so re-running it is safe.
--
-- ── 1. CANTEEN AUTO-RELOAD TURNS ITSELF OFF IN SILENCE ─────────────────────
-- canteen-auto-reload already does the sensible thing with a failing card:
-- three consecutive declines and it sets enabled = false rather than burning an
-- authorisation fee a night. That instinct was right and it predates the same
-- fix on the tuition side.
--
-- What it never did was tell anyone. There is not one insert into
-- `notifications` anywhere in that function. So the card fails three times,
-- auto-reload switches off, and the first anyone hears about it is a child being
-- declined at the counter — and the camp cannot explain why, because nothing
-- told them either.
--
-- The notification belongs HERE rather than in the edge function, in the RPC
-- that performs the state change. It already reads the old value under the row
-- lock, so it is the one place that can see enabled going true -> false; and
-- putting it here means any future caller gets it without having to remember.
-- That is the same reasoning as the trigger in 176: a rule enforced at the
-- write cannot be skipped by the next writer.
--
-- ── 2. A CAMP'S OWN PAYOUT FAILS AND CAMPISTRY SHOWS NOTHING ───────────────
-- stripe-webhook handles payout.failed, but that is the PLATFORM's payout and
-- the alert goes to the platform's own address. A camp on Stripe Connect has
-- its own payouts, and stripe-connect-webhook handles exactly three events —
-- account.updated, payment_intent.succeeded, payment_intent.payment_failed.
-- None of them is a payout.
--
-- So a camp with a closed bank account or a mistyped routing number sees money
-- collected, sees no money arrive, and finds nothing in Campistry that explains
-- the gap. Stripe does email the connected account holder, which is why this is
-- the smaller of the two — but for a destination-charge setup the camp often has
-- no Stripe login anyone watches, and "the software that shows me my money said
-- nothing" is the complaint either way.
--
-- record_payout_failure is deliberately processor-agnostic in shape: nothing
-- about it is Stripe-specific beyond who calls it.
-- ============================================================================

-- ─── 1. the auto-reload state write, now with a voice ───────────────────────
-- 144's function, unchanged except that it compares the incoming autoReload
-- with the stored one and speaks when collection has stopped.
CREATE OR REPLACE FUNCTION public.update_canteen_autoreload_state(
    p_camp_id      uuid,
    p_camper_name  text,
    p_autoreload   jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_value   jsonb;
    now_ts    timestamptz := now();
    v_prev    jsonb;
    v_was_on  boolean;
    v_now_on  boolean;
    v_fails   integer;
    v_reason  text;
    v_notify  boolean := false;
BEGIN
    IF p_camp_id IS NULL OR p_camper_name IS NULL OR btrim(p_camper_name) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_params');
    END IF;
    IF p_autoreload IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_autoreload');
    END IF;

    SELECT value INTO v_value FROM camp_state_kv
    WHERE camp_id = p_camp_id AND key = 'campistrySnacks' FOR UPDATE;
    IF v_value IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_snacks_row');
    END IF;
    IF v_value->'accounts' IS NULL THEN v_value := jsonb_set(v_value, '{accounts}', '{}'::jsonb); END IF;
    IF v_value->'accounts'->p_camper_name IS NULL THEN
        v_value := jsonb_set(v_value, ARRAY['accounts', p_camper_name],
            '{"balance":0,"dailyLimit":10,"spentToday":0}'::jsonb, true);
    END IF;

    -- The transition, read under the lock we already hold. Only ON -> OFF
    -- matters: a parent switching it off themselves never reaches this
    -- function, and an already-off card failing again is not news.
    v_prev   := v_value #> ARRAY['accounts', p_camper_name, 'autoReload'];
    v_was_on := COALESCE((v_prev->>'enabled')::boolean, false);
    v_now_on := COALESCE((p_autoreload->>'enabled')::boolean, false);
    v_fails  := COALESCE((p_autoreload->>'consecutiveFailures')::integer, 0);
    v_reason := NULLIF(p_autoreload->>'lastFailureReason', '');
    v_notify := v_was_on AND NOT v_now_on AND v_fails >= 3;

    -- Only the autoReload sub-key is replaced. balance and transactions in the
    -- freshly-read row (including anything credit_canteen_balance_from_processor
    -- just committed) are left exactly as they are.
    v_value := jsonb_set(v_value, ARRAY['accounts', p_camper_name, 'autoReload'], p_autoreload, true);

    -- A stamp any screen can read, so the reason survives past the
    -- notification and a parent's Link page can explain itself too.
    IF v_notify THEN
        v_value := jsonb_set(v_value,
            ARRAY['accounts', p_camper_name, 'autoReload', 'disabledAt'],
            to_jsonb(to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')), true);
        v_value := jsonb_set(v_value,
            ARRAY['accounts', p_camper_name, 'autoReload', 'disabledReason'],
            to_jsonb(COALESCE(v_reason, 'the card was declined three times')), true);
    END IF;

    UPDATE camp_state_kv SET value = v_value, updated_at = now_ts
    WHERE camp_id = p_camp_id AND key = 'campistrySnacks';

    IF v_notify THEN
        -- Deduped per camper per SWITCH-OFF DAY. A card re-enabled and failing
        -- again weeks later is a new problem worth a new message; the same
        -- switch-off reported twice in one night is not.
        INSERT INTO notifications (camp_id, source, source_id, title, body, link_target)
        VALUES (p_camp_id, 'canteen_autoreload_off',
                p_camper_name || ':' || to_char(now_ts, 'YYYY-MM-DD'),
                'Canteen auto-reload switched off',
                p_camper_name || ' — their card was declined ' || v_fails
                  || ' times in a row, so canteen auto-reload has been turned off'
                  || COALESCE(' (' || v_reason || ')', '')
                  || '. Their balance will not top up again, and they will be '
                  || 'declined at the register once it runs out. Ask the family '
                  || 'for a new card.',
                'campistry_snacks.html')
        ON CONFLICT (camp_id, source, source_id) DO NOTHING;
    END IF;

    RETURN jsonb_build_object('success', true, 'autoReloadDisabled', v_notify);
END;
$$;
REVOKE ALL ON FUNCTION public.update_canteen_autoreload_state(uuid, text, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_canteen_autoreload_state(uuid, text, jsonb) TO service_role;


-- ─── 2. the camp's money did not arrive ─────────────────────────────────────
-- Resolves the camp from the CONNECTED ACCOUNT id, because that is all a
-- connected-account webhook carries. Refuses rather than guesses: a payout
-- alert on the wrong camp's dashboard sends the wrong office to their bank.
CREATE OR REPLACE FUNCTION public.record_payout_failure(
    p_stripe_account_id text,
    p_payout_id         text,
    p_amount            numeric DEFAULT NULL,
    p_currency          text DEFAULT NULL,
    p_failure_message   text DEFAULT NULL,
    p_arrival_date      date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_camp uuid;
    v_name text;
BEGIN
    IF COALESCE(p_stripe_account_id, '') = '' OR COALESCE(p_payout_id, '') = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_arguments');
    END IF;

    SELECT id, name INTO v_camp, v_name
      FROM camps WHERE stripe_account_id = p_stripe_account_id LIMIT 1;
    IF v_camp IS NULL THEN
        -- Not one of ours, or a camp that has since disconnected. Saying so is
        -- the whole answer; inventing a camp to attach it to is not.
        RETURN jsonb_build_object('success', false, 'error', 'camp_not_found',
                                  'stripeAccountId', p_stripe_account_id);
    END IF;

    INSERT INTO notifications (camp_id, source, source_id, title, body, link_target)
    VALUES (v_camp, 'payout_failed', p_payout_id,
            'A payout to your bank failed',
            'Stripe could not pay '
              || COALESCE('$' || ROUND(p_amount, 2)::text, 'a payout')
              || ' into your bank account'
              || COALESCE(' (' || p_failure_message || ')', '')
              || '. The money is still with Stripe, not lost — but it will not '
              || 'arrive until the bank details are corrected in your Stripe '
              || 'account. Payouts usually stay paused until you fix it.',
            'campistry_me.html')
    ON CONFLICT (camp_id, source, source_id) DO NOTHING;

    RETURN jsonb_build_object('success', true, 'campId', v_camp, 'campName', v_name);
END;
$$;
REVOKE ALL ON FUNCTION public.record_payout_failure(text, text, numeric, text, text, date)
    FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_payout_failure(text, text, numeric, text, text, date)
    TO service_role;


-- ─── Checking it ───────────────────────────────────────────────────────────
-- Auto-reload switching off should speak once:
--   select update_canteen_autoreload_state('<camp>'::uuid, '<camper>',
--     '{"enabled":false,"consecutiveFailures":3,"lastFailureReason":"Do not honor"}'::jsonb);
--   -- autoReloadDisabled: true, and one row in notifications
--   select title, body from notifications
--    where camp_id='<camp>'::uuid and source='canteen_autoreload_off';
--
-- ...and stay quiet when nothing changed (it was already off):
--   -- run the same call again: autoReloadDisabled FALSE, still one notification
--
-- A payout failure lands on the right camp, or on none:
--   select record_payout_failure('<the camp''s acct_...>', 'po_test', 1234.56,
--                                'usd', 'Bank account closed');
--   select record_payout_failure('acct_nosuchthing', 'po_test2', 10);
--   -- success:false, error "camp_not_found" — never attached to a guess
-- ============================================================================
