# Solver v3 — Constructive Constraint-Aware Builder

## Why v3 exists

v2 (SA + smart repair) has plateaued. It's strictly better than v1 across every measured metric, but can't hit "perfect" because the **v1 seed it polishes has structural issues v2's moves can't fix**:

- Bucket grids that don't align to period boundaries
- Swims placed without bookend Change blocks
- Activities placed at locations that border unfillable gaps
- Same-time conflicts that get cleared to Free with no replacement

v2 polishes within v1's choices. v3 makes the choices smarter from the start.

User-described goals (verbatim, captured 2026-05-15):
> "making the generation smarter when it comes to placing. making it thought out and allowing for self learning, and then when things don't work out self healing"

## v3 vs v2 vs v1

| | v1 | v2 | v3 |
|---|---|---|---|
| Strategy | Greedy forward pipeline | Random local search on v1 seed | Constraint-driven constructive builder + v2 polish |
| Bucket grid | Inherited from layer config; gaps possible | Same as v1 | Period-aligned from the start |
| Anchor handling | Best-effort | Frozen, can't add Change blocks | Atomic units (swim+change inseparable) |
| Placement order | Layer order | Random | Most-constrained-first |
| Self-healing | Phase 4.5/4.95 cleanup (clears violations to Free) | Smart repair pass after SA | Constraint propagation during placement + repair after |
| Learning | None | None | Per-camp-config weight adaptation |
| Time budget | ~1-2s | ~10-30s | ~30-60s |

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  runAutoSchedulerV3(layers, options)                    │
│                                                         │
│  Phase A: PRE-FLIGHT ANALYSIS                           │
│    - Parse camp config → ConstraintGraph                │
│    - Compute resource scarcity                          │
│    - Build placement priority queue (most constrained)  │
│                                                         │
│  Phase B: CONSTRUCTIVE PLACEMENT                        │
│    1. Build period-aligned bucket grid per bunk         │
│    2. Place hard-pinned (specials, leagues) atomically  │
│    3. Place fullGrade specials grade-wide atomically    │
│    4. Place swim+change atomic units                    │
│    5. Place sports respecting field/sharing/access      │
│    6. Fill rotation pool for remaining slots            │
│                                                         │
│  Phase C: VALIDATION                                    │
│    - Run hard-violation detector                        │
│    - Surface any unsolvable constraints                 │
│                                                         │
│  Phase D: SMART REPAIR (reuse v2's smartRepair)         │
│    - Fix any residual violations                        │
│                                                         │
│  Phase E: SA POLISH (reuse v2's SA loop)                │
│    - 10-15s of local search to optimize beyond Phase B  │
│                                                         │
│  Phase F: LEARNING                                      │
│    - Record this run's success metrics                  │
│    - Update per-camp weight overrides                   │
│    - Persist to globalSettings.solverV3LearningData     │
└─────────────────────────────────────────────────────────┘
```

## File layout

```
scheduler_core_solver_v3.js          — main entry, orchestrates phases
scheduler_core_v3_constraints.js     — Phase A: constraint graph + analysis
scheduler_core_v3_builder.js         — Phase B: constructive placement
scheduler_core_v3_learning.js        — Phase F: success tracking + weight adaptation
                                       (Phases C, D, E reuse v2 functions)
```

## Phase A — Pre-flight constraint analysis

Input: camp config (`window.divisions`, `g.app1.fields`, `g.specialActivities`, layers, periods).

Output: `ConstraintGraph` with:
```js
{
  bunks: [...],                  // ordered by placement priority
  periods: { [grade]: [{start, end, name}, ...] },
  hardPinned: [                  // must place at exact time
    { type: 'special'|'league'|'rotation_event',
      activity, time, target: bunk[] }
  ],
  fullGradeSpecials: [...],      // place grade-wide atomically
  swimSlots: [                   // swim + change pairs
    { bunk, swimWindow, preChangeMin, postChangeMin }
  ],
  sportsRotation: {              // per bunk, rotation-ranked pool
    [bunk]: [ {sport, score, fields[]}, ... ]
  },
  fieldDemand: {                 // contention map for scarce fields
    [field]: { capacity, totalDemand, peakConcurrent }
  },
  scarcity: {                    // pre-computed scarcity scores
    activities: { ... },         // higher = more constrained
    fields: { ... }
  }
}
```

Placement priority ordering:
1. Hard-pinned activities (least flexibility)
2. fullGrade specials (grade-wide locking)
3. Swim+Change atomic units (block 50+min of day)
4. League games (cross-bunk dependencies)
5. Sports with `frequencyDays` cooldowns
6. Sports with `exactFrequency` constraints
7. Free rotation sports (most flexibility)

## Phase B — Constructive placement

### B.1 Bucket grid

For each bunk, build a per-bunk slot array `_perBunkSlots[grade][bunk]` whose buckets:
- Start/end on PERIOD boundaries (not floating times)
- Cover the bunk's whole day with no gaps (except natural period-transition gaps which are exempt from the wall-clock-gap cost)
- Match the bunk's grade's `campPeriods` exactly

This eliminates the "structural gap" issue at the source.

### B.2 Atomic anchor placement

When a swim is configured for a grade:
- Allocate the bucket(s) the swim will occupy
- Allocate adjacent bucket(s) for pre-change AND post-change
- All three (or two) placed atomically — never one without the others

### B.3 Most-constrained-first sport placement

For each placement round:
1. Find the bucket with the FEWEST viable activity options (most constrained)
2. Pick the activity that best fits (rotation fairness + field availability)
3. Place + propagate constraint updates (reduce options for related buckets)
4. Repeat until all buckets filled

### B.4 Backtracking

When a placement creates a dead-end (a later bucket has zero options), back up:
1. Mark the offending placement as "tried"
2. Try the second-best option
3. If exhausted, back up further
4. Bounded depth (max 50 backtracks per run) to prevent infinite loops

### B.5 Failure mode

If full placement fails after backtracking limit:
- Return the best partial schedule
- Report `infeasibility` list with concrete reasons
- Let Phase D (repair) and Phase E (SA) try to salvage

## Phase F — Learning

Stored in `globalSettings.solverV3LearningData`:
```js
{
  campId: "...",
  runs: 12,
  metrics: {
    avgHoles: 0.2, avgGaps: 3.1, avgSigGaps: 0.8, ...
  },
  moveSuccess: {
    addChange: { proposed: 4231, accepted: 1893 },
    bucketInsert: { ... },
    ...
  },
  weightAdjustments: {
    bucketInsert: 1.3,    // multiplier on default weight
    swap: 0.7,
    ...
  }
}
```

On each gen:
- After SA done, update `runs++`, accumulate `metrics`
- Compute success rate per move; if > 50% above baseline, bump weight; if < 50% below, reduce
- Persist to `globalSettings`

Across gens, the camp-specific weights adapt to what works for THIS specific camp config.

## Migration

- v3 loads alongside v1 and v2.
- New feature flag value: `globalSettings.app1.solverVersion = 'v3'`.
- Default stays `'v1'` until v3 hits parity AND user approves.
- v1 and v2 stay reachable indefinitely as fallback.

## Build sequence

1. Design doc (this file) ✓
2. Phase A — constraint graph builder ✓
3. Phase B — constructive placement (skeleton) ✓
4. Phase C+D+E — wire SolverV2.runSA + smartRepair via public API ✓
5. Phase F — learning component (record + weight adaptation) ✓
6. Parity testing + tuning (pending)
7. Phase B coverage iteration (Change blocks, leagues, multi-period) (pending)

All v3 phases A–F are deployed behind the `solverVersion='v3'` flag. v2 now exposes `window.SolverV2 = { getConfig, buildContext, evaluate, detectHardViolations, runSA, smartRepair }` as a public API so v3 reuses the polished SA loop on its period-aligned constructive seed.
