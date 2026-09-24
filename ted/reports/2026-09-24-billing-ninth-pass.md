# Ted's report: billing, ninth pass (re-check TED-109 and TED-101, then a hunt), 2026-09-24

## Verdict: 🟡 Mostly good, some issues

**Can you be 100% certain billing is right? Not yet.**

**Both findings the builder fixed in `dfe322c` are really fixed, and I'm closing them:**
- **TED-109:** two presses of the same canteen refund now move the money once, on both processors, at every moment I tested.
- **TED-101:** a July/August deposit for next summer now goes on next year's tax statement, and the statement warns about it.

My earlier billing checks still hold. But I went looking in places no earlier pass had checked, and found 6 new problems.

**4 of them can move real money wrongly. Each needs one of two unusual moments:**
- **The answer gets lost.** The card company takes the money, but the reply never gets back to Campistry.
- **Two refund actions hit the same child at once.**

None of them happen on an ordinary day. All 4 need fixing before you can call billing 100%.

I did not change any code. I only reported.

## The numbers
Tests run: 3,645 · Passed: 3,631 · Failed: 14 (real bugs: 14, all of them the deferred auto-scheduler tests, TED-005 · out-of-date tests: 0 · my machine: 0)

**The test suites:**

| Suite | Run | Passed | Failed |
|---|---|---|---|
| Unit tests (`npm test`) | 3,473 | 3,459 | 14, all in `auto_full_day.test.js` (TED-005, which you deferred) |
| Database tests (`npm run test:pg`) | 62, against 121 migrations | 62 | 0 |
| `test:keys` | 42 | 42 | 0 |
| `test:lite` | 12 | 12 | 0 |
| `test:smoke` | 32 | 32 | 0 |
| `test:scale` | 24 | 24 | 0 |

These match the builder's figures exactly.

**The builder's new tests, run against the code from before the fix** (031534e, a scratch copy outside the project, removed afterwards):
- `canteen_refund_retry.test.js` fails 9 of 20 on the old code and passes 20 of 20 now.
- The two new tax tests fail on the old code and pass now.
- So these tests really check the fixes.

**Every earlier billing probe, re-run at today's code:** 60 probe files from passes 1 to 8.
- 55 ran cleanly, with the same results as when I closed each finding.
- 5 stopped early. **None of the 5 is a new bug.** I re-ran each one with a small fix to the probe itself:
  - 3 no longer load at all, because the code they copy now calls one more function. The 7th-pass versions of two of them run and agree. My fixed copy of the third, `deposit_twice_v9`, gives 750, so TED-095 is still closed.
  - `closeout.js` stopped because close-out no longer creates any charge list at all. That is the fix working. My copy `closeout_v9` shows no charge was posted.
  - `paynow.test.js` stopped because a payment with no login is now refused (400), as TED-063 requires. My copy `paynow_v9` shows the refusal.

**My new probes** are in `ted/probes/2026-09-24-billing-9/`. There are 9 of them. They run the real functions and page code against a pretend card company and database.

## What's wrong (most serious first)

### TED-110 🟠 A single refund during "Refund All" (or two staff refunding one child) sends back more than was left
- **What a user would see:**
  - Avi topped up $50 and spent $30 at the canteen, so $20 is left.
  - One office member presses **Refund All**. At the same time, another (or the same person in a second tab) refunds Avi's $20 from his own Refund box.
  - **Both refunds go through.** The parent gets **$40** back, and Avi's canteen wallet shows **−$20**.
  - Both screens say everything worked, so nobody notices. The camp has paid out $20 of snacks the child already ate.
  - It happens on Stripe and on Cardknox/Banquest.
  - **Why the window is wide:** Refund All reads every child's balance once, at the very start, then works through the children four at a time. At a big camp that takes a minute or two. Any refund made for a child during that time is not seen.
  - A child buying at the canteen while Refund All is running is refunded the old, higher balance in the same way.
- **This is partly new:**
  - Before 66a65df, a single refund of a child's whole balance used the same "claim" (a record that stops the same refund being sent twice) as Refund All. So the two couldn't both go out.
  - The TED-105 fix gave single refunds their own key (a label for one refund request). That separated them.
  - A *partial* single refund (say $10 during Refund All) could always double up.
