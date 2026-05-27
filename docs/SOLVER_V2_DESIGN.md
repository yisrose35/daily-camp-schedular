# Solver v2 — Re-architecture for Backtracking

## Why

The v1 solver is a strictly forward pipeline:
`Phase 0 (pin specials/leagues) → Phase 1-2 (build shopping lists, draft sports) → Phase 3 (greedy pack + perfection-fill) → Step 4 (sport-field solver) → Step 4.5-4.95 (cleanups) → Step 5 (save)`

Once Phase 0 commits a placement, no later phase can revise it. This is the root cause of:
- Null buckets (no activity could fit between immovable walls)
- "Free" slots (solver gave up, no valid sport+field)
- 30+ minute wall-clock gaps inside a bunk's day
- Same-day repetition warnings that the rotation system flags but can't repair

v1 has been patched 5+ times for symptoms. The Day 14-15 audits surfaced the same continuation-skip / per-grade bypass bug in three different code paths because each phase reimplements the same logic with subtle differences. The architecture is the bug.

## Goals

1. **Zero null buckets and zero "Free" slots** in standard camp configs
2. **No hard rule violations** (field conflicts, access restrictions, time rules, sharing, full-grade) — same as v1 but enforced as part of the solver loop, not by post-hoc cleanup passes
3. **Better rotation fairness** than v1
4. **Smaller wall-clock gaps** between consecutive activities
5. **Deterministic for the same seed** (same input + same RNG seed = same output)
6. **Graceful infeasibility report** — when a camp config genuinely can't be solved, return best-effort + a list of which constraints had to be relaxed and by how much

## Non-goals

- Replacing manual builder, post-edit, calendar views, rotation engine, league engine — those stay.
- Cloud sync, save, restore, etc. — v2 produces the same `scheduleAssignments` shape as v1, so all downstream consumers work unchanged.
- Backwards-compat with bunkActivityOverrides, scheduledActivities, layer config — same input shape as v1.

## High-level approach

**Greedy seed + Simulated Annealing local search.**

1. **Seed**: reuse v1's existing pipeline through Phase 4 (sport assignment) to produce an initial schedule. We're not throwing v1 away — we're using it as the warm start.

2. **Validate**: compute the seed's cost via the constraint validator. If cost is 0 (hard violations clean, no holes, etc.), we're done.

3. **Local search**: until time budget exhausted, propose random moves, evaluate, accept by simulated annealing rule:
   - If the move reduces cost, always accept.
   - If the move increases cost by ΔC, accept with probability `exp(-ΔC / T)` where T is the current "temperature."
   - T starts high (accept most uphill moves to escape local minima) and cools toward 0 over the budget.

4. **Track best-seen**: at every step, if current schedule is the lowest-cost so far, snapshot it. Return the best snapshot at the end, not the last state.

5. **Reseed on stall**: if no improvement for N moves, re-randomize a small slice of the schedule (a "kick") and continue.

## Cost function

Each schedule has a numeric score; lower is better. The cost is the sum of:

| Term | Weight | What it counts |
|---|---|---|
| **Hard violations** | **disqualifying** (10⁹ each, effectively ∞) | Any field-conflict, access violation, time-rule violation, fullGrade-partial, max-usage-exceeded, exact-frequency-overshoot. The validator returns these as a list; the cost is `count * 1e9`. |
| **Null bucket** | 100 | Each `scheduleAssignments[bunk][i] === null` where the bucket exists in `_perBunkSlots`. |
| **Free slot** | 100 | Same penalty as null — solver gave up. |
| **Same-day repetition** | 30 | Bunk gets the same sport/special twice in one day. (Some sports are explicitly allowed to repeat via config; those skip this term.) |
| **Rotation unfairness** | 20 × deviation | For each (bunk, special) pair, the deviation of today's cumulative count from the ideal (e.g., if special's `minFrequency=2/week` and the bunk had 1 yesterday, ideal is +1 today). |
| **Wall-clock gap min** | 1 × (gap_minutes − 5) | Gap between consecutive non-anchor blocks. Anything ≤ 5 min is free (period transitions). 5-min above is cost 1, etc. |
| **Aesthetic** | small | Things like "swim immediately before lunch" if user prefers a buffer. Configurable, default 0. |

The 1e9 weight ensures SA never accepts a hard-violation move unless ALL other moves are also violating (degenerate camp). If the final result still has hard violations, the gen is reported as "infeasible" and the violations are listed.

## Move operators

The SA loop proposes random moves from this pool:

