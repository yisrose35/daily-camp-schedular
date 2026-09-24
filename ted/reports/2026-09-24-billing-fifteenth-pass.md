# Ted's report: billing, fifteenth pass (re-check TED-142 to TED-151, then a hunt), 2026-09-24

## Verdict: 🟡 Mostly good, some issues

**Can you be 100% certain billing is right? Not yet, but it is much closer.**

**Nine of the ten fixes I re-checked work, and I'm closing them:** TED-142, 144, 145, 146, 147, 148, 149, 150 and 151. I proved each one myself, on the real pages in a real browser, with the real functions and a real database.
- **The season close-out now takes a child's whole canteen balance.** The $20-a-day limit and the parent's floor no longer block it.
- **A bank debit that is still processing now shows as "on its way"**, on every office computer. Nobody can start a second one, not from another computer and not from Batch charge.
- **The card surcharge now comes back per payment.** Partial refunds add up to exactly the fee, and the preview matches the result.
- **A refund that fails later now puts its surcharge share back on the bill**, and only once.
- **Registration's "Charge now" tells the office the real reason** when it refuses.
- **The platform's failed-refund email is sent again** if the email service was down.

**One fix is only partly done (TED-143, auto-reload).**
- After the season it now stops.
- But once you enter **next** summer's sessions, a parent's weekly reload starts charging again right away, months before camp.
- A camp with no session dates is never stopped at all.

**I found five new problems, none of them serious.**
- **Two middle-sized ones:**
  - The season close-out is counted as canteen **sales** in Snacks.
  - The "discount for not paying by card" setting is promised to parents, but it is never given.
- **Three small ones** (listed below).

I did not change any code. I only reported.

## The numbers
Tests run: 3,839 · Passed: 3,825 · Failed: 14 (real bugs: 14, all of them the deferred auto-scheduler tests, TED-005 · out-of-date tests: 0 · my machine: 0)

| Suite | Run | Passed | Failed |
|---|---|---|---|
| Unit tests (`npm test`) | 3,626 | 3,612 | 14, all in `auto_full_day.test.js` (TED-005, deferred by you) |
| Database tests (`npm run test:pg`) | 69, against 128 migrations | 69 | 0 |
| `test:keys` | 42 | 42 | 0 |
| `test:lite` | 12 | 12 | 0 |
| `test:smoke` | 32 + 34 (the Snacks browser test) | 66 | 0 |
| `test:scale` | 24 | 24 | 0 |

These match the builder's figures exactly (claim 11).

**The builder's new and changed tests, run against the code from before the fixes** (`114a60b`, in a scratch copy outside the project, removed afterwards; logs `oldcode_*.log`):

| Test file | Failures on the old code |
|---|---|
| `ach_on_its_way` | 10 of 15 |
| `canteen_autoreload_season` | 4 of 5 |
| `deposit_charge_error_text` | all 6 |
| `card_surcharge_billing` | all 13 |
| `stripe_refund_failed` | 6 |
| `batch_charge_counts_failures` | all 3 |
| `camper_identity_ledger` | 2 |
| `card_fees` | 1 |
| `closeout_canteen_and_rollforward` | 1 |
| `office_charge_retry` | 1 |

- So the new tests do test the new behaviour (claim 11).
- Three changed test files pass on the old code too. Their changes only teach the old tests about the new calls; I read them and nothing was loosened.

**Mutation checks** (`mutations.log`): I broke parts of today's migrations on purpose and re-ran their database tests.
- **Caught** (the test fails as it should):
  - 280 without switching auto-reload off;
  - 280 allowed to take more than the balance;
  - 281 undoing the same surcharge twice;
  - 281's "give the alert claim back" doing nothing;
  - the check script without its TED-151 row.
- **Not caught:** if 281 undid *every* surcharge credit instead of only the failed refund's own one, its test would still pass, because the test has only one credit. The code itself is right; the test just can't tell.
- Unchanged, all three tests pass.

**Every earlier billing probe, re-run at today's code:** 105 probe files from passes 1 to 14 (`rerun_all_probes.sh`, outputs in `rerun/`).
- **91 ran cleanly.**
- **14 stopped early.**
  - 13 are the same 13 as last pass.
  - The 14th is my 11th-pass "charge the same card twice" probe. It copies the page's Charge Card code and didn't copy the new "on its way" helpers. A corrected copy (`charge_card_same_or_new15`) gives the same results as last pass.
