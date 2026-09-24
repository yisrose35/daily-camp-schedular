# Ted's report: billing re-check and deep pass, 2026-09-24

## Verdict: 🔴 Problems found

I re-checked all 13 billing findings from yesterday. The builder's fixes hold: 12 are closed with my own proof, and TED-005 stays deferred. Then I went through the areas I hadn't reached last time: registration deposits, the parent paying from the portal, the hosted pay and card pages, Stripe Connect and tips, close-out, the Banquest return page, and canteen auto-reload. I found 14 new problems, and 3 of them are serious. A parent who pays through the portal on a Stripe camp still sees the full balance, and the money lands in Campistry's own Stripe account, not the camp's. A family paying by bank account on autopay is debited again every night until the first debit clears. And yesterday's late-fee fix counts every old charge twice for any camp that ran the ledger conversion. **So no: billing is not yet correct and complete in the code.**

## The numbers
Tests run: 3,497 · Passed: 3,483 · Failed: 14 (real bugs: 14, the known auto-scheduler failures TED-005, which are outside billing and deferred by the owner · out-of-date tests: 0 · my machine: 0)

- Unit tests (`npm test`): 3,337 run, 3,323 passed, 14 failed (all `auto_full_day.test.js`, TED-005)
- Database tests (`npm run test:pg`): 50 of 50 passed, against 109 migrations
- `test:keys` 42/42 · `test:lite` 12/12 · `test:smoke` 32/32 · `test:scale` 24/24
- These match the builder's figures exactly.
- **Checking the builder's new tests against the old code** (a scratch copy of the code before their fixes, since removed):
  - `stripe_refund_and_charge`: 8 of 9 fail on the old code.
  - `autopay_runner` 3/3, `byop_charge` 7/7 and `batch_charge_counts_failures` 3/3 fail.
  - `stripe_webhooks_fail_closed`: 3 of 6 fail. The other 3 test things the old code already did right.
  - `charges_reach_the_ledger` and `office_plan_is_ledger_plan` fail to load.
  - `sweep_sends_camper_numbers` passes on the old code, which is right because it guards behaviour that already worked. Both of my deliberate breakages of that code were caught.
  - So the new tests really do test the fixes.
- **My own proof runs** (kept in `ted/probes/2026-09-24-billing/`): 3 runs on a scratch database built from the project's own migration chain, 8 runs of real edge functions through `tests/edge_harness.js`, and 2 runs of the real Me-page code.

## What's wrong (most serious first)

### TED-063 🔴 A parent who pays in the portal on a Stripe camp still sees the whole balance, and the money goes to Campistry's account, not the camp's
- **What a user would see:** A parent opens Link, presses Pay Now and pays $500 by card. Stripe takes the money, but the balance still shows the full amount. The parent thinks it failed and may pay again. Autopay works from that same balance, so it will also try to collect the $500 again. The money also settles in Campistry's own Stripe account instead of the camp's connected account, even when the camp is connected. The office cannot refund it from Billing, because the payment isn't linked to any family.
- **How sure I am:** Confirmed
- **Proof:**
  - `campistry_link_parent.html:1723` sends `stripe-checkout` the camp, family *name*, email and amount, but no `familyKey`. The office's pay link does send it (`campistry_me.js:19019`).
  - Real `stripe-checkout` run through the harness (`probes/paynow.test.js`): the parent's request gave `destination: null | metadata familyKey: ""`. The office's request gave `destination: acct_CAMP | familyKey: "gold"`.
  - The webhook then records the payment with `familyKey: null` (`stripe-webhook/index.ts:195`).
  - Scratch database (`probes/paynow_db.js`): I recorded exactly what the webhook records. Result: `ledgerPosted: false`. The parent's balance was 1000.00 before and **1000.00 after paying $500**.
- **What to ask the builder for:** "Link's Stripe Pay Now (_lkPayConfirm, campistry_link_parent.html:1723) doesn't send familyKey, so the payment never reaches the family's ledger and the money goes to the platform account. Send d.familyKey. Better still, make stripe-checkout work out the family from the parent's own login. Add a test that a Link payment lowers get_my_balance. Then list the payments already recorded with no familyKey, so the office can attach them and move the money to the camps."

