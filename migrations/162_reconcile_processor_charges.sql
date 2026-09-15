-- =============================================================================
-- 162 — find card charges the ledger has lost
--
-- WHY THIS EXISTS
--
-- campistryMe is a single camp_state_kv row that the browser rewrites WHOLE on
-- every save, from state it read at page load — and it is not the only writer.
-- charge-due-installments appends finance.payments and marks an installment
-- paid; the Stripe, Cardknox, BYOP and hosted-checkout handlers write the
-- card-on-file fields. A tab left open across an autopay run therefore wrote
-- back a blob that predated the charge: the payment vanished, the family owed
-- it again, and the installment reverted to 'pending' so the card was charged a
-- second time the following night.
--
-- campistry_finance_merge.js closes that window going forward. It cannot undo
-- what was already lost — the money left the card and Campistry has no record
-- of it — and a camp cannot be asked to diff a JSON blob against a processor
-- dashboard by hand.
--
-- So this reports it. For every succeeded charge in processor_transactions, it
-- looks for a payment in the camp's ledger that refers to it, and returns the
-- ones with nothing pointing at them.
--
-- READ-ONLY, ON PURPOSE
--
-- It writes nothing. processor_transactions carries no family_key, and the
-- Stripe autopay path does not record into it at all, so this cannot reliably
-- say WHOSE payment a gap is — only that one exists. Guessing an attribution
-- would credit the wrong household, which is the one outcome worse than a
-- missing payment. Where the processor's own metadata names a family, that is
-- passed through as a suggestion for a person to confirm.
--
-- Idempotent — safe to re-run. Requires 126 (processor_transactions) and 145
-- (_deposit_can_admin).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.reconcile_processor_charges(
    p_camp_id uuid,
    p_since   date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_me       jsonb;
    v_refs     text[];
    v_missing  jsonb;
    v_charged  bigint := 0;
    v_recorded bigint := 0;
BEGIN
    IF NOT _deposit_can_admin(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    SELECT value INTO v_me
      FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe';

    -- Every string a payment could use to name its processor charge. The
    -- shapes differ by rail and by era: `reference` is what the office sees,
    -- the intent/transaction ids are what the webhooks write, and the autopay
    -- cron builds its row id out of the charge id ("auto_pi_123"). A charge is
    -- accounted for if ANY payment mentions it in ANY of them.
    SELECT COALESCE(array_agg(DISTINCT t), '{}')
      INTO v_refs
      FROM (
        SELECT jsonb_array_elements(COALESCE(v_me->'finance'->'payments', '[]'::jsonb)) AS p
      ) s,
      LATERAL (VALUES
        (s.p->>'reference'),
        (s.p->>'stripePaymentIntentId'),
        (s.p->>'byopTransactionId'),
        (s.p->>'id')
      ) AS v(t)
     WHERE t IS NOT NULL AND t <> '';

    SELECT COALESCE(jsonb_agg(row_to_json(g)::jsonb ORDER BY g.created_at DESC), '[]'::jsonb),
           count(*)
      INTO v_missing, v_recorded
      FROM (
        SELECT pt.external_transaction_id,
               pt.processor_key,
               pt.amount_cents,
               pt.created_at,
               -- The autopay cron passes the family through as processor
               -- metadata. Present for some rails and eras and absent for
               -- others, so it is a suggestion to confirm, never an answer.
               COALESCE(pt.raw_response #>> '{metadata,familyKey}',
                        pt.raw_response #>> '{metadata,family_key}', '') AS suggested_family_key,
               COALESCE(pt.raw_response #>> '{metadata,familyName}',
                        pt.raw_response #>> '{metadata,family_name}', '') AS suggested_family_name
          FROM processor_transactions pt
         WHERE pt.camp_id = p_camp_id
           AND pt.kind = 'charge'
           AND lower(pt.status) IN ('succeeded', 'success', 'approved', 'captured', 'settled')
           AND (p_since IS NULL OR pt.created_at::date >= p_since)
           -- Matched loosely on purpose: a payment id of "auto_pi_123" names
           -- charge "pi_123" without equalling it.
           AND NOT EXISTS (
               SELECT 1 FROM unnest(v_refs) AS r
                WHERE r = pt.external_transaction_id
                   OR r LIKE '%' || pt.external_transaction_id
           )
      ) g;

    SELECT count(*) INTO v_charged
      FROM processor_transactions pt
     WHERE pt.camp_id = p_camp_id
       AND pt.kind = 'charge'
       AND lower(pt.status) IN ('succeeded', 'success', 'approved', 'captured', 'settled')
       AND (p_since IS NULL OR pt.created_at::date >= p_since);

    RETURN jsonb_build_object(
        'success', true,
        'charges', v_charged,
        'missing', v_missing,
        'missingCount', v_recorded,
        'missingCents', COALESCE((
            SELECT sum((m->>'amount_cents')::bigint) FROM jsonb_array_elements(v_missing) m
        ), 0),
        -- Said plainly so nobody reads a clean result as proof of a clean
        -- ledger: this table only ever held the non-Stripe rails, and the
        -- Stripe autopay path never wrote to it at all.
        'covers', 'Charges recorded in processor_transactions only. Stripe autopay charges are not recorded there, so a clean result here does not rule out a gap on Stripe — check the Stripe dashboard for the same dates.'
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.reconcile_processor_charges(uuid, date) TO authenticated;

NOTIFY pgrst, 'reload schema';
