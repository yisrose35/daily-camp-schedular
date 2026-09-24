# Ted's report: billing, sixteenth pass (re-check TED-143, TED-152 to TED-156, then a hunt), 2026-09-24

## Verdict: 🔴 Problems found

**All six fixes I re-checked work, and I'm closing them:** TED-143, 152, 153, 154, 155 and 156. I proved each one myself, on the real pages in a real browser, with the real functions and a real database. The gap I found in last pass's surcharge test is closed too.

**But you can't be 100% certain yet.** Looking at parts of billing no pass had tested, I found six new problems. The worst is on the **Finance** page:
- **Finance page (🔴):** a payment recorded with its "+ Record Payment" button never reaches the family's bill. The nightly autopay then charged that family's card the full amount again.
- **Canteen register (🟠):** it can charge a child twice for one snack.
- **Four smaller ones** are listed below.

I did not change any product code. I only reported.

## The numbers
Tests run: 3,860 · Passed: 3,846 · Failed: 14 (real bugs: 14, all of them the deferred auto-scheduler tests, TED-005 · out-of-date tests: 0 · my machine: 0)

| Suite | Run | Passed | Failed |
|---|---|---|---|
| Unit tests (`npm test`) | 3,646 | 3,632 | 14, all in `auto_full_day.test.js` (TED-005, deferred by you) |
| Database tests (`npm run test:pg`) | 70, against 129 migrations | 70 | 0 |
| `test:keys` | 42 | 42 | 0 |
| `test:lite` | 12 | 12 | 0 |
| `test:smoke` | 32 + 34 (the Snacks browser test) | 66 | 0 |
| `test:scale` | 24 | 24 | 0 |

These match the builder's figures exactly (claim 8).

**The builder's new and changed tests, run against the code from before the fixes** (`0923e47`, in a scratch copy outside the project, removed afterwards; logs `oldcode_*.log`):

| Test file | Failures on the old code |
|---|---|
| `cash_discount_applied` | the whole file (the discount code it tests did not exist) |
| `closeout_not_a_sale` | all 3 |
| `link_autoreload_paused` | all 3 |
| `canteen_autoreload_season` | 4 of 7 |
| `ach_on_its_way` | 2 of 17 |
| `card_surcharge_billing` | 2 of 15 |
| `canteen_autoreload_once` | 0 of 5 (its only change gives the pretend camp session dates, so it still charges under the new rule; I read it and nothing was loosened) |

**Mutation checks** (`mutations.log`): I broke today's database changes on purpose and re-ran their tests. All three were caught:
- migration 281 undoing **every** surcharge credit instead of only the failed refund's own one. Last pass this slipped through; now the test fails, so claim 7 holds;
- migration 282 doing nothing;
- the checking script without its new 282 row.

**Every earlier billing probe, re-run at today's code:** 112 probe files from passes 1 to 15 (`rerun_all_probes.sh`, outputs in `rerun/`, compared in `compare_reruns.out`).
- **102 give the same output as last pass.**
- **The other 10 are all explained:**
  - **4 are timings or clock times only**, with the same answers.
  - **2 are the TED-143 fix itself.** After the season, and before next summer, nobody is charged any more.
  - **3 are auto-reload probes whose pretend camp has no session dates**, so under the new rule nobody is charged. I made corrected copies with a session covering today (`sola_pause16`, `reload16`, `recheck_harness16`). They give exactly last pass's results.
  - **1 is my 7th-pass Record Payment probe.** It copies that button's code and was missing the new discount helpers. The corrected copy (`negative_payment16`) gives last pass's result: a minus amount is still refused.
- **The 13 probes I wrote last pass, re-run unchanged** (`rerun15/`): every difference is one of the six fixes. The unfixed-code failures now pass: close-out sales, the $970 cheque, the late "processing" event, the $5 fee for a bank family, and Link's wording.
- **The 6 browser probes from pass 14** (`rerun_e2e/`): 5 give the same results.
  - The 6th (`ach_charge_twice`) uses a pretend Stripe that can't answer the new "how does this payment stand now?" question.
  - So the webhook asks Stripe to resend, and Charge Card refuses with "nothing was charged". That is the safe outcome.
  - Last pass's fuller copy (`ach15`) answers that question and passes A1–A6.

