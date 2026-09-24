# Ted's report: billing, sixth pass (re-check TED-093 to TED-099, then a hunt), 2026-09-24

## Verdict: 🟡 Mostly good, some issues

I re-checked the 7 open billing findings from my fifth pass, re-ran all of those probes, and wrote 8 new ones. **All 7 are fixed, and I'm closing them with my own proof.** Card deposits are no longer counted twice, Stripe card deposits can be refunded from Billing, "Refund everyone" no longer refunds a child twice, and the big-camp slowdown is gone.

I found 6 new problems. None loses a parent's money. The two to fix first:
- **One fix opened a gap.** In one case the new refund rule lets a camp refund Campistry's own SMS fees to itself.
- **The year-end tax statement puts a December deposit in the wrong tax year.**

So billing is close, but not yet 100%. I did not change any code, only reported.

## The numbers
Tests run: 3,601 · Passed: 3,587 · Failed: 14 (real bugs: 14, all the deferred auto-scheduler failures TED-005 · out-of-date tests: 0 · my machine: 0)

- **Unit tests (`npm test`):**
  - 3,429 run, 3,415 passed, 14 failed.
  - All 14 failures are in `auto_full_day.test.js` (TED-005, deferred by you).
  - The builder reported 3,427 run and 3,413 passed. My run has 2 more tests, both passing. The same 14 fail.
- **Database tests (`npm run test:pg`):** 62 of 62 passed, against 121 migrations.
- **Other suites:** `test:keys` 42/42, `test:lite` 12/12, `test:smoke` 32/32, `test:scale` 24/24.
- **The builder's new tests, run against the code from before their fix** (a scratch copy, removed afterwards). Every file fails on the old code, so each one really tests its fix:

  | Test file | Failed on the old code |
  |---|---|
  | `refund_lost_answer` | 5 of 9 |
  | `deposits_reach_the_family` | 3 of 10 |
  | `refund_idempotency` | 1 of 14 |

- **My proof runs** are in `ted/probes/2026-09-24-billing-6/`:
  - all 9 fifth-pass probes again;
  - 8 new probes: 3 on a scratch database, 2 of real payment functions, 2 of the real Me-page code, and 1 of the tax-statement code.

## What's wrong (most serious first)

### TED-100 🟠 A camp can now refund Campistry's own SMS fees to itself
- **What a user would see:**
  - Nothing on screen. The risk is to your money.
  - The TED-096 fix lets Billing's refund accept any Stripe payment stamped with the camp's ID.
  - Campistry's own charges to a camp carry that same stamp: the $25 SMS number setup fee and the monthly SMS fee.
  - A camp's office that has one of those payment IDs can refund Campistry's fee to its own card. The money comes out of your Stripe balance.
  - The camp never sees these payment IDs in the app, so it would need to get one some other way. Until this pass, those payments were refused.
- **How sure I am:** Confirmed with the real `stripe-refund` function (Stripe itself was modelled).
- **Proof:**
  - `probes/…-6/platform_fee_refund.test.js`: a payment shaped exactly like the one `telnyx-charge-monthly-fees` makes (`metadata.campId` = the camp, purpose `telnyx_monthly_fee`, no transfer).
    - Today's code: HTTP 200, **1 refund sent to Stripe**, with no transfer reversal.
    - The code before the fix (25378b1, scratch worktree): **403**, 0 sent.
  - The cause is at `stripe-refund/index.ts:111`. The camp stamp alone now decides it.
  - Campistry's fee charges set that stamp at `telnyx-charge-monthly-fees/index.ts:99` and `telnyx-number-request/index.ts:146`.
- **What to ask the builder for:** "stripe-refund now refunds any PaymentIntent whose metadata.campId is the caller's camp, including Campistry's own SMS fees (telnyx-number-request, telnyx-charge-monthly-fees) — TED-100. Only accept the camp stamp for family-money payments (metadata.source such as registration_deposit/autopay, or a matching camp_payments/deposit row of this camp), refuse metadata.purpose telnyx_*, and add a harness test that a telnyx_monthly_fee payment is refused."

### TED-101 🟠 The tax statement puts a December deposit for next summer in the wrong year
- **What a user would see:**
  - A family enrolls in October 2025 for summer 2026. They pay a $500 deposit in December 2025 and the rest ($2,500) in spring 2026.
  - The 2025 tax statement tells them they can claim **$500** for 2025.
  - The 2026 statement shows only **$2,500**.
  - The statement's own rule (IRS Publication 503, quoted in the code) says all $3,000 belongs on the 2026 return, because that's when the camp happens.
  - A parent who files from these statements claims the deposit in the wrong year.
  - Where the deposit *is* caught as "paid ahead", it is left out of 2025 as it should be. But it then never appears on the 2026 statement either, so it is never claimed at all.
