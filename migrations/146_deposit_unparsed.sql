-- =============================================================================
-- 146 — never lose a deposit email we could not read
--
-- WHY
--
-- 145 stored only raw_subject, and the edge function DROPPED any message the
-- parser did not understand -- it answered 200, wrote nothing, and left a log
-- line that ages out in days. For a known bank that is fine: most mail
-- reaching the address really is marketing. For a bank we have never seen, it
-- means a real deposit disappears with no record anywhere, and nobody finds
-- out until a family says they paid.
--
-- That is the one failure this feature cannot have. Parsing is best-effort by
-- nature -- there are thousands of banks and they reword alerts whenever they
-- like -- so the system has to degrade to "a human sees it", never to silence.
--
-- WHAT
--
--   raw_excerpt   the first ~4k of the message, so the office can read what
--                 actually arrived and fix the payer by hand, and so a new
--                 bank's wording becomes visible instead of invisible.
--   parse_reason  why the parser gave up, in its own words.
--   status        gains 'unparsed': recorded, never counted, always shown.
--
-- An unparsed row has no amount yet, so the positive-amount check is relaxed
-- for that status only. Everything else keeps its guarantees: 'posted' still
-- requires a family, and the fingerprint is still unique per camp.
--
-- Idempotent -- safe to re-run. Run this AFTER 145 (and 145a).
-- =============================================================================

ALTER TABLE bank_deposits ADD COLUMN IF NOT EXISTS raw_excerpt  text NOT NULL DEFAULT '';
ALTER TABLE bank_deposits ADD COLUMN IF NOT EXISTS parse_reason text NOT NULL DEFAULT '';

ALTER TABLE bank_deposits DROP CONSTRAINT IF EXISTS bank_deposits_status_check;
ALTER TABLE bank_deposits ADD CONSTRAINT bank_deposits_status_check
    CHECK (status IN ('posted', 'review', 'unmatched', 'ignored', 'unparsed'));

-- Relaxed for 'unparsed' only: we could not read an amount, which is precisely
-- why a human has to look at it.
ALTER TABLE bank_deposits DROP CONSTRAINT IF EXISTS bank_deposits_amount_positive;
ALTER TABLE bank_deposits ADD CONSTRAINT bank_deposits_amount_positive
    CHECK (amount_cents > 0 OR status = 'unparsed');

-- The write path for a message the parser could not read. Service role only,
-- exactly like _deposit_record: a client that could call this could invent
-- tuition payments.
CREATE OR REPLACE FUNCTION public._deposit_record_unparsed(
    p_camp_id     uuid,
    p_fingerprint text,
    p_raw_subject text,
    p_raw_excerpt text,
    p_reason      text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_id  uuid;
    v_dup boolean := false;
BEGIN
    INSERT INTO bank_deposits (
        camp_id, fingerprint, amount_cents, status,
        raw_subject, raw_excerpt, parse_reason, source
    )
    VALUES (
        p_camp_id, p_fingerprint, 0, 'unparsed',
        COALESCE(LEFT(p_raw_subject, 200), ''),
        COALESCE(LEFT(p_raw_excerpt, 4000), ''),
        COALESCE(LEFT(p_reason, 80), ''),
        'email'
    )
    ON CONFLICT (camp_id, fingerprint) DO NOTHING
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
        v_dup := true;
        SELECT id INTO v_id FROM bank_deposits
         WHERE camp_id = p_camp_id AND fingerprint = p_fingerprint;
    END IF;

    RETURN jsonb_build_object('success', true, 'id', v_id, 'duplicate', v_dup);
END;
$$;

REVOKE ALL ON FUNCTION public._deposit_record_unparsed(uuid, text, text, text, text) FROM PUBLIC;

-- get_bank_deposits must return the two new columns, or the inbox cannot show
-- an unparsed row's text and the whole point of storing it is lost.
CREATE OR REPLACE FUNCTION public.get_bank_deposits(
    p_camp_id uuid,
    p_status  text DEFAULT NULL,
    p_limit   integer DEFAULT 200
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_out jsonb;
BEGIN
    IF NOT _deposit_can_admin(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    SELECT COALESCE(jsonb_agg(row_to_json(d)::jsonb ORDER BY d.deposit_date DESC NULLS LAST, d.created_at DESC), '[]'::jsonb)
      INTO v_out
      FROM (
        SELECT id, fingerprint, amount_cents, is_reversal, deposit_date,
               payer_name, payer_handle, memo, memo_code, kind, trace_id,
               bank, source, raw_subject, raw_excerpt, parse_reason,
               status, family_key, match_confidence,
               match_reasons, candidates, guardrail, matched_by,
               resolved_by, resolved_at, created_at
          FROM bank_deposits
         WHERE camp_id = p_camp_id
           AND (p_status IS NULL OR status = p_status)
         ORDER BY deposit_date DESC NULLS LAST, created_at DESC
         LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 200), 1000))
      ) d;

    RETURN jsonb_build_object('success', true, 'deposits', v_out);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_bank_deposits(uuid, text, integer) TO authenticated;

