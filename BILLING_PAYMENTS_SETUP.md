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

---

## Migration 162 — finding card charges the ledger lost

`campistryMe` is a single `camp_state_kv` row that the browser rewrites whole
on every save, from state it read at page load — and it is not the only
writer. `charge-due-installments` appends `finance.payments` and marks an
installment paid; the Stripe, Cardknox, BYOP and hosted-checkout handlers write
the card-on-file fields.

So a tab left open across an overnight autopay run wrote back a blob that
predated the charge. The payment vanished, the family owed it again, and the
installment reverted to `pending` — so the card was charged a second time the
following night. **The balance not going down and the double charge were the
same defect.**

`campistry_finance_merge.js` closes that window at write time: anything the
cloud has that the tab does not is restored before the upsert. Both quantities
only ever append or advance (a payment is never un-made, a refund is a new
negative row; an installment goes `pending → paid` and never back), so the
restore is exact rather than a guess, and local still wins on anything it also
has.

It cannot undo what was already lost. Apply **`migrations/162_reconcile_processor_charges.sql`**
in the Supabase SQL editor, then run it from **Me → Finance → Integrations →
"Check for missing charges"**. It compares every successful charge in
`processor_transactions` against the payments on the ledger and lists any with
nothing pointing at them.

It writes nothing, deliberately: `processor_transactions` carries no
`family_key`, so it can say a charge is unaccounted for but not reliably whose
it is, and crediting a guess to the wrong household is worse than a missing
payment. Where the processor's own metadata names a family it is shown as a
suggestion to confirm.

> **It does not cover Stripe.** The Stripe autopay path never wrote to
> `processor_transactions` at all, so a clean result here does not rule out a
> gap on Stripe — check the Stripe dashboard for the same dates. The tool says
> this on screen too.

---

## Migration 165 — taking the registration deposit on the form

A camp can require money to hold a place (migration 164). Until now the form
could only **say** so. This is the paying half.

**Apply `migrations/185_registration_deposit.sql`**, then **deploy the new
`registration-deposit-checkout` function** (Supabase Dashboard → Edge Functions
→ Deploy a new function → paste
`supabase/functions/registration-deposit-checkout/index.ts`), and **redeploy
`payments-hosted-complete` and `stripe-webhook`**, which now carry the branch
that marks the application paid.

### The order, and why

The application is saved **first**, then the parent pays against it. A form
that refused to submit until a card cleared would throw away twenty minutes of
typing on a declined card — and an unpaid application is a real, correct state
the office already understands: **awaiting deposit**.

### Which rail

Decided from `camps.payment_processor_key`, the same test autopay uses, so a
camp cannot be on one processor here and another there:

| Processor | What the parent gets |
|---|---|
| Stripe (or none set, with Stripe connected) | Stripe Checkout — card and ACH, with the camp's own account as the destination when connected |
| Banquest | The camp's hosted pay page |
| Cardknox / Sola | Sola's own hosted checkout at `secure.cardknox.com/<slug>`, with a real per-transaction amount |
| Anything else | No online step. The amount is stated and the camp collects it as it already does. |

The form asks `get_public_pay_ability` before offering a button, so a camp
without a processor never shows one that cannot work.

### What is guaranteed

- **The amount is never the caller's to name.** The page is anonymous, so the
  figure comes from `_registration_deposit_owed` — what the camp stamped on
  that application — and never from the request body.
- **Recorded once.** `_record_registration_deposit` is idempotent on the
  processor's reference, because processors retry webhooks and a double credit
  is real money.
- **Written with `jsonb_set`, not read-modify-write.** A webhook that rewrote
  the whole `campistryMe` document would lose whatever the office saved while
  the parent was on the processor's page — the defect that erased autopay
  charges.
- **A failed mark is loud.** If the money moved and the application could not
  be marked, the parent is given the reference and told to contact the camp,
  and the failure is logged. A silent success would leave a paid family sitting
  in a list of unpaid ones.

> **Test it with a card before a real family does.** Put Stripe in test mode (or
> Banquest in sandbox), submit an application with a deposit required, pay it,
> and confirm the Registration list flips that application to **paid**. None of
> this can be verified from the code alone.

### Migration 166 — saving the card at registration

A family paying a deposit has already typed their card into the camp's
processor. Asking them to type it again in July, to set up a plan or pay an
instalment, is work nobody needs to do twice.

Picking **Credit Card** or **ACH** says, where it is picked, exactly what will
happen — with a tickbox to keep the card. On submit they go straight to the
payment rather than hunting for a second button; the pay step stays on the
confirmation screen for anyone who comes back.

**On a Banquest camp the card fields open right there, underneath the choice.**
The parent types the card, presses **Submit & pay $250**, and the application
and the payment go together with no redirect at all. The fields are not ours:
`campistry_card_setup.html` is framed in (`?mode=token&embed=1`), the card
number lives inside Banquest's own iframe inside *that* page, and all that
comes back to the form is a single-use nonce plus the last four digits.

