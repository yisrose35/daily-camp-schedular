# Daily Camp Scheduler — Audit Plan

Hand this file to a new chat and say "run slice N from `audit_plan.md`". The plan is built around **slice-by-slice audits**: one bounded subsystem at a time, each one finds issues, fix what's real, then drive the affected user-facing flow in a browser before moving on.

## Why slice-by-slice

A whole-codebase audit goes shallow. A single-file audit goes blind to seams. Slices the size of "one pipeline" or "one subsystem" are the sweet spot — deep enough to find silent bypasses, narrow enough to keep findings actionable.

The auto-pipeline slice (slice 3 below) was run on 2026-05-10 and found 17 issues, 6 HIGH severity. All fixed in commit `0361dd8d`. That same shape is what every other slice should produce.

## How to invoke a slice

In a new chat, paste this template, replacing `<SLICE_BLOCK>` with the slice's full text from below:

```
You are a senior code auditor for the daily-camp-schedular project at
C:\Users\yisro\daily-camp-schedular\ (branch Auto-Pipeline-Audit).

Read-only audit. Find bugs and logic gaps; do NOT fix anything yet.

<SLICE_BLOCK>

Output format — markdown punch list. Each finding:

### [Severity: HIGH/MED/LOW] One-line title
**File:** path:line-range
**What's wrong:** 2-3 sentences
**Why it matters:** 1 sentence
**Suggested fix:** 1-2 sentences

Group findings by audit goal. End with "Top 3 to fix first" and a
"Confirmed-good" section listing prior-fixed items that did NOT regress.
1500–3000 words; quality over quantity.
```

After the agent reports, fix the HIGHs (and MEDs that are cheap), commit each batch with a clear message, push, then drive the affected feature in a browser to confirm.

---

## Recommended order

Run **every** slice. The order below is highest-leverage-first; do not skip any. Slices 3 and 6 had prior partial passes — re-audit them in full to catch regressions and finish the items the prior runs deferred.

1. Cloud sync + persistence
2. Auth + Supabase RLS + secret exposure
3. Auto generation pipeline (re-audit; finish deferred items — see slice 3)
4. Manual builder + edit / undo / displacement
5. Rotation tracking + analytics
6. Deletion / cleanup paths (re-audit; cover surfaces beyond the patched three)
7. Calendar / day management
8. Leagues + playoffs
9. Daily adjustments + overrides + pinned activities
10. Facilities / fields / specials / general activities
11. Rendering + print path
12. XSS / input validation / user-supplied content
13. Cross-device + race conditions
14. Performance + bundle size
15. UI flows audit (manual, in-browser — not delegable)

---

## Slice 1 — Cloud sync + persistence

**Files in scope:** `cloud_sync_helpers.js`, `integration_hooks.js`, `app1.js` (sections that wrap saveGlobalSettings), `rotation_cloud.js`, any `ScheduleDB.*` definition, `migrations/*.sql`

**Audit goals:**

1. **`saveGlobalSettings` ladder.** Two layers wrap it (cloud_sync_helpers, integration_hooks). Trace every code path: which key types persist locally, which sync to cloud, which are batched, which fire `forceSyncToCloud`, and which silently no-op. Specifically check that `daily_schedules`, `app1`, `specialActivities`, `pinnedTileDefaults`, `historicalCounts`, `manualUsageOffsets`, `rotationHistory`, `locationZones`, `allSports`, `savedSkeletons`, `leaguesByName`, `schedulingRules` all reach Supabase eventually. Anything that only writes localStorage is a bug if it's user-editable config.