-- _deposit_record keeps the message text on deposits that DID parse, too.
-- A payer name read off unfamiliar prose can be wrong in ways only a human
-- looking at the original can see; without the text there is nothing to check
-- it against. Same signature, so no caller changes -- it just reads one more
-- key out of the deposit payload.
CREATE OR REPLACE FUNCTION public._deposit_record(
    p_camp_id      uuid,
    p_fingerprint  text,
    p_amount_cents integer,
    p_deposit      jsonb,
    p_decision     jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_id       uuid;
    v_status   text := COALESCE(p_decision->>'decision', 'unmatched');
    v_family   text := NULLIF(p_decision->>'familyKey', '');
    v_dup      boolean := false;
BEGIN
    IF v_status = 'auto' THEN v_status := 'posted'; END IF;
    IF v_status NOT IN ('posted', 'review', 'unmatched', 'ignored') THEN
        v_status := 'unmatched';
    END IF;
    IF v_status = 'posted' AND v_family IS NULL THEN
        v_status := 'review';
    END IF;

    INSERT INTO bank_deposits (
        camp_id, fingerprint, amount_cents, is_reversal, deposit_date,
        payer_name, payer_handle, memo, memo_code, kind, trace_id, bank,
        source, raw_subject, raw_excerpt, status, family_key, match_confidence,
        match_reasons, candidates, guardrail, matched_by, resolved_at
    ) VALUES (
        p_camp_id,
        p_fingerprint,
        abs(p_amount_cents),
        COALESCE((p_deposit->>'isReversal')::boolean, false),
        NULLIF(p_deposit->>'date', '')::date,
        COALESCE(p_deposit->>'payerName', ''),
        COALESCE(p_deposit->>'payerHandle', ''),
        COALESCE(p_deposit->>'memo', ''),
        COALESCE(p_deposit->>'memoCode', ''),
        COALESCE(NULLIF(p_deposit->>'kind', ''), 'ach'),
        COALESCE(p_deposit->>'traceId', ''),
        COALESCE(p_deposit->>'bank', ''),
        COALESCE(NULLIF(p_deposit->>'source', ''), 'email'),
        COALESCE(p_deposit->>'rawSubject', ''),
        COALESCE(LEFT(p_deposit->>'rawExcerpt', 4000), ''),
        v_status,
        v_family,
        COALESCE((p_decision->>'confidence')::integer, 0),
        COALESCE(p_decision->'reasons', '[]'::jsonb),
        COALESCE(p_decision->'candidates', '[]'::jsonb),
        COALESCE(p_decision->>'guardrail', ''),
        'auto',
        CASE WHEN v_status = 'posted' THEN now() ELSE NULL END
    )
    ON CONFLICT (camp_id, fingerprint) DO NOTHING
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
        v_dup := true;
        SELECT id INTO v_id FROM bank_deposits
         WHERE camp_id = p_camp_id AND fingerprint = p_fingerprint;
    END IF;

    RETURN jsonb_build_object('success', true, 'id', v_id,
                              'duplicate', v_dup, 'status', v_status);
END;
$$;

REVOKE ALL ON FUNCTION public._deposit_record(uuid, text, integer, jsonb, jsonb) FROM public, anon, authenticated;

NOTIFY pgrst, 'reload schema';
