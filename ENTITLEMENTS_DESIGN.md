# Camp entitlements — selling part of the product

Design for: *"a camp buys only part of the program — give them Campistry Me, but
only the roster and bunk structure, nothing else."*

Status: **Phases 1, 2A and 2B shipped.** 2C is a deliberate non-goal (§6);
Phase 3 still to do. Decisions taken are at the end.

---

## 1. Why the existing access system can't do this

There are already two access layers, and neither is the right shape.

| | What it gates | Scope | Enforced where |
|---|---|---|---|
| `camp_users.product_access` | whole apps (`["go","health"]`) | **per staff member** | browser only |
| `access_preset` + `section_access` | sections within an app | **per staff member** | browser only |

Three facts from the access audit make this decisive:

1. **There is no camp-level concept at all.** Everything is per-user. Selling a
   limited product today would mean setting it on every staff member and hoping
   nobody is missed — and a new hire defaults to more than the camp bought.

2. **Owners and admins are never gated.** `campistry_capabilities.js` `resolve()`
   returns full access for them before any other rule, deliberately, so an owner
   can't lock themselves out. The owner is exactly the person a partial purchase
   must limit.

3. **Section access is not enforced anywhere but the browser.** `section_access`
   appears in **zero** RLS policies and in no RPC or edge function. RLS on
   `camp_state_kv` lets any `manager` or `scheduler` read the entire
   `campistryMe` blob — families, payments, payroll, finance — and write it back.

So a camp entitlement has to be a **new, third layer**: camp-scoped, applying to
owners, and enforced on the server. It is a *ceiling*; the existing per-staff
layers keep working underneath it.

---

## 2. The model

```
effective access = camp entitlement  ∩  user product_access  ∩  user section_access
                   (what was bought)    (what this person is allowed)
```

- The entitlement can only ever **remove**. It never grants.
- It applies to **everyone**, owner and admin included.
- Empty/absent entitlement = unrestricted, so every existing camp is unaffected.

Stored on the camp, not the user — that is what lets it cap an owner, and it is
why `set_member_access`'s `cannot_restrict_admin` rule doesn't get in the way.

### Schema

```sql
ALTER TABLE camps
  ADD COLUMN IF NOT EXISTS entitlements jsonb NOT NULL DEFAULT '{}'::jsonb;
```

`{}` means unrestricted. Otherwise, per app, either `"*"` or a list of section
keys from the registry in `campistry_capabilities.js`:

```jsonc
{
  "me":   ["campers", "structure", "bunkbuilder"],  // the roster-only camp
  "flow": "*",                                       // bought Flow outright
  "live": []                                         // explicitly nothing
}
```

An app absent from the object = not bought. `"*"` = the whole app, and stays
correct when new sections are added later. Section keys are exactly the registry
keys (`me.campers`, `me.structure`, …), so there is one vocabulary, not two.

Helpers, so no caller hand-parses the JSON:

```sql
camp_entitled(p_camp_id uuid, p_app text, p_section text) returns boolean
camp_entitled_sections(p_camp_id uuid, p_app text) returns text[]
```

---

## 3. Where enforcement lives — the real decision

Hiding the menu is not enforcement. The question is how a section's **data** is
kept from a camp that didn't buy it.

### Option A — split storage per section

`camp_state_kv` keys become `campistryMe:campers`, `campistryMe:billing`, … and
RLS keys off the section.

- True enforcement, simplest policy.
- Enormous change: every read/write in a 16k-line file, plus a data migration
  splitting every existing blob. High risk of silent data loss.

### Option B — RPC-mediated read/write (recommended)

Keep one blob per app. Replace direct table access with two RPCs:

```sql
get_camp_state(p_camp_id uuid, p_key text) returns jsonb   -- scrubs on the way out
save_camp_state(p_camp_id uuid, p_key text, p_value jsonb) -- merges on the way in
```

- `get_camp_state` removes the JSON branches the caller isn't entitled to
  **before the data leaves the database**. The browser never receives them.
- `save_camp_state` merges: branches the caller can't see are taken from the
  stored row, not from what the client submitted.
- Then tighten RLS on `camp_state_kv` so the gated keys are reachable only
  through these functions.

Option B is the recommendation. It is far less invasive, and the merge on write
**structurally kills the worst bug class we just fixed by hand** — a client that
can't see billing becomes incapable of blanking it, rather than merely
well-behaved. (That bug was live: a staff member without Billing access wiped
every family ledger and all payroll on their first save.)

It needs one new piece of server-side truth: the **branch map**, section →
JSON paths. That mapping exists today only in the browser, as `BRANCHES` in
`campistry_access_sections.js`. It moves into SQL and becomes the single
definition both sides use.

---

## 4. The hard part: sections are not independent

A naive scrub breaks the app. Concretely, in `campistry_me.js`:

