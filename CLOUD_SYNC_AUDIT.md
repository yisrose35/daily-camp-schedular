# Cloud Sync Audit — leaks to and from the cloud

Follow-on from `REPORTING_DISCREPANCY_FINDINGS.md`, which covered `rotation_counts`
and `leagueAssignments`. This pass walks every remaining read/write path between the
app and Supabase looking for the same class of defect: data that silently fails to
arrive, silently fails to leave, or arrives attached to the wrong thing.

## Tables in play

| Table | Writers | Shape | Conflict model |
|---|---|---|---|
| `daily_schedules` | every scheduler | one row per (camp, date, **scheduler**) | per-bunk / per-division newest-wins merge on read |
| `camp_state_kv` | owner/admin/scheduler | one row per (camp, **key**) | whole-value last-writer-wins, with fetch-merge for `app1` / `campistryMe` / league histories |
| `rotation_counts` | every scheduler | one row per (camp, date, bunk, activity) | delete-then-upsert (now bunk-scoped) |
| `schedule_proposals` | schedulers | one row per proposal | append/delete |
| `field_locks` | schedulers | one row per (camp, date) | whole-row last-writer-wins |
| `camp_state` | legacy | one row per camp | superseded by `camp_state_kv` |

Broadly, `daily_schedules` is the best-defended surface in the codebase — the empty-save
guard, the stripped-downgrade guard, the cross-date owner stamp, `_divStamps`, and the
CB-2 transient-error tag are all real and all correct. The leaks below are in the layers
*around* it.

---

## Fixed in this pass

### 1. A failed `camp_state_kv` sync was never retried
`integration_hooks.js` — `executeBatchSync`

The two sibling bail-out branches both re-arm: offline registers an `online` listener,
client-not-ready sets a 2 s timer. The **error** branch restored the keys into
`_pendingChanges` and then did nothing. So a settings edit whose sync hit a transient
5xx/timeout sat there until some *unrelated* later edit happened to call
`scheduleBatchSync`. Make one edit, have it fail, reload — the edit was gone, with only a
console line.

Everything routed through `saveGlobalSettings` is exposed: layers, skeletons, specials,
facilities, camp dates, `manualUsageOffsets`, `rotationHistory`.

**Fixed:** the catch block now schedules a retry with exponential backoff (2 s → 60 s cap,
reset on any successful write), and the `campistry-sync-error` event carries `retryInMs`.

### 2. The schedule save queue dropped cross-date saves
`supabase_sync.js` — `queueSave` / `executeSave`

`_pendingSave` was a **single slot** with a 500 ms debounce:

```js
_pendingSave = { dateKey, data, timestamp: Date.now() };
if (_saveTimeout) clearTimeout(_saveTimeout);
```

Queue a save for date A, then one for date B inside 500 ms, and A's flush is cancelled and
A's payload overwritten. A is then in neither the pending slot nor the offline queue —
nothing retries it, and the edit never reaches the cloud. Reachable on quick date
navigation with unsaved edits, and on any multi-date fanout.

**Fixed:** `_pendingSaves` is keyed by date and `executeSave` drains all of them. The newest
payload for a *given* date still supersedes the older one (correct — same day, fresher
data); a different date can no longer cannibalise it. A multi-date drain passes
`allowCrossDate` per payload, exactly as the offline-queue replay does.

### 3. Debounced saves died on tab close
`supabase_sync.js`

A save waits out `SAVE_DEBOUNCE_MS` before it is attempted. Close the tab inside that
window and it was gone — `integration_hooks`' `beforeunload` handler only persists the
**currently viewed** date, so a queued save for any other date had no rescue path.

**Fixed:** `pagehide` + `beforeunload` move whatever is still pending into the *persisted*
offline queue (a synchronous localStorage write, which survives unload). The normal drain
on next load pushes it to the cloud.

### 4. The offline queue gave up silently
`supabase_sync.js` — `processOfflineQueue`

After `MAX_RETRY_ATTEMPTS` (5) an item is **dropped** — those edits are gone for good. That
happened with one `logError` line, and the toast lumped it in with retryable failures
("⚠️ N change(s) failed to sync"), which reads as "it'll sort itself out".

**Fixed:** abandoned payloads are written to `localStorage["__campistry_abandoned_saves"]`
(bounded to 10, same pattern as `__campistry_empty_save_blocks`) and reported in their own
toast naming the affected dates. Retryable failures are counted separately.

