# Ted's report: billing, fourth pass (re-check TED-076 to TED-087, then a hunt), 2026-09-24

## Verdict: 🔴 Problems found

I re-checked all 12 billing findings from the third pass. The builder's fixes hold for the cases they describe, and I'm closing 11 of them with my own proof. TED-077 (Zelle payments) stays open in a narrower form. Then I looked again across the whole billing area and found 7 new problems. Two of them are serious and older than this batch. **First, parents see a balance in Link that ignores autopay charges, Zelle payments and shop charges until the office next saves, so a parent can pay the same money twice. Second, since 18 September a parent cannot pay the registration deposit on the form right after applying.** So no: billing is not yet 100% correct. I did not fix anything; my job is to report so the builder can fix it.

## The numbers
Tests run: 3,576 · Passed: 3,562 · Failed: 14 (real bugs: 14, all the deferred auto-scheduler failures TED-005 · out-of-date tests: 0 · my machine: 0)

- Unit tests (`npm test`): 3,407 run, 3,393 passed, 14 failed (all in `auto_full_day.test.js`, TED-005, deferred by the owner).
- Database tests (`npm run test:pg`): 59 of 59 passed, against 118 migrations.
- `test:keys` 42/42 · `test:lite` 12/12 · `test:smoke` 32/32 · `test:scale` 24/24.
- These match the builder's figures exactly.
- **The builder's new tests, run against the code from before their fixes** (a scratch copy, removed afterwards):

  | Test file | Failed on the old code |
  |---|---|
  | `registration_deposit_charge` | 4 of 10 |
  | `canteen_autoreload_once` | 2 of 4 |
  | `ted087_loose_ends` | 4 of 4 |
  | `autopay_runner` | 6 of 18 |
  | `charges_reach_the_ledger` (old Me page) | 3 of 19 (TED-081, TED-082 ×2) |
  | `office_plan_is_ledger_plan` (old Link page) | 1 of 11 (TED-080) |

- **Mutations I made myself:**
  - I removed the TED-079 guard, and the TED-079 test failed.
  - I removed Add Charge's "above zero" check, and the TED-062 test failed.
  - So those tests really test the behaviour.
- **My proof runs** are in `ted/probes/2026-09-24-billing-4/`:
  - 11 runs on a scratch database built from the project's own migration chain;
  - 1 run of a real edge function through `tests/edge_harness.js`;
  - I also re-ran all 12 of my third-pass probes.

## What's wrong (most serious first)

### TED-088 🔴 The parent's balance in Link ignores payments and charges the server records, so a parent can pay twice
- **What a user would see:**
  - A family owes $1,000. Autopay takes $300 overnight, or the family pays $400 by Zelle, or the shop bills a $40 order.
  - The office's Billing page shows the new balance. The parent's Link page still says **$1,000**. The "Pay now" button offers $1,000, and the payment schedule is worked out from $1,000.
  - The parent's page only catches up the next time someone in the office saves the Me page.
  - A Billing tab left open from before puts the parent's figure back to the old number when it saves.
- **How sure I am:** Confirmed on the scratch database. It has been this way since families moved into their own rows (22 September).
- **Proof:**
  - `probes/…-4/parent_balance.js`:
    - at the start: office 1000, parent 1000;
    - after a Zelle payment of $400: office **600**, parent **1000**;
    - after an autopay charge of $300: office **300**, parent **1000**;
    - only after an office save of the settings document: parent 300.
  - The cause:
    - `get_my_balance` reads `projected_family_ledger`, which reads `family_ledger_projection`.
    - Only migration 202's trigger on the `campistryMe` settings row fills that table (`migrations/202_ledger_projection.sql:113-180`).
    - Every server writer (`camp_family_save`, `migrations/213…sql:161`) writes the family rows instead. Autopay, webhooks, the shop and the new Zelle trigger all use it.
    - Commit 422076a moved five readers onto the rows but not this one.
    - Pay Now charges whatever amount the page sends (`stripe-checkout/index.ts:216-271`), so it charges the old figure.
- **What to ask the builder for:** "get_my_balance's ledger path still reads family_ledger_projection (fed only from the campistryMe document), so the parent never sees autopay, webhook, Zelle or shop entries written to camp_families rows (TED-088). Make it read the rows (camp_family / camp_families_object) the way 422076a moved the other readers, and add a pgtest: a parent's balance drops right after record_autopay_charge and after a Zelle deposit, with no office save in between."

