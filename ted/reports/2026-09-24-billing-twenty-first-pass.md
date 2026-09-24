# Ted's report: billing, twenty-first pass (re-check TED-193 to TED-199, then a hunt), 2026-09-24

## Verdict: 🟡 Mostly good, some issues

**All seven fixes from last pass work. I'm closing TED-193 to TED-199.** I proved each one myself, with the real payment functions on a real database and in a real browser. With two open disputes, the pause now stays on until both are settled. A replaced card no longer wipes the pause. A late message after a win no longer pauses anything. A declined card's retry date survives a dispute. Batch Charge and Charge Card now leave out a paused family. The builder's test numbers are exactly right.

**Billing is still not 100%.** The dispute pause is only set on a family that has **autopay turned on** when the dispute arrives. If a family pays by hand but has a card saved, the office can still charge the card the parent is disputing, with no warning:
- Batch Charge includes them.
- Charge Card goes through.
- Nothing on their Billing row says a dispute is open.

The same gap applies if autopay is switched on during the dispute (🟠, TED-200). There are four smaller items (🟡). I changed no product code.

## The numbers
Tests run: 3,964 · Passed: 3,950 · Failed: 14 (real bugs: 14, all of them the deferred auto-scheduler tests, TED-005 · out-of-date tests: 0 · my machine: 0)

| Suite | Run | Passed | Failed |
|---|---|---|---|
| Unit tests (`npm test`) | 3,733 | 3,719 | 14, all in `auto_full_day.test.js` (TED-005, deferred by you) |
| Database tests (`npm run test:pg`) | 77, against 136 migrations | 77 | 0 |
| `test:keys` | 42 | 42 | 0 |
| `test:lite` | 12 | 12 | 0 |
| `test:smoke` | 34 + 42 | 76 | 0 |
| `test:scale` | 24 | 24 | 0 |

These match the builder's figures exactly.

**Mutation checks** (`mutations.log`). I broke each fix on purpose, one at a time, in a scratch copy outside the project (removed afterwards). **16 of 22 were caught.**
- **Caught:** all of last pass's missed ones (M8, M12, M15, M17, M24, and the runner's dispute skip removed everywhere); TED-193's list (both ways); TED-194's `flag_plan_collection` patch (both ways); TED-195 Batch Charge and Charge Card; TED-196's database "already won" check; TED-197's restore; TED-198's Account button and "Credit" words.
- **Missed:**
  - **Removing just one of the runner's three dispute checks.** Each check is enough on its own, so the product stays right. I don't count this as a gap.
  - **Four real test gaps (TED-204):**
    - The webhook's "won/lost takes nothing" rule (N7).
    - "Keep the earlier mark under the pause" on the first pause (N10).
    - The Cancel-share window's new words (N13).
    - The check script's new "earlier copy of 288" row (N14).

  In each of the four, my own probe shows the product is right today.

**Every earlier probe, re-run at today's code** (`rerun_all21.sh`, compared by `compare_reruns21.sh`):
- **136 non-browser probes:**
  - Every exit code is the same as last pass except one.
  - 124 logs are identical once ids and times are masked.
  - 6 differ only in timings.
  - Last pass's own `dispute20` now passes everything (it had 4 BAD).
  - The one exit-code change is a wiring issue in my old probes, not the product. Four of my old Charge Card probes copy the page's functions one by one, so they don't have the new `_familyDisputed` helper. With that one helper added (`rewired/`), the corrected copy `charge_card_same_or_new15` passes 2/2 as before. The other three were already failing last pass for their own wiring.
  - The access sweep is unchanged.
- **8 browser probes that touch this commit's code:** Charge Card, bank debits, surcharge, Finance, and payer accounts. They give the same verdict lines as last pass. One screenshot they rewrote in an older folder was put back; this pass's copy is in `rerun_e2e/`.

**New probes this pass** (`ted/probes/2026-09-24-billing-21/`):
- `dispute21`: real webhook + real runner on real SQL.
- `batch21`: real Me page; Batch Charge and Charge Card with a recorder in place of Stripe, so nothing was sent.
- `moveback21`: real Me page.
- `check_script21`: real database, the owner's paste orders.
- Re-runs of last pass's `dispute20`, `billing20`, `batch20` and `void20`, plus the mutation script.

