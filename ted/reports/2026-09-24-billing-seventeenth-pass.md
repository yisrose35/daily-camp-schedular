# Ted's report: billing, seventeenth pass (re-check TED-157 to TED-161, then a hunt), 2026-09-24

## Verdict: 🔴 Problems found

**All five fixes I re-checked work, and I'm closing them: TED-157, 158, 159, 160 and 161.** I proved each one myself, on the real pages in a real browser, with the real payment functions and a real database. The builder's figures for every test suite are exactly right.

**But you can't be 100% certain yet.** Two of the fixes left a gap behind them, and the parts of billing nobody had tested before had problems of their own. I found 14 new problems. The ones that matter most:
- **Split between payers (🔴):** when a scholarship fund pays part of a bill, the family is still billed for all of it. Tonight's autopay would take the fund's share from the family's card too.
- **Stripe payments (🟠):** if the database has a hiccup at the moment Stripe reports a payment, Campistry answers "received" anyway. The parent is charged and emailed a receipt, and the payment is never recorded. Stripe won't send it again.
- **Finance's ✕ (🟠):** it now "undoes" a refund that really went back to the family's bank through Stripe, so the bill shows money the camp doesn't have.
- **Payroll (🟠):** the "New Pay Run" window's own starting dates make weekly runs pay the same week twice, and two-weekly runs skip part of a week.
- **Refund window (🟠):** its "Balance owed after this refund" figure is wrong for any family who paid online.

I did not change any product code. I only reported.

## The numbers
Tests run: 3,876 · Passed: 3,862 · Failed: 14 (real bugs: 14, all of them the deferred auto-scheduler tests, TED-005 · out-of-date tests: 0 · my machine: 0)

| Suite | Run | Passed | Failed |
|---|---|---|---|
| Unit tests (`npm test`) | 3,659 | 3,645 | 14, all in `auto_full_day.test.js` (TED-005, deferred by you; I ran that file on its own: 23 run, 9 pass, 14 fail) |
| Database tests (`npm run test:pg`) | 71, against 130 migrations | 71 | 0 |
| `test:keys` | 42 | 42 | 0 |
| `test:lite` | 12 | 12 | 0 |
| `test:smoke` | 34 + 34 (the Snacks browser test) | 68 | 0 |
| `test:scale` | 24 | 24 | 0 |

These match the builder's figures exactly (claim 6).

**The builder's new and changed tests, run against the code from before the fixes** (`aa72c69`, in a scratch copy outside the project, removed afterwards; logs `oldcode_*.log`):

| Test file | Failures on the old code |
|---|---|
| `finance_payments_reach_the_bill` (new) | all 5 |
| `pos_charge_once` (new) | 3 of 5 (the 2 that pass test things the old register also did: a new sale after an answer, and a refusal) |
| `link_autoreload_paused` | 2 of 6 (the 2 new TED-161 tests) |
| `card_surcharge_billing` | 2 of 15 |
| `camper_identity_ledger` | 2 of 9 |
| `cash_discount_applied` | 1 of 8 |
| `charges_reach_the_ledger` | 1 of 21 |

Two changes to older tests I read closely, and neither was loosened:
- `cash_discount_applied` lost its "give the online-bank discount" test. That behaviour is now tested more strictly in the new `finance_payments_reach_the_bill`.
- `charges_reach_the_ledger` stopped testing the Finance page's own Record Payment form, because that form no longer exists. It now checks that only one such form is left.

**Mutation checks** (`mutations.log`): I broke today's changes on purpose, one at a time, and re-ran the builder's tests. All 7 were caught:
- migration 283 charging a repeated sale again;
- migration 283 without its same-child, same-amount check;
- migration 283 remembering a refused sale;
- the register without its "one charge at a time" lock;
- the register making a new key after a lost answer;
- Finance's ✕ leaving the discount on the bill;
- Link switching auto-reload on for every edit.