### TED-089 🔴 Since 18 September a parent can't pay the registration deposit on the form after applying
- **What a user would see:**
  - A parent fills in the registration form, their card is accepted, and they submit.
  - The form then tries to take the deposit and fails with "We could not find that application." Nothing is charged.
  - The same happens with the processor's hosted pay page. The application sits as "awaiting deposit".
  - It starts working only after someone in the office opens the Me page, which pulls the new application in.
- **How sure I am:** Confirmed at the database level. I also read the form's code: it asks for the deposit 0.9 s after submitting. I did not run it in a browser.
- **Proof:**
  - `probes/…-4/regdep_new_app.js`:
    - `submit_public_application` → success, and the application is 1 row in `camp_applications`;
    - `_registration_deposit_owed` → `application_not_found`;
    - `_record_registration_deposit` → `application_not_found`.
  - The cause:
    - Migration 200 (18 September) moved new applications into `camp_applications`.
    - Both deposit functions still read only `campistryMe.enrollments` (`migrations/190…sql:269-276`, `migrations/185…sql:94-101`).
    - `registration-deposit-checkout/index.ts:167-177` answers 404 on that.
    - The form calls it automatically (`campistry_register.html:2540-2543`).
  - The builder's deposit tests pretend `_registration_deposit_owed` always finds the application, so none of them could catch this.
- **What to ask the builder for:** "_registration_deposit_owed and _record_registration_deposit only look in campistryMe.enrollments, but since migration 200 a new application lives in camp_applications until the office absorbs it, so the form's deposit payment always fails with 404 (TED-089). Make both read (and _record write) the camp_applications row when the blob has none, and add a pgtest: submit_public_application, then _registration_deposit_owed → owed 250, _record_registration_deposit → paid."

### TED-090 🟠 A deposit taken by card never lowers the family's balance, so autopay collects it again
- **What a user would see:**
  - The parent pays a $250 registration deposit by card through Campistry, and the application shows "paid".
  - When the family is enrolled, Billing, the parent's balance and autopay all still bill the full tuition.
  - The $250 counts only if someone in the office remembers to type it into Billing by hand, and nothing reminds them.
  - A payment typed in by hand also can't be refunded back to the card from Billing.
- **How sure I am:** Confirmed by reading the code: I found no path that turns a charged deposit into a payment. I have not seen it on a live camp.
- **Proof:**
  - `_record_registration_deposit` only sets `depositPaid` on the application (`migrations/185…sql:109-126`).
  - Across all of the project's code, `depositPaid` is read only by the application screen, the deposit rules and the form. It is never read by Billing, the ledger or `get_my_balance`.
  - `enrollCamper` (`campistry_me.js:14952-15100`) has no deposit step.
  - The manual "Mark deposit received" button says "record the money itself in Billing so it counts toward tuition" (`:19654`). The card path shows no such message.
  - `stripe-webhook/index.ts:899-903` says a deposit "becomes an ordinary payment when the office accepts and enrolls". Nothing does that.
- **What to ask the builder for:** "A registration deposit charged by card (depositPaid + depositReference) never becomes a payment on the family's ledger (TED-090). When the office enrolls the application, post it as a payment entry keyed on depositReference (so it is refundable and never doubled), and add a test: $250 card deposit, enroll, balance = tuition − 250."

### TED-091 🟠 A Billing tab left open cancels a shop order that was billed after it opened
- **What a user would see:**
  - The office opens Billing in the morning. At lunch the shop bills a $40 sweatshirt to a family.
  - In the afternoon the office, in the same tab, adds a $10 photo charge to that family.
  - The next time anyone opens Billing, the $40 is taken off automatically, with a line reading "Cancelled — charge". The family owes $40 less than it should.
- **How sure I am:** Confirmed on the scratch database (the real `settle_shop_order`, the real save, the real Me-page catch-up).
- **Proof:**
  - `probes/…-4/stale_shop.js`: after the shop bills $40 → charges `["shop_o1"]`, balance 1040.
  - After the stale tab's save → charges `["c10"]`, while the ledger still has `le_chg_shop_o1`; balance 1050.
  - The next catch-up posts `le_chgadj_shop_o1_1 credit 40 "Cancelled — charge"`, leaving a balance of **1010** (should be 1050).
  - The cause: 266's merge keeps ledger entries and plan state, but takes the family's charge and credit lists from the page as they are (`migrations/266…sql:31-126`, `269` the same).