## What's wrong (most serious first)

### TED-200 🟠 A family that pays by hand can still be charged on the card they are disputing
- **What a user would see:**
  - Hazel pays by hand, but her card is saved. Fern has no payment plan at all, but her card is saved too.
  - Each paid $1,000, and each parent disputes that payment with the bank. The $1,000 goes back on their bill.
  - **Batch Charge** lists both, "Fern $2,000, Hazel $2,000", and would charge their cards. Only Teal, who has autopay, is named as "Not charged — a payment is disputed".
  - **Charge Card** on Hazel or Fern goes straight to Stripe.
  - Their Billing rows show nothing about the dispute.
  - If autopay is switched on for Hazel, or a new autopay plan is set up for Fern, during the dispute, the next nightly run charges them.
- **How sure I am:** Confirmed, on the real page and with the real runner.
- **Proof:**
  - `batch21.log` D1: "Batch Charge — 3 Families … Fern $2,000 Hazel $2,000 Olive $500 · Not charged — a payment is disputed: Teal". D2: `hazel … reached stripe-charge: 1`, `fern … reached stripe-charge: 1`, while Teal is refused. D3: Hazel's row reads "Pending — $2,000 View". Screenshot `batch21_window.png`.
  - `dispute21.log`: the pause shows `none` for Hazel and Fern (0 notices). The night's charges include `cus_fern $1000.00, cus_hazel $1000.00` while the control family Kiwi is `held_for_dispute`.
  - Cause: `288:_mark_plans_for_dispute` only marks plans with `autopay` true at that moment. The page's `_familyDisputed` (`campistry_me.js:19985-19989`) and the runner (`charge-due-installments/index.ts:791`) look only at those plan marks. Also, `stripe-charge` has no dispute check of its own, so the page is the only guard.
- **What to ask the builder for:** "TED-200: the dispute pause only lands on plans with autopay on at that moment. A hand-paying family (Hazel, plan autopay off) or one with no plan (Fern) is still charged by Batch Charge and Charge Card, shows nothing in Billing, and is charged by autopay if it's switched on mid-dispute (ted/probes/2026-09-24-billing-21 batch21 D1/D2, dispute21 H1/H2). Keep the open-dispute list on the family itself, not only on autopay plans. Have Billing, Batch Charge, Charge Card, the runner, and stripe-charge on the server all check it."

### TED-201 🟡 An older-style family (single "plan") is never paused
- **What a user would see:** a family whose data still has the pre-multi-plan single `plan` is not paused by a dispute. The next nightly run charges the disputed card ($500 in my run).
- **How sure I am:** Confirmed. It only matters for data from before multi-plan families. No code writes that shape any more, and there are no live camps. However, every other server money function (215, 233, 269) and the page still read it.
- **Proof:** `dispute21.log` H3: Ash `pause none`, then the night charges `cus_ash $500.00`. Cause: `_mark_plans_for_dispute` reads only `p_fam->'plans'`, while `_plan_path` (269) and the runner (`index.ts:715-717`) also handle `plan`.
- **What to ask the builder for:** "TED-201: 288's pause ignores the legacy single `plan` (dispute21 H3: Ash charged $500 mid-dispute). Handle `plan` like _plan_path does. The TED-200 fix may cover this if the pause moves to the family."

### TED-202 🟡 "Resume autopay" clears every dispute, including one still open
- **What a user would see:**
  - Rose2 has two disputes. The camp loses the first, so autopay stays paused, correctly.
  - The office clicks "Autopay paused", reads "Resume it only if the dispute is over", and presses Resume.
  - The pause for the second, still-open dispute goes too. Nothing in that window says a second dispute is open.
- **How sure I am:** Confirmed.
- **Proof:** `dispute21.log` H4: before, `{"reason":"chargeback","disputeIds":["dp_r2A","dp_r2B"]}`; resume gives `{"changed": true}`; after, `pause now none (dispute B still open)`. The dialog wording is at `campistry_me.js:6631`. `resume_autopay_after_dispute` calls `_mark_plans_for_dispute(…, NULL, false)`, which empties the list.
- **What to ask the builder for:** "TED-202: with two disputes (one lost, one open), Resume clears both (dispute21 H4). Have a loss mark its id as lost, have Resume lift only lost ones, or at least have the Resume window say how many disputes are still open."

