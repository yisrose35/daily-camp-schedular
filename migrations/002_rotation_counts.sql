-- ============================================================================
-- Migration: rotation_counts — per-date activity tracking for rotation report
--
-- Why: rotation tracking was stored in localStorage (historicalCounts) which
--      was unreliable across sessions and devices. This table gives a durable,
--      cloud-synced, per-date record of how many times each bunk did each
--      activity. Supports regeneration (delete+reinsert for a date) and
--      totals across 60+ days.
--
-- Schema: one row per (camp, date, bunk, activity) with a count of how many
--         slots that activity occupied on that date.
-- ============================================================================

-- ─── 1. New table ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rotation_counts (
    camp_id      uuid          NOT NULL,
    date_key     date          NOT NULL,
    bunk         text          NOT NULL,
    activity     text          NOT NULL,
    count        integer       NOT NULL DEFAULT 1,
    updated_at   timestamptz   NOT NULL DEFAULT now(),
    PRIMARY KEY (camp_id, date_key, bunk, activity)
);

CREATE INDEX IF NOT EXISTS idx_rotation_counts_camp
    ON rotation_counts (camp_id);

CREATE INDEX IF NOT EXISTS idx_rotation_counts_camp_bunk
    ON rotation_counts (camp_id, bunk);

-- ─── 2. Row-Level Security (mirror camp_state_kv policies) ────────────────
ALTER TABLE rotation_counts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rotation_counts_select ON rotation_counts;
CREATE POLICY rotation_counts_select ON rotation_counts
    FOR SELECT
    USING (camp_id = get_user_camp_id());

DROP POLICY IF EXISTS rotation_counts_insert ON rotation_counts;
CREATE POLICY rotation_counts_insert ON rotation_counts
    FOR INSERT
    WITH CHECK (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'scheduler'::text])
    );

DROP POLICY IF EXISTS rotation_counts_update ON rotation_counts;
CREATE POLICY rotation_counts_update ON rotation_counts
    FOR UPDATE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'scheduler'::text])
    );

DROP POLICY IF EXISTS rotation_counts_delete ON rotation_counts;
CREATE POLICY rotation_counts_delete ON rotation_counts
    FOR DELETE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'scheduler'::text])
    );

-- ─── 3. Realtime publication ───────────────────────────────────────────────
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        BEGIN
            ALTER PUBLICATION supabase_realtime ADD TABLE rotation_counts;
        EXCEPTION WHEN duplicate_object THEN
            NULL;
        END;
    END IF;
END $$;
