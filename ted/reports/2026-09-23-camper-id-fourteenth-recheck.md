# Ted's report: camper ID, fourteenth re-check (TED-046), 2026-09-23

## Verdict: 🟢 Good

I checked the one code change since my last visit (commit `678e3a2`). It fixes TED-046. I proved that myself three ways: with the real Supabase library, with my own test from last time, and by putting the old code back and watching the builder's new test fail. Every test count matches what the builder reported. I found one small new item, TED-047. It cannot make anyone a child's parent and it cannot move money, so it does not change my answer.

**Is the camper-ID work complete in the code? Yes.** Apart from your live steps below, every decision about which child a record, a payment or a photo belongs to, and who counts as a child's parent, now goes by the camper's number. The one leftover (TED-047) is a single on/off switch that uses the child's name. It decides whether a family's app stays "connected to camp" after their child leaves. It never decides who the child is or who the parent is. It is a tidy-up, not a blocker.

## The numbers
Tests run: 3,451 · Passed: 3,437 · Failed: 14 (real bugs: 14, the deferred TED-005 · out-of-date tests: 0 · my machine: 0)

- `npm test`: 3,291 run, 3,277 passed, 14 failed. I ran each test file on its own, and all 14 failures are in `auto_full_day.test.js`. That is TED-005, which you deferred.
- `npm run test:pg`: 50 passed, 0 failed
- `npm run test:keys`: 42 checks, all passed
- `npm run test:lite`: 12 checks, all passed
- `npm run test:smoke`: 32 checks, all passed
- `npm run test:scale`: 24 checks, all passed

These match the builder's numbers exactly.

## What's wrong (most serious first)

### TED-047 🟡 The "is this family still at camp?" switch compares children's names, not numbers
- **What a user would see:** Almost certainly nothing. When a child leaves camp, the Me page switches the family's parent app off for live camp features, such as canteen, mail and pickup. It decides by checking whether the child's *name* is still on the roster. Here is the rare case where that goes wrong. A child leaves, and a different child with the same name is added. If the Me page runs its switch-off check in the short gap (up to about 40 seconds) before it learns the new child's internal label, the first family stays switched on. The next check, which runs a few seconds after the next save, puts it right. The family still only owns its own child's number, so it cannot see or pay for the new child.
- **How sure I am:** Confirmed that the switch goes by name. Suspected, not proven, that a user could ever notice.
- **Proof:**
  - On a scratch copy of the database with every migration, I enrolled the Katz family's "Avi Katz" (#1), removed him, and added a different "Avi Katz", who got #3. I then ran the switch-off check (`revoke_orphaned_parent_invites`) with the plain name. Result: `revoked: 0`, and the Katz invite stayed `camp_connected = t` with `person_ids [1]`. My script is `scratchpad/v14/t047.sql`.
  - The server function compares names: `migrations/122_camper_offboard_link_features.sql`, `WHERE p_roster_names ? cn` over `i.camper_names`. The page sends roster names: `campistry_me.js:14206-14207`.
  - Why the impact is small: the database gives the new child his own label, "Avi Katz #3", and `test:keys` step 3 shows the page adopts that label. The check also runs again after every auto-invite pass (`campistry_me.js:14271`). Erasing a child already removes him from invitations by number (`migrations/254_…sql:317-340`), so erased children are not affected at all.
- **What to ask the builder for:** "TED-047: make revoke_orphaned_parent_invites decide whether a family still has a child at camp from the invite's person_ids and the enrolled camper numbers, not from camper_names. Add a pgtest where a departed Avi Katz #1 and a new Avi Katz #3 share a name, and the first family is still switched off."

