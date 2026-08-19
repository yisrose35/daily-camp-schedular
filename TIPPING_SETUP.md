# Campistry Link Tipping (Stripe Connect) — setup

Real, card-charged staff tipping in Campistry Link — modeled on Grazzee.
Parents pay a tip by card; Stripe splits it automatically so the staff
member's own connected account receives the full tip, and Campistry keeps a
2% fee on top of Stripe's own processing cost. This is a first **concept
build** — test-mode only until the notes at the bottom are addressed.

## Three people, three surfaces

| Who | Surface | Does what |
|---|---|---|
| **Head counselor / admin** | Campistry Me → Payroll → **Tip Payments** | Creates a staff tip account (name, role, generates an access code), edits Zelle/Venmo/PayPal/Cash App, sees the ledger (Earned / Balance / Paid Out), removes accounts |
| **Parent** | Link Parent → Tips | Pays a tip by card |
| **Staff member (the receiver)** | Campistry Lite → **Tips** tab (inside "My Camp" for counselors, or Link Lite for head staff) | Their tip account is set up automatically the first time they open the Tips tab — no admin step, no access code needed (`ensure_my_tip_account`, migration 060). They connect their own Stripe Express account, and/or type in their own Zelle/Venmo/PayPal/Cash App. |

Staff Payments management (accounts, handles, Stripe status, ledger, remove)
lives in **Campistry Me → Payroll → Tip Payments**, not Link Admin — every
other piece of staff data (roster, hiring, positions, bunk assignment, wage
payroll) already lives in Me, so managing how a staff member gets tipped
lives with the rest of their record instead of a separate app. Link Admin's
Tips Setup page still owns the "Suggested Tip by Role" $ amounts (parent-
facing config), but no longer touches `link_staff_accounts` directly.

A staff member can have personal handles configured, be Stripe-connected,
both, or neither — the parent-facing Tips page shows whichever applies for
that staff member automatically. Handles a staff member enters themselves in
Lite take priority over anything an admin entered in Me's Tip Payments tab —
that list still works and is shown for any staff member who hasn't
self-entered their own.

## How money reaches a staff member

