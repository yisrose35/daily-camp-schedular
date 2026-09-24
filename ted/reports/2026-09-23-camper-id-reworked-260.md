# Ted's report: camper ID number, check of the reworked 260, 2026-09-23 (sixth visit)

## Verdict: 🔴 Problems found

**This round's repairs are real.** I re-tested every finding from last time myself. Seven of the eight are fixed: the Me page saves through a renumber again, and invitations follow the child. Rename and renumber in one edit keeps one child, the split repair no longer touches brothers or sisters, and the spreadsheet Update matches the right child. **But I found an older, more serious hole in parent invitations.** Any logged-in account, including a stranger with no connection to your camp, can make itself the "parent" of any child. 260 makes this easier: the child's number is now enough, and the name isn't needed. I also found that 260 can make a large renumber save take far too long, and that the erased-child fix is only half done. **Don't apply 260 until TED-023 and TED-024 are dealt with.**

## The numbers
Tests run: 3,430 · Passed: 3,416 · Failed: 14 (real bugs: not sorted, all 14 are the auto-scheduler tests you deferred (TED-005) · out-of-date tests: 0 · my machine: 0)

- Unit tests (`npm test`): 3,284 run, 3,270 passed, **14 failed**. These are the same 14 `auto_full_day.test.js` tests as before.
- Database tests (`npm run test:pg`): 49 of 49 passed, against 84 migrations.
- Roster-key browser test (`npm run test:keys`): 29 of 29, **in all 4 of my runs**. The builder had one time-out in four; I saw none.
- Lite + Health browser test: 12 of 12. Smoke: 32 of 32. 600-camper scale test: 24 of 24.
- Extra check: I ran the new browser test against the *previous* 260 in a scratch copy outside the project. It failed at the renumber step ("timed out waiting for the renumber to reach the database"), as the builder said it would. So the test really does catch TED-016.

All of these match what the builder said. None of them covers the problems below.

## What's wrong (most serious first)

### TED-023 🔴 A stranger can make themselves the parent of any child at your camp
- **What a user would see:** Nothing, which is the danger. Someone with any Campistry parent login (anyone can sign up) makes an invitation for your camp with their own email, then claims it. The portal then treats them as that child's parent. The number-based checks built in 258 answer "yes, this is their child". With no names on the invitation, they count as the parent of **every** child in the camp. After 260 they don't even need a child's name: a guessed number such as #5 is enough.
- **How sure I am:** Confirmed on a scratch database built from all 84 migrations. I loaded the exact invite functions from the repo (`upsert_parent_invite` from 131, `claim_invite_by_code` from 010).
- **Proof:**
  - **The setup.** A stranger account with no role at the camp: `_is_camp_admin(...)` = **f**.
  - **By number (new with 260).** `upsert_parent_invite(<camp>, 'evil-token-1', 'Evil', 'stranger@evil', '["anything"]', '{"anything":{"camperId":5}}', NULL)` → success. The invite's `person_ids` became **`[5]`**. `claim_invite_by_code(<its code>)` → success. Then `_parent_owns_person(<camp>, 5)` = **t** (Rivka Stern), and `get_my_camper_ids` returns `camperId 5`.
  - **By name (already possible before 260).** The same call with `["Avi Katz"]` gave `[6]`, and the stranger owned #6.
  - **With no names (already possible before 260).** Passing no names gave an invitation that owns **#5 and #6**, i.e. every child. `_invite_covers_person` says "an invite naming no campers covers the camp".
  - **Why.** `migrations/131_reconnect_on_reprovision.sql:49-51`: the only check is `auth.uid() IS NULL`, and the function is granted to every logged-in user (`:118`). Nothing checks that the caller is staff at `p_camp_id`. The caller also chooses the token, so they can claim it straight away. 260's slot rule trusts the number in `camper_data` first (`migrations/260_…sql:621-627`), and that is what makes the number enough on its own.
  - **Not covered by any test.** Neither 131 nor 010 is in the test chain (`tests/e2e/db.js`).
- **What to ask the builder for:** "upsert_parent_invite (131) lets any logged-in user write an invitation for any camp. Make it refuse unless the caller is an owner/admin of p_camp_id (and never accept a null camper_names from it), check the same in any other function that writes link_parent_invites, and add a pgtest where a non-member calls it with a camperId and must not own that child."

