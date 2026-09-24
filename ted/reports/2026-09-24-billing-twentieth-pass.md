# Ted's report: billing, twentieth pass (re-check TED-186 to TED-192, then a hunt), 2026-09-24

## Verdict: 🟡 Mostly good, some issues

**All seven fixes from last pass work, and I'm closing every one: TED-186 to TED-192.** The serious one is fixed: a bank *inquiry* no longer puts a paid tuition payment back on the bill, and a real chargeback now pauses that family's autopay. I proved each fix myself, in a real browser or with the real payment functions on a real database. The builder's test numbers are exactly right.

**Billing is not 100% yet.** The hunt found gaps in the new "pause autopay during a dispute" rule. In three situations a card the parent is disputing can still be charged again:
- **Two disputes at once (🟠).** When a parent disputes two instalments and the camp wins the first, autopay restarts while the second dispute is still open.
- **The card is replaced (🟠).** If the family's card is removed during a dispute, the pause is lost. Autopay then charges the new card while the dispute is still open.
- **Batch Charge (🟠).** Billing's Batch Charge still lists a disputed family and charges them, with no warning.

There are also four smaller items (🟡). I did not change any product code. I only reported.

## The numbers
Tests run: 3,957 · Passed: 3,943 · Failed: 14 (real bugs: 14, all of them the deferred auto-scheduler tests, TED-005 · out-of-date tests: 0 · my machine: 0)

| Suite | Run | Passed | Failed |
|---|---|---|---|
| Unit tests (`npm test`) | 3,726 | 3,712 | 14, all in `auto_full_day.test.js` (TED-005, deferred by you) |
| Database tests (`npm run test:pg`) | 77, against 136 migrations | 77 | 0 |
| `test:keys` | 42 | 42 | 0 |
| `test:lite` | 12 | 12 | 0 |
| `test:smoke` | 34 + 42 | 76 | 0 |
| `test:scale` | 24 | 24 | 0 |

These match the builder's figures exactly.

**Mutation checks** (`mutations.log`). I broke each fix on purpose, one at a time, in a scratch copy outside the project (removed afterwards). **18 of 25 were caught.**
- **Caught:**
  - The inquiry rule.
  - The escalation messages.
  - Pausing autopay, and resuming it on a win.
  - All three "answer 500" fixes.
  - 288's "only this dispute's pause" rule, and its "autopay plans only" rule.
  - The canteen escalation.
  - Cancel share.
  - All three of last pass's missed tests (287's cap, 287's once-per-refund rule, the register's version check).
  - 289 keeping the items; 284's cap by item; the register sending the items.
  - 283 pasted again after 289.
- **Missed** (test gaps only; see TED-199): M8, M9, M10, M12, M15, M17, M24. In every one of these cases, my own probe shows the product behaves correctly today.

**Every earlier probe, re-run at today's code** (`rerun_all20.sh`, compared by `compare_reruns20.sh`):
- **133 non-browser probes:**
  - Every exit code is identical to last pass.
  - 123 logs are the same once ids and times are masked.
  - 5 differ only in timings.
  - `access_sweep` now lists 2 more browser-callable money functions. Both are properly locked: the office's "resume autopay" (staff with Billing edit only), and the register's new charge (staff only).
  - Last pass's own probes now pass:
    - `refund_write_fails19` R1–R3 now answer 500 (was 200).
    - `webhook19` T1, T2 and C4b now ok.
  - `void_names19` is unchanged, because it makes its sale the old way (see TED-192 below).
- **25 browser probes:**
  - The same verdicts as last pass, except `payer_migrate19` M2, which is now fixed.
  - Two older probes now show a BAD line because of their own wiring, not the product:
    - `billing_refund_again14/15` C4 now gets HTTP 500. My probe passes the refund list to the database in a form real Supabase converts but my test bridge doesn't. TED-187 now (correctly) reports database errors, so it shows. The books are unchanged and right. `refund_again_500_20.log` shows the exact error.
    - `pos17` drops the old 7-part register function, which 289 already removed.