### TED-203 🟡 "Move back to family" after a fund paid: the family is billed the full share, and nobody is told
- **What a user would see:**
  - The Scholarship Fund owes $800 of Pine's bill and has paid $300.
  - The office presses **Move back to family**. The window only says "Move this $800 share back to the Pine family's own bill?", and the message afterwards only says "$800 moved back to Pine's bill".
  - Pine now owes $1,000, and autopay would charge that ($1,000 due tonight). Meanwhile the fund's $300 sits as a credit.
  - Manage payers does now show "Credit $300 — return it to them…". But nothing at the moment of the move tells the office that the family is being billed for money the fund already paid.
  - TED-198's words were added to **Cancel share** only.
- **How sure I am:** Confirmed on the real Me page.
- **Proof:** `moveback21.log` S3: the confirm said "Move this $800 share back to the Pine family's own bill? Scholarship Fund will no longer owe it."; toast `✓ $800 moved back to Pine's bill`; `Pine owes $1000`; fund `{"charged":0,"paid":300,"owes":-300}`; `plan_due_for … "amount": 1000.00`. Code: `campistry_me.js:18842, 18860`.
- **What to ask the builder for:** "TED-203: Move back after the fund paid $300 bills Pine the full $800 with no word about the $300 (moveback21 S3; autopay would take $1,000). Say in the Move back window what the fund already paid, and offer to move back only the unpaid part ($500) or to apply the fund's credit."

### TED-204 🟡 Four new safety rules without a working test
- **What a user would see:** nothing today. These tests would catch a future mistake.
- **How sure I am:** Confirmed. In `mutations.log`, each of these passes every test:
  - **N7:** the webhook counting won/lost as "taking" again.
  - **N10:** the first pause not keeping an earlier decline mark.
  - **N13:** the Cancel-share words removed.
  - **N14:** the check script's "earlier copy of 288" row switched off.

  Also, the TED-198 test checks the Account button only by matching the page's source text.
- **Proof that the product is right today:**
  - `dispute20_rerun.log`: T6a/T6b and T7 are ok.
  - `rerun20/billing20.log` S3: the new Cancel-share words are shown.
  - `check_script21.log`:
    - V1: last pass's 288 gives "apply 288 again".
    - V4: 214 re-pasted after 288 is caught.
    - V2: an old-style pause picks up a second dispute correctly.
- **What to ask the builder for:** "TED-204: tests miss mutations N7, N10, N13, N14 (ted/probes/2026-09-24-billing-21/mutations.log). Test a late updated(won) through the webhook, a first pause over a declined mark, the Cancel-share words, and the check script on an earlier 288."

## Re-check of last report's findings
| ID | Now | My proof |
|----|-----|----------|
| TED-193: two disputes, first win restarts autopay | **Closed** | `dispute20` re-run T5: after A is won, the pause is `{"reason":"chargeback","disputeId":"dp_rB"}`; N1 charges no `cus_rose`. `check_script21` V2: a pause stored by the old 288 still takes in a second dispute and lifts only after both are won. N1/N2 caught. |
| TED-194: no-card night wipes the pause | **Closed** | `dispute20` N2a: the pause survives the no-card night; N2b: the new card is not charged. `flag_plan_collection` is patched (`v_cb` in the function after 288 over 214+269; `check_script21` V2). N3/N4 caught. |
| TED-195: Batch Charge charges a paused family | **Closed** for autopay families (the gap for others → TED-200) | `batch21` D1: Teal left out and named "Not charged — a payment is disputed: Teal"; D2: Charge Card on Teal is refused, 0 requests. `batch20` re-run: only Teal eligible → "Nothing to charge" (no window). N5/N6 caught. |
| TED-196: late message after a win re-pauses | **Closed** (test gap N7 → TED-204) | `dispute20` T6a/T6b: `pause none` after a late updated(won) and a re-sent funds_withdrawn; C9 canteen $20. N8 caught. |
| TED-197: decline wait erased | **Closed** (test gap N10 → TED-204) | `dispute20` T7: after the win, `{"reason":"declined","nextRetryAt":"2099-01-01","attempts":1}`. N9 caught. |
| TED-198: "owes $-300", Account hidden | **Closed** for Cancel share (Move back → TED-203) | `rerun20/billing20` S3: the confirm names "Scholarship Fund has paid $300 so far…"; toast "Scholarship Fund: Credit $300 — return it to them, or keep it for a later share". S4: Manage payers shows the Credit line and an **Account** button. N11/N12 caught. |
| TED-199: seven untested rules | **Closed** | M8, M12, M15, M17, M24 and the runner skip removed everywhere are all caught now. The runner test has a control family that is charged (`cus_olive`). |
| TED-162: tip fee | Open, unchanged | `stripe-connect-tip` last changed in `f8c5772`. Waiting on your question to Stripe. |
| TED-005: auto-scheduler | Open, deferred | Still 14 failing, all in `auto_full_day.test.js`. |

