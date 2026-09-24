# Ted's report: billing, fifth pass (re-check TED-077 and TED-088 to TED-094, then a hunt), 2026-09-24

## Verdict: 🔴 Problems found

I re-checked the 8 open billing findings from my fourth pass, re-ran all of those probes, and wrote 9 new ones. **Six of the eight are fixed, and I'm closing them with my own proof.** The parent's Link balance now updates straight away, money received early now reaches the family's account, and a parent can pay the deposit right after applying. Two are only partly fixed:
- "Refund everyone" on a Cardknox/Banquest camp can still refund a child twice.
- One kind of money notice is still shown to all staff.

I also found 5 new problems. The most urgent is caused partly by me: **in my last report I told you to type card-paid deposits into Billing by hand. The new code now adds those same deposits automatically, so any family where you did that will be credited twice.** Please do step 1 under "Things only you can check" before anyone opens Billing on the new version.

So no: billing is not yet 100%. I did not change any code, only reported.

## The numbers
Tests run: 3,592 · Passed: 3,578 · Failed: 14 (real bugs: 14, all the deferred auto-scheduler failures TED-005 · out-of-date tests: 0 · my machine: 0)

- **Unit tests (`npm test`):** 3,421 run, 3,407 passed, 14 failed. All 14 failures are in `auto_full_day.test.js` (TED-005, deferred by you).
- **Database tests (`npm run test:pg`):** 61 of 61 passed, against 120 migrations.
- **Other suites:** `test:keys` 42/42, `test:lite` 12/12, `test:smoke` 32/32, `test:scale` 24/24.
- All of these match the builder's numbers exactly.
- **The builder's new tests, run against the code from before their fixes** (a scratch copy, removed afterwards). Every file fails on the old code, so each one really tests its fix:

  | Test file | Failed on the old code |
  |---|---|
  | `deposits_reach_the_family` | 6 of 7 |
  | `refund_lost_answer` | 3 of 4 |
  | `refund_idempotency` | 4 of 14 |
  | `registration_deposit_charge` | 2 of 11 |
  | `canteen_autoreload_once` | 1 of 5 |
  | `charges_reach_the_ledger` | 1 of 20 |

- **My proof runs** are in `ted/probes/2026-09-24-billing-5/`:
  - 5 runs on a scratch database built from the project's own migrations;
  - 4 runs of real payment functions in the test harness;
  - 1 run of the real Me-page code;
  - all 10 fourth-pass probes again.
- **A mistake in my own fourth-pass probe:** `parent_balance.js` called the autopay function with its arguments in the wrong order. Its conclusion still holds, and I've corrected the call in this pass's `parent_live.js`.

## What's wrong (most serious first)

### TED-095 🟠 A card-paid deposit the office already typed into Billing is counted twice
- **What a user would see:**
  - A parent paid a $250 registration deposit by card on the form.
  - The office typed that $250 into Billing by hand. My last report told you to do this, and so did the old "Mark deposit received" screen.
  - Now Billing adds the card deposit by itself as well.
  - The family is credited $500. Their balance drops by an extra $250, and autopay collects $250 too little.
- **How sure I am:** Confirmed with the real Me-page code.
- **Proof:**
  - `probes/…-5/deposit_twice.test.js`: balance 750 → **500** after the Billing load (should stay 750), with 2 payment rows.
  - This happens whether the hand-typed payment has the card reference in its "Reference" box or no reference at all.
  - The cause: `_postCardDepositsFor` (`campistry_me.js:6346-6375`) only looks for an existing payment with `depositReference`, `stripePaymentIntentId` or `byopTransactionId` equal to the deposit's reference. A hand-typed payment has none of these, not even when its typed `reference` matches.
- **What to ask the builder for:** "_postCardDepositsFor double-credits a deposit the office already recorded by hand (TED-095): also treat a payment whose typed reference equals the deposit reference as the same money, and for a hand-typed payment of the same amount on that family (method card, around the deposit date) don't post automatically — flag it in Billing for the office to confirm. Add a test with a hand-typed $250 already present → balance stays 750."

### TED-096 🟠 Billing can't refund most card deposits taken through Stripe
- **What a user would see:**
  - The office tries to refund a registration deposit a parent paid by card through Stripe. Billing says **"That payment does not belong to your camp."** Nothing is refunded.
  - This happens when the family already had a different card on file (a returning family or a sibling), or has no Stripe card on file at all.
  - The refund only works when the card from the form happens to be the family's card on file.
