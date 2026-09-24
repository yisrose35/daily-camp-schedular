# Ted's report: billing, eleventh pass (re-check TED-116 to TED-123, then a hunt), 2026-09-24

## Verdict: 🔴 Problems found

**Can you be 100% certain billing is right? No, not yet.**

**Six of the eight fixes work, and I'm closing them** (TED-117, 118, 119, 121, 122, 123). I proved each with my own runs, most on a real copy of the database:
- Stripe canteen refunds no longer go out twice, and money a parent already got is no longer put back on the wallet.
- Charge Card now asks "the same charge, or a new one?" and does the right thing either way.
- An office card charge is now one payment row, not two.
- The nightly autopay run now stops on time and carries on without skipping or repeating a family.

**Two fixes are only half done:**
- **TED-116:** the new "waiting for an answer" list crashes the moment it tries to draw, so the office still has no working screen to settle a stuck Sola/Banquest refund.
- **TED-120:** Billing no longer takes a `ch_` id, but it still credits a family twice if the office pastes another family's `pi_` (or a typo).

**I also found five new problems. One of them is serious:**
- **The "Refund All" button in Snacks does nothing.** It has been broken since the file entered the project on Sep 8. I clicked it in a real browser. Nothing opens.

I did not change any code. I only reported.

## The numbers
Tests run: 3,710 · Passed: 3,696 · Failed: 14 (real bugs: 14, all of them the deferred auto-scheduler tests, TED-005 · out-of-date tests: 0 · my machine: 0)

| Suite | Run | Passed | Failed |
|---|---|---|---|
| Unit tests (`npm test`) | 3,535 | 3,521 | 14, all in `auto_full_day.test.js` (TED-005, deferred by you) |
| Database tests (`npm run test:pg`) | 65, against 124 migrations | 65 | 0 |
| `test:keys` | 42 | 42 | 0 |
| `test:lite` | 12 | 12 | 0 |
| `test:smoke` | 32 | 32 | 0 |
| `test:scale` | 24 | 24 | 0 |

These match the builder's figures exactly.

**The builder's new tests, run against the product code from before the fix** (`6a59cab`, in a scratch copy outside the project, removed afterwards):

| Test | Fails on the old code | Passes now |
|---|---|---|
| `canteen_stripe_reask` | 5 of 6 | 6 of 6 |
| `canteen_held_refunds` | 7 of 8 | 8 of 8 |
| `office_charge_retry` | 4 of 13 (the 4 new ones) | 13 of 13 |
| `stripe_dispute_camp` | 4 of 10 (the 5th new one, "404 is an answer", is meant to pass both ways) | 10 of 10 |
| `autopay_lost_answer` | 3 of 11 (the 3 new ones) | 11 of 11 |
| `canteen_refund_retry` | 1 of 21 | 21 of 21 |
| database test 276 | fails ("a ch_ id was taken") | passes |
| database test 275 with the wallet lock's `FOR UPDATE` removed | fails ("the second refund did not wait") | passes unchanged |

**So the new tests really check the fixes, with one gap.** The Snacks test lifts single functions out of the page and supplies its own copy of a helper the real page can't reach. That's why it passes while the real page crashes (TED-116, TED-125).

**Every earlier billing probe, re-run at today's code:** 81 probe files from passes 1 to 10.
- **72 ran cleanly.**
- **9 stopped early:**
  - 8 are the same 8 as last time, already replaced by working copies.
  - The 9th is my 10th-pass Charge Card probe. It stopped because the page now asks the new "same or new?" question. My new probe replaces it.
- **Of the 72 outputs I could compare with last time:**
  - 62 are identical.
  - 7 differ only in random ids or times.
  - 3 differ only because my old pretend Stripe can't list a payment's refunds, which the new code now asks for. In those 3, no money moved twice. I re-ran the same situations on a faithful Stripe model (below).

**New probes:** there are 6, in `ted/probes/2026-09-24-billing-11/`.
- One drives the **real Snacks page in a real browser** (Chromium) against a real database.
- Four run the **real edge functions or real page code against a real database** with every migration.
- One runs the real nightly runner in a chain of up to 30 runs.

## What's wrong (most serious first)

