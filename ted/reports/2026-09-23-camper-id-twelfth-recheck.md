# Ted's report: camper ID, twelfth re-check (TED-040, 042, 043), 2026-09-23

## Verdict: 🟡 Mostly good, some issues

I checked the one new change since my last visit (commit `70cd931`). It fixes the three erase-reload issues I raised last time, and I confirmed all three myself: with the real Supabase library, and by breaking each fix on purpose and watching the test fail. One narrow gap came with the TED-042 fix. If this computer's erase is still waiting for its answer when another computer erases a child, a save from this page can slip through before the page reloads. Also, one of the new safety rules has no test guarding it. Every test suite matches what the builder reported.

## The numbers
Tests run: 3,443 · Passed: 3,429 · Failed: 14 (real bugs: 14, the deferred TED-005 · out-of-date tests: 0 · my machine: 0)

- `npm test`: 3,284 run, 3,270 passed, 14 failed. All 14 are `auto_full_day.test.js`, which is TED-005 and still deferred by you.
- `npm run test:pg`: 50 passed, 0 failed
- `npm run test:keys`: 41 checks, all passed
- `npm run test:lite`: 12 checks, all passed
- `npm run test:smoke`: 32 checks, all passed
- `npm run test:scale`: 24 checks, all passed

## What's wrong (most serious first)

### TED-044 🟡 A save can slip through while this computer's own erase is still waiting for its answer
- **What a user would see:** Nothing in almost every case. Here is the rare case. Two office users erase a child at nearly the same moment, and one of them saves something while their own erase is still waiting for the server's reply. That save carries an old copy that still includes the child the *other* computer just erased, and the server accepts it. The page does reload a moment later, when its own erase answer arrives. Your rule says a page opened before an erase reloads *before it can save anything*. In this short window, it saves first and reloads after. The server-side protections from earlier fixes (TED-021, TED-033) should stop an erased child from being written back. So this is a missing safety net, not a known way to bring a child back.
- **How sure I am:** Confirmed, on a fake server with the real Supabase library. The two computers never had to erase at the exact same instant.
- **Proof:** `scratchpad/v12/probe.e2e.js`, case P2:
  1. This page's erase is sent and held open.
  2. Another computer erases.
  3. This page upserts `camp_state_kv`.

  Result: `stale camp save sent = 1 | reloaded before own answer: false | reloaded after: true`. The cause is `supabase_client.js:110` (`if (server > _EG.tab + _EG.own)`). While one of its own erases is in flight, the page accepts one step of change without knowing whose step it was. Before this fix, the same save was refused.
- **What to ask the builder for:** "TED-044: while this page's own erase or merge is still waiting for its answer, don't let other saves through on the 'tab + own' allowance. Hold them until the answer arrives, then decide. Add a test:keys check where another computer erases while this page's erase is in flight and the page saves in between: nothing may be saved."

### TED-045 🟡 No test guards the new rule that every table write checks afresh
- **What a user would see:** Nothing today. The code does check before every table write. I confirmed this with the real library: a canteen-table insert right after an erase elsewhere was held back, and the page reloaded. But if someone later put the old "every 15 seconds" rule back for ordinary tables, every test would still pass, and nobody would notice.
- **How sure I am:** Confirmed
- **Proof:** I ran test:keys in a scratch copy with `supabase_client.js` changed back to `const maxAge = table === 'camp_state_kv' ? 0 : 15000;` → "All 41 checks passed." The new step 7 only tests a function call (RPC) that names a camper. It never tests a table write.
- **What to ask the builder for:** "TED-045: add a test:keys check where, right after a check, another computer erases and the page then writes to an ordinary table (not camp_state_kv). The write must not reach the database and the page must reload. The check must fail with the old 15-second rule."

