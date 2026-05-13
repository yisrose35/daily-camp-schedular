# Campistry — Claude Code Context

## Project Overview
**Campistry** is a camp scheduling platform for head counselors and camp owners. It generates daily activity schedules across divisions, grades, and bunks — respecting field availability, access restrictions, rotation fairness, and league fixtures.

- **Stack:** Vanilla JS, HTML, CSS — no build step, no framework. Files load directly in the browser.
- **Backend:** Supabase (PostgreSQL, Auth, RLS). Tables: `daily_schedules`, `rotation_counts`, `camp_state_kv`.
- **Two builder modes:** Auto Builder (layer-based solver) and Manual Builder (drag-drop skeleton).

## Active Mission
40-day polish plan — no new features, perfect what exists. Track progress:
https://github.com/yisrose35/daily-camp-schedular/issues/66

**Working branch:** `Daily-Audit-Walkthrough`

---

## How to Use This File
When the user says **"day X"** or **"let's do day X"**:
1. Look up Day X in the plan below
2. Read the listed files deeply before making any changes
3. Execute every task for that day
4. Commit and push to `Daily-Audit-Walkthrough` when done
5. Check off completed items in GitHub Issue #66

---

## Key File Map

| System | Files |
|--------|-------|
| Auto Builder — Layer Editor | `auto_schedule_planner.js` |
| Auto Builder — Grid Preview | `auto_schedule_grid.js` |
| Auto Builder — Solver | `scheduler_core_auto.js`, `auto_solver_engine.js`, `total_solver_engine.js` |
| Manual Builder — Skeleton Editor | `master_schedule_builder.js` |
| Manual Builder — Generation | `scheduler_core_main.js` |
| Shared Scheduling Rules | `rules.js`, `scheduler_core_utils.js` |
| Rotation & Fairness | `rotation_engine.js`, `rotation_cloud.js`, `rotation_events.js` |
| Cloud Sync | `cloud_sync_helpers.js`, `supabase_sync.js`, `supabase_schedules.js`, `supabase_client.js` |
| Local Cache | `local_cache_idb.js` |
| Camp Setup UI | `app1.js`, `campistry_me.js`, `campistry_me.html` |
| Output — Print | `print_center.js` |
| Output — Calendar Views | `schedule_calendar_views.js` |
| Output — Daily Adjustments | `daily_adjustments.js` |
| Schedule Data System | `unified_schedule_system.js` |
| Analytics | `analytics.js` |
| Leagues | `leagues.js`, `scheduler_core_leagues.js`, `specialty_leagues.js` |
| Special Activities | `special_activities.js` |
| Integration Hub | `integration_hooks.js` |

---

## 40-Day Plan

### Phase 1 — Foundation & Cloud Audit `Days 1–5`

**Day 1**
- Goal: Kill debug noise, get tests running
- Tasks:
  - Search for `DEBUG = true` (or `const DEBUG = true`) across all JS files and set each to `false`. Key files: `supabase_schedules.js`, `division_times_system.js`, `integration_hooks.js`, `post_edit_system.js`, `access_control.js`, `unified_schedule_system.js`, `scheduler_core_loader.js`, `schedule_orchestrator.js`, `total_solver_engine.js`
  - Run `node --test tests/period_packer.test.js` — document any failures
  - Run `node --test tests/post_edit_autogen.test.js` — document any failures
  - Run `node --test tests/travel_time.test.js` — document any failures
  - Run `node --test tests/calendar_delete_reset.test.js` — document any failures
- Done when: All DEBUG flags are false, test results are documented

**Day 2**
- Goal: Fix test failures, triage TODOs
- Tasks:
  - Fix all failing tests from Day 1
  - Search codebase for `// TODO` and `// FIXME` — list every one, fix any that are clearly broken, close any that are no longer relevant
  - Verify all 4 test suites pass cleanly after fixes
- Done when: All 4 test suites green, TODO list triaged

**Day 3**
- Goal: Resolve mid-day rain TODOs, begin cloud audit
- Tasks:
  - Read `rainy_day_manager.js` around line 1240 and `daily_adjustments.js` around line 943 — both have a TODO about re-enabling mid-day mode. Decide: re-enable it correctly or remove the dead code path entirely
  - Audit `cloud_sync_helpers.js` end to end — verify retry logic (exponential backoff), merge logic, and error handling on every save and load path. Fix any gaps.
