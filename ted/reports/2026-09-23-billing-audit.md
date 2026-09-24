# Ted's report: Billing, payments, refunds and payment plans, 2026-09-23

## Verdict: 🔴 Problems found

I traced the main money journeys through the code: charging a saved card, a payment plan on autopay, refunds, late fees and surcharges, credits, and disputes. I ran the real autopay runner and the real refund function against a fake Stripe, and the real parent-balance function on a scratch database. Four problems need fixing before this handles real money. Autopay never charges a payment plan that a parent set up. Anyone who has a payment's reference number can refund it without logging in. Late fees and other added charges never reach the balance anyone pays. On Banquest/Cardknox camps, the office's "Charge card" button calls a function that cannot start.

## The numbers
Tests run: 3,376 · Passed: 3,362 · Failed: 14 (real bugs: not re-sorted today, all 14 are the auto-scheduler failures already tracked as TED-005, outside billing · out-of-date tests: 0 · my machine: 0)

- Unit tests (`npm test`): 3,294 run, 3,280 passed, 14 failed (all in `auto_full_day.test.js`, TED-005)
- Database tests (`npm run test:pg`): 50 run, 50 passed
- Money smoke test (`npm run test:smoke`): 32 of 32 passed. It only covers the canteen and the shop, not tuition billing.
- My own checks: 3 runs of the real autopay runner, 1 run of the real refund function, and 1 run of the real parent balance on a scratch database. Details under each finding.

All the billing tests pass, and the four serious problems below still get through. Most billing tests only check that certain words appear in the code. They don't run it (see TED-060).

## What's wrong (most serious first)

### TED-051 🔴 Autopay never charges a payment plan a parent built
- **What a user would see:** A parent sets up a plan in the portal and autopay is turned on. On each due date nothing is charged and nobody is told. The plan shows as active, the office sees no failure, and the money is never collected. A camp that ran the "convert to ledger plans" tool has the same problem on every converted plan.
- **How sure I am:** Confirmed
- **Proof:** The nightly runner's first check skips any family unless one of its plans has an `installments` list (`supabase/functions/charge-due-installments/index.ts:528`). Plans built by parents are written with `dueDates` and no `installments` (`migrations/181_new_plans_are_ledger_plans.sql:239-252`, repeated in `215_payment_family_writers.sql`). I ran the real runner file, with only its two import lines pointed at a fake database and a fake Stripe. The setup was one parent-built plan and one office-built plan, both due today, both with a card on file, both on autopay. Result: `stripe charges made: [ 'cus_O $500' ]`, and nobody even asked what the parent's family owed (`plan_due_for asked for: []`). Then I widened that one line to also accept `dueDates`, and both were charged (`[ 'cus_P $500', 'cus_O $500' ]`). The existing test for this (`tests/ledger_plans_and_unread_failures.test.js:84`) only checks that a certain line of text exists, which is why it still passes.
- **What to ask the builder for:** "The autopay runner skips every plan that has dueDates and no installments (charge-due-installments line 528). Fix it, and add a test that actually runs the runner with a parent-built plan and checks it gets charged."

### TED-052 🔴 Anyone who has a payment's reference number can refund it, no login needed
- **What a user would see:** A parent, or anyone else, can send the payment back to the card themselves, without the camp knowing or agreeing. Autopay receipt emails print this reference number (the "Reference" line), so every parent who gets a receipt has one. The refund then shows up on the family's balance, so the camp is out the money until someone notices.
- **How sure I am:** Confirmed (the function has no check; on the live system the only barrier is the public key that ships inside every Campistry page)
- **Proof:** `supabase/functions/stripe-refund/index.ts` never looks at who is calling. There is no login check, no camp check and no role check (compare `stripe-charge`, which requires an owner or admin). The project has no `supabase/config.toml` adding a gate. I ran the real file with a request carrying no login and no camp, just `{paymentIntentId:"pi_FROM_RECEIPT"}`. It answered `HTTP 200 {"refundId":"re_1","status":"succeeded","amount":500}` after calling Stripe's `POST /refunds`. Receipts show the reference at `send-payment-receipt/index.ts:125`, and autopay sends the Stripe payment id as that reference (`charge-due-installments/index.ts:715`). The office's own refund button calls this function without a login too (`campistry_me.js:18294`, `callEdgeFunction`).
- **What to ask the builder for:** "stripe-refund has no caller check. Make it owner/admin only, like payments-refund. Check that the payment belongs to the caller's camp, add the same refund-claim (idempotency) protection, and send the login from Billing."

