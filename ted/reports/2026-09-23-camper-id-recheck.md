# Ted's report: camper ID number, re-check of TED-010 to TED-015, 2026-09-23 (fifth visit)

## Verdict: 🔴 Problems found

**We are still not at 100%, and one of this round's fixes broke something new.** Three fixes check out: the nurse's forms, the spreadsheet "Replace" import and the name counter. The sibling problem on parent invitations is also fixed for the cases I raised. But the new "a renumber moves the saved records too" step has a side effect. **After the office changes a camper's ID number on the Me page, the Me page can't save anything to the cloud any more.** It still shows "Synced". I watched this happen in a real browser. I also found three more ways a parent's portal can end up on the wrong child's number, or on no number at all. The new repair tool for the old rename bug can pair a child with their brother or sister. **Don't apply 260 yet.**

## The numbers
Tests run: 3,418 · Passed: 3,404 · Failed: 14 (real bugs: not sorted, all 14 are the auto-scheduler tests you deferred (TED-005) · out-of-date tests: 0 · my machine: 0)

- Unit tests (`npm test`): 3,284 run, 3,270 passed, **14 failed**. These are the same 14 `auto_full_day.test.js` tests (TED-005, deferred).
- Database tests (`npm run test:pg`): 49 of 49 passed, against 84 migrations.
- Roster-key browser test (`npm run test:keys`): 17 of 17.
- Lite + Health browser test (`npm run test:lite`): 12 of 12.
- Smoke (`npm run test:smoke`): 32 of 32.
- 600-camper scale test (`npm run test:scale`): 24 of 24.

These match what the builder said. The suites pass because none of them saves a renumber the way the real Me page does, and none covers the cases below.

## What's wrong (most serious first)

### TED-016 🔴 After a camper's ID number is changed, the Me page stops saving to the cloud
- **What a user would see:** The office opens Edit Camper, types a new Camper ID (1 → 7) and presses Save. The screen shows the new number and says "Synced". **Nothing reached the cloud.** Every later edit on the Me page is lost the same way: other campers, families, payments and enrollments. It lasts until someone notices. Another device, or a reload that pulls from the cloud, shows the old data.
- **How sure I am:** Confirmed in a real browser, on the real Me page, against a database built from all 84 migrations.
- **Proof:**
  - **Setup.** My own browser script (scratchpad, modelled on `tests/roster_keys.e2e.js`) used Moshe Gold #1 with one enrollment carrying `camperId: 1`. It opened Edit Camper, typed `7` in the Camper ID box and clicked Save.
  - **What the page logged.** `Failed to sync to cloud (camp_state_kv): ON CONFLICT DO UPDATE command cannot affect row a second time`.
  - **What the database held.** Still `"Moshe Gold": {"camperId": 1}`, and the enrollment was still `camperId: 1`.
  - **A later, unrelated edit.** It also never arrived ("batch sync failures logged: 2"), and the page still said "Synced".
  - **Why.** The page saves its documents in one go: roster first (`app1`), then `campistryMe` (`integration_hooks.js:1089-1091`, one upsert of all rows). 260's new step fires while the roster row is being written. It rewrites the `campistryMe` row, which comes later in that same statement (`migrations/260_…sql:235-258`, `_renumber_in_documents`). Postgres refuses to touch that row twice, so the whole save fails. The failed save is put back in the queue (`integration_hooks.js:1072-1077`), so it fails again every time.
  - **The same failure by hand.** A single SQL statement shaped like the page's save fails the same way.
  - **Why the tests missed it.** The 260 test renumbers with a single-row `UPDATE`, which is not how the page saves.
  - **When it started.** This is new in 260. Before 260 the roster trigger never wrote to other rows.
- **What to ask the builder for:** "260's renumber step breaks the Me page's save: the page upserts app1 and campistryMe in one statement, and the trigger rewrites campistryMe mid-statement ('ON CONFLICT DO UPDATE command cannot affect row a second time'). Move the document rewrite out of the BEFORE trigger (or make the page save the renumber on its own), and add a browser test that renumbers a camper through Edit Camper and then checks the roster, the enrollment and a later edit all reach the database."

