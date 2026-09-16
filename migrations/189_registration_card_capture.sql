-- =============================================================================
-- Migration 189: capture the card BEFORE the form is submitted.
--
-- Until now a parent picked "Credit Card", submitted, and only then met the
-- processor. That is the wrong way round: they find out their card is
-- declined after the application is gone, and the form cannot tell them
-- whether they have a working card at all.
--
-- Now: picking a card method offers a button, the button opens the camp's
-- processor, the processor accepts (or refuses) the card, and the form shows a
-- tick or a cross next to the method. Submit is held until there is a tick.
--
-- The processors disagree about how they say "accepted":
--   Banquest  -- a $0 verify with save_card, answered in the same request.
--   Cardknox  -- Sola's hosted cc:save page, answered later by webhook.
--   Stripe    -- a Checkout Session in setup mode, answered later by webhook.
-- So this table is the ONE place all three land, and the form polls it. The
-- form never learns a token, a customer id or anything else it could misuse --
-- get_card_capture_status returns the tick, the brand and the last four.
--
-- Nothing here charges anything. The deposit is taken afterwards, against the
-- captured card, for the amount the camp stamped on the saved application.
--
-- Idempotent -- safe to re-run. Requires 185 (the registration deposit).
-- =============================================================================

CREATE TABLE IF NOT EXISTS registration_card_captures (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    camp_id       uuid NOT NULL REFERENCES camps(id),
    reference     text NOT NULL UNIQUE,
    processor     text NOT NULL,
    status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'completed', 'failed')),
    -- What the processor gave back. Never leaves the server.
    customer_ref  text,
    method_ref    text,
    last4         text,
    brand         text,
    error_text    text,
    -- Set once the capture is attached to a real application, so the same
    -- card cannot be claimed twice.
    claimed_by    text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    completed_at  timestamptz
);
CREATE INDEX IF NOT EXISTS registration_card_captures_camp_idx
    ON registration_card_captures (camp_id);
-- An abandoned capture is a dead row; this is what a cleanup job would sweep.
CREATE INDEX IF NOT EXISTS registration_card_captures_created_idx
    ON registration_card_captures (created_at);

ALTER TABLE registration_card_captures ENABLE ROW LEVEL SECURITY;
-- No client-facing policies at all. Everything goes through the RPCs below,
-- the same convention camp_processor_credentials and cardknox_checkout_intents
-- already follow.

-- ─── 1. start one ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_card_capture(
    p_camp_id   uuid,
    p_reference text,
    p_processor text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    INSERT INTO registration_card_captures (camp_id, reference, processor)
    VALUES (p_camp_id, p_reference, p_processor);
    RETURN jsonb_build_object('success', true);
EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'error', 'reference_already_used');
END;
$$;

