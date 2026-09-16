-- ============================================================================
-- Migration 179: a card that stops working gets chased on a schedule and
-- escalated, instead of being retried into the void; and a card about to expire
-- says so before it fails.
--
-- ── WHAT WAS WRONG WITH A DECLINE ──────────────────────────────────────────
-- 175 flagged a declined plan and raised one notification. After that: nothing.
-- Every instalment date the same dead card was charged again, declined again,
-- and told nobody again — the notification is deduped on
-- (family, plan, reason), which is right for not nagging nightly and wrong for
-- a plan that has now failed six times. The office saw one message in June for
-- a card that collected nothing all summer.
--
-- Three things follow from that, and all three are fixed here:
--
--   1. NOBODY WAS TOLD IT WAS GETTING WORSE. One decline is a bad night; three
--      is a card that is not coming back. Those need different words, so the
--      third failure escalates — its own notification, its own source_id, so it
--      arrives even though the first one was already sent.
--
--   2. EVERY ATTEMPT COST MONEY. Most processors charge per authorisation
--      whether it approves or declines. Retrying a closed account on every
--      instalment date bills the camp for the privilege. Attempts now back off:
--      3 days, then 5, then 7, then a fortnight.
--
--   3. THE PLAN QUIETLY RAN OUT. A declined instalment still advances the
--      counter (deliberately — the derived model rolls what was not collected
--      into the instalments that are left). But with a card that never works,
--      the counter reaches the end, the plan reads finished, and the balance is
--      still sitting there. The backoff above is what stops that: after three
--      strikes attempts are fortnightly, so the plan cannot burn itself out in
--      a week of due dates while the office is waiting to hear something.
--
-- Clearing is unchanged and still automatic: one successful charge removes the
-- block, the attempt count and the schedule together. A parent fixing their own
-- card needs no one to dismiss anything.
--
-- ── AND THE FAILURE NOBODY HAD TO HAVE ─────────────────────────────────────
-- A card expires on a date known the day it is saved. Autopay would simply
-- start declining in the middle of the summer and fall into the dunning above —
-- correct handling of a problem that did not need to happen. flag_expiring_cards
-- looks ahead instead.
--
-- It can only report what was captured. Stripe gives exp_month/exp_year on the
-- PaymentMethod and stripe-webhook now stores them. The BYOP adapters return a
-- brand and last four and no expiry at all, so a Cardknox or Banquest card is
-- reported as `unknown` and deliberately NOT warned about — a warning nobody
-- can act on is worse than silence, and pretending to check is worse still.
--
-- Idempotent.
-- ============================================================================

-- ─── 1. how long to wait before trying that card again ──────────────────────
-- Deliberately a function rather than numbers buried in the runner: the same
-- schedule has to be readable by whatever decides to attempt, by whatever
-- reports "next try Tuesday", and by the test.
CREATE OR REPLACE FUNCTION public.collection_retry_days(p_attempts integer)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
    SELECT CASE
        WHEN COALESCE(p_attempts, 0) <= 1 THEN 3
        WHEN p_attempts = 2              THEN 5
        WHEN p_attempts = 3              THEN 7
        ELSE 14
    END;
$$;
REVOKE ALL ON FUNCTION public.collection_retry_days(integer) FROM public;
GRANT EXECUTE ON FUNCTION public.collection_retry_days(integer)
    TO authenticated, service_role;

-- Three consecutive failures is the point at which this stops being bad luck.
CREATE OR REPLACE FUNCTION public.collection_escalate_after()
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$ SELECT 3; $$;
REVOKE ALL ON FUNCTION public.collection_escalate_after() FROM public;
GRANT EXECUTE ON FUNCTION public.collection_escalate_after()
    TO authenticated, service_role;


