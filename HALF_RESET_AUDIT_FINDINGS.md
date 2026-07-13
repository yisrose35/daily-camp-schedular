# Half Reset — Deep Audit Findings

> **IMPLEMENTATION STATUS (2026-07-12): SHIPPED.** The non-deleting epoch reset
> described in §4 is implemented (all changes carry `★ HR-n` comments; grep `HR-`).
> Owner decisions locked during implementation:
> 1. **Cooldowns reset** at the epoch (pre-epoch visits never block).
> 2. **Multi-part sequences restart** at part 1.
> 3. **Epoch = going-forward date** (revised 2026-07-13 from boundary snapping):
>    if a schedule already exists for TODAY at reset time (local or cloud),
>    today is pushed back into the previous half → counting restarts TOMORROW;
>    otherwise (first-morning reset) counting restarts TODAY.
> 4. **COMPLETE reset** (revised from the §5.4 recommendation): bunks get new
>    campers at the half, so even the short-term variety heuristics
>    (yesterday-repeat, 14-day recency/streak, league adjacent-day rematch and
>    forward-sport guards) treat pre-epoch days as nonexistent.
> 5. **Owner-only** — the scheduler-scoped destructive variant is retired.
>
> Mechanism shipped: `rotationEpoch` in `camp_state_kv` (+ the dormant
> `app1.halfStartDate` hook now written), merge-surviving `_epochDate` inside
> both league-history blobs (adopt-max), `dateKey >= epoch` filters at every
> site listed in §4 (incl. the two self-healing daemons), epoch-scoped flat
> aggregate rebuilds, `SchedulerCoreLeagues.setHistoryEpoch` /
> `SchedulerCoreSpecialtyLeagues.setHistoryEpoch` /
> `LeaguesAPI.resetStandingsAndPlayoffs` / `SpecialtyLeaguesAPI.resetStandingsAndPlayoffs`,
> `window.saveLeaguesData` exposed (fixes F3), and a rewritten owner-only
> `startNewHalf` (calendar.js) that deletes NOTHING — schedules, `rotation_counts`
> rows and `league.games` stay as a filtered archive, making the reset reversible.
> Tests: `tests/calendar_delete_reset.test.js` rewritten for the new semantics.

**Date:** 2026-07-12
**Scope:** The "Start New Half" feature (`calendar.js:509` `window.startNewHalf`, button `flow.html:362`) and every system that would have to respect a **non-deleting** half reset — rotation counters, usage caps, cooldowns, multi-part specials, rotation events, regular + specialty leagues, playoffs, standings, and the cloud-sync/merge machinery.
**Method:** Four parallel deep-read audits (rotation counters, leagues, specials/cross-day constraints, the reset implementation itself), findings cross-verified against the code. Every claim cites `file:line`.

---

## 0. The concept — validated

The requested behavior is a classic **epoch reset** (a "counting watermark"):

> From date X forward, the camp behaves as if it is day 1 — rotation fairness, usage caps, league game numbers ("Game 1"), matchup history, standings, playoffs all restart — **but nothing is deleted**. Pre-reset schedules remain saved, viewable, and printable.

The concept is coherent and implementable. Two facts about the current codebase frame everything below:

1. **The current "Start New Half" is the opposite of this concept.** It is a destructive reset: the owner branch deletes every `daily_schedules` row from Supabase (`calendar.js:654-657`) and wipes local daily data (`calendar.js:646`); the scheduler branch strips the scheduler's bunks out of every saved schedule (`calendar.js:542-560`). The confirm dialog even promises it ("✓ All generated daily schedules", `calendar.js:625`).
2. **The epoch mechanism already half-exists, dormant.** `Utils.getPeriodStartDate('half')` falls back to `app1.halfStartDate || currentHalfStart || sessionHalfStart` (`scheduler_core_utils.js:2563`), and the auto planner's `getHalfStartDate` reads the same chain (`scheduler_core_auto.js:1301-1313`) — but a repo-wide search shows **nothing ever writes any of those keys**. Likewise the league merge layer already supports reset markers (`_resetAt`, `_countersResetAt`, `_tombstones` in `mergeLeagueHistories`, `scheduler_core_leagues.js:54-234`) — but `startNewHalf` doesn't use them (only the console-only `window.resetLeagueHistory` at `scheduler_core_leagues.js:4815-4834` does).

