# Ted's report: billing, twenty-second pass (re-check TED-200 to TED-204, then a hunt), 2026-09-24

## Verdict: 🟡 Mostly good, some issues

**All five fixes from last pass work, so I'm closing TED-200, 201, 202, 203 and 204.** I proved each one myself, using the real payment functions on a real database and the real Me page in a browser:
- A family whose payment is disputed is now paused whether or not they are on autopay, and whether or not they have a plan.
- The nightly run, Charge Card, Batch Charge and the server all refuse to charge them.
- Resume says how many disputes are still open.
- "Move back to family" no longer bills the family for money a fund already paid.

**Billing is still not 100%.** I found five new problems:
- **Canteen auto-reload (🟠, TED-205).** It keeps charging a card while that card's payment is disputed. This includes the case where the disputed charge was an auto-reload itself: the next day it charges the same card again.
- **Cardknox/Banquest setup guides (🟠, TED-206).** They say the dispute webhook's secret is optional, but the webhook refuses every message without it. A camp set up by following the guides never records a dispute and never pauses the card.
- **Three smaller items (🟡, TED-207 to TED-209).**

I changed no product code.

## The numbers
Tests run: 3,975 · Passed: 3,961 · Failed: 14 (real bugs: 14, all of them the deferred auto-scheduler tests, TED-005 · out-of-date tests: 0 · my machine: 0)

| Suite | Run | Passed | Failed |
|---|---|---|---|
| Unit tests (`npm test`) | 3,744 | 3,730 | 14, all in `auto_full_day.test.js` (TED-005, deferred by you) |
| Database tests (`npm run test:pg`) | 77, against 136 migrations | 77 | 0 |
| `test:keys` | 42 | 42 | 0 |
| `test:lite` | 12 | 12 | 0 |
| `test:smoke` | 34 + 42 | 76 | 0 |
| `test:scale` | 24 | 24 | 0 |

These match the builder's figures exactly.

**Mutation checks** (`mutations.log`, `mutations_ted204.log`). I broke each of this commit's fixes on purpose, one at a time, in a scratch copy outside the project, then removed the copy.
- **16 of 21 were caught.** Everything that moves money is guarded:
  - the family pause and the plan marks;
  - the older single plan;
  - the page-save merge;
  - the nightly run;
  - Charge Card on the server, for both Stripe and Cardknox/Banquest;
  - Cardknox/Banquest pause and lift;
  - "lost" marking;
  - Resume while a dispute is open;
  - the Billing label;
  - Move back.
- **5 missed** (TED-208). In each case my own probes show the product is right today.
- **Last pass's four missed breaks, re-run:** N7, N10 and N13 are now caught. N14 (the checking script's row for the replaced-card fix) is still missed.

**Every earlier probe, re-run at today's code** (`rerun_all22.sh`, compared by `compare_reruns22.sh`):
- **138 non-browser probes.** Every exit code is the same as last pass. 128 logs are identical once ids and times are masked, and 10 differ:
  - **Timings or ids only:** 6.
  - **Access list:** the only change is that Resume now takes a third input ("resume anyway"). It has the same gates as before.
  - **Last pass's `dispute21`:** it now pauses Hazel, Fern and Ash, as the fix should.
  - **`dispute20`:** T8 now reads "a dispute is still open", but only because my old probe doesn't pass the new "lost" step through. With that one step added (`rewired/`), `dispute20` and `dispute21` both give 0 BAD. H4 now answers "A dispute is still open" (1 open), which is correct.
  - **`check_script19`:** it now stops with an error, but only because that probe deletes part of migration 286 by hand, a state no normal paste can create. `check_script22` below checks the paste orders you can actually hit, and all of them work.
- **10 browser probes** (Charge Card, bank debits, surcharge, Finance, payer accounts, Batch Charge). They give the same verdict lines as last pass, except `billing20`: that probe looks for the old words "Autopay paused", which the fix changed on purpose. My new `moveback22` covers the same checks with the new words, and all of them pass. Three screenshots the probes rewrote in older folders were put back; copies are in `rerun_e2e/`.