### TED-064 🔴 Autopay from a bank account debits the family again every night until the first debit clears
- **What a user would see:** A parent saves a bank account for autopay, which the portal offers. On the due date autopay starts a $500 bank debit. A bank debit stays "processing" for several days. Autopay records nothing while it processes, so it starts another $500 debit the next night, and the next. By the time the first one clears the family has been debited three or four times for one instalment.
- **How sure I am:** Confirmed from the code and a run of the real autopay runner. It needs a family paying autopay by bank account.
- **Proof:**
  - The Stripe card-setup page offers bank accounts (`stripe-setup-checkout/index.ts:141`).
  - The runner deliberately records nothing for a charge that is still processing (`charge-due-installments/index.ts:678`, and the same in the older plan path). The next night's check sees the same balance, because a pending payment doesn't count.
  - Real runner, fake Stripe answering "processing", three nights (`probes/ach.test.js`): `debits started 1 | recorded 0` on each night, so 3 debits for one $500 instalment.
  - Autopay charges also carry no Stripe Idempotency-Key (`idempotency key sent: false`). The SMS-fee runner already uses one for exactly this reason (`telnyx-charge-monthly-fees/index.ts:37`).
- **What to ask the builder for:** "In charge-due-installments, a PaymentIntent that comes back 'processing' must hold that instalment (record it as in flight, or wait until it settles), not leave it to be charged again tomorrow. Also send an Idempotency-Key per camp, plan, instalment and date on every autopay charge. Add a runner test with a 'processing' answer over two nights."

### TED-065 🔴 Yesterday's late-fee fix counts old charges twice for any camp that ran the ledger conversion
- **What a user would see:** On a camp where someone ran the "convert to ledger" tool (`convert_family_ledgers`), every late fee, card fee or add-on charge from before the conversion is now counted twice. The first time the office opens Billing, the Me page posts them again. The family's balance, the parent's balance and the autopay amount all go up by those charges a second time.
- **How sure I am:** Confirmed. It only affects camps that ran the conversion; I can't see whether any did.
- **Proof:**
  - The conversion already copies every family charge onto the ledger, under its own number and without saying which charge it came from (`migrations/215_payment_family_writers.sql:758-771`).
  - The new catch-up in `buildFamilyLedgers` posts each charge again as `le_chg_<id>`. It only checks for that exact number (`campistry_me.js:6363`).
  - Scratch database (`probes/dup.js`): $1,000 tuition, $400 paid and a $25 late fee. After conversion the balance was 625.00, which is correct. After the Me page's catch-up the entries were `le_conv_gold_2 $25, le_chg_lf_1 $25` and the balance was **650.00**.
- **What to ask the builder for:** "_postLedgerCharge / the buildFamilyLedgers backfill double-posts charges that convert_family_ledgers already put on the ledger as le_conv_* with no source.chargeId. Skip a charge the ledger already covers (and make the conversion record source.chargeId). Check live data for families that already have both, and add a scratch-DB test: convert, load Billing, the balance stays 625."

### TED-066 🟠 A Camp Shop order billed to the family and then cancelled stays on the family's balance
- **What a user would see:** The shop bills a $40 sweatshirt to the family's account, and the office opens Billing some time later. When the order is then cancelled, or re-priced, it comes off the family's list of charges, but the $40 stays on the balance the parent sees and autopay collects.
- **How sure I am:** Confirmed
- **Proof:** Scratch database (`probes/shop.js`), using the real `settle_shop_order`:
  - Billed $40, then the Me page's catch-up ran: ledger balance 40.00.
  - The order was cancelled: charges list `[]`, but the ledger still held `le_chg_shop_o1 $40`, so the ledger balance stayed **40.00**.
  - The catch-up only ever adds. It never updates or reverses an entry (`campistry_me.js:6354-6373`), and cancelling a shop order only rewrites the charges list (`migrations/239…sql:290-316`).
- **What to ask the builder for:** "When settle_shop_order removes or changes a shop_<order> charge, the posted ledger entry has to be reversed or replaced as well (in the same database function). Add a test: bill, load Billing, cancel, and the balance goes back to 0."

### TED-067 🟠 Season close-out bills the family for its own child's canteen money, and "Roll into next season" credits nothing
- **What a user would see:**
  - At the end of summer the office closes out a family whose child has $6 of canteen money left. The default choice for canteen money is "Roll into next season". Applying it adds a $6 charge to the family's tuition account, so a family that had paid in full now owes $6. The child's canteen balance still shows $6.
  - Choosing "cash" or "check" does the same, so the canteen money could be handed out twice.
  - "Roll into next season" never creates an opening credit anywhere, so a family's leftover credit simply disappears.
