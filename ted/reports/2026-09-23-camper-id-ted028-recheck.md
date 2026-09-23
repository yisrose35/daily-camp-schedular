# Ted's report: camper ID number, check of the TED-021/028/029/030 fixes, 2026-09-23 (eighth visit)

## Verdict: 🔴 Problems found

I checked the one new commit (`0909cee`) and re-tested every open finding myself. **Most of the fixes work.** Counselors and viewers can no longer read families' access codes and claim a child. The check script no longer crashes. The Me page now shows a plain message. Go's addresses follow a renumber. But two things still break "only the right family becomes a child's parent":
1. **Erasing a child still goes wrong in its most ordinary form.** You erase Avi. The camp gives the next new child, Sara, Avi's old number on its own. Then an office tab that was open since the morning saves. Sara disappears from the roster and Avi comes back **on Sara's number**, with Sara's mother as his parent.
2. **A staff member with the *scheduler* role can still read every family's access code** straight from the invitations table, and claim a child with it.

## The numbers
Tests run: 3,433 · Passed: 3,419 · Failed: 14 (real bugs: not sorted: all 14 are the auto-scheduler tests you deferred (TED-005) · out-of-date tests: 0 · my machine: 0)

- Unit tests (`npm test`): 3,284 run, 3,270 passed, **14 failed**. These are the same `auto_full_day.test.js` tests (174-195) as on every visit.
- Database tests (`npm run test:pg`): 50 of 50 passed, against 89 migrations.
- Roster-key browser test: 31 of 31 passed. Lite + Health: 12 of 12. Smoke: 32 of 32. 600-camper scale test: 24 of 24.

These match the builder's numbers exactly. **The tests don't cover either of the two problems below.**

## What's wrong (most serious first)