**New probes this pass** (`ted/probes/2026-09-24-billing-20/`):
- `dispute20` (real webhook + real nightly runner on a real database, 11 cases).
- `runner_installments20` (real runner, older-style plans, with a control family).
- `billing20`, `batch20`, `void20` (real browser; `void20` uses the real register, then the real Snacks page).
- `check_script20` (real database).
- The mutation script and the re-run.

## What's wrong (most serious first)

### TED-193 🟠 Winning one dispute restarts autopay while another dispute is still open
- **What a user would see:**
  - Rose paid two $500 instalments by card. The parent disputes both with the bank (common with a "fraud" claim, which covers every charge).
  - Autopay pauses, correctly.
  - The camp wins the first dispute, and autopay starts again. **The second dispute is still open.**
  - That night Rose's card, the one the parent is disputing, is charged again.
- **How sure I am:** Confirmed, with the real webhook and the real nightly runner on a real database.
- **Proof:**
  - `dispute20.log` T5: with both open, the pause reads `{"reason":"chargeback","disputeId":"dp_rA"}`. After A is won: `pause none`, `plan_due_for … "amount": 250.00`.
  - N1: the runner's charges include `cus_rose $250.00`.
  - Cause: the plan remembers only the first dispute's id (`288:_mark_plans_for_dispute` doesn't mark again when a pause is already there). A win releases the pause when its id matches, even if other disputes are open.
- **What to ask the builder for:** "TED-193: with two open disputes on one family, winning the first takes the autopay pause off while the second is still open (dispute20 T5; N1 then charges Rose $250). Keep a list of open dispute ids on the pause and only lift it when none is left; add a pgtest with two disputes."

### TED-194 🟠 A night with no card on file wipes the dispute pause, so a new card is charged mid-dispute
- **What a user would see:**
  - Mint's $1,000 payment is disputed, and autopay pauses.
  - During the dispute the card is removed (banks often cancel a card after a fraud claim), and one nightly run happens.
  - The runner writes "no card on file" over the dispute pause.
  - The parent saves a new card, and a few nights later **autopay charges the new card $500 while the dispute is still open.**
- **How sure I am:** Confirmed, with the real runner on a real database.
- **Proof:**
  - `dispute20.log` N2: after the no-card night, the pause reads `{"reason":"no_card","nextRetryAt":"2026-09-27"}`, and the dispute mark is gone.
  - A later night gives `Mint:charged`, `cus_mint $500.00`, with dispute dp_m1 still open.
  - Cause: `charge-due-installments/index.ts:787-799` calls `flag_plan_collection(…,'no_card')` before the dispute check, and `flag_plan_collection` (`214`) replaces whatever pause is on the plan.
- **What to ask the builder for:** "TED-194: the runner's no-card step (charge-due-installments :787-799 → flag_plan_collection) overwrites a chargeback pause; after a new card is saved autopay charges mid-dispute (dispute20 N2). Skip a family whose plan is paused for a chargeback before the card check, and make flag_plan_collection never replace a 'chargeback' mark."

### TED-195 🟠 Batch Charge charges a family whose payment is disputed, with no warning
- **What a user would see:**
  - Teal's payment was charged back, so Teal "owes" it again and autopay is paused.
  - The office presses **Batch Charge** in Billing. The window lists "Teal $1,000", and pressing Save charges Teal's card.
  - Nothing in that window says Teal is in a dispute. The red "Autopay paused" note is only on the family row.
- **How sure I am:** Confirmed on the real Me page (I read the window and cancelled; nothing was charged).
- **Proof:**
  - `batch20.log`: `Batch Charge — 1 Families … Teal $1,000`, while the plan's mark in the cloud is `{"reason":"chargeback","disputeId":"dp_t"}`.
  - Cause: `campistry_me.js:20214-20221` leaves out only families with a bank debit on its way.
- **What to ask the builder for:** "TED-195: Batch Charge includes a family whose autopay is paused for a chargeback (batch20). Leave such families out and name them under 'Not charged — a payment is disputed', like the bank-debit case."