- **What to ask the builder for:** "_merge_family_from_page keeps entries and plan state but not charges[]/credits[], so a stale tab drops a shop charge and _postExistingCharges then cancels it (TED-091). Keep server-added charges (at least those with a ledger entry the page did not know) when merging, and add a scratch-DB test: settle_shop_order, stale save with another charge, catch-up → balance unchanged."

### TED-077 🟠 (still open, narrowed) Money received before a family's ledger starts never reaches it
- **What a user would see:**
  - For families that already have a ledger, a Zelle payment now lowers the balance straight away. That's fixed.
  - But a new family's ledger only starts the first time Billing is opened after they enrol.
  - A Zelle payment matched before that moment is never added to it. Neither is a payment the office recorded before that moment.
  - The balance then shows the full amount, and autopay collects the money again.
- **How sure I am:** Confirmed on the scratch database. How often it happens depends on timing.
- **Proof:**
  - `probes/…-4/deposit_before_ledger.js`: Zelle $400 posted while the family had no ledger. After the first Billing save the ledger balance is **1000.00** (should be 600) and autopay's first payment is **500** (should be 300).
  - `probes/…-4/payment_before_ledger.js`: a $300 check recorded first. After the first Billing save the balance is **1000.00** and autopay asks **500**.
  - The parent-side "is the ledger complete?" check answers `t` (true). It reads payments from the settings document's old `finance.payments` list, which has been empty since 158 (`get_my_balance` → `projected_family_payments`, `migrations/202…sql:219-228`). So the check can no longer notice missing payments.
  - The trigger in 265 skips families with no ledger, which is correct. Nothing adds the deposit later when that family's ledger starts.
- **What to ask the builder for:** "When a family's ledger starts (first entries written), post every earlier bank deposit and camp_payments row for that family (TED-077 residual), and make get_my_balance's completeness check read camp_payments rows and bank_deposits instead of the empty document list. Test: deposit and check recorded first, then tuition posted → 300 and 600 owed."

### TED-092 🟠 Cardknox/Banquest deposit left unconfirmed: two "nothing went through" confirmations both charge, and nobody tells the office
- **What a user would see:**
  - A Cardknox or Banquest deposit charge is cut off mid-way. The parent is told "the camp office will confirm whether this went through". The office is never told.
  - If the office then presses "Charge deposit now" and confirms twice (two tabs, two people, or a double click through the dialog), both charges go through.
- **How sure I am:**
  - Confirmed that the database lets both through.
  - The double charge itself is Likely: each request uses its own unique invoice number, so Sola's duplicate block won't stop it.
- **Proof:**
  - `probes/…-4/stale_twice.js`: after the cut-off the parent sees `stale`. Office confirmation 1 gives `retaken, claimed true`. Office confirmation 2, made before the first reached the card company, also gives **`retaken, claimed true`**.
  - The cause: retaking a stale claim keeps its old `called_at` (`migrations/268…sql:88-93`), so it still looks stale to the next caller.
  - The deposit function's cut-off path writes no notification (`registration-deposit-checkout/index.ts:430-439`).
  - `chargeDepositNow` has no guard against a second click while the first is still running (`campistry_me.js:19670-19711`).
- **What to ask the builder for:** "claim_charge_intent: a retaken stale claim keeps its old called_at, so a second caller retakes it too; on Cardknox/Banquest two office confirmations charge twice (TED-092). Clear/reset called_at on retake so the next caller sees in_progress, and raise an office notification (and Billing flag) when a deposit claim goes stale."

### TED-093 🟡 A refund whose answer gets lost can be issued twice
- **What a user would see:** The office refunds $100 of a $500 card payment. The card company does the refund, but the connection drops before it answers. The office sees "Refund failed: connection reset", clicks Refund again, and the family is refunded $200. Only the second refund appears in Billing.
- **How sure I am:**
  - Confirmed for Cardknox with the real `payments-refund` function.
  - The same shape is in both canteen refund functions.
  - On Stripe, a second click uses a new key, so Stripe would also accept a second partial refund.
- **Proof:**
  - `probes/…-4/refund_cutoff.test.js`: try 1 → `{"error":"connection reset"}` and the claim is given back. Try 2 → `Approved`. **2 refunds reached the gateway.**
  - A thrown error is reported as "no money moved" (`payments-refund/index.ts:36-53, 206-213`; `payments-canteen-refund/index.ts:275-281`; `payments-canteen-refund-all/index.ts:246-252`).
  - The office's key is new on every click (`campistry_me.js:18448`).
