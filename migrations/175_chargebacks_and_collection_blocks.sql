-- ============================================================================
-- Migration 175: a chargeback moves the money back, and a plan that cannot
-- collect says so.
--
-- Both halves are the same defect wearing different clothes: money stopped
-- moving, or moved backwards, and NOTHING IN THE APP SAID SO.
--
-- ── 1. THE CHARGEBACK (the serious one) ────────────────────────────────────
-- stripe-webhook already handled charge.dispute.created — by emailing
-- RISK_ALERT_EMAIL, which is the PLATFORM's address, not the camp's. It did
-- nothing to the family's ledger and nothing to finance.payments. So after a
-- chargeback:
--
--   * Stripe pulls the money back out of the camp's account.
--   * Campistry still shows the payment as 'succeeded'.
--   * The family's balance still says they paid.
--
-- The camp's books overstate collected cash and the family's balance is simply
-- wrong, with no camp-level signal at all.
--
-- In accounting terms a chargeback is a REVERSAL OF CASH RECEIVED, which is
-- exactly what the posted ledger models. So: post a `refund` entry. The balance
-- goes back up because the ledger got longer, and the original payment entry
-- stays untouched — a year later the office can still see the payment, the
-- chargeback, and the date of each. Nothing is edited or deleted.
--
-- The entry's REASON is 'chargeback' rather than 'card', deliberately: a refund
-- the camp chose to give and cash a bank pulled back have the same effect on a
-- balance and are completely different things in a report. One is a decision,
-- the other is a loss.
--
-- If the camp WINS the dispute, resolve_chargeback posts the payment back. Same
-- rule — another entry, never an edit.
--
-- ── 2. THE PLAN THAT CANNOT COLLECT ────────────────────────────────────────
-- Two ways autopay silently stops:
--
--   NO CARD. A parent removing their last saved card clears cardOnFile and the
--     tokens, but nothing touches plans[].autopay — so the plan still displays
--     as active. The nightly runner skips the whole family before it reaches the
--     plan loop, which means the instalment counter never advances either: the
--     plan does not even run out, it stalls forever on the same instalment. The
--     only trace is a console.warn in an edge function.
--
--   DECLINED. Recorded honestly in the plan history with the reason, and the
--     counter advances so one bad card cannot stall the plan for ever. But
--     nobody is told — no notification to the office, none to the parent.
--
-- flag_plan_collection writes a `collectionBlocked` object onto the plan, which
-- both the office's Billing page and the parent's portal already receive (
-- get_my_balance returns plans), and raises ONE notification per plan per reason
-- rather than one a night. Clearing it is the same call with a null reason, so a
-- successful charge or a newly saved card closes it automatically.
--
-- Idempotent.
-- ============================================================================

