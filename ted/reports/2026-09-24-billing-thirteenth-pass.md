# Ted's report: billing, thirteenth pass (re-check TED-129 to TED-135, then a hunt), 2026-09-24

## Verdict: 🔴 Problems found

**Can you be 100% certain billing is right? No, not yet.**

**Six of the seven fixes I re-checked work, and I'm closing them** (TED-129, 130, 131, 132, 133, 135). I proved each one myself, in a real browser on the real Snacks and Billing pages, wired to the real refund functions and a real database.
- **Old canteen top-ups can now be refunded to the card.** A $30 top-up from 40 days ago is offered and really goes back to the parent. Refund All refunds two children's old top-ups, each from their own payment.
- **After a failed canteen refund is put back, Refund All sends it again.**
- **Refund All's figures now match what it does,** and it says what happened to refunds that were still waiting.
- **The platform is now alerted about every failed refund,** including ones Campistry hadn't booked.
- **A failed dashboard refund is no longer booked by mistake** on older Stripe setups.

**But one fix leads straight into a new serious problem (TED-136).**
- After a failed tuition refund is put back, Billing now offers "$500 refundable to card/bank". The notice tells the office to do exactly that.
- The office presses Refund and is told **"✓ Refunded $500 to card/bank for Gold". Nothing is sent to Stripe.** The server answers with the old, failed refund instead.
- The parent never gets the money. Each press adds another $500 refund to the history.

I also found two middle-sized problems:
- A **card surcharge can be put on a family whose card is a debit card** (not allowed by the card brands).
- **Very large camps may hit Supabase's processing-time limit** on canteen refunds.

There are also five smaller ones. One is TED-134, which is still half open: the new "owner only" wording in Billing never reaches the screen.

I did not change any code. I only reported.

## The numbers
Tests run: 3,784 · Passed: 3,770 · Failed: 14 (real bugs: 14, all of them the deferred auto-scheduler tests, TED-005 · out-of-date tests: 0 · my machine: 0)

| Suite | Run | Passed | Failed |
|---|---|---|---|
| Unit tests (`npm test`) | 3,573 | 3,559 | 14, all in `auto_full_day.test.js` (TED-005, deferred by you) |
| Database tests (`npm run test:pg`) | 67, against 126 migrations | 67 | 0 |
| `test:keys` | 42 | 42 | 0 |
| `test:lite` | 12 | 12 | 0 |
| `test:smoke` | 32 + 34 (the Snacks browser test) | 66 | 0 |
| `test:scale` | 24 | 24 | 0 |

These match the builder's figures exactly (claim 9).

**The builder's new tests, run against the code from before the fixes** (`f3ee2ed`'s seven product files, in a scratch copy outside the project, removed afterwards):
- 13 unit/function tests fail: 11 in `stripe_refund_failed`, 1 in `autopay_confirm_stripe`, 1 in `canteen_held_refunds`. That matches claim 10.
- The browser test fails 3 checks: it shows "$25.00" where $35.00 is right.
- **Mutation checks** (`mutations.log`):
  - pgtest 278 fails on the earlier 278 ("no Billing notice for the failed canteen refund").
  - It also fails on today's 278 with only the TED-129 line removed ("TED-129: the put-back refund's reservation still says it was sent").
  - It passes on today's 278 unchanged.

**The builder's tests have one gap.** The TED-132 test only checks what the refund window *offers*. Nobody pressed the button. That is how TED-136 got through.

**Every earlier billing probe, re-run at today's code:** 90 probe files from passes 1 to 12 (`rerun_all_probes.sh`, outputs in `rerun/`).
- **80 ran cleanly.**
- **10 stopped early.** They are the same 10 as last time, and all have working replacements.
- **Of the 86 outputs I could compare with last pass** (ids and times masked), 83 are identical. 3 differ, all as expected:
  - Sola's refund answer now also carries the new "refundable" figures;
  - a clock time;
  - a timing.
- **The 4 twelfth-pass probes now in the sweep for the first time** match their own outputs. The only differences are a new `firstNotice` field and the manager wording.
- **The eleventh-pass Snacks browser probe** gives the same output as last time.