### TED-053 🔴 Late fees, card surcharges and any "Add Charge" never reach the balance anyone pays
- **What a user would see:** The office charges a late fee and a "Late Fee $25" line appears in the family's activity. But the balance due doesn't change, on the office's screen or in the parent's portal, so the fee is never paid. The same goes for card surcharges, one-off "Add Charge" items, bulk charges and season close-out entries. The printed statement shows lines that don't add up to its own "Balance Due". Credits don't have this problem: the builder posts them to the ledger.
- **How sure I am:** Confirmed for the parent's balance (real database run). Confirmed from the code for the office's balance.
- **Proof:** All five charge writers only add to the family's charge list: `campistry_me.js:2273` (close-out), `:2381` (surcharge), `:3155` (bulk), `:3452` (late fee), `:17971` (Add Charge). None of them posts to the ledger; credits do (`_postLedgerCredit`, `:398`, `:3162`). Both screens use the ledger figure whenever a family has one: the office at `campistry_me.js:16328-16338`, the parent in `migrations/202_ledger_projection.sql:290-410`. The parent's check that the ledger is complete only looks at tuition and payments. Scratch database: a family with $1,000 tuition and a $400 payment, both properly on the ledger, plus a $25 late fee. The parent's balance came back as `{"ledger": true, "balance": 600.00}`, while the family's own records work out to `{"derived_balance": 625}`. The office's gap figure (`ledgerDiff`) is worked out but never shown anywhere.
- **What to ask the builder for:** "Late fees, surcharges, Add Charge, bulk charges and close-out entries go into f.charges but never onto the posted ledger, so neither balance includes them. Post each one to the ledger (keyed on its id) and add a real-database test that a $25 late fee changes the parent's balance."

