# Part 1 — Campistry Me: Roster & Camp Structure

Covers: the Roster page and its slices, camper profiles, staff profiles,
families and household merging, Camp Structure, the Bunk Builder, the bunk
auto-generator, bunk staff, division heads, counselor visibility, global search,
the setup checklist, and CSV/Excel import.

**Files:** `campistry_me.html`, `campistry_me.js`, `campistry_camper_identity.js`,
`campistry_presence.js`, `campistry_enrollment_window.js`, `campistry_visibility.js`,
`campistry_setup_checklist.js`, `campistry_bus_routes.js`, `campistry_scan_to_pdf.js`,
`integration_hooks.js`.

**Before you start:** Part 0 done, seed data built, `tests/me_page_recorder.js`
pasted into the console.

---

## 1.1 — The page loads at all

#### ME-R-01 ★ CORE — First paint and hydration

| | |
|---|---|
| **Do** | Open `campistry_me.html` as the owner. Watch the white loading overlay with the Me wordmark. |
| **Expect** | The overlay fades **after** cloud data has landed — the roster is populated the instant you can see it. You never see an empty roster that then fills in. |
| **Verify** | Console: no errors. `CampistryDB.getCampId()` returns a UUID. |
| **If it fails** | `hideMeLoadingOverlay` (`campistry_me.js:293`), `init` (309), `loadData` (390). An overlay that never lifts means hydration threw. |
| **Sev** | S2 |

#### ME-R-02 — Sidebar and deep links

| | |
|---|---|
| **Do** | Open the hamburger. Click each of Roster, Structure, Registration, Hiring, Billing, Payroll, Analytics, Finance, Reports. |
| **Expect** | Each renders. The sidebar item highlights. No blank pane. |
| **If it fails** | `setupSidebar` (797), `nav` (805). A blank pane usually means that renderer threw — check the console for the first error after the click. |
| **Sev** | S2 |

#### ME-R-03 — Global search

| | |
|---|---|
| **Do** | Type `Malky` in the header search. Then `A1`. Then `O'Brien`. Then a saved report name. Then `<script>`. |
| **Expect** | Campers, bunks, staff, families and saved reports all findable. Clicking a result navigates to it. The `<script>` query returns nothing and renders as literal text — never executes. |
| **If it fails** | `_globalSearchIndex` (824), `_globalSearchResultsHtml` (913), `esc` (975). |
| **Sev** | S3, but the `<script>` case is S1 (stored XSS). |

---

## 1.2 — The roster and its slices

The Roster page shows **who is at camp**, not everyone ever enrolled. That
distinction is the source of most confusion here, and it is deliberate.

#### ME-R-04 ★ CORE — The "Showing" picker

| | |
|---|---|
| **Do** | Find the **Showing** dropdown. Switch between `in camp today`, `All`, and each session. |
| **Expect** | `in camp today` shows `Both Halves` plus whichever of `First-Half Only` / `Second-Half Only` matches today's date — **not both**. `All` shows every enrolled camper. `1st Half` shows `First-Half Only` and `Both Halves`. |
| **Verify** | Console: `CampistryPresence.isHere('Second-Half Only')` should agree with what the page shows. |
| **If it fails** | `_rosterWhenDefault` (90), `_hereToday` (151), `_rosterPresence` (184), `campistry_enrollment_window.js`. |
| **Sev** | S2 — this is the number every bunk list, head count and print-out is built from. |

#### ME-R-05 — The default slice is not always "today"

| | |
|---|---|
| **Do** | Part 8 creates a session plan. Come back and open the roster while inside a 2nd-Half plan. |
| **Expect** | It opens on **2nd Half**, not today — and the picker says so. |
| **If it fails** | `_rosterWhenDefault` (90). Note: this only applies until the user touches the picker once. |
| **Sev** | S3 |

#### ME-R-06 — Enrolled / Unenrolled / Staff tabs

