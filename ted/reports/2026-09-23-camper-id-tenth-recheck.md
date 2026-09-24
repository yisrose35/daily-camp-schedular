# Ted's report: camper ID number, check of the TED-033..036 fixes and the "reload after an erase" rule, 2026-09-23 (tenth visit)

## Verdict: 🟡 Mostly good, some issues

I checked the two new builder commits (`189d36b`, `10f4461`) and re-tested every open finding myself. Three of last visit's four findings are fixed, and I closed them with my own proof:
- An office tab left open no longer makes children added elsewhere disappear.
- Parents can no longer pull the camp's list of names and numbers.
- The check script now catches an open invitations table.

Your new rule, "a page opened before an erase reloads before it can save", works for the normal save, but it has gaps:
- **The page's old copy still goes out as it reloads.** I watched this happen in a real browser.
- **Campistry Lite never got the new code.**
- **The check script says "ok" even if the new 260 has not been run on your database.** In that case the reload does not happen at all.

No family can become the wrong child's parent through any of this. The risk is an old page's stale data landing after an erase.

## The numbers
Tests run: 3,436 · Passed: 3,422 · Failed: 14 (real bugs: not sorted: all 14 are the auto-scheduler tests you deferred (TED-005) · out-of-date tests: 0 · my machine: 0)

| Suite | Run | Passed | Failed |
|---|---|---|---|
| Unit (`npm test`) | 3,284 | 3,270 | **14** (`auto_full_day.test.js` 174-195, the same 14 as every visit) |
| Database (`npm run test:pg`) | 50 | 50 | 0 (against 89 migrations) |
| Roster keys (`npm run test:keys`) | 34 | 34 | 0 |
| Lite + Health (`npm run test:lite`) | 12 | 12 | 0 |
| Smoke (`npm run test:smoke`) | 32 | 32 | 0 |
| 600-camper scale (`npm run test:scale`) | 24 | 24 | 0 |

These match the builder's numbers. The name inventory `--check` says "up to date".

## What's wrong (most serious first)

### TED-037 🟠 (new) A page forced to reload still sends its old copy on the way out
- **What a user would see:**
  1. Computer B has had the Me page open since before an erase.
  2. Someone on B edits a camper and presses Save.
  3. The page shows "A camper was erased on another computer. Reloading…" and reloads, as you asked.
  4. But as it closes, the page's "save before leaving" step sends B's whole old copy straight to the database anyway. B's edit lands, and so does everything else B was holding from before the erase.

  The only part that stays safe is the roster: the server still refuses to bring the erased child back (the TED-021 protection). This means your "force reload" rule is not yet true. It also means TED-035's case (a leftover record with only a number and no name landing on a new child given the erased number) can still happen.
- **How sure I am:**
  - **Confirmed** in a real browser (Chromium) against a scratch database: the request leaves the page carrying the stale edit.
  - **Confirmed** that it lands, by replaying that exact request on the scratch database the same way Supabase would.
  - **Likely** limited by size. This "save before leaving" step only sends saves under about 60,000 characters. On the Me page that means small camps. Pages that save one small item at a time, such as Health, can send it at any camp size. I didn't measure your real camp's size.
- **Proof:**
  - My script `v10/leak2.e2e.js` (scratchpad) runs the real Me page as the owner:
    1. Avi #2 is removed and really erased (`erase_camper` → `cache_epoch: 1`).
    2. Sara is given #2 on purpose.
    3. The old page edits Leah's school and saves.
  - Page log:
    - `a camper was erased or merged on another computer — clearing this page's copy and reloading`
    - then `FETCH /rest/v1/camp_state_kv?on_conflict=camp_id,key keepalive=true … STALE-EDIT`
    - It carried 4 documents: `campStructure, app1, campistryMe, campistryMeFinance`, and its roster held `Avi Gold`.
  - I replayed that request as the owner. Leah's school became `"Stale Tab Edit"`. The roster stayed `{Leah 20, Sara 2, Moshe 1}`, so Avi did not come back.
  - **The cause:** the guard wraps the page's Supabase connection only (`supabase_client.js`, `_withEraseGuard`). When the save is blocked, the page puts it back in its to-do list (`integration_hooks.js:1071-1080`). The page's before-leaving handler then sends that list with a plain `fetch(… keepalive: true)` straight to `/rest/v1/camp_state_kv`, which goes around the guard (`integration_hooks.js:3647-3686`).
  - **Why the builder's test missed it:** test:keys step 6 runs against a pretend Supabase address (`smoke.supabase.co`). The page's security policy blocks that address, so the leaked request is refused in the test and never counted. The browser said `Refused to connect because it violates the document's Content Security Policy`. The real address is allowed (`campistry_security.js:869`).
  - Step 6 also moves the version by hand (`_bump_cache_epoch`) rather than doing a real erase.
- **What to ask the builder for:** "When the erase guard makes a page reload, the beforeunload keepalive flush in integration_hooks.js still POSTs the blocked save straight to /rest/v1/camp_state_kv. Make that flush (and any other raw fetch write) respect the guard, and make test:keys step 6 catch a leaked keepalive request."