**Critical architectural insight:** the whole codebase is built on the assumption that "reset" == "schedules are gone." Multiple self-healing daemons deliberately **rebuild counters and league history from saved schedules** (that was the point of recent commits `098c8e9` "saved schedules are the backstop", `b81332b` "schedule-sourced history healing"). A naive non-deleting reset — clear the counters, keep the schedules — is therefore **self-undoing**: the healing machinery resurrects everything within one generation, one cloud sync, or at most one day. The design must be *filter-at-read* (epoch watermark), not *clear-the-stores*.

---

## 1. Executive summary

| # | Verdict |
|---|---|
| 1 | The current `startNewHalf` is destructive AND buggy even on its own terms — 4 critical/high bugs mean parts of the promised reset silently don't happen (§2: F1, F2, F3, F10, F18). |
| 2 | A naive non-deleting reset (clear counters, keep schedules) is impossible in the current architecture — at least **seven independent resurrection channels** rebuild cleared state from kept schedules (§3). |
| 3 | The correct design is a **`rotationEpoch` dateKey watermark**: stored in `camp_state_kv`, written into the dormant `halfStartDate` hook, embedded as a merge-surviving field in both league history blobs, and enforced as a `dateKey >= epoch` filter at ~6 choke points plus ~25 direct scan sites (§4). |
| 4 | A handful of constraints have **debatable semantics at the boundary** (physical cooldowns, mid-sequence multi-part specials, mid-week caps, day-1 back-to-back checks) and need explicit product decisions before implementation (§5). |
| 5 | Existing tests cannot catch any of the above — the browser harness is broken outright and the node suite mocks away the sync layer where the worst bugs live (§6). |

---

## 2. Part A — Bugs in the CURRENT `startNewHalf` (as shipped)

These are correctness bugs in the existing destructive reset, independent of the redesign. Ranked by severity.

### Critical

**F1. Today's schedule resurrects itself immediately after the owner reset.**
The owner branch never clears the in-memory schedule (`window.scheduleAssignments` / `window.leagueAssignments`) — unlike the scheduler branch, which calls `clearBunksFromGlobals` (`calendar.js:603`). When `window.location.reload()` fires (`calendar.js:723`), the `beforeunload` final-save hook (`integration_hooks.js:3086-3151`) sees a populated in-memory schedule, synchronously **rewrites `campDailyData_v1`** (the key the reset just removed at `calendar.js:646`) and re-upserts today's `daily_schedules` row via `ScheduleDB.saveSchedule` (`integration_hooks.js:3150`, guard in `supabase_schedules.js:871-897` passes because the date matches). Net: after "Start New Half," the current day's schedule is back locally (always) and back in the cloud (whenever the keepalive lands).

**F2. The league-history cloud clear is silently merged away.**
`clearCloudKeys(['leagueHistory','specialtyLeagueHistory',…])` (`calendar.js:666-676`) queues bare `{}` values. But `executeBatchSync`'s LG-8 merge step (`integration_hooks.js:798-823`) fetches the current cloud row and merges the outgoing value with it. `mergeLeagueHistories` (`scheduler_core_leagues.js:54-234`) treats a bare `{}` as a lineage with `_savedAt: 0`, **no `_resetAt`, no tombstones** — so the merge adopts every (league, date) from the old cloud copy and writes the full pre-reset history straight back. Same for `mergeSpecialtyHistories` (`scheduler_core_specialty_leagues.js:41-157`). The dialog's promise "League game counters back to Game 1" (`calendar.js:623-624`) is therefore false — game numbering continues from the old half. The codebase already documents the correct pattern: `window.resetLeagueHistory` writes `_resetAt` precisely because "a bare {} would be resurrected by any stale copy" (`scheduler_core_leagues.js:4815-4834`). `startNewHalf` doesn't use it. (`SpecialtyLeagues.resetHistory` at `scheduler_core_specialty_leagues.js:1892-1902` has the same bare-`{}` bug.)

### High

**F3. Regular-league standings/playoff reset never persists — `window.saveLeaguesData` does not exist.**
`calendar.js:703-707` mutates `window.leaguesByName` standings/playoffs in memory, then guards `if (typeof window.saveLeaguesData === 'function')`. `saveLeaguesData` is module-private inside the leagues.js IIFE (`leagues.js:381`) and is never assigned to `window` (verified repo-wide: the only `window.saveLeaguesData` references are the two guarded call sites, `calendar.js:707` and `playoff_hub.js:95`). The guard silently no-ops, the page reloads, and cloud `leaguesByName` still carries every team's first-half W/L/T and bracket. LG-10 fixed only the specialty side (`window.saveSpecialtyLeaguesData`, `specialty_leagues.js:2418-2420`).

