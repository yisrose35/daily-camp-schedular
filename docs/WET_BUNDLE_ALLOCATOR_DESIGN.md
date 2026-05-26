# Wet-Bundle Slot Allocator — Design & Build Plan

**Status:** Design (not yet built). Supersedes the two reverted in-session patches.
**Owner area:** `scheduler_core_auto.js` Phase 0 swim placement + Phase 2.4 bundling.
**Goal:** Reliably cover **all eligible bunks** with a wet-bundle rotation event
(e.g. Water Slide adjacent to Swim) across its multi-day date range — without
ever shipping a disconnected slide, creating a gap, or evicting another grade.

---

## 1. Problem statement

A "wet bundle" is a rotation event (Water Slide) that must sit **immediately
adjacent** to swim: `Change → WS → Swim → Change` or `Change → Swim → WS → Change`.
Hard rules (user-confirmed, do not relax):
- **Adjacency > quota:** never ship a disconnected slide; defer to a future day instead.
- **No gaps / no holes.**
- **Same-grade pool floor** (this config): pool is `cross_division`, capacity **20 bunks**,
  **11 allowedPairs**. Slide concurrency ("Bunks at a Time") = **8**.

### The structural ceiling we are fighting
With the current rotation matrix (`buildRotationMatrix`, seed is iteration-derived
and **constant per day**), grades **Quartet, Soloists, and often Majors** are
assigned **afternoon swim bands** (2:14–3:45pm, or post-lunch) on *every* day.
A swim in the last period — or immediately after lunch — has **no open adjacent
period** for the slide, so those bunks can never bundle. Result: coverage swings
between ~22 and ~33 of 35 purely on seed luck. The 8–14 "afternoon-band" bunks
are the ones that never get the slide.

**Success criteria:** over a 3-day range, **every** eligible bunk bundles the
slide on **at least one** day, with zero disconnected slides and zero gaps —
*deterministically*, not by lucky seed.

---

## 2. Failure analysis — the two reverted attempts (DO NOT REPEAT)

Both were reverted because they made coverage **worse**, not better.

### 2a. Greedy "band escape" (commit `006e4aa7`, reverted) — 33 → 27
Moved an un-bundleable grade's swim to the earliest pool-free period **per-grade,
greedily**. It checked `canUsePoolAtTime` but **not the slide concurrency** — and
at Phase 0 the slide isn't placed yet, so the live ledger couldn't predict the
Phase-2.4 slide congestion. Quartet escaped into the morning and consumed the
slide capacity **Soloists** was using → all of Soloists dropped. **Lesson: you
cannot seat one grade without accounting for the slide/pool budget of every other
grade. Per-grade greedy is fatal.**

### 2b. Global allocator v1 (commit `c1283459`, reverted) — 33 → 19
Modeled only **pool capacity + slide concurrency + lunch**. It ignored each grade's
**own pinned anchors** (Main activity, leagues) and the real **same-grade /
allowedPair pool rules**, and it **replaced the per-grade spreader for ALL grades**.
So it pinned swims onto periods that collided with unmodeled constraints; the
downstream placer then relocated them off-plan to un-bundleable spots, and the
cascade broke grades that were previously bundling fine. **Lesson: the Phase-0
swim placement is a tightly-coupled heuristic that silently satisfies a web of
constraints. Any planner that overrides it must model ALL of them, or it does net
harm. And it must only touch grades it can actually improve.**

---

## 3. Constraint catalog (the allocator MUST model every one)

A proposed (swimPeriod, slidePeriod) assignment for a grade is **valid only if**:

1. **Swim fits a pool period** of ≥ swim duration, inside the grade's daily window.
2. **Pool capacity** at the swim period: `poolLoad[S] + gradeBunks ≤ poolCap` (20),
   AND cross-grade co-occupancy respects `allowedPairs` (not just the number).
3. **Slide concurrency** at the slide period: `slideLoad[D] + gradeBunks ≤ 8`.
4. **Adjacency:** D is immediately before or after S (period-adjacent), and the gap
   between them holds only Change/Cleanup (≤ the adjacency tolerance).