### TED-038 🟠 (new) Campistry Lite never gets the reload rule
- **What a user would see:** A counselor's phone that was open before an erase keeps saving its old copy: health dispensing, the day's attendance, staff assignments. Nothing reloads it.
- **How sure I am:** Confirmed by reading the code. I didn't test it on a phone.
- **Proof:**
  - Lite loads `supabase_client.js` with its own version number, `LITE_ASSET_VERSION = '20260923-06'` (`campistry_lite.html:137`, `:149`). That wasn't changed in either commit (`campistry_lite.html` is not in `git diff b92dcdc..HEAD --stat`). So a phone that cached the file keeps the old copy with no guard.
  - The builder's claim of "all 21 pages" leaves Lite out, because Lite builds the script address in code.
  - Lite writes camp documents itself: `saveKV('campistryHealth', …)` at `campistry_lite.js:623`, plus `liveDaily_…` and `liteStaffAssignments`.
- **What to ask the builder for:** "Bump LITE_ASSET_VERSION in campistry_lite.html so Lite phones load the new supabase_client.js with the erase guard, and add Lite to the list of pages the guard is checked on."

### TED-039 🟠 (new) The check script says 260 is "ok" even when the new 260 hasn't been run, and then the reload silently never happens
- **What a user would see:** You run the check script and it says 260 `ok`. But if your database still has last round's 260:
  - no page ever reloads after an erase;
  - parents can still read the camp's name list (TED-034);
  - an old tab can still drop children (TED-033).

  The new code is built to carry on quietly when the database doesn't answer the version question (`supabase_client.js`: "not staff, or not migrated: carry on"). So nothing on screen tells you either.
- **How sure I am:** Confirmed on a scratch database.
- **Proof:** my script `v10/verify_old260.js` builds the full chain with the previous 260 (from `b92dcdc`) and runs `scripts/verify_identity_chain.sql`:
  - `260 numbers stay with their child … | ok`
  - `261 … | ok`
  - `get_camp_cache_epoch exists: f`
  - `get_camper_numbers gate: camp_reader`

  The 260 row checks invites, renumbers and split renames only (`scripts/verify_identity_chain.sql:488-511`), not the new parts.
- **What to ask the builder for:** "Make the verify script's 260 row say 'run 260 again' when get_camp_cache_epoch or camp_cache_epoch is missing, get_camper_numbers doesn't use camp_staff_member, merge_campers doesn't bump the version, or the roster trigger doesn't handle _rosterSeen."

### TED-035 🟡 (still open) A leftover record with only a number can land on a new child given an erased number
- Your rule for this (force a reload with a cleared cache; numbers stay reusable; money stays, unlinked) is now built into the normal save.
- It stays open because of TED-037 and TED-038: an old page's copy can still reach the database. That copy can carry a record with only `camperId: 2`. The normal blocked save itself works: in my browser run the database was unchanged by the normal save, and the page reloaded once.

### TED-040 🟡 (new) Some saves aren't covered by the reload rule: edge-function calls, and a 15-second gap
- **What a user would see:** Rare. An old Snacks page could send a canteen refund or auto-reload for a camper by number, and a stale page could save in the first seconds after an erase.
  - The guard doesn't cover calls to the server's edge functions at all.
  - For writes other than camp documents, it only asks for the version once every 15 seconds.

  If an erased number has already been given to a new child, those could land on that child. In practice someone has to type the erased number for a new child within those seconds, which is unlikely.
- **How sure I am:** Suspected. I read the code but didn't run the money functions.
- **Proof:**
  - `_withEraseGuard` wraps only `client.from(...)` writes and `client.rpc(...)`, not `client.functions.invoke` or raw `fetch(…/functions/v1/…)`.
  - Money examples that send a camper number:
    - `campistry_snacks.js:1941` (`stripe-canteen-refund` / `payments-canteen-refund` with `camperId` and `amount`);
    - `campistry_snacks_pos.js:779` (`canteen-auto-reload` with `camperId`).
  - Other tables and RPCs use `maxAge 15000`.
- **What to ask the builder for:** "Put the erase guard in front of functions.invoke and edge-function fetches that carry a camperId (at least the canteen refund and auto-reload), with a fresh check, not the 15-second one."

### TED-041 🟡 (new) The erasing page can skip a reload it should have done
- **What a user would see:**
  1. Computer B erases a child.
  2. A few seconds later, computer A runs its own erase.
  3. A takes on the newest version number, so it never reloads, though it still holds B's erased child.
- **How sure I am:** Likely, by reading the code. I didn't test it.
- **Proof:**
  - `_eraseGuardAdvance` sets `_EG.tab = Math.max(_EG.tab || 0, n)` with the number the erase returned (`supabase_client.js`).
  - The erase call itself only asks for the version if the last check was more than 15 s ago.
  - The Me page runs its erase about 8 s after its roster save.
