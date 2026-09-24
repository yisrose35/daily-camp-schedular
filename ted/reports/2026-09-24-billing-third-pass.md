# Ted's report: billing, third pass (re-check TED-063 to TED-076, then a hunt), 2026-09-24

## Verdict: 🔴 Problems found

I re-checked all 14 billing findings from the last report. The builder's fixes hold for the cases they describe, and I'm closing 13 of them with my own proof. The 14th (TED-076) stays open only because two tests still just look for text. Then I went looking for what those fixes could break, and at billing corners nobody had examined yet. I found 11 new problems. The most serious one is older than these changes: **a family that pays by Zelle or bank transfer still shows as owing that money once their account is on the new ledger, and autopay collects it again.** Several of the others were caused or exposed by these changes. **So no: billing is not yet correct and complete in the code.**

## The numbers
Tests run: 3,542 · Passed: 3,528 · Failed: 14 (real bugs: 14, all the auto-scheduler failures TED-005, which are outside billing and deferred by the owner · out-of-date tests: 0 · my machine: 0)

- Unit tests (`npm test`): 3,379 run, 3,365 passed, 14 failed (all in `auto_full_day.test.js`, TED-005).
- Database tests (`npm run test:pg`): 53 of 53 passed, against 112 migrations.
- `test:keys` 42/42 · `test:lite` 12/12 · `test:smoke` 32/32 · `test:scale` 24/24. The name inventory is up to date.
- These match the builder's figures exactly.
- **The builder's new tests, run against the code from before their fixes** (a scratch copy, removed afterwards):

  | Test file | Failed on the old code |
  |---|---|
  | `stripe_checkout_family` | 4 of 5 |
  | `autopay_runner` | 7 of 10 |
  | `registration_deposit_charge` | 5 of 6 |
  | `hosted_and_sola_matching` | 5 of 7 |
  | `canteen_autoreload_once` | 2 of 2 |
  | `closeout_canteen_and_rollforward` | 3 of 4 |
  | `office_plan_is_ledger_plan` | 5 of 10 |
  | `stripe_refund_and_charge` | 1 of 10 (the new refund-amount test) |
  | `charges_reach_the_ledger` | failed to load |

  So the new tests really do test the fixes.
- **My own proof runs** are in `ted/probes/2026-09-24-billing-3/`:
  - 7 runs on a scratch database built from the project's own migration chain;
  - 3 runs of real edge functions through `tests/edge_harness.js`;
  - 3 runs of the real Me-page and Link code.
- **Commits during this audit:** someone committed to this branch while I worked (up to `6e9a2a7`). Those commits change only the Team & Access pages and `flow.html`, plus one of my own probe files. No billing file changed after `79ed2a0`.

## What's wrong (most serious first)

### TED-077 🔴 A Zelle or bank-transfer payment never lowers the balance of a family on the new ledger, so autopay collects that money a second time
- **What a user would see:**
  - A parent owes $1,000 and sends $400 by Zelle. Campistry's bank-email reader recognises the payment and marks it as that family's.
  - The balance the office sees in Billing, the balance the parent sees in Link, and the amount autopay charges all still work from $1,000.
  - Autopay therefore charges $500 + $500. The family pays $1,400 on a $1,000 bill.
- **How sure I am:** Confirmed on the scratch database. It affects every family whose balance comes from the posted ledger, which is now the normal kind of family.
- **Proof:**
  - `probes/…-3/zelle_ledger.js` runs the real `_deposit_record`. The deposit row reads `posted gold 40000`. Afterwards the ledger balance is still **1000.00**, and `plan_due_for` still answers **$500** for the first payment.
  - Nothing ever puts a bank deposit onto a ledger after conversion:
    - `_deposit_record` only writes the `bank_deposits` table (`migrations/163…sql:78-133`), and so does `resolve_bank_deposit` (145).
    - The only thing that copies deposits across is `sync_family_ledger_payments` (178/215). Nothing in the code calls it, and migration 183 took it away from logged-in users.
  - The parent's balance (`get_my_balance`, `migrations/202…sql:369-405`) treats the ledger as complete without asking about bank deposits, then returns the ledger figure.
  - The Me page uses the posted balance for these families (`campistry_me.js:16469-16480`). The deposit only shows up there as a "ledger disagrees" difference.
