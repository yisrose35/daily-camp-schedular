-- ═══════════════════════════════════════════════════════════════════════════
-- CAMPISTRY — payments, billing and access bundle
--
-- GENERATED FILE — do not edit by hand.
-- Rebuild with:  python3 scripts/build-migration-bundle.py
--
-- Run this whole file in the Supabase SQL Editor. SAFE TO RE-RUN as often as
-- you like: every statement is CREATE OR REPLACE, IF NOT EXISTS, ON CONFLICT DO
-- NOTHING, or an UPDATE whose WHERE clause matches nothing once applied.
-- Running it a second time changes nothing.
--
-- WHY A BUNDLE: there is no migration runner here — migrations are pasted in by
-- hand — and numbers 146-151 were each used TWICE in this repo (once by the
-- payments work, once by the bank-deposit/template work), so "have I run 150?"
-- is ambiguous. This contains only the payments/access set, in dependency
-- order, so you can run it and know the whole set is in place.
--
-- WHAT YOU WILL NOTICE AFTERWARDS:
--   * Parents stop being told they owe money they already paid (152).
--   * Cards saved on Campistry's card page appear under Link -> Cards (151).
--   * Stripe is no longer the default processor; a camp that has not connected
--     one reads 'none' and online payments stay off until it does (153).
--   * !! Section access starts actually applying (154). Until now it silently
--     granted full access to every ungrouped staff member, so anyone you had
--     configured with restrictions has been seeing everything. They will now be
--     gated as intended — tell your staff before running this, so a suddenly
--     restricted person isn't reported to you as a regression.
--
-- PREREQUISITES (long since applied on a live camp; the preflight below fails
-- loudly rather than confusingly if one is missing): 077 (camp Stripe Connect),
-- 126 (BYOP framework), 129/130 (disconnect RPCs), 137/139 (saved cards),
-- 097 (access groups).
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Preflight: fail with a readable message instead of a confusing error
-- ─── several hundred lines down.
DO $preflight$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_name='camp_state_kv') THEN
        RAISE EXCEPTION 'No camp_state_kv table — this is not a Campistry database.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='camps' AND column_name='payment_processor_key') THEN
        RAISE EXCEPTION 'Missing camps.payment_processor_key — apply migration 126 (BYOP framework) first.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='camps' AND column_name='stripe_account_id') THEN
        RAISE EXCEPTION 'Missing camps.stripe_account_id — apply migration 077 (camp Stripe Connect) first.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_name='payment_processor_catalog') THEN
        RAISE EXCEPTION 'Missing payment_processor_catalog — apply migration 126 first.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_name='camp_access_groups') THEN
        RAISE EXCEPTION 'Missing camp_access_groups — apply migration 097 (access groups) first.';
    END IF;
    RAISE NOTICE 'Preflight OK — applying bundle.';
END
$preflight$;


-- #########################################################################
-- ###### 146_banquest_real_api_credentials
-- ###### Banquest credential shape (sourceKey/pin/tokenizationKey/gatewayUrl/tokenizationUrl)
-- #########################################################################

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


-- #########################################################################
-- ###### 147_clear_stale_byop_cards_on_switch
-- ###### Scrub saved cards belonging to a processor the camp no longer uses
-- #########################################################################

