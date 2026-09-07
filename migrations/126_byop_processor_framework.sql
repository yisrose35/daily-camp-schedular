-- ============================================================================
-- Migration 126: Bring-Your-Own Processor (BYOP) framework
--
-- Why: a camp raised switching to Campistry (Stripe-only) would cost them a
-- lot of money, because they already run their tuition/canteen billing
-- through their OWN negotiated merchant account with a traditional ISO
-- (Banquest / Cardknox-Sola / etc.) — often paired with a cash-discount or
-- surcharge program that nets them close to $0 in fees. Forcing them onto
-- Campistry's Stripe Connect setup would mean giving that up.
--
-- Researched this session: this is NOT how CampMinder or Campflow work
-- (both designate/embed their own processor) — it IS how AdmirePro works
-- (a donor/tuition platform for schools/nonprofits): the customer already
-- has their own merchant account, and the software just plugs into it.
-- Confirmed with the user: build this the versatile way — an extensible
-- CATALOG of supported processors (not a hardcoded 3-way enum), so adding
-- processor #4 later is "insert one catalog row + write one adapter file,"
-- never a new migration. Credential handoff is HUMAN-ASSISTED, not a
-- self-serve camp-facing form — see BYOP_SETUP.md for the actual runbook.
--
-- Deliberately additive: every existing camp defaults to 'stripe' and every
-- existing Stripe table/column (camps.stripe_account_id,
-- link_photo_purchases, canteen JSON blob RPCs, etc.) is completely
-- untouched. Nothing about a camp's behavior changes unless someone
-- explicitly walks it through the human-assisted BYOP setup.
--
-- Same convention as every other sensitive table this session has built:
-- RLS enabled, ZERO client-facing write policies, every write funneled
-- through a SECURITY DEFINER RPC or a service-role edge function. The one
-- new wrinkle: camp_processor_credentials never stores a raw credential at
-- all — only a Supabase Vault secret reference. A live processor API key
-- is a materially higher-trust secret than a Stripe Connect account id
-- (which this app already goes out of its way to never return to a
-- client) — it can move real money out of a camp's own account if leaked.
--
-- Idempotent — safe to re-run.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- Supabase Vault — if this fails with a permissions error, enable it once
-- via Dashboard → Database → Extensions → search "supabase_vault" → Enable,
-- then re-run this migration. No CLI needed either way.
CREATE EXTENSION IF NOT EXISTS supabase_vault CASCADE;