- **What to ask the builder for:** "Bank deposits never reach posted ledgers (TED-077). When a bank deposit is posted to a family (_deposit_record auto-match, resolve_bank_deposit, reversals, unmatch/ignore), post or reverse a le_dep_<id> entry on that family's ledger in the same database function. Make get_my_balance's completeness check count posted deposits. Backfill the existing ones, and add a pgtest: $1,000 bill, $400 Zelle auto-posted → ledger 600, plan_due 300."

### TED-078 🟠 A Billing tab left open undoes the autopay runner's work, including the new "bank debit in flight" hold, so the family is debited again
- **What a user would see:**
  - A family pays autopay from a bank account. At night the runner starts a $500 debit and writes a "waiting for this debit" note onto the family's plan (the TED-064 fix).
  - Next morning the office uses a Billing tab it opened the day before and changes anything on that family, for example adding a $10 charge or recording a check.
  - Saving writes back the tab's old copy of the family, which doesn't have the note. That night the runner debits the bank account again.
  - The same overwrite also wipes the plan's payment counter and anything else the runner, a webhook or the shop wrote to that family since the tab loaded.
- **How sure I am:**
  - Confirmed that a save from a stale copy wipes the hold.
  - Likely that tabs are stale in real use. Billing only hears about changes to the camp settings table, never about changes to family rows, so nothing refreshes the tab after an overnight autopay run.
- **Proof:**
  - `probes/…-3/stale_hold.js`: after `hold_autopay_charge`, the plan shows `pendingCharge {…pi_ach_1…}`.
  - The office's save through `sync_camp_billing` then leaves `pendingCharge` **undefined**, and `plan_due_for` answers `amount 500.00` again.
  - The page's other save path does the same: it rewrites `campistryMe.families` in the settings table, and the 211/234 trigger copies that onto the family rows. After that save the hold is also gone.
  - Why the tab goes stale:
    - The page sends whole family records (`campistry_me.js:2818-2847`, `:965`).
    - It re-reads family rows only in `loadData()` (`:682`).
    - Live updates listen to `camp_state_kv` only (`integration_hooks.js:2647`).
    - The plan editor's "keep pendingCharge" (`campistry_me.js:19470`) copies from the same stale copy.
- **What to ask the builder for:** "The Me page overwrites whole family rows from its in-memory copy (sync_camp_billing and the families projection trigger), wiping what the runner, webhooks and settle_shop_order wrote since the tab loaded, including plan.pendingCharge (TED-078). Make family saves merge on the server: never drop server-owned plan fields (pendingCharge, nextIndex, history, collectionBlocked) or ledger entries the page didn't know about, or refuse a save based on an older version. Add a scratch-DB test: hold, then a stale office save, and the hold is still there."

### TED-079 🟠 With the office's own payment amounts, a declined payment is never collected, and the plan ends with money still owed
- **What a user would see:**
  - The office sets up $1,000 on 1 June, then $200 and $200. The June card charge is declined.
  - As before, autopay records the decline and moves on to the next payment. July takes $200 and August takes $200, and the plan reads finished.
  - The declined $1,000 is still owed, and nothing will ever collect it.
  - Before 264 the later payments absorbed a missed one, because each was "what's owed ÷ payments left".
- **How sure I am:** Confirmed on the scratch database
- **Proof:**
  - `probes/…-3/fixed_decline.js`: after the decline, 1 July is due **200.00** and 1 August **200.00**. After the last date nothing is due, with the **balance still 1000.00**.
  - The same decline on a plan without set amounts makes 1 July due **700.00**.
  - The cause: `plan_due` (264) charges `amounts[i]` whenever it is set, and a decline moves the counter on (`charge-due-installments/index.ts:763-772`).