### TED-196 🟡 A late dispute message after a win pauses autopay again, silently
- **What a user would see:**
  - The camp wins Lime's dispute, and autopay starts again.
  - If Stripe then delivers a late message about the same dispute, autopay pauses again with no new notice. The late message can be an "updated" carrying status *won*, or a re-sent "funds withdrawn".
  - Lime's autopay stops collecting until someone notices the red note in Billing.
- **How sure I am:** The behaviour is confirmed. How often Stripe delivers messages in that order is not known: Stripe does not promise any order, and it re-sends a message that got an error.
- **Proof:**
  - `dispute20.log` T6: after the win, `pause none`. A late updated(won) gives `pause {"reason":"chargeback","disputeId":"dp_l1"}`. The re-sent funds_withdrawn gives the same. Pause notices stay at `1`.
  - Cause: `stripe-webhook handleDisputeLedger` treats any non-inquiry status (won and lost included) as "taking". `record_chargeback` answers `alreadyRecorded` with the family, and the hold is set again.
  - Canteen and tips are safe here: `dispute20` C9 keeps the wallet at $20, and tips already guard this since TED-182.
- **What to ask the builder for:** "TED-196: after a won dispute, a late charge.dispute.updated (status won) or a re-sent funds_withdrawn pauses autopay again (dispute20 T6). Don't treat won/lost as 'taking', and don't re-pause when the chargeback already has its le_cbwon_ line."

### TED-197 🟡 A dispute pause erases a card's "try again next week" wait
- **What a user would see:**
  - Plum's card was declined, and autopay was told to wait until the retry date.
  - An older payment of Plum's is disputed and then won. The pause is lifted, and the decline wait goes with it.
  - Autopay retries the declined card that same night, ahead of schedule.
- **How sure I am:** Confirmed.
- **Proof:**
  - `dispute20.log` T7: before, `{"reason":"declined","nextRetryAt":"2099-01-01"}`; disputed, `chargeback`; won, `none`.
  - N1 then charges `cus_plum $250.00`.
  - Cause: `288` overwrites `collectionBlocked` and removes it on release.
- **What to ask the builder for:** "TED-197: 288's pause replaces a declined/no-card mark and the win deletes it, so the decline schedule is lost (dispute20 T7). Keep the earlier mark under the pause and put it back on release."

### TED-198 🟡 After "Cancel share", a fund's cheque is left with nowhere to go
- **What a user would see:**
  - The Scholarship Fund owes $800 of Pine's tuition and has paid $300 by cheque. The child withdraws.
  - The office presses **Cancel share**. The window says "Nobody will owe it", but doesn't mention the $300 already paid.
  - Afterwards the toast reads "Scholarship Fund owes $-300".
  - The fund disappears from Manage payers' money lines: no "Owes", no **Account** button. The $300 cheque can no longer be seen there or removed, and nothing says it should be returned to the fund.
  - Finance still counts the $300 as collected. (Moving the share back to the family has the same effect.)
- **How sure I am:** Confirmed on the real Me page.
- **Proof:**
  - `billing20.log` S3: the toast "$800 share cancelled — Scholarship Fund owes $-300"; fund `{"charged":0,"paid":300,"owes":-300}`.
  - S4: Manage payers shows `Scholarship Fund organization Archive` with no Account button.
  - Cause: `campistry_me.js:1869-1874` shows the Account button only when `charged>0`.
  - Screenshot `billing20_after_cancel.png`.
- **What to ask the builder for:** "TED-198: after Cancel share (or Move back) on a fund that already paid, the fund shows 'owes $-300' in a toast and its Account button disappears (billing20 S4). Keep Account visible whenever a payer has any lines, show a credit as 'Credit $300 — return or apply it', and say in the Cancel share window how much the fund has already paid."

### TED-199 🟡 Seven safety rules without a working test
- **What a user would see:** nothing today. These guards would catch a future mistake.
- **How sure I am:** Confirmed. In `mutations.log`, each of these passes every test:
  - M8: an autopay-pause database error answered 200.
  - M9 and M10: the runner's dispute skip removed from *either one* of its two places. The builder's test uses families the runner would not charge anyway, so "0 charges" proves nothing. Only removing both is caught.
  - M12: resume allowed without Billing edit.
  - M15: tips' funds_withdrawn not routed.
  - M17: TED-190's "already moved" skip removed. The test uses a one-family cheque, which the old code already handled; the real case is a cheque split across two families.
  - M24: the Void window ignoring soldItems. The test calls the helper directly, not the window.
