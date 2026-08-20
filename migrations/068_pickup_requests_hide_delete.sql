-- ============================================================================
-- Migration 068: hide + delete for parent_pickup_requests
--
-- Live's Messages/Changes lists have no way to clear a resolved request out
-- of view — every early pickup, change, and late arrival a camp ever
-- confirms/declines stays in the list forever. This adds:
--   - a `hidden` column (soft-dismiss, syncs across every office device —
--     deliberately a real column, not a local-only flag, so one staff
--     member clearing a mess doesn't leave it cluttering everyone else's
--     screen)
--   - a DELETE policy (there was none at all before this — the table only
--     ever had SELECT/UPDATE for office roles)
--
-- Idempotent. Safe to re-run.
-- ============================================================================

ALTER TABLE public.parent_pickup_requests ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;

-- Same membership check as the existing ppr_admin_write/ppr_admin_read
-- policies (camps.owner or any camp_users row for this camp) — mirrored
-- exactly rather than tightened, so this doesn't accidentally diverge from
-- who can already review these rows.
DROP POLICY IF EXISTS ppr_admin_delete ON public.parent_pickup_requests;
CREATE POLICY ppr_admin_delete ON public.parent_pickup_requests
    FOR DELETE USING (
        camp_id = auth.uid()
        OR EXISTS (SELECT 1 FROM camps c WHERE c.id = parent_pickup_requests.camp_id AND c.owner = auth.uid())
        OR EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = parent_pickup_requests.camp_id AND u.user_id = auth.uid())
    );

-- ─── Sanity check ──────────────────────────────────────────────────────────
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'parent_pickup_requests' AND column_name = 'hidden';
--   SELECT policyname, cmd FROM pg_policies
--    WHERE tablename = 'parent_pickup_requests' ORDER BY policyname;
