-- ============================================================================
-- Migration 183: a camp id stops being a password.
--
-- Standalone — not in APPLY_BUNDLE.sql. Paste this file on its own. Idempotent.
--
-- ── WHAT WAS WRONG ─────────────────────────────────────────────────────────
-- Several RPCs are SECURITY DEFINER (so they bypass RLS), take a camp id, and
-- were granted to `anon` with NO check on who is calling. The camp id was the
-- only thing standing between a stranger and the data — and camp ids are not
-- secret. They sit in public form URLs, tip links and the canteen deposit page
-- by design.
--
--   get_canteen_accounts   returned the whole campistrySnacks blob: every
--                          camper's NAME, their balance, their limits, and the
--                          camp's complete transaction ledger. To anyone.
--   get_link_tip_targets   returned every staff member's zelle, venmo, paypal
--                          and cashapp handles. To anyone.
--   get_link_tips_config   returned the tips config blob, which carries the
--                          admin-entered staffPay handles. To anyone.
--   get_camp_broadcasts    returned every message the camp has sent parents.
--
-- Not one of them needed `anon`: every caller is the parent portal or Lite,
-- both of which run authenticated. The grant was breadth nobody asked for.
--
-- Removing `anon` is not enough on its own. Without a caller check these were
-- also readable by ANY logged-in user of ANY OTHER camp, just by passing a
-- different uuid. So each one now asks whether the caller has an actual
-- relationship with that camp.
--
-- ── AND THE ONE THAT IS MINE ───────────────────────────────────────────────
-- flag_expiring_cards and sync_family_ledger_payments (178/179) were granted to
-- `authenticated`, and both WRITE to a camp's blob. Any logged-in user could
-- have run either against any camp id. The damage is bounded — both are
-- idempotent and only post what that camp's own records already imply — but
-- neither has any business being reachable by a normal session. They are
-- service_role only now. That grant was mine and it was careless.
--
-- ── THE CANTEEN CHANGE IS A BEHAVIOUR CHANGE ───────────────────────────────
-- A parent now gets THEIR OWN children's accounts, not the camp's. That is
-- already what the UI does — campistry_link_parent.html fetches everything and
-- then picks out accounts[child.name] in the browser — so nothing on screen
-- changes. What changes is that the other families' data never leaves the
-- database. Staff still get the whole blob, because the POS needs it.
-- ============================================================================

