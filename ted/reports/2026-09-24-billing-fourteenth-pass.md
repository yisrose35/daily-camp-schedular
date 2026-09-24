# Ted's report: billing, fourteenth pass (re-check TED-134 and TED-136 to TED-142, then a hunt), 2026-09-24

## Verdict: 🔴 Problems found

**Can you be 100% certain billing is right? No, not yet.**

**Seven of the eight fixes I re-checked work, and I'm closing them** (TED-134, 136, 137, 138, 139, 140, 141). I proved each one myself: in a real browser on the real Billing page, with the real refund and webhook functions on a real database.
- **"Refund it again from Billing" after a failed refund now really refunds.** It still works when the second and third refunds fail too, and when Stripe can't be reached (the office is told, nothing is booked).
- **Billing now shows the real reason** when something is refused, for example "Only the camp owner or an admin can confirm a Stripe autopay payment." It no longer says "Edge Function returned a non-2xx status code".
- **The platform gets one email per failed refund**, not four.
- **Canteen refunds stay fast at very large camps.** Nothing else about them changed.
- **No surcharge is put on a debit card.**
- **When a surcharged payment is refunded, the surcharge's share now comes off the bill.**

**One fix is only partly done (TED-142, the balance floor).**
- Card refunds now return the whole balance. That part works.
- But Me's season close-out now **fails outright** for a child whose parent set a floor. Before the fix it at least returned everything above the floor.
- Money put on in cash under a floor still can't be given back.

**And I found a new serious problem: canteen auto-reload keeps charging parents after camp is over (TED-143).**
- The office runs Refund All at the end of the season. Within 30 minutes, auto-reload charges the parent's card $20 again.
- A parent on a weekly reload is charged every week, all year.

I also found four middle-sized problems and four smaller ones (listed below). I did not change any code. I only reported.

## The numbers
Tests run: 3,797 · Passed: 3,783 · Failed: 14 (real bugs: 14, all of them the deferred auto-scheduler tests, TED-005 · out-of-date tests: 0 · my machine: 0)

| Suite | Run | Passed | Failed |
|---|---|---|---|
| Unit tests (`npm test`) | 3,586 | 3,572 | 14, all in `auto_full_day.test.js` (TED-005, deferred by you) |
| Database tests (`npm run test:pg`) | 67, against 126 migrations | 67 | 0 |
| `test:keys` | 42 | 42 | 0 |
| `test:lite` | 12 | 12 | 0 |
| `test:smoke` | 32 + 34 (the Snacks browser test) | 66 | 0 |
| `test:scale` | 24 | 24 | 0 |

These match the builder's figures exactly (claim 11).

**The builder's new tests, run against the code from before the fixes** (`fef6edb`, in a scratch copy outside the project, removed afterwards; logs `oldcode_*.log`):
- `stripe_refund_failed`: 9 fail.
- `card_surcharge_billing`: all 5 fail.
- `canteen_refund_scale`: all 3 fail. The old code took 3,323 ms where the budget is 2,000 ms.
- `autopay_confirm_stripe`: the 1 new test fails.
- `card_fees` 2, `closeout` 1 and `canteen_and_payout_alerts` 1 also fail (the rule changes).
- So the new tests do test the new behaviour. That matches claim 12.

**Mutation checks** (`mutations.log`):
- The new database tests 275 and 278 both fail on the earlier 275/278.
- Today's 278 with the "alert once" rule removed fails: "TED-137: the no-camp alert is not once-only".
- Today's 278 with the canteen-hold look-up removed fails ("TED-138: the waiting canteen refund's notice…").
- Today's files unchanged pass.

**Two gaps in the builder's tests:**
- The test for "a card refund takes the surcharge's share off the bill" only checks that some lines of text exist in the file. My browser probe is what pressed the button.
- Nothing tests Me's close-out actually applying the canteen step. That is how the floor regression in TED-142 got through.

**Every earlier billing probe, re-run at today's code:** 97 probe files from passes 1 to 13 (`rerun_all_probes.sh`, outputs in `rerun/`).
- **84 ran cleanly.**
- **13 stopped early.** 10 are the same 10 as last time, and all have working replacements. The other 3 are my own thirteenth-pass probes that were built around the old function shapes. This pass replaces them (`access_repaste_278.js`, `canteen_index_cpu.mts`).
- **Of the 97 outputs** (ids and times masked), 87 are identical to last pass. The 10 that differ are all explained:
  - the new notice wording (TED-138);
  - the new Take Out Cash wording (TED-142);
  - the refund window answering in a tenth of the time, with the same figures (TED-139);
  - a clock time and some timings;
  - the three replaced probes.
