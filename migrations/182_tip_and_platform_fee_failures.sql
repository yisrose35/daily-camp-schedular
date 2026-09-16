-- ============================================================================
-- Migration 182: two failures that were written down and read by nobody.
--
-- Standalone — not in APPLY_BUNDLE.sql. Paste this file on its own. Idempotent.
--
-- ── 1. A TIP THAT NEVER REACHED THE STAFF MEMBER ───────────────────────────
-- When a cart tip's transfer fails, stripe-connect-webhook writes the reason to
-- link_tip_cart_items.transfer_error and moves on to the next recipient — which
-- is right, one broken account must not block the rest of the cart. But nothing
-- reads that column. The only reference to it outside the writer is a sample
-- query in migration 059's comments.
--
-- So the parent's charge succeeded, the platform is holding the money, the
-- counselor is never paid, and no screen anywhere says so.
--
-- The code justifies this: "processed_at stays null so a future retry (Stripe's
-- own delivery retries, or a manual resend) picks it up." Neither exists. The
-- handler catches the error and returns 200, so Stripe considers the event
-- delivered and never retries it; and there is no manual resend anywhere in the
-- app. The stated recovery mechanism is not there.
--
-- record_tip_transfer_failure raises it with the camp — it is the camp's staff
-- member who is unpaid, and the camp that can chase it. retry_failed_tip_transfers
-- returns the ones still outstanding so the nightly runner can try again, which
-- is the retry the comment assumed was already happening.
--
-- ── 2. CAMPISTRY'S OWN SMS FEE FAILING IN SILENCE ──────────────────────────
-- telnyx-charge-monthly-fees writes error_message on a declined monthly charge
-- and leaves status as 'active'. The dashboard only renders error_message when
-- status is 'rejected' or 'failed', so the camp sees "active since <date>" and
-- nothing else. Worse, next_charge_at is not advanced on failure — so it
-- re-attempts on every run, for ever, collecting a decline fee each time and
-- telling nobody.
--
-- This is Campistry's own revenue, which is exactly why it should not be the
-- one money path with no dunning on it.
-- ============================================================================

-- ─── 1. the tip that did not arrive ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_tip_transfer_failure(
    p_item_id uuid,
    p_error   text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_item   record;
    v_camp   uuid;
    v_amount numeric;
BEGIN
    IF p_item_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_arguments');
    END IF;

    UPDATE link_tip_cart_items
       SET transfer_error = p_error
     WHERE id = p_item_id
    RETURNING * INTO v_item;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'item_not_found');
    END IF;

    v_camp   := v_item.camp_id;
    v_amount := ROUND(COALESCE(v_item.tip_cents, 0)::numeric / 100, 2);

    IF v_camp IS NULL THEN
        -- Nothing to raise it with. The log line in the caller is the only
        -- signal left, which is why that one is written as a money problem.
        RETURN jsonb_build_object('success', true, 'notified', false,
                                  'reason', 'no_camp_on_item');
    END IF;

    -- One per ITEM, not per attempt: a retry that fails again is the same
    -- unpaid tip, not a second one.
    INSERT INTO notifications (camp_id, source, source_id, title, body, link_target)
    VALUES (v_camp, 'tip_transfer_failed', p_item_id::text,
            'A tip did not reach a staff member',
            COALESCE(v_item.staff_name, 'A staff member')
              || ' was tipped $' || v_amount
              || ' and the transfer to their account failed'
              || COALESCE(' (' || p_error || ')', '')
              || '. The parent was charged and the money is still with Stripe. '
              || 'It will be retried automatically; if it keeps failing, their '
              || 'payout account probably needs reconnecting.',
            'campistry_me.html')
    ON CONFLICT (camp_id, source, source_id) DO NOTHING;

    RETURN jsonb_build_object('success', true, 'notified', true,
                              'campId', v_camp, 'amount', v_amount);
END;
$$;
REVOKE ALL ON FUNCTION public.record_tip_transfer_failure(uuid, text)
    FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_tip_transfer_failure(uuid, text) TO service_role;


-- ─── 2. what is still owed to a staff member ────────────────────────────────
-- Read-only. Returns cart items whose money was collected from the parent and
-- never handed on: charged (the cart has a payment intent), not processed, and
-- carrying an error. The caller does the Stripe work; this is the queue.
--
-- Bounded to the last 90 days so a permanently broken account from last summer
-- is not retried nightly for ever — after that it is an office job, not a
-- machine's.
CREATE OR REPLACE FUNCTION public.retry_failed_tip_transfers(p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'id', i.id,
               'campId', i.camp_id,
               'cartId', i.cart_id,
               'staffName', i.staff_name,
               'staffAccountId', i.staff_account_id,
               'tipCents', i.tip_cents,
               'feeCents', i.fee_cents,
               'error', i.transfer_error)), '[]'::jsonb)
      FROM link_tip_cart_items i
     WHERE i.processed_at IS NULL
       AND COALESCE(i.transfer_error, '') <> ''
       AND i.staff_account_id IS NOT NULL
       AND i.created_at > now() - interval '90 days'
     LIMIT GREATEST(COALESCE(p_limit, 50), 1);