| | |
|---|---|
| **Do** | Switch tabs. Check each count in the tab label against the rows shown. |
| **Expect** | Counts match. The Staff tab appears only if you have `me.staffing` or `me.payroll` access. |
| **If it fails** | `renderCampers` (2689), `setRosterSubTab` (124), `buildStaffRoster` (2110). |
| **Sev** | S3 |

#### ME-R-07 — Pagination

| | |
|---|---|
| **Do** | With more than 50 campers (BRK-01 bulk-imports 500 if you need them), page forward, filter to something with 3 results, then page again. |
| **Expect** | Page clamps into range — you never land on an empty page after a filter shrinks the list. "Showing 51–100 of 500". |
| **If it fails** | `_paginate` (102), `_pagerHtml` (109). |
| **Sev** | S3 |

#### ME-R-08 — Setup checklist

| | |
|---|---|
| **Do** | On a fresh camp, look at the top of the Roster page. Complete one item; dismiss the checklist. |
| **Expect** | Items in dependency order (roster before billing, bank alerts before automatic deposits). Dismissal sticks across reload. |
| **If it fails** | `campistry_setup_checklist.js`, `_setupChecklistHtml` (2849). |
| **Sev** | S4 |

---

## 1.3 — Two campers, one name

This is hazard #2 from the roadmap. It has its own section because it is the most
expensive thing in this app to get wrong.

#### ME-R-09 ★ CORE — The duplicate is accepted

| | |
|---|---|
| **Do** | You already created two `Malky Stein`. Open each from the roster. |
| **Expect** | Both exist. Both are editable. Each shows `Malky Stein` as their display name. |
| **Verify** | Console: `Object.keys(G.campistryMe.roster).filter(k=>k.startsWith('Malky'))` → two keys, one of them suffixed, e.g. `Malky Stein #102`. Both records carry `displayName: 'Malky Stein'`. |
| **If it fails** | `campistry_camper_identity.js`, `_disambiguateRosterName` (18576), `saveCamper` (3359). |
| **Sev** | S1 |

#### ME-R-10 — The suffix never leaks into the interface

| | |
|---|---|
| **Do** | Walk the second Malky through: roster row, camper detail page, bunk builder chip, print sheet preview, Billing family card, a report export. |
| **Expect** | Every *visible* place says `Malky Stein`. |
| **Known gap** | `TEST_FINDINGS.md` states the display sweep is **partly done**: `campistry_me.js` has ~22 un-swept sites and will show `Malky Stein #102` in some places. That is cosmetic and already known — log which screens, do not re-report it as new. A wrong *balance* or a wrong *bunk* is a different matter entirely and is S1. |
| **If it fails** | `_lbl` (3583), `bunkLabel` (1148). |
| **Sev** | S4 for the label; S1 if identity is wrong anywhere. |

#### ME-R-11 ★ CORE — Money does not cross between them

| | |
|---|---|
| **Do** | In Snacks (Part 7), deposit $20 to one Malky. Come back and check the other's canteen balance. Then delete the first Malky and create a *third* camper with the same name. |
| **Expect** | The second Malky has $0. The new third Malky starts at $0 and does **not** inherit the deleted account's money — the closed account is moved aside to its own key and keeps its balance. |
| **Verify** | Console: `G.campistrySnacks.accounts` — look for a moved-aside key. `G.campistrySnacks.transactions.filter(t=>t.camper.startsWith('Malky'))` should show each transaction carrying a distinct `camperId`. |
| **If it fails** | `_reconcileBalances` and `ensureAccountsForRoster` in `campistry_snacks.js`; `TEST_FINDINGS.md` defect D4. |
| **Sev** | S1 |

---

## 1.4 — Camper create, edit, delete

#### ME-R-12 ★ CORE — Add a camper

| | |
|---|---|
| **Do** | **+ Add Camper**. Fill name, division, grade, bunk, date of birth, parent email, phone. Save. |
| **Expect** | Appears in the roster immediately. Sync badge settles to Synced. |
| **Verify** | SQL: `select value->'roster'->'<NAME>' from camp_state_kv where camp_id='<UUID>' and key='campistryMe';` |
| **Side effects to confirm** | (a) an **accepted enrollment** is auto-created so Billing and the pipeline treat them like a real registration; (b) a **canteen account** appears in Snacks; (c) a **parent invite** is provisioned for Link if the parent email is present. |
| **If it fails** | `saveCamper` (3359), `_autoCreateAcceptedEnrollment` (3537), `_autoProvisionParentInvites` (11221). |
| **Sev** | S2 |

