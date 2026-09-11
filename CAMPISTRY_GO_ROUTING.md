# Campistry Go — how bus routes are built

This is the design of the routing engine behind **Go → Routes → Generate**, the
rules it enforces, and where each rule came from. It exists so the next person
who touches routing can tell a deliberate choice from an accident.

Files: `campistry_go.js` (`generateRoutes`, both pipelines),
`campistry_go_neighborhoods.js` (road-graph neighbourhoods, `packIntoBuses`),
`campistry_go_route_post.js` (pure: ordering, capacity, containment gate, sweep,
polish, road network, audits). Tests: `tests/bus_*.test.js`.

## The goals, in order

1. **Every child seated.** A bus never leaves with more children than seats.
2. **Every bus stays on one side of camp.** No route drives out north, turns
   around and drives back through camp to go south.
3. **Efficient, not equal.** The fleet's total minutes are minimised. Buses are
   not evened out; a camp that wants that turns on *Balance Bus Loads*.
4. **Nobody rides absurdly long.** A soft budget per bus, and a per-child check
   against their direct trip.

## Pipeline

```
addresses ─ geocode ─┬─ road graph (OpenStreetMap) ─ neighbourhoods ─ packIntoBuses
                     │                                   greedy  ┐
                     │                                   sweep   ├─ pick → polish
                     └─ (no graph: sandbox / Overpass down) ─ k-means ┘
                                                                   │
              stops per bus (door / optimized / corner) ───────────┘
                                                                   │
        per-bus ordering (children-minutes objective, road legs if available)
                                                                   │
   post passes: hard capacity → (opt-in) balance → ETAs → duration split → ETAs
                                                                   │
   final street-time pass → containment audit → dashboard exceptions
```

### Districting (who rides which bus)

* **Sweep** (`sweepPartition`): atoms (road segments, or sibling groups on the
  k-means path) are walked in bearing order around camp and cut into one
  contiguous arc per bus by dynamic programming: minimise total estimated
  riding minutes, each arc within its bus's seats, a penalty for splitting a
  neighbourhood, a penalty for arcs over the riding budget, and a per-bus
  overhead. Every rotation of the seam is tried. It cannot straddle camp and it
  cannot fail on a tight fleet.
* **Greedy packer** (`packIntoBuses`): the older neighbourhood-first placement.
  It carries last year's bus mapping. Kept whenever it is contained and within
  15 % of the sweep's score; the sweep wins outright when the greedy result
  has a bus on both sides of camp.
* **Polish** (`polishDistricts`): local search that moves single atoms between
  buses or swaps two, priced on each bus's own tour, under seats and
  containment. A **ruin-and-recreate** phase (remove a radial cluster of
  atoms, re-insert cheapest-first, keep if better — the large-neighbourhood
  step used by jsprit and VROOM) is implemented but off by default
  (`polishLnsIters`): measured on camp-shaped layouts it added nothing over
  relocate/swap and spent the whole time budget.

### Containment

The arc a bus covers around camp is the smallest wedge containing all its
stops beyond 1.5 mi from camp. Above **110°** a bus is on both sides of camp.
Every pass that moves a stop between buses goes through one gate
(`stopFitsRoute`): near an existing stop of the receiver, and not widening the
receiver's wedge past the limit.

### Ordering (`localTspOrder`)

Objective is **children-minutes** (minimum latency), plus twice the minutes a
child rides beyond `2 × direct trip + 25`, plus the tour length as a tie-break.
Arrival mode charges the drive from the last pickup back to camp. Multi-start
nearest-neighbour + distance 2-opt, then 2-opt and or-opt on the real
objective. Seeds are chosen by geometry (nearest, farthest, spread by bearing)
and the incoming order is itself a seed, so the result depends only on the set
of stops: generation and Re-optimize agree. Measured within 0.005 % of an exact
minimum-latency optimum on 8–11 stop routes.

### Travel times

With a road graph: **street network travel times** (`buildRoadNet`) — Dijkstra
over the OpenStreetMap graph with class-based speeds (residential 20 mph,
tertiary 25, secondary 30, primary 35, trunk 45, motorway 55, scaled by the
camp's *Avg Speed*), one-way streets, ~3 s per edge for intersections. Rivers,
highways and cul-de-sacs are therefore real. Without a graph: straight-line
× 1.35. ETAs are computed on the same legs the ordering used.

### Dwell

`Time Per Stop` + `Extra Seconds Per Child` × children at the stop. Studies of
school buses measure about 19 s + 2.6 s per student (Braca et al. 1997);
camps set their own. Default is the flat per-stop time.

### Exceptions the dashboard reports

* over capacity, over the route-duration cap (existing)
* **straddle** — a bus on both sides of camp
* **ride-ratio** — a child riding more than 2× their direct trip (+10 min)
* **pass-by** — the bus drives past a stop (within ~400 ft) before serving it

## What was borrowed from where

| Practice | Source | Here |
|---|---|---|
| Route on the street network with realistic bus speeds | Transfinder, Tyler Versatrans, Edulog | `buildRoadNet` |
| Minimise buses, then miles/time; seats as a hard limit | all commercial products | sweep overhead, *Fleet Use* setting, `enforceCapacity` |
| Ride time ≤ ~2× direct | SBRP literature (school time windows) | ordering allowance, `rideRatioViolations` |
| Dwell = base + per-student seconds | Braca et al. 1997 | `stopDwellMin` |
| Walk-to-stop distance, students per stop, no crossing arterials | NHTSA / state stop guidelines; Routefinder Smart Stop Assignment | `maxWalkDistance`, 15 per stop, arterial-aware clustering |
| Avoid doubling back / passing a stop | route design guidance | `passBys` audit, minimum-latency ordering |
| Exception reports for planners | Routefinder, Versatrans dashboards | dispatcher dashboard issues |
| Relocate / swap / ruin-and-recreate | jsprit, VROOM, OR-Tools | `polishDistricts` |
| Contiguous sectors from the depot (sweep) | classic VRP sweep heuristic | `sweepPartition` |

Sources consulted (September 2026): Transfinder Routefinder PLUS product and
optimisation pages; Tyler Versatrans Routing & Planning; Edulog Athena; BusBoss;
Bytecurve; NHTSA *Selecting School Bus Stop Locations*; NYSED and state stop
rules (200–600 ft spacing, 50–100 ft from intersections, right-side loading,
0.1–0.5 mi walks by grade); Park & Kim, *The school bus routing problem: a
review*; Lewis et al., EvoCOP 2021 SBRP heuristic; Braca et al. 1997 dwell
model; jsprit and VROOM documentation on ruin/recreate and regret insertion.

## Settings that matter

* **Avg Speed** — calibrates road-class speeds (25 = as listed).
* **Time Per Stop / Extra Seconds Per Child** — dwell.
* **Max Walk** — stop consolidation radius.
* **Fleet Use** — *as-needed* (default) or *fewer buses*.
* **Balance Bus Loads** — off by default.
* **Max Route Duration** — the split pass's cap.

## Known limits

* Door-to-door on the road-graph path still merges homes within *Max Walk*.
* The soft riding budget in sweep/polish is 60 min, not *Max Ride Time*.
* Return-to-camp minutes are counted on the last shift, not on shifts that
  precede another one.
* Sandbox runs have no road graph, so they use straight-line times and the
  k-means districting path.