- Done when: Mid-day rain TODO resolved, `cloud_sync_helpers.js` audit complete with issues fixed

**Day 4**
- Goal: Audit daily schedule and sync cloud paths
- Tasks:
  - Audit `supabase_schedules.js` — verify every write to `daily_schedules` is atomic and correct, every read returns the right data. Fix any issues.
  - Audit `supabase_sync.js` — verify sync orchestration has no race conditions (two saves firing simultaneously, stale reads overwriting fresh writes). Fix any issues.
  - **[NEW from main]** Realtime sync had 12 commits including revert cycles — verify current realtime handler in `integration_hooks.js` and `supabase_sync.js` is clean: DELETE event propagation works, no duplicate merge blocks, 60-second guard is fully removed, scoped delete/clear for schedulers vs owners
  - **[NEW from main]** Multi-scheduler merge (`schedule_orchestrator.js`) — verify newest-wins sort by `updated_at` doesn't lose data
- Done when: Both files audited, realtime sync verified clean, any bugs fixed

**Day 5**
- Goal: Audit rotation cloud and offline cache
- Tasks:
  - Audit `rotation_cloud.js` — verify rotation counts write to `rotation_counts` table correctly, are never double-counted on re-generation, survive across sessions
  - Audit `local_cache_idb.js` — verify IndexedDB fallback logic is correct and offline→online sync path delivers all queued writes
  - Review `audit_plan.md` — read slices 3–6, identify any outstanding regressions, fix the critical ones
- Done when: Both cloud files audited, `audit_plan.md` regressions addressed

---

### Phase 2 — Me Page Quick Pass `Days 6–8`

**Day 6**
- Goal: Verify camp structure CRUD and cloud persistence
- Tasks:
  - Walk `campistry_me.html` end-to-end: create a division, create grades inside it, create bunks, edit them, reorder them, delete one
  - Verify each operation persists to `camp_state_kv` in Supabase (check network tab or Supabase dashboard)
  - Fix any CRUD operation that fails or doesn't save correctly
- Done when: Division/grade/bunk CRUD works and cloud-persists correctly

**Day 7**
- Goal: Verify activity config, camp dates, and builder mode handoff
- Tasks:
  - Add a special activity, add a league/sport — verify both appear correctly when entering the Flow builder
  - Read `app1.js` lines 489–545 (`renderBuilderModeSlider`) — verify the Manual/Auto toggle is visually clear and the selection persists to `camp_state_kv`
  - Load Flow page and verify all configured divisions, bunks, activities and leagues are present
  - **[NEW from main]** Camp dates feature (`dashboard.js`, `dashboard.html`): set up camp dates (start/end, halves, transition weeks), verify they persist to cloud, survive reload, and show read-only for scheduler role
  - **[NEW from main]** Verify camp ID resolution — a prior fix (`9d03c205`) fixed camp ID mismatch causing dates not to persist
- Done when: Builder mode persists, camp dates persist, all camp data is available in the Flow page

**Day 8**
- Goal: Regression — structural changes don't corrupt existing schedules
- Tasks:
  - Generate a schedule, then go back to the Me page and rename a division, add a bunk, remove a bunk
  - Reload the Flow page — verify the existing schedule is intact, not corrupted or partially lost
  - Fix any data corruption found
- Done when: Structural changes after schedule generation are safe

---

### Phase 3 — Auto Builder `Days 9–24`

**Day 9**
- Goal: Layer editor create/edit/delete
- Files: `auto_schedule_planner.js`
- Tasks:
  - Read `auto_schedule_planner.js` in full. Understand the layer data model, how layers are created, edited, deleted, reordered
  - Test: create a layer, add blocks to it, edit block durations, delete a block, reorder layers. Each operation should feel responsive and correct
  - Fix any bugs in create/edit/delete/reorder
- Done when: All four layer operations work correctly with no data loss

**Day 10**
- Goal: Layer save/load and template persistence
- Files: `auto_schedule_planner.js`, `cloud_sync_helpers.js`
- Tasks:
  - Verify layers save to `camp_state_kv` and reload correctly after page refresh
  - Verify layers survive logout → login (full round trip through Supabase)
  - Test saving a layer as a reusable template — verify it persists and can be loaded back
  - Fix any persistence gaps