2. **Hash + dedupe gates.** `_lastDailySchedulesHash`, `_secondarySaveHash`, `_secondarySaveLog`. Verify hash inputs cover the fields that actually matter (e.g. if a user toggles a flag that doesn't change `scheduleAssignments`/`leagueAssignments`, will the hash still pick it up?). Verify dedupe windows don't silently drop legitimate rapid-fire saves.

3. **Cloud → local hydration.** When the app boots, in what order are `camp_state_kv`, `daily_schedules`, `rotation_counts` loaded? What happens if one fetch fails? Does the app silently render stale local state? Are there race windows where a save fires before hydration completes (clobbering cloud with stale local)?

4. **`_isAuthoritativeHandler` flag.** Verify the campistry_me.save() branching logic still chooses the fine-grained path. The flag was added to prevent stale-cache forceSyncToCloud overwrites. Confirm callers still respect it.

5. **Two-device behavior.** Device A saves, Device B has stale localStorage. Device B opens the app: does it pull the newer cloud state? When B then makes an edit, does it merge or clobber A's edit? Look for last-writer-wins patterns that lose data.

6. **Quota / size.** `localStorage.setItem('campDailyData_v1', ...)` has a quota fallback that prunes oldest dates. Is the fallback safe (does it run on every save attempt, or only error path)? Are large fields (logos, custom HTML) rejected before they bloat the save?

7. **`RotationCloud.deleteActivity`** (added 2026-05-10): verify it's called from every deletion path, not just the three patched ones.

**Known prior fixes — verify no regression:**

- `_writeGuardCache` removed in favor of live read.
- `applyPostEditCounts` is the single source of truth for per-bunk count delta.
- Cloud rotation_counts cleanup on activity deletion.
- `daily_schedules` saveGlobalSettings persists to localStorage AND fans out to cloud per-date.

---

## Slice 2 — Auth + Supabase RLS + secret exposure

**Files in scope:** `migrations/*.sql`, all `*.js` files for hardcoded keys / URLs, `AccessControl` references, `CampistryDB` setup, login / session / camp-id resolution code

**Audit goals:**

1. **RLS policies** for every table: `camp_state_kv`, `rotation_counts`, `daily_schedules`, `schedule_proposals`, and any others in `migrations/`. For each, can an unauthenticated client read? Write? Delete? Can a user read another camp's data? Are the SELECT/INSERT/UPDATE/DELETE policies symmetric (a write should imply you also see what you wrote)?

2. **Anon vs service keys.** Grep the codebase for keys (`eyJ...`, `service_role`, `SUPABASE_SERVICE`, `anon`). The anon key in client code is normal; a service-role key would be a critical leak. Verify the anon key has only the privileges RLS allows.

3. **`AccessControl.canEditSetup` / `canEraseData`.** Where is this checked? Where is it bypassed (just grep for write paths that don't gate). A malicious browser console can call any window function — RLS is the real defense, not client-side gates. But client-side gates should still be consistent so legit users don't trip them randomly.

4. **camp_id resolution.** How is the active `campId` determined? Can a user switch camps via URL, settings, or console? Does every Supabase query scope by `campId`, or do some leak across camps?

5. **XSS in user-supplied strings.** Camper names, bunk names, activity names, custom block names, special-activity names, field names, league names, playoff names. Any `innerHTML = userInput` is a vuln. Look for template literals concatenated into HTML, especially in the rendering / print / analytics paths.

6. **Print/export paths.** Print templates may render user content; verify HTML escape. Same for any CSV/JSON export.

7. **Session lifetime.** What happens after token expiry? Does the app surface re-auth, or silently fail saves to cloud while pretending success?

**Known prior fixes — verify no regression:**

- AccessControl gates on facilities save / delete.

---

## Slice 3 — Auto generation pipeline (re-audit)

**Files in scope:** `scheduler_core_auto.js`, `auto_solver_engine.js`, `rules.js`, `pinned_activity_preservation.js`, `rotation_engine.js`, `scheduler_core_utils.js`

**Status:** First pass on 2026-05-10 in commit `0361dd8d` found 17 issues; HIGHs and most MEDs fixed. Re-audit because:

1. **Verify no regression** of the fixes. Specifically: every `accessRestrictions.enabled` check is truthy (not `=== true`); every divisions lookup tries both `String(grade)` and `grade`; `fallbackSweep` routes through `commitWriteIfLegal`; `_validateWritePlacement` reads live; BFS helpers use `_bfsShareLegal`; `commitWriteIfLegal` calls `SchedulingRules.isCandidateAllowed`; sport-override picker prefers rule-passing courts.

2. **Finish deferred items** from the first pass:
   - Per-slot rotation re-score in Phase-3 picker (priority list built once with `beforeSlotIndex: 0` is stale by the time later slots are picked).
   - `bunkActivities` map centralization across all repair phases (each helper currently rebuilds its own; same-day duplicates can slip in).
   - Narrowness-first ordering for specials pre-place (sort by `restrictionWidth = numGrades * numFields` ascending).
   - `_findValidAlternativeField` index optimization (currently O(F × B × S) per rescue; build a `fieldUsageBySlot` index once per safety-net pass).
   - Field Quality Group ranking (`rules.js:583-826` defines it; no consumer reads `field.fieldGroup` / `field.qualityRank`).
   - `getActivityCount` case normalization (mixed-case `historicalCounts` vs `manualUsageOffsets` keys can desync).
   - `pickFillActivity` cache invalidation after writes (later picks see pre-first-pick rotation state).

3. **Look for new issues** — anything the first pass missed.

Use the same audit goals from the original prompt: grade/access on every write path, sharing rules at every gate, rules.js propagation through every phase, rotation correctness, placement intelligence (most-constrained-first, no quadratic blow-ups, no stale caches).

---

## Slice 4 — Manual builder + edit / undo / displacement

**Files in scope:** `scheduler_core_main.js`, `scheduler_core_utils.js` (the helpers manual gen uses), `unified_schedule_system.js`

**Audit goals:**

1. **Manual write paths.** Every place a user click writes to `scheduleAssignments`. Do they all go through a guard that checks accessRestrictions / timeRules / sharing rules / Unavailable / FieldCombos? `commitWriteIfLegal` exists for the auto pipeline; is there an equivalent for manual? If not, manual edits can land violations the auto pipeline won't.

2. **`applyMultiBunkEdit`.** When the user edits multiple bunks at once, does each placement get individually validated? Does displacement (kicking another bunk off a field) follow rules?

3. **`displacement` / `AutoRebalance`.** When manual edit displaces an existing assignment, where does the displaced bunk go? Does it route through the same fill picker as auto, or use a less-validated path?

4. **Undo.** Multiple edits in a row, undo three times — does state perfectly reverse? Are rotation counts rolled back? (Counts went through `applyPostEditCounts`; verify undo also calls it with negative deltas.)

5. **Save flow.** `saveSchedule` triggers `rebuildHistoricalCounts`. Is there any edit path that mutates `scheduleAssignments` without triggering save, leaving cloud out of sync with local?

6. **Field/Activity rename.** When a field or activity is renamed, are existing scheduleAssignments updated? Both for today and for past saved days?

7. **Pin / unpin.** Pinning a tile, then changing the underlying field's accessRestrictions to exclude the bunk's grade — does the next gen drop the pin? (`pinned_activity_preservation.js` should handle this; verify.)

**Known prior fixes — verify no regression:**

- `saveSchedule` no longer double-counts (removed reIncrement).
- `applyMultiBunkEdit` routes counts through `applyPostEditCounts`.
- `pinned_activity_preservation.capturePinnedActivities` drops pins where access excludes the bunk grade.

---

## Slice 5 — Rotation tracking + analytics

**Files in scope:** `rotation_engine.js`, `rotation_cloud.js`, `analytics.js`, `scheduler_core_utils.js` (sections for `applyPostEditCounts`, `rebuildHistoricalCounts`, `getValidActivityNames`)

**Audit goals:**

1. **`historicalCounts` source of truth.** Should always equal sum of `scheduleAssignments` across all saved days plus `manualUsageOffsets`. Verify `rebuildHistoricalCounts` produces that. Any code that mutates `historicalCounts` directly without using `applyPostEditCounts` is suspicious.

2. **`rotationHistory.bunks`.** Timestamps per (bunk, activity). When are entries added? Removed? Should removal happen on undo / day-deletion / activity-deletion?

3. **Cloud merge.** `rotation_engine.mergeCloudData` excludes today's row to avoid stale-vs-live races. Does it also handle multi-day generation correctly (gen for tomorrow while today's row is fresh)?

4. **Counts → picker.** Both manual and auto pickers consult counts for "least-recent" preference. Is the consultation read-once-at-start or refreshed per slot? (Audit slice 3 flagged this as MED-LOW; not fixed.) For multi-bunk same-grade picks, does each bunk see the others' just-placed picks?

5. **Adjust column UI.** User edits offset for (bunk, activity). Does the change persist locally, sync to cloud, and immediately affect the next pick? If two devices edit the same offset concurrently, what happens?

6. **Analytics tab listeners.** `campistry-generation-complete` event — is it fired from every gen path (auto, manual, regen, partial regen, undo)? If not, the analytics tab shows stale data after some operations.

7. **Half/season reset.** `RotationCloud.clearAll` — when invoked, does local `historicalCounts` / `rotationHistory` / `manualUsageOffsets` also clear? Or do they desync after reset?

**Known prior fixes — verify no regression:**

- Cloud rotation cleanup on activity deletion.
- `mergeCloudData` excludes today's row.
- `applyPostEditCounts` is single-write-path for count deltas.
- Generation-complete listener in analytics.

---

## Slice 6 — Deletion / cleanup paths (re-audit)

**Status:** First pass on 2026-05-10 in commit `4919ba66` patched field/special/general activity deletion. Re-audit because the prior pass focused on three deletion paths; this slice covers all surfaces.

**Files in scope:** `facilities.js` (cleanupDeletedField, cleanupDeletedSpecial, cleanupDeletedGeneral, cleanupRotationTracking, deleteFacility, X-button handlers), `app1.js` (camper / bunk / grade / division delete, sport delete via `removeGlobalSport`), `calendar.js` (day delete, half reset), `cloud_sync_helpers.js`, every league/playoff delete site

**Audit goals:**

1. **Field / Special / General delete** (already audited 2026-05-10 in `4919ba66`). Verify the three cleanup helpers still cover: daily_schedules slot purge, manualSkeleton items, locationZones, activityProperties, registry purge, pinnedTileDefaults, historicalCounts, manualUsageOffsets, rotationHistory.bunks, cloud rotation_counts. Spot-check one of each type with `checkActivityRemoved(name)` (helper script saved to memory).

2. **Sport delete.** `removeGlobalSport(sportName)` — does it also remove the sport from every field's `activities` array, every saved scheduleAssignments slot, sportMetaData, daily disabled-sports lists, AND rotation tracking?

3. **Camper / Bunk / Grade / Division delete.** When a camper moves bunks or a bunk is deleted entirely, what happens to: scheduleAssignments keyed by that bunk, rotation tracking, leagues that reference the bunk, playoff brackets, manualUsageOffsets, accessRestrictions bunk-allow-lists in fields/specials. Anything that holds a bunk name as a string can become orphaned.

4. **Day delete.** Calendar.js delete-a-day flow. Does it remove from local `daily_schedules`, cloud `daily_schedules` row, `rotation_counts` rows for that date, `schedule_proposals` for that date, leagueAssignments? `tests/calendar_delete_reset.test.js` exists — check coverage.

5. **Half / Season reset.** Local + cloud purge of all rotation data, scheduleAssignments, leagues, playoffs. Each has its own surface; verify a single reset handles all of them or document what survives.

6. **League / Playoff delete.** Removing a league mid-season — what happens to past leagueAssignments referencing it, saved standings, playoff brackets that drew from it?

7. **Facility type-toggle.** Toggling `usedFor.includes('special')` off without deleting the facility — should that purge the special's references? (Currently it doesn't.) Same for `general` and `sports` toggles.

