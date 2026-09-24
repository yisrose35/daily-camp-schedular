# Ted's report: billing (24th pass), 2026-09-24

## Verdict: 🟡 Mostly good, some issues

I re-checked the builder's fixes for last pass's findings (commit `dfddc3b`) on a real
Postgres with the real edge functions. Three are genuinely fixed (TED-207 D7, TED-212,
TED-213). But the headline fix for **disputed Cardknox/Banquest canteen top-ups (TED-211/210)
does not work for the case the finding is actually about** — an *auto-reload* charge that a
parent disputes. It only works for a top-up the parent typed in by hand. The auto-reload one
is stored under a different label in the database, and the new lookup does not look for that
label. The family is not paused, the money is not taken off the wallet, and the same card is
charged again the next night — exactly the behaviour TED-211 described. The new automated
tests pass because they fake the database lookup, so they never touch the mismatch.

## The numbers
Tests run (HEAD `a4546ec`): npm test 3764 · **passed 3750 · failed 14** (real bugs: 0 · out-of-date: 0 · deferred TED-005: 14 · my machine: 0) · test:pg 78/78 · test:keys 42/42 · test:lite 12/12 · test:smoke 34+42 · test:scale 24/24.

All 14 npm-test failures are the auto-scheduler suite (TED-005, deferred by the owner) — unchanged.

## What's wrong (most serious first)

### TED-211 🟠 A disputed Cardknox/Banquest AUTO-RELOAD canteen charge is still ignored
- **What a user would see:** A camp on Cardknox/Sola or Banquest has canteen auto-reload switched on ("when the wallet drops below $5, top it up $20"). The parent disputes one of those $20 auto-charges with their bank. Campistry does nothing: the $20 stays on the child's wallet, auto-reload stays ON, the family is NOT paused, and the very next night the same disputed card is charged another $20. This is the exact scenario the finding was about, and the fix does not cover it. (A top-up the parent typed in by hand *is* handled correctly — see below.)
- **How sure I am:** Confirmed.
- **Proof:** Real byop-dispute-webhook + real canteen-auto-reload on real SQL (`ted/probes/2026-09-24-billing-24/byop24.js` → `byop24.log`): K2 — after the auto-reload charge (ref 7001) is disputed, `family_not_found`, Eli's wallet stays `$20.00`, auto-reload `true`, family pause `none`; next night both the disputed child (Eli) AND his sibling (Ezra) are charged again (`tok_eli sales: …$20, …$20`). Root cause: the auto-reload run stores the top-up with `payload.kind = 'autoreload'` (migration 219 line 345), but the new `_canteen_deposit_of` / `canteen_dispute_family` / 287's patched lookup all filter `kind = 'deposit'` (migration 290 line 51). Isolated in `diag.log` (the stored row is `kind='autoreload'`, `canteen_dispute_family('7001')` → `deposit_not_found`) and `kindtest.log` (a `kind='deposit'` row is found, a `kind='autoreload'` row is not). A hand-typed BYOP top-up (`kind='deposit'`) *is* found with its family (`manual_byop.log`: `familyKey:"elif"`), so the fix is partial.
- **What to ask the builder for:** "Make the canteen-dispute lookup (`_canteen_deposit_of`, migration 290) match auto-reload top-ups too — a disputed row can be `kind='autoreload'` as well as `kind='deposit'` — and add a real-database test that disputes an actual auto-reload charge, not a mocked one."

### TED-210 🟠 The FAMILY pause for a disputed canteen top-up works for Stripe, but not for Cardknox/Banquest auto-reload
- **What a user would see:** When a canteen top-up is disputed, siblings on the same card, and the family's tuition autopay / Charge Card, are all meant to wait. On **Stripe** this now works correctly. On **Cardknox/Banquest** it works only for a hand-typed top-up; for a disputed auto-reload charge the family is never paused (same root cause as TED-211), so a sibling's auto-reload and the family's tuition autopay keep running.
- **How sure I am:** Confirmed (Stripe half works; BYOP auto-reload half does not).
- **Proof:** Stripe verified end to end — `autoreload24.log` A1 (wallet off, card not recharged), A2 (family paused, canteen held), A3 (sibling on the family card held), A5 (won → money back): **0 BAD**. BYOP auto-reload not paused — `byop24.log` K2c (family pause `none`), K2e (sibling Ezra charged again next night).
- **What to ask the builder for:** Same fix as TED-211 — once the lookup matches auto-reload rows, the family-pause path follows.