#### ME-R-13 — Required fields and rubbish input

| | |
|---|---|
| **Do** | Try to save with: empty name; a name of 300 characters; leading/trailing spaces (` Avi Klein `); an email of `not-an-email`; a date of birth in the future; a date of birth of `1900-01-01`; a phone of `abc`. |
| **Expect** | Empty name refused. Spaces trimmed (and ` Avi Klein ` must **not** create a second camper). Bad email flagged. A future DOB either refused or flagged — record which. |
| **If it fails** | `saveCamper` (3359), `_sameCamperSignal` (18565). |
| **Sev** | S2 for the whitespace duplicate; S3 otherwise. |

#### ME-R-14 ★ CORE — Rename a camper

| | |
|---|---|
| **Do** | Rename `Sara O'Brien` to `Sara Oberlander`. |
| **Expect** | The new name appears in: roster, bunk assignment, family's children, enrollment record, canteen account, Link parent's child list, print sheets. The old name appears nowhere. |
| **Verify** | Console: search the whole blob — `JSON.stringify(G).match(/O'Brien/g)` should return null (or only in historical audit entries, which are intentional). |
| **If it fails** | `cascadeCamperRename` (3562), `_propagateBunkRename` (5393). |
| **Sev** | S1 — a half-renamed camper is a camper who exists twice. |

#### ME-R-15 ★ CORE — Delete a camper who owes money

| | |
|---|---|
| **Do** | Give `Avi Klein` an unpaid charge in Billing (Part 3), then delete him from the roster. |
| **Expect** | The confirm dialog **names the amount still owed** and says the family keeps the balance and can still pay it. After deleting: the camper is gone, the family record **remains** (because it carries money), Billing still shows the debt, and the parent can still reach it in the portal. |
| **Verify** | `G.campistryMe.families` — the household is still there, flagged `formerCamper: true`. The posted ledger still carries the charge. |
| **If it fails** | `deleteCamper` (4019), `cascadeCamperDelete` (3938), `_familyHasMoney` (3591), `campistry_billing_core.js`, `BILLING_OUTLIVES_ENROLLMENT_DESIGN.md`. |
| **Sev** | S1 — this used to erase the debt silently. |

#### ME-R-16 — Delete a camper who owes nothing

| | |
|---|---|
| **Do** | Delete a camper whose family has no ledger, no plan and no card, and who is the family's only child. |
| **Expect** | The empty family record is deleted outright, not left as a $0 "Paid" card in Billing. Their enrollments are deleted, not left dangling at a non-terminal status. |
| **Verify** | Billing shows no phantom card. `G.campistryMe.enrollments` has no entry with that `camperName`. |
| **If it fails** | `cascadeCamperDelete` (3938). |
| **Sev** | S3 |

#### ME-R-17 ★ CORE — Undo a delete

| | |
|---|---|
| **Do** | Delete a camper who is in a family and a bunk and has an enrollment. Click **Undo** on the toast. |
| **Expect** | Everything comes back: the camper, their **whole household record**, their bunk placement, and each enrollment at its **exact prior status**. |
| **If it fails** | `deleteCamper` (4019) — the capture block before the cascade. |
| **Sev** | S1 |

#### ME-R-18 — Undo after the toast is gone

| | |
|---|---|
| **Do** | Delete a camper. Wait for the toast to disappear. Reload. |
| **Expect** | No Undo is offered, and nothing half-restored. The delete is final and complete. |
| **Sev** | S3 |

#### ME-R-19 — Unenroll, then re-enroll