**New probes** are in `ted/probes/2026-09-24-billing-13/`:
- `billing_refund_again.e2e.js`: the real Billing page in a browser. Real `stripe-refund` and `stripe-webhook` on a real database, and a pretend Stripe that follows Stripe's documented rules. This found TED-136.
- `snacks_recheck.e2e.js`: the real Snacks page with the real canteen refund functions. It covers TED-130, TED-135, and the manager side of TED-134 (8 of 8 checks pass).
- `billing_error_text.e2e.js`: the project's own copy of the Supabase library in Chromium, answered by the real functions. This shows what the Billing page actually displays (TED-134).
- `refund_failed_realdb.js`: my twelfth-pass database probe, updated. It covers TED-129, 131, 132 and 133, plus alert counts.
- `surcharge.e2e.js`: the real Billing page, surcharges (TED-140, TED-141).
- `floor_left_behind.js`: the balance floor at the end of the season (TED-142).
- `refundable_cpu.mts`, `refundall_cpu.mts`, `refundable_scale.js`: processing time at large camps (TED-139).
- `access_new_fn.js`, `repaste_278.js`: who can call the new database functions; pasting 278 again.

## What's wrong (most serious first)

### TED-136 🔴 "Refund it again from Billing" after a failed refund says it worked but sends nothing
- **What a user would see:**
  - Gold paid $500 by card. The office refunds it. Three days later Stripe fails the refund (the card account was closed).
  - Campistry puts the $500 back on Gold's account. The Billing notice says **"refund it again from Billing, or ask the family for other bank details."**
  - The office opens Billing → Issue Credit/Refund → Direct Refund. It now says **"$500 refundable to card/bank"**. They press Save.
  - The office sees **"✓ Refunded $500 to card/bank for Gold"**, and Billing's history gets a new "−$500 refund" line.
  - **Stripe was never asked, and the parent gets nothing.** The window still offers $500. Each press adds another −$500 line, each pointing at the old failed refund.
  - Gold's balance itself doesn't move, so nothing on the account screen looks wrong.
  - **Why:** the second refund carries exactly the same internal key as the first (same payment, same amount left, same amount). The server has kept the first refund's answer under that key forever, so it hands back the old, failed refund instead of asking Stripe.
  - Refunding a different amount ($300) works normally. The same-amount case is exactly the one the notice asks for.
- **How sure I am:** Confirmed in a real browser, with the real refund and webhook functions on a real database.
- **Proof:**
  - `billing_refund_again.log`:
    - B3: `toast: ["✓ Refunded $500 to card/bank for Gold"]`, `Stripe sent back $0 [re_1 $500 failed]`, payment rows `[…, refail_re_1 $500, ref_…_0 $-500 [re_1]]`.
    - The server's answer: `stripe-refund→200 {"replayed":true,…,"refundId":"re_1"}`.
    - The stored key: `rfnd_gold:pi_pi_GOLD1:50000:50000 → {"refundId": "re_1", "status": "succeeded"}`.
    - B4: 3 refund lines, still $0 sent.
    - B5 (control, $300): `re_2 $300 succeeded`.
  - **Code:**
    - `campistry_me.js:18677` (the key);
    - `campistry_me.js:18375` (`_refundedFrom` makes the $500 refundable again);
    - `supabase/functions/stripe-refund/index.ts:225` (the stored answer is replayed without asking Stripe);
    - `migrations/198_refund_intents.sql:97-102` (a stored answer never expires).
- **What to ask the builder for:** "TED-136: after 278 puts a failed Stripe refund back, Billing → Direct Refund for the same amount builds the same key (rfnd_<family>:<payment>:<left>:<amount>); stripe-refund's claim_refund_intent replays the old failed refund (re_1) without asking Stripe, and the page books a refund that never happened — every press adds another. In stripe-refund, when a claim's earlier refund has since failed or been canceled (GET /refunds/{id}), send a new refund under a new key (as stripe-canteen-refund does with _after_<id>); add a test that presses the button: refund → fail → put back → refund again → Stripe makes a second refund."

### TED-140 🟠 A credit-card surcharge can be added to a family whose card is a debit card
- **What a user would see:**
  - The camp surcharges credit cards 3%. Gold's only saved card is a **debit** card; Stripe said so when it was saved, and Campistry stored it.
  - The office opens Billing → Gold → **Add card surcharge…** for $1,000. The window says "Fee $30 — total with fee $1,030". It also says "Debit cards, bank transfers, cheques and cash are not charged it". Save: **"✓ Card fee of $30 added to Gold"**. Gold now owes $1,030.
  - The fee is a separate line on Gold's bill. Whatever way Gold pays (the debit card on autopay, a cheque), the $30 is collected.
  - The card brands forbid surcharging debit and prepaid cards. The project's own card-fee rules refuse it ("Debit and prepaid cards are never surcharged"), but the office button never asks them about the real card.
