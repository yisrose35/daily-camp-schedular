# The browser end-to-end harness

    npm run test:smoke

Drives the repo's own pages in Chromium against a **throwaway Postgres carrying
the real migrations**. Nothing about the app is mocked: the HTML, the JavaScript
and the SQL are the shipped ones, and every row a page reads back was computed by
the same SQL that runs in production.

## Why it exists

Every other test here checks one layer. The `*.test.js` files read source text;
`scripts/pgtests/*.sql` call one SQL function directly. Between them sits the path
nobody covered: a page calls an RPC, the RPC calls another function, that one
writes a table, a trigger fires, and a second page reads the result.

Migration **233** lived in that gap. `settle_shop_order` called a
`camp_family_save` that does not exist, so from the day 215 was applied no Camp
Shop order could reach a camp bill — and the whole suite stayed green, because
each layer was correct on its own.

Its first run found five more, none of which any existing test could see:

| What | Where | Symptom |
|---|---|---|
| `loadData()` and the two row loaders called each other without end | `campistry_me.js` | ~350 `get_camp_payments` + ~350 `get_camp_families` in six seconds, for as long as the tab stayed open |
| Four pages read the roster out of a snapshot that does not contain it | `campistry_snacks.js`, `campistry_snacks_shop.js`, `campistry_health.js`, `campistry_go_luggage.js` | no campers in the canteen, the shop, the medication sheet or the luggage form |
| The shop settled an order the server had not been told about yet | `campistry_snacks_shop.js` | `order_not_found` on the first save of every order — the charge never landed |
| The canteen desk's deposit, cash-out and limit writers wrote a document branch that is stripped on the way out | migration 240 | the office took $40 in cash, the screen said so, and the next hydration put the camper back to zero |
| A guard that compared the caller's camp with `<>` did nothing when the caller had no camp | migration 239 | a signed-in stranger could debit any camper's canteen balance at any camp |
| The offline register was exported from the frozen document and imported back into it | migration 242, `campistry_snacks.js` | the register started from stale balances, and every sale it took was free at the next reload |

The fourth was found by clicking "+ Add Deposit" and then looking in the
database. The fifth was found while writing 240's own gate, by asking what the
copied comparison does when the resolver answers `NULL` — and then reproducing it.

## The pieces

| File | What it is |
|---|---|
| `db.js` | boots a throwaway Postgres, loads `scripts/pgstubs.sql`, applies the ordered migration chain, hands back `sql()` / `json()` / a persistent `session()` |
| `postgrest.js` | compiles a serialized Supabase call into one SQL statement — column and parameter types come from the catalog, and overloads resolve by PostgREST's own rule |
| `bridge.js` | serves the repo's pages, and `POST /__pg` runs one call. Records every call, including the ones it could not answer |
| `shim.js` | the client the pages get, injected before any page script. A transport, not a mock |

## What a pass does and does not prove

**Does:** the JS→RPC→SQL→trigger path, the caller's identity (`auth.uid()` is real,
so a `SECURITY DEFINER` function's own gates apply), and what actually landed in
the tables.

**Does not:**

* **Row Level Security.** The bridge connects as a superuser. A step that succeeds
  proves the *function* allowed it, never that the policies would have.
* **The credential check.** The session is fabricated from a seeded user. Sign-in
  is checked against that list, not against Supabase's auth service.
* **Realtime** and **edge functions.** Both refuse in the shim, deliberately, so a
  test cannot quietly depend on them.

## Adding a step

Assert **in the database**, not in the page's memory — `kvRead(db, key)` and
`db.json(...)` are there for that. Wait on a *condition*, never a timer: cloud
saves are debounced and fire-and-forget, so `waitFor()` polls and says what it was
waiting for when it gives up.

Two things the harness will tell you about, and both are failures rather than
gaps to live with: `bridge.unsupported()` is every call it could not compile, and
`bridge.failed()` is every call that reached Postgres and came back with an error.
An RPC missing from the chain shows up in the second list — add the migration that
owns it to `MIGRATIONS` in `db.js`, with a line saying which page calls it.

Two files are served **empty** on purpose: `supabase-js@2.js` (the real library
would dial a host that is not there, and an absent `createClient` is the seam
`supabase_client.js` needs) and `config.js` (gitignored, holds the developer's real
project URL and anon key).
