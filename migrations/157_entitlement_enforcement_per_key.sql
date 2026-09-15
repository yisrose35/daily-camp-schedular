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
