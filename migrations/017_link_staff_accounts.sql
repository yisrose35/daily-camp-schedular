-- ============================================================================
-- Migration: link_staff_accounts — tips land directly in the recipient's
--            own account
--
-- Every tipped staff member gets an account row. When a parent sends a tip,
-- submit_link_tip() credits the recipient's balance IN THE SAME TRANSACTION
-- as the tip insert — no manual reconciliation step. The staff member checks
-- their balance with a personal access code (same trust model as parent
-- access codes: the code is the credential), and the admin records payouts
-- which move money from balance → total_paid_out.
--
--   link_staff_accounts        — one row per staff member (balance ledger)
--   submit_link_tip()          — REPLACED: now also credits the account
--   get_staff_tip_account()    — staff-facing: balance + recent tips by code
--   record_staff_payout()      — admin-facing: atomic payout with role check
--
-- Requires migration 016 (link_tips).
-- ============================================================================

-- ─── 1. Table ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS link_staff_accounts (
    id             uuid          NOT NULL DEFAULT gen_random_uuid(),
    camp_id        uuid          NOT NULL,
    staff_name     text          NOT NULL,
    role           text          NOT NULL DEFAULT '',
    access_code    text          NOT NULL DEFAULT upper(
                       substring(encode(gen_random_bytes(2), 'hex') from 1 for 4) || '-' ||
                       substring(encode(gen_random_bytes(2), 'hex') from 1 for 4)
                   ),
    balance        numeric(10,2) NOT NULL DEFAULT 0,   -- earned − paid out
    total_earned   numeric(10,2) NOT NULL DEFAULT 0,
    total_paid_out numeric(10,2) NOT NULL DEFAULT 0,
    created_at     timestamptz   NOT NULL DEFAULT now(),
    updated_at     timestamptz   NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

-- One account per staff member per camp (case-insensitive)
CREATE UNIQUE INDEX IF NOT EXISTS idx_link_staff_accounts_camp_name
    ON link_staff_accounts (camp_id, lower(staff_name));

CREATE UNIQUE INDEX IF NOT EXISTS idx_link_staff_accounts_code
    ON link_staff_accounts (upper(access_code));

-- ─── 2. RLS — camp staff manage; the access-code RPC serves the staff member ──
ALTER TABLE link_staff_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS link_staff_accounts_select ON link_staff_accounts;
CREATE POLICY link_staff_accounts_select ON link_staff_accounts
    FOR SELECT
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'scheduler'::text])
    );

DROP POLICY IF EXISTS link_staff_accounts_insert ON link_staff_accounts;
CREATE POLICY link_staff_accounts_insert ON link_staff_accounts
    FOR INSERT
    WITH CHECK (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text])
    );

DROP POLICY IF EXISTS link_staff_accounts_update ON link_staff_accounts;
CREATE POLICY link_staff_accounts_update ON link_staff_accounts
    FOR UPDATE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text])
    );

DROP POLICY IF EXISTS link_staff_accounts_delete ON link_staff_accounts;
CREATE POLICY link_staff_accounts_delete ON link_staff_accounts
    FOR DELETE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text])
    );

