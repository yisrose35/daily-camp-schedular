-- ============================================================================
-- Migration: split camp_state JSON blob into per-key rows
--
-- Why: camp_state stores everything in one JSONB column. Every save does a
--      read-modify-write of the entire blob, so any writer with stale data
--      can clobber another writer's keys (e.g. Flow's saveData spreading an
--      empty camperRoster over Me's freshly imported 480-camper roster).
--
-- After: each (camp_id, key) is its own row. Writers UPSERT a single key —
--        physically cannot touch another writer's row.
--
-- Safety: this migration is ADDITIVE. The existing camp_state table is left
--         intact. Code reads from camp_state_kv first and falls back to
--         camp_state until we're confident the new path works. Backfill is
--         idempotent (safe to re-run). RLS policies mirror the existing
--         camp_state policies EXACTLY, using the same get_user_camp_id() /
--         get_user_role() helper functions.
-- ============================================================================

-- ─── 1. New table ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS camp_state_kv (
    camp_id      uuid          NOT NULL,
    key          text          NOT NULL,
    value        jsonb,
    updated_at   timestamptz   NOT NULL DEFAULT now(),
    PRIMARY KEY (camp_id, key)
);

CREATE INDEX IF NOT EXISTS idx_camp_state_kv_camp
    ON camp_state_kv (camp_id);

-- ─── 2. Row-Level Security (mirror camp_state policies exactly) ────────────
-- Your camp_state policies use get_user_camp_id() and get_user_role() helper
-- functions instead of joining camp_users directly. We reuse them so the
-- access semantics are identical:
--   SELECT — any role on the camp
--   INSERT — owner or admin
--   UPDATE — owner or admin
--   DELETE — owner only
ALTER TABLE camp_state_kv ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS camp_state_kv_select ON camp_state_kv;
CREATE POLICY camp_state_kv_select ON camp_state_kv
    FOR SELECT
    USING (camp_id = get_user_camp_id());

DROP POLICY IF EXISTS camp_state_kv_insert ON camp_state_kv;
CREATE POLICY camp_state_kv_insert ON camp_state_kv
    FOR INSERT
    WITH CHECK (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text])
    );

DROP POLICY IF EXISTS camp_state_kv_update ON camp_state_kv;
CREATE POLICY camp_state_kv_update ON camp_state_kv
    FOR UPDATE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text])
    );

DROP POLICY IF EXISTS camp_state_kv_delete ON camp_state_kv;
CREATE POLICY camp_state_kv_delete ON camp_state_kv
    FOR DELETE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = 'owner'::text
    );

-- ─── 3. Realtime publication ───────────────────────────────────────────────
-- Add the new table to supabase_realtime so subscribeToCampState gets
-- postgres_changes events. Wrapped in DO block so re-running is safe.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        BEGIN
            ALTER PUBLICATION supabase_realtime ADD TABLE camp_state_kv;
        EXCEPTION WHEN duplicate_object THEN
            NULL; -- already in publication, fine
        END;
    END IF;
END $$;

-- ─── 4. Backfill from existing camp_state ──────────────────────────────────
-- Explode each row's `state` JSONB into one row per top-level key.
-- ON CONFLICT DO NOTHING means re-running this is a no-op for camps that
-- already have KV rows. The original camp_state row is NEVER modified.
INSERT INTO camp_state_kv (camp_id, key, value, updated_at)
SELECT
    cs.camp_id,
    kv.key,
    kv.value,
    COALESCE(cs.updated_at, now())
FROM camp_state cs,
     LATERAL jsonb_each(cs.state) AS kv(key, value)
WHERE cs.state IS NOT NULL
ON CONFLICT (camp_id, key) DO NOTHING;

-- ─── 5. Sanity check ───────────────────────────────────────────────────────
-- After running the migration, verify counts match. Run this manually:
--
--   SELECT
--     (SELECT COUNT(*)                       FROM camp_state)    AS camps_in_old_table,
--     (SELECT COUNT(DISTINCT camp_id)        FROM camp_state_kv) AS camps_in_new_table,
--     (SELECT COUNT(*)                       FROM camp_state_kv) AS total_kv_rows;
--
-- camps_in_old_table should equal camps_in_new_table.
-- total_kv_rows ≈ sum of jsonb_object_keys per row in the old table
--   (varies per camp — your data shows 2 to ~30 keys per camp).
