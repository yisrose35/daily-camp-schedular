# Ted's report: billing, seventh pass (re-check TED-100 to TED-105, then a hunt), 2026-09-24

## Verdict: 🟡 Mostly good, some issues

I re-checked the 6 open billing findings from my sixth pass with my own probes, re-ran the sixth-pass probes, and wrote 8 new ones. **3 are fully fixed and 1 is fixed with a loose end; I'm closing those 4.** Camps can no longer refund Campistry's SMS fees. Typed-in card deposits are now refundable to the card. Autopay waits while a deposit question is open. The check script now spots old copies of 268, 270, 271 and 272.

**Two fixes are not complete, and I found three new problems.** The one to fix first:
- **Canteen refunds can still go out twice.** The TED-105 fix only works when the child topped up once, on Stripe. With two top-ups, pressing Refund again after a lost answer still sends a second refund, on both Stripe and Cardknox/Banquest.

Billing is close, but not yet 100%. I did not change any code, only reported.

## The numbers
Tests run: 3,612 · Passed: 3,598 · Failed: 14 (real bugs: 14, all the deferred auto-scheduler failures TED-005 · out-of-date tests: 0 · my machine: 0)

- **Unit tests (`npm test`):**
  - 3,440 run, 3,426 passed, 14 failed.
  - All 14 failures are in `auto_full_day.test.js` (TED-005, deferred by you).
  - This matches the builder's figures exactly.
- **Database tests (`npm run test:pg`):** 62 of 62 passed, against 121 migrations.
- **Other suites:** `test:keys` 42/42, `test:lite` 12/12, `test:smoke` 32/32, `test:scale` 24/24.
- **The builder's changed test files, run against the code from before their fix** (3390aba, a scratch copy outside the project, removed afterwards). Every file fails on the old code and passes now, so each one really tests its fix:

  | Test file | Failed on the old code |
  |---|---|
  | `autopay_runner` | 1 of 19 |
  | `deposits_reach_the_family` | 9 of 13 |
  | `refund_idempotency` | 1 of 14 |
  | `refund_lost_answer` | 3 of 12 |
  | `tax_statement` | 3 of 33 |

- **But two of the new tests only check that some text exists in a file:**
  - the Me-page care-year test (`tax_statement`);
  - the Snacks refund-key test (`refund_lost_answer`).
- **My proof runs** are in `ted/probes/2026-09-24-billing-7/`:
  - all sixth-pass probes again (two Me-page probes copied and updated to load the new helper `_markCardPayment`);
  - 8 new probes: 3 on a scratch database, 2 of real payment functions, 3 of real Me-page or tax code.

## What's wrong (most serious first)

### TED-105 🟠 (still open) A canteen refund retried after a lost answer is still sent twice when the child topped up more than once
- **What a user would see:**
  - The office refunds $20 of a child's canteen money. The refund goes through, but the page never gets the answer, so it shows an error. The office presses Refund again.
  - **Stripe, child topped up once:** fixed. The second press gets the same refund back.
  - **Cardknox/Banquest, child topped up twice ($50 + $50):** a second $20 goes to the parent's card.
  - **Either processor, when the $20 spans two top-ups ($10 + $50):** a second $20 goes to the parent's card.
  - **Cardknox/Banquest, child topped up once:** no second refund, but the office is told **"Refund failed."** even though the money went back. An office that believes that message may then refund by hand, which pays the parent twice.
  - The books stay honest (the wallet shows every refund), but the parent gets $40 when the office meant $20.
- **How sure I am:** Confirmed with the real `stripe-canteen-refund` and `payments-canteen-refund` (card companies modelled; Stripe replays a repeated key, as it does).
- **Proof:**
  - `probes/…-7/canteen_retry_two_topups.test.js`, same key sent twice, as Snacks now does:

    | Top-ups | Stripe | Cardknox |
    |---|---|---|
    | one: $50 | 1 refund | 1 refund, but the second answer is 500 "Refund failed." |
    | two: $50, $50 | 1 refund | **2 refunds** (X1 $20, X2 $20) |
    | small: $10, $50 | **3 refunds** (pi_top1 $10, pi_top2 $10, pi_top2 $20) | **3 refunds**, same shape |

  - Cause 1: each slice's key includes the amount taken from that top-up. After the first refund is recorded, a used-up top-up drops out of the list, so the retry splits the $20 differently and gets new keys (`stripe-canteen-refund/index.ts:230-232`, `payments-canteen-refund/index.ts:272-275`).
  - Cause 2 (Cardknox/Banquest): a slice found "already settled" is skipped with `continue` without counting it as refunded. The loop then moves on to the next top-up and refunds the same $20 there. If there is no next top-up, the total is 0 and the office sees "Refund failed." (`payments-canteen-refund/index.ts:283-286`, `:351-354`).
  - The builder's behavioural test has only one top-up, on Stripe. The Snacks part of the test only checks that the text is in the file.
