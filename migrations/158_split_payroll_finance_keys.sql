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
