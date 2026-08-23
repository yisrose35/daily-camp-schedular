-- ============================================================================
-- Migration 070: decouple billing access from portal-lifecycle status.
--
-- Why: revoke_orphaned_parent_invites() (migration 034) flips status='revoked'
-- the moment a parent's LAST camper drops off the roster — normal roster
-- cleanup after a season ends, or a family simply not returning. That single
-- flag currently gates EVERYTHING: messaging, forms, camper mail, AND
-- get_my_balance/payment history. So a family mid-way through a 12-month
-- tuition plan loses the ability to see what they still owe the moment the
-- office cleans up the roster, and a family that finished paying loses their
-- own payment record the same way — neither is a deliberate decision by
-- anyone, it's a side effect of an unrelated cleanup step.
--
-- Fix: split "can use the live portal" (status) from "can see/pay their
-- balance" (billing_access) into two independent flags on the same row.
-- Roster cleanup keeps closing the portal exactly as before; it never
-- touches billing_access. Billing access defaults to true and is permanent
-- unless a staff member explicitly closes it (set_parent_billing_access,
-- below) — e.g. a bad-debt write-off or a parent asking to be forgotten.
--
-- Defaulting existing rows to billing_access=true is deliberate: every
-- invite already sitting at status='revoked' from past roster cleanups
-- silently regains billing access the moment this migration runs. No
-- backfill script needed — this fails toward restoring a family's own
-- payment history rather than requiring anyone to notice it went missing.
-- ============================================================================

-- ─── 1. Column ────────────────────────────────────────────────────────────────
ALTER TABLE link_parent_invites
    ADD COLUMN IF NOT EXISTS billing_access boolean NOT NULL DEFAULT true;

-- ─── 2. get_my_balance — billing access no longer requires status='active' ────
CREATE OR REPLACE FUNCTION public.get_my_balance(p_camp_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller    uuid := auth.uid();
    inv       link_parent_invites;
    me        jsonb;
    enr       jsonb;
    pays      jsonb;
    v_names   jsonb;
    rec       record;
    e         jsonb;
    p         jsonb;
    v_billed  numeric := 0;
    v_paid    numeric := 0;
    v_tuition numeric;
    v_disc    numeric;
    v_amt     numeric;
    v_status  text;
    v_family  text;
    v_enrIds  jsonb := '[]'::jsonb;
    v_history jsonb := '[]'::jsonb;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    SELECT * INTO inv
    FROM link_parent_invites
    WHERE user_id = caller
      AND (status = 'active' OR billing_access = true)
      AND (expires_at IS NULL OR expires_at > now())
      AND (p_camp_id IS NULL OR camp_id = p_camp_id)
    ORDER BY created_at DESC
    LIMIT 1;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;
    v_names := COALESCE(inv.camper_names, '[]'::jsonb);

    SELECT value INTO me FROM camp_state_kv
    WHERE camp_id = inv.camp_id AND key = 'campistryMe';
    IF me IS NULL THEN me := '{}'::jsonb; END IF;
    enr  := COALESCE(me->'enrollments', '{}'::jsonb);
    pays := COALESCE(me->'finance'->'payments', '[]'::jsonb);

    -- Net tuition for the parent's enrolled campers.
    FOR rec IN SELECT key, value FROM jsonb_each(enr) LOOP
        e := rec.value;
        IF (v_names ? (e->>'camperName')) AND (e->>'status') IN ('enrolled', 'accepted') THEN
            v_tuition := COALESCE((e->>'sessionTuition')::numeric, 0);
            v_disc := 0;
            IF e->'discount' IS NOT NULL AND e->'discount' <> 'null'::jsonb THEN
                v_disc := COALESCE((e->'discount'->>'amt')::numeric, 0)
                        + ROUND(v_tuition * COALESCE((e->'discount'->>'pct')::numeric, 0) / 100);
            END IF;
            v_billed := v_billed + (v_tuition - v_disc);
            v_enrIds := v_enrIds || to_jsonb(rec.key);
        END IF;
    END LOOP;

    -- Payments matched to those campers (by family name or enrollmentId).
    FOR p IN SELECT * FROM jsonb_array_elements(pays) LOOP
        v_family := COALESCE(p->>'family', '');
        IF (v_names ? v_family) OR (v_enrIds ? COALESCE(p->>'enrollmentId', '')) THEN
            v_amt := COALESCE((p->>'amount')::numeric, 0);
            v_status := COALESCE(p->>'status', '');
            IF v_status NOT IN ('pending', 'failed') THEN
                v_paid := v_paid + v_amt;
            END IF;
            v_history := v_history || jsonb_build_object(
                'date',   COALESCE(p->>'date', ''),
                'desc',   COALESCE(NULLIF(p->>'notes', ''), COALESCE(p->>'method', 'Payment')),
                'amt',    v_amt,
                'status', CASE WHEN v_amt < 0 THEN 'refunded'
                               WHEN v_status = 'pending' THEN 'pending'
                               WHEN v_status = 'failed' THEN 'failed'
                               ELSE 'paid' END
            );
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'success',    true,
        'camp_id',    inv.camp_id,
        'familyName', COALESCE(v_names->>0, inv.parent_name),
        'campers',    v_names,
        'billed',     v_billed,
        'paid',       v_paid,
        'balance',    v_billed - v_paid,
        'payments',   v_history
    );