| | |
|---|---|
| **Do** | Unenroll `Both Halves`. Check the Unenrolled tab. Then re-enroll them. |
| **Expect** | They move between tabs. Unenrolling reopens/credits withdrawals per the cancellation policy; re-enrolling does **not** double-charge tuition. |
| **Verify** | Compare the family ledger before and after. A re-enroll must post at most one tuition charge. |
| **If it fails** | `unenrollCamper` (4105), `_reopenWithdrawals` (4179), `reenrollCamper` (4195), `_creditWithdrawalsFor` (3710). |
| **Sev** | S1 |

#### ME-R-20 — Re-enroll twice

| | |
|---|---|
| **Do** | Re-enroll an already-enrolled camper (the code notes `reEnrollCamper` has no dedup guard). |
| **Expect** | State what happens. If a second enrollment record appears for the same camper and session, that is a finding: Billing scans every accepted/enrolled application and may charge twice. |
| **If it fails** | `reEnrollCamper` (18430), `buildFamilyLedgers` (12885). |
| **Sev** | S1 |

---

## 1.5 — The camper profile page

#### ME-R-21 — Every card renders

| | |
|---|---|
| **Do** | Open `Avi Klein`'s full profile. Walk every card: details, family/household, enrollment, billing summary, bunk, documents, notes & timeline, change history, attendance history, other camps, custom fields, scholarships. |
| **Expect** | Every card renders with either data or a sensible empty state. No `undefined`, no `[object Object]`, no `NaN`. |
| **If it fails** | `renderCamperDetailPage` (3036), `_dpCard` (2897). |
| **Sev** | S3 |

#### ME-R-22 — Documents: upload and scan

| | |
|---|---|
| **Do** | Upload a PDF. Then use **Scan** to photograph a page with the camera. Then upload a 25 MB file, a `.exe` renamed to `.pdf`, and a 0-byte file. |
| **Expect** | Normal files attach and re-open. The scan produces a real PDF. Oversized/invalid files are refused with a message, not a silent failure or a hung spinner. |
| **If it fails** | `uploadDocument` (18472), `scanDocument` (18478), `_storeDocumentFile` (18485), `campistry_scan_to_pdf.js`. |
| **Sev** | S3 |

#### ME-R-23 — Notes, timeline and change history

| | |
|---|---|
| **Do** | Add a note. Edit the camper's bunk. Reopen the profile. |
| **Expect** | The note is timestamped and attributed. The change history shows the bunk change as a before→after diff. |
| **If it fails** | `addCamperNote` (18359), `renderCamperTimeline` (18368), `_diffCamperFields` (18386). |
| **Sev** | S4 |

#### ME-R-24 — Attendance history and person links

| | |
|---|---|
| **Do** | Look at Attendance History. If the app suggests this camper is the same person as a staff member, confirm it; then dismiss a different suggestion. |
| **Expect** | Seasons listed with bunk/division. Confirming links the two records; dismissing hides that suggestion permanently. |
| **If it fails** | `_dpAttendanceHistoryCard` (2913), `_loadAttendanceHistory` (2927), `_confirmPersonLink` (2981), `ATTENDANCE_HISTORY_SETUP.md`, migration `088_camp_person_seasons.sql`. |
| **Sev** | S4 |

#### ME-R-25 — Custom fields

| | |
|---|---|
| **Do** | Add a custom field. Fill it for one camper. Remove the field. Re-add a field with the same name. |
| **Expect** | The value saves and shows. Removing the field does not corrupt other campers. Re-adding either recovers the old values or starts empty — state which. |
| **If it fails** | `manageCustomFields` (18457), `_addCustomField` (18466), `_removeCustomField` (18467). |
| **Sev** | S3 |

---

## 1.6 — Families and households

#### ME-R-26 ★ CORE — Family suggestions and merging

| | |
|---|---|
| **Do** | Create two campers with the same parent email but no family. Look for the suggestion banner. Accept it. Then use **Merge Families** on two households that share a surname. |
| **Expect** | The suggestion appears, names both children, and accepting produces one household with both. The merge tool shows a field-by-field comparison before committing. |
| **If it fails** | `detectFamilySuggestions` (1627), `acceptFamilySuggestion` (1709), `openMergeFamiliesTool` (1815), `_mfConfirmMerge` (1872). |
| **Sev** | S2 |