- **What to ask the builder for:** "Refunds: a thrown/timeout error from the processor is treated as 'no money moved' and the claim is released, so a retry refunds again (TED-093). Keep the claim (as 268 does for deposits) when the processor may have acted, look the refund up before retrying, and tell the office to check the processor instead of offering Refund again."

### TED-094 🟡 Smaller loose ends
- **Old plans without an id, office removes one:** the "bank debit in flight" note of the removed plan moves onto the plan after it. That plan then waits on a debit that isn't its own. Proof: `probes/…-4/legacy_hold.js` → after removing the $300 plan, the $200 plan carries `pendingCharge pi_ach_1 amount 500`. The cause is that 269 matches id-less plans by position.
- **Re-running 266 on its own undoes 267 and 269**, although its header says "safe to run more than once". The checking script does catch it: it says "apply 267" and "apply 269" (`probes/…-4/rerun.js`). The owner should paste 265–270 in order and never re-run 266 alone.
- **Money notices hidden from non-Billing staff (270) miss some kinds:** `autopay_setup` (family plus card or bank), `canteen_autoreload_off` (child plus card declines) and `tip_transfer_failed` (staff tip amounts) are still shown to every staff member (`migrations/270…sql:33-36`).
- **Canteen auto-reload after a Stripe server error:** it counts the error as a decline, so the next try uses a new key. If the first charge did go through, the webhook's top-up usually prevents a second one. It's still not what Stripe advises (`canteen-auto-reload/index.ts:545-552`).
- **`payments-refund` accepts a negative amount** (it only refuses 0, `:158`). The processor probably rejects it.
- **What to ask the builder for:** "TED-094 tidy-ups: don't carry plan state by position when the page removed an id-less plan; header note on 266 re-runs; add autopay_setup, canteen_autoreload_off, tip_transfer_failed to is_money_notice; treat Stripe 5xx in auto-reload as unknown (same key); refuse amount ≤ 0 in payments-refund."

## Re-check of last report's findings
| ID | Now | My proof |
|----|-----|----------|
| TED-076 two tests text-only | **Closed** | The tests now run the real save buttons: with the above-zero check removed, the TED-062 test fails. Only close-out is still a text check (the builder says so). |
| TED-077 Zelle never reaches the ledger | **Open (narrowed)** | Unchanged `probes/…-3/zelle_ledger.js`: 1000 → **600**, autopay **300**; pgtest 265 passes. Money received before a ledger starts is still missed (see above). |
| TED-078 stale tab wipes the debit hold | **Closed** | Unchanged `stale_hold.js`: after the stale `sync_camp_billing` save and after the settings-document save, `pendingCharge` is still there, and autopay due stays held. Residual: TED-091 (charge lists) |
| TED-079 declined fixed instalment skipped | **Closed** | Code read `charge-due-installments/index.ts:812-830`: the counter is not moved and the retry date comes from `flag_plan_collection`; the key includes the day, so the retry is a new request. The test fails with the guard removed. |
| TED-080 Link showed even split | **Closed** | Unchanged `link_plan_view.js` → `[1000,200,200]`, matching autopay's 1000; the test fails on the old Link page. (The balance it starts from is wrong: TED-088.) |
| TED-081 merge dropped charges | **Closed** | Unchanged `merge.js`: A.charges carries `lf_b`, the catch-up posts **0**, A owes **1025**; the test fails on old code |
| TED-082 converted charge re-priced/cancelled | **Closed** | Unchanged `conv_shop.js`: re-price → **55.00**, cancel → **0.00**; `dup_recheck.js` still 625 in JS and SQL; 2 tests fail on old code |
| TED-083 cut-off deposit "already paid" | **Closed** | pgtest 268 states (new / in progress / retaken / stale / settled); the edge tests fail 4/10 on old code; code read of the new cut-off handling. Residual: TED-092 |
| TED-084 legacy plan not held | **Closed** | `probes/…-4/legacy_hold.js`: hold and flag on `#0` succeed, and a stale save keeps both; builder tests (night 2 = no new debit, hold failure → `processing_hold_failed` + office flag) fail on old code. Residual in TED-094 |
| TED-085 keys outlive a decline | **Closed** | Deposit key gets `:a<n>` after a decline (pgtest 268 attempt 1); reload key carries `:f<failures>`; tests fail on old code |
| TED-086 kind check | **Closed** | Unchanged `ptx_kind.js`: `registration_deposit` and `registration_card_capture` both `{"success": true}` |
| TED-087 loose ends | **Closed** | Cardknox connect refuses without PIN; webhook answers 503 (tests 4/4 fail on old); tip retry stores the payment id; `_sync_charge_to_ledger` STABLE; `probes/…-4/bundle.js`: APPLY_BUNDLE.sql stops at its first statement ("is retired … Nothing was changed"), `plan_due`/`settle_shop_order` unchanged. Notice list gaps moved to TED-094 |
| TED-005 auto-scheduler | Open, deferred | still 14 failing, not re-investigated |