- **Proof that the product is right today:**
  - `runner_installments20.log`: Teal held, Olive (control) charged. With the skip removed in a scratch copy, Teal is charged.
  - `dispute20` N1 (the dueDates plans).
  - `payer_migrate19` M2.
  - `void20` V2.
  - Code read of 288 (the Billing-edit check) and of `stripe-connect-webhook:616-618`.
- **What to ask the builder for:** "TED-199: tests miss mutations M8, M9, M10, M12, M15, M17, M24 (ted/probes/2026-09-24-billing-20/mutations.log). Give the runner test a control family that IS charged, the TED-190 test a two-family cheque, and test the Void window's call, a view-only resume, the hold error and connect funds_withdrawn."

## Re-check of last report's findings
| ID | Now | My proof |
|----|-----|----------|
| TED-186: inquiry posted as a chargeback; autopay re-charges | **Closed** (edges → TED-193…197) | `dispute20` T1: an inquiry, then its close → still owes $500, no pause. T2: `nothing_owed`. T3: escalated → owes $1,000 once, one chargeback line, pause `dp_t2`, one notice, no extra email. T4: won → $0, pause off. T8: lost → pause stays; the owner's resume clears it. N1: the real runner gives `Mint:held_for_dispute`, no charge, and the control family is charged. `runner_installments20`: the older plan type is held too. Real browser (`billing20` B1–B3): Billing and the family page show "Autopay paused — a payment is disputed with the bank". Clicking it gives the resume question; resume clears it in the cloud; a stale computer's save doesn't bring it back. Last pass's `webhook19` T1/T2 are now ok. Mutations M1–M4, M11, M13 caught. |
| TED-187: DB error on refund/chargeback/close answered 200 | **Closed** (test gap M8 → TED-199) | Last pass's `refund_write_fails19`, re-run: R1, R2 and R3 now answer `HTTP 500` (they were 200). The canteen and payment controls are still 500. M5–M7 caught. |
| TED-188: escalated canteen inquiry stays on the wallet | **Closed** (test gap M15 → TED-199) | `webhook19` C4b re-run: `Dov $0.00; notices for Dov 1` after updated/funds_withdrawn. `dispute20` C9: late messages after a win take nothing. M14 caught. Tips route funds_withdrawn (`stripe-connect-webhook:616-618`). The guides list the new events. Two outside write-ups say an escalated inquiry is the same dispute object and triggers `charge.dispute.updated` (search results below); Stripe's own docs are blocked from this machine. |
| TED-189: no plain "cancel a fund's share" | **Closed** (residual → TED-198) | `billing20` S2: the credit window says "Part of this bill is paid by Scholarship Fund ($800)… use that payer's account → Cancel share". S3: Cancel share → fund charged $0, Pine still $200, `plan_due_for` 200, and no charge added to the family. M16 caught. |
| TED-190: old payer list counted a cheque twice | **Closed** (test gap M17 → TED-199) | `payer_migrate19` re-run, real browser: M2 is now `paid 1000` (it was 2000), and Manage payers shows "Owes $300 (shares $1,300, paid $1,000)". |
| TED-191: three safety rules untested | **Closed** | Last pass's missed mutations are now caught (M18, M19, M20). |
| TED-192: void couldn't restock "Trail Mix 2" / "Chips, BBQ" | **Closed** (test gap M24 → TED-199) | `void20`, real register → real Snacks: the register sends `p_sold [{"id":11,"qty":2},{"id":12,"qty":1}]`, and the sale keeps it. Void offers "Put 2 × Trail Mix 2" and "Put 1 × Chips, BBQ"; after the void Avi has $20 and stock is back to 10/10. `check_script20`: an old 284 → "apply 284 again"; an old 283 pasted after 289 → "apply 289 again" (a register left un-reloaded then gets "is not unique", which is why the row matters); re-pasting twice is ok. M21–M23, M25 caught. **Limit:** sales made before 289, by a register that wasn't reloaded, or on the offline register, still restock by name. `void_names19` is unchanged for those, and the Void window says so rather than restocking the wrong thing. |
| TED-162: tip fee | Open, unchanged | `stripe-connect-tip` hasn't changed since `f8c5772`. Waiting on your question to Stripe. |
| TED-005: auto-scheduler | Open, deferred | Still 14 failing, all in `auto_full_day.test.js`. |

