-- =============================================================================
-- Migration 060: Self-service tip account + payment handles for staff (Lite)
--
-- Two gaps found testing the auto-invite-on-hire flow end to end:
--
-- 1. A counselor's ONLY way to attach the Tips tab to their own login was to
--    enter an access code (migration 058's claim_staff_tip_account). But the
--    only place an access code is ever generated is when an admin manually
--    clicks "Add staff account" in Link Admin — a step that has nothing to
--    do with the hiring pipeline that now auto-invites them to Lite. A
--    freshly-hired counselor logging into Lite for the first time had no
--    code to enter and no way to get one without going back to a human.
--    Fix: ensure_my_tip_account() below lets a counselor's own Lite session
--    provision (or, if an admin happened to already create a matching row,
--    claim) their link_staff_accounts row directly — no code, no admin step.
--
-- 2. Zelle/Venmo/PayPal/Cash App handles (the fallback for staff who haven't
--    connected Stripe) could only be entered by an admin, in a totally
--    separate name-keyed list (campistry_link_admin.html's "Staff payment
--    info" section, stored in camp_state_kv). A counselor had no way to
--    enter their own. Fix: add the handle columns directly to
--    link_staff_accounts, which a staff member can already self-UPDATE per
--    migration 058's link_staff_accounts_self_update policy — the guard
--    trigger there only pins ledger/identity columns, so these new columns
--    are self-editable with no trigger change needed.
-- =============================================================================

-- ─── 1. link_staff_accounts: self-service payment handles ──────────────────
ALTER TABLE link_staff_accounts
    ADD COLUMN IF NOT EXISTS zelle_handle   text,
    ADD COLUMN IF NOT EXISTS venmo_handle   text,
    ADD COLUMN IF NOT EXISTS paypal_handle  text,
    ADD COLUMN IF NOT EXISTS cashapp_handle text;

-- ─── 2. ensure_my_tip_account — self-provision, no access code needed ──────
-- Order of resolution: (a) caller already has a claimed row → return it;
-- (b) an admin-precreated, still-unclaimed row exists for this name in this
-- camp → claim it, preserving any tips already recorded against that name;
-- (c) otherwise create a fresh row owned by the caller outright.
CREATE OR REPLACE FUNCTION public.ensure_my_tip_account(
    p_staff_name text DEFAULT NULL,
    p_role       text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller  uuid := auth.uid();
    my_camp uuid;
    acct    link_staff_accounts;
    nm      text := btrim(coalesce(p_staff_name, ''));
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    my_camp := get_user_camp_id();
    IF my_camp IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_camp');
    END IF;

    SELECT * INTO acct FROM link_staff_accounts WHERE user_id = caller LIMIT 1;
    IF FOUND THEN
        RETURN jsonb_build_object('success', true, 'account', to_jsonb(acct));
    END IF;

    IF nm = '' THEN nm := 'Staff member'; END IF;

    SELECT * INTO acct FROM link_staff_accounts
    WHERE camp_id = my_camp AND user_id IS NULL AND lower(staff_name) = lower(nm)
    LIMIT 1;
    IF FOUND THEN
        UPDATE link_staff_accounts SET user_id = caller, updated_at = now()
        WHERE id = acct.id
        RETURNING * INTO acct;
        RETURN jsonb_build_object('success', true, 'account', to_jsonb(acct));
    END IF;

    INSERT INTO link_staff_accounts (camp_id, staff_name, role, user_id)
    VALUES (my_camp, nm, coalesce(p_role, ''), caller)
    ON CONFLICT (camp_id, lower(staff_name)) DO UPDATE
        SET user_id = CASE WHEN link_staff_accounts.user_id IS NULL THEN caller ELSE link_staff_accounts.user_id END
    RETURNING * INTO acct;

    -- Name collided with someone else's already-claimed row (two staff members
    -- sharing a display name in the same camp) — surface it rather than
    -- silently handing back a row that isn't actually theirs.
    IF acct.user_id <> caller THEN
        RETURN jsonb_build_object('success', false, 'error', 'name_taken');
    END IF;

    RETURN jsonb_build_object('success', true, 'account', to_jsonb(acct));
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_my_tip_account(text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.ensure_my_tip_account(text, text) TO authenticated;

-- ─── 3. get_link_tip_targets — surface handles to the parent tip sheet ─────
-- Same anon-facing narrow projection as migration 057, now including the
-- self-entered handles so a parent sees them even for staff who haven't
-- connected Stripe yet, without needing the separate admin-entered list.
CREATE OR REPLACE FUNCTION public.get_link_tip_targets(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE result jsonb;
BEGIN
    IF p_camp_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_camp_id');
    END IF;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', a.id, 'staff_name', a.staff_name, 'role', a.role,
        'stripe_charges_enabled', a.stripe_charges_enabled,
        'zelle', a.zelle_handle, 'venmo', a.venmo_handle,
        'paypal', a.paypal_handle, 'cashapp', a.cashapp_handle
    )), '[]'::jsonb)
    INTO result
    FROM link_staff_accounts a
    WHERE a.camp_id = p_camp_id;

    RETURN jsonb_build_object('success', true, 'targets', result);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.get_link_tip_targets(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_link_tip_targets(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.get_link_tip_targets(uuid) TO authenticated;

-- ─── Sanity check ────────────────────────────────────────────────────────
--   select ensure_my_tip_account('Test Counselor', 'counselor');  -- as a counselor session
--   select zelle_handle, venmo_handle, paypal_handle, cashapp_handle
--     from link_staff_accounts limit 5;
--   select get_link_tip_targets('00000000-0000-0000-0000-000000000000'::uuid);
-- =============================================================================