- **What to ask the builder for:** "TED-105 is still open: with the page's refund key, key each claim on the key alone (e.g. canteen:<key>:<n> for the n-th slice of the ORIGINAL request, stored with its deposit and amount on the claim), and on a retry replay the settled slices from the claims instead of re-splitting against today's remaining; count a skipped settled slice toward the amount and report it as refunded (never 'Refund failed'); add harness tests with two top-ups ($50+$50 and $10+$50) on both stripe-canteen-refund and payments-canteen-refund."

### TED-106 🟠 After the office answers the card-deposit question, autopay stays stopped for days, and the office is told the card is dead
- **What a user would see:**
  - The deposit question is open (new in this round: autopay waits for it, as asked). Each night autopay flags the family's plan.
  - The flag goes through the **card-decline** machinery. Each night counts as another "failed attempt" with a longer retry delay (3, then 5, 7 and 14 days).
  - **On the third night the office gets:** "This card is not going to start working — 3 attempts have now failed… nothing will be collected until someone contacts the family for a new card." Nothing is wrong with the card.
  - **Answering the question does not clear the flag.** Autopay keeps skipping the family until the retry date, up to 14 days later. The instalments due in that time are not collected, though they would be collected later.
  - Meanwhile Billing still reads "Not collecting — Autopay waiting — answer the card deposit question ×3 · retries 2026-10-01" after the question is gone, and there is no button to clear it.
  - **The notice wording doesn't reach your database.** If you pasted 269 before, re-pasting it (as the steps say) does not add the new "waiting for you to answer a question" wording. The notice then reads "Gold — deposit_review. a card deposit…". The check script's 269 row can't see this.
- **How sure I am:** Confirmed with the real database function and the real autopay program.
- **Proof:**
  - `probes/…-7/deposit_review_flag.js` (scratch DB, real `flag_plan_collection`, 3 nights):
    - attempts 1 → 2 → 3, retry dates 09-27 → 09-29 → 10-01, `escalated: true`;
    - both notifications printed, including the "new card" escalation;
    - after the office saves with the question gone: `depositReview = []`, but `collectionBlocked` is still `deposit_review`, retry 10-01. The page's copy can't clear it, because the server's flag wins (269 `_merge_plan_state`).
  - `probes/…-7/after_answer_night.test.js` (real `charge-due-installments`):
    - no flag: 1 charge;
    - question answered, last night's flag left: **0 charges**, result `waiting_to_retry`, reason `deposit_review`.
  - Same probe, part 2: 3390aba's 269, then today's 269 pasted again → "knows deposit_review?" **false** both times. The patch block returns early when 269 was pasted before (`269:136-139`).
- **What to ask the builder for:** "TED-106: the deposit_review hold rides the decline/dunning path. Don't count it as an attempt or set nextRetryAt/escalate for it (flag without backoff, or a separate hold field). Clear it the first night the question is gone (the runner can flagPlan(null) when depositReview is empty and the block's reason is deposit_review), or clear it from resolveDepositReview. Make re-pasting 269 add the new wording (or put it in a new migration), add a check-script row for it, and add a runner test for 'question answered → charged the same night'."

### TED-107 🟠 Tax statement: a family whose camp was cancelled and fully refunded is told $500 is claimable
- **What a user would see:**
  - A family pays a $500 deposit in December 2025 for summer 2026, then cancels in March 2026 and gets the $500 back.
  - The 2026 statement says **$500 claimable** for care that was never given and money they got back.
  - The same statement also warns "Refunds in 2026 exceed payments in 2026… Nothing is claimable for 2026." The numbers and the warning contradict each other.
  - This is new with the TED-101 fix. Money paid in an earlier year is now added to the next year *after* that year's refunds are taken off, so a refund of that money is never subtracted from it.
