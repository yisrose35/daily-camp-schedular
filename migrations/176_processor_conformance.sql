-- ============================================================================
-- Migration 176: a processor cannot be connected until it can do everything
-- money requires — including handing back money.
--
-- THE PROBLEM THIS EXISTS TO PREVENT. Migration 175 taught Stripe to post a
-- chargeback to the family's ledger. Cardknox and Banquest had no such path, so
-- on those camps a chargeback still silently left the books overstating
-- collected cash. That is not a Cardknox bug or a Banquest bug — it is a gap in
-- how a processor gets ADDED. 126's catalog says adding one is "ONE INSERT plus
-- one adapter file", and nothing anywhere states what that adapter must be able
-- to do. So each new processor arrives with whatever its author remembered.
--
-- The catalog already has a `capabilities` column. Until now it was
-- documentation: nothing read it, so a processor could claim anything or
-- nothing. This makes it a CONTRACT.
--
--   * processor_required_capabilities() names what every processor must have.
--   * processor_conformance(key) reports what a given one is missing.
--   * A trigger on camp_processor_credentials REFUSES to connect a camp to a
--     processor that does not conform — every writer, not one function.
--
-- The last one is the point. A capability list nothing enforces is the same
-- documentation we already had. A camp can no longer be pointed at a processor
-- that cannot refund, cannot take a card off file, or cannot tell us a parent
-- disputed a charge — because the connect call fails and says which one.
--
-- ── WHY `chargeback` IS REQUIRED AND NOT OPTIONAL ──────────────────────────
-- A processor that cannot report a dispute does not merely lack a feature. It
-- means money leaves the camp's bank account and Campistry never learns, so the
-- balance the camp shows a parent is wrong and stays wrong. Every other
-- capability failing is visible — a charge that will not go through gets
-- noticed the same day. This one is silent, which is why it is a blocker rather
-- than a warning.
--
-- ── WHAT THIS MIGRATION CANNOT CHECK ───────────────────────────────────────
-- It checks a DECLARATION, not an implementation: a catalog row could claim
-- `"chargeback": true` while the webhook does nothing. That half is enforced in
-- the repository by tests/processor_conformance.test.js, which asserts every
-- active processor has an adapter file and a branch in the dispute webhook's
-- mapper. Both halves are needed; neither alone is enough.
--
-- Idempotent.
-- ============================================================================

-- ─── 1. what every processor must be able to do ─────────────────────────────
CREATE OR REPLACE FUNCTION public.processor_required_capabilities()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
    SELECT jsonb_build_object(
        -- Money in. Without this there is no point connecting anything.
        'charge',       'Take a payment from a saved card or a one-off token',
        -- Money back. A camp that cannot refund has to do it by hand at the
        -- processor, and Campistry''s ledger then disagrees with the bank.
        'refund',       'Return money for a payment we recorded',
        -- Cards on file, which is what autopay charges.
        'tokenization', 'Store a reusable card token we can charge later',
        'recurring',    'Charge that stored token off-session, with no parent present',
        -- Money taken back BY THE PARENT. The silent one — see the header.
        'chargeback',   'Tell us when a parent disputes a charge, so the ledger can reverse it'
    );
$$;
REVOKE ALL ON FUNCTION public.processor_required_capabilities() FROM public;
GRANT EXECUTE ON FUNCTION public.processor_required_capabilities()
    TO authenticated, service_role;


-- ─── 2. what a given processor is missing ───────────────────────────────────
-- Returns { ok, missing[], declared{} }. A capability declared as anything
-- other than boolean true counts as NOT present: 126 seeds one as the string
-- "per-account, confirm with processor", which is an honest note and is
-- precisely not a yes.
CREATE OR REPLACE FUNCTION public.processor_conformance(p_key text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_caps    jsonb;
    v_req     jsonb := public.processor_required_capabilities();
    v_missing jsonb := '[]'::jsonb;
    k         text;
BEGIN
    SELECT capabilities INTO v_caps FROM payment_processor_catalog WHERE key = p_key;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'unknown_processor',
                                  'processor', p_key);
    END IF;
    v_caps := COALESCE(v_caps, '{}'::jsonb);

    FOR k IN SELECT jsonb_object_keys(v_req) LOOP
        IF COALESCE(v_caps->>k, '') <> 'true' THEN
            v_missing := v_missing || jsonb_build_array(
                jsonb_build_object('capability', k, 'why', v_req->>k));
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'ok', jsonb_array_length(v_missing) = 0,
        'processor', p_key,
        'missing', v_missing,
        'declared', v_caps);
END;
$$;
REVOKE ALL ON FUNCTION public.processor_conformance(text) FROM public;
GRANT EXECUTE ON FUNCTION public.processor_conformance(text)
    TO authenticated, service_role;


-- ─── 3. declare what the three live processors actually do ──────────────────
-- Each of these states ALL FIVE required capabilities explicitly rather than
-- merging in the one that is new. Merging would have left a stale declaration
-- in place and the gate below would then refuse a processor that works — which
-- is exactly what would have happened to Banquest; see its note.
--
-- `||` still merges, so every capability NOT named here (ach, nativeSurcharge)
-- keeps whatever 126/127 seeded. Those are not required and several are honest
-- prose notes rather than claims, which is right and is left alone.