#### ME-R-27 ★ CORE — Merging two families that both have money

| | |
|---|---|
| **Do** | Give both households a payment history, then merge them. |
| **Expect** | **No money is lost.** Both ledgers are reconciled into the survivor. State exactly what happened to each payment. |
| **Verify** | Sum the payments before and after — they must be equal. |
| **If it fails** | `mergeFamiliesReconciled` (1752). |
| **Sev** | S1 |

#### ME-R-28 — Remove a camper from a family

| | |
|---|---|
| **Do** | Remove one of two siblings from a household. |
| **Expect** | The sibling discount is **re-priced** for whoever remains — it is not left at the two-child rate. |
| **Verify** | The family ledger shows a discount adjustment. |
| **If it fails** | `removeCamperFromFamily` (2055), `_resyncSiblingDiscounts` (3632), `campistry_sibling_discount.js`. |
| **Sev** | S1 |

#### ME-R-29 — Delete a family

| | |
|---|---|
| **Do** | Delete a household that still has campers in it. |
| **Expect** | Either refused, or the campers are left family-less without being deleted. Never silent camper deletion. |
| **If it fails** | `deleteFamily` (2024). |
| **Sev** | S1 |

---

## 1.7 — Camp Structure

#### ME-S-01 ★ CORE — Create a division, grades and bunks

| | |
|---|---|
| **Do** | **+ Add Division**. Name it `Delta`, pick a colour, add two grades, add bunks to each, map school grades. Save. |
| **Expect** | It appears with its colour. Bunks are selectable everywhere a bunk is picked. |
| **Verify** | SQL: `select value from camp_state_kv where camp_id='<UUID>' and key='campStructure';` |
| **If it fails** | `openDivForm` (4743), `saveDiv` (4809), `_addGradeRow` (4796). |
| **Sev** | S2 |

#### ME-S-02 — Reorder divisions, grades and bunks

| | |
|---|---|
| **Do** | Drag a division above another. Drag a grade. Drag a bunk chip. Reload. |
| **Expect** | The order persists exactly. It is the order used by print sheets and the scheduler. |
| **If it fails** | `_getDivisionOrder` (4281), `_saveDivisionOrder` (4295), `_commitStructureReorder` (4340), `_meReorderInit` (4562). |
| **Sev** | S3 |

#### ME-S-03 ★ CORE — Rename a division that is in use

| | |
|---|---|
| **Do** | Generate a schedule for `Alpha` in Flow first. Then rename `Alpha` to `Aleph`. |
| **Expect** | Campers, bunks, skeleton tiles, auto layers and camp periods all follow the rename. Nothing is left pointing at `Alpha`. The existing schedule is intact, not blanked. |
| **Verify** | `JSON.stringify(G).match(/"Alpha"/g)` → null. |
| **If it fails** | `_propagateDivisionRename` (5119), `_propagateGradeRenameTiles` (5001). |
| **Sev** | S1 |

#### ME-S-04 ★ CORE — Delete a division that is in use

| | |
|---|---|
| **Do** | Delete `Gamma` after putting a camper in `G1`, assigning bunk staff to it, and generating a schedule that includes it. |
| **Expect** | A confirmation that says what will happen. Afterwards: orphaned skeleton tiles, auto layers, camp periods and bunk references are all purged — no ghost bunk left in the scheduler or in print sheets. The camper is **not** silently deleted; state where they end up. |
| **Verify** | Open Flow's layer editor and the manual skeleton: no `G1`. |
| **If it fails** | `deleteDiv` (4921), `_purgeOrphanedSkeletonTiles` (4941), `_purgeOrphanedAutoLayers` (4970), `_purgeOrphanedCampPeriods` (5099), `_purgeOrphanedBunks` (5272). |
| **Sev** | S1 |

#### ME-S-05 — Rename a bunk

| | |
|---|---|
| **Do** | Rename `A2` to `A2-Maple`. |
| **Expect** | Camper assignments, bunk staff, canteen POS bunk filter, Link audiences and print sheets all follow. |
| **If it fails** | `_propagateBunkRename` (5393), `tests/bunk_rename_ghost_prune.test.js`. |
| **Sev** | S1 |