### TED-017 🔴 Changing a camper's number, or repairing a split child, leaves the parent portal on the old number, and the parent gets whichever child is given that number next
- **What a user would see:** Moshe is renumbered 1 → 7. His parent's portal keeps telling the browser Moshe is **#1**. Nobody is #1 now, so the parent's deposits, forms and pickups for "Moshe" are filed on a number that belongs to no child. Later the office gives #1 to a new child, Dina. **Moshe's parent now owns Dina.** The server agrees the parent may act for #1, and says they may not act for #7, Moshe's real number. The new "put the split child back together" repair does the same thing: the parent is left on the split number the repair deleted.
- **How sure I am:** Confirmed on the scratch database. Once TED-016 is fixed, renumbers will reach the server and this will happen.
- **Proof:**
  - **Renumber.** Invite `camper_names ["Moshe Gold"]`, `person_ids [1]`. Renumber saved (upsert) → `camp_people` shows Moshe as #7. The office's next invite save (131's exact UPDATE, now with `camperId: 7` in the data) left `person_ids` as **`[1]`**.
  - **A new child gets #1.** Dina is saved as `camperId: 1`, which the server accepts. As the parent: `get_my_camper_ids` → `{"name":"Moshe Gold","camperId":1}`, `_parent_owns_person(camp,1)` = **t** (Dina), `_parent_owns_person(camp,7)` = **f** (Moshe).
  - **Split repair.** The invite held `[2]` (the split number). After `split_renames(true)`, Ayala is #1 and #2 no longer exists, but the invite still says **`[2]`**.
  - **Nothing notices except the new check.** `verify_invite_numbers()` flags both cases.
  - **Why.** 260's invite trigger returns early when the list of names hasn't changed (`migrations/260_…sql:99-105`). Neither the renumber (237's in-place `UPDATE camp_people SET person_id`) nor `split_renames` updates `link_parent_invites`. `merge_campers` does (254, "Invitations name people by position; carry those too"), and these two were not given the same step.
- **What to ask the builder for:** "Whenever a camper's number changes (renumber in number_camp_campers, split_renames(true)), rewrite that number in link_parent_invites.person_ids too, like merge_campers does. Add pgtests: renumber Moshe 1→7 then give #1 to Dina, and get_my_camper_ids for Moshe's parent must say 7 and must not own #1. The same test after split_renames(true)."

### TED-011 🟠 (still open, changed) The split-child repair can put a child onto their sibling's number
- **What a user would see:** A family has Avi and Moshe. In one old save, Avi was removed from the roster and Moshe was renamed; the 253 bug split Moshe in two. The new report lists Moshe **twice**: once matched to his own old number, and once to **Avi's** number, because the siblings share a parent email. Running the repair then stops with a database error, and **no child in the camp** is repaired. It's worse if Moshe's old record had no birthday or email on file: the report lists only the Avi match, and the repair **silently moves Moshe onto Avi's number, with Avi's $80 canteen balance and Avi's history**. Separately, every repaired child's parent portal is left on the deleted number (TED-017).
- **How sure I am:** Confirmed on the scratch database.
- **Proof:**
  - **Both matches listed.** `_split_rename_pairs()` returned `1 Avi Gold → 3 Moshe Gold-Stein (same parent email)` and `2 Moshe Gold → 3 (same date of birth)`.
  - **The repair aborts.** `split_renames(true)` failed with `duplicate key value violates unique constraint "uq_camp_people_source"`. Only "our own" errors are caught (`EXCEPTION WHEN raise_exception`, `migrations/260_…sql:329`).
  - **The silent variant.** With Moshe's old record empty (`{}`), the dry run listed one match (Avi #1). The repair made **#1 = "Moshe Gold-Stein", live, with canteen $80.00**.
  - **Why.** The "exactly one match" rule is only checked one way: one split per departed child (`:286-292`). It never checks that the split child has only one possible original.
- **What to ask the builder for:** "In _split_rename_pairs, require exactly one match in BOTH directions (a split child with two candidate originals is left for a person), catch any error per child rather than only raise_exception, and carry link_parent_invites.person_ids in the repair. Add a pgtest: sibling removed and child renamed in the same save — the repair must not touch the sibling's number."

### TED-018 🟠 A parent whose invitation was written before their child was enrolled never sees the child
- **What a user would see:** The office accepts an application, which writes the family's invitation, and then enrolls the child. The parent logs in and their child isn't in the portal. Saving the child again doesn't help. The office's new check reports this family as "INVITE NUMBERS ON THE WRONG CHILD", and the only repair tool is the one in TED-019.
- **How sure I am:** Confirmed on the scratch database.
- **Proof:**
  - **The invite is born with an empty slot.** Invite written for "Rivka Stern" before she was on the roster → `person_ids [null]`. She was then added to the roster (#1).
  - **Re-saving doesn't fill it.** The Me page re-saves the invite after enrolling (`campistry_me.js:14967`, `_syncInvitesForCamper`), with the same names and `camperId: 1` in the data. `person_ids` stayed **`[null]`**.
  - **Why.** 260's trigger does nothing when the names are unchanged (`migrations/260_…sql:102-105`). The Me page's comment at `campistry_me.js:14961-14963` says the re-save "re-stamps it, which fills the slot". That is not true. It wasn't true under 232 either, for a slot that already held `null`.
  - **The office's data doesn't help.** The Me page's invite data doesn't include the camper number at all (`campistry_me.js:14380-14397`). So step 1 of 260's slot rule, "the number the office sent", never applies on this path.
- **What to ask the builder for:** "Make the invite trigger fill empty slots (and re-check every slot against camper_data's camperId) on every save, not only when camper_names changes; send camperId in camper_data from _upsertInviteForParent. Add a pgtest: invite written before enrollment, then enroll and re-save — the parent must see the child's number."

### TED-019 🟠 The office's invite repair tool still picks a departed child by name
- **What a user would see:** `restamp_parent_invite` is the repair `verify_identity_chain.sql` tells the office to use for invitations that need attention. It decides every slot by **name**. When the only child with that name has left, it gives the new family **the departed child's number**, and with it that child's records. 260 removed this exact behaviour from the automatic path, but the manual repair still does it.
- **How sure I am:** Confirmed on the scratch database.
- **Proof:** "Ghost Kid" #3 left. A new family's invite for "Ghost Kid" was born `[null]`, which is correct. `restamp_parent_invite(invite)` returned `{"was":[null],"now":[3]}`. The function (`migrations/232_…sql:340-342`) uses `camp_person_by_name`, and nothing later replaced it. `verify_identity_chain.sql:516` points the office to it.
- **What to ask the builder for:** "Rewrite restamp_parent_invite to use 260's _invite_slot_person (camper_data's number, then the enrolled key holder, never a departed child by name), and add it to the 260 pgtest."

### TED-020 🟠 Renaming a camper and changing their number in the same edit splits them in two
- **What a user would see:** In one Edit Camper save, the office corrects Moshe's surname and types a new Camper ID. Moshe's old number is marked "departed" and keeps his medication records and history. A brand-new number is created for "Moshe Goldberg". That is the 253 rename bug again, in this combined case.
- **How sure I am:** The server side is confirmed. That the page sends both changes in one save is likely: `saveCamper` renames and applies the typed ID before the single save (`campistry_me.js:5720-5745`).
- **Proof:** Roster `"Moshe Gold":1` → saved `"Moshe Goldberg":9`. Result: #1 "Moshe Gold" **departed**, #9 "Moshe Goldberg" new, and the Health record still says `camperId: 1`. 259's rename rule only fires when the stated number is the camper's own. 260's document step only looks at the same key.
- **What to ask the builder for:** "Handle rename + renumber in one save as one person (the old key's number moves to the new key and new number, tables, documents and invites), or have the page send the rename first and the renumber as its own save. Add a pgtest for it."

### TED-021 🟠 An office tab that was open before a camper was erased brings them back
- **What a user would see:** The office deletes Avi, and after the Undo window he's erased: everything goes and his number is freed. A second office tab, open since before, saves once. **Avi is back** on the roster under his old number, and that tab's copies of his enrollments and payments come back with him. This breaks your rule that "erasing a camper erases everything".
- **How sure I am:** The server side is confirmed. Whether a real second tab still holds him depends on whether the Me page refreshes its roster from other tabs' saves, which I didn't test.
- **Proof:** `erase_camper(camp,2,true)` → `number_is_free: true`, health record cleared. Then an old roster containing `"Avi Gold": {"camperId":2}` was saved → `camp_people` shows **#2 "Avi Gold", live**. `_number_people` treats a free stated number as "free: honour it".
- **What to ask the builder for:** "Remember erased numbers and keys (a tombstone) and refuse a roster save that brings one back without an explicit re-add; add a pgtest: erase, then a stale save — the camper must not return."

### TED-022 🟡 The spreadsheet's "Update" import (no ID column) only ever matches the child who has the plain name
- **What a user would see:** There are two Avi Katz, one of them filed internally as "Avi Katz #11". Re-importing with **Update** (not Replace) and no Camper ID column gives the #11 child's row a **third** Avi with a new number. His real record isn't updated, and his history stays on #11.
- **How sure I am:** Likely, from reading the code. I didn't run it.
- **Proof:** `campistry_me.js` `importRows`: `existing=roster[r.name]` (the plain key only). If `_sameCamperSignal` fails, the row is treated as a new camper (`_needOwnKey`). The Replace-mode fix (`_returningCamper`) wasn't applied to Update mode.
- **What to ask the builder for:** "In CSV Update mode without an ID, match a row against every camper shown with that name (as _returningCamper does for Replace), not only the one holding the plain key."

### TED-002 🟡 (still open) The move to camper numbers is not finished
- The page-side count is now A = 0 and B = 323 roster-key places (`docs/CAMPER_NAME_INVENTORY.md`, regenerated with no difference). The remaining real work is on the server: TED-011 and TED-016 to TED-021.

### TED-005 🟠 (still open, deferred by you) 14 auto-scheduler tests still fail
- The same 14 (`auto_full_day.test.js`, tests 174-195). I didn't investigate them, as you asked.

## What I confirmed is working
- **TED-010 is fixed for the cases I raised (closed).** The 260 test (sibling withdraws → `[1]`; sibling added in front → `[5,1]`; departed-only name → `[null]`) passes in my `npm run test:pg` run (49/49). My own renumber test above also showed the trigger re-deciding slots only when names change, as designed. The remaining invite problems are new findings (TED-017/018/019).
- **TED-013 is fixed (closed).** `npm run test:keys` step 5 passes (17/17): Leah Fox kept #20, her key and her $30 through a Replace import with no ID column, and a new child got a new number. The code matches by birthday, then by parent email or address, and only when there is exactly one match (`_returningCamper`). Rows it can't match are reported in the summary.
- **TED-014 is fixed (closed).** Both Health forms now go through `pickedCamper()` (`campistry_health.js:475-482, 487-489, 509-510`). A typed name shared by two campers is refused. The picker shows the plain name and remembers the pick. `npm run test:lite` 12/12 includes "a name two campers share is not saved as a visit" and "the visit carries the picked camper's number (#702)".
- **TED-015 is fixed (closed).** The mislabelled `name-ok` form-reminder line now decides by number (diff at `sendFormReminders`). The form "missing" list does the same (`viewFormResponses`). The counter now finds `.camper` comparisons (11 listed; the remaining ones I grepped are number-first with a name fallback for old records only). Re-running `node scripts/camper_name_inventory.js` produced no change to the committed document.
- **The server side of a renumber works when saved alone:** a single-row roster update moved the Health record 1 → 7 (the 260 pgtest).
- **Swapping two campers' numbers in one save is refused safely.** Both keep their numbers and no records move (scratch database).
- **Changed files carry new `?v=` numbers** (`20260923-22`), and Lite's asset version moved to `20260923-06`.

## What I did NOT check (and why)
- **The live database.** I didn't connect. I can't say how many families' invitations are already affected, or how many split children your data has.
- **Whether other Me-page actions that save several documents at once hit TED-016.** I tested the Edit Camper renumber only.
- **Whether a second office tab picks up another tab's roster changes live** (TED-021's real-world likelihood).
- **Lite, Health and the Snacks register after a renumber.** They write the camper number from the roster they loaded (`campistry_lite.js:613-618`), so until they reload they would keep writing the old number. I read this in the code; I didn't run it.
- **Go.** I only read its counted roster-key places (4). I didn't trace a route or luggage record end to end.
- **The parent portal in a browser, a real parent login, real payments, a real phone.**

## Things only you can check (click-by-click)
1. **Don't apply 260 yet.** On its own it breaks Me-page saving after any renumber (TED-016). 255-259 are unaffected by what I found this round. If you want them in, apply them in order: Supabase Dashboard → SQL Editor → New query → paste the file → Run.
2. **Until TED-016 and TED-017 are fixed, don't change any camper's Camper ID** on Edit Camper, and never type an old number for a new child.
3. **If you already applied 260:** don't run `SELECT public.split_renames(true);`. Run only the dry run, `SELECT public.split_renames();`, and send the result to the builder. Check whether any child appears twice or next to a sibling's number.
4. **Look for affected families (read only):** Supabase Dashboard → SQL Editor → New query → paste `SELECT public.verify_invite_numbers();` → Run (works only after 260). Send the result to the builder. **Don't** use `restamp_parent_invite` to fix them (TED-019).
5. **Keep only one office tab open on the Me page** while campers are being deleted, until TED-021 is fixed.
