# Ted's report: billing, nineteenth pass (re-check TED-177 to TED-185, then a hunt), 2026-09-24

## Verdict: 🔴 Problems found

**All nine fixes from last pass work, and I'm closing every one: TED-177 to TED-185.** I proved each one myself: in a real browser on the real pages, or with the real payment functions on a real database. The builder's test numbers are exactly right. I broke 22 of the fixes on purpose, and the builder's tests caught 19. The 3 they missed are behaving correctly in my own checks.

**But billing is not 100% yet.** The hunt found an older problem that matters:
- **A bank "inquiry" is treated as a chargeback (🔴).** Sometimes a parent's bank only *asks a question* about a tuition payment. No money moves. Campistry puts the whole payment back on the family's bill anyway, and tells the camp "the bank pulled it back". That night, autopay would charge the parent the full amount **again**. When the inquiry closes, nothing undoes it.
- **Refunds and chargebacks lost on a database hiccup (🟠).** If the database is briefly busy when Stripe reports a tuition refund or chargeback, Campistry answers "got it" anyway. Stripe never sends it again, and the family's bill stays wrong. (Payments and canteen refunds already handle this correctly.)
- **Escalated canteen inquiries (🟠, likely).** A canteen inquiry that turns into a real chargeback probably never comes off the child's wallet.
- Four smaller items (🟡).

I did not change any product code. I only reported.

## The numbers
Tests run: 3,944 · Passed: 3,930 · Failed: 14 (real bugs: 14, all of them the deferred auto-scheduler tests, TED-005 · out-of-date tests: 0 · my machine: 0)

| Suite | Run | Passed | Failed |
|---|---|---|---|
| Unit tests (`npm test`) | 3,715 | 3,701 | 14, all in `auto_full_day.test.js` (TED-005, deferred by you) |
| Database tests (`npm run test:pg`) | 75, against 134 migrations | 75 | 0 |
| `test:keys` | 42 | 42 | 0 |
| `test:lite` | 12 | 12 | 0 |
| `test:smoke` | 34 + 42 (the Snacks browser test) | 76 | 0 |
| `test:scale` | 24 | 24 | 0 |

These match the builder's figures exactly.

