# Test plan — entitlements, per-staff access, and money

Covers everything shipped between commits `ec6be91` and `539a4da`: camp
entitlements enforced in the database, per-staff and per-JOB section access, the
super-admin control hub, the owner's Teams & Access hub, balance parity, the Camp
Shop taking money, and the eight payment edge functions moved off blind blob
writes.

**None of this has been exercised against a live Supabase project or a real card
processor.** The automated tests assert structure and arithmetic — that the SQL
mirrors the JS resolver, that the sums balance, that no function blind-writes a
blob. They cannot prove that a real Zelle payment lands in a real parent's
balance, or that a real counselor is actually blocked from payroll.

---

## Read this before touching anything

Three ways to do real damage while testing:

1. **The access migrations change what your staff can see.** Until now, section
   access was silently granting full access to every ungrouped staff member.
   Anyone you had configured with restrictions has been seeing everything and
   will now be gated. Tell your staff before you run the SQL.
2. **Do not test the entitlement gate against your only owner account.** An
   entitlement set wrong locks that key for everyone including the owner. Use a
   throwaway camp, and know that setting the entitlement back to unrestricted
   undoes it.
3. **Money tests charge real cards.** Use a throwaway camp, a processor test
   card where the processor offers one, and small amounts. Autopay runs against
   *every* camp in the project — do not trigger `charge-due-installments` by
   hand on a project with live camps unless you mean it.

Order: run the SQL → confirm the verification table → Part B.1 (owner not locked
out) before anything else.

---

## Part A — what a Claude Code session can verify on its own

A remote session has the repo, `node`, `python3` with `pglast`, and Chromium +
Playwright preinstalled. It has **no** access to your Supabase project, no
service-role key, and no card processor. So it can verify logic, consistency and
the browser UI against a stubbed backend — not live behaviour.

### A1. The suite, and the 14 that were already red

```
node --test tests/*.test.js
```

Expected: **1491 tests, 1477 pass, 14 fail.** The 14 are all in
`tests/auto_full_day.test.js`, all one symptom (`Main Activity count = 0 (want
exactly 1)` for every bunk), and all fail identically on `main` before any of
this work — verify that claim by stashing, don't take it on trust. Anything
failing *outside* that file is a real regression.

### A2. Does the SQL resolver still match the JS resolver?

`migrations/160` + `165` implement `user_section_level()` in PL/pgSQL as a mirror
of `C.resolve()` in `campistry_capabilities.js`. They are two implementations of
one rule and they will drift.

Re-read both and check every branch agrees, especially:
- the backward-compatibility rule (no preset, no overrides → full access)
- per-person override beats per-JOB default beats preset
- `me.finance` is viewOnly and never resolves to `edit` **for anyone, including
  the owner** — which is why the RLS write gates test `<> 'none'`, never
  `= 'edit'`. If someone "tidies" that to `= 'edit'`, the owner loses write
  access to their own finance page.

`tests/access_registry_sql.test.js` and `role_presets.test.js` cover parts of
this; the question is whether they cover *every* branch. Report gaps.

### A3. Does every gated key survive the next `CREATE OR REPLACE`?

`camp_state_key_user_allowed()` is redefined by 160, 161, 163, 164 and 165 in
turn, and each redefinition must carry forward **every** key the earlier ones
gated. A migration that forgets one silently un-gates it — no error, no failing
test, just a key anyone can read again.

Read the five in order and confirm the final definition gates all of:
`campistryMePayroll`, `campistryMeFinance`, `campistrySnacks`,
`campistryHealth`, `campistryShop`, `campistryLuggage`, `campistryMe`.

Then confirm the same for `camp_state_kv`'s RLS policies: migration 157 asserts
there are exactly **six** and rewrites all six. If a later migration added a
seventh permissive policy without the entitlement check, it is a hole through
the entire gate — Postgres OR-combines permissive policies, so one un-gated
policy defeats the other six.

### A4. Arithmetic, adversarially

`tests/money_parity.test.js` and `canteen_shop_money.test.js` encode the money
rules. Re-derive them from the source rather than trusting the tests:

- `get_my_balance` (migration 166) vs `buildFamilyLedgers` in `campistry_me.js`
  — the parent's number and the camp's number must come out the same for: a
  family that paid by Zelle, a parent with two family records, an enrollment
  with both a flat and a percentage discount, a discount larger than tuition.
- The canteen is event-sourced: `account.balance === Σ transactions`. Find
  anything that writes a balance **without** a matching transaction — the next
  `_reconcileBalances` erases it. `settle_shop_order` (167) is the one to check
  hardest, since it moves money between three blobs.
- `settle_shop_order` must be idempotent by delta. Settling the same order twice
  must not charge twice; editing an order's total must charge the difference.

### A5. Deadlock and lock-order review

