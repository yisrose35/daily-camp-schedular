# Design: a family's billing outlives their enrollment

**Status:** proposal, no code written.
**Problem owner's words:** *"if a parent owes money, they always need to be able
to access the payment regardless of who they have in camp."*

---

## The problem, in one line

Everything about a family's money — the payment plan, the saved card, the
charges and the credits — is stored **as fields on the family record**, and the
family record is deleted by routine roster operations.

That single fact causes every money defect found in `TEST_FINDINGS.md`:

| | What triggers it | What is lost |
|---|---|---|
| **D0** | CSV import in Replace mode (the annual reset) | every plan and card in the camp |
| **D1** | Parking a camper and re-enrolling them | the instalments that came due while parked |
| **Delete** | Removing a family's last camper | that family's plan, card, and the debt itself |

`cascadeCamperDelete` deletes a family once `camperIds` is empty; `importRows`
in Replace mode does `families={}`. Neither asks whether the family still owes
money.

---

## Two things that are already right

This is smaller than it looks, because half the work was done already and the
other half has an existing mechanic to reuse.

### 1. Parent portal access already survives (migration 070)

`link_parent_invites` was deliberately split into two independent flags:
`status` (portal access) and `billing_access`. Migration 070's own header says
billing access *"defaults to true and is permanent unless a staff member
explicitly closes it"*.

- `revoke_orphaned_parent_invites` — the sweep that fires when a family's last
  active camper goes — sets `status='revoked'` and **does not touch
  `billing_access`**.
- `get_my_balance` admits the caller on `status = 'active' OR billing_access = true`.

**So a parent whose child has left still authenticates and still reaches the
balance RPC.** Nothing needs to change here. The failure is one step later:
`get_my_balance` resolves the invite's `camper_names` against
`families[].camperIds`, and the family record has been deleted — so `v_famKeys`
comes back empty and the balance reads `$0`.

We do not need to build parent access. We need to stop deleting the thing it
resolves to.

### 2. A family charge already survives a withdrawal

Both balance implementations bill `f.charges` unconditionally, and only bill
tuition for enrollments in `('enrolled','accepted')`. That asymmetry is already
deliberate and already tested (*"a family charge SURVIVES a withdrawal — it is
not tuition"*, `money_parity.test.js`).

That is the mechanic this design turns on. Tuition is enrollment-derived and
*should* disappear when the enrollment does. A debt should not. **Converting the
outstanding amount into a standing family charge at the moment of removal** is
what makes the debt survive, using machinery that already works on both sides of
the ledger.

---

## The change

### Principle

> A family record is a **billing account**. Roster operations may detach campers
> from it. They may never delete it while it carries money.

### 1. Settle-or-carry at the moment of removal

When `deleteCamper`, `rescindEnrollment` or `unenrollCamper` would leave a
family with no active campers, compute the family's balance **first**:

- **Balance ≈ 0, no plan, no card, no payments** → delete the family as today.
  This is the case `cascadeCamperDelete`'s existing comment is protecting
  against (an empty `$0` card sitting in Billing forever), and it stays.
- **Balance > 0** → keep the family. Convert what they owe into a family charge
  before the enrollments go:
  ```js
  f.charges.push({
      amount: outstanding,
      note: 'Outstanding balance — Malky Stein, Summer 2026',
      date: today,
      carriedFrom: { camper: 'Malky Stein', enrollmentIds: [...], reason: 'removed' }
  })
  ```
  Then clear the plan's remaining instalments (the debt now lives in one place,
  not two) and mark the family `formerCamper: true`.
- **Balance < 0 (a credit is owed)** → keep the family, flag it as owing a
  refund. Never delete a family the camp owes money to.

`carriedFrom` matters: without it the charge is an unexplained line item, which
is how a ledger stops being trusted.

### 2. Stop the Replace import wiping families

`importRows(rows, 'replace')` keeps `families={}` only for families with no
financial state. Any family with a balance, a plan, a card or payments is
preserved with its camper links cleared and `formerCamper: true`.

This is the same rule as (1), applied in bulk — which is the point. One
predicate, `familyHasMoney(f)`, used by both.

### 3. Billing shows them

A **"Former families"** section, collapsed by default, listing camperless
families with a non-zero balance. The existing `pendingEnrollment` synthetic
ledger already proves Billing can render a ledger that is not a normal
enrollment; this is the same idea with a real record behind it.

The camp needs to be able to find these people. CampMinder surfaces exactly this
as a "Family Balance" filter and a warning icon on the camper record.