### TED-124 🔴 Snacks → Refund All does nothing when pressed
- **What a user would see:**
  - The office clicks **Refund All** on Snacks → Accounts. Nothing happens: no window, no message.
  - This is the only screen in the app that refunds every child's leftover canteen money at once. At the end of summer the office would have to refund every child one by one.
  - **It also blocks the new TED-116/117 screens:**
    - the "waiting for an answer" list the builder added to the Refund All window can't be seen;
    - a Stripe refund stuck "on its way" for a child whose wallet is now $0 can never be looked up. The only other trigger is a single refund, and its button is off at $0.
  - It has been like this since `campistry_snacks.js` entered the project (Sep 8). It is not new today.
- **How sure I am:** Confirmed in a real browser.
- **Proof:**
  - `snacks_refund_windows.log`:
    - `REFUND ALL button pressed: page errors from the click: ["ReferenceError: _stripeRefundCapacity is not defined"] | Refund All window open: false`
    - `typeof _stripeRefundCapacity in the page: undefined`
  - **Code:**
    - `campistry_snacks.js:2093` calls `_stripeRefundCapacity(c.name)`. No file in the project defines it: `grep` finds only this one call, and `git log -S` shows it was never defined.
    - The helper that exists is `_onlineRefundCapacity(name, processorKey)` (`:1847`).
    - The window's own text ("Only Stripe-paid deposits…", `:2110`, `:2116`) also ignores Sola/Banquest camps.
- **What to ask the builder for:** "TED-124: Snacks → Refund All throws ReferenceError _stripeRefundCapacity (campistry_snacks.js:2093) and the window never opens. Use _onlineRefundCapacity with the camp's processor, word the window for Sola/Banquest too, and add a browser test that clicks the real Refund All button with one camper and checks the window opens."

### TED-116 🟠 (still open) The office still can't settle a stuck Sola/Banquest canteen refund from any screen
- **What a user would see:**
  - The server side now works (see below). The screens don't:
    - **The Refund window:** the builder added a yellow "waiting for an answer from the card company" box with "It went through" / "Nothing went through" buttons. When it tries to draw, the page crashes, so the box never appears.
    - **The Refund All window:** the same box is there, but the window can't open (TED-124).
  - **The trap:** Avi's earlier $20 refund went through, but the answer was lost. From then on, every refund for Avi stops with "An earlier refund of $20.00 … was never confirmed … If it IS there, cancel and record it under 'waiting for an answer' in this window". There is no such box on screen. The office has two choices:
    - press OK ("it is not there"). That puts $20 back on Avi's wallet which the parent already has, so the parent can get it twice;
    - or never refund Avi again.
  - "Nothing went through" still works through that same OK.
- **How sure I am:** Confirmed. Real browser for the page, real database for the server.
- **Proof:**
  - `snacks_refund_windows.log`, the Refund window with one held $20 Sola refund for Avi: `page errors: ["ReferenceError: _lbl is not defined"] … "waiting for an answer" list shown: false | buttons: []`. The list was fetched: `edge calls: [["payments-canteen-refund","{\"action\":\"holds\"}"]]`.
  - **Code:** `_lbl` is declared *inside* `getCamperList()` (`campistry_snacks.js:143-151`), so it exists only there. The new list calls it at `:2050`, and Refund All's per-child error lines at `:2155`.
  - **The server half works** (`byop_held_refunds_realdb.log`, real functions + real SQL):
    - H1: `it went through, ref RN1 → 200 {"settled":true}` (a 2nd answer → 409); `Refund All again → failedCount 0`; `money back $20 [RN1], wallet $0.00, holds [posted $20.00], history [RN1 $20.00]`.
    - H2: a reload, then the office's "not there" confirm: `money back $20 [RN2], wallet $30.00`.
    - H3: "nothing went through" at 1 minute → 409 "sent a moment ago"; at 5 minutes → released, wallet $50.
    - H4: a reference already used → 409.
    - H5: a scheduler and a stranger → 403 for both actions.
- **What to ask the builder for:** "TED-116: the new 'waiting for an answer' box crashes (ReferenceError _lbl, defined inside getCamperList at campistry_snacks.js:151) — move _lbl to the top level, then prove the box shows with both buttons in a REAL browser test that opens the Refund window for a child with a held Sola refund (the current test supplies its own _lbl)."

