-- ============================================================================
-- Migration: add the COUNSELOR role for Campistry Lite (mobile companion)
--
-- Campistry Lite gives bunk counselors a read-only mobile view of:
--   * their bunk's daily schedule   (daily_schedules — SELECT already
--     role-agnostic per migration 003: camp_id = get_user_camp_id())
--   * their bunk roster + league teams (camp_state_kv keys app1.camperRoster,
--     leaguesByName, specialtyLeagues — SELECT was restricted to
--     owner/admin/scheduler by migration 006, so counselor must be added)
--   * their assignment record (camp_state_kv key liteStaffAssignments,
--     written by head staff from the Lite admin UI)
--
-- Counselors get NO write access anywhere: they are excluded from every
-- INSERT/UPDATE/DELETE policy, mirroring the client-side read-only gates
-- added to access_control.js (isReadOnlyRole).
--
-- Idempotent: constraint is dropped-if-exists and recreated; policies use
-- the DROP POLICY IF EXISTS / CREATE POLICY pattern from migrations 001-009.
-- ============================================================================

-- ─── 1. camp_users role CHECK constraint ───────────────────────────────────
-- The live constraint (created via the Supabase dashboard, referenced in
-- supabase_client.js) allows 'admin','scheduler','viewer' — note 'owner' is
-- deliberately NOT a camp_users role (owners live in camps.owner).
-- Recreate it with 'counselor' included.
ALTER TABLE camp_users DROP CONSTRAINT IF EXISTS camp_users_role_check;
ALTER TABLE camp_users ADD CONSTRAINT camp_users_role_check
    CHECK (role = ANY (ARRAY[
        'admin'::text,
        'scheduler'::text,
        'viewer'::text,
        'counselor'::text
    ]));

-- ─── 2. camp_state_kv SELECT: allow counselor to READ camp state ───────────
-- Migration 006 tightened SELECT to owner/admin/scheduler (dropping viewer).
-- Counselors need read access for camp structure, camper roster, leagues,
-- and their own liteStaffAssignments record. Writes stay owner/admin/
-- scheduler (migrations 001 + 009) — intentionally unchanged.
DROP POLICY IF EXISTS camp_state_kv_select ON camp_state_kv;
CREATE POLICY camp_state_kv_select ON camp_state_kv
    FOR SELECT
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY[
            'owner'::text, 'admin'::text, 'scheduler'::text, 'counselor'::text
        ])
    );

-- ─── 3. daily_schedules ────────────────────────────────────────────────────
-- No change required: daily_schedules_select (migration 003) is already
-- role-agnostic (camp_id = get_user_camp_id()), and counselors are excluded
-- from INSERT/UPDATE/DELETE because those policies enumerate roles.

-- ─── Sanity check (run manually after applying) ────────────────────────────
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint WHERE conname = 'camp_users_role_check';
--
--   SELECT policyname, cmd, qual
--   FROM pg_policies WHERE tablename = 'camp_state_kv'
--   ORDER BY policyname;
--
-- Expect: role check lists counselor; camp_state_kv_select lists counselor;
-- camp_state_kv_insert/update still owner/admin/scheduler; delete owner-only.
