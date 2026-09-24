# Ted's report: camper ID fifteenth re-check (TED-047 fix), 2026-09-23

## Verdict: 🟡 Mostly good, some issues

I checked the one code change since my last visit (commit `d049454`). It fixes TED-047: the "is this family still at camp?" switch now goes by camper number. I proved that myself on a scratch copy of the database. Every test count matches what the builder reported. I found two new small items. The one you need to know about is TED-048. If you already ran migration 261 in Supabase before today, you must run it again. The checking script will wrongly tell you it is fine.

**Is the camper-ID work complete in the code, apart from your live steps? Yes.** Every decision about which child a record, a payment or a photo belongs to, and who counts as a child's parent, goes by the camper's number. The family on/off switch (TED-047) now does too. Two things are left. TED-048 is about your checking script, not the app. TED-049 is a rare case where a family whose child is still at camp gets switched off. It never gives anyone the wrong child. Neither one blocks a "yes".

## The numbers
Tests run: 3,451 · Passed: 3,437 · Failed: 14 (real bugs: 14, the deferred TED-005 · out-of-date tests: 0 · my machine: 0)

- `npm test`: 3,291 run, 3,277 passed, 14 failed. All 14 failures are in `auto_full_day.test.js` (run on its own: 9 pass, 14 fail). That is TED-005, which you deferred.
- `npm run test:pg`: 50 passed, 0 failed
- `npm run test:keys`: 42 checks, all passed
- `npm run test:lite`: 12 checks, all passed
- `npm run test:smoke`: 32 checks, all passed
- `npm run test:scale`: 24 checks, all passed

These match the builder's numbers exactly.

## What's wrong (most serious first)

### TED-048 🟠 The checking script says "261 ok" on a database that has the earlier copy of 261
- **What a user would see:** Nothing they would notice. But if you already ran migration 261 in Supabase, your database has the older copy. That copy does not have today's by-number switch. The Me page notices the switch is missing and quietly goes back to deciding by name, so the TED-047 problem stays live. Your checking script (`verify_identity_chain.sql`) still prints "261 … ok", so you have no way to tell. This is the same kind of problem as TED-039 was for 260.
- **How sure I am:** Confirmed.
- **Proof:** On a scratch copy with every migration, I removed only the new 3-argument `revoke_orphaned_parent_invites(uuid,jsonb,jsonb)`, which leaves exactly what the earlier 261 created. The script still printed `1 is it there | 261  only the camp office writes parent invitations | ok`. The script's 261 check (`scripts/verify_identity_chain.sql:526-557`) only asks whether each version of the function contains `_is_camp_office`. It never asks whether the 3-argument version exists. Running today's 261 on top of the old copy works (`261 over old-261 ok`), so re-running it is the fix on your side.
- **What to ask the builder for:** "TED-048: make verify_identity_chain.sql say 'run 261 again' when public.revoke_orphaned_parent_invites(uuid,jsonb,jsonb) does not exist, and add that case to whatever checks the verify script."

