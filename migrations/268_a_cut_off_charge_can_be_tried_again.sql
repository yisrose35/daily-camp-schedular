-- ============================================================================
-- Migration 268: a card charge that was cut off can be tried again — safely.
--
-- Standalone. Paste into the Supabase SQL Editor and click Run. Safe to run
-- more than once. Run it BEFORE redeploying registration-deposit-checkout.
--
-- ── THE PROBLEM (TED-083, TED-085, TED-086) ────────────────────────────────
-- 1. The registration deposit takes a claim (198's refund_intents) before it
--    charges, so an office click and a parent's retry cannot both charge. If
--    the connection to the processor dropped mid-charge, the claim was never
--    given back and never expired, and a claim somebody else held was answered
--    "already paid". The parent was told "This deposit is already paid" for
--    ever while nothing had been charged.
-- 2. After a decline, a retry sent Stripe the same Idempotency-Key, and Stripe
--    replays a key's first answer — the decline — for 24 hours.
-- 3. processor_transactions only accepted kind 'charge' / 'refund', so the
--    card-charged registration deposits (and card checks) were never recorded.
--
-- ── THE CHANGE ─────────────────────────────────────────────────────────────
-- Charge claims (same table, new columns) know three more things:
--   * called_at — when the processor was actually asked. A claim abandoned
--     BEFORE that (the function died first) surely moved no money, so after
--     10 minutes the next try simply takes it over.
--   * released_at — a claim given back after a decline (or an error before
--     the processor was reached) is reopened, not deleted, so it keeps…
--   * attempt — bumped on every decline. It goes into the Stripe
--     Idempotency-Key, so a retry after a decline is a new request, while a
--     retry after a dropped connection is the SAME request (Stripe then tells
--     us what really happened instead of charging again).
-- claim_charge_intent answers one of: claimed (go ahead, with the attempt
-- number) · settled (really paid) · in_progress (someone is charging right
-- now) · stale (the processor was asked, never answered, 10+ minutes ago —
-- whether money moved is unknown; the caller decides: Stripe re-asks with the
-- same key, the office may confirm nothing went through).
-- 198's refund functions are untouched.
-- ============================================================================

ALTER TABLE public.refund_intents ADD COLUMN IF NOT EXISTS attempt     integer NOT NULL DEFAULT 0;
ALTER TABLE public.refund_intents ADD COLUMN IF NOT EXISTS called_at   timestamptz;
ALTER TABLE public.refund_intents ADD COLUMN IF NOT EXISTS released_at timestamptz;

CREATE OR REPLACE FUNCTION public.claim_charge_intent(
    p_camp_id      uuid,
    p_key          text,
    p_amount       numeric DEFAULT NULL,
    p_payment_ref  text    DEFAULT NULL,
    p_take_stale   boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_key text := NULLIF(btrim(COALESCE(p_key, '')), '');
    r     record;
BEGIN
    IF p_camp_id IS NULL OR v_key IS NULL THEN
        RETURN jsonb_build_object('claimed', false, 'state', 'no_key');
    END IF;

    INSERT INTO refund_intents (camp_id, key, amount, payment_ref)
    VALUES (p_camp_id, v_key, p_amount, NULLIF(btrim(COALESCE(p_payment_ref, '')), ''))
    ON CONFLICT (camp_id, key) DO NOTHING;
    IF FOUND THEN
        RETURN jsonb_build_object('claimed', true, 'state', 'new', 'attempt', 0);
    END IF;

    SELECT * INTO r FROM refund_intents WHERE camp_id = p_camp_id AND key = v_key FOR UPDATE;

    IF r.settled_at IS NOT NULL THEN
        RETURN jsonb_build_object('claimed', false, 'state', 'settled',
                                  'previous', COALESCE(r.result, '{}'::jsonb));
    END IF;

    IF r.released_at IS NOT NULL                                               -- given back
       OR (r.called_at IS NULL AND r.created_at < now() - interval '10 minutes')  -- died before asking
       OR (p_take_stale AND r.called_at IS NOT NULL
           AND r.called_at < now() - interval '10 minutes') THEN               -- caller will re-ask
        UPDATE refund_intents
           SET released_at = NULL, created_at = now(),
               called_at = CASE WHEN r.released_at IS NULL AND r.called_at IS NOT NULL THEN r.called_at END,
               amount = COALESCE(p_amount, amount)
         WHERE camp_id = p_camp_id AND key = v_key;
        RETURN jsonb_build_object('claimed', true, 'state', 'retaken', 'attempt', r.attempt,
                                  'wasCalled', r.released_at IS NULL AND r.called_at IS NOT NULL);
    END IF;

    IF r.called_at IS NOT NULL AND r.called_at < now() - interval '10 minutes' THEN
        RETURN jsonb_build_object('claimed', false, 'state', 'stale', 'attempt', r.attempt,
                                  'since', r.called_at);
    END IF;

    RETURN jsonb_build_object('claimed', false, 'state', 'in_progress', 'attempt', r.attempt);
END $$;

/** The processor is about to be asked: from here on, an abandoned claim may have moved money. */
CREATE OR REPLACE FUNCTION public.mark_charge_intent_called(p_camp_id uuid, p_key text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    UPDATE refund_intents SET called_at = now()
     WHERE camp_id = p_camp_id AND key = NULLIF(btrim(COALESCE(p_key, '')), '') AND settled_at IS NULL
    RETURNING true;
$$;

/**
 * Give a charge claim back. p_declined: the processor said no, so the next try
 * is a new attempt (a new Idempotency-Key). Otherwise (nothing was sent, or
 * Stripe's answer was lost) the next try repeats this attempt. Never touches a
 * settled claim.
 */
CREATE OR REPLACE FUNCTION public.release_charge_intent(p_camp_id uuid, p_key text, p_declined boolean DEFAULT false)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    UPDATE refund_intents
       SET released_at = now(), called_at = NULL,
           attempt = attempt + CASE WHEN p_declined THEN 1 ELSE 0 END
     WHERE camp_id = p_camp_id AND key = NULLIF(btrim(COALESCE(p_key, '')), '') AND settled_at IS NULL
    RETURNING true;
$$;

REVOKE ALL ON FUNCTION public.claim_charge_intent(uuid, text, numeric, text, boolean) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_charge_intent_called(uuid, text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_charge_intent(uuid, text, boolean) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_charge_intent(uuid, text, numeric, text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_charge_intent_called(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_charge_intent(uuid, text, boolean) TO service_role;


-- TED-086: every kind the functions record is accepted. (The reconciliation
-- report still counts kind 'charge' only; the others are now on record.)
DO $$
DECLARE c text;
BEGIN
    FOR c IN SELECT conname FROM pg_constraint
              WHERE conrelid = 'public.processor_transactions'::regclass AND contype = 'c'
                AND pg_get_constraintdef(oid) ~ 'kind' LOOP
        EXECUTE format('ALTER TABLE public.processor_transactions DROP CONSTRAINT %I', c);
    END LOOP;
    ALTER TABLE public.processor_transactions DROP CONSTRAINT IF EXISTS processor_transactions_kind_check;
    ALTER TABLE public.processor_transactions
        ADD CONSTRAINT processor_transactions_kind_check CHECK (kind ~ '^[a-z][a-z_]{0,39}$');
END $$;
