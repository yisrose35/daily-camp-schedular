# Codebase Audit — Confirmed Findings

Full-codebase methodical audit (multi-phase workflow: per-subsystem bug-class finders -> adversarial verifier per finding -> completeness-critic sweep -> verify). Excludes items already in LEAGUE_AUDIT_FINDINGS.md / WALKTHROUGH_AUDIT_FINDINGS.md and documented intentional patterns. Numbered CB-1.. (severity-sorted within each phase). NONE FIXED YET unless noted.

Bug classes hunted per subsystem: data loss/corruption, cloud/local desync, cross-date contamination, multi-user/role gaps, slot-index-vs-time keying, stale-cache/load-precedence, silent no-ops (saved-but-never-read settings), error swallowing, XSS/escaping, dead/divergent duplicate code.

**[LIVE] = needs live browser/Supabase verification to fully confirm trigger.**

---

## Phase 1 — cloud sync/save/load/realtime, solvers (auto+manual), daily-adjustments+post-edit (55 findings: 8 HIGH / 32 MED / 15 LOW)

Run wf_d3cfa12c-d21 (resumed after session-limit). 82 agents.


### HIGH

#### CB-1 [CONFIRMED] supabase_schedules.js:973  _(cloud)_
**saveSchedule builds divisionTimes (and pbSlots/skeleton fallbacks) from LIVE window state, not the passed payload — every allowCrossDate save stamps the viewed date's grid onto another date's cloud row**

- Evidence: Payload construction ignores data.divisionTimes entirely: `divisionTimes: window.DivisionTimesSystem?.serialize(window.divisionTimes) || {}` (L973). Same pattern: `unifiedTimes: serializeUnifiedTimes(data.unifiedTimes || window.unifiedTimes || [])` (L970), `slotCount: data.unifiedTimes?.length || window.unifiedTimes?.length || 0` (L971), `_perBunkSlotsData` falls back to `window.divisionTimes` (L983-990), `manualSkeleton: data.manualSkeleton || w
- Scenario: User is viewing 06-12 and renames a field (or a league renumber touches future days). saveGlobalSettings('daily_schedules') fans out a secondary save for 06-15; the 06-15 cloud row is upserted with 06-15's scheduleAssignments but 06-12's divisionTimes/_perBunkSlotsData/slotCount. Next load of 06-15: MS-4c hands the content-winner's (contaminated) g
- Verifier: The payload built by saveSchedule (supabase_schedules.js) is split-sourced: scheduleAssignments comes from the PASSED payload (L921 `data.scheduleAssignments` under skipFilter, else filtered at L925), but the grid metadata that must MATCH those assignments is read from LIVE window state, not from `data`: - L973 `divisionTimes: window.DivisionTimesS

#### CB-2 [CONFIRMED] supabase_schedules.js:485  _(cloud)_
**Transient query error is indistinguishable from 'no records' — loadSchedule deletes the local cache and reports recordCount:0, which downstream consumers treat as 'owner deleted everything' and full-clear memory + localStorage**