- **How sure I am:** Confirmed with the real `stripe-refund` function (Stripe itself was modelled).
- **Proof:**
  - `probes/…-5/deposit_refund.test.js`:
    - family's card on file = the card from the form → refunded;
    - a different card on file → **403**, 0 refunds sent;
    - no Stripe card on file → **403**.
  - The cause: `campOwnsPayment` (`stripe-refund/index.ts:104-114`) accepts a payment only if its Stripe customer is one of the families' `stripeCustomerId`s. The deposit is made on the form's own customer. Registration never replaces a card the family already has (`campistry_me.js:15175-15190`). The hosted Checkout deposit makes a new customer every time.
  - The payment does carry `metadata.campId` (`registration-deposit-checkout/index.ts:411-413`), but that is only checked when the payment has no customer.
- **What to ask the builder for:** "stripe-refund refuses registration-deposit refunds whenever the family's stripeCustomerId isn't the form's customer (TED-096). Also accept a PaymentIntent whose metadata.campId is the caller's camp and whose transfer destination is the camp's own account (or that matches a camp_payments row of this camp), and add a harness test: deposit with customer cus_form, family on cus_office → refunded."

### TED-093 🟠 (still open, narrowed) "Refund everyone" on a Cardknox/Banquest camp can still refund a child twice
- **What a user would see:**
  - At the end of the season the office presses "Refund everyone" in Snacks.
  - One child's refund goes through, but Cardknox's answer is lost. The page shows that child as "failed", and the office presses Try Again.
  - That child is refunded again.
- **How sure I am:** Confirmed with the real `payments-canteen-refund-all` function.
- **Proof:**
  - `probes/…-5/refund_all_lost.test.js`: run 1 → `failedCount 1` ("may or may not have gone through"). Run 2 → `refunded 50`. **2 refunds reached Cardknox for one $50 deposit.**
  - The cause: the function only claims a refund when the page sends a key (`payments-canteen-refund-all/index.ts:381-382`, `:237`). Snacks sends an empty request (`campistry_snacks.js:2032`, `body: {}`), so nothing is ever claimed. The builder's test for this only checks the text of the file.
- **The rest of TED-093 is fixed:**
  - single refunds from Billing (Cardknox/Banquest and Stripe);
  - the single canteen refund;
  - my fourth-pass probe now shows 1 refund reaching the gateway, not 2.
- **A smaller gap, found by reading the code:**
  - The server can't tell "the first try is still running" from "the first try was cut off".
  - A double-click on the refund button makes the second click ask "Did the earlier refund go through?" while the first is still in progress.
  - If the office confirms within those few seconds, the in-progress claim is released and a second refund is sent (`payments-refund/index.ts:199-222`, `release_refund_intent` deletes any unsettled claim, `migrations/198…sql:145-146`).
  - Deposits already guard against this with a 10-minute rule (268). Refunds don't.
- **What to ask the builder for:** "TED-093 residual: Snacks calls payments-canteen-refund-all with no idempotencyKey, so it claims nothing and a re-run after a lost answer refunds again — derive the chunk key server-side from deposit + remaining + chunk as the single canteen refund does; and only let confirmNotRefunded release a refund claim older than a few minutes (answer 'still in progress' otherwise). Add a harness test of Refund-all with body {} and a lost first answer → 1 gateway refund."

### TED-097 🟠 A second Stripe canteen refund of the same amount on the same day says "Refunded" but sends nothing
- **What a user would see:**
  - A child has $50 of canteen money from a Stripe top-up. The office refunds $20. Later that day it refunds another $20.
  - Both times it says "Refunded $20". Only the first $20 goes back to the card, and the wallet still shows $30.
  - The office believes the parent got $40 back.
- **How sure I am:** Likely. I confirmed it with the real `stripe-canteen-refund` function and a pretend Stripe that behaves as Stripe documents (the same key within 24 hours returns the first result).
- **Proof:**
  - `probes/…-5/canteen_second_refund.test.js`: both calls answer `totalRefunded 20, refundId re_1`, and both used the key `canteen_refund_pi_top_2000`.
  - The cause: the key is only the payment plus the amount (`stripe-canteen-refund/index.ts:224`; the same in `stripe-canteen-refund-all/index.ts:178`). The ledger then sees `re_1` as already recorded (`migrations/229…sql`), so it changes nothing.
- **What to ask the builder for:** "stripe-canteen-refund's Stripe Idempotency-Key is pi + amount, so a second same-amount partial refund within 24 h is answered with the first refund and reported as done (TED-097). Include what is still refundable on that deposit in the key (as the single BYOP canteen refund now does), and treat a returned refund id that is already recorded as 'nothing new was refunded', not success."

### TED-098 🟡 An office tab opened before a deposit was paid can make it look unpaid again
- **What a user would see:**
  - The office opens Me after a parent applies but before the deposit is paid.
  - The parent pays later, for example on the processor's own pay page.
  - The office then saves from that same open tab.
  - Until someone reloads Me, the application counts as unpaid again. A second deposit charge would be accepted, and that second charge replaces the record of the first. The first $250 would then never reach the family's account and couldn't be refunded from Billing.
  - The next time anyone reloads Me, the page repairs the application.