**Every earlier billing probe, re-run at today's code** (`rerun_all17.sh`, compared by `compare_reruns17.sh`):
- **All 121 non-browser probes from passes 1 to 16 give the same answers as last pass.** 112 are byte-identical once ids and times are masked. 6 differ only in timings, a clock time or a line number. 3 are pass-16 test probes whose log names changed, and they give the same results.
- **Browser probes (15, in `rerun15/`, `rerun_e2e/`, `rerun16/`): 12 give exactly last pass's results, and the other 3 are explained.**
  - The 15th-pass six pass in full, as last pass.
  - The 14th-pass six match last pass line for line, including 3 BAD lines that were already explained:
    - the old surcharge probe doesn't connect migration 281 to its webhook; the 15th-pass copy does, and passes;
    - the old bank-debit probe's pretend Stripe can't answer the webhook's newer question, so Charge Card safely charges nothing.
  - The 3 explained ones: last pass's cash-discount probe gives the same D1–D4, then stops at D5. The old typed-name Finance form it fills in is gone, which is the TED-157 fix; my new probe covers D5–D7 on the new forms.
  - Last pass's register and Link probes: the Link one's every difference is the fix. The register one can't reach the new code (its wrapper catches only the old function name: "requests sent 0"), so it proves nothing; the new `pos17` does.

**New probes this pass** (`ted/probes/2026-09-24-billing-17/`), 10 in all:
- 6 on real pages in a real browser: Finance + Billing with the real refund and webhook functions; the online register; Link's auto-reload card; the offline register; Payroll with the browser clock set; Add Charge with a payer split;
- the real Stripe webhook with one database write failing;
- migration 283 with two real database connections at once;
- the real bank-email matcher;
- the check script against last pass's copy of 281.

## What's wrong (most serious first)

### TED-165 🔴 "Split between payers" is saved but never used: the family is billed, and autopay charges, the full amount
- **What a user would see:**
  - The Pine family's tuition is $1,000. The camp's Scholarship Fund has approved $800 of it.
  - The office opens **Billing → Add Charge**, enters $1,000 and opens "Split between payers". It gives the Scholarship Fund $800, and the window confirms **"Scholarship Fund 800.00 · Pine 200.00"**.
  - **But Pine's bill says they owe $1,000.** Billing's family page says $1,000 and never mentions the fund, and Link shows the parent $1,000 too.
  - **Tonight's autopay would take $1,000 from Pine's card**, the fund's $800 included.
  - When the fund's cheque arrives and is recorded, Pine ends up with an $800 credit, and the camp has to refund it.