- **What to ask the builder for:** "With plan.amounts (264), a declined instalment is skipped for good (TED-079). Either don't advance nextIndex on a decline for fixed-amount plans (retry that same instalment on the dunning schedule), or have the last instalment sweep whatever is still owed. Add a pgtest: 1000/200/200, first declined → the $1,000 is still collected."

### TED-080 🟠 The parent portal shows the wrong payment-plan amounts
- **What a user would see:** The office sets up $1,000, $200 and $200. The parent's portal says "Next payment $466.67 due 1 June — worked out from what is still owed". Autopay then takes $1,000.
- **How sure I am:** Confirmed (the real Link code and the real BillingCore)
- **Proof:**
  - `probes/…-3/link_plan_view.js`: the portal shows `[466.67, 466.67, 466.66]`, and autopay charges `amount: 1000`.
  - `_lkPlanSchedule` (`campistry_link_parent.html:1482-1497`) still divides evenly and ignores `plan.amounts`. The TED-068 fix changed the Me page and BillingCore but missed Link.
- **What to ask the builder for:** "Link's _lkPlanSchedule ignores plan.amounts (TED-080). Use the same rule as BillingCore.planDue / plan_due 264, and change the 'worked out from what is still owed' note for plans with set amounts."

### TED-081 🟠 Merging two family records wipes the second family's late fees and other extra charges from the balance
- **What a user would see:** The office merges two records for the same family (Billing → Merge Families). The second record has a $25 late fee. After the merge, the next time Billing loads, the late fee is cancelled automatically, with an entry that reads "Cancelled — charge". The family now owes $25 less than it should. The same happens to shop orders billed to that family and any other extra charges.
- **How sure I am:** Confirmed (the real merge code and the real Billing catch-up)
- **Proof:**
  - `probes/…-3/merge.js`: before the merge 500 + 525 = 1025. After the merge A owes 1025, and `A.charges: []`.
  - The catch-up then posts `le_chgadj_lf_b_1 credit 25 "Cancelled — charge"`, and **A now owes 1000**.
  - The cause:
    - `mergeFamiliesReconciled` moves B's ledger entries and plans but not B's `charges` list (`campistry_me.js:4075-4081`).
    - The new TED-066 catch-up treats "on the ledger but not in charges" as cancelled (`campistry_me.js:6469`).
- **What to ask the builder for:** "mergeFamiliesReconciled must move b.charges (and b.credits) along with b.entries, or the TED-066 catch-up reverses every charge the merged family had (TED-081). Add a test: merge a family with a posted $25 fee, run _postExistingCharges, and the balance is unchanged."

### TED-082 🟠 On camps that ran the ledger conversion, a shop order billed before the conversion is counted twice when re-priced, and still billed when cancelled
- **What a user would see:** A $40 sweatshirt was billed to a family before the camp converted to the ledger. After conversion:
  - if the shop changes the order to $55, the family owes $95;
  - if the shop cancels it, the family still owes $40.
- **How sure I am:** Confirmed on the scratch database (the real conversion and the real `settle_shop_order`). It only affects camps that ran the conversion.
- **Proof:**
  - `probes/…-3/conv_shop.js`: after conversion the balance is 40.00. Re-pricing to $55 leaves `le_conv_gold_2 $40, le_chg_shop_o1 $55` and **balance 95.00**. Cancelling leaves **40.00**.
  - The cause:
    - The conversion's entries carry no charge id (`migrations/215…sql:758-771`).
    - `_sync_charge_to_ledger` (263) only counts entries that do.
    - The Me page's TED-065 matching only covers charges that haven't changed since conversion.
- **What to ask the builder for:** "_sync_charge_to_ledger and _postExistingCharges don't see le_conv_ entries, so a pre-conversion charge that is later re-priced or cancelled is double-counted or kept (TED-082). Link converted fee entries to their charge ids once (a one-off repair that matches amount and date and stamps source.chargeId), so both paths can see them. Add a pgtest: convert with a $40 shop charge, re-price to 55 → 55, cancel → 0."

