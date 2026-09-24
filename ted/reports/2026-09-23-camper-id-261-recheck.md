# Ted's report: camper ID number, check of 261 and the 260 repairs, 2026-09-23 (seventh visit)

## Verdict: 🟡 Mostly good, some issues

I checked the one new commit (`bd61488`) and re-tested every open finding myself. **The stranger hole (TED-023) is closed.** A logged-in account with no role at your camp can no longer make itself a parent. **The slow save (TED-024) is fixed**, and so are the renumber undo (TED-025), the missed split child (TED-026) and the renumber-hint safety net (TED-027). Two things are still wrong. First, anyone on your staff list, even a counselor, can still become the parent of any family that hasn't signed up yet, by another route (new TED-028). Second, an erased child's payment can still land on a new child in one order of events (TED-021, now narrower). **261 is safe to apply now, on its own.** 260 is no longer blocked on speed.

## The numbers
Tests run: 3,403 · Passed: 3,389 · Failed: 14 (real bugs: not sorted, all 14 are the auto-scheduler tests you deferred (TED-005) · out-of-date tests: 0 · my machine: 0)

- Unit tests (`npm test`): 3,284 run, 3,270 passed, **14 failed**. These are the same 14 `auto_full_day.test.js` tests (174-195) as every visit.
- Database tests (`npm run test:pg`): 50 of 50 passed, against 85 migrations.
- Roster-key browser test (`npm run test:keys`): 31 of 31.
- Lite + Health: 12 of 12. Smoke: 32 of 32. 600-camper scale test: 24 of 24.

These match the builder's numbers exactly.

## What's wrong (most serious first)

### TED-028 🟠 Any staff member, even a counselor, can still become the parent of a family that hasn't signed up yet
- **What a user would see:** Nothing. A counselor (or a viewer) at your camp opens the list of parent invitations. The database hands every staff member the list, **with each family's private access code**. They type one of those codes into the parent portal on their own account and become that child's parent. From then on, the portal and every number-based check say "yes, this is their child". This only works on invitations no parent has claimed yet. It's staff only, not strangers, but 261 set the rule that counselors must not write invitations, and this goes straight around that rule.
- **How sure I am:** Confirmed on a scratch database built from the full chain plus 261. I loaded the exact functions from the repo: `get_camp_parent_invites` (032) and `claim_invite_by_code` (010).
- **Proof:**
  - The owner writes Moshe's parent's invitation. Its `person_ids` is `[5]`.
  - As a counselor, `upsert_parent_invite` is refused with `not_camp_office`, so 261 works.
  - As the same counselor, `get_camp_parent_invites(camp)` returned the invitation with `access_code` `A6D0-E1FD`.
  - `claim_invite_by_code('A6D0-E1FD')` returned `success: true`.
  - Then `_parent_owns_person(camp, 5)` = **t**, and `get_my_camper_ids` returns Moshe Gold, camperId 5.
  - **Why.** `migrations/032_bulk_parent_onboarding.sql:29-32` lets any `camp_users` member read the list. The list includes `token` and `access_code` (`:38-39`). `claim_invite_by_code` (`migrations/010_link_access_code.sql:34-80`) needs only the code, not a matching email.
  - **Same pattern, not tested.** `set_parent_invite_email` (034) and `resolve_join_request` (032) also accept any member. A counselor could point an unclaimed invitation at their own email, or approve their own join request.
  - **The builder's claim.** They said the other writers "already require camp membership … or a secret token/code". That's true, but membership includes counselors and viewers, and the "secret" code is handed to every member.
- **What to ask the builder for:** "get_camp_parent_invites, set_parent_invite_email and resolve_join_request accept any camp member, and the first hands out every family's access code — so a counselor can claim any unclaimed invite. Gate all three with _is_camp_office, and add a pgtest where a counselor reads the codes, claims one, and must not own the child."

### TED-021 🟠 (still open, narrower) An erased child's payment can still land on a new child who is given his number
- **What a user would see:** Avi is erased. The office gives a new child, Sara, Avi's old number #2. **Then** an office tab opened before the erase saves. Sara now has Avi's $900 payment, his enrollment and his sick visit.
- **How sure I am:** Confirmed on the scratch database. The fix works in the order the builder tested: erase, then the old tab saves, then Sara gets #2. It does not work in the order erase, Sara gets #2, then the old tab saves.
- **Proof:**
  - **After the erase (fixed).** The Me document was `payments [{amount 900, camperName "Avi Gold"}]`, with no number. That's correct.
  - **Sara given #2.** `camp_people` shows `2 | Sara Levi`.
  - **The old tab saves `campistryMe` and `campistryHealth`.** The Me document now has `{"amount": 900, "camperId": 2, "camperName": "Avi Gold"}` and `enrollments.e2 … "camperId": 2`. Health has `sickVisits [{"camperId": 2, "complaint": "cough", "camperName": "Avi Gold"}]`.
  - **Why.** `_carry_moved_numbers` removes an erased number only while nobody holds it: `AND NOT EXISTS (SELECT 1 FROM camp_people …)` in `migrations/260_numbers_stay_with_their_child.sql` (the erased-number loop). The builder's claim says "while the number is free", so they described this honestly. But the money still reaches the wrong child.
  - **The page doesn't warn.** It lets the office type a freed number: `personIdHolder` in `campistry_me.js:283-302` has no check for erased numbers.
- **What to ask the builder for:** "After an erase, a record that carries the erased number AND the erased child's name (camperName) should be detached even once a new child holds the number — or the page should refuse to hand out an erased number for a while. Add a pgtest: erase, Sara given #2, THEN the old tab saves; Sara must not have the $900."

