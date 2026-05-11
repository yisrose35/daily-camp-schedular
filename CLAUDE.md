# daily-camp-schedular — Contributor & Maintenance Guide

This file is the entry point for anyone (human or Claude instance) working on the codebase. Read it before touching the scheduler.

## Project shape

- **Single-page browser app**, no build step. Each `.js` file is loaded as a regular `<script>` in `index.html` / `campistry_me.html` / `campistry_register.html` etc.
- **State lives in `window` globals** by deliberate convention. The relevant ones:
  - `window.scheduleAssignments` — `{ [bunkName]: [slotEntry | null, ...] }` — the canonical placement map.
  - `window.divisions` — `{ [gradeKey]: { bunks: [...], startTime, endTime } }`.
  - `window.divisionTimes[grade]._perBunkSlots[bunk]` — per-bunk per-slot timeline.
  - `window.fieldUsageBySlot` — `{ [slotIdx]: { [fieldName]: { count, bunks } } }`.
  - `window.activityProperties`, `window.specialActivities`, `window.dailyDisabledFields`, ... — registry & overrides.
- **Cloud persistence**: Supabase. Per-key UPSERTs into `camp_state_kv`; per-date rows in `daily_schedules`; rotation history in `rotation_counts`. Slice 1 hardened this layer.
- **Auth + RLS**: `supabase_client.js` + `access_control.js`. RLS migrations live in `migrations/*.sql`. Slice 2 audited and hardened.

## Auto-generation pipeline (Slice 3 — the hot path)

Touching anything in these files needs care; they are the most-audited code in the repo:

| File | LOC | Role |
|---|---|---|
| `scheduler_core_auto.js` | 15.6K | Phase orchestration, anchor placement, safety-net |
| `auto_solver_engine.js` | 2.5K | Main CSP solver + repair phases |
| `rules.js` | 1.1K | Cooldown / FieldCombos rule engine |
| `rotation_engine.js` | 1.3K | Per-bunk-per-activity rotation scoring |
| `pinned_activity_preservation.js` | 0.6K | Pin gate (drop pins that violate current rules) |
| `scheduler_core_utils.js` | 2.6K | Shared helpers |

### Execution order

```
Phase 0  — Overrides applied (disabledFields/disabledSports/customBlocks)
Phase 1  — Anchor placement (Lunch/Swim/Snack from layer config)
Phase 2  — Specials placement (todaysSpecials, sorted narrowness-first)
Step 2.7 — Direct writes (specials, sport overrides, capacity-checked, anchors)
Phase 3  — Main solve via auto_solver_engine.solve()
Repair   — lnsRepair / colocateFreeBlocks / ejectionChainRepair / bfsAugmentingRepair
Step 4.95 — Rule safety net (fixed-point loop, max 3 iterations)
Phase 5  — Save (schedule + rotation history + cloud sync)
```

### The cardinal rule

**Every write to `scheduleAssignments` must go through a legality gate.**

There are exactly four legal write paths today:
1. `commitWriteIfLegal()` — primary solver + repair phases. The single trust point.
2. `_runRulesCheck()` (alongside `_validateWritePlacement`) — Step 2.7 direct writes (special, sport-override, capacity-checked, anchor).
3. Rescue path inside Step 4.95 — also routes through `AutoSolverEngine.commitWriteIfLegal`.
4. `writeFree()` — Free is exempt from rule gating but still stamps `_startMin/_endMin`.

**If you add a fifth, you will introduce a regression.** Every audit pass has found one. Use one of the four.

### The triplet invariant

Three structures must stay synchronized:
- `scheduleAssignments[bunk][slotIdx]`
- `fieldIndex` (built by `buildFieldTimeIndex()` in the solver, keyed by normalized field name)
- `fieldUsageBySlot[slotIdx][fieldName]`

Any write that touches one MUST touch the other two. The repair phases each maintain their own local invariants; if you add a new phase, study `executeChain` for the rollback pattern (snapshot before mutate, atomic restore on rejection).

### Slot entry flags