- **How sure I am:** Confirmed (the real close-out code, run with the real billing and close-out modules)
- **Proof:**
  - `probes/closeout.js`: default canteen choice `roll_forward` (`campistry_closeout.js:94`). The family's ledger balance was 0 before and **6 after**.
  - The charge reads "Roll into next season — Avi Gold's canteen money (opening credit next season)".
  - Nothing in the project reads a roll-forward back or creates the credit. I searched for `roll_forward`, `carried_forward` and `opening credit`, and they appear only in the close-out code itself.
  - Yesterday's fix is what now puts this charge on the balance the parent and autopay use (`campistry_me.js:2276`).
- **What to ask the builder for:** "_applyCloseout must not post canteen-money steps as a charge on the family ledger. They should debit the camper's canteen account instead. roll_forward needs to actually create next season's opening credit, or be removed as an option. Add a test that closing out $6 of canteen money leaves the family's tuition balance unchanged."

### TED-068 🟠 The office's payment-plan editor throws away the amounts the office types
- **What a user would see:** The office sets up $1,000 on 1 June and then $200 on each of 1 July and 1 August. The editor still shows those amounts and a "Total scheduled", and the heading says "edit any date or amount". But autopay charges $466.67 three times. If the office schedules only part of a balance, for example $600 of $1,400 with the rest coming from a grant, autopay takes the whole $1,400 ($700 + $700).
- **How sure I am:** Confirmed (the real `_mpBuildLedgerPlan` and `_planSchedule`, `probes/plan.js`)
- **Proof:** The saved plan holds only the dates: `{"dueDates":[…3 dates…],"nextIndex":0,"total":1400}`. The amounts collected work out as `$466.67, $466.67, $466.66`, and in the partial case `$700 + $700`. The server does the same sum: `plan_due` takes the whole family balance divided by the payments left (`migrations/172…sql:210-253`). The builder added a one-line note under the rows, but the amount boxes and the running total are still there.
- **What to ask the builder for:** "Now that the office writes ledger plans, the editor's per-row amounts do nothing. Either remove the amount inputs and the 'Total scheduled' and say plainly that autopay splits the whole balance evenly, or support plans that keep fixed amounts and plans that cover only part of a balance."

### TED-069 🟠 Anyone can make the "charge the deposit now" button's charge happen, and two at once charge twice
- **What a user would see:** The office's "Charge deposit now" charges the card a parent entered when they applied. The function behind it doesn't check who is asking. Anyone who has the camp's id and the application's id can make it charge that parent's card, with no login. Two of these requests at the same moment both charge the card: the office clicking while the parent retries, or a double click. So the deposit is taken twice.
- **How sure I am:** Confirmed that no login is needed. The double charge is likely, from reading the code.
- **Proof:**
  - `registration-deposit-checkout/index.ts:180`: `officeCharge` runs without checking who is calling.
  - Harness (`probes/regdep.test.js`), a request with no login: `{"success":true,"paid":true,"amount":250}` and 1 Stripe charge on `cus_parent`.
  - Nothing claims the charge between checking "what is still owed" and charging. The parent's own path claims its card capture first; this one doesn't.
- **What to ask the builder for:** "In registration-deposit-checkout, require an owner/admin login for officeCharge (like stripe-charge), and claim the deposit before charging (claim_refund_intent keyed on camp + application) plus a processor idempotency key, so two requests can't both charge."

### TED-070 🟠 On Banquest camps the deposit's hosted payment page can never open, and the other deposit path ignores the camp's gateway address
- **What a user would see:** On a Banquest camp, a parent paying a registration deposit on Banquest's own page is told "This camp has not finished setting up online payments" every time, even when it has. Deposits charged against a card entered in the form always go to Banquest's default address. That breaks any camp whose credentials point somewhere else, such as a sandbox.
- **How sure I am:** Confirmed from the code
- **Proof:**
  - `registration-deposit-checkout/index.ts:391` reads `credRes?.credential || credRes`. The database function returns `credentials`, plural (`migrations/126…sql:300`, and every other function reads `.credentials`). So `sourceKey` is never found.
  - `:57` builds the address from `apiHost`, a field nothing stores. The connect form stores `gatewayUrl` (`admin_connect_processor.html:49`).
- **What to ask the builder for:** "registration-deposit-checkout: read credRes.credentials in the Banquest hosted branch, and use gatewayUrl (like every other function) in bqBase."