- Done when: Layers and templates survive page refresh and logout/login

**Day 11**
- Goal: Grid preview accuracy
- Files: `auto_schedule_grid.js`
- Tasks:
  - Read `auto_schedule_grid.js` in full. Understand how it reads layer state and renders per-bunk timelines
  - Test: edit a layer block and verify the grid updates immediately (no stale render)
  - Test: empty layer, single-activity layer, cross-division block — all render correctly
  - Fix any rendering bugs or stale state issues
- Done when: Grid accurately reflects layer state in real time

**Day 12**
- Goal: Grid edge cases and cloud state
- Files: `auto_schedule_grid.js`, `unified_schedule_system.js`
- Tasks:
  - Test grid with large camp (many bunks) — verify no overflow, truncation, or layout breakage
  - Verify grid state reloads correctly after page refresh (loads from cloud, not stale local)
  - Fix any edge cases found
- Done when: Grid handles all edge cases correctly

**Day 13**
- Goal: Auto solver baseline — no crashes
- Files: `scheduler_core_auto.js`, `daily_adjustments.js`
- Tasks:
  - Read the top-level structure of `scheduler_core_auto.js` — understand the entry point, main generation loop, and how it consumes layer config
  - Run generation for a standard camp config (2–3 divisions, 2–4 bunks each, standard activities)
  - Verify: no JS errors, no crashes, schedule is produced for all bunks
  - **[NEW from main]** Generation scope picker (`daily_adjustments.js`): test partial regen — select only one division and generate. Verify the pre-generation wipe only clears selected divisions, not all. Verify Free-slot fallback (`scheduler_core_main.js`) also respects the scope.
  - Fix any crash-level bugs
- Done when: Auto generation completes without errors for standard and scoped configs

**Day 14**
- Goal: Access restrictions, field conflicts, and scheduler division scoping
- Files: `scheduler_core_auto.js`, `scheduler_core_utils.js`, `rules.js`, `access_control.js`
- Tasks:
  - Verify access restrictions are honored: a bunk that cannot access a certain activity should never receive it in the generated schedule
  - Verify field conflicts: no two bunks are assigned to the same field at the same time
  - Set up a test case with known restrictions and verify the output manually
  - **[NEW from main]** Scheduler division scoping (`access_control.js`): verify `allowedDivisions` resolution is not stale (prior fixes: `36dfa2ed`, `09b95280`, `304f6f24`, `542a1476`, `af5d4009`). Test with a scheduler role account — they should only see/generate for their assigned divisions. Verify subdivision UUID resolution and parent→child grade expansion work correctly.
  - Fix any violations found
- Done when: Access restrictions, field conflicts, and division scoping are clean

**Day 15**
- Goal: Time rules and field sharing
- Files: `scheduler_core_auto.js`, `rules.js`
- Tasks:
  - Verify time rules: no activity placed outside its allowed time window
  - Verify field sharing: when two bunks share a field at the same time, this is only allowed when the activity supports it (e.g. free swim)
  - Fix any violations found
- Done when: Time rules and field sharing are clean

**Day 16**
- Goal: Cloud save of auto-generated schedule
- Files: `supabase_schedules.js`, `cloud_sync_helpers.js`, `unified_schedule_system.js`
- Tasks:
  - After a successful auto generation, verify the schedule is saved to `daily_schedules` in Supabase
  - Verify all bunks are present in the saved data — no bunk is silently dropped
  - Reload the page — verify the generated schedule comes back correctly from cloud
  - Fix any save/load issues
- Done when: Auto-generated schedule saves and reloads correctly from Supabase