- **How sure I am:** Confirmed at the database level. How often it happens depends on timing, and it needs that exact order.
- **Proof:**
  - `probes/…-5/regdep_cycle.js`, steps 1–4, show TED-089 is fixed: owed 250, paid, owed 0, the webhook's repeat is ignored.
  - Step 5: after the old tab saves the settings document, owed = **250** again. A second charge `9002` leaves `depositCharges` = `[9002]` only; `9001` is gone.
  - The cause: `_application_entry` (`migrations/271…sql:118-129`) believes the settings document's copy before `camp_applications`. The save-time merge can't carry the payment across, because the cloud document had no copy of the application yet (`integration_hooks.js:900-926`).
- **What to ask the builder for:** "_application_entry prefers the campistryMe copy even when camp_applications holds a deposit that copy lacks (TED-098). Read both and use the one with more deposit charges (or union their depositCharges), and never overwrite depositCharges with a shorter list. Add a pgtest: pay on camp_applications, stale document save, owed stays 0."

### TED-099 🟡 A big camp's first Billing save after enrolment is 25 times slower
- **What a user would see:**
  - When many families' accounts start at once (a camp's first Billing load of the season, or after a big enrolment import), that one save is much slower.
  - At about 1,000 families it takes around 7.5 seconds on my machine. Supabase stops a request at 8 seconds, so a larger or slower camp could have that save fail.
- **How sure I am:** Confirmed on the scratch database. The numbers come from my machine, not from Supabase.
- **Proof:**
  - `probes/…-5/ledger_start_scale.js`:
    - 100 families: 190 ms;
    - 600 families: 3,012 ms (122 ms without the new trigger);
    - 1,000 families: **7,561 ms** (298 ms without it).
  - The result is correct every time: every earlier payment was posted exactly once.
  - The cause: for each family, the trigger calls `sync_family_ledger_payments`, which rebuilds the whole camp's family list and payment list (`migrations/215…sql:565-569`).
- **What to ask the builder for:** "The 271 ledger-start trigger calls sync_family_ledger_payments per family, which rebuilds camp_families_object and camp_payments_array each time: 1,000 families take 7.6 s in one save (TED-099). Give the trigger a one-family path that reads only that family's payment rows and deposits."

### TED-094 🟡 (still open, narrowed) One more money notice is shown to all staff
- The notice "Payment plan set up" (`autopay_setup`) names the family and the card (for example "Visa ending 4242"). It is still shown to every staff member, not only those with Billing access.
- Proof: `stripe-webhook/index.ts:554-561` writes it. `migrations/270…sql:33-36` lists 10 money notices, and `autopay_setup` isn't one of them.
- The rest of TED-094 is fixed:
  - plans without an id are no longer matched by position (`legacy_hold.js`: the hold stays with its own plan);
  - re-running 266 or 269 on its own now leaves 272 in place (`probes/…-5/rerun.js`);
  - a negative refund amount is refused (a test that fails on the old code);
  - canteen auto-reload treats a Stripe server error as "unknown" (code read, and a test that fails on the old code).
- **What to ask the builder for:** "Add 'autopay_setup' to is_money_notice in 270 (TED-094 residual)."

## Re-check of last report's findings
| ID | Now | My proof |
|----|-----|----------|
| TED-088 parent's balance ignored server entries | **Closed** | Unchanged `parent_balance.js`: after Zelle, office **600** and parent **600**; after autopay, **300** and **300**. My new `parent_live.js`, with no office save anywhere: a shop charge, its cancellation, Zelle, autopay, the webhook's own payment row and a dashboard refund all match between office and parent (1040 → 1000 → 600 → 300 → 300 → 350). |
| TED-089 deposit couldn't be paid after applying | **Closed** | Unchanged `regdep_new_app.js`: owed 250, record → paid 250. `regdep_cycle.js` steps 1–4. Deposit tests fail 2/11 on old code. Residual: TED-098 |
| TED-090 card deposit never became a payment | **Closed** | `deposits_reach_the_family` 7/7 (6 fail on old code): one payment row, balance 750, once however often Billing loads; Cardknox row refundable via `byopTransactionId`. Residuals: TED-095, TED-096 |
| TED-091 stale tab cancelled a shop order | **Closed** | Unchanged `stale_shop.js`: after the stale save, charges `["c10","shop_o1"]`, the catch-up posts **0**, balance **1050** (was 1010) |
| TED-077 money received before a ledger started | **Closed** | Unchanged `deposit_before_ledger.js` → **600**, autopay 300; `payment_before_ledger.js` → **700**. `rerun.js`: a family that started short goes from 1000 to 700 when 271 is pasted, and stays 700 after pasting it twice more. `ledger_start_scale.js`: 1,000 of 1,000 families posted exactly once. |
| TED-092 deposit claim retaken twice | **Closed** | Unchanged `stale_twice.js`: office click 1 `retaken`, click 2 **`in_progress`**, parent `in_progress`; pgtest 268 checks the office notice; the function test checks the notice on a cut-off charge |
| TED-093 refund with a lost answer sent twice | **Open (narrowed)** | Unchanged `refund_cutoff.test.js`: 1 gateway refund (was 2). Refund-all still sends 2 (see above) |
| TED-094 loose ends | **Open (narrowed)** | See above; only `autopay_setup` remains |
| TED-005 auto-scheduler | Open, deferred | still 14 failing, not re-investigated |

