-- ============================================================================
-- Migration: schedule_versions — saved/named schedule snapshots ("Save
--            Schedule" button + Saved Schedules recall table)
--
-- Why: schedule_versions_db.js (ScheduleVersionsDB) and the unified Save
--      Schedule UI read/write this table, and the auto-backup-before-edit
--      hook inserts rows named 'Auto-backup before ...'. No migration ever
--      created it, so its existence depended on a manual dashboard action.
--      createVersion() swallows insert errors (returns {success:false}
--      silently), so a missing table makes every Save quietly no-op. This
--      brings the table + RLS into version control.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS is a no-op if the table already
-- exists (it will NOT alter an existing schema), ENABLE RLS is a no-op if
-- already on, and every CREATE POLICY is preceded by DROP POLICY IF EXISTS.
--
-- Columns mirror what schedule_versions_db.js reads/writes:
--   id, camp_id, date_key, name, schedule_data jsonb, created_by,
--   created_at, updated_at
-- ============================================================================

-- ─── 1. Table ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schedule_versions (
    id            uuid          NOT NULL DEFAULT gen_random_uuid(),
    camp_id       uuid          NOT NULL,
    date_key      date          NOT NULL,
    name          text          NOT NULL,
    schedule_data jsonb         NOT NULL,
    created_by    text,
    created_at    timestamptz   NOT NULL DEFAULT now(),
    updated_at    timestamptz   NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

-- listVersions(dateKey) filters by (camp_id, date_key) and orders by created_at
CREATE INDEX IF NOT EXISTS idx_schedule_versions_camp_date
    ON schedule_versions (camp_id, date_key, created_at DESC);

-- ─── 2. Row-Level Security (mirror rotation_counts) ─────────────────────────
ALTER TABLE schedule_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS schedule_versions_select ON schedule_versions;
CREATE POLICY schedule_versions_select ON schedule_versions
    FOR SELECT
    USING (camp_id = get_user_camp_id());

DROP POLICY IF EXISTS schedule_versions_insert ON schedule_versions;
CREATE POLICY schedule_versions_insert ON schedule_versions
    FOR INSERT
    WITH CHECK (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'scheduler'::text])
    );

DROP POLICY IF EXISTS schedule_versions_update ON schedule_versions;
CREATE POLICY schedule_versions_update ON schedule_versions
    FOR UPDATE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'scheduler'::text])
    );

-- DELETE: owner/admin/scheduler — schedulers prune their own auto-backups via
-- cleanupOldAutoBackups and remove saves from the Saved Schedules table.
DROP POLICY IF EXISTS schedule_versions_delete ON schedule_versions;
CREATE POLICY schedule_versions_delete ON schedule_versions
    FOR DELETE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'scheduler'::text])
    );

-- ─── 3. Realtime publication (optional; matches sibling tables) ─────────────
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        BEGIN
            ALTER PUBLICATION supabase_realtime ADD TABLE schedule_versions;
        EXCEPTION WHEN duplicate_object THEN
            NULL;
        END;
    END IF;
END $$;
