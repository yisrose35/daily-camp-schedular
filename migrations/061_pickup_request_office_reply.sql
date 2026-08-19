-- ============================================================================
-- Migration: office reply on parent_pickup_requests
--
-- migration 025 built parent_pickup_requests (status/reviewed_at/reviewed_by)
-- as the real cloud channel for a parent's early-pickup / pickup-change /
-- going-with-a-friend / late-arrival request, but it was never wired to
-- anything — Link's parent portal kept riding the generic link_messages
-- channel instead, and Live kept string-parsing message subjects to fake
-- pickup requests out of it. Neither side ever gets a reply: today Confirm/
-- Decline only mark a message read, so a parent never learns whether their
-- request was approved.
--
-- This adds one column so the office can leave a real note (canned or free
-- text) when reviewing a request, and the parent portal (already covered by
-- the ppr_parent_read policy from migration 025, which is `SELECT *`) can
-- show it back to them. Idempotent, additive only — no other change to 025's
-- table, RLS, or RPC.
-- ============================================================================

ALTER TABLE public.parent_pickup_requests
    ADD COLUMN IF NOT EXISTS office_message text;

-- Sanity check (manual, run after applying):
-- SELECT column_name FROM information_schema.columns
-- WHERE table_name = 'parent_pickup_requests' AND column_name = 'office_message';
