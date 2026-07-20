-- ============================================================================
-- Migration: scheduled broadcasts — compose now, send later
--
-- link_broadcasts previously stored one row per broadcast the moment it went
-- out. Scheduled broadcasts need to live in that same table BEFORE they're
-- sent, so we add:
--
--   - scheduled_for  timestamptz  — when the broadcast should fire (NULL = sent
--                                    immediately, the historical behavior)
--   - status         text         — 'sent' | 'scheduled' | 'sending' | 'canceled'
--
-- A partial index on (camp_id, scheduled_for) WHERE status = 'scheduled' keeps
-- the "what's due to fire" lookup cheap for both the client-side driver and the
-- send-scheduled-broadcasts edge function.
--
-- Backfill: every existing row was an immediate send, so status defaults to
-- 'sent' and scheduled_for stays NULL.
-- ============================================================================

ALTER TABLE link_broadcasts
    ADD COLUMN IF NOT EXISTS scheduled_for timestamptz,
    ADD COLUMN IF NOT EXISTS status        text NOT NULL DEFAULT 'sent',
    ADD COLUMN IF NOT EXISTS sent_at       timestamptz,
    -- Recipient snapshot captured at schedule time so the server-side edge
    -- function can send without live browser camp-state: [{ name, email,
    -- phone, subject, body }] with merge tags already resolved per recipient.
    ADD COLUMN IF NOT EXISTS recipients    jsonb;

-- Guard the status domain without a hard enum (keeps future values cheap).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'link_broadcasts_status_chk'
    ) THEN
        ALTER TABLE link_broadcasts
            ADD CONSTRAINT link_broadcasts_status_chk
            CHECK (status IN ('sent', 'scheduled', 'sending', 'canceled'));
    END IF;
END $$;

-- Fast lookup of broadcasts that are due to fire.
CREATE INDEX IF NOT EXISTS idx_link_broadcasts_due
    ON link_broadcasts (camp_id, scheduled_for)
    WHERE status = 'scheduled';

-- Existing rows are historical immediate sends.
UPDATE link_broadcasts SET status = 'sent' WHERE status IS NULL;