### TED-126 🟠 A Stripe refund that fails after Stripe accepts it is never noticed, and a stuck canteen refund that later failed is booked as paid
- **What a user would see:**
  - Stripe can accept a refund and fail it days later, for example when the parent's card account is closed. The money then returns to the Stripe balance.
  - Campistry doesn't listen for that. The family's ledger (tuition) or the child's wallet (canteen) keeps saying "refunded". The parent never got the money.
  - With the camp's Stripe setup, the money lands in **Campistry's platform** Stripe balance, so the camp never hears of it.
  - **The new canteen look-up makes one case worse:**
    - A canteen refund's answer was lost. Stripe made it, then failed it.
    - Within 24 hours, the next Refund All (or the office pressing Refund again) correctly sees "failed" and puts the $20 back on the wallet.
    - But it then **re-sends the refund with the very same key**. Stripe answers with its old saved "succeeded", and Campistry books it as refunded again.
    - Wallet $0, the parent got $0, and Avi's history shows a $20 refund.
    - After 24 hours the same situation is handled correctly (a new refund is made).
- **How sure I am:**
  - The canteen replay: Confirmed with the real functions and real SQL, on a pretend Stripe that replays a key's first answer, as Stripe documents.
  - The general gap: Confirmed in code.
  - How often refunds fail: rare, not measured.