-- ─── 2. may this plan be attempted today? ───────────────────────────────────
-- A plan with no block is always ready — this only ever holds back one that is
-- already known to be failing. An unparseable or missing nextRetryAt reads as
-- ready, so a bad value can only ever cost an extra attempt, never stop
-- collection outright.
CREATE OR REPLACE FUNCTION public.plan_collection_ready(p_plan jsonb, p_as_of date)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
    SELECT CASE
        WHEN p_plan IS NULL OR NOT (p_plan ? 'collectionBlocked') THEN true
        WHEN COALESCE(p_plan->'collectionBlocked'->>'nextRetryAt', '') = '' THEN true
        ELSE (p_plan->'collectionBlocked'->>'nextRetryAt')::date
                 <= COALESCE(p_as_of, CURRENT_DATE)
    END;
$$;
REVOKE ALL ON FUNCTION public.plan_collection_ready(jsonb, date) FROM public;
GRANT EXECUTE ON FUNCTION public.plan_collection_ready(jsonb, date)
    TO authenticated, service_role;


-- ─── 3. the flag, now with a memory ─────────────────────────────────────────
-- 175's function plus the attempt count, the schedule and the escalation. The
-- clearing behaviour and the "keep the original `since`" rule are unchanged.
CREATE OR REPLACE FUNCTION public.flag_plan_collection(
    p_camp_id    uuid,
    p_family_key text,
    p_plan_id    text,
    p_reason     text DEFAULT NULL,
    p_detail     text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    now_ts   timestamptz := now();
    v_me     jsonb;
    v_fam    jsonb;
    v_plans  jsonb;
    v_plan   jsonb;
    v_pi     integer := NULL;
    v_had    boolean;
    v_same   boolean := false;
    v_prev   jsonb;
    v_att    integer := 1;
    v_esc    boolean := false;
    v_was    boolean := false;
    v_next   date;
    i        integer;
BEGIN
    IF p_camp_id IS NULL OR COALESCE(p_family_key, '') = ''
       OR COALESCE(p_plan_id, '') = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_arguments');
    END IF;

    SELECT value INTO v_me FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe'
     FOR UPDATE;
    IF v_me IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_camp_data');
    END IF;

    v_fam := v_me #> ARRAY['families', p_family_key];
    IF v_fam IS NULL OR jsonb_typeof(v_fam) <> 'object' THEN
        RETURN jsonb_build_object('success', false, 'error', 'family_not_found');
    END IF;

    v_plans := CASE WHEN jsonb_typeof(v_fam->'plans') = 'array'
                    THEN v_fam->'plans' ELSE '[]'::jsonb END;
    FOR i IN 0 .. GREATEST(jsonb_array_length(v_plans) - 1, -1) LOOP
        IF v_plans->i->>'id' = p_plan_id THEN v_pi := i; EXIT; END IF;
    END LOOP;
    IF v_pi IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'plan_not_found');
    END IF;
    v_plan := v_plans->v_pi;
    v_had  := (v_plan ? 'collectionBlocked');
    v_prev := v_plan->'collectionBlocked';
    v_same := v_had AND v_prev->>'reason' = p_reason;

    IF COALESCE(p_reason, '') = '' THEN
        -- Collected. The block, the count and the schedule all go together: a
        -- parent who fixes their own card needs nobody to dismiss anything.
        IF NOT v_had THEN
            RETURN jsonb_build_object('success', true, 'changed', false);
        END IF;
        v_plan := v_plan - 'collectionBlocked';
    ELSE
        -- Consecutive failures OF THE SAME KIND. A different reason is a
        -- different problem and starts its own count — "declined" three times
        -- is a dead card; declined, then no_processor, then declined is not.
        v_att := CASE WHEN v_same
                      THEN COALESCE((v_prev->>'attempts')::integer, 1) + 1
                      ELSE 1 END;
        v_was := v_same AND COALESCE((v_prev->>'escalated')::boolean, false);
        v_esc := v_att >= public.collection_escalate_after();
        v_next := (now_ts AT TIME ZONE 'UTC')::date
                  + public.collection_retry_days(v_att);

        v_plan := jsonb_set(v_plan, '{collectionBlocked}', jsonb_build_object(
            'reason', p_reason,
            'detail', p_detail,
            -- Keep the ORIGINAL `since` when the reason has not changed, so the
            -- office can see how long a plan has been stuck rather than a date
            -- that resets every night.
            'since', CASE WHEN v_same THEN v_prev->>'since'
                          ELSE to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') END,
            'attempts', v_att,
            'lastAttemptAt', to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'nextRetryAt', to_char(v_next, 'YYYY-MM-DD'),
            'escalated', v_esc
        ), true);
    END IF;

    v_plans := jsonb_set(v_plans, ARRAY[v_pi::text], v_plan, true);
    v_fam := jsonb_set(v_fam, '{plans}', v_plans, true);
    v_me := jsonb_set(v_me, ARRAY['families', p_family_key], v_fam, true);

    UPDATE camp_state_kv SET value = v_me, updated_at = now_ts
     WHERE camp_id = p_camp_id AND key = 'campistryMe';

    IF COALESCE(p_reason, '') <> '' THEN
        INSERT INTO notifications (camp_id, source, source_id, title, body, link_target)
        VALUES (p_camp_id, 'autopay_blocked',
                p_family_key || ':' || p_plan_id || ':' || p_reason,
                'Autopay cannot collect',
                COALESCE(v_fam->>'name', p_family_key) || ' — '
                  || CASE p_reason
                       WHEN 'no_card' THEN 'their payment plan is still active but there is no card on file, so nothing is being collected'
                       WHEN 'declined' THEN 'their card was declined'
                       WHEN 'no_processor' THEN 'the camp''s payment processor is not connected'
                       ELSE p_reason END
                  || COALESCE('. ' || p_detail, '') || '.',
                'campistry_me.html')
        ON CONFLICT (camp_id, source, source_id) DO NOTHING;

        -- The escalation. Its own source_id, because the first notification was
        -- already sent and deduped — without a distinct key the message that
        -- actually matters would be swallowed by the one that no longer does.
        -- Sent once, on the attempt that crosses the line, not every time after.
        IF v_esc AND NOT v_was THEN
            INSERT INTO notifications (camp_id, source, source_id, title, body, link_target)
            VALUES (p_camp_id, 'autopay_blocked',
                    p_family_key || ':' || p_plan_id || ':' || p_reason || ':escalated',
                    'This card is not going to start working',
                    COALESCE(v_fam->>'name', p_family_key) || ' — ' || v_att
                      || ' attempts have now failed'
                      || COALESCE(' (' || p_detail || ')', '')
                      || '. Automatic retries continue every '
                      || public.collection_retry_days(v_att)
                      || ' days, but nothing will be collected until someone '
                      || 'contacts the family for a new card.',
                    'campistry_me.html')
            ON CONFLICT (camp_id, source, source_id) DO NOTHING;
        END IF;
    END IF;

    RETURN jsonb_build_object('success', true, 'changed', true,
                              'blocked', COALESCE(p_reason, '') <> '',
                              'attempts', CASE WHEN COALESCE(p_reason,'') = '' THEN 0 ELSE v_att END,
                              'escalated', v_esc,
                              'nextRetryAt', v_next);
