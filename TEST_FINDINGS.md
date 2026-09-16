# Test findings — Part A, plus camper withdrawal

> **STATUS: all five money defects are FIXED and pushed.** D0 (season rollover),
> D1 (parked-then-re-enrolled), D2 (rescind's audit record), D3 and D4 (the
> canteen) are closed by `campistry_billing_core.js` plus migrations 171–173, and
> each defect's test has been rewritten to assert the fix. The findings below are
> kept as the record of what was wrong and why — read them as history, not as an
> open list. `BILLING_OUTLIVES_ENROLLMENT_DESIGN.md` has the design;
> `tests/billing_core.test.js`, `billing_wiring.test.js` and
> `canteen_identity.test.js` have the proof.
>
> The canteen name-collision case is now closed too: a new camper arriving with a
> closed account's name no longer takes it over. The closed account is moved aside
> to its own key and keeps its money, and its legacy (pre-`camperId`) ledger rows
> are stamped at that moment so the re-key cannot orphan them — safe precisely
> there, because until that instant the name had only ever belonged to one child.
>
> What remains is cosmetic rather than a money risk: `accounts` is still keyed by
> name, so the archived account shows as `"Malky Stein #101"`. Keying the map by
> `camperId` throughout would be tidier, but no money can move between two
> campers any more, which was the actual defect.

Run against `265127c`. Suite after this pass: **1509 tests, 1495 pass, 14 fail** —
the 14 are the pre-existing `tests/auto_full_day.test.js` scheduler failures,
unchanged and unrelated (verified by stashing).

25 new tests added: 7 in `tests/money_parity.test.js` (withdrawal parity) and 18
in the new `tests/withdrawal_lifecycle.test.js`.

---

## Part A — what held

**A3, the entitlement chain: clean.** This was the check most likely to find a
hole, because `camp_state_key_user_allowed()` is redefined five times and each
redefinition has to carry every earlier key forward. Verified by extracting the
`WHEN` arms of the *final* definition (164) rather than trusting string matches:
all seven keys are gated — `campistryMePayroll`, `campistryMeFinance`,
`campistrySnacks`, `campistryHealth`, `campistryShop`, `campistryLuggage`,
`campistryMe`.

The related risk was a later migration adding a permissive `camp_state_kv` policy
without the entitlement check — Postgres OR-combines permissive policies, so one
un-gated policy defeats every other. Checked every `CREATE POLICY` in 157–170:

| Migration | Policies on `camp_state_kv` | Entitlement check |
|---|---|---|
| 157 | 6 | all 6 |
| 158 | 1 | yes |
| 160 | 4 | all 4 |
| 161 | 2 | both |
| 163, 164 | 0 (function only) | n/a |
| 165 | 2 — but on `camp_role_access`, a different table | n/a |

No hole.

**Write gates are correct.** Every key's write gate tests `<> 'none'`, never
`= 'edit'`. This matters more than it looks: `me.finance` is viewOnly and never
resolves to `edit` for *anyone*, including the owner, so an `= 'edit'` write gate
would lock the owner out of their own finance page.

**A2, resolver precedence: correct.** Personal override → personal preset → job
default → `none`. The person's own setting wins, which is what was asked for. The
fall-through to the job default depends on `access_preset_grants` being complete
(every preset naming every capability, so a preset lookup never returns NULL and
silently falls through) — that is already asserted by
`tests/access_registry_sql.test.js:81` and passes.

One design note, not a defect: a person with **any** personal preset never sees
the job default, even for capabilities their preset says nothing about, because
the grants table gives every preset a row for every capability. That is coherent
— their preset *is* their setting — but it means a job default only reaches
people with no preset, or with overrides only.

**A5, lock order: consistent.** `place_shop_order` (122) and `settle_shop_order`
(167) both lock **Shop → Snacks → Me**. 168 and 169 lock `campistryMe` only; 170's
two functions lock one blob each. No cycle, so no deadlock. No lock is held
across a network call — the RPCs are pure SQL, and the one remaining network call
inside a webhook (`vaultCardknoxToken`) sits in a read, not a locked window.

**A4 / withdrawal parity: correct.** See below.

---

## Camper withdrawal — what happens to the money