**Mutation checks** (`mutations.log`, `mutations_browser.log`). I broke each fix on purpose, one at a time, in a scratch copy of today's code outside the project (removed afterwards). **19 of 22 were caught.**
- **Caught:**
  - TED-177 ×2: the server merge losing fund lines; the share written to the old place.
  - TED-178 ×3: Finance leaving funds out; "Move back" not billing the family; the method default.
  - TED-180: the Void window behind History again, caught by the real-browser test.
  - TED-181 ×5: taking money while a Snacks refund waits; taking a Campistry refund twice; taking a Snacks-tagged refund; acting on an inquiry; never giving back a won dispute.
  - TED-182 ×2, TED-183 ×3, TED-184 ×2 (including last pass's missed M9) and TED-185 ×1.
- **Missed (test gaps only; the product is right):**
  - M6: the "never more than the top-up had left" cap in 287.
  - M9: 287's once-per-refund rule.
  - M21: the downloaded register's version check.
  - My own probe shows the product behaves correctly in all three cases: a refund delivered twice comes off once, partial refunds add up and stop at $20, and the check exists in the code. See TED-191.

**Every earlier probe, re-run at today's code** (`rerun_all19.sh`, compared by `compare_reruns19.sh`):
- **Non-browser probes from passes 1 to 18 (129):**
  - 121 are the same as last pass once ids and times are masked.
  - 5 differ only in timings.
  - 3 are last pass's own probes whose bugs are now fixed:
    - `tip18`: T3 and T5 now ok.
    - `void_sale18`: V3 now restocks 0 instead of 200.
    - `webhook_permanent18`: now answers 200 instead of 500. It still prints BAD, because that probe doesn't connect the new alert-claim function and counts emails the wrong way. My corrected `webhook19` P1/P2 replaces it.
  - `canteen_dashboard_refund18` still prints BAD for the same kind of reason: it doesn't connect the new wallet function. `webhook19` C1/C2 replaces it.
  - Every exit code for passes 1–17 is identical to last pass.
- **Browser probes from passes 14 to 17 (19):** the same verdicts and exit codes as last pass.
- **Last pass's 6 browser probes:**
  - `void18`: the Void window is on top and the only one open (screenshot `rerun18/void18_window_at_e8f1d26.png`).
  - `link18`, `offline_register18` and `two_computers18`: all ok.
  - `void18b` stops because it tries to press History's Close button, and History is now already closed. That is the fix.
  - `payer_split18` looks for the fund in its old place; `payer_split19` replaces it.

**New probes this pass** (`ted/probes/2026-09-24-billing-19/`):
- `payer_split19` (real browser, 6 office computers).
- `payer_migrate19` (real browser).
- `webhook19` (real webhook on a real database, 14 cases).
- `refund_write_fails19` (real webhook).
- `check_script19` (real database).
- `void_names19` (real database).
- The re-run of every earlier probe, and the mutation scripts.

## What's wrong (most serious first)

### TED-186 🔴 A bank inquiry about a tuition payment puts the payment back on the bill, and autopay would charge it again
- **What a user would see:**
  - Teal paid $1,000 tuition by card. Their bill shows $0, and autopay has nothing to collect.
  - Teal's bank sends Stripe an **inquiry**, a question about the charge. Stripe marks it as a warning. **No money leaves the camp.**
  - Campistry treats it as a chargeback:
    - Teal's bill goes back to **$1,000 owed**.
    - The camp gets a notice: "Teal — $1000.00 was pulled back by the bank. Their balance has gone back up by that amount." That isn't true.
    - **Tonight's autopay would charge Teal's card $1,000 again**, the same card whose bank is asking questions.
  - When the inquiry closes without becoming a dispute, nothing puts it right. The family still "owes" $1,000.
  - Last pass's fixes already skip inquiries for canteen top-ups and staff tips (TED-181, TED-182). The tuition path was never changed.
- **How sure I am:** Confirmed, with the real `stripe-webhook` on a real database with the real autopay rule. This is older than this commit; this pass is the first time anyone checked it.
- **Proof:**
  - `webhook19.log` T1: owes `$500.00` after paying, then `$1000.00` after the inquiry opened, and still `$1000.00` after it closed ("warning_closed"). The family's record gets a line `"id": "le_cb_dp_t1", "kind": "refund", "amount": 500.00, "reason": "chargeback"`.
  - T2: before the inquiry, autopay's rule (`plan_due_for`) says `"amount": 0, "reason": "nothing_owed"`. After it, it says `"amount": 1000.00`. The camp notice reads "…was pulled back by the bank…".
  - Code:
    - `stripe-webhook/index.ts` `handleDisputeLedger` calls `record_chargeback` for every `charge.dispute.created`, whatever its status (the inquiry check at `:999` covers only canteen).
    - `record_chargeback` (`migrations/215…sql`) posts the refund line and never looks at `p_status`.
    - `resolve_chargeback` only undoes a dispute that is "won", and a closed inquiry is "warning_closed".
  - No version of the chargeback function ever paused autopay (175, 177 and 215 read).
- **What to ask the builder for:** "TED-186: a Stripe inquiry (dispute status warning_needs_response / warning_under_review) on a tuition payment is posted as a chargeback — webhook19 T1/T2: owes $500→$1,000, notice 'pulled back by the bank', plan_due_for asks autopay to charge $1,000 again, and warning_closed leaves it. Skip warning_* in handleDisputeLedger for family payments (take the money only when the inquiry escalates — subscribe to and handle charge.dispute.updated / charge.dispute.funds_withdrawn), undo a posted chargeback when the status is warning_closed, and decide whether autopay should pause for a family with an open dispute instead of re-charging the disputed card."

### TED-187 🟠 A tuition refund or chargeback that arrives while the database is busy is never booked
- **What a user would see:**
  - The camp refunds $500 of Gold's tuition in Stripe's dashboard. At that moment the database is briefly busy (a timeout, or a restart).
  - Campistry answers Stripe "received", so Stripe never sends it again.
  - Gold's bill keeps counting the $500 as paid, though the parent has it back. The same happens with a chargeback (the camp's books overstate cash) and with a won dispute (the family stays charged for money the camp got back).
  - Only a line in the server log records it.
  - Payments (TED-164) and, since last pass, canteen refunds answer "try again" in the same situation, so Stripe re-sends them.