## What I confirmed is working
- **Every claim in the builder's list.** The table above has the proof. Notes on four of them:
  - The runner skips a disputed family before the card check: `index.ts:791`, and `dispute20` N2.
  - The view-only resume test uses a stubbed resolver answering "view" (pgtest 288). It fails when the Billing-edit check is removed (M12).
  - The version bump is right. `campistry_me.js?v=20260924-31` in `campistry_me.html:343` is the only place the file is loaded.
  - The suite numbers match exactly.
- **Migration 288, pasted the ways the owner might paste it** (`check_script21`, 0 BAD):
  - On a fresh chain, the check row says "ok".
  - Last pass's copy pasted over today's gives "apply 288 again".
  - Today's copy pasted over last pass's copy patches `flag_plan_collection` once.
  - Pasting it twice more changes nothing.
  - 214 re-pasted after it is caught.
- **Leftovers:** no debug switches, TODOs, secrets or new log lines in the product diff.
- **Your code didn't change under me.** HEAD was `dc83cf0` the whole time, and only my `ted/` folder changed.

## What I did NOT check (and why)
- **Any real processor, email or SMS service.** Stripe is modelled on its documented event shapes, and nothing is live.
- **Stripe's newer dispute statuses** (for example `prevented`, used by some card networks' early-resolution programs). The webhook treats any status other than inquiry/won/lost as money taken. `docs.stripe.com` is blocked from this machine.
- **Two office computers with realtime updates.** A computer that was open before a dispute arrived may still have the family unpaused in memory. Because `stripe-charge` has no dispute check (TED-200), such a computer's Batch Charge would charge. I could not model Supabase realtime faithfully here, so this is suspected, not shown.
- **The Link page with a real parent login**, payroll's youth rules, and the tax statement's classification rules.

## Things only you can check (click-by-click)
1. **Owner steps (still pending):**
   - Supabase → **SQL Editor** → paste migrations **255 to 289 in order**, each one → **Run**. If you pasted an earlier 288, paste today's 288 again.
   - Then paste `scripts/verify_identity_chain.sql` → **Run**. Every row should say "ok".
   - 288 must be in before `stripe-webhook` and `charge-due-installments` are deployed.
   - Supabase → **Edge Functions** → deploy `stripe-webhook`, `stripe-connect-webhook` and `charge-due-installments`. For `stripe-webhook`: **Settings** → **"Enforce JWT Verification" OFF**.
2. **Stripe webhook events:**
   - Stripe Dashboard → **Developers → Webhooks** → your Campistry endpoint → **Edit**.
   - Make sure **charge.dispute.created, .updated, .funds_withdrawn and .closed** are all ticked, on both the main endpoint and the Connect (tips) endpoint.
3. **Until TED-200 is fixed:**
   - When Stripe emails you about a dispute, open Billing and look up that family.
   - If their row does **not** say "Autopay paused", don't include them in **Batch Charge** and don't press **Charge Card** for them until the dispute is over. Untick them, or charge families one by one.
4. **Ask Stripe support:** *"Which dispute statuses can charge.dispute.updated carry, including 'prevented'? When a dispute closes as won, do you also send charge.dispute.updated, and in what order?"* Give the answer to the builder.
5. **Staff tips (TED-162):** your fee question to Stripe is still open.
