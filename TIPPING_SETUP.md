# Campistry Link Tipping (Stripe Connect) — setup

Real, card-charged staff tipping in Campistry Link — modeled on Grazzee.
Parents pay a tip by card; Stripe splits it automatically so the staff
member's own connected account receives the full tip, and Campistry keeps a
2% fee on top. This is a first **concept build** — test-mode only until the
notes at the bottom are addressed.

## What exists

| Capability | Where | Auto-records? |
|---|---|---|
| Personal Venmo/Zelle/PayPal/Cash App handles (existing, unchanged) | Link admin → Tips Setup → Staff Payment Info | — |
| **Card tips via Stripe Connect** (new) | Link admin → Tips Setup → Card Tips | ✅ (webhook) |
| Staff balance viewer (existing) | `campistry_link_staff.html` (access-code login) | — |
| Manual cash/check payout (existing) | Link admin → Tips Setup → Card Tips → Pay out | — |

A staff member can have personal handles configured, be Stripe-connected,
both, or neither — the parent-facing Tips page shows whichever applies for
that staff member automatically.

## How money reaches a staff member

1. Admin clicks **Connect Stripe** on a staff row (Link admin → Tips Setup →
   Card Tips) → `stripe-connect-onboard` creates a Stripe Connect **Express**
   account and returns a hosted onboarding link. The staff member fills in
   their own bank account there — Campistry never sees or stores it.
2. Once Stripe confirms the account can receive money (`charges_enabled`),
   the row shows **Connected**, and that staff member appears as a "Pay with
   card" option on the parent's Tips page instead of (or alongside) personal
   handles.
3. A parent taps an amount and **Pay with card** → `stripe-connect-tip`
   creates a hosted Stripe Checkout session for `tip + 2%`, with
   `application_fee_amount` = the 2% and `transfer_data.destination` = the
   staff member's connected account — Stripe splits the charge automatically,
   the connected account receives the full tip amount.
4. Stripe calls `stripe-connect-webhook`, which records the tip into
   `link_tips` and credits `link_staff_accounts.total_earned` — **not**
   `balance`, since the money already reached the staff member directly; an
   admin should never "pay out" a Stripe-paid tip a second time.

## One-time setup

### 1. Apply the migration
Run `migrations/057_link_staff_stripe_connect.sql` in the Supabase SQL
editor. Adds Stripe columns to `link_staff_accounts`/`link_tips` and two
RPCs (`get_link_tip_targets`, an updated `get_staff_tip_account`).

### 2. Enable Stripe Connect
Stripe Dashboard → Connect → get started, choose **Express** as the account
type. One-time, done by Campistry (the platform) — no camp ever touches
their own Stripe account for this.

### 3. Deploy the edge functions
```bash
supabase functions deploy stripe-connect-onboard
supabase functions deploy stripe-connect-status
supabase functions deploy stripe-connect-tip
supabase functions deploy stripe-connect-webhook
```

### 4. Set secrets
```bash
supabase secrets set STRIPE_SECRET_KEY=sk_test_xxx        # same var the rest of Stripe already uses
supabase secrets set STRIPE_CONNECT_WEBHOOK_SECRET=whsec_xxx   # from step 5, a DIFFERENT secret than STRIPE_WEBHOOK_SECRET
supabase secrets set SUPABASE_ANON_KEY=<your anon/publishable key>
# SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.
```

### 5. Register the Connect webhook in Stripe
Dashboard → Developers → Webhooks → Add endpoint:
- URL: `https://<your-project>.supabase.co/functions/v1/stripe-connect-webhook`
- **Listen to events on: Connected accounts** (not "Your account" — easy to
  miss, and `account.updated` won't fire without it)
- Events: `account.updated`, `payment_intent.succeeded`, `payment_intent.payment_failed`
- Copy the signing secret into `STRIPE_CONNECT_WEBHOOK_SECRET` (step 4) —
  this is a **separate** webhook/secret from the existing billing
  `stripe-webhook`, so this feature's event handling can evolve independently.

## Testing end-to-end (test mode)

1. In Link admin → Tips Setup → Card Tips, **+ Add Staff Account** → click
   **Connect Stripe**.
2. Complete Stripe's test onboarding (use test bank routing `110000000` /
   account `000123456789`; any test SSN/DOB works). You're redirected back
   with the row showing **Connected** within a few seconds.
3. As a test parent in Link, open Tips → tip that staff member → confirm the
   sheet shows "$10.00 tip + $0.20 fee (2%) = $10.20 total" → **Pay with
   card** → pay with `4242 4242 4242 4242`, any future expiry/CVC/ZIP.
4. In the Stripe Dashboard (test mode): confirm the PaymentIntent is $10.20
   with a $0.20 application fee and a $10.00 transfer to the connected
   account.
5. Back in Link admin: the staff row's **Earned** total should rise by
   $10.00; **Balance**/**Paid Out** should be unchanged (that's the manual
   cash-payout ledger, untouched by Stripe-paid tips).
6. `campistry_link_staff.html` (the staff's own access-code balance page)
   should show the tip in recent activity.

No local dev server convention exists in this repo for edge functions — test
against the deployed test-mode functions. Forward webhook events with
`stripe listen --events account.updated,payment_intent.succeeded,payment_intent.payment_failed --forward-to https://<project-ref>.supabase.co/functions/v1/stripe-connect-webhook`
(prints a temporary `whsec_...` you can use in place of step 5's Dashboard
webhook while testing), or just register the permanent Dashboard webhook from
step 5 and test against it directly.

## Notes / follow-ups (known concept-stage limitations)

- **2% is hardcoded** in `stripe-connect-tip`, not yet a camp-configurable
  setting. Fine for a single pilot camp; would need a `camp_state_kv` setting
  (same storage pattern as `stripePublishableKey`) before this varies by camp.
- **No verified staff identity beyond Stripe's own KYC.** A charge can only
  ever be initiated against a `link_staff_accounts.id` the admin explicitly
  created and connected — never a parent-typed name — but nothing confirms
  the person who completes Stripe onboarding is actually the intended staff
  member. Acceptable for a single pilot camp; would need a real staff login
  (email-verified) before scaling past that.
- **Checkout shows one combined total**, not itemized tip vs. fee — the
  itemized breakdown only appears in Campistry's own tip sheet before the
  parent redirects to pay.
- Existing personal-handle tipping (Venmo/Zelle/PayPal/Cash App) is
  completely unaffected — it's the fallback for any staff member who isn't
  Stripe-connected yet.