**Day 17**
- Goal: Rotation fairness, exact frequency, and escalation bonuses
- Files: `rotation_engine.js`, `rotation_cloud.js`, `scheduler_core_auto.js`, `scheduler_core_utils.js`
- Tasks:
  - Read `rotation_engine.js` — understand the least-recent selection logic and how it scores activities for each bunk
  - Generate schedules for 3 consecutive days — verify that activity distribution is visibly fair (no bunk gets the same activity every day, no bunk is always last to get desirable activities)
  - Verify rotation counts are written to `rotation_counts` in Supabase after each generation
  - **[NEW from main]** Exact frequency constraint: configure a special with an exact frequency (e.g. "exactly 2x per week") in facilities UI. Generate — verify the constraint is enforced, not exceeded. Verify the manual edit gate also rejects violations.
  - **[NEW from main]** Escalating frequency bonuses (`rotation_engine.js`, `scheduler_core_auto.js`): verify the bonus doesn't unfairly favor one bunk, and that cooldown is factored into the escalation correctly
  - **[NEW from main]** Per Half period option: if camp dates define halves, verify rotation can be set to "Per Half" and counts reset at the half boundary
  - Fix any fairness bugs
- Done when: Rotation is visibly fair, exact frequency enforced, escalation balanced

**Day 18**
- Goal: Rotation count correctness on re-generation
- Files: `rotation_cloud.js`, `post_edit_system.js`
- Tasks:
  - Generate a schedule, note the rotation counts, then re-generate for the same day
  - Verify rotation counts are updated correctly — not double-counted, not reset, not stale
  - Verify `rotation_counts` table in Supabase reflects the correct cumulative state
  - Fix any double-count or reset bugs
- Done when: Re-generation produces correct cumulative rotation counts

**Day 19**
- Goal: Special activities integration + multi-period spanning
- Files: `special_activities.js`, `scheduler_core_auto.js`, `division_times_system.js`, `post_edit_system.js`
- Tasks:
  - Configure 2–3 special activities in the Me page
  - Run auto generation — verify specials are placed correctly, no bunk is double-booked for a special
  - Verify special activity assignments are saved to cloud and reload correctly
  - **[NEW from main]** Multi-period special spanning: configure a special that spans 2+ consecutive periods (e.g. 90-min swim across two 45-min slots). Verify: continuation slots have correct `_startMin/_endMin`, field capacity is counted correctly across spanned periods, pinned preservation handles multi-period pins, manual edit of a spanned special updates all continuation slots
  - **[NEW from main]** Period-boundary alignment: verify multi-period specials align to period boundaries and don't create unfillable gaps
  - Fix any placement or persistence bugs
- Done when: Special activities place correctly including multi-period spanning

**Day 20**
- Goal: League games in auto builder
- Files: `leagues.js`, `scheduler_core_leagues.js`, `scheduler_core_auto.js`
- Tasks:
  - Configure a league with a sport in the Me page
  - Run auto generation — verify league game slots are placed correctly for all participating bunks
  - Verify back-to-back away league games are handled and displayed correctly
  - Fix any league placement bugs
- Done when: League games place correctly in auto-generated schedules

**Day 21**
- Goal: League games cloud persistence
- Files: `supabase_schedules.js`, `scheduler_core_leagues.js`
- Tasks:
  - After auto generation with league games, reload the page
  - Verify league game assignments come back correctly from cloud (correct opponents, correct time slots)
  - Fix any persistence gaps for league data
- Done when: League game assignments survive page refresh from cloud

**Day 22**
- Goal: Large camp stress test + multi-scheduler
- Tasks:
  - Configure a large camp: 4+ divisions, 4+ bunks each, multiple leagues, special activities
  - Run auto generation — verify it completes without timeout, crash, or JS errors
  - Verify all bunks receive a complete schedule with no gaps or invalid placements
  - **[NEW from main]** Multi-scheduler test: assign different divisions to different scheduler accounts. Have each scheduler generate only their divisions. Verify: no scheduler can wipe another's divisions, the merged schedule shows all divisions correctly, cross-user schedule visibility works during auto mode
  - Fix any performance or correctness issues found
- Done when: Solver handles a large camp correctly, multi-scheduler scoping is clean

**Day 23**
- Goal: Multi-day stress test and cross-division
- Tasks:
  - Generate schedules for 5 consecutive days for the large camp
  - Verify rotation is fair across all 5 days
  - Verify cross-division field sharing produces no conflicts on any day
  - Fix any issues found
- Done when: 5-day generation is clean and fair

