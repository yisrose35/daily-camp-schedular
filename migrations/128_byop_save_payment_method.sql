-- ============================================================================
-- Migration 128: BYOP — let a family actually get a saved payment method
--
-- Migrations 126/127 built the charge/refund plumbing and the Banquest/
-- Cardknox adapters, but nothing yet could put a BYOP family INTO the
-- "has a customerRef on file" state payments-charge/payments-refund expect
-- — this closes that gap.
--
-- Both NMI (Banquest) and Cardknox tokenize card data CLIENT-SIDE (NMI's
-- "Collect.js", Cardknox's "iFields") — the same PCI-scope-reduction role
-- Stripe.js/Elements already plays for the Stripe flows. Raw card numbers
-- never reach Campistry's servers either way. The wrinkle specific to this
-- model: the client-side tokenizer needs a PUBLIC tokenization key
-- (safe to expose in a browser — it can only create tokens, not charge or
-- move money), separate from the PRIVATE security key/API key the server
-- uses to actually charge/refund. The existing camp_processor_credentials
-- Vault secret already holds the private key; this migration adds a way to
-- fetch ONLY the public tokenization key anonymously, without ever
-- exposing the private one.
--
-- Idempotent — safe to re-run.
-- ============================================================================

-- Document the new (non-secret) credential field on the Banquest catalog
-- row. Existing connected camps aren't affected — this is additive
-- metadata, not a schema change to camp_processor_credentials itself
-- (which already stores the whole credentials JSON blob per camp; a camp
-- connected before this migration just won't have tokenizationKey in that
-- blob yet and needs it added via one more admin-connect-processor run).
UPDATE payment_processor_catalog
   SET credential_fields = '[
        {"key":"securityKey","label":"Banquest/NMI Security Key","secret":true},
        {"key":"tokenizationKey","label":"Banquest/NMI Public Tokenization Key (for Collect.js — safe to expose client-side)","secret":false},
        {"key":"gatewayUrl","label":"Gateway URL (only if Banquest gave you a branded one — defaults to secure.nmi.com)","secret":false}
       ]'::jsonb
 WHERE key = 'banquest';


-- ─── get_camp_public_tokenization_key ───────────────────────────────────────
-- Deliberately anon-callable — the card-setup page a family opens has no
-- session. Returns ONLY the processor key + its public tokenization key,
-- NEVER the private security/API key sitting in the same Vault secret.
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
        'tokenizationKey', v_decrypted->>'tokenizationKey'
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_camp_public_tokenization_key(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_camp_public_tokenization_key(uuid) TO anon, authenticated;

-- ─── Sanity checks (run manually after applying) ───────────────────────────
--   SELECT proname, proacl FROM pg_proc WHERE proname = 'get_camp_public_tokenization_key';
--   -- expect: grants to anon + authenticated.
--
--   SELECT get_camp_public_tokenization_key('<a connected camp id>');
--   -- expect {"success":true,"processorKey":"banquest","tokenizationKey":"..."}
--   -- and NEVER the securityKey value anywhere in the result.
-- ============================================================================
