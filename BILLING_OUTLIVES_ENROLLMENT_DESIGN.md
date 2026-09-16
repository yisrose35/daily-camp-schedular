# Design: a family's billing outlives their enrollment

**Status:** BUILT AND PUSHED. Revision 2 was the design; this is now what the
code does. See the commits from `0be2fc1` onwards, and the STATUS banner in
`TEST_FINDINGS.md`. Kept as the design record — the reasoning is still the
reference for why it is shaped this way.

**Problem owner's words:** *"if a parent owes money, they always need to be able
to access the payment regardless of who they have in camp."*

Revision 2 replaces the payment-plan model rather than patching it, after
looking at how CampMinder actually structures instalments. See
[Why revision 2](#why-revision-2) for what changed and why.

---

## The problem, in one line

Everything about a family's money — the payment plan, the saved card, the charges
and the credits — is stored **as fields on the family record**, and the family
record is deleted by routine roster operations.

That single fact causes every money defect in `TEST_FINDINGS.md`:

| | What triggers it | What is lost |
|---|---|---|
| **D0** | CSV import in Replace mode (the annual reset) | every plan and card in the camp |
| **D1** | Parking a camper and re-enrolling them | the instalments that came due while parked |
| **Delete** | Removing a family's last camper | that family's plan, card, and the debt itself |

There is a **second, independent** defect underneath D1, and it is the one that
makes the whole plan model untrustworthy. It gets its own section below.

---

## Two things that are already right

### 1. Parent portal access already survives (migration 070)

`link_parent_invites` was deliberately split into two independent flags:
`status` (portal access) and `billing_access`. Migration 070's header says
billing access *"defaults to true and is permanent unless a staff member
explicitly closes it"*.

- `revoke_orphaned_parent_invites` — the sweep that fires when a family's last
  active camper goes — sets `status='revoked'` and **does not touch
  `billing_access`**.
- `get_my_balance` admits the caller on `status = 'active' OR billing_access = true`.

**A parent whose child has left already authenticates and already reaches the
balance RPC.** The failure is one step later: `get_my_balance` resolves the
invite's `camper_names` against `families[].camperIds`, and the family record has
been deleted, so `v_famKeys` is empty and the balance reads `$0`.

We do not need to build parent access. We need to stop deleting what it resolves
to.

### 2. A family charge already survives a withdrawal

Both balance implementations bill `f.charges` unconditionally, and bill tuition
only for enrollments in `('enrolled','accepted')`. That asymmetry is deliberate
and already tested (`money_parity.test.js`). Tuition *should* vanish with the
enrollment. A debt should not.

**Converting the outstanding amount into a standing family charge at the moment
of removal** is what makes the debt survive, using machinery that already works
on both sides of the ledger.

---

## The plan model is the real bug

This is what you flagged, and you were right that it is a defect rather than a
consequence to manage.

### What we do now

A plan is a **frozen array of dated instalments, each with a mutable status**:

```js
f.plans = [{ id, autopay: true, installments: [
    { dueDate: '2026-01-01', amount: 500, status: 'pending' }, …
]}]
```

`charge-due-installments` then reconciles that array against a *recomputed*
balance, and **mutates the array based on the comparison**:

```js
if (remainingBalance <= 0.005) {
    inst.status = 'paid';
    inst.note   = 'Covered by an earlier payment — not charged';
}
```

That line conflates **"nothing is owed at this instant"** with **"this
instalment is settled forever."** A *transient* zero balance permanently
destroys an instalment. Nothing ever reopens it. That is D1, and it is also why
my revision-1 design changed autopay's behaviour as a side effect: any design
that makes the balance positive again changes what that line does.

Patching the condition is not enough. The model is wrong: it stores an amount
frozen at plan creation, a status that can be written for reasons other than
payment, and no record of what was actually charged.

### What CampMinder does instead

CampMinder does not store per-instalment statuses to be marked paid. It stores a
**billing preference with an instalment counter**, and derives the amount at
invoice time:

- A preference of, say, monthly × 5.
- Invoicing takes a proportion of the **balance due** — for a 5-instalment plan
  the first invoice "adds 20% of the balance due to *due now*" — and **advances
  the instalment number from 1 to 2**.
- Sending a *statement* does not advance the counter; an *invoice* does.

The load-bearing property: **each instalment's amount is derived from the
balance at the time it is charged, not frozen when the plan was created.** The
counter is the only mutable state, and there is no per-instalment status field to
corrupt.

Every symptom we have disappears from that model for free:

| Situation | Frozen array + status (today) | Derived from balance (CampMinder) |
|---|---|---|
| Camper parked, balance 0 | instalment marked `paid`, **destroyed** | amount computes to 0, nothing charged, nothing destroyed |
| Re-enrolled | nothing pending left to collect — **money lost** | balance is positive again, next instalment collects |
| Parent pays extra early | instalment capped, `scheduledAmount` bolted on to explain it | next instalment is simply smaller. No special case |
| Discount applied late | plan now disagrees with the balance | self-corrects on the next charge |
| Camper withdrawn, debt carried | plan disagrees with the balance | self-corrects |

### The shape

```js
f.plans = [{
    id,
    autopay: true,
    dueDates: ['2026-01-01', '2026-02-01', …],   // WHEN, never how much
    count: 6,
    nextIndex: 0,                                 // the counter — only mutable state
    history: [                                    // append-only, what ACTUALLY happened
        { index: 0, dueDate: '2026-01-01', charged: 500, paymentId: 'auto_pi_1', at: … },
        { index: 1, dueDate: '2026-02-01', charged: 0, reason: 'nothing_owed', at: … },
    ],
}]
```

Amount at charge time:

```
due = round( remainingBalance / (count - nextIndex) )
```

…with the final instalment sweeping the remainder so rounding cannot leave cents
behind.

Two rules make this safe:

1. **Nothing is ever marked paid that was not charged.** `history` records what
   happened, including `charged: 0`. A plan can no longer present as settled
   while money is outstanding.
2. **A plan that runs out of dates with a balance remaining is loudly
   outstanding**, surfaced to the office. Today that case is silently swallowed
   by the `status = 'paid'` write — which is precisely how D1 hides $1,500.

### Migrating existing plans

The one real cost of this change, and it needs care: existing plans carry
`status` fields that are **known to be corrupted** by D1 — instalments marked
`paid` that were never charged.

So the conversion must not trust them:

- `dueDates`, `count` — read straight off the existing `installments[]`.
- `nextIndex` — derived from **dates**: the first instalment whose `dueDate` is
  in the future.
- `history` — reconstructed from **`finance.payments`**, not from the plan.

That last point is the rule: **the payment ledger is append-only and
trustworthy; the plan's statuses are not.** Reconstructing from payments also
surfaces every family D1 has already under-collected, which the office will want
to see as a list before this ships.

---

## The change

### Principle

> A family record is a **billing account**. Roster operations may detach campers
> from it. They may never delete it while it carries money.

### 1. Settle-or-carry at the moment of removal

When `deleteCamper`, `rescindEnrollment` or `unenrollCamper` would leave a family
with no active campers, compute the balance **first**:

- **Balance ≈ 0, no plan, no card, no payments** → delete as today. This keeps
  the Billing-clutter guard that put the deletion there.
- **Balance > 0** → keep the family, and convert what they owe into a charge
  before the enrollments go:
  ```js
  f.charges.push({
      amount: outstanding,
      note: 'Outstanding balance — Malky Stein, Summer 2026',
      date: today,
      carriedFrom: { camper:'Malky Stein', enrollmentIds:[…], reason:'removed' }
  })
  ```
  Mark the family `formerCamper: true`. The plan needs **no** edit — under the
  derived model it simply keeps sizing itself off the balance.
- **Balance < 0** → keep the family, flag a refund owed. Never delete a family
  the camp owes money to.

`carriedFrom` matters: an unexplained line item is how a ledger stops being
trusted.

### 2. Ask about the payment schedule, and guard siblings

Adopted from **CampSite** (a different competitor — not CampMinder), whose
unenroll flow asks the admin *whether to remove the family from the payment
schedules associated with that camper's enrollment*, and **refuses when an
enrolled sibling shares the schedule**.

That maps cleanly: the removal dialog offers "also stop this family's payment
plan", defaulted per the policy decision below, and **never touches a plan when
the family still has another active camper on it**.

### 3. Stop the Replace import wiping families

`importRows(rows,'replace')` clears only families with no financial state. Any
family with a balance, plan, card or payments is preserved with camper links
cleared and `formerCamper: true`. Same predicate as (1) — `familyHasMoney(f)` —
used in both places.

### 4. Billing shows them

A **"Former families"** section, collapsed by default, listing camperless
families with a non-zero balance, plus a "still owes" filter. CampMinder surfaces
this as a Family Balance filter and a warning icon on the camper record; a
balance also blocks moving a camper to Alumni or Staff until it is resolved.

### 5. Warn, don't block, at removal

```
Remove Malky Stein?

⚠ Stein Family owes $1,500.
  This will be kept as an outstanding balance. The parent
  keeps portal access and can still pay it.

  [ ] Also stop this family's payment plan

[Cancel]   [Remove and carry the balance]
```

A hard block gets worked around by wiping the roster instead — same effect, no
warning at all.

---

## The remaining decision: autopay default

Under the derived model this is a clean policy choice rather than a mitigation,
because a former family's plan now collects the *right amount* either way.

| | Keep charging | Pause, parent pays manually |
|---|---|---|
| Collects | reliably, no chasing | only if the parent acts |
| Risk | highest chargeback exposure — auto-charging after a child has left is what generates disputes | office has to chase |

**Recommendation: pause by default**, with the checkbox in (5) and a per-family
un-pause. It matches the goal — *they need to be able to access the payment* —
and makes continuing to collect a deliberate office decision.

---

## What this does NOT do

**It does not move the billing account out of `campistryMe.families` into its own
key.** **16 edge functions** and **12 migrations' RPCs** read or write
`families[...]`. A data move means rewriting all of them with a window where some
are on the old shape and some on the new, across the exact paths that take money.
The `finance.payments` split (158) was one branch with seven writers and still
needed a bridge, a fallback and two follow-up fixes.

Preserving the record achieves "the ledger outlives enrollment" without moving a
byte, and makes a future move easier rather than harder.

---

## Rollout

| # | Change | Where |
|---|---|---|
| 1 | Derived-instalment plan model + reader/writer updates | `campistry_me.js` |
| 2 | Plan conversion, reconstructing history from `finance.payments` | one-off, run once per camp |
| 3 | Under-collection report (who D1 already shorted) | read-only, run **before** 1–2 |
| 4 | `familyHasMoney(f)` predicate | `campistry_me.js` |
| 5 | `cascadeCamperDelete` — preserve + carry the balance | `campistry_me.js` |
| 6 | Replace import — preserve families with money | `campistry_me.js` |
| 7 | Removal dialog + payment-schedule checkbox + sibling guard | `campistry_me.js` |
| 8 | "Former families" section | `campistry_me.js` |
| 9 | Derive the amount; skip `autopayPaused`; write `history` | `charge-due-installments` (single-file Dashboard paste) |

Order matters:

- **(3) first, and read it.** It tells you what D1 has already cost before
  anything changes.
- **(9) before the site.** A camp on the new site with the old edge function is
  the dangerous direction — preserved families, old waiving logic. The reverse is
  harmless.
- (1)+(2) ship together; a half-converted plan is the one state nothing handles.

`get_my_balance`, `revoke_orphaned_parent_invites` and `billing_access` are all
already correct — **no SQL to paste** for the access half. (2) and (3) are the
only new server-side work, and both can be RPCs pasted into the SQL Editor.

## Tests

`tests/withdrawal_lifecycle.test.js` pins today's behaviour with passing tests.
When this lands these flip and get rewritten — that is the signal it worked:

- `CLEARING HOUSE: every payment plan and saved card is destroyed`
- `CLEARING HOUSE: autopay silently stops for everyone`
- `DEFECT: re-enrolling after a parked spell leaves an uncollectable gap`
- `deleting the last camper deletes the family record`
- `a hard delete takes the saved card with it`

New coverage, written **before** the code:

- The derived amount equals `balance / remaining`, and the last instalment
  sweeps the remainder — no cents left behind.
- A parked-then-re-enrolled family collects the **full** amount. This is D1's
  worked example ($1,500 short) as a regression test.
- Nothing is ever recorded as paid that was not charged: for any plan,
  `Σ history[].charged === Σ` matching payments in `finance.payments`.
- A plan whose dates run out with a balance remaining reports outstanding rather
  than complete.
- A re-enrolling family is **not** double-billed by both the carried charge and a
  fresh enrollment — the carried charge must be offset. **This is the trap in
  this design.**
- A zero-balance family is still deleted (no clutter regression); a
  credit-owed family never is.
- The parent portal resolves a `formerCamper` family through `billing_access`.

## Sourcing, honestly

CampMinder's help site is blocked by this environment's egress proxy, so the
CampMinder details above come from search-result summaries, not articles I read
end to end. What is well-grounded: the instalment **counter** advancing on
invoice, invoices taking a proportion of **balance due**, statements not
advancing it, balances and credits attaching to the household and carrying across
enrollments, `Display Financial Data for Previously Enrolled Campers`, and a
balance blocking a move to Alumni/Staff.

What I could **not** confirm for CampMinder specifically: what it does with
*automatic* payments after a withdrawal. That may well be per-camp
configuration rather than a product rule, which is part of why (5) makes it an
explicit choice rather than a default we invent.

The unenroll prompt in (2) is **CampSite's**, not CampMinder's.

## Why revision 2

Revision 1 kept the frozen-instalment model and treated autopay's behaviour
change as a policy question to manage. That was wrong: with a frozen array and a
mutable `status`, *any* change to the balance changes what the waiving line
destroys, so the policy question could never be answered cleanly. Replacing the
model with a derived amount removes the question instead of answering it, and
fixes D1 as a by-product rather than as a separate patch.

## Still open, tracked separately

D2 (rescind deletes the audit record it promises), D3 and D4 (canteen balance
vanishes on delete; a reused name inherits it). D3/D4 are this same principle
applied to `campistrySnacks` and should follow once this shape is proven.
