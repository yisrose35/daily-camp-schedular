# Ted's report: billing, eighteenth pass (re-check TED-163 to TED-176, then a hunt), 2026-09-24

## Verdict: 🔴 Problems found

**All 14 fixes from last pass work, and I'm closing every one: TED-163 to TED-176.** I proved each one myself: in a real browser on the real pages, or with the real payment functions on a real database. The builder's test numbers are exactly right. I broke 15 of the fixes on purpose, and the builder's tests caught 14.

**But billing is not 100% yet.** Three of the fixes left something behind, and the hunt found more. The ones that matter:
- **Split between payers (🔴):** the fund's share is now billed to the fund, but it is kept only in the shared settings file. An office computer that has been open since before the charge (a laptop that was asleep) wipes it the next time it saves anything. The fund's $800 disappears, and so does the record of the cheque it sent.
- **Canteen refunds and disputes made outside Campistry (🟠):** if a canteen top-up is refunded in Stripe's own dashboard, or a parent disputes it with their bank, the money stays on the child's wallet and nobody is told. The child can go on spending money the parent got back.
- **Void a sale (🟠):** it works, but pressing **Void** opens its window *behind* the history window, so it looks like nothing happened.
- **Payer money in Finance (🟠):** Finance's totals leave out what funds owe and what they paid.

I did not change any product code. I only reported.

## The numbers
Tests run: 3,918 · Passed: 3,904 · Failed: 14 (real bugs: 14, all of them the deferred auto-scheduler tests, TED-005 · out-of-date tests: 0 · my machine: 0)

| Suite | Run | Passed | Failed |
|---|---|---|---|
| Unit tests (`npm test`) | 3,699 | 3,685 | 14, all in `auto_full_day.test.js` (TED-005, deferred by you) |
| Database tests (`npm run test:pg`) | 73, against 132 migrations | 73 | 0 |
| `test:keys` | 42 | 42 | 0 |
| `test:lite` | 12 | 12 | 0 |
| `test:smoke` | 34 + 34 (the Snacks browser test) | 68 | 0 |
| `test:scale` | 24 | 24 | 0 |

These match the builder's figures exactly.

**The builder's new tests, run against the code from before the fixes** (`6ab5d61`, in a scratch copy outside the project, removed afterwards; logs `oldcode_*.log`):
- Every new test failed on the old code: 13 files, 50 failures.
- Some files fail completely on old code only because the test now loads a helper the old code doesn't have. That proves little, so I also ran mutation checks.

**Mutation checks** (`mutations.log`): I broke each fix on purpose, one at a time, in a scratch copy of today's code. **14 of 15 were caught.**
- **Caught:** each of TED-163, 164, 165, 166, 167, 168, 170, 172, 173 and 174; 175 twice (a sale voided twice; a voided sale still counted as a sale); and 176 twice (a late event lowering a refund; a reversal without its safety key).
- **Missed:** M9. The register telling the server it sold the *next* child's items (TED-169) is not guarded by any test. The fix itself is right: my browser test reads the stock from the database, and it is correct (below). The missing test is part of TED-184.

**Every earlier probe, re-run at today's code** (`rerun_all18.sh`, compared by `compare_reruns18.sh`):
- **All 125 non-browser probes from passes 1 to 17:**
  - 115 are byte-identical to last pass once ids and times are masked, and every exit code for passes 1–16 is the same.
  - 6 differ only in expected ways: timings, a PostgREST start-up time, one line cut at a different character, and the money-function list growing from 98 to 99 (the new void function, which checks the caller inside).
  - 4 are my own 17th-pass probes, whose bugs are now fixed.
- **All 13 browser probes from passes 14 to 16:** same results as last pass. The only differences are "132 migrations" instead of 130, and one line number that moved.
- **All 10 of last pass's own probes:** see the re-check table. Three need a word:
  - `link17` stops at step 1. It copies a fixed list of Link's functions and misses the two helpers the fix added. My corrected copy (`link18`) passes every step.
  - `finance_billing17`'s F6 says BAD because the ✕ it tries to press is now hidden. Nothing happened, which is the fix.
  - `payroll_runs17`'s two BAD lines were last pass's expectations, which assumed unfinished weeks get paid. The new pay runs are right (below).

