# Ted's report: camper ID number, check of the TED-021/028/031/032 fixes, 2026-09-23 (ninth visit)

## Verdict: 🟡 Mostly good, some issues

I checked the one new builder commit (`b92dcdc`) and re-tested every open finding myself on a scratch database. **The two ways the wrong family could become a child's parent are now closed:**
- An erased child no longer comes back on a new child's number.
- A scheduler can no longer read families' access codes.

I found four smaller problems, none of which gives a family the wrong child:
- An office tab left open since the morning can still make children added since then disappear from the roster.
- Any parent can pull up the whole camp's list of children's names and numbers.
- A leftover record with no name on it can move onto a new child who was deliberately given an erased child's number.
- The check script's new table test is narrow.

## The numbers
Tests run: 3,433 · Passed: 3,419 · Failed: 14 (real bugs: not sorted: all 14 are the auto-scheduler tests you deferred (TED-005) · out-of-date tests: 0 · my machine: 0)

| Suite | Run | Passed | Failed |
|---|---|---|---|
| Unit (`npm test`) | 3,284 | 3,270 | **14** (`auto_full_day.test.js` 174-195, the same 14 as every visit) |
| Database (`npm run test:pg`) | 50 | 50 | 0 (against 89 migrations) |
| Roster keys (`npm run test:keys`) | 31 | 31 | 0 |
| Lite + Health (`npm run test:lite`) | 12 | 12 | 0 |
| Smoke (`npm run test:smoke`) | 32 | 32 | 0 |
| 600-camper scale (`npm run test:scale`) | 24 | 24 | 0 |

These match the builder's numbers exactly. The name inventory check (`--check`) says "up to date", and part A is 0.

## What's wrong (most serious first)

### TED-033 🟠 (new) A tab left open since the morning removes children added since then
- **What a user would see:**
  1. Office computer A has had Me open since the morning.
  2. On computer B, someone adds Sara.
  3. Computer A saves.
  4. Sara is gone from the roster and shows as having left. Her number stays hers, so no other family gets her, but she has to be added back by hand.

  The builder's new fix brings back only children added **after an erase**. A child added in the ~8 seconds between deleting a camper and the erase actually running is still lost. So is any child added when there was no erase at all.
- **How sure I am:** Confirmed on the scratch database. **Suspected in real use:** the page does re-load when another computer saves (realtime), so this needs a tab that missed that, such as a sleeping or offline laptop, or a dropped connection. This is the same assumption the builder's own tests make.
- **Proof:** my script `v9/t33.sql` (scratchpad), each step a separate save:
  - **No erase at all:** morning copy `{Moshe #1}`; Sara #2 added; the morning copy saves. Roster is `{"Moshe Gold"}`, and `camp_people` has `2 | Sara Levi | departed = t`.
  - **Erase, with Sara added before it ran:** Avi #2 removed; Sara added (#3); `erase_camper(…,2,true)` = success; the morning copy saves. Roster is `{"Moshe Gold"}`, and `3 | Sara Levi | departed = t`.
  - **Why:** the put-back step only covers children first seen at or after the erase (`migrations/260_numbers_stay_with_their_child.sql`, the `v_stale` block: `p.first_seen >= v_stale`). The Me page still replaces the whole roster on save (`integration_hooks.js:879-897`, a top-level merge only).
- **What to ask the builder for:** "A Me tab opened earlier still drops children added since (with no erase, or added before the erase ran). Make a roster save never remove a child it has never seen: e.g. send the roster version the tab loaded, and put back any child first seen after it."

