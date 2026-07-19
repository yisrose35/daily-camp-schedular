-- ============================================================================
-- Migration: hidden_for_admin for link_messages
--
-- Until now an admin "delete" was a real hard DELETE — which also destroyed
-- the parent's copy of the conversation. That's not the inbox expectation:
-- deleting from your own inbox shouldn't wipe it from the other party's.
--
-- Migration 021 already made PARENT delete a soft hide (hidden_for_parent);
-- this adds the symmetric ADMIN-side flag. Admin delete now sets
-- hidden_for_admin = true — the row survives (the parent still sees it via
-- get_my_messages, which never references this column), it just disappears
-- from the admin/staff inbox, which reads link_messages directly and now
-- filters hidden_for_admin = false.
--
-- No RPC or policy change is needed: staff already have SELECT/UPDATE on
-- link_messages (owner/admin/scheduler), and setting the flag is a plain
-- UPDATE. The old DELETE policy is left in place (unused by the apps now).
-- ============================================================================

ALTER TABLE link_messages
    ADD COLUMN IF NOT EXISTS hidden_for_admin boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_link_messages_camp_hidden_admin
    ON link_messages (camp_id, hidden_for_admin);

-- ─── Sanity check ─────────────────────────────────────────────────────────────
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'link_messages' AND column_name = 'hidden_for_admin';