- **Of the 105 outputs** (ids and times masked), 88 are identical to last pass. The 17 that differ are all explained:
  - **8 are expected changes:**
    - the auto-reload fix;
    - the failed alert email now answered 500 (the email goes on the next delivery);
    - the check script now flags an earlier 275;
    - the new Take Out Cash wording (2 probes);
    - the new close-out function in the list of money functions a browser can call (now 98, gated to Billing editors);
    - my 9th-pass charge probe: its pretend Stripe can't answer the new "anything still processing?" question, so stripe-charge safely charges nothing;
    - a stack-trace line number.
  - **4 are timings or ordering only**, with the same answers.
  - **5 are my older probes missing the new wiring:** the failed-alert claim wasn't connected to the database, or the new helpers weren't copied. Corrected copies (`refund_failed_realdb15`, `charge_card_same_or_new15`, and for the browser `billing_refund_again15`) give the same results as last pass: one platform email per failed refund.
- **The four earlier Snacks browser probes:** identical.

**New probes this pass** (`ted/probes/2026-09-24-billing-15/`):
- 6 browser probes on the real pages;
- 7 on real functions or real SQL;
- 1 on the check script;
- corrected copies of 4 earlier ones.

## What's wrong (most serious first)

### TED-143 🟠 (still open, partly fixed; was 🔴) Auto-reload starts charging again as soon as next summer's sessions are entered
- **What's fixed:** after the season it stops.
  - The day after the camp's last session, the job charges nobody.
  - Refund All and a child's own Refund (Stripe and Sola) switch off the auto-reload of each child whose wallet they empty. A partial refund leaves it on, as claimed.
  - The office's new switch (Snacks → Settings → Parents' auto-reload → Off) stops every charge.
- **What a user would see now, problem 1 (pre-season):**
  - Bea's parent chose "every Thursday, add $25" last summer and left the dates blank.
  - Bea spent her wallet down to $0, so Refund All had nothing to refund and switched nothing off.
  - In spring the owner enters next summer's sessions. From that moment, the job treats the camp as "in season".
  - **Bea's parent is charged $25 every Thursday**, months before camp starts.
  - A child on "below $5, add $20" is charged $20 once.
  - The office's switch prevents it, but only if it was switched Off last summer and left Off until camp starts.
- **Problem 2 (no dates):**
  - A camp that never entered sessions still has an auto-reload that never stops (unless the switch is used).
  - Meanwhile the Link form now tells every parent "the camp stops it after the season either way".
