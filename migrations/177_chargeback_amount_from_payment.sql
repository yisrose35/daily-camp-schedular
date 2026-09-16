-- ============================================================================
-- Migration 177: a chargeback can be recorded without the processor telling us
-- how much it was.
--
-- WHY THIS CHANGED. 175 required an amount and refused with 'bad_amount'
-- otherwise, on the assumption that a dispute notification always carries one.
-- Cardknox's webhook field picker says otherwise: its Transaction Fields are
-- xCommand, xMaskedAccountNum, xAccountType, xCardLastFour, xExp, xCardType,
-- xAuthCode, xEntryMethod, xCurrency, xDigitalWalletType, xCashbackAmount,
-- xStatus, xResponseError, xResponseRefnum, xResponseBatch, xResponseAuthCode,
-- ... — and no xAmount anywhere in the list. Only xSubtotal/xTip/xTax/
-- xShipAmount under Order Details, which are order lines and not what was
-- actually captured.
--
-- So on that processor the notification may identify the transaction perfectly
-- while saying nothing about its value, and 175 would refuse the whole thing.
-- The camp would then be exactly where it started: money gone from the bank,
-- nothing in Campistry.
--
-- WHERE THE AMOUNT COMES FROM INSTEAD. The payment we already recorded. We are
-- matching the dispute to a specific payment anyway — that is how the family is
-- found — and that payment row carries the amount we actually took. Reading it
-- there is not a fallback so much as the better source: it is our own record of
-- what was captured, rather than a field whose meaning varies per processor.
--
-- p_amount still WINS when supplied, because a partial chargeback is real and
-- only the processor knows about it. This just stops "silent about the amount"
-- from meaning "not recorded".
--
-- STILL REFUSED, deliberately:
--   * no matching payment  -> family_not_found, as before. Never guess a family.
--   * matched, but we have no amount from either source -> 'amount_unknown'.
--     A $0 refund entry would say "we handled it" while moving nothing, which is
--     worse than a loud failure.
--
-- Replaces record_chargeback in place (same signature, so grants and callers are
-- untouched). Idempotent.
-- ============================================================================

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
    v_matched numeric := NULL;   -- what the matched payment says it was
    v_amount  numeric;           -- what we actually post
    p        jsonb;
    i        integer;
BEGIN
    IF p_camp_id IS NULL OR COALESCE(p_dispute_id, '') = ''
       OR p_refs IS NULL OR array_length(p_refs, 1) IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_arguments');
    END IF;
    -- NOTE: no amount check here any more. It cannot be made until we have
    -- found the payment, because the payment is one of the two places the
    -- amount can come from.

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

        -- Same match as 175, but keep the entry's own amount: this payment is
        -- what was disputed, so its value is the best answer we have when the
        -- processor did not send one.
        SELECT (e->>'amount')::numeric INTO v_matched
          FROM jsonb_array_elements(
                 CASE WHEN jsonb_typeof(famRec.value->'entries') = 'array'
                      THEN famRec.value->'entries' ELSE '[]'::jsonb END) e
         WHERE e->>'kind' = 'payment'
           AND (e->'source'->>'paymentId' = ANY(p_refs)
             OR e->>'id' = ANY(p_refs))
         LIMIT 1;
        IF FOUND THEN
            v_famKey := famRec.key;
            EXIT;
        END IF;
    END LOOP;

    -- Not in a ledger: fall back to finance.payments, which every processor
    -- webhook writes and which carries the processor's own reference.
    IF v_famKey IS NULL THEN
        SELECT e->>'familyKey', (e->>'amount')::numeric
          INTO v_famKey, v_matched
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

    -- What the processor said, else what we captured. A partial chargeback is
    -- real and only the processor knows about it, so a supplied amount wins.
    v_amount := CASE WHEN COALESCE(p_amount, 0) > 0
                     THEN p_amount ELSE COALESCE(v_matched, 0) END;
    IF NOT (v_amount > 0) THEN
        -- We know WHOSE payment was disputed but not for how much. Posting a $0
        -- refund would read as "handled" while moving nothing at all.
        RETURN jsonb_build_object('success', false, 'error', 'amount_unknown',
                                  'familyKey', v_famKey, 'refs', to_jsonb(p_refs));
    END IF;

    v_fam := v_me #> ARRAY['families', v_famKey];

    -- The refund entry. Balance goes back up; the original payment is untouched.
    v_fam := jsonb_set(v_fam, '{entries}',
        CASE WHEN jsonb_typeof(v_fam->'entries') = 'array'
             THEN v_fam->'entries' ELSE '[]'::jsonb END
        || jsonb_build_array(jsonb_build_object(
            'id', v_entryId,
            'kind', 'refund',
            'amount', ROUND(v_amount, 2),
            'reason', 'chargeback',
            'date', to_char(now_ts, 'YYYY-MM-DD'),
            'postedAt', to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'note', 'Chargeback' || COALESCE(' — ' || p_reason, ''),
            'by', 'system',
            -- amountSource records WHERE the figure came from. When a camp later
            -- asks why a chargeback reads $450, "the payment it disputed" and
            -- "the processor said so" are different answers.
            'source', jsonb_build_object('disputeId', p_dispute_id,
                                         'refs', to_jsonb(p_refs),
                                         'amountSource',
                                         CASE WHEN COALESCE(p_amount, 0) > 0
                                              THEN 'processor' ELSE 'matched_payment' END))), true);
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
            COALESCE(v_fam->>'name', v_famKey) || ' — $' || ROUND(v_amount, 2)
              || ' was pulled back by the bank'
              || COALESCE(' (' || p_reason || ')', '')
              || '. Their balance has gone back up by that amount.',
            'campistry_me.html')
    ON CONFLICT (camp_id, source, source_id) DO NOTHING;

    RETURN jsonb_build_object('success', true, 'familyKey', v_famKey,
        'entryId', v_entryId, 'paymentFlagged', v_hit,
        'amount', ROUND(v_amount, 2),
        'amountSource', CASE WHEN COALESCE(p_amount, 0) > 0
                             THEN 'processor' ELSE 'matched_payment' END,
        'balance', public.family_ledger_balance(v_fam));
END;
$$;
REVOKE ALL ON FUNCTION public.record_chargeback(uuid, text, text[], numeric, text, text)
    FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_chargeback(uuid, text, text[], numeric, text, text)
    TO service_role;

-- ─── Checking it ───────────────────────────────────────────────────────────
-- With an amount, unchanged from 175:
--   select record_chargeback('<camp>'::uuid,'d1',array['<a real payment ref>'],450);
--   -- success, amountSource "processor"
--
-- Without one, which is the case this migration exists for:
--   select record_chargeback('<camp>'::uuid,'d2',array['<a real payment ref>'],null);
--   -- success, amount = that payment's amount, amountSource "matched_payment"
--
-- And a reference that matches nothing is still refused rather than guessed:
--   select record_chargeback('<camp>'::uuid,'d3',array['nope'],null);
--   -- success:false, error "family_not_found"
-- ============================================================================