### TED-071 🟠 Sola/Cardknox payments are matched to families by amount: identical deposits go unrecorded, and an unrelated charge can be credited
- **What a user would see:**
  - Two families start a $250 deposit on Sola's page in the same week, and one leaves without paying. When the other pays, their deposit is never recorded and their application stays "awaiting deposit". Only a log line says so, and the office is never told.
  - Separately, if Sola reports the office's own card charges or autopay charges back to Campistry, one of those can be credited to a family whose checkout is still pending at the same amount.
- **How sure I am:**
  - The unrecorded deposit is confirmed from the code.
  - The wrongly credited charge is suspected. It depends on whether Sola reports sales made through its API.
- **Proof:**
  - Sola's hosted page doesn't send back Campistry's reference, so matching by amount is the normal path (`cardknox-webhook/index.ts:196-251`). Two pending intents at one amount is a "refuse to guess".
  - Harness (`probes/ck.test.js`) with two pending $250 deposits and one payment: `status 200 "ok" | deposit recorded: false`.
  - A sale that carries a reference Campistry doesn't know still falls through to amount matching. An approved $250 with `xInvoice: CI-…` (the office or autopay format) was recorded as `enr_A`'s deposit, ref 9002.
- **What to ask the builder for:** "cardknox-webhook: only fall back to amount matching when no xInvoice came back at all, and when a payment matches several intents, write it somewhere the office sees (a notification or an 'unmatched' row) instead of only logging it. Expire abandoned intents sooner than 7 days."

### TED-072 🟠 Banquest's return page can credit a family with someone else's payment
- **What a user would see:** A parent comes back from Banquest's page. If Banquest's list doesn't contain their transaction under their link's key, Campistry takes the newest transaction on the camp's whole account instead. The family can then be marked paid, or their canteen topped up, with another family's money. Or their link can be marked failed because of someone else's declined card.
- **How sure I am:** Confirmed that the code does this. Whether it happens live depends on how Banquest answers the lookup.
- **Proof:** `payments-hosted-complete/index.ts:104` is `txns.find(key matches) || txns[0]`. In a harness run (`probes/hosted.test.js`), Banquest's answer held only another link's transaction for $350, and it was recorded for `famA $350 ref 777` with `success: true`.
- **What to ask the builder for:** "payments-hosted-complete must only accept a transaction whose key matches the pending link. Drop the `|| txns[0]` fallback and answer 'pending' instead."

### TED-073 🟠 The nightly retry for failed staff tips can never succeed, and would short-pay the counselor
- **What a user would see:** When a tip's first transfer to a counselor fails, for example because the counselor's Stripe account wasn't ready, it is supposed to be retried every night. Every retry fails, so the counselor never gets that tip. If one did get through, it would be 2% short.
- **How sure I am:** Confirmed
- **Proof:**
  - The first transfer sends the tip to the counselor's Stripe account, `item.stripe_account_id` (`stripe-connect-webhook/index.ts:331`), and pays the full `tip_cents`.
  - The retry sends it to `staffAccountId`, which is Campistry's own internal staff record number, a UUID (`charge-due-installments/index.ts:969`). It pays `tipCents − feeCents` (`:955`).
  - Harness (`probes/tipretry.test.js`): `amount=1960&…&destination=5f0c2a8e-…` for a $20 tip, then "No such destination".
- **What to ask the builder for:** "retry_failed_tip_transfers should return stripe_account_id, and the retry should send the full tip_cents to it (the fee was charged to the parent separately)."

### TED-074 🟠 "Let parents set up their own payment plan" points families to a tool that no longer exists
- **What a user would see:** When this setting is on, an application that asked for a payment plan tells the office "once accepted, this family can build their own plan from their Link portal", and the office's "Set Up Payment Plan" button is hidden. But the plan builder was removed from Link, so nobody sets up the plan.
- **How sure I am:** Confirmed from the code
- **Proof:** `campistry_link_parent.html:1489-1494` (`_lkPlanOfferHtml` returns nothing: "Self-serve … was removed from Link"). No page calls `set_my_payment_plan`. The Me page still offers the setting (`campistry_me.js:1988-2005`) and the message (`:13079`).
- **What to ask the builder for:** "Either bring back a working parent plan builder in Link, or remove the allowParentPaymentPlans setting and always show the office the 'Set Up Payment Plan' button."

