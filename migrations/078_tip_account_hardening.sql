-- =============================================================================
-- Migration 078: Close a real account-hijack hole in tip payments, plus a
-- ledger-race fix, ahead of tips going live for real money this year.
--
-- Found in review, both real:
--
-- 1. ensure_my_tip_account() (migration 060) let ANY authenticated staff
--    member at a camp claim a co-worker's still-unclaimed link_staff_accounts
--    row purely by matching their display name — a string visible in the
--    Payroll UI/roster, not a secret. Anyone could call
--    ensure_my_tip_account({p_staff_name: 'Sarah M.'}) and silently take over
--    Sarah's row, then connect their OWN Stripe account — every parent tip
--    meant for Sarah would route to the attacker's bank account, with
--    Sarah's total_earned never reflecting it. migration 058 already has the
--    correct mechanism for this (claim_staff_tip_account(p_code), gated on
--    the row's real access_code) — this migration makes ensure_my_tip_account
--    require the SAME proof of identity when claiming an EXISTING row, while
--    keeping the friction-free self-service path for the safe case: a caller
--    with no row of their own and no existing row under that name still gets
--    one created instantly, no code needed (nothing to steal there — it's a
--    brand new row with zero balance/history).
--
--    campistry_lite.js's Tips tab already has a fallback UI for exactly this
--    outcome (a "We couldn't set up your tip account automatically... enter
--    your access code" card, wired to claim_staff_tip_account) — no client
--    change needed, it already does the right thing once this RPC starts
--    returning success:false for the claim-existing-row case.
--
-- 2. total_earned on link_staff_accounts was updated via a non-atomic
--    SELECT-then-UPDATE in stripe-connect-webhook (both the single-tip and
--    cart fan-out handlers) — two tips landing on the same staff member close
--    together could read the same starting value and one increment would be
--    silently lost, even though the real money correctly reached them via
--    Stripe. Adds increment_staff_total_earned(), an atomic single-statement
--    UPDATE, for the webhook to call instead.
-- =============================================================================

-- ─── 1. ensure_my_tip_account — require the access code to claim an
--        existing row; only a brand-new row stays code-free ────────────────
CREATE OR REPLACE FUNCTION public.ensure_my_tip_account(
    p_staff_name   text DEFAULT NULL,
    p_role         text DEFAULT '',
    p_access_code  text DEFAULT NULL
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
    code    text := btrim(coalesce(p_access_code, ''));
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
        -- An admin already pre-created this row (possibly with tips already
        -- recorded against it) — claiming it now requires proving identity
        -- via its real access_code, same as claim_staff_tip_account(). A
        -- bare name match is NOT proof of identity.
        IF code = '' OR upper(acct.access_code) <> upper(code) THEN
            RETURN jsonb_build_object('success', false, 'error', 'code_required');
        END IF;
        UPDATE link_staff_accounts SET user_id = caller, updated_at = now()
        WHERE id = acct.id
        RETURNING * INTO acct;
        RETURN jsonb_build_object('success', true, 'account', to_jsonb(acct));
    END IF;

    -- No existing row at all under this name — safe to self-provision
    -- instantly, there is nothing here for anyone to have stolen.
    INSERT INTO link_staff_accounts (camp_id, staff_name, role, user_id)
    VALUES (my_camp, nm, coalesce(p_role, ''), caller)
    ON CONFLICT (camp_id, lower(staff_name)) DO NOTHING
    RETURNING * INTO acct;

    IF NOT FOUND THEN
        -- Lost a race against a concurrent claim/insert for the same name —
        -- re-check rather than silently attaching to whatever is there now.
        SELECT * INTO acct FROM link_staff_accounts
        WHERE camp_id = my_camp AND lower(staff_name) = lower(nm) LIMIT 1;
        IF acct.user_id IS NULL THEN
            RETURN jsonb_build_object('success', false, 'error', 'code_required');
        ELSIF acct.user_id <> caller THEN
            RETURN jsonb_build_object('success', false, 'error', 'name_taken');
        END IF;
    END IF;

    RETURN jsonb_build_object('success', true, 'account', to_jsonb(acct));
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_my_tip_account(text, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.ensure_my_tip_account(text, text, text) TO authenticated;

-- Old 2-arg signature is superseded — drop it so nothing can call the
-- vulnerable version anymore (Postgres allows overloads by arg count, and a
-- stale cached client could otherwise still hit the old, unsafe function).
DROP FUNCTION IF EXISTS public.ensure_my_tip_account(text, text);

-- ─── 2. increment_staff_total_earned — atomic ledger credit ────────────────
-- Single-statement UPDATE instead of the webhook's old SELECT-then-UPDATE,
-- so two concurrent tips to the same staff member can never lose an
-- increment to a lost-update race. SECURITY DEFINER + service-role-only
-- (this is meant to be called from stripe-connect-webhook using the
-- service-role client, never from a user session — the amount comes from a
-- verified Stripe webhook payload, not user input).
CREATE OR REPLACE FUNCTION public.increment_staff_total_earned(p_account_id uuid, p_amount numeric)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    UPDATE link_staff_accounts
    SET total_earned = total_earned + p_amount, updated_at = now()
    WHERE id = p_account_id;
$$;

REVOKE ALL ON FUNCTION public.increment_staff_total_earned(uuid, numeric) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_staff_total_earned(uuid, numeric) TO service_role;

-- ─── Sanity check ────────────────────────────────────────────────────────
--   select ensure_my_tip_account('Some Existing Unclaimed Name', 'counselor', null);
--   -- expect: {"success": false, "error": "code_required"}
--   select ensure_my_tip_account('Some Existing Unclaimed Name', 'counselor', '<its real access_code>');
--   -- expect: {"success": true, "account": {...}}
--   select increment_staff_total_earned('<a real link_staff_accounts.id>'::uuid, 5.00);
-- =============================================================================