$$;
REVOKE ALL ON FUNCTION public.retry_failed_tip_transfers(integer)
    FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retry_failed_tip_transfers(integer) TO service_role;


-- ─── 3. the SMS fee that could not be collected ─────────────────────────────
-- Counts consecutive failures, backs the next attempt off instead of retrying
-- every run, and tells the camp. Same shape as 179's plan dunning, for the same
-- reason: an authorisation costs money whether it approves or not.
ALTER TABLE camp_telnyx_provisioning
    ADD COLUMN IF NOT EXISTS charge_failures integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.record_telnyx_charge_failure(
    p_camp_id uuid,
    p_error   text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_fails integer;
    v_next  timestamptz;
    v_days  integer;
BEGIN
    IF p_camp_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_arguments');
    END IF;

    UPDATE camp_telnyx_provisioning
       SET charge_failures = COALESCE(charge_failures, 0) + 1,
           error_message   = p_error,
           -- The fix for "retries every run for ever". 3 days, then 5, then 7,
           -- then a fortnight — 179's schedule, deliberately the same one.
           next_charge_at  = now() + (CASE
                                 WHEN COALESCE(charge_failures, 0) + 1 <= 1 THEN 3
                                 WHEN COALESCE(charge_failures, 0) + 1 = 2 THEN 5
                                 WHEN COALESCE(charge_failures, 0) + 1 = 3 THEN 7
                                 ELSE 14 END || ' days')::interval,
           updated_at      = now()
     WHERE camp_id = p_camp_id
    RETURNING charge_failures, next_charge_at INTO v_fails, v_next;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_provisioning_row');
    END IF;

    -- Deduped per camp per failure NUMBER, so the first one says "your card was
    -- declined" and the third says it again rather than being swallowed — but a
    -- single failure is never reported twice.
    INSERT INTO notifications (camp_id, source, source_id, title, body, link_target)
    VALUES (p_camp_id, 'telnyx_fee_failed', v_fails::text,
            CASE WHEN v_fails >= 3
                 THEN 'Your SMS number is at risk'
                 ELSE 'The monthly SMS charge did not go through' END,
            'The monthly charge for your Campistry SMS number was declined'
              || COALESCE(' (' || p_error || ')', '')
              || '. Your number is still active and nothing has been cut off. '
              || CASE WHEN v_fails >= 3
                      THEN 'This is attempt ' || v_fails
                           || ' — please update the card on file, or the number '
                           || 'may eventually be released.'
                      ELSE 'We will try again in a few days; updating the card on '
                           || 'file will sort it sooner.' END,
            'dashboard.html')
    ON CONFLICT (camp_id, source, source_id) DO NOTHING;

    RETURN jsonb_build_object('success', true, 'failures', v_fails,
                              'nextChargeAt', v_next);
END;
$$;
REVOKE ALL ON FUNCTION public.record_telnyx_charge_failure(uuid, text)
    FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_telnyx_charge_failure(uuid, text) TO service_role;

-- And clearing it, so a camp that fixes their card stops being chased.
CREATE OR REPLACE FUNCTION public.clear_telnyx_charge_failures(p_camp_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    UPDATE camp_telnyx_provisioning
       SET charge_failures = 0, error_message = NULL, updated_at = now()
     WHERE camp_id = p_camp_id AND COALESCE(charge_failures, 0) <> 0;
$$;
REVOKE ALL ON FUNCTION public.clear_telnyx_charge_failures(uuid)
    FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_telnyx_charge_failures(uuid) TO service_role;


-- ─── Checking it ───────────────────────────────────────────────────────────
-- Unpaid tips, which used to be visible only to whoever thought to run this:
--   select retry_failed_tip_transfers();
--
-- A failed SMS charge backs off instead of retrying nightly:
--   select record_telnyx_charge_failure('<camp>'::uuid, 'Your card was declined');
--   select charge_failures, next_charge_at from camp_telnyx_provisioning
--    where camp_id = '<camp>'::uuid;      -- 1, and ~3 days out
--   -- run it twice more: 3, ~7 days out, and the third notification reads
--   -- "Your SMS number is at risk"
--   select clear_telnyx_charge_failures('<camp>'::uuid);
-- ============================================================================