### TED-075 🟡 Canteen auto-reload can charge twice when two top-up checks run at the same moment
- **What a user would see:** A child's canteen balance drops below the parent's threshold. If the register's instant check and the half-hourly check run at the same moment, or two registers serve the child at once, the parent's card is charged the reload amount twice.
- **How sure I am:** Confirmed that it happens when the two checks overlap. In normal use the overlap should be rare.
- **Proof:** The "once per day" limit is checked before charging but written only after. Nothing claims the reload first, and no Idempotency-Key is sent (`canteen-auto-reload/index.ts:245-285, 445-530`). Harness (`probes/reload.test.js`), two simultaneous instant triggers: `card charges made: 2 [ '5000', '5000' ]`.
- **What to ask the builder for:** "canteen-auto-reload: claim the reload before charging (a row keyed on camp + camper + date), and send an Idempotency-Key per camper per day."

### TED-076 🟡 Smaller loose ends
- `stripe-refund` treats an amount of 0 or less as "refund everything" (`stripe-refund/index.ts:147-149`). Billing never sends one, but the function should refuse it.
- The registration deposit's saved-card Stripe charge omits `on_behalf_of`, so the parent's statement shows Campistry's name instead of the camp's. It also has no Idempotency-Key. Every other Stripe charge sets `on_behalf_of` for this reason.
- Editing a payment plan quietly clears "paused" and any "collection blocked" note, and autopay is ticked on by default (`_mpBuildLedgerPlan`).
- The TED-062 test and the "all five writers post" test only look for text in the source, so they don't run the code.
- `payments-hosted-complete` never marks a registration-deposit link as completed. That's harmless, because the recording is idempotent.
- **What to ask the builder for:** "Tidy-ups: refuse non-positive refund amounts, add on_behalf_of and an idempotency key to the deposit charge, keep paused/collectionBlocked when editing a plan, and turn the text-only billing tests into ones that run the code."

## Re-check of yesterday's findings
| ID | Now | My proof |
|----|-----|----------|
| TED-051 autopay skipped parent-built plans | **Closed** | `autopay_runner.test.js` test 1 passes; fails on the old runner (3/3 fail) |
| TED-052 anyone could refund | **Closed** | 4 refund tests pass; fail on old code; code read: login, owner/admin, camp-owns-payment, claim before Stripe, Idempotency-Key, server-set campId (`stripe-refund/index.ts:129-199`). Residual: TED-076 |
| TED-053 charges never reached the ledger | **Closed as claimed**, with 3 new side effects | `charges_reach_the_ledger.test.js` passes; pgtest 215 billing block passes. New problems it caused: TED-065, 066, 067 |
| TED-054 payments-charge could not start | **Closed** | `byop_charge.test.js` 7/7 pass, 7/7 fail on old; no local imports |
| TED-055 declined old-style instalment dropped | **Closed** | runner tests 2–3 pass; pgtest 215 decline → pending, flagged, notified, retry pays |
| TED-056 two plan models | **Closed** (office now writes ledger plans; parent plans reopen) | `office_plan_is_ledger_plan.test.js` passes. New problem: TED-068 |
| TED-057 webhook accepted unsigned events | **Closed in code** | `stripe_webhooks_fail_closed.test.js` 6/6; 3 fail on old; connect webhook also checks age (`:142-145`). **Owner step: set the secrets or every Stripe event is now refused** |
| TED-058 cross-camp charge / no idempotency | **Closed** | 3 charge tests pass; fail on old |
| TED-059 batch always said 0 failed | **Closed** | `batch_charge_counts_failures.test.js` 3/3; fail on old |
| TED-060 billing tests couldn't catch problems | **Closed** | chain now 109 migrations; my three scratch databases booted from it and ran conversion, shop settlement and the parent balance for real |
| TED-061 open stripe-setup | **Closed** | harness: HTTP 410, 0 outside calls |
| TED-062 negative credit | **Closed** | code: `campistry_me.js:17999`, `:18412` refuse ≤ 0 (its test is text-only, TED-076) |
| TED-050 no test for camper numbers in the sweep | **Closed** | test catches both of my mutations (numbers dropped → 1 fail; fallback on any error → 1 fail) |
| TED-005 auto-scheduler | Open, deferred | still 14 failing |