- **How sure I am:** Confirmed, with the real `stripe-webhook`. This is older than this commit (a twin of TED-164).
- **Proof:**
  - `refund_write_fails19.log`:
    - R1 (dashboard refund) → `HTTP 200`, "refund re_1 NOT posted (canceling statement due to statement timeout)".
    - R2 (chargeback) → `HTTP 200`.
    - R3 (dispute won) → `HTTP 200`.
    - The controls: R4 (canteen refund) → `HTTP 500`; R5 (payment) → `HTTP 500`.
  - Code: `handleChargeRefunded` (`stripe-webhook/index.ts`, `record_external_refund` inside try/catch, logged only) and `handleDisputeLedger` (`record_chargeback` / `resolve_chargeback` errors logged only).
- **What to ask the builder for:** "TED-187: stripe-webhook answers 200 when record_external_refund, record_chargeback or resolve_chargeback fails with a database error — refund_write_fails19 R1–R3 (HTTP 200, never re-sent; canteen and payment paths already 500). Throw on a real error so Stripe re-sends (each write is keyed on the refund/dispute id); keep 200 for 'family_not_found'-type answers that retrying cannot fix."

### TED-188 🟠 (Likely) A canteen inquiry that becomes a real chargeback never comes off the child's wallet
- **What a user would see:**
  - A parent's bank opens an inquiry on Dov's $20 canteen top-up. Rightly, nothing moves.
  - The bank then escalates it into a real chargeback, and the $20 is taken from the camp.
  - Dov's wallet still has the $20, and the camp is not told.
- **How sure I am:** Likely.
  - Proven: Campistry acts only on the "dispute opened" message, and the inquiry's opened message is (rightly) skipped. Messages after that change nothing.
  - Not proven: I couldn't reach Stripe's documentation from here to confirm exactly which messages Stripe sends when an inquiry escalates. My understanding is that the same dispute changes status and Stripe sends "updated" / "funds withdrawn" messages, not a second "opened" one.
- **Proof:**
  - `webhook19.log` C4:
    - The inquiry: Dov $20.00 (right).
    - `charge.dispute.updated` (status needs_response) and `charge.dispute.funds_withdrawn` → `Dov $20.00; notices for Dov 0`.
  - Code:
    - `stripe-webhook/index.ts:1003-1009`: only `charge.dispute.created` takes money, and only `charge.dispute.closed` + won gives it back.
    - `BILLING_PAYMENTS_SETUP.md:74`: the webhook is told to send only `created` and `closed`.
- **What to ask the builder for:** "TED-188: an inquiry on a canteen top-up that escalates to a chargeback never comes off the wallet — webhook19 C4b: after charge.dispute.updated (needs_response) and charge.dispute.funds_withdrawn, Dov still has $20. Confirm with Stripe's docs how an escalated inquiry is announced; handle it (take the money on funds_withdrawn / a status change out of warning_*, keyed on the dispute id so a later 'created' can't take it twice), add those events to BILLING_PAYMENTS_SETUP.md, and do the same for tuition when fixing TED-186."