### TED-083 🟠 If a deposit charge is cut off mid-way, every later try says "This deposit is already paid" while nothing was charged
- **What a user would see:**
  - A parent pays the registration deposit with the card they entered, or the office presses "Charge deposit now". The connection to Stripe drops, or Stripe answers with an error page.
  - The first try fails. Every try after that tells the parent "This deposit is already paid — thank you" and hides the button. The office sees "Already paid".
  - No money was taken, and the application stays "awaiting deposit".
- **How sure I am:** Confirmed that it happens after a network error. How often that happens live I can't say.
- **Proof:**
  - `probes/…-3/deposit_stuck.test.js` shows the three tries in turn:
    - try 1: `500 connection reset`;
    - try 2: `200 {"success":true,"alreadyPaid":true,"replayed":true}`;
    - try 3: the same as try 2.
  - Card charges that went through: 0.
  - The cause:
    - The claim is taken at `registration-deposit-checkout/index.ts:273-280`. It is released only on a decline or a missing setup.
    - A thrown error goes to the outer catch (`:612`), which doesn't release it.
    - Claims never expire (`migrations/198…sql`).
    - A claim held by someone else is answered as `alreadyPaid`, and the pages believe it (`campistry_register.html:1770`, `campistry_postaccept.html:1124`, `campistry_me.js:19673`).
- **What to ask the builder for:** "registration-deposit-checkout: a thrown error after the claim leaves it held forever, and a held claim is reported as 'already paid' (TED-083). Answer a held-but-unsettled claim with 'a payment is already in progress' (not paid). On an error, release the claim when the processor surely did not charge; for Stripe, rely on the Idempotency-Key and ask Stripe. Give unsettled claims an expiry."

### TED-084 🟠 The bank-debit hold doesn't work for the oldest kind of payment plan: those families are still debited every night
- **What a user would see:** A family whose plan was set up before multiple plans existed (a single plan with no id) pays by bank account. Each night the runner starts a new $500 debit and reports "processing_held", but nothing is held.
- **How sure I am:** Confirmed (the real runner). How many families still have that old plan shape I can't see.
- **Proof:**
  - `probes/…-3/ach_legacy.test.js` shows the same result on nights 1, 2 and 3: `bank debits started 1 | hold calls 0 | results ["processing_held"]`.
  - The cause:
    - `holdCharge` returns early without a plan id (`charge-due-installments/index.ts:432`).
    - `hold_autopay_charge` only looks in `plans[]`, never in the old single `plan` (`migrations/262…sql:47-53`).
- **What to ask the builder for:** "TED-064's hold skips plans without an id and the legacy single f.plan (TED-084). Give such plans an id (or migrate f.plan into plans[]) before holding, fail loudly if the hold did not save, and never report processing_held unless it did. Add a runner test with a legacy f.plan on bank debit."

### TED-085 🟡 After a decline, the new Stripe idempotency keys keep replaying that decline
- **What a user would see:**
  - A registration deposit on a saved card is declined. The parent sorts out their card and the office presses "Charge deposit now" again the same day. Stripe replays the first decline, or refuses because the card changed, for 24 hours.
  - Canteen auto-reload: once a reload is declined, every half-hourly retry that day replays the decline. Three of those switch the parent's auto-reload off, even if they fixed the card in between.
- **How sure I am:** Likely. This is Stripe's documented behaviour: the result for a key is kept for 24 hours, declines included. I did not call Stripe.
- **Proof:**
  - Deposit key: `deposit:<camp>:<application>:<cents>` (`registration-deposit-checkout/index.ts:356`).
  - Reload key: `<camp>:reload:<camper>:<day>:<n>` (`canteen-auto-reload/index.ts:455, 536`). Three failures switch auto-reload off (`:271`).
  - The builder's "decline can be retried" tests use a pretend Stripe that doesn't replay.
- **What to ask the builder for:** "Idempotency keys that outlive a decline (TED-085): add an attempt counter to the deposit and auto-reload keys (bump it after a release), so a retry after a decline is a new request."