- **Problem 3 (the guide):** the new end-of-season section says "Dashboard → Camp dates → set the end date". There is no such control any more: the end date comes from the last session's end date (Dashboard → Dates & Pricing).
- **How sure I am:** Confirmed, with the real auto-reload job and a real database.
- **Proof:**
  - `autoreload_dates15.log`:
    - D1 (season ended yesterday): `skipped_season_over`, no charge;
    - **D2 (next summer's dates entered): `Bea schedule $25 → charged` in each of 4 weekly runs, `Avi threshold $20 → charged` once**; wallets Avi $20, Bea $100;
    - D3 (no dates): charged;
    - D4 (switch Off): `skipped_switched_off_by_camp`;
    - D5 (control, in season): both charged.
  - `rerun14_autoreload_after_season.log`: A2/A4 now 0 charges (fixed); A5 (weekly, no dates) still charged 3 weeks running.
  - Code:
    - `supabase/functions/canteen-auto-reload/index.ts:442` (only `today > endDate` is checked, never the start);
    - `CANTEEN_AUTORELOAD_SETUP.md:144`;
    - `dashboard.html:540` ("There is no separate … Camp Dates step any more");
    - `campistry_link_parent.html:460`.
- **What to ask the builder for:** "TED-143 (continued): canteen-auto-reload skips a camp only after campDates.endDate, so once next summer's sessions are entered (campDates in the future) every parent whose auto-reload wasn't switched off is charged again — a weekly reload every week from spring. Also skip camps before campDates.startDate; decide what a camp with no dates should do and make Link's 'the camp stops it after the season either way' true; and fix CANTEEN_AUTORELOAD_SETUP.md's 'Dashboard → Camp dates' step (it is the last session's end date under Dashboard → Dates & Pricing)."

### TED-152 🟠 The season close-out is counted as canteen sales
- **What a user would see:**
  - Avi bought a $3 snack today and took $10 cash from the till.
  - Snacks shows "Sales today $3" and "Revenue $3.00". Correct.
  - Then the office closes the Katz family out and hands back Avi's remaining $37.
  - **Snacks now shows "Sales today $40", "Revenue $40.00", 2 transactions averaging $20, and $40 on the weekly chart.**
  - The close-out line is labelled **"Purchase"**.
  - At the end of the season, every child closed out is added to the canteen's sales: 200 children × $30 is $6,000 of "sales" that never happened.
- **Why:**
  - Before this fix the close-out went through the till's cash-out, which is marked `cash_out`, and Snacks leaves those out of sales. Migration 240 even says so: "`kind:'cash_out'` is what lets revenue reporting … tell this from a sale".
  - The new close-out function (280) marks its line `closeout`, which Snacks doesn't know, so it counts it as a purchase.
  - This is a side effect of the TED-142/145 fix. No test covers it.
- **How sure I am:** Confirmed in a real browser: the real Me close-out, then the real Snacks page.
- **Proof:**
  - `closeout_sales15.log`: Z1a `Sales today "$3" … Revenue "$3.00"`; Z1b `✓ 1 close-out step applied`, `lines today: purchase $3, cash_out $10, closeout $37.00`; Z2 `Sales today "$40" … Revenue "$40.00", 2 txns, avg $20.00; weekly bars [… $40]`, row `Season close-out: Hand back in cash … Purchase −$37.00`.
  - Code: `migrations/280_…sql:114` (`'kind', 'closeout'`); `campistry_snacks.js:700`, `:876`, `:992` (sales = every debit except `cash_out` and `refund`); `:1016` (anything else is labelled Purchase); `migrations/240_…sql:362`.
- **What to ask the builder for:** "TED-152: canteen_season_closeout (280) posts kind 'closeout', which Snacks' sales figures (campistry_snacks.js:700, 876, 992) and its transaction list (:1016) treat as a purchase — a $37 close-out turned 'Sales today' from $3 into $40 and is labelled 'Purchase'. Leave close-outs out of sales and revenue, label them as close-outs, and add a test."

### TED-153 🟠 "Discount for not paying by card" is promised to parents and never given
- **What a user would see:**
  - Me → Settings → Card Fees offers "Discount for not paying by card — The card price is the posted price. **Safest of the three.**" The camp chooses it with 3%.
  - The public registration form then tells every parent: **"Prices shown include card processing. Paying by cheque or bank transfer takes 3% off."**
  - The Wolf family owes $1,000 and sends a cheque for $970, as promised. The office records it.
  - **Wolf still owes $30.** Reminders and late fees follow for money the camp promised to take off.
  - The office has no tool for it. "Add card surcharge…" in this mode just says "That works out to no fee", and the settings never say the discount must be given by hand.
- **Why:**
  - The card-fee rules work out the discount, but nothing in the product ever reads it.
  - The policy is used in exactly three places: the registration form's wording, and Me's manual fee window and its settings.
  - The same is true the other way round for the surcharge and the flat online fee. Parents are told they apply, but they are only added when the office adds them by hand. That is in the family's favour, so I haven't filed it separately.
- **How sure I am:** Confirmed in a real browser (the real registration form and the real Me page).
- **Proof:**
  - `cash_discount15.log`:
    - `Files that read the card-fee policy at all: ./campistry_card_fees.js, ./campistry_me.js, ./campistry_register.html`;
    - `Places that read a quote's discount: none`;
    - C1 `"Prices shown include card processing. Paying by cheque or bank transfer takes 3% off."`;
    - C2 `Wolf now owes $30`;
    - C3 `toast: "That works out to no fee"`.
  - Code: `campistry_card_fees.js:176` (the discount is worked out) and `:303` (the promise); `campistry_me.js:20489` ("Safest of the three").
- **What to ask the builder for:** "TED-153: the 'Discount for not paying by card' card-fee mode is saved and promised to parents on the registration form ('Paying by cheque or bank transfer takes 3% off'), but nothing ever applies it — a family who pays $970 by cheque against $1,000 still owes $30. Apply the discount when a cheque/bank payment is recorded (as its own line on the bill), or give the office a way to apply it and say so in Card Fees — or hide the option until it works."

### TED-154 🟡 A bank debit the bank returned can show as "on its way" for two weeks
- **What a user would see:**
  - Steel's $700 bank debit is returned by the bank (insufficient funds). Billing correctly marks it failed.
  - Then Stripe delivers its earlier "processing" message late. It does this when a first delivery didn't get through.
  - **Billing now shows "$700 on its way" again**, and Charge Card refuses: "Nothing more is charged to this family until the bank settles it … or returns it (Billing then says it failed, and you can charge again)".
  - Batch charge leaves Steel out, and the nightly autopay waits too, for up to 14 days, although Stripe says the payment failed.
  - The fix covers the late message after a *successful* payment (checked), but not after a failed one.
- **How sure I am:** Confirmed, on the real Billing page with the real webhook and a real database. It needs Stripe to deliver out of order, which Stripe says can happen.
- **Proof:**
  - `ach15.log` A6: `payment_failed → … pi_pi_3 $700 failed`, then `late processing → … pi_pi_3 $700 pending`, `Steel's family page: "Balance$700$700 on its way …"`, `Charge Card → "Steel: A $700 bank debit started … is still on its way"`, `Steel's debits: pi_3 requires_payment_method`.
  - Code: `supabase/functions/stripe-webhook/index.ts:189-195` (only succeeded/canceled are left alone); `campistry_me.js:19410` and `charge-due-installments/index.ts:282` (a pending row counts for 14 days).
- **What to ask the builder for:** "TED-154: stripe-webhook's late-'processing' guard (upsertPayment, index.ts:189-195) skips only succeeded/canceled; a 'processing' event delivered after payment_failed (the PaymentIntent is now requires_payment_method) turns the failed row back to pending, so Billing, Batch charge and autopay treat a returned debit as on its way for 14 days. Record 'processing' only when Stripe still says processing."

### TED-155 🟡 The bank-account guard also blocks the flat "online payment fee", with the wrong reason
- **What a user would see:**
  - The camp charges a flat $5 "online payment fee". The card-fee rules allow this on bank payments too.
  - Zinc pays by bank. The office opens "Add card surcharge…". The window says "Fee $5 — total with fee $1,005".
  - Save answers **"Not added: … which the card brands forbid"**, and no fee is added. A family paying by card gets it ("✓ Card fee of $5 added to Nickel").
  - The TED-147 guard is right for the percentage surcharge, but it was applied to every fee type.
- **How sure I am:** Confirmed in a real browser.
- **Proof:** `surcharge15.log` S7 (zinc: `"✕ Not added: Zinc's default payment method is a bank account … which the card brands forbid"`; nickel: `fee $5`). Code: `campistry_me.js:2423`.
- **What to ask the builder for:** "TED-155: addCardSurcharge refuses any card-fee mode for a family whose default is a bank account (campistry_me.js:2423); limit that refusal to the percentage surcharge — a flat convenience fee is allowed on bank payments."

### TED-156 🟡 Link keeps saying "the camp switched it off" after the parent turned auto-reload off themselves
- **What a user would see:**
  - After Refund All, the parent's Link page says: "Auto-reload was switched off — switched off when the camp refunded the canteen balance — switch it back on if you still want it."
  - But both buttons (Update card, Turn off) are hidden, and the trigger box is still ticked. To switch it back on, the parent has to untick and re-tick a box.
  - After they do, and later press "Turn off" themselves, Link again says **the camp** switched it off.
- **How sure I am:** Confirmed, with the real parent function on a real database and Link's own display code in a browser. Not the whole Link page, because there is no test login for it.
- **Proof:** `link_paused_reason.log`: P0 `buttons []; "below $5" trigger box ticked: true`; P1 `stored: enabled true, disabledReason "switched off when the camp refunded …"`; P2 after the parent's own Turn off, `Link: "Auto-reload was switched off — switched off when the camp refunded the canteen balance …"`. Code: `migrations/231_…sql:447` (the parent's save merges and clears only the card-failure fields); `campistry_link_parent.html:2600`.
- **What to ask the builder for:** "TED-156: set_canteen_auto_reload keeps disabledReason/disabledAt when a parent re-enables, so after the parent's own 'Turn off' Link says the camp switched it off; clear them on any parent save, and give the paused state a 'Switch it back on' button (today both buttons are hidden and the trigger box is already ticked)."