Every money RPC takes `FOR UPDATE`, and any two that take the same locks in
opposite orders will deadlock under load. `settle_shop_order` (167) and
`place_shop_order` (122) must both lock **Shop → Snacks → Me**. Check every RPC
in 167–170 for a consistent order, and check nothing holds a lock across an
`await`-equivalent (a network call inside a locked window).

### A6. The two UI pages, against a stubbed Supabase

`campistry_control.html` (super admin) and `campistry_team_access.html` (owner)
are the two new pages. Drive them in Chromium with a stubbed `supabase` client
and a fixture camp. Worth proving:

- **The control matrix reads the right way round.** A ticked box means the camp
  **has** the feature. This was shipped backwards once (`ed67ff1`): `{}` rendered
  as all-unticked, and saving would have written "this camp bought nothing." An
  empty/absent entitlement must render as **unrestricted (ticked)**, and a
  round-trip (load → save → load) must be a no-op.
- **The generated SQL is valid and says what the boxes say.** Feed the
  generator's output to `pglast`. Then flip one box and confirm exactly one
  thing changed in the SQL.
- **The owner's hub only offers what the camp is entitled to.** A section the
  camp does not have must not appear as grantable. Note: `CampistrySections`
  is **not** loaded on either hosting page — an earlier fix here was inert for
  exactly that reason, so verify the entitlement data actually reaches the page
  at runtime rather than assuming the import is there.
- By-JOB and by-person both save, and per-person wins over per-JOB in the UI as
  well as in the resolver.

### A7. `campistry_me.js` key-split bridge

Migration 158 moved `payroll` and `finance` (minus `payments`) out of
`campistryMe` into their own keys. `_preferKey(fresh, legacy)` decides which
wins. Confirm:
- an **empty** new key never beats a **populated** legacy branch
- the `_loadedPayroll` / `_loadedFinance` guards: both keys are stripped from the
  lite localStorage snapshot, so a fresh-load fallback reads them as *absent*,
  which is not the same as *empty*. Treating absent as empty here loses the
  payroll file.
- `families[fk].balance` is **not** the balance — it is clamped with
  `Math.max(0, …)` and knows nothing about bank deposits. Anything treating it
  as authoritative is a bug.

### A8. Report

Write findings to `TEST_FINDINGS.md` — what was checked, what held, what didn't,
and for each failure the smallest reproduction. Do not fix anything in the
scheduler (see Part C).

---

## Part B — what only you can do

### B1. Run the SQL, then check you are not locked out

Supabase Dashboard → SQL Editor → paste all of `migrations/APPLY_BUNDLE.sql`
(safe to re-run). It ends with a verification table. Every row must read `OK`,
in particular:

- `autopay writes the instalment and the payment together`
- `saved-card writes are atomic`
- `every money RPC takes a row lock`
- `atomic payment write path`
- `parent balance counts Zelle/ACH deposits`

**Then, before anything else:** log in as the owner and open Me, Payroll,
Finance, Snacks, Health, Shop, Luggage. All seven must load. If one is empty or
errors, the gate is wrong and nothing else matters.

### B2. Redeploy five edge functions

Dashboard → Edge Functions, paste each single file. All five call RPCs that
`APPLY_BUNDLE.sql` creates, so **run the SQL first**.

| Function | Why |
|---|---|
| `stripe-webhook` | payments + saved cards + canteen auto-reload |
| `cardknox-webhook` | payments + saved cards + canteen auto-reload |
| `payments-hosted-complete` | Banquest hosted-page completion |
| `charge-due-installments` | the nightly autopay runner |
| `payments-save-method` | BYOP save-a-card |

Three more were already redeployed earlier in this work and need nothing:
`charge-saved-card`, `payments-charge-nonce`, `payments-checkout`.

A function you have not redeployed keeps working exactly as before — the SQL is
additive — so you can do these one at a time.

### B3. Access, with real accounts

You need at least: an owner, a counselor, and one staff member with a restrictive
preset. For each, log in and confirm:

| Who | Must be able to | Must NOT be able to |
|---|---|---|
| Owner | every section of their camp | — |
| Counselor | the POS register | payroll, finance |
| Nurse preset | health | payroll, finance, snacks ledger |
| Scheduler preset | their assigned divisions only | payroll, finance |
| **Unconfigured** staff (no preset, no overrides) | **everything** | — |

That last row is the backward-compatibility rule and the easiest to break. A
camp that never configured access must see no change at all.

Then the per-JOB feature: set access for the *job* "scheduler", confirm it
applies to a scheduler who has no personal setting, then give one scheduler a
personal override and confirm **the person's own setting wins**.

Blocked must mean blocked at the **API**, not just hidden in the UI — the point
of moving this into RLS was that a restricted person with a valid session could
previously read the data straight out of the API. Worth one check with the
browser devtools network tab: hit the gated key directly and confirm it comes
back empty rather than populated.

