-- ============================================================================
-- Migration 072: sms_opt_outs — TCPA STOP-word compliance, global by phone.
--
-- Why: any automated/consent-based SMS sending needs to honor "reply STOP"
-- immediately and permanently. Keyed globally by phone (last-10-digits, same
-- comparison key send-sms/index.ts already uses via phoneKey()) rather than
-- per-camp — TCPA opt-out attaches to the phone number's consent state, not
-- to a particular camp's relationship with that number. A number that opts
-- out is opted out everywhere on the platform.
-- ============================================================================

CREATE TABLE IF NOT EXISTS sms_opt_outs (
    phone_key     text        NOT NULL,   -- last 10 digits, see phoneKey() in send-sms
    phone_raw     text,                   -- as received, for support/debugging
    camp_id       uuid,                   -- camp active when the STOP arrived, if known
    source        text        NOT NULL DEFAULT 'telnyx_stop',
    opted_out_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (phone_key)
);

ALTER TABLE sms_opt_outs ENABLE ROW LEVEL SECURITY;

-- No client-side SELECT/INSERT policy — every read/write goes through
-- SECURITY DEFINER functions (the Telnyx webhook, and the send-broadcast /
-- send-scheduled-broadcasts edge functions checking before a send), same
-- pattern as other compliance-sensitive tables in this schema.

-- Sanity check after running:
--   SELECT to_regclass('public.sms_opt_outs');