-- ─── 1. record a chargeback ────────────────────────────────────────────────
-- p_refs is every identifier Stripe gives us for the disputed money — the charge
-- id AND the payment_intent id — because a payment row may carry either
-- depending on which path recorded it. Matching on a set rather than one field
-- is what stops a dispute failing to find its own payment.
CREATE OR REPLACE FUNCTION public.record_chargeback(
    p_camp_id    uuid,
    p_dispute_id text,
    p_refs       text[],
    p_amount     numeric,
    p_reason     text DEFAULT NULL,
    p_status     text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    now_ts   timestamptz := now();
    v_me     jsonb;
    v_fams   jsonb;
    famRec   record;
    v_fam    jsonb;
    v_famKey text := NULL;
    v_pays   jsonb;
    v_newP   jsonb;
    v_hit    boolean := false;
    v_entryId text;
    p        jsonb;
    i        integer;
BEGIN
    IF p_camp_id IS NULL OR COALESCE(p_dispute_id, '') = ''
       OR p_refs IS NULL OR array_length(p_refs, 1) IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_arguments');
    END IF;
    IF NOT (COALESCE(p_amount, 0) > 0) THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_amount');
    END IF;

    SELECT value INTO v_me FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe'
     FOR UPDATE;
    IF v_me IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_camp_data');
    END IF;

    v_entryId := 'le_cb_' || p_dispute_id;

    -- Find the family whose ledger or payment list carries this money. The
    -- ledger is checked first because that is the authoritative record.
    v_fams := COALESCE(v_me->'families', '{}'::jsonb);
    FOR famRec IN SELECT key, value FROM jsonb_each(v_fams) LOOP
        IF jsonb_typeof(famRec.value) <> 'object' THEN CONTINUE; END IF;

        -- Already recorded? Idempotent on the dispute id, so a redelivered
        -- webhook cannot reverse the same money twice.
        IF EXISTS (
            SELECT 1 FROM jsonb_array_elements(
                     CASE WHEN jsonb_typeof(famRec.value->'entries') = 'array'
                          THEN famRec.value->'entries' ELSE '[]'::jsonb END) e
             WHERE e->>'id' = v_entryId
        ) THEN
            RETURN jsonb_build_object('success', true, 'alreadyRecorded', true,
                                      'familyKey', famRec.key);
        END IF;

        IF EXISTS (
            SELECT 1 FROM jsonb_array_elements(
                     CASE WHEN jsonb_typeof(famRec.value->'entries') = 'array'
                          THEN famRec.value->'entries' ELSE '[]'::jsonb END) e
             WHERE e->>'kind' = 'payment'
               AND (e->'source'->>'paymentId' = ANY(p_refs)
                 OR e->>'id' = ANY(p_refs))
        ) THEN
            v_famKey := famRec.key;
            EXIT;
        END IF;
    END LOOP;

    -- Not in a ledger: fall back to finance.payments, which every processor
    -- webhook writes and which carries the processor's own reference.
    IF v_famKey IS NULL THEN
        SELECT e->>'familyKey' INTO v_famKey
          FROM jsonb_array_elements(
                 COALESCE(v_me->'finance'->'payments', '[]'::jsonb)) e
         WHERE COALESCE(e->>'familyKey', '') <> ''
           AND (e->>'stripePaymentIntentId' = ANY(p_refs)
             OR e->>'reference' = ANY(p_refs)
             OR e->>'byopTransactionId' = ANY(p_refs)
             OR e->>'id' = ANY(p_refs))
         LIMIT 1;
    END IF;

    IF v_famKey IS NULL OR v_me #> ARRAY['families', v_famKey] IS NULL THEN
        -- Do NOT guess. A chargeback posted against the wrong family is worse
        -- than one posted against none: the caller logs this loudly and a human
        -- reconciles it by hand.
        RETURN jsonb_build_object('success', false, 'error', 'family_not_found',
                                  'refs', to_jsonb(p_refs));
    END IF;

    v_fam := v_me #> ARRAY['families', v_famKey];

    -- The refund entry. Balance goes back up; the original payment is untouched.
    v_fam := jsonb_set(v_fam, '{entries}',
        CASE WHEN jsonb_typeof(v_fam->'entries') = 'array'
             THEN v_fam->'entries' ELSE '[]'::jsonb END
        || jsonb_build_array(jsonb_build_object(
            'id', v_entryId,
            'kind', 'refund',
            'amount', ROUND(p_amount, 2),
            'reason', 'chargeback',
            'date', to_char(now_ts, 'YYYY-MM-DD'),
            'postedAt', to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'note', 'Chargeback' || COALESCE(' — ' || p_reason, ''),
            'by', 'system',
            'source', jsonb_build_object('disputeId', p_dispute_id,
                                         'refs', to_jsonb(p_refs)))), true);
    v_me := jsonb_set(v_me, ARRAY['families', v_famKey], v_fam, true);

    -- Flag the payment row so Billing shows WHY it no longer counts. This is a
    -- display annotation on a receipt, not the balance — the balance moved via
    -- the entry above.
    v_pays := COALESCE(v_me->'finance'->'payments', '[]'::jsonb);
    IF jsonb_typeof(v_pays) = 'array' THEN
        v_newP := '[]'::jsonb;
        FOR i IN 0 .. GREATEST(jsonb_array_length(v_pays) - 1, -1) LOOP
            p := v_pays->i;
            IF NOT v_hit AND (p->>'stripePaymentIntentId' = ANY(p_refs)
                           OR p->>'reference' = ANY(p_refs)
                           OR p->>'byopTransactionId' = ANY(p_refs)
                           OR p->>'id' = ANY(p_refs)) THEN
                p := p || jsonb_build_object('disputed', true,
                        'disputeId', p_dispute_id,
                        'disputeStatus', COALESCE(p_status, 'open'),
                        'disputeReason', p_reason);
                v_hit := true;
            END IF;
            v_newP := v_newP || jsonb_build_array(p);
        END LOOP;
        v_me := jsonb_set(v_me, ARRAY['finance', 'payments'], v_newP, true);
    END IF;

    UPDATE camp_state_kv SET value = v_me, updated_at = now_ts
     WHERE camp_id = p_camp_id AND key = 'campistryMe';

    -- Tell the CAMP. The existing platform email goes to the platform; an owner
    -- needs to know a parent's money was pulled back out of their account.
    INSERT INTO notifications (camp_id, source, source_id, title, body, link_target)
    VALUES (p_camp_id, 'chargeback', p_dispute_id,
            'A payment was charged back',
            COALESCE(v_fam->>'name', v_famKey) || ' — $' || ROUND(p_amount, 2)
              || ' was pulled back by the bank'
              || COALESCE(' (' || p_reason || ')', '')
              || '. Their balance has gone back up by that amount.',
            'campistry_me.html')
    ON CONFLICT (camp_id, source, source_id) DO NOTHING;

    RETURN jsonb_build_object('success', true, 'familyKey', v_famKey,
        'entryId', v_entryId, 'paymentFlagged', v_hit,
        'balance', public.family_ledger_balance(v_fam));
END;
$$;
REVOKE ALL ON FUNCTION public.record_chargeback(uuid, text, text[], numeric, text, text)
    FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_chargeback(uuid, text, text[], numeric, text, text)
    TO service_role;


-- ─── 2. the camp won (or lost) the dispute ──────────────────────────────────
-- Won: the money comes back, so post the payment again. Lost: nothing to do —
-- the refund already stands, and recording the loss twice would double it.
CREATE OR REPLACE FUNCTION public.resolve_chargeback(
    p_camp_id    uuid,
    p_dispute_id text,
    p_won        boolean,
    p_status     text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    now_ts    timestamptz := now();
    v_me      jsonb;
    famRec    record;
    v_fam     jsonb;
    v_famKey  text := NULL;
    v_cb      jsonb := NULL;
    v_winId   text;
BEGIN
    IF p_camp_id IS NULL OR COALESCE(p_dispute_id, '') = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_arguments');
    END IF;

    SELECT value INTO v_me FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe'
     FOR UPDATE;
    IF v_me IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_camp_data');
    END IF;

    v_winId := 'le_cbwon_' || p_dispute_id;

    FOR famRec IN SELECT key, value FROM jsonb_each(
                      COALESCE(v_me->'families', '{}'::jsonb)) LOOP
        IF jsonb_typeof(famRec.value) <> 'object' THEN CONTINUE; END IF;
        SELECT e INTO v_cb
          FROM jsonb_array_elements(
                 CASE WHEN jsonb_typeof(famRec.value->'entries') = 'array'
                      THEN famRec.value->'entries' ELSE '[]'::jsonb END) e
         WHERE e->>'id' = 'le_cb_' || p_dispute_id
         LIMIT 1;
        IF v_cb IS NOT NULL THEN v_famKey := famRec.key; EXIT; END IF;
    END LOOP;

    IF v_famKey IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'chargeback_not_found');
    END IF;
    v_fam := v_me #> ARRAY['families', v_famKey];

    IF NOT COALESCE(p_won, false) THEN
        -- Lost: the refund already reflects it. Nothing to post.
        RETURN jsonb_build_object('success', true, 'familyKey', v_famKey,
                                  'posted', false, 'outcome', 'lost');
    END IF;

    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_fam->'entries') e
                WHERE e->>'id' = v_winId) THEN
        RETURN jsonb_build_object('success', true, 'alreadyRecorded', true,
                                  'familyKey', v_famKey);
    END IF;

    v_fam := jsonb_set(v_fam, '{entries}', v_fam->'entries' ||
        jsonb_build_array(jsonb_build_object(
            'id', v_winId,
            'kind', 'payment',
            'amount', v_cb->'amount',
            'reason', 'chargeback',
            'date', to_char(now_ts, 'YYYY-MM-DD'),
            'postedAt', to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'note', 'Chargeback reversed — the camp won the dispute',
            'by', 'system',
            'source', jsonb_build_object('disputeId', p_dispute_id,
                                         'reverses', v_cb->>'id'))), true);
    v_me := jsonb_set(v_me, ARRAY['families', v_famKey], v_fam, true);

    UPDATE camp_state_kv SET value = v_me, updated_at = now_ts
     WHERE camp_id = p_camp_id AND key = 'campistryMe';

    RETURN jsonb_build_object('success', true, 'familyKey', v_famKey,
        'posted', true, 'outcome', 'won',
        'balance', public.family_ledger_balance(v_fam));