5. **Not lunch-blocked:** neither S nor D overlaps lunch, and the S↔D gap isn't lunch.
6. **No own-anchor collision:** S must not overlap the grade's own pinned anchors
   (Main activity, league, lunch, snack, Nit) — the thing v1 ignored.
7. **Leading-change room** for the canonical `Change→WS→Swim` (WS not at day-start).
8. **Within the grade's daily window** (start/end).

The allocator keeps its **own forward-simulated** `poolLoad[]` and `slideLoad[]`
counters (the live `_resourceBuckets` ledger is empty pre-placement, so it cannot
be consulted for the *future* slide load — this was the escape's fatal blind spot).

---

## 4. Integration map (reverse-engineered this session)

All line numbers approximate `scheduler_core_auto.js` as of the 33/35 baseline
(after reverts; HEAD `2c66737d`+ the memory note re: phantom fix `6ff962eb`).

| Concern | Location | Notes |
|---|---|---|
| Phase-0 placement loop | `orderedPinned.forEach` ~L2487, inside a Phase-0 helper | grade per layer; runs **per tabu iteration** |
| `orderedPinned` sort | ~L2450 | order of pinned-layer placement |
| Wet-bundle swim spreader (periods case) | ~L2759–2858 | already bundle-aware, but **band-constrained** + overridden downstream |
| Authoritative pool placer | ~L2887–3000 | re-picks swim by pool-center + `canUsePoolAtTime`; **overrides the spreader**; only triggers when `!canUsePoolAtTime \|\| _swimOverlapsOwnAnchor` |
| Linked-rot adjacent placement | ~L3008–3060 | Phase-0 also tries to co-place the WS |
| `canUsePoolAtTime(grade,s,e)` | L1431 | pool cap + allowedPairs via `rtCanUse('pool',…)`; **stateful** |
| `canUseRotationSlotAtTime(eid,conc,grade,s,e)` | L1537 | slide concurrency via `rtCanUse('rotevt',…,'all',conc)`; **stateful** |
| `_resourceBuckets` / `rtRegister` / `rtCanUse` | ~L1500 region | shared per-5-min resource ledger |
| Rotation matrix (band assignment) | `buildRotationMatrix` L11895; called L12134 | `_typeOrderSeed = totalIters*7919+1`, `_iterSeed` from tabu — **both date-independent** |
| Quota (`getRotationQuotas`) | `_phase24Quotas` L12704; `daysLeft/dailyTarget` | per-event remaining across range |
| Completion ledger | `RotationEvents.completedBunks[dateKey]`; `markCompleted` (rotation_events.js L496) | **now marked at STEP 4.996c** from the final grid (commit `6ff962eb`) |
| `layersByGrade` | built L1048 | available at L2487 ✓ |
| Kill-switch precedent | `window._DISABLE_BUNDLE_ALLOCATOR` | used by reverted v1; reuse |

---

## 5. Proposed architecture

A new **Phase-0.4 Bundle Planner** that runs **once per generation** (before the
`orderedPinned.forEach` placement loop), producing a read-only plan
`_bundleSwimPlan[grade] = swimStartMin` that the swim spreader **consults but the
authoritative placer also respects**.

### Algorithm (global, capacity-aware, urgency-first)
1. **Enumerate bundleable slots** for the day: every (S,D) period pair satisfying
   constraints 1,4,5,7,8 (the day-structure ones, independent of load).
2. **Compute per-grade bundle-debt** from the ledger across the event's date range:
   `debt(grade) = bunks not yet completed in range`. Higher debt + fewer days left
   = higher priority. (On day 1 everyone has full debt → pack by capacity; covered
   grades yield on later days so coverage *spreads across the range*.)
3. **Assign grades → slots, urgency-first**, against the forward-simulated
   `poolLoad[]`/`slideLoad[]` and the allowedPairs/own-anchor checks (constraints
   2,3,6). Seat a grade only where there is **genuine spare capacity** — never evict.
   If no slot fits today, the grade is **deferred** (stays top-priority tomorrow).
4. **Pin** each assigned grade's swim at its S. Crucially, also make the
   **authoritative placer prefer the planned period** for planned grades (so it
   doesn't relocate off-plan), and **fall back cleanly** to today's behaviour for
   any grade the planner did NOT assign (no override → no regression for the
   already-working grades — the v1 mistake).

### Why this beats the failures
- It is **global** (won't rob Soloists to pay Quartet — fixes 2a).
- It models **all** constraints incl. own-anchors + pair rules (fixes 2b).
- It only **adds** assignments where capacity genuinely exists; un-assignable grades
  keep current behaviour rather than being force-pinned (fixes 2b's "override all").

There is concrete headroom to exploit: on low days (e.g. 5/27 ran only 5 slides,
5/28 only 6) the slide is nowhere near its cap of 8 — the planner targets those
slack days for the afternoon-band grades instead of fighting a full morning.

---

## 6. Phased, testable rollout (each phase verified live before the next)

- **P0 — Design** (this doc). ✅
- **P1 — Read-only planner + instrumentation.** Build `_planBundleSlots()` that
  logs the plan it WOULD make (`[BundlePlanner] would assign …`) but changes
  nothing. Verify the plan looks sane across several regenerations (does it seat
  Quartet/Soloists on slack days? does it respect caps?). **No behaviour change.**
- **P2 — Own-anchor + pair-aware feasibility.** Add constraints 2(pairs) and 6 to
  the planner's slot test; re-verify the logged plan never proposes an
  anchor/pair-illegal slot.
- **P3 — Wire the pin (flagged OFF by default).** Behind `globalSettings.app1.bundleAllocator===true`,
  let the planner pin swims AND teach the placer to prefer planned periods. Test
  3-day coverage with flag ON vs OFF; require **coverage ≥ baseline on every run**
  before proceeding.
- **P4 — Cross-day rotation tuning.** Tune debt/urgency weights so coverage
  *spreads* (everyone covered once across the range). Target 35/35.
- **P5 — Default ON** only after P3/P4 show consistent ≥ baseline with zero
  disconnected slides and zero gaps across many regenerations.

Every phase: `node --check` before commit; commit + push to `Daily-Audit-Walkthrough`;
verify with the coverage snippet (below). Kill-switch `window._DISABLE_BUNDLE_ALLOCATOR`
stays for instant rollback without redeploy.

---

## 7. Verification protocol

After regenerating the full date range **in order**, run the coverage snippet
(grid vs ledger + cumulative coverage). Acceptance per change:
- **Coverage ≥ previous baseline** on EVERY run (never a regression — today's hard lesson).
- Every day: `ledger == grid` (no phantom).
- `[REAL-GAP] ✅ ZERO real gaps`.
- Zero `DROPPED disconnected` that a feasible slot existed for.

```js
(function(){
  const D=['2026-05-26','2026-05-27','2026-05-28']; // update to the live range
  const all=(window.loadAllDailyData&&window.loadAllDailyData())||{};
  const cur=window.currentScheduleDate;
  const grid=d=>(d===cur&&window.scheduleAssignments&&Object.keys(window.scheduleAssignments).length)?window.scheduleAssignments:((all[d]&&all[d].scheduleAssignments)||{});
  const isWS=s=>/water\s*slide/i.test((s&&(s._activity||s.event||s.type)||'')+'');
  const ever={};let ws=null;try{(window.RotationEvents.loadRotationEvents()||[]).forEach(e=>{if(/water\s*slide/i.test(e.name||''))ws=e;});}catch(e){}
  const L=[];
  D.forEach(d=>{const g=grid(d);const on=new Set();Object.keys(g).forEach(b=>{if((g[b]||[]).some(isWS)){on.add(b);ever[b]=1;}});
    const rec=(ws&&ws.completedBunks&&ws.completedBunks[d])?ws.completedBunks[d].length:0;
    const ph=((ws&&ws.completedBunks&&ws.completedBunks[d])||[]).filter(b=>!on.has(b));
    L.push(d+': grid='+on.size+' WS, recorded='+rec+(ph.length?'  PHANTOM='+ph.length:'  ledger==grid'));});
  const a=new Set();D.forEach(d=>Object.keys(grid(d)).forEach(b=>a.add(b)));
  const miss=[...a].filter(b=>!ever[b]);
  L.push('COVERAGE: '+Object.keys(ever).length+'/'+a.size+(miss.length?'  MISSING: ['+miss.join(', ')+']':' — ALL COVERED'));
  console.log(L.join('\n'));
})();
```

---

## 8. Open questions / risks
- **Does the planner belong per-iteration or once per generation?** Once is cleaner
  (it's day-structure + ledger driven, both iteration-independent) but the placer
  runs per iteration — confirm the pin survives the tabu loop / elite restore.
- **v2 solver interaction:** the SA runs after the v1 seed. Confirm it doesn't move
  pinned swims (it hasn't been observed to, but verify under the flag).
- **Pair-rule fidelity:** replicate `rtCanUse`'s allowedPairs logic exactly, or call
  a pure (non-registering) variant, so the plan and `canUsePoolAtTime` never disagree.
- **Feasibility:** if a week is genuinely capacity-maxed, 35/35 may be impossible;
  the planner must then guarantee the *fairest* rotation (cover as many as capacity
  allows, rotate who misses) rather than the same grades always losing.

---

## 9. Build log & P4 findings (2026-05-26)

**Shipped:** P1 (`682f2235`), P2 own-anchor+allowedPairs (`2bfdcfee`), P3 flag-gated
pin (`b1203ecb`) + `window._FORCE_BUNDLE_ALLOCATOR` test override (`c8c92fbf`).
Flag default OFF; deployed code is inert until enabled.

**Test harness (reliable A/B):** the auto-regen loop (two tabs on the same realtime
camp) + completion-ledger accumulation made naive measurement non-deterministic
(same day gave 11 and 16). Clean protocol: close the 2nd tab; before EACH gen
`RotationEvents.clearCompletedForDate('<date>')` to reset debt; trigger via DOM
(`[...buttons].find(b=>/generate schedule/i.test(b.textContent)).click()` — works
even when the editor is hidden behind the view); read coverage from
`window.scheduleAssignments`. With this, baseline is reproducibly **16** on 05-26.

**Clean A/B on 05-26 (cleared ledger, Majors already done on 05-28):**
- Flag OFF (baseline): **16** — Quints 8, Trios 6, Minors 2 (the morning-band grades).
- Flag ON: **12** — Quints 8, Minors 2, **Quartet 2** (rescued ✓), Soloists 0, Trios 0.
- → **REGRESSION −4.** Flag stays OFF.

**Root causes (confirmed via 116 `[Phase0][P3]` pin logs + per-grade swim/slide dump):**
1. **Adjacency infidelity.** Planner pinned Soloists swim@735 (12:15) with slide
   "before" — but Soloists' period grid has a gap so the slide period ends at 730,
   not 735 → not flush → Phase 2.4 can't attach it → Soloists 0. The planner treats
   array-consecutive periods as time-adjacent; it must require `D.endMin===S.startMin`
   (before) / `S.endMin===D.startMin` (after) on the grade's REAL grid.
2. **Baseline displacement (the −6).** Planner pinned Quartet swim@650 (10:50) — the
   SAME slot Trios uses to bundle at baseline. Trios wasn't planned, so its slot
   wasn't reserved; the pinned Quartet (placed first via Edit C) stole 10:50 and
   Trios fell out. Classic "per-grade greedy robs another grade" (§2a/2b).

**Fix plan — make the planner ADDITIVE (only touch grades it can improve):**
- The spreader already bundles MORNING-band grades fine (Quints/Trios/Minors). The
  planner must (a) detect those natural bundlers (matrix swim band has a truly-adjacent
  free slide period) and NOT pin them, only RESERVE their pool/slide usage; (b) pin
  ONLY the stranded afternoon-band grades (Soloists/Duetos/Quartet/Majors) into
  leftover feasible slots; (c) require true time-adjacency (fix #1) so it never
  seats a grade whose slide can't attach. Net target: baseline 16 + afternoon
  rescues, never < baseline.
- Needs: confirm `staggerPlan[grade].typeBands.swim` (matrix band) is in scope at the
  planner (~L2500); replicate the spreader's "band has a bundleable neighbour" test;
  reserve natural-bundler (swim,slide) intervals in `_seatedSwims/_seatedSlides`
  BEFORE seating stranded grades.
- Verify each iteration against the harness: coverage ≥ 16 on 05-26 AND cumulative
  35/35 across 05-26→28, 0 disconnected, before flipping the flag default (P5).
