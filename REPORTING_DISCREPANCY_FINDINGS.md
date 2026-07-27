# Rotation Reporting — Discrepancy Deep Dive

**Trigger:** a camp reports a bunk never had Pizza Making, but the Rotation report
credits them with it.

**Scope:** the full path from "what the bunk was given" → "what the system stored"
→ "what the report shows". Read-only investigation; the only code shipped
alongside this is a read-only reconciliation tool (see *Diagnosing a live case*).

---

## 1. The pipeline, end to end

There is exactly one source of truth and two derived tallies that both drift from it.

```
        window.scheduleAssignments          ← the live grid (what the camp is handed)
                    │
      ┌─────────────┴──────────────┐
      ▼                            ▼
 daily_schedules              rotation_counts               globalSettings.historicalCounts
 (cloud, per date)            (cloud, per date/bunk/act)    (LOCAL, cumulative per bunk/act)
 SOURCE OF TRUTH              ← RotationCloud.deriveCounts  ← Utils.rebuildHistoricalCounts
      │                            │                              │
      │                            ▼                              ▼
      │                     Rotation report Count           Solver fairness scoring
      │                     (analytics.js)                  (rotation_engine / solver)
      └──────────────────────────► also re-scanned by rebuildHistoricalCounts
```

Key structural facts:

- **`rotation_counts` is the report.** `analytics.js:1393-1401` loads cloud-first;
  local `historicalCounts` is only a fallback when a bunk has *zero* cloud rows
  (`analytics.js:1504`).
- **`historicalCounts` is the solver.** The report and the solver therefore read
  two different tallies that are built by two different functions with
  two different rule sets (see finding **E**).
- **Both tallies are derived, never incremented.** Every live path re-derives from
  `scheduleAssignments` and replaces. That is the right design — but it means the
  tally is only ever as correct as the *saved schedule*, and any path that mutates
  the schedule without re-deriving leaves a stale credit behind.

---

## 2. Findings, ranked

### A. The report counts what was **scheduled**, never what was **delivered** — and there is no correction path

`rotation_counts` rows are derived purely from `scheduleAssignments`
(`rotation_cloud.js:67-100`). If the schedule said Pizza Making and the activity
was cancelled, swapped verbally, rained out without using the rainy-day tool, or
the staff member didn't show — the bunk is still credited. The only way the credit
clears is if someone edits *that day's saved schedule*.

This is a design gap, not a code defect, and it is the single most likely
explanation for "the bunk says they didn't have it." There is currently no
"didn't actually happen" affordance anywhere in the product, and no way for a head
counselor to see which date a count came from in order to correct it.

**This is the first thing to rule out on the live case**, which is what the new
drill-down (below) does.

---

### B. `RotationCloud.save` can be fired with a mismatched (date, schedule) pair — no cross-date guard

`saveRotationCounts` **deletes every row for the date across the whole camp**,
then re-inserts from the passed grid (`rotation_cloud.js:151-165`). Two callers pass
`window.currentScheduleDate` + `window.scheduleAssignments` with **no coherence
check between them**:

| Caller | Guarded? |
|---|---|
| `unified_schedule_system.js:4625-4628` (`saveSchedule`) | ❌ no `_pendingDateTransition`, no `_scheduleAssignmentsDate` |
| `scheduler_core_utils.js:3562-3571` (`applyPostEditCounts`, **500 ms debounce**) | ❌ neither |
| `integration_hooks.js:2481-2494` (autosave hook, schedule payload) | ✅ both |
| `integration_hooks.js:965-970` (`verifiedScheduleSave`) | ✅ owner stamp |
| `scheduler_core_auto.js:33417`, `:35052` | ✅ uses `currentDate` captured at gen start |

The guards exist and are used correctly for the `daily_schedules` write. The
`rotation_counts` write next to them skips them.