- **How sure I am:** Confirmed with the real functions, both loaded into one process so they could race each other. How often two offices actually hit the same child is Likely, not proven.
- **Proof:**
  - `probes/…-9/refund_all_vs_single.test.js`, at today's code:
    - **Stripe:** both timings → `money back to the parent: $40 ["pi_top1 $20","pi_top1 $20"] | canteen wallet after: -20.00`.
    - **Cardknox:** the same, `$40 ["X1 $20.00","X1 $20.00"]`.
  - The same probe on older code:
    - **3390aba:** all four runs → **$20**.
    - **66a65df:** three of four → **$40**.
  - `refund_all_vs_single_10.test.js`: a $10 single refund during Refund All → **$30** on both 3390aba and today's code.
  - **Cause:**
    - Refund All reads balances once (`stripe-canteen-refund-all/index.ts:233`, used until `:253`; `payments-canteen-refund-all/index.ts:362`, `:388`).
    - A single refund with the page's key claims `canteen:<pageKey>:<top-up>` (`payments-canteen-refund/index.ts:303-305`), which is never the same claim as Refund All's `canteen:<top-up>:<left>:<amount>`. Refund All's own comment still says "One key per money, whichever button spends it" (`payments-canteen-refund-all/index.ts:240`). That is no longer true.
    - The wallet write never refuses to go below zero (`migrations/229…sql:144, :213`).
- **What to ask the builder for:** "TED-110: a canteen refund must take the money out of the child's wallet in one locked database step BEFORE calling the card company (refuse if balance − floor is less than the amount), and put it back only when the card company says no. Refund All must do this per child at that child's turn, not trust the balances it read at the start. Add a test where Refund All and a single refund (same amount, and a smaller one) run at the same time on both processors."

### TED-111 🟠 "Charge Card" after a lost answer charges the parent twice
- **What a user would see:**
  - The office opens a family in Billing, presses **Charge Card** and charges $500.
  - The card company takes the money, but the reply gets lost (a dropped connection or a timeout). The page says **"Charge failed: …"**.
  - The office naturally presses Charge Card again. The box is pre-filled with the same balance. The parent is charged **$500 a second time**.
  - On **Banquest**, when its gateway times out (HTTP 504), the office is told **"Declined (HTTP 504)"**, although the sale may have gone through.
- **How sure I am:** Confirmed with the real page code and the real functions.
- **Proof:**
  - `probes/…-9/office_charge_retry.test.js`:
    - **The page:** the office saw `"Charge failed: Failed to send a request to the Edge Function"`. The two presses sent different keys (`chg_gold_1790222015631_pipe3y`, then `chg_gold_1790222015632_8u9i03`), so neither the card company nor the claim can tell it's a retry.
    - **Stripe:** `the parent was charged: ["pi_1 $500","pi_2 $500"]`.
    - **Cardknox:** `["sale 1 $500.00","sale 2 $500.00"]`.
    - **Banquest 504:** `{"error":"Declined (HTTP 504)"}` and the claim was released.
  - **Code:**
    - A brand-new key on every press (`campistry_me.js:19134`).
    - A timed-out Banquest charge is reported as declined (`payments-charge/index.ts:91`), and the claim is handed back (`:190-192`).
  - Refunds were fixed for exactly this in TED-093 and TED-105. Charges never were.
- **What to ask the builder for:** "TED-111: Charge Card must reuse the same key for the same family and amount until a charge succeeds (like the Snacks refund key), so a retry after a lost answer meets the first charge. A lost answer must say 'may have gone through — check the processor before trying again', not 'Charge failed'. In payments-charge, a Cardknox reply with no xResult or a Banquest 5xx with no reference number is 'uncertain' (keep the claim), never 'declined'. Add a lost-answer test on all three processors."