**New probes this pass** (`ted/probes/2026-09-24-billing-16/`):
- 4 browser probes on the real pages: the cheque discount and the Finance page, Link's auto-reload card, the canteen register, and a PostgREST check;
- 3 on real functions over a real database: auto-reload by session dates, the Finance-page payment against the real autopay run, and migration 282's paste orders;
- 1 on the tip fee maths;
- 4 corrected copies of older probes.

## What's wrong (most serious first)

### TED-157 🔴 A payment recorded on the Finance page never reaches the family's bill, so autopay charges the card again
- **What a user would see:**
  - The Moss family owes $1,000 and pays by cheque.
  - The office records it on **Finance → Revenue → "+ Record Payment"**, which is a button with the same name as Billing's. The toast says "Payment recorded", and Finance's Payment Log lists "Moss $970 Check".
  - **But Billing still says Moss owes $1,000**, and so does the parent's balance in Link.
  - On the night the family's payment plan is due, **autopay charges their card the full amount**, and they have now paid twice. Reminders and late fees work from the same wrong figure.
  - The cheque discount (TED-153) isn't given on that page either.
- **Why:**
  - That button saves the payment under a typed family name only. It never puts the payment on the family's bill (the ledger).
  - Since 16 September (commit `4c0e9aa`), the ledger is what Billing, Link and autopay all read.