**Reachable window:** during a date change, `integration_hooks.js:2375` sets
`window.currentScheduleDate = newDateKey` **before** the new date's data loads at
`:2384-2387`. In that window `scheduleAssignments` still holds the *old* day. A
save firing there writes yesterday's activities under today's `date_key` and — because
save pre-deletes — **erases today's real rows**. Net effect: the bunk is credited twice
for yesterday's activities and loses credit for today's. The 500 ms post-edit debounce
makes this trivially reachable: edit a cell, immediately change the date.

**Impact:** phantom credit on a date the bunk never had it + silent loss of the real date.
This is the most plausible *code* cause of the reported symptom.

---

### C. `rotation_counts` writes are camp-wide destructive but division-blind

`daily_schedules` writes are carefully scoped: filtered to the user's own bunks
(`supabase_schedules.js:378-414`) and merged per-bunk newest-wins.
`rotation_counts` has **none of that** — `delete().eq('camp_id').eq('date_key')`
wipes every division's rows for the date, and the re-insert only contains whatever
bunks happen to be in the caller's memory.

Any client whose in-memory grid is partial — an init race, a scheduler whose
cross-division merge hasn't landed, an offline session — silently deletes other
divisions' rotation history for that date.

**Amplifier:** `rotation_backfill.js:234-245` arms `autoReconcileRotationMemory()`
automatically 25 s after every boot, once per device per day. It walks up to 90 past
dates and calls the same delete-then-insert (`:161`) from that device's local copy.
Its only safety net is the fully-degraded case (`dTotal === 0 && sTotal > 0`,
`:132-135`) — a *partial* local copy sails straight through and heals the date down
to that one device's view.

**Direction:** undercount for everyone else, but combined with **B** it means the
numbers move around between sessions, which reads to a user as "the reports are not
the actual report."

---

### D. The report's "today" column counts by different rules than the cloud ever will