-- ============================================================================
-- Migration 147: clear stale saved cards when a camp (re)connects a processor
--
-- A saved card is tied to the processor it was tokenized on — a Cardknox
-- token can't be charged through Banquest, a Stripe customer can't be charged
-- through a BYOP gateway, etc. When a camp switches processors, every
-- family's/camper's saved card from the OLD processor becomes dead weight:
-- it still shows as "card on file" in Link and Me, and any charge against it
-- just declines. This function scrubs those mismatched cards so the only card
-- ever shown/charged is one that actually works on the camp's CURRENT
-- processor. Cards that DO match the current processor are left untouched
-- (so reconnecting the same processor is a no-op).
--
-- admin-connect-processor calls this (best-effort) right after a successful
-- connect. It's also safe to call by hand for a camp that switched before
-- this existed:
--     select _admin_clear_stale_byop_cards('<camp id>'::uuid, 'banquest');
--
-- service_role ONLY. Idempotent.
-- ============================================================================
CREATE OR REPLACE FUNCTION public._admin_clear_stale_byop_cards(p_camp_id uuid, p_processor_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_me      jsonb;
    v_snacks  jsonb;
    v_fams    jsonb := '{}'::jsonb;
    v_accts   jsonb := '{}'::jsonb;
    rec       record;
    v_obj     jsonb;
    v_ar      jsonb;
    v_pms     jsonb;
    v_famsChanged   boolean := false;
    v_acctsChanged  boolean := false;
    v_cleared int := 0;
BEGIN
    -- ── Tuition cards on each family (campistryMe.families) ──────────────────
    SELECT value INTO v_me FROM camp_state_kv WHERE camp_id = p_camp_id AND key = 'campistryMe';
    IF v_me IS NOT NULL AND jsonb_typeof(v_me->'families') = 'object' THEN
        FOR rec IN SELECT key, value FROM jsonb_each(v_me->'families') LOOP
            v_obj := rec.value;

            -- Keep only saved methods that belong to the current processor.
            IF jsonb_typeof(v_obj->'savedPaymentMethods') = 'array' THEN
                SELECT COALESCE(jsonb_agg(m), '[]'::jsonb) INTO v_pms
                  FROM jsonb_array_elements(v_obj->'savedPaymentMethods') m
                 WHERE (m->>'processor') = p_processor_key;
                IF v_pms IS DISTINCT FROM (v_obj->'savedPaymentMethods') THEN
                    v_obj := jsonb_set(v_obj, '{savedPaymentMethods}', v_pms, true);
                    v_famsChanged := true;
                END IF;
            END IF;

            -- Strip the legacy single-slot fields when they point at a
            -- DIFFERENT processor than the one now connected (a stale BYOP
            -- token, or a Stripe customer on a now-BYOP camp).
            IF ( (v_obj ? 'byopProcessor') AND (v_obj->>'byopProcessor') IS DISTINCT FROM p_processor_key )
               OR ( COALESCE(v_obj->>'stripeCustomerId','') <> '' AND p_processor_key <> 'stripe' )
            THEN
                v_obj := (((((( v_obj - 'byopCustomerRef') - 'byopProcessor') - 'cardSavedDate')
                            - 'stripeCustomerId') - 'stripePaymentMethodId') - 'paymentMethodLabel') - 'paymentMethodType';
                v_obj := jsonb_set(
                    v_obj, '{cardOnFile}',
                    CASE WHEN jsonb_typeof(v_obj->'savedPaymentMethods') = 'array'
                              AND jsonb_array_length(v_obj->'savedPaymentMethods') > 0
                         THEN 'true'::jsonb ELSE 'false'::jsonb END,
                    true);
                v_famsChanged := true;
                v_cleared := v_cleared + 1;
            END IF;

            v_fams := jsonb_set(v_fams, ARRAY[rec.key], v_obj, true);
        END LOOP;

        IF v_famsChanged THEN
            v_me := jsonb_set(v_me, '{families}', v_fams, true);
            UPDATE camp_state_kv SET value = v_me, updated_at = now()
             WHERE camp_id = p_camp_id AND key = 'campistryMe';
        END IF;
    END IF;

    -- ── Canteen auto-reload cards (campistrySnacks.accounts[*].autoReload) ────
    SELECT value INTO v_snacks FROM camp_state_kv WHERE camp_id = p_camp_id AND key = 'campistrySnacks';
    IF v_snacks IS NOT NULL AND jsonb_typeof(v_snacks->'accounts') = 'object' THEN
        FOR rec IN SELECT key, value FROM jsonb_each(v_snacks->'accounts') LOOP
            v_obj := rec.value;
            v_ar  := v_obj->'autoReload';
            IF v_ar IS NOT NULL AND jsonb_typeof(v_ar) = 'object'
               AND ( ( (v_ar ? 'byopProcessor') AND (v_ar->>'byopProcessor') IS DISTINCT FROM p_processor_key )
                     OR ( COALESCE(v_ar->>'stripeCustomerId','') <> '' AND p_processor_key <> 'stripe' ) )
            THEN
                v_ar := ((((( v_ar - 'byopCustomerRef') - 'byopProcessor') - 'stripeCustomerId')
                          - 'stripePaymentMethodId') - 'paymentMethodLabel') - 'paymentMethodType';
                v_ar := jsonb_set(v_ar, '{cardOnFile}', 'false'::jsonb, true);
                v_obj := jsonb_set(v_obj, '{autoReload}', v_ar, true);
                v_acctsChanged := true;
                v_cleared := v_cleared + 1;
            END IF;
            v_accts := jsonb_set(v_accts, ARRAY[rec.key], v_obj, true);
        END LOOP;

        IF v_acctsChanged THEN
            v_snacks := jsonb_set(v_snacks, '{accounts}', v_accts, true);
            UPDATE camp_state_kv SET value = v_snacks, updated_at = now()
             WHERE camp_id = p_camp_id AND key = 'campistrySnacks';
        END IF;
    END IF;

    RETURN jsonb_build_object('success', true, 'cleared', v_cleared);
END;
$$;

REVOKE ALL ON FUNCTION public._admin_clear_stale_byop_cards(uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._admin_clear_stale_byop_cards(uuid, text) TO service_role;

-- ─── One-time cleanup for a camp that switched BEFORE this existed ──────────
-- (e.g. the Banquest sandbox test camp):
--   select _admin_clear_stale_byop_cards('<TEST_CAMP_ID>'::uuid, 'banquest');
--   -- returns {"success":true,"cleared":N}; families/campers then show no
--   -- stale card and can add a fresh one on the current processor.
-- ============================================================================


-- #########################################################################
-- ###### 148_banquest_api_host_labels
-- ###### Correct the Banquest API host guidance (api.* host, /api/v2)
-- #########################################################################

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


-- #########################################################################
-- ###### 149_banquest_hosted_payment_pages
-- ###### Hosted Payment Page support: banquest_pending_links + credential fields
-- #########################################################################

-- ============================================================================
-- Migration 149: Banquest redirect-to-hosted-page (Payment Pages) support.
--
-- Switches Banquest to the redirect model the user asked for: the parent
-- leaves Campistry, lands on Banquest's own hosted Payment Page, enters the
-- card there, and comes back — nothing card-related renders on our page.
--
-- Banquest's redirect primitive is Payment Pages:
--   POST /payment-pages/generate-pay-link/{slug}  { custom_fields, general_fields,
--        one_time_use:true, redirect_url }  →  { payment_link, key }
-- With one_time_use:true the response includes a unique tracking `key`, and the
-- redirect_url comes back with `?key=<key>` appended. That key is how we tie a
-- completed hosted payment back to the family/camper who started it:
--   GET /transactions?key=<key>  →  the transaction (status, reference_number,
--        custom_fields, card_details.last4, amount_details.amount).
--
-- This migration adds:
--   1. banquest_pending_links — the server-side map from a pay-link `key` to
--      what the parent was doing (which camp / family / camper / purpose /
--      amount), so the completion step knows what to record without trusting
--      anything the browser sends back beyond the opaque key.
--   2. Two extra Banquest credential fields:
--        paymentPageSlug   — the slug of the hosted Payment Page to pre-fill
--        webhookSignature  — the signing secret of the transaction.succeeded
--                            webhook (from POST /webhooks), used to verify
--                            inbound webhook deliveries. Optional: the
--                            poll-by-key completion path does not need it.
--
-- service_role owns the pending table; the edge functions (service role) are
-- the only readers/writers. Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.banquest_pending_links (
    key              text PRIMARY KEY,
    camp_id          uuid NOT NULL,
    purpose          text NOT NULL CHECK (purpose IN ('save_card','pay_now','canteen')),
    family_key       text,
    camper_name      text,
    amount           numeric,
    status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed')),
    reference_number bigint,
    card_ref         text,
    last4            text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    completed_at     timestamptz
);

CREATE INDEX IF NOT EXISTS banquest_pending_links_camp_idx
    ON public.banquest_pending_links (camp_id, created_at DESC);

ALTER TABLE public.banquest_pending_links ENABLE ROW LEVEL SECURITY;
-- No policies → only service_role (which bypasses RLS) can touch it. The edge
-- functions run as service role; the browser never reads or writes this table.
REVOKE ALL ON public.banquest_pending_links FROM anon, authenticated;

-- Housekeeping: a pending link that was never completed (parent abandoned the
-- hosted page, or an emailed pay link was never used) is dead after 30 days.
-- 30 (not 1) because an owner-generated pay link sent by email may be paid days
-- later; the row must still be there to complete it. Safe to call from a cron.
CREATE OR REPLACE FUNCTION public._admin_prune_banquest_pending_links()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE v_n integer;
BEGIN
    DELETE FROM public.banquest_pending_links
     WHERE status = 'pending' AND created_at < now() - interval '30 days';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public._admin_prune_banquest_pending_links() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._admin_prune_banquest_pending_links() TO service_role;

-- ── Banquest credential fields: add paymentPageSlug + webhookSignature ──────
UPDATE payment_processor_catalog
   SET credential_fields = '[
        {"key":"sourceKey","label":"Banquest Source Key","secret":true},
        {"key":"pin","label":"Banquest PIN","secret":true},
        {"key":"tokenizationKey","label":"Banquest Public Tokenization Key (pk_… — safe to expose client-side)","secret":false},
        {"key":"gatewayUrl","label":"API base URL (sandbox https://api.sandbox.banquestgateway.com/api/v2 · prod https://api.banquestgateway.com/api/v2)","secret":false},
        {"key":"tokenizationUrl","label":"Hosted tokenization script URL (e.g. https://tokenization.sandbox.banquestgateway.com/tokenization/v0.3)","secret":false},
        {"key":"paymentPageSlug","label":"Hosted Payment Page slug (from the Banquest dashboard — the page parents are redirected to)","secret":false},
        {"key":"webhookSignature","label":"Webhook signing secret (the signature returned by POST /webhooks for transaction.succeeded — optional; used to verify inbound webhooks)","secret":true}
       ]'::jsonb
 WHERE key = 'banquest';

-- ─── Sanity checks (run manually after applying) ───────────────────────────
--   SELECT * FROM banquest_pending_links LIMIT 1;          -- table exists
--   SELECT credential_fields FROM payment_processor_catalog WHERE key='banquest';
--   -- expect paymentPageSlug + webhookSignature present.
-- ============================================================================


-- #########################################################################
-- ###### 150_card_form_field_config
-- ###### Admin-configurable card-form fields, returned by the public tokenization RPC
-- #########################################################################

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


-- #########################################################################
-- ###### 151_backfill_saved_payment_methods
-- ###### Backfill savedPaymentMethods[] from legacy single-slot card fields
-- #########################################################################

-- ============================================================================
-- Migration 151: backfill savedPaymentMethods[] from the legacy single-slot
-- card fields.
--
-- Migration 139 made families[fk].savedPaymentMethods the real LIST of saved
-- cards, and get_my_saved_payment_methods (the only thing behind Link's Cards
-- tab) reads NOTHING else. But payments-save-method was writing only the legacy
-- single-slot fields (byopCustomerRef / cardOnFile / paymentMethodLabel), so a
-- card saved through Campistry's own card page was fully saved and fully
-- chargeable — autopay could use it — yet invisible in Cards. That writer is
-- fixed to append to the array going forward; this backfills the cards saved
-- before the fix so nobody has to re-enter one.
--
-- For each family that has a legacy BYOP token but no array entry carrying that
-- same token, append one. Entry shape matches cardknox-webhook / stripe-webhook
-- exactly: {id, type, processor, token, last4, label, addedDate, isDefault}.
-- The backfilled card becomes the default only when the array was empty, so a
-- family that already has cards keeps whichever default it had.
--
-- Stripe-only families are skipped: their legacy fields hold a Stripe customer
-- + payment-method pair rather than a single BYOP token, and stripe-webhook
-- already appends to the array for them.
--
-- service_role ONLY. Idempotent — re-running adds nothing, because the second
-- pass finds the token already present.
-- ============================================================================
CREATE OR REPLACE FUNCTION public._admin_backfill_saved_payment_methods(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_me     jsonb;
    v_fams   jsonb := '{}'::jsonb;
    rec      record;
    v_fam    jsonb;
    v_pms    jsonb;
    v_token  text;
    v_label  text;
    v_last4  text;
    v_added  text;
    v_proc   text;
    v_changed boolean := false;
    v_added_n int := 0;
BEGIN
    SELECT value INTO v_me FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe';
    IF v_me IS NULL OR jsonb_typeof(v_me->'families') <> 'object' THEN
        RETURN jsonb_build_object('success', true, 'added', 0, 'note', 'no families');
    END IF;

    FOR rec IN SELECT key, value FROM jsonb_each(v_me->'families') LOOP
        v_fam   := rec.value;
        v_token := NULLIF(btrim(COALESCE(v_fam->>'byopCustomerRef', '')), '');
        v_pms   := CASE WHEN jsonb_typeof(v_fam->'savedPaymentMethods') = 'array'
                        THEN v_fam->'savedPaymentMethods' ELSE '[]'::jsonb END;

        -- Only families with a legacy BYOP token whose token isn't already listed.
        IF v_token IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(v_pms) m WHERE m->>'token' = v_token
        ) THEN
            v_proc  := COALESCE(NULLIF(btrim(COALESCE(v_fam->>'byopProcessor', '')), ''), 'banquest');
            v_label := NULLIF(btrim(COALESCE(v_fam->>'paymentMethodLabel', '')), '');
            -- Recover the last 4 from whatever the label recorded ("•••• 4242",
            -- "Card ···· 4242"); blank if the label never carried digits.
            v_last4 := NULLIF(right(regexp_replace(COALESCE(v_label, ''), '[^0-9]', '', 'g'), 4), '');
            v_added := COALESCE(NULLIF(btrim(COALESCE(v_fam->>'cardSavedDate', '')), ''), now()::text);

            v_pms := v_pms || jsonb_build_object(
                'id',        'pm_' || replace(gen_random_uuid()::text, '-', ''),
                'type',      'card',
                'processor', v_proc,
                'token',     v_token,
                'last4',     COALESCE(v_last4, ''),
                'label',     COALESCE(v_label, CASE WHEN v_last4 IS NOT NULL
                                                    THEN 'Card ···· ' || v_last4
                                                    ELSE 'Card on file' END),
                'addedDate', v_added,
                'isDefault', (jsonb_array_length(v_pms) = 0)
            );
            v_fam := jsonb_set(v_fam, '{savedPaymentMethods}', v_pms, true);
            -- Cards exist now, so the flag Link reads must agree.
            v_fam := jsonb_set(v_fam, '{cardOnFile}', 'true'::jsonb, true);
            v_changed := true;
            v_added_n := v_added_n + 1;
        END IF;

        v_fams := jsonb_set(v_fams, ARRAY[rec.key], v_fam, true);
    END LOOP;

    IF v_changed THEN
        v_me := jsonb_set(v_me, '{families}', v_fams, true);
        UPDATE camp_state_kv SET value = v_me, updated_at = now()
         WHERE camp_id = p_camp_id AND key = 'campistryMe';
    END IF;

    RETURN jsonb_build_object('success', true, 'added', v_added_n);
END;
$$;

REVOKE ALL ON FUNCTION public._admin_backfill_saved_payment_methods(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._admin_backfill_saved_payment_methods(uuid) TO service_role;

-- ─── Run it for the camp whose card is missing from the Cards tab ───────────
--   select _admin_backfill_saved_payment_methods('<camp id>'::uuid);
--   -- returns {"success":true,"added":N}; reload Link -> Cards and the card
--   -- appears, with the same token autopay was already going to charge.
-- ============================================================================


-- #########################################################################
-- ###### 152_fix_get_my_balance_attribution
-- ###### Credit payments by familyKey/family name; stop summing unreported families
-- #########################################################################

-- ============================================================================
-- Migration 152: fix two balance defects in get_my_balance.
--
-- Found by auditing why Link and the Me page reported different balances for
-- the same family.
--
-- 1. PAYMENTS WERE MOSTLY NOT CREDITED. A payment was attributed to this parent
--    only if finance.payments[].family was an exact CAMPER name, or the row
--    carried an enrollmentId this parent owns. familyKey was never consulted.
--    But of all the writers, only charge-due-installments (autopay) stores a
--    camper name in `family`; manual Record Payment, charge-saved-card,
--    payments-charge-nonce and the Stripe/Cardknox webhooks all store the
--    FAMILY name, and most also store familyKey. So in the common case the
--    portal showed a parent a balance that ignored what they had already paid.
--    Now matched on familyKey first, then the family's own name, with the
--    camper-name and enrollmentId paths kept for autopay and legacy rows.
--
-- 2. CHARGES WERE SUMMED ACROSS FAMILIES THAT WEREN'T REPORTED. The families
--    loop added charges[] and credits[] from every families[] entry containing
--    one of this parent's campers, but returned only the FIRST as familyKey
--    (and took plans/cardOnFile from it). A household split across two family
--    records got a total belonging to neither, reconciling against nothing the
--    office sees. Only the reported family contributes now.
--
-- Deliberately NOT changed: the camper filter (an enrollment still counts only
-- when the camper is on this parent's invite). That is the parent's
-- authorization scope, not a bug -- a parent should not be shown tuition for a
-- camper that isn't theirs.
--
-- Everything else -- the enrolled/accepted status filter, live-session-price
-- vs frozen sessionTuition, the discount formula, pending/failed exclusion,
-- negative-amount refund handling, plans normalization -- is a byte-for-byte
-- re-paste of migration 137's body.
--
-- Idempotent.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_my_balance(p_camp_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller    uuid := auth.uid();
    inv       link_parent_invites;
    me        jsonb;
    enr       jsonb;
    fams      jsonb;
    pays      jsonb;
    sess_list jsonb;
    v_names   jsonb;
    rec       record;
    famRec    record;
    e         jsonb;
    p         jsonb;
    fam       jsonb;
    ch        jsonb;
    cr        jsonb;
    v_billed  numeric := 0;
    v_paid    numeric := 0;
    v_credits numeric := 0;
    v_tuition numeric;
    v_liveT   numeric;
    v_disc    numeric;
    v_amt     numeric;
    v_status  text;
    v_family  text;
    v_enrIds  jsonb := '[]'::jsonb;
    v_history jsonb := '[]'::jsonb;
    v_belongs boolean;
    v_famKey  text := NULL;
    v_famName text := '';
    v_fam     jsonb := NULL;
    v_myEnr   jsonb := '[]'::jsonb;
    v_plans   jsonb;
    v_chargeable  boolean := false;
    v_processorKey text := NULL;
    v_cardLabel   text := NULL;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    SELECT * INTO inv
    FROM link_parent_invites
    WHERE user_id = caller
      AND (status = 'active' OR billing_access = true)
      AND (expires_at IS NULL OR expires_at > now())
      AND (p_camp_id IS NULL OR camp_id = p_camp_id)
    ORDER BY created_at DESC
    LIMIT 1;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;
    v_names := COALESCE(inv.camper_names, '[]'::jsonb);

    SELECT value INTO me FROM camp_state_kv
    WHERE camp_id = inv.camp_id AND key = 'campistryMe';
    IF me IS NULL THEN me := '{}'::jsonb; END IF;
    enr       := COALESCE(me->'enrollments', '{}'::jsonb);
    fams      := COALESCE(me->'families', '{}'::jsonb);
    pays      := COALESCE(me->'finance'->'payments', '[]'::jsonb);
    sess_list := COALESCE(me->'sessions', '[]'::jsonb);

    FOR rec IN SELECT key, value FROM jsonb_each(enr) LOOP
        e := rec.value;
        IF (v_names ? (e->>'camperName')) AND (e->>'status') IN ('enrolled', 'accepted') THEN
            v_liveT := (SELECT (s->>'tuition')::numeric
                          FROM jsonb_array_elements(sess_list) s
                         WHERE s->>'name' = e->>'session'
                         LIMIT 1);
            v_tuition := CASE WHEN v_liveT IS NOT NULL AND v_liveT > 0 THEN v_liveT
                              ELSE COALESCE((e->>'sessionTuition')::numeric, 0) END;
            v_disc := 0;
            IF e->'discount' IS NOT NULL AND e->'discount' <> 'null'::jsonb THEN
                v_disc := COALESCE((e->'discount'->>'amt')::numeric, 0)
                        + ROUND(v_tuition * COALESCE((e->'discount'->>'pct')::numeric, 0) / 100);
            END IF;
            v_billed := v_billed + (v_tuition - v_disc);
            v_enrIds := v_enrIds || to_jsonb(rec.key);
            v_myEnr := v_myEnr || jsonb_build_object(
                'id', rec.key, 'camperName', e->>'camperName',
                'session', e->>'session', 'net', v_tuition - v_disc
            );
        END IF;
    END LOOP;

    FOR famRec IN SELECT key, value FROM jsonb_each(fams) LOOP
        fam := famRec.value;
        v_belongs := EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(COALESCE(fam->'camperIds', '[]'::jsonb)) ci
            WHERE v_names ? ci
        );
        IF NOT v_belongs THEN CONTINUE; END IF;

        -- Only the family we actually REPORT contributes charges/credits. This
        -- loop used to sum them from EVERY families[] entry holding one of this
        -- parent's campers while returning only the first as familyKey, so a
        -- household split across two family records produced a balance that
        -- belonged to neither of them and matched nothing the office sees.
        IF v_famKey IS NULL THEN
            v_famKey  := famRec.key;
            v_fam     := fam;
            v_famName := COALESCE(fam->>'name', '');
        ELSE
            CONTINUE;
        END IF;

        FOR ch IN SELECT * FROM jsonb_array_elements(COALESCE(fam->'charges', '[]'::jsonb)) LOOP
            v_amt := COALESCE((ch->>'amount')::numeric, 0);
            v_billed := v_billed + v_amt;
            v_history := v_history || jsonb_build_object(
                'date',   COALESCE(ch->>'date', ''),
                'desc',   COALESCE(NULLIF(ch->>'description', ''), COALESCE(ch->>'category', 'Charge')),
                'amt',    v_amt,
                'status', 'charge'
            );
        END LOOP;

        FOR cr IN SELECT * FROM jsonb_array_elements(COALESCE(fam->'credits', '[]'::jsonb)) LOOP
            v_amt := COALESCE((cr->>'amount')::numeric, 0);
            v_credits := v_credits + v_amt;
            v_history := v_history || jsonb_build_object(
                'date',   COALESCE(cr->>'date', ''),
                'desc',   COALESCE(NULLIF(cr->>'reason', ''), 'Credit'),
                'amt',    v_amt,
                'status', 'credit'
            );
        END LOOP;
    END LOOP;

    FOR p IN SELECT * FROM jsonb_array_elements(pays) LOOP
        v_family := COALESCE(p->>'family', '');
        -- Attribution used to require `family` to be an exact CAMPER name (or an
        -- enrollmentId). But only autopay writes a camper name there --
        -- manual Record Payment, charge-saved-card, payments-charge-nonce and
        -- the Stripe/Cardknox webhooks all store the FAMILY name, and most also
        -- store familyKey. So nearly every real payment was invisible here and
        -- the portal told parents they still owed money they had already paid.
        -- Match the stored familyKey first (authoritative), then the family's
        -- own name, keeping the camper-name and enrollmentId paths for autopay
        -- and for older rows that carry neither.
        IF (v_names ? v_family)
           OR (v_enrIds ? COALESCE(p->>'enrollmentId', ''))
           OR (v_famKey IS NOT NULL AND COALESCE(p->>'familyKey', '') = v_famKey)
           OR (v_famName <> '' AND v_family = v_famName)
        THEN
            v_amt := COALESCE((p->>'amount')::numeric, 0);
            v_status := COALESCE(p->>'status', '');
            IF v_status NOT IN ('pending', 'failed') THEN v_paid := v_paid + v_amt; END IF;
            v_history := v_history || jsonb_build_object(
                'date',   COALESCE(p->>'date', ''),
                'desc',   COALESCE(NULLIF(p->>'notes', ''), COALESCE(p->>'method', 'Payment')),
                'amt',    v_amt,
                'status', CASE WHEN v_amt < 0 THEN 'refunded'
                               WHEN v_status = 'pending' THEN 'pending'
                               WHEN v_status = 'failed' THEN 'failed'
                               ELSE 'paid' END
            );
        END IF;
    END LOOP;

    IF v_fam IS NOT NULL AND v_fam ? 'plans' AND jsonb_typeof(v_fam->'plans') = 'array' THEN
        v_plans := v_fam->'plans';
    ELSIF v_fam IS NOT NULL AND v_fam ? 'plan' AND v_fam->'plan' <> 'null'::jsonb THEN
        v_plans := jsonb_build_array((v_fam->'plan') || jsonb_build_object('enrollmentIds', NULL));
    ELSE
        v_plans := '[]'::jsonb;
    END IF;

    -- Same shape as campistry_me.js's _famChargeable(f): a real vaulted BYOP
    -- token always wins; otherwise a Stripe customer + the cardOnFile flag.
    -- Only ever tells the client YES/NO + which processor -- never returns
    -- the token/customer id itself.
    IF v_fam IS NOT NULL THEN
        IF v_fam->>'byopCustomerRef' IS NOT NULL AND v_fam->>'byopCustomerRef' <> '' THEN
            v_chargeable := true;
            v_processorKey := COALESCE(v_fam->>'byopProcessor', 'cardknox');
        ELSIF v_fam->>'stripeCustomerId' IS NOT NULL AND v_fam->>'stripeCustomerId' <> ''
              AND COALESCE((v_fam->>'cardOnFile')::boolean, false) THEN
            v_chargeable := true;
            v_processorKey := 'stripe';
        END IF;
        v_cardLabel := v_fam->>'paymentMethodLabel';
    END IF;

    RETURN jsonb_build_object(
        'success',            true,
        'camp_id',            inv.camp_id,
        'familyName',         COALESCE(v_names->>0, inv.parent_name),
        'campers',            v_names,
        'billed',             v_billed,
        'paid',               v_paid,
        'credits',            v_credits,
        'balance',            v_billed - v_paid - v_credits,
        'payments',           v_history,
        'familyKey',          v_famKey,
        'cardOnFile',         COALESCE(v_fam->'cardOnFile', 'false'::jsonb)::boolean,
        'paymentMethodType',  v_fam->>'paymentMethodType',
        'paymentMethodLabel', v_fam->>'paymentMethodLabel',
        'plans',              v_plans,
        'enrollments',        v_myEnr,
        'allowParentPaymentPlans', COALESCE((me #>> '{enrollSettings,allowParentPaymentPlans}')::boolean, false),
        'chargeable',         v_chargeable,
        'processorKey',       v_processorKey,
        'cardLabel',          v_cardLabel
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_balance(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_balance(uuid) TO authenticated;

-- ─── Sanity check after applying ───────────────────────────────────────────
--   select prosrc ilike '%familyKey%' as credits_payments_by_family_key
--     from pg_proc where proname = 'get_my_balance';
--   -- expect true. Then reload Link -> Payments: a family whose payments were
--   -- recorded manually or through hosted checkout should now show them
--   -- credited, and the balance should agree with Me -> Billing.
-- ============================================================================


-- #########################################################################
-- ###### 153_stripe_is_not_the_default
-- ###### Stripe becomes a selectable processor; 'none' is the new default
-- #########################################################################

-- ============================================================================
-- Migration 153: Stripe stops being the default processor and becomes one
-- selectable option among Stripe / Sola / Banquest.
--
-- Migration 126 made camps.payment_processor_key NOT NULL DEFAULT 'stripe', so
-- "this camp has not chosen a processor" and "this camp chose Stripe" were the
-- same value. That had a real consequence: a camp on the default with no Stripe
-- Connect account still took tuition through stripe-checkout, which only gates
-- CANTEEN deposits on a destination account — so the money settled into
-- Campistry's own platform balance rather than the camp's.
--
-- WHY A 'none' SENTINEL AND NOT NULL:
--   * get_camp_payment_processor_status INNER JOINs payment_processor_catalog
--     (migration 126, line ~178). A NULL key drops the row entirely, so the RPC
--     returns success:true with processorKey null and status 'untested' — and
--     the dashboard renders "Connected to null but not yet verified. Contact
--     support." for a perfectly healthy camp.
--   * _admin_clear_stale_byop_cards (migration 147) filters saved cards with
--     (m->>'processor') = p_processor_key. NULL makes every comparison NULL, so
--     jsonb_agg returns [] and EVERY family's savedPaymentMethods is deleted.
--   * The FK to payment_processor_catalog stays meaningful; NULL satisfies an
--     FK silently.
-- A real catalog row keeps every existing join, comparison and constraint
-- working, and gives the UI one explicit state to render a "choose a processor"
-- call to action for.
--
-- SAFE TO BACKFILL: confirmed with the camp owner that no camp is live on
-- Stripe today, so every row still reading 'stripe' is an unchosen default, not
-- a decision. Camps that connected Sola or Banquest already had their key set
-- by _admin_store_camp_processor_credentials and are left alone.
--
-- NOT TOUCHED — these are platform-Stripe and must stay that way regardless of
-- what a camp connects:
--   * Tips      — stripe-connect-tip / -tip-cart / stripe-connect-webhook,
--                 charged on the platform account and transferred to each
--                 staff member's own Connect account (link_staff_accounts).
--   * Photos    — link-photo-checkout, explicitly a platform-account charge
--                 and deliberately not a Connect destination charge.
-- Neither reads camps.payment_processor_key at all, so neither is affected.
--
-- Idempotent.
-- ============================================================================

-- ─── 1. The 'none' processor ────────────────────────────────────────────────
-- capabilities are all false: nothing can be charged, refunded or tokenized
-- until a real processor is connected. Anything that reads capabilities to
-- decide whether to offer an action therefore correctly offers nothing.
INSERT INTO payment_processor_catalog (key, label, credential_fields, capabilities, adapter_module)
VALUES ('none', 'No processor connected', '[]'::jsonb,
        '{"charge":false,"refund":false,"recurring":false,"ach":false,"tokenization":false,"nativeSurcharge":false}'::jsonb,
        'none (no online payments until the camp connects a processor)')
ON CONFLICT (key) DO NOTHING;

-- ─── 2. New camps start unchosen ────────────────────────────────────────────
ALTER TABLE camps ALTER COLUMN payment_processor_key SET DEFAULT 'none';

-- ─── 3. Backfill the unchosen default ───────────────────────────────────────
-- Only rows still sitting on 'stripe'. A camp that genuinely wants Stripe gets
-- there by completing Stripe Connect, which now sets the key explicitly.
UPDATE camps SET payment_processor_key = 'none' WHERE payment_processor_key = 'stripe';

-- ─── 4. Status RPC understands 'none' ───────────────────────────────────────
-- Same body as migration 126 except the status expression: 'none' reports
-- 'not_connected' (an actionable state the UI can prompt on) instead of
-- inheriting the old 'stripe_default'. A camp on 'stripe' now means a camp that
-- really connected Stripe, so its status is derived from whether Connect is
-- actually usable rather than assumed.
CREATE OR REPLACE FUNCTION public.get_camp_payment_processor_status(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_uid  uuid := auth.uid();
    v_ok   boolean;
    v_row  record;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM camps WHERE id = p_camp_id AND owner = v_uid
        UNION
        SELECT 1 FROM camp_users
         WHERE camp_id = p_camp_id AND user_id = v_uid
           AND accepted_at IS NOT NULL AND role IN ('owner', 'admin')
    ) INTO v_ok;
    IF NOT v_ok THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    SELECT c.payment_processor_key AS processor_key,
           pc.label AS processor_label,
           c.stripe_account_id,
           c.stripe_charges_enabled,
           cred.status, cred.last_verified_at, cred.connected_at
      INTO v_row
      FROM camps c
      JOIN payment_processor_catalog pc ON pc.key = c.payment_processor_key
      LEFT JOIN camp_processor_credentials cred ON cred.camp_id = c.id
     WHERE c.id = p_camp_id;

    RETURN jsonb_build_object(
        'success', true,
        'processorKey', v_row.processor_key,
        'processorLabel', v_row.processor_label,
        'status', CASE
            WHEN v_row.processor_key = 'none'   THEN 'not_connected'
            -- Stripe keeps no row in camp_processor_credentials (it has no BYOP
            -- adapter); its health is whether Connect can actually take money.
            WHEN v_row.processor_key = 'stripe' THEN
                CASE WHEN COALESCE(v_row.stripe_charges_enabled, false) THEN 'verified'
                     WHEN v_row.stripe_account_id IS NOT NULL           THEN 'untested'
                     ELSE 'not_connected' END
            ELSE COALESCE(v_row.status, 'untested')
        END,
        'lastVerifiedAt', v_row.last_verified_at,
        'connectedAt', v_row.connected_at
    );
END;
$$;
REVOKE ALL ON FUNCTION public.get_camp_payment_processor_status(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_camp_payment_processor_status(uuid) TO authenticated;

-- ─── 5. Disconnecting returns to 'none', not 'stripe' ───────────────────────
-- Migration 129 reset to 'stripe', which under the old default meant "back to
-- normal". It now has to mean "no processor", or disconnecting Sola/Banquest
-- would silently opt the camp into Stripe.
CREATE OR REPLACE FUNCTION public.disconnect_my_camp_processor(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, pg_catalog
AS $$
DECLARE
    v_uid       uuid := auth.uid();
    v_ok        boolean;
    v_secret_id uuid;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM camps WHERE id = p_camp_id AND owner = v_uid
        UNION
        SELECT 1 FROM camp_users
         WHERE camp_id = p_camp_id AND user_id = v_uid
           AND accepted_at IS NOT NULL AND role IN ('owner', 'admin')
    ) INTO v_ok;
    IF NOT v_ok THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    SELECT vault_secret_id INTO v_secret_id
      FROM camp_processor_credentials WHERE camp_id = p_camp_id;

    IF v_secret_id IS NOT NULL THEN
        DELETE FROM vault.secrets WHERE id = v_secret_id;
    END IF;

    DELETE FROM camp_processor_credentials WHERE camp_id = p_camp_id;
    UPDATE camps SET payment_processor_key = 'none' WHERE id = p_camp_id;

    RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public.disconnect_my_camp_processor(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.disconnect_my_camp_processor(uuid) TO authenticated;

-- ─── 6. Connecting / disconnecting Stripe sets the key ──────────────────────
-- Stripe Connect onboarding only ever wrote stripe_account_id; the key came
-- from the default. With the default gone, completing Connect has to say so
-- explicitly, and disconnecting has to hand the camp back to 'none'.
-- service_role: called by stripe-connect-status-camp / -onboard-camp.
CREATE OR REPLACE FUNCTION public._admin_set_camp_stripe_selected(p_camp_id uuid, p_selected boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    IF p_selected THEN
        -- Never clobber a camp that deliberately runs Sola/Banquest; only a
        -- camp with nothing chosen is moved onto Stripe by connecting it.
        UPDATE camps SET payment_processor_key = 'stripe'
         WHERE id = p_camp_id AND payment_processor_key = 'none';
    ELSE
        UPDATE camps SET payment_processor_key = 'none'
         WHERE id = p_camp_id AND payment_processor_key = 'stripe';
    END IF;
    RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public._admin_set_camp_stripe_selected(uuid, boolean) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._admin_set_camp_stripe_selected(uuid, boolean) TO service_role;

-- ─── 7. Disconnecting Stripe also releases the processor key ────────────────
-- Migration 130's disconnect_my_camp_stripe cleared stripe_account_id but left
-- payment_processor_key alone, because under the old default 'stripe' meant
-- "nothing special". Now it means "this camp takes payments through Stripe", so
-- tearing down Connect has to hand the key back to 'none' — otherwise the camp
-- keeps claiming a processor it can no longer charge with.
CREATE OR REPLACE FUNCTION public.disconnect_my_camp_stripe(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_uid uuid := auth.uid();
    v_ok  boolean;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM camps WHERE id = p_camp_id AND owner = v_uid
        UNION
        SELECT 1 FROM camp_users
         WHERE camp_id = p_camp_id AND user_id = v_uid
           AND accepted_at IS NOT NULL AND role IN ('owner', 'admin')
    ) INTO v_ok;
    IF NOT v_ok THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    UPDATE camps
       SET stripe_account_id = NULL,
           stripe_charges_enabled = false,
           stripe_onboarding_status = 'not_started',
           stripe_connected_at = NULL,
           -- Only if Stripe was the chosen processor; a camp on Sola/Banquest
           -- that happens to have had Connect set up keeps its real processor.
           payment_processor_key = CASE WHEN payment_processor_key = 'stripe'
                                        THEN 'none' ELSE payment_processor_key END
     WHERE id = p_camp_id;

    RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public.disconnect_my_camp_stripe(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.disconnect_my_camp_stripe(uuid) TO authenticated;

-- Tidy any camp already left claiming Stripe with no Connect account behind it.
UPDATE camps SET payment_processor_key = 'none'
 WHERE payment_processor_key = 'stripe' AND stripe_account_id IS NULL;

-- ─── Sanity checks (run manually after applying) ───────────────────────────
--   SELECT key, label FROM payment_processor_catalog ORDER BY key;
--     -- expect a 'none' row alongside stripe / cardknox / banquest.
--   SELECT column_default FROM information_schema.columns
--    WHERE table_name='camps' AND column_name='payment_processor_key';
--     -- expect 'none'::text
--   SELECT payment_processor_key, count(*) FROM camps GROUP BY 1;
--     -- expect no 'stripe' rows unless that camp really completed Connect.
-- ============================================================================


-- #########################################################################
-- ###### 154_fix_get_my_access_group_resolution
-- ###### Section access actually applies: fix the unassigned-record and NULL-preset bugs
-- #########################################################################

-- ============================================================================
-- Migration 154: fix get_my_access, which silently granted full access.
--
-- Migration 097 declared `v_grp record` and then tested `IF v_grp IS NOT NULL`.
-- That is wrong twice over, and both failures grant MORE access, silently:
--
--   1. A member with NO access group never assigns v_grp at all. In PL/pgSQL an
--      unassigned record raises "record \"v_grp\" is not assigned yet" the
--      moment it is referenced — including by IS NOT NULL. That exception is
--      swallowed by the function's own EXCEPTION WHEN OTHERS handler, which
--      returns success:false + unrestricted:true, and
--      campistry_access_sections.js treats that as "no restrictions at all".
--      So for every ungrouped staff member — the common case — section access
--      has been doing nothing.
--
--   2. A member WITH a group whose access_preset is NULL (any group built from
--      raw section toggles rather than a named preset — including migration
--      097's own worked example) fails `record IS NOT NULL`, because SQL
--      row-value semantics require EVERY field to be non-null. Execution falls
--      through to the member's own columns, which for a grouped member are
--      typically empty, so resolve() sees "unconfigured" and grants edit on
--      everything. The group's restrictions are discarded.
--
-- Fix: select into three scalar variables instead of a record, and branch on
-- FOUND. Nothing else about the function changes — the owner short-circuit, the
-- not-a-member fail-open and the deliberate fail-open exception handler are all
-- preserved verbatim, because they are policy (documented in
-- campistry_access_sections.js:26-37), not bugs.
--
-- AFTER APPLYING: section access starts actually applying for ungrouped members
-- for the first time. Any member who was configured with restrictions has been
-- silently enjoying full access; they will now be gated as intended. Worth
-- telling the camp before running this, so a suddenly-restricted staff member
-- isn't reported as a regression.
--
-- Idempotent.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_my_access(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller        uuid := auth.uid();
    v_row         record;
    v_grp_found   boolean := false;
    v_grp_products jsonb;
    v_grp_preset   text;
    v_grp_sections jsonb;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    -- Owner of the camp: always full, never gated.
    IF EXISTS (SELECT 1 FROM camps WHERE id = p_camp_id AND owner = caller) THEN
        RETURN jsonb_build_object(
            'success', true, 'role', 'owner',
            'products', '[]'::jsonb, 'preset', NULL,
            'overrides', '{}'::jsonb, 'unrestricted', true
        );
    END IF;

    SELECT role, product_access, access_preset, section_access, access_group_id
    INTO v_row
    FROM camp_users
    WHERE camp_id = p_camp_id AND user_id = caller
    LIMIT 1;

    IF NOT FOUND THEN
        -- Not a resolvable member here. Fail OPEN, matching
        -- product_access_guard.js: the page's own auth handles non-members, and
        -- RLS is the real boundary. Failing closed would lock out legitimate
        -- users during the window where membership hasn't propagated.
        RETURN jsonb_build_object(
            'success', true, 'role', NULL,
            'products', '[]'::jsonb, 'preset', NULL,
            'overrides', '{}'::jsonb, 'unrestricted', true
        );
    END IF;

    -- Scalars, not a record: an unassigned record cannot be tested safely, and
    -- a record IS NOT NULL test would also reject a group with a NULL preset.
    IF v_row.access_group_id IS NOT NULL THEN
        SELECT product_access, access_preset, section_access
          INTO v_grp_products, v_grp_preset, v_grp_sections
          FROM camp_access_groups WHERE id = v_row.access_group_id;
        v_grp_found := FOUND;
    END IF;

    -- A group assignment replaces the member's own columns wholesale (no
    -- merge), which is migration 097's intended behaviour.
    IF v_grp_found THEN
        RETURN jsonb_build_object(
            'success', true,
            'role', v_row.role,
            'products', COALESCE(v_grp_products, '[]'::jsonb),
            'preset', v_grp_preset,
            'overrides', COALESCE(v_grp_sections, '{}'::jsonb),
            'unrestricted', (v_row.role IN ('owner', 'admin'))
        );
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'role', v_row.role,
        'products', COALESCE(v_row.product_access, '[]'::jsonb),
        'preset', v_row.access_preset,
        'overrides', COALESCE(v_row.section_access, '{}'::jsonb),
        'unrestricted', (v_row.role IN ('owner', 'admin'))
    );
EXCEPTION WHEN OTHERS THEN
    -- Fail open on an unexpected error, for the same reason as above.
    RETURN jsonb_build_object('success', false, 'error', SQLERRM, 'unrestricted', true);
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_access(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_access(uuid) TO authenticated;

-- ─── Sanity check after applying ───────────────────────────────────────────
-- As a restricted (non-owner, ungrouped) staff member, this should now return
-- unrestricted:false with their real preset/overrides, instead of
-- success:false + unrestricted:true:
--   select get_my_access('<camp id>'::uuid);
-- ============================================================================


-- ═══════════════════════════════════════════════════════════════════════════
-- POST-APPLY: backfill saved cards for every camp.
--
-- Additive and idempotent — it only creates a savedPaymentMethods[] entry for a
-- family that already has a legacy card token and no array entry carrying that
-- same token, so a second run adds nothing. Without it, a card saved before the
-- fix stays chargeable but invisible under Link -> Cards.
--
-- _admin_clear_stale_byop_cards is deliberately NOT run here: it DELETES cards
-- belonging to a processor the camp no longer uses, which is right after
-- switching processors but is not something an "apply everything" script should
-- ever do unprompted.
-- ═══════════════════════════════════════════════════════════════════════════
DO $backfill$
DECLARE
    c        record;
    v_result jsonb;
    v_total  int := 0;
BEGIN
    FOR c IN SELECT id FROM camps LOOP
        v_result := public._admin_backfill_saved_payment_methods(c.id);
        v_total  := v_total + COALESCE((v_result->>'added')::int, 0);
    END LOOP;
    RAISE NOTICE 'Saved-card backfill complete — % card(s) added across all camps.', v_total;
END
$backfill$;

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION — every row should read OK. Anything else means that piece did
-- not apply; re-run the bundle and read the error.
-- ═══════════════════════════════════════════════════════════════════════════
SELECT 'banquest credential fields (paymentPageSlug present)' AS check_name,
       CASE WHEN EXISTS (SELECT 1 FROM payment_processor_catalog
                          WHERE key='banquest' AND credential_fields::text LIKE '%paymentPageSlug%')
            THEN 'OK' ELSE 'MISSING' END AS result
UNION ALL SELECT '''none'' processor exists',
       CASE WHEN EXISTS (SELECT 1 FROM payment_processor_catalog WHERE key='none')
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'camps default is ''none''',
       CASE WHEN (SELECT column_default FROM information_schema.columns
                   WHERE table_name='camps' AND column_name='payment_processor_key') LIKE '%none%'
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'no camp left on the old stripe default',
       CASE WHEN NOT EXISTS (SELECT 1 FROM camps
                              WHERE payment_processor_key='stripe' AND stripe_account_id IS NULL)
            THEN 'OK' ELSE 'STILL PRESENT' END
UNION ALL SELECT 'banquest_pending_links table',
       CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='banquest_pending_links')
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'tokenization RPC returns cardFormFields',
       CASE WHEN (SELECT prosrc FROM pg_proc WHERE proname='get_camp_public_tokenization_key' LIMIT 1) LIKE '%cardFormFields%'
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'get_my_balance credits payments by familyKey',
       CASE WHEN (SELECT prosrc FROM pg_proc WHERE proname='get_my_balance' LIMIT 1) LIKE '%familyKey%'
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'get_my_access uses scalars, not an unassigned record',
       CASE WHEN (SELECT prosrc FROM pg_proc WHERE proname='get_my_access' LIMIT 1) LIKE '%v_grp_found%'
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'saved-card backfill function',
       CASE WHEN EXISTS (SELECT 1 FROM pg_proc WHERE proname='_admin_backfill_saved_payment_methods')
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'stale-card cleanup function',
       CASE WHEN EXISTS (SELECT 1 FROM pg_proc WHERE proname='_admin_clear_stale_byop_cards')
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'stripe-selected helper',
       CASE WHEN EXISTS (SELECT 1 FROM pg_proc WHERE proname='_admin_set_camp_stripe_selected')
            THEN 'OK' ELSE 'MISSING' END;