- **How sure I am:** Confirmed, on the real Me page in a browser and with the real autopay run on a real database.
- **Proof:**
  - `cash_discount16.log` D5: `toast: "Payment recorded"`, `Finance's own lists now show Moss as: "2026-09-24Moss$970Check✕"`, `Billing's figure for Moss: "$1,000"; the ledger … owes $1000`, `Moss's ledger: charge 1000 tuition`.
  - `finance_page_payment16.log`: Gold's $1,000 cheque saved exactly the way that button saves it → `plan_due_for → {"amount": 1000.00 …}` → `results ["Gold:charged $1000","Silver:nothing_owed $0"]`, `card sales made: Gold $1000.00`. The control family Silver, whose cheque was recorded in Billing, was not charged.
  - Code: `campistry_me.js:15806` (the button), `:16169-16196` (`finAddPayment`: no family key, no ledger entry), `:16759` ("THE POSTED LEDGER WINS"), `migrations/264_…sql:48` (autopay's amount comes from the ledger).
- **What to ask the builder for:** "TED-157: Finance → Revenue → '+ Record Payment' (finAddPayment, campistry_me.js:16169) saves a payment row with only a typed family name and never posts it to the family's ledger, so Billing, the parent's Link balance and autopay ignore it — a $1,000 cheque recorded there was charged again by the nightly autopay run (finance_page_payment16). Make that button open Billing's Record Payment (family picker, ledger entry, cheque discount) or remove it, and add a test that runs the real button."

### TED-158 🟠 The Finance page's ✕ "removes" a payment from its list but not from the bill
- **What a user would see:**
  - The office records a $970 cheque on the wrong family (Wolf), notices, and removes it with the only remove button there is: **Finance → Revenue → Payment Log → ✕**.
  - The toast says "Removed" and the row disappears from Finance.
  - **Wolf still shows $0 owed** in Billing and in Link. The payment and its $30 discount are still on Wolf's bill, so the camp never collects Wolf's $1,000.
  - Finance's revenue totals now disagree with Billing.
- **How sure I am:** Confirmed, on the real Me page in a browser.
- **Proof:**
  - `cash_discount16.log` D6: `pressed ✕ on: "2026-09-24Wolf$970Check✕"`, `toast: "Removed"`, `Wolf owes on the ledger: before $0, after $0; Billing: "$0"`, `Wolf's ledger: … payment 970 check …; credit 30 discount …`.
  - Code: `campistry_me.js:15843` (the ✕), `:16198-16204` (`finRemovePayment` only takes the row out of the list).
- **What to ask the builder for:** "TED-158: Finance → Payment Log's ✕ (finRemovePayment, campistry_me.js:16198) removes only the list row; the payment's ledger entry and any cash-discount credit tied to it stay, so the family's balance doesn't change (Wolf still owed $0 after his $970 cheque was removed). Either reverse the ledger entry and its discount when a payment is removed, with a confirmation that says so, or remove the ✕ and give Billing a proper 'reverse this payment' (e.g. for a bounced cheque)."

### TED-159 🟠 The canteen register can charge a child twice for one snack
- **What a user would see:**
  - **Case 1, a second tap:** a counselor taps "Charge $2.50 → Shaya". On slow camp wifi nothing seems to happen for a moment, so they tap again. **Shaya is charged $2.50 twice.** The register then says "✓ $2.50 charged to null".
  - **Case 2, a lost answer:** the wifi drops just as the charge goes through. The register says **"Charge failed (TypeError: Failed to fetch)"** and keeps the cart. The counselor taps Charge again, and Shaya is charged twice.
  - Either way, the parent sees two debits for one item in Link, and twice the amount counts against the child's daily limit.
- **How sure I am:** Confirmed, on the real register page with the real database.
  - The project's own test harness sends database calls one at a time and in order, which hides this.
  - My probe sends the charge the way the real Supabase library does (in the background), to the same database.
- **Proof:**
  - `pos_double16.log` P0 (control): one tap → 1 debit.
  - P1: `requests sent 3; new debits 2; balance $32.50; register says ["✓ $2.50 charged to null"]`.
  - P2: `register says ["Charge failed (TypeError: Failed to fetch)"] … counselor taps Charge again → … new debits 2`; ledger shows two `debit 2.5 Ices` per case.
  - Code: `campistry_snacks_pos.js:655` (`charge()`: nothing stops a second call; the button stays live and the cart is only cleared when the answer arrives, `:714`), `:750-752` (no key sent with the sale), `migrations/247_…sql:49-157` (every call is a new purchase).
- **What to ask the builder for:** "TED-159: the POS Charge button (campistry_snacks_pos.js:655) can send submit_canteen_purchase twice — a second tap while the first is on its way, or a retry after a lost answer that the register reports as 'Charge failed' although the server charged — and each call is a new debit (pos_double16). Disable the button while a charge is in flight, send a key per sale that submit_canteen_purchase stores so a repeat returns the first result instead of charging again, and when no answer came back say 'could not confirm — check the child's transactions' rather than 'Charge failed'. Test it with the charge sent asynchronously, as supabase-js does."

### TED-160 🟡 The "not paying by card" discount for online bank payments is given by hand and can be given twice
- **What a user would see:**
  - For a bank payment made **online** (a pay link, a bank debit, or an autopay instalment by bank), the office has to remember to press **"Discount for not paying by card…"** and type the amount. A family on bank autopay needs it pressed after every instalment.
  - Nothing ties the discount to the payment:
    - Hawk got $30 off, then **$29.10 more** when it was pressed again for the same payment (Hawk is now owed a $29.10 credit).
    - Nothing shows which online payments have already had their discount.
  - Also, from reading the code (not tested): the discount is never taken back on a refund.
    - A family who got $30 off and then withdraws has those $30 in their refundable credit, so the camp would refund more than it was paid.
    - The card surcharge's share, by contrast, does come back on refunds.
- **How sure I am:** The double discount is confirmed in a real browser. The refund part is likely, from reading the code.
- **Proof:**
  - `cash_discount16.log` D7: `toast: "$30 off Hawk for not paying by card"; Hawk owes $0`; then `pressed again for the same payment → toast: "$29.1 off Hawk …"; Hawk owes $-29.1`.
  - Code: `campistry_me.js:2454-2475` (`_giveCashDiscount` gives each discount a fresh id, `'manual_'+Date.now()`, linked to no payment). No refund code reads the discount (`cashDiscount` appears only where it is created).
- **What to ask the builder for:** "TED-160: the online-bank cash discount (_giveCashDiscount, campistry_me.js:2454) isn't tied to a payment, so it can be given twice for the same payment (Hawk: $30 then $29.10) and bank autopay instalments never get it; let the office pick the online bank payment it is for (one discount per payment, like Record Payment's cdisc_<payment id>) or give it automatically when a bank payment is recorded; and decide whether a refund takes back the discount's share the way it takes back the surcharge's."

### TED-161 🟡 Link: after parents turn auto-reload off, there's no way back on, and editing an amount quietly turns it back on
- **What a user would see:**
  - After the parent presses **Turn off**, Link says "Auto-reload is off." with **no buttons** at all, and the trigger box is still ticked.
  - The new "Switch it back on" button only appears when **the camp** paused it.
  - If the parent only changes the amount while it is off (say to $30, to be ready for later), **auto-reload is switched straight back on**, and their card will be charged when the balance drops.
  - All they see is a small "saved" hint and the status line changing to "Auto-reload is on".
- **How sure I am:** Confirmed. I used Link's own auto-reload card and its own functions in a browser, calling the real parent function on a real database. It isn't the whole Link page, because there is no test parent login.
- **Proof:** `link_paused16.log`:
  - P2 `Link: "Auto-reload is off."; buttons []; "below $5" box ticked: true`;
  - P3 `sent [{"enabled":true,…,"thresholdReloadAmount":30,…}]`, `stored: enabled true … Link "✓ Auto-reload is on · charging Visa ···· 4242"; toasts ["(saved hint)"]`.
  - Code: `campistry_link_parent.html:2615` (the off state hides both buttons), `:2737` (the auto-save always sends `enabled:true`).
- **What to ask the builder for:** "TED-161: in Link's plain 'Auto-reload is off' state (after the parent's own Turn off) there is no button to switch it back on, and _arAutoSave (campistry_link_parent.html:2737) sends enabled:true on any field change, so editing only the amount while it is off switches auto-reload back on with just a 'saved' hint (link_paused16 P3). Show 'Switch it back on' in that state too, and make an edit while off save the settings without switching it on."

### TED-162 🟡 (Suspected; a card-rules question, not a code bug) Staff tips add 5% to 36% on top of every tip, debit cards included
- **What a user would see:** a parent tipping a counselor pays:

  | Tip | Parent pays | Extra, as a share of the tip |
  |---|---|---|
  | $20 | $21.32 | 6.6% |
  | $5 | $5.57 | 11.4% |
  | $1 | $1.36 | 36% |

  - The extra is Stripe's fee plus Campistry's 2%, and the parent sees it before paying.
  - The staff member gets the full tip, and Campistry keeps exactly its 2% (I checked the maths).
  - But the product's own Card Fees rules refuse any card surcharge above 3%, and any fee on a debit card, "which the card brands forbid". The tip checkout doesn't go through those rules.
- **How sure I am:** Suspected. The maths is right; whether this fee is allowed on tips is a question for Stripe.
- **Proof:** `tip_fee16.log` (the tip function's own fee calculation, lifted and run as-is). Code: `supabase/functions/stripe-connect-tip/index.ts:43-62`, and Link's wording at `campistry_link_parent.html:7544`.
- **What to ask the builder for:** "TED-162: the staff-tip checkout (stripe-connect-tip computeFees) passes Stripe's fee + 2% to the parent — 5–36% of the tip, debit cards included — outside campistry_card_fees.js's rules; once the owner has asked Stripe whether that is allowed for tips, either absorb it or apply the camp's card-fee policy."

## Gaps in the builder's tests
- Nothing tests the Finance page's "Record Payment" or ✕. That's how TED-157/158 have gone unnoticed since 16 September.
- The register's Charge button is tested only through the harness, which sends database calls one at a time. A double tap can't happen there (TED-159).
- The auto-reload job reads the session dates with a special query. The builder's test harness doesn't run that query as written; it hands back whole rows.
  - I ran the exact query through a real PostgREST 12.2.3, the server Supabase puts in front of the database, with the project's own supabase-js (`postgrest_sessions16.log`).
  - It returns the sessions correctly, and only the sessions.

## Re-check of last report's findings
| ID | Now | My proof |
|----|-----|----------|
| TED-143: auto-reload outside the season | **Closed** | Real job on a real database, sessions stored the way Dates & Pricing stores them (`autoreload_sessions16.log`, 0 BAD): S1 next summer entered in spring, 4 weekly runs → `skipped_not_in_session`, nothing charged (last pass: $20 + 4 × $25); S2 between sessions → none; S3 first and last day → charged; S4 day after → `skipped_season_over`; S5 no dates → `skipped_no_session_dates`; S6 falls back to the camp dates; S7 office switch → none; S8 two camps in one run → only the in-session camp; S9 a stale camp-dates row doesn't override the sessions. The query works on real PostgREST (`postgrest_sessions16.log`). Link's hint, Snacks' hint and the setup guide now say "only on days camp is in session" / Dates & Pricing; no "Camp dates" step left (grep). |
| TED-152: close-out counted as sales | **Closed** | Last pass's probe, unchanged, on the real Me close-out then the real Snacks page (`rerun15/closeout_sales15.e2e.log`): Sales today stays $3, Revenue $3.00, weekly bar $3, row labelled "Season close-out" (last pass: $40 / "Purchase"). The builder's test fails 3/3 on the old code. |
| TED-153: discount for not paying by card | **Closed** (new residuals → TED-160) | Real browser (`cash_discount16.log`): D1 $970 cheque → owes $0, the window showed "$30" before saving, the discount is its own ledger line; D2 $1,000 cheque → $30 credit; D3 $500 ACH + $470 Zelle → $15.46 + $14.54 = $30; D4 card → no discount; D8 the menu says "Discount for not paying by card…". Last pass's probe, unchanged: Wolf owes $0 (was $30). Tax statement: a same-day credit is applied before the payment, so a $970 cheque counts as $970 of care (code read, `campistry_tax_statement.js:223-232`). |
| TED-154: late "processing" after a returned debit | **Closed** | Last pass's probe, unchanged (`rerun15/ach15.e2e.log` A6): after `payment_failed`, the late "processing" leaves the row **failed**, and Charge Card works again (last pass: "on its way" and refused). The builder's test sends a signed event to the real webhook: Stripe unreachable → HTTP 500, nothing recorded (fails on the old code). All camp charges are made on the platform's own Stripe account, so the webhook's look-up can find them (grep: no connected-account header anywhere). |
| TED-155: flat fee refused for a bank family | **Closed** | `rerun15/surcharge15.e2e.log` S7: Zinc (bank) → "✓ Card fee of $5 added to Zinc" (last pass: refused). The percentage surcharge is still refused for a bank default (`rerun_e2e/surcharge_default_bank.log` unchanged). Nit: the toast still says "Card fee" for a bank payer; the bill line uses the disclosure wording. |
| TED-156: Link pause note / way back on | **Closed** (residual → TED-161) | `link_paused16.log`: P0 "Switch it back on" shown while the camp has it paused; pressing it → stored `enabled true`, note gone, card kept, "✓ Auto-reload is on"; P2 after the parent's own Turn off → "Auto-reload is off." (not "the camp"). `check_script_282.log`: 231 pasted again after 282 → "apply 282"; 282 again → ok; 282 twice → notice, the line is in once, grants kept; 282 without 231 → "282 needs migration 231 — apply it first". pgtest 282 fails when 282 does nothing or when the script loses its row (mutations). |
| pgtest 281 gap (last pass's M5) | **Closed** | `mutations.log` M1: undoing every credit now fails the test ("undo: … undone 2"). |
| TED-005: auto-scheduler | Open, deferred | Still 14 failing, all in `auto_full_day.test.js`. Not investigated. |

## What I confirmed is working
- **Claims 1–9:** each is checked above.
  - Two things in them are incomplete, not wrong: the online-bank discount (TED-160), and Link's plain Off state (TED-161).
- **Payment ids are unique now** (`pay_<time>_<random>`), and nothing in the code reads the old shape (search). The ledger took the new ids in the browser run.
- **Browser caching:** `campistry_me.js?v=20260924-25` and `campistry_snacks.js?v=20260924-10`, each loaded from its one page.
- **Leftovers:** no secrets, debug switches or TODOs in the changed files; one intended new server log line.
- **Who can call money functions from a browser:** still 98, the same list as last pass (`rerun/…access_sweep.log`).
- **Photo purchases:** the price is fixed on the server, so a browser can't change it (code read, `link-photo-checkout/index.ts:46`). That's all I looked at.
- **Auto-reload's "today" is the UTC date** (S10). For a camp in New York it starts about 4 hours early, the evening before the first day, and stops at 8 pm on the last day. It's minor, and the parent's own dates work the same way.
- **Your code didn't change under me.** HEAD is `4811cd7` throughout. Only my `ted/` folder changed.
  - One old probe rewrites its own output file in the 10th-pass folder. I kept this pass's copy in my folder (`access_sweep16.out.json`) and put the old file back.

## What I did NOT check (and why)
- **Any real processor, email or SMS service.** Stripe, Sola and Resend are modelled on their documented behaviour. Nothing is live.
- **What is deployed.** Migrations 255–282 and the functions are not live yet.
- **The whole Link page with a real parent login** (there's no test parent login). I ran its auto-reload card and functions against the real database function.
- **The canteen register beyond the Charge button:**
  - the offline register;
  - voiding or refunding a sale;
  - stock counts;
  - the child's daily limit, which uses the register tablet's own date.
- **Staff tips beyond the fee maths:**
  - how a tip is recorded;
  - transfers to staff;
  - refunds of tips;
  - failed transfers.
- **The cheque discount on a refund or withdrawal:** I read the code only (TED-160).
- **Two office computers recording cheques for the same family at the same moment.**
- **Areas no billing pass has deep-audited yet:**
  - payroll;
  - photo purchases beyond the price;
  - splitting a family;
  - the bank-email matcher.

## Things only you can check (click-by-click)
1. **Owner steps (still pending):**
   - Supabase → **SQL Editor** → paste migrations **255 to 282 in order**, each one → **Run**.
   - Then paste `scripts/verify_identity_chain.sql` → **Run**. Every row should say "ok".
   - **281 must be in before `stripe-webhook` is deployed.**
   - Supabase → **Edge Functions** → deploy each of these (changed this time: `canteen-auto-reload` and `stripe-webhook`):
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
2. **Session dates decide auto-reload now:**
   - Go to Dashboard → **Dates & Pricing**, and check that every session has its real start **and** end date.
   - A camp with no session dates charges nobody automatically.
   - To test auto-reload outside the season, the setup guide says to add a test session covering today. That session also shows on your registration form while it exists, so delete it straight after.
3. **Until TED-157/158 are fixed:**
   - Record every payment in **Billing → the family → Record Payment**, never on Finance → Revenue.
   - Then look at **Finance → Revenue → Payment Log**. For each row whose family's Billing balance didn't go down, record it again in Billing.
   - Then press ✕ on the Finance-page copy. That copy never reached the bill, so removing it is safe.
   - Don't use ✕ to undo a payment recorded in Billing. For now, add a charge for the same amount with a note ("cheque returned").
4. **Until TED-159 is fixed, tell the canteen staff:**
   - Tap **Charge** once and wait for the green "✓ … charged" message.
   - If it says "Charge failed", open Snacks → that child's transactions before charging again.
5. **Staff tips (TED-162):**
   - Stripe Dashboard → **Help → Contact support**.
   - Ask whether passing Stripe's fee plus a 2% platform fee to the parent on a tip is allowed, including for debit cards. Quote the table above.
6. **Stripe events (unchanged):**
   - Stripe Dashboard → Developers → Webhooks → your endpoint → **⋯ → Update details**.
   - Check that `payment_intent.processing`, `payment_intent.payment_failed`, `refund.failed`, `refund.updated` and `charge.refund.updated` are ticked, with the rest of the list in `BILLING_PAYMENTS_SETUP.md` step 5.
7. **Platform alert email:** Supabase → Edge Functions → **Secrets**: check `RESEND_API_KEY` is set.