There are three different ways to take a camper out, and they are not the same
operation:

| | `unenrollCamper()` | `rescindEnrollment()` | `deleteCamper()` |
|---|---|---|---|
| Enrollment | → `'unenrolled'` | → `'withdrawn'` *(see D2)* | deleted |
| Roster entry | kept, `bunk` cleared | deleted | deleted |
| Family record | kept | deleted if no campers left | deleted if no campers left |
| Payments | kept | kept | kept |
| Payment plan | kept | gone with the family | gone with the family |
| Saved card | kept | gone with the family | gone with the family |
| Canteen account | **kept** | deleted by roster sync | deleted by roster sync |
| Reversible | yes, `reenrollCamper()` | no | undo only, same session |

### The balance math is right

All 7 new parity tests pass. Both implementations — `get_my_balance` in SQL and
`buildFamilyLedgers` in the browser — filter on the same two statuses
(`enrolled`, `accepted`), so every other status stops the tuition on both sides
at once. Confirmed for `unenrolled`, `withdrawn`, `declined`, `waitlisted` and
`pending`.

Specifically correct:
- A family who **already paid** goes **negative** — a credit owed — on both
  sides. Neither side clamps to zero, which is right: clamping would hide a
  refund the camp genuinely owes.
- A **Zelle payer** who withdraws is owed the full deposit back on both sides,
  even though the deposit lives in `bank_deposits` rather than the blob.
- Withdrawing **one of two siblings** leaves the other billed in full.
- **Family charges survive** (a bus fee, a late fee). They are charges on the
  family, not the enrollment, so a withdrawal does not forgive them.
- **Autopay stops** for a parked camper — the balance is ≤ 0, so nothing is
  charged.
- **Re-enrolling restores the tuition** exactly.

### Four defects

All four are pinned by passing tests that assert current behaviour, so the suite
stays honest; when one is fixed its test fails and gets rewritten. None loses
money on the day the camper leaves. All four lose money or a record later.

**D1 — Re-enrolling after a parked spell leaves an uncollectable gap.**
`charge-due-installments` marks every instalment that comes *due* while the
balance is ≤ 0 as `'paid'`, with the note "Covered by an earlier payment — not
charged". Correct while the camper is gone. But nothing reopens those instalments
on re-enrolment: `reenrollCamper()` restores the status and stops there.

Worked example (test 4): 6 × $500 plan, paid Jan and Feb, parked 1 Mar,
re-enrolled 1 Jun. March, April and May are each marked paid-not-charged. June
charges $500. **Collected $1500 of $3000. The plan reads fully paid. The family
still owes $1500 and there is no pending instalment left to collect it.** The only
clue an office gets is a note blaming "an earlier payment."

This is the one I would fix first. It is silent, it is money, and a camper
leaving and coming back mid-season is ordinary.

**D2 — A rescinded application is deleted, not kept as "Withdrawn".** The confirm
dialog says: *"The application stays here marked **Withdrawn** for the audit
trail."* It does not. `rescindEnrollment` calls `cascadeCamperDelete` first, which
deletes every enrollment matching the camper name; the `e.status='withdrawn'`
that follows mutates an object already detached from the `enrollments` map, so
`save()` never writes it. The promised audit record does not exist.

A comment inside `cascadeCamperDelete` still describes itself as mirroring
"rescindEnrollment's own cleanup (flip to 'withdrawn' + audit entry)" — so this
looks like a change from flip-to-delete that missed its one caller.

**D3 — A deleted camper's canteen money vanishes with no record.**
`ensureAccountsForRoster()` deletes accounts for anyone no longer in the roster.
The **transactions stay**, so canteen revenue still counts a parent's deposit
while the balance owed back to them simply stops existing. Nothing flags that
money was left on a closed account.

Good news: a *parked* camper keeps their account, because `getCamperList()` reads
every roster entry and does not filter `unenrolled`. There is now a test pinning
that, since adding an `unenrolled` filter there would start deleting parked
campers' canteen balances.

**D4 — A new camper with the same name inherits the old balance.**
`_reconcileBalances()` rebuilds every balance from the transaction ledger, and the
ledger is keyed by **camper name**. So a fresh account for a reused name is
immediately overwritten with the deleted camper's balance. Two unrelated children
called the same thing across two summers is not exotic.