**New probes this pass** (`ted/probes/2026-09-24-billing-18/`), 12 in all:
- **6 in a real browser:**
  - payer split on two office computers;
  - two office computers recording payments at once;
  - offline register export, re-export and import;
  - Snacks Void (and Void after closing History);
  - Link auto-reload.
- **3 with real payment functions on a real database:**
  - a webhook payment that can never be recorded;
  - canteen refunds and disputes made outside Campistry;
  - tip refunds and disputes.
- **1 on the real void function** with two database connections at once.
- **1 re-run of every 17th-pass probe.**
- **1 mutation script.**

## What's wrong (most serious first)

### TED-177 🔴 A fund's share of a split bill is wiped by an office computer that was open from before
- **What a user would see:**
  - The office adds Pine's $1,000 tuition and splits it: Scholarship Fund $800, Pine $200. Pine is billed $200, and the fund owes $800 in Manage payers. That part is right now.
  - The fund's $300 cheque arrives and is recorded.
  - A second office computer was open all along (a laptop that was asleep, or wifi that dropped). Someone on it adds an ordinary $50 trip charge to another family.
  - **The fund's account is now empty.** The $800 it owes and the $300 cheque are both gone. Manage payers shows nothing owed, on every computer.
  - Pine is still billed only $200. So $800 of tuition is now owed by nobody, and the cheque that came in has no record.
- **How sure I am:** Confirmed, on the real Me page on two office computers against the real database. Live updates between computers were not delivered in my test, which is exactly the asleep-laptop case.
- **Proof:**
  - `payer_split18.log` S1: `Pine owes $200`, `plan_due_for → 200`, fund ledger `[… "amount": 800 …]`.
  - S2: the $300 cheque is saved.
  - S4: `computer B's copy of the fund: {… no ledger …}`, then after B's $50 Oak charge `fund's ledger in the cloud now: []`, and computer C: `(no Owes line)`.
  - Family bills do *not* have this problem: `two_computers18.log` K1/K2 (a stale computer's cheque, and a charge and a payment saved at the same instant) all land, Pine owes exactly $450.
  - Code: the fund's account lives in `campistryMe.payers` (`campistry_me.js:967`). That document is merged only one level deep before saving (`integration_hooks.js:900`), and the finance merge doesn't cover `payers` (`campistry_finance_merge.js:352-353`). No migration touches `payers`.
- **What to ask the builder for:** "TED-177: payer ledgers (split shares + payer payments) live only in campistryMe.payers, which a stale office tab overwrites wholesale — payer_split18 S4: after a never-refreshed computer saved an unrelated charge, the fund's $800 share and its $300 cheque were gone from the cloud. Keep payer charges/payments where a stale save can't drop them (their own rows, or merge payer ledger entries by id on save like families' entries), and add a two-computer test."

### TED-181 🟠 A canteen top-up refunded in Stripe's dashboard, or disputed by the parent's bank, stays on the child's wallet
- **What a user would see:**
  - A parent puts $20 on Avi's canteen wallet by card.
  - Later the $20 is refunded from Stripe's own dashboard (not from Snacks), or the parent disputes it with their bank.
  - The parent has the $20 back, but **Avi's wallet still shows $20 and he can spend it.** No notice reaches the camp.
  - Tuition payments are handled correctly in the same situations (the bill goes back up, TED-114). Canteen top-ups are not.
- **How sure I am:** Confirmed, with the real `stripe-webhook` on a real database. It is older than this commit: this pass is the first time anyone checked it.
- **Proof:**
  - `canteen_dashboard_refund18.log` C1: `webhook HTTP 200; Avi's wallet $20.00; camp notices 0`.
  - C2 (dispute): `Bina's wallet $20.00; camp notices 0`.
  - Code: `stripe-webhook/index.ts:772-835` (`handleChargeRefunded`) and `:915-963` (`handleDisputeLedger`) only try the family bill. They log "family_not_found" (`migrations/215…sql` `record_external_refund` and `record_chargeback`), and nothing looks at canteen wallets.
- **What to ask the builder for:** "TED-181: a canteen top-up refunded in the Stripe Dashboard (charge.refunded) or disputed (charge.dispute.created) leaves the money on the child's wallet with no notice — canteen_dashboard_refund18 C1/C2 (Avi and Bina keep $20). When the payment is a canteen deposit (metadata source campistry-canteen-deposit), take the refund / chargeback off that child's wallet once (keyed on the refund/dispute id, like refund_canteen_deposit_from_stripe), put back a lost-then-won dispute, and raise a camp notice if the wallet no longer has it."

