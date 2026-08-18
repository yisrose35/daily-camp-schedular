-- =============================================================================
-- Migration 058: Staff self-service Stripe Connect via Campistry Lite
--
-- Until now, the ADMIN triggered Stripe Connect onboarding on a staff
-- member's behalf from Link Admin (stripe-connect-onboard, called with the
-- admin's own session). That's backwards for a feature that ends with a
-- real bank account attached to a real person — the actual tip recipient
-- should authenticate as themselves and connect their own account. This
-- migration adds the missing link between a link_staff_accounts row and a
-- real Campistry login (auth.uid()), so the receiver can do this themselves
-- from Campistry Lite (Tips tab), while Link Admin keeps its existing
-- owner/admin visibility (create accounts, set suggested amounts, view the
-- ledger) untouched.
--
-- Linking mechanism: a "claim" RPC, not an email match. link_staff_accounts
-- rows are created by an admin with just a name/role — no guarantee that
-- matches the staff member's real login email. The existing access_code
-- (already the credential for get_staff_tip_account) is reused as the
-- proof-of-identity for claiming: the staff member enters their code once
-- inside Lite, which links their auth.uid() to that row. From then on RLS
-- recognizes them directly, no code needed again.
-- =============================================================================

-- ─── 1. link_staff_accounts.user_id — the claim target ─────────────────────
ALTER TABLE link_staff_accounts
    ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id);

-- One claimed account per login (a person can't claim two staff rows).
CREATE UNIQUE INDEX IF NOT EXISTS idx_link_staff_accounts_user
    ON link_staff_accounts (user_id)
    WHERE user_id IS NOT NULL;

-- ─── 2. RLS — additive self-service policies ────────────────────────────────
-- Postgres OR's multiple permissive policies for the same command together,
-- so these just add a second path (a staff member's own row) alongside the
-- existing owner/admin/scheduler policies from migration 017 — nothing there
-- needs to change.
DROP POLICY IF EXISTS link_staff_accounts_self_select ON link_staff_accounts;
CREATE POLICY link_staff_accounts_self_select ON link_staff_accounts
    FOR SELECT
    USING (user_id = auth.uid());

DROP POLICY IF EXISTS link_staff_accounts_self_update ON link_staff_accounts;
CREATE POLICY link_staff_accounts_self_update ON link_staff_accounts
    FOR UPDATE
    USING (user_id = auth.uid());

-- ─── 3. Guard trigger — self-update may only touch Connect status columns ──
-- The self_update policy above is row-scoped, not column-scoped — Postgres
-- RLS has no column-level UPDATE restriction. Without this trigger, a staff
-- member's own (RLS-scoped) client could send an update({balance: 99999})
-- and it would pass RLS cleanly. This pins every ledger/identity column back
-- to its stored value whenever the update isn't coming from a trusted
-- caller (the service-role webhook, or an owner/admin acting through the
-- admin RLS path) — so the only columns a staff member's own session can
-- ever actually change are the Stripe Connect status ones (which is exactly
-- what stripe-connect-onboard/stripe-connect-status legitimately write).
CREATE OR REPLACE FUNCTION public.link_staff_accounts_guard_self_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    IF auth.role() = 'service_role'
       OR (get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text])) THEN
        RETURN NEW;
    END IF;

    NEW.camp_id        := OLD.camp_id;
    NEW.staff_name      := OLD.staff_name;
    NEW.role            := OLD.role;
    NEW.access_code     := OLD.access_code;
    NEW.balance         := OLD.balance;
    NEW.total_earned    := OLD.total_earned;
    NEW.total_paid_out  := OLD.total_paid_out;
    -- user_id is deliberately NOT pinned here: the only way a NULL user_id
    -- ever becomes non-NULL is claim_staff_tip_account() below, which runs
    -- SECURITY DEFINER and bypasses RLS/this trigger's table access outright
    -- (it still fires the trigger, but by the time it does, get_user_role()
    -- for a counselor caller fails the trusted-caller check above — so this
    -- column is simply left out of the pin list rather than special-cased).
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_link_staff_accounts_guard ON link_staff_accounts;
CREATE TRIGGER trg_link_staff_accounts_guard
    BEFORE UPDATE ON link_staff_accounts
    FOR EACH ROW
    EXECUTE FUNCTION public.link_staff_accounts_guard_self_update();

-- ─── 4. claim_staff_tip_account — link a real login to an access-code row ──
CREATE OR REPLACE FUNCTION public.claim_staff_tip_account(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    acct   link_staff_accounts;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF p_code IS NULL OR btrim(p_code) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_code');
    END IF;

    SELECT * INTO acct FROM link_staff_accounts
    WHERE upper(access_code) = upper(btrim(p_code))
    LIMIT 1;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_code');
    END IF;

    IF acct.user_id IS NOT NULL AND acct.user_id <> caller THEN
        RETURN jsonb_build_object('success', false, 'error', 'already_claimed');
    END IF;

    UPDATE link_staff_accounts SET user_id = caller, updated_at = now()
    WHERE id = acct.id;

    RETURN jsonb_build_object(
        'success', true, 'account_id', acct.id,
        'staff_name', acct.staff_name, 'role', acct.role
    );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_staff_tip_account(text) FROM public;
GRANT EXECUTE ON FUNCTION public.claim_staff_tip_account(text) TO authenticated;

-- ─── Sanity check ────────────────────────────────────────────────────────
--   select id, staff_name, user_id, stripe_charges_enabled from link_staff_accounts;
--   select claim_staff_tip_account('ABCD-1234');  -- as the staff member's own session
-- =============================================================================
