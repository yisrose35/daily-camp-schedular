# Auto Builder — session handoff (branch `claude/campistry-auto-builder-mode-bq7nwq`)

Context for a fresh Claude Code session picking this up **locally** (with a browser
extension / Browser MCP driving the real app). Written at the end of a remote session
that could not reach a browser.

## Where the numbers stand

Camp Neranina, 38 bunks / 7 grades, Monday 2026-07-27 (day 1/6 of the week):

| metric | value |
|---|---|
| real fill | **91%** (95.5% of *schedulable* time) |
| actionable dead | **485 min** across 38 bunks |
| bunks fully wall-to-wall | 30 / 38 |
| validator errors | **0** (every category) |
| SEAT AUDIT | clean camp-wide as of `ed80446`; residuals since are born-dead marks only |

Dead time decomposes as: **190 min** layout gaps (8) · **130 min** honest-open tiles (9)
· **120 min** field-less Sport placeholders (3) · rest = per-bunk slivers.
(525 min of "empty" is bell-schedule transition slivers — unfillable by design, excluded.)

## The live diagnosis (verified by reading the code, NOT yet by experiment)

**1. The per-bunk subcategory cap is the binding constraint — not capacity.**
Every grade logs `uncategorized (avail=11, floor=1 → cap=1)`. Chain:
`subOps` default to `'='` when unset (`scheduler_core_auto.js:5337`) → `'='` sets
`cap = qty` (`:5356`) → an explicit finite cap is honored exactly (`:18567`).
So each bunk may hold **one** of eleven available activities. That is why every
surviving gap is annotated `| others capped` and goes OPEN with 10 activities unused.
The engine is *correct* to honor it (it is the user's stated ceiling); `e6900a9` added a
STEP 1.5 warning naming the `">="` operator as the lever.

> **HIGHEST-VALUE EXPERIMENT:** in the special layer, set the **uncategorized**
> subcategory operator to `">="` (at least 1) instead of `"="`. Predicted: cap rises
> 1 → 11, bunks take 2-3 uncategorized activities, and most of the 190 min closes.
> **This is a prediction, not a measured result — verify it before trusting it.**

**2. A duration shortage is masquerading as a seat shortage.**
12 of 13 uncategorized activities run **40 min only**; only Baking does 30. So
`uncat@30` has 1 seat camp-wide while 26 bunks demanded it (`GENERIC-RECONCILE`).
Absorb was minting 10- and 20-min "Special: Uncategorized" placeholders that could
never fill; `e6900a9` marks those `_bornDead` and reports them as a **duration**
shortage instead of "+N seats". The real fix is a *shorter* activity.

## What to verify first in a real browser

1. **Regenerate Monday 2026-07-27** and confirm the baseline above reproduces.
2. **Flip the `>=` operator** on uncategorized, regenerate, diff `actionable dead`.
   This is the one experiment that most likely moves the number.
3. Watch the new log lines: `CROSS-BUNK examined N … repaired`, `duration shortage`,
   the STEP 1.5 throttled-subcat warning, and `[GENERIC-ABSORB]` born-dead counts.
4. `downloadGenTrace()` after a run — 800+ events, 1200+ score breakdowns. Far richer
   than the console; use it instead of log-reading when diagnosing a specific tile.

## Open items

- **Quartets ז shiur 20 min `[capacity-stuck]`** — recurs across runs. Single stranded
  shiur; suspected fill-order contention on Shiur 2. Not yet chased.
- **CROSS-BUNK repaired 0 of 5** examined gaps (`66648f6` added two vacate modes:
  relocate-into-own-free-window, and equal-duration swap). Both fail here because the
  gaps are 30-min and this camp has almost no 30-min-capable tiles to trade. If the
  `>=` experiment works, re-check whether this pass is still needed.
- **Swap-chain cannot fire on 30/20/10-min gaps**: the mover's duration must be a legal
  *sport* duration (a sport back-fills its old slot) and sports here are 40-min only.
  Generalizing the back-fill is unexplored.
- **Theme Activity shareability** — `A4.6-DIAG` reports 9 sessions could collapse to ~4
  if shareable. Standing config recommendation; frees midday field time.

## Kill switches (all default ON)

`__actMatchGate` · `__fillAware` · `__constrainedFirst` · `__seatLedgerMoves` ·
`__seatRebuild` · `__crossBunkRepair` · `__spreadPressure` · `__subcatStrict` ·
`__honestOpenTime` · `__weeklyQuota` · `__physActSeat` · `__seatGate` · `__absorbSport`

Set any to `false` in the console before generating to A/B a pass.

## Test baseline (do not "fix" these)

- `tests/auto_full_day.test.js` — **17 pass / 10 fail**; those 10 are *pre-existing*
  failures (tests 1,2,3,5,11,13,14,15,21,22) that predate this work.
- Everything else green: `period_layout` 54, `gl_*` + metrics + packer/tiler → 203 total,
  other auto-engine suites 58.

## Product rules these changes are built on

No filler concept · subcat-strict (a subcat tile is that subcat or genuine OPEN) ·
fill-if-possible (OPEN is last resort) · warn-don't-repeat · honest reporting
(**never manufacture a tile that cannot be filled** — the born-dead work enforces this).
