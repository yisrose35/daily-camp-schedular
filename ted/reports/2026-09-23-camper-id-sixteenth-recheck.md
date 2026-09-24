# Ted's report: camper ID sixteenth re-check (TED-048, TED-049 fixes + Parents page wording), 2026-09-23

## Verdict: 🟢 Good

I checked the three commits since my last visit (`d049454` → `4ce2489`). Both open items from last time are really fixed, and I proved it myself:
- TED-048: the checking script now spots an old copy of migration 261.
- TED-049: a family whose child is still at camp is no longer switched off.

The Parents-page wording changes do what they say. Every test count matches the builder's numbers. I found one small tidy-up item (TED-050, a missing automated test). It does not change the answer.

**Is the camper-ID work complete and closed in the code, apart from your live steps? Yes.** Nothing about camper numbers is left open. The only open item (TED-005, the 14 auto-scheduler tests) has nothing to do with camper numbers, and you deferred it.

## The numbers
Tests run: 3,454 · Passed: 3,440 · Failed: 14 (real bugs: 14, all the deferred TED-005 · out-of-date tests: 0 · my machine: 0)

- `npm test`: 3,294 run, 3,280 passed, 14 failed. All 14 are in `auto_full_day.test.js` (run on its own: 9 pass, 14 fail). That is TED-005, which you deferred.
- `npm run test:pg`: 50 passed, 0 failed (89 migrations, one database copy per test)
- `npm run test:keys`: 42 of 42 passed
- `npm run test:lite`: 12 of 12 passed
- `npm run test:smoke`: 32 of 32 passed
- `npm run test:scale`: 24 of 24 passed
- Name inventory `--check`: "up to date"

These match the builder's numbers exactly.

## What's wrong (most serious first)

### TED-050 🟡 No automated test checks that the Me page sends camper numbers to the "family still at camp?" switch
- **What a user would see:** Nothing today. The page works. But suppose a later change stopped the Me page from sending the numbers. The page would quietly fall back to deciding by name, and the TED-047 problem would be back: a departed child's family stays connected because a new child has the same name. No test would go red.
- **How sure I am:** Confirmed. The safety net is missing. The page itself works.
- **Proof:** `grep -rln "p_roster_ids\|_sweepOrphanedParentInvites" tests/` finds nothing. My own probe (`scratchpad/v15/sweep_probe.js`) still passes against today's `campistry_me.js`:
  - It sends `p_roster_ids = [3,2]`.
  - It retries with the old form only on a "function not found" (PGRST202) answer.
  - It does not retry on any other error.
- **What to ask the builder for:** "TED-050: add an automated test (in npm test or test:keys) that runs the Me page's _sweepOrphanedParentInvites and fails if it stops sending p_roster_ids, or if it falls back to the name-only call on anything other than a PGRST202 'function not found' answer."

## What I confirmed is working