### TED-189 🟡 Cancelling a split charge takes two steps and bills the family in between
- **What a user would see:**
  - Pine's $1,000 tuition is split: the Scholarship Fund pays $800 and Pine $200. Then the child withdraws.
  - The office credits Pine's $200, but the fund still "owes" $800.
  - The only button on the fund's account is **Move back to family**. It puts the $800 on Pine's bill, and the office must then credit Pine another $800.
  - There's no plain "cancel this share", and a credit on the family never reaches the fund's share. Last pass asked for this ("follow credits on split charges"); it was only half done.
- **How sure I am:** Confirmed by reading the code. The two-step path itself works in a real browser (`payer_split19` S7).
- **Proof:** the only places that touch a fund's lines are the split, Record payment, Remove payment and Move back (`campistry_me.js`, search `payerLedger`). The credit and refund code never reads them.
- **What to ask the builder for:** "TED-189: a fund's share can only be 'moved back to family' (which bills the household) — cancelling a split charge takes move-back + credit, and a credit on the family never reaches the fund's share. Add 'Cancel share' (a void line, no household charge), and offer it when the office credits or removes a split charge."

### TED-190 🟡 During an update, an office computer still on the old page can make a fund's cheque count twice
- **What a user would see:**
  - This only matters for a camp that used "Split between payers" before this update. **Nothing is live, so no real camp has such data today.**
  - The fund had two families' shares and one $1,000 cheque.
  - After the update, one computer moves the fund's lines to their new place, correctly.
  - A second computer was never reloaded and still runs the old page. It saves, which writes the old list back.
  - The next move counts the cheque again. The fund shows **"Owes $-700 (shares $1,300, paid $2,000)"**, and Finance counts $1,000 too much collected.
- **How sure I am:** Confirmed, on the real Me page on a real database. I wrote the old page's save straight into the database, since the old page itself isn't available.
- **Proof:**
  - `payer_migrate19.log` M1: the first move is right, `paid 1000`.
  - M2: after the old list comes back, `paid 2000`. The cheque's parts are named by how they were split (`prp_old1_0`, `prp_old1_1`), and the second move splits it differently (`prp_old1`).
  - Code: `_migratePayerLedgers` / `_placePayerPayment` in `campistry_me.js`.
- **What to ask the builder for:** "TED-190: re-moving an old payers.ledger (an old-code computer wrote it back) books a multi-family fund cheque again — payer_migrate19 M2: paid 1000 → 2000, 'Owes $-700'. Skip an old payment whose paymentId is already on any family's payerLedger, and a pgtest/unit test for it."

### TED-191 🟡 Three safety rules without a test
- **What a user would see:** nothing today. These are guards that would catch a future mistake.
- **How sure I am:** Confirmed.
- **Proof:** in `mutations.log`, three mutations pass every test:
  - M6: removing 287's "never more than the top-up had left" cap.
  - M9: removing 287's once-per-refund check. With it gone, a repeated *partial* refund would come off the wallet twice.
  - M21: removing the offline register's version check.
  - The product itself is right: `webhook19` C1 (a refund delivered twice comes off once) and C5 ($5, then $15, then a bogus $5 → $15, $0, $0).
- **What to ask the builder for:** "TED-191: pgtest 287 passes with the v_left cap removed and with the xref once-check removed (mutations M6/M9 — a repeated partial refund would come off twice); offline_register_once passes with the build check removed (M21). Add a repeated-partial-refund case and an over-amount case to pgtest 287, and a mismatched-build case to the download test."

### TED-192 🟡 Voiding a sale can't restock an item whose name has a comma or ends like "Mix 2"
- **What a user would see:**
  - A sale of "Trail Mix 2" or "Chips, BBQ" is voided. The money goes back correctly, but the item doesn't go back in stock.
  - The Void window doesn't offer the item either, so nobody is misled. The office restocks it by hand.
- **How sure I am:** Confirmed, on the real 284.
- **Proof:** `void_names19.log`: N1 and N2 give `restocked: 0`, with the right money back ($2 and $1). N3 "Ices ×2" restocks 2. The cap reads item names back out of the sale's text ("Ices ×2, Chips"), in `284:151-156` and `campistry_snacks.js:848`.
- **What to ask the builder for:** "TED-192: the void's restock cap (284) and the page's offer parse the sale's items text, so an item named 'Trail Mix 2' or 'Chips, BBQ' can't be restocked by a void (void_names19). Store the sold items' ids and quantities with the sale and cap by id."

