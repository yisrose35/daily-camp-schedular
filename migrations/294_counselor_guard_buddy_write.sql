-- ============================================================================
-- Migration 294: let a counselor's Campistry Lite save a buddy pair
--
-- Same shape as migration 099 (counselor POS writes to campistrySnacks).
-- camp_state_kv's INSERT/UPDATE RLS policies (migration 001, widened by 009
-- and 098) only ever allow 'owner' | 'admin' | 'manager' | 'scheduler' —
-- 'counselor' has never been on that list for writes. campistry_lite.js's new
-- buddy-pairing feature (renderBuddyBox/loadGuardFresh) calls saveKV, a
-- direct client upsert into camp_state_kv key='campistryGuard', so a
-- counselor picking a pool buddy for their bunk would hit exactly the same
-- silent 0-rows-matched RLS rejection migration 099 fixed for the register —
-- the save fails with no error surfaced beyond Lite's own "Could not save
-- buddy" toast.
--
-- Fix: grant 'counselor' INSERT/UPDATE on camp_state_kv, scoped to the
-- 'campistryGuard' key only. This is additive (Postgres OR-combines multiple
-- permissive policies for the same command) — it doesn't touch or narrow
-- anything the base policies already grant owner/admin/manager/scheduler.
--
-- SELECT needs no change: the counselor SELECT policy (migration 160) already
-- allows any key except an explicit exclusion list (app1, campistryMe,
-- campistryHealth, campistryMePayroll, campistryMeFinance), and
-- campistryGuard is not on it — a counselor can already read buddy pairs and
-- Guard's live-roster check-in data via Lite, just not write them until now.
--
-- Idempotent — safe to re-run.
-- ============================================================================

DROP POLICY IF EXISTS camp_state_kv_insert_counselor_guard ON camp_state_kv;
CREATE POLICY camp_state_kv_insert_counselor_guard ON camp_state_kv
    FOR INSERT
    WITH CHECK (
        camp_id = get_user_camp_id()
        AND get_user_role() = 'counselor'::text
        AND key = 'campistryGuard'::text
    );

DROP POLICY IF EXISTS camp_state_kv_update_counselor_guard ON camp_state_kv;
CREATE POLICY camp_state_kv_update_counselor_guard ON camp_state_kv
    FOR UPDATE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = 'counselor'::text
        AND key = 'campistryGuard'::text
    );

-- ─── Sanity check (run manually after applying) ────────────────────────────
--   SELECT policyname, cmd, qual, with_check
--   FROM pg_policies
--   WHERE tablename = 'camp_state_kv' AND policyname LIKE '%counselor_guard%';
--   -- expect 2 rows: one INSERT, one UPDATE, both scoped to key='campistryGuard'
-- ============================================================================