1. **The staff member**, not the admin, sets everything up themselves: the
   first time they open the Tips tab in Campistry Lite, `ensure_my_tip_account`
   (migration 060) provisions their `link_staff_accounts` row automatically —
   claiming an admin-precreated row by name match if one already exists
   (preserving any tips already logged against it), otherwise creating a
   fresh one tied straight to their login. No access code is required for
   this to work, though the old code-based `claim_staff_tip_account` flow
   (migration 058) still works as a manual fallback if auto-provisioning
   ever fails (e.g. `get_user_camp_id()` can't resolve).
2. From there they tap **Connect Stripe** — `stripe-connect-onboard` creates
   a Stripe Connect **Express** account under *their* session and returns a
   hosted onboarding link. They fill in their own bank account there —
   Campistry never sees or stores it. (The admin-triggered "Connect Stripe"
   button in Me → Payroll → Tip Payments still works too, e.g. for a staff
   member without a Lite login yet.) They can also type Zelle/Venmo/PayPal/
   Cash App handles directly into the Tips tab at any time — self-editable
   per the `link_staff_accounts_self_update` RLS policy (migration 058); the
   guard trigger there only pins ledger/identity columns, so these handle
   columns were self-editable with no trigger change needed.
3. Once Stripe confirms the account can receive money (`charges_enabled`),
   Lite shows **Connected**, and that staff member appears as a "Pay with
   card" option on the parent's Tips page instead of (or alongside) personal
   handles.
4. A parent adds one or more recipients to their **tip cart** — even across
   different camps, if they have kids at more than one — and pays everyone
   in **one checkout**. Two different Stripe patterns handle this
   automatically depending on cart size, but the parent never sees the
   difference:
   - **One recipient** (`stripe-connect-tip`): a Stripe *destination
     charge* — one PaymentIntent with `transfer_data.destination` = that
     staff member's connected account, so Stripe routes the money as part
     of the charge itself.
   - **Two or more recipients, or any cross-camp cart**
     (`stripe-connect-tip-cart`): Stripe can't split one PaymentIntent
     across multiple destination accounts, so this charges the parent's
     card into the **platform's own** Stripe balance (no destination on the
     charge), persists who-gets-what in `link_tip_cart_items` (migration
     059) keyed by a `cartId`, and lets `stripe-connect-webhook` fan the
     payment out into one Stripe `Transfer` per recipient the instant it
     succeeds — Stripe's own documented "separate charges and transfers"
     pattern for one payment, many payouts.
   Either way, the fee is **Stripe's real processing cost (2.9% + 30¢) plus
   Campistry's 2%**, computed so every recipient still receives their exact
   tip amount regardless of what Stripe itself deducts. (Passing only
   Campistry's 2% to the parent, as the very first version of this did,
   meant Campistry paid Stripe's cut out of its own margin — see
   `computeFees()`/the cart's inline equivalent for the exact grossed-up
   math. For a cart, Stripe's 2.9%+30¢ is computed **once on the whole
   cart** — it's one charge, not N charges — and shown as one combined
   "Card & platform fees" line item alongside each recipient's own tip line.)
5. Stripe calls `stripe-connect-webhook`, which records each tip into
   `link_tips` (`fee_amount` = that recipient's own share of Campistry's 2%;
   the cart's shared Stripe fee isn't attributed per recipient — see the
   migration's comment) and credits `link_staff_accounts.total_earned` —
   **not** `balance`, since the money already reached the staff member
   directly; an admin should never "pay out" a Stripe-paid tip a second time.

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
- `migrations/059_link_tip_cart.sql` — adds `link_tip_cart_items` (the tip
  cart's server-side bookkeeping) and changes `link_tips`' idempotency key
  from `stripe_payment_intent_id` alone to `(stripe_payment_intent_id,
  staff_account_id)`, since a cart checkout is one PaymentIntent covering N
  recipients. **Required** even if you don't care about multi-recipient
  carts yet — without it, `stripe-connect-tip-cart`/the webhook's cart
  handler will fail outright (no table to write to).
- `migrations/060_link_staff_self_service_handles.sql` — adds
  `zelle_handle`/`venmo_handle`/`paypal_handle`/`cashapp_handle` to
  `link_staff_accounts`, adds `ensure_my_tip_account()` so a staff member's
  own Lite login can provision their tip account with no admin step and no
  access code, and updates `get_link_tip_targets` to surface the
  self-entered handles to the parent tip sheet.

### 2. Enable Stripe Connect
Stripe Dashboard → Connect → get started, choose **Express** as the account
type. One-time, done by Campistry (the platform) — no camp ever touches
their own Stripe account for this.

### 3. Deploy the edge functions
```bash
supabase functions deploy stripe-connect-onboard
supabase functions deploy stripe-connect-status
supabase functions deploy stripe-connect-tip
supabase functions deploy stripe-connect-tip-cart
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

1. In Campistry Me → Payroll → **Tip Payments**, **+ Add Person** — note
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

**Cart test (2+ recipients, or cross-camp):** connect a second staff account
the same way. As the test parent, open two different recipients' amount
sheets and tap **Add to cart** on each — a sticky bar should appear at the
bottom of the Tips page ("2 recipients · $X total — Review & Pay"). Tap it,
confirm the review sheet lists both with a combined total and one **Pay $X
total** button, and pay with the same test card. In Stripe Dashboard: the
PaymentIntent should have **no** `transfer_data`/`application_fee_amount` at
all (this is the platform-balance charge, not a destination charge) — then
under **Connect → Transfers**, confirm two separate Transfer objects, one
per connected account, each for exactly that recipient's tip amount. In
Supabase, `link_tip_cart_items` for that `cart_id` should show both rows
with `processed_at` set and a `stripe_transfer_id`, and `link_tips` should
have two new rows (one per recipient) sharing the same
`stripe_payment_intent_id` but different `staff_account_id`s — this is
exactly the case the old unique index would have rejected, so if this step
fails with a constraint violation, migration 059 wasn't applied.
For the cross-camp case specifically, this only actually requires a parent
account with an active invite at two different camps — the cart code
doesn't otherwise care whether items span camps or not.

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
- The admin-triggered "Connect Stripe" button now lives in Campistry Me →
  Payroll → Tip Payments (moved from Link Admin, where all Staff Payments
  management used to live) and still works exactly as before — nothing was
  removed, self-service in Lite is additive.
- **A cart's Transfer fan-out has no automatic retry beyond Stripe's own
  webhook redelivery window.** If one recipient's Transfer fails (their
  connected account got disconnected mid-cart, a Stripe hiccup, etc.), the
  webhook logs `transfer_error` on that `link_tip_cart_items` row and moves
  on to the rest of the cart — everyone else still gets paid — but that one
  recipient's payout needs a manual look (query
  `link_tip_cart_items WHERE transfer_error IS NOT NULL`) and a manual
  re-trigger for now. Fine for a concept build's expected volume; an
  automatic retry/alerting pass is the natural next step before this scales.
- **Cart size is capped at 20 recipients** (`MAX_ITEMS` in
  `stripe-connect-tip-cart`) — comfortably above any real family's tip list,
  and well under Stripe Checkout's own 100-line-item ceiling.
- Existing personal-handle tipping (Venmo/Zelle/PayPal/Cash App) is
  completely unaffected — it's the fallback for any staff member who isn't
  Stripe-connected yet.
