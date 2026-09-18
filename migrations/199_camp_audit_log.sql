-- ============================================================================
-- Migration: camp_audit_log — append-only "who changed what when" activity log
--
-- Why: change attribution previously lived only implicitly in per-record
--      updated_at fields (and a per-camper history timeline). There was no
--      camp-wide log an owner could open to see who did significant actions
--      (merges, deletions, imports, destructive schedule resets). calendar.js
--      already tried to write to `camp_audit_log`, but the table was never
--      created, so those inserts failed silently. This creates it and opens it
--      to the whole app.
--
-- Schema: one immutable row per logged action. Never updated or deleted (no
--         UPDATE/DELETE policies — RLS denies both by default), so the log is
--         tamper-resistant.
-- ============================================================================

-- ─── 1. Table ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS camp_audit_log (
    id          uuid          NOT NULL DEFAULT gen_random_uuid(),
    camp_id     uuid          NOT NULL,
    user_id     uuid,
    user_email  text,
    user_role   text,
    action      text          NOT NULL,
    details     jsonb,
    created_at  timestamptz   NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_camp_audit_log_camp_time
    ON camp_audit_log (camp_id, created_at DESC);

-- ─── 2. Row-Level Security (mirror camp_state_kv / rotation_counts) ──────────
ALTER TABLE camp_audit_log ENABLE ROW LEVEL SECURITY;

-- Any authenticated member of the camp may APPEND an entry (so their own
-- actions get recorded), but the row must be for their own camp.
DROP POLICY IF EXISTS camp_audit_log_insert ON camp_audit_log;
CREATE POLICY camp_audit_log_insert ON camp_audit_log
    FOR INSERT
    WITH CHECK (camp_id = get_user_camp_id());

-- Only owners/admins/managers may READ the log.
DROP POLICY IF EXISTS camp_audit_log_select ON camp_audit_log;
CREATE POLICY camp_audit_log_select ON camp_audit_log
    FOR SELECT
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'manager'::text])
    );

-- Deliberately NO update/delete policies: the log is append-only and immutable.