END;
$$;
REVOKE ALL ON FUNCTION public.get_my_balance(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_balance(uuid) TO authenticated;

-- ─── 3. get_my_camps — surface billing-only camps + a portal_active flag ──────
-- A camp now appears here if it's portal-active OR billing-access-only, so a
-- parent whose portal was closed by roster cleanup still sees that camp for
-- billing purposes. portal_active tells the client which one it is, so it
-- can keep messaging/forms/camper-mail scoped to portal-active camps only —
-- billing is the one thing exempt from that gate.
CREATE OR REPLACE FUNCTION public.get_my_camps()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    result jsonb;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'camp_id',      i.camp_id,
        'camp_name',    coalesce(NULLIF(btrim(c.name), ''), 'Camp'),
        'parent_name',  i.parent_name,
        'parent_email', i.parent_email,
        'family_id',    i.family_id,
        'camper_names', i.camper_names,
        'camper_data',  i.camper_data,
        'camp_dates',   cd.value,
        'portal_active', (i.status = 'active')
    ) ORDER BY coalesce(c.name,''), i.created_at), '[]'::jsonb)
    INTO result
    FROM link_parent_invites i
    LEFT JOIN camps c ON c.id = i.camp_id
    LEFT JOIN camp_state_kv cd ON cd.camp_id = i.camp_id AND cd.key = 'campDates'
    WHERE i.user_id = caller
      AND (i.status = 'active' OR i.billing_access = true)
      AND (i.expires_at IS NULL OR i.expires_at > now());

    RETURN jsonb_build_object('success', true, 'camps', result);
END;
$$;
REVOKE ALL ON FUNCTION public.get_my_camps() FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_camps() TO authenticated;

-- ─── 4. set_parent_billing_access — staff-controlled manual override ──────────
-- The ONLY way billing_access is ever turned off: an explicit staff action,
-- never automatic. Also doubles as the "reopen" action (p_enabled = true) if
-- staff need to undo a mistaken close. Mirrors the staff-membership check
-- used by set_parent_invite_email (migration 034).
CREATE OR REPLACE FUNCTION public.set_parent_billing_access(
    p_camp_id      uuid,
    p_parent_email text,
    p_enabled      boolean
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    n int := 0;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    IF NOT EXISTS (SELECT 1 FROM camps c WHERE c.id = p_camp_id AND c.owner = caller)
       AND NOT EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = p_camp_id AND u.user_id = caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_a_member');
    END IF;
    IF p_parent_email IS NULL OR btrim(p_parent_email) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_email');
    END IF;

    UPDATE link_parent_invites
    SET billing_access = p_enabled
    WHERE camp_id = p_camp_id AND lower(parent_email) = lower(p_parent_email);
    GET DIAGNOSTICS n = ROW_COUNT;

    RETURN jsonb_build_object('success', true, 'updated', n, 'billing_access', p_enabled);
END;
$$;
REVOKE ALL ON FUNCTION public.set_parent_billing_access(uuid, text, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.set_parent_billing_access(uuid, text, boolean) TO authenticated;

-- Sanity check after running:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'link_parent_invites' AND column_name = 'billing_access';
--   -- then from a parent session with a revoked invite: select get_my_balance()
--   -- and confirm it now succeeds instead of returning 'no_active_invite'.
