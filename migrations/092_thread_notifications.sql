-- ============================================================================
-- Migration 092: one notification per CONVERSATION, not per message.
--
-- notify_new_link_message() (from 056) keyed each notification row on the
-- individual inbound message's own id (source_id = NEW.id::text). A parent
-- and the office going back and forth 5 times in one thread produced 5
-- separate "New message from X" rows in the Dashboard feed — each message
-- of an ongoing conversation showed up as its own notification instead of
-- the conversation staying one continuous item that just refreshes.
--
-- Fix: key on NEW.thread_id instead (stable across every message in a
-- conversation) and DO UPDATE on conflict — refreshing title/body/
-- created_at/link_target in place — instead of the prior DO NOTHING, which
-- would have made the row go stale after the first message. Since the row's
-- id (and therefore any notification_reads pointing at it) stays the same
-- across the whole thread, a message arriving in an already-dismissed
-- thread needs its read state cleared too, or it would silently stay
-- "dismissed" forever even though a brand new message just came in — so
-- this also deletes any notification_reads for that row on every update.
--
-- Idempotent (CREATE OR REPLACE), safe to re-run.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.notify_new_link_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_notif_id uuid;
BEGIN
    IF NEW.direction = 'in' THEN
        INSERT INTO notifications (camp_id, source, source_id, title, body, link_target)
        VALUES (
            NEW.camp_id,
            'link_message',
            NEW.thread_id::text,
            'New message from ' || COALESCE(NULLIF(NEW.parent_name, ''), 'a parent'),
            left(COALESCE(NEW.body, ''), 140),
            'campistry_link_admin.html?thread=' || NEW.thread_id::text
        )
        ON CONFLICT (camp_id, source, source_id) DO UPDATE
            SET title       = EXCLUDED.title,
                body        = EXCLUDED.body,
                link_target = EXCLUDED.link_target,
                created_at  = now()
        RETURNING id INTO v_notif_id;

        -- A new message means the conversation is unread again for everyone
        -- who'd already dismissed the prior state of this same row.
        DELETE FROM notification_reads WHERE notification_id = v_notif_id;
    END IF;
    RETURN NEW;
END;
$$;

-- ─── Sanity check ──────────────────────────────────────────────────────────
--   SELECT proname FROM pg_proc WHERE proname = 'notify_new_link_message';
--
--   Then, as a parent, send two messages in the same thread a few seconds
--   apart — confirm only ONE row exists for that thread:
--   SELECT count(*) FROM notifications
--   WHERE source = 'link_message' AND source_id = '<the thread id>';
--   -- should be 1, with body/created_at reflecting the SECOND message.
--
--   Dismiss that notification in the Dashboard (or manually insert a row
--   into notification_reads for it), then send a third message in the same
--   thread — confirm the notification_reads row for it is gone and the
--   Dashboard badge counts it as unread again.
-- ============================================================================