### 4. Warn, don't block, at removal

Following CampMinder — which holds a camper in Enrollment Management until the
balance is resolved rather than refusing the operation outright:

```
Remove Malky Stein?

⚠ Stein Family owes $1,500.
  This will be kept as an outstanding balance. The parent
  keeps portal access and can still pay it.

[Cancel]   [Remove and carry the balance]
```

A hard block would be worked around by wiping the roster instead, which has the
same effect and no warning at all.

---

## The one open decision: autopay

This is the only part I am not deciding for you, because it is a chargeback
judgement about your camps rather than a correctness question.

Once the family record survives, `charge-due-installments` will find it — it has
`plans` and `cardOnFile`, so **it would keep charging the card of a family whose
child has left**, unless told not to.

Note the interaction with D1: if we carry the debt as a family *charge* (step 1)
the balance stays positive, so autopay would no longer waive the instalments —
it would genuinely keep collecting. That is a real behaviour change, not a
no-op.

| | Keep charging | Pause, parent pays manually |
|---|---|---|
| Collects | reliably, no chasing | only if the parent acts |
| Risk | highest chargeback exposure — auto-charging a card after a child has left is what generates disputes | office has to chase |
| Parent experience | may be surprised | in control |

**My recommendation: pause.** Set `f.autopayPaused = true` alongside
`formerCamper`, have `charge-due-installments` skip a paused family, and leave
the balance fully payable from the portal ("Pay now", or resume the plan). It
matches the stated goal — *they need to be able to access the payment* — and a
camp that wants to keep collecting can un-pause per family, which is a one-click
office decision rather than a silent default.

---

## What this does NOT do

Worth being explicit, because the obvious bigger version of this change is a
trap.

**It does not move the billing account out of `campistryMe.families` into its
own key.** That was the first thing I proposed, and the codebase argues against
it: **16 edge functions** and **12 migrations' RPCs** read or write
`families[...]`. A data move means rewriting all of them, with a window where
some are on the old shape and some on the new — across the exact code paths that
take money. The `finance.payments` split (migration 158) was one branch with
seven writers and it still needed a bridge, a fallback and two follow-up fixes.

The goal is *"the ledger outlives enrollment"*, and preserving the record
achieves that without moving a byte. A future move stays possible and becomes
easier once roster operations no longer delete the record.

---

## Rollout

Almost all client-side. **No new migration is required.**

| # | Change | Where |
|---|---|---|
| 1 | `familyHasMoney(f)` predicate | `campistry_me.js` |
| 2 | `cascadeCamperDelete` — preserve + carry the balance | `campistry_me.js` |
| 3 | Replace import — preserve families with money | `campistry_me.js` |
| 4 | Removal dialog warning | `campistry_me.js` |
| 5 | "Former families" section in Billing | `campistry_me.js` |
| 6 | Skip `autopayPaused` families | `charge-due-installments` (single-file Dashboard paste) |

Order: ship 1–5 together (they are one behaviour), then 6. A camp on the old
site with the new edge function is fine — `autopayPaused` simply never appears.
A camp on the new site with the old edge function is the risky direction: it
would preserve families *and* keep charging them. **So deploy the edge function
first**, or ship 6 in the same release.

No SQL to paste. `get_my_balance`, `revoke_orphaned_parent_invites` and the
`billing_access` flag are all already correct.

## Tests

`tests/withdrawal_lifecycle.test.js` already pins the current behaviour with
passing tests. When this lands, these flip and get rewritten — that is the
signal the change worked:

- `CLEARING HOUSE: every payment plan and saved card is destroyed`
- `CLEARING HOUSE: autopay silently stops for everyone`
- `deleting the last camper deletes the family record`
- `a hard delete takes the saved card with it`

New coverage needed: the balance carries as a charge with `carriedFrom`; a
zero-balance family is still deleted (no clutter regression); a credit-owed
family is never deleted; the parent portal resolves a `formerCamper` family
through `billing_access`; a re-enrolling family does not get double-billed by
both the carried charge and a fresh enrollment.

That last one is the trap in this design and deserves a test written before the
code: the carried charge must be **removed or offset** when the family enrols
again, or they pay last summer's tuition twice.

## Still open, tracked separately

D2 (rescind deletes the audit record it promises), D3 and D4 (canteen balance
vanishes on delete, and a reused name inherits it) are not addressed here. D3/D4
are the same principle applied to `campistrySnacks` and should follow once this
shape is proven.
