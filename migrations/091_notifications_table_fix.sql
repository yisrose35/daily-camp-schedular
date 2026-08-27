-- ============================================================================
-- Migration 091: reconcile the legacy hand-created `notifications` table
-- with the shape migrations/056_notifications.sql's writers actually need.
--
-- Root cause (already predicted, never fixed — see 064_pickup_alerts.sql's
-- own comment header, written back when this session built pickup alerts):
-- `notifications` was created directly in the Supabase dashboard, before
-- 056 shipped, with the shape (user_id, type, title, message, metadata,
-- read) that the post-edit conflict-notify feature (post_edit_system.js,
-- integration_hooks.js) still reads/writes today. 056's own
-- `CREATE TABLE IF NOT EXISTS notifications` used a DIFFERENT shape
-- (camp_id, source, source_id, title, body, link_target) — since the table
-- already existed, that statement silently no-op'd. But 056's trigger
-- (notify_new_link_message), plus the check-notes-reminders and
-- send-broadcast edge functions, all insert assuming the NEW shape exists.
--
-- Confirmed live: a parent replying to a Link message fails outright —
-- submit_message_reply's INSERT into link_messages fires the trigger, the
-- trigger's INSERT into notifications hits "column \"source\" of relation
-- \"notifications\" does not exist", and the whole reply rolls back with a
-- 400 the parent sees as "could not send message please try again."
--
-- Fix: ADD the columns 056's writers need directly onto the existing
-- table — non-destructive, nothing about the legacy user_id/type/message/
-- read shape is touched, so the conflict-notify feature keeps working
-- exactly as it does today — and relax NOT NULL on the legacy columns the
-- new (source-based) writers never set, so fixing the missing-column error
-- doesn't just trade it for a NOT NULL violation on the very next insert.
-- Idempotent, safe to re-run.
-- ============================================================================

ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS source      text,
    ADD COLUMN IF NOT EXISTS source_id   text,
    ADD COLUMN IF NOT EXISTS body        text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS link_target text;

-- Legacy columns the new writers never set — relax NOT NULL only if the
-- column exists and is currently required. No-op if already nullable or if
-- this install never had that column at all.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'notifications'
          AND column_name = 'user_id' AND is_nullable = 'NO'
    ) THEN
        ALTER TABLE notifications ALTER COLUMN user_id DROP NOT NULL;
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'notifications'
          AND column_name = 'type' AND is_nullable = 'NO'
    ) THEN
        ALTER TABLE notifications ALTER COLUMN type DROP NOT NULL;
    END IF;
END $$;

-- UNIQUE(camp_id, source, source_id) — the trigger's ON CONFLICT and
-- check-notes-reminders' upsert(...).ignoreDuplicates both assumed this
-- existed since 056 (it never did, same no-op). NULLs in source/source_id
-- (every legacy conflict-notify row) never conflict with each other under
-- a UNIQUE constraint, so old rows are unaffected.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.notifications'::regclass
          AND contype = 'u'
          AND conname = 'notifications_camp_source_source_id_key'
    ) THEN
        ALTER TABLE notifications
            ADD CONSTRAINT notifications_camp_source_source_id_key
            UNIQUE (camp_id, source, source_id);
    END IF;
END $$;

-- ─── Sanity check ──────────────────────────────────────────────────────────
--   SELECT column_name, is_nullable FROM information_schema.columns
--   WHERE table_name = 'notifications' ORDER BY ordinal_position;
--   -- confirm source / source_id / body / link_target all exist now, and
--   -- user_id / type (if present) are nullable.
--
--   SELECT conname FROM pg_constraint
--   WHERE conrelid = 'public.notifications'::regclass AND contype = 'u';
--   -- confirm notifications_camp_source_source_id_key exists.
--
--   Then, as a parent, reply to a Link message — it should succeed, and:
--   SELECT * FROM notifications WHERE source = 'link_message'
--   ORDER BY created_at DESC LIMIT 1;
--   -- should show the new row.
-- ============================================================================
