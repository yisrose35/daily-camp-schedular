-- =============================================================================
-- 151 — read a stored deposit again, without resending the email
--
-- Every deposit keeps the message it came from (raw_excerpt, migration 146),
-- so there is no reason to forward mail again to find out whether a change
-- helped. The browser re-runs the parser, the camp's learned template and the
-- matcher over the stored text and writes the result back here.
--
-- This is the same work the edge function does on arrival, so it takes the
-- same shape: parsed fields in, a decision in, the row updated. The difference
-- is who is asking — a signed-in admin rather than a webhook — so this one is
-- admin-gated and _deposit_record is not.
--
-- WHAT IT WILL NOT DO
--
-- A deposit already POSTED to a family is left alone. Re-reading is for
-- working out why something was not understood; silently moving money that an
-- office has already reconciled, because a template changed, is not a
-- debugging tool. Unmatch it first if that is really the intent.
--
-- The fingerprint is deliberately NOT recomputed. It is the row's identity and
-- the whole duplicate defence; changing it on a row that already exists could
-- collide with another row or orphan this one.
--
-- Idempotent -- safe to re-run. Run AFTER 146.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.reparse_bank_deposit(
    p_camp_id    uuid,
    p_deposit_id uuid,
    p_deposit    jsonb,
    p_decision   jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_dep      bank_deposits;
    v_status   text := COALESCE(p_decision->>'decision', 'unmatched');
    v_family   text := NULLIF(p_decision->>'familyKey', '');
    v_amount   integer;
BEGIN
    IF NOT _deposit_can_admin(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    SELECT * INTO v_dep FROM bank_deposits
     WHERE id = p_deposit_id AND camp_id = p_camp_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_found');
    END IF;

    IF v_dep.status = 'posted' THEN
        RETURN jsonb_build_object('success', false, 'error', 'already_posted');
    END IF;

    IF v_status = 'auto' THEN v_status := 'posted'; END IF;
    IF v_status NOT IN ('posted', 'review', 'unmatched', 'ignored') THEN
        v_status := 'unmatched';
    END IF;
    IF v_status = 'posted' AND v_family IS NULL THEN
        v_status := 'review';
    END IF;

    -- A re-read that finds no amount must not wipe one the row already has:
    -- the deposit is real either way, and zeroing it would hide money.
    v_amount := COALESCE(NULLIF((p_deposit->>'amountCents'), '')::integer, v_dep.amount_cents);
    IF v_amount IS NULL OR v_amount <= 0 THEN v_amount := v_dep.amount_cents; END IF;

    UPDATE bank_deposits SET
        amount_cents     = v_amount,
        is_reversal      = COALESCE((p_deposit->>'isReversal')::boolean, is_reversal),
        deposit_date     = COALESCE(NULLIF(p_deposit->>'date', '')::date, deposit_date),
        payer_name       = COALESCE(NULLIF(p_deposit->>'payerName', ''), payer_name),
        payer_handle     = COALESCE(NULLIF(p_deposit->>'payerHandle', ''), payer_handle),
        memo             = COALESCE(NULLIF(p_deposit->>'memo', ''), memo),
        memo_code        = COALESCE(NULLIF(p_deposit->>'memoCode', ''), memo_code),
        kind             = COALESCE(NULLIF(p_deposit->>'kind', ''), kind),
        trace_id         = COALESCE(NULLIF(p_deposit->>'traceId', ''), trace_id),
        bank             = COALESCE(NULLIF(p_deposit->>'bank', ''), bank),
        parse_reason     = '',
        status           = v_status,
        family_key       = v_family,
        match_confidence = COALESCE((p_decision->>'confidence')::integer, 0),
        match_reasons    = COALESCE(p_decision->'reasons', '[]'::jsonb),
        candidates       = COALESCE(p_decision->'candidates', '[]'::jsonb),
        guardrail        = COALESCE(p_decision->>'guardrail', ''),
        matched_by       = 'auto',
        resolved_at      = CASE WHEN v_status = 'posted' THEN now() ELSE NULL END,
        updated_at       = now()
     WHERE id = p_deposit_id;

    RETURN jsonb_build_object('success', true, 'status', v_status, 'familyKey', v_family);
END;
$$;

GRANT EXECUTE ON FUNCTION public.reparse_bank_deposit(uuid, uuid, jsonb, jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';