**Known prior fixes — verify no regression:**

- `cleanupDeletedSpecial`, `cleanupDeletedField` comprehensive purges.
- `cleanupDeletedGeneral` mirrors special path.
- `cleanupRotationTracking` wipes 4 surfaces + cloud.

---

## Slice 7 — Calendar / day management

**Files in scope:** `calendar.js`, integration with `daily_schedules` cloud table

**Audit goals:**

1. **Day creation.** Creating a date that already has a saved schedule — overwrite, merge, or reject?
2. **Day delete.** Already covered in slice 6.
3. **Date format consistency.** Anywhere `YYYY-MM-DD` is parsed — verify timezone handling. A user in PST creating a schedule near midnight should see consistent dates.
4. **Multi-day operations.** Bulk-copy yesterday's schedule to today; bulk-clear a week; multi-day league setup. Each should respect the same rules as single-day operations.
5. **Rainy-day toggle.** Per-date rainy flag. Does it flip indoor/outdoor field availability everywhere (auto pipeline, manual builder, rendering)?
6. **Calendar overrides.** `dayData.overrides.disabledFields` — when does it apply, when is it cleaned, who reads it?

---

## Slice 8 — Leagues + playoffs

**Files in scope:** `scheduler_core_leagues.js`, `scheduler_core_specialty_leagues.js`, `playoff_hub.js`, `specialty_leagues.js`

