# Ted's report: camper ID, thirteenth re-check (TED-044, 045), 2026-09-23

## Verdict: 🟡 Mostly good, some issues

I checked the one new change since my last visit (commit `b6115a4`). It fixes both issues I raised last time, TED-044 and TED-045. I confirmed both myself, with the real Supabase library, and by breaking each fix on purpose and watching a test fail. While checking, I found an older gap that my earlier checks missed. Some staff actions that name a child only by name are still sent to the server after another computer has erased a child. The page then tells the person the action was stopped, but it was actually sent. All test counts match what the builder reported.

## The numbers
Tests run: 3,450 · Passed: 3,436 · Failed: 14 (real bugs: 14, the deferred TED-005 · out-of-date tests: 0 · my machine: 0)

- `npm test`: 3,290 run, 3,276 passed, 14 failed. All 14 are in `auto_full_day.test.js`. That is TED-005, which you deferred.
- `npm run test:pg`: 50 passed, 0 failed
- `npm run test:keys`: 42 checks, all passed
- `npm run test:lite`: 12 checks, all passed
- `npm run test:smoke`: 32 checks, all passed
- `npm run test:scale`: 24 checks, all passed

## What's wrong (most serious first)

### TED-046 🟠 A staff action that names a child only by name slips past the erase check, and the page wrongly says it was stopped
- **What a user would see:** On the Link admin Photos page, a staff member approves a face tag on a photo. On another computer, the office has just erased a child. This page hasn't heard about the erase yet. The approval is still sent to the server, carrying the child number from this page's old list. The page then shows the message that it is reloading because a camper was erased, so the staff member thinks nothing was sent, but it was. Pickup-alert "checked" marks on the Live page work the same way. Your rule is that a page opened before an erase reloads before it can save anything, and these actions break it. I did not prove that a photo actually lands on the wrong child. The server's own erase clean-up may stop that. But the check is bypassed, and the message to the user is wrong.
- **How sure I am:** Confirmed that the action is sent and the page says it wasn't. Suspected, not proven, that a photo could land on the wrong child.
- **Proof:**
  - With the real Supabase library and a fake server (`scratchpad/v13/probe.e2e.js`, case P5), another computer erases, then this page calls `resolve_photo_tag` with only `p_camper_name: 'Avi Katz'`. Result: `sent = 1`, sent with `"p_camper_id":2`. The page was told "A camper was erased on another computer — this page is reloading."
  - The same probe in a node sandbox (`probe_name.js`) gives the same result. The same call for a name not on the roster, and `canteen_office_credit`, which passes its own number, were both correctly held back (`sent = 0`).
  - The gap was already there at `70cd931`. I re-ran the same probe on that commit and got the same result, so this change did not cause it.
  - The cause: `campistry_camper_id_rpc.js:62-67` looks up the child's number and adds it with `raw(fn, a, opts).then(...)`. That `.then` sends the request right away, inside the layer below the erase check. `supabase_client.js:245` then puts the check on a request that has already gone. The check only fails to cover calls where the page gave the name and no number, and the page's roster knew the number.
  - Staff callers affected: `campistry_link_photos.js:1153, 1169, 1205, 1211` (`resolve_photo_tag`, Link admin) and `campistry_live.html:469, 474, 481` (`mark_pickup_alert_league_checked`).
- **What to ask the builder for:** "TED-046: when a staff call names a camper by name only and the ID lookup adds the number, the erase check must run before the call is sent. Today the ID layer sends it at once, and the page is then told it was stopped even though it went out. Add a test with the real campistry_camper_id_rpc.js and supabase_client.js together: another computer erases, then resolve_photo_tag is called with only p_camper_name. Nothing may be sent, and the page must reload."