### TED-214 🟡 The new canteen-dispute tests fake the database, so they miss the bug above
- **What a user would see:** Nothing directly — but this is why TED-211/210 shipped looking "fixed". The new tests in `tests/dispute_pause_everywhere.test.js` assert the webhook *calls* the right database functions with the right arguments, using mocked stand-ins that always return a family. They never run the real `canteen_dispute_family` against a real auto-reload row, so they cannot catch that the real lookup returns "not found".
- **How sure I am:** Confirmed.
- **Proof:** `git show dfddc3b -- tests/dispute_pause_everywhere.test.js` — the TED-210 canteen test overrides `T.rpc.pause_canteen_autoreload_for_dispute` / `canteen_dispute_family` with fakes; my real-DB probe (`byop24.js`) exercising the actual SQL fails where the mocked test passes.
- **What to ask the builder for:** "Add a canteen-dispute test that runs against the real migration chain (like the autoreload/byop probes) so the `kind='autoreload'` vs `'deposit'` mismatch is caught."

### TED-162 🟡 Staff-tip card fee — unchanged, still an open question for the owner
- **What a user would see:** A parent tipping staff by card pays Stripe's fee plus 2% (36% on a $1 tip, ~5% on larger ones), which is outside the camp's normal 3%/no-debit card-fee rules. The maths is correct; whether this fee model is allowed is a card-network question.
- **How sure I am:** Suspected (a policy/rules question, not a code bug).
- **Proof:** `supabase/functions/stripe-connect-tip/index.ts` last changed at `f8c5772` — unchanged this pass (`git log -1`).
- **What to ask the builder for:** Nothing yet — this waits on the owner's question to Stripe (see "Things only you can check").

### TED-005 🟠 14 auto-scheduler tests fail — deferred by the owner
- Still 14 failures at `a4546ec` (`npm_test.log`, all in the `auto scheduler …` suite). Not billing; the owner has deferred this. Noted, not re-litigated.

## What I confirmed is working
- **TED-207 (D7) — "closed: lost" arriving before "created":** Fixed. Resume no longer sticks on "A dispute is still open with the bank." `dispute24.log` D7: Resume → `{"changed":true,"success":true}` (was refused last pass). The whole dispute24 suite: **0 BAD** (D1–D8).
- **TED-212 — ordinary transactions sent to the dispute address:** Fixed. An "Approved" sale, a refund and a void are all logged and ignored (`byop24.log` K1/K1b → HTTP 200 `{"ignored":"not_a_chargeback"}`, no chargeback booked, nobody paused). "Chargeback Reversal" is read as a win and lifts the family pause (`byop24.log` K4b: pause lifted). (K4a — the money returning to the wallet — did NOT happen, but only because the underlying auto-reload top-up was never found; that is the TED-211 bug, not a flaw in the chargeback-classification logic, which is correct.)
- **TED-213 — same-name children:** Fixed. Auto-reload now finds a child's family by camper number, not display name. `autoreload24.log` A4: the Lev family's "Sam #4" is reloaded while another family's paused "Sam #3" is not — **0 BAD**.
- **Test suites:** npm test (billing portions), pg 78/78, keys, lite, smoke, scale all green at `a4546ec`; the migration bundle `APPLY_255_290.sql` is in sync (`range_bundle.test.js` passes) and the CR LF fix (`a4546ec`) did not break the chain (pg 78/78 applies the real chain).

## What I did NOT check (and why)
- **Real Cardknox / Banquest / Stripe dispute webhooks:** nothing is live; all disputes were replayed against the real edge functions on a scratch Postgres. Whether a real Cardknox dispute even reaches this endpoint, and what fields it carries, is still unverified (the code and BYOP_SETUP.md both say so).
- **A real parent login / Link portal, real money, real SMS/email:** not touched; no live processors.
- **Non-billing areas** (scheduler, builders, cloud sync, print): out of scope for this pass.

## Things only you can check (click-by-click)
1. **TED-162 (tip fee) — ask Stripe / your card processor:** "For a tip a parent pays by card to a staff member, I pass Stripe's processing fee plus a 2% platform fee on to the parent, on debit cards too. Is passing this surcharge to the cardholder allowed under the card-network rules in my state?" Their answer decides whether the tip fee stays as is.
2. **After the builder fixes TED-211/210:** on a Cardknox/Sola or Banquest camp, in the processor's dashboard, send a test *chargeback* for an auto-reload charge and confirm in Snacks that the child's wallet drops, auto-reload switches off, and the family is paused. (This is the one path I could only simulate.)