**New probes this pass** (`ted/probes/2026-09-24-billing-22/`):
- `dispute22`: the real webhook, nightly run and stripe-charge on a real database.
- `moveback22`: the real Me page.
- `autoreload_dispute22`: the real canteen auto-reload plus the real webhook on a real database.
- `byop22`: the real Cardknox/Banquest dispute webhook.
- `check_script22`: your paste orders against a real database.
- Re-runs of last pass's `batch21` and `moveback21`, plus the two mutation scripts.

## What's wrong (most serious first)

### TED-205 🟠 Canteen auto-reload keeps charging a card while its payment is disputed
- **What a user would see:**
  - **A1:** Avi's canteen auto-reload charges his parent's card $20. The parent disputes that $20 with the bank. Campistry correctly takes the $20 off Avi's wallet, which leaves it at $0. That empty wallet is exactly what auto-reload reacts to, so **the next day it charges the same card $20 again**, and again every time it runs low. Nobody is told.
  - **A2:** the Gold family disputes a $1,000 tuition payment. Billing pauses the family, and the office's notice says *"their card will not be charged again — not by autopay, not from Billing"*. A week later, Bea's weekly canteen auto-reload charges that same card $25.
  - Charging a card again while its owner is disputing charges on it is what card networks count against a merchant. A parent who disputes an "unrecognised" automatic charge and then sees another one tends to dispute that too.
- **How sure I am:** Confirmed, with the real functions on a real database.
- **Proof:**
  - `autoreload_dispute22.log` A1: `webhook HTTP 200; Avi's wallet now $0.00` → `next day's run (2026-09-25): Avi $20 → charged` → `cus_avi charged: 2026-09-24 $20, 2026-09-25 $20`.
  - A2: `Gold pause {"disputeIds": ["dp_gold"] …}`, notice text as above, then `a week later (2026-10-01): Bea $25 → charged` → `cus_gold charged: 2026-09-24 $25, 2026-10-01 $25`. The control, Cy, was charged both weeks as expected.
  - Cause: `supabase/functions/canteen-auto-reload/index.ts:516-518` only checks that auto-reload is on and a card is saved. It never looks at the family's dispute pause, and nothing marks the auto-reload when one of its own top-ups is disputed (287 only adjusts the wallet).
- **What to ask the builder for:** "TED-205: canteen auto-reload charges a card while its payment is disputed (ted/probes/2026-09-24-billing-22 autoreload_dispute22 A1/A2). When a top-up is disputed, pause that child's auto-reload until the dispute is settled. Also skip auto-reload for any child whose family has a dispute pause, or whose saved card is the disputed family's card. Tell the parent and the office why, and test it with the real runner."

### TED-206 🟠 Following the Cardknox/Banquest guides, disputes are never recorded and the card is never paused
- **What a user would see:**
  - A camp on Cardknox (Sola) or Banquest is set up exactly as `PROCESSOR_ONBOARDING.md` and `BYOP_SETUP.md` say.
  - `BYOP_SETUP.md` says the secret is **optional**: *"If the processor can't send custom headers, leave it unset."* `PROCESSOR_ONBOARDING.md` doesn't mention it at all.
  - But the function refuses **every** message when that secret is not set. So a parent's chargeback never reaches Campistry:
    - the family's bill still shows the payment as paid;
    - the new dispute pause never happens;
    - autopay and Charge Card keep charging the disputed card.
  - A second, smaller gap: if the database has a hiccup while the chargeback is being posted, the function still answers "OK". The processor never sends it again, and the family is neither charged back nor paused. Stripe disputes answer "try again" in the same situation (TED-187).
- **How sure I am:**
  - The refusal is confirmed.
  - Whether Sola and Banquest can send a custom header at all is unknown. If they can't, this endpoint can never work for them as written.
- **Proof:**
  - `byop22.log` Y1: no secret → `HTTP 503 {"error":"webhook_not_configured"}; posted 0, paused 0`, with the log line "REFUSING ALL REQUESTS: BYOP_DISPUTE_SECRET is not set".
  - Y2: posting fails → `HTTP 200 {"received":true}; paused 0`.
  - Controls Y3 (pause write fails → 500) and Y4 (all good → posted + paused) are fine.
  - Code: `byop-dispute-webhook/index.ts:194-201` refuses without the secret; `:295-299` logs a posting failure and falls through to 200.
  - Docs: `BYOP_SETUP.md:465-468`; `PROCESSOR_ONBOARDING.md:42-47, 69-78` never mention the secret.
  - The refuse-without-secret change was made on 2026-09-17 (`81c6bb3`); the guide text is older (`1f4f833`, 2026-09-16).
