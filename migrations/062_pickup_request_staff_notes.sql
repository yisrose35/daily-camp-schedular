-- ============================================================================
-- Migration: internal staff notes on parent_pickup_requests
--
-- office_message (migration 061) is the office's reply BACK to the parent —
-- visible to them. This adds a second, parent-invisible column so staff can
-- jot working notes on a request ("called mom, confirmed", "bus already
-- left, redirecting to carpool") without that text ever being exposed via
-- the parent-facing ppr_parent_read policy's `SELECT *`. Since that policy
-- is a blanket SELECT *, staff_notes must stay out of any query path the
-- parent portal uses — campistry_link_parent.html never selects this table
-- directly today (it only INSERTs via the RPC), so there is nothing to
-- audit there; if a parent-facing read of this table is ever added, exclude
-- staff_notes from its column list explicitly.
-- ============================================================================

ALTER TABLE public.parent_pickup_requests
    ADD COLUMN IF NOT EXISTS staff_notes text;

-- Sanity check (manual, run after applying):
-- SELECT column_name FROM information_schema.columns
-- WHERE table_name = 'parent_pickup_requests' AND column_name = 'staff_notes';