## What I confirmed is working
- **Everything in the claims list**, as the table above shows. The version numbers are right: `campistry_me.js` 20260924-30, `campistry_snacks.js` 20260924-15 and `campistry_snacks_pos.js` 20260924-03 are bumped where they load.
- **Check script:** rows 283 to 289 all say "ok" on today's chain. It catches an old 284, a missing or browser-open 288, and an old 283 pasted after 289 (`check_script20.log`).
- **Who can call it:** `hold_autopay_for_dispute` is server-only. Resuming needs Billing edit; a stranger is refused (pgtest 288). The access sweep's two new entries are both properly locked.
- **Migrations:** 288 and 289 are new, raw SQL for the SQL Editor, and in the test chain. 283 and 284 were edited in place, and the check script catches older copies.
- **Leftovers:** the diff has no debug switches, TODOs or secrets, and one ordinary server log line.
- **Your code didn't change under me.** HEAD is `a941220` throughout; only my `ted/` folder changed. Three screenshots the re-runs rewrote in last pass's folder were put back; this pass's copies are in `rerun18/`.

## What I did NOT check (and why)
- **Any real processor, email or SMS service.** Stripe is modelled on its documented event shapes. Nothing is live.
- **Stripe's own documentation** on escalated inquiries and on event order at the close of a dispute (TED-188, TED-196). `docs.stripe.com` is blocked here. Third-party pages found by search ([chargeflow](https://www.chargeflow.io/chargebacks-101/stripe-chargebacks), [chargeback.io](https://www.chargeback.io/blog/stripe-chargeback-policy)) say an escalated inquiry is the same dispute object and triggers `charge.dispute.updated`. The code handles both that and a fresh "created".
- **A view-only Billing user pressing "resume"**: code read only (TED-199 M12).
- **The Link page with a real parent login**, payroll's youth-employment rules, and the tax statement's classification rules.

## Things only you can check (click-by-click)
1. **Owner steps (still pending):**
   - Supabase → **SQL Editor** → paste migrations **255 to 289 in order**, each one → **Run**.
   - Then paste `scripts/verify_identity_chain.sql` → **Run**. Every row should say "ok".
   - **288 must be in before `stripe-webhook` and `charge-due-installments` are deployed. 289 must be in before the register (POS) is reloaded.**
   - Supabase → **Edge Functions** → deploy `stripe-webhook`, `stripe-connect-webhook` and `charge-due-installments`. For `stripe-webhook`: **Settings** → **"Enforce JWT Verification" OFF**.
2. **Stripe webhook events:**
   - Stripe Dashboard → **Developers → Webhooks** → your Campistry endpoint → **Edit** → add **charge.dispute.updated** and **charge.dispute.funds_withdrawn**, next to created/closed.
   - Do the same on the Connect (tips) endpoint.
3. **Email alerts:** Supabase → **Edge Functions** → `stripe-webhook` → **Secrets**. Check that `RESEND_API_KEY` is set.
4. **Ask Stripe support**:
   - *"When an inquiry escalates, is it the same dispute changing status, and which events are sent?"*
   - *"When a dispute closes as won, do you also send charge.dispute.updated, and in what order?"*
   - Give the answers to the builder (TED-188, TED-196).
5. **Until TED-193/194/195 are fixed:** if Stripe tells you a family has a dispute, don't use **Batch Charge** without first checking the list. If a family has more than one dispute, turn their autopay off by hand (**Billing** → the family → **Autopay off**) until all are closed.
6. **Registers:** after 289, reload the POS on every register, and download the offline POS again for the tablets.
7. **Staff tips (TED-162):** your fee question to Stripe is still open.