- **What to ask the builder for:** "TED-206: the Cardknox/Banquest dispute webhook refuses everything without BYOP_DISPUTE_SECRET, but BYOP_SETUP.md calls it optional and PROCESSOR_ONBOARDING.md never mentions it (byop22 Y1). Fix both guides with click-by-click Dashboard steps (Edge Functions → Secrets, and where to add the header in each processor's dashboard), and say what to do if a processor can't send a header. Also make a database error while posting the chargeback answer 500, so the processor sends it again (byop22 Y2), with a test."

### TED-207 🟡 The office's "Resume" can be undone silently, and a lost dispute can be counted as "still open"
- **What a user would see:**
  - **D6:** Wren's dispute is lost. The office agrees with the family and presses Resume, and the pause comes off. Later, a delayed Stripe message about that same dispute arrives, for example a re-sent funds_withdrawn.
    - The family is paused again, and **no new notice** is sent (the notice for that dispute already exists).
    - Pressing Resume now says **"A dispute is still open with the bank"**, which is false; the office has to use "Resume anyway".
  - **D8:** the office presses "Resume anyway" during an open dispute because it has agreed with the family. When the camp then submits evidence, Stripe's routine "under review" message pauses the family again, also with no new notice.
  - **D7:** if Stripe's "closed: lost" message arrives before its "created" message (created failed first and was re-sent), Resume also calls the lost dispute "still open".
  - Nothing is charged by mistake in any of these. The risk is an office that thinks a family is back on autopay when it isn't, with no message saying why.
- **How sure I am:** Confirmed (real webhook on a real database). How often it happens depends on Stripe's message order and re-sends, so it should be rare, but D8 follows an ordinary sequence.
- **Proof:** `dispute22.log`:
  - D6: `pause after resume: none` → `late funds_withdrawn HTTP 200; pause now {"disputeIds":["dp_w"],"lostIds":[]}; notices 1; Resume again → {"open": 1, "error": "dispute_open" …}`.
  - D8: `resume anyway → {"changed": true…}; pause none; evidence submitted → HTTP 200; pause now {"disputeIds":["dp_m"]…}; notices 1`.
  - D7: `Resume → {"open": 1, "error": "dispute_open" …}`.
  - Cause: `resume_autopay_after_dispute` deletes the whole `disputeHold`, including which disputes were lost. `hold_autopay_for_dispute` (288) remembers only won disputes (`le_cbwon_`), and `note_dispute_lost` ignores a family with no pause.
- **What to ask the builder for:** "TED-207: Resume forgets which disputes were lost or resumed, so a late or routine Stripe message re-pauses the family with no notice, and Resume then calls a lost dispute 'still open' (dispute22 D6/D7/D8). Remember lost disputes, and disputes the office resumed, after Resume (as le_cbwon_ does for wins). Don't re-pause for those. Record a 'lost' that arrives first. If a family is paused again, send a new notice."

### TED-208 🟡 Five new safety rules without a working test
- **What a user would see:** nothing today. These are tests that would catch a future mistake.
- **How sure I am:** Confirmed. In `mutations.log`, each of these breaks passes every test:
  - **P5:** the merge lets a page write its own pause when the server has none.
  - **P10:** stripe-charge charges anyway when it can't read the family records. The test's title claims to cover this, but it never makes the read fail.
  - **P17:** the page always sends "resume anyway".
  - **P18:** the page stops re-asking when the server knows of an open dispute.
  - **P21:** the checking script's new 288 row is switched off.
  - Also, last pass's N14 (the row for the replaced-card fix) is still missed.
- **Proof that the product is right today:**
  - `dispute22` D4: a page cannot invent a pause.
  - `moveback22` B2/B4/B5: the windows, the "Resume anyway" choice and the second question.
  - `check_script22` V1: last pass's 288 → "apply 288 again".
  - P10 was checked by reading the code (`stripe-charge/index.ts:339-343`).