- **The four earlier Snacks browser probes:** 3 give identical output. The 4th stops at the same step as last pass.
- **The browser access sweep:** still the same 97 money functions a browser can call, with the same gates.

**New probes** are in `ted/probes/2026-09-24-billing-14/`:
- 8 browser probes on the real pages;
- 6 on real functions with a real database;
- 1 timing and same-answers check.

## What's wrong (most serious first)

### TED-143 🔴 Canteen auto-reload keeps charging parents after camp is over
- **What a user would see:**
  - A parent turns on Auto-Reload in Link: "when the balance drops below $5, add $20". They save a card and leave the optional "Active dates" empty, which is how the form starts.
  - Camp ends. The office runs Snacks → Refund All. The parent gets their $30 back and the wallet is $0.
  - **On the next run of the auto-reload job (it runs every 30 minutes), the parent's card is charged $20**, and the $20 lands back on the wallet.
  - If the office refunds that too, the next day's run charges $20 again. Every refund is followed by a new charge.
  - A parent who chose a weekly reload ("every Thursday, add $25") is **charged $25 every week**, through autumn and winter.
- **Why nothing stops it:**
  - The job runs every day of the year (the setup guide's schedule).
  - It never looks at the camp's or the session's dates.
  - Refund All and Me's season close-out don't pause auto-reload.
  - The office has no screen to switch a parent's auto-reload off.
- **How sure I am:** Confirmed, with the real Refund All, the real auto-reload job (called the way the schedule calls it) and the real webhook, on a real database.
- **Proof:**
  - `autoreload_after_season.log`:
    - A1: `Refund All: $30 … Avi's wallet $0`;
    - A2: `runner: Avi threshold $20 → charged`, then `A3 … Avi's wallet $20`;
    - A4: a second Refund All, then `runner (next day): Avi threshold $20 → charged`, `charges to the parent's card: $20 from cus_avi, $20 from cus_avi`;
    - A5: `week 1 … charged / week 2 … charged / week 3 … charged` → `$25, $25, $25`.
  - **Code:**
    - `supabase/functions/canteen-auto-reload/index.ts:227` (no dates means always active) and `:262` (what is due);
    - `migrations/243_…sql` `canteen_autoreload_accounts` (every account with auto-reload on, whatever the season);
    - `CANTEEN_AUTORELOAD_SETUP.md:128` (`'*/30 7-18 * * *'`, every day);
    - `campistry_link_parent.html:2558-2559` (dates optional, blank by default).
  - The same guide also tells you to test the job from **PowerShell** (`:145`), which you can't use.
- **What to ask the builder for:** "TED-143: canteen-auto-reload charges parents after camp ends — right after Refund All (threshold reloads) and every week (scheduled reloads) — because an auto-reload with no Active dates never stops and nothing ties it to the season. Stop auto-reload outside the camp's session dates (and pause it when Refund All or the season close-out empties a wallet, telling the parent), default the Link form's stop date to the session end, give the office a way to switch it off, and replace the PowerShell test steps in CANTEEN_AUTORELOAD_SETUP.md with dashboard steps."

### TED-144 🟠 A family paying by bank can be debited twice for one bill from Billing's "Charge Card"
- **What a user would see:**
  - Iron pays by bank account; it is Iron's default method. On office computer A, the office presses Billing → Iron → Charge Card for the $1,000 owed.
  - The bank debit starts. Bank debits take several business days. The office sees a red **"✕ Payment status: processing"**, which looks like a failure.
  - Billing still shows **"Balance due: $1,000 · Card on file ✓"**. The debit on its way is recorded only as "pending", which doesn't count.
  - Another staff member presses Charge Card again. So does anyone on another computer, or on the same computer the next day. **A second $1,000 debit starts.** Iron is debited $2,000 for a $1,000 bill.
  - The only guard is a note kept in the first computer's own browser, for 23 hours.
  - The nightly autopay had the same problem and was fixed (TED-064). This office button was not.
- **How sure I am:** Confirmed, with two office computers (two separate browsers) on the real Billing page, the real charge function and the real webhook.
- **Proof:**
  - `ach_charge_twice.log`:
    - A1: `toast ["✕ Payment status: processing"]; debits started: pi_1 pm_bank $1000.00`;
    - A2: `payment rows: pi_pi_1 $1000 pending; Iron owes $1000`;
    - A3: the window `Balance due: $1,000 · Card on file ✓`, then `debits started: pi_1 pm_bank $1000.00, pi_2 pm_bank $1000.00`.
  - **Code:**
    - `campistry_me.js:19312` (the only memory of an earlier charge is this browser's);
    - `:19420` (processing shown as an error);
    - `supabase/functions/stripe-webhook/index.ts:1004` (processing is recorded as pending, which doesn't count).
- **What to ask the builder for:** "TED-144: Charge Card for a family whose default method is a bank account can start a second debit from another computer (or after 23 h) while the first is still processing — Billing shows the full balance due and a red '✕ Payment status: processing'. Treat a pending (processing) payment as money on its way: show it, take it off what Charge Card and Batch charge offer, refuse a second charge for the same family while one is processing, and word it as 'on its way — bank debits take a few days'."

### TED-142 🟠 (still open, partly fixed) The balance floor at the end of the season
- **What's fixed:** card refunds now return the whole balance, floor and all:
  - Stripe and Sola;
  - one child and Refund All;
  - the Refund window offers the whole amount.
- **What a user would see now, problem 1 (new, caused by the fix):**
  - Me → Billing → a family → Close out… now offers the child's whole $50.
  - The office picks "Hand back in cash", "Send a cheque" or "Donate to the camp" and presses Apply. It reads **"Could not take canteen money off: Avi Katz (over_available) — do it from the Canteen page"** and **nothing** is taken off.
  - Before the fix, the same close-out took $40 and left the $10 floor.
  - The close-out goes through the same till cash-out as Take Out Cash, and that still keeps the floor.
- **Problem 2 (not fixed): money put on in cash under a floor still can't be given back.**
  - Take Out Cash stops at the floor and now says "refund it to the card (Refund) instead".
  - For a child whose money came in cash, the card Refund answers "This balance has no Stripe-paid deposits left to refund online — it came from cash/manual deposits and must be refunded that way instead."
  - The last $10 has no way out.
- **How sure I am:** Confirmed (real browser for the close-out, real functions and real database for the rest).
- **Proof:**
  - `floor14_realdb.log` F1–F3 and `floor_sola_realdb.log` S1–S3: $50 back, wallet $0.
  - `closeout_floor.log` K1/K2 (daily cash limit switched off): `"✕ Could not take canteen money off: Avi Katz (over_available)"`, `wallet now $50`.
  - The same probe on the pre-fix page (`oldcode_closeout_floor.log`) K1/K2: `"✓ 1 close-out step applied"`, `cash_out $40.00`, wallet $10. K3 (no floor) works on both.
  - `floor14_realdb.log` F5 (the cash-funded case).
  - **Code:**
    - `campistry_me.js:2109` (the whole balance offered), `:2318` (every canteen close-out step goes through `canteen_office_cash_out`);
    - `migrations/240_…sql:331` (that cash-out keeps the floor);
    - `campistry_snacks_cash.js:79`, `:119` (the new advice).
  - My thirteenth-pass floor probe stood in for the database rule with its old behaviour, so it could not judge today's fix. I replaced it with one that uses the real database.
- **What to ask the builder for:** "TED-142 (continued): card refunds now return the whole balance, but (1) Me's close-out now offers the whole balance while canteen_office_cash_out still keeps the floor, so a cash, cheque or donate close-out step for a child with a floor fails outright ('over_available') where it used to take balance minus floor; (2) cash-funded money under the floor still can't be returned — Take Out Cash says 'refund it to the card' and the card refund says it came from cash. Let the office's end-of-season write (and the close-out) take the whole balance, and add a test that applies a close-out with a floor."

### TED-145 🟠 Me's season close-out can't take a child's canteen money off with the Snacks default settings
- **What a user would see:**
  - Billing → a family → Close out… The child has $50 of canteen money. The office picks "Hand back in cash", "Send a cheque" or "Donate to the camp" → Apply.
  - With Snacks' default settings (a $20-a-day cash-out limit per child), **nothing is taken off**. The office reads "Could not take canteen money off: Avi Katz (over_available) — do it from the Canteen page".
  - The Canteen page's Take Out Cash has the same $20-a-day limit, so $50 takes three days.
  - A cheque or a donation isn't cash leaving the till, but it gets the child's daily cash limit anyway. "over_available" is also not words the office can act on.
  - This was already so before today's changes: the same result on the old code.
- **How sure I am:** Confirmed in a real browser with the real database.
- **Proof:**
  - `closeout_floor.log` K0: all three choices end with `"✕ Could not take canteen money off: Avi Katz (over_available)"` and `wallet now $50`. The same in `oldcode_closeout_floor.log`.
  - **Code:** `campistry_me.js:2318`; `migrations/240_…sql:139` (default `cashDailyMax` 20) and `:349`.
- **What to ask the builder for:** "TED-145: _applyCloseout sends every canteen close-out choice (cash, cheque, donate) through canteen_office_cash_out, which applies the child's daily cash limit ($20 by default) and refuses the whole amount with 'over_available' — give the close-out its own write that isn't bound by the till's daily cash limit (or the floor, see TED-142), and show readable words instead of 'over_available'."

### TED-146 🟠 The surcharge's share of a refund is worked out across all of a family's payments, not the one that carried it
- **What a user would see:**
  - **Bronze:**
    - Bronze paid a $500 deposit by card at registration, with no surcharge. Later Bronze paid the $3,000 balance by credit card, plus a $90 surcharge: $3,090.
    - Bronze withdraws. The camp keeps the deposit and refunds the $3,090 payment in full.
    - Stripe returns all $3,090 to the card, but Billing takes only **$77.47** of the surcharge off Bronze's bill. **$12.53 of surcharge stays on the bill for a card payment that was completely refunded.** The project's own rule (`refundShare`) says the whole $90 goes back.
  - **Copper:**
    - Copper paid the surcharged $1,030 by card, and later $2,000 by bank.
    - A $500 refund comes out of the bank payment (Billing refunds the newest payment first). Yet Billing takes **$4.95** of the card surcharge off the bill.
  - **The window before pressing:**
    - It says "Balance owed after this refund: $1,000".
    - The result is $970.87: the preview leaves out the surcharge's share.
- **How sure I am:** Confirmed in a real browser, with the real refund function.
- **Proof:**
  - `surcharge14.log`:
    - S1 (one payment) is right: `$29.13 … Silver now owes $970.87`, but the preview said `$1,000` (S1b);
    - S2: `Refunded $3,090 … $77.47 of it was the card surcharge … Bronze now owes $3012.53`;
    - S3: `card payment none; bank payment re_3 $500 … credits on Copper's bill: $4.95`.
  - **Code:**
    - `campistry_me.js:18735` (`_paidBefore=onlineTotal`, all of the family's refundable online payments);
    - `:18473` (the surcharge is counted family-wide, not per payment);
    - `:18575` (the preview).
- **What to ask the builder for:** "TED-146: Billing works out the surcharge's share of a refund as fee × refund ÷ ALL the family's refundable online payments (campistry_me.js:18735), so a fully refunded surcharged payment leaves part of its surcharge on the bill ($12.53 of $90) and a refund of an un-surcharged bank payment returns part of it ($4.95). Tie each surcharge to the payment that paid it and share it per refunded payment; and make 'Balance owed after this refund' include the fee's share."

### TED-147 🟠 A card surcharge can still end up collected from a bank account
- **What a user would see:**
  - Iron pays by bank on autopay; the bank account is Iron's default method. Iron once saved a credit card as well.
  - The office opens Add card surcharge… The window says "Card on file: Visa ···· 1111 (credit)". Save gives "✓ Card fee of $30 added to Iron".
  - The office presses Charge Card. It takes **$1,030, surcharge included, from Iron's bank account**, because Charge Card always uses the default method.
  - A card surcharge collected by bank debit is what the card brands' rules forbid.
  - The window's advice ("If the family ends up paying another way, remove this fee") doesn't tell the office that Charge Card will use the bank.
- **How sure I am:** Confirmed in a real browser with the real charge function.
- **Proof:**
  - `surcharge_default_bank.log`:
    - `toast ["✓ Card fee of $30 added to Iron"]; Iron's ledger [charge tuition $1000, charge fee $30]`;
    - then `what Stripe was asked to take, and from which method: pm_bank $1030.00`.
  - **Code:** `campistry_me.js:2444` (when the default isn't a card, the only card counts) and `:19353` (Charge Card sends the default method).
- **What to ask the builder for:** "TED-147: Add card surcharge takes a family's only saved card as 'the card' even when their default payment method — the one Charge Card and autopay use — is a bank account, so the 3% fee is then collected by bank debit. Only surcharge when the method that will actually be charged is a credit card (or make that charge use the card)."

### TED-148 🟡 A refund that fails later keeps the surcharge's share credited
- **What a user would see:**
  - Slate paid $1,030 ($1,000 + $30 surcharge). The office refunds $1,000, and $29.13 of the surcharge comes off Slate's bill.
  - Three days later Stripe fails the refund, and Campistry puts the $1,000 back. **The $29.13 stays credited, so Slate shows $29.13 in credit for a refund that never reached the card.**
  - If the office refunds again, another $0.84 is taken off. That is $29.97 in all, where one successful refund means $29.13.
- **How sure I am:** Confirmed in a real browser with the real refund function and the real webhook.
- **Proof:** `surcharge14.log` S4: `owes $-29.13 … credits $29.13`, then after the second refund `credits $29.13 + $0.84; Slate owes $970.03`.
- **What to ask the builder for:** "TED-148: when 278 puts a failed Stripe refund back, the card-surcharge credit Billing posted with that refund (cardFeeReturn) stays, leaving the family $29.13 in credit for a refund that never happened; reverse it with the put-back."

### TED-149 🟡 Registration's "Charge $250 now" says "The card was declined" for any refusal
- **What a user would see:**
  - Registration shows a "Charge $250 now" button on an application whose deposit wasn't taken. The button shows for anyone who can open Registration.
  - A **manager** presses it. The server refuses ("Only the camp's owner or an admin can charge a deposit."), but the office reads **"The card was declined"**.
  - The same happens when the server can't find the application.
  - An office that believes it could tell a family their card was declined when it wasn't even tried. This is TED-134's twin: Billing was fixed, this button was not.
- **How sure I am:** Confirmed with the project's own Supabase library in a real browser, the real deposit function, and the page's real code.
- **Proof:** `deposit_error_text.log`: D1 `the server answered: 403 {…"Only the camp's owner or an admin can charge a deposit."}` → `the office reads: ["Charging…","The card was declined"]`; D2 404 → the same. Code: `campistry_me.js:20142`.
- **What to ask the builder for:** "TED-149: chargeDepositNow (campistry_me.js:20113–20142) reads only r.data, so any refusal sent with an error status (manager 403, application not found 404, server 500) shows 'The card was declined' — show the server's own reason (as callEdgeFunctionAuthed now does), and hide the button from people who can't use it."

### TED-150 🟡 If the failed-refund alert email fails to send, it is never sent
- **What a user would see:**
  - Nothing, and that's the problem. Campistry now claims each failed-refund alert once, **before** sending the email. If the email service is down at that moment, the email fails and Stripe's re-sends find the alert already claimed.
  - So the platform is never told to pass that money back to the camp.
  - For a camp Campistry knows, the camp's notice even says "Campistry has been alerted".
- **How sure I am:** Confirmed with the real webhook and an email service that fails once.
- **Proof:** `alert_email_fails.log`: `send attempts that failed: 1; alert emails that went out: 0` for both the no-camp path (TED-137's) and the known-camp path, over 4 deliveries. Code: `stripe-webhook/index.ts:832-834` and `:643-659` (a failed send is only logged).
- **What to ask the builder for:** "TED-150: stripe-webhook takes the once-only claim for a failed-refund platform alert before sending it, and a failed send is only logged — so one email-service hiccup means the alert never goes out; release the claim (or return 500 so Stripe re-sends) when the email doesn't send."

### TED-151 🟡 The check script can't tell whether an earlier copy of 275 was pasted
- **What a user would see:**
  - 275 was changed again today without a new number. If the earlier copy had been pasted, the check script would still say "ok", and refunds would keep holding back the floor.
  - Nothing is live yet, so this only matters if a copy was pasted in between.
- **How sure I am:** Confirmed on a scratch database.
- **Proof:** `check_script_275.log`: the earlier 275 refuses $50 with a $10 floor (`available 40.00`), and the check script still says `ok`.
- **What to ask the builder for:** "TED-151: scripts/verify_identity_chain.sql's 275 row passes the earlier 275 (which kept the balance floor back from refunds); make it check the current rule, as the 260/261/270 rows do."

## Re-check of last report's findings
| ID | Now | My proof |
|----|-----|----------|
| TED-136: refund-again replayed the failed refund | **Closed** | Real browser, my unchanged probe (`rerun13_billing_refund_again.log`): B3 `✓ Refunded $500`, `Stripe sent back $500 [re_1 $500 failed, re_2 $500 succeeded]`; B4: the window no longer offers it. (B5, the $300 control, is now moot: nothing is left to refund.) New `billing_refund_again14.log`, 8/8 checks: third refund after two failures (`after:re_2 → re_3`); Stripe's later messages don't book anything twice; Stripe unreachable → `"Refund failed: Stripe could not be asked…"`, nothing sent or booked; then a single new refund. Builder tests fail on the old code. |
| TED-134: Billing showed "Edge Function returned a non-2xx status code" | **Closed** (twin → TED-149) | The project's own `supabase-js@2.js` in Chromium with the real functions (`rerun13_billing_error_text.log`): `"Not recorded: Only the camp owner or an admin can confirm a Stripe autopay payment."`, `"Refund failed: Refund amount ($600.00) is greater than unrefunded amount on charge ($500.00)"`, `"Charge failed: No payment method on file for this customer"`. The builder's test fails on the old code. |
| TED-137: four alert emails for one failure | **Closed** (follow-up → TED-150) | Real webhook and real database (`refund_failed_realdb14.log` N): `emails per delivery 1/0/0/0`. pgtest 278 fails with the once-only rule removed. |
| TED-138: wrong advice for Campistry's own waiting canteen refund | **Closed** | `refund_failed_realdb14.log` W3: "A canteen refund failed … It was a canteen refund of Avi's money that Campistry was still waiting to hear about … the next Refund All … sends it again. Do NOT refund it by hand as well". The next Refund All sent it once (`re_24`). pgtest 278 fails with the hold look-up removed. |
| TED-139: canteen refund maths too slow at large camps | **Closed** | `canteen_index_cpu.log`: at 1,500 children × 20 top-ups, 50 ms or less for each of the four (was 2.9–3.2 s at 1,000 × 15). Answers identical to the old code on 4,000 of 4,000 random comparisons, once the two deliberate rule changes are left out (no floor; failed-refund rows only on Stripe payments). Builder's scale test fails on the old code (3,323 ms). |
| TED-140: surcharge on a debit card | **Closed as asked** (harder case → TED-147) | Real browser, my unchanged probe (`rerun13_surcharge.log` C1): window `Debit and prepaid cards are never surcharged`, `Card on file: Visa ···· 4242 (debit)`, no fee added. Unknown card type: builder's test runs the page's own code. |
| TED-141: surcharge share never refunded | **Closed for one surcharged payment** (residuals → TED-146, TED-148) | Real browser and real refund function (`surcharge14.log` S1): `"✓ Refunded $1,000 … — $29.13 of it was the card surcharge, taken off their bill"`, owes $970.87. The refund window now names the surcharge (`rerun13_surcharge.log` C2). |
| TED-142: balance floor kept back | **Still open, partly fixed, now 🟠** | See above: card refunds fixed (`floor14_realdb`, `floor_sola_realdb`); close-out now fails outright (`closeout_floor` vs `oldcode_closeout_floor`); cash-funded money still stuck. |
| TED-005: auto-scheduler | Open, deferred | Still 14 failing, all in `auto_full_day.test.js`. Not investigated. |

## What I confirmed is working
- **The builder's claims 1–13:** each checked above or here. Claim 8's close-out part holds only on screen, not when applied (TED-142).
- **Nobody can call the new or changed database functions from a browser** (`access_repaste_278.log`):
  - `claim_refund_failure_alert`: server only;
  - the 6-argument `reverse_failed_stripe_refund`: server only;
  - `_notice_unbooked_refund_failure`: not callable by anyone directly;
  - the new `refund_failure_alerts` table: no browser read or write, and row security is on.
- **The list of money functions a browser can call is unchanged:** 97, same gates (`rerun/access_sweep.out.json`).
- **Pasting 278** over either earlier copy (3-argument or 5-argument) leaves exactly one version of each function. The check script says "apply 278" before and "ok" after, also when pasted a second time.
- **Sola canteen refunds with a floor** return the whole balance (`floor_sola_realdb.log`).
- **Take Out Cash wording:** "Only $40.00 available to take out — the other $10.00 is under the balance floor; refund it to the card (Refund) instead". When the daily limit is the cap, it doesn't blame the floor (builder's test).
- **Browser caching:** each changed file loads with its new number wherever it is used:
  - `campistry_me.js?v=20260924-23` (1 page);
  - `campistry_snacks.js?v=20260924-08` (1 page);
  - `campistry_snacks_cash.js?v=20260924-01` (both Snacks pages).
  - There is no service worker.
- **Leftovers:** no secrets, debug switches or TODOs in the 26 changed files. One new server log line, which is intended.
- **Setup guides:** `BILLING_PAYMENTS_SETUP.md` has no command-line steps. The Stripe events are unchanged. The auto-reload guide's PowerShell step is noted in TED-143.
- **The surcharge credit and the tax statement:** the new credit only settles charges in the tax report, so it does not change what counts as care.

## What I did NOT check (and why)
- **Any real processor.** Stripe and Sola are modelled on their documented rules. I could not open their documentation from this machine.
- **Supabase's real processing speed.** TED-139's timings are this machine's processor in Node, not Supabase's servers.
- **What is deployed.** Migrations 255–279 and the functions are not live yet.
- **Whether you have set up the auto-reload schedule (TED-143) and when it runs.** I used the schedule written in the guide.
- **Whether Resend delivers alert emails** (TED-150 was tested with a pretend email service).
- **Sola same-day refunds.** Unchanged from last report.
- **Areas no billing pass has deep-audited yet:**
  - payroll;
  - POS register maths;
  - Link photo purchases;
  - staff tips;
  - splitting a family;
  - the bank-email matcher;
  - the convenience-fee and cash-discount card-fee modes (only the surcharge was tested).

## Things only you can check (click-by-click)
1. **Owner steps (still pending, unchanged):**
   - Supabase → SQL Editor → paste migrations **255 to 279 in order**, each one → Run.
   - Then paste `scripts/verify_identity_chain.sql` → Run. Every row should say "ok".
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
2. **The Stripe events (unchanged):**
   - Stripe Dashboard → Developers → Webhooks → your `stripe-webhook` endpoint → **⋯ → Update details**.
   - Make sure `refund.failed`, `refund.updated` and `charge.refund.updated` are ticked, with the rest of the list in `BILLING_PAYMENTS_SETUP.md` step 5 → **Update endpoint**.
3. **Until TED-143 is fixed, don't schedule canteen auto-reload, or turn it off at the end of camp:**
   - Supabase → **Integrations → Cron** (or **Database → Cron Jobs**, depending on your dashboard).
   - Find `campistry-canteen-autoreload` → **Deactivate** (or delete it) on the last day of camp, **before** running Refund All.
   - If it isn't set up yet, don't set it up until the fix is in.
4. **Until TED-144 is fixed:** for any family whose card on file is a bank account, press Charge Card **once**. If Billing shows "Payment status: processing", the money is on its way (a few business days). Check Stripe Dashboard → Payments for that customer before anyone presses it again.
5. **At the end of the season, until TED-142 and TED-145 are fixed:**
   - Return canteen money with Snacks → **Refund All** (card-funded money) or Take Out Cash, not with Me's Close out…
   - For a child whose parent set a Balance Floor, ask the parent to set it to $0 in Link first.
6. **Don't switch on the credit-card surcharge until TED-146 and TED-147 are fixed.** In Me → Registration → **Registration Form** → **Card Fees**, leave it on "Nothing passed on", or use one of the other two choices.
7. **Platform alert email:** Supabase → Edge Functions → Secrets: check `RESEND_API_KEY` is set. Until TED-150 is fixed, also look at Stripe Dashboard → **Payments → Refunds**, filtered to **Failed**, once a week.