**F4. Standings reset wouldn't stick even if F3 were fixed — `league.games` is never cleared.**
`standings` is fully derived from `league.games` by `recalcStandings` (`leagues.js:2583-2680`), and `games` retains every pre-half game. The next score entry or generation sync (`leagues.js:2866, 2889`) rebuilds first-half W/L/T into the "reset" standings. Specialty mirror: `specialty_leagues.js:1237/1738/2514`.

**F5. Scheduler branch: the entire cloud read-modify-write loop has zero error handling.**
`calendar.js:542` discards the select `error` (a failed read looks like "no records"); per-record `.delete()`/`.update()` results (`calendar.js:554-558`) are ignored. Any mid-loop failure → local state is wiped anyway, the success alert shows, the cloud still holds the bunks, and reload re-hydrates them from cloud (`supabase_sync.js:390-449`). The sibling `deleteBunksFromAllRecords` received exactly this fix (CB-74, `calendar.js:896-929` with `writeFailures` tracking) — never applied here.

**F6. A full reset does not survive a second open device.**
Realtime DELETE handling only acts on the currently-viewed date (`supabase_sync.js:944-952`); device B's `campDailyData_v1` keeps all other dates, and B's `beforeunload` final save, offline-queue replay (`supabase_sync.js:1011-1034`), or any stale-date edit re-pushes full rows. For KV keys, hydration's newer-wins merge (`integration_hooks.js:1906-1927`) and whole-key last-writer-wins saves let B's stale copies beat the reset — and for league history, the hydrate-leg merge (`integration_hooks.js:1942-1955`) unions B's old history back **without B making any edit** (consequence of the missing `_resetAt`, F2). Only a marker/tombstone design survives multi-device; the machinery exists and is unused.

### Medium

