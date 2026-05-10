-- ============================================================================
-- Migration: enforce RLS on daily_schedules and document the policy
--
-- Why: The audit found no migration in this repo for daily_schedules even
--      though 9 modules read/write it. Whatever policies exist live only in
--      the Supabase dashboard, so the source-of-truth is invisible to
--      reviewers. This migration brings the policy into version control.
--
-- Idempotent: ENABLE ROW LEVEL SECURITY is a no-op if already enabled, and
-- every CREATE POLICY is preceded by DROP POLICY IF EXISTS.
--
-- Schema is assumed to already exist in production. If it doesn't, the
-- code in supabase_schedules.js implies these columns:
--   id, camp_id, date_key, scheduler_id, scheduler_name, divisions[],
--   schedule_data jsonb, unified_times, is_rainy_day, updated_at
-- ============================================================================

-- ─── 1. Enable RLS (idempotent) ────────────────────────────────────────────
ALTER TABLE IF EXISTS daily_schedules ENABLE ROW LEVEL SECURITY;

-- ─── 2. Policies (mirror camp_state_kv: write requires owner/admin/scheduler) ─
DROP POLICY IF EXISTS daily_schedules_select ON daily_schedules;
CREATE POLICY daily_schedules_select ON daily_schedules
    FOR SELECT
    USING (camp_id = get_user_camp_id());

DROP POLICY IF EXISTS daily_schedules_insert ON daily_schedules;
CREATE POLICY daily_schedules_insert ON daily_schedules
    FOR INSERT
    WITH CHECK (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'scheduler'::text])
    );

DROP POLICY IF EXISTS daily_schedules_update ON daily_schedules;
CREATE POLICY daily_schedules_update ON daily_schedules
    FOR UPDATE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'scheduler'::text])
    );

-- DELETE: owner/admin only. Schedulers can clear THEIR row via the
-- deleteMyScheduleOnly flow which restricts by scheduler_id at app level
-- AND by RLS update; but full-row delete should require admin.
DROP POLICY IF EXISTS daily_schedules_delete ON daily_schedules;
CREATE POLICY daily_schedules_delete ON daily_schedules
    FOR DELETE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text])
    );

-- ─── 3. Realtime publication ───────────────────────────────────────────────
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        BEGIN
            ALTER PUBLICATION supabase_realtime ADD TABLE daily_schedules;
        EXCEPTION WHEN duplicate_object THEN
            NULL;
        END;
    END IF;
END $$;