REVOKE ALL ON FUNCTION public.create_card_capture(uuid, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_card_capture(uuid, text, text) TO service_role;

-- ─── 2. finish one ──────────────────────────────────────────────────────────
-- Called by whichever side heard back: the edge function itself (Banquest,
-- which answers synchronously) or a webhook (Stripe, Cardknox).
--
-- Idempotent on purpose: webhooks retry, and a second delivery for a capture
-- that already succeeded must not turn it back into a failure.
CREATE OR REPLACE FUNCTION public.complete_card_capture(
    p_reference    text,
    p_status       text,
    p_customer_ref text,
    p_method_ref   text,
    p_last4        text,
    p_brand        text,
    p_error        text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE v_current text;
BEGIN
    IF p_status NOT IN ('completed', 'failed') THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_status');
    END IF;

    SELECT status INTO v_current
      FROM registration_card_captures WHERE reference = p_reference FOR UPDATE;
    IF v_current IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_found');
    END IF;
    IF v_current = 'completed' THEN
        -- Already good. A retry does not get to undo that.
        RETURN jsonb_build_object('success', true, 'alreadyDone', true);
    END IF;

    UPDATE registration_card_captures
       SET status       = p_status,
           customer_ref = COALESCE(p_customer_ref, customer_ref),
           method_ref   = COALESCE(p_method_ref, method_ref),
           last4        = COALESCE(p_last4, last4),
           brand        = COALESCE(p_brand, brand),
           error_text   = p_error,
           completed_at = now()
     WHERE reference = p_reference;

    RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.complete_card_capture(text, text, text, text, text, text, text)
    FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_card_capture(text, text, text, text, text, text, text)
    TO service_role;

-- ─── 3. what the form is allowed to see ─────────────────────────────────────
-- Anon, because the form asking has no session -- but the reference is a
-- random 32-hex string the caller can only have because we just gave it to
-- them, and the answer holds nothing worth stealing: a status, a brand and
-- the last four digits, which is what the form is about to print anyway.
-- Deliberately NOT customer_ref/method_ref: those can move money.
CREATE OR REPLACE FUNCTION public.get_card_capture_status(p_reference text)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT CASE WHEN c.id IS NULL
                THEN jsonb_build_object('success', false, 'error', 'not_found')
                ELSE jsonb_build_object(
                    'success', true,
                    'status',  c.status,
                    'last4',   c.last4,
                    'brand',   c.brand,
                    'error',   c.error_text)
           END
      FROM (SELECT 1) x
      LEFT JOIN registration_card_captures c ON c.reference = p_reference;
$$;

REVOKE ALL ON FUNCTION public.get_card_capture_status(text) FROM public;
GRANT EXECUTE ON FUNCTION public.get_card_capture_status(text) TO anon, authenticated;

-- ─── 4. attach it to the application that was just created ──────────────────
-- Moves the processor's references onto the enrollment, so the deposit can be
-- charged against the card the parent already had accepted. One capture, one
-- application: claimed_by stops the same accepted card being spread across
-- several applications by a caller replaying the reference.
CREATE OR REPLACE FUNCTION public._claim_card_capture(
    p_camp_id   uuid,
    p_reference text,
    p_enroll_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE c registration_card_captures%ROWTYPE;
BEGIN
    SELECT * INTO c FROM registration_card_captures
     WHERE reference = p_reference FOR UPDATE;

    IF c.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_found');
    END IF;
    IF c.camp_id <> p_camp_id THEN
        RETURN jsonb_build_object('success', false, 'error', 'wrong_camp');
    END IF;
    IF c.status <> 'completed' THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_accepted');
    END IF;
    IF c.claimed_by IS NOT NULL AND c.claimed_by <> p_enroll_id THEN
        RETURN jsonb_build_object('success', false, 'error', 'already_claimed');
    END IF;

    UPDATE registration_card_captures
       SET claimed_by = p_enroll_id WHERE id = c.id;

    RETURN jsonb_build_object(
        'success',   true,
        'processor', c.processor,
        'customer',  c.customer_ref,
        'method',    c.method_ref,
        'last4',     c.last4,
        'brand',     c.brand);
END;
$$;

REVOKE ALL ON FUNCTION public._claim_card_capture(uuid, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._claim_card_capture(uuid, text, text) TO service_role;

-- ─── 5. Cardknox/Sola needs one more kind ───────────────────────────────────
-- The capture row above is the source of truth the form polls, but Sola's
-- answer arrives at cardknox-webhook, which resolves a delivery against
-- cardknox_checkout_intents -- including the amount-zero fallback it has to
-- use because Sola never echoes xInvoice back. So a capture also gets an
-- intent row, under its own kind.
--
-- Dropped BY NAME first. Postgres stores `kind IN (...)` as
-- `kind = ANY (ARRAY[...])`, so hunting for the old constraint by the word IN
-- matches nothing, drops nothing, and the ADD below dies with "already
-- exists" -- which is exactly how 187 failed.
ALTER TABLE public.cardknox_checkout_intents
    DROP CONSTRAINT IF EXISTS cardknox_checkout_intents_kind_check;

DO $$
DECLARE c_name text;
BEGIN
    FOR c_name IN
        SELECT conname FROM pg_constraint
         WHERE conrelid = 'public.cardknox_checkout_intents'::regclass
           AND contype = 'c'
           AND pg_get_constraintdef(oid) ILIKE '%kind%'
    LOOP
        EXECUTE format('ALTER TABLE public.cardknox_checkout_intents DROP CONSTRAINT %I', c_name);
    END LOOP;
END $$;

ALTER TABLE public.cardknox_checkout_intents
    ADD CONSTRAINT cardknox_checkout_intents_kind_check
    CHECK (kind IN ('tuition_charge', 'canteen_deposit', 'card_save',
                    'canteen_autoreload_setup', 'registration_deposit',
                    'registration_card_capture'));

NOTIFY pgrst, 'reload schema';

-- ─── Sanity checks (run manually after applying) ────────────────────────────
--   SELECT * FROM registration_card_captures LIMIT 1;  -- empty, no error
--   SELECT get_card_capture_status('nope');            -- {"success":false,...}
--   SELECT proname, proacl FROM pg_proc WHERE proname IN
--     ('create_card_capture','complete_card_capture','get_card_capture_status','_claim_card_capture');
--   -- expect anon ONLY on get_card_capture_status
-- =============================================================================