- **What to ask the builder for:** "__campistryEraseGuardAdvance should only move this page on when the returned version is exactly one past what it had; otherwise reload like any other stale page."

### TED-005 🟠 (still open, deferred by you) 14 auto-scheduler tests still fail
- The same 14. I didn't investigate them.

## What I confirmed is working
- **TED-033 is fixed (closed).** I re-ran my own scenarios with the new "children this tab has seen" list, on a fresh full-chain database (`v10/t33.sql`):
  - **No erase:** the tab saw only Moshe, and Sara was added elsewhere. After the tab saves, the roster is `{Sara #2, Moshe #1 (with the tab's edit)}`, and Sara isn't marked departed. The list itself isn't stored.
  - **Added before the erase ran:** after the tab saves, the roster is `{Sara #3, Moshe #1}`, and Avi isn't back.
  - **Deliberate removal:** the tab saw Sara and then removed her, so she's removed.
  - **Page without the list:** an old page behaves as before, as the builder said.
  - **Renumbered child:** the tab saw her as #3 and the office moved her to #9. The tab's removal is honoured.
  - The Me page collects the list at every load and before every save (`campistry_me.js:652`, `:856-860`, `:5988-5992`).
- **TED-034 is fixed (closed).** On the scratch database (`v10/tpar.sql`):
  - A parent (`camp_staff_member` = f, `camp_reader` = t) calling `get_camper_numbers` now gets `{"success": false, "error": "not_authorized"}`.
  - The owner gets `"erased": {"2": true}`, with no name.
  - A non-staff caller gets `NULL` for the cache version.
  - **Leftover:** the erased child's name is still stored in `camp_erased_people.key` (I saw `Avi Gold`). The server uses it to spot stale saves, but "erased" still keeps the name.
- **TED-036 is fixed (closed).** `v10/t36.js`, on a full build, changing one thing at a time:

  | Change | 261 row says |
  |---|---|
  | none (full build) | `ok` |
  | row security off | "run 261 again" |
  | extra rule `USING (camp_id = get_user_camp_id())` | "run 261 again" |
  | parent rule opened with `OR true` | "run 261 again" |

  Still passes: a hand-edited office rule that keeps the owner/admin/manager words but adds `OR true`, or drops the camp check. That's unlikely on a real database, since 261 writes that rule itself.
- **The normal save on an old page is blocked.** In my browser run:
  - the old page reloaded once;
  - the log showed `Batch sync failed: A camper was erased on another computer — this page is reloading`;
  - the database's roster had no stale edit from that save.

  (The copy that went out on the way out is TED-037.)
- **Erase and merge move the camp's version on.** `erase_camper` returned `cache_epoch: 1` on my scratch database. pgtest 260 sections 6d, 12 and 13 check erase, merge, the parent refusal and the seen list, and they passed in `npm run test:pg`.
- **Browser caching:**
  - `supabase_client.js?v=20260923-03` is on all 21 pages that load it with a fixed tag.
  - `campistry_me.js?v=20260923-28` is on `campistry_me.html:343`.
  - Lite is the exception (TED-038).
- **Leftovers.** The diff adds no TODO, FIXME or debug switch. There is one new `console.warn` when a page reloads.

## What I did NOT check (and why)
- **The live database.** I didn't connect, so I don't know whether the new 260 has been run there (see TED-039).
- **A real phone running Lite** (TED-038 is from reading the code).
- **The edge functions** (canteen refund, auto-reload) with a reused number (TED-040). They move real money, so I only read the code.
- **How big a real camp's Me save is.** That decides whether the TED-037 leak fires on the Me page. Small single-item saves on other pages are under the limit at any size.
- **Two real computers.** My "second computer" was a second browser page against a scratch database.
- **The 14 auto-scheduler failures** (deferred by you).

## Things only you can check (click-by-click)
1. **Run 260 again, then 261.**
   - Supabase Dashboard → SQL Editor → New query → paste all of `migrations/260_numbers_stay_with_their_child.sql` → Run.
   - Then do the same with `migrations/261_only_the_camp_office_writes_parent_invites.sql`.
2. **Check the new parts are really there (read only),** because the check script won't tell you (TED-039). New query, paste and Run:
   `SELECT to_regprocedure('public.get_camp_cache_epoch(uuid)') IS NOT NULL AS reload_rule_installed, pg_get_functiondef('public.get_camper_numbers(uuid)'::regprocedure) ~ 'camp_staff_member' AS names_staff_only;`
   Both should say `true`.
3. **After the new code is live, reload every office computer.** A page opened before the update is still running the old code, with no reload rule. **Close and re-open Lite on phones too.** Until TED-038 is fixed, Lite won't pick up the rule even then.
4. **Two-computer check.**
   1. Open Me on two computers.
   2. On computer 1, delete a test camper and wait about 10 seconds for the erase.
   3. On computer 2, edit another camper and press Save.
   4. Computer 2 should show "A camper was erased on another computer. Reloading…" and reload.
   5. After it reloads, the edit you made on computer 2 should **not** be there.

   If it *is* there, that is TED-037 happening on your camp.