-- ─── 3. submit_link_tip — REPLACED to credit the recipient's account ─────────
-- Same signature and validation as migration 016; the only change is the
-- account upsert after the tip insert (auto-creates the account on the
-- first tip a staff member receives).
CREATE OR REPLACE FUNCTION public.submit_link_tip(
    p_recipient_name text,
    p_recipient_role text DEFAULT '',
    p_amount         numeric DEFAULT 0,
    p_camper_name    text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    inv    link_parent_invites;
    new_id uuid;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF p_recipient_name IS NULL OR btrim(p_recipient_name) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_recipient');
    END IF;
    IF p_amount IS NULL OR p_amount < 1 OR p_amount > 500 THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_amount');
    END IF;

    SELECT * INTO inv
    FROM link_parent_invites
    WHERE user_id = caller
      AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
    ORDER BY created_at DESC
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;

    IF p_camper_name IS NOT NULL AND inv.camper_names IS NOT NULL
       AND NOT (inv.camper_names ? p_camper_name) THEN
        RETURN jsonb_build_object('success', false, 'error', 'camper_not_on_invite');
    END IF;

    INSERT INTO link_tips (
        camp_id, invite_id, user_id, camper_name,
        parent_name, parent_email, recipient_name, recipient_role, amount
    ) VALUES (
        inv.camp_id, inv.id, caller, p_camper_name,
        inv.parent_name, inv.parent_email,
        btrim(p_recipient_name), coalesce(p_recipient_role, ''), round(p_amount, 2)
    )
    RETURNING id INTO new_id;

    -- Credit the recipient's account in the same transaction
    INSERT INTO link_staff_accounts (camp_id, staff_name, role, balance, total_earned)
    VALUES (inv.camp_id, btrim(p_recipient_name), coalesce(p_recipient_role, ''), round(p_amount, 2), round(p_amount, 2))
    ON CONFLICT (camp_id, lower(staff_name)) DO UPDATE
    SET balance      = link_staff_accounts.balance      + EXCLUDED.balance,
        total_earned = link_staff_accounts.total_earned + EXCLUDED.total_earned,
        role         = CASE WHEN link_staff_accounts.role = '' THEN EXCLUDED.role ELSE link_staff_accounts.role END,
        updated_at   = now();

    RETURN jsonb_build_object('success', true, 'id', new_id);
END;
$$;

REVOKE ALL ON FUNCTION public.submit_link_tip(text, text, numeric, text) FROM public;
GRANT EXECUTE ON FUNCTION public.submit_link_tip(text, text, numeric, text) TO authenticated;

-- ─── 4. RPC: get_staff_tip_account — the staff member's own view ─────────────
-- The access code is the credential (256-bit codes are impractical here, but
-- 8 hex chars scoped to a single camp's staff list and revocable by deleting
-- the account row is proportionate for a tip-balance view). Anon-callable so
-- counselors don't need accounts.
CREATE OR REPLACE FUNCTION public.get_staff_tip_account(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    acct link_staff_accounts;
    tips jsonb;
BEGIN
    IF p_code IS NULL OR btrim(p_code) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_code');
    END IF;

    SELECT * INTO acct
    FROM link_staff_accounts
    WHERE upper(access_code) = upper(btrim(p_code))
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_code');
    END IF;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'amount',      t.amount,
        'camper_name', t.camper_name,
        'created_at',  t.created_at
    ) ORDER BY t.created_at DESC), '[]'::jsonb)
    INTO tips
    FROM (
        SELECT amount, camper_name, created_at
        FROM link_tips
        WHERE camp_id = acct.camp_id
          AND lower(recipient_name) = lower(acct.staff_name)
        ORDER BY created_at DESC
        LIMIT 50
    ) t;

    RETURN jsonb_build_object(
        'success',        true,
        'staff_name',     acct.staff_name,
        'role',           acct.role,
        'balance',        acct.balance,
        'total_earned',   acct.total_earned,
        'total_paid_out', acct.total_paid_out,
        'recent_tips',    tips
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_staff_tip_account(text) FROM public;
GRANT EXECUTE ON FUNCTION public.get_staff_tip_account(text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_staff_tip_account(text) TO authenticated;

-- ─── 5. RPC: record_staff_payout — admin pays the balance out ────────────────
-- Atomic: checks the caller is camp staff, clamps to the current balance.
CREATE OR REPLACE FUNCTION public.record_staff_payout(
    p_account_id uuid,
    p_amount     numeric DEFAULT NULL   -- NULL = pay out the full balance
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    acct link_staff_accounts;
    amt  numeric;
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF NOT (get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text])) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    SELECT * INTO acct
    FROM link_staff_accounts
    WHERE id = p_account_id
      AND camp_id = get_user_camp_id()
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_found');
    END IF;

    amt := coalesce(p_amount, acct.balance);
    IF amt <= 0 OR amt > acct.balance THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_amount', 'balance', acct.balance);
    END IF;
    amt := round(amt, 2);

    UPDATE link_staff_accounts
    SET balance        = balance - amt,
        total_paid_out = total_paid_out + amt,
        updated_at     = now()
    WHERE id = acct.id;

    RETURN jsonb_build_object('success', true, 'paid', amt, 'balance', acct.balance - amt);
END;
$$;

REVOKE ALL ON FUNCTION public.record_staff_payout(uuid, numeric) FROM public;
GRANT EXECUTE ON FUNCTION public.record_staff_payout(uuid, numeric) TO authenticated;

-- ─── 6. Backfill accounts from tips that predate this migration ──────────────
INSERT INTO link_staff_accounts (camp_id, staff_name, role, balance, total_earned)
SELECT t.camp_id,
       btrim(t.recipient_name),
       coalesce(max(t.recipient_role), ''),
       sum(t.amount),
       sum(t.amount)
FROM link_tips t
GROUP BY t.camp_id, btrim(t.recipient_name)
ON CONFLICT (camp_id, lower(staff_name)) DO NOTHING;

-- ─── 7. Sanity check ──────────────────────────────────────────────────────────
--   SELECT staff_name, balance, total_earned, access_code
--   FROM link_staff_accounts ORDER BY balance DESC;
-- ============================================================================