- **How sure I am:** Confirmed with the real tax-statement code. I'm not a tax adviser, so I'm judging it against the rule the code itself says it follows.
- **Proof:**
  - `probes/…-6/tax_prepaid.js`:
    - tuition charge dated at enrolment (2025-10-01), as Me dates it (`campistry_me.js:16403`, `enrolledDate`) → 2025 statement claimable **500**, 2026 statement claimable **2500**;
    - with no charge yet, the 2025 statement marks the $500 as prepaid, but the 2026 statement is still 2500.
  - The cause:
    - the module decides "paid ahead" only by whether a charge exists yet, not by the year the camp takes place (`campistry_tax_statement.js:250-276`);
    - an earlier year's payment only "moves the lots" and is never counted in the year it is used (`:253`).
  - `tests/tax_statement.test.js:89` checks only a deposit with no charge on the books at all.
- **What to ask the builder for:** "The tax statement assigns money by payment year and by whether a charge exists, not by the year the care is given (TED-101): a December deposit applied to next summer's tuition (dated at enrolment) is counted as this year's claimable care, and prepaid money never appears on the next year's statement. Date each tuition lot by its session's year (start date), count payments applied to a later year's lot as prepaid, and include prior-year prepayments on the statement for the year the care is given; add tests for enrolled-in-October + December deposit."

### TED-102 🟡 Card deposits linked to typed-in payments can't always be refunded to the card
- **What a user would see:**
  - **A typed payment with the card reference:** the office typed the deposit into Billing with the card reference in its Reference box. The fix correctly counts it once, but it is not marked as a card payment. Billing then won't offer to refund it to the card; the office has to use Offline Refund.
  - **Two children, $250 deposits each:** Billing asks both "already recorded by hand?" questions about the **same** typed payment.
    - After the first answer, the second child's deposit is added automatically, but the question stays on screen.
    - Answering "same money" to that leftover question moves the typed payment's link from the first child's charge to the second child's.
    - If the office had typed both deposits, the second typed payment is never linked, so that child's deposit can't be refunded to the card from Billing.
  - **The money is right in every case I ran:** each family is credited exactly once.
- **How sure I am:** Confirmed with the real Me-page code.
- **Proof:**
  - `probes/…-6/ref_link_refundable.test.js`: after the Billing load, the typed row has `depositReference` but no `stripePaymentIntentId`/`byopTransactionId`. `_famRefundableOnlineAll` (`campistry_me.js:18316`) needs one of those.
  - `probes/…-6/sibling_review.test.js`:
    - the questions are `pi_A→pay_h1` and `pi_B→pay_h1`;
    - after the answers, `pay_h1` carries `depositReference: pi_B` with `stripePaymentIntentId: pi_A`, and `pay_h2` is unlinked;
    - the balance is 1500 in all 3 cases (correct).
  - The cause:
    - the reference link sets only `depositReference` (`campistry_me.js:6362-6366`);
    - the look-alike search always picks the first match (`:6375-6380`);
    - `resolveDepositReview` doesn't check whether the payment is already linked (`:6419-6422`).
  - The builder's test for this screen only checks that the text exists in the file.
- **What to ask the builder for:** "TED-102: when a typed payment is linked by its reference, also set stripePaymentIntentId/byopTransactionId (and byopProcessor) like resolveDepositReview does; in the look-alike search skip payments another open question already points at; in resolveDepositReview re-check the payment is still unlinked (and drop the question if the deposit was posted meanwhile); add a real test of resolveDepositReview with two siblings."

### TED-103 🟡 While the "already recorded by hand?" question is unanswered, the deposit counts as unpaid
- **What a user would see:**
  - The family paid a $250 card deposit. They also paid a *different* $250 (for example a cheque) within 45 days.
  - Billing holds back the card deposit and asks the office. Until someone answers:
    - the family's balance is $250 too high, on the office's screen and on the parent's Link page;
    - autopay collects the next instalments against that higher balance.
  - The question only shows as a small line on the family's Billing row. There is no notification.