**Stripe and Cardknox/Sola camps still redirect**, because those two collect
cards on their own hosted pages — that page *is* their card form. The note
under the payment methods says which one is about to open. There is no
half-built inline form for them: the alternative would mean card numbers
passing through Campistry's own page, which nothing here does.

Whichever rail, **the amount is never sent from the browser.**
`registration-deposit-checkout` charges what `_registration_deposit_owed` says
the camp stamped on that saved application, so a public form cannot name its
own price in either direction.

A nonce is single-use, so a charge that fails for any reason clears the card
off the form and the parent enters it again — rather than leaving a button that
can only fail the same way twice.

Apply **`migrations/186_registration_saved_card.sql`** alongside 185, and
redeploy the same three functions.

**The card number never reaches Campistry.** The parent types it on the
processor's page. Only the processor's own references and the last four digits
are stored, which is what every existing card-on-file path here already holds.

The token waits on the *application*, because there is no family record until
the office accepts — `enrollCamper` carries it onto the family at the moment
the family first exists, and **never overwrites a card the office already has
on file**, which was chosen deliberately and may be the one autopay is running
on.

### Migration 189 — the card is checked before the form is sent

Apply **`migrations/189_registration_card_capture.sql`**, deploy the new
**`card-capture-start`** function, and redeploy **`stripe-webhook`**,
**`cardknox-webhook`** and **`registration-deposit-checkout`**.

This changes the order of the whole thing. Before: submit, then meet the
processor, then find out the card was declined with the application already
gone. Now:

1. The parent picks Credit Card or ACH.
2. A button appears under the choice: **Enter card**.
3. It opens the camp's own processor — framed in for Banquest, a popup for
   Stripe and Cardknox/Sola.
4. The processor accepts or refuses the card. **Nothing is charged there** —
   every rail runs a zero-amount check (`verify` + `save_card`, `cc:save`, a
   Checkout Session in `setup` mode).
5. A tick appears next to the method, or a cross with the reason.
6. **Submit stays disabled until the tick**, and says what is missing:
   *"Enter your card to submit"*.
7. On submit, the deposit is charged against that card, for the amount the
   camp stamped on the now-saved application.

Both forms do this — registration and post-acceptance — through one shared
module, `campistry_card_capture.js`, so the rule cannot drift between them.

**If you see "Your card was accepted but we could not save it".** The card is
genuinely fine — that message means `complete_card_capture` could not be
reached. Two things cause it, and **both need `migrations/194_one_complete_card_capture.sql`
applied** (after 189 and 192):

1. **189 was never applied**, so the function does not exist.
2. **There are two of it.** 192 added an 8-argument form (`p_funding`, with a
   default) and kept 189's 7-argument one. PostgREST calls RPCs by argument
   *name*, not position, so a body carrying the original seven names matched
   both and Postgres refused to choose (`PGRST203`). Every caller broke; the
   Banquest path is the one a parent sees, because it is the only rail that
   records the result inside the request they are waiting on. 194 drops the
   narrower form.

The function now tells these apart, says *"Online card entry isn't finished
setting up for this camp"* instead of asking for a retry that cannot work, and
releases Submit. It also returns the database's own error text, which the form
prints to the browser console as `[CardCapture] server said: …` — check there
before guessing.

**How the answer gets back.** The popup is on the processor's origin and
cannot talk to the form, and only some processors redirect back at all (Sola
answers by webhook and returns nothing to the browser). So there is one
mechanism for all three: the server mints a reference, every rail writes its
verdict onto that row, and the form polls it. A closed popup, a refreshed tab
and a parent who wandered off all behave the same way.

**The form is never told anything it could misuse.** `get_card_capture_status`
is the only anon-callable piece and it returns a status, a brand and the last
four digits. The vault references stay server-side.

**The parent is asked whether to keep the card.** A tick under the card step:
*"Keep this card on file for future camp payments."* Off unless they say so.
The processor holds the card either way — that is how the deposit is charged a
moment later, and a parent cannot pay by card and opt out of that — but without
the tick the vault reference stops there: this charge used it, nothing else
will. With it, the card lands on the application and so on the family the
office creates from it.

**It never blocks on a step it cannot run.** No processor connected, the module
failed to load, no deposit due with the application, or a method that never
reaches a processor — in all of those the application submits as it always did
and the camp collects however it already does.

### Migration 167 — Cardknox / Sola

Apply **`migrations/187_cardknox_registration_deposit.sql`** and redeploy
**`cardknox-webhook`** as well.

Sola's hosted checkout already carries a real per-transaction amount
(`?xAmount=`) and correlates back through an intent row (migration 134), and it
saves cards through `cc:save` (135/136). Nothing new was invented — the intent
only had to learn about applications, because every other kind belongs to a
family or a camper and neither exists before the office accepts.

> **The detail that matters.** Live testing established that Sola's
> hosted-checkout webhook **never echoes `xInvoice` back**; it correlates by
> amount within a bounded window instead. That amount-matched path builds its
> intent object field by field, and it did not carry `enrollment_id` — so a
> registration deposit would have resolved to an intent with no application to
> credit and the money would have landed nowhere. That is the normal path on
> this rail, not an edge case.