**F7. Scheduler branch league scrub is a structural no-op.** It deletes `myBunks` keys from `leagueAssignments` (`calendar.js:546-551, 568-571`), but `leagueAssignments` is keyed by **division**, not bunk (`scheduler_core_leagues.js:4658, 537-543`) — the deletes never match anything. Their divisions' league tiles survive in every saved schedule; league history, `leagueRoundState`, standings, playoffs are untouched entirely (the scheduler dialog also doesn't promise league resets — but if divisions map to their own leagues this is a functional hole).
**F8. Specialty standings save races the reload.** `saveData(true)` defers the cloud push to `setTimeout(…, 100)` (`specialty_leagues.js:632-655`); `alert()` + immediate reload frequently kills the timer; the keepalive fallback needs a previously-cached token and a <60 KB body (`integration_hooks.js:855-863, 3158-3193`).
**F9. Specialty registry may be empty when reset runs.** The loop iterates `window.specialtyLeagues` (`calendar.js:708-712`), which is only hydrated on demand (`specialty_leagues.js:78-79`); a session that never opened the Specialty tab resets nothing there.
**F10. Failure atomicity: everything is swallowed, success alert always shows.** The Supabase delete error is only logged (`calendar.js:658`); `RotationCloud.clearAll()` returns `false` on error, ignored (`calendar.js:695`, `rotation_cloud.js:443-466`); `clearCloudKeys` returns true even when the batch sync re-queued on failure (`integration_hooks.js:890-905`); `forceSyncToCloud` returns true without syncing pre-hydration (`integration_hooks.js:916-919`). And localStorage is wiped **first** (`calendar.js:641-646`) — the damage-minimizing order (verified cloud ops first, local wipe last) is inverted.
**F11. Empty-record delete destroys other bunks' league data** (scheduler branch): when `scheduleAssignments` empties, the whole row is deleted (`calendar.js:553-554`) even if `leagueAssignments` still holds other divisions' entries. Related: the `modified` flag ignores league-only changes (`calendar.js:550`), so a league-only record is skipped.
**F12. Read-modify-write race:** select at `calendar.js:542`, update at `:556` with no `updated_at` precondition — a concurrent save between them is clobbered wholesale.
**F13. Scheduler KV scrubs reach the cloud only via debounce + beforeunload keepalive** (`calendar.js:584-601` queue through `saveGlobalSettings` with no forced sync before reload) — and if scheduler KV writes are RLS-denied, the owner's next whole-key `rotationHistory` save resurrects the scrubbed bunks (acknowledged at `integration_hooks.js:168-177`).
**F14. Stores missed by both branches:** `swimRotationHistory` and `activityHistory` (auto-solver weekly ledgers, `scheduler_core_auto.js:14412-14477` — Erase-All clears them at `calendar.js:1565`, New Half doesn't), and `historicalCountsByDate` (per-date rebuild baselines, written at `scheduler_core_utils.js:2909`, cleared by **no** reset path — stale baselines feed the raise-only merge logic at `scheduler_core_utils.js:2843-2887`).
**F15. In-memory `window.leagueRoundState` not reset** in the owner branch (cloud key cleared at `calendar.js:667`; contrast `eraseRotationHistory` at `calendar.js:494-495`). Masked by reload when reload happens.

### Low

**F16.** No re-entrancy guard on `#newHalfBtn` — double-click runs two overlapping async resets.
**F17.** Scheduler scoping: a stale division name yields `myBunks = []` → the cloud wipe silently skips (`calendar.js:541`) yet the success alert still shows.
**F18.** Rotation-event completion wipe's cloud push is non-awaited (`rotation_events.js:27-31`) and can be preempted by the reload.
**F19.** `_ocResetAt` (off-campus trip ledger marker) never stamped — away-trip fairness counters rely on the same doomed bare-`{}` clear.

---

## 3. Part B — Why "clear counters, keep schedules" self-destructs

These are the **resurrection channels**: code that re-derives cleared state from saved schedules. Every one must be epoch-fenced for a non-deleting reset to hold.

| # | Channel | Where | What it resurrects | Trigger |
|---|---|---|---|---|
| R1 | `Utils.rebuildHistoricalCounts` — full `allDailyData` scan with no floor, **overwrites** `historicalCounts` | `scheduler_core_utils.js:2781-2922` (loop at 2790) | All activity-usage counts | After **every** generation (`scheduler_core_main.js:7597`, `scheduler_core_auto.js:33360, 34993`, `integration_hooks.js:2728`) and every date delete (`calendar.js:1342`). The comment at 2824-2834 states outright that decrements belong to "the explicit erase / New-Half paths, not this passive rebuild" — i.e., the design assumes New Half deletes schedules. |
| R2 | `autoReconcileRotationMemory` daily self-heal — hydrates 90 days of cloud schedules, re-upserts every "missing" date into `rotation_counts` | `rotation_backfill.js:192-223` (auto-armed 25 s after every page load, once/day; upsert at :139) | The entire `rotation_counts` table | Automatic, within ~25 s of any page load |
| R3 | Gen-preamble cloud overlay — `RotationCloud.load` sums **all rows lifetime** and overwrites `historicalCounts` from the totals | `rotation_cloud.js:222-254`; `scheduler_core_auto.js:1085-1122`; `scheduler_core_main.js:3489-3524` | Counts + last-done dates | Every generation |
| R4 | League `reconcileHistoryFromSchedules` — rebuilds `gameLog`, `matchupHistory`, `teamSports`, **and `gamesPerDate`** from saved `leagueAssignments` for any (league, date) the history lacks | regular `scheduler_core_leagues.js:857-913` (runs at top of every gen, `:3011`; counter backfill `:891-895`); specialty `scheduler_core_specialty_leagues.js:1220-1291` (`:1331`) | Matchup history and cumulative game numbers → "Game 1" becomes "Game 47" again | Next generation. Guards exist (`_resetAt`, tombstones) but are unused by `startNewHalf`, and the `gamesPerDate` backfill isn't even gated on `_countersResetAt`. |
| R5 | LG-8 merge healing + lineage adoption — merges re-derive `gamesPerDate` from `gameLog` (`scheduler_core_leagues.js:195-204`) and adopt any surviving copy's lineage (`:123-168`) | `integration_hooks.js:798-823` (upsert-time), `:1941-1958` (hydrate), `scheduler_core_leagues.js:321-329` (verified push) | League history from **any** stale replica (cloud row, second device, localStorage backup) | Every sync/load |
| R6 | Direct schedule scans that never consulted counters at all — recency/streak/coverage 14-day history (`rotation_engine.js:189-283`), period caps (`scheduler_core_utils.js:2612-2649`), cooldowns (`scheduler_core_auto.js:5627-5641` + 3 more sites), multiPart (`scheduler_core_auto.js:5594-5619`, `special_activities.js:3196-3211`), cohort lifetime counts (`scheduler_core_auto.js:1399-1412`), fill fallback (`auto_fill_slot.js:477-514`), manual capped-queue (`scheduler_core_main.js:1917-1935`), adjacency rematch guards (`scheduler_core_leagues.js:1373-1408`) | (listed) | Nothing to "resurrect" — these see old schedules **directly**; clearing counters never affected them | Always |
| R7 | Re-hydration of past schedules into localStorage — `hydrateLocalStorageFromCloud` (90-day pull, `scheduler_core_utils.js:2931-3010`) and `schedule_orchestrator.hydrateRotationHistory` (`schedule_orchestrator.js:323-368`) | (listed) | Feeds all local scans in R6 | Page load |

**Corollary 1:** clearing the `rotation_counts` table in a non-deleting world is both destructive *and* ineffective — R2 rebuilds it from kept schedules within a day. Keep the rows; filter the reads.
**Corollary 2:** `getHalfStartDate`'s last-resort fallback is `Object.keys(allDailyData).sort()[0]` — the earliest **saved** schedule (`scheduler_core_auto.js:1313`). Under a non-deleting reset that pins "half start" to camp day 1 forever. This line alone breaks per-half caps for the new design.

---

## 4. Part C — Epoch design blueprint

**Primitive:** `rotationEpoch` — an ISO **dateKey** (not a wall-clock timestamp), meaning "counting starts at this date."

Storage (three legs, all required):
1. `camp_state_kv` / globalSettings key (e.g. `rotationEpoch`), **also written into the dormant `app1.halfStartDate`** so `getPeriodStartDate('half')` (`scheduler_core_utils.js:2563`) and `getHalfStartDate` (`scheduler_core_auto.js:1313`) become epoch-aware for free.
2. A **merge-surviving field inside both league-history blobs** (adopt-max in `mergeLeagueHistories` / `mergeSpecialtyHistories`), because plain KV values lose newer-wins merges to stale devices (F6/R5). The existing `_resetAt` is the wrong shape — it's a wall-clock stamp whose reconcile guard (`scheduler_core_leagues.js:878`) is all-or-nothing (blocks healing of *post*-epoch days too, forever). A dateKey field lets reconcile keep healing post-epoch days while fencing pre-epoch ones.
3. Reset-time in-memory neutralization + immediate verified push **before** `location.reload()` (lessons of F1/F8).

### Tier 1 — choke points (each fixes many consumers at once)

| Site | Change |
|---|---|
| `Utils.getPeriodStartDate` `scheduler_core_utils.js:2535-2601` | Clamp **every** return to `max(result, epoch)` — including the `null` (= lifetime) branches at 2563/2577 and the pre-camp fall-through at 2555-2559, which must return `epoch` instead of null. Covers all maxUsage/exactFrequency/minFrequency enforcement in rotation_engine, total_solver_engine, smart_logic_adapter, unified_schedule_system, post_edit_system, auto_fill_slot, scheduler_core_main, and the auto weekly-quota passes. |
| `Utils.getPeriodActivityCount` `scheduler_core_utils.js:2612-2649` | `dateKey >= epoch` in BOTH the local loop (:2619-2625) and the CB-66 cloud overlay loop (:2639-2645). Filtering only one operand lets the other reintroduce pre-epoch counts (the function takes MAX(local, cloud)). |
| `RotationCloud.load` `rotation_cloud.js:197-242` | `.gte('date_key', epoch)` on the query (or filter in the aggregation loop). Epoch-fies the gen-preamble overlays (R3), `mergeCloudData` (`rotation_engine.js:1610-1712`), analytics seeding. Lets pre-epoch `rotation_counts` rows stay in the table as history → **reversible reset**. |
| `Utils.rebuildHistoricalCounts` `scheduler_core_utils.js:2781-2922` | Skip `dateKey < epoch` in the main scan (:2790), `_countedDates` (:2838), and don't carry pre-epoch floors in the raise-only merge (:2843-2905). Also `rebuildHistoricalCountsFromCloud` (:3191-3199). Kills R1. |
| `rotation_backfill.js:90-127, 192-223` | Restrict the reconcile date set to `d >= epoch` — kills R2, the single most dangerous resurrection path. |
| Auto `getHalfStartDate` `scheduler_core_auto.js:1301-1314` | Return epoch in the settings chain; **replace the `sort()[0]` earliest-schedule fallback** (:1313). Clamp the planner's own `getPeriodStartDate` clone (:1339-1349). |

### Tier 2 — direct schedule/timestamp scans (each needs its own `>= epoch` guard)

- `RotationEngine.buildBunkActivityHistory` date filter `rotation_engine.js:201-206` (recency/streak/coverage).
- `rotationHistory` timestamp floors: `scheduler_core_utils.js:2448-2456`, `rotation_engine.js:551-557` (ignore timestamps `< epochMs`), `auto_fill_slot.js:506-510`.
- `Utils.getEscalationBonus` `scheduler_core_utils.js:2743-2772` — clamp `periodStart` so elapsed-days restarts at the epoch; otherwise a below-floor special gets a `100 × 2^(elapsed)` day-one urgency blowup after a mid-period reset.
- Auto planner scans: `getPeriodCount` (:1350-1361), `getMultiPartInfo` (:1367-1394), `getLifetimeSpecialCount` cohort (:1399-1412), multiPart priorCount/lastDone (:5594-5604), frequencyDays cooldown (:5627-5641), commit-gate `_crossDayCount` + cooldown (:24213-24269), Phase-4.9 recapture (:26046-26120).
- `rotation_engine.js` gates: cooldown (:1080-1089), multiPart (:1104-1123), cohort-manual (:1160-1197) — mostly inherit via counter/util fixes; verify.
- `auto_fill_slot.buildHistory` `auto_fill_slot.js:491-501`.
- Manual capped-queue `_lrStats` `scheduler_core_main.js:1917-1935`.
- `getBunkCompletionCount` source-3 scan `special_activities.js:3196-3211`.
- `getActivitiesDoneYesterday` `scheduler_core_utils.js:2400-2428` + engine fallback `rotation_engine.js:481-518` (see §5.4 for semantics).
- `schedule_orchestrator.hydrateRotationHistory` `schedule_orchestrator.js:326-331` — clamp hydrate start to epoch (schedules stay viewable through normal calendar loads; only rotation-purpose hydration stops at the epoch).
- Analytics: lastDone scan `analytics.js:1563-1587` (display accuracy).
- Rotation events: either keep the existing reset-time `clearAllCompleted()` (CB-90, `calendar.js:699`) or — more reversible — filter `getCompletedBunks` (`rotation_events.js:120-127`) to `dateKey >= epoch`; one choke point covers remaining/assignments/quotas/UI. Note `markCompletionsFromSchedule` (:1371) has zero callers, so kept schedules can NOT resurrect completions — this store is safe either way.

### Tier 3 — leagues (regular `scheduler_core_leagues.js`, specialty `scheduler_core_specialty_leagues.js`)

- **Game numbering restarts at 1:** `calculateStartingGameNumber` sums `gamesPerDate` for `d < currentDate` — restrict to `epoch <= d < currentDate` (regular :450-454; specialty :339-358). `updateFutureSchedules` clamps both its future-date scan and per-date sums to `>= epoch` (regular :490-527; specialty ~:380-586) so pre-epoch archives are never renumbered.
- **Reconcile fence (kills R4):** skip `d < epoch` in both reconcile loops (regular :875-897 including the `gamesPerDate` backfill at :891-895; specialty :1239-1276). This *replaces* the too-blunt `resetAt > 0` guard for post-epoch healing.
- **Merge fence (kills R5):** in `mergeLeagueHistories`/`mergeSpecialtyHistories`, drop (league, date) entries with `d < epoch` during adoption (:123-168 / :92-155), gate the counter-heal (:195-204 / :111-120) on the epoch, and rebuild flat aggregates (`matchupHistory`, `teamSports`, specialty `teamFieldRotation`/`slotDebt`) only from `d >= epoch` (:208-232).
- **Matchup/sport fairness reads:** `getTeamSportHistoryByDate` (:720-725), `getMatchupCountByDate` (:937-942, incl. the `asOfDate=null` full-season call at :1310), `getPairSports` (:1060-1064), `makePairRecency` (:1133); specialty `matchupHistory` date-arrays (~:767 region). Flat legacy aggregates zeroed at epoch.
- **Adjacency/forward guards:** exclude `d < epoch` from `_adjDates`/`metAdjacent` (:1373-1408) and `_getTeamNextDaySports` (:811-835) — see §5.4.
- **Chinuch cross-day ledger** (:3249-3331) and **off-campus trip ledger** (`ocTripsByDate` rebuild :174-188, or stamp the existing `_ocResetAt['*']` mechanism :2950-2954): restart at epoch (fairness ledgers, not records).
- **Playoffs:** round = `gameNumber − playoff.startGameCount` (regular :4074-4117; specialty :1507-1520; hub `playoff_hub.js:154-218`). After a counter restart, existing anchors make derivedRound ≤ 0 → the tile silently plays regular league (:4079-4081). Reset `league.playoff` or re-stamp `startGameCount` against the epoch-filtered counter at reset time. `_gamesBeforeActiveDate` (`playoff_hub.js:176-178`) counts only `epoch <= d < activeDate`.
- **Results/standings (fixes F3/F4 class):** at reset time, archive/delete `league.games` entries with `g.date < epoch` (or filter in `recalcStandings`, `leagues.js:2616`), expose `window.saveLeaguesData`, guard `importGamesFromSchedule` (`leagues.js:2332`; specialty :1990) against pre-epoch dates.
- **Specialty note:** specialty matchup identity is purely game-number-driven round-robin (`roundRobin[(gameNumber−1) % rounds]`, :693-761) — a clean counter restart IS the matchup reset there; only field/slot-fairness ledgers need separate fencing.

### Tier 4 — one-time clears at reset (stores without usable date keys)

Clear once, then let the (now epoch-filtered) rebuilders repopulate from post-epoch days only: `historicalCounts`, `historicalCountedDates`, **`historicalCountsByDate`** (missed by every current path — F14), `manualUsageOffsets`, `rotationHistory` timestamps (or rely on the timestamp floors), `swimRotationHistory`, `activityHistory`, `leagueRoundState` (cloud + in-memory), league/specialty standings + playoffs (with F3/F4 fixed), and — product decision — rotation-event completions (§5.6). `smartTileHistory`/`smartTileSpecialHistory` are dead data (no live readers) — clear for hygiene.

### Reset-time procedure (order matters — lessons of F1/F5/F10)

1. Compute epoch dateKey (product decision: today vs. tomorrow — recommend **tomorrow** so today's already-generated day stays consistently pre-epoch).
2. Write epoch: globalSettings `rotationEpoch` + `app1.halfStartDate` + inside both league-history blobs (merge-surviving field); stamp `_ocResetAt`.
3. Apply Tier-4 clears; reset playoff anchors; prune `league.games < epoch`.
4. **Verified** cloud push (the league engines' verified-push pattern, `scheduler_core_leagues.js:307-365`) with per-step success checks; abort with a partial-failure alert instead of a success alert if anything fails (no blind `console.error`-and-continue).
5. Neutralize in-memory state (`clearBunksFromGlobals`-equivalent for the full camp, `window.leagueRoundState = {}`) **before** reload so the beforeunload final-save can't resurrect anything (F1).
6. Reload.
7. Multi-device: other sessions adopt the epoch via the merge-surviving field on their next sync/hydrate (this is precisely what bare-`{}` clears can never do — F6).

**Reversibility bonus:** since nothing is deleted (schedules kept, `rotation_counts` rows kept, `league.games` archived rather than destroyed if desired), moving the epoch back restores history exactly — a genuinely undoable reset, which the current design can never be.

---

## 5. Part D — Semantic edge cases (product decisions needed)

1. **Physical cooldowns across the boundary.** `frequencyDays` ("min N days between visits") may encode real-world constraints (equipment turnaround). A strict epoch makes a bunk that did the Lake the day before the reset instantly eligible on day 1. Recommend: epoch-filter for consistency, but surface the choice — or exempt cooldowns from the epoch as a config flag.
2. **Mid-sequence multiPart specials.** Parts done pre-epoch stop counting → sequence restarts at part 1 while old saved schedules still display stamped "1/3, 2/3" labels. The inverse (partial rollout where auto and manual paths disagree on the next part) is worse — whatever is chosen, **all** multiPart sites must be filtered together, never mixed. multiPart is the strongest candidate for an epoch-exempt (lifetime) constraint, or a reset-time confirmation listing mid-sequence bunks.
3. **Mid-week/mid-half caps double-dose.** Epoch mid-week with "exactly 2×/week": 2 pre-epoch + 2 post-epoch = 4 in 7 real days. Consistent with "nothing before counts," but owners may read caps as physical. Mitigation: recommend (or force) the epoch to land on a period boundary (Sunday/Monday, or `campDates.half2Start`).
4. **Day-1 recency and back-to-back.** Filtering "yesterday" checks means the first post-epoch day can repeat exactly what every bunk did the day before, and league engines lose back-to-back-away detection across the boundary (`scheduler_core_auto.js:25279-25286`). A defensible split: epoch-filter all *bookkeeping* (counts, caps, cooldowns, matchups, game numbers) but keep the 14-day *quality* heuristics (recency, yesterday-repeat, adjacency) unfiltered. Caveat: the `NEVER_DONE` guards (`rotation_engine.js:737-741, 1013-1014`) must then use the same epoch-scoped count source as frequency scoring or the two split-brain (the exact bug class the 2026-07-08 trace comment at `rotation_engine.js:728-736` describes).
5. **Rematch legitimacy.** After the epoch declares who-played-who void, a Game-1 rematch of last half's finale is legitimate by definition. If the owner wants "no literal calendar back-to-back rematches" across the boundary, that should be an explicit opt-in, not an accident of unfiltered history.
6. **Rotation events straddling the epoch.** An event whose `dateRange` spans the reset: clearing completions re-queues already-served bunks (double turns); keeping them means the fresh start doesn't apply to events. Least surprising rule: events started pre-epoch keep their completions; a full wipe only on explicit owner confirmation.
7. **Editing/regenerating pre-epoch dates.** Post-reset, regenerating a pre-epoch date would mix old-half state into new-half ledgers (and `RotationCloud.save` on an old date re-derives that day's counts — harmless once loads are epoch-filtered, but the UX should probably treat pre-epoch dates as read-only archive, or at least warn).
8. **Scheduler-scoped epoch?** The current scheduler branch resets only their bunks. An epoch watermark is naturally camp-global; a per-division epoch multiplies every filter site's complexity. Recommend: owner-only feature (schedulers keep their existing scoped destructive tools), or a single camp-global epoch that schedulers can't set.

---

## 6. Test-coverage gaps

- **Node suite** (`tests/calendar_delete_reset.test.js:542-658`): mocks `clearCloudKeys`/`saveGlobalSettings`/`forceSyncToCloud` as inert (:170-172), so the merge-resurrection (F2), debounce-loss (F8/F13), and swallowed-failure (F5/F10) classes are structurally invisible. No beforeunload simulation (F1), no failure injection, no assertion that in-memory schedules are cleared, no league-standings persistence assertion (F3 would have failed one), no league-only record case (F11), no multi-record partial-failure case.
- **Browser harness** (`tests/deletion_features.html`) is broken: its AccessControl mock (:103-109) lacks `canEraseData`, so `startNewHalf` is denied for every role — the owner/admin suites must fail, and the "scheduler denied" tests (:549-563) pass for the wrong reason while asserting stale policy (schedulers now have a scoped branch, not denial). It also lacks `getGeneratableDivisions`, so the scheduler branch can't be exercised at all.
- For the epoch redesign: new tests must cover the resurrection channels directly — generate → epoch-reset → regenerate and assert counts/game-numbers/matchups start fresh **with schedules still present**; run the backfill reconcile against a set epoch; merge a stale device blob against an epoch-stamped blob.

## 7. Recommended implementation order

1. **Fix the standalone bugs first** (they hurt today, deleting or not): F3 (expose `saveLeaguesData`), F2/F19 (stamp `_resetAt`/`_countersResetAt`/`_ocResetAt` — or move straight to the epoch field), F1 (neutralize in-memory before reload), F4 (`league.games`), F5/F10 (error handling + ordering), F7 (division-keyed league scrub), F14 (missed stores).
2. **Land the epoch primitive + Tier-1 choke points** behind the dormant `halfStartDate` hook — this makes per-period caps epoch-correct with minimal surface.
3. **Fence the two self-healing daemons** (R1/R2 rebuilders, R4/R5 league reconcile+merge) — without this the epoch is decorative.
4. **Tier-2/3 direct scans**, with the §5 product decisions resolved.
5. **Rewire the button**: new confirm dialog describing the non-deleting semantics ("previous schedules remain viewable; all counters and matchups restart"), reset-time procedure of §4, remove the schedule deletion.
6. **Tests** per §6.