### TED-034 🟠 (new, partly older) Any parent can see every child's name and camper number at the camp, including children who left or were erased
- **What a user would see:** Nothing on screen. But a parent who is logged in to the portal can ask the server directly for the camp's number list. They get every current child's full name and number, every child who left, and now also the names of erased children.
- **How sure I am:** Confirmed on the scratch database.
- **Proof:** my script `v9/tpar.sql`:
  - Sara's mother (a parent, not staff: `camp_staff_member` = f, `camp_reader` = t) called `get_camper_numbers`.
  - She got `"campers": {"Sara Levi": 3, "Moshe Gold": 1}`, `"departed": {"4": "Rivka Stern"}` and `"erased": {"2": "Avi Gold"}`.
  - **Why:** the function lets any "camp reader" in, and a camp reader includes parents (`migrations/260_numbers_stay_with_their_child.sql:697`; `migrations/183_lock_down_camp_scoped_readers.sql:103-104`). Only the Me page (office) calls it (`campistry_me.js:352`).
  - The current and departed lists have been open to parents since 253. The erased names are new in this commit. An erase is meant to remove a child, yet their name is kept (`camp_erased_people.key`) and now handed out.
  - A number is not a login, so this does not let anyone claim a child. It is a privacy leak.
- **What to ask the builder for:** "get_camper_numbers answers any parent with the whole camp's names and numbers (plus departed and erased names). Make it staff-only (camp_staff_member), and don't hand out erased children's names."