- Billing (`buildFamilyLedgers`) reads `enrollments` and `sessions` — both in
  `campistryMe`, both owned by *other* sections.
- The same page loads `roster` from **`app1.camperRoster`** — a different app's
  key entirely.

So "sell Billing" does not mean "ship only the billing branch", and "sell the
roster only" does not mean the roster branch is self-contained.

The branch map therefore needs two relations, not one:

- **owns** — the branches a section is the authority for (what it may write).
- **needs** — the branches it must be able to read to function.

A camp entitled to `me.billing` gets billing's owned branches plus a **read-only**
view of what billing needs. Writes stay restricted to owned branches, so a
read-through can never become a back door.

This has to be derived by walking the real code per section, not guessed. It is
the main body of work in this design, and the main source of "we shipped it and
a page broke" risk.

---

## 5. What the codebase map changed about this plan

Phases 2 and 3 were written before mapping the code. The map contradicts two of
their assumptions, so the plan below replaces them.

**Assumption 1: "migrate the callers onto RPCs."** There are **55 user-session
call sites** on `camp_state_kv` and **55 service-role ones**.
`integration_hooks.js` is a choke point for only about **five** of the 55 user
sites — the other fifty go straight to the table, including a raw REST `fetch`
in a `beforeunload` handler that bypasses supabase-js entirely, and an anonymous
page that upserts the whole `campistryMe` blob. Tightening RLS means finding and
moving all of them; miss one and that feature dies silently in production.

**Assumption 2: "scrub sections out of the blob."** Campistry Me's sections are
not separable, and `save()` writes all three keys (`campStructure`, `app1`,
`campistryMe`) on **every** save from **any** section — there is no per-section
write path at all. Concretely:

- **Billing cannot compute a single number** without `enrollments` **and**
  `sessions` **and** the roster. `sessions` isn't even owned by Me — Dashboard
  writes it.
- **Bunk Builder owns no data.** Placements live on `app1.camperRoster[].bunk`,
  deliberately, so the "bunk structure" half of your roster-only camp writes the
  campers branch.
- **Camp Structure propagates into Flow** — renaming a division rewrites the
  roster in place and pushes into Flow's schedule records.
- **Reports and Analytics fan out over every branch**, including both sensitive
  ones.

So "Me, roster + bunk structure only" is not a clean data boundary. Roster,
structure and bunk builder are one inseparable unit — which is fine, because
that is exactly the bundle being sold. What can't be done is scrubbing *within*
that unit.

### Separability verdict

| Genuinely separable | Entangled — sell as a unit |
|---|---|
| `payroll` (one-way reads from Hiring; only offboarding cross-writes) | `campers` + `structure` + `bunkbuilder` |
| `finance` (own branch, but Billing writes `finance.payments`) | `billing` + `enrollment` + `settings` |
| `printsheets` (owns one array, otherwise a pure reader) | `reports`, `analytics` (read everything) |

---

## 6. Revised plan

Enforce at the level the data is actually stored at — **the key** — instead of
pretending sections are separable inside one blob.

### Phase 2A — per-key entitlement in RLS — **SHIPPED** (migration 157)

Apps that already live in their own `camp_state_kv` key are enforced in the
database now. A camp that didn't buy Health genuinely cannot read or write
`campistryHealth` — owner included, from any client, with or without our
JavaScript. This covers the whole **app-level** half of the sale for real, and
it was a policy change rather than a refactor.

Gated: `campistrySnacks`→snacks, `campistryHealth`→health,
`campistry_notes_v1`→notes, `campistryShop`→snacks.shop,
`campistryLuggage`→go.luggage. Every other key returns true — unknown keys are
not gated, so nothing unnamed can be affected.

Two things the first draft of this phase got wrong, both caught before shipping
and worth remembering for 2B:

1. **Gating the three obvious policies was not enough.** Postgres OR-combines
   permissive policies for the same command, so migration 099's counselor POS
   write on `campistrySnacks` was a hole straight through the snacks gate. All
   **six** policies on `camp_state_kv` now carry the predicate, and the bundle's
   verification query asserts the count is 6 — any future policy added without
   the gate will show up as MISSING rather than silently reopening it.
2. **DELETE needed gating too**, for the camp's benefit rather than ours: an
   owner whose entitlement lapsed could otherwise delete a row they can no
   longer read, destroying data that a restored entitlement would have brought
   straight back. An entitlement is reversible; a delete is not.

`campistryLink` is deliberately **not** gated — parents aren't `camp_users` and
reach the portal by other paths, so gating it risks breaking the portal for a
camp that did buy it, with no matching upside.

Service role still bypasses all of it, which is load-bearing and correct:
canteen-auto-reload, the payment webhooks and the deposit inbox must keep
working on a camp's data regardless of what that camp bought.