END;
$$;
REVOKE ALL ON FUNCTION public.flag_plan_collection(uuid, text, text, text, text)
    FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.flag_plan_collection(uuid, text, text, text, text)
    TO service_role;


-- ─── 4. a card with a date on it ────────────────────────────────────────────
-- 'expired' | 'expiring' | 'ok' | 'unknown'. A card expires at the END of its
-- month, which is why this compares against the first of the NEXT one — a
-- 09/2026 card is good all through September.
CREATE OR REPLACE FUNCTION public.card_expiry_status(
    p_method jsonb, p_as_of date, p_days integer DEFAULT 30)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_m   integer := NULLIF(p_method->>'expMonth', '')::integer;
    v_y   integer := NULLIF(p_method->>'expYear', '')::integer;
    v_end date;
BEGIN
    IF v_m IS NULL OR v_y IS NULL OR v_m < 1 OR v_m > 12 THEN
        -- No expiry was captured. The BYOP adapters return a brand and last
        -- four and nothing else, so this is the normal answer for a Cardknox or
        -- Banquest card — reported honestly rather than guessed at.
        RETURN 'unknown';
    END IF;
    IF v_y < 100 THEN v_y := 2000 + v_y; END IF;       -- '27' means 2027
    v_end := (make_date(v_y, v_m, 1) + interval '1 month')::date;

    IF v_end <= COALESCE(p_as_of, CURRENT_DATE) THEN RETURN 'expired'; END IF;
    IF v_end <= COALESCE(p_as_of, CURRENT_DATE) + COALESCE(p_days, 30) THEN
        RETURN 'expiring';
    END IF;
    RETURN 'ok';
