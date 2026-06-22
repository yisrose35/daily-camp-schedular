-- ============================================================================
-- Migration: allow a user to own more than one camp (Debug Copy)
--
-- camps.owner has BOTH:
--   • a foreign key (camps_owner_fkey) → auth.users(id)  — owner must be real
--   • a UNIQUE constraint (camps_owner_key)              — one camp per owner
--
-- A debug copy must be owned by a real user (the FK), and the only real user we
-- can use is the super-admin themselves — but they already own their real camp,
-- so the UNIQUE constraint blocks the second (copy) camp.
--
-- Drop ONLY the unique constraint. The FK stays (owner is still a real user).
-- Multi-camp ownership is already handled deterministically by
-- get_user_camp_id() (migration 010, prefers id = uid) and by the client
-- owner-detection paths (prefer the camp whose id == uid = the real camp;
-- copies are entered via team membership, not ownership).
--
-- Idempotent.
-- ============================================================================

ALTER TABLE public.camps DROP CONSTRAINT IF EXISTS camps_owner_key;

-- Sanity check: should list camps_owner_fkey (FK) but NOT camps_owner_key.
--   SELECT conname, contype FROM pg_constraint
--    WHERE conrelid = 'public.camps'::regclass AND conname LIKE 'camps_owner%';
