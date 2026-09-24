# Ted's report: billing, twenty-third pass (re-check TED-205 to TED-209, then a hunt), 2026-09-24

## Verdict: 🟡 Mostly good, some issues

**Four of last pass's five findings are fixed. I'm closing TED-205, 206, 208 and 209.** TED-207 is mostly fixed; one case is left. I checked each fix myself, running the real payment functions on a real database and the real Me page in a browser:
- A disputed canteen top-up now switches that child's auto-reload off, and the next day nothing is charged.
- A family paused for a tuition dispute no longer has its child's canteen auto-reload charged.
- The Cardknox/Banquest setup guides now say the dispute secret is required. The secret can also go on the web address.
- The office's Resume is no longer undone by a late message from Stripe.
- "Move back to family" is no longer offered on a share that's already paid.

**Billing is still not 100%.** The biggest remaining risk is on Cardknox/Banquest camps. I found three new 🟠 problems and one new 🟡:
- **TED-212 (🟠):** the Cardknox/Banquest dispute webhook records a chargeback for any message it receives. That includes an ordinary "approved sale" notice: the family is billed again and their card is paused.
- **TED-211 (🟠):** a disputed Cardknox/Banquest canteen top-up is ignored. The money stays on the wallet and auto-reload charges the card again.
- **TED-210 (🟠):** on Stripe, a disputed canteen top-up only stops that one child. A brother or sister on the same card is still charged.
- **TED-213 (🟡):** a child can be wrongly held back because a child in another family has the same name.

I changed no product code.

## The numbers
Tests run: 3,985 · Passed: 3,971 · Failed: 14 (real bugs: 14, all of them the deferred auto-scheduler tests, TED-005 · out-of-date tests: 0 · my machine: 0)

| Suite | Run | Passed | Failed |
|---|---|---|---|
| Unit tests (`npm test`) | 3,753 | 3,739 | 14, all in `auto_full_day.test.js` (TED-005, deferred by you) |
| Database tests (`npm run test:pg`) | 78, against 137 migrations | 78 | 0 |
| `test:keys` | 42 | 42 | 0 |
| `test:lite` | 12 | 12 | 0 |
| `test:smoke` | 34 + 42 | 76 | 0 |
| `test:scale` | 24 | 24 | 0 |

These match the builder's figures exactly.

**Mutation checks** (`mutations.log`). In a scratch copy outside the project, I broke this commit's fixes on purpose, one at a time, and removed the copy afterwards.
- **25 of 29 were caught.**
- **All six of last pass's misses are now caught:** P5, P10, P17, P18, P21 and N14.
- **Four missed** (TED-214). In each case the product is right today (proof below).

**Every earlier probe re-run at today's code** (`rerun_all23.sh`, compared by `compare_reruns23.sh`):
- **142 non-browser probes.** Every exit code is the same as last pass. 133 logs are identical once ids and times are masked, and 9 differ:
  - **Timings, ids or log order only:** 7.
  - **Last pass's `dispute22` and `byop22`:** they now show the fixes.
    - `dispute22`: D6 and D8 are now "ok".
    - `byop22` still reports one BAD, Y1. Y1 checks a camp with no secret, which the guides now correctly say is not allowed.
- **Last pass's `autoreload_dispute22` still shows 2 BAD.** That's my old probe's wiring, not the product. It doesn't connect the two new database calls the fix uses. My rewired copy, `autoreload23`, shows A1 and A2 fixed.
- **12 browser probes.** The results are the same as last pass, with one expected change:
  - `moveback22` can no longer find the Move back button on the paid share, because the fix removed it on purpose. My new `moveback23` checks it properly: 0 BAD.
  - Five screenshots the probes rewrote in older folders were put back. Copies are in `rerun_e2e/screens/`.

## What's wrong (most serious first)