- **How sure I am:** Confirmed for the balance. Autopay is from reading the code: it charges from the ledger balance, as in my earlier passes.
- **Proof:**
  - The builder's own test `deposits_reach_the_family.test.js` ("Billing asks") shows it: the balance is 750 until the office says "different", then 500.
  - The deposit is not posted while the question is open (`campistry_me.js:6381-6388`, `return` before posting).
- **What to ask the builder for:** "TED-103: while a depositReview question is open, the card deposit is not on the ledger, so the parent sees it owed and autopay can collect it. Raise a Billing notification when a question is created, and hold autopay for that family (or post the deposit and put the question on the typed payment instead) until it is answered."

### TED-104 🟡 The check script says 270 and 271 are "ok" on the fifth-pass copies
- **What a user would see:**
  - If you pasted 255–272 last time, the check script still says "ok" for 270 and 271 even if you don't paste them again.
  - But those copies lack three of this round's fixes:
    - "Payment plan set up" shown only to Billing staff (TED-094);
    - a stale office tab can't make a deposit look unpaid (TED-098);
    - the big-camp slowdown (TED-099).
  - The same kind of problem as TED-039 and TED-048.
- **How sure I am:** Confirmed on a scratch database.
- **Proof:** `probes/…-6/old_270_271_verify.js`. With 25378b1's 270 and 271 on top of today's chain, the script says **270 ok, 271 ok**, and `is_money_notice('autopay_setup')` = **false**.
- **What to ask the builder for:** "verify_identity_chain.sql's 270 and 271 rows pass on the 25378b1 copies (TED-104): have 270 check is_money_notice('autopay_setup') and 271 check that _ledger_started_catch_up calls _catch_up_family_ledger and _deposit_charges_union exists; add those to the pgtests."

### TED-105 🟡 A canteen refund whose answer is lost after it finished is sent again if the office presses Refund again
- **What a user would see:**
  - The office refunds $20 of a child's canteen money. The refund goes through, but the page never gets the answer (for example the Wi-Fi drops), so it shows an error.
  - The office presses Refund again, and a second $20 goes back to the card.
  - The books stay honest: the wallet shows both refunds. But the parent gets $40 when the office meant $20.
  - Until this round, a Stripe camp was protected from this for 24 hours. The TED-097 fix removed that protection, and Cardknox/Banquest camps never had it.
- **How sure I am:** Likely. The server can't tell a retry from a deliberate second refund, because the page sends nothing that marks a retry.
- **Proof:**
  - `probes/…-5/canteen_second_refund.test.js` at HEAD: two identical requests → `re_1` then **`re_2`**. That is right for a deliberate second refund, and it is the same thing the server sees for a retry.
  - Snacks sends `{camperName, camperId, amount}` and no key (`campistry_snacks.js:1941`). `payments-canteen-refund` ignores any key (`index.ts:269`, `void idempotencyKey`).
- **What to ask the builder for:** "TED-105: Snacks' single canteen refund sends no per-click key, so a retry after a lost answer is a second refund (Stripe lost its pi+amount protection with TED-097). Make Snacks create a key when the refund modal opens and reuse it on retry, and have both canteen refund functions claim on it before the remaining-based key."

## Re-check of last report's findings
| ID | Now | My proof |
|----|-----|----------|
| TED-095 deposit typed by hand counted twice | **Closed** | Unchanged `deposit_twice.test.js`: balance stays **750** with a reference and without one, 1 payment row each (was 500, 2 rows). Loose ends: TED-102, TED-103 |
| TED-096 Stripe deposit not refundable (403) | **Closed** | Unchanged `deposit_refund.test.js`: all 3 cases **HTTP 200, 1 refund** (was 403 for 2 of 3). Side effect: TED-100 |
| TED-093 Refund everyone refunded twice | **Closed** | Unchanged `refund_all_lost.test.js` (body `{}`, as Snacks sends): run 2 → "never confirmed", **1** refund reached Cardknox (was 2). pgtest 273: a claim seconds old isn't released, one 4 minutes old is, a settled one never. Code read: payments-refund and payments-canteen-refund call `release_stale_refund_intent` and answer "may still be going through" otherwise |
| TED-097 2nd same-amount Stripe canteen refund sent nothing | **Closed** | Unchanged `canteen_second_refund.test.js`: keys `…_5000_2000` then `…_3000_2000`, refunds `re_1` then **`re_2`**. Side effect: TED-105 |
| TED-098 stale tab made deposit owed again | **Closed** | Unchanged `regdep_cycle.js` step 5: owed **0** after the stale save (was 250); a 2nd charge leaves `depositCharges` = [9001, 9002] (was [9002]) and paid 500 |
| TED-099 ledger start slow at scale | **Closed** | Unchanged `ledger_start_scale.js`: 600 families **592 ms** (was 3,012), 1,000 **1,280 ms** (was 7,561), every payment posted once. 2,500 families: 5,308 ms (1,202 without the trigger). Code read: `_catch_up_family_ledger` does the same checks as `sync_family_ledger_payments` for one family |
| TED-094 autopay_setup visible to all staff | **Closed** | `is_money_notice` lists it (270:36); pgtest 270 has an autopay_setup row that a scheduler can't see; I found no other notice kind missing from the list (all 8 database and 5 function writers checked). Check-script gap: TED-104 |
| TED-005 auto-scheduler | Open, deferred | still 14 failing, not re-investigated |

