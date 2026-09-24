# Ted's report: billing, eighth pass (re-check TED-101, 105-108, then a hunt), 2026-09-24

## Verdict: 🟡 Mostly good, some issues

I re-checked the 5 open billing findings from my seventh pass with my own probes, re-ran the seventh-pass probes, and wrote 4 new ones. **4 of the 5 are fixed and I'm closing them:**
- Canteen refunds retried after a lost answer now go out once, on both processors.
- Autopay no longer treats an open deposit question as a dead card.
- A cancelled-and-refunded family is no longer shown money as claimable.
- Record Payment refuses a minus sign.

**Billing is not yet 100%.** Two small things are left, and both need unusual timing or setup:
- **TED-101 (still open):** on a session with no dates, a deposit taken in July or August for next summer still lands on this year's tax statement, with no warning.
- **TED-109 (new):** two refund requests for the same child sent at the same moment can refund twice when the child topped up more than once. This is now possible on Stripe too.

I did not change any code, only reported.

## The numbers
Tests run: 3,623 · Passed: 3,609 · Failed: 14 (real bugs: 14, all the deferred auto-scheduler failures TED-005 · out-of-date tests: 0 · my machine: 0)

- **Unit tests (`npm test`):**
  - 3,451 run, 3,437 passed, 14 failed.
  - All 14 failures are in `auto_full_day.test.js` (TED-005, deferred by you).
  - This matches the builder's figures exactly.
- **Database tests (`npm run test:pg`):** 62 of 62 passed, against 121 migrations.
- **Other suites:** `test:keys` 42/42, `test:lite` 12/12, `test:smoke` 32/32, `test:scale` 24/24.
- **The builder's changed test files, run against the code from before their fix** (66a65df, a scratch copy outside the project, removed afterwards). Every file fails on the old code and passes now, so each one really tests its fix:

  | Test file | Failed on the old code | Now |
  |---|---|---|
  | `autopay_runner` | 2 of 20 | 20/20 |
  | `charges_reach_the_ledger` (Record Payment) | 1 of 21 | 21/21 |
  | `refund_idempotency` | 1 of 14 | 14/14 |
  | `refund_lost_answer` | 4 of 18 | 18/18 |
  | `tax_statement` | 3 of 36 | 36/36 |

  Note: the `refund_idempotency` change only checks the text of a key in the file. The real behaviour is covered by `refund_lost_answer` and by my probe.
- **My proof runs** are in `ted/probes/2026-09-24-billing-8/`:
  - the seventh-pass probes again;
  - 4 new probes: 2 of the real refund/autopay functions, 1 on a scratch database, 1 of the real tax code.

## What's wrong (most serious first)

### TED-109 🟡 (new) Two refund requests for the same child, sent at the same moment, refund twice when the child topped up more than once
- **What a user would see:**
  - The office types $20 in Snacks → Refund and presses Refund. While it says "Refunding…", they retype the amount. Typing in that box turns the button back on. They press Refund again.
  - Both requests carry the same refund key and reach the server almost together.
  - **If the child topped up twice ($50 + $50):** the second request finds the first top-up "taken" and moves on to the second one. The parent gets **$40** back, not $20. This happens on both Stripe and Cardknox/Banquest.
  - **In the other shapes** (one top-up; $10 + $50), no extra money moves, but one of the two answers says **"Refund failed."** even though the refund went through.
  - **This is new for Stripe.** Before this change, the two requests sent Stripe the same key and Stripe merged them into one refund. Cardknox/Banquest could already do this before.
  - The timing is narrow: the second request has to arrive within the first request's first fraction of a second. So this is unlikely, but it is real money.
- **How sure I am:** Confirmed with the real `stripe-canteen-refund` and `payments-canteen-refund`, with the second request run inside the first one's claim step. Whether a real office can hit the timing is Likely, not proven.
- **Proof:**
  - `probes/…-8/canteen_retry_realistic.test.js`, "race" rows:
    - $50 + $50 → Stripe `MONEY MOVED 2: pi_top1 $20, pi_top2 $20`; Cardknox `X1 $20, X2 $20`;
    - one top-up and $10 + $50 → one answer `500 Refund failed.`
  - Cause: when a top-up's claim is already taken, the code skips to the next top-up:
    - Stripe: `if (cl && cl.claimed === false) continue;` (`stripe-canteen-refund/index.ts:262`);
    - Cardknox/Banquest: "already settled, skipping" (`payments-canteen-refund/index.ts:313-316`).
  - Old Stripe code keyed the Stripe call on the same split with no claim (`git show 66a65df:…/stripe-canteen-refund/index.ts:231`), so Stripe itself merged the two.
  - The button comes back on during a refund: `refundAmtChanged` sets `btn.disabled` from the amount alone (`campistry_snacks.js:1894-1900`).
