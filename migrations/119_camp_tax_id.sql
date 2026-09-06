-- 119_camp_tax_id.sql
-- Adds a general-purpose Tax ID / EIN field to a camp's profile, with a
-- toggle for whether it's shown on printed Billing statements. Distinct
-- from the existing telnyx_biz_name/telnyx_ein-style fields, which are
-- scoped exclusively to Telnyx texting-number registration and not
-- reusable for this purpose.
--
-- Paste this whole file into the Supabase SQL Editor and run it.

ALTER TABLE public.camps
    ADD COLUMN IF NOT EXISTS tax_id text;

ALTER TABLE public.camps
    ADD COLUMN IF NOT EXISTS show_tax_id_on_statements boolean NOT NULL DEFAULT false;

-- Verify after running:
--   SELECT column_name, data_type, column_default
--   FROM information_schema.columns
--   WHERE table_name = 'camps' AND column_name IN ('tax_id','show_tax_id_on_statements');