### TED-212 🟠 Cardknox/Banquest: any message to the dispute address is booked as a chargeback, and a reversal is never booked as a win
- **What a user would see:**
  - The Birch family paid $500 by card on a Sola (Cardknox) camp. Sola sends its ordinary "Approved" notice for that sale to the dispute address. Campistry then:
    - books a $500 chargeback, so **Birch owes $1,000 again**;
    - pauses Birch's card, "disputed with the bank";
    - sends the office a dispute notice.
  - The same happens for any message that carries a transaction number: a refund, a void, a status update.
  - Later, when the bank reverses a chargeback in the camp's favour, Sola may word it as "Chargeback Reversal". The code only recognises "reversed", "won", "closed" and similar words, so the reversal is booked as the same chargeback again. **The family stays billed for money the camp got back, and stays paused.**
  - Does Sola actually send those messages to this address? Nobody knows yet.
    - `BYOP_SETUP.md` says Sola's webhook screen "is Cardknox's **transaction** postback and not a dispute feed".
    - `PROCESSOR_ONBOARDING.md` has you set up a "dispute webhook" and a separate "Webhook Settings → Postback URL".
    - If Sola only has the one transaction notice, pointing it at the dispute address books every sale as a chargeback.
- **How sure I am:**
  - What the code does: **Confirmed**, with the real function on a real database.
  - Whether Sola/Banquest send such messages: **Suspected**. It depends on their dashboards, which can't be reached from here.
- **Proof:**
  - `byop23.log` K1: an `xStatus: Approved, xCommand: cc:sale` body gave `HTTP 200; chargeback lines: le_cb_ck_9001 $500; Birch now owes $1000; pause ["ck_9001"]`.
  - K4: `xStatus: Chargeback Reversal` gave `win lines: none; Birch owes $1000; pause ["ck_9001"]`.
  - Code: `byop-dispute-webhook/index.ts:136-140`. Every message not matching `/reversed|won|lost|closed|resolved/` is treated as a new chargeback, and nothing checks that the status is a chargeback.
  - Unchanged since `1f4f833` (2026-09-16).
- **What to ask the builder for:** "TED-212: byop-dispute-webhook treats any message with a transaction number as a chargeback. An 'Approved' cc:sale books $500 and pauses the family, and 'Chargeback Reversal' isn't read as a win (ted/probes/2026-09-24-billing-23 byop23 K1/K4). Only book a chargeback when the status or command says it is one, log and ignore everything else, recognise 'reversal', and make the guides say plainly which Sola/Banquest screen to use (not the transaction postback). Test it with the real function."

### TED-211 🟠 Cardknox/Banquest: a disputed canteen top-up is ignored, and auto-reload charges the card again
- **What a user would see:**
  - On a Sola camp, Eli's auto-reload charges his parent's card $20. The parent disputes it and Sola tells Campistry. Campistry answers "chargeback NOT posted (family_not_found)" and does nothing else:
    - Eli's wallet keeps the $20 the bank has taken back;
    - auto-reload stays on;
    - **the next day it charges the same card $20 again.**
  - This is the Cardknox/Banquest twin of two Stripe problems that are already fixed: TED-181 (a disputed top-up left on the wallet) and TED-205 (auto-reload charging during a dispute).
  - `BILLING_PAYMENTS_SETUP.md` says Cardknox and Banquest disputes "pause the card the same way". For canteen top-ups they don't.
- **How sure I am:** Confirmed, with the real dispute webhook and the real auto-reload run on a real database.
- **Proof:**
  - `byop23.log` K2: `run today: Eli $20 → charged`, then after the dispute: `HTTP 200` and log `chargeback ck_7001 NOT posted (family_not_found)`.
  - Then: `wallet now $20.00; auto-reload: true`, and the next day `Eli $20 → charged`, giving `tok_eli sales: 2026-09-24 $20, 2026-09-25 $20`.
  - Code: `byop-dispute-webhook` only calls `record_chargeback`, which looks for family payments. It never checks canteen top-ups, and it never calls `pause_canteen_autoreload_for_dispute`.
