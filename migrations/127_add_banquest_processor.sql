-- ============================================================================
-- Migration 127: register Banquest in the BYOP processor catalog
--
-- Follow-up to migration 126 (payment_processor_catalog framework) — a
-- separate migration rather than editing 126 in place, since 126 may
-- already have been pasted into the SQL Editor by the time this exists.
-- The real at-risk prospect this whole feature was built for uses Banquest
-- directly, so it's the second adapter (after the Cardknox reference
-- implementation) — see supabase/functions/_shared/adapters/banquest_adapter.ts.
--
-- Idempotent — safe to re-run.
-- ============================================================================

INSERT INTO payment_processor_catalog (key, label, credential_fields, capabilities, adapter_module) VALUES
    ('banquest', 'Banquest',
     '[{"key":"securityKey","label":"Banquest/NMI Security Key","secret":true},
       {"key":"gatewayUrl","label":"Gateway URL (only if Banquest gave you a branded one — defaults to secure.nmi.com)","secret":false}]'::jsonb,
     '{"charge":true,"refund":true,"recurring":"NMI supports recurring/Customer Vault schedules, not yet wired into charge-due-installments","ach":"NMI-account-dependent, confirm with Banquest","tokenization":true,"nativeSurcharge":"per-account, confirm with Banquest"}'::jsonb,
     'supabase/functions/_shared/adapters/banquest_adapter.ts')
ON CONFLICT (key) DO NOTHING;

-- ─── Sanity check (run manually after applying) ────────────────────────────
--   SELECT key, label, active FROM payment_processor_catalog ORDER BY key;
--   -- expect: banquest, cardknox, stripe
-- ============================================================================
