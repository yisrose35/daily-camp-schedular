-- ============================================================================
-- Migration 164: per-user gate on campistryMe.
--
-- The last key. Read the honest scope below before expecting much of it.
--
-- ── WHAT THIS DOES ─────────────────────────────────────────────────────────
-- Adds campistryMe to camp_state_key_user_allowed, gated on "has this person
-- ANY me.* section". A user with every Me section off can no longer read or
-- write the row.
--
-- ── WHAT IT DOES NOT DO, AND CANNOT ────────────────────────────────────────
-- It cannot express "campers but not billing", which is what anyone actually
-- wants from gating Campistry Me. campistryMe is ONE row holding campers,
-- structure, bunk placements, families, payments, enrollments, sessions,
-- reports and settings together, and RLS gates rows, not JSON branches.
--
-- The obvious answer — do what 2B did for payroll and finance, and move the
-- sensitive branches to their own keys — does not work here. `families` holds
-- the card-on-file tokens and is read AND written by six edge functions
-- (cardknox-webhook, payments-hosted-complete, payments-charge-nonce,
-- charge-saved-card, send-broadcast, payments-hosted-link), exactly like
-- finance.payments. Every one of those is deployed by hand, one paste at a
-- time, so moving the path would open a window where some processors write to
-- the old location and some to the new — losing card tokens and recorded
-- payments. That is the same reasoning that kept finance.payments in place,
-- and it applies with more force here.
--
-- Real within-Me separation needs the RPC-mediated read/write from
-- ENTITLEMENTS_DESIGN.md §3 Option B: get_camp_state scrubbing branches on the
-- way out and save_camp_state merging on the way in. That is a refactor of 55
-- call sites, not a policy change, and it is not what this migration is.
--
-- ── SO IS THIS WORTH APPLYING? YES, BUT IT BITES NOBODY TODAY ──────────────
-- Every one of the nine presets grants me.campers, so no preset produces a
-- user with zero Me access. The gate therefore changes nothing for any camp
-- configured from a preset.
--
-- It is here because of what comes next: once owners can set access explicitly
-- per job and per person (migration 165 and the Teams & Access hub), "Go only,
-- no Me at all" becomes a configuration a camp will actually create — for a
-- bus coordinator, say. Without this the database would hand that person the
-- entire Me blob anyway. Shipping the gate now means it is already in place
-- when the first such configuration is saved, rather than being remembered
-- afterwards.
--
-- Idempotent. Requires 159, 160, 161, 163.
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
        -- 163
        WHEN 'campistryHealth'    THEN public.user_app_any_section(p_camp_id, 'health')
        WHEN 'campistryShop'      THEN public.user_section_level(p_camp_id, 'snacks.shop') <> 'none'
        WHEN 'campistryLuggage'   THEN public.user_section_level(p_camp_id, 'go.luggage') <> 'none'
        -- 164: whole-key only. See the header for why this cannot be per-branch.
        WHEN 'campistryMe'        THEN public.user_app_any_section(p_camp_id, 'me')
        ELSE true
    END;
END;
$$;
REVOKE ALL ON FUNCTION public.camp_state_key_user_allowed(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.camp_state_key_user_allowed(uuid, text) TO authenticated, service_role;

-- app1 and campStructure are deliberately NOT gated, and should not be:
-- campStructure and app1.camperRoster are read by Flow, Lite, Snacks, Go,
-- badges and an edge function. Neither can be treated as Me-owned by any
-- policy, and gating either on a Me capability would break pages that have
-- nothing to do with Campistry Me.

-- ─── Sanity checks ─────────────────────────────────────────────────────────
-- Nothing changes for a preset-configured camp — every preset grants
-- me.campers, so this is true for all nine:
--   select user_app_any_section('<camp>'::uuid, 'me');   -- expect true
--
-- It bites only an explicitly-configured user with no Me sections:
--   -- as such a user:
--   select key from camp_state_kv where key = 'campistryMe';   -- 0 rows
--
-- The full gated set is now seven keys:
--   select prosrc from pg_proc where proname = 'camp_state_key_user_allowed';
-- ============================================================================