### 5. The realtime refresh could overwrite a live edit
`supabase_sync.js` — `refreshMultiSchedulerView`

Fired from the realtime handler 500 ms after any remote change, with
`forceOverwrite = true`. Its smart merge only protects bunks when the user is a
**scheduler** or has a live `_isPerBunk` generation — for an owner/admin in manual mode
`myBunks` is empty and it is a **full replace** of `window.scheduleAssignments`. 500 ms is
exactly the window a local post-edit is still writing in.

Every other realtime consumer already defers on `_postEditInProgress` /
`_generationInProgress` — `integration_hooks`' merge, `unified_schedule_system`'s
`loadScheduleForDate`, `post_edit_system`'s loader patch. `supabase_sync.js` had **no
occurrence of either flag anywhere in the file**.

**Fixed:** defers and retries (500 ms, bounded to 20 attempts) rather than dropping, so the
remote update still lands once the edit settles.

### 6. The realtime refresh could hydrate the wrong date into memory
`supabase_sync.js` — `refreshMultiSchedulerView`

`dateKey` is captured at call time, then the function awaits `loadSchedule`. Navigate
across that await and the localStorage write is still correct (that date's own row) but
`forceHydrateFromLocalStorage(dateKey, true)` loads the **old** date's schedule into
`window.scheduleAssignments` *and stamps `_scheduleAssignmentsDate` to match* — arriving
pre-blessed past every downstream save guard.

**Fixed:** re-check the live date after the await; if it moved, keep the localStorage
update and skip the in-memory half.

### 7. `field_locks` — signature mismatch, so cross-scheduler lock state never persisted
`access_control.js` / `division_selector.js`

```js
// division_selector.js
await AccessControl.saveFieldLocks(_currentDate, mergedLocks, allGenerated);   // 3 args
const { locks, generatedDivisions } = await AccessControl.loadFieldLocks(date);
```
```js
// access_control.js
async function saveFieldLocks(date, locks) { ... }          // 2 params
.select('locks')                                            // no generated_divisions
```

`allGenerated` was dropped on the floor; `generatedDivisions` was **always undefined**. The
"which divisions has someone already generated today" state never round-tripped, so each
scheduler saw an empty set.

Two further problems on the same path:
- `loadFieldLocks` returned a bare `{ locks: {} }` on error — a transient failure reads as
  "every field is free", the unsafe direction.
- `saveLocks` merged against `_existingLocks`, a snapshot from page open. `field_locks` is
  one whole row per (camp, date), so a concurrent scheduler's locks were overwritten with
  our stale base — a classic lost update.

**Fixed:** signatures aligned, `generated_divisions` selected and written, `_queryErrored`
tag added (same idea as CB-2) with the caller keeping known locks instead of adopting a
phantom-empty set, and `saveLocks` re-reads immediately before merging.

> **Schema gap — needs your call.** No migration in `migrations/` defines `field_locks`,
> and `generated_divisions` appears nowhere in the repo. If the table isn't provisioned,
> every call here throws and is swallowed, and the whole cross-scheduler field-lock
> feature is inert. Either add the migration or retire the path — I've fixed the code bug
> but can't verify the table against your live database from here.

---

## Looked at and found sound

- **`local_cache_idb.js`** — both writes share one transaction; read/write/clear all
  degrade safely; `onversionchange` clears the cached open-promise.
- **`daily_schedules` write guards** — empty-bunks, structural-skeleton,
  all-empty-preview, stripped-downgrade, filter-induced-empty, and the cross-date owner
  stamp are all correct and cover the direct callers that bypass the orchestrator.
- **CB-2 transient-error tagging** — `loadAllSchedulersForDate` tags a failed query so
  `loadSchedule` and `deleteMyScheduleOnly` don't read it as "the date was deleted". This
  is the right pattern; finding 7 above extends it to `field_locks`.
- **`camp_state_kv` fetch-merge** — `app1` / `campistryMe` shallow-merge and the
  `leagueHistory` / `specialtyLeagueHistory` (league, date)-granular merge correctly stop
  a partial payload from dropping another writer's sub-keys.
- **Offline-queue re-entrancy** — the `_draining` guard is correct; two reconnect paths
  can both call `processOfflineQueue`.
- **DELETE attribution** — an unattributable realtime DELETE is ignored rather than
  guessed at, which is the safe direction.

---

## Known and not addressed

- **`camp_state_kv` is last-writer-wins per key.** Two people editing different specials
  in the same session: the second save replaces the whole `specialActivities` array. The
  fetch-merge only operates at the top level of `app1`, not inside its arrays. Fixing
  properly means either per-entity rows or optimistic concurrency on `updated_at` — a
  real design change, not a patch.
- **In-flight batch on tab close.** `executeBatchSync` moves keys out of `_pendingChanges`
  into a local `changesToSync` before awaiting. Close the tab mid-flight and those keys
  are in neither place, so the `beforeunload` keepalive flush can't see them. Narrow
  window, but real.
- **`_lastSeenUpdatedAt` grows unbounded** — one entry per record id per session. Memory,
  not correctness.
*(The legacy `camp_state` item that was here is now section 8 below — investigating it
turned up a bigger problem than the one I'd noted.)*

---

## 8. Legacy `camp_state`, and the camp-id resolution behind it

**Correction to my earlier note:** those three files don't read a dead store blindly — all
three read `camp_state_kv` **first** and fall back to `camp_state` only when it returns
nothing. The fallback wasn't the bug. Two real ones were underneath it.

### 8a. The legacy blob never migrated, so it stayed a divergent shadow store

`integration_hooks.js` hydration sets `usedFallback = true` when it reads the legacy blob —
and that variable **was never read anywhere**. So a camp still on `camp_state` re-read it on
every single load and never moved to `camp_state_kv`. That is why three unrelated consumers
each had to carry their own fallback.

It was also a data cliff: the hydration branch prefers KV whenever it has *any* rows, so the
moment one key got written (a single edit anywhere), every un-migrated key stopped being read
from cloud at all.

**Fixed:** on legacy fallback the whole blob is now upserted into `camp_state_kv` once,
preserving the blob's own `updated_at` so the migration can't look newer than edits another
device already wrote. Idempotent — once the rows exist the fallback branch never runs again.

### 8b. Camp id was resolved from an unverified localStorage chain, differently per call site

`CampistryDB.getCampId()` deliberately dropped the
`currentCampId || campistry_user_id || camp_id` localStorage chain — its own comment says
why: *"Anyone with DOM access could write any camp_id and the client would honor it without
verifying membership."* Seven call sites still did exactly that chain by hand, and they
**did not agree with each other**:

```
dashboard loadStats       campistry_camp_id || campistry_user_id || currentUser.id
dashboard loadCampDates   campistry_camp_id || campistry_user_id || membership.camp_id || currentUser.id
dashboard saveCampDates   campistry_camp_id || campistry_user_id || currentUser.id
```

With `campistry_camp_id` unset but a membership present, camp dates were **read from
`membership.camp_id` and written to `currentUser.id`** — different rows. That is the
"camp dates don't persist" symptom, still live after the earlier `9d03c205` fix.

Every one of these also passes a **user** id as a camp id when `campistry_camp_id` is
missing, which matches no camp: `trial_guard` then reported 0 days used / 0 campers (quota
under-counted against the wrong identity), and `team_subdivisions_ui` rendered every
division grey.

Worst of the set, `schedule_versions_db.js`:

```js
return (window.getCampId && window.getCampId()) ||
       localStorage.getItem('campistry_user_id') ||
       'demo_camp_001';          // ← shared literal
```

Any camp reaching that last fallback wrote its schedule versions into a **shared** bucket
that every other such camp could read.

**Fixed:** one resolver per file, all preferring `CampistryDB.getCampId()` then the
id-shaped cache key, never a user id and never a shared literal. `dashboard.js` uses a
single `dashCampId()` across stats and all three camp-dates paths, so read and write can no
longer target different rows. `schedule_versions_db` returns null instead of inventing an
id, and both its callers now refuse to run without one. `access_control.js`'s owner/admin
cache fast-path prefers `campistry_camp_id` before falling back.

### 8c. Read errors presented as empty data

`dashboard.js` fell through to the legacy table whenever the KV read returned no rows —
including when it **errored**. The legacy read then failed too, `state` stayed null, and the
dashboard rendered 0 divisions / 0 bunks / 0 campers, indistinguishable from a new camp.
`team_subdivisions_ui` cached `{}` on a failed read, pinning every division to the grey
default for the rest of the session.

**Fixed:** both distinguish error from empty and keep what they already had. Same class as
CB-2 on `daily_schedules` and the `field_locks` fix in section 7.