### TED-049 🟡 The by-number switch can turn off a family whose child is still at camp
- **What a user would see:** Rarely, a parent loses live camp features (canteen, mail, pickup) in the parent app even though their child is still enrolled. The by-name version kept these families connected. I found three ways it can happen:
  1. **A sibling who hasn't been matched to the family's invitation yet.** The invitation lists Avi (#1) and Sara, but Sara's number isn't filled in yet. When Avi leaves, the family is switched off, even though Sara's name is on the roster. This fixes itself about 4 seconds later: the Me page re-sends the family's invitation, which fills in Sara's number and switches them back on.
  2. **The Me page has the wrong number for a child for a few seconds.** The page sends its own copy of the numbers. The page sometimes corrects its copy from the server, which is what the "camper numbers were already taken and have been changed" message is about. That correction runs about 7 seconds after a save. The switch-off check runs about 4 seconds after a save, so for that gap it uses the old number. The child's family is switched off and stays off until the page is reloaded or something about that family changes.
  3. **A list of numbers with no usable number in it.** Such a list (e.g. `[null]`) switches off every family that has a number. The safety rule "never switch off on an empty list" counts the items, not the usable numbers. Only the camp office can call this, and the Me page never sends such a list (it drops blanks first). So this is a missing safety net, not a live bug.
- **How sure I am:** Confirmed in the database for all three. For case 2, the 4-second and 7-second timings come from reading the code, and I have not seen the wrong number happen in a browser. How often cases 1 and 2 happen for real is suspected, not proven.
- **Proof:**
  - Scratch DB (`scratchpad/v15/edge.sql`):
    - Case 1: invitation `[1, null]` for "Avi Katz","Sara Katz", with numbers `[4,6]` sent → `revoked: 1`, `camp_connected = f`.
    - Case 2: a family on `[6]` with the page sending `[4,5]` → switched off.
    - Case 3: `'[null]'` → `revoked: 3`, all off.
  - `scratchpad/v15/s1real.sql`: re-sending the invitation fills the slot (`[1, null]` → `[1, 2]`), which is why case 1 fixes itself.
  - Timings: `campistry_me.js:14190` (provisioning after 4 s, then the switch-off check at `:14314`), `:1086` (number correction after 7 s). The check only ever switches families off (`migrations/261_…sql:217`), and `_apiLastSig` (`:14306`) skips re-sending unchanged families. So in case 2 nothing turns the family back on until a reload.
- **What to ask the builder for:** "TED-049: in revoke_orphaned_parent_invites (3-arg), keep an invitation connected if any of its numbers belongs to a camper the database itself has as enrolled (camp_people), or if any of its null slots' names is on the roster. Also treat a p_roster_ids list with no usable number as empty. Add pgtest cases for [1,null] with an enrolled sibling, for a page number that is off by one, and for '[null]'."

## What I confirmed is working
- **TED-047 closed. The switch now goes by number.**
  - I re-ran my own scenario from last time (`scratchpad/v15/t047.sql`, adapted from v14): Katz's Avi #1 leaves, and a different Avi Katz is enrolled and gets #3. With the numbers the database holds, the new switch gives `revoked: 1` and the Katz invitation `[1]` is now `camp_connected = f`. The old by-name call on the same data still gives `revoked: 0`, which is the bug it replaces.
  - **Putting the old logic back:** on a scratch copy, I switched off the by-number branch of the new function, then ran the builder's pgtest 261. It fails with "TED-047: the departed Avi #1's family is still connected because a new child shares his name". With the real function it passes. So the new test really does guard the fix.
- **Office-only:** as a counselor, both the 3-argument and 2-argument versions return `not_camp_office`. A manager's call goes through. `anon` cannot run either version.
- **Empty lists:** `[]`, `NULL` and `{}` all return `skipped: empty_roster` and switch nothing off (but see TED-049 case 3).
- **Invitations with no number** are still decided by name. The builder's pgtest covers this with Rina, and my run did the same.
- **Numbers written as text** (`"6"`, `"#4"`) are read correctly.
- **The Me page's call** (`scratchpad/v15/sweep_probe.js`): I ran the real `_sweepOrphanedParentInvites` from `campistry_me.js` against a stand-in database.
  - It sends `p_roster_ids = [3,2]`, leaving out an unenrolled camper and a camper with no number. `"0002"` is read as 2.
  - On a `PGRST202 "Could not find the function"` answer, it retries once with the 2-argument form.
  - On any other error, or an office refusal, it does not retry.
- **261 applies cleanly:** twice in a row on a full build, and on top of the earlier copy of 261. The full build prints `260 … ok` and `261 … ok`. Two versions of the function now exist side by side, as intended.
- **Browser cache:** `campistry_me.js?v=20260923-30` is the only version any page loads.
- **Name inventory:** `node scripts/camper_name_inventory.js --check` → "up to date".
- **Leftovers:** the diff has no debug switches, TODOs or secrets.

## What I did NOT check (and why)
- **Real Supabase/PostgREST answering the 3-argument call.** I have no live PostgREST. The error text the page looks for is PostgREST's usual `PGRST202` wording, but I only tested it against a stand-in.
- **No automated test covers the page side.** No browser test checks that the Me page sends `p_roster_ids`, or that it falls back to the old form. I checked it only with my own probe. I've filed this under TED-049's ask rather than as its own finding.
- **What a switched-off family actually sees in the parent app.** The function that builds the parent app's feature list is not in the test migration chain.
- **Whether your live database has the earlier 261** (TED-048). Only you can see that.
- **The native Lite app (Capacitor build).** Only you can rebuild it.
- **Auto Builder** (TED-005): deferred by you.

## Things only you can check (click-by-click)
1. **Run migration 261 again, even if you ran it before.** Open Supabase → **SQL Editor** → **New query**. Paste the whole of `migrations/261_only_the_camp_office_writes_parent_invites.sql` and click **Run**. It is safe to run more than once.
2. **Confirm the new switch exists** (the checking script can't tell you yet, see TED-048). In a new SQL Editor query, paste `SELECT count(*) FROM pg_proc WHERE proname = 'revoke_orphaned_parent_invites';` and click **Run**. It should say **2**. If it says 1, step 1 did not take.
3. **Make sure the new page is live.** Open the Me page in Chrome and press F12. Open the **Network** tab, tick "Disable cache", and reload. Type `campistry_me` in the filter box. The file should show `?v=20260923-30`.
4. **Try it with test campers.** Add a test camper with a parent email you control. Wait 10 seconds, then remove the camper (Unenroll). In the F12 **Console** you should see "Parent sign-up: disconnected 1 invite". In the parent app, logged in with that email, live camp features should be gone.