### TED-180 🟠 Pressing "Void" in Snacks opens its window behind the history window, so nothing seems to happen
- **What a user would see:**
  - The office opens Avi's history and presses **Void** on the mistaken sale.
  - The Void window opens *underneath* the history window, whose own buttons cover the "Void sale" button. To the office, nothing happened.
  - Only after pressing **Close** on the history does the Void window show. Then it works perfectly (below).
- **How sure I am:** Confirmed, with real clicks in a real browser.
- **Proof:**
  - `void18.log`: `openModals ["m-void z200","m-history z200"]`, the topmost thing at the button is `modal-footer`, and a real click on "Void sale" timed out.
  - Screenshot `void18_window.png` (only the history shows, with the edge of the Void window peeking out behind it).
  - `void18b.log`: after pressing History's Close, `a real click on "Void sale" worked: true`.
- **What to ask the builder for:** "TED-180: openVoidSale (campistry_snacks.js:858) opens #m-void (campistry_snacks.html:507) while #m-history is still open; both overlays are z-index 200 and #m-history (line 508) comes after it in the page, so history's footer covers 'Void sale' and a real click never reaches it (void18: topmost 'modal-footer'; works only after closing History, void18b). Close History first (and reopen it after the void) or stack the void window above; add a browser check that clicks the real button."

### TED-178 🟠 Finance doesn't count what funds owe or pay, and a fund's account can't be corrected
- **What a user would see:**
  - After the Scholarship Fund's $300 cheque is recorded, **Finance → Revenue** doesn't show it. It isn't in the Payment Log or in "Collected".
  - The $800 the fund still owes isn't in "Outstanding" either. Only the household's $200 share is.
  - A fund cheque recorded by mistake, or a fund share for a charge that was later credited back, cannot be removed or refunded anywhere. The fund goes on "owing" it.
  - The fund's Record payment window preselects "Credit card", so a cheque is saved as a card payment unless someone changes it.
- **How sure I am:** Confirmed in a real browser (Finance), and by reading the code (no way to correct it).
- **Proof:**
  - `payer_split18.log` S3: `Finance: … Collected $200, Outstanding $200; fund named anywhere: false; the $300 cheque listed: false`.
  - S2's stored cheque: `"method": "credit"`.
  - Code: `recordPayerPayment` (`campistry_me.js:18630`) writes only to the fund's own list, and Finance reads `finPayments` and family ledgers only. The only code that touches a fund's list is the split and this Record payment (search for `py.ledger`). `_payOptions` puts Credit card first (`:3845`).
- **What to ask the builder for:** "TED-178: payer (fund) money is invisible to Finance and uncorrectable — payer_split18 S3: the fund's $300 cheque is not in Finance's Payment Log/Collected and its unpaid $800 is not in Outstanding; there is no way to remove/refund a payer payment or take back a payer's share of a credited charge; the payer payment form defaults to Credit card. Count payer charges/payments in Finance's totals, add remove/refund for payer entries (and follow credits on split charges), default the method to Check."

### TED-182 🟡 A staff tip is taken back even when the camp lost no money (a bank inquiry, or a dispute already won)
- **What a user would see:**
  - A parent's bank sometimes only *asks* about a charge (an "inquiry"). No money leaves Campistry.
  - The webhook still takes the whole $20 tip back from the staff member's Stripe account.
  - When the inquiry closes, Campistry emails the platform to send the tip back by hand. The same happens when a dispute is already won and Stripe's late "opened" message arrives after the "won" one.
  - The staff member is short their tip until someone does it.
- **How sure I am:** Confirmed, with the real `stripe-connect-webhook` and the real 285 on a real database. (Ordinary refunds and disputes work right: T1, T2 and T4 below.)
- **Proof:**
  - `tip18.log` T5 (inquiry `warning_needs_response`): `taken back ["tr_5 2000"]`, then `dispute won`, and an email to re-send.
  - T3 (won first, then the late "created"): `taken back ["tr_3 2000"]` though the tip record says `dispute won`.
  - Code: `stripe-connect-webhook/index.ts` `handleTipReversal` uses the event's own "open" before the tip's saved state, and never looks at the dispute's `status`.