- **What to ask the builder for:** "TED-109: with the page's key, a claim that is already taken must never move on to the next top-up: if it is settled, count its amount toward this refund; if it is not settled, stop and answer 'uncertain' (both stripe-canteen-refund :262 and payments-canteen-refund :313-316). Keep the Snacks Refund button off while a refund is running (refundAmtChanged must not turn it back on). Add a test where a second request with the same key runs between the first request's claims read and its first claim, with top-ups $50+$50, on both processors."

### TED-101 🟡 (narrowed again, still open) A session with no dates: a summer re-enrolment deposit goes on this year's tax statement, silently
- **What a user would see:**
  - **Sessions with dates:** correct.
  - **Sessions without dates, charged September to December:** now counted as next summer, and the statement says it guessed. Good.
  - **Sessions without dates, re-enrolled in July or August for next summer** (common at the end of camp): the statement still puts the deposit on this year's return, with **no warning**. Example: charged and $500 paid on 1 Aug 2026 for "Summer 2027" → the 2026 statement says $500 claimable.
  - **A smaller oddity:** an undated autumn programme ("Fall Sundays", charged in September, held in October) is now moved to the following year. It is flagged with a warning, so the office can see it.
- **How sure I am:** Confirmed with the real tax code and Me's real care-year lookup. I'm not a tax adviser.
- **Proof:**
  - `probes/…-8/tax_edges.js`:
    - case J → `2026: claimable 500`, no warnings;
    - case K → 2026 `prepaid 400`, 2027 `claimable 400`, with the "has no start date" warning.
  - The guess only covers months 9 to 12 (`campistry_tax_statement.js:133-141`).
- **What to ask the builder for:** "TED-101 residue: whenever a charge's session has no start date, always add the 'has no start date, care taken to be in YEAR' warning (not only for Sept–Dec charges), and consider using a 4-digit year in the session name (e.g. 'Summer 2027') before falling back to the charge date. Add the Aug-re-enrolment case to tax_statement.test.js."

## Re-check of last report's findings
| ID | Now | My proof |
|----|-----|----------|
| TED-105 canteen retry refunded twice | **Closed** (new narrow race filed as TED-109) | `probes/…-8/canteen_retry_realistic.test.js` uses a claims table shared by the claim steps and the new "what did this key already do" read. With a lost answer, pressing again with the same key: **1 refund per case** on both processors. <br>• one top-up: 1 refund, both answers "$20" (Cardknox used to answer "Refund failed."). <br>• $50 + $50: 1 refund (Cardknox used to send 2). <br>• $10 + $50: 2 parts totalling $20 (used to be 3 parts, $40). <br>• Answer lost after the card company acted: Stripe asks again with the same key and gets the same refund back; Cardknox stops with "never confirmed". <br>• A declined second part: the retry refunds only the missing $10. <br>Same probe on 66a65df: Cardknox 2 and 3 refunds, Stripe 3 |
| TED-106 deposit hold used the card-decline path | **Closed** | Unchanged `probes/…-7/after_answer_night.test.js`: question answered, old flag left → **1 charge, "charged"** (was 0, `waiting_to_retry`). <br>`probes/…-8/deposit_hold_db.js` (scratch DB, real chain): <br>• an old 3-night flag (attempts 3, escalated, retry 10-01) cleared by the new runner's call → `collectionBlocked` gone, attempts 0; <br>• the new notice inserted on 3 nights → 1 row, nights 2 and 3 refused by the database's one-per-question rule; <br>• `is_money_notice('autopay_blocked')` = true (Billing staff only). <br>The runner no longer calls the decline path for this (`charge-due-installments/index.ts:638-652`), so the 269 wording gap no longer matters |
| TED-107 refunded cancellation shown as claimable | **Closed** | `probes/…-7/tax_care_year.js` case C: 2026 claimable **0** (was 500), no contradicting warning. <br>`probes/…-8/tax_edges.js`: <br>• F (everything refunded in 2026) → 0; <br>• G (800 refunded) → 2200. <br>Cases A, D and E are unchanged and correct: 3000 / 2000+1000 / 2750 |
| TED-108 Record Payment took a minus sign | **Closed** | Unchanged `probes/…-7/negative_payment.test.js`: "-500" → refused ("Enter an amount above zero…"), 0 payment rows, balance 1000 → 1000 (was 1500). <br>Code read: the Finance form refuses ≤ 0 too (`campistry_me.js:16044`; Billing form `:18196`). <br>Other money-in paths: CSV import takes amounts > 0 only (`:16205-16207`); Offline Refund refuses ≤ 0 (`:18675-18676`). <br>The builder's test runs both real save buttons and fails on the old code |
| TED-101 tax year, undated session | **Open**, narrowed | See above: the printed Total now equals the child rows (G: rows 2200 = claimedTotal 2200; `campistry_me.js:18862`). The Aug-re-enrolment case is still wrong and silent |
| TED-005 auto-scheduler | Open, deferred | still 14 failing, not re-investigated |

