-- ============================================================================
-- Migration 168: stop losing payments to a lost update.
--
-- THE RACE. Seven edge functions record money into the campistryMe blob —
-- cardknox-webhook, payments-hosted-complete, payments-charge-nonce,
-- charge-saved-card, charge-due-installments, stripe-webhook, payments-checkout
-- — and every one of them does this:
--
--     cur = SELECT value ...            -- read the whole blob
--     cur.finance.payments.push(...)    -- mutate in memory
--     UPSERT value = cur                -- write the whole blob back
--
-- with no lock and no version check. Two writers that overlap both read the
-- same blob, both append their own payment, and the second write silently
-- discards the first. The money left the card; Campistry has no record of it.
--
-- This is not theoretical for this app. Autopay runs nightly across every
-- family while card webhooks arrive independently, and a camp can have two
-- processors live at once. Migration 162's reconcile report exists to FIND
-- charges lost this way — this is the fix that stops making them.
--
-- The retry loop those functions already have does not help: it retries on a
-- WRITE ERROR, and a lost update is not an error. Both writes succeed.
--
-- ── THE SECOND BUG IN THE SAME LINES ───────────────────────────────────────
-- Each function checks "have I already recorded this transaction id?" before
-- appending — but that check is inside the same unlocked read-modify-write. A
-- processor that retries a webhook (Stripe does, routinely) can have two
-- deliveries in flight at once: both read a blob without the payment, both
-- pass the check, both append. The family is credited twice for one charge.
--
-- Under a row lock, both are impossible. The dedupe moves inside the lock, so
-- the second delivery sees the first one's row and returns alreadyRecorded.
--
-- ── WHY AN RPC AND NOT A FIX IN THE FUNCTIONS ──────────────────────────────
-- A lock has to be held across the read AND the write. The edge functions talk
-- to PostgREST, which is one HTTP request per statement — there is no
-- transaction spanning their SELECT and their UPSERT, so they CANNOT take one.
-- Moving the read-modify-write into a single SECURITY DEFINER function is the
-- only way to get a transaction around it.
--
-- ── ROLLOUT IS INCREMENTAL AND SAFE ────────────────────────────────────────
-- These functions are additive. An edge function still on the old blind-upsert
-- path keeps working exactly as it does today, so the seven can be redeployed
-- one at a time, in any order, with no coordinated cutover.
--
-- Idempotent.
-- ============================================================================

