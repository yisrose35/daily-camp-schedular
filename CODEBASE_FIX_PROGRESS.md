# Codebase Audit Fix Progress

Fixing all 145 CB findings from CODEBASE_AUDIT_FINDINGS.md, highest severity first, one at a time, committed as we go. Resumable: if interrupted, continue from the first ⬜ below — do NOT restart.

Branch: `Daily-Audit-Walkthrough` (commit/push DAW only; never main without authorization).
Verify each fix with `node --check`. Mark ✅ when committed. `[LIVE]` items get the code fix + a note that live verification is still owed.

## HIGH (15)
- ✅ CB-1 supabase_schedules.js:973 — divisionTimes/geometry from passed payload not live window (+ CB-38 folded in)
- ✅ CB-2 supabase_schedules.js:485 — transient query error ≠ "no records" (_queryErrored tag; 3 delete-on-empty sites guarded)
- ✅ CB-3 schedule_orchestrator.js:381 — slim restricted to past in-window dates only; future/out-of-window dates untouched; LOCAL_ONLY_FIELDS preserved
- ✅ CB-4 [LIVE] schedule_orchestrator.js:848 — mergeCloudRecords now delegates to ScheduleDB.mergeSchedules (MS-3/4c/#V2-25); local loop kept as fallback; auto/skeleton/rainy signals layered back. Owed: 2-account live verify
- ✅ CB-5 [LIVE] scheduler_core_main.js:1665 — STEP 0f slim restricted to past in-window dates; LOCAL_ONLY preserved on slim. Owed: live manual-gen verify
- ⬜ CB-6 supabase_schedules.js:336 [LIVE] — scheduler save filter falls back to ALL divisions
- ⬜ CB-7 post_edit_system.js:746 — no HTML escaper (broad XSS)
- ⬜ CB-8 scheduler_core_main.js:3893 [LIVE] — STEP 7.55 demotes off-site trips
- ⬜ CB-56 scheduler_core_utils.js:2592 [LIVE] — rebuildHistoricalCounts whole-key overwrite from partial scan
- ⬜ CB-57 calendar.js:1430 — Erase ALL leaves stale local historicalCounts/rotationHistory
- ⬜ CB-58 validator.js:937 — manual validator modal XSS
- ⬜ CB-59 auto_validator.js:643 — auto validator modal XSS
- ⬜ CB-60 campistry_me.js:141 — save() strips forms/customFields/locale/Stripe key
- ⬜ CB-61 schedule_calendar_views.js:339 [LIVE] — day-view nav defeats cross-date save guard
- ⬜ CB-107 campistry_go.js:2348 [LIVE] — clearAll* wipes whole cloud state row

## MED (86) — after all HIGH
CB-9,10,11,12,13,14,15,16,17,18,19,20,21,22,38(done w/CB-1),23,24,25,26,27,28,29,39,30,31,32,33,34,35,36,37,40,62,63,64,65,66,67,68,90,69,70,71,72,73,74,75,76,77,78,79,80,81,91,82,83,84,85,86,87,88,89,92,93,94,108,109,110,111,112,125,121,122,123,124,128

## LOW (44) — last
CB-41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,95,96,97,98,99,100,101,102,103,104,105,106,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145

## Notes
- CB-38 fixed together with CB-1 (same root cause: window state leaking onto cross-date saves).
- Many [LIVE] fixes can't be fully verified without 2 accounts / network-blip / Supabase RLS repro — code fix lands, live verification owed (tracked in multischeduler_ms_fixes rig).