- **What to ask the builder for:** "TED-182: handleTipReversal claws back the whole tip on charge.dispute.created even for an inquiry (status warning_*, no funds withdrawn) and when the tip's saved dispute_status is already won/lost (late created after closed) — tip18 T5/T3 reverse $20 that then needs a manual re-send. Skip warning_* disputes, prefer the tip's saved closed state over a late 'open', and add both cases to tip_refund_dispute.test.js."

### TED-183 🟡 A payment the database will never accept is retried for 3 days and then dropped, with nobody told
- **What a user would see:**
  - This case is rare. A parent pays, but the thing they paid for is gone by the time Stripe reports it: a canteen top-up for a child number that no longer exists (erased or merged), or a registration deposit for an application the office has deleted as a duplicate.
  - Since the TED-164 fix, Campistry answers "try again" every time. Stripe retries for 3 days and then stops.
  - No email and no notice tells anyone the money came in. Before the fix it was just as silent (it answered "received").
- **How sure I am:** Confirmed, with the real `stripe-webhook` on a real database.
- **Proof:**
  - `webhook_permanent18.log` P1: `4 deliveries answered [500,500,500,500]; receipts 0; platform emails 0; camp notices 0` (unknown_camper).
  - P2: the same (application_not_found).
  - P3 (the control): an ordinary top-up is credited once.
- **What to ask the builder for:** "TED-183: when credit_canteen_balance_from_stripe answers unknown_camper or _record_registration_deposit answers application_not_found, the webhook answers 500 forever and nobody learns a paid payment has nowhere to go (webhook_permanent18 P1/P2). For a refusal that will never succeed, raise a Billing notice / platform email once (claim table like 278's) and answer 200; keep 500 for real database errors."

### TED-179 🟡 The Manage payers window's layout is broken
- **What a user would see:** in **Payers & Organizations**, each payer's "Record payment" and "Archive" buttons sit below and outside the payer's box. The window's own **Cancel** and **Save** buttons fall outside the white window, on the grey background.
- **How sure I am:** Confirmed (screenshot).
- **Proof:** `payer_split18_manage_payers.png`. `payer_split18.log` S6: `the Record payment / Archive buttons sit in the fund's row → buttons outside the row box`. Code: `campistry_me.js:1866-1868` adds an extra `</div>`.
- **What to ask the builder for:** "TED-179: managePayers (campistry_me.js:1866-1868) closes each payer row's div twice since the 'Owes' line was added, so Record payment/Archive fall outside the row and the modal's Cancel/Save outside the modal (payer_split18_manage_payers.png). Remove the extra </div>."

### TED-184 🟡 Two missing safety nets
- **What a user would see:** nothing today. These are guards that would catch a future mistake.
- **How sure I am:** Confirmed.
- **Proof:**
  - The register fix (TED-169) has two halves. The half that tells the server what was sold is not tested: mutation M9 (`mutations.log`) passes every test, while M9b, the page's own stock, is caught.
  - The void function puts back in stock whatever list the page sends, even items that weren't in the sale. In `void_sale18.log` V3, one $2.50 Ices void with a list of "100 Chips" twice gave `Chips 210 left`. The page itself only offers the sale's own items.
- **What to ask the builder for:** "TED-184: (1) pos_charge_once doesn't check the p_items sent to record_canteen_sale_inventory when the next child's cart is on screen (mutation M9 missed); (2) canteen_void_sale restocks whatever p_restock lists (void_sale18 V3: 200 Chips for an Ices sale) — cap each item at its quantity in the sale's items text."

### TED-185 🟡 (Suspected) Tablets may keep an old offline register after this fix
- **What a user would see:** the offline register fixes (TED-170, 171) only reach a tablet when the office downloads a fresh copy. Tablets already set up keep the old one. Also, Snacks fetches the register's template without a version number, so an office computer's browser may hand out a cached old copy for a while.
- **How sure I am:** Suspected. I read the code, but I can't see your hosting's cache settings.
- **Proof:** `campistry_snacks.js:1434` `fetch('campistry_snacks_pos_offline.html')` (no `?v=`, no `cache: 'no-store'`).
- **What to ask the builder for:** "TED-185: downloadOfflinePOS fetches campistry_snacks_pos_offline.html without a version or cache:'no-store', so an office browser can bake an old register into the download; add one, and show the register's build on its settings screen so the office can tell an old tablet."

