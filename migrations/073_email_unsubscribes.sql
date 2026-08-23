-- ============================================================================
-- Migration 073: email_unsubscribes — CAN-SPAM unsubscribe compliance,
-- global by email.
--
-- Same reasoning as migration 072's sms_opt_outs: an unsubscribe applies to
-- the email address's consent state platform-wide, not per-camp.
-- ============================================================================

CREATE TABLE IF NOT EXISTS email_unsubscribes (
    email             text        NOT NULL,
    camp_id           uuid,                 -- camp active when they unsubscribed, if known
    unsubscribed_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (email)
);

ALTER TABLE email_unsubscribes ENABLE ROW LEVEL SECURITY;

-- No client-side SELECT/INSERT policy — every read/write goes through
-- SECURITY DEFINER functions / edge functions (the unsubscribe-link
-- endpoint, and the sending functions checking before every send).

-- Sanity check after running:
--   SELECT to_regclass('public.email_unsubscribes');