**Day 24**
- Goal: Full auto builder cloud verification
- Tasks:
  - Starting from a fresh session (clear local storage, log out and back in)
  - Set up layers → generate → verify cloud save → reload → confirm all data intact (layers, schedule, rotation counts, league assignments)
  - Fix any gaps in the full cloud round trip
- Done when: Full auto builder round trip through cloud is verified end-to-end

---

### Phase 4 — Manual Builder `Days 25–36`

**Day 25**
- Goal: Skeleton editor — drag-drop reliability
- Files: `master_schedule_builder.js`
- Tasks:
  - Read `master_schedule_builder.js` in full — understand tile data model, drag-drop logic, modal system
  - Test: create tiles of each type (Swim, Sports, Electives, etc.), drag them into time slots, reorder them
  - Test: merge overlapping Swim/Elective tiles — verify the merge behavior is correct
  - Fix any drag-drop bugs or modal issues
- Done when: Skeleton editor drag-drop works reliably for all tile types

**Day 26**
- Goal: Skeleton save/load and cloud persistence
- Files: `master_schedule_builder.js`, `cloud_sync_helpers.js`
- Tasks:
  - Verify skeleton saves correctly on every change and reloads after page refresh
  - Verify skeleton survives logout → login (full cloud round trip via `camp_state_kv`)
  - Test: build a skeleton for multiple divisions — verify each division's skeleton is stored independently
  - Fix any save/load or isolation bugs
- Done when: Skeletons save, reload, and are isolated per division

**Day 27**
- Goal: Multiple division skeletons
- Files: `master_schedule_builder.js`
- Tasks:
  - Create different skeletons for Division A and Division B
  - Verify editing Division A's skeleton has zero effect on Division B's skeleton
  - Verify switching between divisions in the UI loads the correct skeleton each time
  - Fix any cross-contamination bugs
- Done when: Division skeletons are fully isolated

**Day 28**
- Goal: Manual generation — field assignment and access restrictions
- Files: `scheduler_core_main.js`, `rules.js`
- Tasks:
  - Read `scheduler_core_main.js` — understand the entry point and generation loop
  - Run generation for a standard camp (2–3 divisions, skeleton defined)
  - Verify: field assignments are correct, no field double-booked, access restrictions honored
  - Fix any field or access bugs
- Done when: Manual generation assigns fields and restrictions correctly

**Day 29**
- Goal: Time rules and field sharing in manual mode
- Files: `scheduler_core_main.js`, `rules.js`, `scheduler_core_utils.js`
- Tasks:
  - Verify time rules: no activity placed outside its allowed window
  - Verify field sharing: multi-bunk field use only happens when allowed
  - Fix any violations
- Done when: Time rules and field sharing are clean in manual mode

**Day 30**
- Goal: Cloud save of manually generated schedule
- Files: `supabase_schedules.js`, `unified_schedule_system.js`
- Tasks:
  - After manual generation, verify schedule is saved to `daily_schedules` for all divisions
  - Reload the page — verify the schedule comes back correctly from cloud
  - Fix any save/load issues
- Done when: Manually generated schedule saves and reloads correctly

**Day 31**
- Goal: Schedule display and edit-after-generate
- Files: `master_schedule_builder.js`, `daily_adjustments.js`
- Tasks:
  - Verify the schedule grid shows all divisions correctly after generation — no blank slots, no wrong activity names
  - Make a daily adjustment to a generated schedule — verify it saves to cloud without corrupting the base schedule
  - Fix any display or corruption bugs
- Done when: Schedule displays correctly and daily adjustments save safely

**Day 32**
- Goal: Re-generation safety
- Files: `scheduler_core_main.js`, `unified_schedule_system.js`
- Tasks:
  - Generate a schedule, make some daily adjustments, then re-generate
  - Verify: re-generation updates cloud schedule correctly, doesn't stack old data on top of new
  - Fix any stale data or overwrite bugs
- Done when: Re-generation is safe and cloud data is clean

**Day 33**
- Goal: League games in manual mode
- Files: `master_schedule_builder.js`, `scheduler_core_main.js`, `scheduler_core_leagues.js`
- Tasks:
  - Configure a league, set up a skeleton with a league slot, run generation
  - Verify league game tiles are placed correctly in the schedule
  - Verify league assignments save and reload correctly from cloud
  - Fix any league placement or persistence bugs
