-- ============================================================================
-- 198_refund_intents.sql
--
-- STOP A REFUND HAPPENING TWICE.
--
-- record_external_refund is already idempotent — it returns alreadyRecorded when
-- an entry carrying the same refund id exists. But it keys on the PROCESSOR's
-- refund id, and that id does not exist until the processor call has succeeded.
-- So the sequence on a double submission is:
--
--     call the processor  -> refund R1 created   -> ledger entry for R1
--     call it again       -> refund R2 created   -> ledger entry for R2
--
-- Both entries are correct. The family has been refunded twice in real money, and
-- the books faithfully record it. The bookkeeping was protected; the money was not.
--
-- A claim has to be taken BEFORE the processor is called, on a key the CALLER
-- controls and repeats — the same shape as 188's payment_receipts, for the same
-- reason: whoever is about to do the irreversible thing asks first whether it has
-- already been done.
--
-- ── WHY THE CALLER SUPPLIES THE KEY ────────────────────────────────────────
--
-- Because only the caller can tell a RETRY from a second deliberate refund. Two
-- partial refunds of $50 against the same payment are legitimate and must both go
-- through; one refund of $50 attempted twice because the connection dropped must
-- not. Those are identical from the server's side and different from the user's,
-- so the key is generated once per user action and reused on retry.
--
-- ── ON FAILURE THE CLAIM IS RELEASED ───────────────────────────────────────
--
-- A claim that outlives a failed processor call would lock a refund out
-- permanently — the office would try again, be told it already happened, and the
-- family would never get their money. Release on failure, exactly as 188 does.
--
-- Service-role only. These are called from Edge Functions, never a browser.
-- Idempotent. Safe to run twice.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.refund_intents (
    camp_id     uuid        NOT NULL,
    key         text        NOT NULL,      -- the caller's idempotency key
    amount      numeric,                   -- what was claimed, for forensics
    payment_ref text,                      -- which payment it is against
    result      jsonb,                     -- the first call's answer, replayed
    created_at  timestamptz NOT NULL DEFAULT now(),
    settled_at  timestamptz,               -- when the processor confirmed
    PRIMARY KEY (camp_id, key)
);

CREATE INDEX IF NOT EXISTS idx_refund_intents_camp
    ON public.refund_intents (camp_id, created_at DESC);

ALTER TABLE public.refund_intents ENABLE ROW LEVEL SECURITY;
-- No policies at all: service role bypasses RLS, and nothing else may read a
-- table whose rows say what a family was refunded.
REVOKE ALL ON TABLE public.refund_intents FROM anon, authenticated;

/**
 * Claim the right to perform this refund. TRUE means go ahead.
 *
 * FALSE means somebody already has — the caller must NOT call the processor, and
 * should return the stored result so a retry looks like the success it replays
 * rather than a new failure.
 */
CREATE OR REPLACE FUNCTION public.claim_refund_intent(
    p_camp_id     uuid,
    p_key         text,
    p_amount      numeric DEFAULT NULL,
    p_payment_ref text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_key  text := NULLIF(btrim(COALESCE(p_key, '')), '');
    v_prev jsonb;
BEGIN
    -- No key means no way to tell a retry from a new refund. Refusing to claim
    -- would BLOCK the refund, which is the wrong failure: fall through and let it
    -- proceed unguarded, exactly as it did before this table existed, rather than
    -- making a missing header stop an office issuing money.
    IF p_camp_id IS NULL OR v_key IS NULL THEN
        RETURN jsonb_build_object('claimed', true, 'unguarded', true);
    END IF;

    INSERT INTO refund_intents (camp_id, key, amount, payment_ref)
    VALUES (p_camp_id, v_key, p_amount, NULLIF(btrim(COALESCE(p_payment_ref, '')), ''))
    ON CONFLICT (camp_id, key) DO NOTHING;

    IF FOUND THEN
        RETURN jsonb_build_object('claimed', true, 'unguarded', false);
    END IF;

    SELECT result INTO v_prev
      FROM refund_intents
     WHERE camp_id = p_camp_id AND key = v_key;

    RETURN jsonb_build_object('claimed', false, 'unguarded', false,
                              'previous', COALESCE(v_prev, '{}'::jsonb));
END $$;

/** Record what the processor said, so a later retry can replay it. */
CREATE OR REPLACE FUNCTION public.settle_refund_intent(
    p_camp_id uuid,
    p_key     text,
    p_result  jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_key text := NULLIF(btrim(COALESCE(p_key, '')), '');
BEGIN
    IF p_camp_id IS NULL OR v_key IS NULL THEN RETURN false; END IF;
    UPDATE refund_intents
       SET result = COALESCE(p_result, '{}'::jsonb), settled_at = now()
     WHERE camp_id = p_camp_id AND key = v_key;
    RETURN FOUND;
END $$;

/**
 * Give the claim back after a FAILED processor call.
 *
 * Without this a dropped connection locks the refund out for good: the office
 * retries, is told it already happened, and the family never sees their money.
 * Only ever called when the processor did NOT move money.
 */
CREATE OR REPLACE FUNCTION public.release_refund_intent(p_camp_id uuid, p_key text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_key text := NULLIF(btrim(COALESCE(p_key, '')), '');
BEGIN
    IF p_camp_id IS NULL OR v_key IS NULL THEN RETURN false; END IF;
    -- Never release a SETTLED claim: that one really did move money, and handing
    -- it back would authorise a second refund.
    DELETE FROM refund_intents
     WHERE camp_id = p_camp_id AND key = v_key AND settled_at IS NULL;
    RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION public.claim_refund_intent(uuid, text, numeric, text)
    FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_refund_intent(uuid, text, jsonb)
    FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_refund_intent(uuid, text)
    FROM public, anon, authenticated;

-- ============================================================================
-- HOW TO RUN THIS
--   Supabase Dashboard -> SQL Editor -> New query -> paste this file -> Run.
--
-- HOW TO CHECK IT TOOK
--   select proname from pg_proc
--    where proname in ('claim_refund_intent','settle_refund_intent',
--                      'release_refund_intent') order by proname;
--   -- 3 rows
--
--   -- and after issuing a refund, one settled row per real refund:
--   select key, amount, payment_ref, settled_at from refund_intents
--    where camp_id = '<your camp uuid>' order by created_at desc limit 10;
-- ============================================================================
