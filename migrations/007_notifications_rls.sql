-- ============================================================================
-- Migration: notifications RLS — allow same-camp cross-user inserts
--
-- Why: The post-edit conflict flow (MS-4) lets one scheduler override a
--      slot that another user owns and "notify" them — the code inserts a
--      row into `notifications` addressed to the OTHER user (user_id =
--      that user's uid). The live table's INSERT policy was the default
--      restrictive "WITH CHECK (user_id = auth.uid())", so a scheduler
--      could only ever address notifications to THEMSELVES — every
--      cross-user notify failed with 42501 (row-level security violation)
--      and the other user was never told. (Verified live: insert addressed
--      to the owner → 42501.)
--
--      The `notifications` table has no prior migration in this repo (it
--      was created directly in the Supabase dashboard). This file brings
--      its policies into version control and fixes the INSERT rule.
--
-- Trust boundary: same camp. An authenticated member of a camp may create
--      a notification for ANY user, as long as the row's camp_id is the
--      sender's active camp (get_user_camp_id(), defined in
--      005_helper_functions.sql). Recipients still SELECT/UPDATE only their
--      OWN notifications (read + dismiss).
--
-- Idempotent. DROP POLICY IF EXISTS / CREATE POLICY pattern.
-- ============================================================================

ALTER TABLE IF EXISTS notifications ENABLE ROW LEVEL SECURITY;

-- ─── SELECT: you read only your own notifications ─────────────────────────
DROP POLICY IF EXISTS notifications_select ON notifications;
CREATE POLICY notifications_select ON notifications
    FOR SELECT
    USING (user_id = auth.uid());

-- ─── INSERT: any active same-camp member may notify any user in the camp ──
-- camp_id must be the sender's active camp. This is what lets a scheduler
-- send the conflict/bypass notification to the owner (or another scheduler).
DROP POLICY IF EXISTS notifications_insert ON notifications;
CREATE POLICY notifications_insert ON notifications
    FOR INSERT
    WITH CHECK (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'scheduler'::text])
    );

-- ─── UPDATE: you mark only your own notifications read/dismissed ───────────
DROP POLICY IF EXISTS notifications_update ON notifications;
CREATE POLICY notifications_update ON notifications
    FOR UPDATE
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

-- ─── DELETE: you delete only your own notifications ───────────────────────
DROP POLICY IF EXISTS notifications_delete ON notifications;
CREATE POLICY notifications_delete ON notifications
    FOR DELETE
    USING (user_id = auth.uid());

-- ─── Realtime: receiver subscribes to INSERTs on its own user_id ──────────
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        BEGIN
            ALTER PUBLICATION supabase_realtime ADD TABLE notifications;
        EXCEPTION WHEN duplicate_object THEN
            NULL;
        END;
    END IF;
END $$;

-- ─── Sanity check ──────────────────────────────────────────────────────────
--   SELECT polname, cmd, qual, with_check
--   FROM pg_policies
--   WHERE tablename = 'notifications'
--   ORDER BY polname;