- **How sure I am:** Confirmed, on the real Me page in a browser, with the real autopay amount query.
- **Proof:**
  - `payer_split17.log`: `The window says: "Scholarship Fund 800.00 · Pine 200.00"`; `Pine's ledger: charge 100; payment 100; charge 1000; owes $1000; Billing's family page Balance $1,000; the fund's share shown on that page: false`; `plan_due_for → {"amount": 1000.00 …}`.
  - Code: `campistry_me.js:18510-18517` (the split is stored on the charge, and the full amount goes to the family's ledger and balance).
  - The split's own maths (`campistry_payers.js` `allocate`/`balances`, 36 passing tests) is never called by Billing, by Link, by any migration, or by the autopay function (search finds no caller).
- **What to ask the builder for:** "TED-165: Add Charge's 'Split between payers' (campistry_me.js:18505-18515) stores the split on the charge but posts the full amount to the family's ledger, so the family's bill, Link and autopay (plan_due_for) all ask the household for the organization's share too — Pine was split $800 fund / $200 household and plan_due_for returned $1,000 (payer_split17). Make the household's bill (and autopay, and Link) carry only the household's share, keep the organization's share as its own receivable with a way to record its payment, and show it on the family page; add a test that runs Add Charge with a split and checks plan_due_for."

### TED-164 🟠 If the database hiccups when Stripe reports a payment, the parent is charged and emailed a receipt, but the payment is never recorded
- **What a user would see:**
  - A parent pays $500 on Link, or puts $20 on the canteen, or buys photo matching. Stripe takes the money and tells Campistry.
  - If the database refuses the write at that moment (a timeout, a dropped connection, a migration not yet pasted), Campistry answers Stripe "received" and sends the parent a receipt anyway.
  - The family's bill still shows the $500 owing, and autopay may charge it again. The child's canteen wallet stays empty, and the photos stay locked.
  - Stripe treats "received" as done and never sends it again, so nothing ever puts it right.
- **How sure I am:** Confirmed. I used the real `stripe-webhook` on a real database, with that one write failing the way the Supabase library reports a timeout.
- **Proof:**
  - `webhook_write_fails17.log`: W1 Pay Now → `HTTP 200 {"received":true}; receipts sent 1; Gold owes $1000.00`; W2 canteen → `Avi's wallet $0`; W3 photos → `photo purchases on file 0`.
  - The same event delivered again with the database healthy records each one. So an error answer, which makes Stripe retry for 3 days, would have fixed it.
  - Code: `supabase/functions/stripe-webhook/index.ts:238-241` (`upsertPayment` returns false and the caller only logs it, :1072-1073), `:268-274` (canteen), `:372-395` (photos), `:307-316` (registration deposit), then the receipt (:1090) and `200 received` (:1142).
  - The Sola webhook already does this right. It answers 500 "worth a retry" and sends the receipt only after the payment is recorded (`cardknox-webhook/index.ts:551-553`, `:637-639`).
- **What to ask the builder for:** "TED-164: stripe-webhook answers 200 'received' (and sends the receipt) when append_camp_payment / credit_canteen_balance_from_stripe / record_link_photo_purchase / _record_registration_deposit fails for a succeeded payment, so Stripe never retries and the payment is never recorded (webhook_write_fails17 W1–W3). Answer 500 when the write fails (the writes are idempotent, so Stripe's retry is safe), send the receipt only after it is recorded — as cardknox-webhook already does — and add a test that fails the write once."

### TED-163 🟠 Finance's ✕ "undoes" a refund that really went back to the family through Stripe, and a failed-refund put-back
- **What a user would see:**
  - Hawk withdrew, and Billing refunded their $970 to their bank through Stripe.
  - Later someone tidies Finance's Payment Log and presses ✕ on the refund row. The window says **"The $970 refund comes off Hawk's account — the refund is undone."**
  - Hawk's bill goes from owing $1,000 to owing **$30**, as if the camp still had the $970. The refund window offers **"$970 refundable to card/bank"** again.
  - The same happens to the row Campistry adds when Stripe fails a refund (in the Payment Log it shows as "$970 · Other"). ✕ on it makes Slate owe $970, as if the parent had got money they never received.
  - The ✕ correctly refuses the payment itself ("That payment went through the card processor"). It only checks payments, not the refunds and put-backs that also went through Stripe.
- **How sure I am:** Confirmed, on the real Me page with the real `stripe-refund` and `stripe-webhook`.
- **Proof:**
  - `finance_billing17.log` F8: `confirmation "…The $970 refund (Other) comes off Hawk's account — the refund is undone."`, `Hawk owes: before $1000, after $30`, `the refund window now says: "$970 refundable to card/bank…"`.
  - F11: `Slate owes: before $0, after $970`.
  - Code: `campistry_me.js:19327-19331` (only `stripePaymentIntentId`/`byopTransactionId` are refused). Billing's refund rows carry `stripeRefundId`/`byopRefundId` instead (`:19034-19038`), and so do the webhook's dashboard-refund rows (`migrations/215…sql`, `record_external_refund`). 278's put-back rows carry `failedRefundId` (`migrations/278…sql:280-292`).
- **What to ask the builder for:** "TED-163: _removeRecordedPayment (campistry_me.js:19327) refuses only rows with stripePaymentIntentId/byopTransactionId, so Finance's ✕ reverses a real Stripe/Sola refund (stripeRefundId/byopRefundId) and a 278 'Refund failed' put-back (failedRefundId) — Hawk went from owing $1,000 to $30 and the payment became refundable again (finance_billing17 F8, F11). Refuse any row that carries a processor id of any kind (and ideally hide the ✕ on those rows); add these rows to the test."

### TED-166 🟠 Payroll: the New Pay Run window's own dates pay a week twice (weekly runs) or skip part of a week (two-weekly runs)
- **What a user would see:**
  - **Every week, with the window's defaults:**
    - On Tuesday Jul 7 the office makes a run with the dates the window fills in (from the Sunday of last week to today), then does the same on Tuesday Jul 14.
    - Both runs include the week of Jul 5.
    - Ana (hourly, $15) is paid for **112 hours against 96 worked** ($1,680 instead of $1,440).
    - Ben (weekly, $300) is paid for **4 weeks** after 2⅓.
  - **Every two weeks, with the defaults:**
    - The first run counts only Sunday to Tuesday of the week it was made in, and the next run starts the following Sunday.
    - The rest of that week is never paid: Ana is paid for **112 of 136 hours** ($1,680 of $2,040).
  - Nothing warns that a run overlaps an earlier one.
  - Campistry doesn't send pay itself, but the pay run is the list the office pays from.
- **How sure I am:** Confirmed, on the real Payroll page in a browser with the clock set to those Tuesdays.
- **Proof:**
  - `payroll_runs17.log`: `Run 1 … From 2026-06-28 To 2026-07-07`, `Run 2 … From 2026-07-05 To 2026-07-14`; `Ana paid for 112 h ($1680) — the week of Jul 5 is in both runs`; `Ben paid 4 weeks ($1200)`.
  - Scenario B: `Ana paid for 112 h of 136 h ($1680 of $2040)`.
  - Code: `campistry_me.js:17754` (`from = the Sunday of last week, to = today`), `campistry_payroll_core.js:461-476` (a sheet is in a run when its week's Sunday is in the range, whole-week), `:112` (weekly pay counts any sheet as a full week).
- **What to ask the builder for:** "TED-166: New Pay Run (prNewRun, campistry_me.js:17754) defaults to 'Sunday of last week → today', which includes the current unfinished week — weekly runs a week apart both count the middle week (Ana 112 h paid for 96 worked, Ben 4 weeks for 2⅓), two-weekly runs never pay the rest of that week (112 of 136 h) (payroll_runs17). Default to the last COMPLETE week(s) after the previous run's end, refuse or warn on a range that overlaps an earlier run, and add a test for two consecutive default runs."

### TED-167 🟠 The refund window's "Balance owed after this refund" is wrong for families who paid online
- **What a user would see:**
  - Finch paid their $1,000 tuition online by card, and Billing correctly shows $0.
  - The office opens Issue Credit/Refund for $400. The window says **"Balance owed after this refund: $1,400 (currently $1,000)"**.
  - After the refund Finch owes **$400**.
  - For online-bank families with the not-paying-by-card discount it is off too: Hawk's window said "$970 (currently $-30)", and afterwards Hawk owed $1,000.
- **Why:** the window reads an old per-family figure that online payments recorded by the webhook never update. Billing itself shows the right figure (from the ledger).
- **How sure I am:** Confirmed, on the real Me page with the real `stripe-refund`. It is older than this commit: the line was the same at `aa72c69`. The 15th-pass surcharge probe passed only because its families had no such figure.
- **Proof:**
  - `finance_billing17.log` F14: `before: Finch owes $0 on the ledger (Billing's figure: "$0")`, `preview "Balance owed after this refund: $1,400 (currently $1,000)"`, `Finch now owes $400`.
  - F7b and F12: the same drift.
  - Code: `campistry_me.js:18814-18815` (`f.balance`), `:15402` (enrolment adds the tuition to `f.balance`, and nothing takes an online payment off it).
- **What to ask the builder for:** "TED-167: _crUpdateBalancePreview (campistry_me.js:18814) starts from families[fk].balance, which webhook-recorded payments never update, so 'Balance owed after this refund' said $1,400 (currently $1,000) for Finch, who owed $0 and owed $400 afterwards (finance_billing17 F14). Start from the ledger balance Billing shows (buildFamilyLedgers) and add a test with a family whose old balance field disagrees with its ledger."

### TED-168 🟡 Register: after a lost answer, the same child's next identical purchase is not charged
- **What a user would see:**
  - Shaya's Ices charge loses its answer, and the register says "Could not confirm…".
  - The counselor checks, sees it went through, and presses **Clear All** instead of charging again.
  - If Shaya's second Ices is the very next sale on that register, it is **not charged**, yet the register shows "✓ $2.50 charged to Shaya Brickman".
- **How sure I am:** Confirmed, on the real register page against the real 283.
- **Proof:**
  - `pos17.log` P4: `requests ["…key=sale_mufgiwa4_zez057c5","…key=sale_mufgiwa4_zez057c5"]; register says ["✓ $2.50 charged to Shaya Brickman"]; new debits 0`.
  - Code: `campistry_snacks_pos.js:662-668` (the key is kept until an answer comes, and Clear All at `:596` doesn't drop it).
- **What to ask the builder for:** "TED-168: after a lost answer the register keeps the sale's key even when the counselor presses Clear All or picks another child, so the same child's next identical sale replays the first one and isn't charged while the toast says 'charged' (pos17 P4). Drop the pending key on Clear All / a camper change, and say 'already charged — not charged again' on a replayed answer instead of '✓ charged'."

### TED-169 🟡 Register: starting the next child's sale while "Charging…" wipes that cart and miscounts stock
- **What a user would see:**
  - On slow wifi, while Shaya's charge shows "Charging…", the counselor selects Avi and adds Chips.
  - When Shaya's answer lands, Avi's Chips disappear from the screen, and the stock counts record Chips as sold. Avi was not charged, and no Chips were sold.
- **How sure I am:** Confirmed, on the real register page. This was possible before this commit too.
- **Proof:**
  - `pos17.log` P5: `cart "Tap items to start"`, `stock before Ices 45 left/5 sold, Chips 50 left/0 sold; after Ices 44 left/6 sold, Chips 49 left/1 sold`, `Avi +0`.
  - Code: `campistry_snacks_pos.js:696-722` (`finish` reads the current cart when the answer arrives).
- **What to ask the builder for:** "TED-169: the register's finish() (campistry_snacks_pos.js:696) uses whatever is in the cart when the answer arrives, so starting the next child's sale during 'Charging…' records that child's items as sold and clears their cart (pos17 P5). Use the sale's own items (captured at charge time) and only clear the cart if it is still that sale."

### TED-170 🟡 The offline register can charge a child twice for one double tap (TED-159's twin)
- **What a user would see:** on the offline register (the tablet with no wifi), a double tap that the screen registers at the same instant charges the child twice for one item, and counts the stock twice.
- **How sure I am:** Confirmed, on the real offline register page. On my machine, taps 40 ms apart were charged once; on a slower tablet the gap that charges twice is wider.
- **Proof:**
  - `offline_register17.log` O1: `before {"bal":17.5,"sales":1,…,"stock":29} → after {"bal":12.5,"sales":3,…,"stock":27}`.
  - Code: `campistry_snacks_pos_offline.html:1657-1735` (`POS.charge` waits on the tablet's storage before clearing the cart, with no "already charging" guard).
- **What to ask the builder for:** "TED-170: the offline register's POS.charge (campistry_snacks_pos_offline.html:1657) has no in-flight guard and awaits IndexedDB before clearing the cart, so a same-instant double tap records two sales (offline_register17 O1). Give it the same one-charge-at-a-time lock as the online register."

### TED-171 🟡 Offline register: if the exported sales file is lost, those sales can never be exported again
- **What a user would see:**
  - The canteen counselor presses "Export Transactions" on the offline tablet.
  - The tablet marks every sale as exported the moment the download starts. If the file never reaches the office (a download blocked, a file saved somewhere nobody can find), those sales can't be exported again.
  - The children are never charged, and the stock never catches up.
  - Importing the same file twice is already safe, so exporting again would be too.
- **How sure I am:** Confirmed, on the real offline register page.
- **Proof:**
  - `offline_register17.log` O3: `first file: 4 sales`, `second file: 0 sales`; the settings screen shows "Un-synced 0 · Exported 4", and there is no "export again".
  - Code: `campistry_snacks_pos_offline.html:1208-1231`.
- **What to ask the builder for:** "TED-171: the offline register marks every sale exported as soon as the download starts (campistry_snacks_pos_offline.html:1226) and offers no way to export them again, so a lost file loses those sales (offline_register17 O3). Add 'Export all sales again' (the import is idempotent on the sale id) and warn before Clear All Data while any sale has never been imported."

### TED-172 🟡 Link: ticking a trigger and then quickly changing an amount leaves auto-reload OFF (side effect of the TED-161 fix)
- **What a user would see:**
  - A parent setting up auto-reload for the first time ticks "Reload when balance drops below…". Right away they nudge the amount with the arrow, or, on a slow phone, type a new amount before the first save comes back.
  - The box stays ticked, but auto-reload is **off**: Link says "Auto-reload is off." and shows "Switch it back on".
  - A parent who doesn't read the status line thinks it's on, and the child's balance runs out.
- **Why:** the auto-save waits half a second and keeps only the last change. Since the fix, only a tick switches it on, so a tick followed by an amount edit is saved as off.
- **How sure I am:** Confirmed, with Link's own card and functions against the real `set_canteen_auto_reload`.
- **Proof:**
  - `link17.log` L5: `sent [{"child":"Chaim Katz","enabled":false,…}]; stored enabled false; Link "Auto-reload is off."; box ticked true`.
  - L6 (answers take 1.5 s): `sent [{…"enabled":true…},{…"enabled":false…}]; stored enabled false`.
  - L1–L4 (the fix itself) all pass.
  - Code: `campistry_link_parent.html:2725-2745`.
- **What to ask the builder for:** "TED-172: _arAutoSave (campistry_link_parent.html:2725) decides switch-on from the LAST change event only and reads 'was on' from the last saved answer, so a trigger tick followed within the 500 ms debounce (or before the first save returns) by an amount edit saves enabled:false (link17 L5, L6). Remember a pending switch-on across the debounce and across a save still in flight."

### TED-173 🟡 The checking script says "281 ok" on last pass's copy of 281, which doesn't give the discount back
- **What a user would see:** 281 was changed in place this time. If you pasted last pass's 281 and now paste only the new 283, the checking script says every row is "ok". But when a refund of a discounted bank payment fails, the family's $30 discount is not given back.
- **How sure I am:** Confirmed, on a real database with the real check script.
- **Proof:**
  - `check_script_281_17.log`: with last pass's 281 pasted over today's, the rows read `["281 : ok","282 : ok","283 : ok"]`, and a failed refund gives `{"undone": 0}`, `credits now: cdisc_pi_pi_hawk $30` (today's 281 gives `discountBack 30`).
  - Code: `scripts/verify_identity_chain.sql:698-705` (it checks only that the functions exist and are locked down).
- **What to ask the builder for:** "TED-173: the check script's 281 row passes an earlier copy of 281 without the TED-160 discount give-back (check_script_281_17); make it check for cashDiscountBack in undo_card_fee_return and say 'apply 281 again', like the 275 row (TED-151)."

### TED-174 🟡 The bank-email matcher posts money to one of two households whose parent has the same name
- **What a user would see:**
  - Two households each have a parent called David Cohen, which is common in this community. A Zelle arrives "from DAVID COHEN" for $1,000.
  - With automatic posting on, the matcher posts it to whichever Cohen household owes exactly $1,000, with no person checking. A $500 Zelle goes to the Cohen who owes $500.
  - If it was the other David Cohen who sent it, both bills are now wrong. The family who paid is chased, and autopay may charge them again.
- **How sure I am:** Confirmed, using the real matcher decision (the same code the deposit-inbox function is built from).
- **Proof:**
  - `deposit_match17.log` M1: `auto → cohenA (conf 98) candidates [["cohenA",98,"Matches parent David Cohen + … + Pays the balance exactly"],["cohenB",86,"Matches parent David Cohen …"]]`; M1b the same for $500 → cohenB.
  - The module's own rules say a name is "never strong enough to post money by itself" and that an ambiguous top two never auto-posts (`campistry_deposit_match.js:20-21`, `:35`; the decision is at `:530-570`).
  - Two households with the same *household* name are correctly sent to review (M4).
- **What to ask the builder for:** "TED-174: decide() (campistry_deposit_match.js:530) auto-posts when two households match the payer's NAME equally and only the balance-equals-amount bonus separates them (David Cohen ×2 → posted to whichever owes that amount, deposit_match17 M1/M1b). Send it to review when the name evidence alone is tied, and add that case to deposit_match.test.js."

### TED-175 🟡 There is no way to undo a register sale; the only workaround books money nobody paid
- **What a user would see:**
  - A child is charged by mistake: the wrong child, the wrong item, or a double charge from before TED-159.
  - Neither Snacks nor the register has a void or refund-a-sale button.
  - The only way to give it back is **Add Deposit**, which records "$2.50 paid in by cash" (or card). The cash drawer, the day's takings and the deposit reports then show money that never came in, and the mistaken sale still counts as a sale.
- **How sure I am:** Confirmed by reading the code: no void action on either page, and no void function in the database.
- **Proof:** Snacks' actions (`campistry_snacks.js`, `window.*` list) and the register's have no void. There is no `canteen_*void*/adjust*` function in `migrations/`. `addDep` (`campistry_snacks.js:1679-1712`) only takes the camp's real payment methods.
- **What to ask the builder for:** "TED-175: there is no way to void a register sale — the office's only correction is Add Deposit with a real payment method, which books fake cash/card income (campistry_snacks.js:1679). Add a 'Void this sale' on a child's transaction (staff with Snacks edit), recorded as a reversal of that sale and giving back stock, not as a deposit."

### TED-176 🟡 (Likely) A refunded or disputed staff tip isn't handled: the staff member keeps it, and Campistry pays
- **What a user would see:**
  - A parent disputes a $100 tip with their bank, or someone refunds it in Stripe.
  - Nothing in Campistry notices. The tip stays on the staff member's record and total.
  - Because the tip went straight to the staff member's own Stripe account, Stripe takes the refund or chargeback, plus its dispute fee, from **Campistry's** platform balance.
  - Getting the money back from the staff member is a manual "reverse transfer" in Stripe, and the tipping setup guide doesn't mention any of this.
- **How sure I am:** Likely, from reading the code (I can't run a real dispute).
- **Proof:**
  - `stripe-connect-webhook/index.ts:445-495` handles `account.updated`, `payment_intent.succeeded`/`payment_failed` and `payout.failed` only, with no refund or dispute event.
  - `stripe-connect-tip/index.ts:231-232` (destination charge).
  - `TIPPING_SETUP.md` has no mention of refund, dispute, chargeback or reversal (search).
- **What to ask the builder for:** "TED-176: tips are destination charges from the platform, and stripe-connect-webhook handles no refund/dispute events, so a refunded or disputed tip stays on the staff record while the platform pays it back; handle charge.refunded / charge.dispute.created for tip payments (mark the tip, reverse the transfer when possible, alert the platform), and document the manual steps in TIPPING_SETUP.md."

## Re-check of last report's findings
| ID | Now | My proof |
|----|-----|----------|
| TED-157: Finance's Record Payment never reached the bill | **Closed** | Real browser (`finance_billing17.log` F1): Finance → Revenue → "+ Record Payment" opens Billing's form (family picker, no typed-name box); Moss $970 cheque → owes $0 with the $30 discount; Finance re-rendered in place with the row; tonight's autopay `plan_due_for → "nothing_owed"` (last pass: $1,000 charged again). |
| TED-158: Finance's ✕ removed only the list row | **Closed** (new gap → TED-163) | F2: the confirmation reads "…comes off Wolf's account — they will owe it again, and the $30 discount that came with it goes too"; after it, Wolf owes $1,000, the discount credit is gone, and the ledger went from 3 to 5 entries (both reversed, not deleted). F3: Cancel changes nothing. F6: Hawk's Stripe payment is refused ("use Issue Credit/Refund"). Refund rows are not refused → TED-163. |
| TED-159: register double charge | **Closed** (edges → TED-168, 169; offline twin → TED-170) | The real register page, with both purchase functions sent asynchronously like supabase-js (`pos17.log`): P1 second and third taps after 0.3 s → 1 request, 1 debit, button "Charging…", toast "✓ $2.50 charged to Shaya Brickman"; P2 lost answer after the server charged → "Could not confirm the charge to Shaya Brickman — it may have gone through…", sale kept, retry sends the same key → 1 debit; P3 lost before reaching the server → retry charges once; P7 without 283 → falls back, one charge. Two real database connections (`sale_key_race17.log`): R1 same key 0.5 s apart → the second waited 1.5 s and got the first answer (replayed), 1 debit; R2 first rolled back → second charged once; R3 two sales at once → both charged; R4 refused → both refused, no key kept; R5 3-day-old key forgotten; R6 parent account → not_authorized. Last pass's probe can't exercise it (its wrapper only catches the old function name: "requests sent 0"). |
| TED-160: online-bank discount | **Closed** (preview figure → TED-167; check script → TED-173) | F5: the family page says "1 bank payment made online without the not-paying-by-card discount — give it"; the window lists that payment; Give → owes $0, one credit `cdisc_pi_pi_hawk $30`; pressing again → "already has its discount", nothing more, note gone. F7: $970 refund to the bank → the real stripe-refund sends one refund, "Discount returned" $30 posted, Hawk owes $1,000. F9: $500 + $470 refunds → $15.46 + $14.54 = $30 back. F10: Stripe fails the refund → real webhook + real 278/281 → owes $0 again; re-delivered → no change. F12: the offline refund window says "This family was given $30 off … add that discount back with Add Charge". F13: a bank debit still on its way isn't offered. |
| TED-161: Link off state | **Closed** (side effect → TED-172) | Last pass's probe, unchanged (`rerun16/link_paused16.log`): every difference is the fix. Off → "Switch it back on"; editing the amount while off → sent `enabled:false`, stays off (last pass: switched on). `link17.log` L1–L4 with real clicks and typing: off → back on; $35 typed while off → saved, stays off; a never-set-up child ticks the trigger → "Almost there — add a card"; edit while on → stays on. |
| TED-162: tip fee | Open, unchanged | Waiting on your question to Stripe. Tip refunds and disputes are a separate new finding (TED-176). |
| TED-005: auto-scheduler | Open, deferred | Still 14 failing, all in `auto_full_day.test.js`. Not investigated. |

## What I confirmed is working
- **Claims 1–7** are each checked above. Apart from the gaps listed as new findings, every claim is true.
- **Browser caching:** `campistry_me.js?v=20260924-26` and `campistry_snacks_pos.js?v=20260924-01`, each loaded from its one page. Link's change is inside its own HTML page.
- **Leftovers:** the diff has no debug switches, no new logging, no TODOs and no secrets (search).
- **Who can call money functions from a browser:**
  - The old list is unchanged at 98, plus the new register sale function. That one is for camp staff only: a parent account is refused (R6) and signed-out visitors can't call it (pgtest 283).
  - The table of sale keys can't be read from a browser (pgtest 283).
- **Staff tips:** a tip is recorded once, even if Stripe sends it twice (unique index on payment + staff member, `migrations/059…sql:83`), and the multi-recipient cart transfer uses a stable key (code read).
- **Photo purchases:** the price is fixed on the server (last pass), and a purchase is recorded once per payment (code read). The one gap is TED-164.
- **Payer split maths** (`campistry_payers.js`): 36/36 tests pass, and rounding cents go to the household. The gap is that nothing uses it (TED-165).
- **Bank-email matcher:** its 9 test files all pass (215 tests), and two households with the same household name go to review (M4).
- **Payroll's other maths:** zero hours pays zero, a stipend pays once in the final run, and people paid by a program cost the camp $0 (code read).
- **One small wording issue (not a money problem):** removing an old Finance-page row that never reached the bill leaves the bill alone, which is right. But the window says "they will owe it again" and the toast says "balance is back up by $970" (`finance_billing17.log` F4). No such rows exist today, because nothing is live.
- **Your code didn't change under me.** HEAD is `f70340a` throughout, and only my `ted/` folder changed. The old access-sweep probe rewrote its 10th-pass output file again; I put it back and kept this pass's copy (`access_sweep17.out.json`).

## What I did NOT check (and why)
- **Any real processor, email or SMS service.** Stripe and Sola are modelled on their documented behaviour. Nothing is live.
- **What is deployed.** Migrations 255–283 and the functions are not live yet.
- **The whole Link page with a real parent login** (there's no test parent login). I ran its auto-reload card and functions against the real database function.
- **A real staff-tip dispute or refund** (TED-176 is from reading the code).
- **Payroll's youth-employment rules and the overtime question.** The pay maths has no overtime at all. Whether your non-counselor staff (kitchen, maintenance) are owed overtime is a legal question, not something I can check.
- **The bank-email parser** (reading each bank's email wording). I tested only the matcher's decision.
- **Two office computers recording or removing payments for the same family at the same moment.**
- **The canteen register's daily limit using the tablet's own date**, and restocking.

## Things only you can check (click-by-click)
1. **Owner steps (still pending):**
   - Supabase → **SQL Editor** → paste migrations **255 to 283 in order**, each one → **Run**. Paste **281 again** even if you pasted it last time: it changed, and the checking script can't tell (TED-173).
   - Then paste `scripts/verify_identity_chain.sql` → **Run**. Every row should say "ok".
   - **281 must be in before `stripe-webhook` is deployed. 283 must be in before the register (Snacks POS) is reloaded.**
   - Supabase → **Edge Functions** → deploy the functions listed in last report (changed since: `stripe-webhook` for the 281 part).
   - For `stripe-webhook` and `charge-due-installments`: open each → **Settings** → **"Enforce JWT Verification" OFF**.
   - Reload Me, Snacks and the register on the office computers and tablets.
2. **Until TED-165 is fixed:** don't use "Split between payers" for a family on autopay. Instead, add the household's share as the charge and track the fund's share outside Campistry.
3. **Until TED-163 is fixed:** in Finance → Revenue → Payment Log, only press ✕ on a cheque, cash, Zelle or bank-transfer payment you typed in yourself by mistake. Never press it on a row with a minus sign (a refund) or a row whose method says "Other".
4. **Until TED-166 is fixed:** in **Payroll → Pay Runs → New Pay Run**, don't accept the default dates. Set **From** to the day after your last run ended and **To** to the last Saturday that is fully over.
5. **Until TED-164 is fixed:** after any Supabase outage, open Stripe Dashboard → **Payments**, and for each payment from the outage window check that the family, the canteen wallet or the photo purchase shows it in Campistry.
6. **Until TED-171 is fixed:** after exporting sales from an offline tablet, check the file actually reached the office computer and was imported before anyone clears the tablet.
7. **Staff tips (TED-162, TED-176):**
   - Stripe Dashboard → **Help → Contact support**. Ask your fee question (last report).
   - Also ask: "When a destination-charge tip is refunded or disputed, how do we reverse the transfer from the staff member's account?"
8. **Platform alert email:** Supabase → Edge Functions → **Secrets**: check `RESEND_API_KEY` is set.
