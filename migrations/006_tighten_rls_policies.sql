-- ============================================================================
-- Migration: tighten existing RLS policies surfaced by Slice 2 audit
--
-- Two findings from the Slice 2 audit address active gaps in 001/002:
--
--   (A) [HIGH] rotation_counts DELETE allows scheduler — a single scheduler
--       can wipe rotation history for the entire camp via console. Schedulers
--       are limited to their own divisions in client code, but RLS is camp-
--       wide. Restrict DELETE to owner/admin to mirror camp_state_kv's
--       owner-only semantics. Schedulers can still UPDATE their own deltas.
--
--   (B) [MED] camp_state_kv SELECT is open to viewers — viewers (e.g.
--       parents granted view-only access) can read every camper's
--       enrollment / medical / signature / address. The KV store shouldn't
--       be reachable by viewer-tier roles for keys carrying enrollment
--       data. We restrict SELECT to roles that legitimately need the
--       blob: owner / admin / scheduler.
--
--       This is a TIGHTENING. If your viewer flows currently rely on
--       reading anything out of camp_state_kv, surface those reads via a
--       dedicated public view with permissive RLS over a projection.
--
-- Idempotent. DROP POLICY IF EXISTS / CREATE POLICY pattern.
-- ============================================================================

-- ─── (A) rotation_counts DELETE: owner/admin only ─────────────────────────
DROP POLICY IF EXISTS rotation_counts_delete ON rotation_counts;
CREATE POLICY rotation_counts_delete ON rotation_counts
    FOR DELETE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text])
    );

-- ─── (B) camp_state_kv SELECT: drop viewer access ─────────────────────────
DROP POLICY IF EXISTS camp_state_kv_select ON camp_state_kv;
CREATE POLICY camp_state_kv_select ON camp_state_kv
    FOR SELECT
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'scheduler'::text])
    );

-- ─── Sanity check ──────────────────────────────────────────────────────────
-- Verify policy text is what we expect:
--
--   SELECT polname, cmd, qual
--   FROM pg_policies
--   WHERE tablename IN ('camp_state_kv','rotation_counts')
--   ORDER BY tablename, polname;
