-- ============================================================================
-- Migration 163: per-user section access on campistryHealth, campistryShop
-- and campistryLuggage.
--
-- Phase 3, third step. 160 did the two Me keys, 161 the canteen; these three
-- finish the app-level keys. What is left after this is only the inseparable
-- core — campistryMe / app1 / campStructure — which stays last, if ever.
--
-- Adding a key is a CREATE OR REPLACE of camp_state_key_user_allowed and
-- nothing else: the four main policies call it by name, so read and write
-- cannot drift apart and no policy is rewritten here. That indirection is what
-- keeps each step this small.
--
-- ── THE READER AUDIT ───────────────────────────────────────────────────────
-- campistryHealth
--   RLS-subject: campistry_health.js (the Health app), and campistry_lite.js,
--     which reads AND writes it directly for the med-dispensing log.
--   Not RLS-subject: lite_counselor_state() (migration 050) is SECURITY
--     DEFINER and is how a counselor gets med status — counselors are already
--     excluded from campistryHealth by the SELECT policy and always have been,
--     so nothing about the Lite counselor path changes here.
--   Lite's loadHealth() already catches a failed read and carries on with what
--     it has, so a denial degrades rather than breaking the page.
--
-- campistryShop
--   RLS-subject: campistry_snacks_shop.js only.
--   Not RLS-subject: the parent-facing shop RPCs (047, 052, 107, 122), all
--     SECURITY DEFINER — parents are not camp_users and reach the shop only
--     through those.
--
-- campistryLuggage
--   RLS-subject: campistry_go_luggage.js only. No server-side consumer at all.
--
-- ── GRAIN ──────────────────────────────────────────────────────────────────
-- Matched to how migration 157 already gates these same keys for the CAMP
-- entitlement, so the camp-level and user-level rules read the same way:
--     campistryHealth   -> any health.* section   (the key holds nine)
--     campistryShop     -> snacks.shop            (one section, its own key)
--     campistryLuggage  -> go.luggage             (one section, its own key)
--
-- ── WHAT CHANGES, BY PRESET (role=manager) ─────────────────────────────────
--                     health   shop   luggage
--     full              yes     yes     yes
--     read-only         yes     yes     yes
--     nurse             yes     no      no
--     canteen           no      yes     no
--     bus-coordinator   no      no      yes
--     division-head     no      no      no
--     head-counselor    no      no      no
--     office            no      no      no
--     bookkeeper        no      no      no
--     (unconfigured)    yes     yes     yes
--
-- The row worth pausing on is head-counselor and division-head losing Health.
-- Those presets grant no health section, but a MANAGER on either of them can
-- read campistryHealth today — the counselor carve-out is role-based, so it
-- never covered them. After this they cannot. That is the point of the phase,
-- and medical records are the data it matters most for, but it IS a visible
-- change for a camp that configured its head staff that way: tell them before
-- applying, or a nurse-ish staff member will report Health as broken.
--
-- Nobody unconfigured is affected — the backward-compatibility rule holds, as
-- it does for every step of phase 3.
--
-- Idempotent. Requires 159 + 160 (and 161 for the snacks entry preserved here).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.camp_state_key_user_allowed(p_camp_id uuid, p_key text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    RETURN CASE p_key
        -- 160
        WHEN 'campistryMePayroll' THEN public.user_section_level(p_camp_id, 'me.payroll') <> 'none'
        WHEN 'campistryMeFinance' THEN public.user_section_level(p_camp_id, 'me.finance') <> 'none'
        -- 161
        WHEN 'campistrySnacks'    THEN public.user_app_any_section(p_camp_id, 'snacks')
        -- 163: new. Same grain migration 157 uses for the camp entitlement.
        WHEN 'campistryHealth'    THEN public.user_app_any_section(p_camp_id, 'health')
        WHEN 'campistryShop'      THEN public.user_section_level(p_camp_id, 'snacks.shop') <> 'none'
        WHEN 'campistryLuggage'   THEN public.user_section_level(p_camp_id, 'go.luggage') <> 'none'
        ELSE true
    END;
END;
$$;
REVOKE ALL ON FUNCTION public.camp_state_key_user_allowed(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.camp_state_key_user_allowed(uuid, text) TO authenticated, service_role;

-- No policy changes. The four main camp_state_kv policies (160) and the two
-- counselor POS policies (161) already call this function, and none of the
-- three keys added here is reachable through the counselor-snacks policies —
-- those are pinned to key='campistrySnacks'.

-- ─── Sanity checks ─────────────────────────────────────────────────────────
-- As a nurse: Health yes, canteen shop no.
--   select user_app_any_section('<camp>'::uuid, 'health');            -- true
--   select user_section_level('<camp>'::uuid, 'snacks.shop');         -- none
--
-- As a bus coordinator: luggage yes, health no.
--   select user_section_level('<camp>'::uuid, 'go.luggage');          -- view/edit
--   select key from camp_state_kv where key = 'campistryHealth';      -- 0 rows
--
-- The full set of keys now gated per user:
--   select prosrc from pg_proc where proname = 'camp_state_key_user_allowed';
--   -- expect campistryMePayroll, campistryMeFinance, campistrySnacks,
--   --        campistryHealth, campistryShop, campistryLuggage
--
-- Still six policies, all still carrying both checks:
--   select policyname,
--          (coalesce(qual,'') || coalesce(with_check,'')
--             like '%camp_state_key_user_allowed%') as user_gated,
--          (coalesce(qual,'') || coalesce(with_check,'')
--             like '%camp_state_key_entitled%')     as camp_gated
--     from pg_policies where tablename = 'camp_state_kv' order by policyname;
-- ============================================================================