- **How sure I am:** Confirmed in a real browser.
- **Proof:**
  - `surcharge.log`:
    - the rules: `funding "debit" → fee $0, not_credit`; `"(unknown)" → fee $0, funding_unknown`.
    - C1: `toast ["✓ Card fee of $30 added to Gold"]; Gold's ledger now [charge tuition $1000, charge fee $30], owes $1030`.
  - **Code:** `campistry_me.js:2413` and `:2442` pass `funding:'credit'` for every family. The card type the webhook saves (`stripe-webhook/index.ts` `pmFunding`) is never read by the Billing page.
- **What to ask the builder for:** "TED-140: Add card surcharge (campistry_me.js:2413 and :2442) always quotes with funding:'credit'; use the family's saved card's funding (stored by stripe-webhook) and refuse when it is not 'credit' or is unknown, as campistry_card_fees.quote already does — and decide what happens to the fee when the family then pays another way."

### TED-139 🟠 At very large camps, canteen refunds may run out of Supabase's processing time
- **What a user would see:**
  - Since TED-130, every time the office picks a child in Snacks' Refund window, the server works out every child's refundable amount from the whole summer's history. Refund All does the same sums.
  - The work grows with the square of the history. Supabase stops a function after **2 seconds of processing** on every plan.
  - At about 1,000 children with 15 top-ups each, the sums alone take about 3 seconds.
  - When the Refund window's request is stopped, the page quietly falls back to its own week-only figure. **TED-130 comes back:** older top-ups show "$0.00".
  - Refund All could be stopped part-way. Money stays safe: unfinished refunds are held and looked up next time. But the office gets an error mid-run.
  - At 600 children with 8 top-ups each, it is about 0.4 seconds, which is fine.
