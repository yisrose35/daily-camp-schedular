# Camp entitlements — selling part of the product

Design for: *"a camp buys only part of the program — give them Campistry Me, but
only the roster and bunk structure, nothing else."*

Status: **design, not built.** Decisions needed at the end.

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

## 5. Rollout

The order matters more than usual, because the last step is irreversible in the
sense that a mistake locks people out of live data.

**Phase 1 — model, no enforcement.**
Add `camps.entitlements`, the helpers, and return it from `get_my_access`. Have
`resolve()` intersect it — *before* the owner/admin bypass, which is the one
place the current code must change. Menu and panes respect it; data still flows.
Reversible, ships safely, and makes the sale demonstrable.

**Phase 2 — the branch map moves to SQL, RPCs land.**
Define owns/needs per section in SQL. Add `get_camp_state` / `save_camp_state`.
Migrate clients onto them. RLS unchanged, so anything missed still works.

**Phase 3 — close the door.**
Tighten `camp_state_kv` RLS so gated keys are only reachable through the RPCs.
This is the step that makes entitlement real. Do it per key, not all at once,
and only once Phase 2 has run in production long enough to be sure nothing still
reads the table directly.

Doing Phase 3 before Phase 2 breaks every page at once.

---

## 6. Known risks

- **Sections that turn out to be inseparable.** If billing genuinely can't work
  without a near-complete roster, then "roster only" and "billing only" can be
  sold, but the scrub for one of them is mostly theatre. Worth discovering in
  Phase 2, per section, and being honest about in the sales conversation.
- **Service-role callers bypass all of this** — crons and edge functions read
  with the service key and must keep doing so. That is correct (they're trusted)
  but means entitlement is a *user-facing* boundary, not a data-classification
  one.
- **Other clients read the same tables.** `campistry_lite.js` and
  `product_access_guard.js` both read access state directly and already disagree
  with each other (an empty `product_access` means "blocked" in one and
  "unrestricted" in the other). Both need to learn the new layer, or Phase 3
  will lock Lite users out.
- **The existing per-staff layer is still broken in places** (ungated sections,
  grouped members locked out of every product page). Those don't block this
  design, but a camp buying a limited product will meet them.

---

## 7. Decisions needed

1. **Sold per app, per section, or both?** The design assumes both (`"*"` or a
   list). Confirm you want section granularity on day one rather than app-level
   first.
2. **What should a camp see for something it didn't buy** — hidden entirely, or
   visible but locked with an upgrade prompt? This changes the UI work
   substantially and is a commercial decision, not a technical one.
3. **Who sets entitlements?** Assumed: you, via a service-role RPC, not
   self-serve in the camp's dashboard. Confirm.
4. **How far does Phase 3 go?** Locking `campistryMe` is clearly worth it.
   Locking every key is more work for less return. A shortlist beats "all".
5. **Does the entitlement need to be enforced against a camp's own API/exports?**
   Print sheets, reports and CSV exports all run client-side over data the page
   already holds; if they must be gated too, that follows from the scrub, but
   worth stating.