## Gaps in the builder's tests
- Nothing tests that a close-out isn't counted as a sale. That's how TED-152 got through.
- pgtest 281 can't tell whether only the failed refund's own surcharge credit is undone (mutation M5 passes).
- The auto-reload switch-off is tested only on the two Stripe refund functions. My probe (`sola_pause15.log`) shows the two Sola ones do it too, with a control that is charged.

## Re-check of last report's findings
| ID | Now | My proof |
|----|-----|----------|
| TED-142: balance floor at season end | **Closed** | The real close-out in a real browser (`rerun14_closeout_floor.log`): with a $10 floor, "Hand back in cash" and "Donate" take all $50 (K1/K2; the 14th pass took nothing). Card refunds still return the whole balance (`rerun14_floor14_realdb`, `rerun14_floor_sola_realdb`, unchanged). Cash under the floor now has a way out (the close-out), and Take Out Cash says so. |
| TED-145: close-out blocked by the $20-a-day limit | **Closed** | `rerun14_closeout_floor.log` K0: with Snacks' default $20 limit, cash, donate and cheque each take the whole $50 (all three failed before). pgtest 280 fails if it may take more than the balance (M2). A double press can't take the money twice (`closeout_access15.log`: second press "Only $0.00 is on the canteen account now…"). |
| TED-144: bank debit charged twice | **Closed** (new twin → TED-154) | Real browser, three office computers (`ach15.log`): A1 "✓ A $1,000 bank debit has started … on its way"; A3 computer B refused before anything is sent; A3s with no row on the page, stripe-charge asked Stripe and refused (1 debit); A4 Batch charge "Not charged: Iron — a bank debit is still on its way", Gold and Steel charged; A5 a late "processing" after settlement leaves it paid. Autopay: the builder's test runs the real runner and fails on the old code. |
| TED-146: surcharge share across all payments | **Closed** | Real browser (`surcharge15.log`): S2 Bronze's fully refunded $3,090 returns all $90; S3 a refund from a bank payment returns none; S1b/S5 the preview matches the result (single and two-payment refunds); S6 three partial refunds return $8.74 + $8.74 + $12.52 = exactly $30. |
| TED-147: surcharge collected from a bank account | **Closed as asked** (side effect → TED-155) | `rerun14_surcharge_default_bank.log`: "✕ Not added: Iron's default payment method is a bank account…", nothing on the bill. |
| TED-148: surcharge credit kept after a failed refund | **Closed** | Real browser + real webhook + real 281 (`surcharge15.log` S4): after the put-back Slate owes $0 (was −$29.13); the second refund leaves $970.87; a re-delivered failure changes nothing. pgtest 281 fails with once-per-credit removed (M3). |
| TED-149: registration "Charge now" says "declined" | **Closed** | `rerun14_deposit_error_text.log`: manager 403 → "Not charged: Only the camp's owner or an admin can charge a deposit."; 404 → "Not charged: We could not find that application."; D3 in progress → the server's own words. Button hidden for others (code: `campistry_me.js` viewApplication, `_canChargeCards`). |
| TED-150: failed alert email never re-sent | **Closed** | Real webhook + real 278/281 SQL (`alert_retry_realdb15.log`): A (no camp) and B (known camp) → HTTP 500 then 200, **1 email**, money put back once, 1 notice; C no key → all 200, no loop; D Resend down for all 4 deliveries → 500 each (Stripe keeps re-sending). pgtest 281 fails when the release does nothing (M4). |
| TED-151: check script passed an earlier 275 | **Closed** | `rerun14_check_script_275.log`: now "apply 275 again — an earlier copy is in place, and it keeps the balance floor back from refunds". pgtest 275 fails without that row (M6). New 280/281 rows (`check_script_280_281.log`): "apply 280/281" when missing, "apply 281 again" when a browser can call it. |
| TED-143: auto-reload after camp | **Still open, partly fixed, now 🟠** | See above. |
| TED-005: auto-scheduler | Open, deferred | Still 14 failing, all in `auto_full_day.test.js`. Not investigated. |

