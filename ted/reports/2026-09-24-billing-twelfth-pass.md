# Ted's report: billing, twelfth pass (re-check TED-116, 120, 124–128, then a hunt), 2026-09-24

## Verdict: 🔴 Problems found

**Can you be 100% certain billing is right? No, not yet.**

**All seven fixes I re-checked work, and I'm closing them** (TED-116, 120, 124, 125, 126, 127, 128). I proved each one myself. This time I clicked the real Snacks page in a real browser, wired to the real refund functions and a real database:
- **Snacks → Refund All now opens.**
- **Stuck refunds can be settled.** The "waiting for an answer" box appears, with "It went through" and "Nothing went through". Each answer moves the money exactly once.
- **Take Out Cash** now says "Paid out $5.00 cash to Avi Katz" and clears the amount box.
- **A refund Stripe fails later** is now noticed and put back on the family's bill or the child's wallet, once.
- **Another family's payment id**, or a typo, can no longer be recorded as a family's autopay.
- **The setup guide** now has the "JWT verification off" step.

**But the browser run found a serious problem that has been there since yesterday.**
- **Snacks can only refund to a card the top-ups from the last 7 days.** Since Sep 23 the Snacks page only loads a week of each child's history. Both refund buttons decide "how much can go back to the card" from that week alone.
- **So a child who topped up in July shows "$0.00 refundable" in August.** The Refund button is off, and Refund All says "No campers currently have a Stripe-paid balance to refund".
- **At the end of summer, almost nobody can be refunded to their card.**

I also found six smaller problems, most of them around the new "refund failed" handling. I did not change any code. I only reported.

## The numbers
Tests run: 3,765 · Passed: 3,751 · Failed: 14 (real bugs: 14, all of them the deferred auto-scheduler tests, TED-005 · out-of-date tests: 0 · my machine: 0)

