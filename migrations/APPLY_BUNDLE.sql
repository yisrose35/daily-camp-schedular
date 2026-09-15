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
--   * Camp entitlements start being enforced by the database, not just hidden
--     in the browser (155-157). This changes NOTHING for any existing camp:
--     every camp is unrestricted until an entitlement is deliberately set from
--     the control page, and setting one back to unrestricted undoes it.
--   * Payroll and Finance move into their own rows so that gate can reach them
--     (158). DEPLOY THE SITE BEFORE RUNNING THIS — the new page reads the new
--     rows and falls back to the old blob, so it is correct either way round,
--     but old code running against moved data would show empty pages. The
--     family payment ledger deliberately does NOT move.
--   * !! A staff member's SECTION access starts being enforced by the database
--     for Payroll and Finance (159/160), not just hidden in the browser. Until
--     now a manager with payroll:none could still read the data out of the API
--     with a valid session. Anyone who was never configured (no preset, no
--     overrides) is unaffected — that is the backward-compatibility rule — but
--     anyone you DID restrict can no longer reach those two keys at all.
--     161 extends the same rule to the canteen (campistrySnacks): staff with no
--     snacks access — nurse, division head, office, bus coordinator presets —
--     stop being able to read camper balances and the transaction ledger. The
--     POS register is unaffected: it runs as a counselor, and an unconfigured
--     counselor still passes the gate.
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


-- #########################################################################
-- ###### 155_camp_entitlements
-- ###### Camp entitlements: what the camp bought, capping owners too (phase 1, no DB enforcement yet)
-- #########################################################################