**Audit goals:**

1. **League CSP.** League scheduling has its own CSP. Does it consult the same rules.js cooldowns, accessRestrictions, timeRules, sharing rules as the main pipeline? (Auto-pipeline audit flagged that league CSP calls `isFieldAvailable` directly, which is now hardened — verify.)
2. **Round-robin / bracket construction.** Edge cases: odd team counts, byes, forfeits.
3. **Cross-grade leagues.** A league spanning grades 4–6: does each bunk's grade-specific access still apply per match?
4. **Playoff seeding.** Standings → bracket. What if standings are tied? What if a team is deleted mid-tournament?
5. **Specialty leagues.** Differences from regular leagues — verify the rule application is consistent or intentionally different.
6. **Persistence.** League / playoff state lives in cloud kv? Verify save/load paths.

---

## Slice 9 — Daily adjustments + overrides + pinned activities

**Files in scope:** `daily_adjustments.js`, `pinned_activity_preservation.js`, override-handling sections of `scheduler_core_auto.js` (Phase 0)

**Audit goals:**

1. **Override types.** `disabledFields`, `disabledSports`, custom overrides. For each, verify Phase 0 reads it, the auto pipeline respects it through every phase, and the manual builder also respects it.
2. **Pinned activities.** Capture, restore, validation. The `capturePinnedActivities` already drops pins where access excludes the bunk; verify other rule violations (timeRules, disabledSports, sharing) are also handled at capture or restore.
3. **Custom blocks.** User-defined non-sport non-special activities. Where do they live (`block._customField`, `block._customActivity`)? Are they written to the right slots, persisted across reloads, and counted in rotation?
4. **Lock semantics.** `_fixed`, `_pinned`, `_activityLocked`, `_bunkOverride` — what's the precedence? Can a regen blow away a `_fixed` block?