### TED-021 🔴 (still open, now more serious) An erased child comes back on the next new child's number, and that child's parent gets him
- **What a user would see:**
  1. The office erases Avi (#2).
  2. They add a new camper, Sara, and don't type a number. **The camp gives her #2 on its own.** She is invited, and her mother signs up.
  3. Then a Me tab that someone opened earlier in the day saves.
  4. Sara is gone from the roster. "Avi Gold" is back, with number #2 and his old enrollment.
  5. The camp's list of people says #2 is Avi Gold. Sara's mother's invitation still points at #2, so every check that goes by number says she is **Avi's** parent.

  Last visit I suggested you avoid handing out an erased number. That advice doesn't help, because the camp picks the number itself.
- **How sure I am:** I confirmed this on a scratch database built from the full chain at `0909cee`. It needs an old tab to save, the same assumption the builder's own tests 6, 6b and 6c make.
- **Proof:** my script `t031.sql` (scratchpad):
  - The erase returned `number_is_free = true`.
  - I added Sara with no number, and she got `person_id 2`.
  - `upsert_parent_invite` for her mother returned success. The invitation has `person_ids [2]`, and I marked it claimed.
  - The stale tab then saved `app1` and `campistryMe` in one upsert, the way the Me page saves.
  - **After that save:**
    - The roster is `{"Avi Gold": {camperId 2}, "Moshe Gold": {camperId 1}}`, and Sara is not in it.
    - `camp_people` shows `2 | Avi Gold` (not departed), and there is no Sara.
    - The enrollment is `{"camperName":"Avi Gold","camperId":2,"status":"enrolled"}`.
    - As Sara's mother, `_parent_owns_person(camp, 2)` = **t**.
  - **Why the stale tab can drop Sara.** The Me page merges only top-level keys before saving, so a tab's whole `camperRoster` replaces the cloud copy (`integration_hooks.js:878-893`). The roster trigger then treats "Sara missing, Avi on #2" as Sara being renamed to Avi.
  - **Why the new fix doesn't help here.** The new step in `_carry_moved_numbers` (`migrations/260_numbers_stay_with_their_child.sql`, the "once a NEW child holds it" loop) only acts when the current holder's name differs from the erased child's. By the time the Me document is checked, the same save has already renamed #2 to "Avi Gold".
  - **The builder's fix does work for the exact case they tested** (section 6c: only the Me and Health documents save, not the roster). I removed the new loop, and pgtest 260 failed with "TED-021: Sara (#2) was given the erased child's records". I put it back and the test passed.
  - **Smaller gaps in the same fix.** It only knows a stale record by the name written inside it. In the same scratch test (erase, then Sara #2, then a stale save), these kept #2:
    - a record with no name in it (`{"camperId":2,"amount":900}`);
    - names that differ only in capitals or a trailing space (`"avi gold"`, `"Avi Gold "`);
    - Go's saved address for Avi, which is filed under his name rather than holding it (`addresses: {"Avi Gold": {"_camperId": 2}}`). In a camp that uses Go without the Me roster, Go builds its camper list from those addresses (`campistry_go.js:1426-1436`).
- **What to ask the builder for:** "Erase → Sara auto-gets #2 → a stale Me tab saves app1+campistryMe: Sara vanishes and #2 becomes Avi Gold, owned by Sara's mother. Either never hand out an erased number automatically (and warn if typed), or make the roster trigger refuse an erased child's name on a number someone else now holds. Add a pgtest that includes the stale app1 save."

### TED-028 🟠 (still open, narrower) A *scheduler* can still read every family's access code and claim a child
- **What a user would see:** Nothing. A staff member with the scheduler role reads the invitations table directly, gets each unclaimed family's access code, and types it into the parent portal on their own login. From then on they are that child's parent. Counselors and viewers can't do this any more.
- **How sure I am:** I confirmed this on the scratch database, using the table's real read rule.
- **Proof:**
  - The table's read rule lets **owner, admin, manager and scheduler** read every column, including `access_code` and `token` (`migrations/098_manager_role_rls.sql:88-94`).
  - I recreated that rule and set up a camp with a scheduler (`get_user_role()` = `scheduler`):
    - `get_camp_parent_invites` → `not_camp_office` (the new gate works);
    - but `SELECT parent_email, access_code, token FROM link_parent_invites` as `authenticated` → `gold@t | 43AD-225E | tok-gold`;
    - `claim_invite_by_code('43AD-225E')` → `success: true`;
    - `_parent_owns_person(camp, 5)` = **t**.
  - 261's own rule says schedulers are not the office, so this is a way around it.
  - **Why no test caught it.** Pgtest 261 runs as the database superuser against a table with no read rules.
- **What to ask the builder for:** "Schedulers can still SELECT access_code/token from link_parent_invites (098's select policy). Make the table's select policy office-only (owner/admin/manager), and add a pgtest that runs as `authenticated` with the real policy: a scheduler reads no codes and cannot claim a family."

### TED-031 🟠 (new) If you already ran 261 after my last report, you're still exposed, and the check script says "ok"
- **What a user would see:** Last visit I told you to apply 261 straight away. The version you applied then didn't include the counselor fix. The new part of 261 only takes effect if you **run 261 again**, and nothing tells you to. The check script's 261 line only looks at the older part, so it says "ok" either way.
- **How sure I am:** Confirmed on a scratch database (the chain with 261 but without 260).
  - I put the old, ungated `get_camp_parent_invites` back (the function-definition check for `_is_camp_office` is now `f`).
  - `verify_identity_chain.sql` still printed `261  only the camp office writes parent invitations | ok`.
- **Proof:** `scripts/verify_identity_chain.sql:513-520` checks only `upsert_parent_invite`. The top of 261 says "Safe to run twice", but nowhere does it say "run it again".
- **What to ask the builder for:** "Make verify_identity_chain's 261 row also check that get_camp_parent_invites, resolve_join_request, set_parent_invite_email, set_parent_billing_access (and revoke_orphaned_parent_invites if present) contain _is_camp_office, and say 'run 261 again' if not."

### TED-032 🟡 (new, suspected) Some office actions now fail without a word for staff who aren't the office
- **What a user would see:** A scheduler with Me access changes a family's parent email. The page says nothing, but the parent's portal invitation stays on the old email. The Link admin Parents page shows "No invite" for every family to anyone who isn't the office, instead of saying they lack access.
- **How sure I am:** Suspected.
  - **Read in the code.** `campistry_me.js:5901-5905` shows no message on failure, and `campistry_link_admin.html:4251-4258` shows "No invite" when the list is refused.
  - **Not checked.** I didn't confirm in a browser which roles can open those screens.
- **What to ask the builder for:** "When set_parent_invite_email or get_camp_parent_invites returns not_camp_office, show 'only the camp office can…' instead of silently doing nothing or showing 'No invite'."

### TED-002 🟡 (still open) The move to camper numbers is not finished
- Part A of the name inventory is still 0, and `node scripts/camper_name_inventory.js --check` says "up to date".
- Go's `_camperId` now follows a renumber, so that part is done.
- What remains is TED-021 and TED-028.

### TED-005 🟠 (still open, deferred by you) 14 auto-scheduler tests still fail
- The same 14. I didn't investigate them.

## What I confirmed is working
- **Counselors and viewers are shut out (the TED-028 fix, as claimed).**
  - Pgtest 261 passes.
  - I put the old list function back, and the test failed straight away with "a counselor read the families' access codes". After re-running 261, it passed again.
  - In the scratch database, all five functions contain `_is_camp_office` and none still says `not_a_member`. They stayed `SECURITY DEFINER`, and `authenticated` can still execute them.
- **The 122 version is handled too.** I loaded 122's `revoke_orphaned_parent_invites` (the same text as in `APPLY_BUNDLE.sql`), then ran 261. It was rewritten to `IF NOT public._is_camp_office(p_camp_id, caller)`. A second run of 261 also succeeded.
- **The check script no longer crashes (TED-029, closed).**
  - With 261 but no 260, it prints "apply 260" on the 260 line and "ok" on the 261 line, with no error.
  - With both applied, it prints ok / ok.
- **The Me page's invite message (TED-030, closed).** On `not_camp_office` it now says "Only the camp office (owner, admin or manager) can invite parents." (`campistry_me.js:14445`, `:14466`).
- **The erase fix works in the order the builder tested.** Pgtest 260 section 6c passes, and it fails with the fix removed.
- **Go follows a renumber.** I used Go's real saved shape (`addresses: {"Moshe Gold": {"_camperId": 1}}`). After 1→7 it held 7. An old Go tab that saved `_camperId: 1` was corrected to 7. The builder's test uses a route-stop shape Go doesn't actually save, but the mechanism works on both.
- **Browser caching.** `campistry_me.js` is loaded from `campistry_me.html` only, now at `?v=20260923-25`.
- **Leftovers.** The diff adds no debug switches, TODOs or `console.log`.

## What I did NOT check (and why)
- **The live database.** I didn't connect. I can't tell whether you already applied the older 261, or whether any scheduler or counselor has claimed a family.
- **Which roles can open the Me invite button or the Link admin Parents page** (TED-032). I didn't log in as a scheduler.
- **Whether live function text matches 261's pattern.** If a live function looks different from the repo, 261 stops with "does not look the way this file expects". I checked against the repo's text only.
- **How often an office tab stays open and stale in real use** (TED-021). The realtime sync may refresh an open tab. A sleeping or offline laptop won't be refreshed.

## Things only you can check (click-by-click)
1. **Run 261 again** (even if you ran it before). Supabase Dashboard → SQL Editor → New query → paste all of `migrations/261_only_the_camp_office_writes_parent_invites.sql` → Run. If it stops with "does not look the way this file expects", copy that message to the builder.
2. **Confirm the new part took (read only).** New query, paste and Run:
   `SELECT proname, pg_get_functiondef(oid) ~ '_is_camp_office' AS office_only FROM pg_proc WHERE proname IN ('get_camp_parent_invites','resolve_join_request','set_parent_invite_email','set_parent_billing_access','revoke_orphaned_parent_invites');`
   Every row should say `true`.
3. **See who can read access codes today (read only).** New query, paste and Run:
   `SELECT cu.role, u.email FROM camp_users cu JOIN auth.users u ON u.id = cu.user_id WHERE cu.role = 'scheduler';`
   Everyone listed can still read families' codes until TED-028 is fixed.
4. **See whether staff claimed families (read only).** New query, paste and Run:
   `SELECT i.camp_id, i.parent_email, u.email AS claimed_by, i.created_at FROM link_parent_invites i JOIN auth.users u ON u.id = i.user_id WHERE lower(u.email) <> lower(i.parent_email) ORDER BY i.created_at DESC;`
   Check any row whose `claimed_by` is one of your staff.
5. **Until TED-021 is fixed, don't erase a camper while other office computers have the Me page open.** Ask everyone to close and reopen Me first. After an erase, have the next new camper typed with a number that was never used, rather than leaving the number blank.
