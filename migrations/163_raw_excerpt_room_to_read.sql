-- =============================================================================
-- 163 — keep enough of the message to be worth reading
--
-- raw_excerpt was capped at 4,000 characters, in the edge function and again
-- here. That was sized for "an excerpt", and it is too small for what actually
-- arrives: a bank alert sent as HTML, converted to text, carried inside a
-- forward with the original quoted underneath, runs past 4k on legal footers
-- and unsubscribe blocks alone.
--
-- Two things broke on that, and neither announced itself:
--
--   * "Read the email" showed a message that stopped mid-sentence, with no
--     indication that anything had been cut.
--   * "Read again" re-runs the parser over the STORED text. A memo sitting
--     past the 4,000th character was not merely hidden -- it was not there to
--     find, so re-reading could never recover it however good the parser got.
--
-- 32,000 is generous for any alert a bank sends and still bounded. The column
-- is plain text with no length constraint, so only these two LEFT() calls and
-- the matching slices in the edge function change. Nothing is migrated: rows
-- already truncated stay as they are, because the text they lost is gone.
--
-- Idempotent -- safe to re-run. Run AFTER 146, and redeploy deposit-inbox too,
-- or the edge function keeps slicing to 4,000 before this ever sees it.
-- =============================================================================

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
        COALESCE(LEFT(p_raw_excerpt, 32000), ''),
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
        COALESCE(LEFT(p_deposit->>'rawExcerpt', 32000), ''),
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

NOTIFY pgrst, 'reload schema';