## What I confirmed is working
- **TED-044 closed. While this computer's own erase is waiting for its answer, a save no longer slips through.**
  - Real Supabase library, fake server (`scratchpad/v13/probe.e2e.js`):
    - P2 (my exact case from last time): `stale camp save sent = 0 | reloaded before own answer: false | reloaded after: true`. The same probe on the old commit `70cd931` gives `stale camp save sent = 1`.
    - P3, this page's own erase alone: `save sent before answer = 0 | save in between sent = 1 | reloaded: false`. The save waits for the answer, then goes out, and the page does not reload itself.
    - The 30-second safety limit works. In an early run of my probe, the erase answer never came, and the page reloaded after 30 s, as designed. This happened because my probe was holding the answer back, not because of a product fault.
  - Breaking it on purpose (scratch copy, `tests/erase_guard.test.js`):
    - The old "tab + own" rule → tests 3 and 6 fail.
    - Reloading at once instead of waiting → test 3 fails.
    - Waiting without deciding again afterwards → tests 2 and 6 fail.
    - Counting this page's own erase before its check → test 5 fails.
    - Sending the erase without a check → test 5 fails.
- **TED-045 closed. A test now guards "every ordinary-table write checks afresh".** With the old 15-second rule for tables put back, `erase_guard.test.js` test 4 fails ("the write went out after an erase elsewhere"). The new file runs as part of `npm test`: 3,290 tests now, 3,284 before, so 6 new.
- **test:keys step 7 does what the builder says.** In a scratch copy, I put back sending all erases at once (`Promise.all`). The result was "FAIL the erases were sent one after another, never two at once → at once: 2". With the real code, it passes.
- **The test-helper change is fair.** `tests/e2e/shim.js` now sends a call only when its result is asked for. The real Supabase library behaves the same way: in my probe, requests reached the fake server only after the check. All browser suites pass with it.
- **Browser cache versions:** all 21 pages that load `supabase_client.js` directly use `?v=20260923-06`, with no stragglers. Lite loads it through `LITE_ASSET_VERSION = '20260923-10'` (`campistry_lite.html:137`).
- **Only the Me page erases, one at a time.** `campistry_me.js:450-451` are the only callers of `erase_camper` and `merge_campers`. Each erase's answer calls the "this page is current" step before the in-flight count drops (`campistry_me.js:456`, `supabase_client.js:239`), so a waiting save never mistakes this page's own erase for someone else's.
- **Name inventory:** `node scripts/camper_name_inventory.js --check` → "up to date".
- **No leftovers:** the only added `console.log` lines are the existing script-load error messages, where only the version number changed. No new TODOs, debug switches or secrets.

## Re-check of every open finding
- TED-044: closed (proof above).
- TED-045: closed (proof above).
- TED-005: still open, deferred by you. Still exactly 14 failures, all in `auto_full_day.test.js`.

## What I did NOT check (and why)
- **The real Supabase server.** Everything ran on a scratch database copy or a fake server. I never erased anyone on the live camp.
- **Whether TED-046 can put a photo on the wrong child.** That depends on how the erase clean-up handles photo tags, and on a new child getting the erased number. I did not build that full scenario on a scratch database.
- **Two real people on two real computers.** I simulated "another computer" by moving the server's version number myself.
- **Two Me tabs in the same browser.** They share one erase queue, so the tab that didn't press Delete will reload with the "another computer" message. That is safe but the wording is misleading. I did not test it by hand.
- **Calls whose arguments don't start with camper/person/child** (e.g. `revoke_orphaned_parent_invites` with `p_roster_names`). They are still checked at most every 15 s, the same as last time.
- **The native Lite app (Capacitor build).** Only you can rebuild it.
- **Auto Builder** (TED-005): deferred by you.

## Things only you can check (click-by-click)
1. **Make sure the new files are live.** Open the Me page in Chrome and press F12. Open the **Network** tab, tick "Disable cache", and reload. Type `supabase_client` in the filter box. The file should show `?v=20260923-06`.
2. **Erase two children in a row.** Use two test campers you don't need. Delete them one after the other on the Me page, and wait about a minute for the Undo window to pass. The page should **not** say "A camper was erased on another computer. Reloading…". Both children should be gone after you reload.
3. **The other-computer case.** Open the Me page on a second computer, or in a private window logged in as you. Erase a test camper on the first computer. On the second computer, click back into the window. Within a second it should say "A camper was erased on another computer. Reloading…" and reload.
4. **Lite on phones.** If staff use the installed Lite app, rebuild it so it carries `LITE_ASSET_VERSION 20260923-10`.
