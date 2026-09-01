-- ============================================================================
-- Migration 099: let a counselor's POS register actually save a sale
--
-- Bug this fixes: a camper's Gatorade + Water purchase at the Snacks POS
-- (campistry_snacks_pos.html) never showed up on the Manager Dashboard's
-- Item Popularity / Revenue by Category / Transactions — not even after a
-- reload. Root cause: camp_state_kv's INSERT/UPDATE RLS policies (migration
-- 001, widened by 009 for scheduler and 098 for manager) only ever allowed
-- 'owner' | 'admin' | 'manager' | 'scheduler'. 'counselor' was never on that
-- list. submit_canteen_purchase() (migration 026) is SECURITY DEFINER so it
-- bypasses RLS and correctly writes the debit + transaction for ANY camp_users
-- role — but the POS's charge() ALWAYS follows that up with a direct client
-- upsert (campistry_snacks_pos.js's cloudSaveSnacks/_cloudUpsertSnacks) to
-- persist the item soldToday/totalSold counters. That second write is what
-- RLS was silently rejecting for a counselor-logged-in register — Postgres
-- just matches 0 rows under RLS, no error, so cloudSaveSnacks's
-- `if (res.error) console.warn(...)` never even fires. If migration 026
-- itself isn't applied yet, the POS falls back to a local-only charge
-- (campistry_snacks_pos.js's localCharge()) that goes through this SAME
-- upsert for everything — transaction, balance, and inventory counters all
-- at once — so the same silent RLS rejection means NOTHING reaches the
-- cloud at all, matching exactly what was reported.
--
-- Fix: grant 'counselor' INSERT/UPDATE on camp_state_kv, but SCOPED to the
-- 'campistrySnacks' key only — not a blanket write grant. A counselor
-- running the register can save sales; they still cannot touch camp
-- structure, the roster, health data, or any other camp_state_kv key. This
-- is an ADDITIVE policy (Postgres OR-combines multiple permissive policies
-- for the same command), so it doesn't touch or narrow anything migration
-- 098 already grants owner/admin/manager/scheduler.
--
-- Idempotent — safe to re-run.
-- ============================================================================

DROP POLICY IF EXISTS camp_state_kv_insert_counselor_snacks ON camp_state_kv;
CREATE POLICY camp_state_kv_insert_counselor_snacks ON camp_state_kv
    FOR INSERT
    WITH CHECK (
        camp_id = get_user_camp_id()
        AND get_user_role() = 'counselor'::text
        AND key = 'campistrySnacks'::text
    );

DROP POLICY IF EXISTS camp_state_kv_update_counselor_snacks ON camp_state_kv;
CREATE POLICY camp_state_kv_update_counselor_snacks ON camp_state_kv
    FOR UPDATE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = 'counselor'::text
        AND key = 'campistrySnacks'::text
    );

-- ─── Sanity check (run manually after applying) ────────────────────────────
--   SELECT policyname, cmd, qual, with_check
--   FROM pg_policies
--   WHERE tablename = 'camp_state_kv' AND policyname LIKE '%counselor_snacks%';
--   -- expect 2 rows: one INSERT, one UPDATE, both scoped to key='campistrySnacks'
--
-- ─── Confirm migration 026 (submit_canteen_purchase) is actually applied ──
-- If this RPC doesn't exist yet, every POS charge falls back to a fully
-- client-side write — this migration alone fixes that path too, but the
-- atomic daily-limit/overdraft enforcement from 026 is still worth applying:
--   SELECT proname FROM pg_proc WHERE proname = 'submit_canteen_purchase';
--   -- expect 1 row. If empty, paste migrations/026_canteen_limits_and_purchase.sql too.
-- ============================================================================