-- ============================================================================
-- Migration 155: camp entitlements — what the camp actually BOUGHT.
--
-- Phase 1 of ENTITLEMENTS_DESIGN.md. This adds the model and surfaces it to the
-- client; it does NOT yet enforce it in the database. Phase 3 is what closes
-- that door, and it must not run before the RPC read/write path exists.
--
-- WHY A THIRD LAYER. product_access and section_access are both per STAFF
-- MEMBER, and owners/admins are deliberately never gated by them (so an owner
-- can't lock themselves out). Neither property is what selling a partial
-- product needs: the limit belongs to the CAMP, and it has to hold for the
-- owner, who is precisely the person being sold to. So this is stored on camps,
-- not on camp_users, and campistry_capabilities.js applies it ABOVE the
-- owner/admin bypass — the only rule that sits above it.
--
-- SUBTRACTIVE ONLY. '{}' means unrestricted, so every existing camp is
-- unaffected by this migration. An entitlement can never grant access that the
-- staff-level layers don't already allow; it can only take away.
--
-- SHAPE (keys are exactly the registry keys in campistry_capabilities.js, so
-- there is one vocabulary rather than two):
--   {}                                  -- unrestricted (the default)
--   {"me": "*"}                         -- all of Campistry Me, nothing else
--   {"me": ["campers","structure"]}     -- the roster-only camp
--   {"me": [], "flow": "*"}             -- Flow outright, Me bought but empty
-- An app absent from a NON-EMPTY object was not bought.
--
-- Idempotent.
-- ============================================================================

ALTER TABLE camps
    ADD COLUMN IF NOT EXISTS entitlements jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN camps.entitlements IS
'What this camp bought. ''{}'' = unrestricted (default). Otherwise per app: "*" for the whole app, or an array of section keys from campistry_capabilities.js. An app absent from a non-empty object was not bought. Subtractive only — never grants. See ENTITLEMENTS_DESIGN.md.';

-- ─── Helpers, so nothing hand-parses the JSON ───────────────────────────────
CREATE OR REPLACE FUNCTION public.camp_entitled(p_camp_id uuid, p_app text, p_section text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_ent jsonb;
    v_app jsonb;
BEGIN
    SELECT entitlements INTO v_ent FROM camps WHERE id = p_camp_id;
    -- Unknown camp or unset entitlement: unrestricted, matching the client.
    IF v_ent IS NULL OR v_ent = '{}'::jsonb THEN RETURN true; END IF;
    IF NOT (v_ent ? p_app) THEN RETURN false; END IF;
    v_app := v_ent -> p_app;
    IF jsonb_typeof(v_app) = 'string' AND v_app #>> '{}' = '*' THEN RETURN true; END IF;
    IF jsonb_typeof(v_app) <> 'array' THEN RETURN false; END IF;
    RETURN v_app ? p_section;
END;
$$;
REVOKE ALL ON FUNCTION public.camp_entitled(uuid, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.camp_entitled(uuid, text, text) TO authenticated, service_role;

-- ─── Setting entitlements is ours, not the camp's ───────────────────────────
-- Deliberately service_role only: this is a commercial boundary, so a camp
-- owner must not be able to widen it from their own dashboard. Same reasoning
-- as _admin_store_camp_processor_credentials in migration 126.
CREATE OR REPLACE FUNCTION public._admin_set_camp_entitlements(p_camp_id uuid, p_entitlements jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    rec record;
    v_app jsonb;
BEGIN
    IF p_entitlements IS NULL OR jsonb_typeof(p_entitlements) <> 'object' THEN
        RETURN jsonb_build_object('success', false, 'error', 'entitlements must be a json object ({} = unrestricted)');
    END IF;
    -- Validate the shape up front; a malformed entry would otherwise read as
    -- "not bought" and quietly switch a paying camp off.
    FOR rec IN SELECT key, value FROM jsonb_each(p_entitlements) LOOP
        v_app := rec.value;
        IF NOT ( (jsonb_typeof(v_app) = 'string' AND v_app #>> '{}' = '*')
                 OR jsonb_typeof(v_app) = 'array' ) THEN
            RETURN jsonb_build_object('success', false,
                'error', format('entitlements.%s must be "*" or an array of section keys', rec.key));
        END IF;
    END LOOP;

    IF NOT EXISTS (SELECT 1 FROM camps WHERE id = p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'no camp with that id');
    END IF;

    UPDATE camps SET entitlements = p_entitlements WHERE id = p_camp_id;
    RETURN jsonb_build_object('success', true, 'entitlements', p_entitlements);
END;
$$;
REVOKE ALL ON FUNCTION public._admin_set_camp_entitlements(uuid, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._admin_set_camp_entitlements(uuid, jsonb) TO service_role;

-- ─── get_my_access carries the entitlement to the client ────────────────────
-- Same body as migration 154 (which fixed the unassigned-record and NULL-preset
-- bugs) plus one new field. Note it is returned even for owners and for the
-- fail-open not-a-member case: 'unrestricted' means "no per-STAFF restriction",
-- and must not be read as "no entitlement". campistry_capabilities.js applies
-- the entitlement before the owner bypass for exactly this reason.
CREATE OR REPLACE FUNCTION public.get_my_access(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller         uuid := auth.uid();
    v_row          record;
    v_grp_found    boolean := false;
    v_grp_products jsonb;
    v_grp_preset   text;
    v_grp_sections jsonb;
    v_ent          jsonb := '{}'::jsonb;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    SELECT COALESCE(entitlements, '{}'::jsonb) INTO v_ent FROM camps WHERE id = p_camp_id;
    v_ent := COALESCE(v_ent, '{}'::jsonb);

    -- Owner of the camp: never gated by the per-staff layers, but STILL capped
    -- by what the camp bought.
    IF EXISTS (SELECT 1 FROM camps WHERE id = p_camp_id AND owner = caller) THEN
        RETURN jsonb_build_object(
            'success', true, 'role', 'owner',
            'products', '[]'::jsonb, 'preset', NULL,
            'overrides', '{}'::jsonb, 'unrestricted', true,
            'entitlements', v_ent
        );
    END IF;

    SELECT role, product_access, access_preset, section_access, access_group_id
    INTO v_row
    FROM camp_users
    WHERE camp_id = p_camp_id AND user_id = caller
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', true, 'role', NULL,
            'products', '[]'::jsonb, 'preset', NULL,
            'overrides', '{}'::jsonb, 'unrestricted', true,
            'entitlements', v_ent
        );
    END IF;

    IF v_row.access_group_id IS NOT NULL THEN
        SELECT product_access, access_preset, section_access
          INTO v_grp_products, v_grp_preset, v_grp_sections
          FROM camp_access_groups WHERE id = v_row.access_group_id;
        v_grp_found := FOUND;
    END IF;

    IF v_grp_found THEN
        RETURN jsonb_build_object(
            'success', true,
            'role', v_row.role,
            'products', COALESCE(v_grp_products, '[]'::jsonb),
            'preset', v_grp_preset,
            'overrides', COALESCE(v_grp_sections, '{}'::jsonb),
            'unrestricted', (v_row.role IN ('owner', 'admin')),
            'entitlements', v_ent
        );
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'role', v_row.role,
        'products', COALESCE(v_row.product_access, '[]'::jsonb),
        'preset', v_row.access_preset,
        'overrides', COALESCE(v_row.section_access, '{}'::jsonb),
        'unrestricted', (v_row.role IN ('owner', 'admin')),
        'entitlements', v_ent
    );
EXCEPTION WHEN OTHERS THEN
    -- Fail open on an unexpected error, matching the documented policy in
    -- campistry_access_sections.js. Entitlements fail open too: a camp that
    -- paid must never be locked out by an error on our side.
    RETURN jsonb_build_object('success', false, 'error', SQLERRM,
                              'unrestricted', true, 'entitlements', '{}'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.get_my_access(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_access(uuid) TO authenticated;

-- ─── Usage ─────────────────────────────────────────────────────────────────
-- Sell a camp the roster and bunk structure only:
--   select _admin_set_camp_entitlements(
--     '<camp id>'::uuid,
--     '{"me": ["campers","structure","bunkbuilder"]}'::jsonb);
--
-- Give a camp everything again:
--   select _admin_set_camp_entitlements('<camp id>'::uuid, '{}'::jsonb);
--
-- Check one section:
--   select camp_entitled('<camp id>'::uuid, 'me', 'billing');
-- ============================================================================


-- #########################################################################
-- ###### 156_entitlements_control_rpcs
-- ###### Super-admin RPCs behind campistry_control.html (list camps, set entitlements)
-- #########################################################################

-- ============================================================================
-- Migration 156: super-admin RPCs behind the entitlements control page.
--
-- Migration 155 added camps.entitlements and _admin_set_camp_entitlements, but
-- that setter is service_role only — callable from an edge function or the SQL
-- editor, not from a signed-in browser. Configuring what every camp has bought
-- by hand-editing JSON in the SQL editor is exactly the friction this removes.
--
-- Auth reuses the mechanism migration 010 already established for the debug
-- clone: the super_admins allow-list plus is_super_admin(). Nothing new to
-- distribute, and membership stays grantable only from the SQL editor — a camp
-- owner can never reach these, which matters because entitlements are a
-- commercial boundary rather than a permission.
--
-- Every function here fails CLOSED. Unlike get_my_access — which fails open on
-- purpose, so a glitch can't lock a paying camp out of its own data — these
-- WRITE the commercial boundary, and the safe direction for a write is to
-- refuse.
--
-- Idempotent.
-- ============================================================================

-- ─── 1. List every camp with what it currently has ──────────────────────────
-- One row per camp. Deliberately returns only what the control page renders:
-- no credentials, no camp data, nothing from camp_state_kv.
CREATE OR REPLACE FUNCTION public.admin_list_camps_entitlements()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_rows jsonb;
BEGIN
    IF NOT public.is_super_admin() THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    SELECT COALESCE(jsonb_agg(r ORDER BY r->>'name'), '[]'::jsonb) INTO v_rows
    FROM (
        SELECT jsonb_build_object(
            'id',           c.id,
            'name',         COALESCE(c.name, '(unnamed camp)'),
            'entitlements', COALESCE(c.entitlements, '{}'::jsonb),
            -- 'unrestricted' is the honest label for '{}': the camp has
            -- everything, because nothing has been sold to it in particular.
            'unrestricted', (COALESCE(c.entitlements, '{}'::jsonb) = '{}'::jsonb),
            'processorKey', c.payment_processor_key,
            'createdAt',    c.created_at,
            'staffCount',   (SELECT count(*) FROM camp_users u WHERE u.camp_id = c.id)
        ) AS r
        FROM camps c
    ) s;

    RETURN jsonb_build_object('success', true, 'camps', v_rows);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_list_camps_entitlements() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_camps_entitlements() TO authenticated;

-- ─── 2. Set one camp's entitlements ─────────────────────────────────────────
-- Validates the shape before writing. A malformed entry would read as "not
-- bought" everywhere and quietly switch a paying camp off, so a typo must be
-- rejected rather than stored.
CREATE OR REPLACE FUNCTION public.admin_set_camp_entitlements(p_camp_id uuid, p_entitlements jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    rec   record;
    v_app jsonb;
    v_el  jsonb;
BEGIN
    IF NOT public.is_super_admin() THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;
    IF p_entitlements IS NULL OR jsonb_typeof(p_entitlements) <> 'object' THEN
        RETURN jsonb_build_object('success', false,
            'error', 'entitlements must be a JSON object ({} means unrestricted)');
    END IF;

    FOR rec IN SELECT key, value FROM jsonb_each(p_entitlements) LOOP
        v_app := rec.value;
        IF jsonb_typeof(v_app) = 'string' THEN
            IF v_app #>> '{}' <> '*' THEN
                RETURN jsonb_build_object('success', false,
                    'error', format('entitlements.%s: the only allowed string is "*"', rec.key));
            END IF;
        ELSIF jsonb_typeof(v_app) = 'array' THEN
            -- Every element must be a plain section key.
            FOR v_el IN SELECT * FROM jsonb_array_elements(v_app) LOOP
                IF jsonb_typeof(v_el) <> 'string' THEN
                    RETURN jsonb_build_object('success', false,
                        'error', format('entitlements.%s: section keys must be strings', rec.key));
                END IF;
            END LOOP;
        ELSE
            RETURN jsonb_build_object('success', false,
                'error', format('entitlements.%s must be "*" or an array of section keys', rec.key));
        END IF;
    END LOOP;

    IF NOT EXISTS (SELECT 1 FROM camps WHERE id = p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'no camp with that id');
    END IF;

    UPDATE camps SET entitlements = p_entitlements WHERE id = p_camp_id;

    RETURN jsonb_build_object('success', true, 'campId', p_camp_id, 'entitlements', p_entitlements);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_set_camp_entitlements(uuid, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_camp_entitlements(uuid, jsonb) TO authenticated;

-- ─── 3. Am I a super admin? ─────────────────────────────────────────────────
-- is_super_admin() is already granted to authenticated, but the control page
-- wants one call that also works when the user simply isn't one (returning
-- false rather than erroring), so the page can render a clean "not authorised"
-- instead of a broken screen.
CREATE OR REPLACE FUNCTION public.am_i_super_admin()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT jsonb_build_object('success', true, 'isSuperAdmin', public.is_super_admin());
$$;
REVOKE ALL ON FUNCTION public.am_i_super_admin() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.am_i_super_admin() TO authenticated;

-- ─── Granting yourself access (SQL editor only, by design) ──────────────────
--   insert into super_admins (user_id, note)
--   select id, 'platform owner' from auth.users where email = 'yisrose35@gmail.com'
--   on conflict (user_id) do nothing;
--
-- Check it took:
--   select am_i_super_admin();          -- as that signed-in user
--   select admin_list_camps_entitlements();
-- ============================================================================


-- #########################################################################
-- ###### 157_entitlement_enforcement_per_key
-- ###### Entitlements enforced in the DATABASE, per camp_state_kv key (phase 2A)
-- #########################################################################

-- ============================================================================
-- Migration 157: enforce camp entitlements in the DATABASE, per key.
--
-- Phase 2A of ENTITLEMENTS_DESIGN.md. Up to now an entitlement only hid things
-- in the browser: a manager or scheduler could read the data straight out of
-- camp_state_kv regardless. This makes the gate real for the app data that
-- already lives in its OWN key, which is where it can be done as a policy
-- change rather than a refactor.
--
-- WHAT IS GATED (each of these is one app's data in one key):
--     campistrySnacks     -> snacks   (any section)
--     campistryHealth     -> health   (any section)
--     campistry_notes_v1  -> notes    (any section)
--     campistryShop       -> snacks.shop      (the Camp Shop lives inside Snacks)
--     campistryLuggage    -> go.luggage       (Luggage lives inside Go)
--
-- WHAT IS DELIBERATELY NOT GATED:
--   * app1, campistryMe, campStructure — the inseparable core. Campistry Me's
--     sections share one blob and genuinely need each other's data (Billing
--     cannot compute without enrollments + sessions + the roster; Bunk Builder
--     writes placements onto app1.camperRoster). Gating these is phase 2B/2C,
--     not a policy change. See ENTITLEMENTS_DESIGN.md §5.
--   * link_* / campistryLink — parent-portal config. Parents are not camp_users
--     and reach it through other paths; gating it here risks breaking the
--     portal for a camp that did buy it, with no matching upside.
--   * Every other key — unknown keys are untouched, so nothing that isn't
--     named above can be affected by this migration.
--
-- WHY THIS IS SAFE TO APPLY NOW: the gate is a no-op for a camp whose
-- entitlements are '{}', and '{}' is the default every camp currently has. Not
-- one camp changes behaviour until an entitlement is deliberately set from the
-- control page. Setting one is also reversible — set it back to '{}'.
--
-- ALL SIX camp_state_kv POLICIES ARE REWRITTEN, not just the obvious three.
-- Postgres OR-combines permissive policies for one command, so a single
-- un-gated policy is a hole through the whole thing — migration 099's counselor
-- POS write on campistrySnacks was exactly that. DELETE is gated too, so a camp
-- whose entitlement lapsed cannot destroy data that a restored entitlement
-- would otherwise bring straight back.
--
-- SERVICE ROLE IS UNAFFECTED (it bypasses RLS), which is correct and load
-- bearing: canteen-auto-reload, the payment webhooks and the deposit inbox must
-- keep working on a camp's data regardless of what that camp bought.
--
-- Idempotent.
-- ============================================================================

-- ─── 1. "Is this camp entitled to ANY of this app?" ─────────────────────────
-- A whole-key gate needs a whole-app question. camp_entitled() (migration 155)
-- answers per section, which is the wrong grain for a key like campistrySnacks
-- that holds accounts, menu, transactions and settings together.
CREATE OR REPLACE FUNCTION public.camp_entitled_any(p_camp_id uuid, p_app text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_ent jsonb;
    v_app jsonb;
BEGIN
    SELECT entitlements INTO v_ent FROM camps WHERE id = p_camp_id;
    -- Unknown camp or unset entitlement: unrestricted. Fail OPEN here on
    -- purpose — a camp that paid must never be locked out of its own data by a
    -- missing row or a lookup failure.
    IF v_ent IS NULL OR v_ent = '{}'::jsonb THEN RETURN true; END IF;
    IF NOT (v_ent ? p_app) THEN RETURN false; END IF;
    v_app := v_ent -> p_app;
    IF jsonb_typeof(v_app) = 'string' THEN RETURN (v_app #>> '{}') = '*'; END IF;
    IF jsonb_typeof(v_app) = 'array' THEN RETURN jsonb_array_length(v_app) > 0; END IF;
    RETURN false;   -- malformed: withhold rather than hand out the app
END;
$$;
REVOKE ALL ON FUNCTION public.camp_entitled_any(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.camp_entitled_any(uuid, text) TO authenticated, service_role;

-- ─── 2. One place that decides whether a key is allowed ─────────────────────
-- Both policies call this, so read and write can never drift apart — a key
-- readable but not writable (or the reverse) would corrupt data rather than
-- protect it. Anything not named here returns true: unknown keys are not gated.
CREATE OR REPLACE FUNCTION public.camp_state_key_entitled(p_camp_id uuid, p_key text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    RETURN CASE p_key
        WHEN 'campistrySnacks'    THEN public.camp_entitled_any(p_camp_id, 'snacks')
        WHEN 'campistryHealth'    THEN public.camp_entitled_any(p_camp_id, 'health')
        WHEN 'campistry_notes_v1' THEN public.camp_entitled_any(p_camp_id, 'notes')
        WHEN 'campistryShop'      THEN public.camp_entitled(p_camp_id, 'snacks', 'shop')
        WHEN 'campistryLuggage'   THEN public.camp_entitled(p_camp_id, 'go', 'luggage')
        ELSE true
    END;
END;
$$;
REVOKE ALL ON FUNCTION public.camp_state_key_entitled(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.camp_state_key_entitled(uuid, text) TO authenticated, service_role;

-- ─── 3. The policies ────────────────────────────────────────────────────────
-- Byte-for-byte migration 098's predicates with the entitlement conjoined. The
-- role rules, the counselor carve-out and get_user_camp_id() are unchanged, so
-- an unrestricted camp behaves exactly as it does today.
--
-- NOTE the entitlement is ANDed at the TOP level, outside the role branches:
-- unlike every other rule here it applies to owners too. That is the whole
-- point — it is what the camp bought, not what this person is allowed.

DROP POLICY IF EXISTS camp_state_kv_insert ON camp_state_kv;
CREATE POLICY camp_state_kv_insert ON camp_state_kv
    FOR INSERT
    WITH CHECK (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'manager'::text, 'scheduler'::text])
        AND camp_state_key_entitled(camp_id, key)
    );

DROP POLICY IF EXISTS camp_state_kv_update ON camp_state_kv;
CREATE POLICY camp_state_kv_update ON camp_state_kv
    FOR UPDATE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'manager'::text, 'scheduler'::text])
        AND camp_state_key_entitled(camp_id, key)
    );

DROP POLICY IF EXISTS camp_state_kv_select ON camp_state_kv;
CREATE POLICY camp_state_kv_select ON camp_state_kv
    FOR SELECT
    USING (
        camp_id = get_user_camp_id()
        AND camp_state_key_entitled(camp_id, key)
        AND (
            get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'manager'::text, 'scheduler'::text])
            OR (
                get_user_role() = 'counselor'::text
                AND key <> ALL (ARRAY['app1'::text, 'campistryMe'::text, 'campistryHealth'::text])
            )
        )
    );

-- ─── 4. The counselor POS carve-out (migration 099) ─────────────────────────
-- Postgres OR-combines permissive policies for the same command, so gating the
-- policies above is NOT enough on its own: migration 099 grants a counselor its
-- own INSERT/UPDATE on key='campistrySnacks' so the register can save sales,
-- and that policy would keep granting it after the camp lost Snacks. A
-- counselor at a camp that never bought Snacks could still write the blob.
--
-- Same two policies, same predicates, entitlement conjoined. A camp that has
-- Snacks sees no change; the register keeps working exactly as before.
DROP POLICY IF EXISTS camp_state_kv_insert_counselor_snacks ON camp_state_kv;
CREATE POLICY camp_state_kv_insert_counselor_snacks ON camp_state_kv
    FOR INSERT
    WITH CHECK (
        camp_id = get_user_camp_id()
        AND get_user_role() = 'counselor'::text
        AND key = 'campistrySnacks'::text
        AND camp_state_key_entitled(camp_id, key)
    );

DROP POLICY IF EXISTS camp_state_kv_update_counselor_snacks ON camp_state_kv;
CREATE POLICY camp_state_kv_update_counselor_snacks ON camp_state_kv
    FOR UPDATE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = 'counselor'::text
        AND key = 'campistrySnacks'::text
        AND camp_state_key_entitled(camp_id, key)
    );

-- (submit_canteen_purchase is SECURITY DEFINER and bypasses all of this, which
-- is deliberate — an in-flight POS charge must not fail halfway. If POS should
-- refuse outright for an unentitled camp, that belongs in the RPC, not here.)

-- ─── 5. DELETE ──────────────────────────────────────────────────────────────
-- Owner-only, from migration 001, now entitlement-gated as well. This protects
-- the CAMP, not us: without it an owner whose Health entitlement lapsed could
-- delete the campistryHealth row they can no longer read — destroying data that
-- would otherwise come straight back the moment the entitlement is restored.
-- An entitlement is meant to be reversible; a delete is not.
DROP POLICY IF EXISTS camp_state_kv_delete ON camp_state_kv;
CREATE POLICY camp_state_kv_delete ON camp_state_kv
    FOR DELETE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = 'owner'::text
        AND camp_state_key_entitled(camp_id, key)
    );

-- ─── Sanity checks ─────────────────────────────────────────────────────────
-- Nothing should change while every camp is on '{}':
--   select count(*) from camps where entitlements <> '{}'::jsonb;   -- expect 0
--
-- Prove the gate works, on a throwaway camp:
--   select camp_state_key_entitled('<camp>'::uuid, 'campistryHealth');  -- true
--   select _admin_set_camp_entitlements('<camp>'::uuid, '{"me":"*"}'::jsonb);
--   select camp_state_key_entitled('<camp>'::uuid, 'campistryHealth');  -- false
--   -- and as a signed-in staff member of that camp:
--   --   select key from camp_state_kv where key = 'campistryHealth';   -- 0 rows
--   select _admin_set_camp_entitlements('<camp>'::uuid, '{}'::jsonb);   -- undo
--
-- Confirm ALL SIX policies carry the gate — a permissive policy that misses it
-- is a hole, because Postgres ORs them together:
--   select policyname, cmd,
--          (coalesce(qual,'') || coalesce(with_check,'')
--             like '%camp_state_key_entitled%') as gated
--     from pg_policies where tablename = 'camp_state_kv';
--   -- expect 6 rows, gated = true on every one
-- ============================================================================


-- #########################################################################
-- ###### 158_split_payroll_finance_keys
-- ###### Payroll and Finance get their own keys so the entitlement can reach them (phase 2B)
-- #########################################################################

-- ============================================================================
-- Migration 158: move Payroll and Finance out of the campistryMe blob.
--
-- Phase 2B of ENTITLEMENTS_DESIGN.md. Phase 2A (157) can only enforce an
-- entitlement at the granularity the data is STORED at — the camp_state_kv key.
-- Payroll and Finance are the two branches actually worth withholding, and they
-- were both buried inside campistryMe, so 157 could not reach them. This gives
-- each its own key, and 157's per-key rule then covers them for free.
--
--     campistryMe.payroll                    -> campistryMePayroll
--     campistryMe.finance minus 'payments'   -> campistryMeFinance
--
-- ── WHY finance.payments DOES NOT MOVE ─────────────────────────────────────
-- The design doc said "move finance". Mapping the code says move MOST of it.
-- finance.payments is the family payment ledger, and it is written by SEVEN
-- edge functions doing read-modify-write on campistryMe:
--     cardknox-webhook, payments-hosted-complete, payments-charge-nonce,
--     charge-saved-card, charge-due-installments, stripe-webhook,
--     payments-checkout
-- and read by get_my_balance, the parent-facing balance RPC, at
-- me->'finance'->'payments' (rewritten across a dozen migrations up to 152).
--
-- Every one of those functions is deployed by pasting it into the Supabase
-- Dashboard one at a time. There is no atomic deploy, so moving the payments
-- path would open a window in which some processors append to the old location
-- and some to the new — silently losing recorded payments, which is the worst
-- failure this system has.
--
-- It is also the RIGHT filing, not just the safe one. finPayments is consumed
-- almost entirely by BILLING (record payment, refunds, family detail,
-- renderBilling), barely by Finance. It is Billing's ledger that happened to be
-- stored under 'finance' — and that misfiling is exactly what produced the
-- billing/finance data-loss bug that needed a hand-written per-sub-branch merge
-- guard in campistry_me.js. Splitting the two halves apart deletes that whole
-- class of bug instead of guarding against it.
--
-- Nothing server-side touches payroll or finance.{staff,expenses,budget,
-- integrations} — verified by grep across supabase/functions and migrations —
-- so those move with no function redeploys at all.
--
-- ── ORDERING: DEPLOY THE SITE FIRST, THEN RUN THIS ─────────────────────────
-- campistry_me.js reads the new key and FALLS BACK to the legacy branch when it
-- is absent, so the new client is correct both before and after this runs.
-- Running this before the deploy would hide payroll/finance from any still-open
-- old tab. Running it after is harmless. It is also idempotent: it only writes a
-- target key that is missing or empty, so a camp whose new client already saved
-- is left completely alone.
--
-- The legacy branches are deliberately NOT deleted here. They are the rollback:
-- if anything is wrong, revert the site and the old blob is still intact. The
-- new client stops writing them, so they simply go stale. Delete them later with
-- the statement at the bottom, once you are satisfied — not in the same step.
-- ============================================================================

-- ─── 1. Copy payroll into its own key ───────────────────────────────────────
-- Only for camps that actually have payroll data and no new-key row yet.
INSERT INTO camp_state_kv (camp_id, key, value, updated_at)
SELECT me.camp_id, 'campistryMePayroll', me.value -> 'payroll', now()
  FROM camp_state_kv me
 WHERE me.key = 'campistryMe'
   AND jsonb_typeof(me.value -> 'payroll') = 'object'
   AND me.value -> 'payroll' <> '{}'::jsonb
   AND NOT EXISTS (
        SELECT 1 FROM camp_state_kv t
         WHERE t.camp_id = me.camp_id
           AND t.key = 'campistryMePayroll'
           AND t.value IS NOT NULL
           AND t.value <> '{}'::jsonb
           AND t.value <> 'null'::jsonb )
ON CONFLICT (camp_id, key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = now();

-- ─── 2. Copy finance into its own key, MINUS payments ───────────────────────
-- '- payments' is jsonb key deletion: everything except the ledger.
INSERT INTO camp_state_kv (camp_id, key, value, updated_at)
SELECT me.camp_id, 'campistryMeFinance', (me.value -> 'finance') - 'payments', now()
  FROM camp_state_kv me
 WHERE me.key = 'campistryMe'
   AND jsonb_typeof(me.value -> 'finance') = 'object'
   AND ((me.value -> 'finance') - 'payments') <> '{}'::jsonb
   AND NOT EXISTS (
        SELECT 1 FROM camp_state_kv t
         WHERE t.camp_id = me.camp_id
           AND t.key = 'campistryMeFinance'
           AND t.value IS NOT NULL
           AND t.value <> '{}'::jsonb
           AND t.value <> 'null'::jsonb )
ON CONFLICT (camp_id, key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = now();

-- ─── 3. Teach 157's gate about the two new keys ─────────────────────────────
-- Now that the data lives in its own key, the entitlement can actually reach
-- it. camp_entitled() (per-section) is the right grain here, unlike the
-- whole-app keys in 157 — 'me' is one app with many sections, and payroll and
-- finance are two of them.
CREATE OR REPLACE FUNCTION public.camp_state_key_entitled(p_camp_id uuid, p_key text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    RETURN CASE p_key
        WHEN 'campistrySnacks'     THEN public.camp_entitled_any(p_camp_id, 'snacks')
        WHEN 'campistryHealth'     THEN public.camp_entitled_any(p_camp_id, 'health')
        WHEN 'campistry_notes_v1'  THEN public.camp_entitled_any(p_camp_id, 'notes')
        WHEN 'campistryShop'       THEN public.camp_entitled(p_camp_id, 'snacks', 'shop')
        WHEN 'campistryLuggage'    THEN public.camp_entitled(p_camp_id, 'go', 'luggage')
        -- New in 158: the two branches lifted out of campistryMe.
        WHEN 'campistryMePayroll'  THEN public.camp_entitled(p_camp_id, 'me', 'payroll')
        WHEN 'campistryMeFinance'  THEN public.camp_entitled(p_camp_id, 'me', 'finance')
        ELSE true
    END;
END;
$$;
REVOKE ALL ON FUNCTION public.camp_state_key_entitled(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.camp_state_key_entitled(uuid, text) TO authenticated, service_role;

-- ─── 4. Keep counselors out — THIS IS THE LOAD-BEARING PART ────────────────
-- A counselor cannot read campistryMe (migration 018/049/050/098 carve-out), so
-- until now they could not read payroll or finance either: staff pay rates, home
-- addresses, the camp's budget and expenses were protected by being buried in a
-- key they were denied.
--
-- Lifting them into their own keys would have QUIETLY UNDONE THAT. The SELECT
-- policy allows a counselor every key not named in its exclusion list, so two
-- brand-new keys are readable by default. Moving the data to enforce an
-- entitlement would have handed every counselor in every camp the payroll file.
--
-- Same policy as 157, with the two new keys added to the counselor exclusion.
DROP POLICY IF EXISTS camp_state_kv_select ON camp_state_kv;
CREATE POLICY camp_state_kv_select ON camp_state_kv
    FOR SELECT
    USING (
        camp_id = get_user_camp_id()
        AND camp_state_key_entitled(camp_id, key)
        AND (
            get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'manager'::text, 'scheduler'::text])
            OR (
                get_user_role() = 'counselor'::text
                AND key <> ALL (ARRAY['app1'::text, 'campistryMe'::text, 'campistryHealth'::text,
                                      'campistryMePayroll'::text, 'campistryMeFinance'::text])
            )
        )
    );

-- ─── Sanity checks ─────────────────────────────────────────────────────────
-- What moved:
--   select key, jsonb_object_keys(value) from camp_state_kv
--    where key in ('campistryMePayroll','campistryMeFinance');
--
-- The ledger must still be in campistryMe, where the edge functions and
-- get_my_balance expect it — this is the one that matters:
--   select camp_id, jsonb_array_length(value->'finance'->'payments') as payments
--     from camp_state_kv where key = 'campistryMe';
--
-- Counselors must not reach the new keys:
--   select policyname from pg_policies
--    where tablename='camp_state_kv' and policyname='camp_state_kv_select'
--      and qual like '%campistryMePayroll%';   -- expect 1 row
--
-- ── LATER, ONCE YOU ARE SATISFIED: drop the now-stale legacy branches. ──────
-- Only run this after the new client has been live long enough that no old tab
-- is still open, and after confirming the two queries above look right. It
-- deliberately keeps finance.payments.
--
--   UPDATE camp_state_kv
--      SET value = (value - 'payroll')
--                  || jsonb_build_object('finance',
--                       jsonb_build_object('payments',
--                         COALESCE(value->'finance'->'payments', '[]'::jsonb))),
--          updated_at = now()
--    WHERE key = 'campistryMe'
--      AND (value ? 'payroll' OR value ? 'finance');
-- ============================================================================


-- #########################################################################
-- ###### 159_access_registry_tables
-- ###### The capability registry and preset expansions, in SQL (generated)
-- #########################################################################

-- ============================================================================
-- Migration 159: the capability registry and preset expansions, in SQL.
--
-- GENERATED FILE — do not edit by hand.
-- Rebuild with:  node scripts/build-access-registry-sql.js
--
-- Phase 3 of ENTITLEMENTS_DESIGN.md enforces a STAFF MEMBER's section access in
-- RLS. Until now that layer was browser-only: a manager with payroll:none could
-- read campistryMePayroll straight out of the table with curl. To close that,
-- the database needs the two things that only existed as JavaScript — the
-- capability registry, and what each preset expands to once '*' and 'app.*' are
-- resolved.
--
-- These tables are DERIVED DATA, not configuration. Nobody edits them; they are
-- regenerated from campistry_capabilities.js, which stays the single source of
-- truth. tests/access_registry_sql.test.js fails if this file drifts from it.
--
-- Read-only to clients: RLS denies everything and the resolver reads them as
-- SECURITY DEFINER. They are not camp data — they are the same for every camp.
--
-- Idempotent: the tables are recreated and refilled from scratch each run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS access_capabilities (
    cap_key    text PRIMARY KEY,
    app        text NOT NULL,
    section    text NOT NULL,
    view_only  boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS access_preset_grants (
    preset     text NOT NULL,
    cap_key    text NOT NULL,
    level      text NOT NULL,
    -- Did the preset literally NAME this key, as opposed to inheriting the
    -- level from 'app.*' or '*'? Needed for the finance -> analytics legacy
    -- fallback in user_section_level(); see the header of the generator.
    explicit   boolean NOT NULL DEFAULT false,
    PRIMARY KEY (preset, cap_key)
);

-- Neither table is camp-scoped and neither is client-readable. The resolver is
-- SECURITY DEFINER, so it sees them regardless.
ALTER TABLE access_capabilities  ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_preset_grants ENABLE ROW LEVEL SECURITY;

-- Refill from scratch, so a removed capability or preset actually disappears
-- rather than lingering and granting access to a section that no longer exists.
TRUNCATE access_preset_grants;
TRUNCATE access_capabilities;

INSERT INTO access_capabilities (cap_key, app, section, view_only) VALUES
    ('flow.camper-locator', 'flow', 'camper-locator', false),
    ('flow.daily-adjustments', 'flow', 'daily-adjustments', false),
    ('flow.facilities', 'flow', 'facilities', false),
    ('flow.leagues', 'flow', 'leagues', false),
    ('flow.master-scheduler', 'flow', 'master-scheduler', false),
    ('flow.print', 'flow', 'print', false),
    ('flow.report', 'flow', 'report', true),
    ('flow.rules', 'flow', 'rules', false),
    ('flow.schedule', 'flow', 'schedule', false),
    ('flow.setup', 'flow', 'setup', false),
    ('flow.specialty-leagues', 'flow', 'specialty-leagues', false),
    ('flow.zones', 'flow', 'zones', false),
    ('go.addresses', 'go', 'addresses', false),
    ('go.fleet', 'go', 'fleet', false),
    ('go.luggage', 'go', 'luggage', false),
    ('go.routes', 'go', 'routes', false),
    ('go.setup', 'go', 'setup', false),
    ('go.staff', 'go', 'staff', false),
    ('guard.guard', 'guard', 'guard', false),
    ('health.allergies', 'health', 'allergies', false),
    ('health.campers', 'health', 'campers', false),
    ('health.dashboard', 'health', 'dashboard', false),
    ('health.doctor', 'health', 'doctor', false),
    ('health.intake', 'health', 'intake', false),
    ('health.medications', 'health', 'medications', false),
    ('health.nighttime', 'health', 'nighttime', false),
    ('health.reports', 'health', 'reports', true),
    ('health.sick-visits', 'health', 'sick-visits', false),
    ('link.dashboard', 'link', 'dashboard', false),
    ('link.forms', 'link', 'forms', false),
    ('link.lists', 'link', 'lists', false),
    ('link.messages', 'link', 'messages', false),
    ('link.parents', 'link', 'parents', false),
    ('link.photos', 'link', 'photos', false),
    ('link.tips', 'link', 'tips', false),
    ('live.absences', 'live', 'absences', false),
    ('live.camper-locator', 'live', 'camper-locator', true),
    ('live.camper-mail', 'live', 'camper-mail', false),
    ('live.changes', 'live', 'changes', false),
    ('live.early-pickup', 'live', 'early-pickup', false),
    ('live.messages', 'live', 'messages', false),
    ('live.reports', 'live', 'reports', true),
    ('live.roll-call', 'live', 'roll-call', false),
    ('me.analytics', 'me', 'analytics', true),
    ('me.billing', 'me', 'billing', false),
    ('me.bunkbuilder', 'me', 'bunkbuilder', false),
    ('me.campers', 'me', 'campers', false),
    ('me.enrollment', 'me', 'enrollment', false),
    ('me.finance', 'me', 'finance', true),
    ('me.payroll', 'me', 'payroll', false),
    ('me.printsheets', 'me', 'printsheets', false),
    ('me.reports', 'me', 'reports', true),
    ('me.settings', 'me', 'settings', false),
    ('me.structure', 'me', 'structure', false),
    ('notes.notes', 'notes', 'notes', false),
    ('snacks.accounts', 'snacks', 'accounts', false),
    ('snacks.dashboard', 'snacks', 'dashboard', false),
    ('snacks.menu', 'snacks', 'menu', false),
    ('snacks.pos', 'snacks', 'pos', false),
    ('snacks.settings', 'snacks', 'settings', false),
    ('snacks.shop', 'snacks', 'shop', false),
    ('snacks.transactions', 'snacks', 'transactions', false);

INSERT INTO access_preset_grants (preset, cap_key, level, explicit) VALUES
    ('bookkeeper', 'flow.camper-locator', 'none', false),
    ('bookkeeper', 'flow.daily-adjustments', 'none', false),
    ('bookkeeper', 'flow.facilities', 'none', false),
    ('bookkeeper', 'flow.leagues', 'none', false),
    ('bookkeeper', 'flow.master-scheduler', 'none', false),
    ('bookkeeper', 'flow.print', 'none', false),
    ('bookkeeper', 'flow.report', 'none', false),
    ('bookkeeper', 'flow.rules', 'none', false),
    ('bookkeeper', 'flow.schedule', 'none', false),
    ('bookkeeper', 'flow.setup', 'none', false),
    ('bookkeeper', 'flow.specialty-leagues', 'none', false),
    ('bookkeeper', 'flow.zones', 'none', false),
    ('bookkeeper', 'go.addresses', 'none', false),
    ('bookkeeper', 'go.fleet', 'none', false),
    ('bookkeeper', 'go.luggage', 'none', false),
    ('bookkeeper', 'go.routes', 'none', false),
    ('bookkeeper', 'go.setup', 'none', false),
    ('bookkeeper', 'go.staff', 'none', false),
    ('bookkeeper', 'guard.guard', 'none', false),
    ('bookkeeper', 'health.allergies', 'none', false),
    ('bookkeeper', 'health.campers', 'none', false),
    ('bookkeeper', 'health.dashboard', 'none', false),
    ('bookkeeper', 'health.doctor', 'none', false),
    ('bookkeeper', 'health.intake', 'none', false),
    ('bookkeeper', 'health.medications', 'none', false),
    ('bookkeeper', 'health.nighttime', 'none', false),
    ('bookkeeper', 'health.reports', 'none', false),
    ('bookkeeper', 'health.sick-visits', 'none', false),
    ('bookkeeper', 'link.dashboard', 'none', false),
    ('bookkeeper', 'link.forms', 'none', false),
    ('bookkeeper', 'link.lists', 'none', false),
    ('bookkeeper', 'link.messages', 'none', false),
    ('bookkeeper', 'link.parents', 'none', false),
    ('bookkeeper', 'link.photos', 'none', false),
    ('bookkeeper', 'link.tips', 'none', false),
    ('bookkeeper', 'live.absences', 'none', false),
    ('bookkeeper', 'live.camper-locator', 'none', false),
    ('bookkeeper', 'live.camper-mail', 'none', false),
    ('bookkeeper', 'live.changes', 'none', false),
    ('bookkeeper', 'live.early-pickup', 'none', false),
    ('bookkeeper', 'live.messages', 'none', false),
    ('bookkeeper', 'live.reports', 'none', false),
    ('bookkeeper', 'live.roll-call', 'none', false),
    ('bookkeeper', 'me.analytics', 'view', true),
    ('bookkeeper', 'me.billing', 'edit', true),
    ('bookkeeper', 'me.bunkbuilder', 'none', false),
    ('bookkeeper', 'me.campers', 'view', true),
    ('bookkeeper', 'me.enrollment', 'none', false),
    ('bookkeeper', 'me.finance', 'view', true),
    ('bookkeeper', 'me.payroll', 'edit', true),
    ('bookkeeper', 'me.printsheets', 'none', false),
    ('bookkeeper', 'me.reports', 'view', true),
    ('bookkeeper', 'me.settings', 'none', false),
    ('bookkeeper', 'me.structure', 'none', false),
    ('bookkeeper', 'notes.notes', 'none', false),
    ('bookkeeper', 'snacks.accounts', 'view', true),
    ('bookkeeper', 'snacks.dashboard', 'none', false),
    ('bookkeeper', 'snacks.menu', 'none', false),
    ('bookkeeper', 'snacks.pos', 'none', true),
    ('bookkeeper', 'snacks.settings', 'none', false),
    ('bookkeeper', 'snacks.shop', 'none', false),
    ('bookkeeper', 'snacks.transactions', 'view', true),
    ('bus-coordinator', 'flow.camper-locator', 'none', false),
    ('bus-coordinator', 'flow.daily-adjustments', 'none', false),
    ('bus-coordinator', 'flow.facilities', 'none', false),
    ('bus-coordinator', 'flow.leagues', 'none', false),
    ('bus-coordinator', 'flow.master-scheduler', 'none', false),
    ('bus-coordinator', 'flow.print', 'none', false),
    ('bus-coordinator', 'flow.report', 'none', false),
    ('bus-coordinator', 'flow.rules', 'none', false),
    ('bus-coordinator', 'flow.schedule', 'none', false),
    ('bus-coordinator', 'flow.setup', 'none', false),
    ('bus-coordinator', 'flow.specialty-leagues', 'none', false),
    ('bus-coordinator', 'flow.zones', 'none', false),
    ('bus-coordinator', 'go.addresses', 'edit', false),
    ('bus-coordinator', 'go.fleet', 'edit', false),
    ('bus-coordinator', 'go.luggage', 'edit', false),
    ('bus-coordinator', 'go.routes', 'edit', false),
    ('bus-coordinator', 'go.setup', 'edit', false),
    ('bus-coordinator', 'go.staff', 'edit', false),
    ('bus-coordinator', 'guard.guard', 'none', false),
    ('bus-coordinator', 'health.allergies', 'none', false),
    ('bus-coordinator', 'health.campers', 'none', false),
    ('bus-coordinator', 'health.dashboard', 'none', false),
    ('bus-coordinator', 'health.doctor', 'none', false),
    ('bus-coordinator', 'health.intake', 'none', false),
    ('bus-coordinator', 'health.medications', 'none', false),
    ('bus-coordinator', 'health.nighttime', 'none', false),
    ('bus-coordinator', 'health.reports', 'none', false),
    ('bus-coordinator', 'health.sick-visits', 'none', false),
    ('bus-coordinator', 'link.dashboard', 'none', false),
    ('bus-coordinator', 'link.forms', 'none', false),
    ('bus-coordinator', 'link.lists', 'none', false),
    ('bus-coordinator', 'link.messages', 'none', false),
    ('bus-coordinator', 'link.parents', 'none', false),
    ('bus-coordinator', 'link.photos', 'none', false),
    ('bus-coordinator', 'link.tips', 'none', false),
    ('bus-coordinator', 'live.absences', 'none', false),
    ('bus-coordinator', 'live.camper-locator', 'none', false),
    ('bus-coordinator', 'live.camper-mail', 'none', false),
    ('bus-coordinator', 'live.changes', 'none', false),
    ('bus-coordinator', 'live.early-pickup', 'none', false),
    ('bus-coordinator', 'live.messages', 'none', false),
    ('bus-coordinator', 'live.reports', 'none', false),
    ('bus-coordinator', 'live.roll-call', 'none', false),
    ('bus-coordinator', 'me.analytics', 'none', false),
    ('bus-coordinator', 'me.billing', 'none', false),
    ('bus-coordinator', 'me.bunkbuilder', 'none', false),
    ('bus-coordinator', 'me.campers', 'view', true),
    ('bus-coordinator', 'me.enrollment', 'none', false),
    ('bus-coordinator', 'me.finance', 'none', false),
    ('bus-coordinator', 'me.payroll', 'none', false),
    ('bus-coordinator', 'me.printsheets', 'none', false),
    ('bus-coordinator', 'me.reports', 'none', false),
    ('bus-coordinator', 'me.settings', 'none', false),
    ('bus-coordinator', 'me.structure', 'none', false),
    ('bus-coordinator', 'notes.notes', 'edit', true),
    ('bus-coordinator', 'snacks.accounts', 'none', false),
    ('bus-coordinator', 'snacks.dashboard', 'none', false),
    ('bus-coordinator', 'snacks.menu', 'none', false),
    ('bus-coordinator', 'snacks.pos', 'none', false),
    ('bus-coordinator', 'snacks.settings', 'none', false),
    ('bus-coordinator', 'snacks.shop', 'none', false),
    ('bus-coordinator', 'snacks.transactions', 'none', false),
    ('canteen', 'flow.camper-locator', 'none', false),
    ('canteen', 'flow.daily-adjustments', 'none', false),
    ('canteen', 'flow.facilities', 'none', false),
    ('canteen', 'flow.leagues', 'none', false),
    ('canteen', 'flow.master-scheduler', 'none', false),
    ('canteen', 'flow.print', 'none', false),
    ('canteen', 'flow.report', 'none', false),
    ('canteen', 'flow.rules', 'none', false),
    ('canteen', 'flow.schedule', 'none', false),
    ('canteen', 'flow.setup', 'none', false),
    ('canteen', 'flow.specialty-leagues', 'none', false),
    ('canteen', 'flow.zones', 'none', false),
    ('canteen', 'go.addresses', 'none', false),
    ('canteen', 'go.fleet', 'none', false),
    ('canteen', 'go.luggage', 'none', false),
    ('canteen', 'go.routes', 'none', false),
    ('canteen', 'go.setup', 'none', false),
    ('canteen', 'go.staff', 'none', false),
    ('canteen', 'guard.guard', 'none', false),
    ('canteen', 'health.allergies', 'none', false),
    ('canteen', 'health.campers', 'none', false),
    ('canteen', 'health.dashboard', 'none', false),
    ('canteen', 'health.doctor', 'none', false),
    ('canteen', 'health.intake', 'none', false),
    ('canteen', 'health.medications', 'none', false),
    ('canteen', 'health.nighttime', 'none', false),
    ('canteen', 'health.reports', 'none', false),
    ('canteen', 'health.sick-visits', 'none', false),
    ('canteen', 'link.dashboard', 'none', false),
    ('canteen', 'link.forms', 'none', false),
    ('canteen', 'link.lists', 'none', false),
    ('canteen', 'link.messages', 'none', false),
    ('canteen', 'link.parents', 'none', false),
    ('canteen', 'link.photos', 'none', false),
    ('canteen', 'link.tips', 'none', false),
    ('canteen', 'live.absences', 'none', false),
    ('canteen', 'live.camper-locator', 'none', false),
    ('canteen', 'live.camper-mail', 'none', false),
    ('canteen', 'live.changes', 'none', false),
    ('canteen', 'live.early-pickup', 'none', false),
    ('canteen', 'live.messages', 'none', false),
    ('canteen', 'live.reports', 'none', false),
    ('canteen', 'live.roll-call', 'none', false),
    ('canteen', 'me.analytics', 'none', false),
    ('canteen', 'me.billing', 'none', false),
    ('canteen', 'me.bunkbuilder', 'none', false),
    ('canteen', 'me.campers', 'view', true),
    ('canteen', 'me.enrollment', 'none', false),
    ('canteen', 'me.finance', 'none', false),
    ('canteen', 'me.payroll', 'none', false),
    ('canteen', 'me.printsheets', 'none', false),
    ('canteen', 'me.reports', 'none', false),
    ('canteen', 'me.settings', 'none', false),
    ('canteen', 'me.structure', 'none', false),
    ('canteen', 'notes.notes', 'none', false),
    ('canteen', 'snacks.accounts', 'edit', false),
    ('canteen', 'snacks.dashboard', 'edit', false),
    ('canteen', 'snacks.menu', 'edit', false),
    ('canteen', 'snacks.pos', 'edit', false),
    ('canteen', 'snacks.settings', 'edit', false),
    ('canteen', 'snacks.shop', 'edit', false),
    ('canteen', 'snacks.transactions', 'edit', false),
    ('division-head', 'flow.camper-locator', 'view', true),
    ('division-head', 'flow.daily-adjustments', 'edit', true),
    ('division-head', 'flow.facilities', 'none', false),
    ('division-head', 'flow.leagues', 'none', false),
    ('division-head', 'flow.master-scheduler', 'none', false),
    ('division-head', 'flow.print', 'edit', true),
    ('division-head', 'flow.report', 'view', true),
    ('division-head', 'flow.rules', 'none', false),
    ('division-head', 'flow.schedule', 'view', true),
    ('division-head', 'flow.setup', 'none', false),
    ('division-head', 'flow.specialty-leagues', 'none', false),
    ('division-head', 'flow.zones', 'none', false),
    ('division-head', 'go.addresses', 'none', false),
    ('division-head', 'go.fleet', 'none', false),
    ('division-head', 'go.luggage', 'none', false),
    ('division-head', 'go.routes', 'none', false),
    ('division-head', 'go.setup', 'none', false),
    ('division-head', 'go.staff', 'none', false),
    ('division-head', 'guard.guard', 'none', false),
    ('division-head', 'health.allergies', 'none', false),
    ('division-head', 'health.campers', 'none', false),
    ('division-head', 'health.dashboard', 'none', false),
    ('division-head', 'health.doctor', 'none', false),
    ('division-head', 'health.intake', 'none', false),
    ('division-head', 'health.medications', 'none', false),
    ('division-head', 'health.nighttime', 'none', false),
    ('division-head', 'health.reports', 'none', false),
    ('division-head', 'health.sick-visits', 'none', false),
    ('division-head', 'link.dashboard', 'none', false),
    ('division-head', 'link.forms', 'none', false),
    ('division-head', 'link.lists', 'none', false),
    ('division-head', 'link.messages', 'none', false),
    ('division-head', 'link.parents', 'none', false),
    ('division-head', 'link.photos', 'none', false),
    ('division-head', 'link.tips', 'none', false),
    ('division-head', 'live.absences', 'edit', false),
    ('division-head', 'live.camper-locator', 'view', false),
    ('division-head', 'live.camper-mail', 'edit', false),
    ('division-head', 'live.changes', 'edit', false),
    ('division-head', 'live.early-pickup', 'edit', false),
    ('division-head', 'live.messages', 'edit', false),
    ('division-head', 'live.reports', 'view', false),
    ('division-head', 'live.roll-call', 'edit', false),
    ('division-head', 'me.analytics', 'none', false),
    ('division-head', 'me.billing', 'none', false),
    ('division-head', 'me.bunkbuilder', 'edit', true),
    ('division-head', 'me.campers', 'view', true),
    ('division-head', 'me.enrollment', 'none', false),
    ('division-head', 'me.finance', 'none', false),
    ('division-head', 'me.payroll', 'none', false),
    ('division-head', 'me.printsheets', 'edit', true),
    ('division-head', 'me.reports', 'view', true),
    ('division-head', 'me.settings', 'none', false),
    ('division-head', 'me.structure', 'view', true),
    ('division-head', 'notes.notes', 'edit', true),
    ('division-head', 'snacks.accounts', 'none', false),
    ('division-head', 'snacks.dashboard', 'none', false),
    ('division-head', 'snacks.menu', 'none', false),
    ('division-head', 'snacks.pos', 'none', false),
    ('division-head', 'snacks.settings', 'none', false),
    ('division-head', 'snacks.shop', 'none', false),
    ('division-head', 'snacks.transactions', 'none', false),
    ('full', 'flow.camper-locator', 'edit', false),
    ('full', 'flow.daily-adjustments', 'edit', false),
    ('full', 'flow.facilities', 'edit', false),
    ('full', 'flow.leagues', 'edit', false),
    ('full', 'flow.master-scheduler', 'edit', false),
    ('full', 'flow.print', 'edit', false),
    ('full', 'flow.report', 'view', false),
    ('full', 'flow.rules', 'edit', false),
    ('full', 'flow.schedule', 'edit', false),
    ('full', 'flow.setup', 'edit', false),
    ('full', 'flow.specialty-leagues', 'edit', false),
    ('full', 'flow.zones', 'edit', false),
    ('full', 'go.addresses', 'edit', false),
    ('full', 'go.fleet', 'edit', false),
    ('full', 'go.luggage', 'edit', false),
    ('full', 'go.routes', 'edit', false),
    ('full', 'go.setup', 'edit', false),
    ('full', 'go.staff', 'edit', false),
    ('full', 'guard.guard', 'edit', false),
    ('full', 'health.allergies', 'edit', false),
    ('full', 'health.campers', 'edit', false),
    ('full', 'health.dashboard', 'edit', false),
    ('full', 'health.doctor', 'edit', false),
    ('full', 'health.intake', 'edit', false),
    ('full', 'health.medications', 'edit', false),
    ('full', 'health.nighttime', 'edit', false),
    ('full', 'health.reports', 'view', false),
    ('full', 'health.sick-visits', 'edit', false),
    ('full', 'link.dashboard', 'edit', false),
    ('full', 'link.forms', 'edit', false),
    ('full', 'link.lists', 'edit', false),
    ('full', 'link.messages', 'edit', false),
    ('full', 'link.parents', 'edit', false),
    ('full', 'link.photos', 'edit', false),
    ('full', 'link.tips', 'edit', false),
    ('full', 'live.absences', 'edit', false),
    ('full', 'live.camper-locator', 'view', false),
    ('full', 'live.camper-mail', 'edit', false),
    ('full', 'live.changes', 'edit', false),
    ('full', 'live.early-pickup', 'edit', false),
    ('full', 'live.messages', 'edit', false),
    ('full', 'live.reports', 'view', false),
    ('full', 'live.roll-call', 'edit', false),
    ('full', 'me.analytics', 'view', false),
    ('full', 'me.billing', 'edit', false),
    ('full', 'me.bunkbuilder', 'edit', false),
    ('full', 'me.campers', 'edit', false),
    ('full', 'me.enrollment', 'edit', false),
    ('full', 'me.finance', 'view', false),
    ('full', 'me.payroll', 'edit', false),
    ('full', 'me.printsheets', 'edit', false),
    ('full', 'me.reports', 'view', false),
    ('full', 'me.settings', 'edit', false),
    ('full', 'me.structure', 'edit', false),
    ('full', 'notes.notes', 'edit', false),
    ('full', 'snacks.accounts', 'edit', false),
    ('full', 'snacks.dashboard', 'edit', false),
    ('full', 'snacks.menu', 'edit', false),
    ('full', 'snacks.pos', 'edit', false),
    ('full', 'snacks.settings', 'edit', false),
    ('full', 'snacks.shop', 'edit', false),
    ('full', 'snacks.transactions', 'edit', false),
    ('head-counselor', 'flow.camper-locator', 'edit', false),
    ('head-counselor', 'flow.daily-adjustments', 'edit', false),
    ('head-counselor', 'flow.facilities', 'edit', false),
    ('head-counselor', 'flow.leagues', 'edit', false),
    ('head-counselor', 'flow.master-scheduler', 'edit', false),
    ('head-counselor', 'flow.print', 'edit', false),
    ('head-counselor', 'flow.report', 'view', false),
    ('head-counselor', 'flow.rules', 'edit', false),
    ('head-counselor', 'flow.schedule', 'edit', false),
    ('head-counselor', 'flow.setup', 'edit', false),
    ('head-counselor', 'flow.specialty-leagues', 'edit', false),
    ('head-counselor', 'flow.zones', 'edit', false),
    ('head-counselor', 'go.addresses', 'none', false),
    ('head-counselor', 'go.fleet', 'none', false),
    ('head-counselor', 'go.luggage', 'none', false),
    ('head-counselor', 'go.routes', 'none', false),
    ('head-counselor', 'go.setup', 'none', false),
    ('head-counselor', 'go.staff', 'none', false),
    ('head-counselor', 'guard.guard', 'none', false),
    ('head-counselor', 'health.allergies', 'none', false),
    ('head-counselor', 'health.campers', 'none', false),
    ('head-counselor', 'health.dashboard', 'none', false),
    ('head-counselor', 'health.doctor', 'none', false),
    ('head-counselor', 'health.intake', 'none', false),
    ('head-counselor', 'health.medications', 'none', false),
    ('head-counselor', 'health.nighttime', 'none', false),
    ('head-counselor', 'health.reports', 'none', false),
    ('head-counselor', 'health.sick-visits', 'none', false),
    ('head-counselor', 'link.dashboard', 'none', false),
    ('head-counselor', 'link.forms', 'none', false),
    ('head-counselor', 'link.lists', 'none', false),
    ('head-counselor', 'link.messages', 'none', false),
    ('head-counselor', 'link.parents', 'none', false),
    ('head-counselor', 'link.photos', 'none', false),
    ('head-counselor', 'link.tips', 'none', false),
    ('head-counselor', 'live.absences', 'edit', false),
    ('head-counselor', 'live.camper-locator', 'view', false),
    ('head-counselor', 'live.camper-mail', 'edit', false),
    ('head-counselor', 'live.changes', 'edit', false),
    ('head-counselor', 'live.early-pickup', 'edit', false),
    ('head-counselor', 'live.messages', 'edit', false),
    ('head-counselor', 'live.reports', 'view', false),
    ('head-counselor', 'live.roll-call', 'edit', false),
    ('head-counselor', 'me.analytics', 'none', false),
    ('head-counselor', 'me.billing', 'none', false),
    ('head-counselor', 'me.bunkbuilder', 'edit', true),
    ('head-counselor', 'me.campers', 'view', true),
    ('head-counselor', 'me.enrollment', 'none', false),
    ('head-counselor', 'me.finance', 'none', false),
    ('head-counselor', 'me.payroll', 'none', false),
    ('head-counselor', 'me.printsheets', 'edit', true),
    ('head-counselor', 'me.reports', 'view', true),
    ('head-counselor', 'me.settings', 'none', false),
    ('head-counselor', 'me.structure', 'view', true),
    ('head-counselor', 'notes.notes', 'edit', true),
    ('head-counselor', 'snacks.accounts', 'none', false),
    ('head-counselor', 'snacks.dashboard', 'none', false),
    ('head-counselor', 'snacks.menu', 'none', false),
    ('head-counselor', 'snacks.pos', 'none', false),
    ('head-counselor', 'snacks.settings', 'none', false),
    ('head-counselor', 'snacks.shop', 'none', false),
    ('head-counselor', 'snacks.transactions', 'none', false),
    ('nurse', 'flow.camper-locator', 'none', false),
    ('nurse', 'flow.daily-adjustments', 'none', false),
    ('nurse', 'flow.facilities', 'none', false),
    ('nurse', 'flow.leagues', 'none', false),
    ('nurse', 'flow.master-scheduler', 'none', false),
    ('nurse', 'flow.print', 'none', false),
    ('nurse', 'flow.report', 'none', false),
    ('nurse', 'flow.rules', 'none', false),
    ('nurse', 'flow.schedule', 'none', false),
    ('nurse', 'flow.setup', 'none', false),
    ('nurse', 'flow.specialty-leagues', 'none', false),
    ('nurse', 'flow.zones', 'none', false),
    ('nurse', 'go.addresses', 'none', false),
    ('nurse', 'go.fleet', 'none', false),
    ('nurse', 'go.luggage', 'none', false),
    ('nurse', 'go.routes', 'none', false),
    ('nurse', 'go.setup', 'none', false),
    ('nurse', 'go.staff', 'none', false),
    ('nurse', 'guard.guard', 'none', false),
    ('nurse', 'health.allergies', 'edit', false),
    ('nurse', 'health.campers', 'edit', false),
    ('nurse', 'health.dashboard', 'edit', false),
    ('nurse', 'health.doctor', 'edit', false),
    ('nurse', 'health.intake', 'edit', false),
    ('nurse', 'health.medications', 'edit', false),
    ('nurse', 'health.nighttime', 'edit', false),
    ('nurse', 'health.reports', 'view', false),
    ('nurse', 'health.sick-visits', 'edit', false),
    ('nurse', 'link.dashboard', 'none', false),
    ('nurse', 'link.forms', 'none', false),
    ('nurse', 'link.lists', 'none', false),
    ('nurse', 'link.messages', 'none', false),
    ('nurse', 'link.parents', 'none', false),
    ('nurse', 'link.photos', 'none', false),
    ('nurse', 'link.tips', 'none', false),
    ('nurse', 'live.absences', 'none', false),
    ('nurse', 'live.camper-locator', 'none', false),
    ('nurse', 'live.camper-mail', 'none', false),
    ('nurse', 'live.changes', 'none', false),
    ('nurse', 'live.early-pickup', 'none', false),
    ('nurse', 'live.messages', 'none', false),
    ('nurse', 'live.reports', 'none', false),
    ('nurse', 'live.roll-call', 'none', false),
    ('nurse', 'me.analytics', 'none', false),
    ('nurse', 'me.billing', 'none', false),
    ('nurse', 'me.bunkbuilder', 'none', false),
    ('nurse', 'me.campers', 'view', true),
    ('nurse', 'me.enrollment', 'none', false),
    ('nurse', 'me.finance', 'none', false),
    ('nurse', 'me.payroll', 'none', false),
    ('nurse', 'me.printsheets', 'none', false),
    ('nurse', 'me.reports', 'none', false),
    ('nurse', 'me.settings', 'none', false),
    ('nurse', 'me.structure', 'none', false),
    ('nurse', 'notes.notes', 'edit', true),
    ('nurse', 'snacks.accounts', 'none', false),
    ('nurse', 'snacks.dashboard', 'none', false),
    ('nurse', 'snacks.menu', 'none', false),
    ('nurse', 'snacks.pos', 'none', false),
    ('nurse', 'snacks.settings', 'none', false),
    ('nurse', 'snacks.shop', 'none', false),
    ('nurse', 'snacks.transactions', 'none', false),
    ('office', 'flow.camper-locator', 'none', false),
    ('office', 'flow.daily-adjustments', 'none', false),
    ('office', 'flow.facilities', 'none', false),
    ('office', 'flow.leagues', 'none', false),
    ('office', 'flow.master-scheduler', 'none', false),
    ('office', 'flow.print', 'none', false),
    ('office', 'flow.report', 'none', false),
    ('office', 'flow.rules', 'none', false),
    ('office', 'flow.schedule', 'none', false),
    ('office', 'flow.setup', 'none', false),
    ('office', 'flow.specialty-leagues', 'none', false),
    ('office', 'flow.zones', 'none', false),
    ('office', 'go.addresses', 'none', false),
    ('office', 'go.fleet', 'none', false),
    ('office', 'go.luggage', 'none', false),
    ('office', 'go.routes', 'none', false),
    ('office', 'go.setup', 'none', false),
    ('office', 'go.staff', 'none', false),
    ('office', 'guard.guard', 'none', false),
    ('office', 'health.allergies', 'none', false),
    ('office', 'health.campers', 'none', false),
    ('office', 'health.dashboard', 'none', false),
    ('office', 'health.doctor', 'none', false),
    ('office', 'health.intake', 'none', false),
    ('office', 'health.medications', 'none', false),
    ('office', 'health.nighttime', 'none', false),
    ('office', 'health.reports', 'none', false),
    ('office', 'health.sick-visits', 'none', false),
    ('office', 'link.dashboard', 'edit', false),
    ('office', 'link.forms', 'edit', false),
    ('office', 'link.lists', 'edit', false),
    ('office', 'link.messages', 'edit', false),
    ('office', 'link.parents', 'edit', false),
    ('office', 'link.photos', 'edit', false),
    ('office', 'link.tips', 'edit', false),
    ('office', 'live.absences', 'none', false),
    ('office', 'live.camper-locator', 'none', false),
    ('office', 'live.camper-mail', 'none', false),
    ('office', 'live.changes', 'none', false),
    ('office', 'live.early-pickup', 'none', false),
    ('office', 'live.messages', 'none', false),
    ('office', 'live.reports', 'none', false),
    ('office', 'live.roll-call', 'none', false),
    ('office', 'me.analytics', 'none', false),
    ('office', 'me.billing', 'edit', true),
    ('office', 'me.bunkbuilder', 'none', false),
    ('office', 'me.campers', 'edit', true),
    ('office', 'me.enrollment', 'edit', true),
    ('office', 'me.finance', 'none', false),
    ('office', 'me.payroll', 'none', false),
    ('office', 'me.printsheets', 'edit', true),
    ('office', 'me.reports', 'view', true),
    ('office', 'me.settings', 'none', false),
    ('office', 'me.structure', 'view', true),
    ('office', 'notes.notes', 'edit', true),
    ('office', 'snacks.accounts', 'none', false),
    ('office', 'snacks.dashboard', 'none', false),
    ('office', 'snacks.menu', 'none', false),
    ('office', 'snacks.pos', 'none', false),
    ('office', 'snacks.settings', 'none', false),
    ('office', 'snacks.shop', 'none', false),
    ('office', 'snacks.transactions', 'none', false),
    ('read-only', 'flow.camper-locator', 'view', false),
    ('read-only', 'flow.daily-adjustments', 'view', false),
    ('read-only', 'flow.facilities', 'view', false),
    ('read-only', 'flow.leagues', 'view', false),
    ('read-only', 'flow.master-scheduler', 'view', false),
    ('read-only', 'flow.print', 'view', false),
    ('read-only', 'flow.report', 'view', false),
    ('read-only', 'flow.rules', 'view', false),
    ('read-only', 'flow.schedule', 'view', false),
    ('read-only', 'flow.setup', 'view', false),
    ('read-only', 'flow.specialty-leagues', 'view', false),
    ('read-only', 'flow.zones', 'view', false),
    ('read-only', 'go.addresses', 'view', false),
    ('read-only', 'go.fleet', 'view', false),
    ('read-only', 'go.luggage', 'view', false),
    ('read-only', 'go.routes', 'view', false),
    ('read-only', 'go.setup', 'view', false),
    ('read-only', 'go.staff', 'view', false),
    ('read-only', 'guard.guard', 'view', false),
    ('read-only', 'health.allergies', 'view', false),
    ('read-only', 'health.campers', 'view', false),
    ('read-only', 'health.dashboard', 'view', false),
    ('read-only', 'health.doctor', 'view', false),
    ('read-only', 'health.intake', 'view', false),
    ('read-only', 'health.medications', 'view', false),
    ('read-only', 'health.nighttime', 'view', false),
    ('read-only', 'health.reports', 'view', false),
    ('read-only', 'health.sick-visits', 'view', false),
    ('read-only', 'link.dashboard', 'view', false),
    ('read-only', 'link.forms', 'view', false),
    ('read-only', 'link.lists', 'view', false),
    ('read-only', 'link.messages', 'view', false),
    ('read-only', 'link.parents', 'view', false),
    ('read-only', 'link.photos', 'view', false),
    ('read-only', 'link.tips', 'view', false),
    ('read-only', 'live.absences', 'view', false),
    ('read-only', 'live.camper-locator', 'view', false),
    ('read-only', 'live.camper-mail', 'view', false),
    ('read-only', 'live.changes', 'view', false),
    ('read-only', 'live.early-pickup', 'view', false),
    ('read-only', 'live.messages', 'view', false),
    ('read-only', 'live.reports', 'view', false),
    ('read-only', 'live.roll-call', 'view', false),
    ('read-only', 'me.analytics', 'view', false),
    ('read-only', 'me.billing', 'view', false),
    ('read-only', 'me.bunkbuilder', 'view', false),
    ('read-only', 'me.campers', 'view', false),
    ('read-only', 'me.enrollment', 'view', false),
    ('read-only', 'me.finance', 'view', false),
    ('read-only', 'me.payroll', 'view', false),
    ('read-only', 'me.printsheets', 'view', false),
    ('read-only', 'me.reports', 'view', false),
    ('read-only', 'me.settings', 'view', false),
    ('read-only', 'me.structure', 'view', false),
    ('read-only', 'notes.notes', 'view', false),
    ('read-only', 'snacks.accounts', 'view', false),
    ('read-only', 'snacks.dashboard', 'view', false),
    ('read-only', 'snacks.menu', 'view', false),
    ('read-only', 'snacks.pos', 'view', false),
    ('read-only', 'snacks.settings', 'view', false),
    ('read-only', 'snacks.shop', 'view', false),
    ('read-only', 'snacks.transactions', 'view', false);

-- ─── Verification ──────────────────────────────────────────────────────────
--   select count(*) from access_capabilities;    -- expect 62
--   select count(*) from access_preset_grants;   -- expect 558
--
-- Resolved levels for the two capabilities phase 3 gates, straight from the
-- JavaScript resolver. After applying 160, user_section_level() must agree with
-- every line of this:
--   me.payroll  role=owner    (no preset)        -> edit
--   me.payroll  role=admin    (no preset)        -> edit
--   me.payroll  role=manager  preset=bookkeeper       -> edit
--   me.payroll  role=manager  preset=bus-coordinator  -> none
--   me.payroll  role=manager  preset=canteen          -> none
--   me.payroll  role=manager  preset=division-head    -> none
--   me.payroll  role=manager  preset=full             -> edit
--   me.payroll  role=manager  preset=head-counselor   -> none
--   me.payroll  role=manager  preset=nurse            -> none
--   me.payroll  role=manager  preset=office           -> none
--   me.payroll  role=manager  preset=read-only        -> view
--   me.finance  role=owner    (no preset)        -> view
--   me.finance  role=admin    (no preset)        -> view
--   me.finance  role=manager  preset=bookkeeper       -> view
--   me.finance  role=manager  preset=bus-coordinator  -> none
--   me.finance  role=manager  preset=canteen          -> none
--   me.finance  role=manager  preset=division-head    -> none
--   me.finance  role=manager  preset=full             -> view
--   me.finance  role=manager  preset=head-counselor   -> none
--   me.finance  role=manager  preset=nurse            -> none
--   me.finance  role=manager  preset=office           -> none
--   me.finance  role=manager  preset=read-only        -> view
--
-- NOTE 'me.finance' never exceeds 'view' for ANYONE, the owner included — it is
-- flagged view-only in the registry. That is why migration 160 gates writes on
-- "not none" rather than "edit": gating on edit would make Finance permanently
-- unsaveable for every user in every camp.
-- ============================================================================


-- #########################################################################
-- ###### 160_per_user_key_rls
-- ###### A staff member's section access enforced in RLS, for the two Me keys (phase 3)
-- #########################################################################

-- ============================================================================
-- Migration 160: enforce a STAFF MEMBER's section access in the database.
--
-- Phase 3 of ENTITLEMENTS_DESIGN.md, and the last of the three access layers to
-- become real:
--
--     camp entitlement   (what the camp bought)    -> enforced by 157/158
--     user product_access (which apps)             -> browser only
--     user section_access (which sections)         -> browser only  <-- THIS
--
-- Until now section_access appeared in ZERO RLS policies. A manager or
-- scheduler configured with payroll:none could still read campistryMePayroll
-- out of camp_state_kv with curl and a valid session — pay rates, home
-- addresses, the lot — and write it back. The browser hid the page; nothing
-- stopped the request.
--
-- ── SCOPE: TWO KEYS, DELIBERATELY ──────────────────────────────────────────
-- The plan says "only for keys whose readers are all accounted for, one key at
-- a time". This does campistryMePayroll and campistryMeFinance and nothing
-- else, because those two are the only keys where that is honestly true: they
-- were created by migration 158, their only readers are campistry_me.js and
-- campistry_birthdays.js, and both were written in the same change.
--
-- NOT done here, on purpose:
--   * campistrySnacks — read by the POS (counselor role), the Snacks manager,
--     Campistry Lite and several parent-facing SECURITY DEFINER RPCs. Gating it
--     needs each of those audited first.
--   * campistryHealth, campistryShop, campistryLuggage — same reason, fewer
--     readers. Next, one at a time.
--   * campistryMe / app1 / campStructure — 55 user-session call sites,
--     including a raw REST fetch in a beforeunload handler and an anonymous
--     page that upserts the whole blob. Last, if ever.
--
-- ── WHY WRITES ARE GATED ON "NOT NONE" AND NOT ON "EDIT" ───────────────────
-- me.finance is flagged view-only in the capability registry, so C.resolve
-- never returns 'edit' for it — not for a manager, not for an admin, not for
-- the OWNER. Gating writes on level='edit' would therefore make Finance
-- permanently unsaveable for every user in every camp, and the failure would be
-- a silent RLS denial on save rather than anything the page reports.
--
-- view-only is a UI affordance (it greys out the controls), not a storage rule,
-- and the Finance page legitimately writes budget and expenses. So the storage
-- boundary here is "can this person reach the section at all", and edit-vs-view
-- stays where it already works. Revisit only with a view-only cap that the UI
-- genuinely never writes.
--
-- Idempotent. Requires 159 (the generated registry tables).
-- ============================================================================

-- ─── 1. The resolver ────────────────────────────────────────────────────────
-- A faithful mirror of C.resolve() in campistry_capabilities.js. Every branch
-- below exists because that function has it; the order is its order. If you
-- change one, change both — tests/access_registry_sql.test.js pins the JS side
-- and the truth table at the bottom of 159 is generated from it.
CREATE OR REPLACE FUNCTION public.user_section_level(p_camp_id uuid, p_cap_key text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_caller      uuid := auth.uid();
    v_app         text;
    v_section     text;
    v_view_only   boolean;
    v_role        text;
    v_products    jsonb;
    v_preset      text;
    v_overrides   jsonb;
    v_group_id    uuid;
    v_grp_found   boolean := false;
    v_grp_products jsonb;
    v_grp_preset   text;
    v_grp_sections jsonb;
    v_level       text;
    v_explicit    boolean;
    v_unconfigured boolean;
BEGIN
    IF v_caller IS NULL THEN RETURN 'none'; END IF;

    SELECT app, section, view_only
      INTO v_app, v_section, v_view_only
      FROM access_capabilities WHERE cap_key = p_cap_key;
    -- Not in the registry at all -> not a section we gate. Allow, matching
    -- S.level()'s "lvl === undefined ? 'edit'" rather than blocking a page we
    -- simply haven't catalogued.
    IF NOT FOUND THEN RETURN 'edit'; END IF;

    -- Camp owner: always full. Same short-circuit as get_my_access, and for the
    -- same reason — anything else and an owner can lock themselves out with no
    -- way back in. The CAMP ENTITLEMENT still caps them, but that is enforced
    -- separately (157) and is about what was bought, not who this is.
    IF EXISTS (SELECT 1 FROM camps WHERE id = p_camp_id AND owner = v_caller) THEN
        RETURN CASE WHEN v_view_only THEN 'view' ELSE 'edit' END;
    END IF;

    SELECT role, product_access, access_preset, section_access, access_group_id
      INTO v_role, v_products, v_preset, v_overrides, v_group_id
      FROM camp_users
     WHERE camp_id = p_camp_id AND user_id = v_caller
     LIMIT 1;

    -- Not a resolvable member. Fail OPEN, matching get_my_access. This is not a
    -- hole: every policy using this function also requires
    -- camp_id = get_user_camp_id(), so a non-member never reaches here. Failing
    -- closed would only lock out a legitimate user during the window where
    -- membership hasn't propagated.
    IF NOT FOUND THEN RETURN 'edit'; END IF;

    -- A group assignment replaces the member's own columns WHOLESALE (no
    -- merge) — migration 097's intended behaviour, and 154's fix. Branch on
    -- FOUND, never on "record IS NOT NULL": a group whose access_preset is NULL
    -- fails a row-value null test and would silently fall through to the
    -- member's own empty columns, which reads as unconfigured and grants
    -- everything. That exact bug is what 154 existed to fix.
    IF v_group_id IS NOT NULL THEN
        SELECT product_access, access_preset, section_access
          INTO v_grp_products, v_grp_preset, v_grp_sections
          FROM camp_access_groups WHERE id = v_group_id;
        v_grp_found := FOUND;
    END IF;
    IF v_grp_found THEN
        v_products  := v_grp_products;
        v_preset    := v_grp_preset;
        v_overrides := v_grp_sections;
    END IF;

    v_products  := COALESCE(v_products,  '[]'::jsonb);
    v_overrides := COALESCE(v_overrides, '{}'::jsonb);
    -- Normalise exactly as campistry_access_sections.js apply() does before it
    -- hands the access object to resolve(), because that normalisation is what
    -- the JS rules are actually written against:
    --
    --   preset: data.preset || null     -> an EMPTY STRING is no preset.
    --
    -- This matters. Without it, a preset column holding '' is "not NULL" here,
    -- so the user is treated as configured, the lookup finds no grant row, and
    -- the level falls to 'none' — locking someone out of a section the browser
    -- shows them, which is the worst kind of divergence to debug.
    IF v_preset = '' THEN v_preset := NULL; END IF;

    -- Owners and admins are never gated by the per-STAFF layers.
    IF v_role IN ('owner', 'admin') THEN
        RETURN CASE WHEN v_view_only THEN 'view' ELSE 'edit' END;
    END IF;

    -- The product gate comes first: no access to the app, no access to any of
    -- its sections.
    --
    -- An EMPTY products array means "no product restriction recorded", NOT "no
    -- products". resolve() itself would deny everything for [] — it tests
    -- `Array.isArray(products) && indexOf(app) < 0` with no length check — but
    -- it never sees one, because apply() maps an empty array to null first
    -- (`data.products.length ? data.products : null`) on BOTH the group and the
    -- member path. Reading camp_users/camp_access_groups directly, this
    -- function CAN see [], so the length test is what keeps it faithful.
    -- Dropping it would lock out every member whose product_access is [].
    IF jsonb_typeof(v_products) = 'array'
       AND jsonb_array_length(v_products) > 0
       AND NOT (v_products ? v_app) THEN
        RETURN 'none';
    END IF;

    -- THE BACKWARD-COMPATIBILITY RULE: a user with no preset and no overrides
    -- has never had section access configured, and keeps the behaviour from
    -- before section access existed — full use of every app they can open.
    v_unconfigured := (v_preset IS NULL AND v_overrides = '{}'::jsonb);

    IF v_unconfigured THEN
        v_level := 'edit';
    ELSE
        -- 'finance' was split out of what used to be one 'analytics' capability
        -- ("Analytics & Finance"). Access configured before that split only
        -- names 'analytics', so treating 'finance' as just another unlisted key
        -- would silently hide financial data from people who already had it.
        -- Until it is named explicitly — a real override, or a preset that
        -- names it — 'finance' simply IS 'analytics'. Recursing (rather than
        -- reading the analytics row directly) also picks up that key's own
        -- wildcard and legacy fallbacks.
        IF v_section = 'finance' AND NOT (v_overrides ? p_cap_key) THEN
            SELECT explicit INTO v_explicit
              FROM access_preset_grants
             WHERE preset = v_preset AND cap_key = p_cap_key;
            IF v_preset IS NULL OR NOT COALESCE(v_explicit, false) THEN
                RETURN public.user_section_level(p_camp_id, v_app || '.analytics');
            END IF;
        END IF;

        IF v_overrides ? p_cap_key THEN
            v_level := v_overrides ->> p_cap_key;
        ELSIF v_preset IS NOT NULL THEN
            SELECT level INTO v_level
              FROM access_preset_grants
             WHERE preset = v_preset AND cap_key = p_cap_key;
        ELSE
            -- Overrides exist but this key isn't among them and there is no
            -- preset: the owner is picking sections explicitly, so anything
            -- unlisted is off.
            v_level := 'none';
        END IF;
    END IF;

    IF v_level IS NULL OR v_level NOT IN ('none', 'view', 'edit') THEN
        v_level := 'none';
    END IF;

    -- A read-only role can never come out above 'view', whatever the preset
    -- says — the fail-closed floor from access_control.
    IF v_role IN ('viewer', 'counselor') AND v_level = 'edit' THEN
        v_level := 'view';
    END IF;
    IF v_view_only AND v_level = 'edit' THEN
        v_level := 'view';
    END IF;

    RETURN v_level;
END;
$$;
REVOKE ALL ON FUNCTION public.user_section_level(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.user_section_level(uuid, text) TO authenticated, service_role;

-- ─── 2. Which keys this applies to ──────────────────────────────────────────
-- One place, so read and write can never disagree. Anything not named returns
-- true: this migration cannot affect a key it does not list, which is what
-- makes adding the next key a one-line change with a bounded blast radius.
CREATE OR REPLACE FUNCTION public.camp_state_key_user_allowed(p_camp_id uuid, p_key text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    RETURN CASE p_key
        WHEN 'campistryMePayroll' THEN public.user_section_level(p_camp_id, 'me.payroll') <> 'none'
        WHEN 'campistryMeFinance' THEN public.user_section_level(p_camp_id, 'me.finance') <> 'none'
        ELSE true
    END;
END;
$$;
REVOKE ALL ON FUNCTION public.camp_state_key_user_allowed(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.camp_state_key_user_allowed(uuid, text) TO authenticated, service_role;

-- ─── 3. The policies ────────────────────────────────────────────────────────
-- 158's predicates with the per-user check conjoined. All FOUR policies that
-- can touch these keys are rewritten: Postgres OR-combines permissive policies,
-- so leaving one without the check would reopen the door through it. (099's two
-- counselor-snacks policies are scoped to key='campistrySnacks' and so cannot
-- reach these keys; they keep 157's entitlement gate and are left alone.)

DROP POLICY IF EXISTS camp_state_kv_select ON camp_state_kv;
CREATE POLICY camp_state_kv_select ON camp_state_kv
    FOR SELECT
    USING (
        camp_id = get_user_camp_id()
        AND camp_state_key_entitled(camp_id, key)
        AND camp_state_key_user_allowed(camp_id, key)
        AND (
            get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'manager'::text, 'scheduler'::text])
            OR (
                get_user_role() = 'counselor'::text
                AND key <> ALL (ARRAY['app1'::text, 'campistryMe'::text, 'campistryHealth'::text,
                                      'campistryMePayroll'::text, 'campistryMeFinance'::text])
            )
        )
    );

DROP POLICY IF EXISTS camp_state_kv_insert ON camp_state_kv;
CREATE POLICY camp_state_kv_insert ON camp_state_kv
    FOR INSERT
    WITH CHECK (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'manager'::text, 'scheduler'::text])
        AND camp_state_key_entitled(camp_id, key)
        AND camp_state_key_user_allowed(camp_id, key)
    );

DROP POLICY IF EXISTS camp_state_kv_update ON camp_state_kv;
CREATE POLICY camp_state_kv_update ON camp_state_kv
    FOR UPDATE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'manager'::text, 'scheduler'::text])
        AND camp_state_key_entitled(camp_id, key)
        AND camp_state_key_user_allowed(camp_id, key)
    );

DROP POLICY IF EXISTS camp_state_kv_delete ON camp_state_kv;
CREATE POLICY camp_state_kv_delete ON camp_state_kv
    FOR DELETE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = 'owner'::text
        AND camp_state_key_entitled(camp_id, key)
        AND camp_state_key_user_allowed(camp_id, key)
    );

-- ─── Sanity checks ─────────────────────────────────────────────────────────
-- As the OWNER, nothing changes — these must still read as they did:
--   select user_section_level('<camp>'::uuid, 'me.payroll');   -- edit
--   select user_section_level('<camp>'::uuid, 'me.finance');   -- view (view-only cap)
--
-- As an UNCONFIGURED staff member (no preset, no overrides) nothing changes
-- either — that is the backward-compatibility rule:
--   -- expect edit / view, NOT none
--
-- As a staff member on the 'nurse' preset:
--   select user_section_level('<camp>'::uuid, 'me.payroll');   -- none
--   select key from camp_state_kv where key = 'campistryMePayroll';  -- 0 rows
--
-- Every value the resolver should produce is listed in the generated truth
-- table at the bottom of migration 159. Compare against it:
--   select preset, level from access_preset_grants
--    where cap_key = 'me.payroll' order by preset;
--
-- All four policies must carry the per-user check — one that doesn't is a hole,
-- because Postgres ORs permissive policies together:
--   select policyname, cmd,
--          (coalesce(qual,'') || coalesce(with_check,'')
--             like '%camp_state_key_user_allowed%') as gated
--     from pg_policies where tablename = 'camp_state_kv' order by policyname;
--   -- expect the 4 unsuffixed policies true; the 2 *_counselor_snacks false
-- ============================================================================


-- #########################################################################
-- ###### 161_per_user_snacks_key_rls
-- ###### Per-user section access on campistrySnacks, counselor POS included (phase 3)
-- #########################################################################

-- ============================================================================
-- Migration 161: per-user section access on campistrySnacks.
--
-- Phase 3, second key. 160 did campistryMePayroll and campistryMeFinance;
-- this adds the canteen. Before this, any camp_user with a session could read
-- every camper's canteen balance, spending history and the whole transaction
-- ledger out of the API regardless of what their access was configured to be.
--
-- ── THE READER AUDIT (the prerequisite, done) ──────────────────────────────
-- campistrySnacks has far more consumers than the two Me keys, so each was
-- checked for whether it goes through RLS at all:
--
--   SUBJECT TO RLS (a real camp_user session doing a direct table call):
--     campistry_snacks.js        — the Snacks manager: select + upsert
--     campistry_snacks_pos.js    — the POS register: select + upsert
--     campistry_cloud_bootstrap.js — fetches it for Live / Health / Link admin
--
--   NOT SUBJECT TO RLS (bypasses it, by design, and must keep working):
--     ~20 SECURITY DEFINER RPCs (deposits, purchases, limits, auto-reload,
--     shop, PIN login) — parents are not camp_users and reach the canteen
--     only through these.
--     10 edge functions on the service role (canteen-auto-reload, the card
--     processor webhooks, the checkout starters).
--     campistry_link_parent.html — mentions camp_state_kv only in comments;
--     every real call is an RPC.
--     campistry_lite.js — does not touch snacks at all.
--
-- So the gate reaches exactly the three admin-side readers, and nothing a
-- parent or a scheduled job depends on.
--
-- ── WHY "ANY SNACKS SECTION" IS THE RIGHT GRAIN ────────────────────────────
-- campistrySnacks is ONE key holding seven sections' data together —
-- dashboard, transactions, accounts, menu, pos, shop, settings. A whole-key
-- gate therefore has to ask a whole-app question: has this person any snacks
-- access at all? If yes the key is readable and the browser keeps gating
-- sections within it, exactly as it does today. If no, the key is not theirs.
--
-- Effect per preset (role=manager), computed from the real resolver:
--     full, bookkeeper, canteen, read-only        -> ALLOWED
--     nurse, division-head, head-counselor,
--     office, bus-coordinator                     -> DENIED (the tightening)
-- An UNCONFIGURED user is allowed, per the backward-compatibility rule, so
-- nobody who was never configured is newly restricted.
--
-- ── THE POS KEEPS WORKING ──────────────────────────────────────────────────
-- This is the one that could have broken a camp mid-day. The register runs as
-- a COUNSELOR doing a direct upsert, permitted by migration 099's own policies.
-- Two things make it safe:
--
--   1. The gate is "not none", not "edit". A counselor can NEVER resolve to
--      'edit' — user_section_level floors viewer/counselor at 'view' — so an
--      edit-based gate would have killed every register in every camp.
--   2. An unconfigured counselor resolves snacks.pos to 'view', which passes.
--
-- A counselor deliberately configured with no snacks access does lose the
-- register, which is the intended meaning of that configuration.
--
-- Idempotent. Requires 159 + 160.
-- ============================================================================

-- ─── 1. "Does this user have ANY section of this app?" ──────────────────────
-- The user-level counterpart of camp_entitled_any (157). Derived from the
-- generated registry, so a new snacks section is included automatically rather
-- than needing this function edited.
CREATE OR REPLACE FUNCTION public.user_app_any_section(p_camp_id uuid, p_app text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_cap text;
BEGIN
    FOR v_cap IN SELECT cap_key FROM access_capabilities WHERE app = p_app LOOP
        IF public.user_section_level(p_camp_id, v_cap) <> 'none' THEN
            RETURN true;
        END IF;
    END LOOP;
    -- No sections catalogued for this app at all: not an app we gate. Allow,
    -- matching user_section_level's own "not in the registry -> edit".
    IF NOT EXISTS (SELECT 1 FROM access_capabilities WHERE app = p_app) THEN
        RETURN true;
    END IF;
    RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION public.user_app_any_section(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.user_app_any_section(uuid, text) TO authenticated, service_role;

-- ─── 2. Add the key to the one gate both read and write already call ────────
-- The four main camp_state_kv policies call camp_state_key_user_allowed, so
-- adding a key here is a function replace — no policy rewrite, and read and
-- write cannot drift apart. That indirection is deliberate: it is what makes
-- each additional key a one-line change with a bounded blast radius.
CREATE OR REPLACE FUNCTION public.camp_state_key_user_allowed(p_camp_id uuid, p_key text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    RETURN CASE p_key
        WHEN 'campistryMePayroll' THEN public.user_section_level(p_camp_id, 'me.payroll') <> 'none'
        WHEN 'campistryMeFinance' THEN public.user_section_level(p_camp_id, 'me.finance') <> 'none'
        -- New in 161. Whole-app question, because the key holds seven sections.
        WHEN 'campistrySnacks'    THEN public.user_app_any_section(p_camp_id, 'snacks')
        ELSE true
    END;
END;
$$;
REVOKE ALL ON FUNCTION public.camp_state_key_user_allowed(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.camp_state_key_user_allowed(uuid, text) TO authenticated, service_role;

-- ─── 3. Close the counselor POS carve-out — LOAD BEARING ───────────────────
-- Migration 099 gives a counselor its OWN insert/update policy on
-- key='campistrySnacks'. Postgres OR-combines permissive policies, so gating
-- the four main policies does nothing for a counselor: they would keep writing
-- the canteen through 099's policy no matter what their access said. This is
-- the same hole 157 had to close for the entitlement, in the same two policies.
--
-- Predicates otherwise unchanged from 157, so a camp that has Snacks and a
-- counselor with normal (unconfigured) access sees no difference.
DROP POLICY IF EXISTS camp_state_kv_insert_counselor_snacks ON camp_state_kv;
CREATE POLICY camp_state_kv_insert_counselor_snacks ON camp_state_kv
    FOR INSERT
    WITH CHECK (
        camp_id = get_user_camp_id()
        AND get_user_role() = 'counselor'::text
        AND key = 'campistrySnacks'::text
        AND camp_state_key_entitled(camp_id, key)
        AND camp_state_key_user_allowed(camp_id, key)
    );

DROP POLICY IF EXISTS camp_state_kv_update_counselor_snacks ON camp_state_kv;
CREATE POLICY camp_state_kv_update_counselor_snacks ON camp_state_kv
    FOR UPDATE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = 'counselor'::text
        AND key = 'campistrySnacks'::text
        AND camp_state_key_entitled(camp_id, key)
        AND camp_state_key_user_allowed(camp_id, key)
    );

-- ─── Sanity checks ─────────────────────────────────────────────────────────
-- The register must still work. As the counselor who runs the POS:
--   select user_app_any_section('<camp>'::uuid, 'snacks');   -- expect true
--   select value -> 'accounts' from camp_state_kv where key = 'campistrySnacks';
--
-- As a staff member on the 'nurse' preset, the canteen is no longer theirs:
--   select user_app_any_section('<camp>'::uuid, 'snacks');   -- expect false
--   select key from camp_state_kv where key = 'campistrySnacks';   -- 0 rows
--
-- ALL SIX policies must now carry the per-user check — the two counselor ones
-- included, or a counselor writes straight past it:
--   select policyname, cmd,
--          (coalesce(qual,'') || coalesce(with_check,'')
--             like '%camp_state_key_user_allowed%') as gated
--     from pg_policies where tablename = 'camp_state_kv' order by policyname;
--   -- expect 6 rows, gated = true on every one
-- ============================================================================


-- #########################################################################
-- ###### 162_reconcile_processor_charges
-- ###### Report card charges the ledger lost to a stale-tab overwrite (read-only)
-- #########################################################################

-- =============================================================================
-- 162 — find card charges the ledger has lost
--
-- WHY THIS EXISTS
--
-- campistryMe is a single camp_state_kv row that the browser rewrites WHOLE on
-- every save, from state it read at page load — and it is not the only writer.
-- charge-due-installments appends finance.payments and marks an installment
-- paid; the Stripe, Cardknox, BYOP and hosted-checkout handlers write the
-- card-on-file fields. A tab left open across an autopay run therefore wrote
-- back a blob that predated the charge: the payment vanished, the family owed
-- it again, and the installment reverted to 'pending' so the card was charged a
-- second time the following night.
--
-- campistry_finance_merge.js closes that window going forward. It cannot undo
-- what was already lost — the money left the card and Campistry has no record
-- of it — and a camp cannot be asked to diff a JSON blob against a processor
-- dashboard by hand.
--
-- So this reports it. For every succeeded charge in processor_transactions, it
-- looks for a payment in the camp's ledger that refers to it, and returns the
-- ones with nothing pointing at them.
--
-- READ-ONLY, ON PURPOSE
--
-- It writes nothing. processor_transactions carries no family_key, and the
-- Stripe autopay path does not record into it at all, so this cannot reliably
-- say WHOSE payment a gap is — only that one exists. Guessing an attribution
-- would credit the wrong household, which is the one outcome worse than a
-- missing payment. Where the processor's own metadata names a family, that is
-- passed through as a suggestion for a person to confirm.
--
-- Idempotent — safe to re-run. Requires 126 (processor_transactions) and 145
-- (_deposit_can_admin).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.reconcile_processor_charges(
    p_camp_id uuid,
    p_since   date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_me       jsonb;
    v_refs     text[];
    v_missing  jsonb;
    v_charged  bigint := 0;
    v_recorded bigint := 0;
BEGIN
    IF NOT _deposit_can_admin(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    SELECT value INTO v_me
      FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe';

    -- Every string a payment could use to name its processor charge. The
    -- shapes differ by rail and by era: `reference` is what the office sees,
    -- the intent/transaction ids are what the webhooks write, and the autopay
    -- cron builds its row id out of the charge id ("auto_pi_123"). A charge is
    -- accounted for if ANY payment mentions it in ANY of them.
    SELECT COALESCE(array_agg(DISTINCT t), '{}')
      INTO v_refs
      FROM (
        SELECT jsonb_array_elements(COALESCE(v_me->'finance'->'payments', '[]'::jsonb)) AS p
      ) s,
      LATERAL (VALUES
        (s.p->>'reference'),
        (s.p->>'stripePaymentIntentId'),
        (s.p->>'byopTransactionId'),
        (s.p->>'id')
      ) AS v(t)
     WHERE t IS NOT NULL AND t <> '';

    SELECT COALESCE(jsonb_agg(row_to_json(g)::jsonb ORDER BY g.created_at DESC), '[]'::jsonb),
           count(*)
      INTO v_missing, v_recorded
      FROM (
        SELECT pt.external_transaction_id,
               pt.processor_key,
               pt.amount_cents,
               pt.created_at,
               -- The autopay cron passes the family through as processor
               -- metadata. Present for some rails and eras and absent for
               -- others, so it is a suggestion to confirm, never an answer.
               COALESCE(pt.raw_response #>> '{metadata,familyKey}',
                        pt.raw_response #>> '{metadata,family_key}', '') AS suggested_family_key,
               COALESCE(pt.raw_response #>> '{metadata,familyName}',
                        pt.raw_response #>> '{metadata,family_name}', '') AS suggested_family_name
          FROM processor_transactions pt
         WHERE pt.camp_id = p_camp_id
           AND pt.kind = 'charge'
           AND lower(pt.status) IN ('succeeded', 'success', 'approved', 'captured', 'settled')
           AND (p_since IS NULL OR pt.created_at::date >= p_since)
           -- Matched loosely on purpose: a payment id of "auto_pi_123" names
           -- charge "pi_123" without equalling it.
           AND NOT EXISTS (
               SELECT 1 FROM unnest(v_refs) AS r
                WHERE r = pt.external_transaction_id
                   OR r LIKE '%' || pt.external_transaction_id
           )
      ) g;

    SELECT count(*) INTO v_charged
      FROM processor_transactions pt
     WHERE pt.camp_id = p_camp_id
       AND pt.kind = 'charge'
       AND lower(pt.status) IN ('succeeded', 'success', 'approved', 'captured', 'settled')
       AND (p_since IS NULL OR pt.created_at::date >= p_since);

    RETURN jsonb_build_object(
        'success', true,
        'charges', v_charged,
        'missing', v_missing,
        'missingCount', v_recorded,
        'missingCents', COALESCE((
            SELECT sum((m->>'amount_cents')::bigint) FROM jsonb_array_elements(v_missing) m
        ), 0),
        -- Said plainly so nobody reads a clean result as proof of a clean
        -- ledger: this table only ever held the non-Stripe rails, and the
        -- Stripe autopay path never wrote to it at all.
        'covers', 'Charges recorded in processor_transactions only. Stripe autopay charges are not recorded there, so a clean result here does not rule out a gap on Stripe — check the Stripe dashboard for the same dates.'
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.reconcile_processor_charges(uuid, date) TO authenticated;

NOTIFY pgrst, 'reload schema';


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
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'camps.entitlements column',
       CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
                          WHERE table_name='camps' AND column_name='entitlements')
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'get_my_access returns entitlements',
       CASE WHEN (SELECT prosrc FROM pg_proc WHERE proname='get_my_access' LIMIT 1) LIKE '%entitlements%'
            THEN 'OK' ELSE 'MISSING' END
-- Every permissive policy must carry the gate: Postgres ORs them together, so
-- one policy without it is a hole through the whole entitlement.
UNION ALL SELECT 'all 6 camp_state_kv policies entitlement-gated',
       CASE WHEN (SELECT count(*) FROM pg_policies
                   WHERE tablename='camp_state_kv'
                     AND COALESCE(qual,'') || COALESCE(with_check,'')
                         LIKE '%camp_state_key_entitled%') = 6
            THEN 'OK' ELSE 'MISSING' END
-- The payroll/finance split is only safe if counselors are excluded from the
-- two NEW keys. Being buried inside campistryMe used to keep them out; lifting
-- them into their own keys would otherwise hand every counselor the payroll
-- file, because the SELECT policy allows a counselor any key it does not name.
UNION ALL SELECT 'counselors excluded from the new payroll/finance keys',
       CASE WHEN (SELECT COALESCE(qual,'') FROM pg_policies
                   WHERE tablename='camp_state_kv' AND policyname='camp_state_kv_select')
                 LIKE '%campistryMePayroll%'
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'payroll/finance reachable by the entitlement',
       CASE WHEN (SELECT prosrc FROM pg_proc WHERE proname='camp_state_key_entitled' LIMIT 1)
                 LIKE '%campistryMeFinance%'
            THEN 'OK' ELSE 'MISSING' END
-- The ledger must NOT have moved: seven payment edge functions and
-- get_my_balance read campistryMe.finance.payments and were not redeployed.
UNION ALL SELECT 'payment ledger still in campistryMe',
       CASE WHEN NOT EXISTS (SELECT 1 FROM camp_state_kv
                              WHERE key='campistryMeFinance' AND value ? 'payments')
            THEN 'OK' ELSE 'LEDGER MOVED — INVESTIGATE' END
-- Phase 3. The registry tables are generated from campistry_capabilities.js;
-- if the counts are wrong the database is resolving against stale rules.
UNION ALL SELECT 'access registry loaded (' || (SELECT count(*)::text FROM access_capabilities)
                 || ' capabilities)',
       CASE WHEN (SELECT count(*) FROM access_capabilities) > 0
             AND (SELECT count(*) FROM access_preset_grants) =
                 (SELECT count(*) FROM access_capabilities)
                 * (SELECT count(DISTINCT preset) FROM access_preset_grants)
            THEN 'OK' ELSE 'MISSING' END
-- All SIX policies, the two counselor POS ones included: gating only the four
-- main policies leaves a counselor writing the canteen straight past the check,
-- because Postgres OR-combines permissive policies.
UNION ALL SELECT 'per-user section access on all 6 camp_state_kv policies',
       CASE WHEN (SELECT count(*) FROM pg_policies
                   WHERE tablename='camp_state_kv'
                     AND COALESCE(qual,'') || COALESCE(with_check,'')
                         LIKE '%camp_state_key_user_allowed%') = 6
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'snacks key gated per user',
       CASE WHEN (SELECT prosrc FROM pg_proc
                   WHERE proname='camp_state_key_user_allowed' LIMIT 1) LIKE '%campistrySnacks%'
            THEN 'OK' ELSE 'MISSING' END
-- me.finance is a view-only capability and never resolves to 'edit' for
-- anyone, the owner included. If the key gate ever tests for 'edit', Finance
-- becomes permanently unsaveable for every user in every camp.
UNION ALL SELECT 'finance writes gated on "not none", not "edit"',
       CASE WHEN (SELECT prosrc FROM pg_proc
                   WHERE proname='camp_state_key_user_allowed' LIMIT 1) LIKE '%<> ''none''%'
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'lost-charge reconciliation report',
       CASE WHEN EXISTS (SELECT 1 FROM pg_proc WHERE proname='reconcile_processor_charges')
            THEN 'OK' ELSE 'MISSING' END;