### TED-024 🟠 A save that renumbers many campers, or an old tab's save after renumbers, can take long enough to fail
- **What a user would see:** The office re-imports the roster from a spreadsheet with the Replace option and the camp's own ID numbers, so every child gets a new number in one save. That save now takes many seconds. Supabase stops a signed-in user's database request after a few seconds (8 by default, as far as I know; I didn't check your project). If it's stopped, the whole save is thrown away and the Me page retries it again and again, with the same result as TED-016. Smaller version: once a camp has a few dozen renumbers behind it, **any** save from a tab still holding an old number takes seconds.
- **How sure I am:** The timings are confirmed on my machine. That Supabase would cut the save off is likely, not tested.
- **Proof:** Scratch database, 600 campers, and a Me document of about 550 KB with an enrollment and a payment per child.
  - **An ordinary save:** 7 ms before any renumber, 11 ms after 30 renumbers.
  - **One roster save giving 200 children new numbers:** **18.1 seconds**. The same save with 260's new after-save step switched off (`trg_zz_apply_moved_numbers`) took **0.43 seconds**, so the new step is almost all of it.
  - **An old tab's save carrying one old number, after 30 renumbers:** **2.9 seconds**.
  - **Why.** For every renumber ever recorded, `_carry_moved_numbers` walks the whole document once (`migrations/260_…sql:159-161`). `_apply_pending_renumbers` does that for every document of the camp (`:230-236`). Renumbers are never forgotten, only when the child is erased.
  - **The page path.** `importRows` takes each row's number from the file in Replace mode (`campistry_me.js` ~22364).
- **What to ask the builder for:** "260's document carry walks each whole document once per recorded renumber; make it a single pass (look each number up in one map), and add a timing test: 600 campers, 200 renumbered in one save, must finish well under Supabase's statement timeout."

### TED-021 🟠 (still open, changed) An old office tab no longer brings an erased child back to the roster, but it still brings back his enrollments and payments
- **What a user would see:** Avi is erased. A tab opened before that saves. Avi does **not** reappear on the roster (fixed). But that tab's copy of his enrollment and his **$900 payment** is written back to the cloud. If the office later types Avi's freed number #2 for a new child, Sara, that $900 payment now carries Sara's number.
- **How sure I am:** Confirmed on the scratch database.
- **Proof:**
  - **The erase.** `erase_camper(camp,2,true)` → success, and `camp_erased_people` holds `2 | Avi Gold`.
  - **The old tab's save.** It wrote both documents in one statement. The roster came back **without** Avi. The Me document came back **with** `enrollments.e2 {camperName:"Avi Gold", camperId:2}` and `payments [{camperId:2, amount:900, note:"Avi tuition"}]`.
  - **The freed number reused.** "Sara Levi" was saved with `camperId 2` and was accepted. The `payments` still showed `camperId 2, amount 900`.
  - **Why.** Only the roster entry is checked against `camp_erased_people` (`migrations/260_…sql:396-406`). Nothing checks the other documents.
- **What to ask the builder for:** "When a save carries an erased child's number in any document (enrollments, payments, health…), drop or refuse those records the same way the roster entry is dropped, unless the child was re-added; and add a pgtest: erase, old two-document save, then a new child given the freed number must not show the erased child's payment."

### TED-025 🟡 A renumber can never be undone
- **What a user would see:** The office mistypes a new Camper ID (Moshe 1 → 7, meant 17) and wants #1 back. Edit Camper refuses: "ID 1 already belongs to the camper now numbered #7 (their old number)", even though that camper *is* Moshe. If an old tab sends #1 for him anyway, the server quietly turns it back into 7.
- **How sure I am:** Confirmed. Server on the scratch database; page message by reading the code.
- **Proof:**
  - **Server.** Saving `"Moshe Gold": {camperId: 1, renumberedFrom: 7}` left him at **7**.
  - **Page.** `personIdHolder` returns the "their old number" text for any number in `_serverMovedNumbers` (`campistry_me.js:290-291`). `saveCamper` refuses on any holder (`:5746-5747`).
- **What to ask the builder for:** "Let a child go back to a number they were moved off (the server already flattens 7→1 chains; the page and the step 0a check should allow it when it's the same child)."

### TED-026 🟡 The split-child check misses a child whose birthday was entered in the same edit as the rename
- **What a user would see:** A child split by the old rename bug stays split, and the check says "ok". This happens if their old record had a parent email but no birthday, and the office filled in the birthday in the same edit that renamed them.
- **How sure I am:** Confirmed on the scratch database.
- **Proof:**
  - **The setup.** Old record `{"parent1Email":"g@x"}`, departed; split record `{"dob":"2016-01-01","parent1Email":"g@x"}`, minted at the same instant.
  - **The result.** `split_renames()` listed it **nowhere**, neither under split_children nor under needs_a_person.
  - **Why.** `_split_same_child` returns false when only one side has a birthday (`migrations/260_…sql:827-834`).
  - **The rest works.** The same run handled a sibling removed in the same save (repaired only Moshe, and Avi was untouched), an empty old record (needs a person), and twins (needs a person).
- **What to ask the builder for:** "In _split_same_child, when only one record has a birthday, fall back to the parent email and list the pair under needs_a_person rather than dropping it."

### TED-027 🟡 A leftover renumber hint on the wrong child re-points the old number (safety net)
- **What a user would see:** Nothing today. I found no page action that copies one camper's record onto another. The server, though, trusts a `renumberedFrom` hint on any entry. If one ever lands on the wrong child, the old number is re-pointed to that child, and old tabs' records for the first child go to them.
- **How sure I am:** The server behaviour is confirmed. That it can happen through the page is only suspected.
- **Proof:** After Moshe 1 → 9 (`moved {"1":9}`), a new entry `"Tova Goldberg": {camperId:10, renumberedFrom:1}` changed it to `moved {"1":10}`. An old tab's enrollment `camperId 1` was then saved as **10**. The cause is `migrations/260_…sql:489-494`, which records the hint without checking that its number currently belongs to this entry.
- **What to ask the builder for:** "Only honour renumberedFrom when that number's current holder (following moves) is this entry's own child."

### TED-002 🟡 (still open) The move to camper numbers is not finished
- Part A of the name inventory is still 0, and `node scripts/camper_name_inventory.js --check` says "up to date". Remaining server work: TED-021, TED-023 and TED-024. Small note: Go stores a camper's number as `_camperId`. 260's document carry doesn't rewrite that field, so after a renumber a Go-only camper keeps the old number (`campistry_go.js:1432`). Go prefers the Me roster's number when there is one, so this matters only for camps using Go without Me.

### TED-005 🟠 (still open, deferred by you) 14 auto-scheduler tests still fail
- The same 14 (`auto_full_day.test.js`, tests 174-195). I didn't investigate them.

## What I confirmed is working
- **TED-016 is fixed (closed).**
  - **The server side.** One statement saving `app1` (Moshe 1→7) and `campistryMe` together succeeded. The Me document came back with `camperId 7` in both the enrollment and the payment.
  - **The real page.** In a browser (test:keys step 4b, 4 runs of 4), Edit Camper 3→40 saved, and so did a later unrelated edit. No failed cloud save was logged.
  - **The old 260 fails that step.** See the extra check above.
- **TED-017 is fixed (closed).** After that save, the invite said `[7]` and `get_camper_numbers → moved {"1":7}`. A new child typed as #1 (Dina) got #8 of her own. Moshe's parent: `get_my_camper_ids` → 7, owns #7 = t, owns Dina = f.
- **TED-012 is closed (superseded by TED-016/017, both fixed).** An old tab's later save with `camperId 1` in the Me document was corrected to 7 as it was saved.
- **TED-018 is fixed (closed).** An invite born `[null]` before enrollment became `[1]` when the Me page's re-save sent `camperId 1`. The page now sends it (`campistry_me.js`, `_syncParentInviteSnapshot`).
- **TED-019 is fixed (closed).** `restamp_parent_invite` on a new family's "Ghost Kid" invite (the only Ghost Kid has left) → `now [null]`, not the departed child's #3.
- **TED-020 is fixed (closed).**
  - **The server side.** Rename + renumber with the hint (`"Moshe Goldberg": {camperId 9, renumberedFrom 1}`) gave one child, #9 "Moshe Goldberg", with no departed #1. The enrollment moved to 9, and the hint was not stored.
  - **The real page.** Test:keys step 4c passes.
- **TED-011 is fixed as raised (closed).** The dry run and the repair above: the sibling was never touched, uncertain cases were listed for a person, and the invite moved `[3]` → `[2]`. The new gap is filed separately as TED-026.
- **TED-022 is fixed (closed).** Test:keys step 4d: a spreadsheet Update with no ID column updated "Avi Katz #n" under his own key and number, and no third Avi was made. The code now uses `_returningCamper` for Update mode.
- **260 applies cleanly again.** I pasted it twice more on top of the chain, each time as one transaction (the way the SQL Editor runs it): exit 0 both times. `scripts/verify_identity_chain.sql` then reported **ok** for 260.
- **Browser caching.** `campistry_me.js` is loaded from one page only, now `?v=20260923-23`.

## What I did NOT check (and why)
- **The live database.** I didn't connect. I can't say whether anyone has already used the TED-023 hole, how many renumbers your camps have, or whether your live `upsert_parent_invite` differs from the repo's.
- **Supabase's real time limit** for your project (TED-024). I measured on my own machine only.
- **The parent portal in a browser, with a real parent login.** TED-023 was proven at the database level with the repo's functions, not through the Link page.
- **Other functions that write invitations** besides the ones in the repo's migrations (e.g. edge functions). I checked only that no edge function writes `camper_data`.
- **Lite, Health, Snacks and Go after a renumber, in a browser.** Their open pages keep the old number until they reload. The server now corrects documents they save, but I didn't test their table writes.

## Things only you can check (click-by-click)
1. **Don't apply 260 yet.** It fixes a lot, but it makes TED-023 easier and adds TED-024. Ask for those two first.
2. **Check whether the TED-023 hole was used (read only).** Supabase Dashboard → SQL Editor → New query → paste this and press Run:
   `SELECT i.camp_id, i.parent_email, i.created_at FROM link_parent_invites i WHERE i.user_id IS NOT NULL AND i.camper_names IS NULL ORDER BY i.created_at DESC;`
   Every row is an account that the portal treats as the parent of every child in that camp. Check that each one is someone you set up on purpose. Send anything you don't recognise to the builder.
3. **Until TED-024 is fixed,** don't re-import the roster with the Replace option and a Camper ID column.
4. **Until TED-021 is fixed,** keep only one office tab open on the Me page while campers are being erased, and never type an erased child's old number for a new child.
