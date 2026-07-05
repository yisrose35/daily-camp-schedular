-- ============================================================================
-- Migration: allow SCHEDULERS to WRITE camp_state_kv (INSERT + UPDATE)
--
-- Why (LG-2): league results, league history (leagueHistory / leagueRoundState
--      / leaguesByName) and other camp-wide state a scheduler generates live in
--      camp_state_kv, which migration 001 restricted to owner/admin for
--      INSERT/UPDATE. So a scheduler's saves were blocked by RLS and silently
--      dropped — the client logged "saved to cloud" but the write never landed,
--      so the owner saw no games for a scheduler-generated day. Per camp policy
--      schedulers now need to save their work, so grant scheduler the same
--      INSERT/UPDATE access owner/admin already have. Migration 006 already
--      grants scheduler SELECT.
--
-- ⚠ TRADE-OFF (explicitly accepted): camp_state_kv writes are WHOLE-KEY —
--      last-writer-wins, no merge (except the app1 / campistryMe fetch-merge in
--      client code). With schedulers able to write any key, a scheduler saving a
--      key from a STALE in-memory copy can overwrite another writer's value for
--      that key (e.g. overwrite the owner's facilities/rules/divisions). That is
--      the deliberate boundary migration 001 created; it is being relaxed here on
--      purpose. DELETE stays owner-only (deleting camp_state keys wipes camp-wide
--      config/history wholesale, so keep it owner-gated).
--
-- Pairs with the client change in integration_hooks.js (_canWriteCampState now
-- returns true for 'scheduler'). Apply this migration BEFORE/with deploying that
-- code so scheduler writes succeed instead of 403-ing (the client catches the
-- 403 either way, so generation is never killed, but the data only lands once
-- this policy is in place).
--
-- Idempotent. DROP POLICY IF EXISTS / CREATE POLICY pattern; reuses the existing
-- get_user_camp_id() / get_user_role() helpers so the semantics match 001/006.
-- ============================================================================

-- ─── camp_state_kv INSERT: owner / admin / scheduler ──────────────────────
DROP POLICY IF EXISTS camp_state_kv_insert ON camp_state_kv;
CREATE POLICY camp_state_kv_insert ON camp_state_kv
    FOR INSERT
    WITH CHECK (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'scheduler'::text])
    );

-- ─── camp_state_kv UPDATE: owner / admin / scheduler ──────────────────────
DROP POLICY IF EXISTS camp_state_kv_update ON camp_state_kv;
CREATE POLICY camp_state_kv_update ON camp_state_kv
    FOR UPDATE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'scheduler'::text])
    );

-- DELETE intentionally UNCHANGED (owner-only, from migration 001).

-- ─── Sanity check (run manually after applying) ────────────────────────────
--   SELECT policyname, cmd, roles, qual, with_check
--   FROM pg_policies
--   WHERE tablename = 'camp_state_kv'
--   ORDER BY policyname;
--
-- Expect camp_state_kv_insert (cmd=INSERT) + camp_state_kv_update (cmd=UPDATE)
-- to list 'scheduler' alongside 'owner'/'admin'; camp_state_kv_delete still
-- owner-only; camp_state_kv_select owner/admin/scheduler.
