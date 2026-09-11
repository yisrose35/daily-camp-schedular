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
  containment. Every move is applied, re-priced exactly and kept only if the
  fleet really gained. A **ruin-and-recreate** phase (remove a radial cluster of
  atoms, re-insert cheapest-first, keep if better — the large-neighbourhood
  step used by jsprit and VROOM) is implemented but off by default
  (`polishLnsIters`): measured on camp-shaped layouts it added nothing over
  relocate/swap and spent the whole time budget.
  * **Shared stops** (`polishMergeSameStreetMi` / `polishMergeAnyMi`): the
    stop consolidation that runs later merges homes on one street within a
    quarter mile (and anything within *Max Walk*) into one stop. The polish
    prices the same rule: an atom that would share a stop with a same-bus
    neighbour costs no base dwell of its own, only its per-child seconds.
    That is what keeps a street on one bus — a straggler next to its
    street-mates is a free stop there and a full stop anywhere else. On the
    road-graph path the radii come from *Max Walk*; house stops on the
    k-means path never merge, so it gets none.
  * Priced but **off by default**, both measured on camp-shaped maps
    (751 children, 18 buses, three map seeds) against the final routes:
    `polishChildMinuteWeight` (children's minutes aboard, weighted into the
    objective — every weight from 0.01 to 0.05 made the final routes longer
    for buses *and* children, because the road-time ordering that runs
    afterwards already minimises children's minutes within each bus and the
    proxy tour cannot see it) and `polishStreetSplitMin` (a flat penalty per
    extra bus on a street — traded real minutes for a tidier map without
    cutting the number of split streets). Arrival mode (`isArrival`) prices
    a bus to its return at camp and a child from pickup to camp.

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
objective with LKH-style neighbour lists (moves only among each stop's 10
nearest), then iterated local search (double-bridge kicks around the best
tour). Seeds are chosen by geometry (nearest, farthest, spread by bearing)
and the incoming order is itself a seed, so Re-optimize keeps an order it
cannot improve. Measured within 0.005 % of an exact minimum-latency optimum
on 8–11 stop routes; input-order dependence at most ~2 % on 45-stop routes
(inherent to local search — the previous full-candidate version showed the
same), 0.2 % on average.

### Travel times

With a road graph: **street network travel times** (`buildRoadNet`) — Dijkstra
over the OpenStreetMap graph with class-based speeds (residential 20 mph,
tertiary 25, secondary 30, primary 35, trunk 45, motorway 55, scaled by the
camp's *Avg Speed*), one-way streets, ~3 s per edge for intersections. Rivers,
highways and cul-de-sacs are therefore real. Without a graph: straight-line
× 1.35. ETAs are computed on the same legs the ordering used.

### Map

Route lines follow the streets: the road engine records the shortest path
for every leg (`stampRoadPath`, with each edge's interior shape points), so
the map draws the run along the roads rather than corner to corner. Without a
road graph the lines are straight segments. When the fleet outgrows the
15-colour palette, `assignRouteColors` gives every bus its own colour, ordered
by bearing from camp with a golden-angle hue step so neighbouring districts
never look alike; the colour is saved on the bus so list, legend, map and
print sheets agree. A per-bus summary table is logged after every generation.

### Dwell

`Time Per Stop` + `Extra Seconds Per Child` × children at the stop. Studies of
school buses measure about 19 s + 2.6 s per student (Braca et al. 1997);
camps set their own. Default is the flat per-stop time. *Time Per Stop* takes
quarter minutes: on a door-to-door run of 750 children and 18 buses the dwell
at 2 min a stop is longer than the driving, and 0.5 min + 5 s per child cut
the measured fleet by a quarter and the average ride from 28 to 21 min.

The console's *Route summary* table (printed after every generation) carries
each bus's minutes, seats, stops, wedge, and the average and longest child
ride, so a route problem can be reported with numbers.

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
* **Time Per Stop / Extra Seconds Per Child** — dwell. The default is 1 min.
  The camp's own routes (`historical_route_stops.json`, 263 corner pickups)
  run a median 1–2 min from one stop to the next *including* the drive, and a
  stop of eight children takes no longer than a stop of one — the children are
  waiting at the corner. So: 1 for corner stops, 0.5 for door-to-door, and 0 s
  per child unless the camp knows otherwise. 2 min per stop, the old stock
  value, doubled every route.
* **Max Walk** — stop consolidation radius.
* **Fleet Use** — *as-needed* (default) or *fewer buses*.
* **Balance Bus Loads** — off by default.
* **Max Route Duration** — the split pass's cap.

## Known limits

* Door-to-door on the road-graph path still merges homes within *Max Walk*
  (and same-street homes within a quarter mile). It used to merge ANY two
  homes in the same town within a quarter mile — the street parser read the
  city, state and ZIP of a full address as street names — which made
  door-to-door a corner mode in disguise.
* **Corner stops on the road-graph path** gather a bus's homes by walking
  distance across streets (densest corner first), stand each group at the
  intersection that minimises the children's total walk, and let the
  consolidation pass measure walks from the homes behind a corner rather
  than the corner itself, re-snapping merged stops. Before this, corner mode
  grouped by street first and produced one stop per street — about twice the
  camp's 263.
* **Routing Engine** is now a Route Settings control. A camp was found on the
  older spatial-sort engine with no way to see or change it; the console's
  Route summary `source` column says which engine produced a run
  (`neighborhood`, or `spatial-sort-secondary` when the map download failed).
* The soft riding budget in sweep/polish is 60 min, not *Max Ride Time*.
* Return-to-camp minutes are counted on the last shift, not on shifts that
  precede another one.
* **Sandbox mode blocks paid providers and mocks geocoding; it does not block
  the road graph.** It used to: the guard treated free OpenStreetMap data as
  "network", so every camp in sandbox mode (the default) silently lost the
  road-graph engine and every real intersection. Tests that must run offline
  set `campistry_go_no_network`.
* **Map data is downloaded in tiles** (~7 x 7 miles each, cached per tile in
  IndexedDB for 90 days) through the Supabase proxy, the same-origin proxy,
  then the public mirrors, with one console line per failed attempt
  (`[Go-NH] Map tile 400:-594 via overpass-api.de: HTTP 429`). One whole-area
  query used to outlive the mirrors' 25 s limit and fail as a unit. The
  corner-stop builder takes its intersections from the same graph.