1. **Swap** — pick two non-anchor slots in the same bunk's day and swap them.
2. **Replace** — pick a slot, pick a different valid activity (from the bunk's rotation pool), assign it.
3. **Relocate** — pick a sport, pick a different field for it (must respect access + capacity + sharing).
4. **Cross-bunk swap** — pick two bunks of the same grade, swap a slot index between them. Useful for fixing field-cap conflicts.
5. **Slide** — shift a multi-block sequence ± one bucket within its allowed window. Closes wall-clock gaps.
6. **Inject** — pick a null/Free slot, pick the highest-cost-reducing activity + field combination that's valid.

Move selection is weighted by recent acceptance rate per move type (the SA tunes itself toward moves that are improving).

## Constraint validator

A single pure function: `validate(schedule, config) → { hardViolations: [...], cost: number }`.

Reuses the rule logic from v1's `commitWriteIfLegal`, `canBlockFit`, `_validateWritePlacement`, and the safety net's `checkAccess` / `checkTimeRules`. These functions are already correct; v2 just calls them from inside the SA loop.

The validator is the only place rules are checked. SA never "trusts" a move — every accepted move is validated. This eliminates the bypass class of bugs (perfFieldFreeAt missing gradeShareRules, etc.) that plagued v1.

## Module layout

```
scheduler_core_solver_v2.js       — main entry, SA loop, top-level orchestration
scheduler_core_v2_seed.js         — greedy seed builder (delegates to v1's pipeline)
scheduler_core_v2_cost.js         — validator + cost function
scheduler_core_v2_moves.js        — move operators
scheduler_core_v2_history.js      — best-seen tracking, acceptance stats
```

All v2 files load AFTER v1 files (so they can call v1's helpers like `_validateWritePlacement`).

## Feature flag

```js
// In integration_hooks.js or scheduler_core_loader.js
window.runAutoScheduler = async function(layers, options) {
  const g = window.loadGlobalSettings?.() || {};
  const v = g.app1?.solverVersion || 'v1';
  if (v === 'v2' && window.runAutoSchedulerV2) {
    return window.runAutoSchedulerV2(layers, options);
  }
  return window._runAutoSchedulerV1(layers, options);
};
```

`solverVersion` defaults to `'v1'` until Phase X4. Toggle via JS console for testing: `window.loadGlobalSettings().app1.solverVersion = 'v2'`.

## Migration phases

- **X1** (this doc, ~1 day): design doc, plan, feature-flag scaffolding, skeleton files.
- **X2** (~1-2 weeks): incremental build — cost function first, then validator, then SA loop, then each move operator. Test in isolation as we go.
- **X3** (3-5 days): parity testing on live preview. Run v1 vs v2 on same camp, diff outputs. Stress test with multiple camp configs. Tune SA hyperparameters (temperature schedule, kick threshold).
- **X4** (1-2 days): flip default to v2. Keep v1 reachable via flag for 2 weeks. After clean operation, delete v1 path.

## Time budget

- Default: **10 seconds per gen** (user-confirmed).
- SA hyperparameters chosen so the budget is fully used: ~5000 moves per second × 10s = 50k moves. For a 35-bunk camp with ~9 slots each, that's ~150 evaluations per slot — enough for SA to find a strong local optimum.
- Configurable via `g.app1.solverV2TimeBudgetMs`. If user wants 5s or 30s, just change the value.

## Failure mode

If SA budget exhausted and `validate()` still returns hard violations:
- Return the best-seen schedule (lowest cost, even if non-zero).
- Emit a structured "infeasibility report" object: `{ hardViolations: [...], suggestions: [...] }` — surfaces in the existing console diagnosis system and the UI's "Schedule Generated" dialog ("Generated with N warnings — click to see").
- The caller decides what to do (continue with imperfect schedule, or roll back).

## Testing strategy

- **Cost function unit tests** — known schedules with known cost. `tests/solver_v2_cost.test.js`.
- **Move operator tests** — each move generator produces only legal output. `tests/solver_v2_moves.test.js`.
- **Convergence test** — synthetic infeasible camp; verify SA settles on a stable best-seen instead of oscillating.
- **Determinism test** — same seed + same input = same output.
- **Parity log** — Phase X3 harness logs every (config, v1_output, v2_output, cost_v1, cost_v2). Acceptance: v2 cost ≤ v1 cost on ≥ 95% of test configs.

## Risks + mitigations

1. **SA hyperparameters need tuning** → make them all configurable via `globalSettings.app1.solverV2*`, ship sensible defaults, let stress tests tune them.
2. **Move operator misses a constraint** → validator catches it (rejected post-move). Worst case: a wasted iteration, not a corrupt schedule.
3. **Camp config really is infeasible** → graceful report, not a crash.
4. **Performance regression** → 10s budget is a hard ceiling. If SA isn't converging in 10s, return best-seen (which is at least as good as v1's seed).
5. **User wants to roll back** → feature flag stays for 2 weeks post-launch, can flip back per-camp.
