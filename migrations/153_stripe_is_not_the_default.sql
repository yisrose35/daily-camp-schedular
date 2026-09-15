-- ============================================================================
-- Migration 153: Stripe stops being the default processor and becomes one
-- selectable option among Stripe / Sola / Banquest.
--
-- Migration 126 made camps.payment_processor_key NOT NULL DEFAULT 'stripe', so
-- "this camp has not chosen a processor" and "this camp chose Stripe" were the
-- same value. That had a real consequence: a camp on the default with no Stripe
-- Connect account still took tuition through stripe-checkout, which only gates
-- CANTEEN deposits on a destination account — so the money settled into
-- Campistry's own platform balance rather than the camp's.
--
-- WHY A 'none' SENTINEL AND NOT NULL:
--   * get_camp_payment_processor_status INNER JOINs payment_processor_catalog
--     (migration 126, line ~178). A NULL key drops the row entirely, so the RPC
--     returns success:true with processorKey null and status 'untested' — and
--     the dashboard renders "Connected to null but not yet verified. Contact
--     support." for a perfectly healthy camp.
--   * _admin_clear_stale_byop_cards (migration 147) filters saved cards with
--     (m->>'processor') = p_processor_key. NULL makes every comparison NULL, so
--     jsonb_agg returns [] and EVERY family's savedPaymentMethods is deleted.
--   * The FK to payment_processor_catalog stays meaningful; NULL satisfies an
--     FK silently.
-- A real catalog row keeps every existing join, comparison and constraint
-- working, and gives the UI one explicit state to render a "choose a processor"
-- call to action for.
--
-- SAFE TO BACKFILL: confirmed with the camp owner that no camp is live on
-- Stripe today, so every row still reading 'stripe' is an unchosen default, not
-- a decision. Camps that connected Sola or Banquest already had their key set
-- by _admin_store_camp_processor_credentials and are left alone.
--
-- NOT TOUCHED — these are platform-Stripe and must stay that way regardless of
-- what a camp connects:
--   * Tips      — stripe-connect-tip / -tip-cart / stripe-connect-webhook,
--                 charged on the platform account and transferred to each
--                 staff member's own Connect account (link_staff_accounts).
--   * Photos    — link-photo-checkout, explicitly a platform-account charge
--                 and deliberately not a Connect destination charge.
-- Neither reads camps.payment_processor_key at all, so neither is affected.
--
-- Idempotent.
-- ============================================================================

-- ─── 1. The 'none' processor ────────────────────────────────────────────────
-- capabilities are all false: nothing can be charged, refunded or tokenized
-- until a real processor is connected. Anything that reads capabilities to
-- decide whether to offer an action therefore correctly offers nothing.
INSERT INTO payment_processor_catalog (key, label, credential_fields, capabilities, adapter_module)
VALUES ('none', 'No processor connected', '[]'::jsonb,
        '{"charge":false,"refund":false,"recurring":false,"ach":false,"tokenization":false,"nativeSurcharge":false}'::jsonb,
        'none (no online payments until the camp connects a processor)')
ON CONFLICT (key) DO NOTHING;

-- ─── 2. New camps start unchosen ────────────────────────────────────────────
ALTER TABLE camps ALTER COLUMN payment_processor_key SET DEFAULT 'none';

-- ─── 3. Backfill the unchosen default ───────────────────────────────────────
-- Only rows still sitting on 'stripe'. A camp that genuinely wants Stripe gets
-- there by completing Stripe Connect, which now sets the key explicitly.
UPDATE camps SET payment_processor_key = 'none' WHERE payment_processor_key = 'stripe';

-- ─── 4. Status RPC understands 'none' ───────────────────────────────────────
-- Same body as migration 126 except the status expression: 'none' reports
-- 'not_connected' (an actionable state the UI can prompt on) instead of
-- inheriting the old 'stripe_default'. A camp on 'stripe' now means a camp that
-- really connected Stripe, so its status is derived from whether Connect is
-- actually usable rather than assumed.
CREATE OR REPLACE FUNCTION public.get_camp_payment_processor_status(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_uid  uuid := auth.uid();
    v_ok   boolean;
    v_row  record;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM camps WHERE id = p_camp_id AND owner = v_uid
        UNION
        SELECT 1 FROM camp_users
         WHERE camp_id = p_camp_id AND user_id = v_uid
           AND accepted_at IS NOT NULL AND role IN ('owner', 'admin')
    ) INTO v_ok;
    IF NOT v_ok THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    SELECT c.payment_processor_key AS processor_key,
           pc.label AS processor_label,
           c.stripe_account_id,
           c.stripe_charges_enabled,
           cred.status, cred.last_verified_at, cred.connected_at
      INTO v_row
      FROM camps c
      JOIN payment_processor_catalog pc ON pc.key = c.payment_processor_key
      LEFT JOIN camp_processor_credentials cred ON cred.camp_id = c.id
     WHERE c.id = p_camp_id;

    RETURN jsonb_build_object(
        'success', true,
        'processorKey', v_row.processor_key,
        'processorLabel', v_row.processor_label,
        'status', CASE
            WHEN v_row.processor_key = 'none'   THEN 'not_connected'
            -- Stripe keeps no row in camp_processor_credentials (it has no BYOP
            -- adapter); its health is whether Connect can actually take money.
            WHEN v_row.processor_key = 'stripe' THEN
                CASE WHEN COALESCE(v_row.stripe_charges_enabled, false) THEN 'verified'
                     WHEN v_row.stripe_account_id IS NOT NULL           THEN 'untested'
                     ELSE 'not_connected' END
            ELSE COALESCE(v_row.status, 'untested')
        END,
        'lastVerifiedAt', v_row.last_verified_at,
        'connectedAt', v_row.connected_at
    );