- **Proof:**
  - `canteen_stripe_faithful_realdb.log`:
    - F1 (Refund All, 1 hour later): `money back $0 [re_16 $20 (FAILED)], wallet $0, holds [posted $20.00], history [re_16 $20.00]`
    - F3 (single refund, same key): the same result.
    - F2 (25 h later) is right: `re_17 $20 (FAILED), re_18 $20 … wallet $0`.
  - **Code:**
    - After "failed" the hold is released (`stripe-canteen-refund-all/index.ts:296-299`, `stripe-canteen-refund/index.ts:307-313`).
    - The next send uses the same Idempotency-Key (`stripe-canteen-refund-all/index.ts:198`; `stripe-canteen-refund/index.ts:395-397`).
    - `stripe-webhook/index.ts:926-1016` handles no `refund.failed` / `charge.refund.updated` event, and no other function does.
  - **Stripe's behaviour:**
    - [Stripe refunds guide](https://docs.stripe.com/refunds): failed refunds, and for destination charges the money returns to the platform balance.
    - [Refunds API](https://docs.stripe.com/api/refunds): a refund's status can be `failed`.
    - [2024-10-28 changelog, refund webhook update](https://docs.stripe.com/changelog/acacia/2024-10-28/refund-webhook-update).
- **What to ask the builder for:** "TED-126: (1) after a canteen refund is found 'failed', never re-send it with its old Idempotency-Key — use a new key (and hold key); (2) handle Stripe's refund.failed / charge.refund.updated(status failed) in stripe-webhook: put the money back on the family ledger or child's wallet and raise a Billing notice. Test both."

### TED-120 🟠 (still open) "Autopay went through" still credits a family twice for the wrong `pi_` id
- **What a user would see:**
  - The `ch_` case from last time is fixed: Billing now says "use the payment's id — it starts with pi_".
  - **But the check only refuses a `pi_` booked for a *different amount*.** On an autopay night, many families are charged the same $500, so Stripe's payments list is full of identical-looking $500 rows.
  - **If the office opens Silver's row and pastes Silver's `pi_` for Gold:**
    - Gold is credited $500 on top of Gold's own payment. Balance $0 after paying $500 of $1,000, and the next instalment says "nothing owed".
    - Silver's $500 now appears twice in the payments list and the exports.
  - **If Gold's charge really failed:** Gold is marked paid with money never collected.
  - **A typo'd `pi_`** also credits twice once Gold's real payment arrives.
- **How sure I am:** Confirmed on the real database. How often an office picks the wrong row: Likely on busy nights, not measured.
- **Proof:**
  - `autopay_resolve_wrong_row.log`:
    - W1: `office → {"success": true, "recorded": true} … gold: ledger payments [le_pay_pi_GOLD $500, le_ap_plan_gold_0 $500] | balance owed 0.00 … next night due … "nothing_owed" … payment rows: auto_pi_SILVER→gold $500.00, pi_pi_GOLD→gold $500, pi_pi_SILVER→silver $500`
    - W4 (typo): the same double credit.
    - W3 (the right `pi_`) is correct.
  - **Code:** `migrations/276…sql:104-114` checks the `pi_` shape and a different amount only. It does not check another family, or that the payment exists.
- **What to ask the builder for:** "TED-120 (residual): resolve_unconfirmed_autopay must refuse a pi_ already booked for ANOTHER family (any amount); and on Stripe verify the pi_ with Stripe before recording (same customer as this family, same amount, succeeded, created on/after the hold's date) — e.g. an edge function the Billing button calls. Test: Silver's pi_ pasted for Gold → refused; a typo → refused."

### TED-125 🟡 Take Out Cash gives no confirmation, and leaves the amount in the box
- **What a user would see:**
  - The office pays Avi $5 cash. The $5 is recorded once, and the window closes.
  - Then the page crashes, so **the "Paid out $5.00 cash to Avi" message never appears** (the old message stays on screen) and **"5" is left in the amount box**.
  - An office that isn't sure it worked may open Take Out Cash again, see $5 already filled in, and record a second payout.
  - It has been like this since Sep 23 (`2330ff9`). Same cause as TED-116.
- **How sure I am:** Confirmed in a real browser.
- **Proof:**
  - `snacks_refund_windows.log` TAKE OUT CASH:
    - `database: balance now $35, cash-out rows = [{"amount":5,"kind":"cash_out"}]`
    - `page errors from the payout: ["ReferenceError: _lbl is not defined"]`
    - `toasts on screen: ["Added $40.00 to Avi Katz (Cash)"] | amount field still holds: "5"`
  - **Code:** `campistry_snacks.js:1788`.
- **What to ask the builder for:** "TED-125: moving _lbl to the top level (TED-116) also fixes Take Out Cash's missing confirmation (campistry_snacks.js:1788); add a browser test that pays out cash and checks the message and the cleared box."

### TED-127 🟡 After a stuck Stripe refund is looked up, refunding a new top-up fails once with "already refunded"
- **What a user would see:**
  - Refund All refunds Avi's $50, but the answer is lost. An hour later the parent tops Avi up $30, and the office refunds the $30.
  - The office sees **"Charge pi_… has already been refunded."** Nothing is refunded.
  - Pressing Refund again works ($30). The money is right both times (wallet $30, then $0).
  - This replaces last time's wrong wallet ($80) with a confusing error.
- **How sure I am:** Confirmed with the real functions and real SQL, on a faithful Stripe model.
- **Proof:**
  - `canteen_stripe_faithful_realdb.log`:
    - C1: `ERROR: Charge pi_5top1 has already been refunded. → money back $50 … wallet $30`
    - then `→ the office presses Refund again … $30 → money back $80 … wallet $0`
  - **Code:** the look-up settles the old refund (`stripe-canteen-refund/index.ts:260-264`). It then works out what is refundable from the wallet history read before that (`:209`, `:340-349`), with the settled refund dropped from the "on its way" list (`:264`). So the used-up top-up looks refundable again.
- **What to ask the builder for:** "TED-127: in stripe-canteen-refund, after the look-up loop settles a hold, count it against its top-up (re-read canteen_refund_view, or keep the settled amount in the deposit maths). Test: case C1 → $30 refunded on the first press."

### TED-128 🟡 The billing setup guide's new Dashboard steps leave out the "JWT verification off" switch
- **What a user would see:**
  - `BILLING_PAYMENTS_SETUP.md` now tells you to deploy `charge-due-installments` from the Dashboard (good, no command line). It doesn't say to turn off **"Enforce JWT Verification"** for it.
  - The nightly schedule call carries only the secret, not a Supabase login. With the switch on (Supabase's default for a new function), Supabase refuses the call and **nobody is charged, silently**.
  - `BYOP_SETUP.md` does say this, and notes it was hit on the live site. So your live function is probably already set correctly. The billing guide alone would lead you wrong on a fresh deploy.
- **How sure I am:** Confirmed in the documents. The effect is from Supabase's documented default and the project's own note.
- **Proof:**
  - `BILLING_PAYMENTS_SETUP.md:110-120` (no JWT step);
  - `BYOP_SETUP.md:196-216` (turn it off for `charge-due-installments`);
  - the schedule's headers at `BILLING_PAYMENTS_SETUP.md:129-133` (no `Authorization`).
- **What to ask the builder for:** "TED-128: add 'Settings → turn OFF Enforce JWT Verification' to the charge-due-installments steps in BILLING_PAYMENTS_SETUP.md, same wording as BYOP_SETUP.md."

## Re-check of last report's findings
| ID | Now | My proof |
|----|-----|----------|
| TED-117: Stripe canteen re-ask refunded twice / put refunded money back | **Closed** (new residuals → TED-126, TED-127) | **Real functions + real SQL + a faithful pretend Stripe** (`canteen_stripe_faithful_realdb.log`, 15 of 18 cases right). A1 (the $100 top-up, next Refund All 25 h later, key forgotten): `money back $50 [re_1 $50], wallet $0, holds [posted $50.00], history [re_1 $50.00]` (last time $100). A2 (fully refunded $20): `money back $20, wallet $0` (last time put back on the wallet). Never reached Stripe, asked 25 h or 5 min later: $20 once. Same page key again after 10 s, after 25 h, with a different reason, or with a 429 on the lookup (then a 3rd press): $20 once every time. Two top-ups, the second part lost: $20 once. Two deliberate $20 refunds still $40. Last time's V3 (wallet $80): now $30 with a 429, or correct after a second press (TED-127). |
| TED-118: same-day same-amount Charge Card replayed "succeeded" | **Closed** | **Real page code + real functions** (`charge_card_same_or_new.log`). Stripe: "a new charge" → yes → `charges actually made ["pi_1 $500","pi_2 $500"]`; "the same charge" → one charge, recorded once; cancel both → nothing sent; Batch → refused "never got an answer". Cardknox: new → R2 charged; same → the processor question, nothing charged. 3 builder tests fail on old code. |
| TED-119: Stripe Charge Card listed twice | **Closed** | **The real page's own row** (`pi_pi_1`) saved to a real database with the webhook's row, both orders: `payment rows [pi_pi_1 $500] (collected per the rows $500) | ledger payments [le_pay_pi_1 $500] | owed 500.00`. Last time: 2 rows, $1,000. Builder's page test fails on old code. |
| TED-120: autopay "went through" with a `ch_` id | **Still open** (narrowed) | The `ch_` case is fixed: the unchanged 10th-pass probe S2 → `{"error": "stripe_needs_payment_id"}`, hold kept, balance owed 500; pgtest 276 fails on the old 276. Another family's `pi_` or a typo still double-credits (above). |
| TED-121: webhook lookup failure lost the event | **Closed** | Unchanged `…-10/dispute_lookup_fails`: 500, 429 and a dropped connection → `webhook answers HTTP 500` for disputes and refunds (last time 200); a working lookup → 200, posted once. Every Stripe lookup happens before anything is written, so the retry can't post twice. 4 builder tests fail on old code. |
| TED-122: pgtest 275 didn't guard `FOR UPDATE` | **Closed** | In a scratch copy with `FOR UPDATE` removed from the wallet lock: `FAIL … the second refund did not wait for the wallet's lock`; unchanged: `ok`. (The comment at `migrations/227…sql:188-189`, "Deleting FOR UPDATE here breaks no test", is now out of date. Tidy-up only.) |
| TED-123: nightly run had no time budget | **Closed** | **The real runner, chained** (`autopay_chain.log`). 4 camps listed out of order, families keyed "zed", "Alpha", "10", "émile"…: 24 runs, 1 family each → `charged 24 of 24, twice [], missing []`. With a real clock (3 families per run) → `charged 20 of 20` in 7 runs. With 36 families → stops at 30 runs, logs `NOT continuing: 30 runs in a row`; the other 6 wait for the next night, and nobody is charged twice. One claim is slightly off, harmlessly: the card-expiry check runs twice for a camp when a run stops just as it enters that camp. The Billing notice isn't repeated (`ON CONFLICT DO NOTHING`, `migrations/214…sql`); only a timestamp is rewritten. Whether Supabase really keeps the handed-on run going is under "Things only you can check". |
| TED-005: auto-scheduler | Open, deferred | Still 14 failing, all in `auto_full_day.test.js`. Not investigated. |

## What I confirmed is working
- **Who can reach billing:**
  - my 10th-pass access sweep and stranger/parent read probes print exactly the same as last time;
  - the new `holds` / `resolveHold` actions refuse a scheduler and a stranger (403) and touch only the caller's own camp's holds.
- **The Cardknox/Banquest server side of TED-116** (H1–H5 above), on real SQL.
- **The autopay nights** (my 10th-pass real-database probe) print the same as last time: a lost Cardknox answer is held, Silver still charged, nothing charged twice.
- **Browser caching:** each changed file loads from exactly one page with the new number: `campistry_me.js?v=20260924-20` (`campistry_me.html:343`), `campistry_snacks.js?v=20260924-05` (`campistry_snacks.html:581`). No service worker.
- **Leftovers:** no secrets, debug switches or TODOs added. One informative server log line.
- **Every earlier closed billing finding still holds:** 72 earlier probes ran cleanly, with no money moving twice anywhere.

## What I did NOT check (and why)
- **Any real processor.** Stripe, Cardknox and Banquest are modelled. Stripe's rules (key replay, 24-hour keys, refund list, failed refunds) come from its documentation (links above).
  - I assumed Stripe's refund list shows a refund the moment it is made. I couldn't test that against real Stripe.
- **What is deployed.** Migrations 255–277 and the edge functions are not live yet.
- **Whether Supabase keeps the handed-on nightly run alive.**
  - The first run waits in the background for the next one, so on the free plan it outlives its own 150-second limit.
  - If Supabase stops the next run when the first is stopped, the rest of that night waits a day. That is the same as the old behaviour, and nobody is charged twice.
  - This can only be seen in your logs (below).
- **The Stripe "waiting" box and Refund All's result list in a browser after the fixes.** They crash today (TED-116, TED-124), so there was nothing further to see.
- **Card-surcharge refund rules.** I looked only far enough to see surcharges are ordinary bill lines. Not audited.
- **Areas no billing pass has deep-audited yet:**
  - payroll;
  - POS register maths;
  - Link photo purchases;
  - staff tips;
  - splitting a family;
  - the bank-email parser/matcher.
- **Tax law.** Your accountant should confirm the care-year rule.

## Things only you can check (click-by-click)
1. **Owner steps (still pending):**
   - Supabase → SQL Editor → paste migrations **255 to 277 in order**, each one → Run.
   - Then paste `scripts/verify_identity_chain.sql` → Run. Every row should say "ok".
   - Supabase → Edge Functions → deploy each of these:
     - `charge-due-installments`
     - `payments-charge`
     - `stripe-charge`
     - `stripe-webhook`
     - `payments-canteen-refund`
     - `payments-canteen-refund-all`
     - `stripe-canteen-refund`
     - `stripe-canteen-refund-all`
     - the earlier ones from the 9th/10th-pass list: `registration-deposit-checkout`, `canteen-auto-reload`, `cardknox-webhook`, `admin-connect-processor`, `stripe-connect-webhook`, `payments-refund`, `stripe-refund`.
   - Reload Me and Snacks on the office computers.
2. **The nightly run's switch (TED-128):**
   - Supabase → Edge Functions → `charge-due-installments` → Settings. Make sure **"Enforce JWT Verification" is OFF**.
   - Then open its **Logs** the morning after a due date. You should see a line starting `[autopay] done`.
3. **The handed-on run (TED-123):**
   - On a big night, the same Logs may show `[autopay] stopped for time … continuing in a new run`.
   - Check that a line `[autopay] done (part 2)` (or a final `[autopay] done — charged …`) follows within a few minutes.
   - If the "continuing" line is never followed, tell the builder.
4. **Until TED-124 is fixed:** refund canteen balances one child at a time (Snacks → Accounts → the child's **Refund** button). The Refund All button does nothing.
5. **Until TED-116 is fixed (Sola/Banquest camps):**
   - If a child's refund asks about "an earlier refund … never confirmed", open the Sola/Banquest portal first.
   - Press **OK only if the earlier refund is NOT there.**
   - If it IS there, press Cancel and send the builder the child's name and the refund's reference. There is no screen to record it yet.
6. **Until TED-120 is fixed:**
   - When Billing asks for the Stripe payment id, open the family first: Stripe → Customers → search the family's email → the payment on the charge date.
   - Copy its `pi_…` id from there, not from the all-payments list.
7. **Until TED-125 is fixed:** after **Take Out Cash**, look at the child's balance on the Accounts list before doing anything else. If it went down, the payout is recorded. Clear the amount box before the next payout.
8. **Until TED-126 is fixed:**
   - In your own Stripe Dashboard → Payments → **Refunds**, filter by status **Failed** once a week.
   - Any failed refund has to be fixed by hand on the family's bill or the child's wallet. Tell the builder which ones.