- **What to ask the builder for:** "TED-208: tests miss mutations P5, P10, P17, P18, P21 and N14 (ted/probes/2026-09-24-billing-22/mutations.log, mutations_ted204.log). Test: a page sending a pause the server doesn't have; stripe-charge when camp_families_object errors; the Resume window's p_even_open and its second question; the checking script on a 288 missing note_dispute_lost / the merge patch; and on a flag_plan_collection without v_cb."

### TED-209 🟡 "Move back to family" is offered on a share that's already fully paid, and does nothing
- **What a user would see:** after a Move back, the fund's account shows a new line, "… — the part Scholarship Fund paid $300", with **Move back to family** still offered. Pressing it:
  - the window says "nothing moves to the Pine family — it is paid";
  - the toast says "✓ $0 moved back to Pine's bill";
  - it adds two more lines, including one titled "… the part Scholarship Fund paid — the part Scholarship Fund paid".

  No money moves (Pine still owes $700, fund 300/300). It's a button with nothing behind it that clutters the account.
- **How sure I am:** Confirmed, on the real Me page.
- **Proof:** `moveback22.log` S5: confirm and toast as quoted; account rows afterwards include the doubled title.
- **What to ask the builder for:** "TED-209: don't offer Move back on a share the payer has fully paid (or say plainly there's nothing to move, and add no lines) (moveback22 S5)."

## Re-check of last report's findings
| ID | Now | My proof |
|----|-----|----------|
| TED-200: a hand-paying or no-plan family charged mid-dispute | **Closed** | `dispute22` D1–D3: Hazel (autopay off), Fern (no plan), Ash and Kiwi are each paused on the family with one notice. After autopay is switched on or a plan is added, the night gives all four `held_for_dispute` and only the control, Olive, is charged. The real stripe-charge answers **409** for all four with nothing sent to Stripe, and charges Olive. Real Me page (`rerun21/batch21.log`): Batch Charge lists only Olive and names "Fern, Teal, Hazel"; Charge Card reaches the server 0 times for the three; the rows read "Payment disputed — card not charged". D4: an old computer's save keeps the pause, and a page cannot invent one. Cardknox/Banquest pause and lift are covered by the builder's tests, and my `byop22` Y4 posts and pauses (but see TED-206). |
| TED-201: older single plan not paused | **Closed** | `dispute22` D1: Ash's `plan.collectionBlocked` is a chargeback, and the night gives `Ash:held_for_dispute`. Mutation P3 caught. |
| TED-202: Resume clears a second open dispute | **Closed** (edge cases → TED-207) | `dispute22` D5: A lost → Resume refused with `"open": 1`; B won → pause kept for lost A; Resume then allowed. `rewired/dispute21` H4: refused, 1 open. Real Me page `moveback22` B4: "1 dispute is still open with the bank (the camp lost 1)", Cancel keeps it; B5: a stale page gets a second question from the server's answer, and Cancel keeps the pause. P6/P7/P14 caught. |
| TED-203: Move back after a fund paid | **Closed** (cosmetic leftover → TED-209) | Real Me page `moveback22` S3: "Scholarship Fund has already paid $300 toward it … only the unpaid $500 moves to the Pine family"; toast "$500 moved back … $300 stays on the share"; Pine owes **$700**, fund charged 300 / paid 300; autopay asks **$700** (was $1,000). S6: with two shares and a $500 cheque, $100 kept and $700 moved, which matches where the cheque was placed (Oak $400, Birch $100). P19/P20 caught. |
| TED-204: four untested rules | **Closed** (N14 still untested → TED-208) | N7 and N10 caught against today's tests (`mutations_ted204.log`), N13 caught. |
| TED-162: tip fee | Open, unchanged | `stripe-connect-tip` last changed in `f8c5772`. Still waiting on your question to Stripe. |
| TED-005: auto-scheduler | Open, deferred | Still 14 failing, all in `auto_full_day.test.js`. |

## What I confirmed is working
- **Every claim in the builder's list.** The table above has the proof. Four more notes:
  - The runner checks the family pause before anything else: `index.ts:793`, and `dispute22` D2.
  - stripe-charge answers 503 and charges nothing if it can't read the families: code read at `stripe-charge/index.ts:339-343`, not exercised (TED-208).
  - The version bump is right: `campistry_me.js?v=20260924-32` in `campistry_me.html:343`, the only place the file is loaded.
  - The suite numbers match exactly.
