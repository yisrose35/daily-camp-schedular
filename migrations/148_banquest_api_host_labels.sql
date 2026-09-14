-- ============================================================================
-- Migration 148: correct the Banquest gatewayUrl guidance to the REAL API host.
--
-- Migration 146's credential_fields told the operator to enter the API base as
-- the DASHBOARD host (sandbox https://sandbox.banquestgateway.com). Confirmed
-- against the Banquest API v2 docs (Sep 2026), that's wrong: the login/dashboard
-- host and the API host are DIFFERENT machines. The v2 REST API lives at:
--
--     sandbox : https://api.sandbox.banquestgateway.com/api/v2
--     prod    : https://api.banquestgateway.com/api/v2
--
-- The inlined edge-function callers now defensively append /api/v2 when a bare
-- host is stored, but they CANNOT rewrite a wrong hostname
-- (sandbox.banquestgateway.com → api.sandbox.banquestgateway.com). So the
-- stored gatewayUrl must carry the correct API host. This migration only
-- rewrites the operator-facing labels/examples so future onboarding enters the
-- right value; a camp already connected with the dashboard host must be
-- reconnected via admin-connect-processor with the corrected gatewayUrl.
--
-- Idempotent — safe to re-run.
-- ============================================================================

UPDATE payment_processor_catalog
   SET credential_fields = '[
        {"key":"sourceKey","label":"Banquest Source Key","secret":true},
        {"key":"pin","label":"Banquest PIN","secret":true},
        {"key":"tokenizationKey","label":"Banquest Public Tokenization Key (pk_… — safe to expose client-side)","secret":false},
        {"key":"gatewayUrl","label":"API base URL (sandbox https://api.sandbox.banquestgateway.com/api/v2 · prod https://api.banquestgateway.com/api/v2)","secret":false},
        {"key":"tokenizationUrl","label":"Hosted tokenization script URL (e.g. https://tokenization.sandbox.banquestgateway.com/tokenization/v0.3)","secret":false}
       ]'::jsonb
 WHERE key = 'banquest';

-- ─── Sanity check (run manually after applying) ────────────────────────────
--   SELECT credential_fields FROM payment_processor_catalog WHERE key = 'banquest';
--   -- gatewayUrl example should now read the api.sandbox… host with /api/v2.
--
-- ─── Reconnect the sandbox test camp with the corrected API base ───────────
-- (do this from admin-connect-processor — it re-tests the credential live and
--  re-stores it; the gatewayUrl below is the only field that changes):
--     gatewayUrl = https://api.sandbox.banquestgateway.com/api/v2
-- ============================================================================
