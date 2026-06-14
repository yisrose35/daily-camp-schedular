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
- ✅ CB-6 + CB-18 + CB-112 [LIVE] supabase_schedules.js — scheduler save scope hardened (no ALL-divisions fallback; empty set returns {})
- ✅ CB-7 post_edit_system.js — added escHtml (CampUtils delegate + fallback); wrapped bunk/activity/field/location/conflict-bunk names in edit modal, conflict panel, drag tooltips, availability banner, add modal
- ✅ CB-8 [LIVE] scheduler_core_main.js:3891 — STEP 7.55 capacity sweep skips _isTrip entries (manual twin of FN-59). Owed: live manual trip-day gen
- ✅ CB-56 + CB-63 [LIVE] scheduler_core_utils.js:2592 — rebuild detects partial local scan (cloud counted dates absent locally) → merges raise-only + unions counted-dates instead of overwriting. Owed: quota/2-device verify
- ✅ CB-57 calendar.js:1430 — Erase-ALL now clears historicalCounts/historicalCountedDates/rotationHistory/manualUsageOffsets/swim+activity history (mem + globalSettings)
- ✅ CB-58 validator.js:937 — escMsg (escape + intentional-tag whitelist restore) at the <li> sink
- ✅ CB-59 auto_validator.js:643 — _avEscMsg at both error+warning <li> sinks (twin of CB-58)
- ✅ CB-60 campistry_me.js:141 — save() spreads existing campistryMe before overriding (preserves forms/customFields/locale/Stripe key)
- ✅ CB-61 [LIVE] schedule_calendar_views.js:339 — no eager currentScheduleDate set on cross-date nav (handler saves old date under correct key first). Owed: live date-nav-with-unsaved-edit verify
- ✅ CB-107 + CB-127 [LIVE] campistry_go.js:2348 — clearAll monitors/counselors/addresses no longer wipe the whole cloud state row (save() already persists correct state). Owed: 2-device GO verify

## MED (86) — after all HIGH
CB-9✅..17✅,19-29✅,30✅,31✅,32✅,33✅,34✅,35✅,36✅,37✅,39✅,40✅(+41,49,86,87),12,13,14,15,16,17,18,19,20,21,22,38(done w/CB-1),23,24,25,26,27,28,29,39,30,31,32,33,34,35,36,37,40,62,63,64,65,66,67,68,90,69,70,71,72,73,74,75,76,77,78,79,80,81,91,82,83,84,85,86,87,88,89,92,93,94,108✅,109✅,110,111,112,125,121,122,123,124,128

## LOW (44) — last
CB-41✅(w22),42✅,43✅,44✅,45✅,46✅,47✅,48✅,49✅,50✅,51✅,52✅,53✅,54✅,55✅,95✅,96✅,97✅,98✅,99✅,100✅,101✅,102✅,103✅,104✅(=CB-71),105✅,106✅,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145
- ✅ CB-95 scheduler_core_auto.js:21024 — Phase 4.9 prep-room geometry (_p49pbs) prefers durable window._perBunkSlots over clobbered window.divisionTimes._perBunkSlots (FN-14 pattern); was [] on 2nd+ in-session gen → prep recapture silently disabled
- ✅ CB-96 scheduler_core_utils.js:2831 — DOC: incrementHistoricalCounts/reIncrementHistoricalCounts dead-but-wired (no live caller; rebuildHistoricalCounts is authority + counts league sports differently). Comment warns against re-wiring; not removed (test dep)
- ✅ CB-97 dashboard.js:1152 — buildWeekMap emits week start/end via local-component fmtLocal (was toISOString → one-day-early in +UTC timezones)
- ✅ CB-98 dashboard.js saveCampDates/clearCampDates — owner-only isTeamMember write guard (mirrors saveProfile); UI was read-only but writers had no role check
- ✅ CB-99 division_times_integration.js:234 — migrateAssignmentsByTime carries spanned continuation slots with the head (was dropping them → multi-period special truncated to 1 slot). Path currently unwired
- ✅ CB-100 print_center.js:960 — deleteTemplate gated with canEditTemplates() like siblings (was mutating + returning true while persist silently no-op'd for schedulers)
- ✅ CB-101 print_center.js:~4822 — restore campistry_pc3_pack on load (was written on apply, never read back → pack showed inactive after reload)
- ✅ CB-102 + CB-105 campistry_me.js — grade rename/removal cascade now migrates campPeriods (Bell Schedule): rename block in _propagateGradeRenameTiles + new _purgeOrphanedCampPeriods wired into both saveDiv/deleteDiv sites. Was orphaning per-grade periods
- ✅ CB-103 division_selector.js:1 — DOC: dead module (DivisionSelector + rbac_integration.js loaded by no HTML). Header notes the unescaped-name XSS to fix if revived; not removed
- ✅ CB-106 analytics.js:204 — Field Availability Gantt resolves per-bunk slot geometry (._perBunkSlots[bunk] / window._perBunkSlots) before falling back to flat division array (raw-index mis-timed auto entries lacking inline times)
- ✅ CB-50 [LIVE] global_field_locks.js:610 — loadOtherSchedulerSchedules drops prior-date 'other_scheduler'-tagged locks from _locks before re-register (usage maps were reset but _locks leaked stale exclusive locks cross-date). Owed: 2-scheduler live verify
- ✅ CB-51 daily_adjustments.js editTile/copyTile — capture date at modal open, bail on tail save if currentScheduleDate changed (stale detached ev → silent no-op / cross-date write). Mirrors Day-25b drop-race hardening
- ✅ CB-52 post_edit_system.js:450,641,2214 + unified_schedule_system.js:3929,4311 — removed all 5 write-only `scheduleAssignments_<date>` + 2 `campDailyData_v1_<date>` mirrors (zero getItem reads repo-wide); canonical campDailyData_v1[date] map preserved as the real read/recovery path. Frees per-edit quota
- ✅ CB-53 [LIVE] daily_adjustments.js:5446 — loadDailyTrips merge: when both LS+cloud non-empty (legacy, Source 3 absent) prefer fromCloud (cross-device truth) over count-based, fixing deletion-resurrection; cloud-wipe recovery unaffected (else branch). Owed: 2-device legacy-trips verify
- ✅ CB-54 auto_field_locks.js:397 — getLockedFieldsAtTime mirrors FN-7: surface 'exclusive' OR 'division' locks with same-division skip (dead nested division-branch was unreachable). Inert today (no division locks created), correct for future

## Notes
- CB-38 fixed together with CB-1 (same root cause: window state leaking onto cross-date saves).
- Many [LIVE] fixes can't be fully verified without 2 accounts / network-blip / Supabase RLS repro — code fix lands, live verification owed (tracked in multischeduler_ms_fixes rig).