### Phase 2B — the two sensitive branches get their own keys — **SHIPPED** (158)

`payroll` and `finance` are the branches actually worth withholding. They now
live in `campistryMePayroll` and `campistryMeFinance`, so Phase 2A's per-key
rule covers them.

**One correction to the plan above, found by mapping the code.** "Move finance"
turned out to mean "move most of finance". `finance.payments` is the family
payment ledger, and it is written by **seven** edge functions doing
read-modify-write on `campistryMe` (`cardknox-webhook`,
`payments-hosted-complete`, `payments-charge-nonce`, `charge-saved-card`,
`charge-due-installments`, `stripe-webhook`, `payments-checkout`) and read by
`get_my_balance` for the parent portal. Every one of those is deployed by
pasting it into the Dashboard one at a time, so moving the path would open a
window where some processors append to the old location and some to the new —
silently losing recorded payments.

So the ledger stays in `campistryMe`, and that is the **right** filing, not a
compromise. `finPayments` is consumed by Billing (record payment, refunds,
family detail), barely by Finance; it is Billing's data that happened to be
stored under `finance`. Nothing server-side touches `payroll` or
`finance.{staff,expenses,budget,integrations}` — verified by grep across
`supabase/functions` and `migrations` — so those moved with **zero** function
redeploys.

**This also fixed a live data-loss bug.** Scrubbing `me.finance` used to delete
`campistryMe.finance` wholesale, ledger included. A user with `finance:none` and
`billing:edit` therefore loaded an *empty* ledger, and recording one payment
wrote it back over every payment the camp had ever taken. Splitting the two
halves apart means the ledger is no longer part of what a finance restriction
scrubs — there is nothing to reconstruct and nothing to get wrong.

Two more things worth carrying into Phase 3:

- **Moving data out of `campistryMe` can silently *grant* access.** A counselor
  cannot read `campistryMe`, so payroll and finance were protected by being
  buried in a key they were denied. The SELECT policy allows a counselor every
  key it does not name, so two brand-new keys are readable by default — the move
  would have handed every counselor in every camp the payroll file, complete
  with pay rates and home addresses. 158 adds both keys to the counselor
  exclusion, and the bundle asserts it. **Any future key split must do this.**
- **Order of operations: deploy the site first, then run the SQL.**
  `campistry_me.js` reads the new key and falls back to the legacy branch, so it
  is correct before and after. The legacy branches are deliberately left in
  place as the rollback copy; 158 ends with the statement that drops them, to be
  run later once you're satisfied.

### Phase 2C — the rest of Me stays a UI boundary, on purpose

`campers`, `structure`, `bunkbuilder`, `billing`, `enrollment`, `reports`,
`analytics` share one blob and genuinely need each other's data. Splitting them
would be a rewrite of the app's core, not an access-control change. They keep
the locked-UI treatment from Phase 1.

Be honest about what that means commercially: a roster-only camp is *shown*
only roster and bunk structure, and a cooperative customer gets exactly the
product they paid for — but a determined staff member could still read the
billing branch out of the blob. For selling plans that is fine. For a hard
confidentiality guarantee it is not, and 2C is where that line sits.

### Phase 3 — close the door, per key, last

Only after 2A/2B, and only for keys whose readers are all accounted for. Do it
one key at a time. `campistryMe` is the hardest (most call sites) and should go
last, if at all.

---

## 7. Known risks

- **Service-role writers race the client.** The payment webhooks and
  `payments-*` functions do whole-blob read-modify-write on `campistryMe` and
  race `executeBatchSync`'s whole-key upsert, last-writer-wins. Any RPC design
  has to fix that rather than relocate it.
- **Anonymous write path.** `campistry_inquiry.html` upserts the whole
  `campistryMe` blob without a session. Worth closing regardless of this work.
- **Cross-app keys.** `campStructure` and `app1.camperRoster` are read by Flow,
  Lite, Snacks, Go, badges and an edge function. Neither can be treated as
  Me-owned by any policy.
- **`settings` isn't in Me.** The registry lists `me.settings`, but the UI lives
  in `dashboard.js`, which writes `campistryMe` directly. `enrollSettings` is
  co-owned by both files on a whole-key upsert.

---

## 8. Decisions taken

1. **Section-level, scoped to Me** — confirmed. In practice that means selling
   the roster/structure/bunk unit, with payroll and finance separable for real
   after 2B.
2. **Locked, not hidden** — confirmed and shipped in Phase 1.
3. **Only we set entitlements** — shipped: `campistry_control.html`, gated on
   the existing `super_admins` allow-list.
4. **How far Phase 3 goes** — proposed above: per key, sensitive keys first,
   `campistryMe` last or never.
5. **Exports** — follows from whatever the data layer allows; no separate
   mechanism.