### TED-029 🟡 The camp's check script stops with an error if 261 is applied before 260
- **What a user would see:** 261 says to apply it now, on its own. If you then paste `scripts/verify_identity_chain.sql` into the SQL Editor, you get "ERROR: function public.verify_invite_numbers() does not exist" and no results at all, not a line saying "apply 260".
- **How sure I am:** Confirmed on a scratch database with the chain up to 259, plus 261.
- **Proof:** psql reported the error at `scripts/verify_identity_chain.sql:604`, the end of its single SELECT. 261 itself applies cleanly without 260, and pgtest 261 passes there.
- **What to ask the builder for:** "verify_identity_chain.sql crashes when 260 isn't applied yet; guard the 260 checks with to_regprocedure so it says 'apply 260' instead."

### TED-030 🟡 (suspected) A scheduler with the Me page now gets a confusing error when sending a parent invitation
- **What a user would see:** A staff member with the *scheduler* role who can use the Me page presses "invite parent" and gets "Could not save invite: unknown. Run migration 011 in Supabase." Before 261 it worked. Refusing them may be what you want, but the message is wrong. Their silent updates to existing invitations now also fail without a word.
- **How sure I am:** Suspected. 261's rule allows only owner, admin and manager. The toast is `campistry_me.js:14463`. I didn't confirm in a browser that a scheduler can reach that button.
- **What to ask the builder for:** "Decide whether schedulers may send parent invites; if not, hide the button for them and show a plain 'only the office can invite parents' message on not_camp_office."

### TED-002 🟡 (still open) The move to camper numbers is not finished
- Part A of the name inventory is still 0, and `node scripts/camper_name_inventory.js --check` says "up to date". Remaining: TED-021 and TED-028. Go still stores `_camperId`, which the renumber carry doesn't rewrite. The carry reads only `camperId`, `personId`, `person_id` and `camper_id`.

### TED-005 🟠 (still open, deferred by you) 14 auto-scheduler tests still fail
- The same 14. I didn't investigate them.

## What I confirmed is working
- **TED-023 is fixed (closed).**
  - **Pgtest 261 passes, and it catches the hole.** I swapped in the old 131 `upsert_parent_invite` and it failed straight away: "a stranger wrote an invitation naming a child".
  - **Counselors are refused.** On my own scenario a counselor got `not_camp_office`.
  - **An owner's invitation with no list covers nobody.** It gets `[]`, and `_invite_covers_person` treats only a NULL list as the whole camp.
  - **Safe to apply either way round.** 261 applies on the chain without 260, and twice in a row. Applying 260 afterwards (twice) keeps 261's check.
  - **Direct table writes were already office-only.** The table rules allow inserts and updates to owner/admin only (`migrations/008_link_parent_invites.sql:65-79`).
- **TED-024 is fixed (closed).** The builder's timing test on my machine: **1.86 s** for 200 renumbers in one save, and **0.24 s** for an old tab's save. Last visit I measured 18.1 s for a similar save.
- **TED-025 is fixed (closed).**
  - **The server.** Moshe 1→7, then back with `renumberedFrom 7`. He is #1 again as one child, and the moves table holds only `7→1`. His $50 came back to #1. A tab that had seen #7 saved two payments on 7, and both landed on 1. A new child typed as #7 got #3, not #7.
  - **The real page.** Test:keys step 4e passes.
- **TED-026 is fixed (closed).** Pgtest 260 section 11 (my exact case: no birthday on the old record, one on the new, same parent email) passes. The pair is listed under needs_a_person and not repaired.
- **TED-027 is fixed (closed).** Pgtest 260 section 10: Tova's leftover hint moved nothing, and `1→7` stayed.
- **Carry and erase.** An erase now removes the erased number from money records but keeps the amounts (`$900` stays, number gone).
- **Browser caching.** `campistry_me.js` is loaded from one page only, now `?v=20260923-24`.
- **Leftovers.** The diff adds no debug switches, TODOs or `console.log`.

## What I did NOT check (and why)
- **The live database.** I didn't connect. I can't say whether the TED-023 hole was used before 261, or whether counselors have already claimed invitations (TED-028).
- **Supabase's real time limit.** The timings are from my machine.
- **The parent portal in a browser, with a real parent login.** Both TED-023 and TED-028 were proven at the database level with the repo's functions.
- **`set_parent_invite_email` and `resolve_join_request`.** I read them but didn't run them as a counselor.
- **Whether a scheduler can reach the invite button** (TED-030).

## Things only you can check (click-by-click)
1. **Apply 261 now.** Supabase Dashboard → SQL Editor → New query → paste all of `migrations/261_only_the_camp_office_writes_parent_invites.sql` → Run. It's safe to run twice.
2. **Check whether the stranger hole was used (read only).** Same place, new query, paste and Run:
   `SELECT i.camp_id, i.parent_email, i.user_id, i.created_at FROM link_parent_invites i WHERE i.user_id IS NOT NULL AND i.camper_names IS NULL ORDER BY i.created_at DESC;`
   Every row is an account the portal treats as the parent of every child in that camp. Send any email you don't recognise to the builder.
3. **Check whether a staff member claimed a family (TED-028, read only).** New query, paste and Run:
   `SELECT i.camp_id, i.parent_email, u.email AS claimed_by, i.created_at FROM link_parent_invites i JOIN auth.users u ON u.id = i.user_id WHERE lower(u.email) <> lower(i.parent_email) ORDER BY i.created_at DESC;`
   Each row is an invitation claimed by an account whose email isn't the parent's. Some are genuine (a parent using a second email). Check any that belong to your staff.
4. **Until TED-021 is fixed,** don't give a new child the number of a child you just erased. Let the camp pick the next number instead.
5. **Until TED-029 is fixed,** run the check script only after both 260 and 261 are applied.
