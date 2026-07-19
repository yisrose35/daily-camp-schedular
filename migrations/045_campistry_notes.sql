-- ============================================================================
-- Migration: campistry_notes — per-user notes, private unless shared
--
-- Notes were personal but stored in a per-user camp_state_kv blob
-- (campistryNotes:<userId>), which is camp-scoped and therefore readable by any
-- camp admin. This moves notes into their own table with row-level security so
-- they're PRIVATE to their owner, EXCEPT notes explicitly shared by email, which
-- the shared-with recipients can read.
--
--   - owner sees + edits their own notes.
--   - a note with is_shared = true is READABLE by any signed-in user whose email
--     is in shared_with (stored lowercased). Recipients get read-only access
--     (only the owner can INSERT/UPDATE/DELETE).
-- ============================================================================

CREATE TABLE IF NOT EXISTS campistry_notes (
    id           text        PRIMARY KEY,               -- client-generated note id
    camp_id      uuid        NOT NULL,
    owner_id     uuid        NOT NULL,                  -- auth.uid() of the creator
    title        text        NOT NULL DEFAULT '',
    body         text        NOT NULL DEFAULT '',
    color        text        NOT NULL DEFAULT 'yellow',
    pinned       boolean     NOT NULL DEFAULT false,
    tags         jsonb       NOT NULL DEFAULT '[]'::jsonb,
    shared_with  jsonb       NOT NULL DEFAULT '[]'::jsonb,  -- array of lowercased emails
    is_shared    boolean     NOT NULL DEFAULT false,
    reminder     timestamptz,
    trashed      boolean     NOT NULL DEFAULT false,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_campistry_notes_owner ON campistry_notes (camp_id, owner_id);
CREATE INDEX IF NOT EXISTS idx_campistry_notes_shared ON campistry_notes USING gin (shared_with);

ALTER TABLE campistry_notes ENABLE ROW LEVEL SECURITY;

-- Read: your own notes, plus notes shared with your email.
DROP POLICY IF EXISTS campistry_notes_select ON campistry_notes;
CREATE POLICY campistry_notes_select ON campistry_notes
    FOR SELECT
    USING (
        owner_id = auth.uid()
        OR (is_shared AND shared_with ? lower(coalesce(auth.jwt() ->> 'email', '')))
    );

-- Only the owner may create / change / remove a note.
DROP POLICY IF EXISTS campistry_notes_insert ON campistry_notes;
CREATE POLICY campistry_notes_insert ON campistry_notes
    FOR INSERT WITH CHECK (owner_id = auth.uid());

DROP POLICY IF EXISTS campistry_notes_update ON campistry_notes;
CREATE POLICY campistry_notes_update ON campistry_notes
    FOR UPDATE USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

DROP POLICY IF EXISTS campistry_notes_delete ON campistry_notes;
CREATE POLICY campistry_notes_delete ON campistry_notes
    FOR DELETE USING (owner_id = auth.uid());

-- ─── Sanity check ─────────────────────────────────────────────────────────────
--   SELECT tablename FROM pg_tables WHERE tablename = 'campistry_notes';
--   SELECT polname FROM pg_policy WHERE polrelid = 'campistry_notes'::regclass;