### B4. Money, on a throwaway camp

Each row: do the thing, then check **both** the camp's Billing page and the
parent's portal, and confirm they agree.

1. **Zelle/ACH deposit** captured from a bank alert → parent's balance drops by
   that amount. This is the bug `166` fixed: deposits counted for the camp and
   for autopay but not for the parent, so a family that paid by bank transfer
   read as settled in Billing and permanently owing in the portal. Expect some
   real parent balances to **drop** when you run the SQL — that is the fix, not
   a new discount.
2. **Parent with two family records** → portal shows the sum of both, not one.
3. **Camp adds a charge** → parent sees it. **Camp adds a credit** → parent's
   balance drops.
4. **Parent pays online** → camp's Billing drops by exactly that.
5. **Parent pays the full balance early, then autopay runs** → remaining
   instalments are marked *covered*, not charged. Then **parent overpays a
   little** → the next instalment is capped at what is still owed, and the plan
   row explains the gap rather than just showing a smaller number.
6. **Shop order → charge to canteen account** → canteen balance drops by exactly
   the order total **and** a matching transaction appears in the ledger.
   Balance-without-transaction gets erased on the next reconcile.
7. **Shop order → charge to camp bill** → family balance rises by the total.
8. **Edit a settled shop order's total** → only the difference is charged.
   **Re-save the same order** → nothing is charged twice.
9. **Refunds**, every rail you use: tuition, canteen, shop. Balance moves the
   right way, by the right amount, once.
10. **Save a card** → it appears in Link → Cards. **Save a second card** → it
    appears, and does **not** steal the default from the first. **Save the same
    card twice** → one entry, not two.
11. **Canteen auto-reload card save** → the card lands, and the parent's own
    trigger config (enabled, thresholds, schedule) is untouched.

Note on 6–8: orders placed **before** the SQL are not back-charged. If you have
unpaid shop orders on the books, re-save them to post the charge.

### B5. Concurrency — the actual point of 167–170

This is the one class of bug the automated tests can only model, not prove. Each
migration's footer has a copy-pasteable two-tab recipe; run them against a
throwaway camp:

- `168` — two `append_camp_payment` calls in two SQL Editor tabs at once. **Both
  payments must survive.** Then the same payment twice → the second returns
  `alreadyRecorded: true` and appends nothing.
- `169` — the same autopay charge twice → first `patched: true,
  alreadyRecorded: false`, second `patched: false, alreadyRecorded: true`. The
  instalment and the payment must always move together, never one without the
  other.
- `170` — the same card twice → one entry, `isFirst` true then false. A second,
  *different* card must not overwrite the legacy `stripePaymentMethodId` /
  `byopCustomerRef` that autopay charges.
- `167` — a shop settlement while a POS sale is ringing up. No transaction may
  vanish; the canteen balance is recomputed from that ledger, so a lost
  transaction is lost money.

### B6. The real-world one

Let the nightly autopay run on its own schedule once, with the office actively
saving the Me page while it runs. Before this work, that combination lost data
in both directions: the office's save discarded, or the run's own charges
vanished (cards charged, no record). Afterwards, both must survive. Check
`finance.payments` against the processor's own dashboard for that night —
migration 162's `reconcile_processor_charges` report exists to find exactly the
charges that used to go missing, so run it and expect zero new ones.

---

## Part C — known-open, don't let the test session "fix" these

### C1. Two non-money blind writes (known, pinned)

`telnyx-sms-webhook` and `send-scheduled-reports` still write a whole
`campistryMe` blob. Both are pinned in `ALLOWED_BLIND_WRITERS` in
`tests/billing_races.test.js` with a reason. Worst cases are: continuing to text
someone who sent STOP, and a duplicate emailed report. Each needs one narrow
RPC. Not money, not urgent, but real.

### C2. The 14 red scheduler tests

All in `tests/auto_full_day.test.js`, all one symptom, all pre-existing on
`main`. **Investigate, report, do not fix as part of this pass** — it is the
scheduling core, it is unrelated to everything above, and it deserves its own
session.

### C3. A doc that is wrong, and may explain C2

`CLAUDE.md` states the two-engine architecture was retired and that
`scheduler_core_solver_v2.js` and `solver_version_switch.js` are "GONE." Both
files are still in the repo, and `flow.html:692-693` still loads them.
`solver_version_switch.js` wraps `window.runAutoScheduler` on every Flow page
load; it defaults to v1, so behaviour should be v1 — but any camp with
`globalSettings.app1.solverVersion` set to `'v2'` (or `'v3'` — there is a branch
for that too) is still running the retired engine. Check this **before** C2; it
is cheap and it could be the whole explanation.