-- ─── 1. who is asking ───────────────────────────────────────────────────────
-- Camp-scoped, unlike get_user_role(), which answers for the caller's OWN camp
-- and so cannot say anything about a camp id passed in from outside.
-- Deliberately ANY accepted role, not just owner/admin: a counselor on the POS
-- has to be able to read canteen balances.
CREATE OR REPLACE FUNCTION public.camp_staff_member(p_camp_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT p_camp_id IS NOT NULL AND auth.uid() IS NOT NULL AND EXISTS (
        SELECT 1 FROM camps WHERE id = p_camp_id AND owner = auth.uid()
        UNION
        SELECT 1 FROM camp_users
         WHERE camp_id = p_camp_id AND user_id = auth.uid()
           AND accepted_at IS NOT NULL
    );
$$;
REVOKE ALL ON FUNCTION public.camp_staff_member(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.camp_staff_member(uuid) TO authenticated, service_role;

-- The camper names this caller is a parent of at this camp. Empty array when
-- they are not a parent here — which is also how "no relationship" reads, and
-- is why the callers below test staff FIRST.
CREATE OR REPLACE FUNCTION public.camp_parent_campers(p_camp_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT COALESCE(
        (SELECT jsonb_agg(DISTINCT n)
           FROM link_parent_invites i,
                LATERAL jsonb_array_elements_text(
                    CASE WHEN jsonb_typeof(i.camper_names) = 'array'
                         THEN i.camper_names ELSE '[]'::jsonb END) n
          WHERE i.camp_id = p_camp_id
            AND i.user_id = auth.uid()
            AND (i.status = 'active' OR i.billing_access = true)
            AND (i.expires_at IS NULL OR i.expires_at > now())),
        '[]'::jsonb);
$$;
REVOKE ALL ON FUNCTION public.camp_parent_campers(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.camp_parent_campers(uuid) TO authenticated, service_role;

-- Staff, or a parent with a live invite. The gate for things a parent is
-- allowed to see in full (the camp's own broadcasts, who can be tipped).
CREATE OR REPLACE FUNCTION public.camp_reader(p_camp_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT public.camp_staff_member(p_camp_id)
        OR jsonb_array_length(public.camp_parent_campers(p_camp_id)) > 0;
$$;
REVOKE ALL ON FUNCTION public.camp_reader(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.camp_reader(uuid) TO authenticated, service_role;


-- ─── 2. canteen: your own children, not the camp's ──────────────────────────
CREATE OR REPLACE FUNCTION public.get_canteen_accounts(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_value  jsonb;
    v_mine   jsonb;
    v_accts  jsonb := '{}'::jsonb;
    v_txs    jsonb;
    k        text;
BEGIN
    -- Staff first: the POS and the Snacks dashboard need the whole camp, and a
    -- staff member who is also a parent here should not be cut down to their
    -- own child.
    IF public.camp_staff_member(p_camp_id) THEN
        SELECT value INTO v_value FROM camp_state_kv
         WHERE camp_id = p_camp_id AND key = 'campistrySnacks';
        IF v_value IS NULL THEN
            RETURN jsonb_build_object('success', true, 'accounts', '{}'::jsonb,
                                      'transactions', '[]'::jsonb);
        END IF;
        RETURN jsonb_build_object(
            'success', true,
            'accounts', COALESCE(v_value->'accounts', '{}'::jsonb),
            'transactions', COALESCE(v_value->'transactions', '[]'::jsonb));
    END IF;

    v_mine := public.camp_parent_campers(p_camp_id);
    IF jsonb_array_length(v_mine) = 0 THEN
        -- No relationship with this camp at all. This used to return the lot.
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    SELECT value INTO v_value FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistrySnacks';
    IF v_value IS NULL THEN
        RETURN jsonb_build_object('success', true, 'accounts', '{}'::jsonb,
                                  'transactions', '[]'::jsonb);
    END IF;

    -- Only this parent's children. The accounts map is keyed by camper name,
    -- which is what makes the filter possible at all.
    FOR k IN SELECT jsonb_array_elements_text(v_mine) LOOP
        IF v_value->'accounts' ? k THEN
            v_accts := jsonb_set(v_accts, ARRAY[k], v_value->'accounts'->k, true);
        END IF;
    END LOOP;

    -- ...and only their transactions. A canteen ledger is a list of what other
    -- people's children bought, which is nobody else's business.
    SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) INTO v_txs
      FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(v_value->'transactions') = 'array'
                  THEN v_value->'transactions' ELSE '[]'::jsonb END) t
     WHERE v_mine ? COALESCE(t->>'camper', '');

    RETURN jsonb_build_object('success', true, 'accounts', v_accts,
                              'transactions', v_txs, 'scope', 'parent');
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
REVOKE ALL ON FUNCTION public.get_canteen_accounts(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_canteen_accounts(uuid) TO authenticated, service_role;


-- ─── 3. staff payment handles are not public ────────────────────────────────
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
    -- These rows carry zelle/venmo/paypal/cashapp handles — a staff member's
    -- own payment details. They were readable by anyone holding the camp id.
    IF NOT public.camp_reader(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
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
REVOKE ALL ON FUNCTION public.get_link_tip_targets(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_link_tip_targets(uuid) TO authenticated, service_role;


-- ─── 4. the tips config blob (carries staffPay handles) ─────────────────────
CREATE OR REPLACE FUNCTION public.get_link_tips_config(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_value text;
BEGIN
    IF NOT public.camp_reader(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    SELECT value INTO v_value
    FROM camp_state_kv
    WHERE camp_id = p_camp_id
      AND key     = 'link_tips_config'
    LIMIT 1;

    IF NOT FOUND OR v_value IS NULL THEN
        RETURN jsonb_build_object('success', true, 'config', NULL);
    END IF;

    RETURN jsonb_build_object('success', true, 'config', v_value::jsonb);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
REVOKE ALL ON FUNCTION public.get_link_tips_config(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_link_tips_config(uuid) TO authenticated, service_role;


-- ─── 5. the camp's messages to its parents ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_camp_broadcasts(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    result jsonb;
BEGIN
    IF NOT public.camp_reader(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', b.id, 'subject', b.subject, 'body', b.body, 'created_at', b.created_at
    ) ORDER BY b.created_at DESC), '[]'::jsonb)
    INTO result
    FROM link_broadcasts b
    WHERE b.camp_id = p_camp_id
    LIMIT 100;

    RETURN jsonb_build_object('success', true, 'broadcasts', result);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
REVOKE ALL ON FUNCTION public.get_camp_broadcasts(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_camp_broadcasts(uuid) TO authenticated, service_role;


-- ─── 6. two writers of mine that a normal session could call ────────────────
-- Both only ever post what a camp's own records already imply, and both are
-- idempotent, so this is not a hole anyone could have taken money through. It
-- is still a write reachable by any logged-in user against any camp id, which
-- is not a thing to leave lying about. Nothing calls them from the browser —
-- charge-due-installments runs as service_role.
REVOKE EXECUTE ON FUNCTION public.flag_expiring_cards(uuid, date, integer)
    FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_family_ledger_payments(uuid, text, boolean)
    FROM authenticated;


-- ─── Checking it ───────────────────────────────────────────────────────────
-- Nothing camp-scoped should be left open to anon:
--   select p.proname, array_to_string(p.proacl, ' ') as acl
--     from pg_proc p
--    where p.proname in ('get_canteen_accounts','get_link_tip_targets',
--                        'get_link_tips_config','get_camp_broadcasts',
--                        'flag_expiring_cards','sync_family_ledger_payments');
--   -- no 'anon=X' on any row; the last two are service_role only
--
-- As an anon session (the public key, no login), the canteen read must refuse:
--   select get_canteen_accounts('<a real camp id>'::uuid);
--   -- {"success": false, "error": "not_authorized"}
--
-- As a PARENT at that camp, it must return their children and nobody else's:
--   select get_canteen_accounts('<camp>'::uuid);
--   -- "scope": "parent", accounts keyed only by their own campers
--
-- As a staff member, the whole camp, as before:
--   select jsonb_object_keys(get_canteen_accounts('<camp>'::uuid)->'accounts');
-- ============================================================================
