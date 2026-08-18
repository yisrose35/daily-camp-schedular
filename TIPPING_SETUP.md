# Campistry Link Tipping (Stripe Connect) — setup

Real, card-charged staff tipping in Campistry Link — modeled on Grazzee.
Parents pay a tip by card; Stripe splits it automatically so the staff
member's own connected account receives the full tip, and Campistry keeps a
2% fee on top of Stripe's own processing cost. This is a first **concept
build** — test-mode only until the notes at the bottom are addressed.

## Three people, three surfaces

| Who | Surface | Does what |
|---|---|---|
| **Head counselor / admin** | Link Admin → Tips Setup → Card Tips | Creates a staff tip account (name, role, generates an access code), sets the suggested tip amount, and sees the ledger (Earned / Balance / Paid Out per staff member) |
| **Parent** | Link Parent → Tips | Pays a tip by card |
| **Staff member (the receiver)** | Campistry Lite → **Tips** tab (inside "My Camp" for counselors, or Link Lite for head staff) | Links their own login to the account the admin created (one-time, via the access code), then connects their own Stripe Express account themselves |

A staff member can have personal handles configured, be Stripe-connected,
both, or neither — the parent-facing Tips page shows whichever applies for
that staff member automatically.

## How money reaches a staff member

1. Admin creates the staff account in Link Admin (name, role, access code) —
   unchanged from before.
2. **The staff member**, not the admin, connects Stripe: in Campistry Lite's
   Tips tab, they enter that access code once to link it to their own login
   (`claim_staff_tip_account`, migration 058), then tap **Connect Stripe** —
   `stripe-connect-onboard` creates a Stripe Connect **Express** account
   under *their* session and returns a hosted onboarding link. They fill in
   their own bank account there — Campistry never sees or stores it. (The
   old admin-triggered "Connect Stripe" button in Link Admin still works as
   a fallback, e.g. for a staff member without a Lite login yet — but the
   receiver connecting themselves is now the primary path, since a real bank
   account should be attached by the actual person.)
3. Once Stripe confirms the account can receive money (`charges_enabled`),
   Lite shows **Connected**, and that staff member appears as a "Pay with
   card" option on the parent's Tips page instead of (or alongside) personal
   handles.
4. A parent taps an amount and **Pay with card** → `stripe-connect-tip`
   creates a hosted Stripe Checkout session for `tip + fee`, where `fee` is
   **Stripe's real processing cost (2.9% + 30¢) plus Campistry's 2%** —
   `application_fee_amount` = that combined fee and
   `transfer_data.destination` = the staff member's connected account, so
   the connected account always receives the exact tip amount regardless of
   what Stripe itself deducts. (Passing only Campistry's 2% to the parent,
   as the very first version of this did, meant Campistry paid Stripe's cut
   out of its own margin — see `computeFees()` in `stripe-connect-tip` for
   the exact grossed-up math.)
5. Stripe calls `stripe-connect-webhook`, which records the tip into
   `link_tips` (`fee_amount` = the combined Stripe + Campistry fee) and
   credits `link_staff_accounts.total_earned` — **not** `balance`, since the
   money already reached the staff member directly; an admin should never
   "pay out" a Stripe-paid tip a second time.

## One-time setup

### 1. Apply the migrations
Run, in order, in the Supabase SQL editor:
- `migrations/057_link_staff_stripe_connect.sql` — Stripe columns on
  `link_staff_accounts`/`link_tips`, plus `get_link_tip_targets` and an
  updated `get_staff_tip_account`.
- `migrations/058_link_staff_lite_self_service.sql` — adds `user_id` to
  `link_staff_accounts`, the self-service RLS policies + guard trigger, and
  `claim_staff_tip_account()`, so a staff member's own Lite login can reach
  and connect their own row (see the header comment for the security
  reasoning behind the guard trigger).

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
supabase secrets set STRIPE_CONNECT_WEBHOOK_SECRET=whsec_xxx           # from step 5a
supabase secrets set STRIPE_CONNECT_ACCOUNT_WEBHOOK_SECRET=whsec_yyy   # from step 5b — a DIFFERENT secret
supabase secrets set SUPABASE_ANON_KEY=<your anon/publishable key>
# SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.
```

### 5. Register the Connect webhook in Stripe — TWO endpoints, same URL
The two event types this feature needs live on two different accounts, so
one endpoint is not enough — you must create **both**:

**5a. Platform-account endpoint** (for the actual money-moving event)
- URL: `https://<your-project>.supabase.co/functions/v1/stripe-connect-webhook`
- **Listen to events on: Your account** (the default — leave "Connected
  accounts" OFF here)
- Events: `payment_intent.succeeded`, `payment_intent.payment_failed`
- Why: `stripe-connect-tip` creates the Checkout Session (and thus the
  PaymentIntent) on the **platform** account and routes the money via
  `transfer_data.destination` — a destination charge. The PaymentIntent
  itself is a platform-account object, so its `succeeded` event only ever
  fires on a "Your account" endpoint. A Connected-accounts-only endpoint
  will never receive it — money charged, nothing recorded.
- Copy the signing secret into `STRIPE_CONNECT_WEBHOOK_SECRET` (step 4).

**5b. Connected-accounts endpoint** (for onboarding status)
- URL: same as above
- **Listen to events on: Connected accounts**
- Events: `account.updated`
- Why: this fires on the staff member's own Express account, never on the
  platform account.
- Copy this endpoint's (different) signing secret into
  `STRIPE_CONNECT_ACCOUNT_WEBHOOK_SECRET` (step 4).

Both secrets are a **separate** pair from the existing billing
`stripe-webhook`'s secret, so this feature's event handling can evolve
independently. The function accepts either secret on incoming requests, so
one shared function correctly serves both endpoints.

## Testing end-to-end (test mode)

1. In Link admin → Tips Setup → Card Tips, **+ Add Staff Account** — note
   the generated access code.
2. As that staff member, in Campistry Lite → **Tips** tab, enter the access
   code → **Link my account** → **Connect Stripe**.
3. Complete Stripe's test onboarding (use test bank routing `110000000` /
   account `000123456789`; any test SSN/DOB works). You're redirected back
   into Lite's Tips tab showing **Connected** within a few seconds.
