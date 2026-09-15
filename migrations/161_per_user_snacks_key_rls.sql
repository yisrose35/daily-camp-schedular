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