## What I confirmed is working
- **Every test suite passes except the 14 deferred TED-005 failures.**
- **Migrations 255–273, pasted twice each in order:** all 19 check-script rows say "ok". Pasting 273 and then 271 again keeps the new one-family catch-up (`rerun_255_273.js`).
- **Fifth-pass probes still hold:**
  - the parent and the office see the same balance at every step (`parent_live.js`: 1000 → 1040 → 1000 → 600 → 300 → 300 → 350);
  - re-running 266 or 269 alone keeps 272's fix, and 271's catch-up doesn't post twice (`rerun.js`).
- **If 273 isn't pasted before the functions are redeployed,** a refund can't be retried after "nothing went through". It fails safe: no second refund is sent. I found this by reading the code; it's what the script's 273 row warns about.
- **Browser caching:** `campistry_me.js?v=20260924-15` is on `campistry_me.html:343`, the only page that loads it. Snacks and the tax module didn't change.

## What I did NOT check (and why)
- **Any real processor.** I never called Stripe, Cardknox or Banquest. TED-100 depends on Stripe accepting a refund of a platform payment from our key. That's normal Stripe behaviour, but I modelled it.
- **What is deployed:** which migrations are pasted, which function versions are live, and which page version the office computers run.
- **Anything in a real browser.** In particular, I didn't see the "already recorded by hand?" line or its two dialogs on screen. I ran the real code behind them.
- **Database security rules (RLS) as a real counsellor.** The test database runs as a superuser. Only the pgtests' role checks cover that.
- **Tax law.** TED-101 is judged against the rule the statement quotes. Please have your accountant confirm which year a December deposit belongs to.
- **Areas still never deep-audited:** payroll, POS register maths, Link photo purchases, splitting a family, and the bank-email parser/matcher. I read the tax statement for the first time this pass, but only its year and prepaid logic.

## Things only you can check (click-by-click)
1. **Owner steps from the builder (still pending):**
   - Supabase → SQL Editor → paste migrations 255–273 **in order**, each one → Run.
   - Paste **270 and 271 again even if you pasted them last time.** The check script can't tell the old copies apart (TED-104).
   - Run `scripts/verify_identity_chain.sql` and check that every row says "ok".
   - Apply 268, 269, 271 and 273 before redeploying.
   - Supabase Dashboard → Edge Functions → Deploy each of these:
     - `registration-deposit-checkout`
     - `charge-due-installments`
     - `canteen-auto-reload`
     - `cardknox-webhook`
     - `admin-connect-processor`
     - `stripe-connect-webhook`
     - `payments-refund`
     - `payments-canteen-refund`
     - `payments-canteen-refund-all`
     - `stripe-refund`
     - `stripe-canteen-refund`
     - `stripe-canteen-refund-all`
   - Reload the office computers.
2. **Before redeploying `stripe-refund` (TED-100):** consider waiting for that fix. Meanwhile, Stripe Dashboard → Payments: look for refunds on "Campistry SMS number" payments you didn't make.
3. **After the office computers reload (TED-103):**
   - Me → Billing: look for any family showing "Card deposit $X — already recorded by hand?".
   - Click it. Answer "Same money" only if the typed payment really was that card deposit.
   - Until you answer, that family's parent sees the deposit as still owed.
4. **Tax statements (TED-101):** until fixed, don't send year-end statements to families who paid a deposit in December for the next summer without checking the year yourself. Ask your accountant which year the deposit belongs to.
5. **Snacks refunds (TED-105):** if a refund shows an error, reload Snacks and check the child's wallet before pressing Refund again. If the wallet already dropped, the refund went through.