## Re-check of last report's findings
| ID | Now | My proof |
|----|-----|----------|
| TED-177: fund's share wiped by a stale computer | **Closed** (edge → TED-190) | `payer_split19.log`, real browser: S1 the $800 share is on Pine's family row. S4: a computer that had been open from before saves a charge on Oak, and then **on Pine itself** (the harder case). Fund still `charged 800, paid 300`, Pine owes $250. S8: the same stale computer saves after the corrections, and they survive. S9: two computers each record a $100 cheque, and both are kept. `check_script19` V2: without 286 the script says "apply 286"; 286 pasted twice changes the merge once. Mutations M1/M2 caught. |
| TED-178: Finance blind to fund money; no correction | **Closed** (residual → TED-189) | `payer_split19` S3: Collected $500 (family $200 + the fund's $300), Outstanding $700 (Pine $200 + fund $500), and the Payment Log row "Scholarship Fund (fund) $300 Check Account". S2: the method starts on Check. S6: Remove → the fund owes $800 again, Finance goes back to Collected $200, and the fund row is gone. S7: Move back → Pine owes $1,050, the fund $0, and autopay's rule says $1,050. Mutations M3–M5 caught. |
| TED-179: Manage payers layout | **Closed** | Screenshot `payer_split19_manage_payers.png`: Record payment, Account and Archive sit in the fund's row, and Save/Cancel sit inside the window. (My probe's automatic layout check printed BAD because its selector was wrong; the screenshot is the proof.) |
| TED-180: Void window behind History | **Closed** | `rerun18/void18.log`: `openModals ["m-void z200"]`, and the topmost thing at the button is `voidBtn`. Screenshot `rerun18/void18_window_at_e8f1d26.png`. D2/D3 are still right ($5 back, Ices restocked, Sales $0). The browser mutation MB1 was caught by the builder's real-click test. |
| TED-181: canteen dashboard refund / dispute stays on the wallet | **Closed** (edge → TED-188; test gap → TED-191) | `webhook19.log`, real webhook on a real database: C1 $0, one notice, twice delivered → once. C2 disputed → $0; won (twice) → $20 once. C3 lost → $0. C4a inquiry → nothing. C5 partials add up and are capped. C6 a spent wallet goes to −$15, and the notice says the family owes it. C7 a Snacks refund is not taken twice. C8 a dashboard refund that then fails goes back on the wallet once. `check_script19` V3/V4. Mutations M7, M8, M10–M12 caught. |
| TED-182: tip clawed back on an inquiry / late "opened" | **Closed** | `rerun/…billing-18__tip18.log`: 0 BAD. T5: the inquiry takes nothing. T3: a late "created" after a won dispute takes nothing. Mutations M13/M14 caught. |
| TED-183: never-recordable payment silent | **Closed** | `webhook19` P1: `HTTP 200/200`, emails `1/0`. P2: the email service is down → `500`, then the next delivery → `200` and 1 email. Mutations M15–M17 caught. P3: with no email key set, the answer is 200 and nobody is told. That key is a setup step (below). |
| TED-184: void restock / register test gaps | **Closed** (name edge → TED-192) | `rerun/…void_sale18.log` V3: `restocked: 0` (was 200 Chips). `check_script19` V1: last pass's 284 → "apply 284 again". Mutations M18 and M19 (last pass's missed M9) caught. |
| TED-185: offline register cached | **Closed** (test gap → TED-191) | Code: `campistry_snacks.js:1449` fetches `?v=` + build with `cache: 'no-store'` and refuses a mismatched build. The register shows "Register version" (`campistry_snacks_pos_offline.html:1283`). `rerun18/offline_register18.log`: 0 BAD. Mutation M20 caught, M21 missed. |
| TED-162: tip fee | Open, unchanged | `stripe-connect-tip` hasn't changed since `f8c5772`. Waiting on your question to Stripe. |
| TED-005: auto-scheduler | Open, deferred | Still 14 failing, all in `auto_full_day.test.js`. |

