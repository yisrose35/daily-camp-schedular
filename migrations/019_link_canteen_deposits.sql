-- ============================================================================
-- Migration: submit_canteen_deposit + get_canteen_accounts
--
-- Why: Campistry Snacks stores canteen balances as one JSON blob in
--      camp_state_kv (key='campistrySnacks', shape
--      { accounts: { camperName: {balance,dailyLimit,spentToday} },
--        transactions: [...] }). The admin Snacks dashboard
--      (campistry_snacks.js) reads/writes this directly under an
--      authenticated camp-staff session (RLS allows owner/admin/scheduler).
--
--      Parents have no such session — Campistry Link's "Add Funds" button
--      previously wrote straight to the PARENT'S OWN browser localStorage
--      and never called any cloud path at all, so a deposit added from the
--      parent portal never reached Supabase, never appeared in Campistry
--      Snacks, and never appeared on any other device (including the
--      parent's own, after a reload).
--
-- These RPCs let an authenticated parent (verified via their invite, same
-- pattern as submit_link_tip/submit_camper_mail) safely deposit funds into
-- their OWN camper's canteen account, and read live balances — by mutating
-- the SAME camp_state_kv row the admin dashboard already uses, so nothing
-- about the existing Snacks/POS system needs to change.
-- ============================================================================

-- ─── 1. submit_canteen_deposit ────────────────────────────────────────────────
-- SECURITY DEFINER. Guarantees the camp_state_kv row exists, then locks it
-- (SELECT ... FOR UPDATE) before reading — closes the race window where two
-- concurrent first-ever writes (or a parent deposit racing an admin/POS
-- write) could otherwise clobber each other on a read-modify-write blob.
CREATE OR REPLACE FUNCTION public.submit_canteen_deposit(
    p_camper_name text,
    p_amount      numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller  uuid := auth.uid();
    inv     link_parent_invites;
    v_value jsonb;
    v_bal   numeric;
    now_ts  timestamptz := now();
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF p_camper_name IS NULL OR btrim(p_camper_name) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_camper');
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

    IF inv.camper_names IS NOT NULL AND NOT (inv.camper_names ? p_camper_name) THEN
        RETURN jsonb_build_object('success', false, 'error', 'camper_not_on_invite');
    END IF;

    -- Ensure a row exists so there's always something to lock, then lock it.
    INSERT INTO camp_state_kv (camp_id, key, value, updated_at)
    VALUES (inv.camp_id, 'campistrySnacks', '{"accounts":{},"transactions":[]}'::jsonb, now_ts)
    ON CONFLICT (camp_id, key) DO NOTHING;

    SELECT value INTO v_value
    FROM camp_state_kv
    WHERE camp_id = inv.camp_id AND key = 'campistrySnacks'
    FOR UPDATE;

    IF v_value IS NULL THEN v_value := '{"accounts":{},"transactions":[]}'::jsonb; END IF;
    IF v_value->'accounts' IS NULL THEN v_value := jsonb_set(v_value, '{accounts}', '{}'::jsonb); END IF;
    IF v_value->'transactions' IS NULL THEN v_value := jsonb_set(v_value, '{transactions}', '[]'::jsonb); END IF;

    v_bal := round(COALESCE((v_value->'accounts'->p_camper_name->>'balance')::numeric, 0) + p_amount, 2);

    v_value := jsonb_set(
        v_value, ARRAY['accounts', p_camper_name],
        COALESCE(v_value->'accounts'->p_camper_name, '{"dailyLimit":10,"spentToday":0}'::jsonb)
            || jsonb_build_object('balance', v_bal),
        true
    );

    v_value := jsonb_set(
        v_value, '{transactions}',
        jsonb_build_array(jsonb_build_object(
            'time',   to_char(now_ts, 'HH12:MI AM'),
            'camper', p_camper_name,
            'items',  'Funds added by parent',
            'amount', p_amount,
            'type',   'credit',
            'date',   to_char(now_ts, 'YYYY-MM-DD')
        )) || COALESCE(v_value->'transactions', '[]'::jsonb)
    );

    UPDATE camp_state_kv
    SET value = v_value, updated_at = now_ts
    WHERE camp_id = inv.camp_id AND key = 'campistrySnacks';

    RETURN jsonb_build_object('success', true, 'balance', v_bal);
END;
$$;

REVOKE ALL ON FUNCTION public.submit_canteen_deposit(text, numeric) FROM public;
GRANT EXECUTE ON FUNCTION public.submit_canteen_deposit(text, numeric) TO authenticated;

-- ─── 2. get_canteen_accounts ──────────────────────────────────────────────────
-- Read-only: lets the parent portal show LIVE balances (including ones set
-- by an admin from the Snacks dashboard/POS), not just the parent's own
-- local echo — this was broken in both directions before this migration.
CREATE OR REPLACE FUNCTION public.get_canteen_accounts(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_value jsonb;
BEGIN
    SELECT value INTO v_value FROM camp_state_kv WHERE camp_id = p_camp_id AND key = 'campistrySnacks';
    IF v_value IS NULL THEN
        RETURN jsonb_build_object('success', true, 'accounts', '{}'::jsonb, 'transactions', '[]'::jsonb);
    END IF;
    RETURN jsonb_build_object(
        'success', true,
        'accounts', COALESCE(v_value->'accounts', '{}'::jsonb),
        'transactions', COALESCE(v_value->'transactions', '[]'::jsonb)
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.get_canteen_accounts(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_canteen_accounts(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_canteen_accounts(uuid) TO anon;

-- ─── 3. Sanity check ──────────────────────────────────────────────────────────
--   SELECT proname FROM pg_proc WHERE proname IN ('submit_canteen_deposit','get_canteen_accounts');
