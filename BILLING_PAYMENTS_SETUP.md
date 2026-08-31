# Campistry Billing & Payments — setup

Everything the office and parents need to take money, in one place. Most of it
is already wired; this is the one-time deploy + Stripe configuration.

## What exists

| Capability | Where | Auto-records? |
|---|---|---|
| Auto tuition invoices from enrollments | Me → Analytics & Finance | — |
| Family ledgers, add-on charges, credits, statements | Me → Billing | — |
| **Refunds** (full/partial, + Stripe refund) | Me → Billing / Analytics | ✅ |
| **A/R aging** (0-30 / 31-60 / 61-90 / 90+) | Me → Analytics → Overview | — |
| Save a payment method (card or ACH bank, hosted on Stripe) + charge it + batch charge | Me → Billing / Link → Payments | ✅ (webhook) |
| **Online "Pay Link"** the office sends a parent | Me → Billing → 💳 Pay Link | ✅ (webhook) |
| **Parent self-pay** (their own balance) | Campistry Link → Payments | ✅ (webhook) |
| **Monthly billing (autopay)** — split a balance into monthly payments, auto-charge the card each due date | Me → Billing → 📆 Monthly Plan | ✅ (nightly job) |
| Manual record of any method (Venmo, Zelle, Check, Cash…) | Me → Billing → Record Payment | — |

**Which methods are offered online** (card, ACH bank debit, Cash App, Link,
PayPal, Klarna, …) is controlled entirely by what you enable in your **Stripe
Dashboard** — no code change. Venmo and Zelle are **not** Stripe methods (Venmo
is PayPal-only; Zelle has no merchant API), so those stay manual-entry: the
parent sends them, the office records them under Record Payment.

## How online money reaches Billing

1. Office clicks **💳 Pay Link** (or a parent taps **Pay** in Campistry Link).
2. `stripe-checkout` creates a hosted Stripe payment page → parent pays with any
   enabled method.
3. Stripe calls `stripe-webhook`, which writes the payment straight into
   `camp_state_kv → campistryMe.finance.payments` — the same list the office
   Billing/Analytics screens read. ACH shows as **pending** until it settles
   (not counted as collected), then flips to **succeeded**.

## One-time setup

### 1. Apply the migration
Run `migrations/046_get_my_balance.sql` in the Supabase SQL editor (lets a parent
see only their own balance).

### 2. Deploy the edge functions
```bash
supabase functions deploy stripe-setup
supabase functions deploy stripe-charge
supabase functions deploy stripe-refund
supabase functions deploy stripe-checkout
supabase functions deploy stripe-webhook
```

### 3. Set secrets
```bash
supabase secrets set STRIPE_SECRET_KEY=sk_live_xxx
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_xxx   # from the webhook you create in step 5
# SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.
```

### 4. Set your publishable key in the app
Campistry Me → Settings → Stripe publishable key (`pk_live_...`). Used by the
save-card flow.

### 5. Register the webhook in Stripe
Dashboard → Developers → Webhooks → Add endpoint:
- URL: `https://<your-project>.supabase.co/functions/v1/stripe-webhook`
- Events: `payment_intent.processing`, `payment_intent.succeeded`,
  `payment_intent.payment_failed`
- Copy the signing secret into `STRIPE_WEBHOOK_SECRET` (step 3).

### 6. Enable the payment methods you want
Stripe Dashboard → Settings → Payment methods: turn on **ACH Direct Debit
(`us_bank_account`)**, **Cash App Pay**, **Link**, **PayPal**, etc. They then
appear automatically on every checkout — no redeploy.

## Monthly billing (autopay)

The office sets a family up on **📆 Monthly Plan** (Me → Billing): a balance is
split into N monthly installments and, if a payment method is on file,
**auto-charged on each due date**. A nightly job does the charging.

**Getting a payment method on file never happens on Campistry's own site.**
Both the parent (Campistry Link → Payments → "Set up autopay") and the office
fallback (Me → Billing → a family → "Set Up in Stripe") redirect to a real
Stripe-hosted Checkout page (`stripe-setup-checkout`, `mode: 'setup'`) where
card **or bank transfer (ACH)** is entered directly with Stripe — nothing
reaches Campistry's servers or database. Stripe confirms completion via a
`setup_intent.succeeded` webhook event, which writes the resulting Customer +
PaymentMethod straight onto the family record.

### Deploy stripe-setup-checkout
```bash
supabase functions deploy stripe-setup-checkout
```
No new secrets needed — it reuses `STRIPE_SECRET_KEY` (already set in step 3
above).

### Add the new webhook event
In the same Stripe Dashboard webhook endpoint created in step 5 above (or a
new one, either works), add **`setup_intent.succeeded`** to its event list —
`stripe-webhook` now handles it alongside the existing `payment_intent.*`
events.

### Apply migration 096
Run `migrations/096_get_my_balance_autopay_status.sql` in the Supabase SQL
editor — it extends `get_my_balance` to also return `familyKey`,
`cardOnFile`, `paymentMethodType`/`paymentMethodLabel`, and the family's
`plan`, which is what the parent's Payments page reads to show the "Set up
autopay" prompt and current status.

### Deploy the runner + schedule it
```bash
supabase functions deploy charge-due-installments
supabase secrets set INSTALLMENT_CRON_SECRET=<a-long-random-string>
```
Then schedule it once a day with pg_cron (enable the `pg_cron` and `pg_net`
extensions first, in Database → Extensions). Run in the SQL editor, filling in
your project ref and the same secret:
```sql
select cron.schedule(
  'campistry-autopay-daily',
  '0 13 * * *',                        -- 13:00 UTC daily
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/charge-due-installments',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<INSTALLMENT_CRON_SECRET>'),
    body    := '{}'::jsonb
  );
  $$
);
```
The runner charges each due installment off-session against the saved card,
marks it paid, and records the payment into Billing (method "Autopay (card)").
A declined charge marks that installment **failed** so the office can retry; it
never double-charges (paid/failed installments are skipped). You can trigger a
run manually by POSTing to the function with the `x-cron-secret` header.

## Notes / follow-ups
- ACH takes ~3–5 business days to settle; it's visible as *pending* the whole
  time and only counts as collected once Stripe fires `succeeded`.
- The parent self-pay button attributes a lump payment to the family via the
  first camper's name (matching the office matching rules). Per-installment or
  per-camper splitting is a future refinement.
- Hardening option: route `stripe-checkout` behind an authenticated RPC so the
  amount/family can't be tampered client-side (low risk today — a parent can
  only pay their own camp).