## What I confirmed is working
- **Everything in the claims list**, as the table above shows.
- **Two to six office computers on split bills:** stale saves, simultaneous cheques and corrections all land (`payer_split19`). No page errors.
- **Check script:** today's chain → 284/285/286/287 all "ok". Last pass's 284 → "apply 284 again". Without 286 → "apply 286". 287 opened to browsers → "apply 287 again". Re-pasting 284/286/287 twice leaves everything ok (`check_script19.log`).
- **Browser caching:** `campistry_me.js` 20260924-28 and `campistry_snacks.js` 20260924-14 are bumped where they load. The offline register carries its own build (20260924-02) in both files.
- **Migrations:** 286 and 287 are new, raw SQL for the SQL Editor, and in the test chain. 284 was edited in place again, but the check script catches an earlier copy.
- **Who can call it:** `record_canteen_stripe_reversal` is server-only (revoked from browsers; `check_script19` V3).
- **Leftovers:** the diff has no debug switches, TODOs or secrets, and three ordinary server log lines.
- **Photo purchases refunded in Stripe** (not tested last pass): photo purchases only unlock photos for the parent and are not in the camp's books, so a dashboard refund leaves nothing wrong in Finance. The parent simply keeps the photos. The webhook logs it and answers 200.
- **Your code didn't change under me.** HEAD is `e8f1d26` throughout; only my `ted/` folder changed. Screenshots the re-runs rewrote in last pass's folder were put back, and this pass's copies are kept in `rerun18/`.

## What I did NOT check (and why)
- **Any real processor, email or SMS service.** Stripe is modelled on its documented event shapes. Nothing is live.
- **Stripe's exact messages when an inquiry escalates** (TED-188). Stripe's documentation site is blocked from this machine.
- **The old Me page itself** (TED-190). I wrote its save straight into the database instead.
- **Live updates between office computers.** They aren't delivered in my test setup, which is the harder case.
- **The whole Link page with a real parent login**, payroll's youth-employment rules, and the tax statement's classification rules.

## Things only you can check (click-by-click)
1. **Owner steps (still pending):**
   - Supabase → **SQL Editor** → paste migrations **255 to 287 in order**, each one → **Run**.
   - Then paste `scripts/verify_identity_chain.sql` → **Run**. Every row should say "ok".
   - **286 must be in before Me is reloaded. 287 must be in before `stripe-webhook` is deployed.**
   - Supabase → **Edge Functions** → deploy `stripe-webhook` and `stripe-connect-webhook`. For `stripe-webhook`: **Settings** → **"Enforce JWT Verification" OFF**.
   - Reload Me and Snacks on **every** office computer, and don't leave an old Me page open during the update (TED-190).
2. **Email alerts:** Supabase → **Edge Functions** → `stripe-webhook` → **Secrets**. Check that `RESEND_API_KEY` is set. Without it, the "a payment could not be recorded" alert (TED-183) goes nowhere.
3. **Stripe inquiries (TED-186, 188):** ask Stripe support: *"When an inquiry (warning_needs_response) escalates to a chargeback, is it the same dispute changing status, and which webhook events are sent?"* Give the answer to the builder.
4. **Until TED-186 is fixed:** if Stripe emails you about an inquiry on a tuition payment, pause that family's autopay (**Billing** → the family → **Autopay off**) until it closes, and remove the "chargeback" line by hand afterwards.
5. **Offline tablets:** after the update, in Snacks press **Download offline POS** again and put the new file on every tablet. **Settings** on the tablet should say "Register version 20260924-02".
6. **Staff tips (TED-162):** your fee question to Stripe is still open.
