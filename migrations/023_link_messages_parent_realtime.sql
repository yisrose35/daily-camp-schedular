-- ============================================================================
-- Migration: parent Realtime for link_messages
--
-- Today parents read messages only through the get_my_messages RPC (polled),
-- so their browser can't subscribe to Supabase Realtime (postgres_changes
-- enforces RLS, and parents have no SELECT policy on link_messages).
--
-- This adds a SELECT policy scoped to the parent's OWN active invite email —
-- additive to the existing staff SELECT policy, and tight enough that a parent
-- can only ever see rows addressed to their email (no cross-parent leak). With
-- it, the parent portal can open a websocket and get new camp messages the
-- instant they're inserted, instead of on a 30s poll.
--
-- REPLICA IDENTITY FULL makes Postgres emit the complete old row on UPDATE /
-- DELETE, so Realtime can RLS-filter those events too (an admin archiving or
-- deleting a message reaches the right parent live). INSERT already carries the
-- full new row.
-- ============================================================================

DROP POLICY IF EXISTS link_messages_parent_select ON link_messages;
CREATE POLICY link_messages_parent_select ON link_messages
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM link_parent_invites inv
            WHERE inv.user_id = auth.uid()
              AND inv.status = 'active'
              AND (inv.expires_at IS NULL OR inv.expires_at > now())
              AND inv.camp_id = link_messages.camp_id
              AND lower(inv.parent_email) = lower(link_messages.parent_email)
        )
    );

ALTER TABLE link_messages REPLICA IDENTITY FULL;

-- Ensure the table is published for Realtime (idempotent — 020 added it too).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        BEGIN
            ALTER PUBLICATION supabase_realtime ADD TABLE link_messages;
        EXCEPTION WHEN duplicate_object THEN NULL;
        END;
    END IF;
END $$;

-- ─── Sanity check ─────────────────────────────────────────────────────────────
--   SELECT policyname FROM pg_policies WHERE tablename = 'link_messages';
--   SELECT relreplident FROM pg_class WHERE relname = 'link_messages'; -- expect 'f'
--   SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='link_messages';
