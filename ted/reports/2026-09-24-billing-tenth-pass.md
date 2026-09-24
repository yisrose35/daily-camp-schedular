# Ted's report: billing, tenth pass (re-check TED-110 to TED-115, the new "held" states, then a hunt), 2026-09-24

## Verdict: 🟡 Mostly good, some issues

**Can you be 100% certain billing is right? Not yet.**

**All six findings from last time are fixed, and I'm closing them (TED-110 to TED-115).**
- I proved each one with my own runs, several of them on a real copy of the database rather than a pretend one.
- The builder's new access fix (migration 277) also works. A stranger or a parent can no longer read or change a camp's billing.

**But the new "held" states have gaps, and I found other problems too. Five of them can move real money wrongly or record it wrongly:**
1. **Stripe canteen refunds can go out twice.** When Campistry asks Stripe again about a canteen refund whose answer was lost, it can refund the parent a second time, or put money the parent already got back onto the child's wallet. This happens if the re-ask comes more than a day later, or if Stripe hiccups during the re-ask.
2. **Some canteen refunds get stuck forever.** On Cardknox/Banquest, a canteen refund whose answer was lost can never be settled from any screen. In one case the parent's money stays locked on the wallet for good.
3. **An office card charge on Stripe is recorded twice** in the payments list and the accounting exports. This is older than today's changes, and it happens on an ordinary day.
4. **Autopay, when the office answers "it went through":** if they paste the wrong Stripe number, the family is credited twice and the next instalment is never collected.
5. **Charge Card, later the same day after a lost answer:** a second charge of the same amount says "payment succeeded!" when nothing was charged.

I did not change any code. I only reported.

## The numbers
Tests run: 3,684 · Passed: 3,670 · Failed: 14 (real bugs: 14, all of them the deferred auto-scheduler tests, TED-005 · out-of-date tests: 0 · my machine: 0)

| Suite | Run | Passed | Failed |
|---|---|---|---|
| Unit tests (`npm test`) | 3,509 | 3,495 | 14, all in `auto_full_day.test.js` (TED-005, deferred by you) |
| Database tests (`npm run test:pg`) | 65, against 124 migrations | 65 | 0 |
| `test:keys` | 42 | 42 | 0 |
| `test:lite` | 12 | 12 | 0 |
| `test:smoke` | 32 | 32 | 0 |
| `test:scale` | 24 | 24 | 0 |

These match the builder's figures exactly.

**The builder's new tests against the code from before the fix** (`b8812dd`, in a scratch copy outside the project, removed afterwards):

| Test file | Fails on the old code | Passes now |
|---|---|---|
| `canteen_refund_race` | 10 of 10 | 10 of 10 |
| `canteen_refund_retry` | 15 of 21 | 21 of 21 |
| `office_charge_retry` | 8 of 9 (the 9th, "a different amount is a different charge", was always true) | 9 of 9 |
| `autopay_lost_answer` | 8 of 8 (all 6 runner tests, plus 2 about the new Billing link) | 8 of 8 |
| `stripe_dispute_camp` | 4 of 5 | 5 of 5 |
| `tax_statement` | 2 of 41 | 41 of 41 |

- For `office_charge_retry` and `autopay_lost_answer` I had to let the test load without the new page functions, which don't exist in the old code.
- **So these tests really check the fixes.**
- **One exception:** the builder said the database race test "fails if the wallet lock is removed". That's only half true (TED-122).

**Every earlier billing probe, re-run at today's code:** 72 probe files from passes 1 to 9.
- **64 ran cleanly.**
- **8 stopped early:**
  - 5 are the same five that stopped at the 9th pass. They were replaced then by working copies, which still agree.
  - 3 are my 9th-pass probes of the bugs just fixed. They used a pretend database or page that has no idea of the new "reserve first" step or the new kept key. My new real-database probes replace them.
- **Output compared with the 9th pass:**
  - 50 of 60 printed exactly the same.
  - Of the other 10:
    - 5 differ only in random ids or times.
    - 3 show the intended new tax wording, with the same numbers.
    - 2 changed only because my old pretend database doesn't know the new refund step. I re-checked both on real SQL, and the money is right.