- **How sure I am:** Likely. I measured the real code on this machine (a 2.1 GHz server, Node), not on Supabase. The 2-second limit comes from search results quoting Supabase's documentation ([Limits](https://supabase.com/docs/guides/functions/limits), [CPU limits](https://supabase.com/docs/guides/troubleshooting/edge-function-cpu-limits)). I could not open supabase.com from this machine.
- **Proof:**
  - `refundable_cpu.log` (the real `refundableByAccount`, processing time):
    - 600×8: 366 ms;
    - 1,000×10: 1,501 ms;
    - 1,000×15: **2,943 ms**.
  - `refundall_cpu.log` (Refund All's real `depositsFor`):
    - 1,000×10: 1,441 ms;
    - 1,000×15: **3,213 ms**.
  - **Code:**
    - `stripe-canteen-refund/index.ts:75` (for every top-up it re-reads the whole history);
    - `stripe-canteen-refund-all/index.ts:180`;
    - the fall-back is `campistry_snacks.js:1901-1903`.
- **What to ask the builder for:** "TED-139: refundableByAccount (stripe-canteen-refund, payments-canteen-refund) and Refund All's depositsFor re-scan the whole ledger for every top-up — 2.9–3.2 s of CPU at 1,000 children × 15 top-ups, over Supabase's 2 s limit, and the Snacks page then silently falls back to its 7-day figure; build one map of refunds/holds per payment reference first so it is linear, and add a scale test (1,000 × 15) with a time budget."

### TED-134 🟡 (still open) Billing still shows "Edge Function returned a non-2xx status code" instead of the reason
- **What a user would see:**
  - **Snacks half, fixed:** a manager now sees "Only the camp owner or an admin can refund canteen money to a card." in both the Refund window and Refund All. No refund request is made.
  - **Billing half, not fixed for the user:** the server's new wording is right. But the Billing page never shows any server's reason. A manager pressing "It went through" on a stuck Stripe autopay sees **"Not recorded: Edge Function returned a non-2xx status code"**.
  - The same is true for every other refusal in Billing:
    - Stripe refusing a refund shows **"Refund failed: Edge Function returned a non-2xx status code"** (the real reason: "Refund amount ($600.00) is greater than unrefunded amount on charge ($500.00)");
    - a family with no card shows **"Charge failed: Edge Function returned a non-2xx status code"** (the real reason: "No payment method on file for this customer").
  - My last report said the manager saw the old server wording. That was wrong: they saw this generic text all along.
- **How sure I am:** Confirmed, with the Supabase library file the page actually loads (`supabase-js@2.js`).
- **Proof:**
  - `billing_error_text.log`, E1, E2, E3, for example: `the server answered: 403 {"error":"Only the camp owner or an admin can confirm a Stripe autopay payment."}` then `the office reads: "Not recorded: Edge Function returned a non-2xx status code"`.
  - `snacks_manager.log` R5a/R5b (Snacks fixed).
  - **Code:** `campistry_me.js:19041` uses only `res.error.message`. The library puts the server's answer in `error.context` (`supabase-js@2.js`, `FunctionsHttpError`).
- **What to ask the builder for:** "TED-134: callEdgeFunctionAuthed (campistry_me.js:19034) throws 'Edge Function returned a non-2xx status code' and never reads the function's { error } from res.error.context — read it (as Snacks' _edgeFnErrorMessage does) so the manager's 'Only the camp owner or an admin…', Stripe's refund refusals and 'No payment method on file' reach the office."

### TED-141 🟡 When a surcharged payment is refunded, nothing gives back the surcharge's share
- **What a user would see:**
  - Silver paid $1,030 by card ($1,000 tuition + the $30 fee) and withdraws. The office opens Direct Refund. It says "$1,030 refundable" and nothing about the fee.
  - The card brands require a surcharge to be refunded in proportion: $29.13 for a $1,000 refund. The project has that rule written and tested (`refundShare`), **but no screen uses it.** The office has to know to do it by hand.
- **How sure I am:** Confirmed (browser for the window; code search for the unused rule).
- **Proof:**
  - `surcharge.log` C2: `window: "$1,030 refundable to card/bank across 1 online payment…" … no mention of the fee anywhere in the refund window`. The rule's own answer: `$29.13`.
  - `campistry_card_fees.js:258` (`refundShare`) is called only from `tests/card_fees.test.js`.
- **What to ask the builder for:** "TED-141: when a payment that carried a card surcharge is refunded, work out the surcharge's share with campistry_card_fees.refundShare (it exists but nothing calls it) and show and refund it in Billing's refund window."

### TED-142 🟡 At the end of the summer, the money under a parent's "balance floor" can't be given back
- **What a user would see:**
  - In Link, a parent can set a canteen "Balance Floor" of $0–$20: the child can't spend below it.
  - At the end of the season, **every way of returning money keeps that amount back**: the child's Refund, Refund All, Take Out Cash, and Me's season close-out.
  - Avi's $50 top-up with a $10 floor: $40 goes back to the card, and the office is told only "Capped to what was left available." Take Out Cash for the last $10 says "No available balance".
  - The office has no screen to clear a floor. Only the parent can, in Link.
- **How sure I am:** Confirmed with the real functions.
- **Proof:**
  - `floor_left_behind.log`:
    - `F1 Refund All → refunded $40`;
    - `F2 … $50 asked → refunded $40 — "Capped to what was left available."`;
    - `F3 … Take Out Cash … max $0`;
    - `$10 stays on the wallet`.
  - **Code:**
    - `stripe-canteen-refund/index.ts:92`, `stripe-canteen-refund-all/index.ts:400`;
    - `campistry_snacks_cash.js:73`, `campistry_me.js:2109`;
    - `campistry_link_parent.html:392` (the $0–$20 slider).
- **What to ask the builder for:** "TED-142: refunds, Refund All, Take Out Cash and the Me close-out all keep the parent's balanceFloor back, so up to $20 per child can never be returned at the end of the season; don't apply the floor to refunds/end-of-season payouts (or let the office clear it) and say so instead of 'Capped to what was left available'."

### TED-138 🟡 The new "failed refund not on our books" notice gives the wrong advice for Campistry's own waiting canteen refund
- **What a user would see:**
  - Refund All sends Avi's $20. The answer is lost, so the $20 is held off the wallet. Stripe then fails the refund.
  - The office's notice says **"It is not on Campistry's books… so nothing was changed here: find the payment in Stripe, then refund it again or record it by hand."**
  - But Campistry *is* holding that $20. The next Refund All puts it back and sends it again by itself; my probe shows it doing so.
  - An office that follows the notice (a Stripe-dashboard refund, or cash) and then runs Refund All could pay twice. The second card refund would usually go to the same dead card and fail again, so the real risk is small.
- **How sure I am:** Confirmed (the wording and the outcome).
- **Proof:**
  - `refund_failed_realdb.log` W3: the notice text is printed. Then `Refund All: $20, refunded 1` gives `money back $20 [re_23 $20 (FAILED), re_24 $20]`.
  - The wording is at `migrations/278_…sql:93`.
- **What to ask the builder for:** "TED-138: when refund.failed arrives for a refund whose metadata has campistryHold (Campistry's own canteen refund still waiting for its answer), the notice should say Campistry will put it back and send it again at the next Refund All — not 'nothing was changed here… refund it again or record it by hand'."

### TED-137 🟡 A failed refund with no camp emails the platform again on every delivery
- **What a user would see:**
  - For a failed refund of a payment no camp can be matched to, each Stripe message sends another "pass it back to the camp" email: refund.failed, its re-sends, refund.updated and charge.refund.updated.
  - That was 4 emails for one failure in my run. Booked and unbooked failures of a known camp email once, as intended.
  - Someone could transfer the money twice. Each email does name the refund, though.
- **How sure I am:** Confirmed with the real webhook.
- **Proof:**
  - `refund_failed_realdb.log` N: `emails per delivery 1/1/1/1`.
  - **Code:** `stripe-webhook/index.ts:831` (no once-only check on that path).
- **What to ask the builder for:** "TED-137: stripe-webhook's 'no camp found' refund-failure alert is sent on every delivery (4 emails for one failure); send it once per refund id."

## Re-check of last report's findings
| ID | Now | My proof |
|----|-----|----------|
| TED-130: old canteen top-ups not card-refundable | **Closed** | Real browser + real functions. My unchanged twelfth-pass probe S3a, a 10-day-old top-up: the Refund window says `Available to refund via Stripe: $20.00`, button on, and Refund All offers `Refund All ($20.00)` (last pass: $0.00, no button). `snacks_recheck` R1: a 40-day-old $30 top-up offered and refunded (`re_1 $30`, wallet $40 = the cash). R2: two children's 35- and 20-day-old top-ups, `Refunded $40.00 across 2 campers`, each from their own payment. Builder's test fails 3 checks on the old code. (Side effect at very large camps → TED-139.) |
| TED-129: Refund All skipped a child after a put-back | **Closed** | Real functions + real database (`rerun12_refund_failed_realdb.log`). W1 (failed 3 days later) gives `Refund All: $20, refunded 1`, a new refund `re_18`, wallet $0. W1b (2 hours later, Stripe still remembers the key) gives the new refund `re_20`, never the failed one. Real browser S3: `"Refunded $20.00 across 1 camper."`, a new `re_2`. pgtest 278 fails with the fix removed. |
| TED-131: unbooked failed refund never flagged | **Closed** (leftovers TED-137, TED-138) | Real webhook, W3 (answer lost, then failed): `email "Stripe alert: a $20.00 refund failed — pass it back to the camp"`, one office notice. 3 re-deliveries give `emails 0, notices 1`. Booked failures (W1, T1) email once. Builder's tests 14 and 17 fail on the old code. |
| TED-132: Billing wouldn't offer the card refund after a put-back | **Closed as asked, but see TED-136** | Real browser: after the put-back the window says `"$500 refundable to card/bank across 1 online payment"`. Real page functions over the real rows (`refund_failed_realdb.log` T1b): `can draw on: [pi_pi_15T $500]`. **Pressing it does not refund anything → TED-136 (🔴).** |
| TED-133: dashboard refund booked after it failed (older Stripe) | **Closed** | Real webhook, T3 "older API (the list as it was when the event was made)": `owes $0` (last pass $200). Newer API: `owes $0`. Stripe not answering gives 500, so the event is re-sent (builder's test 19 fails on the old code). |
| TED-134: wrong reason for owner-only card actions | **Still open (Snacks half fixed)** | Snacks, real browser signed in as a manager with Snacks access: both windows say `"Only the camp owner or an admin can refund canteen money to a card."`, no refund request made. Billing: the server now answers the right words (`rerun12_autopay_confirm_realdb.log` A12, the only line that changed), but the page shows `"Not recorded: Edge Function returned a non-2xx status code"` (`billing_error_text.log` E1). |
| TED-135: Refund All's numbers vs what it does | **Closed** | Real browser, unchanged twelfth-pass S1: with $20 held, `Refund All ($5.00)` (last pass $25.00). `snacks_recheck` R3: `"…1 waiting refund ($20.00) had gone through and is now recorded."`, nothing sent twice. R4: `"…1 waiting refund ($20.00) had not gone through — the money is back on the wallet and was refunded again above."`, and it was (`re_5 $20`, once). |
| TED-005: auto-scheduler | Open, deferred | Still 14 failing, all in `auto_full_day.test.js`. Not investigated. |

## What I confirmed is working
- **The builder's claims 1–11:** each checked above or here. Claim 4's "not again for a repeat" holds for camps it can find; it doesn't hold when no camp is found (TED-137).
- **Nobody can call the new or changed database functions from a browser:**
  - `_notice_unbooked_refund_failure`: anon, authenticated and service_role all false. It is only reached from inside `reverse_failed_stripe_refund`.
  - `reverse_failed_stripe_refund`: server only.
  - Source: `access_new_fn.log`.
  - My tenth-pass access sweep, re-run: the list of money functions a browser can call is **byte-identical** to last pass (`rerun/access_sweep.out.json`).
- **Pasting 278 again is safe** (`repaste_278.log`):
  - with only the earlier 278 in place, the check script says "apply 278 BEFORE redeploying stripe-webhook";
  - after today's 278 there is one version of the function and the row says "ok", also when pasted a second time.
- **Browser caching:** each changed file loads from exactly one page, with its new number:
  - `campistry_snacks.js?v=20260924-07` (`campistry_snacks.html:581`);
  - `campistry_me.js?v=20260924-22` (`campistry_me.html:343`).
  - There is no service worker.
- **Every refund function's "who may" rule is owner/admin**, the same as the processor-status check Snacks now uses. So the new Snacks message matches what the server enforces.
- **A failed refund between two children with the same name** still goes back to the right child (`refail_same_name`, re-run).
- **Double-click on Snacks' Refund** still sends one request (ninth-pass probe, re-run, identical).
- **The billing setup guide's Stripe event list** is unchanged (the guide was not touched in `dd49fb7`).
- **Leftovers:** no secrets, debug switches or TODOs added in `dd49fb7` (scanned every added line outside `ted/`).
- **The billing setup guide has no command-line steps** (searched `BILLING_PAYMENTS_SETUP.md` for `supabase functions/db/secrets/link/login`: none).

## What I did NOT check (and why)
- **Any real processor.**
  - Stripe and Sola are modelled.
  - Stripe's rules come from its documentation, which I know from search results. I could not open docs.stripe.com, supabase.com or docs.solapayments.com from this machine.
- **Supabase's real processing speed.** TED-139 is measured on this machine's processor in Node, not on Supabase's servers in Deno.
- **What is deployed.** Migrations 255–279 and the edge functions are not live yet.
- **Whether Sola accepts a refund of a card payment from the same day** (not yet settled). Campistry always sends a refund (`cc:refund`), never a void. Search results quoting Sola's documentation mention a combined "void or refund" command, but don't say plainly whether a refund of an unsettled payment is accepted. See the steps below.
- **Whether Resend delivers the platform alert emails.** Unchanged from last time.
- **Areas no billing pass has deep-audited yet:**
  - payroll;
  - POS register maths;
  - Link photo purchases;
  - staff tips;
  - splitting a family;
  - the bank-email parser/matcher.
  - Surcharges were looked at for the first time today (TED-140, TED-141); convenience fees and cash discounts were not.

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
2. **The Stripe events:**
   - Stripe Dashboard → Developers → Webhooks → your `stripe-webhook` endpoint → **⋯ → Update details** → make sure `refund.failed`, `refund.updated` and `charge.refund.updated` are ticked, with the rest of the list in `BILLING_PAYMENTS_SETUP.md` step 5 → **Update endpoint**.
3. **The platform alert email:**
   - Supabase → Edge Functions → Secrets: check `RESEND_API_KEY` is set.
   - In Resend, check the account's own email is `campistryoffice@gmail.com`.
4. **Before going live with card refunds in Billing, get TED-136 fixed.** Once live, until it is, if Billing shows "A refund failed":
   - send that money by cheque and record it with **Billing → Issue Credit/Refund → Offline Refund**;
   - do **not** use "Direct Refund — back to card/bank" for the same amount.
5. **Don't switch on the credit-card surcharge until TED-140 is fixed.**
   - In Me → Registration → **Registration Form** → the **Card Fees** section, leave it on "Nothing passed on", or use "Online payment fee (flat)" or "Discount for not paying by card", which don't depend on the card type.
6. **Sola same-day refund (only if you use Sola), in your Sola sandbox:**
   - Link → top up a test child's canteen by card.
   - The same day, Snacks → Accounts → **Refund** for that child → the full amount → Refund.
   - Then open the Sola portal → Transactions and see whether the refund was accepted or refused. Tell the builder which.