### TED-086 🟡 Registration deposits charged by card are missing from the processor's payment record
- **What a user would see:** Nothing directly. But the camp's reconciliation report ("charges recorded at the processor") has no card-charged registration deposits in it, so it can't catch a gap there.
- **How sure I am:** Confirmed on the scratch database
- **Proof:** `probes/…-3/ptx_kind.js`: `record_processor_transaction` refuses kind `registration_deposit` and `registration_card_capture` ("violates check constraint processor_transactions_kind_check"; only `charge`/`refund` allowed, `migrations/126…sql:135`). The deposit function ignores that error (`registration-deposit-checkout/index.ts:382-394`).
- **What to ask the builder for:** "processor_transactions only allows kind charge/refund, so registration deposits and card captures are never recorded there (TED-086). Widen the check, or record deposits as 'charge'."

### TED-087 🟡 Smaller loose ends
- A Cardknox/Sola camp connected without a webhook PIN answers every Sola notice with 200 "Not configured". Sola then treats the notice as delivered, so hosted payments are silently never recorded. The connect tool doesn't require the PIN (`cardknox-webhook/index.ts:157-161`; `admin-connect-processor/index.ts:125`).
- The nightly tip retry writes its `link_tips` row without the parent's payment id (`charge-due-installments/index.ts:1116-1128`). A later dispute or refund lookup by payment won't find that tip.
- `_sync_charge_to_ledger` is declared IMMUTABLE but reads the clock (`migrations/263…sql:30`). It works today, but it should be STABLE.
- The old `migrations/APPLY_BUNDLE.sql` still says "safe to re-run as often as you like". It contains the 167/172 versions of `settle_shop_order`, `plan_due` and `record_autopay_charge`, so running it now would undo 263, 264 and many older fixes. The checking script would flag 263/264 afterwards (my re-run probe confirmed it does).
- The "card payment needs matching" notice (TED-071) is shown to every staff member on the Dashboard, with the amount and masked card number, not only to people with Billing access.
- **What to ask the builder for:** "Tidy-ups (TED-087): refuse to connect Cardknox without a webhookPin and return non-2xx while it's missing; store stripe_payment_intent_id on tip-retry link_tips rows; mark _sync_charge_to_ledger STABLE; retire or regenerate APPLY_BUNDLE.sql; show payment_unmatched notices only to Billing users."

### TED-076 🟡 (still open, narrowed) Two billing tests still only look for text
- `tests/charges_reach_the_ledger.test.js:80-89` still just matches source text: the "all five places that add a charge post it" test and the TED-062 "refuse zero and negative amounts" test. Everything else in TED-076 is fixed (see below).