### TED-113 🟠 One dropped connection stops the whole night's autopay, and that family can be charged twice
- **What a user would see:**
  - The nightly autopay run charges families one after another, across every camp.
  - If one card company call drops mid-way (the connection resets, or Stripe sends back an error page instead of a proper reply), the **whole run stops there**.
  - **Every family after it, at every camp, is not charged that night.** They are charged a night late. Nothing in Campistry tells anyone the run stopped. I found no alert in the code, and I could not see how the nightly schedule is set up in your Dashboard.
  - The family whose charge dropped is not recorded. At a Cardknox/Banquest camp that sale also never reaches the ledger (the processor's webhook doesn't book it, as TED-071 set up), so **the next night the family is charged again**. That is two charges for one instalment, if the first went through.
  - **Banquest:** a gateway timeout (504) is booked as a **decline**, and the office is told the card declined. Autopay then tries again later, so the family can also be charged twice.
- **How sure I am:** Confirmed with the real runner.
- **Proof:** `probes/…-9/autopay_lost_answer.test.js`, a Cardknox camp with Gold and then Silver both due $500:
  - **Night 1:** `runner answered HTTP 500 (threw: ["connection reset by peer"]) | card sales made ["Gold $500.00"] | booked []`. Silver was never charged.
  - **Night 2:** `card sales made ["Gold $500.00","Silver $500.00"] | booked ["gold:500","silver:500"]`. Gold paid twice. Only the second payment is booked.
  - **Banquest 504:** `booked ["gold:0 (declined: Declined (HTTP 504))",…] | flag ["declined: Declined (HTTP 504)"…]`.
  - **Code:**
    - The charge calls have no error catch (`charge-due-installments/index.ts:797-799`, and again at `:1037-1039`).
    - Nothing in the handler catches either (`:304`). An error there makes the whole request fail.
    - The Stripe call reads the reply as JSON without checking it (`:135`).
- **What to ask the builder for:** "TED-113: in charge-due-installments, catch errors per family so one processor failure never stops the rest of the run. A charge whose answer was lost (the call threw, Stripe sent back something that isn't JSON, Banquest 5xx with no reference, Cardknox with no xResult) must not be booked as declined and must not be charged again automatically. Hold it like the bank-debit hold, and raise a Billing-only notice telling the office to check the processor dashboard. Add a test: family 1 has its answer lost, family 2 must still be charged the same night, and family 1 is not charged again the next night."

### TED-114 🟠 (suspected) Stripe chargebacks may never reach the family's ledger
- **What a user would see (if my suspicion is right):**
  - A parent disputes a $500 card charge. Stripe takes the $500 back out of the camp's account.
  - Campistry still shows the family as paid, and the camp's books overstate the cash it collected.
  - Only Campistry's own operator email goes out, and the camp is not told. That email even says the chargeback "stands" on the books when it closes.
- **How sure I am:** Suspected. The code is certain. What Stripe sends is not something I could check.
  - To find the camp, the webhook reads the **dispute's own** metadata (the extra fields Campistry attaches to a Stripe object).
  - Campistry stamps the camp on the payment, and Stripe copies that to the charge. As far as I know, Stripe does **not** copy it to a dispute. Stripe's documentation site is blocked from my machine, and a web search didn't settle it.
  - No test sends a dispute shaped the way Stripe sends one.
- **Proof:**
  - `stripe-webhook/index.ts:754`: `const campId = obj.metadata?.campId || event.data.object?.metadata?.campId` (the same field read twice).
  - `probes/…-9/dispute_campid.test.js` (the real webhook, correctly signed):
    - dispute metadata empty → `HTTP 200 | record_chargeback calls: 0 | log: … has no campId in metadata — cannot post it to a ledger; reconcile by hand`;
    - dispute metadata with campId → 1 call.
  - The reply is 200, so Stripe never sends it again.
- **What to ask the builder for:** "TED-114: for charge.dispute.created/closed, don't read campId from the dispute's own metadata. Fetch the PaymentIntent (dispute.payment_intent) or the charge from Stripe and read campId from it. Add a test using a real-shaped dispute event whose metadata is {}." You can also check it yourself: see step 3 at the end.