## What I confirmed is working
- **Refunds (Stripe and Banquest/Cardknox):** owner/admin only, only the camp's own payments, claimed before the processor, and a retried click replays instead of refunding again. Proof: the tests above, and `payments-refund`, which I checked yesterday.
- **The office's "Charge card" on all three processors:** refuses another camp's card and a card that isn't the family's, sends an idempotency key, and reports declines honestly. Proof: `stripe_refund_and_charge`, `byop_charge` and `batch_charge` tests, all of which fail on the old code.
- **Autopay on card for both plan types:** charges on the due date. A decline is retried on a schedule and the office is alerted. Proof: `autopay_runner` tests and pgtest 215.
- **New late fees, surcharges, Add Charge, bulk charges and close-out entries now change both balances.** Proof: pgtest 215, where the parent balance went from 600 to 625.
- **The parent's "pay with saved card":** uses the parent's own login, records the payment with the family attached, and takes a lock against double clicks. Proof: `charge-saved-card/index.ts:222-290, 419-432`.
- **The parent's autopay card setup sends the family:** `campistry_link_parent.html:1614-1620`.
- **Canteen refunds (Stripe and processor):** owner/admin only. Stripe canteen refunds take the money back from the camp's account as well; the processor ones claim each refund before sending it. Proof: grep of the four canteen refund functions.
- **Tip checkout fee maths:** the counselor receives the full tip, and the fee covers Stripe's standard 2.9% + 30¢ plus Campistry's 2%. Proof: `stripe-connect-tip/index.ts:53-60`. The retry is broken (TED-073).
- **Webhooks:** Stripe, Stripe Connect, Cardknox and disputes all refuse unsigned messages.
- **Browser caching:** `campistry_me.js?v=20260924-01` is the only place that file is loaded.
- **Every test suite passes except the 14 known TED-005 failures.**

## What I did NOT check (and why)
- **Any real processor.** I never called Stripe, Banquest or Cardknox. Several findings depend on how they really behave:
  - whether Banquest's `?key=` lookup filters its results (TED-072);
  - whether Sola reports sales made through its API back to Campistry (TED-071);
  - how long real bank debits stay "processing" (TED-064).
- **What is deployed.** I can't see which function versions are live in Supabase, which secrets are set, or whether any camp ran `convert_family_ledgers` (TED-065).
- **The Billing page, the parent portal and the registration form in a browser.** Everything in them I checked by reading code or by running cut-out pieces of it.
- **Database security rules (RLS).** The test database runs as a superuser.
- **Bank deposit matching** (`deposit-inbox`, 3,000 lines), **payroll**, **tax statements**, **the POS register's own maths**, and **Link photo purchases**.
- **Whether surcharges are legal state by state**, and whether debit cards are excluded.
- **Two people at once in real time.** My only concurrency test was the auto-reload harness run.

## Things only you can check (click-by-click)
1. **Set the webhook secrets now. Since TED-057, a missing secret means every payment message is refused.** Supabase Dashboard → your project → Edge Functions → Secrets. Make sure `STRIPE_WEBHOOK_SECRET` is there, plus `STRIPE_CONNECT_WEBHOOK_SECRET` (and `STRIPE_CONNECT_ACCOUNT_WEBHOOK_SECRET` if you use it). Then go to Stripe Dashboard → Developers → Webhooks → your endpoint → "Recent deliveries". The deliveries should show 200, not 500.
2. **Find portal payments that never reached a family (TED-063).** Supabase Dashboard → SQL Editor → paste and Run (read-only):
   `select camp_id, payment_id, family_name, amount, pay_date from camp_payments where deleted_at is null and coalesce(family_key,'') = '' and payload->>'stripePaymentIntentId' is not null order by pay_date desc;`
   Every row is a card payment attached to no family. The money for these is in Campistry's own Stripe balance, not the camp's. Check under Stripe Dashboard → Payments, filtering by these ids.
3. **Did anyone run the ledger conversion (TED-065)?** SQL Editor, read-only:
   `select camp_id, family_key, name from camp_families where deleted_at is null and payload::text like '%le_conv_%' limit 50;`
   If any rows come back, those camps are at risk of double-counted charges. Tell the builder before anyone opens Billing for those camps.
4. **Are any families on bank-account autopay (TED-064)?** Stripe Dashboard → Payments → filter Payment method "ACH Direct Debit" and Status "Processing". Several debits for the same customer on consecutive days is this bug.
5. **Tips waiting on a retry (TED-073).** SQL Editor, read-only:
   `select staff_name, tip_cents, transfer_error, created_at from link_tip_cart_items where processed_at is null and coalesce(transfer_error,'') <> '';`
   Each row is a tip a counselor hasn't received.
6. **Close-out (TED-067):** until this is fixed, don't press "Apply" in a family's close-out when a child has canteen money listed.