### TED-054 🔴 On Banquest/Cardknox camps, the office's "Charge card on file" can't work
- **What a user would see:** On a camp using Banquest or Cardknox, the office presses "Charge card" (or "Batch charge") and gets an error every time. No money is taken.
- **How sure I am:** Confirmed from the repository (I can't see what is deployed)
- **Proof:** The button calls `payments-charge` (`campistry_me.js:18796`). That function imports `./_shared/processor_adapter.ts` from its own folder (`supabase/functions/payments-charge/index.ts:22`). That folder contains nothing except `index.ts`. The builder's own note in `payments-refund/index.ts:25-27` says this same import pattern "was broken and could never boot", and they fixed it there but not here. `payments-checkout` and `payments-canteen-checkout` have the same broken import, but nothing in the pages calls them.
- **What to ask the builder for:** "payments-charge still imports ./_shared/processor_adapter.ts, which doesn't exist next to it. Make it self-contained the way payments-refund was, and have the office charge button use it."

### TED-055 🟠 A declined payment on an office-built plan is dropped for good, with no alert
- **What a user would see:** The office sets up a plan with autopay. One month the card is declined. That payment is never tried again, no "collection blocked" warning appears, and no notification goes out. The family simply never pays that instalment unless someone spots it.
- **How sure I am:** Confirmed
- **Proof:** Real runner, fake Stripe that declines. Night 1: `result: failed`, instalment set to `"failed"`, 0 alerts raised. Night 2: 0 charge attempts, 0 alerts. The older plan type skips anything not `"pending"` (`charge-due-installments/index.ts:749`) and never calls the alert step. Migration 181's own header describes this problem and leaves it in place.
- **What to ask the builder for:** "A declined instalment on an installments[]-style plan is never retried or flagged. Either move those plans onto the new model or give them the same retry and alert logic."

### TED-056 🟠 The two kinds of payment plan are still not reconciled, and the office keeps making the old kind
- **What a user would see:** Plans the office creates use the old fixed-amount kind, and plans parents create use the new kind. They behave differently: a decline is handled differently, the amount is worked out differently, and retries differ. If the office opens a parent's plan and presses "Update Plan", it quietly turns back into the old kind and loses its history.
- **How sure I am:** Confirmed from the code
- **Proof:** `campistry_me.js:19258` builds every office plan with `installments` and replaces an existing plan with it, dropping `dueDates`, `nextIndex` and `history`. The autopay runner keeps two separate paths (`charge-due-installments/index.ts:30-44`), and the old path uses its own third balance formula (`computeFamilyBalance`, `:210-270`). Task #51, "Reconcile the two installment models", is still pending.
- **What to ask the builder for:** "Make the office's Set Up / Edit Payment Plan write the same dueDates plan the parent portal does, and never turn a dueDates plan back into installments."

### TED-057 🟠 The Stripe webhook accepts unsigned messages if its secret isn't set
- **What a user would see:** If the Stripe webhook secret is missing from Supabase, anyone can send a fake "payment succeeded" message and a family is marked as paid for money that never arrived.
- **How sure I am:** Likely (it depends on whether the owner set the secret)
- **Proof:** `supabase/functions/stripe-webhook/index.ts:852` only checks the signature `if (STRIPE_WEBHOOK_SECRET)`. With no secret it accepts everything. `byop-dispute-webhook` was changed on purpose to refuse everything when its secret is missing (`byop-dispute-webhook/index.ts:191-199`). This one wasn't. There is also no check on the message's age, so an old signed message can be replayed.
- **What to ask the builder for:** "Make stripe-webhook refuse every request when STRIPE_WEBHOOK_SECRET isn't set (like byop-dispute-webhook), and reject signatures older than 5 minutes."

### TED-058 🟠 The office charge can hit a card that belongs to a different camp
- **What a user would see:** An owner or admin of any camp (and anyone can sign up and create a camp) who knows another family's Stripe customer number can charge that family's saved card. The function doesn't refuse; it just sends the money to the platform's account instead of the camp's.
- **How sure I am:** Likely (code read; it needs the other family's customer number)
- **Proof:** `supabase/functions/stripe-charge/index.ts:104-118` checks whether the card belongs to the caller's camp only to decide where the money goes. The comment says "never reject the charge itself". The charge then runs at `:227` either way. There is also no idempotency key, so a retried request charges twice.
- **What to ask the builder for:** "In stripe-charge, refuse the charge when the customer isn't one of the caller's camp's families, and send a Stripe Idempotency-Key."

### TED-059 🟠 "Batch charge" always reports 0 failed
- **What a user would see:** The office runs Batch Charge. Declined cards flash an error one at a time, but the final message says "Batch complete: 12 charged, 0 failed", so the office believes everyone paid.
- **How sure I am:** Confirmed from the code
- **Proof:** `chargeStoredCard` catches every error itself and never passes it on (`campistry_me.js:18849-18852`). `batchCharge` counts a success whenever no error reaches it (`:18877-18884`), so `failed` can never go up.
- **What to ask the builder for:** "Make chargeStoredCard return whether the charge succeeded, and have batchCharge count real failures and list who failed."

### TED-060 🟡 The billing tests can't catch the problems above
- **What a user would see:** Nothing directly. But the tests pass while autopay, refunds and late fees are broken.
- **How sure I am:** Confirmed
- **Proof:** The project's test database (`tests/e2e/db.js`, list of 89 migrations) leaves out most billing migrations: 169, 172-177, 179-181, 185-187, 192 and 198 (autopay recording, dunning, chargebacks, refund claims, card fees). It is even missing two functions the parent's balance needs (`family_ledger_summary` and `family_has_tuition_entry`). My first run of `get_my_balance` there failed with `function public.family_ledger_summary(jsonb) does not exist`. None of those migrations has a database test. The money smoke test covers only the canteen and the shop. The parity test compares two hand-written copies, not the real code. Many billing tests only look for text in the source.
- **What to ask the builder for:** "Add the billing migrations to the test database chain, and add real tests: autopay with a parent plan, a declined instalment, a refund without login, a late fee changing both balances."

### TED-061 🟡 A leftover payment-setup function is open to anyone
- **What a user would see:** Nothing. But anyone can use it to create customer records on the camp's Stripe account.
- **How sure I am:** Confirmed from the code
- **Proof:** `supabase/functions/stripe-setup/index.ts` has no caller check, and nothing in the app calls it (a search of all pages found no caller).
- **What to ask the builder for:** "Delete stripe-setup, or add an owner/admin check to it."

### TED-062 🟡 A negative "credit" is accepted and then half-recorded
- **What a user would see:** If someone types -50 as a credit, the family's list shows a -$50 credit, but the balance entry is silently skipped. The two views of the account then disagree.
- **How sure I am:** Confirmed from the code
- **Proof:** `campistry_me.js:18364` only refuses zero (`if(!amt)`), and the ledger writer skips anything not positive (`:6325`).
- **What to ask the builder for:** "Refuse credit amounts that aren't positive."

## What I confirmed is working
- **Autopay on office-built plans charges the right family, and only what is due:** real runner run, office plan charged $500 to `cus_O`.
- **The BYOP refund path (Banquest/Cardknox) is owner/admin only and claims each refund before calling the processor, so a retry can't refund twice:** `payments-refund/index.ts:140-190`. The office's refund button sends a claim key for each part of the refund (`campistry_me.js:18307, 18323`).
- **Office refunds can't exceed what was paid online, are taken from the newest payments first, and payments older than 120 days are sent to "Offline Refund":** `campistry_me.js:17980-18077, 18292`.
- **Stripe refunds made in the Stripe Dashboard reach the family ledger:** `stripe-webhook/index.ts:919-930` posts each refund by its own id.
- **The parent's "pay with saved card" checks who the caller is, rejects amounts under $0.50, and locks against double clicks:** `charge-saved-card/index.ts:193-280`.
- **Credits (single and bulk) are posted to the ledger:** `campistry_me.js:398, 3162`.
- **The Cardknox webhook checks its signature, and the dispute webhook refuses everything without its secret:** `cardknox-webhook/index.ts:163`, `byop-dispute-webhook/index.ts:191-205`.
- **A decline on a parent-built plan would advance with an alert, not be marked paid (once TED-051 is fixed):** code at `charge-due-installments/index.ts:665-680`.
- **Test suites:** unit 3,280/14 (same 14 as before), database 50/0, money smoke 32/0.

## What I did NOT check (and why)
- **Any real processor.** I never called Stripe, Banquest or Cardknox. For example, I didn't check whether Cardknox rejects a same-day refund that should be a "void", or whether Banquest amounts round the same way.
- **What is actually deployed** in Supabase: which function versions, which secrets are set, and whether `payments-charge` fails at start-up there.
- **The Billing page and the parent portal in a browser.** Everything about the office's balance is from reading the code.
- **Database security rules (RLS).** The test database runs as a superuser.
- **The registration deposit, hosted pay link and card-setup pages, the Stripe Connect tips, the canteen money** (beyond the smoke test), **payroll, tax statements, bank-deposit matching, and the close-out figures.**
- **Whether card surcharges are legal in each state**, and whether debit cards are excluded. The office's surcharge button always treats the card as a credit card (`campistry_me.js:2375`).
- **Open finding TED-050** (camper-number switch-off test) and **TED-005** (auto-scheduler): there have been no code changes since the last run, so both stay open. TED-005 still shows 14 failures.

## Things only you can check (click-by-click)
1. **Is the Stripe webhook secret set (TED-057)?** Supabase Dashboard → your project → Edge Functions → Secrets. Look for `STRIPE_WEBHOOK_SECRET` in the list. If it isn't there, that finding is live today.
2. **Does `payments-charge` start (TED-054)?** Supabase Dashboard → Edge Functions → click `payments-charge` → Logs. Look for an error mentioning `processor_adapter.ts` or "Module not found". If the function isn't listed at all, it was never deployed, and the office "Charge card" button fails on Banquest/Cardknox camps.
3. **Has anyone refunded payments without the office (TED-052)?** Stripe Dashboard → Payments → filter Status "Refunded". For each refund, check that the office meant to issue it (each one should also appear in Campistry Billing as "Refund — …").
4. **Are families waiting on autopay that never ran (TED-051)?** Supabase Dashboard → SQL Editor → paste this read-only query and click Run:
   `select k.camp_id, f.key as family, p->>'id' as plan, p->'dueDates' as due_dates from camp_state_kv k, jsonb_each(k.value->'families') f, jsonb_array_elements(coalesce(f.value->'plans','[]'::jsonb)) p where k.key='campistryMe' and p ? 'dueDates' and coalesce((p->>'autopay')::boolean,false);`
   Every row is a plan with autopay on that has never been charged. It reads the saved Me-page copy, which can be slightly behind the newest changes.
5. **See TED-053 yourself:** in Campistry Me → Billing, open a family that has a late fee or "Add Charge" item. Compare "Balance due" with the sum of the activity lines, then log in as that family's parent in Link and compare their balance.