#### ME-S-06 — Bunk aliases

| | |
|---|---|
| **Do** | Give `A1` the alias `Moshe`. |
| **Expect** | It shows as `A1 (Moshe)` or similar wherever bunks are displayed, but the canonical name `A1` is still what every lookup uses. |
| **If it fails** | `openBunkAlias` (5371), `bunkLabel` (1148), `bunkAlias` (1153). |
| **Sev** | S4 |

#### ME-S-07 — Bunk capacity and headcount override

| | |
|---|---|
| **Do** | Set a capacity of 8 on `A1`. Set a manual headcount of 12. Set capacity to 0, then to -3, then to 999. |
| **Expect** | Capacity and headcount are distinct and both persist. Negative is refused. The generator and the bunk builder respect capacity. |
| **If it fails** | `openBunkCountModal` (7159), `setBunkCount` (5665), `_effBunkMax` (5844). |
| **Sev** | S3 |

#### ME-S-08 — School grade mapping

| | |
|---|---|
| **Do** | Open Bunk Settings → School Grades. Customise the list (remove one, add `Post-High`). Then open Edit Camper for someone whose school grade you just removed. |
| **Expect** | The camper's existing value still shows in the dropdown rather than being silently blanked. |
| **If it fails** | `_schoolGradeOptions` (24), `_schoolGradeCatalog` (17). |
| **Sev** | S2 — silently blanking a grade on open is a data-loss bug that only shows up on the next save. |

---

## 1.8 — Bunk Builder

#### ME-S-09 ★ CORE — Drag and drop

| | |
|---|---|
| **Do** | Drag a camper from the unassigned pool into `A1`. Drag between bunks. Drag back out. Do it on a touch device too. |
| **Expect** | Every move persists through a reload. Counts update live. |
| **If it fails** | `renderBB` (5461), `bbDrop` (5538), `mobile_touch_drag.js`. |
| **Sev** | S2 |

#### ME-S-10 — Drag into a full bunk

| | |
|---|---|
| **Do** | Fill `A1` to its capacity, then drag one more camper in. |
| **Expect** | Either blocked with a message, or allowed with a visible over-capacity warning. Never silently over-filled with no signal. |
| **Sev** | S3 |

#### ME-S-11 — Auto-assign and clear

| | |
|---|---|
| **Do** | **Auto Assign**. Then **Clear Bunks**. |
| **Expect** | Clear asks for confirmation. Nothing outside bunk assignment is touched — campers, families and money are untouched. |
| **If it fails** | `autoAssign` (5555), `clearBunks` (5556). |
| **Sev** | S2 |

#### ME-S-12 — Camper bunk requests

| | |
|---|---|
| **Do** | With bunk requests submitted through the post-acceptance form (Part 2), open **Bunk Requests**. |
| **Expect** | Requests listed per camper, and honoured by the generator where possible. |
| **If it fails** | `showCamperBunkRequests` (5525), `_camperBunkRequests` (5698), `_syncPostAcceptBunkRequests` (5731). |
| **Sev** | S3 |

---

## 1.9 — The bunk auto-generator

#### ME-S-13 ★ CORE — Generate bunks

| | |
|---|---|
| **Do** | Open **Bunk Generator Settings**, set criteria (school grade, requests, avoid-conflicts), then **Auto-Generate Bunks**. Read the report it produces. |
| **Expect** | Every camper placed. Cohorts respect school grade. Avoid-pairs are honoured or the report says why not. Bunk sizes are balanced within the configured max. |
| **Verify** | The report names every unplaced camper and every broken constraint. An empty report with unplaced campers is a finding. |
| **If it fails** | `autoGenerateBunks` (6485), `_bunkGenForGrade` (6237), `_rebalanceCohort` (5984), `_splitAvoidConflicts` (5772), `_showBunkGenReport` (6586). Compare against `tests/bunk_generator.test.js`. |
| **Sev** | S2 |

