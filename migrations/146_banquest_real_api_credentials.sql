-- ============================================================================
-- Migration 146: correct the Banquest credential shape for the REAL Banquest
-- (AffiniPay / 8am) API — not NMI.
--
-- Migrations 127/128 registered Banquest assuming it was a white-label NMI
-- reseller (secure.nmi.com, a single `securityKey`, url-encoded Direct Post).
-- That was wrong: Banquest runs on the AffiniPay/8am JSON API. Auth is HTTP
-- Basic base64(sourceKey:pin); the client tokenizer is Banquest's own Hosted
-- Tokenization script (a `pk_` key), served from a per-environment host that
-- is NOT the API host — so the public card page needs that script URL too.
--
-- This migration:
--   1. rewrites the Banquest catalog credential_fields to sourceKey + pin +
--      tokenizationKey + gatewayUrl (API base) + tokenizationUrl (script base)
--   2. extends get_camp_public_tokenization_key to also return tokenizationUrl,
--      so campistry_card_setup.html can load Banquest's tokenizer from the
--      right (sandbox vs prod) host.
--
-- A camp connected under the old (NMI-shaped) Banquest fields must be
-- reconnected via admin-connect-processor with the new fields. No Banquest
-- camp is live yet, so there's nothing to migrate in data.
--
-- Idempotent — safe to re-run.
-- ============================================================================

UPDATE payment_processor_catalog
   SET credential_fields = '[
        {"key":"sourceKey","label":"Banquest Source Key","secret":true},
        {"key":"pin","label":"Banquest PIN","secret":true},
        {"key":"tokenizationKey","label":"Banquest Public Tokenization Key (pk_… — safe to expose client-side)","secret":false},
        {"key":"gatewayUrl","label":"API base URL (sandbox https://sandbox.banquestgateway.com · prod https://api.banquestgateway.com)","secret":false},
        {"key":"tokenizationUrl","label":"Hosted tokenization script URL (e.g. https://tokenization.sandbox.banquestgateway.com/tokenization/v0.3)","secret":false}
       ]'::jsonb
 WHERE key = 'banquest';


-- get_camp_public_tokenization_key — now also returns the (non-secret)
-- tokenizationUrl so the card page loads the right tokenizer host. Still
-- NEVER returns the private sourceKey/pin. Cardknox camps (which have no
-- tokenizationUrl in their credential) simply get null for it, unchanged.
CREATE OR REPLACE FUNCTION public.get_camp_public_tokenization_key(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, vault, pg_catalog
AS $$
DECLARE
    v_processor_key text;
    v_decrypted     jsonb;
BEGIN
    SELECT cred.processor_key, ds.decrypted_secret::jsonb
      INTO v_processor_key, v_decrypted
      FROM camp_processor_credentials cred
      JOIN vault.decrypted_secrets ds ON ds.id = cred.vault_secret_id
     WHERE cred.camp_id = p_camp_id AND cred.status = 'verified';

    IF v_decrypted IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_connected_or_not_verified');
    END IF;

    IF NOT (v_decrypted ? 'tokenizationKey') THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_tokenization_key_on_file');
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'processorKey', v_processor_key,
        'tokenizationKey', v_decrypted->>'tokenizationKey',
        'tokenizationUrl', v_decrypted->>'tokenizationUrl'
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_camp_public_tokenization_key(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_camp_public_tokenization_key(uuid) TO anon, authenticated;

-- ─── Sanity checks (run manually after applying) ───────────────────────────
--   SELECT credential_fields FROM payment_processor_catalog WHERE key = 'banquest';
--   -- expect sourceKey, pin, tokenizationKey, gatewayUrl, tokenizationUrl
--
--   SELECT get_camp_public_tokenization_key('<a connected banquest camp id>');
--   -- expect {"success":true,"processorKey":"banquest","tokenizationKey":"pk_…","tokenizationUrl":"https://…"}
--   -- and NEVER sourceKey/pin anywhere in the result.
-- ============================================================================