## What I confirmed is working
- **Every test suite passes except the 14 deferred TED-005 failures.** The builder's numbers are exact.
- **Migrations 265–272:**
  - pasted twice each, in order, every check-script row says "ok";
  - re-running 266 or 269 on its own no longer undoes 272's fix (`rerun.js`);
  - 271's one-time catch-up doesn't post anything twice.
- **Parents and the office now see the same balance**, straight after autopay, Zelle, the shop and processor refunds (`parent_live.js`).
- **An autopay charge and Stripe's own record of it count once, not twice.** I checked this with the arguments the nightly job really uses.
- **A deposit can be paid straight after applying, and a repeat from the processor is ignored** (`regdep_cycle.js`).
- **Browser caching:**
  - `campistry_finance_merge.js?v=20260924-01` is on all 8 pages that load it;
  - `campistry_me.js?v=20260924-14`;
  - `campistry_snacks.js?v=20260924-01`.

## What I did NOT check (and why)
- **Any real processor.** I never called Stripe, Cardknox or Banquest.
  - TED-097 depends on Stripe replaying a repeated key for 24 hours. That's Stripe's documented behaviour, but I modelled it rather than calling Stripe.
  - Whether a refund made in the Stripe dashboard of a card deposit reaches the family (the TED-096 workaround) depends on Stripe copying the payment's details onto the charge. I didn't verify that.
- **What is deployed:**
  - whether 255–272 have been pasted;
  - which function versions are live;
  - which page version the office computers are running.
- **Anything in a real browser.** I checked Billing, Snacks and the registration form by running pieces of their real code, plus the functions they call.
- **Database security rules (RLS) as a real counsellor.** The test database runs as a superuser.
- **Areas still never deep-audited:** payroll, tax statements, POS register maths, Link photo purchases, splitting a family, and the bank-email parser/matcher.

## Things only you can check (click-by-click)
1. **Before anyone opens Billing on the new version (TED-095), find deposits you typed in by hand.**
   - Go to Supabase → SQL Editor. Paste this and click Run (it only reads):
     `select camp_id, entry_id, payload->>'camperName' as camper, payload->>'depositPaid' as paid, payload->>'depositReference' as card_ref from camp_applications where kind='enrollments' and coalesce(payload->>'depositReference','') <> '' union all select k.camp_id, e.key, e.value->>'camperName', e.value->>'depositPaid', e.value->>'depositReference' from camp_state_kv k, jsonb_each(k.value->'enrollments') e where k.key='campistryMe' and coalesce(e.value->>'depositReference','') <> '';`
   - Each row is a deposit taken by card. Open that family in Billing → Payments.
   - If there's a payment you typed in for the same deposit, delete your typed one after the automatic "Registration deposit" line appears. Otherwise the family is credited twice.
2. **To refund a Stripe card deposit (TED-096) until it's fixed:**
   - Refund it in the Stripe dashboard: Payments → find the $ amount → Refund.
   - Then open the family in Billing and check the refund line appeared. If it didn't, record it as an Offline Refund.
3. **"Refund everyone" in Snacks (TED-093):** if any child shows "may or may not have gone through", do **not** press Try Again. Check the Cardknox/Banquest dashboard for that child first, and refund them one at a time.
4. **Stripe canteen refunds (TED-097):** if you need to refund the same child the same amount twice in one day, change one of them by a cent, or check the Stripe dashboard after the second one.
5. **Owner steps from the builder (still pending):**
   - Paste migrations 255–272 **in order** into the SQL Editor.
   - Run `scripts/verify_identity_chain.sql` and check that every row says "ok".
   - Apply 268, 269 and 271 before redeploying the functions.
   - Redeploy these functions (Supabase Dashboard → Edge Functions → each one → Deploy):
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
   - Reload the office computers, but do step 1 first.