#### ME-S-14 — Generator edge cases

| | |
|---|---|
| **Do** | Run the generator with: one camper in a grade; 60 campers and 2 bunks; a grade with **zero** bunks; every camper mutually avoiding every other; a cohort whose school grades match no bunk. |
| **Expect** | No crash, no infinite spinner, and a report that explains what it could not do. An oversize cluster is split rather than dumped in one bunk. |
| **If it fails** | `_splitOversizeCluster` (5803), `_bunkGenFallback` (6443). |
| **Sev** | S2 |

#### ME-S-15 — Generating twice

| | |
|---|---|
| **Do** | Generate, hand-move two campers, then generate again. |
| **Expect** | It is clear whether the second run wipes manual moves. Either is defensible; a silent wipe with no warning is not. |
| **Sev** | S3 |

---

## 1.10 — Bunk staff, division heads, counselor visibility

#### ME-S-16 ★ CORE — Assign bunk staff

| | |
|---|---|
| **Do** | Open **Bunk Staff** on `A1`. Add a Counselor from the hired-staff list. Add a second with a role of Junior Counselor. Edit one. Remove one. |
| **Expect** | They save, appear on the bunk, and appear in the Link parent portal's **Bunk Staff** card for a child in `A1`. |
| **Verify** | Link → parent portal → My Children → that child. |
| **If it fails** | `openBunkStaffModal` (6629), `addBunkStaff` (6733), `getStaffForBunk` (6764). |
| **Sev** | S2 |

#### ME-S-17 ★ CORE — Bunk staff drive the tip list

| | |
|---|---|
| **Do** | In Link → Tips Setup, set a suggested amount for the Counselor role. Then open the parent portal → Tips for a child in `A1`. |
| **Expect** | The counselor on **that child's bunk only** is listed, carrying the role's suggested amount. A parent never sees the camp's whole staff list. |
| **If it fails** | `_renderTipRecipients` / `amtForRole` in `campistry_link_parent.html` (~7172), `_renderRoleTips` in `campistry_link_admin.html` (4704). |
| **Sev** | S2 — a parent seeing every staff member is a privacy failure, not a display bug. |

#### ME-S-18 — Remove staff from a bunk while a parent has the tip sheet open

| | |
|---|---|
| **Do** | Open the tip sheet as a parent. In Me, remove that counselor from the bunk. Now submit the tip. |
| **Expect** | Handled — either the tip still routes to that person (they did the work) or it is refused with a clear message. Never a tip that vanishes or lands on the wrong person. |
| **Sev** | S1 |

#### ME-S-19 — Division heads

| | |
|---|---|
| **Do** | Assign a division head to `Alpha`. Fill from hired staff. Invite them to Campistry Lite. Remove them. |
| **Expect** | Saves, appears on the division, the Lite invite is sent. |
| **If it fails** | `openDivisionHeadModal` (7011), `addDivisionHead` (7093), `inviteDivisionHeadToLite` (7127). |
| **Sev** | S3 |

#### ME-S-20 — Counselor visibility policy

| | |
|---|---|
| **Do** | Open the visibility panel. Turn off a field (e.g. medical notes). Reset to defaults. |
| **Expect** | Fields marked `always: true` are not offered as toggles — a counselor cannot do the job without them. The setting is what Campistry Lite enforces. |
| **If it fails** | `visibilityPolicy` (7380), `setCounselorVisibility` (7385), `campistry_visibility.js`. |
| **Sev** | S2 — this is a privacy control. |

---

## 1.11 — CSV / Excel import

**Read this before running any import card:** the importer treats the file as the
**new source of truth** and wipes existing data first (`campistry_me.js:18868`).
Run these on the throwaway camp, and run `archiveCurrentSeason` first if you want
the old data back.

#### ME-R-30 ★ CORE — A clean import

| | |
|---|---|
| **Do** | **Template** → download it. Fill 20 rows with Name, Division, Grade, Bunk, Team. Import. |
| **Expect** | A preview before committing. Then: structure built from the file (pass 1), campers created (pass 2), families auto-generated from parent data (pass 3), bunk assignments populated (pass 4), and a report at the end. |
| **Verify** | Counts in the report match the file. |
| **If it fails** | `handleCsv` (18582), `importRows` (18862). |
| **Sev** | S2 |