- **A stale office computer that loaded Billing before a dispute:** if it presses Charge Card, the server refuses (409, D3). The page shows "Charge failed: … disputed a payment with their bank … Nothing was charged." and clears its pending charge. This is a code read of `campistry_me.js:20241-20260`, which treats a refusal as a definite no.
- **Migration 288 pasted the ways you might paste it** (`check_script22`, 0 BAD):
  - On a fresh chain, both rows say "ok".
  - Last pass's 288 pasted over today's gives "apply 288 again" with the new wording. Today's 288 on top of it leaves one Resume (3 inputs) and wraps the merge once.
  - Pasting 288 twice more changes nothing.
  - 286, 266 and 269 re-pasted afterwards keep everything ok.
  - 272 re-pasted afterwards removes both pieces. The checking script names 286 and 288, and following its rows (286, then 288) puts both back with no error.
- **Leftovers:** no debug switches, TODOs, secrets or new log noise in the product diff.
- **Your code didn't change under me.** HEAD was `4889ba7` the whole time, and only my `ted/` folder changed.

## What I did NOT check (and why)
- **Any real processor, email or SMS service.** Stripe is modelled on its documented event shapes. Nothing is live.
- **Whether Sola (Cardknox) and Banquest can send the `x-webhook-secret` header, or send dispute notifications at all.** `BYOP_SETUP.md` itself says this is unproven, and their docs are blocked from this machine.
- **The real order and re-sends of Stripe's dispute messages** (this matters for how often TED-207 happens), and newer statuses such as `prevented`.
- **Two office computers with realtime updates.** A stale page is now backed by the server's refusal, so this matters less.
- **Registration "Charge now" for a family that is disputing.** It charges the card the parent gave on the new application, which may be deliberate. It's a question for you, not a finding.
- **Payroll's youth rules, the tax statement's classification rules, and the Link page with a real parent login.**

## Things only you can check (click-by-click)
1. **Owner steps (still pending):**
   - Supabase → **SQL Editor** → paste migrations **255 to 289 in order**, each one → **Run**. If you pasted any earlier 288, paste today's 288 again.
   - Then paste `scripts/verify_identity_chain.sql` → **Run**. Every row should say "ok".
   - 288 must go in before the functions below are deployed.
   - Supabase → **Edge Functions** → open each of `stripe-webhook`, `charge-due-installments`, `stripe-charge`, `payments-charge` and `byop-dispute-webhook` → **Edit** → paste the file `supabase/functions/<name>/index.ts` → **Deploy**.
   - For `stripe-webhook` and `byop-dispute-webhook`: **Settings** → **"Enforce JWT Verification" OFF**. The processors call them without a login.
2. **Cardknox/Banquest disputes (until TED-206 is fixed):**
   - Supabase → **Edge Functions** → **Secrets** → add `BYOP_DISPUTE_SECRET` with a long random value.
   - In the Sola or Banquest dashboard, find where the dispute/chargeback notification is set up, and check whether you can add a custom header named `x-webhook-secret` with that value. If you can't, tell the builder: the endpoint can't work as written.
   - Then send one test dispute from the processor's dashboard. Open Supabase → Edge Functions → `byop-dispute-webhook` → **Logs**. You should **not** see "REFUSING ALL REQUESTS".
3. **Stripe webhook events:** Stripe Dashboard → **Developers → Webhooks** → your Campistry endpoint → **Edit**. Make sure **charge.dispute.created, .updated, .funds_withdrawn and .closed** are ticked, on the main endpoint and on the Connect (tips) endpoint.
4. **Until TED-205 is fixed:** when you get a "payment was disputed" notice, open **Snacks** and switch off auto-reload for that family's children. If the disputed charge was a canteen top-up, switch it off for that child. Leave it off until the dispute is settled.
5. **Ask Stripe support:** *"After a dispute closes, can you send charge.dispute.updated or funds_withdrawn for it again (retries or re-sends)? Which statuses can charge.dispute.updated carry, including 'prevented'?"* Give the answer to the builder (TED-207).
6. **Staff tips (TED-162):** your fee question to Stripe is still open.