### TED-112 🟡 The tax statement for a family who only paid a deposit for next summer says the wrong things
- **What a user would see:**
  - The most common year-end case: Summer 2026 tuition was billed in October 2025, and the family paid a $500 deposit in December 2025.
  - **The numbers on the 2025 statement are right:** $0 claimable.
  - **But the printed page tells the parent:** "Payments in 2025 could not be matched to any charge, so they cannot be split per child … this has to be split by hand."
  - That is untrue. The payment was matched to 2026 care, and the 2026 statement correctly includes the $500. A parent or office "splitting it by hand" could claim the same $500 in 2025 and again in 2026.
  - The office also sees a box saying **"Not ready to send. Missing:"** with nothing after it.
  - Every such statement also says the deposit was "toward camp that had not been billed yet". It was billed.
  - This has been true since the care-year change in 66a65df. I saw the wording in my 8th-pass output and did not flag it. I should have.
- **How sure I am:** Confirmed with the real statement-printing code and the real tax module.
- **Proof:**
  - `probes/…-9/tax_prepaid_only_print.js`, case A prints:
    - `Not ready to send. Missing:`
    - `$500.00 was paid in 2025 toward camp that had not been billed yet…`
    - `Payments in 2025 could not be matched to any charge… split by hand.`
    - `Total $0`
  - **Code:**
    - `report.allocated = false` whenever no child row exists (`campistry_tax_statement.js:425-426`). This includes when everything went to a later year.
    - The prepaid wording (`:407`).
    - The empty "Missing:" box (`campistry_me.js:18847`).
- **What to ask the builder for:** "TED-112: when a year's payments all went to care in a later year, the tax statement must not say they 'could not be matched' or mark itself not ready. Say '$500 paid in 2025 is for camp in 2026 and is on the 2026 statement'. Reword 'toward camp that had not been billed yet' so it is true when the camp was billed. Never show 'Not ready to send. Missing:' with nothing after it. Add a test for a deposit-only year."

### TED-115 🟡 One of the builder's claims is only partly true: a second lost answer shows a raw "connection reset"
- **What a user would see:**
  - A Stripe canteen refund's answer is lost. The office presses again, and that second request's call to Stripe is cut off too.
  - The office sees **"connection reset"** instead of the "may have gone through, check first" message.
  - **Money is still safe.** The third press gets the same refund back from Stripe, and $20 moved in total.
- **How sure I am:** Confirmed.
- **Proof:**
  - `probes/…-9/stripe_reask_throws.test.js`:
    - press 1 → `uncertain … may have gone through`;
    - press 2 → `HTTP 500 {"error":"connection reset"}`;
    - press 3 → `$20, replayed`;
    - money moved `["pi_top1 $20"]`.
  - The re-ask of an unconfirmed earlier part has no catch (`stripe-canteen-refund/index.ts:181-185`). The main loop does (`:295-304`).
- **What to ask the builder for:** "TED-115: in stripe-canteen-refund, a cut-off Stripe call while re-asking an unconfirmed earlier part (the stripeGet/stripePost at :181-185) must answer {uncertain: true} like the main loop does, not a 500."

## Re-check of last report's findings
| ID | Now | My proof |
|----|-----|----------|
| TED-109: two presses at once refunded twice | **Closed** | `probes/…-9/canteen_race_timings.test.js`: the real functions, with a second press arriving at **5 different moments**: <br>• before the first press claims the refund; <br>• just after it claims; <br>• while it is calling the card company; <br>• after the card company acted but before the reply; <br>• after the first part is recorded. <br>That is 30 runs across 3 top-up shapes and 2 processors. **Every run moved exactly $20.** The second answer was always "$20" or "uncertain", never a plain error. <br>My unchanged 8th-pass probe's race rows now say `MONEY MOVED 1` / `2nd click: $20` (it was $40 / "Refund failed."). <br>Page: `snacks_busy_button.js` runs the real Snacks code. A double-click, a retyped amount and a third press all send **1 request**, and a retry after an error reuses the same key. The old Snacks sent 3 requests and turned the button back on. |
| TED-101: tax year for an undated session | **Closed** | Unchanged `probes/…-8/tax_edges.js`, case J ("Summer 2027", $500 paid 1 Aug 2026): 2026 claimable **0** (prepaid 500), 2027 **3000**, with the "has no start date" warning (was 2026: 500, no warning). Cases F and G unchanged (0 / 2200). K (undated autumn programme) is still moved to the next year, but now always with a warning. The builder's 2 new tests fail on the old code. The wording problem I found next to it is filed as TED-112. |
| TED-005: auto-scheduler | Open, deferred | Still 14 failing, all in `auto_full_day.test.js`. Not investigated. |