- Done when: League games work correctly in manual mode

**Day 34**
- Goal: Multiple division generation
- Tasks:
  - Build different skeletons for 3+ divisions, run generation for all
  - Verify each division receives a correct and independent schedule
  - Verify all schedules save correctly to cloud (no division's data overwrites another's)
  - Fix any issues
- Done when: Multi-division manual generation is correct and cloud-safe

**Day 35**
- Goal: Edge cases
- Tasks:
  - Test: single-bunk division — generation works
  - Test: partial day skeleton (only morning blocks defined) — generation handles gracefully
  - Test: overlapping restrictions that make a slot impossible — scheduler handles without crash
  - Fix any crashes or incorrect outputs
- Done when: Edge cases handled gracefully

**Day 36**
- Goal: Full manual builder cloud verification
- Tasks:
  - Starting from a fresh session (clear local storage, log out and back in)
  - Build skeleton → generate → verify cloud save → reload → confirm all data intact (skeleton, schedule, league assignments)
  - Fix any gaps in the full cloud round trip
- Done when: Full manual builder round trip through cloud is verified end-to-end

---

### Phase 5 — Output & Consumption `Days 37–38`

**Day 37**
- Goal: Print center — both modes
- Files: `print_center.js`
- Tasks:
  - Print an auto-generated schedule (per-bunk mode) — verify all bunks appear, no truncation, league games render correctly (fuzzy slot lookup for consecutive games)
  - Print a manually generated schedule (slot-based mode) — verify all divisions appear, slots are correct
  - Fix any rendering or data lookup bugs in print
- Done when: Print center produces correct output for both builder modes

**Day 38**
- Goal: Calendar, daily adjustments, analytics, camp dates integration
- Files: `schedule_calendar_views.js`, `daily_adjustments.js`, `analytics.js`, `dashboard.js`
- Tasks:
  - Navigate the calendar across multiple dates — verify each date loads the correct schedule from cloud (not a cached wrong day)
  - Make daily adjustments on two different dates — verify each saves independently in cloud
  - Open the analytics/rotation report — verify rotation counts match what is stored in `rotation_counts` table
  - **[NEW from main]** Camp dates + calendar integration: verify camp dates (halves, transitions) display correctly in calendar views, transition week markers render as non-numbered markers, half boundaries are respected by period counting in auto/manual/rotation systems
  - Fix any date isolation or analytics accuracy bugs
- Done when: Calendar date isolation is correct, camp dates render properly, analytics match cloud data

---

### Phase 6 — End-to-End Hardening `Days 39–40`

**Day 39**
- Goal: Full end-to-end run for both modes
- Tasks:
  - **Auto Builder run:** fresh login → Me page setup (divisions, leagues, specials) → enter Flow → build layers → generate → verify schedule → print → reload and verify cloud
  - **Manual Builder run:** fresh login → Me page setup → enter Flow → build skeleton → generate → verify schedule → print → make daily adjustment → reload and verify cloud
  - Document any friction points or bugs found during the full runs
  - Fix critical bugs immediately, log minor ones
- Done when: Both full flow runs complete without errors

**Day 40**
- Goal: Cloud hardening and final polish
- Tasks:
  - **Multi-user test:** have two users (or two browser sessions with different accounts) edit simultaneously — verify no data corruption in `daily_schedules` or `camp_state_kv`
  - **[NEW from main]** Multi-user with scheduler roles: owner deletes a day while scheduler has it open — verify DELETE propagates via realtime. Scheduler clears their divisions — verify it doesn't clear owner's divisions. Test the scoped delete/clear operations end-to-end.
  - **[NEW from main]** Realtime sync stress: rapid edits from two sessions — verify the smart merge logic (no 60-second guard, cloud-empty clear, dedup) handles all cases without data loss or stale state
  - **Offline→online:** disconnect network, make schedule edits, reconnect — verify all changes reach Supabase
  - **Session persistence:** log out and log back in — verify entire state survives (camp structure, layers/skeleton, schedules, rotation counts, camp dates)
  - **Performance check:** measure schedule generation time, cloud save latency, page load time — flag anything over 5 seconds
  - Fix any issues found
- Done when: Cloud is bulletproof. App is ready for summer.