Every entry in `scheduleAssignments[bunk][slotIdx]` may carry these flags. They are NOT mutually exclusive. Precedence (highest → lowest) when multiple are present:

| Flag | Set by | Read by | Semantics |
|---|---|---|---|
| `_league` | League scheduler | Solver, repair, safety net, pinned-preserve | League game. Never evicted, never overwritten by manual edit without explicit league flow. |
| `_activityLocked` | Auto-builder for `_isPrep` continuations | Solver, repair | Slot's activity cannot change. Field can change via repair-rescue if rule fails. |
| `_fixed` | Almost every writer | Solver, repair (skip eviction) | "Don't move this." Survives repair phases. Manual-edit writers set this universally. |
| `_pinned` | User pin, manual edits, multi-bunk edits, displacements, proposals | `pinned_activity_preservation`, safety net | Survives auto-gen via `capturePinnedActivities`. Validated against current access (Slice 3 N7 extended to timeRules + disabledSports + disabledFields). |
| `_bunkOverride` | Auto-builder Step 2, sport-override writes, manual edits | Solver pre-place | "User intent — solver may not touch this." |
| `_autoSpecial` | Auto-builder Step 1 | Solver | This anchor came from a layer config; the auto-builder owns it. |
| `_postEdit` | Manual edits, `_madeRoom`, `_rebalanced`, `_fromProposal`, `_cascadeReassigned` | Solver | "This was edited after generation; the next auto-gen should respect it." |
| `_madeRoom` / `_rebalanced` / `_cascadeReassigned` | Make Room / AutoRebalance / multi-bunk plan | Diagnostics only | Source labels for the entry. |

**Cardinal rule for manual writers:** If your edit represents user intent that should survive the next auto-gen, set BOTH `_fixed: true` AND `_pinned: true`. Setting only `_fixed` makes the entry "stable within this gen" but doesn't shield it from being overwritten when the user clicks Regenerate.

### Manual write paths (Slice 4)

The auto pipeline has `AutoSolverEngine.commitWriteIfLegal` as its single trust point. The manual side has its **own** trust point: `commitManualWriteIfLegal` exposed on `window` by `unified_schedule_system.js`. Every manual write site MUST route through it. Slice 4 audit hardened the following 7 entry points:

- `applyDirectEdit` (single-bunk edits from the modal)
- `applyMultiBunkEdit` (multi-bunk + cascade plan)
- `showMakeRoomModal` (displacement)
- AutoRebalance ar-apply
- `applyApprovedProposal` (primary + plan moves)
- `peiApplyTimeChange` (drag-resize / drag-move)
- `peiApplyNewBlock` (double-click Add)

The gate returns `{ ok: true }` or `{ ok: false, reason, soft }`. Soft violations (cooldowns) prompt the user; hard violations (access, disabledFields, disabledSports, activity-not-in-field) reject outright with a toast.

### Undo (Slice 4)

Promoted to a transaction shape. `peiSnapshotTransaction(bunks, description, opts)` captures the FULL pre-edit state of every affected bunk plus an inverse-counts payload. Persisted to sessionStorage per dateKey. Multi-bunk edits, displacements, rebalances, and proposal applies all snapshot via this helper. Earlier the undo stack was per-bunk single-snapshot only — Ctrl+Z after a 12-bunk action silently popped a prior 1-bunk action.

### Post-edit-in-progress marker

`window.markPostEditInProgress(ms = 8000)` is the only correct way to suppress realtime sync during a manual write. It uses a cancelable clear-timer pattern; legacy `setTimeout(() => _postEditInProgress = false, 8000)` is forbidden (a second edit racing with the stale timer clears the flag mid-second-edit and exposes the in-flight window to remote sync).

### Determinism

Slice 3 introduced deterministic tie-breaking (djb2 hash of `bunkName+activity+dayKey`). Same input + same `_iterSeed` → same schedule. Exception: `seedShuffle` for bunks whose name has no digits silently uses seed 0 (pre-existing minor issue).

## Known gaps (intentionally deferred)