### TED-035 🟡 (new, left over from TED-021) An erased number typed for a new child can pick up an old record that has no name on it
- **What a user would see:**
  1. The office erases Avi (#2).
  2. They deliberately type #2 for a new child, Sara. The page now shows a note saying #2 belonged to Avi.
  3. A tab from the morning saves.
  4. A record of Avi's that carried only his number and no name (in my test, a note "allergic to nuts") now reads as Sara's.
- **How sure I am:** Confirmed on the scratch database. Not checked: which real records in the app carry a number with no name, and how often that happens.
- **Proof:** `v9/t33.sql` T3. After the stale save:
  - `campistryMe.notes = [{"text":"allergic to nuts","camperId":2}]`, with #2 now Sara's.
  - In the same run, the named records were cleaned correctly: the enrollment named `"avi gold "`, `bunkAssignments["Avi Gold"]` and Go's `addresses["Avi Gold"]` all lost the #2.
  - I raised the nameless case last visit. This commit's fix matches by name only.
- **What to ask the builder for:** "After erasing #2, a stale save still puts #2 back on records that carry no name, and those land on whoever is given #2 on purpose. Either strip #2 from any record in a save that also carries the erased child's stale roster entry, or don't let #2 be typed for a new child at all."

### TED-036 🟡 (new) The check script's 261 table test only looks for the word "scheduler"
- **What a user would see:** The check script can say "ok" for 261 while the invitations table is still open, if:
  - row security was turned off;
  - or another broad read rule, under a different name, exists on the live database.
- **How sure I am:** Confirmed on the scratch database.
- **Proof:** `scripts/verify_identity_chain.sql`'s new check is `policyname = 'link_parent_invites_select' AND qual ~ 'scheduler'`.
  - I turned row security off and dropped the rule: 261 said **ok**.
  - I added a rule `staff_read_all … USING (camp_id = get_user_camp_id())`: 261 said **ok**.
  - With `counselor` or `scheduler` inside the named rule, it correctly said "run 261 again".
- **What to ask the builder for:** "Make the 261 row also fail when row security is off on link_parent_invites, or when any SELECT rule other than the office rule and the parent's-own rule exists."

### TED-005 🟠 (still open, deferred by you) 14 auto-scheduler tests still fail
- The same 14. I didn't investigate them.

## What I confirmed is working
- **TED-021 is fixed in the exact order I reported (closed).** I re-ran last visit's script `t031.sql`, unchanged, on a fresh full-chain database. Now:
  - Sara, left without a number, gets **#3** on her own, not the erased #2.
  - After the morning tab's roster + Me save, the roster is `{Sara #3, Moshe #1}`, and Avi does not come back.
  - Avi's enrollment has no number.
  - Sara's mother: `_parent_owns_person(camp, 2)` = **f**, and she sees only Sara #3.
- **The new tests catch the fix being removed.**
  - I removed the "never hand out an erased number" line: pgtest 260 failed with "the erased #2 was handed out by itself".
  - I removed the "put back children added since" step: it failed with "the morning tab made Sara vanish".
  - I restored both: it passed.
- **Name-matching gaps from last visit are fixed.** An enrollment named `"avi gold "` and records filed under Avi's name (`bunkAssignments`, Go `addresses`) lost the erased number (T3).
- **TED-028 is fixed (closed).** On the scratch database, running as the real logged-in role under 261's rule and the parent's-own rule:

  | Who | Invitations they can read |
  |---|---|
  | Scheduler | 0 |
  | Counselor | 0 |
  | Manager | 1 |
  | Owner | 1 (with the code) |

  A scheduler's direct `UPDATE … SET user_id` changed 0 rows. I put `scheduler` back into the rule, and pgtest 261 failed with "a scheduler read families' access codes from the table".
- **TED-031 is fixed (closed).**
  - I put 032's old `get_camp_parent_invites` back: the check script said "run 261 again".
  - I re-ran 261 twice: both runs succeeded, and the check then said ok.
  - With `scheduler` back in the table rule, the check also said "run 261 again".
  - 261's header now says to run it again if an earlier copy was run.
- **TED-032 is fixed (closed, by reading the code).**
  - Me shows "The parent portal still uses the old email — only the camp office … can change it." (`campistry_me.js:5911`).
  - Link admin adds "Only the camp office (owner, admin or manager) can see families' invitations and access codes." (`campistry_link_admin.html:4253-4263`).
  - **Small leftovers:** Link admin still shows "No invite" badges under that note. Its "invite all" says "N failed" without saying why. Approving a join request says "Could not resolve: not_camp_office".
- **The erased-number warning works.** It uses the same number format as the server's list (`campistry_me.js:5756`). The page's next number now starts above every erased number (`:408-410` with the server's new `next`).
- **Name inventory (TED-002, closed).** Part A is 0, and `--check` says "up to date". The two items left open last time (TED-021, TED-028) are both closed now. The new findings above are tracked on their own.
- **Browser caching.** `campistry_me.js` is loaded only from `campistry_me.html`, now `?v=20260923-26`.
- **Leftovers.** The diff adds no `console.log`, TODO, FIXME or debug switch.

## What I did NOT check (and why)
- **The live database.** I didn't connect, so I don't know whether 261 has been re-run there, or whether any other read rule exists on the invitations table.
- **Any page in a browser as a scheduler or parent.** The TED-032 messages were read in the code, not seen on screen.
- **How often a stale tab really saves** (TED-033). Realtime refresh should cover most open tabs.
- **Which real records carry a camper number but no name** (TED-035).
- **The 14 auto-scheduler failures** (deferred by you).

## Things only you can check (click-by-click)
1. **Run 260 and 261 again.** Supabase Dashboard → SQL Editor → New query → paste all of `migrations/260_numbers_stay_with_their_child.sql` → Run. Then do the same with `migrations/261_only_the_camp_office_writes_parent_invites.sql`. If either stops with "does not look the way this file expects", copy that message to the builder.
2. **Run the check.** New query → paste `scripts/verify_identity_chain.sql` → Run. The 260 and 261 rows should both say `ok`.
3. **Check the invitations table's read rules yourself (read only),** because the check script only looks at one rule (TED-036). New query, paste and Run:
   `SELECT policyname, cmd, qual FROM pg_policies WHERE tablename = 'link_parent_invites';`
   `SELECT relrowsecurity FROM pg_class WHERE relname = 'link_parent_invites';`
   You should see:
   - the select rule listing only owner, admin and manager;
   - a parent rule `user_id = auth.uid()`;
   - insert, update and delete rules for owner and admin;
   - `true` on the second query.

   Anything else, send it to the builder.
4. **See whether staff claimed families while the hole was open (read only).** New query, paste and Run:
   `SELECT i.camp_id, i.parent_email, u.email AS claimed_by, i.created_at FROM link_parent_invites i JOIN auth.users u ON u.id = i.user_id WHERE lower(u.email) <> lower(i.parent_email) ORDER BY i.created_at DESC;`
   Look at any row whose `claimed_by` is one of your staff.
5. **Until TED-033 is fixed:** after a laptop has been asleep or offline, reload the Me page before making changes.