**New probes** are in `ted/probes/2026-09-24-billing-10/`. There are 9 of them. Most run the **real edge functions against a real scratch database with every migration applied**, with a pretend card company.

## What's wrong (most serious first)

### TED-117 🟠 Asking Stripe again about an unconfirmed canteen refund can refund twice, or put already-refunded money back on the wallet
- **What a user would see:**
  - A canteen refund's answer gets lost. This is likeliest when Refund All runs long at a big camp and is cut off. The money stays "held" off the child's wallet, and the next Refund All (or a refund of that child) asks Stripe again.
  - **If that next ask is more than a day later**, Stripe no longer recognises the request and treats it as new:
    - Avi had $50 left of a $100 top-up. The parent got **$100 back instead of $50**, and the office screen said "Refunded $0".
    - Where the top-up was refunded in full, Stripe says "already refunded". Campistry reads that as "no refund happened" and **puts the $20 back on Avi's wallet**. He can spend it again at the canteen, though his parent already has it.
  - **The same wrong "put it back" happens within the day** if Stripe hiccups (for example a rate limit) while Campistry looks the payment up before re-asking:
    - Avi's $50 was refunded by Refund All, but the answer was lost.
    - His parent tops him up $30, and the office refunds that $30.
    - The office sees "Charge has already been refunded", and **Avi's wallet shows $80 instead of $30**.
- **How sure I am:**
  - **Confirmed** with the real functions and the real database rules.
  - Stripe's side is modelled on its documented behaviour:
    - keys are forgotten after at least 24 hours, and a reused forgotten key is a brand-new request;
    - a reused key with different details is refused with HTTP 400.
  - How often a re-ask lands more than a day later: Likely, not proven.
