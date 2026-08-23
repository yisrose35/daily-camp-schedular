-- ============================================================================
-- Migration 074: camps.contact_email — a camp's own contact email address.
--
-- Why: the SMS/email broadcast fallback (migrations 070-073) needs a real
-- postal address in every automated email footer (CAN-SPAM) and a sensible
-- Reply-To so a parent's reply reaches the camp, not a noreply@ mailbox.
-- camps.address already exists and is editable on the Dashboard (Camp
-- Profile card) — this adds the matching contact_email column so both can
-- be pulled per-camp instead of one platform-wide default.
-- ============================================================================

ALTER TABLE public.camps ADD COLUMN IF NOT EXISTS contact_email text;

-- Sanity check after running:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'camps' AND column_name = 'contact_email';
