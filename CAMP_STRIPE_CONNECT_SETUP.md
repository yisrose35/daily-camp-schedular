# Per-Camp Stripe Connect for Tuition/Store Billing — Setup

Lets a camp owner connect their own Stripe account from the Dashboard so
family tuition/store payments land directly in that camp's own bank
account, instead of pooling into Campistry's shared platform account. See
`/root/.claude/plans/bubbly-jingling-kite.md` (this session) for the full
design writeup.

**No platform fee** — camps keep 100% of what they charge families.
**Owner-only** — a camp's admin/scheduler users cannot connect or manage
the camp's Stripe account, only the owner.

**Fully backward compatible / opt-in**: a camp that hasn't connected
(`camps.stripe_account_id IS NULL`, every camp on day one) charges exactly
as it did before this shipped — byte-for-byte the same API calls. No
feature flag, no cutover date. A camp connects whenever its owner is ready.

## 1. Run the migration

```
077_camp_stripe_connect.sql
```

(SQL is below — paste into the Supabase SQL Editor.) Safe to re-run.

## 2. Deploy the two new edge functions, redeploy five existing ones

New:
- `stripe-connect-onboard-camp` — JWT verification **on** (default). Called
  by a signed-in camp owner.
- `stripe-connect-status-camp` — JWT verification **on** (default). Same
  caller.

Redeploy (changed):
- `stripe-connect-webhook` — `account.updated` handler now also matches
  camp-level connected accounts (falls back to a `camps` lookup when there's
  no `staffAccountId` in the account's metadata).
- `stripe-charge` — now looks up the camp's connected account and adds
  `transfer_data[destination]` when present.
- `stripe-checkout` — same lookup/destination logic.
- `charge-due-installments` — same, batch-fetched once per cron run instead
  of per-charge.
- `stripe-refund` — now fetches the PaymentIntent from Stripe before
  refunding, and adds `reverse_transfer:true` when the original charge was
  a destination charge (so the refund debits the camp's account, not the
  platform's).

No changes needed to `stripe-setup` (card collection) or `stripe-webhook`
(payment-status recording) — both already work unmodified with destination
charges, since the Customer/PaymentMethod/Charge objects stay on the
platform account regardless of where the resulting transfer lands.

## 3. Secrets

No new secrets. This reuses `STRIPE_SECRET_KEY`, `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` — all already set from
prior billing/tipping work. The two new functions also read
`SUPABASE_ANON_KEY` (same as `stripe-connect-onboard`/`stripe-connect-status`
already do) — confirm that secret is set if you haven't deployed the
staff-tipping feature yet.

## 4. No new webhook registration needed

The existing "Connected accounts" endpoint (the one already registered for
staff Stripe Connect, signed with `STRIPE_CONNECT_ACCOUNT_WEBHOOK_SECRET`)
automatically fires `account.updated` for **every** connected account under
the platform — camp accounts included, the moment a camp creates one. If
you've already set up staff tipping's two webhook endpoints, nothing more
to register. If you haven't, see `TIPPING_SETUP.md` §5 for how to register
both the "Your account" and "Connected accounts" endpoints — camp billing
needs both secrets set (`STRIPE_CONNECT_WEBHOOK_SECRET` and
`STRIPE_CONNECT_ACCOUNT_WEBHOOK_SECRET`) even though this feature itself
never creates a payment_intent.succeeded event on the platform account
directly (tuition PaymentIntents' succeeded/failed events are handled by
the existing `stripe-webhook`, unchanged).

## 5. Verify end to end

Use Stripe **test mode** for all of this — Stripe Connect's own test-mode
onboarding lets you fill in fake business info and skip real bank
verification.

1. As a camp owner on the Dashboard, find **"💳 Payment Processing
   (Stripe)"** → **"Where tuition money lands"** → click **"Connect your
   Stripe account."**
2. Complete Stripe's hosted Express onboarding (test mode: any fake business
   info works, use Stripe's test bank account numbers).
3. Confirm you're redirected back to the Dashboard with the status box
   showing **"Connected"** (either instantly via the `stripeReturn=1`
   sync call, or within a few seconds once the `account.updated` webhook
   lands) and `camps.stripe_charges_enabled = true` in the database.
4. Save a test family's card (Billing page → request card setup → enter a
   Stripe test card, e.g. `4242 4242 4242 4242`).
5. Run a manual charge (Billing → "+ Charge" or "⚡ Batch Charge") against
   that family.
6. In the **Stripe test Dashboard**, confirm the resulting Charge/
   PaymentIntent shows a transfer to the connected test account — not
   sitting in the platform's own balance.
7. Refund that charge. Confirm in the Stripe test Dashboard that the
   connected account's test balance is debited back (`reverse_transfer`
   worked), not the platform's.
8. Confirm a camp that has **not** connected still charges exactly as
   before (regression check — pick any other test camp, verify its charges
   still land on the platform account with no `transfer_data`).
9. (Optional) Manually set a test family's `plan.installments[0].dueDate`
   to today and run `charge-due-installments` (via its cron secret header)
   against a connected test camp — confirm that charge also routes to the
   camp's account.

## What's NOT in this pass

- **Platform fee on tuition** — explicitly declined for now, camps keep
  100%. The reusable pattern (`computeFees()`-style gross-up,
  `application_fee_amount`) already exists in `stripe-connect-tip` if this
  changes later.
- **Owner+admin onboarding access** — owner-only for now. Loosening this is
  a one-line auth check change in `stripe-connect-onboard-camp`.
- **Parent-facing installment-schedule visibility** — an unrelated
  pre-existing gap noticed during this work (`get_my_balance` RPC exposes
  balance + payment history to parents, but not the installment schedule
  itself). Not addressed here.
- **Per-camp fee overrides, non-US camps, non-Express account types** — not
  requested, not built.
- **Migrating a camp already using the shared platform account** — no
  migration needed; a camp simply connects whenever its owner is ready, and
  only its *next* charge picks up the new destination. Nothing about
  existing saved cards or payment history needs to change.

## Migration SQL

```sql
ALTER TABLE public.camps
    ADD COLUMN IF NOT EXISTS stripe_account_id text,
    ADD COLUMN IF NOT EXISTS stripe_charges_enabled boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS stripe_onboarding_status text NOT NULL DEFAULT 'not_started',
    ADD COLUMN IF NOT EXISTS stripe_connected_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS idx_camps_stripe_account
    ON public.camps (stripe_account_id)
    WHERE stripe_account_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.get_camp_stripe_status(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    row_data camps;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM camps c WHERE c.id = p_camp_id AND c.owner = caller)
       AND NOT EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = p_camp_id AND u.user_id = caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_a_member');
    END IF;

    SELECT * INTO row_data FROM camps WHERE id = p_camp_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'camp_not_found');
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'connected', row_data.stripe_account_id IS NOT NULL,
        'charges_enabled', row_data.stripe_charges_enabled,
        'onboarding_status', row_data.stripe_onboarding_status,
        'connected_at', row_data.stripe_connected_at
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_camp_stripe_status(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_camp_stripe_status(uuid) TO authenticated;
```