## What I confirmed is working
- **Canteen refunds, same key:** 30 of 30 timing runs move the right amount once (above). All of the 8th-pass lost-answer, network-cut and part-declined runs still move money once.
- **Browser caching:** the new versions are the only place each file loads.
  - `campistry_snacks.js?v=20260924-03` (`campistry_snacks.html:579`);
  - `campistry_tax_statement.js?v=20260924-03` (`campistry_me.html:243`);
  - there is no service worker.
- **Every earlier closed billing finding still holds**, re-run at today's code. The main ones:
  - autopay holds a bank debit for 1 debit over 3 nights;
  - plan amounts: 1000 / 200 / 200;
  - cancelled shop orders: balance 0;
  - parent and office balances are equal through shop, Zelle, autopay and refund;
  - deposits are counted once (750);
  - Refund All after a lost answer sends 1 refund;
  - Campistry's SMS fees can't be refunded (403);
  - Record Payment refuses a minus sign;
  - the migrations 255–273 check script says "ok" after pasting twice.
- **The roles change pushed in the same batch** (`4d05417`) is only a change to the settings screen (which apps a role opens). The money functions still accept only owners and admins.

## What I did NOT check (and why)
- **Any real processor.** I never called Stripe, Cardknox or Banquest. Their behaviour is modelled:
  - replaying a repeated key;
  - refusing a refund bigger than the original charge;
  - a 504.
  In particular, whether Stripe copies the camp onto a dispute (TED-114) needs your check below.
- **What is deployed.** Migrations 255–273 and the edge functions are not live yet, so nothing here is live either.
- **A real browser with two real office users.** The TED-110 race was run with the real functions in one process, not with two people on two computers.
- **Database security rules (RLS) as a real staff member.** The scratch databases run as a superuser.
- **Tax law.** Your accountant should confirm the care-year rule.
- **Areas no billing pass has deep-audited yet:**
  - payroll;
  - the POS register's maths;
  - Link photo purchases;
  - staff tips;
  - splitting a family;
  - the bank-email parser/matcher;
  - card-surcharge rules. For example, card networks require a proportional surcharge refund when a surcharged payment is refunded. I did not trace that.

## Things only you can check (click-by-click)
1. **Owner steps from the builder (still pending):**
   - Supabase → SQL Editor → paste migrations 255–273 **in order**, each one → Run.
   - Run `scripts/verify_identity_chain.sql` and check that every row says "ok".
   - Supabase Dashboard → Edge Functions → deploy:
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
     - `stripe-canteen-refund`
     - `stripe-canteen-refund-all`
   - Reload Snacks and Me on the office computers.
2. **Until TED-110 is fixed:** when you run Snacks → Refund All, make sure nobody else is refunding a child or selling at the canteen until it says it's finished. Afterwards, look for any child whose wallet shows a minus balance.
3. **TED-114, a 2-minute check in Stripe:**
   - Stripe Dashboard → Developers → Events → search `charge.dispute.created`.
   - If you have never had one, switch to Test mode and pay a test pay-link with the card `4000 0000 0000 0259`. This creates a dispute.
   - Open the event and look at `data.object.metadata`.
   - **Empty `{}`:** TED-114 is real, and chargebacks are not reaching Billing.
   - **Shows `campId`:** tell me and I'll close it.
4. **Until TED-111 is fixed:** if Charge Card says "Charge failed" with a connection or timeout message, don't press it again. First look in your processor's dashboard (Stripe → Payments, or the Sola/Banquest portal) for a charge on that card in the last few minutes.
5. **Until TED-113 is fixed:** each morning, open Supabase → Edge Functions → `charge-due-installments` → Logs. The last line of the night's run should start with `[autopay] done`. If it doesn't, the run stopped part-way. The families after the stop will be charged the next night.