## Re-check of last report's findings
| ID | Now | My proof |
|----|-----|----------|
| TED-163: Finance's ✕ undid Stripe refunds | **Closed** | `rerun17/finance_billing17.log` F8 and F11 are ok: a Stripe refund row and a "refund failed" put-back row can't be removed, and Hawk and Slate stay right. F6 shows the ✕ is now hidden on a Stripe payment (no window; Hawk still owes $0). F4b: an old row that never reached the bill now says "It was never on Owl's bill, so no balance changes". Mutation M1 was caught. |
| TED-164: webhook said "received" when not recorded | **Closed** (new edge → TED-183) | `rerun17/webhook_write_fails17.log` W1–W3: `HTTP 500`, `receipts sent 0`, and the re-send records each one (Gold owes $500, Avi's wallet $20, photos 1). `webhook_permanent18` P3: an ordinary repeat is answered 200 and credited once. Mutation M2 was caught. |
| TED-165: split billed the family in full | **Closed** (new problems → TED-177, 178, 179) | `rerun17/payer_split17.log`: Pine owes $200, and autopay would charge $200. `payer_split18` S1: the fund owes $800 in the cloud; Pine's page says "Also paying part of this bill: Scholarship Fund $800 (still owes $800)". S5: a 100% fund charge leaves Pine's bill unchanged. Mutation M3 was caught. |
| TED-166: pay runs paid a week twice | **Closed** | `rerun17/payroll_runs17.log`: the defaults are now Jun 28–Jul 4, then Jul 5–Jul 11. Ana is paid 40 h + 40 h, exactly the finished weeks. Two-weekly runs pay 40 h, then 80 h. The only hours not yet paid (16 h) are from the week still being worked, which the next run pays. The builder's test covers the overlap warning; mutation M4 was caught. |
| TED-167: refund preview figure | **Closed** | `rerun17/finance_billing17.log` F14: `preview said $400, the family owes $400`. F7b: "$1,000 (currently $0)". Mutation M13 was caught. |
| TED-168: Clear All kept the sale key | **Closed** | `rerun17/pos17.log` P4: the new sale is charged (`1 new debit`, a new key). Mutation M8 was caught. |
| TED-169: next child's cart wiped | **Closed** (test gap → TED-184) | P5: `Chips 50 left/0 sold` before and after (read from the database), `Avi's half-rung sale is still on the screen`. |
| TED-170: offline double tap | **Closed** | `offline_register18.log` O1 and O2: one sale each. Mutation M6 was caught. |
| TED-171: lost export file | **Closed** (old tablets → TED-185) | O4: "Export all sales again" is shown and the file holds all 3 sales with the same ids. O4b: the office's real import of the first file and the re-export → `imported 3`, then `duplicates 3`, wallet $12.50 (each sale once). O5: Clear All Data says "1 sale has never been exported … Check the office imported the exported files (3 sales)…". |
| TED-172: tick then edit saved off | **Closed** | `link18.log` L5 and L6: stored `enabled true`; L1–L4 (TED-161) all still ok. Mutation M7 was caught. |
| TED-173: check script passed an old 281 | **Closed** | `rerun17/check_script_281_17.log`: last pass's 281 → "281 : apply 281 again — an earlier copy is in place…". The BAD line there shows the *old* 281's behaviour, which is what the row now catches. Mutation M15 was caught. |
| TED-174: same-name households auto-posted | **Closed** | `rerun17/deposit_match17.log` M1 and M1b → `review … Two families match the payer's name`; M4 still goes to review. The copy inside `deposit-inbox` is up to date (`node tools/build_deposit_inbox.js --check`). Mutation M5 was caught. |
| TED-175: no way to void a sale | **Closed** (window hidden → TED-180; restock → TED-184) | `void18b.log` D1: only the register sale offers Void. D2: $5 back, both Ices back in stock, and a void line with no payment method. D3: Sales today $0, Revenue $0.00, and the cash drawer still says $20 came in. `void_sale18.log` V1: two computers voiding at once → one void, and the second is told "already voided". V2: refunds, cash-outs and close-outs are refused. Mutations M10 and M14 were caught. |
| TED-176: tip refunds and disputes unhandled | **Closed** (edge → TED-182) | `tip18.log` T1: a full refund takes $20 back once and one email is sent; a repeat does nothing. T2: an opened dispute takes the tip back, and a win restores the total without a second reversal. T4: a half refund takes $10, then $20 in all. The nightly retry skips refunded tips (code read). TIPPING_SETUP.md lists the four events and the manual steps. Mutations M11 and M12 were caught. |
| TED-162: tip fee | Open, unchanged | `stripe-connect-tip` hasn't changed since last pass. Waiting on your question to Stripe. |
| TED-005: auto-scheduler | Open, deferred | Still 14 failing, all in `auto_full_day.test.js`. |

## What I confirmed is working
- **Everything in the claims list**, as the re-check table shows, apart from the new findings.
- **Two office computers recording payments for the same family** (a stale computer's cheque, and a charge and a payment saved at the same instant): all land, and the balance is exact (`two_computers18.log`).
- **Browser caching:** every changed script's `?v=` is bumped wherever it's loaded:
  - `campistry_me.js` 20260924-27
  - `campistry_payers.js` 20260924-01
  - the deposit modules 20260924-01 (and D.BUILD)
  - `campistry_snacks.js` 20260924-11
  - `campistry_snacks_pos.js` 20260924-02
  - Link, Link Admin and the offline register are pages themselves (see TED-185).
- **Migrations:** only new files (284, 285); no old migration was edited in place this time. Both are in the test database chain and the check script (header 222–285). Both are pasted as raw SQL, as you do.
- **Who can call money functions:** the list grew from 98 to 99, and the only new one is the void. It checks the caller inside, only Snacks-edit staff get through (pgtest 284), and signed-out visitors can't call it. Tip functions are server-only.
- **Leftovers:** the diff has no debug switches, no TODOs and no secrets. Two ordinary server log lines were added, in the existing style.
- **Your code didn't change under me.** HEAD is `91e9ef9` throughout, and only my `ted/` folder changed. The old access-sweep probe's output was put back, and this pass's copy is kept as `access_sweep18.out.json`.

## What I did NOT check (and why)
- **Any real processor, email or SMS service.** Stripe and Sola are modelled on their documented behaviour. Nothing is live.
- **Live updates between office computers.** My test harness doesn't deliver them, which is the asleep-laptop case. With them working, a computer that is awake would usually pick up the fund's account before saving. TED-177 is about the ones that miss it.
- **A real Stripe inquiry, dispute or dashboard refund.** Modelled from Stripe's documented event shapes.
- **The whole Link page with a real parent login** (there's no test parent login).
- **Payroll's youth-employment rules and overtime** (a legal question), and the tax statement's classification rules.
- **Photo purchases refunded in Stripe.** Probably the same gap as TED-181, but photos are digital and I didn't test it.

## Things only you can check (click-by-click)
1. **Owner steps (still pending):**
   - Supabase → **SQL Editor** → paste migrations **255 to 285 in order**, each one → **Run**.
   - Then paste `scripts/verify_identity_chain.sql` → **Run**. Every row should say "ok" (the 281, 284 and 285 rows included).
   - **284 must be in before Snacks is reloaded. 285 must be in before `stripe-connect-webhook` is deployed.**
   - Supabase → **Edge Functions** → deploy `stripe-webhook`, `stripe-connect-webhook`, `charge-due-installments` and `deposit-inbox`. For `stripe-webhook` and `charge-due-installments`: **Settings** → **"Enforce JWT Verification" OFF**.
   - Reload Me, Snacks and the register on every office computer and tablet.
2. **Stripe Dashboard → Developers → Webhooks:** open the **"Your account"** endpoint for `stripe-connect-webhook` and add `charge.refunded`, `charge.dispute.created`, `charge.dispute.updated` and `charge.dispute.closed`, as TIPPING_SETUP.md says.
3. **Offline tablets (TED-185):** after the update, in Snacks press **Download offline POS** again and put the new file on every tablet. Before clearing any old tablet, use its **Export all sales again** (new tablets only) or check its last export was imported.
4. **Until TED-177 is fixed:** don't use "Split between payers". If you must, refresh (**reload**) every other office computer right after, and write the fund's share and cheques down outside Campistry too.
5. **Until TED-180 is fixed:** to void a sale, press **Void**, then press **Close** on the history window. The Void window is underneath.
6. **Until TED-181 is fixed:** never refund a canteen top-up from Stripe's dashboard; use Snacks → Refund. If a parent disputes a canteen top-up, take it off the child's wallet by hand in Snacks.
7. **Staff tips (TED-162):** your fee question to Stripe (last report) is still open.