-- ─── 1. payment_processor_catalog ───────────────────────────────────────────
-- The extensible registry. Adding a new processor later is ONE INSERT here
-- plus one new adapter file in supabase/functions/_shared/adapters/ — never
-- a schema change. credential_fields describes what an adapter's
-- testConnection()/charge()/refund() actually need, purely for documentation
-- and for the (human-run) admin-connect-processor tool to know what to ask
-- for — it is never used to render any camp-facing form.
CREATE TABLE IF NOT EXISTS payment_processor_catalog (
    key               text PRIMARY KEY,       -- 'stripe', 'cardknox', 'banquest', ...
    label             text NOT NULL,          -- "Stripe", "Cardknox / Sola Payments", ...
    credential_fields jsonb NOT NULL DEFAULT '[]',
        -- e.g. [{"key":"apiKey","label":"Cardknox API Key","secret":true}]
    capabilities      jsonb NOT NULL DEFAULT '{}',
        -- e.g. {"charge":true,"refund":true,"recurring":true,"ach":true,
        --       "tokenization":true,"nativeSurcharge":false}
    adapter_module    text,                   -- informational: which .ts file implements this
    active            boolean NOT NULL DEFAULT true,
    created_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE payment_processor_catalog ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ppc_read_all ON payment_processor_catalog;
CREATE POLICY ppc_read_all ON payment_processor_catalog
    FOR SELECT USING (true);
    -- Read-only, non-sensitive (names/capabilities, no secrets) — safe for
    -- any authenticated (or anon) caller so Dashboard UI can list what's
    -- supported without hardcoding processor names in JS.

INSERT INTO payment_processor_catalog (key, label, credential_fields, capabilities, adapter_module) VALUES
    ('stripe', 'Stripe', '[]'::jsonb,
     '{"charge":true,"refund":true,"recurring":true,"ach":true,"tokenization":true,"nativeSurcharge":false}'::jsonb,
     'stripe (existing stripe-* functions — not part of the BYOP dispatcher)'),
    ('cardknox', 'Cardknox / Sola Payments',
     '[{"key":"apiKey","label":"Cardknox API Key","secret":true}]'::jsonb,
     '{"charge":true,"refund":true,"recurring":true,"ach":true,"tokenization":true,"nativeSurcharge":"per-account, confirm with processor"}'::jsonb,
     'supabase/functions/_shared/adapters/cardknox_adapter.ts')
ON CONFLICT (key) DO NOTHING;
-- Banquest / Accept Blue / anything else: add with the same INSERT shape
-- once a real adapter exists for it. Not seeded yet — no adapter exists yet
-- for either, and a catalog row with no matching adapter file would let a
-- camp get "connected" to a processor nothing can actually call.


-- ─── 2. camps.payment_processor_key ─────────────────────────────────────────
ALTER TABLE camps ADD COLUMN IF NOT EXISTS payment_processor_key text
    NOT NULL DEFAULT 'stripe'
    REFERENCES payment_processor_catalog(key);
    -- Every existing camp is already 'stripe' by default — zero behavior
    -- change for any camp that never touches BYOP.


-- ─── 3. camp_processor_credentials ──────────────────────────────────────────
-- One row per camp that has connected a non-Stripe processor. Never holds a
-- raw credential — vault_secret_id is a reference into vault.secrets, whose
-- decrypted value is a JSON blob shaped by that processor's
-- credential_fields (e.g. {"apiKey":"..."}). Only the admin-connect-processor
-- edge function (service-role only, run by a human after verifying the camp)
-- and the BYOP dispatcher functions (payments-checkout/-charge/-refund, also
-- service-role) ever decrypt it.
CREATE TABLE IF NOT EXISTS camp_processor_credentials (
    camp_id         uuid PRIMARY KEY REFERENCES camps(id),
    processor_key   text NOT NULL REFERENCES payment_processor_catalog(key),
    vault_secret_id uuid NOT NULL,
    status          text NOT NULL DEFAULT 'untested'
        CHECK (status IN ('untested', 'verified', 'failed')),
    last_verified_at timestamptz,
    connected_at    timestamptz NOT NULL DEFAULT now(),
    connected_by    uuid,     -- auth.uid() of the Campistry staffer who ran the setup, if known
    notes           text      -- free text audit trail, e.g. "confirmed via call with Jane, 2026-09-12"
);

ALTER TABLE camp_processor_credentials ENABLE ROW LEVEL SECURITY;
-- No client-facing policies at all — every access via the RPCs/functions below.


-- ─── 4. processor_transactions ───────────────────────────────────────────────
-- Deliberately SEPARATE from every existing Stripe-shaped table/column
-- (stripe_payment_intent_id etc., migrations 059/079/081) rather than trying
-- to retrofit those unique indexes — zero risk to already-working Stripe
-- flows. Only used by camps on a non-Stripe processor. The downstream
-- Billing ledger / canteen balance RPCs are called exactly the same way
-- regardless of which processor produced the money — this table is where
-- the processor-specific bookkeeping (idempotency, support/debug lookups)
-- actually lives.
CREATE TABLE IF NOT EXISTS processor_transactions (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    camp_id                  uuid NOT NULL REFERENCES camps(id),
    processor_key            text NOT NULL REFERENCES payment_processor_catalog(key),
    external_transaction_id text NOT NULL,   -- that processor's own charge/refund id
    kind                     text NOT NULL CHECK (kind IN ('charge', 'refund')),
    amount_cents             integer NOT NULL,
    status                   text NOT NULL,
    raw_response             jsonb,           -- for support/debugging only, never returned to any client
    created_at               timestamptz NOT NULL DEFAULT now(),
    UNIQUE (processor_key, external_transaction_id)
);

ALTER TABLE processor_transactions ENABLE ROW LEVEL SECURITY;
-- No client-facing policies — every access via the RPCs/functions below.


-- ─── 5. get_camp_payment_processor_status ───────────────────────────────────
-- Owner/admin-only read. Never returns the credential or the Vault secret
-- id — only what's safe to show on a settings screen.
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
        'status', COALESCE(v_row.status, CASE WHEN v_row.processor_key = 'stripe' THEN 'stripe_default' ELSE 'untested' END),
        'lastVerifiedAt', v_row.last_verified_at,
        'connectedAt', v_row.connected_at
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_camp_payment_processor_status(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_camp_payment_processor_status(uuid) TO authenticated;


-- ─── 6. _admin_store_camp_processor_credentials ─────────────────────────────
-- service_role ONLY — called exclusively by the admin-connect-processor
-- edge function, itself gated on the raw Supabase service-role key (see
-- BYOP_SETUP.md), which only the Campistry operator has. This is the
-- deliberately manual, human-assisted onboarding path: a Campistry staffer
-- verifies the camp over a call, then runs this once. There is no
-- camp-facing self-serve version of this on purpose.
--
-- p_vault_secret text is the RAW credential JSON blob (e.g.
-- '{"apiKey":"..."}') — stored via vault.create_secret and never persisted
-- anywhere else. Idempotent: re-running for the same camp replaces the
-- secret and resets status to 'untested' (the caller re-verifies before
-- flipping it to 'verified' — see the edge function).
CREATE OR REPLACE FUNCTION public._admin_store_camp_processor_credentials(
    p_camp_id       uuid,
    p_processor_key text,
    p_vault_secret  text,
    p_connected_by  uuid,
    p_notes         text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, pg_catalog
AS $$
DECLARE
    v_secret_id uuid;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM payment_processor_catalog WHERE key = p_processor_key AND active) THEN
        RETURN jsonb_build_object('success', false, 'error', 'unknown_or_inactive_processor');
    END IF;

    -- Replace any prior secret for this camp+processor rather than leaking
    -- an orphaned one — delete-then-create is fine here, this only ever
    -- runs by hand, never under concurrent load.
    DELETE FROM vault.secrets
     WHERE id = (SELECT vault_secret_id FROM camp_processor_credentials WHERE camp_id = p_camp_id);

    SELECT vault.create_secret(p_vault_secret, 'byop:' || p_camp_id || ':' || p_processor_key) INTO v_secret_id;

    INSERT INTO camp_processor_credentials (camp_id, processor_key, vault_secret_id, status, connected_by, notes)
    VALUES (p_camp_id, p_processor_key, v_secret_id, 'untested', p_connected_by, p_notes)
    ON CONFLICT (camp_id) DO UPDATE
        SET processor_key   = EXCLUDED.processor_key,
            vault_secret_id = EXCLUDED.vault_secret_id,
            status          = 'untested',
            connected_at    = now(),
            connected_by    = EXCLUDED.connected_by,
            notes           = EXCLUDED.notes;

    UPDATE camps SET payment_processor_key = p_processor_key WHERE id = p_camp_id;

    RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public._admin_store_camp_processor_credentials(uuid, text, text, uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._admin_store_camp_processor_credentials(uuid, text, text, uuid, text) TO service_role;


-- ─── 7. _admin_mark_processor_verified / _admin_get_processor_credential ────
-- service_role ONLY. The first flips status after a real testConnection()
-- call succeeds (done by the edge function, not by this migration); the
-- second is how the BYOP dispatcher functions (payments-checkout/-charge/
-- -refund) actually retrieve the decrypted credential at charge time —
-- kept as its own function (rather than a raw SELECT) so a decrypted
-- credential is never fetched by anything except through this one,
-- audited, service_role-only choke point.
CREATE OR REPLACE FUNCTION public._admin_mark_processor_verified(p_camp_id uuid, p_ok boolean)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    UPDATE camp_processor_credentials
       SET status = CASE WHEN p_ok THEN 'verified' ELSE 'failed' END,
           last_verified_at = now()
     WHERE camp_id = p_camp_id;
$$;

REVOKE ALL ON FUNCTION public._admin_mark_processor_verified(uuid, boolean) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._admin_mark_processor_verified(uuid, boolean) TO service_role;

CREATE OR REPLACE FUNCTION public._admin_get_processor_credential(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, pg_catalog
AS $$
DECLARE
    v_processor_key text;
    v_decrypted     text;
BEGIN
    SELECT cred.processor_key, ds.decrypted_secret
      INTO v_processor_key, v_decrypted
      FROM camp_processor_credentials cred
      JOIN vault.decrypted_secrets ds ON ds.id = cred.vault_secret_id
     WHERE cred.camp_id = p_camp_id AND cred.status = 'verified';

    IF v_decrypted IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_connected_or_not_verified');
    END IF;

    RETURN jsonb_build_object('success', true, 'processorKey', v_processor_key, 'credentials', v_decrypted::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public._admin_get_processor_credential(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._admin_get_processor_credential(uuid) TO service_role;


-- ─── 8. record_processor_transaction ────────────────────────────────────────
-- service_role ONLY, called by the BYOP dispatcher functions after a real
-- charge/refund call to that processor's API succeeds. Idempotent via the
-- UNIQUE (processor_key, external_transaction_id) constraint above.
CREATE OR REPLACE FUNCTION public.record_processor_transaction(
    p_camp_id  uuid,
    p_processor_key text,
    p_external_transaction_id text,
    p_kind text,
    p_amount_cents integer,
    p_status text,
    p_raw_response jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    INSERT INTO processor_transactions
        (camp_id, processor_key, external_transaction_id, kind, amount_cents, status, raw_response)
    VALUES (p_camp_id, p_processor_key, p_external_transaction_id, p_kind, p_amount_cents, p_status, p_raw_response)
    ON CONFLICT (processor_key, external_transaction_id) DO UPDATE
        SET status = EXCLUDED.status, raw_response = EXCLUDED.raw_response;
    RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.record_processor_transaction(uuid, text, text, text, integer, text, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_processor_transaction(uuid, text, text, text, integer, text, jsonb) TO service_role;


-- ─── Sanity checks (run manually after applying) ───────────────────────────
--   SELECT key, label, active FROM payment_processor_catalog;
--   -- expect: stripe, cardknox
--
--   SELECT proname, proacl FROM pg_proc
--   WHERE proname IN ('get_camp_payment_processor_status','_admin_store_camp_processor_credentials',
--                      '_admin_mark_processor_verified','_admin_get_processor_credential',
--                      'record_processor_transaction');
--   -- expect: get_camp_payment_processor_status grants to authenticated;
--   -- every other one grants to service_role ONLY.
--
--   SELECT * FROM pg_policies WHERE tablename IN ('camp_processor_credentials','processor_transactions');
--   -- expect ZERO rows — no client-facing policy on either table.
--
--   SELECT * FROM pg_policies WHERE tablename = 'payment_processor_catalog';
--   -- expect exactly one row (ppc_read_all, SELECT, true) — this table alone is meant to be world-readable.
-- ============================================================================
