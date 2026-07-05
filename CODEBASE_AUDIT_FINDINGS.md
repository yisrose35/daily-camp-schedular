# Codebase Audit — Confirmed Findings

Full-codebase methodical audit (multi-phase workflow: per-subsystem bug-class finders -> adversarial verifier per finding -> completeness-critic sweep -> verify). Excludes items already in LEAGUE_AUDIT_FINDINGS.md / WALKTHROUGH_AUDIT_FINDINGS.md and documented intentional patterns. Numbered CB-1.. (severity-sorted within each phase). NONE FIXED YET unless noted.

Bug classes hunted per subsystem: data loss/corruption, cloud/local desync, cross-date contamination, multi-user/role gaps, slot-index-vs-time keying, stale-cache/load-precedence, silent no-ops (saved-but-never-read settings), error swallowing, XSS/escaping, dead/divergent duplicate code.

**[LIVE] = needs live browser/Supabase verification to fully confirm trigger.**

## Summary — 145 findings (15 HIGH / 86 MED / 44 LOW), 66 flagged [LIVE]

Three workflow phases, 9 subsystems (leagues/specialty were audited separately in LEAGUE_AUDIT_FINDINGS.md). 228 finder+verifier+critic agents total.

**The 15 HIGH findings (data/cloud loss or scheduling breaks):**

*Cross-date contamination + cache destruction (the biggest cluster — these silently lose user data):*
- **CB-3** `schedule_orchestrator.js:381` — the rotation-history "slimming" pass rewrites **every** non-today date, **including future dates**, down to bare scheduleAssignments — permanently destroying divisionTimes/skeleton/leagues/trips you built ahead of time.
- **CB-2** `supabase_schedules.js:485` — a transient Supabase query error is treated identically to "no records exist," so a network blip during a load **deletes the date's local cache** and tells downstream code the owner wiped everything.
- **CB-1** `supabase_schedules.js:973` — `saveSchedule` reads divisionTimes/skeleton from **live window state** instead of the date being saved, so a cross-date save stamps the *viewed* day's grid geometry onto *another* day's cloud row.
- **CB-56/57** (rotation) — `rebuildHistoricalCounts` whole-key-overwrites cloud rotation history from a partial local scan; "Erase ALL schedules" wipes cloud counts but leaves stale local `historicalCounts`/`rotationHistory` → next gen double-counts.
- **CB-?** (solvers) — manual STEP 0f does the same future-date slimming as CB-3, and propagates the slim to cloud.

*Multi-scheduler / role:*
- **CB-4** `schedule_orchestrator.js:837` [LIVE] — a **second, parallel** cloud-merge (`mergeCloudRecords`) bypasses every MS-3/MS-4c/#V2-25 fix and its delayed re-apply can override the correct merge.
- **CB-?** `supabase_schedules.js:336` [LIVE] — the MS-2 scheduler save filter falls back to `getEditableDivisions()` = ALL divisions, re-opening the exact "scheduler absorbs every division" bug MS-2 closed (a different code path).
- **CB-? `campistry_go.js:2348`** [LIVE] — GO's "Clear all monitors/counselors/addresses" each wipe the **entire** cloud `state` row (buses, shifts, setup) to `{}`.

*Config loss:*
- **CB-? `campistry_me.js:141`** — the Me-page `save()` rebuilds `campistryMe` as a fixed object literal, **stripping forms, customFields, locale, and the Stripe publishable key** — every sibling feature's save is clobbered on the next unrelated save.

*Scheduling correctness:*
- **CB-8** `scheduler_core_main.js:3893` [LIVE] — manual STEP 7.55 room-capacity sweep **demotes off-site Trip blocks** (the FN-59 class, but in the manual builder), collapsing a division's trip to one bunk.

*Stored XSS (camp-config names execute script):*
- **CB-?** `validator.js:937` + `auto_validator.js:643` — both validator modals render violation messages (with raw bunk/field/division names) as innerHTML with **no escaper**.
- **CB-?** `post_edit_system.js:746` — the entire post-edit edit modal/conflict panel/tooltips have no escaper.

**Dominant cross-cutting themes (apply to many MED/LOW too):**
1. **Cross-date / cache-slimming** keeps recurring — multiple independent code paths rewrite "other dates" assuming only the past matters, destroying future-date local data.
2. **Stale-local-wins load precedence** — several merges pick "more items" or "more geocoded" instead of newest (trips, GO addresses, rotation), the same anti-pattern as LG-1.
3. **Role gate on UI but not on the write (or vice-versa)** — schedulers can trigger config/subdivision/camp-dates writes the UI says are read-only; some land, some silently no-op.
4. **XSS: every render file is its own escaper island** — ~15 files interpolate camp-config names into innerHTML; several have no escaper at all (validator, auto_validator, post_edit, global_field_locks, edit_restrictions, team_subdivisions_ui).
5. **Dead-but-wired code** — whole modules (division_selector, GoStopMaster, PlayoffMode inline UI, several permission guards) are loaded and look load-bearing but have zero callers.

Remediation is a **separate** effort (this is the report). Suggested first batch: the cross-date cluster (CB-1/2/3 + manual STEP 0f) and the `campistry_me.js` config-clobber are the highest user-impact and mostly small fixes.

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


---

## Phase 2 — rotation/frequency, calendar/dates, display layer, Me-page/config CRUD (51 findings: 6 HIGH / 33 MED / 12 LOW)

Run wf_d48fea74-39c. 81 agents.


### HIGH

#### CB-56 [CONFIRMED / LIVE] scheduler_core_utils.js:2592  _(rotation)_
**rebuildHistoricalCounts whole-key overwrites the shared cloud `historicalCounts` from an incomplete local scan — drops every bunk's cross-day rotation history when local cache is partial**

