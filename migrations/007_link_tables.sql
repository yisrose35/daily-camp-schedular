-- ============================================================================
-- Migration: link_outbox + link_broadcasts — Campistry Link cloud persistence
--
-- Why: campistry_link_v1 in localStorage loses all message/notification
--      history when the browser is cleared, and can't be read on another
--      device. This migration moves the row-level data (sent notifications,
--      broadcasts) out of the localStorage JSON blob and into dedicated
--      tables with proper multi-tenant RLS.
--
--      The remaining small state (settings, templates, drafts) stays in
--      camp_state_kv under key 'campistryLink' — same pattern as the rest
--      of the app.
--
-- Tables:
--   link_outbox     — one row per notification/message sent to a parent
--   link_broadcasts — one row per mass-send / broadcast
--
-- RLS: mirrors 001_camp_state_kv.sql exactly using get_user_camp_id() and
--      get_user_role() helper functions.
--   SELECT  — owner / admin / scheduler
--   INSERT  — owner / admin
--   UPDATE  — owner / admin (status updates: queued → sent → delivered)
--   DELETE  — owner / admin
-- ============================================================================

-- ─── 1. link_outbox ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS link_outbox (
    id            uuid          NOT NULL DEFAULT gen_random_uuid(),
    camp_id       uuid          NOT NULL,
    type          text          NOT NULL,  -- bus_stop | bunk_assignment | daily_schedule | manual
    camper_name   text,
    camper_id     integer,                 -- roster camperId for parent linkage
    parent_name   text,
    parent_email  text,
    parent_phone  text,
    subject       text,
    body          text,
    channels      jsonb         NOT NULL DEFAULT '["app"]',  -- ['app','email','sms']
    status        text          NOT NULL DEFAULT 'queued',   -- queued | sent | delivered | failed
    created_at    timestamptz   NOT NULL DEFAULT now(),
    sent_at       timestamptz,
    PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_link_outbox_camp
    ON link_outbox (camp_id);

CREATE INDEX IF NOT EXISTS idx_link_outbox_camp_created
    ON link_outbox (camp_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_link_outbox_camp_type
    ON link_outbox (camp_id, type);

ALTER TABLE link_outbox ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS link_outbox_select ON link_outbox;
CREATE POLICY link_outbox_select ON link_outbox
    FOR SELECT
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'scheduler'::text])
    );

DROP POLICY IF EXISTS link_outbox_insert ON link_outbox;
CREATE POLICY link_outbox_insert ON link_outbox
    FOR INSERT
    WITH CHECK (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text])
    );

DROP POLICY IF EXISTS link_outbox_update ON link_outbox;
CREATE POLICY link_outbox_update ON link_outbox
    FOR UPDATE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text])
    );

DROP POLICY IF EXISTS link_outbox_delete ON link_outbox;
CREATE POLICY link_outbox_delete ON link_outbox
    FOR DELETE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text])
    );

-- ─── 2. link_broadcasts ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS link_broadcasts (
    id               uuid        NOT NULL DEFAULT gen_random_uuid(),
    camp_id          uuid        NOT NULL,
    subject          text,
    body             text,
    channels         jsonb       NOT NULL DEFAULT '["app"]',
    recipient_filter jsonb,      -- { type, division, grade, bunk, ... }
    recipient_count  integer     NOT NULL DEFAULT 0,
    created_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_link_broadcasts_camp
    ON link_broadcasts (camp_id);

CREATE INDEX IF NOT EXISTS idx_link_broadcasts_camp_created
    ON link_broadcasts (camp_id, created_at DESC);

ALTER TABLE link_broadcasts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS link_broadcasts_select ON link_broadcasts;
CREATE POLICY link_broadcasts_select ON link_broadcasts
    FOR SELECT
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'scheduler'::text])
    );

DROP POLICY IF EXISTS link_broadcasts_insert ON link_broadcasts;
CREATE POLICY link_broadcasts_insert ON link_broadcasts
    FOR INSERT
    WITH CHECK (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text])
    );

DROP POLICY IF EXISTS link_broadcasts_update ON link_broadcasts;
CREATE POLICY link_broadcasts_update ON link_broadcasts
    FOR UPDATE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text])
    );

DROP POLICY IF EXISTS link_broadcasts_delete ON link_broadcasts;
CREATE POLICY link_broadcasts_delete ON link_broadcasts
    FOR DELETE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text])
    );

-- ─── 3. Realtime publication ──────────────────────────────────────────────────
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        BEGIN
            ALTER PUBLICATION supabase_realtime ADD TABLE link_outbox;
        EXCEPTION WHEN duplicate_object THEN NULL;
        END;
        BEGIN
            ALTER PUBLICATION supabase_realtime ADD TABLE link_broadcasts;
        EXCEPTION WHEN duplicate_object THEN NULL;
        END;
    END IF;
END $$;

-- ─── 4. Sanity check ──────────────────────────────────────────────────────────
-- After running, verify tables exist with RLS enabled:
--
--   SELECT tablename, rowsecurity
--   FROM pg_tables
--   WHERE tablename IN ('link_outbox','link_broadcasts')
--     AND schemaname = 'public';
--
-- Verify policies:
--
--   SELECT polname, cmd, qual
--   FROM pg_policies
--   WHERE tablename IN ('link_outbox','link_broadcasts')
--   ORDER BY tablename, polname;