| Suite | Run | Passed | Failed |
|---|---|---|---|
| Unit tests (`npm test`) | 3,562 | 3,548 | 14, all in `auto_full_day.test.js` (TED-005, deferred by you) |
| Database tests (`npm run test:pg`) | 67, against 126 migrations | 67 | 0 |
| `test:keys` | 42 | 42 | 0 |
| `test:lite` | 12 | 12 | 0 |
| `test:smoke` | 32 + 26 (the builder's new Snacks browser test) | 58 | 0 |
| `test:scale` | 24 | 24 | 0 |

These match the builder's figures exactly.

**The builder's new tests, run against the code from before the fixes** (`92be06d`, in a scratch copy outside the project, removed afterwards):

| Test | Fails on the old code | Passes now |
|---|---|---|
| `snacks_refund_windows.e2e` (real browser) | stops after 4 of 14: "_stripeRefundCapacity is not defined", "_lbl is not defined" | 26 of 26 |
| `stripe_refund_failed` | 11 of 13 | 13 of 13 |
| `autopay_confirm_stripe` + `autopay_lost_answer` | 11 + 2 = 13 | all |
| `canteen_held_refunds` | 1 (the new TED-127 case) | all |

**Mutation checks** (a copy of today's code with one safety rule removed):
- 278 without its canteen once-only rule → pgtest 278 fails: "a re-sent failure put the money back twice … balance 40".
- 278 without its family once-only rule → fails: "a re-sent family failure … owes -200".
- 279 without its another-family rule → pgtest 279 fails.
- Unchanged → both pass.

So the builder's new tests really do check the fixes. **One gap remains:** the new browser test answers every refund call with a stand-in that changes nothing, and its top-ups are all dated today. That is why TED-130 below went unnoticed.

**Every earlier billing probe, re-run at today's code:** 87 probe files from passes 1 to 11 (`rerun_all_probes.sh`, outputs in `rerun/`).
- **77 ran cleanly.**
- **10 stopped early:**
  - 9 are the same as last time, and already have working replacements.
  - The 10th is my 9th-pass "Refund button pressed twice" probe. It lifts one function out of the page. The success message now calls a page-wide helper my copy didn't have. With that helper supplied (`rerun_9/`) it gives the same result as before: one request per double-click, the same key on a retry.
- **Of the 81 outputs I could compare with last time** (ids and times masked):
  - 78 are identical.
  - 3 differ:
    - one changed as expected: Stripe "it went through" is now checked with Stripe (TED-120);
    - one in timings only;
    - one is the probe above.
- **My six 11th-pass probes against their first outputs:**
  - The autopay chain is identical, and two others differ only in clock times.
  - The other three changed exactly where the fixes are: TED-127's case now right; the wrong-row autopay answers now refused; Refund All now opening.
  - No money moved twice anywhere.

**New probes:** there are 5, in `ted/probes/2026-09-24-billing-12/`.
- `snacks_real_functions.e2e.js`: the **real Snacks page in a real browser**, its refund calls run by the **real** edge functions against the same real database, with a pretend Sola and a pretend Stripe.
- `refund_failed_realdb.js`: the real `stripe-canteen-refund`, `stripe-canteen-refund-all` and `stripe-webhook`, on real SQL. The pretend Stripe now behaves as Stripe documents:
  - a repeated key is answered from memory and marked `Idempotent-Replayed: true`;
  - `GET /refunds/{id}` shows the refund as it is now;
  - a refund can fail days later.
  - My 11th-pass version lacked the first two, which is why its F1/F3 still read wrong at today's code (`rerun11_canteen_stripe_faithful_realdb.log`).
- `autopay_confirm_realdb.js`: the real `stripe-charge` "confirm autopay" check, on real SQL.
- `refail_same_name.js`: a failed refund put back when two children share a name.
- `mutations.log`: the three mutation runs above.

## What's wrong (most serious first)

### TED-130 🔴 Snacks can't refund a card top-up that is more than 7 days old
- **What a user would see:**
  - Avi's parent topped up $20 by card ten days ago. The office opens Snacks → Accounts → **Refund** for Avi. The window says **"Available to refund via Stripe: $0.00 — $90.00 of this balance came from a cash/manual deposit (or a different processor)"**, and the Refund button is greyed out.
  - **Refund All** says **"No campers currently have a Stripe-paid balance to refund."** There is no button.
  - The same happens on Sola and Banquest camps (same code).
  - The server would refund the money: its refund functions read the whole history. But neither button lets the office ask it. **At the end of the season almost every top-up is older than a week, so card refunds of leftover canteen money simply don't happen.** The office's only way out is paying cash by hand.
  - Nothing is lost or paid twice. The refunds just can't be made.
  - **Since Sep 23** (`40fb34d`, migration 245), when the page started loading only a week of history. Before that it had the whole history (`218…sql` returned the document's full list).
- **How sure I am:** Confirmed in a real browser.
- **Proof:**
  - `snacks_real_functions.log`, S3a (top-up dated 2026-09-14):
    - `Avi's Refund window: "Available to refund via Stripe: $0.00$90.00 of this balance came from a cash/manual deposit …" | Refund button disabled: true`
    - `REFUND ALL window: "No campers currently have a Stripe-paid balance to refund." | button null`
    - `what the page loads (get_canteen_accounts, window {"from":"2026-09-17",…}) holds the pi_A top-up: false; the server's refund view … holds it: true`
    - S3b, the same top-up dated today: `"Available to refund via Stripe: $20.00"`, `Refund All ($20.00)`.
  - **Code:**
    - `migrations/245_the_canteen_ledger_is_read_from_its_rows.sql:110` (`v_from := today - 7`);
    - `campistry_snacks.js:1836-1864` (`_onlineDeposits` / `_onlineRefundCapacity` count only `snacks.transactions`);
    - `:1655` (even the one-child refresh keeps only rows inside the window);
    - `:1894` (button off at $0); `:2137` (Refund All hides its button).
- **What to ask the builder for:** "TED-130: Snacks' Refund window and Refund All work out 'refundable to card' from snacks.transactions, which since migration 245 holds only the last 7 days — a top-up older than a week shows $0.00 refundable and both buttons are off. Get the refundable amount per child from the server (canteen_refund_view already has the full history, or a small office RPC that returns it), and add a browser test with a top-up dated 30 days ago."

### TED-129 🟠 After a failed canteen refund is put back, Refund All silently skips that child
- **What a user would see:**
  - Refund All refunds Avi's $20. Days later Stripe fails it (the card account was closed), and Campistry now puts the $20 back on Avi's wallet. Good.
  - The office runs Refund All again. The window promises "1 camper, $20.00 through Stripe". The result is **"Refunded $0.00 across 0 campers."** Nothing is sent, the $20 stays on the wallet, and nothing says why.
  - The child's own **Refund** button does work (a new refund is made). So does paying cash.
  - The office has no reason to try those. The Billing notice says "refund it again (Snacks → Refund)", but only people with Billing access see it.
- **How sure I am:** Confirmed, on the real database and in a real browser.
- **Proof:**
  - `refund_failed_realdb.log`:
    - W1 (failed 3 days later) and W1b (2 hours later) both end with: `Refund All: $0, refunded 0, failed 0, skipped 0 … → money back $0 [re_17 $20 (FAILED)], wallet $20`;
    - W2 (the child's own Refund) → `money back $20 [… re_20 $20], wallet $0`.
  - `snacks_real_functions.log` S3: `result: "Refunded $0.00 across 0 campers." → wallet $90`.
  - **Why:**
    - Refund All names its reservation after the top-up, what is left on it and the amount (`stripe-canteen-refund-all/index.ts:241`). After the put-back those numbers are the same as the first time.
    - The database answers "that reservation already exists and is done" (`migrations/275…sql:131-134`), and Refund All skips the child (`:263`).
    - 278 puts the money back but leaves the old reservation marked done.
- **What to ask the builder for:** "TED-129: after reverse_failed_stripe_refund (278) puts a canteen refund back, the next Refund All reuses the same hold key (scanteen:<pi>:<left>:<amount>), reserve_canteen_refund answers existing/posted, and the child is skipped with 'Refunded $0.00 across 0 campers'. Mark the old hold as reversed in 278 (or put something in the key that changes), so Refund All makes a new refund; test: refund → fail → webhook → Refund All refunds $20 again."

### TED-131 🟠 A failed refund that Campistry had not booked is never flagged, so the money stays in Campistry's Stripe account
- **What a user would see:**
  - On a real camp, a canteen top-up or card payment is paid into the camp's Stripe account through Campistry's account. A refund takes the money back out of the camp's account.
  - When the refund fails, Stripe returns the money to **Campistry's** account, not the camp's. Stripe documents this ([refunds](https://docs.stripe.com/refunds), [Connect refunds](https://docs.stripe.com/connect/marketplace/tasks/refunds-disputes)).
  - The new webhook emails the Campistry office to pass it back, **but only when it finds the refund on Campistry's books.** When it doesn't find it, it only writes a log line. That happens when:
    - the refund's answer had been lost (still "waiting");
    - the refund was made in the Stripe dashboard for money Campistry doesn't track;
    - the child's wallet no longer exists.
  - **The canteen case ends like this:** the look-up later puts the $20 back on the child's wallet. But nobody tells the Campistry office that $20 of the camp's money is sitting in Campistry's Stripe balance. The camp is $20 short until someone happens to notice.
- **How sure I am:**
  - That no alert is sent: Confirmed with the real webhook.
  - What happens to the money: from Stripe's documentation.
  - How often: rare (a lost answer and a later failure together, or a dashboard refund).
- **Proof:**
  - `refund_failed_realdb.log` W3: `webhook HTTP 200 log "[stripe-webhook] refund re_21 failed (camp …) — not on Campistry's books"`, and no email. Compare W1: `email "Stripe alert: a $20.00 refund failed — pass it back to the camp"`.
  - **Code:** `supabase/functions/stripe-webhook/index.ts:816-820` returns before the alert at `:823`. The refund reverses the camp's transfer: `stripe-canteen-refund-all/index.ts:274`, `stripe-refund/index.ts` (`reverse_transfer` for destination charges).
- **What to ask the builder for:** "TED-131: in stripe-webhook handleRefundFailed, send the platform 'pass it back to the camp' alert whenever a failed/canceled refund belongs to a camp — also when reverse_failed_stripe_refund answers refund_not_found / account_not_found — since the money is in the platform balance either way; test W3 (hold still open when refund.failed arrives) expects one alert."

### TED-132 🟡 After a failed tuition refund is put back, Billing can't send it to the card again, though the notice says to
- **What a user would see:**
  - Gold's $500 refund fails. The family's balance goes back to $0 owed, and the Billing notice says **"refund it again from Billing, or ask the family for other bank details."**
  - In Billing → Refund, "Refund to card/bank" offers nothing ("No online charges on record for this family — use Offline Refund instead"). The failed refund still counts against the original payment.
  - Money is right. An Offline Refund (a cheque) works, and since the card account was probably closed, that is likely the right way anyway. But the notice points the office at a button that won't do it.
- **How sure I am:** Confirmed with Billing's real calculation over the real rows.
- **Proof:**
  - `refund_failed_realdb.log` T1b: `Billing → Refund to card/bank can draw on: [nothing]`; the notice text is printed at T1.
  - **Code:** `campistry_me.js:18416` subtracts every refund row, including the one that failed. `migrations/278…sql:205` is the notice.
- **What to ask the builder for:** "TED-132: after 278 puts a failed tuition refund back, either word the notice 'send it by cheque (Billing → Refund → Offline Refund) or ask for other bank details', or let _famRefundableOnlineAll count the refail_ row against the failed refund so the card refund is offered."

### TED-133 🟡 A failed dashboard refund can still be booked as refunded if Stripe's two messages arrive in the wrong order (older Stripe setups only)
- **What a user would see:**
  - A refund made in the Stripe dashboard fails. Stripe sends "refund failed" first, and its earlier "charge refunded" message only arrives later (a retry).
  - On a Stripe webhook set up with an **older API version**, that late message carries the refund as it was ("succeeded"). Campistry books it: the family shows a $200 refund they never got.
  - With the current API version this is handled correctly.
- **How sure I am:** Confirmed in the probe. Unlikely, and only for older webhook setups.
- **Proof:**
  - `refund_failed_realdb.log` T3:
    - `newer API … owes $0`;
    - `older API (the list as it was when the event was made): owes $200 [… refund:200.00/refund]`.
  - **Code:** `stripe-webhook/index.ts:740` trusts the list inside the event.
- **What to ask the builder for:** "TED-133: in handleChargeRefunded, when the charge carries its refunds list, re-check each refund's current status with Stripe (GET /refunds/{id}) before booking it, so a refund that already failed is not booked."

### TED-134 🟡 Staff who aren't the owner/admin are told the wrong reason when a card action is owner-only
- **What a user would see:**
  - **Snacks:** a staff member (not owner/admin) who can manage canteen accounts opens Refund All. The page can't read the camp's processor (owner/admin only), so it now says **"This camp has no card processor connected, so there is nothing to refund to a card. Refund balances by hand (Take Out Cash)."** That is wrong: the camp has Stripe, and only the owner/admin can refund to cards. The staff member may start paying out cash.
  - **Billing:** a manager with Billing edit rights presses "It went through" on a stuck Stripe autopay charge and is told **"Only camp owners/admins can charge a stored card."** Nothing is being charged. "Nothing went through" still works for them.
- **How sure I am:**
  - The Billing message: Confirmed (real `stripe-charge`).
  - The Snacks message: Likely, from the code (I did not sign in as such a staff member).
- **Proof:**
  - `autopay_confirm_realdb.log` A12: `403 {"error":"Only camp owners/admins can charge a stored card."}`, with the hold kept.
  - `migrations/153_stripe_is_not_the_default.sql:76-88` (owner/admin only) → `campistry_snacks.js:1823` (treated as `'none'`) → `:2131-2133` (the message).
- **What to ask the builder for:** "TED-134: when get_camp_payment_processor_status refuses (not owner/admin), Snacks should say 'Only the camp owner or an admin can refund to cards' rather than 'no card processor connected… Take Out Cash'; and stripe-charge's confirmAutopay refusal should say 'Only the camp owner or an admin can confirm a Stripe payment'."

### TED-135 🟡 Refund All's numbers don't match what it does when a refund is still waiting
- **What a user would see:**
  - A $20 Sola refund is waiting for an answer. Refund All's window still says **"Refund All ($25.00)"**. The server would refund only $5, because the waiting $20 is set aside.
  - After the Stripe look-up button settles a waiting refund, the result reads "Refunded $0.00 across 0 campers." It doesn't say the waiting refund was found and recorded (the history does show it).
  - Money is right; the numbers shown aren't.
- **How sure I am:** Confirmed in the browser (the preview). The server side is from code.
- **Proof:**
  - `snacks_real_functions.log` S1: `button: "Refund All ($25.00)"` with a $20 hold open.
  - S4: `result: "Refunded $0.00 across 0 campers." → holds [… posted $20.00]`.
  - **Code:** `campistry_snacks.js:1852-1864` ignores waiting refunds; the server subtracts them (`stripe-canteen-refund-all/index.ts:186-188`).
- **What to ask the builder for:** "TED-135: subtract open holds in _onlineRefundCapacity (the holds list is already fetched), and when Refund All settles waiting refunds say so in the result ('1 waiting refund was found in Stripe and recorded')."

## Re-check of last report's findings
| ID | Now | My proof |
|----|-----|----------|
| TED-124: Refund All did nothing | **Closed** | Real browser + real functions (`snacks_real_functions.log` S1): `Refund All opens with no page error, and lists the waiting $20 with both answers`. S3b: a $20 Stripe Refund All → `"Refunded $20.00 across 1 camper."`, Stripe made `re_1 $20`. S4: wallet $0 with a Stripe refund waiting → button `"Look up the waiting refunds in Stripe"` → the real look-up recorded it (`posted $20.00`, history `re_2`). My unchanged 11th-pass probe now opens it too (`rerun11_snacks_refund_windows.log`: `page errors from the click: [] | Refund All window open: true`). Builder's test fails 4/14 on old code. (New problems in this window → TED-129, 130, 135.) |
| TED-116: no screen to settle a stuck Sola/Banquest refund | **Closed** | Real browser + real `payments-canteen-refund` + real SQL. "It went through" with Sola's real reference RN1 → `holds [posted $20.00], wallet $45` (unchanged, the money was already off), toast `"Recorded — the refund is on the child's history"`, list cleared. "Nothing went through" (another lost refund) → `wallet $70 → $75`, `released $5.00`, toast `"The money is back on the wallet"`. The Refund window's figure after the answer is right ($35). No page errors. |
| TED-125: Take Out Cash gave no confirmation | **Closed** | Real browser: `one $5 payout, "Paid out $5.00 cash to Avi Katz", the box cleared, no page error` (1 cash-out row). |
| TED-126: failed Stripe refunds never noticed; stuck-then-failed canteen refund replayed | **Closed** (new residuals → TED-129, 131, 132, 133) | **(1) Re-sending:** real functions + real SQL + a Stripe model with replay headers (`refund_failed_realdb.log`). F1 (Refund All 1 h later), F2 (25 h), F3 (single, same page key) → `money back $20 [re_1 $20 (FAILED), re_2 $20], wallet $0`, the failed refund not on the history. The same with the replay header removed (the `created` fallback alone). F4 (the re-send itself cut off, then a 3rd press) → `$20 once`. **(2) Webhook:** real `stripe-webhook` → real 278. Canteen: `wallet $20 … refund_failed re_17, notices 1`, re-sent + `charge.refund.updated` → unchanged, one platform email. Tuition (Billing refund): `owes $500 → $0`, one `refail_` row, one notice, re-sent + ledger sync → unchanged. Dashboard refund booked by `charge.refunded`, then failed → `owes 200 → 0`. `charge.refunded` after the failure doesn't re-book (W4). Two children sharing a name → the right wallet each time (`refail_same_name.log`). |
| TED-127: "already refunded" on the first press | **Closed** | `refund_failed_realdb.log` C1: `$30` on the first press → `money back $80 [re_15 $50, re_16 $30], wallet $0` (last time an error). Builder's test fails on old code. |
| TED-120: another family's `pi_` credited twice | **Closed** | Real `stripe-charge` + real SQL (`autopay_confirm_realdb.log`, 13 cases, 0 wrong). Refused, with Gold `owes 1000 | hold KEPT`: Silver's `pi_` (booked or not), a typo (`Stripe has no payment pi_GOLDX`), a failed charge, Gold's May payment, another plan's payment, a $300 payment, another camp's stamp, Stripe down. The right `pi_` → `owes 500 | hold cleared | next due index 1`, whether or not the webhook came first. A second press → "already answered". The browser door now refuses Silver's id (`reference_is_another_payment`) and any Stripe "went through" (`stripe_check_needed`) (`rerun11_autopay_resolve_wrong_row.log`). pgtest 279 fails with the rule removed. (Manager wording → TED-134.) |
| TED-128: guide missing "JWT verification off" | **Closed** | `BILLING_PAYMENTS_SETUP.md` step 2 of the autopay section now says to turn it OFF, and also for `stripe-webhook`. Its event list equals the 13 events the code handles (compared by script). No `supabase` command-line steps are left in that guide. |
| TED-005: auto-scheduler | Open, deferred | Still 14 failing, all in `auto_full_day.test.js`. Not investigated. |

## What I confirmed is working
- **The builder's claims 1–16:** each checked above or here. Claim 3 (the overlay-then-swap) held: no page errors across the whole browser run, including after real answers.
- **Who can reach billing:**
  - My 10th-pass access sweep, re-run: the list of money functions a browser can call is unchanged. Only two stored function texts differ, both expected (`rerun/access_sweep.out.json`).
  - So the new server-only functions (`reverse_failed_stripe_refund`, `resolve_unconfirmed_autopay_checked`, `_record_autopay_answer`) can't be called from a browser. pgtests 278/279 check the same.
  - The stranger/parent read probe prints exactly as last time.
- **What I checked:** the product code at `f3ee2ed`. HEAD is `074c4dc`, which only adds my own unfinished probe files under `ted/`. Another session committed them while I worked; I made no commits.
- **Browser caching:** each changed file loads from exactly one page, with its new number: `campistry_snacks.js?v=20260924-06` (`campistry_snacks.html:581`), `campistry_me.js?v=20260924-21` (`campistry_me.html:343`). No service worker.
- **The check script:** its new 278/279 rows fail on a missing function, on a re-pasted 276 (`resolve_unconfirmed_autopay` without the new check), and on browser access (read in `scripts/verify_identity_chain.sql`). pgtest 278 checks its row says ok.
- **The Billing-only notice list:** 278 keeps all 11 earlier sources and adds `refund_failed`. Nothing was dropped.
- **An old Billing tab can't wipe a put-back:** the family merge keeps every server entry the page lacks (`migrations/272…sql:64-75`).
- **Real canteen top-ups carry the camp's stamp**, which the failed-refund webhook needs to find the camp: Link checkout, auto-reload, saved card.
- **Parents' Link history** shows the put-back line in plain words ("Refund failed at the card company — the money is back on the wallet").
- **Leftovers:** no secrets, debug switches or TODOs added.

## What I did NOT check (and why)
- **Any real processor.** Stripe, Sola and Banquest are modelled, and Stripe's rules come from its documentation (links above).
  - I could not reach docs.stripe.com directly from this machine. The two rules the fixes rely on ("replayed" header; failed refunds return to the platform balance) are from search results quoting Stripe's docs.
- **What is deployed.** Migrations 255–279 and the edge functions are not live yet.
- **A staff member who is not owner/admin, signed in to Snacks** (TED-134's Snacks half is from the code).
- **Whether Resend delivers the platform alert emails.** They are sent from `onboarding@resend.dev`, Resend's test sender, which only delivers to the Resend account's own address. See the steps below.
- **Areas no billing pass has deep-audited yet:**
  - payroll;
  - POS register maths;
  - Link photo purchases;
  - staff tips;
  - splitting a family;
  - the bank-email parser/matcher;
  - card-surcharge refunds.
- **Outside billing:** five other setup guides still give `supabase` command-line steps (`CAMPISTRY_LITE.md`, `NOTIFICATIONS_SETUP.md`, `SCHEDULED_REPORTS_SETUP.md`, `SMS_EMAIL_BROADCAST_SETUP.md`, `TELNYX_NUMBER_PROVISIONING_SETUP.md`). That breaks the project's own rule; worth a separate clean-up.

## Things only you can check (click-by-click)
1. **Owner steps (still pending):**
   - Supabase → SQL Editor → paste migrations **255 to 279 in order**, each one → Run.
   - Then paste `scripts/verify_identity_chain.sql` → Run. Every row should say "ok".
   - Supabase → Edge Functions → deploy each of these:
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
2. **The new Stripe events:**
   - Stripe Dashboard → Developers → Webhooks → your `stripe-webhook` endpoint → **⋯ → Update details** → tick `refund.failed`, `refund.updated`, `charge.refund.updated` (and any of the others in `BILLING_PAYMENTS_SETUP.md` step 5 not yet ticked) → **Update endpoint**.
   - While you're there, note the endpoint's **API version**. If it is older than 2022, tell the builder (TED-133).
3. **The platform alert email:**
   - Supabase → Edge Functions → Secrets: check `RESEND_API_KEY` is set.
   - In Resend, check the account's own email is `campistryoffice@gmail.com`. The sender `onboarding@resend.dev` only delivers there.
   - Without this, "a refund failed — pass it back to the camp" alerts never arrive.
4. **Before going live with canteen card refunds, get TED-130 fixed.**
   - Nothing is live yet, so there is nothing to work around today. Until it is fixed, Snacks can only card-refund top-ups from the last 7 days.
   - Don't try to make up for it by refunding in the Stripe Dashboard and then also paying out in Snacks. It's easy to do both for one child.
5. **Once live, until TED-129 is fixed:** if Billing shows "A canteen refund failed", refund that child with their own **Refund** button, not Refund All.
6. **Once live, until TED-131 is fixed:** once a week, Stripe Dashboard (Campistry's platform account) → Payments → **Refunds** → filter **Failed**. For each failed refund of a camp's payment, transfer the amount back to that camp's connected account.
