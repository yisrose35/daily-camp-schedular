-- ============================================================================
-- Migration: notifications — cross-app live notification feed for the Dashboard
--
-- Why: the Dashboard's "Notifications & Reminders" card is 100% hardcoded
--      client-side content (birthdays + static role tips) — nothing from
--      Campistry Link or Campistry Notes ever surfaces there. This gives
--      every app a single place to write a notification into, and gives the
--      Dashboard one table + one realtime channel to read from.
--
-- Writers (this migration):
--   - link_messages: an AFTER INSERT trigger fires on inbound parent
--     messages (direction='in') and writes a notification.
--   - Campistry Notes reminders: NOT event-driven (a reminder becomes "due"
--     purely because time passed, not because a row changed), so it can't be
--     a trigger. A scheduled edge function (check-notes-reminders, deployed
--     separately per NOTIFICATIONS_SETUP.md) scans for due reminders instead
--     and inserts here the same way.
--
-- Dedup / idempotency: UNIQUE(camp_id, source, source_id) is the whole
-- mechanism — every writer INSERTs with ON CONFLICT DO NOTHING, so a trigger
-- firing more than once (shouldn't happen, but) or a cron scan re-checking a
-- reminder it already surfaced both no-op safely. Nothing about the source
-- data (link_messages, the Notes blob) is ever mutated to track "already
-- notified" — the notifications table itself is the record.
--
-- Read state is per-user (notification_reads), not a boolean on the
-- notification row — an owner and a scheduler on the same camp read
-- independently, same as link_messages' parent-facing read state is
-- independent of the admin-facing one.
-- ============================================================================

-- ─── 1. Tables ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
    id            uuid        NOT NULL DEFAULT gen_random_uuid(),
    camp_id       uuid        NOT NULL,
    source        text        NOT NULL,   -- 'link_message' | 'notes_reminder' (more sources can join later)
    source_id     text        NOT NULL,   -- id of the thing that caused this (link_messages.id, a note's id, ...)
    title         text        NOT NULL,
    body          text        NOT NULL DEFAULT '',
    link_target   text,                   -- where clicking this notification should take the user
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id),
    UNIQUE (camp_id, source, source_id)
);

CREATE INDEX IF NOT EXISTS idx_notifications_camp
    ON notifications (camp_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_reads (
    id               uuid        NOT NULL DEFAULT gen_random_uuid(),
    notification_id  uuid        NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
    user_id          uuid        NOT NULL,
    read_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id),
    UNIQUE (notification_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_reads_user
    ON notification_reads (user_id);

-- ─── 2. RLS ────────────────────────────────────────────────────────────────────
-- notifications: read-only to camp staff, same role set as link_messages.
-- No client INSERT/UPDATE/DELETE policy — the only writers are the
-- SECURITY DEFINER trigger below and the service-role edge function, both of
-- which bypass RLS the same way get_user_camp_id()/get_user_role() do.
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notifications_select ON notifications;
CREATE POLICY notifications_select ON notifications
    FOR SELECT
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'scheduler'::text])
    );

-- notification_reads: each user can only see/create their own read receipts.
ALTER TABLE notification_reads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notification_reads_select ON notification_reads;
CREATE POLICY notification_reads_select ON notification_reads
    FOR SELECT
    USING (user_id = auth.uid());

DROP POLICY IF EXISTS notification_reads_insert ON notification_reads;
CREATE POLICY notification_reads_insert ON notification_reads
    FOR INSERT
    WITH CHECK (user_id = auth.uid());

-- ─── 3. Trigger: new inbound Link message -> notification ────────────────────
CREATE OR REPLACE FUNCTION public.notify_new_link_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    IF NEW.direction = 'in' THEN
        INSERT INTO notifications (camp_id, source, source_id, title, body, link_target)
        VALUES (
            NEW.camp_id,
            'link_message',
            NEW.id::text,
            'New message from ' || COALESCE(NULLIF(NEW.parent_name, ''), 'a parent'),
            left(COALESCE(NEW.body, ''), 140),
            'campistry_link_admin.html?thread=' || NEW.thread_id::text
        )
        ON CONFLICT (camp_id, source, source_id) DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_new_link_message ON link_messages;
CREATE TRIGGER trg_notify_new_link_message
    AFTER INSERT ON link_messages
    FOR EACH ROW
    EXECUTE FUNCTION public.notify_new_link_message();

-- ─── 4. Realtime ────────────────────────────────────────────────────────────
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        BEGIN
            ALTER PUBLICATION supabase_realtime ADD TABLE notifications;
        EXCEPTION WHEN duplicate_object THEN NULL;
        END;
    END IF;
END $$;

-- ─── 5. Sanity check ──────────────────────────────────────────────────────────
--   SELECT proname FROM pg_proc WHERE proname = 'notify_new_link_message';
--   SELECT tgname FROM pg_trigger WHERE tgname = 'trg_notify_new_link_message';
--
-- After deploying, send a test parent reply (submit_message_reply RPC) and
-- confirm a row appears:
--   SELECT * FROM notifications WHERE source = 'link_message' ORDER BY created_at DESC LIMIT 1;