- Evidence: loadAllSchedulersForDate swallows errors: `if (error) { logError('Query error:', error); return []; }` (L485-487) and the catch also returns [] (L492-495). loadSchedule then: `if (!records || records.length === 0) { log('No cloud records — clearing local cache for this date'); deleteLocalSchedule(dateKey); return { success: true, data: {...empty...}, source: 'cloud', recordCount: 0 }; }` (L454-457). Consumers act destructively on recordCount===0:
- Scenario: A realtime change arrives (or the user changes dates) just as the network blips / the auth token is mid-refresh: the daily_schedules SELECT errors → [] → recordCount 0 → refreshMultiSchedulerView wipes the in-memory schedule, any unsaved edits, and the date's localStorage record (including the LOCAL_ONLY fields that exist nowhere else — bunkActivit
- Verifier: Every link in the claimed chain is real code. (1) loadAllSchedulersForDate conflates transient failure with empty: BOTH the `if (error)` branch and the `catch` return `[]` (supabase_schedules.js L485-487, L492-495). (2) loadSchedule treats `records.length === 0` as a genuinely-empty date: it calls `deleteLocalSchedule(dateKey)` and returns `recordC

#### CB-3 [CONFIRMED] schedule_orchestrator.js:381  _(cloud)_
**hydrateRotationHistory 'slimming' rewrites EVERY non-today date — including FUTURE dates — to {scheduleAssignments-only}, permanently destroying their LOCAL_ONLY fields**

- Evidence: After hydrating ≥1 past date from cloud (`if (hydrated > 0)`), the slim loop iterates ALL date keys: `for (const dk of Object.keys(allDaily)) { ... if (dk === todayKey) continue; ... allDaily[dk] = { scheduleAssignments: slim }; }` (L361-382, replacement at L381). The only exclusion is todayKey — `dk < todayKey` is never checked, so future dates with cached schedules are also rewritten. The replacement drops divisionTimes/unifiedTimes (cloud-reco
- Scenario: Early in the season (fewer than 5 past dates with schedules in localStorage — the trigger at L328), a user sets Daily Adjustments bunk overrides for tomorrow, then loads today's schedule. loadSchedule → hydrateRotationHistory fires, pulls one past day from cloud, and the slim pass rewrites tomorrow's local record to bare scheduleAssignments — tomor
- Verifier: The mechanism is real and the decisive code confirms it. In schedule_orchestrator.js hydrateRotationHistory(todayKey) (called from loadSchedule(dateKey) at L723 with the date being loaded as todayKey), the slim loop at L361-382 iterates EVERY date key in campDailyData_v1 and the only date exclusion is `if (dk === todayKey) continue;` (L363) — there

#### CB-4 [CONFIRMED / LIVE] schedule_orchestrator.js:837  _(cloud)_
**Orchestrator's parallel merge (mergeCloudRecords) bypasses ALL multi-scheduler merge fixes (MS-3 division stamps, MS-4c grid/content pairing, #V2-25 deleted-bunk prune) and its delayed re-apply can override the correct merge**

- Evidence: schedule_orchestrator.js:863-869: `for (const record of records) { ... if (data.scheduleAssignments) { Object.assign(merged.scheduleAssignments, data.scheduleAssignments); }` — per-bunk winner is the row with the newest updated_at WHOLESALE, ignoring payload._divStamps (the MS-3 fix that lives only in ScheduleDB.mergeSchedules, supabase_schedules.js:549+). No #V2-25 structure prune (deleted bunks resurrect), divisionTimes merged by 'more slots wi
- Scenario: Camp has 2 scheduler rows for 06-15. Scheduler A ran a scoped generation that re-saved STALE copies of the owner's divisions under a fresh row timestamp (the MS-3 scenario). Owner reloads flow.html: integration_hooks' load uses the stamped merge and shows the correct schedule, but the orchestrator's initialize() load (or its 2s/5s re-apply, which f
- Verifier: The orchestrator's mergeCloudRecords is a SECOND, parallel cloud-merge implementation that bypasses every multi-scheduler fix, and it is live on flow.html. VERIFIED FACTS: 1. mergeCloudRecords (schedule_orchestrator.js L856-897) sorts records by updated_at ascending (L857-861) then does naive `Object.assign(merged.scheduleAssignments, data.schedul

#### CB-5 [PLAUSIBLE / LIVE] scheduler_core_main.js:1665  _(solvers)_
**Manual STEP 0f rotation-history hydration slims EVERY other date (incl. future) to activity-strings, dropping leagues/divisionTimes/skeleton/times — and propagates the slim to cloud**

- Evidence: _slimPastDate returns ONLY scheduleAssignments and keeps only _activity/sport/field/continuation/_isTransition per slot: L1683 `return { scheduleAssignments: slimSched };` (drops leagueAssignments, manualSkeleton/autoSkeleton, unifiedTimes, divisionTimes, _perBunkSlotsData, trips, rainy state) L1672-1681 keep-list omits _startMin/_endMin (real slot times lost too). The slim is applied to ALL date keys, only excluding today: L1685 `for (const dk o
- Scenario: In MANUAL mode: user builds a complete schedule for a future date D_fut (skeleton + league pairings + divisionTimes/per-bunk slots) earlier in the session (so _secondarySaveHash[D_fut] = full-data hash). User then navigates to today and clicks Generate. STEP 0f hydration finds at least one past date missing from localStorage (fresh browser / after
- Verifier: The code says exactly what the claim says, and the mechanism is real. (1) `_slimPastDate` (scheduler_core_main.js L1665-1683) returns ONLY `{ scheduleAssignments: slimSched }` and per slot keeps just `_activity`/`sport`/`field`/`continuation`/`_isTransition` — it drops leagueAssignments, divisionTimes, manualSkeleton/autoSkeleton, _perBunkSlotsData

#### CB-6 [CONFIRMED / LIVE] supabase_schedules.js:336  _(solvers)_
**Scheduler save-scope filter (MS-2) falls back to getEditableDivisions() = ALL divisions, so a scheduler's auto/manual cloud save absorbs every division and shadows the owner in the per-bunk merge**

- Evidence: getMyEditableBunks() (supabase_schedules.js:332-338): let editableDivisions = []; if (role === 'scheduler') { try { editableDivisions = window.AccessControl?.getGeneratableDivisions?.() || []; } catch(e){} } if (!editableDivisions.length) { editableDivisions = window.AccessControl?.getEditableDivisions?.() || []; } The MS-2 comment right above (L324-331) says the WHOLE point is to scope a scheduler's save to their ASSIGNED divisions 'not th
- Scenario: Scheduler assigned only 'Minors' via a subdivision; their _editableDivisions/_directDivisionAssignments haven't resolved yet (cached role='scheduler' loaded from localStorage at init L295 before DB subdivision rows resolve; canEdit() lets schedulers through pre-init, access_control.js:1621). Scheduler clicks Generate. getGeneratableDivisions() -> [
- Verifier: The full code chain is verified. (1) supabase_schedules.js:332-338 — for a scheduler, getMyEditableBunks tries getGeneratableDivisions() and, on empty, falls through `if (!editableDivisions.length) editableDivisions = getEditableDivisions()`. (2) access_control.js:1219-1221 — getEditableDivisions() returns ALL divisions for a SCHEDULER (`const allD

#### CB-7 [CONFIRMED] post_edit_system.js:746  _(dailyadj)_
**post_edit_system.js has NO HTML escaper — broad stored/attribute XSS across the edit modal, conflict panel, and drag tooltips (diverged copy of unified's conflict renderer)**

- Evidence: The entire file contains zero escaper (grep for CampUtils/escapeHtml/escHtml/_escHtml returns nothing; the only `esc` at L1512 is an Escape-KEY handler). It interpolates user-controlled field names, bunk names and activity names raw into innerHTML in many sinks. ATTRIBUTE-BREAKOUT (worst): L746 `<input type="text" id="post-edit-activity" value="${currentActivity}" ...>` where L720 `currentActivity = entry._activity || currentField || currentValue
- Scenario: A field named `Pool"><img src=x onerror=alert(document.cookie)>` (configured in Facilities) appears in the post-edit location dropdown; selecting it and triggering the conflict path renders it raw into the conflict/status innerHTML and executes. Or: in the edit modal, type an activity name containing `"><img src=x onerror=...>` and save -> it is st
- Verifier: Verified every load-bearing element against the actual code in post_edit_system.js (loaded in flow.html:709). The file has ZERO HTML escaper (grep for CampUtils/escapeHtml/escHtml/_escHtml returns nothing; the only `esc` at L1512 is the `if (ev.key === 'Escape')` key handler, correctly excluded as a non-escaper) yet interpolates user-controlled str

#### CB-8 [CONFIRMED / LIVE] scheduler_core_main.js:3893  _(solvers)_
**Manual STEP 7.55 room-capacity sweep DEMOTES off-site Trip blocks — collapses a whole division's trip to a single bunk, then STEP 7.6 refills the rest with on-campus sports**

- Evidence: STEP 2.4 pins a Daily Trip across every bunk of a division writing `window.scheduleAssignments[bunk][slotIndex] = { field: tripName, sport:null, continuation:i>0, _fixed:true, _activity:tripName, _isTrip:true, _bunkOverride:true, _zone:'offsite' }` (L2755-2759) — note NO `_pinned`. STEP 7.55's protection flag is `var prot = !!(e._league || e._postEdit || e._pinned);` (L3893) — it omits `_isTrip` and `_bunkOverride`, so trip blocks are NOT protect
- Scenario: A camp adds an off-campus Trip for a division of 6 bunks (e.g. Minors 1-6 to 'Six Flags' 9:30-15:00) via the Trips popover, then runs a MANUAL generation for that date. STEP 2.4 pins the trip onto all 6 bunks. STEP 7.55 treats 'six flags' as an unknown not_sharable cap-1 room, keeps Minors 1's trip block and demotes Minors 2-6's trip blocks to Free
- Verifier: Every link in the claim's chain is present in the real code of scheduler_core_main.js. (1) TRIP WRITTEN UNPROTECTED — STEP 2.4 pins the trip on every bunk of the division with `window.scheduleAssignments[bunk][slotIndex] = { field: tripName, sport:null, continuation:i>0, _fixed:true, _activity:tripName, _isTrip:true, _bunkOverride:true, _zone:'off


### MED

#### CB-9 [CONFIRMED] integration_hooks.js:2895  _(cloud)_
**Multiple direct localStorage writers REPLACE campDailyData_v1[date] without the LOCAL_ONLY_FIELDS carry-forward — every tab close wipes the current date's local-only adjustments**

- Evidence: ScheduleDB.setLocalSchedule exists precisely to carry LOCAL_ONLY_FIELDS forward (supabase_schedules.js L236-248), but four writers bypass it and assign whole records: (1) hookBeforeUnload L2893-2896: `allData[dateKey] = payload; localStorage.setItem(DAILY_KEY, ...)` where buildFullPayload (L2858-2884) contains no bunkActivityOverrides/leagueRoundState/leagueDayCounters/autoSkeleton — runs on EVERY page unload; (2) hookRemoteChanges current-date m
- Scenario: User makes Daily Adjustments bunk-activity overrides (saved only as campDailyData_v1[date].bunkActivityOverrides via saveCurrentDailyData), then closes the tab. beforeunload's direct write replaces the record with the override-less payload; the override bookkeeping (DA panel state, undo, override badges) is gone on the next session. Same loss fires
- Verifier: The bug is real for the scenario's named field (bunkActivityOverrides) and the named writers. VERIFIED CHAIN: 1. bunkActivityOverrides is a true LOCAL_ONLY field with NO cloud backup. The cloud upsert payload (supabase_schedules.js L966-974, written to daily_schedules.schedule_data at L1085) is an explicit allowlist — scheduleAssignments, schedule

#### CB-10 [PLAUSIBLE / LIVE] schedule_orchestrator.js:863  _(cloud)_
**Orchestrator's mergeCloudRecords is a stale duplicate of the merge: no _divStamps (MS-3), no #V2-25 structure prune, drops scheduleSegments — and it drives the initial flow-page load**

- Evidence: mergeCloudRecords (L837-936) merges per record with row-level newest-wins: `records.sort(...updated_at...); for (const record of records) { ... Object.assign(merged.scheduleAssignments, data.scheduleAssignments); }` (L857-869). It ignores payload._divStamps (the MS-3 per-division recency fix that ScheduleDB.mergeSchedules applies at supabase_schedules.js L549-611), has no #V2-25 deleted-bunk prune, and never merges data.scheduleSegments (merged o
- Scenario: Two-scheduler camp: scheduler B's row carries stale carried-forward copies of division X with a fresh updated_at (the exact MS-3 case). On the owner's next PAGE LOAD (not date-change), the orchestrator's legacy merge picks B's stale copy of X by row timestamp, displays it, caches it locally without scheduleSegments, and the deleted-bunk resurrectio
- Verifier: The structural core of the claim is TRUE. schedule_orchestrator.js mergeCloudRecords (L837-936) is a stale duplicate of the canonical merge: it does row-level newest-wins only — `records.sort((a,b)=>...updated_at...)` (L857-861) then `Object.assign(merged.scheduleAssignments, data.scheduleAssignments)` (L867-869) — with (a) NO payload._divStamps /

#### CB-11 [CONFIRMED / LIVE] schedule_orchestrator.js:812  _(cloud)_
**Delayed re-apply guard timers (500ms/2s/5s) have no current-date check — navigating to a sparser/empty date within 5s re-hydrates the OLD date's schedule under the new view**

- Evidence: After a cloud-direct load, three timers capture the loaded data in a closure: `setTimeout(() => reApply('500ms'), 500); setTimeout(() => reApply('2s'), 2000); setTimeout(() => reApply('5s'), 5000);` (L812-814). reApply (L777-811) compares activity counts and on `currentActs < expectedActs` calls `hydrateWindowGlobals(stableResult, dateKey)` — with the OLD dateKey, which also re-stamps `window._scheduleAssignmentsDate = ownerDateKey` (L411). Nothi
- Scenario: User loads populated date A (timers armed), then within 5s navigates to empty/sparser date B. Date B hydrates (0 activities). The A-timer fires: 0 < expectedActs → re-applies A's schedule into memory, calls updateTable, and stamps the owner date back to A — the user now SEES date A's schedule while the picker says B. Edits made there mutate A's dat
- Verifier: The defect is real and present in code. In loadSchedule (cloud-direct path), after hydrating date A, three fire-and-forget timers are armed: `setTimeout(() => reApply('500ms'), 500); setTimeout(() => reApply('2s'), 2000); setTimeout(() => reApply('5s'), 5000);` (L812-814). reApply (L777-811) closes over `dateKey` (= load param, date A) and `stableR

#### CB-12 [PLAUSIBLE / LIVE] supabase_schedules.js:1303  _(cloud)_
**deleteMyScheduleOnly does unguarded read-modify-write of OTHER schedulers' rows — a concurrent save by the row owner between SELECT and UPDATE is clobbered with the stale snapshot**

- Evidence: For each foreign record it loads schedule_data, deletes its own bunks, then writes the WHOLE blob back: `.update({ schedule_data: updatedData, updated_at: new Date().toISOString() }).eq('id', record.id)` (L1303-1309) with no optimistic-concurrency condition (no `.eq('updated_at', record.updated_at)`). updatedData is `{ ...scheduleData, scheduleAssignments, leagueAssignments }` (L1298-1302) built from the snapshot taken at L1247 — any edit the own
- Scenario: Scheduler S clicks 'erase my schedule' for 06-15 (hookEraseFunctions → deleteMyScheduleOnly). While the loop walks the records, the owner saves an edit to their own 06-15 row. S's update then overwrites the owner's row with the pre-edit snapshot (minus S's bunks) — the owner's just-saved changes vanish with a newer updated_at, so realtime dedup/mer
- Verifier: The mechanism the claim describes is REAL in the code. deleteMyScheduleOnly (supabase_schedules.js) does SELECT (loadAllSchedulersForDate, L1247) -> mutate-in-JS -> blind write-back: `.update({ schedule_data: updatedData, updated_at: new Date().toISOString() }).eq('id', record.id)` (L1303-1309), with updatedData = `{ ...scheduleData, scheduleAssign

#### CB-13 [PLAUSIBLE / LIVE] schedule_orchestrator.js:643  _(cloud)_
**Orchestrator loadSchedule treats confirmed-empty cloud (0 records, no error) as load failure and falls back to stale localStorage — deleted dates resurrect at boot and can re-save to cloud**

- Evidence: STEP 1 only sets success on non-empty: `if (!error && records && records.length > 0) { ... }` else just logs 'No cloud records for' (L643-670, result.success stays false). STEP 2 then loads localStorage: `if (!result.success) { const localData = getLocalData(dateKey); if (localData) { result = { success: true, source: 'localStorage', data: localData, ... } } }` (L688-700) and hydrates it into window globals (L718). Every sibling loader handles co
- Scenario: Owner deletes 06-18 entirely from device A (cloud rows gone). Device B was closed at the time, so no realtime DELETE arrived; its campDailyData_v1 still holds 06-18. Device B is opened the next morning with the date picker on 06-18: cloud query succeeds with 0 records, orchestrator falls back to the stale localStorage copy and hydrates a full sched
- Verifier: Code reading is accurate. Orchestrator STEP 1 only sets success on non-empty records — `if (!error && records && records.length > 0)` (schedule_orchestrator.js:643); confirmed-empty (0 records, no error) falls to the `else` that merely logs 'No cloud records for' (L669) leaving result.success=false. STEP 2 then loads stale localStorage: `if (!resul

#### CB-14 [CONFIRMED] integration_hooks.js:876  _(cloud)_
**forceSyncToCloud converts every save into a WHOLE-STATE push — all camp_state_kv keys re-upserted with updated_at=NOW, letting stale per-key local values clobber other devices' newer rows**

- Evidence: `const localSettings = getLocalSettings(); const allChanges = { ...localSettings, ..._pendingChanges }; _pendingChanges = allChanges; await executeBatchSync();` (L875-879). executeBatchSync then maps EVERY key of _pendingChanges to a row with `updated_at: nowIso` and upserts them all (L766-771, L806-808) — no per-key change detection. So a single call re-writes every KV row (leagueHistory, leaguesByName, specialtyLeagues, rotationHistory, app1, l
- Scenario: Admin A and admin B both online. B enters league scores (cloud leaguesByName row updated 10s ago); A's realtime delivery for that key is delayed/dropped, so A's _localCache.leaguesByName is stale. A then toggles one special activity — special_activities.js calls forceSyncToCloud — and A re-upserts ALL keys including the stale leaguesByName with upd
- Verifier: The claim is mechanically accurate and confirmed by the actual code; it is NOT an excluded duplicate. WRITE-PATH MECHANISM (the heart of the claim): - forceSyncToCloud (integration_hooks.js L848-882): `const localSettings = getLocalSettings(); const allChanges = { ...localSettings, ..._pendingChanges }; _pendingChanges = allChanges; await executeB

#### CB-15 [PLAUSIBLE / LIVE] supabase_sync.js:949  _(cloud)_
**Realtime refresh full-replaces window.scheduleAssignments in manual mode, clobbering the user's unsaved in-memory edits and defeating integration_hooks' deliberate preserve-my-bunks merge**

- Evidence: handleRealtimeChange schedules `refreshMultiSchedulerView(_currentDateKey, true)` (L948-950, forceOverwrite=true) → forceHydrateFromLocalStorage(dateKey, true), whose only protection is auto-generation grades: `if (localDT[grade] && localDT[grade]._isPerBunk && ...)` builds myBunks (L192-201); in MANUAL mode no grade has _isPerBunk, so `myBunks.size === 0` → `window.scheduleAssignments = JSON.parse(JSON.stringify(dateData.scheduleAssignments)); /
- Scenario: Owner is hand-editing bunk slots on the grid for 06-14 (manual mode). A scheduler on another account saves their divisions, the realtime event arrives, and 500ms later refreshMultiSchedulerView full-replaces window.scheduleAssignments from the merged cloud snapshot — which does not yet contain the owner's last edit. The edit disappears from the scr
- Verifier: The structural mechanism the claim describes is real and confirmed in code. supabase_sync's realtime handler `handleRealtimeChange` first calls `notifyRemoteChange(data)` SYNCHRONOUSLY (L924), which invokes integration_hooks' registered callback (L1167-1175 forEach). That callback (integration_hooks L2632-2652) deliberately preserves in-progress wo

#### CB-16 [PLAUSIBLE] supabase_schedules.js:634  _(cloud)_
**unifiedTimes merged by LONGEST ARRAY (count-based, not recency) in all four merge/refresh paths — a reduced slot count can never propagate; the stale longer grid re-persists forever**

- Evidence: mergeSchedules: `if (data.unifiedTimes.length > mergedUnifiedTimes.length) { mergedUnifiedTimes = data.unifiedTimes; }` (L633-637, repeated for record.unified_times L641-646) — MS-4c replaced the analogous 'more slots wins' rule for divisionTimes with content-winner-by-stamp (L714-716) but unifiedTimes was left count-based. Same rule in schedule_orchestrator.js mergeCloudRecords L876-888, supabase_sync.js syncMergeFromCloud L519-524 (`cloudResult
- Scenario: Owner regenerates 06-13 with a shorter day (10 unified slots; the previous generation had 12). A scheduler's row for 06-13 still carries the old 12-slot unifiedTimes. Every load merges assignments fresh (10-slot shape, stamps respected) but picks the STALE 12-slot unifiedTimes because 12 > 10 — the grid renders two phantom periods, slotCount disagr
- Verifier: The code-level defect is REAL and exactly as described. All four paths merge unifiedTimes by array length, never by recency: supabase_schedules.js mergeSchedules L633-646 (`if (data.unifiedTimes.length > mergedUnifiedTimes.length) { mergedUnifiedTimes = data.unifiedTimes; }` plus the identical record.unified_times block); schedule_orchestrator.js m

#### CB-17 [PLAUSIBLE / LIVE] supabase_schedules.js:1284  _(cloud)_
**deleteMyScheduleOnly: scheduler's emptied own row is DELETEd, but RLS restricts DELETE to owner/admin — the delete silently no-ops and the schedule resurrects**

- Evidence: In deleteMyScheduleOnly, when removing the scheduler's bunks empties a record (the normal case for their OWN row, which post-MS-2 contains only their bunks): `if (bunksAfter === 0) { ... const { error } = await client.from(CONFIG.TABLE_NAME).delete().eq('id', record.id); ... recordsDeleted++;` (L1281-1293). migrations/003_daily_schedules_rls.sql L46-52 grants DELETE only to `['owner','admin']` (UPDATE allows scheduler, DELETE does not). An RLS-fi
- Scenario: A scheduler clicks erase for 06-15 (integration_hooks eraseAllSchedules non-full-access branch, L2819, confirms 'Delete YOUR schedule... Other schedulers' data will be preserved'). deleteMyScheduleOnly strips their bunks from the owner's record via UPDATE (allowed), attempts to DELETE their own emptied row (silently blocked), reports success — then
- Verifier: The code-level mechanism is fully confirmed; only the live RLS runtime outcome remains unverifiable from source. Walking the actual code: (1) loadAllSchedulersForDate (supabase_schedules.js:474-490) returns ALL rows for camp_id+date_key with NO scheduler_id filter, and the save path upserts on onConflict:'camp_id,date_key,scheduler_id' (L1090) — so

#### CB-18 [PLAUSIBLE / LIVE] supabase_schedules.js:388  _(cloud)_
**filterScheduleToMyBunks returns the UNFILTERED full schedule when the editable-bunk set is empty ('let RLS handle it') — but RLS never inspects content, so a role/AccessControl init race lets a scheduler upload all divisions with fresh stamps**

- Evidence: `if (myBunks.size === 0) { ... // Return original to avoid saving empty - let RLS handle it\n return scheduleAssignments; }` (L384-390). RLS on daily_schedules (migrations/003) only checks camp_id + get_user_role() per ROW — it cannot strip foreign divisions out of schedule_data, so the 'let RLS handle it' assumption is false. getMyEditableBunks returns [] whenever CampistryDB.getRole() still fails closed to 'viewer' (supabase_client.js V-002) or
- Scenario: Scheduler opens flow.html; a config tweak fires saveCurrentDailyData ~1s after load, before the camp_users role query resolves. getRole()='viewer' → myBunks empty → full 35-bunk schedule (hydrated from yesterday's localStorage snapshot of all schedulers' data) is upserted into the scheduler's row with every division stamped NOW. The server accepts
- Verifier: Every static assertion in the claim is verified true against the code. (1) filterScheduleToMyBunks returns the UNFILTERED full schedule when the editable set is empty — supabase_schedules.js L384-390: `if (myBunks.size === 0) { ... // Return original to avoid saving empty - let RLS handle it; return scheduleAssignments; }`. (2) getMyEditableBunks()

#### CB-19 [PLAUSIBLE / LIVE] integration_hooks.js:1453  _(cloud)_
**saveGlobalSettings('daily_schedules') STEP-5 secondary-date fanout uses skipFilter:true even for scheduler accounts — full-camp snapshots get re-stamped NOW in the scheduler's row for propagated dates**

- Evidence: `window.ScheduleDB.saveSchedule(dk, data[dk], { skipFilter: true, allowCrossDate: true })` (L1451-1453) fans out every changed non-primary date. data[dk] is the campDailyData_v1 row = the MERGED all-scheduler snapshot, and skipFilter bypasses the MS-2 scheduler scoping entirely (supabase_schedules.js:920-922). On the save side, for a non-gen date `scopeActive` is false (window.__lastGenScope.date !== dk), so the MS-3 stamp block stamps EVERY divi
- Scenario: Scheduler A (Juniors only) generates 06-12; the league engine's future-relabel rewrites game labels on 06-15..06-19 in allDailyData → saveGlobalSettings('daily_schedules') fans those dates out with skipFilter:true. A's row for 06-15 now contains EVERY division (copied from A's last local refresh) stamped NOW. The owner had reworked Seniors' 06-15 a
- Verifier: The code mechanism is real and the claim's lines are accurate. Trigger path: a scheduler's post-generation save calls saveGlobalSettings('daily_schedules', allDaily) (scheduler_core_auto.js:22989, daily_adjustments.js:5419/5446) and/or the league future-relabel saves directly (scheduler_core_leagues.js:347) — both fan out propagated future dates wi

#### CB-20 [PLAUSIBLE] schedule_orchestrator.js:345  _(cloud)_
**hydrateRotationHistory merges multiple scheduler rows per past date with Object.assign in arbitrary query order — stale row can win shared bunks and poison 14 days of rotation history**

- Evidence: schedule_orchestrator.js:345-349: `const merged = {}; for (const rec of recs) { const sd = rec.schedule_data || {}; if (sd.scheduleAssignments) Object.assign(merged, sd.scheduleAssignments); }` — recs come from loadDateRange (supabase_schedules.js:500-522, a plain SELECT with NO .order clause) and are grouped by date in whatever order PostgREST returns rows. There is no updated_at sort (both real merges sort ascending so newest wins) and no _divS
- Scenario: Owner's row for 06-08 contains a stale copy of Bunk 'Trios 2' (saved before scheduler B regenerated that division; B's row holds the real day with Drama). On a fresh device, hydrateRotationHistory pulls both rows for 06-08 and PostgREST returns the owner's row last → the stale slate (no Drama) wins the merge into local history. Next generation unde
- Verifier: The mechanism is real and the claim accurately describes the code. (1) loadDateRange (supabase_schedules.js:506-511) is a plain SELECT with .eq/.gte/.lte and NO .order — PostgREST row order is arbitrary. (2) hydrateRotationHistory (schedule_orchestrator.js:345-349) merges per-date rows with a bare Object.assign(merged, sd.scheduleAssignments) in th

#### CB-21 [PLAUSIBLE / LIVE] supabase_schedules.js:727  _(cloud)_
**mergeSchedules drops _autoGenerated and manualSkeleton that saveSchedule deliberately uploads for the load side — only the orchestrator's secondary merge returns them, so the primary date-change/realtime load paths lose the auto-mode signals**

- Evidence: Save side (supabase_schedules.js:1061-1070): 'DAY 16b FIX: Round-trip _autoGenerated + manualSkeleton too. These tell the load-side code path "this was an auto build"...' — `payload._autoGenerated = true; ... payload.manualSkeleton = ms;`. But mergeSchedules' return object (L727-741) contains only scheduleAssignments/scheduleSegments/leagueAssignments/unifiedTimes/divisionTimes/_perBunkSlotsData/slotCount/isRainyDay — `data._autoGenerated` and `d
- Scenario: Scheduler generates an auto-mode day on device A (cloud row has _autoGenerated:true + manualSkeleton). Owner opens device B and navigates to that date — the load goes through ScheduleDB.loadSchedule, so window._autoGenerated stays unset and window._autoSkeleton is never populated. Post-edit gates and the auto-mode rebuild logic take the manual bran
- Verifier: The factual mechanism is CONFIRMED but the asserted harm is unsupported by the consumer code, so the net is PLAUSIBLE (needs live testing to show any real wrong-branch behavior). VERIFIED-TRUE parts: mergeSchedules' return object (supabase_schedules.js:727-741) genuinely omits `_autoGenerated` and `manualSkeleton` — it returns only scheduleAssignm

#### CB-22 [CONFIRMED] schedule_versions_db.js:164  _(cloud)_
**ScheduleVersionsDB never exports deleteVersion — the auto-backup cleanup loop that depends on it is silently dead, so schedule_versions grows without bound**

- Evidence: schedule_versions_db.js:164-171 exports `window.ScheduleVersionsDB = { listVersions, getVersion, createVersion, saveVersion: createVersion, updateVersion, createBasedOn };` — no delete function exists anywhere in the file. The wired consumer, unified_schedule_system.js:5990-5996 cleanupOldAutoBackups (invoked after every auto-backup at L5953), guards on it: `if (window.ScheduleVersionsDB.deleteVersion) { await window.ScheduleVersionsDB.deleteVers
- Scenario: Every displacement/edit that triggers an auto-backup inserts a full-schedule row named 'Auto-backup before ...' into schedule_versions; cleanup runs, logs 'Cleanup complete: removed 0 old backups', and deletes nothing. Over a season a busy camp accumulates hundreds of full-schedule rows per date in Supabase — table bloat, slower listVersions, and a
- Verifier: The claim holds against the actual code. schedule_versions_db.js exports window.ScheduleVersionsDB = { listVersions, getVersion, createVersion, saveVersion: createVersion, updateVersion, createBasedOn } (lines 164-171) — there is NO deleteVersion and no .delete() call anywhere in the file (Grep for `\.delete\(|deleteVersion|function delete` over th

#### CB-23 [CONFIRMED / LIVE] scheduler_core_auto.js:22912  _(solvers)_
**Auto STEP 5 + FN-59 final save key localStorage off raw window.currentScheduleDate, not the FN-14-hardened currentDate — a mid-gen date revert writes the new schedule onto the PREVIOUS date**

- Evidence: FN-14 deliberately established an authoritative gen-date because window.currentScheduleDate can revert mid-gen: L890-896 `// ★ FN-14 (final): prefer the date runOptimizer snapshotted at entry ... over window.currentScheduleDate — which can transiently revert to the PREVIOUS date mid-gen` ... `const currentDate = window._activeGenDate || window.currentScheduleDate || window.currentDate || '';` But the STEP 5 localStorage save ignores `currentDate`
- Scenario: Auto gen for D_new starts (passes the FN-17 start guard, so currentDate=_activeGenDate=D_new). During the long solver run an accumulated-async state change reverts window.currentScheduleDate to the previously-loaded D_prev (the exact race FN-14 documents). STEP 5 then writes the freshly-generated D_new schedule into campDailyData_v1[D_prev], overwr
- Verifier: The claim matches the code line-for-line. Both direct localStorage writes inside runAutoScheduler (defined L457, closes L25812) read the volatile global instead of the FN-14 authority, and both bypass the cross-date guard. STEP 5 (L22912): `const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];` then writes raw at L2

#### CB-24 [CONFIRMED] scheduler_core_auto.js:13048  _(solvers)_
**Swim partial-rotation history (swimRotationHistory) is localStorage-only — its cloud write is a dead no-op, and a stale cloud-app1 snapshot shadows the fresh local copy**

- Evidence: saveSwimHistory() (L13048-13055) persists swim rotation history to only two places: an in-memory mutation `gs.app1.swimRotationHistory = swimHistory` (L13051) and `localStorage.setItem('campistry_swimRotationHistory', ...)` (L13052). The ONLY intended cloud path is `if (window.IntegrationHooks?.queueChange) window.IntegrationHooks.queueChange('swimRotationHistory', swimHistory)` (L13053) — but `window.IntegrationHooks` is NEVER assigned anywhere
- Scenario: Camp has a grade where swim is partial (bunksPerDay < total bunks, e.g. 4 of 8 bunks swim per day). getSwimmersForToday (L13132+) picks the least-recently-swum bunks using swimHistory[grade] week counts (L13142-13162). (a) Cross-device / cache-clear: owner generates all week on device A (history saved to A's localStorage only). On device B (or afte
- Verifier: All load-bearing claims verified against the actual code in scheduler_core_auto.js + integration_hooks.js + cloud_sync_helpers.js. PILLAR 1 — the dedicated cloud write is a dead no-op. `window.IntegrationHooks` is NEVER assigned anywhere in the repo. Grep for IntegrationHooks across the tree returns only two files: scheduler_core_auto.js (the 3 ca

#### CB-25 [CONFIRMED] scheduler_core_auto.js:13074  _(solvers)_
**Weekly activity history (activityHistory, drives multi-day consecutive-streak variety) is localStorage-only via the same dead queueChange no-op + stale-cloud-shadows-fresh read**

- Evidence: saveWeekHistory() (L13074-13105) records each bunk's daily sport/special assignments into weekActivityHistory, then persists to only `gs.app1.activityHistory = weekActivityHistory` (L13099, in-memory, never flushed) and `localStorage.setItem('campistry_activityHistory', ...)` (L13100). The cloud path `if (window.IntegrationHooks && window.IntegrationHooks.queueChange) { window.IntegrationHooks.queueChange('activityHistory', weekActivityHistory);
- Scenario: On a second device or after a cache clear, loadWeekHistory yields empty history → countConsecutiveStreak returns 0 for every bunk/sport → the multi-day anti-repeat penalty is disabled → bunks can be scheduled the same sport on consecutive days that a populated history would have avoided (the v11.0 'multi-day awareness' silently degrades). Equivalen
- Verifier: VERIFIED against the actual code. (1) Dead cloud path: scheduler_core_auto.js:13101-13103 calls `window.IntegrationHooks.queueChange('activityHistory', ...)`, but a repo-wide grep shows `queueChange` is NEVER defined — it is only ever called (3 guarded sites). `window.IntegrationHooks` exists (integration_hooks.js) but exposes no `queueChange` meth

#### CB-26 [CONFIRMED / LIVE] daily_adjustments.js:4833  _(solvers)_
**Auto-mode MS-1 role clamp resolves scope synchronously with no subdivision fallback; when a scheduler's generatable set is empty the clamp is skipped and runAutoScheduler generates ALL divisions unscoped**

- Evidence: runOptimizer (daily_adjustments.js:4831-4838): let _roleScope = null; try { const _gd = window.AccessControl?.getGeneratableDivisions?.(); const _allDivCount = Object.keys(window.divisions||{}).length; if (Array.isArray(_gd) && _gd.length>0 && _allDivCount>0 && _gd.length<_allDivCount) { _roleScope = _gd.map(String); } } catch(_eRS){} The clamp only engages when _gd.length>0. The auto solver does NOT self-clamp by role (scheduler_co
- Scenario: Same unresolved-scheduler state as finding #1, in AUTO mode. getGeneratableDivisions() returns [] -> _roleScope=null -> no clamp -> runAutoScheduler(layers,{allowedDivisions:null}) regenerates every division. Combined with the broken save filter (#1), the scheduler both GENERATES and SAVES all divisions, maximizing the cross-user stomp. The MS-1 fi
- Verifier: The claim is accurate and the mechanism is fully wired in real code. AUTO-mode runOptimizer (daily_adjustments.js:4831-4846) is the ONLY role-scoping point in the auto path, and it uses the SYNCHRONOUS getGeneratableDivisions(). For a SCHEDULER whose subdivision IDs are not yet resolved, getGeneratableDivisions() returns [] (access_control.js:1246:

#### CB-27 [CONFIRMED / LIVE] master_schedule_builder.js:2031  _(solvers)_
**Auto-Builder layer grid band-label renders user-typed customActivity/leagueName as raw innerHTML (stored XSS)**

- Evidence: renderDAWGrid (function spans L1791-2057) builds the grid string and assigns it at L2044 `gridEl.innerHTML = html;`. The band label at L2031 is `<span class="band-label">${layer.customActivity || layer.leagueName || typeDef?.name || layer.type}</span>` with NO escaping. `layer.customActivity` is the raw value of the popover input `#daw-pop-custom-name` saved at L2969: `layer.customActivity = (popover.querySelector('#daw-pop-custom-name')?.value |
- Scenario: In the Auto Builder layer editor, a user (owner/admin/scheduler) creates a custom layer and types the Activity Name `<img src=x onerror=alert(document.cookie)>` (or `</span><script>...`). On every grid redraw — which happens automatically on load and after any drag/resize, no extra click — L2031 injects it raw into gridEl.innerHTML and the payload
- Verifier: The sink is real and unescaped. In renderDAWGrid (master_schedule_builder.js, function L1791-2057), the band label at L2031 interpolates `layer.customActivity || layer.leagueName || typeDef?.name || layer.type` with NO escaping, and the whole string is committed via `gridEl.innerHTML = html;` at L2044. The escaper `_esc = window.CampUtils?.escapeHt

#### CB-28 [CONFIRMED / LIVE] master_schedule_builder.js:2709  _(solvers)_
**Layer edit popover injects customActivity / customField / league names unescaped (attribute-breakout + element XSS)**

- Evidence: renderDAWLayerPopover assigns `popover.innerHTML = ...` at L2514. Inside that template, user-controlled strings are interpolated raw: L2709 `<input ... value="${layer.customActivity || ''}">` (attribute context — a `"` in the name breaks out of the value attribute), L2722 `'<option value="' + f + '"...>' + f + '</option>'` where `f` is a field/special-location name, L2730 `value="${layer.customField || ''}"`, and L2643 `_gradeLeagues.map(n => '<o
- Scenario: User sets a custom layer's Activity Name or custom Field/Location to `"><img src=x onerror=alert(1)>` (or names a field/league with that payload elsewhere). Opening the layer's edit popover assigns popover.innerHTML at L2514; the unescaped value at L2709/2730 breaks out of the input's value attribute (or the option text at L2643/2722 injects an ele
- Verifier: The defect is real and live. showDAWPopover (master_schedule_builder.js; the function the reviewer called renderDAWLayerPopover) builds the layer-edit popover with a template literal assigned at L2514 `popover.innerHTML = ` and injects it into the live DOM at L2814 `document.body.appendChild(popover)`, so any HTML in the string executes. The file's

#### CB-29 [CONFIRMED / LIVE] master_schedule_builder.js:3929  _(solvers)_
**Manual skeleton tile renderer interpolates event/location/league/elective/swim names as raw innerHTML (stored XSS)**

- Evidence: renderSkeletonTile builds `innerHtml` (L3927+) which is placed into the grid via `grid.innerHTML = html;` (L3833). Every user-controlled string is interpolated WITHOUT escaping: L3929 `<strong>${ev.event}</strong>` (the skeleton event name the user types), L3935 `📍 ${ev.location}`, L3937 `${ev.reservedFields.join(', ')}` (field names), L3942 `${ev.leagueName}`, L3953/3955 `${actList}` from `ev.electiveActivities` (activity names), L3964 `${ev.sw
- Scenario: In the Manual Builder skeleton editor a user names a tile/event (or an elective activity, swim location, or custom location) `<img src=x onerror=...>`. When the skeleton grid renders that tile (on load and after each edit) L3929 injects ev.event raw into grid.innerHTML and the script runs. The skeleton persists to camp_state_kv, so it re-fires for
- Verifier: The claim is accurate (the function is named renderEventTile, not renderSkeletonTile, but it is the manual skeleton tile renderer). Full chain verified in code: (1) SINK — renderGrid assembles `html` and writes `grid.innerHTML = html;` at master_schedule_builder.js:3833; auto mode returns early at L3754-3757, so renderEventTile (L3912) is the manua

#### CB-30 [CONFIRMED] daily_adjustments.js:5634  _(dailyadj)_
**Manual-mode trip: trips-store record and skeleton pinned tile get different IDs (separate Date.now() calls) → orphaned/un-removable ghost trip + duplicate in list**

- Evidence: In the trip ADD handler (`#da-apply-trip-btn`.onclick), the trips-store record and the skeleton pinned tile are created by TWO independent `Date.now()` calls, separated by a localStorage+cloud write: L5624-5629: const trips = loadDailyTrips(dateKey); selDivs.forEach(div => { const tripId = 'trip_' + Date.now() + '_' + div; trips.push({ id: tripId, ... }); }); saveDailyTrips(dateKey, trips); // localStorage.setItem + saveGlobalSettings (>1
- Scenario: Manual builder, any date. User opens Trips, selects 1+ divisions, fills name/start/end, clicks 'Add Trip'. The trips-store entry gets id `trip_T0_DivA`; after the localStorage/cloud write the skeleton pinned tile gets id `trip_T1_DivA`. The trip now shows twice in the Trips list (once per store, via the L5518 merge). User clicks 'Remove' on the tri
- Verifier: The defect is real and reachable in the ADD branch of the `#da-apply-trip-btn` onclick (daily_adjustments.js). The trips-store record id and the skeleton pinned-tile id are built from TWO independent Date.now() calls (L5626 and L5634), separated by the full saveDailyTrips() call (L5629). saveDailyTrips does several synchronous JSON.stringify + loca

#### CB-31 [CONFIRMED / LIVE] daily_adjustments.js:4196  _(dailyadj)_
**Manual daily-skeleton cloud branch reads a stale masterSettings snapshot on date-change, while the auto-layer twin reads fresh loadGlobalSettings()**

- Evidence: loadDailySkeleton() Priority-2 (cloud) reads from the module snapshot, not a fresh load: ``` const cloudSkeleton = masterSettings?.app1?.dailySkeletons?.[dateKey]; // <-- snapshot, can be stale ``` and the newest-wins check at 4165-4166 also reads `masterSettings?.app1?.dailySkeletonsTs/dailySkeletons` from the same snapshot. By contrast the auto twin loadDAAutoLayers() (line 4043) reads fresh: `const g = window.loadGlobalSettings?.() || {};
- Scenario: On device B (or after init without a refreshFromCloud), user navigates to a date whose skeleton was created/edited on device A. localStorage `campManualSkeleton_<date>` is empty for that date on B, so Priority-1 misses and the loader falls to the cloud branch — which reads `masterSettings.app1.dailySkeletons[date]` from the stale init snapshot (mis
- Verifier: The asymmetry is real and the divergence mechanism is concrete. READ DIVERGENCE (daily_adjustments.js): - Manual loadDailySkeleton() reads the module-level `masterSettings` snapshot: line 4166 `const _cData = masterSettings?.app1?.dailySkeletons?.[dateKey];` (newest-wins check) and line 4196 `const cloudSkeleton = masterSettings?.app1?.dailySkelet

#### CB-32 [CONFIRMED] daily-camp-schedular/daily_adjustments.js:5428  _(dailyadj)_
**Trips create/edit/delete has NO role gate (viewer + out-of-scope scheduler can write camp-global trip data that both builders honor)**

- Evidence: Every other write in this file is permission-gated, but the Trips path is not. `saveDailySkeleton()` (L4240-4250) opens with `if (!window.AccessControl?.canEdit?.()) { ...return; }`; `activateFullDayRainyMode()` (L1209) and the mid-day path (L1293) open with `if (!window.AccessControl?.checkEditAccess?.(...)) return;`. The Trips equivalents have nothing. `saveDailyTrips(dateKey, trips)` (L5428) runs unconditionally and writes camp-GLOBAL cloud st
- Scenario: A user with the VIEWER role (intended read-only) opens Daily Adjustments, clicks Trips, picks any division(s), and clicks Add Trip (or Remove on an existing trip). `saveDailyTrips` runs un-gated and pushes the trip into `camp_state_kv` `app1.dailyTripsByDate` (camp-global, shared with every user incl. the owner) plus `daily_schedules`. Because trip
- Verifier: The trip write path has no role/permission gate, while every sibling write in the same file does. saveDailyTrips (daily_adjustments.js L5428) runs unconditionally and persists CAMP-GLOBAL cloud state: L5446 saveGlobalSettings('daily_schedules', allDaily) and L5470 saveGlobalSettings('app1', masterSettings.app1) which carries app1.dailyTripsByDate[d

#### CB-33 [CONFIRMED / LIVE] unified_schedule_system.js:1804  _(dailyadj)_
**resolveConflictsAndApply derives claimed time from the DIVISION-level slot table using PER-BUNK slot indices (auto mode) — wrong field-lock window + wrong smart-regen mapping**

- Evidence: Lines 1800-1806: `const editingDivSlots = window.divisionTimes?.[editingDiv] || []; ... if (slots.length>0 && editingDivSlots[slots[0]]) { claimedStartMin = editingDivSlots[slots[0]].startMin; claimedEndMin = editingDivSlots[slots[slots.length-1]].endMin; }`. But `slots` was produced by `findSlotsForRange(startMin,endMin,divName, hasPerBunk?bunk:null)` (applyEdit @4251) which, per scheduler_core_utils.js:137-144, returns indices into the bunk's `
- Scenario: Auto-built schedule (per-bunk timelines). User edits a bunk's cell to a field already used by a bunk in another division at the overlapping wall-clock time, triggering the conflict modal, and picks Notify/Bypass. claimedStartMin/EndMin are read from divisionTimes[editingDiv][perBunkIndex] which points at a different time window (or is undefined → c
- Verifier: The claim is accurate against the actual code. In applyEdit (L4250-4251) auto mode computes hasPerBunk and calls findSlotsForRange(startMin,endMin,divName,bunk), which per scheduler_core_utils.js:137-146 returns indices into _perBunkSlots[bunk] (a bunk-specific array). Those per-bunk slots are then passed to resolveConflictsAndApply (L4281), which

#### CB-34 [CONFIRMED / LIVE] midday_rain_stacker.js:984  _(dailyadj)_
**applyResourceOverrides wipes field timeRules=[] and cloud-syncs; restore depends on a clear that may never run → time restrictions permanently lost from config**

- Evidence: Lines 981-985 (rain start): `if(!field._preRainyTimeRules){ field._preRainyTimeRules = JSON.parse(JSON.stringify(field.timeRules||[])); } field.timeRules=[];` then @1008-1011 `if(changed){ window.saveGlobalSettings?.('app1', g.app1); window.forceSyncToCloud?.(); }`. The ONLY restore is the `else` branch @990-1005 (`field.timeRules = field._preRainyTimeRules; delete field._preRainyTimeRules;`), reached solely via handleMidDayRainClear. saveGlobalS
- Scenario: User activates mid-day rain (clears time-restricted fields' timeRules to [] and syncs to cloud), then changes date / reloads / closes the tab without ever clicking 'rain cleared'. On reload the field config has timeRules=[] permanently — a field that was 'available only 9-11am' is now available all day for every future generation, silently dropping
- Verifier: The mechanism is real and the trigger is concrete. midday_rain_stacker.js applyResourceOverrides(overrides, true) snapshots field.timeRules into field._preRainyTimeRules, then sets field.timeRules=[] (L981-984) and, when changed, calls window.saveGlobalSettings('app1', g.app1)+forceSyncToCloud() (L1008-1011) — writing the now-empty timeRules AND th

#### CB-35 [CONFIRMED] rainy_day_manager.js:1530  _(dailyadj)_
**rainy_day_manager.js has NO escaper — field/special/skeleton names rendered raw into innerHTML text AND into data-* attributes (config-panel XSS + attribute breakout)**

- Evidence: No escaper anywhere in the file. createRainyDayConfigPanel (container.innerHTML, L1356) renders user-configured names raw: L1530 `<div class="rd-item-name">${f.name}</div>` and L1537 `data-field="${f.name}"`; L1562 `<div class="rd-item-name">${s.name}</div>` and L1567 `data-special="${s.name}"` (fields/specials from g.app1.fields / g.app1.specialActivities, L1353-1354). The settings panel (container.innerHTML, L1174) renders skeleton names raw at
- Scenario: User configures a field named `Court"><img src=x onerror=alert(1)>` (or marks a special with a malicious name), then opens Daily Adjustments -> Rainy Day config panel: the name renders raw into the grid innerHTML and the script executes. A skeleton named with a payload fires when the rainy settings panel's template dropdown is built.
- Verifier: Verified by reading rainy_day_manager.js directly. (1) No escaper exists: Grep for escapeHtml/escHtml/_escHtml/CampUtils/function esc( returns ONLY the parseTimeToMinutes/minutesToTime delegations (L243, L248) — no HTML escaper is defined or imported anywhere in the file. (2) Names are user config: createRainyDayConfigPanel (L1349) reads fields=g.a

#### CB-36 [CONFIRMED] unified_schedule_system.js:4729  _(dailyadj)_
**Diverged partial fix: unified conflict renderer escapes the location name but still interpolates other-scheduler bunk names raw (the fix post_edit never got, applied incompletely here)**

- Evidence: renderConflictArea (conflictArea.innerHTML = html, L4736) was given the file's `escapeHtml` (delegates to CampUtils, L3853) for the location at L4727/L4728 `${escapeHtml(location)} is in use`/`is already in use` — but the very next lines leave bunk names raw: L4729 `Can auto-reassign: ${editableBunks.join(', ')}` and L4730 `✗ Other scheduler's bunks: ${nonEditableBunks.join(', ')}` (editableBunks/nonEditableBunks from conflictCheck.*Conflicts.map
- Scenario: A bunk named `A<img src=x onerror=alert(1)>` belongs to another scheduler. When the editing user picks a field that bunk occupies, checkLocationConflict returns it under nonEditableConflicts, and L4730 renders the bunk name raw into the conflict panel innerHTML -> executes in the editor's session (cross-scheduler stored XSS).
- Verifier: VERIFIED by direct read of unified_schedule_system.js. The escaper-fix is genuinely half-applied in renderConflictArea (L4717-4742): the LOCATION is escaped at L4727 (`${escapeHtml(location)} is in use`) and L4728 (`${escapeHtml(location)} is already in use`), but the very next lines interpolate bunk names RAW — L4729 `Can auto-reassign: ${editable

#### CB-37 [CONFIRMED / LIVE] global_field_locks.js:874  _(dailyadj)_
**global_field_locks.js has NO escaper — other-scheduler field & division names rendered raw into the lock-warning panel (multi-user)**

- Evidence: No escaper in the file. The 'Fields Already Scheduled by Other Schedulers' panel (panel.innerHTML, L804) renders L812 `... in use by: ${otherDivisions.join(', ')}` raw and embeds `_renderOtherSchedulerDetails()` (L827) which builds per-field cards raw: L874 `🏟️ ${fieldName}`, L877 `Times: ${timeLabels}`, L879 `Division${...}: ${divisionList}` (divisionList = usage.divisions.join, L863). The 'other-scheduler-badge' path is also raw: L938 `badge.i
- Scenario: Scheduler B owns a division named `B<img src=x onerror=...>` (or a field with a payload name). Scheduler A opens the Flow grid; GlobalFieldLocks renders the cross-scheduler lock panel/badge with B's division/field name raw into innerHTML and the script runs in A's session. Requires two scheduler accounts sharing a camp to populate _otherSchedulerFi
- Verifier: VERIFIED against the actual code. global_field_locks.js (loaded in flow.html L693) has NO escaper anywhere (grep for escapeHtml/escHtml/_escHtml/esc(/CampUtils → zero matches). It renders other-scheduler-controlled field & division names raw into innerHTML in three sinks: (1) renderOtherSchedulerPanel L804 `panel.innerHTML = \`... ${fieldCount} fi

#### CB-38 [PLAUSIBLE / LIVE] supabase_schedules.js:1064  _(cloud)_
**window._autoGenerated / window._autoSkeleton are never reset on date-change → an auto date's mode flag + skeleton leak onto the next manual/empty date's cloud row**

- Evidence: saveSchedule stamps the cloud payload from sticky window globals that no code path ever clears: `if (data._autoGenerated === true || window._autoGenerated === true) { payload._autoGenerated = true; }` (L1064-1066) and `const ms = data.manualSkeleton || window._autoSkeleton || window.dailyOverrideSkeleton; if (Array.isArray(ms) && ms.length > 0) { payload.manualSkeleton = ms; }` (L1067-1070). These two globals are only ever SET truthy — schedule_o
- Scenario: Owner opens an auto-generated day (06-10) → hydrateWindowGlobals sets window._autoGenerated=true and window._autoSkeleton=<06-10's skeleton>. Owner navigates to a MANUAL day (06-11) and makes a daily adjustment (or the date-change auto-save fires). saveSchedule(06-11,...) now stamps 06-11's cloud row with `_autoGenerated:true` and `manualSkeleton:<
- Verifier: The write-side mechanism is REAL and verified verbatim. supabase_schedules.js L1064-1070 stamps the cloud payload from sticky window globals: `if (data._autoGenerated === true || window._autoGenerated === true) { payload._autoGenerated = true; }` and `const ms = data.manualSkeleton || window._autoSkeleton || window.dailyOverrideSkeleton; if (Array.

#### CB-39 [CONFIRMED] scheduler_core_main.js:4055  _(solvers)_
**Manual STEP 7.6 free-fill places a sport on a time-restricted (or rainy-disabled) field — missing the field-availability gate the auto FN-22 sweep has**

- Evidence: STEP 7.6 builds its candidate field list with `const _sportFields76 = _fields76.filter(f => ... && !(f.timeRules && f.timeRules.enabled));` (L4055-4058). `field.timeRules` is ALWAYS an array (facilities.js:2253 `item.timeRules.push(...)`, checked via `.length` everywhere) and NEVER has a `.enabled` property, so `!(f.timeRules && f.timeRules.enabled)` is ALWAYS true (proven: `[].enabled === undefined`). A field with active timeRules (e.g. Pool Una
- Scenario: Manual generation on a day where a field has a timeRules 'Unavailable' window (e.g. Tennis Courts unavailable until 12:30) and a bunk has a Free slot at 11:00 over that field's window with the court otherwise empty. STEP 7.6 writes `{field:'Tennis Courts', sport:'Tennis', _startMin:660, _endMin:705, _freeFilled:true}` into the 11:00 slot — placing
- Verifier: Both load-bearing facts hold. (1) `field.timeRules` is ALWAYS an array: facilities.js initializes it as `[]` (L340/429/884/1319) and only ever `.push()`es onto it (L2253/2262), reading it via `.length` everywhere — it never has a `.enabled` property. So the STEP 7.6 filter `!(f.timeRules && f.timeRules.enabled)` (scheduler_core_main.js:4058) is alw

#### CB-40 [CONFIRMED] edit_restrictions.js:401  _(dailyadj)_
**edit_restrictions.js has no HTML escaper — division & subdivision names rendered raw into the access-denied toast innerHTML (stored XSS)**

- Evidence: showAccessDeniedToast(divisionName) builds `const message = subdivision ? `"${divisionName}" is managed by ${subdivision.name}` : `You don't have permission to edit "${divisionName}"`;` then `toast.innerHTML = `<span...>🔒</span><span>${message}</span>`;` (edit_restrictions.js:397-406). Both divisionName and subdivision.name are user-controlled camp config (division/subdivision names created in the Me page) and are interpolated RAW into innerHTML
- Scenario: A division (or subdivision) is named e.g. `<img src=x onerror=...>`. A restricted user (viewer, or scheduler outside their scope) triggers the access-denied path by attempting a drag/edit on that division (dragstart/click interceptors at L358-382 → showAccessDeniedToast) → the payload executes in their session. Camp-config-controlled stored XSS in
- Verifier: edit_restrictions.js has NO HTML escaper (grep for escapeHtml/escHtml/_escHtml/CampUtils → "No matches found"), and two innerHTML sinks interpolate user-controlled stored camp config RAW. Sink 1 — showAccessDeniedToast (L397-406): message is built from divisionName and subdivision.name, then toast.innerHTML = `...<span>${message}</span>`. Sink 2 —


### LOW

#### CB-41 [CONFIRMED] unified_schedule_system.js:5992  _(cloud)_
**Auto-backup cleanup calls ScheduleVersionsDB.deleteVersion which is never exported — MAX_AUTO_BACKUPS_PER_DATE is silently unenforced and schedule_versions grows unbounded**

- Evidence: cleanupOldAutoBackups computes `toDelete = autoBackups.slice(MAX_AUTO_BACKUPS_PER_DATE)` then `if (window.ScheduleVersionsDB.deleteVersion) { await window.ScheduleVersionsDB.deleteVersion(old.id); }` (L5990-5996). schedule_versions_db.js exports only `{ listVersions, getVersion, createVersion, saveVersion, updateVersion, createBasedOn }` (L164-171) — no deleteVersion exists anywhere in the repo, so the guard is permanently false, `cleaned` stays
- Scenario: Over a season, each activity delete/structural change creates an '[Auto] ...' restore-point version for the date; with the cleanup never deleting anything, listVersions returns an ever-growing pile of full-schedule jsonb rows — bloating the table, slowing the versions UI list, and making the MAX_AUTO_BACKUPS_PER_DATE setting meaningless.
- Verifier: Every link in the claim checks out against the source. (1) deleteVersion does not exist as an export: repo-wide grep for `deleteVersion` returns exactly two hits, both at the call site itself (unified_schedule_system.js:5992-5993). The ScheduleVersionsDB export object (schedule_versions_db.js L164-171) lists only listVersions, getVersion, createVer

#### CB-42 [CONFIRMED] supabase_schedules.js:1271  _(cloud)_
**Scoped delete strips leagueAssignments by BUNK key from a DIVISION-keyed map — silent no-op, ghost league entries survive a scheduler's day delete**

- Evidence: deleteMyScheduleOnly: `if (leagues[bunk] !== undefined) { delete leagues[bunk]; }` (L1271-1273) where `leagues = scheduleData.leagueAssignments` — but leagueAssignments is DIVISION-keyed (mergeSchedules itself iterates it as `([div, slots])` at L627; league writers key by divName per LEAGUE_AUDIT verification). Bunk names are never keys, so this delete never matches and every record's league entries survive intact. The same bunk-vs-division mista
- Scenario: A scheduler deletes their 06-15 schedule. Their bunks' rows are removed from all records, but their divisions' league matchups remain in every record's leagueAssignments; the post-delete reload re-merges them, ensureEmptyState recreates empty bunk rows, and the grid/print still render the day's league games for divisions whose schedule was just del
- Verifier: The claim is accurate on every load-bearing fact. leagueAssignments is DIVISION-keyed, not bunk-keyed: writers key by divName (scheduler_core_main.js:462 `window.leagueAssignments[block.divName] = {}`; scheduler_core_auto.js:20273 `window.leagueAssignments[lb.divName][lb.startMin]`) and readers index by division (mergeSchedules iterates `([div, slo

#### CB-43 [CONFIRMED] schedule_versions_db.js:157  _(cloud)_
**createBasedOn reads source.date but version rows carry date_key — the clone is inserted with an undefined date key, orphaning it from listVersions**

- Evidence: schedule_versions_db.js:157 `return createVersion(source.date, newName, newData, sourceVersionId);` — but rows are written with `date_key: dateKey` (L95) and read back as-is by getVersion (L62-66), so `source.date` is always undefined. createVersion then inserts a payload whose `date_key` is undefined (stripped by JSON serialization → NULL, or a NOT-NULL violation swallowed into `{ success: false, error }` at L112-115). Either way listVersions(da
- Scenario: Any future UI wiring of 'duplicate this version' calls ScheduleVersionsDB.createBasedOn('id', 'Copy of Plan A'): the insert either errors (NOT NULL date_key) or creates a row with NULL date_key that no date's version list ever shows — the user's copy silently vanishes.
- Verifier: The claim is accurate. createBasedOn (schedule_versions_db.js:146) loads `source` via getVersion (L147), which does `.select('*')` on the `schedule_versions` table. Rows are inserted with the column `date_key` (L95: `date_key: dateKey`), never `date`. So a fetched row exposes `source.date_key`, and `source.date` is always `undefined`. L157 then pas

#### CB-44 [CONFIRMED] schedule_orchestrator.js:1704  _(cloud)_
**Dead 'campistry-realtime-update' listeners in schedule_orchestrator.js and supabase_sync.js — the event is never dispatched anywhere, so both realtime-refresh handlers are unreachable wiring**

- Evidence: schedule_orchestrator.js:1704-1707: `window.addEventListener('campistry-realtime-update', (e) => { log('Realtime update received, reloading...'); loadSchedule(getCurrentDateKey(), { force: true }); });` and supabase_sync.js:1265-1268: `window.addEventListener('campistry-realtime-update', (e) => { ... refreshMultiSchedulerView(getCurrentDateKey(), true); });` — a repo-wide grep over *.js and *.html finds exactly these two addEventListener sites an
- Scenario: A maintainer reading the orchestrator believes it force-reloads on realtime updates (the listener and log message say so) and relies on that for a fix or skips adding refresh logic elsewhere — but the handler can never fire. Both blocks look load-bearing and are dead; remove them or actually dispatch the event from handleRealtimeChange if orchestra
- Verifier: Both listeners exist verbatim: schedule_orchestrator.js:1704-1707 (force-reloads via loadSchedule on the event) and supabase_sync.js:1265-1268 (refreshMultiSchedulerView on the event), both files loaded in flow.html (lines 703 and 494), so the listeners are live runtime wiring, not dead files. I ran an exhaustive grep of EVERY dispatchEvent/new Cus

#### CB-45 [PLAUSIBLE] schedule_orchestrator.js:161  _(cloud)_
**showNotification interpolates message into innerHTML with no escaping — latent XSS sink exported on window.ScheduleOrchestrator, and the codebase already passes user-controlled reasons to a global hook of this exact name**

- Evidence: schedule_orchestrator.js:161: `notification.innerHTML = `<span>${icons[type] || ''}</span><span>${message}</span>`;` — no escaper in the file (contrast the sibling notification renderer integration_hooks.js:3233-3244, which escapes title/message with a complete &<>"' escaper before innerHTML). All in-file callers today pass static strings or a numeric bunkCount (`Saved ${bunkCount} bunks`, L1125/1138), so it is not currently exploitable — but the
- Scenario: A dev wires the existing dangling hook: `window.showNotification = ScheduleOrchestrator.showNotification`. A camp owner has a field named `<img src=x onerror=alert(document.cookie)>`; any blocked manual edit on it routes _check.reason into the unescaped innerHTML toast and executes in every scheduler's session. One-line fix now: escape message (use
- Verifier: Every concrete code fact in the claim checks out. The sink is real and unescaped: schedule_orchestrator.js:161 does `notification.innerHTML = `<span>${icons[type] || ''}</span><span>${message}</span>`` with `message` interpolated raw, and the file has no escaper (no CampUtils/escapeHtml hit). It is exported: schedule_orchestrator.js:1878-1899 `wind

#### CB-46 [PLAUSIBLE / LIVE] daily_adjustments.js:5114  _(solvers)_
**Manual pre-generation wipe uses the raw picker scope (_generationScope) instead of the role-clamped _effScope, diverging from the auto path**

- Evidence: In the manual branch the pre-gen wipe and the solver scope both read the RAW picker, not the role-clamped _effScope computed at L4839-4846: L5114: const scopeDivsForWipe = _generationScope ? [..._generationScope] : null; L5260: const scopeDivsManual = _generationScope ? [..._generationScope] : null; The auto branch correctly uses the clamped scope: L4939 `const scopeDivisions = _effScope ? [..._effScope] : null`. For a scheduler who makes NO
- Scenario: Scheduler (assigned a subset) opens manual mode, makes no division pick, clicks Generate. The daily_adjustments wipe takes the FULL branch and blanks window.scheduleAssignments for every division in memory before the solver runs. Visible data loss is averted only because runSkeletonOptimizer re-loads other schedulers' bunks from cloud; if that clou
- Verifier: The claim's code assertions are all accurate. In daily_adjustments.js the manual pre-gen wipe and manual solver scope read the RAW picker (_generationScope), while the auto branch reads the role-clamped _effScope: - L5114 `const scopeDivsForWipe = _generationScope ? [..._generationScope] : null;` - L5260 `const scopeDivsManual = _generationScope ?

#### CB-47 [PLAUSIBLE / LIVE] auto_fill_slot.js:577  _(solvers)_
**autoFillSlotSilent writes ordinary-activity fills with no _startMin/_endMin (slot-time stamp dropped)**

- Evidence: In autoFillSlotSilent (the STEP 7.5 batch leftover-Free-fill path, called from scheduler_core_main.js:3737+), the written entry only receives time stamps for duration-best-fit SPECIALS: L561 `const _afEntry = { field: best.field||best.activity, sport: best.activity, _activity: best.activity, _location:..., continuation:false, _fixed:true, _autoFilled:true, _editedAt:Date.now() };` (no _startMin/_endMin) L575 `if (_afFeat._endMin) { _afEntry.
- Scenario: Manual gen leaves a Free slot; STEP 7.5 fills it with a plain sport via autoFillSlotSilent -> entry persists to cloud with no _startMin/_endMin. Any later reader that lacks division-level slot context for that index (e.g. camper locator on a freshly cloud-loaded manual day, where divisionTimes/_perBunkSlots may not be rehydrated) falls back to coar
- Verifier: autoFillSlotSilent omits _startMin/_endMin on ordinary fills; fillBlock always stamps. Claim concedes latent. Readers fall back to division divisionTimes (manual populated) so no observed wrong time. LOW gap, needs live testing.

#### CB-48 [PLAUSIBLE / LIVE] scheduler_core_auto.js:25793  _(solvers)_
**FN-59 authoritative trip re-save: async ScheduleDB.saveSchedule fired without await/catch inside a sync try — cloud-write rejection is swallowed**

- Evidence: saveSchedule is async (supabase_schedules.js:753 `async function saveSchedule(dateKey, data, options = {})`). At scheduler_core_auto.js:25793 it is invoked fire-and-forget: L25782 `try {` L25793 `window.ScheduleDB?.saveSchedule?.(_dkT, { scheduleAssignments:..., leagueAssignments:... }, { skipFilter: true });` (no await, no .catch) L25798 `} catch (_eSv) { try { warn('[FN-59] authoritative final save: ' + (_eSv && _eSv.message)); } catch(_
- Scenario: On a trip day (tripWriteCount>0) the final authoritative cloud re-save rejects (e.g. transient Supabase error). The local re-save at L25791 already succeeded so no data loss, but the cloud copy is left stale (potentially without the trip) and the failure is invisible to logs/caller. saveSchedule has its own internal verify/backoff, so impact is lim
- Verifier: The structural defect is real and correctly located: scheduler_core_auto.js:25793 calls async saveSchedule with no await and no .catch, inside a SYNCHRONOUS try whose catch (_eSv at L25798) only traps throws raised during the call expression itself (and `?.` already guards "not a function"). A Promise rejection from saveSchedule therefore escapes a

#### CB-49 [CONFIRMED / LIVE] master_schedule_builder.js:2120  _(solvers)_
**Drag-ghost element injects customActivity unescaped during layer drag**

- Evidence: In bindDAWEvents drag handling, L2120: `ghost.innerHTML = '<div>' + (layer.customActivity || typeDef?.name || layer.type) + '</div>' + ...`. `layer.customActivity` is raw user input (saved at L2969) and is concatenated into innerHTML with no escaping. A parallel manual-grid ghost at L4853 does the same with `<strong>${event.event}</strong>`. Lower impact than the grid/popover sinks because it requires the user to actively drag the malicious layer
- Scenario: User creates a layer named `<img src=x onerror=alert(1)>` then drags it within the grid; the drag-ghost innerHTML at L2120 executes the payload mid-drag. Self-inflicted in the common case, but if the layer config was authored by another co-user it becomes cross-user.
- Verifier: The sink is real and the input is genuinely unescaped user-controlled data. At master_schedule_builder.js:2120 (inside bindDAWEvents, the band `dragstart` handler) the drag-ghost is built with `ghost.innerHTML = '<div>' + (layer.customActivity || typeDef?.name || layer.type) + '</div>' + ...` — `layer.customActivity` is concatenated straight into i

#### CB-50 [CONFIRMED / LIVE] global_field_locks.js:596  _(dailyadj)_
**Cross-date field-lock accumulation: loadOtherSchedulerSchedules resets usage maps but never clears _locks, so prior date's other-scheduler locks persist when viewing a new date**

- Evidence: `loadOtherSchedulerSchedules(dateKey)` (called on date change by the listener at L996 `self.loadOtherSchedulerSchedules(newDate)`) resets only the per-date usage caches: L595-597: this._otherSchedulerDateKey = dateKey; this._otherSchedulerFieldUsage = {}; this._otherSchedulerSchedules = {}; It then calls `_extractOtherSchedulerFieldUsage()` + `_registerOtherSchedulerLocks()` (L641-642). `_registerOtherSchedulerLocks` (L726-753) calls `this.
- Scenario: A VIEWER-role account (the only role that registers these locks — owner/admin/scheduler early-return at L602-605 with fieldCount:0) opens Daily Adjustments on date A where another scheduler has Baseball Field at slot 3 at capacity. Locks for that field/slot register. The viewer switches the date picker to date B (where that field/slot is free). `lo
- Verifier: The defect is real at the code level. `loadOtherSchedulerSchedules(dateKey)` (the date-change entry point, invoked by the listener at L995-996 `self.loadOtherSchedulerSchedules(newDate)`) resets ONLY the per-date usage caches at L595-597 (`_otherSchedulerDateKey`, `_otherSchedulerFieldUsage={}`, `_otherSchedulerSchedules={}`) and never clears `this

#### CB-51 [CONFIRMED / LIVE] daily_adjustments.js:4014  _(dailyadj)_
**editTile/copyTile lack the date-settle guard the drop path has, so a date change during the edit modal makes the saved edit a silent no-op**

- Evidence: `editTile(id)` resolves `const ev = dailyOverrideSkeleton.find(e => e.id === id)` (L3796) at open, awaits a blocking modal (`await daShowModal(...)`), mutates `ev` (e.g. L3990 `ev.event = ...; ev.startTime = ...`), then persists with `saveDailySkeleton(); renderGrid();` (L4014-4015) — with NO re-check that the date is still the one being edited. Contrast the drop handler, which was explicitly hardened for exactly this race (Day 25b #4): it guards
- Scenario: Manual builder. User clicks Edit on a skeleton tile; the edit modal opens. While it is open, the loaded date changes (calendar navigation, or a realtime/auto date-settle). User edits the time and clicks Save. Because `dailyOverrideSkeleton` was reassigned on the date switch, the mutation applies to a stale detached tile object and `saveDailySkeleto
- Verifier: The defect is real and confirmable by code. editTile(id) captures `const ev = dailyOverrideSkeleton.find(e => e.id === id)` (L3796) — a reference into the CURRENT module-level array — then awaits a blocking `daShowModal`. The date-change handler `campistry-date-changed` (L7991) polls until `currentScheduleDate` settles (up to 5000ms, L8011; integra

#### CB-52 [CONFIRMED] post_edit_system.js:631  _(dailyadj)_
**Write-only localStorage mirrors that are never read (scheduleAssignments_<date>, campDailyData_v1_<date>) — wasted quota that accelerates the stale-local fallback**

- Evidence: Per-edit writes create keys that are never read anywhere in the codebase. `campDailyData_v1_${currentDate}` is written at post_edit_system.js:631 and :2209 but a repo-wide search for any getItem of `campDailyData_v1_` returns ZERO reads. `scheduleAssignments_${dateKey}` is written 5x (post_edit_system.js:437, :628, :2208; unified_schedule_system.js:3915, :4297) with ZERO getItem reads anywhere. Example: ``` const unifiedKeyWithDate = `campDailyDa
- Scenario: A user editing schedules across many dates accumulates unbounded `scheduleAssignments_<date>` + `campDailyData_v1_<date>` blobs. These never feed any load, but they consume the same localStorage budget. As the origin nears quota, the pruned-and-guarded `campDailyData_v1` write starts hitting QuotaExceededError, which sets `_campistry_local_write_fa
- Verifier: The core factual claim is provably true from the code. WRITE sites match exactly: `scheduleAssignments_${date}` is written at post_edit_system.js:437, :628, :2208 and unified_schedule_system.js:3915, :4297 (5 sites); `campDailyData_v1_${date}` is written at post_edit_system.js:631 and :2209 (2 sites). An exhaustive Grep of the ENTIRE repo for both

#### CB-53 [PLAUSIBLE / LIVE] daily_adjustments.js:5401  _(dailyadj)_
**Trips merge uses count (more-trips-wins) instead of recency when the authoritative dailyTripsByDate key is absent**

- Evidence: loadDailyTrips() final merge: ``` // Merge: use whichever has more trips (handles partial sync) let result = []; if (fromLS && fromCloud) { result = fromLS.length >= fromCloud.length ? fromLS : fromCloud; // count-based, not recency } else { result = fromLS || fromCloud || []; } ``` This is count-based load precedence — the exact anti-pattern the bug class targets. It is normally shadowed because Source 3 (app1.dailyTripsByDat
- Scenario: Source 3 absent for a date. Device A deletes one of two trips (cloud now has 1, the fresher state); device B's stale localStorage still has 2. On B, fromLS.length(2) >= fromCloud.length(1) selects fromLS and resurrects the deleted trip, then cross-syncs it back. A 'most recently written wins' (updated_at) comparison would be correct; 'more items wi
- Verifier: The count-based merge is real and quoted verbatim, but the claim's primary trigger and its headline scenario are both refuted; only a narrow legacy-data window survives. WHAT'S TRUE: daily_adjustments.js:5398-5404 picks trips by `fromLS.length >= fromCloud.length` with no updated_at/recency — a real count-wins anti-pattern. Source 3 (5388-5396) sh

#### CB-54 [PLAUSIBLE] auto_field_locks.js:397  _(dailyadj)_
**getLockedFieldsAtTime has the same dead division-branch bug that FN-7 fixed in isFieldLockedByTime, and only reports 'exclusive' (capacity locks never surface)**

- Evidence: Lines 395-401: `_claims.forEach(c => { if (c.startMin>=endMin || c.endMin<=startMin) return; if (c.lockType==='exclusive'){ if (c.lockType==='division' && c.grade===divisionContext) return; locked.add(c.field); } });`. The inner `c.lockType==='division'` test is unreachable — it is nested inside `c.lockType==='exclusive'`, so it can never be true (a claim cannot be both). This is the exact dead-branch that was called out and fixed in isFieldLocke
- Scenario: When a future 'division' lock type is introduced (the FN-7 note says none exist today), getLockedFieldsAtSlot/getLockedFieldsAtTime would wrongly omit it from the locked-fields list for the allowed division and for everyone (dead branch). Today it under-reports capacity-saturated fields as 'available' in any UI that calls getLockedFieldsAtSlot. Low
- Verifier: Both halves of the claim are factually correct against the code in auto_field_locks.js:393-403. (A) The dead nested branch is real: line 398 `if (c.lockType === 'division' && c.grade === divisionContext) return;` sits inside the `if (c.lockType === 'exclusive')` guard at line 397, so `c.lockType` can never satisfy both — it is unreachable. This is

#### CB-55 [PLAUSIBLE] daily_adjustments.js:192  _(dailyadj)_
**daShowModal escaper applied inconsistently: checkbox-group branch renders field.label raw while the text/select sibling branches escape it**

- Evidence: In the same daShowModal field loop (L158-201), the text/time branch escapes the label (L163 `_escHtml(field.label)`) and the select branch escapes it (L175 `_escHtml(field.label)`), but the checkbox-group branch does NOT: L192 `fieldEl.innerHTML = '<label>' + field.label + '</label>' + ...` — raw. (Its option labels/values ARE escaped at L182-190, so only the group's own label diverged.) Also L195 builds a querySelector from raw field.name: `fiel
- Scenario: Latent. If any future or edited daShowModal caller derives a checkbox-group field.label from user data (e.g. an event/division name like other modals' titles do at L1805/L4025), it renders raw into innerHTML and executes; a field.name containing a quote would also break the L195 selector and silently return no checked values. No current caller trig
- Verifier: The code divergence is real and verified. In the daShowModal field loop (daily_adjustments.js), the text/time branch (L163) and select branch (L175) both render the field label via `_escHtml(field.label)`, but the checkbox-group branch (L192) renders it raw: `fieldEl.innerHTML = '<label>' + field.label + '</label>' + ...`. `_escHtml` (L92) → `windo