Compounding both: `cloudSaveSnacks` unions accounts cloud-first
(`Object.assign({}, cloud.accounts, data.accounts)`), so the roster sync's delete
never propagates while another device still holds the account. The orphan neither
cleans up nor settles — it flickers depending on which device saved last.

---

## D0 — Season rollover destroys every live payment plan

**This is the most serious finding, and it is not an edge case — it is the
annual reset.** Raised as: *"camp clears house for a new summer but we have
plenty of people who are still on payment plans."*

The reset is a CSV import in **Replace** mode. `importRows()`'s own comment
calls it "the only 'start fresh' action this app has". It wipes four things:

```js
roster={}; structure={}; families={}; bunkAsgn={};
```

`families={}` is the one that costs money. Every payment plan (`f.plans`), every
saved card (`byopCustomerRef`, `stripeCustomerId`, `savedPaymentMethods`) and
every family charge/credit lives **on the family record**.

`enrollments` and `finance.payments` are not wiped.

### What that does to a family mid-plan

| | Before the reset | After |
|---|---|---|
| Payment plan | live | **gone** |
| Saved card | live | **gone** (token orphaned at the processor) |
| Autopay | charging monthly | **silently dead** |
| Parent portal | correct balance | **$0 owed** |
| Camp's Billing | one correct ledger | charge on a synthetic ledger, payments unmatched |
| Payment history | intact | **intact** |

1. **Autopay stops for everyone, silently.** `charge-due-installments` iterates
   `me.families`. There are none, so the loop body never runs — no error, no
   warning, not even a log line. Every remaining instalment is simply never
   collected.
2. **The parent portal reads $0.** `get_my_balance` resolves the family from
   `families`; it is gone.
3. **The camp's books go incoherent rather than empty.** Last season's
   `enrolled` enrollments survive with no camper and no family behind them.
   `buildFamilyLedgers` does not drop them — `_resolveFamilyKeyExact` finds no
   family, so each lands on an ephemeral `pending_<lastname>_<eid>` ledger. The
   payments do **not** follow: matching is
   `(p.familyKey && families[p.familyKey]) ? p.familyKey : _payFamilyByName(p)`,
   and after the wipe neither branch reaches that synthetic key. So the charge
   sits on one ledger and the money shows as unmatched — the family reads as
   owing the entire tuition again.
4. **The season archive does not help.** `archive_camp_season` (migration 088)
   snapshots division, grade, bunk, dob, school, parent name and parent email.
   Nothing financial. It is offered in the same dialog as the wipe, which makes
   it read as "your history is safe."
5. **The warning does not say any of this.** The dialog reads: *"Replace — wipe
   all current campers, divisions, grades, bunks, and families, and start fresh
   from this file. Cannot be undone."* An office reads "families" as contact
   records, not as every payment plan and saved card in the camp.

### The one piece of good news

The payment **history** survives. The wipe also pushes `campistryMe` to the
cloud, and the lite localStorage snapshot has `finance` stripped from it
(`integration_hooks.js:553`) — so a wholesale upsert would have deleted every
payment the camp ever took. It does not, because the sync layer fetch-merges
`campistryMe` (`FETCH_MERGE_KEYS`, shallow spread): branches absent from the
payload are preserved from the cloud value, and `families` is overwritten only
because the wipe sets it explicitly to `{}`. That guard is now pinned by a test,
because if it is ever removed this goes from "plans lost" to "every payment the
camp ever recorded, lost."

### Relationship to D1

D1 (parked camper) loses the instalments that came due during one camper's gap.
D0 loses **the entire remaining plan for every family at once**, as part of a
routine annual operation. Same root cause: money that lives on the family record
has no life independent of enrollment, and nothing reconciles a plan against
what is still actually owed.
---

## Not checked

- **A6, the two UI pages in a browser.** Not done in this pass.
- **A7, the `campistry_me.js` key-split bridge.** Not re-verified here; covered
  by `tests/key_split_payroll_finance.test.js`, which passes.
- Anything requiring the live database or a card processor — Part B.
