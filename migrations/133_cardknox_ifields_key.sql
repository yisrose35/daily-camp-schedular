-- ============================================================================
-- Migration 133: Cardknox/Sola iFields client-side tokenization.
--
-- campistry_card_setup.html could only render a client-side card-entry
-- widget for Banquest (NMI Collect.js, migration 128) — opening it for a
-- Cardknox/Sola-connected camp showed "not available yet." That blocked
-- EVERY BYOP client flow for a Sola camp: saving a card, a tuition pay
-- link, and canteen deposits (migration 132) all route through this same
-- page. This adds the Cardknox side, mirroring migration 128's Banquest
-- pattern exactly: Cardknox's iFields is Cardknox's own hosted-tokenization
-- component (same PCI-scope-reduction role as NMI's Collect.js) and needs a
-- PUBLIC iFields key (safe to expose client-side — it can only create
-- tokens, never charge or move money) separate from the PRIVATE xKey/
-- apiKey the server uses to actually charge/refund.
--
-- *** The client widget this key feeds (campistry_card_setup.html's
-- renderCardknoxForm) is written from Cardknox's own published iFields
-- sample/docs, NOT yet verified against a live sandbox the way testConnection()
-- and cc:sale already were earlier this session — confirm the CDN version
-- pinned in that file against https://cdn.cardknox.com/ifields/versions.htm
-- and run one real tokenize+save round-trip before relying on it for a real
-- camp. ***
--
-- Idempotent — safe to re-run.
-- ============================================================================

-- Document the new (non-secret) credential field on the Cardknox catalog
-- row, alongside the existing private apiKey — mirrors migration 128's
-- Banquest update exactly. A camp connected before this migration just
-- won't have ifieldsKey in its credentials blob yet and needs it added via
-- one more admin-connect-processor run (same credentials JSON blob, just
-- with this key included this time — admin-connect-processor already
-- stores whatever blob it's given, no code change needed there).
UPDATE payment_processor_catalog
   SET credential_fields = '[
        {"key":"apiKey","label":"Cardknox/Sola Transaction Key (xKey)","secret":true},
        {"key":"ifieldsKey","label":"Cardknox/Sola iFields Key (for iFields — safe to expose client-side)","secret":false}
       ]'::jsonb
 WHERE key = 'cardknox';


-- get_camp_public_tokenization_key (migration 128) hardcoded 'tokenizationKey'
-- as the credential-blob field name — Banquest's name for its public key.
-- Cardknox's is stored as 'ifieldsKey' (a different name, so the office
-- doesn't have to remember which processor calls it what when they run
-- admin-connect-processor). Extended to check either field name and return
-- whichever is present, still under the response's existing 'tokenizationKey'
-- key so the client doesn't need to know the credential blob's internal
-- naming either — it already branches on processorKey to know which widget
-- to render.
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
    v_public_key    text;
BEGIN
    SELECT cred.processor_key, ds.decrypted_secret::jsonb
      INTO v_processor_key, v_decrypted
      FROM camp_processor_credentials cred
      JOIN vault.decrypted_secrets ds ON ds.id = cred.vault_secret_id
     WHERE cred.camp_id = p_camp_id AND cred.status = 'verified';

    IF v_decrypted IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_connected_or_not_verified');
    END IF;

    v_public_key := COALESCE(v_decrypted->>'tokenizationKey', v_decrypted->>'ifieldsKey');

    IF v_public_key IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_tokenization_key_on_file');
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'processorKey', v_processor_key,
        'tokenizationKey', v_public_key
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_camp_public_tokenization_key(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_camp_public_tokenization_key(uuid) TO anon, authenticated;

-- ─── Sanity checks (run manually after applying) ───────────────────────────
--   SELECT credential_fields FROM payment_processor_catalog WHERE key = 'cardknox';
--   -- expect apiKey (secret) + ifieldsKey (not secret)
--
--   SELECT get_camp_public_tokenization_key('<a real Cardknox-connected camp id>');
--   -- expect {"success":true,"processorKey":"cardknox","tokenizationKey":"<the ifieldsKey value>"}
--   -- and NEVER the apiKey value anywhere in the result. If this camp was
--   -- connected before this migration (no ifieldsKey in its credentials
--   -- yet), expect no_tokenization_key_on_file until admin-connect-processor
--   -- is re-run for it with ifieldsKey included in the credentials blob.
-- ============================================================================