- **How sure I am:** Confirmed with the real tax code and Me's real care-year lookup. I'm not a tax adviser; judged against the rule the statement itself quotes.
- **Proof:**
  - `probes/…-7/tax_care_year.js` case C: 2026 → `claimable 500 | paidEarlier 500 | paid.net -500`, with 2 warnings.
  - The cause is the carried block at `campistry_tax_statement.js:332-355`, which runs after the refund proration at `:309-330`.
- **What to ask the builder for:** "TED-107: money carried from an earlier year into its care year is never reduced by refunds. Deposit paid Dec 2025, cancelled and refunded Mar 2026 → the 2026 statement says 500 claimable. Take this year's refunds off the carried amount too (or apply a refund against the lots it was paid into), and add that case to tax_statement.test.js."

### TED-101 🟡 (narrowed, still open) The December-deposit tax-year fix only works when the session has dates
- **What a user would see:**
  - **With the session's start date filled in:** fixed. 2025 shows $0 claimable ($500 prepaid); 2026 shows the full $3,000.
  - **If the session has no dates** (allowed; much of the app treats undated sessions as "always open"): the statement still puts next summer's December deposit on the 2025 return.
  - **The printed totals don't add up.** When earlier-year money is included:
    - the child's row shows "Total paid" $3,000;
    - the bottom "Total paid" shows $2,500 (only this year's payments).
    - The warning explains it, but the table doesn't.
- **How sure I am:** Confirmed with the real code.
- **Proof:**
  - `probes/…-7/tax_care_year.js`: Me's care year is "2026" for a dated session and **""** for an undated one.
  - Case B (undated): 2025 claimable **500**, 2026 **2500**.
  - Case A (dated): 2025 0 (prepaid 500), 2026 3000, child-row total 3000 vs `paid.net` 2500.
  - Arrears (D) and a partial refund (E) are correct: 2000/1000 and 2750.
- **What to ask the builder for:** "TED-101 residue: when a session has no startDate, fall back to something better than the enrolment date (e.g. the session/enrolment season year, or warn on the statement that the care year is unknown), and make the printed Total row consistent with the child rows when earlier-year money is included."

### TED-108 🟡 Record Payment accepts a minus sign and books it as a refund
- **What a user would see:**
  - In Billing → Record Payment, the office types "-500" by mistake.
  - It says "Payment of $-500.00 recorded for Gold" and books a **$500 refund** that never happened. The family's balance jumps from $1,000 to $1,500, and the parent sees that in Link.
  - Add Credit refuses this since TED-062. Record Payment was missed.
- **How sure I am:** Confirmed with the real Record Payment code.
- **Proof:**
  - `probes/…-7/negative_payment.test.js`: payment rows `[-500]`, ledger entry `{kind: refund, amount: 500}`, balance 1000 → 1500.
  - The cause: the only check is `if(!amt)` (`campistry_me.js:18193`, and the older Finance form at `:16042`); `_postPaymentEntry` files a negative amount as a refund (`:6283`).
- **What to ask the builder for:** "TED-108: Record Payment (openPaymentForFamily and finAddPayment) accepts a negative amount and posts it as a refund. Refuse amount ≤ 0 in both, like Add Credit does since TED-062, with a test that runs the real save."

## Re-check of last report's findings
| ID | Now | My proof |
|----|-----|----------|
| TED-100 camp could refund Campistry's SMS fees | **Closed** | Unchanged `probes/…-6/platform_fee_refund.test.js`: **HTTP 403, 0 refunds** (was 200, 1 refund). I checked every Stripe payment creator: all 3 SMS-fee chargers stamp `purpose: telnyx_*`. Registration deposits (direct and hosted) stamp `source: registration_deposit`. Link Pay Now has no customer and still passes on the camp stamp. Every charge path uses the family's main customer, which is only set when empty. So the narrower rule strands no family payment |
| TED-102 typed deposit not card-refundable; sibling questions | **Closed** | `probes/…-7/ref_link_refundable.test.js`: reference link → `stripePaymentIntentId: pi_dep`; new Cardknox case → `byopTransactionId` + `byopProcessor: cardknox`; balance 750 in all 3. `probes/…-7/sibling_review.test.js`: questions `pi_A→pay_h1`, `pi_B→pay_h2` (was both →pay_h1); each typed payment linked to its own card charge; balance 1500 in all 3 cases; no questions left |
| TED-103 deposit question open → autopay collects | **Closed** (loose ends in TED-106) | `after_answer_night` control + builder's runner test (fails on old code): result `waiting_for_deposit_review`, 0 charges; `deposit_review_flag.js`: the office gets an "Autopay cannot collect" notice naming the deposit question |
| TED-104 check script passed old 270/271 | **Closed** | Unchanged `probes/…-6/old_270_271_verify.js`: now **"apply 270" / "apply 271"** (was ok/ok). `probes/…-7/old_268_272_verify.js`: 4a59637's 268 → "apply 268", 4a08579's 272 → "apply 272"; after re-pasting today's copies, and on a fresh chain, all 19 rows 255–273 say ok |
| TED-105 canteen retry refunds twice | **Open**, raised to 🟠 | See above: fixed only for one Stripe top-up |
| TED-101 tax year of a December deposit | **Open**, narrowed to 🟡 | Fixed for dated sessions; undated sessions and the totals row remain (above). New side effect: TED-107 |
| TED-005 auto-scheduler | Open, deferred | still 14 failing, not re-investigated |

## What I confirmed is working
- **Every test suite passes except the 14 deferred TED-005 failures.**
- **Each of the builder's 5 changed test files fails on the old code** (table above).
- **Tax statement, dated session:** December deposit → 2025 $0 claimable, $500 prepaid; 2026 $3,000 claimable. Arrears count in the year paid. A partial refund comes off correctly (2750). Proof: `tax_care_year.js` A, D, E.
- **Refunds to card can't exceed what was paid online.** Code read of `campistry_me.js:18559-18570`: amount ≤ 0 is refused, and anything above the online total is refused with "use Offline Refund for the rest".
- **Browser caching:**
  - `campistry_me.js?v=20260924-16` and `campistry_tax_statement.js?v=20260924-01` are on `campistry_me.html:343` and `:243`;
  - `campistry_snacks.js?v=20260924-02` is on `campistry_snacks.html:579`;
  - every changed page file was bumped.
- **Parents don't see plan flags:** no Link or parent page reads `collectionBlocked` (search of all pages).

## What I did NOT check (and why)
- **Any real processor.** I never called Stripe, Cardknox or Banquest. Stripe's replay of a repeated key, and Cardknox's refund answers, are modelled.
- **What is deployed:** which migrations are pasted, which function versions are live, and which page version the office computers run.
- **Anything in a real browser.** Specifically:
  - the deposit question and its dialogs;
  - the Billing flag label;
  - the Snacks refund button (I ran the real code behind them).
- **Database security rules (RLS) as a real staff member.** The scratch database runs as a superuser.
- **Tax law.** Please have your accountant confirm which year a December deposit belongs to, and how a refunded deposit should appear.
- **Areas still never deep-audited:** payroll, POS register maths, Link photo purchases, splitting a family, and the bank-email parser/matcher.

## Things only you can check (click-by-click)
1. **Owner steps from the builder (still pending):**
   - Supabase → SQL Editor → paste migrations 255–273 **in order**, each one → Run.
   - Re-paste 268, 269, 270, 271 and 272 even if you pasted them before.
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
2. **Before redeploying `charge-due-installments` (TED-106):**
   - Once it's live, answer any "Card deposit $X — already recorded by hand?" question in Me → Billing the same day you see it.
   - If a family then shows "Autopay waiting — answer the card deposit question" after you've answered, autopay for that family resumes only on the "retries" date shown. Collect by hand meanwhile if a payment is due.
   - Ignore a "This card is not going to start working" notice for a family that has a deposit question.
3. **Snacks refunds (TED-105):** if a refund shows an error or "Refund failed", **don't press Refund again**. Reload Snacks and look at the child's wallet. If it already dropped, the refund went through. Check the Cardknox/Banquest or Stripe dashboard before doing anything else.
4. **Tax statements (TED-101/107):**
   - Before printing year-end statements, make sure every session has a start date: Me → Sessions → edit each session → Start date.
   - Don't send a statement to a family whose deposit was refunded after a cancellation until TED-107 is fixed.
5. **Record Payment (TED-108):** check the amount has no minus sign before saving. A negative amount shows as "Payment of $-…" in the confirmation.
