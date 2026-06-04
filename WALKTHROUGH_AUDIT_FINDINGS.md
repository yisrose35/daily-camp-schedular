# New-Camp Manual-Mode Walkthrough + From-Scratch Code Audit — Findings
**Date:** 2026-06-04 · **Camp:** Camp Awesome (test) · **Mode:** Manual · **Audit run:** wf_f4aca24d-a8f (45 candidates → 12 confirmed, 1 refuted)

## Live walkthrough result (06-03 schedule, 35 bunks / 175 blocks)
- **Concern #1 — facility + rules honored PERFECTLY:** verified on the COMPLETE cloud-authoritative schedule — **0 violations** across capacity, sharing (same_division + cross_division allowedPairs), access restrictions, field time-rules, activity↔field match, and division time-windows. The only multi-bunk concurrency is legit (same-division special sharing within cap, + all-camp Lunch/Swim).
- **Concern #2 — rotation:** intra-day clean (0 bunks repeated an activity; 36 activities, healthy spread); engine tracks multi-day rotation (swimRotationHistory varies groups day-to-day, weeklyBunkMatrix by ISO week). Fresh-week confirmation needs USER gen-clicks.
- **Camper Locator:** works — finds campers, resolves bunk→scheduling-division correctly (Minors 1→Minors, not roster-parent Neranina), cross-output consistent with the grid.
- **Internals:** roster↔schedule perfect (35=35 bunks, all 347 campers in scheduled bunks); localStorage↔cloud self-heals on load (stale local corrected from authoritative cloud, 0 diff after).
- **Print Center:** renders clean (0 NaN/undefined). **BUT see FN-3.**
- **Not exercised live:** leagues (none in 06-03 data), zones + specialty leagues (0 configured in this camp).

## Confirmed bugs to fix (priority order)

### 🔴 HIGH
- **FN-1 · campistry_me.js:1233 · data-integrity.** Renaming a GRADE in the division-edit modal classifies the old name as a *removal* and purges that grade's manual skeleton tiles + auto-layer config + grade time-window, and never updates campers' `grade`. Division rename has `_propagateDivisionRename`; grade rename has the opposite (destruction). → Add `_propagateGradeRename` (carry skeleton/layers/times + rewrite camper.grade), mirroring division rename.
- **FN-2 · special_activities.js:115 · data-integrity.** `validateSpecialActivity` type allowlist `['not_sharable','same_division','custom','all']` omits **`cross_division`**, so any special using "Grade Pairs" sharing is silently reset to `not_sharable` cap 1 and its `allowedPairs` deleted — on load AND every save, then synced to cloud. The cross_division normalization block right below is dead code. → Add `'cross_division'` to the allowlist. (Field-level cross-division sharing is unaffected — only special-activity Grade-Pairs.)
- **FN-3 · print_center.js:427 · correctness.** Week-at-a-Glance `summarizeBunkDay` reads `entry.activity || entry._activity.name`, but `_activity` is a STRING everywhere → `.name` is always undefined and `.activity` is usually unset, so it drops nearly every activity and the weekly sheet prints essentially blank. → Read `entry._activity || entry.sport || entry.activity` (match `formatEntry`).

### 🟡 MEDIUM
- **FN-4 · auto_fill_slot.js:320 · correctness.** The single-slot Auto-Fill + last-ditch Free-slot fallback compare LIFETIME activity counts against per-PERIOD `maxUsage`/`exactFrequency` caps, so caps degrade into lifetime caps and progressively block needed activities later in a season. → Use a period window (mirror `getPeriodActivityCount`).
- **FN-5 · rotation_engine.js:993 (+ total_solver_engine.js:990) · correctness.** Manual-mode `rotationCohort` gate builds the cohort bunk set WITHOUT the access/eligibility filter the auto path uses, so an unreachable cohort member pins the cohort minimum at 0 and the special freezes after one visit per bunk (auto rotates fine). → Add the `isSpecialAvailableForBunk` filter to the manual cohort set.

### 🟢 LOW
- **FN-6 · campistry_me.js:1485.** `_purgeOrphanedBunks` deletes by raw bunk name; misses `grade:bunk` qualified keys when a bunk name is duplicated across grades → orphaned cloud rows (single-account only; multi-user prune covers it).
- **FN-7 · auto_field_locks.js:291 (PLAUSIBLE).** Dead nested `division`-lock branch inside an `exclusive`-only guard; latent (no code creates division locks in auto today) but would silently unenforce division electives if added.
- **FN-8 · rotation_engine.js:1404.** `mergeCloudData` backfills count/recency but not `recentStreak`/`recentWeek`, so streak escalation undercounts when local cache is incomplete (primary yesterday-penalty still fires).
- **FN-9 · scheduler_core_specialty_leagues.js:606.** Playoff TBD dedup key `TBD-TBD` collapses multiple forecast placeholders → only one field reserved for a multi-matchup undecided round.
- **FN-10 · scheduler_core_leagues.js:287.** `updateFutureSchedules` relabel indexes the wrong Set (`time_*` keys vs bare index) → multiple league games on a future date get duplicate game numbers in the per-bunk copy (authoritative grid stays correct).
- **FN-11 · scheduler_core_auto.js:17969.** multiPart per-part `name`/`location` (optional) are never honored at generation — slots always show `<base> N/M` at the base location.
- **FN-12 · schedule_calendar_views.js:311.** `hasSchedule` defined twice in one scope; later (correct) copy wins via hoisting, first is dead code.

## Still owed (USER-gated)
- Fresh **week** of manual generations (you click Generate for upcoming dates) → confirm rotation variety + rules across multiple days.
- Live **leagues / specialty leagues / zones** once configured in a real day.
- Full **Print Center pack** render (triggers OS print dialog).