## What I confirmed is working
- **TED-046 closed. A staff action that names a child only by name is now checked before it is sent.**
  - I re-ran my own unchanged probe from last time with the real Supabase library in Chromium (`scratchpad/v13/probe.e2e.js`). Case P5 now shows `sent = 0 | page was told: A camper was erased on another computer — this page is reloading. | [] | reloaded: true`. Last time, at `b6115a4`, it showed `sent = 1`.
  - My sandbox probe (`scratchpad/v13/probe_name.js`) also shows `sent to server: 0` for `resolve_photo_tag` by name, for a name not on the roster, and for `canteen_office_credit`, with `reloads: 1`.
  - The other probe cases are unchanged: P1 table insert 0 sent, P1c 0 sent, P2 0 sent, P3 the save waits then goes out with no reload, P4 409 with 0 requests reaching the server.
  - **Putting the old code back:** in a scratch copy, I ran the builder's test file against the `b6115a4` version of `supabase_client.js`. Tests 1 to 6 passed, and test 7 (TED-046) failed. With today's code, all 7 pass. So the new test really does guard the fix.
  - **Reading the code:** `supabase_client.js:57` now puts the erase check on first. The number layer (`campistry_camper_id_rpc.js:47`) then captures the already-checked call as its `raw`. Its immediate `.then` at line 59 therefore goes through the check before anything is sent. The retry at line 62 goes through the check too.
  - **Pages that load the number layer after the client:** its self-wrap at `campistry_camper_id_rpc.js:236-240` wraps a client that already has the check, so the check again sits underneath. Both client-creation paths (`supabase_client.js:386, 393, 1074, 1080`) go through `_withCamperIds`.
  - **Nothing else relied on the old order.** `__rawRpc` has no readers outside the number layer.
- **Browser cache versions:** all 21 pages load `supabase_client.js?v=20260923-07`, with no stragglers. The 5 other mentions are comments, plus Lite's load list. Lite is at `LITE_ASSET_VERSION = '20260923-11'` (`campistry_lite.html:137`; it was `-10`), and it loads the number layer first (`campistry_lite.html:29`).
- **Name inventory:** `node scripts/camper_name_inventory.js --check` → "up to date".
- **No leftovers:** the only added `console.log` lines are existing script-load error messages where only the version changed. No TODOs, debug switches or secrets.
- **Your erase rules:** no migration changed since my last check, so the three rules I checked before still hold. Erased numbers stay reusable. Old pages reload with a cleared cache before saving. Erased children's money stays in the books without their number.

## Re-check of every open finding
- TED-046: closed (proof above).
- TED-005: still open, deferred by you. Still exactly 14 failures, all in `auto_full_day.test.js`.

## What I did NOT check (and why)
- **The real Supabase server.** Everything ran on a scratch database or a fake server. I never erased anyone on the live camp.
- **Two real people on two real computers.** I simulated "another computer" by moving the server's version number myself.
- **What a still-connected family (TED-047) actually sees in the parent app.** The function that builds the parent app's feature list is not in the test migration chain, so I could not call it on the scratch copy.
- **Calls whose arguments don't name a camper, person or child** (e.g. the same `revoke_orphaned_parent_invites`). These are still checked at most every 15 seconds (probe P1b: sent = 1). That is unchanged, and none of them files money or a record against a camper number.
- **The native Lite app (Capacitor build).** Only you can rebuild it.
- **Auto Builder** (TED-005): deferred by you.

## Things only you can check (click-by-click)
1. **Make sure the new files are live.** Open the Me page in Chrome and press F12. Open the **Network** tab, tick "Disable cache", and reload. Type `supabase_client` in the filter box. The file should show `?v=20260923-07`.
2. **The other-computer case, on a staff action.** Open Link admin → Photos on a second computer (or in a private window, logged in as you). On the first computer, erase a test camper on the Me page. On the second computer, click back into the window. It should say "A camper was erased on another computer. Reloading…" and reload before you can approve a tag.
3. **Erase two children in a row** on the Me page, using test campers. The page should **not** say "erased on another computer". Both children should be gone after a reload.
4. **Lite on phones.** If staff use the installed Lite app, rebuild it so it carries `LITE_ASSET_VERSION 20260923-11`.