#### ME-R-31 — Hostile files

Run each of these and record what happens. **None of them may corrupt the camp.**

| File | Expected |
|---|---|
| Excel `.xlsx` with the same columns | Works — SheetJS is vendored. |
| `.ods` OpenDocument | Works. |
| UTF-8 **with BOM** | Header row parsed correctly, not `﻿Name`. |
| Semicolon-delimited | Either parsed or refused with a clear message — never one column of joined text. |
| A field containing a comma inside quotes | Parsed as one field. |
| A field containing a newline inside quotes | Parsed as one field. |
| Trailing spaces on every value | Trimmed — no ` A1` bunk distinct from `A1`. |
| The same camper listed twice | Second one disambiguated or merged; never a silent overwrite. |
| A grade that is not in the structure | Created (pass 1) or reported — not silently dropped. |
| 5,000 rows | Completes or reports honestly. Note the time. |
| A `Name` column of `=cmd\|'/c calc'!A1` | Stored as literal text. **Exporting it back to CSV must not produce a live formula** — if the export writes it unescaped, that is CSV injection and it is S1. |
| A name of `<img src=x onerror=alert(1)>` | Rendered as text everywhere. |
| An empty file / a 0-byte file / a PDF renamed `.csv` | Refused with a message. |

| | |
|---|---|
| **If it fails** | `parseCsvLine` (18818), `handleCsv` (18582), `dlCsv` (18198). |
| **Sev** | S1 for the formula and the XSS rows; S2 for the rest. |

#### ME-R-32 ★ CORE — Import over an existing camp

| | |
|---|---|
| **Do** | On a camp that already has campers with **canteen balances and billing history**, import a file that omits half of them. |
| **Expect** | You are warned clearly that this replaces the roster. Afterwards, state precisely: what happened to the omitted campers, their canteen money, and their family ledgers. |
| **Verify** | `G.campistrySnacks.transactions` — the ledger rows must still be there even if the account is gone. Billing must still show what was owed. |
| **If it fails** | `importRows` (18862) wipe block at 18868, `archiveCurrentSeason` (18851). |
| **Sev** | S1 — this is the single most destructive button in Me. |

---

## 1.12 — Persistence for Part 1

After finishing the part, prove all of it actually landed.

| | |
|---|---|
| **ME-R-33 Do** | Hard-reload. Then log out and back in. Then open the camp on a **second device**. |
| **Expect** | Structure, roster, families, bunk assignments, bunk staff, division heads, aliases, capacities, visibility policy and division order are all identical in all three. |
| **Verify** | `select key, updated_at from camp_state_kv where camp_id='<UUID>' and key in ('campistryMe','campStructure','app1','bunkMetaData') order by key;` — all three timestamps recent. |
| **If it fails** | `save` (566), `loadData` (390), `integration_hooks.js`. |
| **Sev** | S1 |

**What lives where — check this table if something "didn't save":**

| Data | Key | Notes |
|---|---|---|
| Campers, families, enrollments, custom fields, print sheets, saved reports | `campistryMe` | One row, rewritten whole. Per-user RLS (migration 164). |
| Payroll | `campistryMePayroll` | Split out by migration 158. |
| Finance | `campistryMeFinance` | Split out by migration 158. |
| Divisions / grades / bunks | `campStructure` | |
| Bunk assignments, roster mirror for the scheduler | `app1` | Multi-writer: Me owns `camperRoster`, Flow owns the rest. Fetch-merged on save. |
| Bunk capacities / metadata | `bunkMetaData` | |
| Canteen | `campistrySnacks` | |
| Camp shop | `campistryShop` | |

A key that is **workspace-operational** (`app1`, `campStructure`, `bunkMetaData`
and the scheduler keys) is prefixed `ws:<id>/` inside a session plan. `campistryMe`
and the money keys are **never** copied into a plan — see Part 8.