- **What to ask the builder for:** "TED-211: a Cardknox/Banquest dispute of a canteen top-up does nothing: the wallet keeps the money and auto-reload charges the card again (byop23 K2). Give byop-dispute-webhook the same canteen handling stripe-webhook has: take it off the wallet, back on if won, switch the child's auto-reload off. Test with the real function."

### TED-210 🟠 On Stripe, a disputed canteen top-up stops only that child: a brother or sister on the same card is still charged
- **What a user would see:**
  - Dov and Eve Katz both have auto-reload on their parent's card. The parent disputes Dov's $20 top-up. Dov's auto-reload is switched off, which is correct.
  - **A week later, Eve's weekly $25 is charged to that same card** while the bank is still deciding.
  - Tuition works differently. When a tuition payment is disputed, every card of the family is paused (TED-205's fix).
  - After a canteen dispute, the family's tuition autopay and Charge Card also keep charging that card. That is from reading the code: the canteen branch returns before any family pause.
- **How sure I am:**
  - The sibling charge: Confirmed.
  - Tuition autopay and Charge Card: Likely, from reading the code.
- **Proof:**
  - `autoreload23.log` A3: `Dov enabled false — "switched off because a top-up was disputed…"; Eve enabled true`, then `cus_katz charged: 2026-09-24 $20, 2026-09-24 $25, 2026-10-01 $25`.
  - Code: `stripe-webhook/index.ts:1019-1034` pauses one child and `return`s.
  - `canteen-auto-reload/index.ts:508-528` only counts families with a tuition dispute pause.
- **What to ask the builder for:** "TED-210: when a canteen top-up is disputed, only that child's auto-reload stops; a sibling's auto-reload on the same card is charged a week later (autoreload23 A3), and tuition autopay/Charge Card aren't paused either. Treat that card as disputed for the whole family until the dispute is settled (or say plainly in the guide why only the one child), with a real-runner test."

### TED-207 🟡 (still open, smaller) A loss that arrives before the dispute itself still reads as "still open"
- **What a user would see:** the Stripe "closed: lost" message can arrive before "created", for example when the first delivery of "created" failed. In that case Resume still says "A dispute is still open with the bank". The office has to use "Resume anyway". Nothing is charged by mistake.
  - The other two cases from last pass are fixed. D6 (a late message after Resume) and D8 (Stripe's routine "under review" after "Resume anyway") no longer re-pause the family.
- **How sure I am:** Confirmed, with the real webhook on a real database.
- **Proof:** `rerun22/dispute22.log` D7: `pause {"disputeIds":["dp_l"],"lostIds":[]}; Resume → {"open": 1, "error": "dispute_open" …}`.
  - Why: when "lost" comes first, no chargeback has been booked yet, so `resolve_chargeback` answers `chargeback_not_found` with no family (`214_family_writers_row_truth.sql`).
  - So `stripe-webhook` never calls `note_dispute_lost`, and the new "remember the loss" log is never written.
  - The builder's pgtest calls `note_dispute_lost` directly, which is why it passes.
- **What to ask the builder for:** "TED-207 (D7): when 'closed: lost' arrives before 'created', resolve_chargeback finds nothing, so note_dispute_lost is never called and Resume still says 'still open' (rerun22/dispute22 D7). Find the family from the payment (as record_chargeback does) and record the loss, with a test through the real webhook."

### TED-213 🟡 A child with the same name as a child in a paused family is not reloaded
- **What a user would see:** the Roe family, whose tuition is disputed, has "Sam" (roster "Sam #3"). The Lev family has no dispute and a different "Sam" ("Sam #4"). **Lev's Sam's weekly reload is held** with "a payment of this family's is disputed". His wallet stays empty and his parent is never told why.
- **How sure I am:** Confirmed.
- **Proof:**
  - `autoreload23.log` A4: `Sam #4 $25 → held_for_dispute`, `cus_lev charged: 2026-09-24 $25` (the second week is missing).
  - Code: `canteen-auto-reload/index.ts:521,555` compares children by `displayName()`, which removes the " #3" / " #4" that tells them apart.
- **What to ask the builder for:** "TED-213: auto-reload's dispute check matches children by display name, so an unrelated child with the same name is held (autoreload23 A4). Match on the roster name or camper number, not displayName."

### TED-214 🟡 Four new safety rules without a working test
- **What a user would see:** nothing today. These are tests that would catch a future mistake.
- **How sure I am:** Confirmed. In `mutations.log`, each of these breaks passes every test:
  - **Q4:** auto-reload ignores a pause written only on a plan (the older form).
  - **Q10:** the checking script's 290 row stops checking the parent's switch-back-on.
  - **Q14:** the Cardknox/Banquest webhook answers 200 when a call throws.
  - **Q23:** the doubled "the part … paid" title comes back.
- **Proof that the product is right today:**
  - Q23: `moveback23` S5, "no doubled title anywhere".
  - Q4: code read at `canteen-auto-reload/index.ts:517-518`.
  - Q14: code read at `byop-dispute-webhook/index.ts:317-318`.
  - Q10: pgtest 290 passes on the real chain.
- **What to ask the builder for:** "TED-214: tests miss mutations Q4, Q10, Q14, Q23 (ted/probes/2026-09-24-billing-23/mutations.log). Add: a plan-only chargeback mark in the auto-reload runner test; the checking script against a 290 without the set_canteen_auto_reload patch; a thrown rpc in byop-dispute-webhook → 500; and a check that Move back never doubles the title."

## Re-check of last report's findings
| ID | Now | My proof |
|----|-----|----------|
| TED-205: canteen auto-reload charges a disputed card | **Closed** (siblings → TED-210; Cardknox/Banquest → TED-211; same name → TED-213) | `autoreload23` A1: after Avi's dispute, `wallet $0`, `enabled false` with the note Link shows, one notice "Canteen auto-reload switched off — a top-up was disputed"; next day **nothing charged** (`cus_avi: 2026-09-24 $20` only). A2: Gold paused, a week later `Bea $25 → held_for_dispute`, and control Cy is charged both weeks. A5: a won dispute puts the $20 back and auto-reload stays off until the parent switches it on (as designed). Link shows the note (`campistry_link_parent.html:2602-2606`). Mutations Q1–Q3, Q5–Q9 caught. |
| TED-206: Cardknox/Banquest guides vs the secret | **Closed** | Guides: `BYOP_SETUP.md:465-481` and `PROCESSOR_ONBOARDING.md:40-59, 83-93` now say the secret is required, with Dashboard click steps, the header or `&key=` choice, JWT off, and what each log line means. `byop23` K0: right `&key=` → 200, wrong → 401, none → 401. K3: posting error → **500**, close/pause error → 500, unknown payment → 200. Mutations Q11–Q13 caught. (Whether Sola/Banquest can send it at all is still for you to check; see TED-212.) |
| TED-207: Resume forgotten | **Open, narrowed** to D7 (above) | `rerun22/dispute22` D6 ok (late funds_withdrawn after Resume → no pause, Resume not "open"). D8 ok ("Resume anyway" survives "under review"). D7 unchanged. Mutations Q15–Q20 caught. |
| TED-208: test gaps P5, P10, P17, P18, P21, N14 | **Closed** | All six caught now (`mutations.log` top six lines). |
| TED-209: Move back on a paid share | **Closed** | Real Me page (`moveback23` S5): the kept "$300 — the part Scholarship Fund paid" row shows **paid** with only "Cancel share". A stale Move back press toasts "✕ Nothing to move back — Scholarship Fund has paid this share in full" and writes **nothing** (payer ledger byte-identical). Pine still $700, fund 300/300, no doubled title. S3 (a part-paid share) still offers and does Move back correctly. Q21, Q22 caught (Q23 → TED-214). |
| TED-162: tip fee | Open, unchanged | `stripe-connect-tip` last changed in `f8c5772`. Still waiting on your question to Stripe. |
| TED-005: auto-scheduler | Open, deferred | Still 14 failing, all in `auto_full_day.test.js`. |

## What I confirmed is working
- **Every claim in the builder's list**, except the ones named in the findings above:
  - TED-207 is only partly fixed.
  - TED-205's "matched by the family's camperIds" over-matches same-name children (TED-213).
  - The table above has the proof for the rest.
- **The suite numbers match exactly.**
- **Nothing a browser can call changed hands.** The access sweep lists the same functions with the same gates as last pass. Only the bodies of Resume and the parent's auto-reload save changed.
  - The new `pause_canteen_autoreload_for_dispute` can't be called from a browser (`access_sweep23.out.json`; pgtest 290).
- **The version bump is right:** `campistry_me.js?v=20260924-33` in `campistry_me.html:343`, the only place the file is loaded.
- **Leftovers:** no debug switches, TODOs, secrets or new log noise in the product diff (grep of the diff).
- **Migration 290 is in the test chain** (137 migrations). pgtest 290 and the checking script's 290 row pass.
- **Your code didn't change under me.** HEAD was `1b0067b` the whole time, and only my `ted/` folder changed.

## What I did NOT check (and why)
- **Any real processor, email or SMS service.** Stripe, Cardknox and Banquest are modelled on their documented shapes. Nothing is live.
- **What Sola and Banquest actually send to the dispute address**, and in what wording (TED-212). Their dashboards and docs can't be reached from here.
- **The real order and re-sends of Stripe's dispute messages** (how often TED-207 D7 happens).
- **The Link page with a real parent login.** I checked the note text in the page code and the parent's switch-back-on in pgtest 290, but not a real parent session.
- **Payroll's youth rules, the tax statement's classification rules, and staff tips** beyond TED-162.

## Things only you can check (click-by-click)
1. **Owner steps (still pending):**
   - Supabase → **SQL Editor** → paste migrations **255 to 290 in order**, each one → **Run**. If you pasted any earlier 288, paste today's 288 again.
   - Then paste `scripts/verify_identity_chain.sql` → **Run**. Every row should say "ok".
   - 288 and 290 must go in before the functions below are deployed.
   - Supabase → **Edge Functions** → open each of `stripe-webhook`, `charge-due-installments`, `stripe-charge`, `payments-charge`, `canteen-auto-reload` and `byop-dispute-webhook` → **Edit** → paste the file `supabase/functions/<name>/index.ts` → **Deploy**.
   - For `stripe-webhook` and `byop-dispute-webhook`: **Settings** → **"Enforce JWT Verification" OFF**.
2. **Before any Cardknox/Banquest camp goes live (TED-212):**
   - Log in to the camp's Sola dashboard and find the screen where the chargeback/dispute notification is set.
   - Check whether it is **its own screen** or the same "Webhook Settings → Postback URL" screen that `cardknox-webhook` uses. If it's the same screen, **don't point it at `byop-dispute-webhook`**; tell the builder instead.
   - Do the same in Banquest.
   - Ask each processor's support: *"What exact status words does your chargeback notification use, including when a chargeback is reversed in the merchant's favour?"* Give the answer to the builder.
3. **Until TED-210 and TED-211 are fixed:** when you get a "canteen top-up was disputed" notice, or a Cardknox/Banquest chargeback email from the processor, open **Snacks** and switch off auto-reload for **every child in that family**. Leave it off until the dispute is settled.
4. **Stripe webhook events:** Stripe Dashboard → **Developers → Webhooks** → your Campistry endpoint → **Edit**. Make sure **charge.dispute.created, .updated, .funds_withdrawn and .closed** are ticked.
5. **Ask Stripe support:** *"Can charge.dispute.closed ever be delivered before charge.dispute.created for the same dispute?"* Give the answer to the builder (TED-207).
6. **Staff tips (TED-162):** your fee question to Stripe is still open.