- Evidence: `Utils.rebuildHistoricalCounts` builds a fresh object from scratch — `const counts = {}; ... Object.entries(allDaily).forEach(([dateKey, dayData]) => { ... counts[bunk][actName] = (counts[bunk][actName]||0)+1; })` (L2558-2587) — then `window.saveGlobalSettings('historicalCounts', counts)` (L2593), a COMPLETE cloud-KV overwrite (historicalCounts is a synced key — integration_hooks.js:528 strips it only from the localStorage lite snapshot, not from
- Scenario: Documented reality (WALKTHROUGH_AUDIT_FINDINGS.md `WHY SO MANY FREES`/Day-40 notes): on a near-quota browser, daily schedules are NOT written to localStorage (`skipping auto-save (data is in cloud)`), so `loadAllDailyData()` is missing most dates. The owner generates one new day; `rebuildHistoricalCounts(true)` scans only the 1-2 dates that happen
- Verifier: The whole-key-overwrite mechanism is real and the no-merge path is verified end to end. (1) `rebuildHistoricalCounts` (scheduler_core_utils.js L2554-2608) builds `counts` from scratch by scanning ONLY `window.loadAllDailyData()`, which reads only localStorage `campDailyData_v1` (calendar.js L184-202 — no cloud merge), then calls `window.saveGlobalS

#### CB-57 [CONFIRMED] calendar.js:1430  _(rotation)_
**"Erase ALL schedules" wipes cloud rotation_counts but leaves local historicalCounts / historicalCountedDates / rotationHistory stale**

- Evidence: eraseAllDailyData (the function wired to flow.html's #eraseAllSchedulesBtn "Delete ALL schedules for ALL days" button, owner/admin path ~L1389-1448) does: cloud daily_schedules delete; `localStorage.removeItem(DAILY_DATA_KEY)`; `window.RotationCloud?.clearAll?.()` (L1431, wipes cloud rotation_counts); clears league state; then `window.location.reload()`. It NEVER clears `historicalCounts`, `historicalCountedDates`, `rotationHistory`, `manualUsage
- Scenario: Owner clicks "Delete ALL schedules for ALL days" to start fresh. After reload: cloud rotation_counts = empty, all daily schedules gone, but globalSettings.historicalCounts still holds every bunk's full accumulated activity counts and historicalCountedDates still marks all deleted dates as counted (both in the local mirror and cloud KV). Next genera
- Verifier: VERIFIED by reading the full functions. eraseAllDailyData (calendar.js L1389-1453) — the owner/admin path wired to flow.html #eraseAllSchedulesBtn — deletes cloud daily_schedules (L1396-1399), removes DAILY_DATA_KEY (L1409), and wipes cloud rotation_counts via RotationCloud.clearAll (L1431; clearAllRotationCounts at rotation_cloud.js L310-333 does

#### CB-58 [CONFIRMED] validator.js:937  _(display)_
**Manual-mode validator modal renders violation messages (embedding user-controlled bunk/field/division names) as raw innerHTML with NO escaper — stored XSS**

- Evidence: validator.js has no esc/escapeHtml helper anywhere (unlike every other display-layer file, which delegate to window.CampUtils.escapeHtml). buildCategorySection interpolates each violation string raw into the <li> body: L935-937 `${items.map(item => `<li ...>${item}</li>`).join('')}`, injected via `overlay.innerHTML = content;` (L887). The violation strings embed user-controlled names unescaped, e.g. cross-division: L398 `<u>${fieldName}</u> ... B
- Scenario: A field is named `Court<img src=x onerror=alert(document.cookie)>` (or a bunk/division is named with an <img onerror=...>). It is config that syncs to cloud (camp_state_kv), so it persists for every user of the camp. The owner (or any scheduler) generates a manual schedule that produces ANY validation violation involving that field/bunk/division (e
- Verifier: Every load-bearing element checks out against the real code. (1) validator.js has NO escaper: Grep for `function esc|escapeHtml|escHtml|CampUtils` returns "No matches found" — unlike every other display file that delegates to window.CampUtils.escapeHtml. (2) Violation strings are interpolated raw into innerHTML: buildCategorySection L935-937 `${ite

#### CB-59 [CONFIRMED] auto_validator.js:643  _(display)_
**Auto-mode validator modal has the identical raw-innerHTML XSS (divergent twin of validator.js — neither file escapes), embedding field/bunk/grade names unescaped**

- Evidence: auto_validator.js likewise defines no escaper (its only `function esc(e)` at L703 is an Escape-KEY keydown handler, not an HTML escaper — an excluded false match). showAutoValidatorModal interpolates each error/warning message raw: L641-644 `${items.map(item => `<li ...>${item.message}</li>`)}` and L661-664 `${warnings.map(w => `<li ...>${w.message}</li>`)}`, injected via `overlay.innerHTML = html;` (L680). The messages embed user-controlled name
- Scenario: Same stored-XSS setup as the validator.js finding, but triggered in AUTO builder mode: a field named `Pool"><img src=x onerror=...>` (cloud-persisted config). After an auto generation, the post-gen auto-validator modal (or a manual Validate click in auto mode) lists a cross-division/capacity/staggered/repeat violation involving that field → `${item
- Verifier: Verified the full chain in auto_validator.js. (1) No HTML escaper exists: grep shows the only `esc` is the Escape-KEY keydown handler at L703-704 (the documented excluded false-match); no CampUtils/escapeHtml/textContent is applied to user data anywhere in the file. (2) Violation messages embed user-controlled config names RAW: L247 `<u>${a.field}<

#### CB-60 [CONFIRMED] campistry_me.js:141  _(config)_
**save() rebuilds campistryMe as a fixed literal, stripping forms/customFields/locale/campSettings/stripePublishableKey — every sibling saver's edit is clobbered on the very next save() and lost from cloud + in-memory cache**

- Evidence: save() (L121-167) reads the in-memory cache `g=Object.assign({},window.loadGlobalSettings())` then OVERWRITES campistryMe with a fresh object literal that lists only a fixed subset of sub-keys (L141-154): `g.campistryMe={families,payments,broadcasts,bunkAssignments,bunkManualCounts,nextCamperId,enrollments,sessions,enrollSettings,formConfig,promoCodes,finance}`. It does NOT spread the existing campistryMe, so the sub-keys `forms`, `customFields`,
- Scenario: On the Me page: create a Form (Forms & Documents → + Create Form), OR add a Custom Field (Settings → Manage Custom Fields → + Add Field), OR change Display Language/RTL (Settings → Save Language Settings), OR set the Stripe Publishable Key. The toast confirms success and the UI shows it (rendered from the in-memory module var campForms/customFields
- Verifier: The claim is accurate. save() (campistry_me.js L121-167) reads the in-memory cache via g=Object.assign({},window.loadGlobalSettings()) — loadGlobalSettings→getLocalSettings returns _localCache (integration_hooks.js L485-486), so g.campistryMe at that moment is the SAME object the sibling savers just mutated (it even reads g.campistryMe?.promoCodes

#### CB-61 [CONFIRMED / LIVE] schedule_calendar_views.js:339  _(dates)_
**Calendar day-view navigation eagerly sets window.currentScheduleDate, defeating the cross-date save guard → old day's unsaved edits lost + not cloud-saved**

- Evidence: changeDateTo() at schedule_calendar_views.js:339 does `window.currentScheduleDate = newKey;` BEFORE firing the picker change event at line 354 (`picker.dispatchEvent(new Event('change', {bubbles:true}))`). That change event runs calendar.js onDateChanged(), whose whole point (per its own comment at calendar.js:137 'DO NOT update window.currentScheduleDate here … Setting it eagerly caused stale-memory saves to overwrite the new date's cloud row')
- Scenario: User is on the Calendar day view for 06-12, makes an edit (or just has the generated 06-12 schedule in memory), then clicks the day-view next-arrow (or drills into another day). changeDateTo sets currentScheduleDate=06-13 first; onDateChanged then records _pendingDateTransition={from:06-13,to:06-13}; integration_hooks sees oldDateKey===newDateKey a
- Verifier: Every link in the claimed chain is confirmed in actual code across 4 files, and the orchestrator path makes it strictly worse than the claim states (no fallback save). 1) schedule_calendar_views.js changeDateTo (line 334) sets `window.currentScheduleDate = newKey;` at line 339 BEFORE dispatching the picker change event at line 354. It is reached f


### MED

#### CB-62 [CONFIRMED / LIVE] rotation_engine.js:1482  _(rotation)_
**mergeCloudData only ever RAISES a bunk's local count to the cloud total, never lowers it — a cross-device rotation_counts delete/decrement is silently ignored, leaving stale-high counts**

- Evidence: In `RotationEngine.mergeCloudData`, the local-exists branch is one-directional: `if (cloudCount > local.count) { history.totalActivities += (cloudCount - local.count); local.count = cloudCount; }` (L1482-1485). There is no `else` to lower `local.count` when the authoritative cloud total is now LOWER than the local 14-day scan. `local` comes from `buildBunkActivityHistory` which scans `loadAllDailyData()` (localStorage), and that local schedule is
- Scenario: Device A generated 06-14 (Soccer counted for Bunk X) and it sits in A's localStorage `campDailyData_v1`. On device B the owner deletes/erases 06-14, which calls RotationCloud.deleteDate (calendar.js:1209) → the cloud rotation_counts row for X/Soccer/06-14 is removed, lowering the cloud total. Back on device A a new generation runs: mergeCloudData r
- Verifier: The claim is accurate end-to-end. CONTEXT: CODEBASE_AUDIT_FINDINGS.md (the actual audit doc, not WALKTHROUGH) has no match for this; not an EXCLUSION. CHAIN VERIFIED: (1) rotation_engine.js:1482-1485 — the local-exists branch is strictly one-directional: `if (cloudCount > local.count) { history.totalActivities += (cloudCount - local.count); local.c

#### CB-63 [PLAUSIBLE / LIVE] scheduler_core_utils.js:2554  _(rotation)_
**Post-gen rebuildHistoricalCounts rebuilds from local-only daily cache and persists to cloud KV, clobbering the more-complete cloud-rotation_counts-derived counts**

- Evidence: rebuildHistoricalCounts(saveToCloud=true) (L2554) builds a fresh `counts` object purely from `window.loadAllDailyData()` (L2557), which reads LOCAL `campDailyData_v1` (calendar.js L184-187) or the in-memory override — never cloud. It then `saveGlobalSettings('historicalCounts', counts)` (L2593) and triggers forceSyncToCloud, so the local-derived value is pushed to cloud camp_state_kv and OVERWRITES whatever was there. It also resets historicalCou
- Scenario: Near-quota or fresh-browser device: cloud rotation_counts has 4 weeks of history; local campDailyData_v1 holds only the last ~14 dates (or is on the memory-override path). User generates a day. Pre-gen merge correctly seeds historicalCounts from the full cloud history; the solver scores fairly. Post-gen rebuildHistoricalCounts re-scans loadAllDaily
- Verifier: The data-flow mechanism is real and verified line-by-line. rebuildHistoricalCounts(true) (scheduler_core_utils.js L2554) builds `counts` purely from window.loadAllDailyData() (L2557), which reads only local campDailyData_v1 or the in-memory override (calendar.js L184-202) — never cloud. It then saveGlobalSettings('historicalCounts', counts) (L2593)

#### CB-64 [PLAUSIBLE] integration_hooks.js:2797  _(rotation)_
**window.eraseAllSchedules(dateKey) deletes the cloud schedule but never deletes the date's cloud rotation_counts nor rebuilds historicalCounts**

- Evidence: The `window.eraseAllSchedules = async function(dateKey)` override (L2797-2838) deletes the date's cloud schedule (`ScheduleDB.deleteSchedule(dateKey)` for full-access, or deleteMyScheduleOnly), clears window.scheduleAssignments/leagueAssignments, reloads remaining cloud data, and stamps _scheduleAssignmentsDate. It does NOT call `window.RotationCloud.deleteDate(dateKey)` and does NOT call rebuildHistoricalCounts/reIncrementHistoricalCounts. Compa
- Scenario: Any flow that invokes window.eraseAllSchedules('2026-07-15') (it is a public window API; not the path bound to flow.html's button, which calls eraseAllDailyData) deletes that day's schedule, but the cloud rotation_counts rows for 2026-07-15 survive and historicalCountedDates['2026-07-15'] stays true. A subsequent generation that pre-merges cloud ro
- Verifier: The omission is REAL: window.eraseAllSchedules (integration_hooks.js L2797-2838) deletes the cloud schedule (L2814 deleteSchedule / L2819 deleteMyScheduleOnly), clears globals, reloads, stamps the date — but contains ZERO calls to RotationCloud.deleteDate or rebuildHistoricalCounts. Its single-date sibling eraseToday (calendar.js) does BOTH: Rotati

#### CB-65 [PLAUSIBLE / LIVE] scheduler_core_auto.js:681  _(rotation)_
**Auto partial-gen snapshots scheduleAssignments from in-memory only (no cloud force-load), unlike the manual path — so a scheduler-scoped auto regen can omit other schedulers' bunks at rotation-save time**

- Evidence: In a scheduler-scoped (partial) auto gen, STEP 0 builds the preserve-snapshot purely from the in-memory map: `_preservedScheduleData = structuredClone(window.scheduleAssignments || {})` (scheduler_core_auto.js:681), and STEP 5 restores non-scoped bunks from that same in-memory snapshot (L22865-22895). There is NO cloud force-load. The MANUAL path explicitly does the opposite — when a partial gen lacks a snapshot it force-loads cloud to pull EVERY
- Scenario: Scheduler B (Seniors) loads 06-15 in AUTO mode; another scheduler's Juniors rows are in cloud but not in B's in-memory scheduleAssignments. B scope-regenerates Seniors. Auto STEP 0 snapshots only B's local bunks (no cloud force-load), STEP 5 restores only those, STEP 6.9 RotationCloud.save deletes the whole 06-15 date and re-inserts only B's bunks
- Verifier: The asymmetry is REAL and verified by direct reading. MANUAL partial gen force-loads cloud to merge ALL schedulers' bunks into window.scheduleAssignments before snapshotting (scheduler_core_main.js:1740-1829), with the author's own comment "Without this, Scheduler 2 won't see Scheduler 1's data and will overwrite it." AUTO has NO equivalent: a grep

#### CB-66 [CONFIRMED / LIVE] scheduler_core_utils.js:2407  _(rotation)_
**Period-scoped caps (maxUsage/exactFrequency per 'half'/'Nweek') are enforced from local campDailyData_v1 only — they ignore cloud rotation_counts and the cloud-merged history cache, so caps silently under-enforce on a second device or after the documented local-quota save-skip**

- Evidence: getPeriodActivityCount scans ONLY localStorage daily data: `var allDaily = window.loadAllDailyData ? window.loadAllDailyData() : {}` then counts per-date entries (scheduler_core_utils.js:2407-2422). It never consults RotationCloud / rotation_counts nor the RotationEngine cloud-merged cache. The rotation engine's HARD period gates depend entirely on it: rotation_engine.js:1075 `maxCount = (_getPeriodCount && maxUsage>0) ? _getPeriodCount(bunkName,
- Scenario: A special has maxUsage=2, maxUsagePeriod='half'. Device A generated several days this half that placed it; those daily records live in A's localStorage (and cloud daily_schedules) but device B's localStorage has none of them (or they were quota-skipped). On device B, getPeriodActivityCount returns 0-1 instead of 2, the `maxCount >= maxUsage` gate n
- Verifier: The asymmetry the claim describes is real and decisive in code. (1) The hard period gate is wired exactly as claimed: rotation_engine.js:940 `var _getPeriodCount = window.SchedulerCoreUtils?.getPeriodActivityCount;` then L1075-1081 `maxCount = (_getPeriodCount && maxUsage>0) ? _getPeriodCount(bunkName, activityName, maxPeriod) : ...` and `if (maxCo

#### CB-67 [CONFIRMED / LIVE] rotation_events.js:30  _(rotation)_
**Scheduler-role rotation-event completions (markCompleted / clearCompletedForDate) are silently dropped at the camp_state role gate — a scheduler's auto-gen marks bunks done locally but the cloud write is discarded while the code reports success**

- Evidence: saveRotationEvents writes the whole array via `window.saveGlobalSettings?.('rotationEvents', events)` (rotation_events.js:30). Rotation events are placed during auto generation (a scheduler CAN run auto): scheduler_core_auto.js:22802 `window.RotationEvents.markCompleted(eid, currentDate, bunks)` → markCompleted (rotation_events.js:564) → saveRotationEvents → saveGlobalSettings('rotationEvents'). That write is queued into integration_hooks _pendin
- Scenario: A scheduler generates an auto day that schedules a 'Lice Check' rotation event for their bunks. The engine marks those bunks completed and saveRotationEvents runs, but the camp_state cloud write is dropped (scheduler role). The completion stamps live only in that scheduler's browser. The owner (or any other device) loads Daily Adjustments → Schedul
- Verifier: Every link in the claimed chain is real, with no intervening guard. (1) WRITE PATH IS THE ONLY ONE: repo-wide grep shows `rotationEvents` is referenced in exactly two files — rotation_events.js (writes) and schedule_calendar_views.js (reads). saveRotationEvents (rotation_events.js:27-32) is the sole cloud writer: `g.rotationEvents = events; window.

#### CB-68 [CONFIRMED] rotation_events.js:726  _(rotation)_
**Stored XSS: Scheduled-Activity name rendered raw in daShowConfirm/daShowAlert (escaper applied inconsistently)**

- Evidence: Three call sites interpolate the fully user-controlled event name UNESCAPED into messages that daShowConfirm/daShowAlert render as raw innerHTML: L726: `await window.daShowConfirm('Delete "' + evt.name + '"? This cannot be undone.', { danger:true, confirmText:'Delete' })` L739: `await confirmFn('Restart "' + evt.name + '"? This will clear all completion records and start from scratch.', ...)` L940: `alertFn('Created "' + result.name + '"<br
- Scenario: In auto-builder mode the 'Scheduled Activities' subtab is injected into Daily Adjustments (rotation_events.js L1020-1074). A user creates a Scheduled Activity named `<img src=x onerror=alert(document.cookie)>`. Immediately on Create the daShowAlert summary (L940) renders the name raw and the onerror fires. Thereafter, every time anyone with the cam
- Verifier: Verified the full source-to-sink chain in real code. SOURCE: the Scheduled Activity 'Name' is a free-text input (rotation_events.js L856 create, L964 edit), collected raw via `.value.trim()` with no escaping (daily_adjustments.js L166: `return fieldEl.querySelector('input').value.trim();`) and stored raw (rotation_events.js L911: `name: result.name

#### CB-69 [CONFIRMED / LIVE] division_times_integration.js:273  _(dates)_
**Debounced _perBunkSlotsData persist writes the OLD date's per-bunk slot geometry under the NEW date's record after a fast date switch (cross-date contamination)**

- Evidence: The auto-persist of per-bunk slot geometry is debounced 250ms and NOT cancelled on date change: ``` let _pbsPersistTimer = null; function _schedulePerBunkSlotsPersist() { if (_pbsPersistTimer) return; // already queued _pbsPersistTimer = setTimeout(function() { _pbsPersistTimer = null; ... const dt = window.divisionTimes || {}; // live geometry = OLD date's ... originalSaveCurrentDailyData.call(wi
- Scenario: Auto builder, per-bunk slots active. User edits a per-bunk slot (any post-build resize / daily-adjustment that triggers saveCurrentDailyData) on date A, then within ~250ms changes the calendar to date B. The queued timer fires after currentScheduleDate has flipped to B, reads window.divisionTimes (still holding A's per-bunk slot arrays because the
- Verifier: The mechanism is real and matches the claim. (1) division_times_integration.js L272-290: _pbsPersistTimer is a 250ms setTimeout that reads live window.divisionTimes (L278) and writes spbs via originalSaveCurrentDailyData (L285). Grep over the whole file proves NO clearTimeout, NO _pendingDateTransition guard, and NO _scheduleAssignmentsDate owner-s

#### CB-70 [CONFIRMED / LIVE] schedule_calendar_views.js:116  _(dates)_
**Calendar month/week/year overview reads schedule-existence + camp/event markers ONLY from stale localStorage campDailyData_v1, never cloud — cloud-only or locally-pruned dates render "No schedule" (and lose trip/event/pin markers) even though a real schedule exists in Supabase**

- Evidence: The entire calendar-views data layer reads only localStorage, with no cloud path. `getAllDailyData()` (L108-114) `var raw = localStorage.getItem('campDailyData_v1'); return raw ? JSON.parse(raw) : {};` and the render-scoped cache `beginRenderCache()` (L92-96) does the same. `getScheduleDataForDate(dateKey)` (L116-119) `var all = getAllDailyData(); return all[dateKey] || null;`. The thorough `hasSchedule(dateKey)` (L305-316) returns false whenever
- Scenario: A camp that has generated >45 days (or is at localStorage quota) opens the calendar in Month or Year view and pages to an earlier month whose days were pruned from the local mirror but still live in Supabase. Every such day shows "No schedule" / no green check and no trip/event markers. The head counselor, believing those days are blank, clicks Gen
- Verifier: All three load-bearing assertions hold in the actual code, and no guard prevents the scenario. (1) Calendar data layer is local-only. schedule_calendar_views.js: beginRenderCache (L92-96) and getAllDailyData (L108-114) read ONLY localStorage 'campDailyData_v1'. getScheduleDataForDate (L116-119) = all[dateKey]||null; hasSchedule (L305-316) returns

#### CB-71 [CONFIRMED] calendar.js:466  _(dates)_
**Scheduler 'Start New Half' silently fails to reset rotation/frequency — omits manualUsageOffsets + historicalCountedDates that the owner branch clears**

- Evidence: In startNewHalf the SCHEDULER branch (calendar.js:466-549) only scrubs per-bunk: RotationCloud.clearForBunks (L523), rotationHistory.bunks (L527-529), historicalCounts (L531-533), smartTileHistory (L535-538). It NEVER touches `manualUsageOffsets` or `historicalCountedDates`. The OWNER branch clears both (L608-610 / L620-622). The same asymmetry exists in eraseRotationHistory: scheduler branch (L361-401) scrubs historicalCounts (L383-385)+smartTil
- Scenario: Scheduler (assigned 'Seniors') has manualUsageOffsets['Senior A']['Swim']=5 (set via the analytics manual-count editor) and clicks Start New Half (or Reset Rotation History). The UI confirms 'New half started for your divisions!' and reloads. But getActivityCount('Senior A','Swim') still returns 0+5=5, so on the new half Swim is treated as already
- Verifier: Verified every link of the claim against the actual code. (1) Asymmetry confirmed by full-file grep: in calendar.js, `manualUsageOffsets` and `historicalCountedDates` appear ONLY in the owner branches — startNewHalf owner at L608-610/620-622 and eraseRotationHistory owner at L419-428 (both pass them to clearCloudKeys / saveGlobalSettings). Neither

#### CB-72 [PLAUSIBLE / LIVE] calendar.js:1238  _(dates)_
**Scheduler 'Erase today' rebuilds GLOBAL historicalCounts + rotationHistory unscoped in the shared tail (non-league analog of the LG-5 fall-through)**

- Evidence: eraseCurrentDailyData's scheduler branch (L1128-1160) does its scoped bunk delete and does NOT return on success (only the cloud-error path returns at 1150). It therefore falls through to the SHARED tail, which runs unconditionally for every role: `window.SchedulerCoreUtils.rebuildHistoricalCounts(true)` (L1238-1239) and a full `_rotHist.bunks = {}` rebuild from `window.loadAllDailyData()` then `window.saveRotationHistory(_rotHist)` (L1244-1266).
- Scenario: Two schedulers, scoped local caches. Scheduler-A (divisions Seniors) clicks Erase Today for their division. After the scoped delete, the shared tail rebuilds historicalCounts and rotationHistory.bunks from A's local loadAllDailyData(), which contains only A's bunks. The truncated global maps (missing Scheduler-B's Juniors history) are saved to glob
- Verifier: The structural fall-through and unscoped global rebuild are REAL and confirmed in code. calendar.js eraseCurrentDailyData's scheduler branch (L1128-1160) does its scoped bunk delete and returns ONLY on the cloud-error path (L1150) — on success it falls through to the shared tail that runs unconditionally for every role. The tail invokes window.Sche

#### CB-73 [PLAUSIBLE / LIVE] scheduler_core_utils.js:1463  _(dates)_
**getSlotTimeRange / findSlotForTime / getSlotAtIndex resolve slot index against the DIVISION-level times table, never the per-bunk geometry — wrong time/activity for auto-mode per-bunk schedules**

- Evidence: getSlotTimeRange (L1463-1485): `const slot = window.divisionTimes[divNameStr]?.[slotIdx]; if (slot) return {startMin: slot.startMin, endMin: slot.endMin}; ... // No fallback - division context is required; return {startMin: null, endMin: null}`. getSlotAtIndex (L1450-1453): `return window.divisionTimes?.[divNameStr]?.[slotIndex] || null;`. findSlotForTime (L1493-1503) and findSlotForTimeRange (L1512) both call `getSlotsForDivision(divisionName)`
- Scenario: Auto-mode camp where bunk 'Minors 1' has a per-bunk timeline that differs from the division-level divisionTimes['Minors'] table (e.g. the division table is shorter, or a bunk has an extra/shifted slot from a custom pinned layer). A caller asks getAssignmentAtTime('Minors 1', 745min): findSlotForBunkAtTime→findSlotForTime scans divisionTimes['Minors
- Verifier: The structural core of the claim is REAL and correctly diagnosed. The shared index→time helpers resolve slot index against the division-level `divisionTimes[div]` array: getSlotsForDivision (scheduler_core_utils.js:1441 `return window.divisionTimes?.[divNameStr] || []`), getSlotAtIndex (:1453), getSlotTimeRange (:1474), findSlotForTime (:1494), fin

#### CB-74 [CONFIRMED / LIVE] calendar.js:830  _(dates)_
**Scheduler scoped-delete (deleteBunksFromAllRecords) swallows mid-loop per-record cloud write errors and is non-atomic — partial cloud delete with success:true, or a throw after some records already deleted leaves cloud/local diverged with no surfaced error**

- Evidence: Per-record loop L830-849: each record is committed individually — `const {error} = await client.from('daily_schedules').delete().eq('id', record.id); if (!error) recordsDeleted++;` (L841-842) and `const {error} = await client.from('daily_schedules').update({...}).eq('id', record.id); if (!error) recordsModified++;` (L844-847). A failed individual write is only counted-or-not; it is NOT collected, NOT re-thrown, and does NOT change the final `retu
- Scenario: Scheduler owns 6 divisions whose bunks are spread across 3 cloud daily_schedules rows for 06-15. They click 'Delete schedule for your divisions'. The loop deletes row 1 (their bunk removed) then the row-2 update hits a transient network error: with inline `if(!error)` the error is silently dropped and the loop continues, success:true is returned, l
- Verifier: The claim has two mechanisms, both verified in actual source and NOT covered by existing findings. MECHANISM 1 (error swallow → success:true): In deleteBunksFromAllRecords (calendar.js), the per-record loop commits each row individually and only counts the error, never collecting/rethrowing it: L841-842 `const { error } = await client.from('daily_

#### CB-75 [CONFIRMED] dashboard.js:352  _(dates)_
**Stored XSS: camp name + subdivision/division names rendered raw via innerHTML (no escaper in the whole file)**

- Evidence: dashboard.js has NO escapeHtml helper anywhere (grep for escapeHtml in the file = 0 hits) yet interpolates owner-controlled names straight into innerHTML. updateWelcomeMessage L352: `welcomeTitle.innerHTML = \`Welcome back, <span>${displayName}</span>!\`;` where `displayName = campName || userName || ...` and campName is loaded from the camp owner's `camps.name` (L200-210 for team members, L270 for owner). Subdivision badge L450-452: `badgeElemen
- Scenario: Camp owner (or any account that can write `camps.name` / a `subdivisions.name`) sets the camp name to `<img src=x onerror=alert(document.cookie)>`. Every team member (admin / scheduler / viewer) who opens the dashboard has campName loaded from the owner's camps.name (L210) and rendered via welcomeTitle.innerHTML (L352) → the payload executes in eac
- Verifier: All four sinks and the full stored-XSS loop are confirmed in the actual code. dashboard.js has NO escaper (grep for escapeHtml|escHtml|_escHtml|esc = 0 matches), and dashboard.html loads it (L322), so the sinks are live. VECTOR 1 (camp name — conclusive cross-user stored XSS): - Write (raw, owner-controlled): saveCampProfile reads a free-form text

#### CB-76 [CONFIRMED] period_editor.js:313  _(dates)_
**Stored XSS: grade names interpolated raw into innerHTML in two headers (sidebar/rows correctly use textContent — escaping applied inconsistently)**

- Evidence: period_editor.js has no escaper. renderGradeDetail L312-313: `hdr.innerHTML = \`<h3 ...>Grade ${activeGrade} — Bell Schedule</h3>...\`;` where activeGrade flows from `grades` = Object.keys(window.divisions) (L249-274). showCopyModal L151-156: `header.innerHTML = \`<h3...>Copy Bell Schedule</h3><p...>Copy <strong>${sourcePeriods.length}</strong>... from <strong>Grade ${sourceGrade}</strong> to:</p>\`;` — sourceGrade is also a grade name, raw. The
- Scenario: A grade is named `<img src=x onerror=...>` in Camp Structure (grade names are free-text). Opening the Bell Schedule (period) editor and selecting that grade renders renderGradeDetail → L313 injects the grade name raw into the H3 → script executes. Clicking 'Copy to Grades…' from any grade renders the modal header (L155) with sourceGrade raw → secon
- Verifier: All elements of the claim verified against the real code in C:\Users\yisro\daily-camp-schedular\period_editor.js. (1) NO ESCAPER: Grep for escapeHtml|escHtml|_escHtml|function esc\(|CampUtils in period_editor.js returns zero matches. The file has only minsToTimeStr/parseTimePicker/toTimeInput/uid helpers (L10-45). It never escapes HTML. (2) TWO R

#### CB-77 [CONFIRMED / LIVE] analytics.js:177  _(display)_
**Field Availability Gantt (buildUsageData) trusts dateKey===liveDate + non-empty memory WITHOUT the _scheduleAssignmentsDate coherence guard the rotation table in the SAME file requires — can show a prior date's field usage on the selected date**

- Evidence: buildUsageData (analytics.js:171-186): ```js const liveDate = window.currentScheduleDate; let assignments; if (dateKey && dateKey === liveDate && window.scheduleAssignments && Object.keys(window.scheduleAssignments).length) { assignments = window.scheduleAssignments; // ← no stamp check } else if (dateKey && allDaily[dateKey]?.scheduleAssignments) { assignments = allDaily[dateKey].scheduleAssignments; } ``` The rotation-table
- Scenario: User generates a schedule for 06-22 (memory now holds 06-22, _scheduleAssignmentsDate=06-22). They navigate to 06-23 via a path where the load returns a transient error (result.success false) — the orchestrator's clear-on-empty branch (integration_hooks.js:2214-2228) only fires on result.success===true, so window.scheduleAssignments keeps 06-22's d
- Verifier: The asymmetry is real and decisive. buildUsageData (analytics.js:171-186) selects in-memory window.scheduleAssignments purely on `dateKey === liveDate && Object.keys(window.scheduleAssignments).length` with NO _scheduleAssignmentsDate stamp check. The rotation-table path in the SAME file (line 1383) was explicitly hardened against exactly this with

#### CB-78 [CONFIRMED / LIVE] print_center.js:388  _(display)_
**Print Center Week-at-a-Glance caches the anchor (current) day's in-memory schedule snapshot at view-open and never refreshes it for the live date — after an in-session regen/edit the week grid shows the stale snapshot the entire session**

- Evidence: ensureWeekDataLoaded captures the CURRENT date's column as a point-in-time snapshot of window.scheduleAssignments (print_center.js:404-405): `if (k === anchor) { _weekData[k] = { scheduleAssignments: window.scheduleAssignments || {}, leagueAssignments: window.leagueAssignments || {} }; ... }`. The reload is short-circuited by a cache guard (line 388): `if (!force && _weekAnchor === weekId && Object.keys(_weekData).length === 7) return;`. renderWe
- Scenario: User opens Print Center, switches to the 'Week' tab on 06-22 (ensureWeekDataLoaded snapshots 06-22's current in-memory schedule into _weekData['06-22']). Without leaving the page they edit a slot (daily adjustment) or regenerate 06-22; window.scheduleAssignments updates, every other view (Divisions/Bunks/Facilities, the grid, the calendar) reflects
- Verifier: The mechanism is real and every link in the chain is present in code. (1) ensureWeekDataLoaded snapshots the anchor day at print_center.js:405 `_weekData[k] = { scheduleAssignments: window.scheduleAssignments || {}, leagueAssignments: window.leagueAssignments || {} }`. (2) The cache guard at L388 `if (!force && _weekAnchor === weekId && Object.keys

#### CB-79 [CONFIRMED] analytics.js:1594  _(display)_
**Report-tab rotation-offset editor writes generation-affecting manualUsageOffsets with NO role gate (whole-map clobber + scheduler silent no-op)**

- Evidence: renderRotationTable renders an editable number input per bunk/activity (L1578-1581: `<input type="number" class="rotation-adj-input" ...>`), then wires it unconditionally for EVERY role: ``` cont.querySelectorAll('.rotation-adj-input').forEach(inp => { inp.onchange = (e) => { const b = e.target.dataset.bunk, a = e.target.dataset.act; const val = parseInt(e.target.value) || 0; const gs = window.loadGlobalSettings?.() || {}; if (!
- Scenario: Owner on device A sets a rotation offset for Bunk1/Soccer (+3) → saved. Admin on device B had the Report tab open (stale loadGlobalSettings missing the +3), types an offset for Bunk2/Gaga and blurs → saveGlobalSettings writes B's whole manualUsageOffsets map (no Bunk1/+3) → cloud row replaced → Bunk1/Soccer offset silently lost, and the next genera
- Verifier: All four legs of the claim hold against the actual code. (1) NO ROLE GATE + reachable by all roles. analytics.js has zero role/permission checks (grep for role|canEdit|isOwner|checkEditAccess|readonly|disabled|getRole in analytics.js → "No matches found"). The number input is rendered per bunk/activity (analytics.js:1578-1580 `<input type="number"

#### CB-80 [CONFIRMED / LIVE] print_center.js:583  _(display)_
**pcFindFieldSharers resolves the slot time-window from division-level divisionTimes[div] but auto-mode callers pass a PER-BUNK slot index → wrong/missing "vs Bunk" sharer annotations on auto printouts**

- Evidence: L560 `function pcFindFieldSharers(bunk, slotIdx, divName){` then L561 `var myEntry = ...scheduleAssignments[bunk][slotIdx];` (per-bunk-indexed array, correct) but L583 `var mySlot = window.divisionTimes && window.divisionTimes[divName] && window.divisionTimes[divName][slotIdx];` then L585 `var myStart = mySlot.startMin, myEnd = mySlot.endMin;`. `divisionTimes[divName]` is the DIVISION-level slot array, NOT `divisionTimes[divName]._perBunkSlots[bu
- Scenario: Auto schedule where a bunk has a 10-min Change slot before swim that shifts its per-bunk slot boundaries away from the division-level grid (the exact divergence documented at auto_schedule_grid.js L330-336 and auto_validator.js L5-6). Bunk Minors-1 plays Basketball on Court A at per-bunk index 3 (actual 11:30-12:15). pcFindFieldSharers reads myEntr
- Verifier: The bug is real and matches the code. `pcFindFieldSharers` (print_center.js:560) reads the ENTRY by per-bunk index — `myEntry = scheduleAssignments[bunk][slotIdx]` (L561) — but reads the TIME WINDOW from the DIVISION-level array with that SAME index — `mySlot = window.divisionTimes[divName][slotIdx]` (L583), `myStart=mySlot.startMin, myEnd=mySlot.e

#### CB-81 [CONFIRMED / LIVE] print_center.js:3044  _(display)_
**Cell hover tooltip (_pcBuildCellTipHtml) reads the slot time from division-level divisionTimes[div] using the per-bunk data-slot index → wrong "When" time shown in auto mode**

- Evidence: L3042 `function _pcBuildCellTipHtml(bunk, slotIdx, divName){` L3043 `var entry = ...scheduleAssignments[bunk][slotIdx];` (per-bunk, correct) but L3044 `var slot = window.divisionTimes && window.divisionTimes[divName] && window.divisionTimes[divName][slotIdx];` and L3055-3056 render `When` from `slot.startMin`/`slot.endMin`. The `slotIdx` arrives from the cell's data-slot attribute which in auto mode is set to the PER-BUNK index: L2169 `... data-s
- Scenario: Auto mode, inspect/hover a cell whose bunk has staggered geometry. The activity name (from entry) is right, but the tooltip 'When 12:15 – 13:00 (45 min)' is read from divisionTimes['Minors'][slotIdx] which is the wrong row for that per-bunk index, so the tooltip displays a time window that does not match the cell the user is hovering, and the 'With
- Verifier: The per-bunk index → division-level-array mismatch is real and the claim correctly traces it. DATA STRUCTURE: In auto/per-bunk mode (division_times_system.js, hasBunkSpecificBlocks branch L266-339), window.divisionTimes[divName] is built with TWO decoupled index spaces: (a) numeric elements pushed at L285 from `sortedPoints` = the UNION of every bo

#### CB-82 [CONFIRMED / LIVE] campistry_me.js:1436  _(config)_
**Division/grade rename never migrates the cloud schedule_data `_perBunkSlotsData` key — per-bunk slot geometry is orphaned for the renamed unit on every saved date**

- Evidence: _propagateDivisionRename renames only two division-keyed cloud sub-structures: `['divisionTimes','unifiedTimes'].forEach(function(k){ if(sd[k] && ... oldName in sd[k]){ sd[k][newName]=sd[k][oldName]; delete sd[k][oldName]; modified=true } });` (campistry_me.js:1436-1443). But cloud `schedule_data` ALSO carries a top-level, division/grade-keyed `_perBunkSlotsData` (supabase_schedules.js:736 `_perBunkSlotsData: ...`, written at 992, and consumed on
- Scenario: Auto-mode camp has generated schedules for several dates. Owner renames grade 'Minors' to 'Minors A' in the division-edit modal. _propagateDivisionRename rewrites divisionTimes['Minors']->['Minors A'] in every cloud row but leaves _perBunkSlotsData['Minors'] untouched. On next load of any of those dates, MS-4c (supabase_schedules.js:583-588) looks
- Verifier: The claim is accurate and identifies a real, uncovered gap. CHAIN VERIFIED END-TO-END: (1) WRITE: cloud schedule_data carries a top-level grade/division-keyed `_perBunkSlotsData` (supabase_schedules.js:987-992 keys it by `g` from window.divisionTimes; written into payload at L992). Also produced by mergeSchedules (L736), schedule_orchestrator (L85

#### CB-83 [CONFIRMED] special_activities.js:119  _(config)_
**Renaming a grade silently WIPES that grade from every special activity's per-grade config (sharing divisions, access restrictions, rotation cohort, per-grade frequency/usage maps) — the Me-page rename cascade never touches specialActivities**

- Evidence: validateSpecialActivity rebuilds each special and filters all per-grade lists against the CURRENT grade set (window.divisions, line 108): `sharableWith.divisions = sharableWith.divisions.filter(d => ... validDivisions.has(d))` (119); access `Object.keys(accessRestrictions.divisions).forEach(divKey => { if (!validDivisions.has(divKey)) delete accessRestrictions.divisions[divKey] })` (146) + priorityList filter (149); `rotationCohort.grades ... raw
- Scenario: A special 'Canteen' is configured cross_division-shared with grades ['Minors','Majors'] and has access restricted to those grades, plus a rotationCohort {grades:['Minors','Majors']}. Owner renames grade 'Minors' to 'Minors A' in Camp Structure. Nothing migrates the special. User opens the Special Activities tab (or generation runs) -> loadData -> v
- Verifier: The claim holds against the actual code on every load-bearing point. (1) The ONLY grade-rename handler in the whole repo is the saveDiv cascade in campistry_me.js (grep for grade-rename across all *.js returns hits only there). When editingDiv detects a grade rename (gradeRenameMap, campistry_me.js:1235-1245) it propagates to exactly three targets

#### CB-84 [CONFIRMED] zones.js:818  _(config)_
**Zone "max concurrent" cap is saved + displayed but NEVER enforced — checkZoneCapacity/getZoneMaxConcurrent have zero solver call sites (silent no-op config)**

- Evidence: zones.js:810 `window.getZoneMaxConcurrent = function(zoneName){...return parseInt(zone?.maxConcurrent)||99;}` and zones.js:818 `window.checkZoneCapacity = function(zoneName, slotIndex, currentCount){ const maxConcurrent = window.getZoneMaxConcurrent(zoneName); return (currentCount||0) < maxConcurrent; }`. The zone editor writes this via zones.js:583 `zone.maxConcurrent = Math.max(1,Math.min(99,parseInt(input.value)||99))` and saveData()→saveGloba
- Scenario: Owner configures an off-campus zone 'Pool Complex' with 'max 2 at a time' (zones.js:575 number input, persisted as zone.maxConcurrent=2) to cap how many bunks can be at that zone simultaneously. Generate any day: the solver places as many bunks into fields in that zone as fit by field capacity/sharing rules, completely ignoring the zone-level cap o
- Verifier: The claim is accurate. zones.js:575-587 shows the zone editor has a live number input ("Maximum number of activities that can run simultaneously in this zone") whose onchange writes zone.maxConcurrent and persists via saveData()→saveGlobalSettings('locationZones'), with the value surfaced in the UI as "N at a time" (lines 422, 586) — so this is a r

#### CB-85 [CONFIRMED] campistry_me.js:1242  _(config)_
**Grade rename does not propagate to facility/special access-restriction, sharing-division, priority-list, or rotation-cohort config — the special validator then silently prunes the now-orphaned grade name (FN-1 sibling, uncovered store)**

- Evidence: saveDiv() handles a grade rename via campistry_me.js:1242 `_propagateDivisionRename(oldG,newG)` + 1243 `_propagateGradeRenameTiles(oldG,newG)` + 1244 camper.grade rewrite. `_propagateDivisionRename` (campistry_me.js:1378) renames ONLY scheduling keys (window.divisionTimes/unifiedTimes/divisions/availableDivisions at 1386-1388), slot `_division` fields (1394-1401), and cloud daily_schedules sub-structures (1436-1447 only `divisionTimes`/`unifiedTi
- Scenario: A special activity 'Ropes Course' is access-restricted to ONLY grade 'Minors' (accessRestrictions.divisions={'Minors':[]}, enabled:true). Owner opens the Me page and renames grade 'Minors' to 'Minors A'. Grade rename propagates to schedule/skeleton/layer/campers, but the special's accessRestrictions still says 'Minors'. Next time special_activities
- Verifier: The grade-rename path in campistry_me.js saveDiv() propagates ONLY to scheduling keys/slots/cloud (_propagateDivisionRename, ~L1242), manual-skeleton tiles + dailyAutoLayers + gradeLayerRules (_propagateGradeRenameTiles, ~L1243), and camper.grade (~L1244). A repo-wide grep proves campistry_me.js never references accessRestrictions / sharableWith /

#### CB-86 [CONFIRMED] master_schedule_builder.js:3929  _(config)_
**Manual skeleton tile renderer (renderEventTile) interpolates ~8 user-controlled names raw into innerHTML — broad stored XSS**

- Evidence: renderEventTile (L3912) builds an HTML string that is assigned to grid.innerHTML at L3833 (`html += renderEventTile(...)` L3824 → `grid.innerHTML = html` L3833). NONE of the user-controlled names are escaped: L3929 `<strong>${ev.event}</strong>` (custom event name, set via the 'Event Name' field L1084), L3935 `📍 ${ev.location}`, L3937 `📍 ${ev.reservedFields.join(', ')}` (field names), L3942 `${ev.leagueName}`, L3955 `🎯 ${actList}` (ev.elective
- Scenario: An admin/scheduler creates a custom skeleton tile and types the Event Name `<img src=x onerror=alert(document.cookie)>` (or names a field/league/elective/swim location that), saves the skeleton. Every time the manual skeleton grid renders (open the builder for that division/date), renderEventTile injects the payload into grid.innerHTML and it execu
- Verifier: The claim is accurate in every link of the chain, verified by reading the actual code. (1) Input is user-controlled and stored RAW. The "Event Name" modal field (master_schedule_builder.js:1084 `{ name: 'eventName', label: 'Event Name', type: 'text', default: ev.event }`) is written back unescaped at L1114 `ev.event = result.eventName.trim();`. Ot

#### CB-87 [CONFIRMED] master_schedule_builder.js:2031  _(config)_
**Auto layer-editor grid (renderDAWGrid) band-label + data-grade attr interpolate custom-activity/league/grade names raw into innerHTML**

- Evidence: In renderDAWGrid the band HTML is built into `html` and assigned `gridEl.innerHTML = html` (L2044). L2031 `<span class="band-label">${layer.customActivity || layer.leagueName || typeDef?.name || layer.type}</span>` interpolates the user-typed custom-layer activity name and league name RAW (body context). L2027 `data-grade="${gradeKey}"` interpolates the grade name RAW into a double-quoted attribute (breakout via `"`). The custom-tile drag-ghost a
- Scenario: A custom auto layer named `<img src=x onerror=alert(1)>`, a league named that, or a grade named `x" onmouseover="alert(1)` (data-grade breakout) executes every time the Auto layer editor grid renders for that grade.
- Verifier: All four sinks named in the claim are real and unescaped in renderDAWGrid (function starts L1791; the html string is assigned raw via gridEl.innerHTML=html at L2044, with no DOMPurify/sanitize anywhere in the file). (1) Band-label body XSS — L2031 interpolates `layer.customActivity || layer.leagueName || typeDef?.name || layer.type` raw into inner

#### CB-88 [CONFIRMED] facilities.js:2332  _(config)_
**Combined-field relationship box interpolates field names raw into innerHTML — inconsistent with textContent used 25 lines below for the same names**

- Evidence: L2332-2333: `box.innerHTML = \`<div ...>${currentCombo.subFields.join(' + ')} = ${currentCombo.combinedField}</div><div ...>${isCombined ? '...' : 'This field is part of "' + currentCombo.combinedField + '"'}</div>\`` — subFields and combinedField are user-entered field names (set at L2391 `fieldCombos[id] = { combinedField: thisName, subFields: subs }`, where thisName/subs come from facility names) interpolated RAW. The SAME field names are re
- Scenario: A facility/field named `<img src=x onerror=alert(1)>` that is part of a combined-field relationship executes when the user opens that field's 'Combined Field' configuration section.
- Verifier: The claim is accurate. In facilities.js, renderComboSettings → renderContent() builds the combined-field relationship box via raw innerHTML at L2332-2333, interpolating currentCombo.subFields.join(' + ') and currentCombo.combinedField with no escaping. These values are user-controlled field names: combos are created at L2391 `fieldCombos[id] = { id

#### CB-89 [CONFIRMED] team_subdivisions_ui.js:165  _(config)_
**Subdivision/team UI (renderSubdivisionItem) interpolates user-typed subdivision and division names raw into innerHTML**

- Evidence: renderSubdivisionItem (L159) returns HTML with `<div class="subdivision-name">${sub.name}</div>` (L165) and is assembled into `container.innerHTML` via renderSubdivisionsCard (L136 `_subdivisions.map(sub => renderSubdivisionItem(...)).join('')` → container.innerHTML at L111/298). `sub.name` is the user-typed subdivision name (modal input at L205 `value="${existingSubdivision.name}"`). Same gap at L429 and L520 (`<span>${sub.name}</span>`), L86 in
- Scenario: An owner/admin creates a subdivision named `<img src=x onerror=alert(document.cookie)>` (Team Subdivisions card). Every render of the subdivisions card (dashboard) executes the payload; the div-pill path also fires if a division is named that.
- Verifier: team_subdivisions_ui.js has NO escaper (grep for escapeHtml/escHtml/_escHtml/CampUtils/escape( returns zero matches in the file) and interpolates user-typed names raw into innerHTML. Full exploit chain verified: (1) renderSubdivisionItem L165 emits `<div class="subdivision-name">${sub.name}</div>`, assembled at L136 `_subdivisions.map(sub => render

#### CB-90 [CONFIRMED] rotation_events.js:499  _(rotation)_
**Rotation-event completedBunks is never cleared when a date's schedule is deleted or a New Half starts — affected bunks are permanently skipped**

- Evidence: clearCompletedForDate (rotation_events.js:499) is the ONLY function that prunes evt.completedBunks, and the auto generator calls it for the CURRENT date only at STEP 0 (scheduler_core_auto.js:731). A grep for `completedBunks`/`clearCompletedForDate`/`RotationEvents` shows ZERO references in the schedule-delete/erase paths: calendar.js (window.eraseRotationHistory, window.startNewHalf owner+scheduler, the documented 'Erase ALL schedules' at ~1430)
- Scenario: Owner sets up a 'Lice Check' rotation event (date range 06-10..06-14), auto-generates 06-10 → 06-12, marking ~25/35 bunks done. Owner then clicks 'Start New Half' (or 'Erase ALL schedules'), which deletes every schedule and resets all counters — but completedBunks for Lice Check is untouched. Owner regenerates the new half: the 25 already-marked bu
- Verifier: The claim holds on every link of the chain, verified in the actual code. WRITE/ACCUMULATE: scheduler_core_auto.js:22781-22802 (`_markCompletionsFromFinalGrid`) calls `window.RotationEvents.markCompleted(eid, currentDate, bunks)` for every placed event at the end of each auto gen. markCompleted (rotation_events.js:474-486) pushes bunks into `evt.co

#### CB-91 [CONFIRMED] coverage_warning.js:250  _(display)_
**Red 'unfilled Free slots' banner never auto-clears on a clean auto-regeneration (producer early-returns before dispatching the empty clearing event)**

- Evidence: coverage_warning.js's header comment promises the Free banner 'Clears automatically on a clean (zero-Free) generation.' and its handler relies on an empty dispatch to clear: onImpossibilities (L250-255) sets `_frees = d.items.slice()` and renderFree (L218-220) removes the widget when `!_frees.length`. The ONLY clear paths are (a) an empty `campistry-schedule-impossibilities` dispatch or (b) the user clicking ×. There is NO generation-start or dat
- Scenario: Auto mode. User generates 06-15 and it leaves 4 Free slots → the big red top-center banner '⛔ 4 unfilled (Free) slots in this schedule' appears. User widens field capacity / fixes layers and regenerates 06-15 → this time 0 Free. The clean gen hits the L25307 early-return and dispatches nothing, so onImpossibilities is never called and the red banne
- Verifier: The mechanism is exactly as claimed, confirmed by reading the actual code. In coverage_warning.js the Free banner's state array `_frees` is mutated in only three places: L252 `onImpossibilities` sets `_frees = d.items.slice()` (the sole event-driven path), L246 `.fw-close` click sets `_frees = []` (user clicks x), and L182 initial `[]`. A grep of e

#### CB-92 [CONFIRMED / LIVE] campistry_me.js:1378  _(config)_
**Division/grade rename never migrates the RBAC scheduler-scoping store (subdivisions.divisions[] + camp_users.assigned_divisions[]) — schedulers silently lose access to the renamed unit**

- Evidence: saveDiv calls `_propagateDivisionRename(editingDiv, name)` (L1228) for divisions and `_propagateDivisionRename(oldG,newG)` (L1242) for grades. _propagateDivisionRename (L1378-1490) renames only in-memory divisionTimes/unifiedTimes/divisions/availableDivisions + slot._division, and cloud `daily_schedules` rows: `client.from('daily_schedules').select('id,schedule_data')` (L1428) — it issues NO query against the `subdivisions` table or `camp_users`.
- Scenario: Owner creates subdivision 'North' = ['Neranina'] and assigns scheduler Sam to it. Owner later renames division 'Neranina' → 'Neranim' in the Me-page Camp Structure modal. _propagateDivisionRename rewrites schedules + window.divisions, but `subdivisions.divisions` still holds 'Neranina'. On Sam's next login getGeneratableDivisions/_editableDivisions
- Verifier: The claim is correct: division/grade rename never migrates the RBAC scoping stores, and schedulers scoped to the renamed unit by name lose access. (1) `_propagateDivisionRename` (campistry_me.js L1378-1490) touches only in-memory `window.divisionTimes/unifiedTimes/divisions/availableDivisions` + slot `_division`, and cloud `daily_schedules` rows:

#### CB-93 [CONFIRMED] master_schedule_builder.js:1438  _(config)_
**Grade rename/delete never migrates the authoritative auto-layer editor store app1.autoLayerTemplates — renamed grade opens with an EMPTY layer editor and its configured layers are orphaned (delete leaves them forever)**

- Evidence: The auto-layer editor content is grade-keyed: `let dawLayers = {}; // { gradeKey: [...] }` (L1381), pushed per grade at `dawLayers[grade].push(...)` (L3293). It persists into `g.app1.autoLayerTemplates[templateKey] = JSON.parse(JSON.stringify(dawLayers))` (saveDAWLayers L1438), and loadDAWLayers reads EXCLUSIVELY from there: `const autoTemplates = g.app1?.autoLayerTemplates || {}` ... `dawLayers = JSON.parse(JSON.stringify(autoTemplates[tmpl]))`
- Scenario: Auto camp: owner builds layers for grade 'Majors' in the layer editor (saved into autoLayerTemplates['_current'] and/or a named template under key 'Majors'). Owner renames 'Majors' → 'Seniors' in the Me-page. dailyAutoLayers/gradeLayerRules are renamed, but autoLayerTemplates still keys the layers under 'Majors'. Next time the editor opens for 'Sen
- Verifier: The claim is correct in every link, grounded in code. (1) The auto-layer editor store `dawLayers` is GRADE-keyed: seeded from non-parent divisions (grades) — master_schedule_builder.js L1421-1427 `Object.keys(divisions).forEach(d => { if (div.isParent) return; dawLayers[d] = []; })` — and written per grade at L3252/L3293 `dawLayers[grade].push(...

#### CB-94 [CONFIRMED] campistry_me.js:1497  _(config)_
**Bunk RENAME is treated as delete+create: there is no data-orig tracking on bunk chips, so _purgeOrphanedBunks destroys the old bunk's cloud schedule rows while the new name starts empty**

- Evidence: Grade rows carry `data-orig` so saveDiv can detect a rename (L1120, L1236-1239), but bunk chips do NOT: `_renderBunkChipsHTML` emits `<span class="me-bunk-chip"><span class="me-bunk-name">'+esc(b)+'</span>...` with no data-orig (L1108-1110), and saveDiv harvests bunks purely by current text — `row.querySelectorAll('.me-bunk-chip .me-bunk-name'), s => s.textContent.trim()` (L1217). So an in-place rename of a bunk yields oldBunks=[...'Bunk A'], new
- Scenario: Owner has a generated week for 'Bunk A'. They open the division Edit modal, fix a typo in the bunk's name to 'Bunk B' (the only editing affordance is to remove the chip and re-type, or the chip text is replaced), and Save. saveDiv sees 'Bunk A' missing from the new set and purges it: every saved daily_schedules row's 'Bunk A' entry is deleted from
- Verifier: Both factual claims hold against the code, and the one refutation path (an in-place rename affordance that data-orig could anchor) does not exist for bunk chips. (1) Bunk chips carry NO data-orig. Grep confirms data-orig appears ONLY at campistry_me.js:1120 on the grade-name input (.dmGradeN). _renderBunkChipsHTML (L1109) and the dynamic addBunk (


### LOW

#### CB-95 [CONFIRMED / LIVE] scheduler_core_auto.js:20954  _(rotation)_
**Phase 4.9 special-recapture reads per-bunk slot geometry from the clobbered window.divisionTimes table instead of the durable window._perBunkSlots — prep-room placement silently disabled on 2nd+ in-session gen**

- Evidence: L20954: `const _p49pbs = window.divisionTimes?.[def.grade]?._perBunkSlots?.[String(def.bunk)] || [];` then `_p49GridDur = (i) => { const g = _p49pbs[i]; return (g && g.endMin != null && g.startMin != null) ? (g.endMin - g.startMin) : 0; };` (L20956) feeds `_p49HasPrepRoomBefore` (L20957-20962) which gates prep-special recapture slot choice (L21037-21040). Every OTHER per-bunk-geometry read in this file uses the durable fallback with an explicit F
- Scenario: User generates day A (1st gen of the session — divisionTimes[grade]._perBunkSlots still intact, works). Without reloading, user generates day B (2nd in-session gen): the patched loadCurrentDailyData has reassigned window.divisionTimes so divisionTimes[grade]._perBunkSlots is undefined → _p49pbs=[] → _p49GridDur returns 0 for every index → _p49HasPr
- Verifier: The claim is factually exact. At scheduler_core_auto.js:20954 the Phase 4.9 prep-room geometry read is `const _p49pbs = window.divisionTimes?.[def.grade]?._perBunkSlots?.[String(def.bunk)] || [];` — the ONLY per-bunk geometry read in this file that omits the durable `window._perBunkSlots` fallback. Every sibling read uses the FN-14 pattern `window.

#### CB-96 [CONFIRMED] scheduler_core_utils.js:2759  _(rotation)_
**Dead-but-wired rotation counters incrementHistoricalCounts / reIncrementHistoricalCounts (no live caller; divergent count rule vs the live authority)**

- Evidence: `Utils.incrementHistoricalCounts` (L2759) and `Utils.reIncrementHistoricalCounts` (L2810) are exported as both `window.incrementHistoricalCounts`/`window.reIncrementHistoricalCounts` (L2878-2879) and `Utils.*`, so they look load-bearing. A repo-wide grep for non-test, non-comment callers returns NOTHING — every live generation/edit path instead calls `rebuildHistoricalCounts` (the full re-scan): scheduler_core_auto.js L25180-25181, scheduler_core
- Scenario: No live impact today (functions are unreachable in production). The risk is latent: if any future code re-wires window.incrementHistoricalCounts / reIncrementHistoricalCounts back into a generation or post-edit path (their names strongly imply they are the incremental updaters), league-game sports would be added to historicalCounts via the sport fa
- Verifier: Both halves of the claim hold against the real code. (1) NO LIVE CALLER. A repo-wide grep for incrementHistoricalCounts/reIncrementHistoricalCounts returns only: (a) the definitions + window exports inside scheduler_core_utils.js (L2759, L2810, L2853 internal tail-call, L2878-2879 exports), and (b) tests/post_edit_autogen.test.js. Critically, the

#### CB-97 [CONFIRMED] dashboard.js:1130  _(dates)_
**buildWeekMap derives week start/end via toISOString() on a local-midnight Date, shifting every week boundary one day earlier in all positive-UTC-offset timezones (camp-dates half/transition preview)**

- Evidence: ``` var start = new Date(startDate + 'T00:00:00'); // L1116 — LOCAL midnight ... weeks.push({ week: weekNum, start: weekStart.toISOString().slice(0, 10), // L1130 — UTC conversion end: weekEnd.toISOString().slice(0, 10) // L1131 }); ``` Verified: with TZ=Asia/Kolkata (UTC+5:30), `new Date('2026-05-25T00:00:00').toISOString().slice(0,10)` === '2026-05-24'. Every w.start/w.end in the preview is shifted back one day. These va
- Scenario: An owner in any timezone east of UTC (Europe/Asia/Australia/etc.) opens dashboard camp-dates and sets start 2026-05-25, half1End/half2Start. The 'Week breakdown' preview shows each week as 5/24–5/30 instead of 5/25–5/31 and may tag the transition/half boundary on the adjacent week, misleading their setup. NOT data loss: the persisted campDates (sav
- Verifier: buildWeekMap in dashboard.js parses camp start as local midnight at L1116 but emits week boundaries via toISOString().slice(0,10) at L1130-1131. In positive UTC-offset timezones a local-midnight Date rolls back one day under toISOString. Reproduced with TZ=Asia/Kolkata (set via process.env.TZ before any Date construction; the Bash shell ignored a b

#### CB-98 [CONFIRMED] dashboard.js:1184  _(dates)_
**Camp-dates write functions have no role guard — only the UI is read-only for admin/scheduler**

- Evidence: loadCampDates(true) only disables the inputs and hides #campDatesActions for admin/scheduler (dashboard.js:1102-1108), but the global writers window.saveCampDates (L1184-1214) and window.clearCampDates (L1216-1235) contain NO role/permission check — they upsert camp_state_kv key 'campDates' and call saveGlobalSettings('campDates', ...) for anyone who invokes them. Contrast saveProfile (camp name), which DOES gate the write: `if (isTeamMember) { .
- Scenario: An admin (granted dashboard read-only camp dates by design) opens the console and calls saveCampDates() or clearCampDates() — or a stale UI where the disable didn't apply — and overwrites/clears the owner's half1End/half2Start. The change propagates to cloud (camp_state_kv) and to globalSettings, silently shifting every Per-Half rotation boundary a
- Verifier: Every claim fact checks out against the code. (1) NO WRITE GUARD: window.saveCampDates (dashboard.js:1184) and window.clearCampDates (dashboard.js:1216) contain no role/permission check — both unconditionally upsert camp_state_kv key 'campDates' (L1200-1203 / L1225-1228) and call saveGlobalSettings('campDates', ...) (L1207 / L1229). (2) ENFORCEMENT

#### CB-99 [PLAUSIBLE] division_times_integration.js:234  _(dates)_
**migrateAssignmentsByTime drops multi-period continuation slots when remapping assignments by time — would leave spanned activities truncated to their first slot (currently unwired)**

- Evidence: L234-235: `oldAssignments.forEach((assignment, oldIdx) => { if (!assignment || assignment.continuation) return; ...` then it matches the head slot's time to a new slot and writes only that one entry (L247-253: `if (newSlot.startMin === startMin) { window.scheduleAssignments[bunk][newIdx] = assignment; break; }`). Because continuation entries are skipped entirely, a 2-slot special that occupied old slots [3,4] (4 = `continuation:true`) migrates on
- Scenario: If wired: a manual skeleton edit changes period boundaries, triggering a by-time migration. A bunk had Swim spanning slots 3-4 (slot 4 continuation). After migration only slot 3 (Swim head) is carried to the new index; the new slot 4 is null → the grid shows Swim for half its real duration and the pool field reads as free for the second half, allow
- Verifier: The code matches the claim exactly. In migrateAssignmentsByTime (division_times_integration.js:229), L234-235 skip every continuation entry (`if (!assignment || assignment.continuation) return;`), and L247-253 write only the single head entry into the new array (`window.scheduleAssignments[bunk][newIdx] = assignment; break;`). There is NO second wr

#### CB-100 [CONFIRMED] print_center.js:937  _(display)_
**deleteTemplate lacks the canEditTemplates() gate its sibling mutators have, and returns true even when the persist silently no-ops for non-owner/admin**

- Evidence: `function deleteTemplate(tid) { _savedTemplates = _savedTemplates.filter(function (t) { return t.id !== tid; }); saveTemplates(); return true; }` (L937). The three sibling mutators all gate first: saveTemplates (L911 `if (!canEditTemplates()) return false;`), saveCurrentAsTemplate (L921 same), updateTemplate (L929 same). deleteTemplate has no guard — it mutates the in-memory _savedTemplates, then calls saveTemplates() which DOES no-op the persist
- Scenario: A scheduler opens Print Center, deletes a saved print template → it disappears from the dropdown and the call returns true → they assume it's gone. saveTemplates() silently skipped the cloud/local write (role gate), so on the next page load loadTemplates() re-reads the still-present printTemplates and the 'deleted' template is back.
- Verifier: The code matches the claim exactly. At print_center.js:937 `deleteTemplate(tid)` mutates `_savedTemplates = _savedTemplates.filter(...)` for ALL callers (no role check), then calls `saveTemplates()` and unconditionally `return true`. The three sibling mutators DO gate first: `saveTemplates` (L911 `if (!canEditTemplates()) return false;`), `saveCurr

#### CB-101 [CONFIRMED] print_center.js:5043  _(display)_
**campistry_pc3_pack preference is written but never read back on load — selected print pack silently does not persist across reloads**

- Evidence: On applying a pack the code persists it: L5004 `_activePack = pack.id;` then L5043 `try { localStorage.setItem('campistry_pc3_pack', packId); } catch (e) {}`. But `_activePack` is initialized to null (L93 `var _activePack = null;`) and the startup restore block (L4783-4806) reads back every other pc3_* pref — timeIncrement, activityAligned, hideDurations, hideLocations, highlightGaps, colorByCategory, quickFilter, pageBreakPerBunk, sidebarCollaps
- Scenario: User selects a print pack (e.g. 'weekly') in Print Center; it is written to campistry_pc3_pack. They reload the page → _activePack stays null, the pack UI shows none active, and the previously-chosen pack must be re-selected. The persisted key is never consulted.
- Verifier: The claim holds under full code inspection. In print_center.js, `_activePack` is initialized to null (L93 `var _activePack = null;`), assigned only on user apply (L5004 `_activePack = pack.id;` inside `window._pc3ApplyPack`), and read only at L1347 (`var active = _activePack === p.id;`) to mark the active pack card in the Packs popover. The apply p

#### CB-102 [CONFIRMED] period_editor.js:49  _(config)_
**Grade-keyed `campPeriods` config (read by the auto solver and outputs) is not migrated on a grade rename — renamed grade loses its custom period config, old key orphaned**

- Evidence: campPeriods is keyed by division/grade name: `getPeriodsForDiv(divName){ return window.campPeriods[divName] || [] }` (period_editor.js:69-71), `setPeriodsForDiv` writes `window.campPeriods[divName]=periods` (73-74), persisted whole via `saveGlobalSettings('campPeriods', window.campPeriods)` (62). campPeriods is consumed by scheduler_core_auto.js, day_packer.js, master_schedule_builder.js, daily_adjustments.js, print_center.js (grep). The Me-page
- Scenario: Owner sets custom periods for grade 'Trios' in the Period Editor, then renames 'Trios' to 'Trios B' in Camp Structure. campPeriods['Trios'] stays under the old key; campPeriods['Trios B'] does not exist, so getPeriodsForDiv('Trios B') returns [] and the renamed grade falls back to default periods. The stale 'Trios' entry persists in cloud config in
- Verifier: The claim is accurate and describes a real gap not covered by the existing FN-1 fix. (1) campPeriods is grade/division-name-keyed: getPeriodsForDiv(divName) returns window.campPeriods[divName] (period_editor.js:69-71), persisted via saveGlobalSettings('campPeriods', ...) at L62. (2) It is load-bearing for the auto solver, which reads window.campPer

#### CB-103 [CONFIRMED] division_selector.js:52  _(config)_
**division_selector.js + rbac_integration.js are dead code — a fully wired generation-scope-picker module (window.DivisionSelector) that no HTML loads**

- Evidence: division_selector.js defines `window.DivisionSelector` with renderDivisionSelector (L52) and appends a modal/styles to the DOM (L143/L517), looking fully load-bearing. Its ONLY caller is rbac_integration.js (L140 `window.DivisionSelector.renderDivisionSelector(...)`, plus initialize/saveLocks). But repo-wide grep shows NO .html loads `division_selector.js` OR `rbac_integration.js`, rbac_init.js (the one flow.html DOES load) never references Divis
- Scenario: A future change wires `window.DivisionSelector` into a page (or someone copies the renderDivisionSelector pattern) and inherits the unescaped division/subdivision-name interpolation; meanwhile the module sits in the bundle as confusing dead weight that appears active because it self-registers on window and is referenced by rbac_integration.js.
- Verifier: Every part of the claim checks out against the actual code. (1) division_selector.js self-registers window.DivisionSelector (L524-535) with renderDivisionSelector (L52) building a modal via modal.innerHTML (L63-143); its only caller is rbac_integration.js (calls .initialize L38, .renderDivisionSelector L140, .saveLocks L260). (2) Repo-wide grep for

#### CB-104 [CONFIRMED] calendar.js:523  _(rotation)_
**Scheduler-scoped 'Start New Half' and 'Erase rotation history' do not clear manualUsageOffsets — phantom counts survive into the new half**

- Evidence: getActivityCount = historicalCounts + manualUsageOffsets (scheduler_core_utils.js:2270-2293; rotation_engine.js:536-561), and manualUsageOffsets is bunk-keyed `{ bunk: { activity: number } }`, set per-bunk by the rotation report's adjust input (analytics.js:1599-1603). The OWNER reset paths clear it: clearCloudKeys([... 'manualUsageOffsets' ...]) at calendar.js:419 (eraseRotationHistory) and 608 / saveGlobalSettings('manualUsageOffsets', {}) at 6
- Scenario: An admin uses the rotation report's 'Adjust counts' field to set Trios 3's 'Baking' offset to +3 (e.g. to seed prior-season usage). Later a scheduler assigned to Trios runs 'Start New Half' (or 'Erase rotation history') for their divisions. historicalCounts/rotationHistory for Trios 3 are wiped to 0, but the +3 Baking offset survives. The new half
- Verifier: Every link in the claim checks out against the actual code, with a concrete trigger and decisive quoted lines. (1) Consumption: getActivityCount returns historicalCounts[bunk][act] + manualUsageOffsets[bunk][act], bunk-keyed (scheduler_core_utils.js:2270-2293; rotation_engine.js:536-561 delegates to it). (2) Write: the rotation report's adjust inp

#### CB-105 [CONFIRMED] campistry_me.js:1262  _(dates)_
**Grade rename/removal cascade cleans skeletons + auto-layers + bunks but never touches campPeriods (Bell Schedule) → orphaned/lost per-grade periods**

- Evidence: The structure-change cascade in campistry_me.js handles every per-grade config EXCEPT campPeriods. On removal: `_purgeOrphanedSkeletonTiles(removedGrades); _purgeOrphanedAutoLayers(removedGrades);` (lines 1262, 1275) plus `_purgeOrphanedBunks`. On rename: `_propagateGradeRenameTiles(oldG,newG)` (line 1243) renames dailySkeletons + dailyAutoLayers + gradeLayerRules. None of these read or write `gs.campPeriods`, which period_editor.js stores per gr
- Scenario: Owner renames grade 'Minors' to 'Minors A' in the division-edit modal. The Bell Schedule periods configured for 'Minors' stay under key 'Minors' in campPeriods; the Period Editor now shows 'Minors A' with no periods, and any scheduler logic that reads period boundaries for 'Minors A' gets none — the user must reconfigure, and the orphaned 'Minors'
- Verifier: The claim is accurate in every load-bearing detail. STORAGE/KEYING (confirmed): period_editor.js stores the Bell Schedule as window.campPeriods[<grade>] and persists via saveGlobalSettings('campPeriods', …). loadAll() reads gs.campPeriods (L54); save via saveGlobalSettings?.('campPeriods', …) (L62); per-grade keys at L70/74/79/86/92 (getPeriodsFor

#### CB-106 [PLAUSIBLE] analytics.js:198  _(display)_
**Field Availability Gantt resolves missing block times from division-level divisionTimes by raw index instead of the bunk's _perBunkSlots, mis-timing auto-mode entries that lack inline _startMin/_endMin**

- Evidence: buildUsageData (L195-237): `const times = dTimes[divName] || [];` (L198) is the DIVISION-level slot array (dTimes = window.divisionTimes or the day snapshot, L190-192) — it never dereferences `._perBunkSlots[bunk]`. When an entry lacks inline times, the fallback reads by raw slot index: L206-216 `if (startMin===undefined||endMin===undefined){ const slotInfo = times[idx]; ... startMin=slotInfo.startMin; endMin=slotInfo.endMin; }`, and the continua
- Scenario: Auto mode, a bunk whose _perBunkSlots has an injected leading slot so per-bunk index 3 ≠ division index 3. A block that lacks _startMin/_endMin (e.g. a legacy/edited entry) falls to L207 times[idx]=divisionTimes[div][3] and is painted at the division slot-3 window in the Field Availability Gantt, overlapping or mis-ordering against bunks rendered f
- Verifier: The mechanism is real and correctly described, but the trigger is narrow and data-dependent, so it cannot be confirmed from code alone. STRUCTURAL PREMISE — TRUE: in analytics.js buildUsageData, `const times = dTimes[divName] || [];` (L198) is the flat DIVISION-level slot array (dTimes = window.divisionTimes or the day snapshot, L190-192). Per-bunk


---

## Phase 3 — access control/RBAC, Campistry GO (transport), shell/security/playoffs/mobile/misc (39 findings: 1 HIGH / 21 MED / 17 LOW)

Run wf_c8a6f9ad-8ed. 65 agents.


### HIGH

#### CB-107 [CONFIRMED / LIVE] campistry_go.js:2348  _(go)_
**clearAllMonitors / clearAllCounselors wipe the ENTIRE cloud 'state' row (buses, shifts, setup, the other staff list) to {}**

- Evidence: clearAllMonitors (L2340-2352): `D.monitors = []; save(); _clearCloudDataType('state'); ...` and clearAllCounselors (L2354-2366) do the same with `_clearCloudDataType('state')` at L2362. `_clearCloudDataType` (L2315-2318) does `window.GoCloudSync.save(dataType, {})`, i.e. upserts an EMPTY object into the `(camp_id,'state')` row. But `save()` (L1148) builds `stateSnap` = { setup, buses, shifts, monitors, counselors, dismissal, arrival } and uncondi
- Scenario: User has buses + shifts + monitors + counselors saved. They click 'Clear all monitors' (intending to remove only monitors). save() pushes full state with monitors=[]; then _clearCloudDataType('state') overwrites the cloud state row with {}. Locally everything still looks fine (localStorage retains D minus monitors), so nothing seems wrong. Later th
- Verifier: The claim is accurate. clearAllMonitors (campistry_go.js L2340-2352) and clearAllCounselors (L2354-2366) both call save() then _clearCloudDataType('state') in that order. save() (L1148) builds stateSnap = {setup, activeMode, buses, shifts, monitors, counselors, dismissal, arrival} and upserts it to the ('state') row at L1221 via window.GoCloudSync.


### MED

#### CB-108 [CONFIRMED / LIVE] dashboard.js:312  _(rbac)_
**Scheduler division scope read from stale denormalized camp_users.assigned_divisions snapshot, never re-resolved from live subdivisions table**

- Evidence: dashboard.js cacheRBACContext writes `assignedDivisions: membership?.assigned_divisions || []` (L312) and `subdivisionIds: membership?.subdivision_ids || []` (L311) straight from the camp_users row read at L183-196 — it never re-resolves the subdivision's current `divisions` from the `subdivisions` table. `camp_users.assigned_divisions` is a DENORMALIZED snapshot: it is written only at invite (access_control.js L1973), when an owner edits a membe
- Scenario: Scheduler S is assigned to subdivision 'Juniors' which contains division 'Majors'. S visits dashboard (cache written with assignedDivisions:['Majors']). Owner edits the 'Juniors' subdivision to REMOVE 'Majors'. The owner does NOT touch S's camp_users row, so assigned_divisions stays ['Majors']. S opens Flow (sessionStorage cache hit, or a fresh loa
- Verifier: The claim is correct. Scenario: scheduler S in subdivision 'Juniors' (which contains 'Majors'); a prior dashboard visit cached assignedDivisions:['Majors'], subdivisionIds:['Juniors-uuid'] (dashboard.js cacheRBACContext L311-312 copies the denormalized camp_users row verbatim). Owner removes 'Majors' from the 'Juniors' subdivision via updateSubdivi

#### CB-109 [CONFIRMED / LIVE] subdivision_schedule_manager.js:83  _(rbac)_
**Cross-scheduler lock/draft state loads from local campDailyData_v1 only (never fresher cloud daily_schedules), but writes fan out to cloud — stale-local-wins**

- Evidence: loadSubdivisionSchedules (L83-87) reads ONLY local: `const dailyData = window.loadCurrentDailyData?.() || {}; ... _subdivisionSchedules = dateData.subdivisionSchedules || {}`. There is no cloud fetch on this load path. The write path, however, pushes to cloud: saveSubdivisionSchedules (L125-143) writes localStorage `campDailyData_v1` then scheduleCloudSync (L146-164) calls `window.saveGlobalSettings('daily_schedules', dailyData)`. So scheduler A'
- Scenario: Scheduler A locks subdivision 'Seniors' (writes status:locked + fieldUsageClaims to cloud via saveGlobalSettings('daily_schedules')). Scheduler B (different machine) loads the same date; their SubdivisionScheduleManager.loadSubdivisionSchedules reads B's local campDailyData_v1, which has no record of A's lock → _subdivisionSchedules['Seniors'].stat
- Verifier: The claim's core thesis holds: SubdivisionScheduleManager lock/draft/fieldUsageClaims state never round-trips through the cloud, so scheduler B's gate operates on a stale local view and double-books fields scheduler A reserved. Verified end-to-end: LOAD is local-only. loadSubdivisionSchedules (subdivision_schedule_manager.js:83-87) reads ONLY `win

#### CB-110 [PLAUSIBLE / LIVE] access_control.js:1046  _(rbac)_
**canManageSubdivisions() returns true for SCHEDULER — scheduler can create/rewrite subdivisions (the division-assignment mechanism) with no client owner-gate**

- Evidence: canManageSubdivisions() (L1044-1049): `if (_currentRole === ROLES.OWNER || ROLES.ADMIN || ROLES.SCHEDULER) return true;`. createSubdivision (L1824-1827) and updateSubdivision (L1857-1859) gate ONLY on canManageSubdivisions() before doing `supabase.from('subdivisions').insert(...)` / `.update(...)`. By contrast deleteSubdivision (L1883-1886) correctly checks `if (_currentRole !== ROLES.OWNER) return {error:'Only owner can delete subdivisions'}`. S
- Scenario: Scheduler (role='scheduler') opens devtools/console and calls `window.AccessControl.updateSubdivision('<some-sub-id>', { divisions: ['DivisionTheyWant'] })` (or createSubdivision). The client check passes (canManageSubdivisions true for scheduler). Whether the write lands depends ENTIRELY on RLS on the `subdivisions` table — the only client guard i
- Verifier: The client-side authorization asymmetry the claim describes is REAL in the actual code. canManageSubdivisions() returns true for SCHEDULER (access_control.js L1044-1049: `if (_currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN || _currentRole === ROLES.SCHEDULER) return true;`). createSubdivision (L1824-1827) and updateSubdivision (L1857-1

#### CB-111 [CONFIRMED] integration_hooks.js:695  _(rbac)_
**Scheduler is granted full UI edit of camp config (facilities/specials/setup) by v3.13, but the cloud write is silently dropped — config edits vanish, no error shown**

- Evidence: v3.13 made canEditFields()/canEditSetup() (access_control.js L1116, L1122) and checkSetupAccess() return true for SCHEDULER. So scheduler-reachable config writers run: facilities.js:305 `if (!AccessControl.canEditSetup())` (passes), facilities.js:450 checkSetupAccess('add facilities') (passes), special_activities.js:662 checkSetupAccess('delete special activities') (passes). Each then mutates local state and calls window.saveGlobalSettings(...).
- Scenario: Scheduler edits a facility's sharing rule or adds/deletes a special activity in the Flow setup tab (UI lets them — buttons enabled, no permission toast). Local save succeeds, the change appears to take. It never propagates to cloud, so it is invisible on any other device and is silently overwritten the next time the owner's client syncs camp_state.
- Verifier: Every link in the chain is real code, and the affected surface (facility / special-activity / setup CONFIG writes) is NOT covered by the existing LG-2 exclusion (which is scoped to league saves) nor by the two other documented instances (rotation-event completions L500, scoped-delete error L552). The claim itself correctly distinguishes from LG-2.

#### CB-112 [CONFIRMED / LIVE] supabase_schedules.js:389  _(rbac)_
**filterScheduleToMyBunks fail-opens to the FULL camp schedule when a scheduler's editable-bunk set resolves empty — defeats MS-2 save scoping and shadows the owner; the empty-save guard can't catch it**

- Evidence: filterScheduleToMyBunks (the live save filter — saveSchedule calls it at L925 when options.skipFilter is falsy, and the primary post-gen path verifiedScheduleSave→ScheduleDB.saveSchedule(dateKey,data) at integration_hooks.js:1030 passes NO options): `const myBunks = new Set(getMyEditableBunks()); if (myBunks.size === 0) { logError('WARNING: No editable bunks found!...'); /* Return original to avoid saving empty - let RLS handle it */ return sched
- Scenario: A scheduler (assigned only a subset of divisions) opens flow.html and clicks Generate (or any save fires) before window.divisions has hydrated, or right after a divisions-clobber/realtime reassignment leaves window.divisions transiently empty. getMyEditableBunks() → [] → filterScheduleToMyBunks returns the full merged scheduleAssignments (all divis
- Verifier: The fail-open is real and the cited guards provably do not cover it. (1) THE FAIL-OPEN EXISTS AS CLAIMED. supabase_schedules.js filterScheduleToMyBunks L384-390: when getMyEditableBunks() returns an empty set it returns the UNFILTERED full scheduleAssignments ("Return original to avoid saving empty - let RLS handle it"). This is the live save filt

#### CB-113 [CONFIRMED / LIVE] campistry_go.js:1224  _(go)_
**Deleting your last camper address and reloading resurrects it from the cloud (delete never propagates when the address map becomes empty)**

- Evidence: deleteAddress (L2300), _quickDeleteAddress (L2306) and saveAddress's empty-street branch (L2270) all do `delete D.addresses[...]; save();` with NO _clearCloudDataType('addresses'). But save() only pushes addresses to cloud when non-empty: L1224 `if (D.addresses && Object.keys(D.addresses).length > 0) { window.GoCloudSync.save('addresses', D.addresses); }`. So when the map drops to {} the cloud 'addresses' row is left holding the OLD set. On the n
- Scenario: Camp has 1 camper address (or the user deletes addresses one by one until none remain). They delete the last one (Delete button → confirm). D.addresses = {}; save() skips the cloud write; cloud still has the address. Reload the page → loadGoCloudData sees cloudCount(1) > localCount(0) → restores the deleted address. The deletion silently fails to p
- Verifier: All three legs of the claim hold in the actual code (campistry_go.js). 1) The three delete paths delete from D.addresses and call save() with NO cloud clear: - deleteAddress L2300-2301: `delete D.addresses[_editCamper]; save();` - _quickDeleteAddress L2306-2307: `delete D.addresses[name]; save();` - saveAddress empty-street branch L2270: `if (!st)

#### CB-114 [CONFIRMED / LIVE] campistry_go.js:1058  _(go)_
**loadGoCloudData restores fleet/state only when the local field is empty — a fresher cloud config never replaces a stale-but-nonempty local one**

- Evidence: State hydration is gated purely on local emptiness, never recency: `if (!D.buses?.length && s.buses?.length) { D.buses = s.buses; ... }` (L1058-1062); identical pattern for shifts (L1063), monitors (L1067), counselors (L1071), dismissal (`s.dismissal && (!D.dismissal || !D.dismissal.buses?.length)` L1077), arrival (L1081), and setup is gated on `!D.setup.campName` (L1051). The cloud 'state' row carries updated_at but it is discarded by loadAll();
- Scenario: Device A edits the bus fleet (adds/removes buses, changes shift times) and cloud 'state' updates. Device B has an older, non-empty D.buses cached in STORE. B reloads: load() restores B's stale buses from localStorage (non-empty), so loadGoCloudData's `!D.buses?.length` guard is false and A's newer fleet is never pulled in. B keeps and re-saves the
- Verifier: The defect is real and reachable. Ordering: the `campistry-cloud-hydrated` handler (campistry_go.js L7567-7576) calls `load()` FIRST, then `loadGoCloudData()`. `load()` populates module-level `D` from the localStorage STORE cache via `else if (local) { D = merge(local); }` (L933-935), and `merge()` (L1142) carries `buses/shifts/monitors/counselors`

#### CB-115 [CONFIRMED / LIVE] campistry_go.js:7876  _(go)_
**Route-flag cache is loaded once and never invalidated; every flag mutation writes the whole route_flags row, clobbering concurrent flag edits from another device**

- Evidence: `async function _ensureFlags(){ if (_flagCache) return _flagCache; _flagCache = await window.GoFlagPersistence.load(); return _flagCache; }` (L7876-7880) — once `_flagCache` is set it is returned forever; a repo grep shows `_flagCache =` is assigned ONLY here (plus the `null` init L7874), never reset on realtime/focus. Every mutation (flagStop/unflagStop/flagRoute/unflagRoute/approveRoute/setAnchor…, L7891-7987) ends in `_persistFlags()` → `GoFla
- Scenario: Dispatcher A (device A) flags Stop X for review; cloud route_flags row now has X. Dispatcher B opened the dashboard earlier so B's `_flagCache` was loaded before X existed and is never refreshed. B flags Route Y → _persistFlags writes B's whole stale cache (Y present, X absent) over the cloud row → A's flag on X is silently erased. Whoever clicks l
- Verifier: All three legs of the claim hold against the actual code. (1) Cache loaded once, never invalidated. `_ensureFlags` (campistry_go.js L7876-7880) calls `GoFlagPersistence.load()` only when `_flagCache` is falsy and returns the cached object forever after. A full-file grep confirms `_flagCache` is assigned ONLY at the `null` init (L7874) and that one

#### CB-116 [CONFIRMED / LIVE] campistry_go.js:1184  _(go)_
**Campistry GO has zero role enforcement and no per-user row scoping — any camp member (incl. schedule-only 'scheduler' role) blindly overwrites the entire shared transportation dataset, and a stale tab silently stomps a concurrent editor's work**

- Evidence: save() unconditionally upserts the whole camp's data: `window.GoCloudSync.save('state', stateSnap)` (L1221), `save('addresses', D.addresses)` (L1225), `save('routes', routePayload)` (L1234). GoCloudSync.save (campistry_go_cloud.js L83-91) does `client.from('go_standalone_data').upsert({camp_id, data_type, data}, {onConflict:'camp_id,data_type'})` — PK is (camp_id,data_type) with NO scheduler_id/owner dimension (unlike daily_schedules which keys o
- Scenario: Two camp staff (e.g. an owner and a scheduler, or two admins) have Campistry GO open. Owner adds Bus 7 + 3 shifts and they save to the 'state' row. The scheduler's tab (opened earlier, stale D) edits one monitor's phone and clicks anything that triggers save() → their save('state', stateSnap) overwrites the whole row with their stale snapshot, sile
- Verifier: All parts of the claim are borne out by the actual code, and the defect is not covered by either findings doc (WALKTHROUGH_AUDIT_FINDINGS.md has zero campistry_go matches; LEAGUE_AUDIT_FINDINGS.md is leagues-only). (1) NO ROLE ENFORCEMENT: grep of campistry_go.js for AccessControl|getRole|checkEditAccess|canEdit|isScheduler|assigned_divisions = No

#### CB-117 [PLAUSIBLE] campistry_go.js:7492  _(go)_
**moveCamperToBus drops camper entirely when destination bus not found (half-mutation on early return)**

- Evidence: Line 7490 mutates the source route FIRST: `camperData = st.campers.splice(ci, 1)[0]` then recomputes `fromRoute.camperCount` and filters empty stops. THEN line 7492: `const toRoute = sr.routes.find(r => r.busId === toBusId); if (!toRoute) { toast('Bus not found', 'error'); return; }`. At this point the camper has already been removed from the source bus and is NOT re-added anywhere — there is no restore/rollback. The function returns having perma
- Scenario: User opens the move-camper modal, then (in another tab / via realtime) the destination bus is removed or its busId changes; user confirms the move -> find(busId===toBusId) returns undefined -> camper is spliced out of the source bus and never re-added -> camper vanishes from the route (and from the saved cloud 'routes' payload on next save). Same o
- Verifier: The half-mutation mechanism is real and matches the code exactly. In moveCamperToBus (campistry_go.js:7485), sr = D.savedRoutes[shiftIdx] is a live reference (line 7487). Line 7490 splices the camper out of the source route FIRST (camperData = st.campers.splice(ci,1)[0]), filters empty stops, and recomputes camperCount — mutating D.savedRoutes in p

#### CB-118 [PLAUSIBLE] campistry_go.js:6137  _(go)_
**reOptimizeBus never sets _matrixIdx, so road-distance matrix is silently ignored for ETA — times fall back to haversine**

- Evidence: reOptimizeBus fetches a real road matrix at L6077 (`matrix = await fetchDistanceMatrix(...)`). The ETA helpers read it via a per-stop index: L6137 `driveMin(a,b){ if (matrix && a._matrixIdx != null && b._matrixIdx != null) { const v = matrix[a._matrixIdx]?.[b._matrixIdx]; ... } if (a.lat && b.lat) return drivingDist(...)/60; ...}` and L6138 `campToStopMin(s){ if (matrix && s._matrixIdx != null) { ... matrix[0]?.[s._matrixIdx] ... } ...}`. But `_m
- Scenario: User clicks 'Re-optimize' on a single bus. The stop order is recomputed correctly, but every stop's displayed estimatedTime/estimatedMin (and route.totalDuration) is computed from haversine distance, not the road matrix that was just fetched — so the printed/displayed arrival times for that bus are wrong (typically too optimistic on winding/road-co
- Verifier: The code-level core of the claim is CONFIRMED by exhaustive grep: `_matrixIdx` appears exactly 3 times in the whole repo — read at L6137 (driveMin), read at L6138 (campToStopMin), deleted at L6155 — and is NEVER assigned (no `._matrixIdx =` anywhere). So in reOptimizeBus the guards `a._matrixIdx != null` / `s._matrixIdx != null` are always false, a

#### CB-119 [CONFIRMED / LIVE] campistry_go.js:6155  _(go)_
**moveCamperToBus / reOptimizeBus mutate stop order but never evict _routeGeomCache, so the map draws the old polyline over the new stops**

- Evidence: _routeGeomCache is keyed by `busId + '_' + shiftIdx` (L7180 cacheKey, populated L3737-3747 from r._roadPts) and the map render reads it FIRST: L7181-7184 `let roadCoords = _routeGeomCache[cacheKey]; if (roadCoords) { L.polyline(roadCoords...) }`. The cache is only cleared on switchMode (L1258) and full regen (L3713). reOptimizeBus reorders `route.stops` (L6127) and even does `delete route._roadPts` (L6155) but does NOT delete `_routeGeomCache[bus
- Scenario: User re-optimizes a bus or moves a camper to a different bus, then views the map: the stop markers update to the new sequence/positions but the route line still traces the OLD road geometry from the stale `_routeGeomCache` entry, so the drawn path visibly disagrees with the stop order until a full regenerate or mode switch clears the cache.
- Verifier: The mechanism is real and confirmed by reading the actual code. Render path reads the cache FIRST: campistry_go.js L7180-7185 `const cacheKey = route.busId + '_' + route.shiftIdx; let roadCoords = _routeGeomCache[cacheKey]; if (roadCoords) { L.polyline(roadCoords, ...).addTo(_map); }`. The cached value is a flat road-polyline array (set at L3739 `_

#### CB-120 [CONFIRMED / LIVE] campistry_go.js:7197  _(go)_
**Camper names injected raw into Leaflet stop-marker popup (stored XSS) — sibling lines escape the same value**

- Evidence: Line 7197 in renderMap(): `const names = stop.isMonitor ? '🛡️ ' + (stop.monitorName || 'Monitor') : stop.isCounselor ? '🎒 ' + (stop.counselorName || 'Counselor') : stop.campers.map(c => c.name).join('<br>');` — camper names are concatenated with NO escaper. `names` is then embedded at line 7199 `'<div style="font-size:12px;">' + names + '</div>'` and rendered via `marker.bindPopup(popup)` at line 7201 (Leaflet treats the string as raw HTML). Th
- Scenario: A camper is named e.g. `<img src=x onerror=alert(document.cookie)>` (or any league/staff member with an HTML-bearing name). Routes are generated and the Routes-tab map is opened (renderMap runs). Clicking that camper's stop marker opens the popup, whose innerHTML now contains the raw `<img onerror>` → script executes in the camp's session. Counselo
- Verifier: The claim is accurate in every load-bearing detail, verified against the actual code in campistry_go.js. SINK (line 7197, inside renderMap): `const names = stop.isMonitor ? '🛡️ ' + (stop.monitorName || 'Monitor') : stop.isCounselor ? '🎒 ' + (stop.counselorName || 'Counselor') : stop.campers.map(c => c.name).join('<br>');` — camper names are conc

#### CB-121 [CONFIRMED] mobile_touch_drag.js:866  _(misc)_
**Touch reposition of a league tile across grades corrupts the league reference and loses the source-grade tile (diverges from both desktop drop handlers)**

- Evidence: In finishTouchReposition (mobile_touch_drag.js L858-892) the moved skeleton event is mutated IN PLACE for BOTH same-grade and cross-grade drops: ```js event.division = divName; event.startTime = minutesToTime(cellStartMin + snapMin); event.endTime = minutesToTime(cellStartMin + snapMin + duration); ``` It then calls (DA branch) bumpOverlappingTiles / saveDailySkeleton, or (MS branch) saveDraftToLocalStorage — but it NEVER calls window._mbRemapL
- Scenario: On a tablet/phone, in Daily Adjustments (or Master Scheduler), long-press a League Game tile in division 'Majors' and drag it onto division 'Minors'. Result: the tile is REMOVED from Majors (desktop would keep it) and the now-in-Minors tile still has leagueName pointing at the Majors league. On generation, Minors bunks are scheduled against a leagu
- Verifier: The touch reposition handler diverges from both desktop drop handlers on a cross-grade drop, and the divergence is exactly as claimed. (1) `event` is a LIVE reference into the skeleton array. findSkeletonEvent (mobile_touch_drag.js L925-951) returns `dailySkeleton.find(...)` / `dailyOverrideSkeleton.find(...)` — the actual stored object, not a cop

#### CB-122 [PLAUSIBLE / LIVE] playoff_hub.js:64  _(misc)_
**Playoff Hub save persists bracket only to cloud+IDB+_localCache, never to the `campistryGlobalSettings` localStorage mirror leagues.js reads first on cold load — bracket lost if a league save/gen fires before hydration**

- Evidence: playoff_hub.js _save() (the ONLY persistence path for every bracket mutation — enable, generate R1, advance, pick winner, seeds, clear) writes solely through saveGlobalSettings: L57-65 regular: `var lbn = window.leaguesByName || {}; var liveR = _league && lbn[_league.name]; if (liveR && _league.playoff) { liveR.playoff = _league.playoff; _league = liveR; } ... window.saveGlobalSettings('leaguesByName', lbn);` L37-55 specialty: same via `saveG
- Scenario: User opens Leagues > a league's 'Playoff Mode' (PlayoffHub.open), builds a bracket, picks winners. Every click's _save writes the bracket to cloud+IDB but NOT to `campistryGlobalSettings`. Later the page is reloaded (or opened on a 2nd device). On script-run, leagues.js loadLeaguesData() (L2863) runs BEFORE cloud hydration: fromGlobal (=_localCache
- Verifier: Every code link in the chain is verified real, and not in EXCLUSIONS or LEAGUE_AUDIT_FINDINGS.md (LG-1..54 never mention playoff_hub/PlayoffHub). (1) PERSISTENCE PATH IS HUB-ONLY AND BYPASSES THE MIRROR. playoff_hub.js _save() (L31-67) is the sole save path — all ~24 bracket mutations (enable L124, generate/advance L269/314/325, seeds L509, clear,

#### CB-123 [CONFIRMED / LIVE] playoff_hub.js:832  _(misc)_
**Playoff Hub has NO role gating — a viewer/read-only user gets a fully interactive bracket editor whose mutations write to the local settings mirror (every sibling league control is role-gated)**

- Evidence: PlayoffHub.open(league, kind) (playoff_hub.js:832-858) takes NO readOnly/role parameter and unconditionally renders fully-enabled controls: enable toggle (enableCb.onchange L121), bracket-style pills (L183), seed add/remove/reorder (L412/418/424/459/471), 'Generate Round 1' (genBtn.onclick L259), pick-winner (renderTeam btn.onclick L728), 'Generate Round N' (advBtn.onclick L319), and 'Clear bracket & start over' (clearBtn.onclick L348). Every one
- Scenario: A viewer-role user (read-only) opens Leagues, clicks 'Playoff Mode' on any league -> the Hub overlay opens fully interactive. They toggle Playoff on, generate Round 1, and reserve activities. _save() fires on each action and writes the entire leaguesByName/specialtyLeagues object to the local settings mirror with no 'changes not saved' warning (unl
- Verifier: Every link in the claim holds against the actual code, and the readOnly-aware path is provably dead. (1) The LIVE path passes NO role/readOnly flag: leagues.js:933-939 `playoffBtn.onclick = function () { ... window.PlayoffHub.open(league, 'regular'); }` and specialty_leagues.js:926-928 `window.PlayoffHub.open(league, 'specialty');`. PlayoffHub.ope

#### CB-124 [CONFIRMED] mobile_touch_drag.js:682  _(misc)_
**Mobile touch-RESIZE of a Daily-Adjustments tile never reconciles overlaps — recreates the exact silent-overlap bug the desktop resize path was explicitly patched to prevent**

- Evidence: finishTouchResize() (mobile_touch_drag.js:682-749) computes new start/end, writes them onto the skeleton event, then only calls `saveDailySkeleton()` + `renderGrid()` — it NEVER calls bumpOverlappingTiles. Compare the DESKTOP DA resize, which was patched for precisely this: daily_adjustments.js onMouseUp L2806-2811 `// ★ Day 25 fix (#1): reconcile overlaps after a resize... Resize previously wrote the new times without bumping neighbors, leaving
- Scenario: On a phone/tablet, a user drags a DA skeleton tile's bottom resize handle down so it now overlaps the next tile (e.g. extend 'Activity' 10:00–10:45 down to 11:15 while 'Swim' sits at 11:00–11:45). finishTouchResize writes startTime/endTime and saves, but bumpOverlappingTiles is never run, so dailyOverrideSkeleton now holds two tiles whose [start,en
- Verifier: The mobile touch-resize path for Daily-Adjustments tiles writes new start/end times onto the live skeleton event but never reconciles overlaps, recreating exactly the silent-overlap defect the desktop resize path was explicitly patched to prevent. (1) Desktop resize was patched for this precise bug. daily_adjustments.js onMouseUp L2806-2811 has th

#### CB-125 [CONFIRMED / LIVE] access_control.js:540  _(rbac)_
**Remote team-member REMOVAL never revokes a live scheduler's session (subscription only handles UPDATE, not DELETE)**

- Evidence: setupMembershipSubscription (L537-548) subscribes ONLY to `event: 'UPDATE'` on camp_users: `.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'camp_users', filter: user_id=eq.${_currentUser.id} }, (payload)=>{ refresh(); })`. There is no DELETE handler. removeTeamMember (L2035-2083) deletes the row (RPC delete_team_member_full, or fallback `.from('camp_users').delete().eq('id',id)`). Meanwhile verifyBeforeWrite (L325-358) short-
- Scenario: Owner removes a scheduler from the team (Team & Access → remove). The scheduler currently has the app open. No DELETE realtime event is delivered to that session, so refresh() never runs; _currentRole stays 'scheduler' and _roleVerifiedFromDB stays true. The removed user keeps full scheduler write/generate access (canSave/canEditDivision/verifyBefo
- Verifier: The mechanism holds at every link, verified against the real code in access_control.js. 1) setupMembershipSubscription (L537-548) subscribes ONLY to `event: 'UPDATE'` on camp_users filtered by `user_id=eq.${_currentUser.id}`. There is no DELETE handler and no wildcard `event: '*'`. A Postgres row DELETE never produces an UPDATE realtime event, so

#### CB-126 [CONFIRMED] campistry_go.js:8346  _(go)_
**Dispatcher "Pin as anchor" button breaks (silent failure) when a stop address contains an apostrophe**

- Evidence: In renderDispatcherDashboard the pin button is built as: ``` ' onclick="CampistryGo.pinAnchor(' + shiftData.shiftIdx + ',\'' + esc(r.busId) + '\',\'' + esc(da.address) + '\',' + da.kidCount + ',' + 0 + ')">' + ``` `da.address` is an external geocoder-derived stop/street name (e.g. "O'Brien St", "Saint John's Pl"). It is passed through `esc()` only. `esc` (campistry_go.js:99) maps `'`->`&#x27;`. But the value is placed inside a SINGLE-QUOT
- Scenario: A camp with a street whose name contains an apostrophe (very common: "O'Brien St", "St. John's Rd") generates routes; the mega-cluster anchor lands on that street. The dispatcher clicks "Pin as anchor". The JS string is corrupted by the decoded apostrophe -> click throws and nothing is pinned. The toast "Anchor pinned — will take effect on next reg
- Verifier: The defect is real and concretely triggerable. In renderDispatcherDashboard the "Pin as anchor" onclick (campistry_go.js:8344-8347) embeds da.address into a single-quoted JS string literal that lives inside a double-quoted HTML onclick attribute, passing it through esc() ONLY: `' onclick="CampistryGo.pinAnchor(' + shiftData.shiftIdx + ',\'' + esc(r

#### CB-127 [CONFIRMED] campistry_go.js:2332  _(go)_
**clearAllAddresses() wipes the ENTIRE cloud 'state' row (buses/shifts/setup/staff), destroying fleet config that has nothing to do with addresses**

- Evidence: clearAllAddresses() empties D.addresses and routes, then calls: ``` save(); _clearCloudDataType('addresses'); _clearCloudDataType('routes'); _clearCloudDataType('state'); // <-- line 2332 ``` `_clearCloudDataType('state')` (line 2315) does `window.GoCloudSync.save('state', {})`, overwriting the whole go_standalone_data 'state' row with `{}` — which holds setup, buses, shifts, monitors, counselors, and both mode snapshots. The function never cle
- Scenario: User clicks "Clear all addresses" (intending only to wipe camper home addresses, e.g. to re-import a roster). Their buses, shifts, monitors and counselors survive locally (localStorage STORE still has them), so it looks fine. They later open Campistry Go on a second device / after a cache clear: loadGoCloudData reads the 'state' row = {} (s.buses u
- Verifier: The claim is accurate end-to-end against the real code. clearAllAddresses (campistry_go.js:2320-2338) empties ONLY D.addresses / D.savedRoutes / mode savedRoutes / _goStandaloneRoster in memory — it never clears D.buses/D.shifts/D.monitors/D.counselors. It then runs, in order: save() at L2329, _clearCloudDataType('addresses'), _clearCloudDataType('

#### CB-128 [CONFIRMED] scheduler_core_auto.js:25307  _(misc)_
**Clean auto-gen never clears a stale red "unfilled Free slots" banner (event not dispatched on 0 impossibilities)**

- Evidence: The post-gen impossibilities reporter early-returns BEFORE dispatching its event when the schedule is clean: ```js if (_impossibilities.length === 0) { log('\n✅ No unfilled slots — schedule is complete.'); return; // <-- returns WITHOUT dispatching campistry-schedule-impossibilities } ... window.dispatchEvent(new CustomEvent('campistry-schedule-impossibilities', { detail: { count: _impossibilities.length, items: _impossibilities } }));
- Scenario: User generates a day in Auto mode whose layers/fields leave Free holes → red banner '⛔ N unfilled (Free) slots in this schedule' appears. User widens a layer window / adds field capacity and re-generates the SAME day → the new gen has 0 impossibilities, so the event is never fired → the stale red banner keeps showing the OLD Free slots (wrong count
- Verifier: All four load-bearing facts verified against the actual code. (1) The post-gen impossibilities reporter is an IIFE; on a clean schedule it hits `if (_impossibilities.length === 0) { log(...); return; }` (scheduler_core_auto.js:25307-25310) which returns BEFORE `window.dispatchEvent(new CustomEvent('campistry-schedule-impossibilities', ...))` at L25


### LOW

#### CB-129 [PLAUSIBLE] subdivision_schedule_manager.js:64  _(rbac)_
**SubdivisionScheduleManager captures _currentDateKey once at init and never updates it on date change; saveSubdivisionSchedules then writes subdivision schedules to the STALE date key and fans the entire campDailyData_v1 to cloud**

- Evidence: `_currentDateKey` is set a single time in initialize(): L64 `_currentDateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];` and is never reassigned anywhere (grep shows reads only at L86/L89/L129/L133/L904). saveSubdivisionSchedules() keys the write off this stale value and persists the whole multi-date blob to cloud: L129-133 `if (!dailyData[_currentDateKey]) dailyData[_currentDateKey] = {}; dailyData[_currentDateKey].s
- Scenario: If/when the multi-scheduler lock UI is wired: scheduler locks subdivision schedule on the init date (e.g. today), navigates to 06-25, edits/locks again → saveSubdivisionSchedules writes 06-25's subdivisionSchedules under today's key (wrong date) and re-uploads every date's campDailyData_v1 to cloud with NOW timestamps, overwriting other devices' ne
- Verifier: The code matches every load-bearing assertion in the claim. (1) `_currentDateKey` (declared L34 `let _currentDateKey = null;`) is assigned exactly once — L64 in initialize() — and a grep for `_currentDateKey\s*=` returns only those two lines; the module has no date-change listener, re-init, or any other reassignment. So once init runs (via rbac_ini

#### CB-130 [PLAUSIBLE] access_control.js:1745  _(rbac)_
**deleteMyDivisionsOnly resolves 'my' bunks via getEditableDivisions() which (v3.13) returns ALL divisions for a scheduler, so it deletes EVERY bunk (including other schedulers'/owner's divisions) from in-memory scheduleAssignments/leagueAssignments before reload**

- Evidence: deleteMyDivisionsOnly builds the bunk set from getEditableDivisions(): L1745 `const myDivisions = getEditableDivisions();` then L1787-1799 iterates those divisions, collects their bunks, and `bunksToRemove.forEach(bunk => { delete window.scheduleAssignments[bunk]; })` (+ leagueAssignments L1801-1805). But getEditableDivisions() for a SCHEDULER returns ALL current divisions, not the scoped set: L1219-1221 `if (_currentRole === OWNER || ADMIN || SC
- Scenario: A future wiring (or an inline handler) calls AccessControl.deleteMyDivisionsOnly(dateKey) for a scheduler: getEditableDivisions() returns all 7 divisions, so all 35 bunks are deleted from window.scheduleAssignments — wiping the displayed schedule for divisions the scheduler doesn't own. The subsequent loadSchedule re-merges from cloud, but any unsa
- Verifier: The over-clear mechanism is REAL and the quoted lines are accurate. access_control.js deleteMyDivisionsOnly (L1745) sources its bunk set from getEditableDivisions(), which under v3.13 (L1219-1221) returns Object.keys(window.divisions) — ALL divisions — for SCHEDULER as well as OWNER/ADMIN. It then collects every bunk across those divisions (L1787-1

#### CB-131 [CONFIRMED] supabase_permissions.js:309  _(rbac)_
**Per-bunk write-filters (filterToMyDivisions / validateScheduleWrite / validateLeagueWrite / assertCanWriteGrade) are dead code — never called by any save path**

- Evidence: PermissionsDB.filterToMyDivisions (supabase_permissions.js L309) and PermissionsGuard.validateScheduleWrite (permissions_guard.js L253), validateLeagueWrite (L286), assertCanWriteGrade (L219) are documented as the layer that 'prevent[s] overwriting other schedulers' work' (comment L307-308). Grep across the whole repo shows the ONLY callers are rbac_diagnostics.js (L377-415, a self-test) — no scheduler/manual/orchestrator save path invokes them.
- Scenario: These functions are advertised (and self-tested) as the bunk-level write guard, but no production code calls them. The system isn't actively broken (scheduler_id row scoping + v3.13 'scheduler = full edit by design' cover the gap), but the safety net the code claims to provide does not exist — a future change that relaxes row scoping or merges sche
- Verifier: The claim is accurate on every load-bearing point. Whole-repo .js grep proves the 4 advertised write-guard functions are never called by any save path: (1) PermissionsDB.filterToMyDivisions (supabase_permissions.js:309) appears ONLY at its definition (L309) and export (L421) — zero callers anywhere, not even the self-test; (2) PermissionsGuard.asse

#### CB-132 [CONFIRMED / LIVE] demo_mode.js:133  _(rbac)_
**Demo mode writes localStorage.campistry_role='owner' and the exit path never clears it — relies solely on the auth-id match in tryRestoreFromLocalStorage to avoid leaking owner into a real session**

- Evidence: demo_mode.js L133 `localStorage.setItem('campistry_role','owner')` (also sets campistry_user_id/auth_user_id to the reused real id at L118-132). The exit path promptDemoExit→tryExit (L669-679) removes only `campistry_demo_mode` and `campistry_rbac_cache`, then reload — it does NOT remove campistry_role / campistry_user_id / campistry_auth_user_id. On reload, access_control.tryRestoreFromLocalStorage (L170-194) fast-paths owner/admin: `if (cachedR
- Scenario: On a shared/kiosk browser: user A runs demo (?demo=true) → campistry_role='owner', campistry_auth_user_id=<A's id> persisted. Demo exited via password (does not clear role/ids). The window between reload and verifyRoleFromDB resolving, a fresh tab for the same cached auth id boots with _currentRole='owner' from localStorage and _initialized=true (i
- Verifier: The claim is accurate as a LOW-severity hygiene defect. Verified end-to-end in source: 1) demo_mode.js sets owner identity into localStorage at boot: L132-133 `localStorage.setItem('campistry_auth_user_id', DEMO_USER_ID); localStorage.setItem('campistry_role','owner');`, where DEMO_USER_ID (L118) is the reused prior REAL auth id `localStorage.getI

#### CB-133 [CONFIRMED] access_control.js:2149  _(rbac)_
**assignDivisionsToMember sets assigned_divisions but leaves subdivision_ids stale — and determineUserContext prioritizes subdivision_ids, silently ignoring the new assignment**

- Evidence: assignDivisionsToMember (L2149-2169) does `update({ assigned_divisions: divisionNames })` ONLY — it never clears or updates subdivision_ids. But determineUserContext (L604-624) and verifyRoleFromDB (L241-256) resolve a scheduler's divisions subdivision-FIRST: `if (_userSubdivisionIds.length > 0) { ...resolve from subdivisions table... } else if (_directDivisionAssignments.length > 0) {...}`. So if the member already had subdivision_ids, the assig
- Scenario: Code/integration that calls AccessControl.assignDivisionsToMember(memberId, ['DivA','DivB']) on a scheduler who already has subdivision_ids set: the DB row's assigned_divisions updates, the call returns success, but on that scheduler's next load their editable/generatable divisions are still derived from the old subdivision_ids — the reassignment s
- Verifier: All three load-bearing facts verified in access_control.js. (1) assignDivisionsToMember (L2149-2169) updates ONLY assigned_divisions — L2157 `.update({ assigned_divisions: divisionNames })` — and never clears/writes subdivision_ids. (2) Both context resolvers prioritize subdivisions: determineUserContext (L604-619) and verifyRoleFromDB (L241-256) d

#### CB-134 [CONFIRMED] subdivision_schedule_manager.js:685  _(rbac)_
**Subdivision lock save/restore conflates two distinct slot-index spaces (per-bunk array index vs division-level fieldUsageBySlot index) — latent keying corruption, currently inert because the restore/register path is dead**

- Evidence: extractScheduleDataForSubdivision copies scheduleAssignments[bunk] as a per-bunk array (`data[bunk] = bunkData` where bunkData = scheduleAssignments[bunk].map(...), L348-355) — indexed by that bunk's OWN per-bunk slot geometry. But extractFieldUsageClaimsForSubdivision builds claims[slotIdx][fieldName] from window.fieldUsageBySlot (L378-407) whose keys are the DIVISION-LEVEL unified slot index (fieldUsageBySlot is written by scheduler_core_main.j
- Scenario: If the subdivision-lock multi-scheduler feature is re-enabled (today restoreLockedSchedules / registerLockedClaimsInGlobalLocks / getBunksToSchedule / markCurrentUserSubdivisionsAsDraft / isFieldClaimedByOthers / getLockedFieldUsageClaims have ZERO callers outside this module — grep-confirmed — and GlobalFieldLocks.loadOtherSchedulerSchedules short
- Verifier: The claim is accurate on both axes and correctly self-limited to LOW/latent. (1) Dead-path: all six named functions are exported on window.SubdivisionScheduleManager (subdivision_schedule_manager.js L959-973) but a repo-wide grep for `.restoreLockedSchedules(` / `.registerLockedClaimsInGlobalLocks(` / `.getBunksToSchedule(` / `.markCurrentUserSubdi

#### CB-135 [PLAUSIBLE] rbac_visual_restrictions.js:677  _(rbac)_
**Dead-but-wired unescaped user-data path: createTabBanner injects division names raw; only the v3.13 scheduler-bypass keeps it from firing**

- Evidence: createTabBanner builds a banner via raw innerHTML with no escaping (file has no escaper): L671-680: function createTabBanner(title, message) { const banner = document.createElement('div'); banner.className = 'rbac-tab-banner'; banner.innerHTML = ` <span ...>...</span> <div> <strong>${title}</strong> <div ...>${message}</div> </div>`; return banner; } The sched
- Scenario: This is the bug-class 'dead code that still LOOKS load-bearing.' If the v3.13 scheduler-edits-everything bypass at rbac_visual_restrictions.js:44 (and the mirror logic in access_control.js) is ever reverted so that schedulers regain field-level restrictions, applyToFieldsTab's scheduler branch (L470-560) immediately becomes live and createTabBanner
- Verifier: The claim is accurate on every checkable point, and correctly self-describes as a LATENT (presently dead) sink — so it cannot be CONFIRMED (no current trigger) but the mechanism is real, hence PLAUSIBLE. SINK IS REAL + UNESCAPED: createTabBanner (rbac_visual_restrictions.js L670-681) assigns banner.innerHTML with raw `${title}`/`${message}`. Grep

#### CB-136 [CONFIRMED / LIVE] supabase_permissions.js:261  _(rbac)_
**Divergent duplicate canEditBunk: supabase_permissions.js lacks the v3.13 scheduler full-edit bypass that access_control.js has**

- Evidence: Two canEditBunk implementations have diverged. access_control.js:1006-1020 was updated for v3.13 so schedulers get full edit access: function canEditBunk(bunkName) { if (!bunkName) return false; if (_currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN || _currentRole === ROLES.SCHEDULER) return true; // v3.13 bypass ... } The duplicate in supabase_permissions.js:261-272 never got that change — a scheduler is NOT bypa
- Scenario: A scheduler tries to edit a bunk in a division they are not assigned to. Under v3.13 (schedulers edit everything) AccessControl.canEditBunk -> true; PermissionsDB.canEditBunk -> false. In practice the divergence is currently SHADOWED: the only consumer (scheduler_core_utils.js Utils.canEditBunk, L1994) calls PermissionsDB.canEditBunk only as a fall
- Verifier: The divergence is real and the claim accurately describes BOTH the defect and its current dormancy. access_control.js:1006-1020 has the v3.13 scheduler bypass (line 1009: `if (_currentRole === ROLES.OWNER || _currentRole === ROLES.ADMIN || _currentRole === ROLES.SCHEDULER) return true;`, marked `// ★★★ v3.13: ... schedulers have full edit access ★★

#### CB-137 [PLAUSIBLE / LIVE] campistry_go.js:975  _(go)_
**Geocode checkpoint recovery replaces the whole address map, can drop cloud/loaded addresses absent from the checkpoint**

- Evidence: load() L968-979: it reads `STORE+'_addr_ckpt'`, counts geocoded entries, and if `ckptGeocoded > mainGeocoded` does `D.addresses = ckpt;` — a WHOLESALE replacement of the address map, not a per-key merge. The checkpoint (written by _saveAddressesCheckpoint L2682 as just `JSON.stringify(D.addresses)`) reflects whatever D.addresses contained mid-geocode. If, by the time of the next load, the authoritative source (cloud / globalSettings, merged earli
- Scenario: Device A starts geocoding 200 addresses, checkpoints at 175 geocoded, tab is killed mid-run. Meanwhile cloud has grown to 210 addresses (added on device B). On the next load on device A: cloud merge brings ~210 into D.addresses with, say, 50 geocoded; checkpoint has 175 geocoded but only the original 200 keys. ckptGeocoded(175) > mainGeocoded(50) →
- Verifier: The mechanism is real and present in the code. In load() the cloud/local merge runs FIRST (campistry_go.js L928/931/934 `D = merge(cloud|local)`), so by the time checkpoint recovery executes (L968-980) D.addresses already contains the authoritative merged set, including any cloud-only keys grown on another device. The recovery then does a WHOLESALE

#### CB-138 [CONFIRMED] campistry_go_persistence.js:112  _(go)_
**recordAssignment collapses a split (oversize) neighborhood's two buses into one in the persisted year-over-year record**

- Evidence: recordAssignment L107-114 builds `busByNh` by iterating each bus's neighborhoodIds and mapping `parentId = nhId.replace(/_p\d+$/, '')` → `busByNh[parentId] = bus.busId`. When packIntoBuses splits an oversize neighborhood into pieces `nh.id+'_p'+i` (campistry_go_neighborhoods.js L989-998) that land on DIFFERENT buses, both pieces share the same parentId, so the second iteration overwrites the first: `busByNh[parent]` keeps only the LAST bus seen.
- Scenario: A large neighborhood exceeds one bus's capacity and packIntoBuses splits it: piece _p0 → bus RED, piece _p1 → bus BLUE. recordAssignment writes busByNh[parent] = (whichever of RED/BLUE is iterated last). Next season getPriorAssignments returns only that one bus for the neighborhood, so the grandfather/diff logic treats half the campers as 'reassign
- Verifier: The claim is accurate and confirmed by the code. campistry_go_neighborhoods.js:989-998 (packIntoBuses) splits an oversize neighborhood into pieces with distinct ids `nh.id+'_p'+i`, each carrying `parentId: nh.id`. These pieces are placed INDEPENDENTLY: assignToBus pushes the PIECE id (`bus.neighborhoodIds.push(nh.id)`, L1013), and the three placeme

#### CB-139 [CONFIRMED] campistry_go.js:968  _(go)_
**Geocode-checkpoint recovery on load compares only geocoded COUNT and consumes the checkpoint regardless, so it can lose a fresher cloud address set or a deletion**

- Evidence: `const ckptRaw = localStorage.getItem(STORE + '_addr_ckpt'); if (ckptRaw) { const ckpt = JSON.parse(ckptRaw); const ckptGeocoded = Object.values(ckpt).filter(a => a.geocoded).length; const mainGeocoded = Object.values(D.addresses || {}).filter(a => a.geocoded).length; if (ckptGeocoded > mainGeocoded) { D.addresses = ckpt; ... } localStorage.removeItem(STORE + '_addr_ckpt'); }` (L969-979). Recovery is decided solely by which has more GEOCODED entr
- Scenario: A geocoding run is interrupted (tab closed mid-run), leaving STORE+'_addr_ckpt' with N geocoded entries. Meanwhile the user (or another device) deleted some campers, so the authoritative current set has fewer geocoded entries. On reload, ckptGeocoded(N) > mainGeocoded → D.addresses is overwritten wholesale by the stale checkpoint, reviving deleted
- Verifier: The defect is real and present in the source. In load() (campistry_go.js:968-980) the checkpoint recovery decides solely by GEOCODED COUNT (ckptGeocoded > mainGeocoded), wholesale REPLACES D.addresses = ckpt (not a merge), and removes the checkpoint UNCONDITIONALLY (L978). The checkpoint is written raw with no timestamp/version (_saveAddressesCheck

#### CB-140 [CONFIRMED] campistry_go_ors_optimizer.js:636  _(go)_
**_cheapestInsert capacity check uses raw bus capacity, ignoring reserved monitor/counselor seats — overfills buses on the unassigned-fallback path**

- Evidence: Everywhere else reserved seats are subtracted before comparing to demand: _recursiveSplit L264-266 `(v.capacity||44) - reserved`, _singleRequest L430-431 `realCap = Math.max(1,(v.capacity||44)-reservedSeats)`. But the unassigned-stop fallback _cheapestInsert L636 does `if (v && route.camperCount + stop.campers.length > v.capacity) continue;` against the RAW `v.capacity` with no monitor/counselor subtraction. So a bus that is full once its monitor
- Scenario: VROOM leaves N stops unassigned (region over capacity); _cheapestInsert places them. A bus with capacity 44, a monitor and 2 counselors has only 41 camper seats but the check compares against 44 — it accepts up to 3 extra campers, producing a route the downstream getCapacityWarnings (L1275, which DOES subtract reserves) then flags as over capacity,
- Verifier: The claim is accurate. In campistry_go_ors_optimizer.js, the unassigned-stop fallback _cheapestInsert gates insertion on RAW bus capacity with no reserved-seat subtraction: L636: `if (v && route.camperCount + stop.campers.length > v.capacity) continue;` where `route.camperCount` counts ONLY campers (built at L572-574 `orderedStops.reduce(... + st

#### CB-141 [CONFIRMED] campistry_go_stop_master.js:42  _(go)_
**Dead-but-wired GoStopMaster subsystem — loaded + full public API, zero call sites (sibling GoNhPersistence IS wired)**

- Evidence: `window.GoStopMaster = (function () { ... return { loadStops, upsertStops, recordSeason, getGrandfatherMap, stopKey }; })();` (L42/L172) is a complete 'canonical Stop Master + camper-stop grandfathering history' feature with Supabase persistence to go_standalone_data (data_type='stop_master'/'camper_stop_history') and a documented public API (L34-39). It is loaded as a real production script — `<script src="campistry_go_stop_master.js"></script>`
- Scenario: No runtime effect (functions are never invoked), but the loaded script advertises a working 'stops survive roster/season churn' grandfathering capability that does nothing: stops are never upserted to the master library and getGrandfatherMap is never consulted during assignment, so the documented year-over-year stop persistence silently does not ha
- Verifier: Every factual claim verifies against the actual code. (1) campistry_go_stop_master.js defines a complete window.GoStopMaster IIFE with a 5-function public API (loadStops/upsertStops/recordSeason/getGrandfatherMap/stopKey) plus Supabase persistence via GoCloudSync to go_standalone_data and a documented API header at L34-39. (2) It is loaded as a rea

#### CB-142 [PLAUSIBLE] mobile_touch_drag.js:709  _(misc)_
**Mobile resize/reposition fallback dispatches 'mobile-resize-complete'/'mobile-reposition-complete' events that NOTHING listens for — on an internal-API load failure the mutated skeleton is silently never saved or re-rendered**

- Evidence: Both finishTouchResize (L709-714, L735-739) and finishTouchReposition (L874-878, L886-890) mutate the live skeleton event in place, then in their else-branch do `window.dispatchEvent(new CustomEvent('mobile-resize-complete'/'mobile-reposition-complete', {...}))` as the fallback when `window.MasterSchedulerInternal`/`window.DailyAdjustmentsInternal` is absent. A repo-wide grep for those two event names returns ONLY the 4 dispatch sites — there is
- Scenario: If master_schedule_builder.js or daily_adjustments.js throws during init (so window.MasterSchedulerInternal / window.DailyAdjustmentsInternal is never assigned at master_schedule_builder.js:4965 / daily_adjustments.js:8395) but mobile_touch_drag.js still binds, a mobile user resizes or repositions a tile: event.startTime/endTime are changed in the
- Verifier: The claim's factual core is verified: the 4 dispatch sites exist (mobile_touch_drag.js:711/736/875/887), a repo-wide grep finds ZERO addEventListener for 'mobile-resize-complete' or 'mobile-reposition-complete' (only the 4 dispatches), and the actual save/render (saveDraftToLocalStorage/saveDailySkeleton/renderGrid) lives only inside the `if (windo

#### CB-143 [CONFIRMED] playoff_mode.js:326  _(misc)_
**Dead, diverged inline playoff UI (PlayoffMode.render) is exported and wired but unreachable — superseded by PlayoffHub**

- Evidence: playoff_mode.js exports a full inline playoff UI: `render` (L326-568) plus `renderSeedList` (L570), `renderRoundCard` (L724), `renderMatchup` (L765), `_fieldsForSport`/`_fieldSupportsSport` (L887-904), the self-reassigning re-render hook `var _origRender = render; render = function(...){ _origRender(...); mountEl._reRender = ... }` (L909-913), and `injectStyles` (L918, injected at load via L987-990 → installs the unused `playoff-mode-styles` <sty
- Scenario: A developer reads playoff_mode.js, sees `window.PlayoffMode.render` exported and called from `mountPlayoffUI`/`mountSpecialtyPlayoffUI`, and assumes it is the live playoff editor. They 'fix' or extend it (e.g. add a constraint to the inline seed/matchup UI), but the change never surfaces because that path is unreachable — the real UI is playoff_hub
- Verifier: The inline playoff UI in playoff_mode.js is genuinely dead/unreachable, exactly as claimed. Reachability chain, verified by reading the code: 1. PlayoffMode.render is exported at playoff_mode.js:1005 and is called from exactly two places: mountPlayoffUI (leagues.js:952) and mountSpecialtyPlayoffUI (specialty_leagues.js:948). A repo-wide grep for `

#### CB-144 [CONFIRMED] access_control.js:459  _(rbac)_
**setupDivisionChangeObserver leaks a new 1-second setInterval on every refresh() (realtime membership change)**

- Evidence: setupDivisionChangeObserver (L458) does `setInterval(() => { ... calculateEditableDivisions(); ... }, 1000)` and never stores the handle or clears it. initialize() calls it unconditionally at L423. refresh() (L978-990) sets `_initialized=false` then `await initialize()`, and the realtime UPDATE handler (L546) calls refresh() on every remote camp_users change. The SIGNED_OUT teardown (L2394-2424) and refresh() both clear the channel subscription b
- Scenario: A scheduler's role/subdivisions are edited remotely several times in a session (or any flow that calls AccessControl.refresh repeatedly). Each refresh()->initialize() spawns another orphaned 1s interval; all prior ones keep running forever, each re-hashing Object.keys(window.divisions) and calling calculateEditableDivisions() every second. N refres
- Verifier: The leak is real and reachable. setupDivisionChangeObserver (access_control.js L458-459) calls setInterval(...,1000) and discards the handle — a file-wide Grep for setInterval/clearInterval returns ONLY L459, so the timer is never captured and never cleared. initialize() does have an early-return guard `if (_initialized) return` (L365-368), but ref

#### CB-145 [CONFIRMED] campistry_go.js:1838  _(go)_
**acceptAllStaffSuggestions() bypasses the over-capacity guard that the single-accept path enforces**

- Evidence: The single-accept path (acceptStaffAssign, line 1919) computes `_capacityAfterStaffAdd(busId)` and, if `cap.overBy > 0`, routes through `_showCapacityWarning` before committing. The bulk path does not: ``` function acceptAllStaffSuggestions() { ... for (const { staff } of all) { if (!staff._suggestedBusId) continue; if (staff._assignStatus === 'accepted' || staff._assignStatus === 'denied') continue; staff._assignStatus = 'accepte
- Scenario: A near-full bus already has its monitor + counselors. The dispatcher clicks "Accept all" to confirm pending staff suggestions; one more counselor is suggested onto that bus. Single-accept would have popped the "Bus Over Capacity" modal; bulk-accept silently assigns it, leaving the bus over its real seat count with no indication.
- Verifier: The asymmetry is real and the trigger is concrete. acceptStaffAssign (single-accept, campistry_go.js L1919-1932) computes _capacityAfterStaffAdd(staff._suggestedBusId) and, when cap.overBy > 0, diverts to _showCapacityWarning instead of committing. The bulk path acceptAllStaffSuggestions (L1838-1858) loops over every pending monitor/counselor and u