-- ─── 1. append a payment, atomically and at most once ───────────────────────
-- p_dedupe_key is the processor's own transaction id. Any existing payment
-- carrying it — under id, reference, byopTransactionId or stripePaymentIntentId
-- — means this charge is already recorded and nothing is appended.
CREATE OR REPLACE FUNCTION public.append_camp_payment(
    p_camp_id         uuid,
    p_payment         jsonb,
    p_dedupe_key      text DEFAULT NULL,
    p_update_on_match jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    now_ts    timestamptz := now();
    v_me      jsonb;
    v_fin     jsonb;
    v_pays    jsonb;
    v_exists  boolean := false;
    v_out     jsonb;
    v_hit     boolean := false;
    e         jsonb;
BEGIN
    IF p_camp_id IS NULL OR p_payment IS NULL OR jsonb_typeof(p_payment) <> 'object' THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_arguments');
    END IF;

    -- Create the row if the camp has never saved Campistry Me, so a first
    -- payment is not lost to a missing blob.
    INSERT INTO camp_state_kv (camp_id, key, value, updated_at)
    VALUES (p_camp_id, 'campistryMe', '{}'::jsonb, now_ts)
    ON CONFLICT (camp_id, key) DO NOTHING;

    -- The lock. Held to the end of the function, so the read, the dedupe check
    -- and the write are one atomic step and a concurrent writer waits rather
    -- than overwriting.
    SELECT value INTO v_me FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe'
     FOR UPDATE;
    IF v_me IS NULL OR jsonb_typeof(v_me) <> 'object' THEN v_me := '{}'::jsonb; END IF;

    v_fin  := COALESCE(v_me->'finance', '{}'::jsonb);
    IF jsonb_typeof(v_fin) <> 'object' THEN v_fin := '{}'::jsonb; END IF;
    v_pays := COALESCE(v_fin->'payments', '[]'::jsonb);
    IF jsonb_typeof(v_pays) <> 'array' THEN v_pays := '[]'::jsonb; END IF;

    IF p_dedupe_key IS NOT NULL AND p_dedupe_key <> '' THEN
        SELECT EXISTS (
            SELECT 1 FROM jsonb_array_elements(v_pays) p
             WHERE p->>'id' = p_dedupe_key
                OR p->>'reference' = p_dedupe_key
                OR p->>'byopTransactionId' = p_dedupe_key
                OR p->>'stripePaymentIntentId' = p_dedupe_key
        ) INTO v_exists;

        IF v_exists THEN
            -- Already here. Two different callers want different things:
            --
            --   p_update_on_match NULL  -> a retried webhook for a charge we
            --                              already recorded. Do nothing.
            --   p_update_on_match SET   -> a STATUS TRANSITION for a payment
            --                              we already have (Stripe sends
            --                              pending, then succeeded or failed
            --                              for the same intent). Patch the row
            --                              in place rather than appending a
            --                              second one for the same charge.
            IF p_update_on_match IS NULL OR jsonb_typeof(p_update_on_match) <> 'object' THEN
                RETURN jsonb_build_object('success', true, 'alreadyRecorded', true,
                                          'updated', false,
                                          'count', jsonb_array_length(v_pays));
            END IF;

            v_out := '[]'::jsonb;
            FOR e IN SELECT * FROM jsonb_array_elements(v_pays) LOOP
                IF NOT v_hit AND (
                       e->>'id' = p_dedupe_key
                    OR e->>'reference' = p_dedupe_key
                    OR e->>'byopTransactionId' = p_dedupe_key
                    OR e->>'stripePaymentIntentId' = p_dedupe_key) THEN
                    v_out := v_out || jsonb_build_array(e || p_update_on_match);
                    v_hit := true;
                ELSE
                    v_out := v_out || jsonb_build_array(e);
                END IF;
            END LOOP;

            v_fin := jsonb_set(v_fin, '{payments}', v_out, true);
            v_me  := jsonb_set(v_me,  '{finance}',  v_fin, true);
            UPDATE camp_state_kv SET value = v_me, updated_at = now_ts
             WHERE camp_id = p_camp_id AND key = 'campistryMe';

            RETURN jsonb_build_object('success', true, 'alreadyRecorded', true,
                                      'updated', true,
                                      'count', jsonb_array_length(v_out));
        END IF;
    END IF;

    v_pays := v_pays || jsonb_build_array(p_payment);
    v_fin  := jsonb_set(v_fin, '{payments}', v_pays, true);
    v_me   := jsonb_set(v_me,  '{finance}',  v_fin,  true);

    UPDATE camp_state_kv SET value = v_me, updated_at = now_ts
     WHERE camp_id = p_camp_id AND key = 'campistryMe';

    RETURN jsonb_build_object('success', true, 'alreadyRecorded', false,
                              'updated', false,
                              'count', jsonb_array_length(v_pays));
END;
$$;
-- The old 3-argument signature is dropped so a stale one cannot linger beside
-- the new one and be chosen by overload resolution.
DROP FUNCTION IF EXISTS public.append_camp_payment(uuid, jsonb, text);
REVOKE ALL ON FUNCTION public.append_camp_payment(uuid, jsonb, text, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_camp_payment(uuid, jsonb, text, jsonb) TO service_role;


-- ─── 2. merge fields onto one family, atomically ────────────────────────────
-- The other read-modify-write the payment functions do: setting the
-- card-on-file fields (byopCustomerRef, stripeCustomerId, paymentMethodLabel,
-- savedPaymentMethods, …) after a card is vaulted. Same lost-update window,
-- and losing these means autopay silently stops working for that family.
--
-- A SHALLOW merge of the named fields only. It never rewrites the whole family
-- record, so it cannot clobber a name, a household or a charge that the office
-- edited while the webhook was in flight.
CREATE OR REPLACE FUNCTION public.merge_camp_family_fields(
    p_camp_id    uuid,
    p_family_key text,
    p_fields     jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    now_ts timestamptz := now();
    v_me   jsonb;
    v_fam  jsonb;
BEGIN
    IF p_camp_id IS NULL OR COALESCE(p_family_key, '') = ''
       OR p_fields IS NULL OR jsonb_typeof(p_fields) <> 'object' THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_arguments');
    END IF;

    SELECT value INTO v_me FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe'
     FOR UPDATE;
    IF v_me IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_camp_data');
    END IF;

    v_fam := v_me #> ARRAY['families', p_family_key];
    IF v_fam IS NULL OR jsonb_typeof(v_fam) <> 'object' THEN
        RETURN jsonb_build_object('success', false, 'error', 'family_not_found');
    END IF;

    v_me := jsonb_set(v_me, ARRAY['families', p_family_key], v_fam || p_fields, true);

    UPDATE camp_state_kv SET value = v_me, updated_at = now_ts
     WHERE camp_id = p_camp_id AND key = 'campistryMe';

    RETURN jsonb_build_object('success', true, 'familyKey', p_family_key);
END;
$$;
REVOKE ALL ON FUNCTION public.merge_camp_family_fields(uuid, text, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_camp_family_fields(uuid, text, jsonb) TO service_role;


-- ─── Proving it works ──────────────────────────────────────────────────────
-- The race is a lost update, so the test is two writers at once. In two SQL
-- editor tabs, run these at the same time against a throwaway camp:
--
--   -- tab A
--   select append_camp_payment('<camp>'::uuid,
--       '{"id":"race_a","family":"A","amount":10,"status":"succeeded"}'::jsonb, 'race_a');
--   -- tab B
--   select append_camp_payment('<camp>'::uuid,
--       '{"id":"race_b","family":"B","amount":20,"status":"succeeded"}'::jsonb, 'race_b');
--
-- BOTH must survive:
--   select jsonb_array_length(value->'finance'->'payments')
--     from camp_state_kv where key='campistryMe';
--
-- And the same charge twice must land once:
--   select append_camp_payment('<camp>'::uuid, '{"id":"dup"}'::jsonb, 'dup');
--   select append_camp_payment('<camp>'::uuid, '{"id":"dup"}'::jsonb, 'dup');
--   -- the second returns alreadyRecorded: true
-- ============================================================================