END;
$$;
REVOKE ALL ON FUNCTION public.resolve_chargeback(uuid, text, boolean, text)
    FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_chargeback(uuid, text, boolean, text)
    TO service_role;


-- ─── 3. a plan that cannot collect ──────────────────────────────────────────
-- p_reason NULL clears the block, so a successful charge or a newly saved card
-- closes it with the same call the runner already makes.
--
-- The notification is raised ONCE per plan per reason, not once a night: the
-- source_id is deterministic and the insert is ON CONFLICT DO NOTHING. A nightly
-- alert for the same stuck plan is how an office learns to ignore alerts.
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
    v_had := (v_plan ? 'collectionBlocked');

    IF COALESCE(p_reason, '') = '' THEN
        IF NOT v_had THEN
            RETURN jsonb_build_object('success', true, 'changed', false);
        END IF;
        v_plan := v_plan - 'collectionBlocked';
    ELSE
        -- Keep the ORIGINAL `since` when the reason has not changed, so the
        -- office can see how long a plan has been stuck rather than a date that
        -- resets every night.
        v_plan := jsonb_set(v_plan, '{collectionBlocked}', jsonb_build_object(
            'reason', p_reason,
            'detail', p_detail,
            'since', CASE WHEN v_had AND v_plan->'collectionBlocked'->>'reason' = p_reason
                          THEN v_plan->'collectionBlocked'->>'since'
                          ELSE to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') END
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
    END IF;

    RETURN jsonb_build_object('success', true, 'changed', true,
                              'blocked', COALESCE(p_reason, '') <> '');
END;
$$;
REVOKE ALL ON FUNCTION public.flag_plan_collection(uuid, text, text, text, text)
    FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.flag_plan_collection(uuid, text, text, text, text)
    TO service_role;


-- ─── Checking it ───────────────────────────────────────────────────────────
-- A chargeback must RAISE the balance and leave the payment on the record:
--   select family_ledger_balance(value #> '{families,<famKey>}')
--     from camp_state_kv where camp_id='<camp>'::uuid and key='campistryMe';
--   select record_chargeback('<camp>'::uuid, 'dp_test',
--       ARRAY['pi_xxx','ch_xxx'], 250, 'fraudulent', 'needs_response');
--   -- balance is 250 HIGHER, the payment row carries disputed:true, and a
--   -- notification appears. Running it again returns alreadyRecorded.
--
-- Winning it puts the money back:
--   select resolve_chargeback('<camp>'::uuid, 'dp_test', true, 'won');
--   -- balance returns to where it started; BOTH entries remain on the ledger.
--
-- A blocked plan raises one notification, not one a night:
--   select flag_plan_collection('<camp>'::uuid, '<famKey>', '<planId>', 'no_card');
--   select flag_plan_collection('<camp>'::uuid, '<famKey>', '<planId>', 'no_card');
--   select count(*) from notifications
--    where camp_id='<camp>'::uuid and source='autopay_blocked';   -- 1
--   select flag_plan_collection('<camp>'::uuid, '<famKey>', '<planId>', NULL);
--   -- the plan no longer carries collectionBlocked
-- ============================================================================