## What I confirmed is working
- **Every test suite passes except the 14 deferred TED-005 failures.**
- **Each of the builder's 5 changed test files fails on the old code** (table above).
- **Canteen refund retries:** all 14 non-race runs in my probe (7 cases × 2 processors) move the right amount of money exactly once.
- **Autopay:**
  - a family with an open deposit question is skipped with one notice, which only Billing staff can see;
  - once the question is answered, that family is charged that same night.
- **Tax statement:** C, F and G (refunds) and A, D and E (timing) all give the expected figures. The printed Total row equals the child rows.
- **Browser caching:**
  - `campistry_me.js?v=20260924-17` and `campistry_tax_statement.js?v=20260924-02` are on `campistry_me.html:343` and `:243`, the only page that loads them;
  - there is no service worker;
  - the edge functions are not browser-cached.
- **The other session's push (roles and scoping, migration 274):** it changes team roles and scoping. It touches no billing code, money function or billing table. The only mention of billing is one help sentence.

## What I did NOT check (and why)
- **Any real processor.** I never called Stripe, Cardknox or Banquest. Stripe's replay of a repeated key, and Cardknox's refund answers, are modelled.
- **What is deployed:** which migrations are pasted, which function versions are live, and which page version the office computers run.
- **Anything in a real browser.** Specifically:
  - the Snacks refund dialog, including the button turning back on while it runs;
  - the tax statement print.
- **Database security rules (RLS) as a real staff member.** The scratch database runs as a superuser.
- **Team roles (other session).** Picking a custom Role now always gives the person the "manager" account type underneath. I did not check whether that changes who can see Billing. That belongs to an access-control audit, and that area has never been deep-audited.
- **Tax law.** Please have your accountant confirm which year a deposit for next summer belongs to.
- **Areas still never deep-audited:** payroll, POS register maths, Link photo purchases, splitting a family, and the bank-email parser/matcher.

## Things only you can check (click-by-click)
1. **Owner steps from the builder (still pending):**
   - Supabase → SQL Editor → paste migrations 255–273 **in order**, each one → Run.
   - Re-paste 268, 269, 270, 271 and 272 even if you pasted them before.
   - Run `scripts/verify_identity_chain.sql` and check that every row says "ok".
   - Supabase Dashboard → Edge Functions → Deploy each of these:
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
   - If you already deployed `charge-due-installments`, `stripe-canteen-refund` or `payments-canteen-refund`, deploy them again.
   - Reload the office computers.
   - Migration 274 (team scoping) is from the other session, not billing.
2. **Snacks refunds (TED-109):** after pressing Refund, don't touch the amount box or press again until the answer shows. If it shows an error, reload Snacks and look at the child's wallet before trying again.
3. **Tax statements (TED-101):** before printing year-end statements, make sure every session has a start date: Me → Sessions → edit each session → Start date. This matters most for sessions families re-enrolled into during the summer.