`analytics.js:1583-1634` (today's live contribution) and `:1650-1674` (lastDone) diverge
from `rotation_cloud.js:deriveCounts` in four ways:

| | `deriveCounts` (what gets stored) | `analytics.js` (what you see for today) |
|---|---|---|
| Valid-activity gate | required (`rotation_cloud.js:92`) | **none** |
| League entries | skipped (`:84`) | **counted** — a league game's `sport` becomes a rotation credit |
| Fields read | `_activity \|\| sport` | `_activity \|\| activity \|\| sport` |
| Source | `scheduleAssignments` | prefers `scheduleSegments`, which may hold **>1 segment per slot** |

So today's number can be higher than what will ever be persisted, and it silently
drops the next day. If the disputed report was read on the day itself, this alone
could explain it.

---

### E. The report's tally and the solver's tally are built by functions that disagree

- `rotation_cloud.js:85` — `entry._activity || entry.sport`
- `scheduler_core_utils.js:3052-3053` (`rebuildHistoricalCounts`) — **`entry._activity` only**, no `sport` fallback

An entry carrying only `sport` counts in the cloud (→ report) but not locally
(→ solver). The two stores are *structurally guaranteed* to disagree on those
entries. `scheduler_core_utils.js:3346-3353` already documents this divergence for
the dead `incrementHistoricalCounts` path; the same divergence is live between the
two stores that ship.

---

### F. `max(memory, cloud)` merge is overcount-biased

`analytics.js:1626`:

```js
const finalCount = memCount >= cloudCount ? memCount : cloudCount;
```

For the viewed date, the report takes the **larger** of the in-memory/localStorage
count and the cloud count. If the local copy of that date is stale and still contains
Pizza Making while the cloud correctly dropped it, the report shows the phantom. The
merge can only ever inflate, never correct downward.

---

### G. `rebuildHistoricalCounts` has a raise-only floor

`scheduler_core_utils.js:3139` and `:3159`:

```js
_merged[b][a] = Math.max(_merged[b][a] || 0, _freshRest[b][a]);
```

When the local scan is partial (near-quota browser keeping days in the cloud), previous
counts become a permanent floor for every date the scan can't see. Deliberate — it
protects against a partial scan wiping shared totals — but the consequence is that a
count for a dropped activity can never come back down through this path. Only the
active date is authoritative (`:3116-3149`).

Affects the solver's fairness directly, and the report whenever a bunk has no cloud
rows (`analytics.js:1504`).

---

### H. Secondary issues found along the way

- **`_displayName` alias.** A slot can be *shown* as one thing and *counted* as another
  (`unified_schedule_system.js:4567-4578`, `scheduler_core_utils.js:44`). Intentional, but it means
  the printed schedule and the report can legitimately disagree on a name. The new
  drill-down surfaces `[shown as "…"]` per slot so this is visible rather than mysterious.
- **`rotationHistory` stamped with `Date.now()`**, not the schedule's date
  (`integration_hooks.js:2703`). Generating a future day marks its activities as done
  "now", skewing recency. Partly mitigated: the report only shows Last Done when
  `Count > 0` (`analytics.js:1775`) and only fills gaps, never overrides
  (`analytics.js:1719-1733`).
- **`rotation_counts` is keyed by bunk *name*.** Reusing a retired bunk name attaches the
  old bunk's history to the new one. `renameBunk` migration exists
  (`rotation_cloud.js:412`, called from `campistry_me.js:1843`) but reuse is not a rename.
- **No date attribution in the report.** Count was a bare cumulative number, so a
  disputed value could not be reconciled by anyone. Addressed below.

---

## 3. Diagnosing the live case

Two things shipped with this write-up, both read-only:

**`rotation_reconcile.js`** — reconciles the report's Count against the saved schedules,
date by date:

```js
explainCount('Bunk 3', 'Pizza Making')   // per-date breakdown for one pair
explainCount('Bunk 3')                   // every activity for a bunk
explainCount(null, 'Pizza Making')       // every bunk for an activity
```

Per date it reports `OK` / `PHANTOM` (credited with no schedule behind it) /
`MISSING` / `MISMATCH`, plus the slot, field, whether the block was pinned or
hand-edited, and any `_displayName` alias. It hydrates from cloud first so a thin
local cache doesn't produce false PHANTOMs, and honors the rotation epoch.

**Clickable Count in the Rotation report** — clicking any non-zero count opens the same
breakdown inline, so a head counselor can answer "which day was this?" without the console.

### Reading the result on the real bunk

- **Any `PHANTOM` rows** → a stored credit with no schedule behind it. Findings **B**/**C**.
  `🔧 Verify Memory` (`backfillRotationMemory()`) re-derives past dates from the schedules
  and clears it.
- **All `OK`, and the dates look plausible** → finding **A**: the schedule genuinely listed
  Pizza Making that day and the change happened on the ground. Editing that day's schedule
  clears the credit. No amount of sync hardening fixes this class; it needs a product answer.
- **`MISSING` rows** → the reverse leak, other divisions' rows wiped by **C**.

---

## 4. Recommended fixes, in order

1. **Guard the two unguarded `RotationCloud.save` calls** (`unified_schedule_system.js:4625`,
   `scheduler_core_utils.js:3563`) with the same `_pendingDateTransition` +
   `_scheduleAssignmentsDate` checks `verifiedScheduleSave` already uses. Small, contained,
   removes finding **B**.
2. **Scope the `rotation_counts` delete to the bunks being written**, instead of the whole
   camp-date, and refuse the write when the caller's bunk set is empty — mirroring the
   `daily_schedules` empty-save guard. Removes finding **C** and de-fangs the daily
   auto-reconcile.
3. **Make `analytics.js`'s today-count call `RotationCloud.deriveCounts`** rather than
   reimplementing it, and drop the `max(mem, cloud)` merge in favour of cloud-authoritative-
   plus-in-session-edits. Removes **D** and **F**.
4. **Give `rebuildHistoricalCounts` and `deriveCounts` one shared per-entry rule function.**
   Removes **E**, and stops the two stores from silently disagreeing again.
5. **Product:** an explicit "this didn't happen" action on a schedule block that clears the
   day's credit. Without it, finding **A** will keep generating these reports no matter how
   clean the sync is.

Items 1–4 are mechanical and low-risk. None of them are done yet — this pass was
investigation plus the diagnostic needed to confirm which one is actually biting.