## What I confirmed is working
- **Every suite passes except the 14 deferred TED-005 failures.** The builder's counts are exact.
- **Migrations 265–270 can be re-run safely in order.** Twice each in order: all rows "ok". The checking script notices when a newer one is undone (`probes/…-4/rerun.js`).
- **A Zelle payment on a family that already has a ledger** now lowers the office balance and autopay straight away. Moving it to another family, ignoring it and a bank return all follow (pgtest 265).
- **An open Billing tab can no longer undo a bank-debit hold, a plan's counter or a decline flag** (`stale_hold.js`, `legacy_hold.js`).
- **Plans with the office's own amounts** keep retrying a declined payment instead of skipping it, and Link shows the amounts autopay will charge.
- **Merging families and converted camps' shop charges** now keep the balance right (`merge.js`, `conv_shop.js`).
- **The old bundle file** refuses to run on a current database and changes nothing.
- **Browser caching:** `campistry_me.js?v=20260924-12` is in `campistry_me.html`. The Link and registration pages are plain HTML, so they need no version number.

## What I did NOT check (and why)
- **Any real processor.** I never called Stripe, Banquest or Cardknox. TED-092's double charge and TED-093's lost answer depend on how those gateways behave, which I modelled.
- **What is deployed:** whether 255–270 have been pasted, which function versions are live, and how many applications are stuck "awaiting deposit" since 18 September (TED-089).
- **Anything in a real browser.** I checked the registration form, Link and Billing by running pieces of their real code, plus the database functions they call.
- **Database security rules (RLS).** The test database runs as a superuser. The 270 notice rule was only read, not run as a counselor.
- **Payroll, tax statements, POS register maths, Link photo purchases, splitting a family, and the bank-email parser/matcher.** These are still never deep-audited.

## Things only you can check (click-by-click)
1. **Applications stuck without a deposit since 18 September (TED-089).** Supabase → SQL Editor → paste and Run (read-only):
   `select camp_id, entry_id, submitted_at, payload->>'camperName' as camper, payload->>'depositRequired' as deposit from camp_applications where kind='enrollments' and coalesce((payload->>'depositRequired')::numeric,0) > 0 and submitted_at > '2026-09-18' order by submitted_at desc;`
   Every row is a family that may have been told their deposit payment failed. After the office opens the Me page, each can be charged with "Charge deposit now" if a card was captured.
2. **Deposits charged by card that aren't on the family's balance (TED-090).** In Me → Registration, look at every application showing a deposit "paid" by card. Then open that family in Billing and check a matching payment exists. If not, record it before their next autopay date.
3. **Until TED-088 is fixed, tell parents to trust the office's statement, not the Link balance,** after an autopay charge or a Zelle payment. Or open the Me page (which saves) after each nightly run so Link catches up.
4. **Until TED-091 is fixed, reload Billing (F5) before editing any family that buys from the Camp Shop.**
5. **Cardknox/Banquest camps (TED-092):** before pressing "Nothing went through — charge", check the Sola/Banquest dashboard. Make sure only one person does it, once.
6. **After a refund says "connection reset" (TED-093):** check the processor's dashboard before pressing Refund again.
7. **Owner steps still pending from the builder:** paste migrations 255–270 **in order** (never re-run 266 on its own afterwards), then run `scripts/verify_identity_chain.sql` and check every row says ok. Redeploy `charge-due-installments`, `registration-deposit-checkout`, `canteen-auto-reload`, `cardknox-webhook`, `admin-connect-processor` and `stripe-connect-webhook` (Supabase Dashboard → Edge Functions → each one → Deploy). Reload office computers. For each Sola camp, confirm the webhook PIN is saved (Sola portal → Settings → Webhooks), because hosted payments now wait until it is.