- **Multi-day cooldowns** are not supported. `rules.js:isCandidateAllowed` evaluates against today's template only. Documented in `rules.js` near the function.
- **Custom layer event names** — `_ANCHOR_TYPE_BY_EVENT` lookup falls through to the explicit `blockType` parameter we pass in. If a caller forgets to pass `block.type`, customized layer names regress to `type='sport'`.
- **Public registration form** writes to localStorage only; cloud sync requires admin to open Campistry Me on same browser. Flagged HIGH in Slice 2; full fix needs a SECURITY DEFINER RPC + hCaptcha.
- **scheduler_core_auto.js is 15.6K LOC.** No human holds it in their head. A structural refactor (split into `phases/*.js` + extract `WriteTransaction`) is the right long-term move but is a 3-6 week project.

## Audit history

| Slice | Topic | Status | Commits |
|---|---|---|---|
| 1 | Cloud sync + persistence | ✅ done (4 audit cycles) | d486ef96 · 91ba802b · 084fb659 · a4b921cc |
| 2 | Auth + Supabase RLS | ✅ done (incl. migrations 003-006) | d39e00eb |
| 3 | Auto generation pipeline | ✅ done (3 audit cycles + this batch) | 92c58300 · c1401a82 · 48e27d63 · this |
| 4 | Manual builder / undo / displacement | pending | — |
| 5 | Rotation tracking + analytics | pending | — |
| 6 | Deletion / cleanup paths (re-audit) | pending | — |
| 7 | Calendar / day management | pending | — |
| 8 | Leagues + playoffs | pending | — |
| 9 | Daily adjustments + overrides + pinned | pending | — |
| 10 | Facilities / fields / specials | pending | — |
| 11 | Rendering + print path | pending | — |
| 12 | XSS / input validation | pending | — |
| 13 | Cross-device + race conditions | pending | — |
| 14 | Performance + bundle size | pending | — |
| 15 | UI flows (manual in-browser) | pending | — |

Full audit plan: `audit_plan.md`.

## Testing

Tests live in `tests/`, run with `node --test tests/*.test.js`. Browser-only files are mocked at the top of each test file. See `tests/calendar_delete_reset.test.js` for the mocking template.

Integration fixture tests for the auto pipeline live in `tests/auto_pipeline_*.test.js`. Run via:

```bash
node --test tests/auto_pipeline_*.test.js
```

If you change anything in the auto pipeline files (`scheduler_core_auto.js`, `auto_solver_engine.js`, `rules.js`, `rotation_engine.js`, `pinned_activity_preservation.js`), run those tests before committing.

## Coding conventions

- **No build step.** All JS is loaded directly; ES modules are NOT used in app code (tests can use `require`).
- **`window.X` globals** are the integration surface. Adding a new one is fine but document it here.
- **Defensive boundary coercion**: divisions keys can be strings or numbers. Use the `(divisions[grade] || divisions[String(grade)])` dual-key pattern at every lookup site, or `SchedulerCoreUtils.getDivisionRecord(grade)`.
- **`_validateWritePlacement` covers access + timeRules + special-access.** It does NOT cover cooldowns / FieldCombos / disabledSports — that's `_runRulesCheck`'s job. Always pair them.
- **Slice 1's per-key cloud merge** means writers should pass FULL sub-keys to `saveGlobalSettings('campistryMe', ...)` etc. The fetch-merge protects against accidental sub-key wipes, but it's shallow — a deliberate empty sub-key passes through.

## How to add a new feature to the auto pipeline

1. Determine which phase it belongs in (see "Execution order" above).
2. Use one of the four legal write paths. Do NOT introduce a fifth.
3. If your write needs new rule semantics, add them to `rules.js` and call via `SchedulingRules.isCandidateAllowed`.
4. If you cache anything, ensure invalidation. Repair phases that bypass the rotation cache will produce stale scores.
5. Add a fixture test. The runner is `node --test tests/auto_pipeline_*.test.js`.
6. Re-audit the affected slice from `audit_plan.md` before merging.