## What I confirmed is working
- **Claims 1–12:** each checked above. What's still wrong is claim 1's "stops after the season" (TED-143: it restarts before the next one) and claim 2's Link wording (TED-156).
- **Sola canteen refunds switch auto-reload off** when they empty a wallet, keep the saved card, and leave it on after a partial refund. The next run charges nobody, while a control child is charged (`sola_pause15.log`).
- **Who can use the new close-out:** Billing editors only.
  - A parent and a stranger are refused, in words.
  - In a camp with no custom access rules, every staff role has Billing edit. That is the same rule as the rest of Billing, noted by design in my 10th pass (`closeout_access15.log`).
  - Nobody signed out can call it (the check script's 280 row).
- **One platform email per failed refund** is still true with the new email-retry logic (`billing_refund_again15.log`, `refund_failed_realdb15.log`: identical to last pass).
- **Browser caching:** each changed file loads with its new number wherever it is used:
  - `campistry_me.js?v=20260924-24`;
  - `campistry_snacks.js?v=20260924-09`;
  - `campistry_snacks_cash.js?v=20260924-02` (both Snacks pages).
- **Leftovers:** no secrets, debug switches or TODOs in the changed files. Two new server log lines, both intended.
- **Setup guide:** the PowerShell step is gone and replaced by a SQL Editor step. The only wrong step is "Dashboard → Camp dates" (TED-143).
- **Your code didn't change under me.** A commit landed during my run (`30b0fb8`, my own in-progress probe files). No product files changed since `5e72100`.

## What I did NOT check (and why)
- **Any real processor, email or SMS service.** Stripe, Sola and Resend are modelled on their documented behaviour. Nothing is live.
- **What is deployed.** Migrations 255–281 and the functions are not live yet.
- **Live sync between office computers.** My test setup has none.
  - Snacks' save lets a computer's own settings win.
  - An office computer that has lost its live connection could therefore switch the new auto-reload switch back on when it next saves an inventory change.
  - With the connection up, a Snacks tab reloads its settings when another computer saves.
- **Two things happening at the same moment:** the auto-reload job charging a child in the same second Refund All pauses that child. Not tested.
- **The whole Link page in a browser.** There is no test parent login. I ran its own display code in isolation (TED-156).
- **A registration deposit paid by bank.** It stays "owed" for days while the bank processes it, and I did not test what the form tells the parent then. A second payment would be recorded and credited, not lost.
- **Areas no billing pass has deep-audited yet:**
  - payroll;
  - POS register maths;
  - Link photo purchases;
  - staff tips;
  - splitting a family;
  - the bank-email matcher.

## Things only you can check (click-by-click)
1. **Owner steps (still pending):**
   - Supabase → SQL Editor → paste migrations **255 to 281 in order**, each one → Run.
   - Then paste `scripts/verify_identity_chain.sql` → Run. Every row should say "ok".
   - **281 must be in before `stripe-webhook` is deployed.**
   - Supabase → Edge Functions → deploy each of these:
     - `stripe-charge`
     - `stripe-refund`
     - `stripe-webhook`
     - `stripe-canteen-refund`
     - `stripe-canteen-refund-all`
     - `charge-due-installments`
     - `payments-charge`
     - `payments-canteen-refund`
     - `payments-canteen-refund-all`
     - `registration-deposit-checkout`
     - `canteen-auto-reload`
     - `cardknox-webhook`
     - `admin-connect-processor`
     - `stripe-connect-webhook`
     - `payments-refund`
   - For `stripe-webhook` and `charge-due-installments`: open each → **Settings** → **"Enforce JWT Verification" OFF**.
   - Reload Me and Snacks on the office computers.
2. **Stripe events (unchanged):**
   - Stripe Dashboard → Developers → Webhooks → your endpoint → **⋯ → Update details**.
   - Check that `payment_intent.processing`, `payment_intent.payment_failed`, `refund.failed`, `refund.updated` and `charge.refund.updated` are ticked, with the rest of the list in `BILLING_PAYMENTS_SETUP.md` step 5.
3. **Until TED-143 is fixed, at the end of every season:**
   - Snacks → **Settings** → *Parents' auto-reload* → **Off — charge nobody automatically** → Save, **before** Refund All.
   - **Leave it Off until next summer's first day of camp**, then switch it back On.
   - Make sure Dashboard → **Dates & Pricing** has every session with its real end date. The last one is when the job stops.
4. **Until TED-152 is fixed:** Snacks' sales for the days you close families out include the close-outs. Their lines read "Season close-out: …" in the transaction list, so subtract them.
5. **Until TED-153 is fixed:** don't choose "Discount for not paying by card" in Me → Registration → Registration Form → **Card Fees**.
   - If you already did, switch it to "Nothing passed on".
   - Give any family who paid the discounted amount a credit: Billing → the family → **Issue Credit**.
6. **If Billing shows a bank debit "on its way" that Stripe shows as failed (TED-154):**
   - Stripe Dashboard → Payments → search the family → confirm it failed.
   - Then in Billing → Payments, remove that "on its way" row (✕). Charge Card works again.
7. **Platform alert email:** Supabase → Edge Functions → **Secrets**: check `RESEND_API_KEY` is set. Without it no alert is sent at all.
