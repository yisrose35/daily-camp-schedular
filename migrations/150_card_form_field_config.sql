-- ============================================================================
-- Migration 150: admin-configurable card-form fields for the Campistry-hosted
-- card page.
--
-- WHY: Banquest's OWN hosted Payment Page needs a page + slug that only Banquest
-- can provision (see BANQUEST_HOSTED_SETUP.md), which blocked the redirect
-- model. So card entry goes back to Campistry's own page
-- (campistry_card_setup.html) using Banquest Hosted Tokenization — the card
-- itself is still typed into Banquest's iframe and never touches our servers,
-- but WE own the surrounding form. That means the camp gets to decide which
-- billing fields it collects.
--
-- This matters for money, not just looks: Banquest/AffiniPay runs AVS on
-- billing street + ZIP, and their docs note these fields "should be populated
-- for fraud prevention and to obtain the best rate for E-commerce credit card
-- transactions." A camp that collects address gets better interchange and
-- fewer fraudulent charges; a camp that wants a one-field form can have that.
--
-- Storage: campistryMe.cardFormFields (camp_state_kv), written by the owner UI
-- in the dashboard Payment tab via the normal saveGlobalSettings path.
--
-- Shape — one entry per field, each {enabled, required}:
--   { "name":{"enabled":true,"required":true}, "email":{...}, "phone":{...},
--     "street":{...}, "street2":{...}, "city":{...}, "state":{...},
--     "zip":{...}, "country":{...} }
--
-- get_camp_public_tokenization_key (the one public RPC the card page already
-- calls) is extended to return the resolved config, so the page needs no extra
-- round trip and no auth. A camp that never configures anything gets the
-- AVS-friendly default below. A camp that sets only SOME fields gets the
-- default merged with its overrides, so adding a new field here never breaks
-- an existing camp.
--
-- Idempotent — safe to re-run. Adds no new table and no new grants.
-- ============================================================================

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
    v_configured    jsonb;
    v_fields        jsonb;
    -- AVS-friendly default: collect cardholder name + full billing address
    -- (street/city/state/zip are what AVS and rate qualification use), ask for
    -- email but don't force it, and leave street2/phone/country off so the
    -- common case is a short form.
    v_default       jsonb := '{
        "name":    {"enabled": true,  "required": true},
        "email":   {"enabled": true,  "required": false},
        "phone":   {"enabled": false, "required": false},
        "street":  {"enabled": true,  "required": true},
        "street2": {"enabled": false, "required": false},
        "city":    {"enabled": true,  "required": true},
        "state":   {"enabled": true,  "required": true},
        "zip":     {"enabled": true,  "required": true},
        "country": {"enabled": false, "required": false}
    }'::jsonb;
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

    -- Resolved field config: default, overridden per-field by whatever the camp
    -- configured. `||` replaces a whole per-field object, which is what we want
    -- (a camp saving {"zip":{...}} keeps the defaults for every other field).
    SELECT value #> '{cardFormFields}' INTO v_configured
      FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe';
    IF v_configured IS NULL OR jsonb_typeof(v_configured) <> 'object' THEN
        v_fields := v_default;
    ELSE
        v_fields := v_default || v_configured;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'processorKey', v_processor_key,
        'tokenizationKey', v_decrypted->>'tokenizationKey',
        'tokenizationUrl', v_decrypted->>'tokenizationUrl',
        'cardFormFields', v_fields
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_camp_public_tokenization_key(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_camp_public_tokenization_key(uuid) TO anon, authenticated;

-- ─── Sanity checks (run manually after applying) ───────────────────────────
--   SELECT get_camp_public_tokenization_key('<a connected camp id>');
--   -- expect cardFormFields with all 9 keys, and STILL no sourceKey/pin/apiKey
--   -- anywhere in the result.
-- ============================================================================