END;
$$;
REVOKE ALL ON FUNCTION public.get_camp_payment_processor_status(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_camp_payment_processor_status(uuid) TO authenticated;

-- ─── 5. Disconnecting returns to 'none', not 'stripe' ───────────────────────
-- Migration 129 reset to 'stripe', which under the old default meant "back to
-- normal". It now has to mean "no processor", or disconnecting Sola/Banquest
-- would silently opt the camp into Stripe.
CREATE OR REPLACE FUNCTION public.disconnect_my_camp_processor(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, pg_catalog
AS $$
DECLARE
    v_uid       uuid := auth.uid();
    v_ok        boolean;
    v_secret_id uuid;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM camps WHERE id = p_camp_id AND owner = v_uid
        UNION
        SELECT 1 FROM camp_users
         WHERE camp_id = p_camp_id AND user_id = v_uid
           AND accepted_at IS NOT NULL AND role IN ('owner', 'admin')
    ) INTO v_ok;
    IF NOT v_ok THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    SELECT vault_secret_id INTO v_secret_id
      FROM camp_processor_credentials WHERE camp_id = p_camp_id;

    IF v_secret_id IS NOT NULL THEN
        DELETE FROM vault.secrets WHERE id = v_secret_id;
    END IF;

    DELETE FROM camp_processor_credentials WHERE camp_id = p_camp_id;
    UPDATE camps SET payment_processor_key = 'none' WHERE id = p_camp_id;

    RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public.disconnect_my_camp_processor(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.disconnect_my_camp_processor(uuid) TO authenticated;

-- ─── 6. Connecting / disconnecting Stripe sets the key ──────────────────────
-- Stripe Connect onboarding only ever wrote stripe_account_id; the key came
-- from the default. With the default gone, completing Connect has to say so
-- explicitly, and disconnecting has to hand the camp back to 'none'.
-- service_role: called by stripe-connect-status-camp / -onboard-camp.
CREATE OR REPLACE FUNCTION public._admin_set_camp_stripe_selected(p_camp_id uuid, p_selected boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    IF p_selected THEN
        -- Never clobber a camp that deliberately runs Sola/Banquest; only a
        -- camp with nothing chosen is moved onto Stripe by connecting it.
        UPDATE camps SET payment_processor_key = 'stripe'
         WHERE id = p_camp_id AND payment_processor_key = 'none';
    ELSE
        UPDATE camps SET payment_processor_key = 'none'
         WHERE id = p_camp_id AND payment_processor_key = 'stripe';
    END IF;
    RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public._admin_set_camp_stripe_selected(uuid, boolean) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._admin_set_camp_stripe_selected(uuid, boolean) TO service_role;

-- ─── 7. Disconnecting Stripe also releases the processor key ────────────────
-- Migration 130's disconnect_my_camp_stripe cleared stripe_account_id but left
-- payment_processor_key alone, because under the old default 'stripe' meant
-- "nothing special". Now it means "this camp takes payments through Stripe", so
-- tearing down Connect has to hand the key back to 'none' — otherwise the camp
-- keeps claiming a processor it can no longer charge with.
CREATE OR REPLACE FUNCTION public.disconnect_my_camp_stripe(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_uid uuid := auth.uid();
    v_ok  boolean;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM camps WHERE id = p_camp_id AND owner = v_uid
        UNION
        SELECT 1 FROM camp_users
         WHERE camp_id = p_camp_id AND user_id = v_uid
           AND accepted_at IS NOT NULL AND role IN ('owner', 'admin')
    ) INTO v_ok;
    IF NOT v_ok THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    UPDATE camps
       SET stripe_account_id = NULL,
           stripe_charges_enabled = false,
           stripe_onboarding_status = 'not_started',
           stripe_connected_at = NULL,
           -- Only if Stripe was the chosen processor; a camp on Sola/Banquest
           -- that happens to have had Connect set up keeps its real processor.
           payment_processor_key = CASE WHEN payment_processor_key = 'stripe'
                                        THEN 'none' ELSE payment_processor_key END
     WHERE id = p_camp_id;

    RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public.disconnect_my_camp_stripe(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.disconnect_my_camp_stripe(uuid) TO authenticated;

-- Tidy any camp already left claiming Stripe with no Connect account behind it.
UPDATE camps SET payment_processor_key = 'none'
 WHERE payment_processor_key = 'stripe' AND stripe_account_id IS NULL;

-- ─── Sanity checks (run manually after applying) ───────────────────────────
--   SELECT key, label FROM payment_processor_catalog ORDER BY key;
--     -- expect a 'none' row alongside stripe / cardknox / banquest.
--   SELECT column_default FROM information_schema.columns
--    WHERE table_name='camps' AND column_name='payment_processor_key';
--     -- expect 'none'::text
--   SELECT payment_processor_key, count(*) FROM camps GROUP BY 1;
--     -- expect no 'stripe' rows unless that camp really completed Connect.
-- ============================================================================