## Re-check of last report's findings
| ID | Now | My proof |
|----|-----|----------|
| TED-063 parent Pay Now credited nobody | **Closed** | `probes/…-3/recheck_harness.test.js`: signed-in parent whose request names another family → `destination acct_CAMP / familyKey gold` (their own); office pay link → `gold`; no login + unknown family → 400, no Stripe call. Test file fails 4/5 on old code. |
| TED-064 ACH debited every night | **Closed** for plans with an id | Same probe, hold carried night to night: night 1 one debit and held; night 2 **0** new debits; night 3 "succeeded" → recorded 500, hold released; **1 debit total**. Idempotency-Key sent. Residuals: TED-078, TED-084 |
| TED-065 conversion double count | **Closed** | `probes/…-3/dup_recheck.js` (real conversion + today's catch-up, run twice): posted `[0, 0]`, balance **625** in JS and SQL. Residual for changed charges: TED-082 |
| TED-066 cancelled shop order stays billed | **Closed** for unconverted camps | My unchanged `probes/2026-09-24-billing/shop.js`: after cancel, ledger `le_chgadj_shop_o1_1 $40` credit, **balance 0.00**. pgtest 263 passes. Converted camps: TED-082; merge side effect: TED-081 |
| TED-067 close-out billed canteen money | **Closed** | My unchanged `closeout.js`: roll_forward now posts nothing (`charges` stays absent, 1 step applied). Test file fails 3/4 on old. Cash/donate call `canteen_office_cash_out` (code read, `campistry_me.js:2308-2323`, signature matches `migrations/240…sql:258-266`) |
| TED-068 office amounts ignored | **Closed** for autopay | My unchanged `plan.js`: $1000, $200, $200 and $300 + $300. pgtest 264 passes. Residuals: TED-079, TED-080 |
| TED-069 deposit charge with no login / twice | **Closed** | My unchanged `regdep.test.js`: no login → 403, 0 charges. Builder test: same request twice → 1 charge (fails on old). Residuals: TED-083, TED-085 |
| TED-070 Banquest deposit keys / gateway | **Closed** | Test file (5/6 fail on old): hosted page asks for `/generate-pay-link/slug1`; charge goes to the camp's `gatewayUrl`. Code read `:83-89`, `:451` |
| TED-071 Sola amount matching | **Closed** | My unchanged `ck.test.js`: an unknown `xInvoice` sale is no longer recorded; two open checkouts → not recorded, and the builder test checks an office notice is written. Test file fails 5/7 on old |
| TED-072 hosted return took newest txn | **Closed** | My unchanged `hosted.test.js`: another link's transaction → `pending`, nothing recorded |
| TED-073 tip retry wrong destination | **Closed** | Code read `charge-due-installments/index.ts:1069-1135`: full `tip_cents` to `item.stripe_account_id`, checks for an existing transfer first; runner tip tests fail on old. Small residual in TED-087 |
| TED-074 Link plan builder gone | **Closed** | `campistry_me.js:13176-13183`: Set Up button always shown; setting relabelled. Test `TED-074` passes |
| TED-075 auto-reload twice | **Closed** | `recheck_harness.test.js` with an insert-if-absent claim: two simultaneous triggers → **1** charge, key `camp1:reload:7:2026-09-24:0`. Residual: TED-085 |
| TED-076 loose ends | **Open (narrowed)** | Refund ≤ 0 now refused (test fails on old); deposit has `on_behalf_of` + key (test); plan edit keeps paused/collectionBlocked/pendingCharge (test). Two text-only tests remain |
| TED-005 auto-scheduler | Open, deferred | still 14 failing |

## What I checked on the four areas you asked about
- **Two writers on the same ledger (the database and the Me page):**
  - They use the same entry names (`le_chg_<id>`, then `le_chgadj_<id>_<n>`). Run one after the other, they don't double up: `shop.js` ends at 0, and the Me-page catch-up after a database cancel posts nothing more.
  - The real problems are:
    - the Me page overwriting whole family records from an old copy (TED-078);
    - neither writer seeing converted entries (TED-082);
    - the catch-up treating a merged family's moved entries as cancelled (TED-081).
- **Migrations 262–264, re-run:** `probes/…-3/rerun.js`, on a scratch database.
  - Applying each file twice more: the checking script says ok, ok, ok, and `settle_shop_order` calls the sync exactly once.
  - Then I put back 239's `settle_shop_order` and 172's `plan_due` and dropped `hold_autopay_charge`. The script flagged all three ("apply 262/263/264").
  - Re-applying the files brought it back to ok.
- **Claims and holds getting stuck:**
  - Deposit claims can stick (TED-083).
  - Canteen reload claims are per day, so a stuck one clears the next day.
  - The bank-debit hold waits forever when Stripe's answer is neither "succeeded" nor "failed" (e.g. the lookup keeps erroring). It also waits forever if the camp switches to Banquest/Cardknox while a debit is held: the runner then never asks Stripe (`:634`, `:859`). Nothing warns anyone about a hold older than a week. I've included that under TED-084's request as "fail loudly".
- **Webhooks refusing when a secret is missing:**
  - `stripe-webhook` and `stripe-connect-webhook` answer 500, so Stripe retries for up to 3 days. After that the payment events are lost, and a parent's Pay Now is never recorded.
  - `byop-dispute-webhook` answers 503 and `deposit-inbox` refuses. Both are older and weren't changed in this batch.
  - The Cardknox case is TED-087. These are all owner steps below.

## What I confirmed is working
- **Every test suite passes except the 14 known TED-005 failures.** The builder's counts are exact.
- **The builder's new tests test the fixes:** they fail on the pre-fix code (table above).
- **A parent's Pay Now** now credits the parent's own family, whatever the request says, and settles in the camp's account (`recheck_harness.test.js`).
- **Bank-debit autopay (plans with an id):** one debit per instalment across nights, recorded when it clears, and released when it fails. Every autopay charge carries an Idempotency-Key.
- **Refunds** refuse a zero or negative amount. The only caller always sends one (`campistry_me.js:18438`).
- **Browser caching:** `campistry_me.js?v=20260924-07`, `campistry_billing_core.js?v=20260924-01` and `dashboard.js?v=20260924-01` are each loaded in one place. The Link page is plain HTML, so it needs no number.
- **Migrations 262–264** can be re-run safely, and the checking script notices each one missing.

## What I did NOT check (and why)
- **Any real processor.** I never called Stripe, Banquest or Cardknox. TED-085 rests on Stripe's documented idempotency rules. I couldn't see how long real bank debits stay "processing", or whether Sola posts back API sales.
- **What is deployed:** which function versions and secrets are live, whether 262–264 have been run, how many families are on bank-account autopay, or how many still have the old single plan.
- **The Billing page, the parent portal and the registration form in a browser.** I checked those by running cut-out pieces of the real code.
- **Database security rules (RLS).** The test database runs as a superuser.
- **The rest of bank deposit matching** (the email parser and matcher, about 3,000 lines). I only followed what happens to a deposit once it has been matched (TED-077).
- **Payroll, tax statements, the POS register's own maths, Link photo purchases, and splitting a family.** Splitting a family could have the same charges-left-behind problem as the merge (TED-081). I didn't trace it.
- **Two office users at once in a real browser.** TED-078 is proven at the database level plus a code read of when the page refreshes.

## Things only you can check (click-by-click)
1. **Webhook secrets, again. With a secret missing, payment messages are refused, and after 3 days Stripe gives up on them.** Supabase Dashboard → your project → Edge Functions → Secrets. Confirm `STRIPE_WEBHOOK_SECRET` and `STRIPE_CONNECT_WEBHOOK_SECRET` are set (and `BYOP_DISPUTE_SECRET` and `RESEND_WEBHOOK_SECRET` if you use disputes or Zelle capture). Then go to Stripe Dashboard → Developers → Webhooks → each endpoint → "Recent deliveries". They should show 200.
2. **Zelle/ACH payments that never reached a family's balance (TED-077).** Supabase → SQL Editor → paste and Run (read-only):
   `select d.camp_id, d.family_key, d.amount_cents/100.0 as amount, d.deposit_date from bank_deposits d join camp_families f on f.camp_id = d.camp_id and f.family_key = d.family_key and f.deleted_at is null where d.status = 'posted' and jsonb_typeof(f.payload->'entries') = 'array' and jsonb_array_length(f.payload->'entries') > 0 and not exists (select 1 from jsonb_array_elements(f.payload->'entries') e where e->>'id' = 'le_dep_' || d.id::text or e->'source'->>'depositId' = d.id::text) order by d.deposit_date desc;`
   Every row is a payment the family made that their balance, and autopay, doesn't know about. **Until this is fixed, check these families before their next autopay date.**
3. **Deposits stuck as "already paid" (TED-083).** SQL Editor, read-only:
   `select camp_id, key, created_at from refund_intents where key like 'deposit:%' and settled_at is null and created_at < now() - interval '10 minutes';`
   Each row is an application whose deposit button now says "already paid" with nothing charged. Tell the builder before deleting anything.
4. **Until TED-081 is fixed, don't use Merge Families on families that have late fees, shop charges or other extra charges.**
5. **Until TED-078 is fixed, reload the Billing page (press F5) before editing a family** that pays autopay by bank account.
6. **Bank-account autopay (TED-084).** Stripe Dashboard → Payments → filter Payment method "ACH Direct Debit", Status "Processing". Several debits for one customer on consecutive days means that family is on the old plan shape.
7. **Cardknox camps (TED-087).** In the Sola portal → Settings → Gateway Settings → Webhook Settings, make sure every Sola camp has the PIN set and that it matches what was stored when the camp was connected.