---

## Slice 10 — Facilities / fields / specials / general activities

**Files in scope:** `facilities.js`, `app1.js` field-management sections

**Audit goals:**

1. **Facility CRUD.** Create, edit, rename, delete. Each operation's effect on local + cloud + cache.
2. **Type toggling.** sports / special / general flags — see slice 6 finding about toggle-off not purging.
3. **Field rename.** Mentioned in slice 4. Verify here too.
4. **Sharing rule editor UI.** Does the editor enforce sane combinations (capacity ≥ 1 for not_sharable, allowedDivisions non-empty for custom)?
5. **Access restriction editor.** Does the bunk picker stay in sync with current divisions/bunks lists when those change?
6. **TimeRules editor.** Available + Unavailable rules can overlap. Does the auto pipeline handle conflicting rules deterministically?
7. **`saveData` / `syncAllToLegacy`.** Confirm the round-trip from `facilities` array to `app1.fields` + `specialActivities` + `pinnedTileDefaults` is lossless. Anything dropped in translation is a silent bug.

---

## Slice 11 — Rendering + print path

**Files in scope:** schedule grid renderer (search for `renderSchedule`, `transposed`, the recently-polished view from commit `86601114`), print template code, any export

**Audit goals:**

1. **Grid rendering.** Bunks × time-slots layout. Empty slots, swim, leagues, specials, custom blocks, transitions, continuation slots. Each renders the right cell, color, label, font size.
2. **Transposed view.** The recently-polished view. Same correctness as main grid? Does it handle every block type?
3. **Cell merging for grade-wide activities.** User flagged this for swim/leagues — separate feature, not strictly an audit item.
4. **Print template variables.** Camper names, bunk names, dates, logos. All HTML-escaped (see slice 2).
5. **Mobile responsiveness.** Does the grid render usably on phone widths?
6. **Continuation block display.** Multi-slot blocks (a 90-min sport across two 45-min slots) should visually span, not show duplicated text.

---

## Slice 12 — XSS / input validation / user-supplied content

**Files in scope:** every renderer that interpolates user-supplied strings into HTML, every save handler that accepts free-text input. Search the codebase for `innerHTML`, template literals containing user content, any `document.write`-style sinks.

**Audit goals:**

1. **Free-text input surfaces.** Camper names, bunk names, division/grade names, activity names (sport/special/general/custom), field names, league names, playoff names, skeleton names, custom block titles, print-template caption fields, schedule notes. For each: where the value is read, where it is rendered.

2. **Render-side escape.** For every render site, confirm the value is set via `textContent` or escaped via an `escapeHtml`-style helper, NOT via `innerHTML += "<div>" + name + "</div>"`. The `escapeHtml` helper already exists (search for it); enforce its consistent use.

