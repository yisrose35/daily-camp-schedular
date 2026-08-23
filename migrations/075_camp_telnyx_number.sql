-- ============================================================================
-- Migration 075: camps.telnyx_from_number — a camp's own SMS sending number.
--
-- Why: sharing one platform-wide Telnyx number across every camp means one
-- camp's parents marking messages as spam (or just not engaging) can hurt
-- carrier trust — and therefore deliverability — for every OTHER camp
-- sharing that number. It also caps everyone under Telnyx's shared/
-- "Low Volume" throughput tier (~6,000 segments/day, 1-3 msg/sec, combined
-- across the whole platform). Per-camp numbers isolate reputation, let each
-- camp scale to its own "Standard" 10DLC campaign independently, and mean a
-- parent always sees the same recognizable number for their camp.
--
-- This column is populated manually for now (the camp owner buys/provisions
-- a number in Telnyx themselves and pastes it in on the Dashboard, same
-- pattern as camps.address/contact_email) — no auto-provisioning via the
-- Telnyx API in this pass. NULL means "hasn't set one up yet"; the sending
-- functions fall back to the platform-wide TELNYX_FROM_NUMBER secret for
-- any camp without its own, so nothing breaks for camps that never set one.
-- ============================================================================

ALTER TABLE public.camps ADD COLUMN IF NOT EXISTS telnyx_from_number text;

-- Sanity check after running:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'camps' AND column_name = 'telnyx_from_number';
