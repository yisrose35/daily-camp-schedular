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
| `auto_feasibility.js` | 0.5K | Phase A diagnostic: pre-flight report + post-solve forensics |
| `rules.js` | 1.1K | Cooldown / FieldCombos rule engine |
| `rotation_engine.js` | 1.3K | Per-bunk-per-activity rotation scoring |
| `pinned_activity_preservation.js` | 0.6K | Pin gate (drop pins that violate current rules) |
| `scheduler_core_utils.js` | 2.6K | Shared helpers |

### Execution order

```
Pre-flight  — AutoFeasibility.check (Phase A1: structural feasibility report)
Phase 0     — Overrides applied (disabledFields/disabledSports/customBlocks)
Phase 1     — Anchor placement (Lunch/Swim/Snack from layer config)
Phase 2     — Specials placement (todaysSpecials, sorted narrowness-first)
Step 2.7    — Direct writes (specials, sport overrides, capacity-checked, anchors)
Phase 3     — Main solve via auto_solver_engine.solve()
Repair      — lnsRepair / colocateFreeBlocks / ejectionChainRepair / bfsAugmentingRepair
Step 4.95   — Rule safety net (fixed-point loop, max 3 iterations)
Forensics   — AutoFeasibility.forensics (Phase A2: post-solve Free breakdown)
Phase 5     — Save (schedule + rotation history + cloud sync)
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

### Determinism

Slice 3 introduced deterministic tie-breaking (djb2 hash of `bunkName+activity+dayKey`). Same input + same `_iterSeed` → same schedule. Exception: `seedShuffle` for bunks whose name has no digits silently uses seed 0 (pre-existing minor issue).

### Phase A — diagnostic / observability layer

`auto_feasibility.js` is observation-only. It does NOT write to `scheduleAssignments`, mutate layers, or block generation. It produces two reports per run:

- **Pre-flight (`window._lastFeasibilityReport`)**: structural feasibility verdict, per-bunk unique-sport-pool analysis, per-window field capacity check (Hall's margin), per-special contention. Includes ranked recommendations the user can act on (enable a field, raise capacity, etc.).
- **Post-solve (`window._lastFreeForensicsReport`)**: categorizes every remaining Free block by `_freeReason`, cross-references against the pre-flight report to separate predicted-by-config Frees from unexpected ones (algorithm misses / Cause 3 layout problems).

**Free block `_freeReason` taxonomy** — every write that produces a Free should stamp one of:
- `pool_exhausted` — bunk's unique-sport pool ran out (Cause 1 territory)
- `capacity_deficit` — no field had capacity at this time (Cause 2 territory)
- `all_disqualified` — mixed pool/capacity pressure
- `no_candidates` — solver received zero candidates (Cause 1 / config)
- `invalid_block` — block had null bunk/time data
- `constraint_demoted` — Step 4.5 demoted for violation
- `rule_violation_cleared` — Step 4.95 rescue rejected
- `back_to_back_cleared` — consecutive same-sport cleared
- `no_augmenting_path` — repair phase couldn't find a swap
- `unknown` — fallback for unstamped Frees (should not occur in steady state)

Any new code path that writes Free MUST stamp `_freeReason` so the forensics summary stays accurate.

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