END;
$$;
REVOKE ALL ON FUNCTION public.card_expiry_status(jsonb, date, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.card_expiry_status(jsonb, date, integer)
    TO authenticated, service_role;


-- ─── 5. tell the camp before it fails, not after ────────────────────────────
-- Writes family.cardExpiry so Billing can show it, and raises one notification
-- per card per MONTH — deduped on the month so a card expiring in three weeks
-- is mentioned once rather than every night, and mentioned again next month if
-- nobody has acted.
--
-- Only families that actually have autopay running are considered. A card on
-- file for a family with no active plan expiring is not a problem to chase.
CREATE OR REPLACE FUNCTION public.flag_expiring_cards(
    p_camp_id uuid,
    p_as_of   date DEFAULT NULL,
    p_days    integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    now_ts    timestamptz := now();
    v_as_of   date := COALESCE(p_as_of, (now() AT TIME ZONE 'UTC')::date);
    v_me      jsonb;
    famRec    record;
    v_fam     jsonb;
    v_methods jsonb;
    m         jsonb;
    v_status  text;
    v_worst   text;
    v_label   text;
    v_changed boolean := false;
    v_expired integer := 0;
    v_expiring integer := 0;
    v_report  jsonb := '[]'::jsonb;
    v_autopay boolean;
    i         integer;
BEGIN
    IF p_camp_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_arguments');
    END IF;

    SELECT value INTO v_me FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe'
     FOR UPDATE;
    IF v_me IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_camp_data');
    END IF;

    FOR famRec IN SELECT key, value FROM jsonb_each(
                      COALESCE(v_me->'families', '{}'::jsonb)) LOOP
        IF jsonb_typeof(famRec.value) <> 'object' THEN CONTINUE; END IF;
        v_fam := famRec.value;

        SELECT EXISTS (
            SELECT 1 FROM jsonb_array_elements(
                     CASE WHEN jsonb_typeof(v_fam->'plans') = 'array'
                          THEN v_fam->'plans' ELSE '[]'::jsonb END) p
             WHERE COALESCE((p->>'autopay')::boolean, false)
               AND NOT COALESCE((p->>'paused')::boolean, false)
        ) INTO v_autopay;
        IF NOT v_autopay THEN CONTINUE; END IF;

        v_methods := CASE WHEN jsonb_typeof(v_fam->'savedPaymentMethods') = 'array'
                          THEN v_fam->'savedPaymentMethods' ELSE '[]'::jsonb END;
        v_worst := NULL; v_label := NULL;

        FOR i IN 0 .. GREATEST(jsonb_array_length(v_methods) - 1, -1) LOOP
            m := v_methods->i;
            IF jsonb_typeof(m) <> 'object' THEN CONTINUE; END IF;
            v_status := public.card_expiry_status(m, v_as_of, p_days);
            -- The DEFAULT card is the one autopay will charge, so it decides.
            -- A spare card expiring is not what stops collection.
            IF COALESCE((m->>'default')::boolean, false) OR jsonb_array_length(v_methods) = 1 THEN
                IF v_status IN ('expired', 'expiring') THEN
                    v_worst := v_status;
                    v_label := COALESCE(NULLIF(m->>'label', ''), 'Card on file');
                END IF;
            END IF;
        END LOOP;

        IF v_worst IS NULL THEN
            -- Nothing wrong: clear any stale flag rather than leaving a warning
            -- about a card that has since been replaced.
            IF v_fam ? 'cardExpiry' THEN
                v_fam := v_fam - 'cardExpiry';
                v_me := jsonb_set(v_me, ARRAY['families', famRec.key], v_fam, true);
                v_changed := true;
            END IF;
            CONTINUE;
        END IF;

        v_fam := jsonb_set(v_fam, '{cardExpiry}', jsonb_build_object(
            'status', v_worst, 'label', v_label,
            'checkedAt', to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')), true);
        v_me := jsonb_set(v_me, ARRAY['families', famRec.key], v_fam, true);
        v_changed := true;

        IF v_worst = 'expired' THEN v_expired := v_expired + 1;
        ELSE v_expiring := v_expiring + 1; END IF;
        v_report := v_report || jsonb_build_array(jsonb_build_object(
            'famKey', famRec.key, 'name', v_fam->>'name',
            'status', v_worst, 'label', v_label));

        INSERT INTO notifications (camp_id, source, source_id, title, body, link_target)
        VALUES (p_camp_id, 'card_expiry',
                -- Per card per MONTH: said once, and said again next month if
                -- nobody has done anything about it.
                famRec.key || ':' || v_worst || ':' || to_char(v_as_of, 'YYYY-MM'),
                CASE WHEN v_worst = 'expired'
                     THEN 'A card on autopay has expired'
                     ELSE 'A card on autopay expires soon' END,
                COALESCE(v_fam->>'name', famRec.key) || ' — ' || v_label
                  || CASE WHEN v_worst = 'expired'
                          THEN ' has expired, so their next instalment will be declined.'
                          ELSE ' expires within ' || p_days || ' days.' END
                  || ' Ask them to add a new card before the next instalment is due.',
                'campistry_me.html')
        ON CONFLICT (camp_id, source, source_id) DO NOTHING;
    END LOOP;

    IF v_changed THEN
        UPDATE camp_state_kv SET value = v_me, updated_at = now_ts
         WHERE camp_id = p_camp_id AND key = 'campistryMe';
    END IF;

    RETURN jsonb_build_object('success', true, 'asOf', v_as_of,
        'expired', v_expired, 'expiringSoon', v_expiring, 'detail', v_report);
END;
$$;
REVOKE ALL ON FUNCTION public.flag_expiring_cards(uuid, date, integer)
    FROM public, anon;
GRANT EXECUTE ON FUNCTION public.flag_expiring_cards(uuid, date, integer)
    TO authenticated, service_role;


-- ─── Checking it ───────────────────────────────────────────────────────────
-- The backoff and the escalation:
--   select flag_plan_collection('<camp>'::uuid,'<fam>','<plan>','declined','Do not honor');
--   -- attempts 1, nextRetryAt +3 days, escalated false
--   -- run it twice more: attempts 3, escalated TRUE, and a second notification
--   select count(*) from notifications
--    where camp_id='<camp>'::uuid and source='autopay_blocked';   -- 2
--   select flag_plan_collection('<camp>'::uuid,'<fam>','<plan>',NULL);
--   -- the block, the count and the schedule are all gone
--
-- A different reason starts its own count rather than inheriting one:
--   select flag_plan_collection('<camp>'::uuid,'<fam>','<plan>','no_card');
--   -- attempts 1, not escalated
--
-- Expiry:
--   select card_expiry_status('{"expMonth":"9","expYear":"2026"}'::jsonb,
--                             '2026-09-30'::date);   -- 'ok' (good all month)
--   select card_expiry_status('{"expMonth":"9","expYear":"2026"}'::jsonb,
--                             '2026-10-01'::date);   -- 'expired'
--   select card_expiry_status('{"last4":"4242"}'::jsonb, '2026-09-16'::date);
--   -- 'unknown' — a BYOP card, no expiry captured, deliberately not warned about
--   select flag_expiring_cards('<camp>'::uuid);
-- ============================================================================