- **Proof:**
  - `probes/…-10/canteen_holds_realdb.js` (log `canteen_holds_realdb.log`):
    - **E1:** `money back to the parent $100 (their child had $50) … Stripe refunds made: re_36 $50, re_37 $50`
    - **E2:** `wallet now $20.00, holds [released $20.00]` after `Charge pi_30top has already been refunded`
  - `probes/…-10/reask_param_mismatch_realdb.js`, **V3:** `HTTP 500 {"error":"Charge pi_top has already been refunded."} … wallet $80.00, holds [released $30.00, released $50.00]`
  - **Code:** the re-ask has no age limit and doesn't check the payment lookup:
    - `stripe-canteen-refund-all/index.ts:269-289`
    - `stripe-canteen-refund/index.ts:197-214`
    - `stripe-canteen-refund/index.ts:243-248`
    - Any 4xx other than 409/429 counts as a definite "no" (`stripe-canteen-refund/index.ts:79`, `stripe-canteen-refund-all/index.ts:70`).
    - The page's own comment knows keys last 24 hours (`campistry_me.js:19298-19300`).
  - **Stripe's behaviour:**
    - [Stripe API reference, idempotent requests](https://stripe.com/docs/api/idempotent_requests?lang=node) (quoted in search results; the site itself is blocked from my machine);
    - [stripe-ruby issue #503](https://github.com/stripe/stripe-ruby/issues/503) (400 for a reused key with different parameters).
- **What to ask the builder for:** "TED-117: when re-asking Stripe about a held canteen refund, (1) never re-send a hold older than ~23 hours with its old key. Find it instead by listing the payment's refunds (put the hold key in the refund's metadata when it is first sent). (2) If the PaymentIntent lookup fails, stop and leave the hold, don't re-send. (3) Treat Stripe's idempotency_error (400) as 'undecided', never as 'no'. Test: a hold re-asked 25 hours later after Stripe forgot the key, and a re-ask whose lookup gets a 429."

### TED-116 🟠 On Cardknox/Banquest, a canteen refund whose answer was lost can never be settled, and the parent's money can stay locked on the wallet
- **What a user would see:**
  - **Case 1: the refund went through, but the answer was lost.**
    - Refund All runs, and the card company refunds Avi's $20 but the answer never arrives.
    - His wallet shows $0 (correct), but **the refund never appears in his canteen history**.
    - Every later Refund All says "1 hit an error — check with the parent or try that camper individually", **without saying which child**. It asks the office to "use Refund on this child to settle it". But with a $0 wallet the Refund box's maximum is $0 and **the Refund button is disabled**.
    - Nothing on any screen can mark it "went through". This repeats on every Refund All, forever.
  - **Case 2: the refund did not go through, but the answer was lost.**
    - The office refunds $20 of Avi's $50. The card company never answers, and the refund really didn't happen.
    - The office reloads Snacks and refunds $20 again, which works.
    - **His wallet now shows $10 when it should show $30.** The parent's first $20 sits on a hold nobody can release.
    - When the office later refunds "the rest" ($10), the parent has had **$30 of the $50 back, and $20 is locked for good**. A note appears in that success message, but the page gives no way to act on it.
  - Stripe camps are not affected by this one: a Stripe hold settles itself on the next re-ask, subject to TED-117.
- **How sure I am:** Confirmed with the real functions, the real database rules and the real Snacks refund-box logic.
- **Proof:**
  - `canteen_holds_realdb.log`:
    - **C:** `a day later, Refund All again → failed 1 [An earlier refund of $20.00 … use Refund on this child to settle it] … wallet $0.00, holds [open $20.00]` and `the Refund box's maximum … = $0 → Refund button disabled`
    - **D:** `wallet $10.00 (should be $30) … money back $30 of the $50 topped up, wallet $0.00, holds [open $20.00, posted $20.00, posted $10.00]`
  - **Code:**
    - The Refund box's maximum comes from the wallet (`campistry_snacks.js:1872-1884`).
    - The single refund offers to release a hold only when the wallet is already $0 (`payments-canteen-refund/index.ts:286-289`), which the page can never send.
    - There is no "it went through" action for Cardknox/Banquest at all.
    - Refund All's result shows counts only (`campistry_snacks.js:2064-2066`).
- **What to ask the builder for:** "TED-116: give the office a place (Snacks → a child's account, and a list after Refund All naming each child) to settle a held Cardknox/Banquest canteen refund both ways: 'it went through' with the processor's reference (posts the refund line), or 'nothing went through' (puts the money back, after 3 minutes). Show held amounts on the child's account so a reload doesn't hide them. Test both cases above."

### TED-119 🟠 (older than today's changes) A Stripe "Charge Card" payment is recorded twice in the payments list and the accounting exports
- **What a user would see:**
  - The office charges a family's saved card $500 (Me → Billing → Charge Card). Stripe's notice to Campistry (the webhook) records the payment.
  - If that notice arrives before the page saves, both happen within seconds, so this is an ordinary-day event. The page then adds its own copy under a different id.
  - The payments list shows **$500 twice**, and the payment rows total **$1,000**.
  - The family's balance is right, but the **QuickBooks / Xero / general-ledger exports and the revenue chart are built from those rows**, so the camp's books import $1,000 of receipts for a $500 charge.
- **How sure I am:** Confirmed on the real database for the ordering. How often the notice beats the save: Likely, not measured.
- **Proof:**
  - `probes/…-10/office_charge_rows.js`:
    - `webhook first, page saves after: payment rows [pay_1790000000000 $500, pi_pi_B $500] (total collected per the rows: $1000) | ledger payments [le_pay_pi_B $500] | balance owed 500.00`
    - The other order gives 1 row.
  - **Code:**
    - The page's row id is `'pay_'+Date.now()` (`campistry_me.js:19257`).
    - The webhook's is `"pi_" + pi.id` (`stripe-webhook/index.ts:193`).
    - A row is identified by its id first (`migrations/208…sql:127-131`).
    - The exports and revenue chart loop over every row (`campistry_me.js:15683, 16142, 16170, 16194, 16216`).
- **What to ask the builder for:** "TED-119: an office Stripe charge must end up as ONE payment row. Either the page records nothing and lets stripe-charge record it server-side (keyed on the PaymentIntent, like the webhook), or the payment save merges a row whose stripePaymentIntentId already exists. Test both orders (webhook first / page first) → one row, exports count $500 once."

### TED-120 🟠 Answering "the autopay charge went through" with the wrong Stripe number credits the family twice
- **What a user would see:**
  - A Stripe autopay charge's answer was lost. The plan is held, and Billing shows "Autopay $500 never confirmed — did it go through?"
  - Stripe's notice has meanwhile recorded the $500 payment on the family.
  - The office clicks "It went through". It is asked for **"The charge's reference number"** and pastes the Stripe **charge** id (`ch_…`, shown on the same Stripe page) instead of the payment id (`pi_…`).
  - The family is **credited $500 twice**: balance $0 after paying $500 of $1,000.
  - **The next instalment is never collected** (the next night: "nothing owed").
  - Pasting the `pi_…` id works correctly. So does Cardknox.
- **How sure I am:** Confirmed on the real database. Whether an office would paste the `ch_` id: Likely, given the prompt's wording.
- **Proof:**
  - `probes/…-10/autopay_resolve_realdb.js`:
    - **S2:** `ledger payments 2 [le_pay_pi_S2 $500, le_ap_plan_a_0 $500] | payment rows 2 | balance owed 0.00 … next night due {"amount": 0, "reason": "nothing_owed"}`
    - **S1** (`pi_` id) gives 1 payment, and **S3/S4** are right.
  - **Code:**
    - The typed reference is the only thing matched against what the webhook already booked (`migrations/276…sql:101-115`).
    - The prompt text is at `campistry_me.js:6473`.
- **What to ask the builder for:** "TED-120: for a Stripe hold, don't rely on a typed reference. Before recording, look for a payment already booked for this family and amount since the hold (the webhook's, carrying metadata planId/source autopay) and link to it. Otherwise accept only a `pi_…` id and say so in the prompt. Test: webhook booked pi_X, office types ch_X → one payment, next instalment still due."

### TED-118 🟠 Charge Card: a second charge of the same amount the same day, after a lost answer, says "payment succeeded!" when nothing was charged
- **What a user would see:**
  - **Stripe:**
    - At 10:00 the office charges Gold $500. The answer is lost, but the charge went through. The page correctly says "may have gone through".
    - At 15:00 a new $500 fee is added and the office charges Gold $500 again.
    - The page reuses the morning's key (kept for 23 hours per family and amount). Stripe replays the morning's charge, and **the office is told "Charged $500 to Gold — payment succeeded!"**
    - Nothing new was charged. A second payment row is added (see TED-119), and Gold still owes the fee.
  - **Cardknox:** the office is instead asked "An earlier try at this charge was never confirmed… if it is not there, confirm". The morning's charge *is* there, so the new $500 can't be charged that day unless they change the amount.
- **How sure I am:** Confirmed with the real page code and the real functions. How often it happens: uncommon.
- **Proof:**
  - `probes/…-10/charge_key_same_day.test.js`:
    - **Stripe:** `15:00 press (a NEW $500) → ok=true | toast: Charged $500 to Gold — payment succeeded! | Stripe charges actually made: ["pi_1 $500"]`
    - **Cardknox:** `15:00 … ok=false … "An earlier try at this charge was never confirmed…" | Sola sales actually made: ["R1 $500.00"]`
  - **Code:** `campistry_me.js:19203-19206`, `:19305`.
- **What to ask the builder for:** "TED-118: after a 'may have gone through' charge, the next Charge Card for that family must ask 'Is this the same charge you tried at 10:00, or a new one?' and use a new key for a new one. And once the office has confirmed the earlier charge (it shows on the family), drop the kept key."

### TED-121 🟡 A Stripe hiccup while the webhook looks up a dispute or refund loses it for good
- **What a user would see:**
  - A parent disputes a charge, or someone refunds in the Stripe Dashboard.
  - The webhook now asks Stripe which camp the dispute or refund belongs to. That is the TED-114 fix, and it works.
  - If that one lookup fails (Stripe error, rate limit, dropped connection), the webhook still answers "OK". So **Stripe never sends it again, and the chargeback or refund never reaches the family's books.**
  - For a refund there isn't even a log line.
- **How sure I am:** Confirmed with the real webhook, correctly signed.
- **Proof:**
  - `probes/…-10/dispute_lookup_fails.log`: for 500, 429 and a dropped connection, `webhook answers HTTP 200 | chargebacks posted: 0` and `refunds posted: 0 | logs: []`. With a working lookup, 1 is posted.
  - **Code:**
    - `stripeGetJson` swallows every failure (`stripe-webhook/index.ts:691-698`).
    - Silent return (`:736`).
    - Return with 200 (`:789-794`).
- **What to ask the builder for:** "TED-121: in stripe-webhook, if the Stripe lookup for a dispute's or refund's camp FAILS (as opposed to finding no campId), answer 500 so Stripe retries. Test: dispute with empty metadata + PI lookup answering 500 → HTTP 500, then a retry with a working lookup posts once."

### TED-122 🟡 The new race test doesn't guard the wallet lock it is said to guard
- **What a user would see:** Nothing today. The product code is right. This is a missing safety net.
- **How sure I am:** Confirmed.
- **Proof:** in a scratch copy of today's code:
  - With `FOR UPDATE` removed from the wallet lock (`migrations/227…sql:193-196`; I confirmed the final function has none), **pgtest 275 still passes**: `ok 275_a_canteen_refund_takes_its_money_first`.
  - With the refund reading the wallet without the lock function at all, it fails: `TED-110: two refunds at once both took Bea's $20`.
  - The test lets the first refund finish before the second starts, so the second waits at another step whether or not the lock is there. The comment at `227:189` ("Deleting FOR UPDATE here breaks no test") is still true.
- **What to ask the builder for:** "TED-122: make pgtest 275 race two reserves that both READ before either writes (e.g. pause the first inside the lock with a pg_sleep hook), so that deleting FOR UPDATE makes it fail. Show it failing with FOR UPDATE removed."

### TED-123 🟡 (suspected) The nightly autopay run has no time limit of its own
- **What a user would see (if my suspicion is right):**
  - The run charges every due family at every camp, one after another, in one call.
  - Supabase stops a function after a fixed time. The builder's new Stripe retry also waits 1.5 s and then 3 s per family during a Stripe outage.
  - On a big night (the 1st of the month at several camps) the run could be stopped part-way:
    - the families after that point are charged a night late;
    - the one being charged at that moment is not recorded, and can be charged again the next night.
- **How sure I am:** Suspected. The code has no time budget and no place to resume. I could not see the size of your nights or the platform's limit.
- **Proof:**
  - No time check anywhere in `charge-due-installments/index.ts`.
  - The retry wait is at `:136`.
  - The next night's Stripe key includes the date (`:900`), so it is a new charge.
- **What to ask the builder for:** "TED-123: give charge-due-installments a time budget: stop cleanly before the platform limit, hold (not charge) the family in flight, and let the next run or a second call carry on. Test with 1,000 due families."

## Re-check of last report's findings
| ID | Now | My proof |
|----|-----|----------|
| TED-110: Refund All + a single refund sent back more than was left | **Closed** | **Real functions + real 275 SQL** (`canteen_holds_realdb.log`, section A): Refund All and a single refund of the same child, the second landing at 3 moments (while the first reads balances / just after it reserved / at the card company), $20 and $10, Stripe and Cardknox. **24 of 24 runs:** exactly $20 back, wallet $0, never below zero. A $15 sale during Refund All → $5 back on both processors. Two deliberate $20 refunds still send $40 (TED-097 holds). pgtest 275's two-connection race passes (its gap is TED-122). |
| TED-111: Charge Card after a lost answer charged twice | **Closed** (new side effect → TED-118) | The builder's test runs the real page and functions: 8 of 9 fail on old code. My 9th-pass probe now shows `Banquest 504 → {"uncertain":true,"canConfirm":true…}` (was "Declined"), Stripe/Cardknox say "may have gone through". My new probe shows one charge across the retry. |
| TED-113: one dropped call stopped the night; charged twice | **Closed** | **Real runner + real SQL** (`autopay_nights_realdb.log`). Cardknox: night 1 `Gold:unconfirmed_held … Silver:charged`; night 2 `Gold:waiting_for_office`, no new sale; office "went through" (9001) → recorded once; night 3 nothing. Banquest 504 → held, not "declined". Stripe cut off → re-asked with the same key → one charge, recorded. Stripe 500 every time → held. Billing notice `charge_unconfirmed` raised once (a money notice: Billing staff only). |
| TED-114: disputes never reached the ledger | **Closed** (residual → TED-121) | The webhook now asks Stripe for the payment: `dispute_lookup_fails` control → 1 chargeback posted; the builder's test 4 of 5 fail on old code. Whatever Stripe puts on the dispute, a working lookup finds the camp. |
| TED-112: tax statement wording for a deposit-only year | **Closed** | Unchanged `probes/…-9/tax_prepaid_only_print.js`: A prints `$500.00 paid in 2025 is for camp in 2026… on the 2026 statement` and `Nothing paid in 2025 was for camp given in 2025`. No "Not ready", no "split by hand", no "not billed yet". All tax numbers in my 6th–8th pass probes are unchanged (e.g. A 0/3000, C 0, D 2000/1000, E 2750, J 0/3000); "no start date" warnings still shown. |
| TED-115: second lost Stripe answer showed a raw error | **Closed** | Unchanged `probes/…-9/stripe_reask_throws.test.js`: press 2 → `HTTP 200 {"uncertain":true,…}` (was 500 "connection reset"); press 3 → $20 replayed; money moved once. |
| TED-005: auto-scheduler | Open, deferred | Still 14 failing, all in `auto_full_day.test.js`. Not investigated. |

## What I confirmed is working
- **Migration 277, who can reach billing, tested with the real database security rules on** (`stranger_reads.log`):
  - A signed-in stranger and a camp parent are refused everything: the tables, the Billing reads and writes, the new hold functions, `resolve_unconfirmed_autopay`, and `append_camp_payment`.
  - Afterwards the hold was still open, the plan untouched, and no fake payment had been added.
  - No page calls the four functions 277 closed to browsers. Only server functions do, so 277 breaks nothing (`grep` over pages and functions; the only database callers run with the definer's rights).
- **The autopay "held" state:**
  - It can only be answered by a Billing editor of that camp.
  - A second answer (double click, second tab) is refused (`nothing_to_answer`).
  - "Went through" needs a reference.
  - A stale Billing tab can neither bring a hold back nor wipe one: the server's copy always wins (`migrations/269…sql:163-164`).
  - A parent can't replace a plan from Link (`plan_already_exists`).
- **The canteen "held" state:**
  - A browser can't read or change holds.
  - "Nothing went through" releases only holds at least 3 minutes old, and only ones the office was asked about.
- **Browser caching:** each changed file loads from exactly one page, with the new number:
  - `campistry_me.js?v=20260924-19`
  - `campistry_snacks.js?v=20260924-04`
  - `campistry_tax_statement.js?v=20260924-04`

  There is no service worker.
- **Leftovers:** no secrets, debug switches or TODOs added. One informative server log line.
- **Every earlier closed billing finding still holds.** 64 earlier probes ran cleanly (see The numbers).
- **Worth knowing, not a bug:**
  - At a camp that has never set up section access, the database treats a **scheduler** as having full Billing access ("legacy full access").
  - They can record payments and answer autopay holds. Charges and refunds stay owner/admin only.
  - If you don't want that, set the scheduler role's access in Staff & Access.

## What I did NOT check (and why)
- **Any real processor.** Stripe, Cardknox and Banquest are modelled. Stripe's key rules come from its documentation (links above). I couldn't open Stripe's own site from my machine.
- **What is deployed.** Migrations 255–277 and the edge functions are not live yet.
- **Five older money functions.**
  - These add canteen money or change saved cards and plans (`credit_canteen_balance_from_stripe` and its twin, `_admin_backfill_saved_payment_methods`, `flag_expiring_cards`).
  - They are callable by any signed-in account in **my** scratch database. That's only because the old migrations that locked them (079, 132, 145, 151, 179, 183) aren't in the test chain.
  - On your live site they should be locked. The read-only check below settles it.
- **A real browser with two office users, and Supabase's real time limit** (TED-123).
- **The office Cardknox/Banquest charge.** It is recorded only by the page's save (the function records nothing). I didn't test closing the tab straight after "Charged".
- **Areas no billing pass has deep-audited yet:**
  - payroll;
  - the POS register's maths;
  - Link photo purchases;
  - staff tips;
  - splitting a family;
  - the bank-email parser/matcher;
  - card-surcharge refund rules.
- **Tax law.** Your accountant should confirm the care-year rule.

## Things only you can check (click-by-click)
1. **Owner steps (still pending):**
   - Supabase → SQL Editor → paste migrations **255 to 277 in order**, each one → Run.
   - Then paste `scripts/verify_identity_chain.sql` → Run. Every row should say "ok".
   - Supabase Dashboard → Edge Functions → deploy each of these:
     - `charge-due-installments`
     - `payments-charge`
     - `stripe-charge`
     - `stripe-webhook`
     - `payments-canteen-refund`
     - `payments-canteen-refund-all`
     - `stripe-canteen-refund`
     - `stripe-canteen-refund-all`
     - the earlier ones from the 9th-pass list: `registration-deposit-checkout`, `canteen-auto-reload`, `cardknox-webhook`, `admin-connect-processor`, `stripe-connect-webhook`, `payments-refund`, `stripe-refund`.
   - Reload Me and Snacks on the office computers.
2. **A read-only safety check (after step 1):**
   - Supabase → SQL Editor → paste and Run:
     ```sql
     SELECT p.oid::regprocedure AS function,
            has_function_privilege('anon', p.oid, 'EXECUTE')          AS anyone_on_the_internet,
            has_function_privilege('authenticated', p.oid, 'EXECUTE') AS any_signed_in_account
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN (
            'credit_canteen_balance_from_stripe', '_credit_canteen_balance_from_stripe__by_name',
            'credit_canteen_balance_from_processor', '_credit_canteen_balance_from_processor__by_name',
            '_admin_backfill_saved_payment_methods', 'flag_expiring_cards',
            'append_camp_payment', 'record_autopay_installment', 'sync_family_ledger_payments',
            'parent_billing_slice', 'reserve_canteen_refund', 'settle_canteen_refund_hold',
            'release_canteen_refund_hold');
     ```
   - **Every value in the last two columns should be `false`.** If any says `true`, send me the list.
3. **Until TED-117 is fixed (Stripe camps):**
   - If a canteen refund or Refund All says "may have gone through", run Refund All again **the same day** (within 24 hours), so Stripe still recognises it.
   - Don't leave it for the next day.
4. **Until TED-116 is fixed (Cardknox/Banquest camps):**
   - If a canteen refund says "may or may not have gone through", **don't reload Snacks**. Press Refund again on the same child for the same amount, and answer the question it asks after checking the Sola/Banquest portal.
   - If Refund All reports "hit an error", write down which children had money before the run and send the list to the builder.
5. **Until TED-120 is fixed:** when Billing asks for the reference of an autopay charge on Stripe, paste the **Payment ID that starts with `pi_`** (Stripe → Payments → open the payment; its ID starts with `pi_`). Never paste one starting `ch_` or `py_`.
6. **Until TED-119 is fixed:** before exporting to QuickBooks/Xero, open Billing → Payments and look for a card payment listed twice for the same family, amount and day: one "Stripe (auto)", one "Credit Card (online)". **Don't delete either in Billing** (the two rows share one ledger entry, and deleting could change the family's balance). Remove the duplicate from the exported file instead, and tell the builder.
7. **Until TED-118 is fixed:** if Charge Card said "may have gone through" earlier today, don't charge that family the same amount again today. Record the second amount by hand, or charge it tomorrow.
8. **For TED-123:** each morning after a due date, open Supabase → Edge Functions → `charge-due-installments` → Logs. Check that the last line of the night's run starts `[autopay] done` and how long the run took. If it's close to the plan's limit (150 s on free, 400 s on paid), tell the builder.