-- Stripe. charge/refund/recurring/tokenization were already declared in 126;
-- restated so this block is the one place to read a processor's contract.
-- chargeback: stripe-webhook handles charge.dispute.* and posts through
-- record_chargeback (migration 175).
UPDATE payment_processor_catalog
   SET capabilities = capabilities || '{"charge":true,"refund":true,
        "recurring":true,"tokenization":true,"chargeback":true}'::jsonb
 WHERE key = 'stripe';

-- Cardknox / Sola. chargeback: byop-dispute-webhook?processor=cardknox.
UPDATE payment_processor_catalog
   SET capabilities = capabilities || '{"charge":true,"refund":true,
        "recurring":true,"tokenization":true,"chargeback":true}'::jsonb
 WHERE key = 'cardknox';

-- Banquest. TWO corrections here, not one:
--
--   * chargeback -> true: byop-dispute-webhook?processor=banquest.
--   * recurring  -> true: 127 declared it as the prose note "NMI supports
--     recurring/Customer Vault schedules, not yet wired into
--     charge-due-installments". That was true when 127 was written and is not
--     true now — charge-due-installments has a banquestCharge() path and
--     charges Banquest camps' vaulted tokens off-session on every run. Left as
--     prose, the gate below would have read it as "not declared" and refused to
--     connect a camp to a processor that demonstrably works.
UPDATE payment_processor_catalog
   SET capabilities = capabilities || '{"charge":true,"refund":true,
        "recurring":true,"tokenization":true,"chargeback":true}'::jsonb
 WHERE key = 'banquest';

-- NOT touched: 'none' (migration 153). It is the sentinel for "this camp has
-- not chosen a processor" and declares every capability false on purpose, so
-- anything reading capabilities to decide whether to offer an action correctly
-- offers nothing. It must stay non-conformant: no camp should ever get a
-- camp_processor_credentials row pointing at it, and the gate below is what
-- makes that true rather than merely expected.


-- ─── 4. the gate ────────────────────────────────────────────────────────────
-- A TRIGGER rather than a rewrite of _admin_store_camp_processor_credentials.
-- Two reasons, and the first is the important one:
--
--   1. Re-declaring that function here would mean reproducing 126's body from
--      memory — the vault secret naming, the exact column list, the status
--      reset. Get one detail wrong and connecting a processor breaks in a way
--      that only shows up when a camp tries to take money. A trigger adds the
--      check without touching a line of working code.
--
--   2. It gates EVERY writer, not one function. Any future path that connects a
--      camp to a processor — a new admin tool, a self-serve flow, a backfill —
--      passes through this table and therefore through this check.
CREATE OR REPLACE FUNCTION public._enforce_processor_conformance()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_conf jsonb;
    v_miss text;
BEGIN
    v_conf := public.processor_conformance(NEW.processor_key);
    IF COALESCE((v_conf->>'ok')::boolean, false) THEN
        RETURN NEW;
    END IF;

    SELECT string_agg(m->>'capability', ', ')
      INTO v_miss
      FROM jsonb_array_elements(COALESCE(v_conf->'missing', '[]'::jsonb)) m;

    RAISE EXCEPTION
        'Cannot connect a camp to payment processor "%" — it does not declare: %. '
        'Every processor must be able to charge, refund, store and re-charge a '
        'card token, and report a dispute. A processor that cannot report a '
        'dispute lets money leave the camp''s bank account with nothing in '
        'Campistry to show for it. See migration 176.',
        NEW.processor_key, COALESCE(v_miss, 'unknown');
END;
$$;

DROP TRIGGER IF EXISTS trg_processor_conformance ON camp_processor_credentials;
CREATE TRIGGER trg_processor_conformance
    BEFORE INSERT OR UPDATE OF processor_key ON camp_processor_credentials
    FOR EACH ROW EXECUTE FUNCTION public._enforce_processor_conformance();


-- ─── Checking it ───────────────────────────────────────────────────────────
-- Every active processor should now conform:
--   select key, processor_conformance(key) from payment_processor_catalog
--    where active;
--   -- every row: "ok": true, "missing": []
--
-- And the gate should refuse a half-built one. Add a deliberately incomplete
-- processor, try to connect a camp to it, then remove it:
--   insert into payment_processor_catalog (key, label, capabilities)
--     values ('halfbuilt', 'Half Built', '{"charge":true}'::jsonb);
--   select processor_conformance('halfbuilt');
--   -- ok:false, missing lists refund, tokenization, recurring, chargeback
--   insert into camp_processor_credentials (camp_id, processor_key, vault_secret_id)
--     values ('<camp>'::uuid, 'halfbuilt', gen_random_uuid());
--   -- ERROR: ... does not declare: refund, tokenization, recurring, chargeback
--   delete from payment_processor_catalog where key='halfbuilt';
-- ============================================================================