- **TED-048 closed. The checking script now spots an old copy of 261.** I tested it on a scratch copy of the database with every migration, using the real earlier copies of 261 taken from git. The builder's own test uses a stand-in, so I did not rely on it.
  - Today's 261: `261 … ok`.
  - 261 from `d049454` (yesterday's by-number version): "run 261 again — this is an earlier copy…". After re-running today's 261: `ok`.
  - 261 from `b92dcdc` (the first version, with no by-number switch): "run 261 again…". After re-running today's 261: `ok`.
  - Today's 261 run twice more on top of itself: both succeed, and the script still says `ok`.
  - **Taking the fix back out:** I gave the builder's pgtest 261 the old checking script from `d049454`, and it fails with `TED-048: the checking script says "ok" on an earlier copy of 261`. I also removed only the new `camp_people` half of the check, and the test fails the same way. So the test really guards both halves.
- **TED-049 closed. A family with a child still at camp stays switched on.**
  - **Taking each fix back out.** I undid each of the three parts of the fix one at a time, each on its own database copy, and ran the builder's pgtest 261. Each failed with the matching message:
    - no database roster check → "the Ross family was switched off although the database has Dov #6 enrolled"
    - no unnumbered-sibling rule → "the Tal family was switched off although Sara (no number yet) is on the roster"
    - blank-number list counted as full → "a list of numbers with no usable number switched families off"
    - Unchanged, the test passes.
  - **My own scenario with real roster saves.** The builder's test typed the database rows in by hand, so I did not rely on it. I saved the roster the way the Me page does and let the database's own bookkeeping run (`scratchpad/v16/real.sql`):
    - A child removed from the roster is marked gone.
    - A child unenrolled by hand has the unenrolled flag copied across.
    - In both cases their family was switched off (`revoked: 2`).
    - The TED-047 case still works: the departed Avi #1's family goes off even though a new Avi Katz joined as #5.
    - A family whose number the page sent wrongly (99 instead of the real 4) stayed on.
    - An unenrolled flag written as the text `"true"` is also read correctly.
- **Parents page wording (commit `4ce2489`):**
  - **"Invite all".** I ran the real function with a stand-in database. It shows `1 parent logins invited · 3 failed: only the camp office (owner, admin or manager) can do this (2); no connection — try again`. A "page is reloading" answer reads "this page is reloading — try again after it loads". Odd text coming back from the database is shown safely (`<b>x</b>` appears as plain text).
  - **New test.** `tests/link_admin_messages.test.js` fails 3 of 3 against yesterday's page and passes 3 of 3 today. Two of its checks only look for text in the page file. My probe above covers the behaviour they don't.
  - **Join request.** Approve/decline now goes through the same plain-words function (code read: `campistry_link_admin.html:4419`).
  - **Staff outside the office:**
    - Badges show "—" and the Invited / Signed up counts show "—" (code read: `:4297`, `:4350-4351`).
    - The CSV says "office only", with a note explaining why codes are missing (`:4472`, `:4486`).
    - The flag is set from the server's answer before the list is drawn (`:4264`, then `_renderParentFamilies()` at `:4281`).
- **Reload notices:** all five messages in `supabase_client.js` now say "in another tab or on another computer". The erase guard's behaviour is unchanged (test:keys 42/42).
- **Browser cache:**
  - 21 pages load `supabase_client.js?v=20260923-08`, and no page loads any other version.
  - Lite's `LITE_ASSET_VERSION` is `20260923-12`.
  - `campistry_me.js` did not change in these commits.
- **Leftovers:** the diff adds no debug switches, TODOs or secrets. The `console.log` lines in the diff are old load-error messages; only their version number changed.

## What I did NOT check (and why)
- **Real Supabase answering the new 261.** I have no live database. Everything above ran on a local copy built from the same migration files.
- **The Parents page in a real browser as a non-office staff member.** I ran its functions in isolation and read the rest of the code. I did not log in as a scheduler.
- **The native Lite app (Capacitor build).** Only you can rebuild it. Its copy of `supabase_client.js` comes from `mobile/campistry-lite/scripts/sync-www.js`.
- **What a switched-off family sees in the parent app.** The function behind the parent app's feature list is not in the test migration chain.
- **Auto Builder (TED-005):** deferred by you. It is still the same 14 failures.

## Things only you can check (click-by-click)
1. **Run migration 261 again, even if you ran it before.** In Supabase, go to **SQL Editor** → **New query**. Paste the whole of `migrations/261_only_the_camp_office_writes_parent_invites.sql` and click **Run**. It is safe to run more than once.
2. **Run the checking script.** In a new SQL Editor query, paste the whole of `scripts/verify_identity_chain.sql` and click **Run**. The rows for **260** and **261** should both say **ok**. If 261 says "run 261 again", step 1 did not take. Now the script can tell you that itself.
3. **Make sure the new files are live.**
   1. Open the Parents page (Link admin) in Chrome and press F12.
   2. Open the **Network** tab, tick "Disable cache", and reload.
   3. Type `supabase_client` in the filter box. It should show `?v=20260923-08`.
4. **Try the family switch with test campers.**
   1. Add a test camper with a parent email you control. Wait 10 seconds.
   2. Unenroll that camper. In the F12 **Console** you should see "Parent sign-up: disconnected 1 invite".
   3. Add a second test camper to a different test family. Unenroll nobody. Save twice. The console should never say that family was disconnected.
5. **As a scheduler (not owner/manager),** open the Parents page. The badges and the Invited / Signed up counts should show "—", with a note that only the camp office can see invitations.
6. **Native Lite app:** rebuild it so it picks up the new `supabase_client.js`.