## What I confirmed is working
- **TED-040 closed. A write or camper-naming call right after an erase elsewhere is stopped.**
  - Real supabase-js, fake server (`probe.e2e.js`):
    - P1: insert into `canteen_transactions` → 0 inserts sent, page reloaded.
    - P1c: an RPC with a camper number tucked inside a list of rows (`p_rows:[{camperId:2}]`) → not sent, page reloaded.
  - Breaking it on purpose: test:keys with the RPC rule set back to 15 s → "timed out waiting for the page to reload before a call that names a camper" (fails).
  - Limit I noted: a call whose argument names don't start with camper/person/child still waits up to 15 s (P1b: `revoke_orphaned_parent_invites` with `p_roster_names` was sent without a fresh check). I found no call like that which files money or a record against a camper number. `settle_shop_order` works from an order ID, and the server looks up the child.
- **TED-042 closed. The erasing page no longer reloads itself when it erases several children.**
  - test:keys step 7 passes: both campers erased, 0 reloads.
  - Put back sending all at once (`Promise.all`) → fails ("reloads: 1").
  - Removed the in-flight count → fails ("reloads: 2").
  - My probe P3, this page's own erase only, with a save in between → the save went through and the page did not reload.
  - The one side effect is filed above as TED-044.
- **TED-043 closed. A write addressed with a URL object is refused while the page reloads.**
  - Probe P4: status 409, 0 requests reached the server.
  - Old line put back → test:keys fails ("sent: Failed to fetch").
- **Browser cache versions:** all 21 pages that load `supabase_client.js` use `?v=20260923-05`, with no stragglers (the other 5 mentions are comments). Lite `LITE_ASSET_VERSION = '20260923-09'` (`campistry_lite.html:137`). `campistry_me.js?v=20260923-29` on the one page that loads it.
- **Erase and merge are the only calls the in-flight count covers, and only the Me page makes them.** `campistry_me.js:450-451` are the only callers of `erase_camper` and `merge_campers`. The server moves the cache version only in those two (migration 260, lines 802 and 871).
- **Name inventory:** `node scripts/camper_name_inventory.js --check` → "up to date"; part A is still 0.
- **No leftovers:** the change adds no debug switches, TODOs or secrets. `CampistryMe.runCamperErases` only runs the existing queue and cannot run twice at once (`_eraseRunning`).

## Re-check of every open finding
- TED-040: closed (proof above).
- TED-042: closed (proof above). Follow-up is TED-044.
- TED-043: closed (proof above).
- TED-005: still open and deferred by you. Still exactly 14 failures, all in `auto_full_day.test.js`.

## What I did NOT check (and why)
- **The real Supabase server.** Everything ran on a scratch copy of the database or a fake server. I never erased anyone on the live camp.
- **Two real people on two real computers.** I simulated "another computer" by moving the version number on the server myself.
- **The native Lite app (Capacitor build).** It bundles its own copy of the files. Only you can rebuild and install it.
- **The parent-invite "still connected" sweep** (`revoke_orphaned_parent_invites`). It compares roster keys, and it is not among the calls that check afresh. I did not test what happens when an office page with an out-of-date roster runs it while another user has just added a child.
- **Auto Builder** (TED-005): deferred by you.

## Things only you can check (click-by-click)
1. **Make sure the new files are live.** Open the Me page in Chrome and press F12. Open the **Network** tab, tick "Disable cache", and reload. Type `supabase_client` in the filter box. The file should show `?v=20260923-05`. Then type `campistry_me.js`. It should show `?v=20260923-29`.
2. **Erase two children in a row on the real site.** Use two test campers you don't need. Delete them one after the other on the Me page, and wait for the Undo window to pass (about a minute). The page should **not** show "A camper was erased on another computer. Reloading…". Both children should be gone after a manual reload.
3. **The other-computer case.** Open the Me page on a second computer (or in a private window logged in as you). Erase a test camper on the first computer. On the second computer, click back into the window. Within a second it should say "A camper was erased on another computer. Reloading…" and reload.
4. **Lite on phones.** If staff use the installed Lite app rather than the website, rebuild it so it carries `LITE_ASSET_VERSION 20260923-09`.