3. **Print/export paths.** Print templates, CSV export, JSON export. Print is especially risky because it often builds HTML strings.

4. **Camp/user-scoped data crossing camps.** If user A's input ever renders inside user B's session (shared camp, multi-tenant), an XSS payload becomes cross-account. Verify camp_id scoping in renderers.

5. **Stored vs reflected.** Most XSS here would be stored (saved to cloud, rendered on every load). Identify any field that is rendered without escape AND saved without sanitization — that pair is the live vulnerability.

6. **HTML in legitimate fields.** Any field that intentionally accepts HTML (camp logo, custom message templates) — verify allowed tags are whitelisted, not permissive.

---

## Slice 13 — Cross-device + race conditions

**Files in scope:** save/load flow, cloud sync helpers, hash gates

**Audit goals:**

1. **Concurrent edit on same day.** Device A and B both editing today's schedule. Last-writer-wins is the documented model? Or merge? Verify behavior matches expectation.
2. **Save during regen.** User clicks Generate, then immediately edits a field config. Does the in-flight regen see the new config or the old? Does the save race the regen's write?
3. **Cloud disconnect mid-save.** Network drops between save start and save complete. Does the app retry? Surface the failure? Silently lose the edit?
4. **Cache invalidation.** `RotationCloud._cache`, `_secondarySaveHash`, `_writeGuardCache` (removed), any others. After a delete or rename, are caches invalidated correctly?

---

## Slice 14 — Performance + bundle size

**Files in scope:** entire app

**Audit goals:**

1. **Generation time.** On a large camp (40 bunks × 15 slots × 20 fields), how long does auto gen take? Profile if >5s.
2. **Memory growth.** Open the app, generate 30 days in a row — does memory plateau or grow?
3. **Bundle size.** Total JS size. Tree-shake opportunities.
4. **Localstorage size.** How much does `campDailyData_v1` grow over a season?
5. **Quadratic blow-ups.** Any nested loop over (bunks × slots × fields × activities) that runs per-slot?

---

## Slice 15 — UI flows audit (manual, in-browser)

**Not delegable to an agent.** Drive the app yourself.

Pre-built test scenarios:

1. Fresh camp setup: 1 grade, 4 bunks, 5 sports, 2 specials, 5 time slots. Generate. Edit one slot. Save. Reload. Confirm everything persisted.
2. Mid-season edit: Open a saved week, edit Tuesday, regenerate Wednesday only. Confirm Tuesday's edits survive.
3. Large camp: 6 grades, 30 bunks total, 20 sports, 8 specials. Generate. Watch console for warnings.
4. Restrictive setup: a field with accessRestrictions for grade 3 only, then assign that field's sport to a grade-1 bunk via override. Confirm the sport-override picker behaves.
5. Rainy day: toggle, regen, confirm no outdoor fields used. Toggle off, regen, confirm outdoor returns.
6. Two-device test: edit on device A, open device B, confirm sync. Edit B, switch to A, confirm.
7. Activity rename mid-season: rename "Hockey" to "Floor Hockey" in facilities. Old days should reflect the rename or stay readable.
8. Delete a heavily-used activity, regen tomorrow, confirm the deletion didn't leave residue (`checkActivityRemoved` reports 0 hits).
9. League setup: create a 4-team round-robin in grade 4. Generate the season. Confirm matchups don't double-book fields.
10. Print: print a schedule, scan visually for any rendering oddity (overlapping text, missing labels, wrong colors).

For each scenario, write down: expected behavior, observed behavior, delta. The deltas become your fix list.

---

## What this plan deliberately doesn't cover

- **A11y / WCAG audit.** This is an admin tool, not a public site. Worth a separate pass eventually but not in the top 15.
- **Internationalization.** No evidence the app supports multiple languages currently.
- **Test coverage / unit testing.** A `tests/` folder exists but the audit is about correctness, not coverage. Adding tests is a follow-up.
- **Code style / linting.** Out of scope; these are correctness audits.

---

## When you're done with all slices

Re-audit slice 3 (auto pipeline) once a quarter. Pipelines drift. The two prior bugs that introduced regressions ("`enabled === true`" and "stale write-guard cache") both happened *after* fixes were in place, because new contributors didn't know the pattern. Treat slice 3 as recurring.

Same for slice 1 (cloud sync) — the persistence layer is where silent data loss lives.