4. As a test parent in Link, open Tips → tip that staff member → confirm the
   sheet shows something like "$10.00 tip + $0.60 fee = $10.60 total"
   (Stripe's 2.9%+30¢ plus Campistry's 2%, combined — exact cents depend on
   the amount) → **Pay with card** → pay with `4242 4242 4242 4242`, any
   future expiry/CVC/ZIP.
5. In the Stripe Dashboard (test mode): confirm the PaymentIntent's total
   matches that combined figure, with an `application_fee_amount` equal to
   the fee and a transfer to the connected account equal to exactly $10.00.
6. Back in Link admin: the staff row's **Earned** total should rise by
   $10.00; **Balance**/**Paid Out** should be unchanged (that's the manual
   cash-payout ledger, untouched by Stripe-paid tips).
7. `campistry_link_staff.html` (the staff's own access-code balance page)
   and the Lite Tips tab should both show the updated numbers.

No local dev server convention exists in this repo for edge functions — test
against the deployed test-mode functions. `stripe listen` conveniently
forwards both platform and connected-account events through one CLI session
with a single temporary `whsec_...` (unlike the two separate Dashboard
endpoints/secrets required in step 5) — forward with:
`stripe listen --events account.updated,payment_intent.succeeded,payment_intent.payment_failed --forward-to https://<project-ref>.supabase.co/functions/v1/stripe-connect-webhook`
and set BOTH `STRIPE_CONNECT_WEBHOOK_SECRET` and
`STRIPE_CONNECT_ACCOUNT_WEBHOOK_SECRET` to that one printed secret while
testing this way. Or just register the two permanent Dashboard endpoints
from step 5 and test against them directly.

## Notes / follow-ups (known concept-stage limitations)

- **2% is hardcoded** in `stripe-connect-tip`, not yet a camp-configurable
  setting. Fine for a single pilot camp; would need a `camp_state_kv` setting
  (same storage pattern as `stripePublishableKey`) before this varies by camp.
- **Stripe's own processing rate (2.9%+30¢) is hardcoded too** (`STRIPE_PCT`/
  `STRIPE_FIXED_CENTS` in `stripe-connect-tip`), matching the standard US
  card rate. If this camp's actual negotiated Stripe rate ever differs,
  update those two constants (and the identical copy in
  `_tipComputeFeeCents()` in `campistry_link_parent.html`, which mirrors
  this formula so the parent's pre-payment estimate matches what's actually
  charged).
- **Staff identity now has a real link, but it's still self-attested at
  claim time.** `claim_staff_tip_account()` links a Lite login to a
  `link_staff_accounts` row using the access code as proof — better than the
  original admin-triggered flow (a real person, authenticated, connects
  their own bank account), but the access code is handed out by an admin
  and isn't itself identity-verified — whoever has the code can claim the
  row. Acceptable for a single pilot camp; a stronger version would have the
  admin pick the staff member's existing Lite account directly instead of
  going through a shared code.
- **Checkout shows one combined total**, not itemized Stripe-fee vs.
  Campistry-fee vs. tip — the itemized breakdown (well, the combined-fee
  breakdown, per the owner's chosen display) only appears in Campistry's own
  tip sheet before the parent redirects to pay.
- The admin-triggered "Connect Stripe" button in Link Admin still exists as
  a fallback and keeps working exactly as before — nothing was removed
  there, self-service in Lite is additive.
- Existing personal-handle tipping (Venmo/Zelle/PayPal/Cash App) is
  completely unaffected — it's the fallback for any staff member who isn't
  Stripe-connected yet.
