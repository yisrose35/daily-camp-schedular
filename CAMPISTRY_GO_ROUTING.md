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

* **Road-time polish** (`_roadPolishRoutes`): once the routes exist and the
  street network is loaded, the same relocate/swap search runs again on the
  finished stops with real driving minutes between every pair of stops
  (one Dijkstra row per stop), under seats, containment and *Max Route
  Duration* as the soft budget, and re-sequences the buses that changed. The
  districting above prices distance as the crow flies, which on the camp's
  first road-graph run left one Jackson bus at 137 minutes while another
  carried 13 children. Ruin-and-recreate is on here (40 attempts inside the
  time budget) so stops can move in chains when every bus is near its seat
  count. The budget is the route total the app caps and the Route summary
  shows — including the ride home on the last dismissal shift — priced at
  `polishOverBudgetX` (2) bus-minute equivalents per minute over plus
  `polishOverBudgetQuad` (0.25 in the road polish) times the square, so a bus
  40 over costs 480 and one 10 over 45: overage is worth real fleet minutes
  to remove and is never piled onto one bus. **Block relocate**: a bus past
  its budget rarely got there by one stop — it serves two branches, or a far
  township on top of its own ground — and single-stop moves can never hand a
  branch to a bus sitting near camp with seats (each stop alone costs it an
  out-and-back). So the polish also tries whole blocks (the far end of the
  run, and radial clusters around the farthest stop, up to `polishBlockMax`
  stops) handed to one of the `polishBlockTargets` buses furthest under their
  budget, an empty bus included, priced exactly. The road polish prices
  overage at 4 per minute plus 0.5 times the square (a bus 30 over costs
  570, one 10 over 90): a hand-off to an idle core bus costs the fleet 30-50
  minutes of new driving, and at half that weight every hand-off on the
  camp's run was a near tie and all were declined while an 11-minute bus
  sat with 15 empty seats. The console says how many hand-offs were priced,
  how many taken, and what the closest declined one would have cost, and
  lists the best dozen it priced with both buses' minutes before and after —
  so a bus left idle is a priced decision, not a blind spot. With Fleet Use
  on "use the buses I listed" the polish gets no reward for emptying a bus
  (`busOverheadMin` 0); at 5 it emptied a short core bus into its
  neighbours and left it with nothing while other buses ran 90 minutes. **Empty and refill**:
  a short bus near camp is full of near-camp children, so it has no seats
  for a branch, and the branch is far, so a single hand-off never pays. What
  a dispatcher does: the buses that pass those near-camp stops on their way
  out take them (a minute or two each), and the emptied bus takes a far
  branch of a bus over the budget. Neither half pays alone; the pair does,
  so the polish tries the pair as one move (`polishRefillMaxFrac`: a bus
  under half its budget is a candidate), priced exactly and kept only if the
  objective falls. The camp had 42 children on an 18-minute bus while three
  buses ran 84-93 minutes. A stop within `polishNearCampMi` (3 mi) of camp
  may join ANY bus: every bus drives out through the core, so the reach
  rule (the receiver already has a stop within 5 mi) is wrong for it — on
  the camp's run it meant no far bus could ever take a core stop, so the
  short core bus could never be emptied and the far pocket was smeared
  across two 85-90 minute buses instead. Block moves run FIRST in
  each pass: on the camp's run the single-stop moves emptied Bus 8 (a
  9-minute run with 24 empty seats) into the core buses before any block
  move ran, and with every core bus full there was no receiver left for a
  branch of the 90-minute buses. Single-stop moves stay local
  (`polishReachOverBudgetX` 1): a far hand-off is a whole branch, never one
  stop sent ten miles to a core bus for two children. **Make room**: the
  camp's Bus 8 once more — 43 children on an 18-minute core run with three
  seats. It cannot take a branch (no seats) and it cannot be emptied (its
  20-child corner fits no other bus, so empty-and-refill fails). What it CAN
  do is shed a few of its stops to the buses that pass them on the way out
  — the over-budget bus itself included, it drives through the core — and
  take the branch with the seats that frees. Block out, up to
  `polishRoomMaxShed` stops shed (cheapest exact insertion per seat freed),
  block in: priced as one move on the exact objective and kept only if it
  falls. It is the fallback, tried in a pass only when neither a plain
  hand-off nor an empty-and-refill could be taken, because those leave the
  cleaner routes (one bus, one branch). Near-camp stops also count as
  "within reach" for the swap move. The console's "Road polish" lines count
  branch hand-offs (and how many had the receiver make room first), say
  when the polish ran out of its time budget, and — the case the camp hit,
  a bus 31 minutes over the cap with nothing priced at all — name the buses
  over the cap when the polish began and how many branch/receiver pairings
  were rejected on seats and how many on containment. For reproducing a
  run offline, `_GoDebug.exportGeometry()` in the console returns the
  saved routes as bare geometry (camp, settings, and per bus the stops as
  [lat, lng, children, minute] — no names, no addresses);
  `copy(_GoDebug.exportGeometry())` puts it on the clipboard.

* **Same input, same routes** (`polishMaxWork`): both polishes (districting
  and road-time) used to stop on a wall-clock budget — 2 seconds and 5
  seconds — so how far they got depended on the machine and on what else
  the browser was doing, and two runs of the same camp produced different
  routes (the camp saw 41 segment moves one run and 59 the next from the
  same starting point, and a worst bus of 91 then 71). Effort is now a work
  budget, counted in leg evaluations (100e6, about 11 seconds on a 2024
  laptop; a 400-segment districting converges at ~90e6, the 186-stop road
  polish at ~12e6), with the wall clock only a 20-second guard. The polish
  is a deterministic local search — same input, same moves, same result —
  and the console line now ends "converged in 3.2s", "stopped at its work
  limit" or "ran out of time (machine busy); this run may differ from the
  next". The remaining run-to-run input differences are real: the prior-
  year pass seeds the greedy districting with the previous run's saved
  neighbourhoods (the sweep usually wins anyway), and the road-graph
  download is cached per tile.

* **Corner stops on the bus's way** (`chooseCornersOnPath`, after the road
  polish): a corner stop was stood at the intersection nearest its homes, and
  that corner can be a block down a side road — the camp's Hope Terrace child
  had the bus leave County Line Road, drop her at the side-road corner and
  U-turn back. Now, once the buses and the order are settled, every corner
  stop looks at the corners inside the walk limit (`cornerSnapper.candidates`,
  nearest total walk first) and stands at the one that adds the least
  driving between its neighbours in the order, with a small charge per mile
  of extra walking (6 min/mi of total walk, so a corner that costs the
  children half a mile stays put). Buses whose corners moved are folded (two
  stops on one corner are one), re-ordered on street times and re-stamped.
  A corner a neighbouring stop already stands at is worth a whole stop's
  dwell (two stops on one corner are one), so a child is stood with the
  next stop's group when the driving is equal. The console says how many
  stops had a choice, how many moved and the detour minutes saved.

* **Districting on street times** (`packIntoBuses({ roadNet })`): once the
  road network is loaded, every segment point is priced against every other
  on real legs (one bounded Dijkstra per point, ~2 s for 500 points), the
  districting polish runs on those legs, and the sweep and greedy
  candidates are each polished and judged on the resulting objective —
  fleet minutes plus the cap penalty — instead of a shape score. A candidate
  with a bus on both sides of camp never beats one without; otherwise the
  greedy (prior-year) mapping is kept unless the sweep is 2% better. The
  same legs fit a straight-line leg model (`fitLegModel`: fixed minutes per
  leg + a road factor, least squares over ~3000 sampled pairs) that the
  sweep's arc costs and every pass without street times use through
  `legFixedMin` / `roadFactor` (the camp's roads: ~0.7 min per leg and
  1.5-1.7x; the old flat 1.35 with no per-leg cost priced core hops at half
  their cost). The districting now aims at the same Max Route Duration as
  the road polish and the audit. Segment points are the very objects the
  legs answer by identity: resolving them by coordinate strings made the
  polish three times slower and pushed it into the wall-clock guard.

* **Real-map regression** (`tests/bus_camp_geometry.test.js`): two of the
  camp's generated route sets, as bare geometry (no names, no addresses),
  replayed through the pure passes on every test run — every child exactly
  once, seats, containment, fleet minutes never rising, no bus pushed over
  the cap by a fleet-only hand-off, the same input giving the same routes
  twice, and the ordering never longer than the stamped order.

* **Far-tail hand-off** (`polishTailMinMi` 4): the costliest habit a fleet
  has is four buses each hauling a few children to the same far pocket, and
  no cap catches it when every run is under the cap. Once the single-stop
  moves are exhausted in a pass, any bus whose run ends out past the radius
  offers that far tail (its suffixes and the radial clusters around its
  farthest stop, never the near part of the run) as a block to a bus already
  serving the pocket — one with a stop within reach of the tail's far end.
  The receiver takes it as it is when the seats allow, else after shedding a
  few stops of its own (make-room), priced exactly and kept only if the
  fleet gains; a hand-off made for fleet minutes alone may not push the
  receiver over Max Route Duration. Replaying the camp's own map offline
  (legs priced as the run's ETAs say: 0.7 min per leg plus 2.9 min per
  mile), the far west's 35 children went from four buses to two or three
  and the fleet from 672 to 626-634 model minutes at the 70-minute cap. On
  the camp's next real run the far west went from four buses to three and
  the fleet from 697 to 685 road minutes — and that is the number to trust:
  optimising the same routes under one noisy leg model and judging them
  under an independent one (same 0.8-minute noise per leg) turned a 50-
  minute "gain" into +1, +15 and −39, so a smooth offline model overstates
  what is left, and only the road-leg run counts. The move runs in the
  road-time polish only; on 400+ districting segments it cost that stage
  its whole time budget (the camp's run hit the 20-second guard).

* **The efficiency line** (`[Go] Fleet: …`, plain text after the Route
  summary, since a pasted console.table is unreadable): total bus-minutes
  and bus-hours, buses used, average and longest run, how many are over
  Max Route Duration, the stop count, and the children's average ride. Bus
  minutes are the cost; the rest is what they bought. Measured on the
  751-child harness: the ordering already yields the shortest tours (stop
  order priced for children's ride time costs under 0.1% in bus minutes),
  and ruin-and-recreate at districting size buys 0.3% for ten seconds, so
  neither is where minutes are left — the districting's shape and the cap
  are.

* **Geometry in the console** (`[Go] Geometry …`): after the Route summary,
  one short line per bus with the stops as [lat, lng, children, minute] and
  one line of camp settings — no names, no addresses — so a run can be
  replayed offline from a console paste. `_GoDebug.exportGeometry()` returns
  the same as one JSON string.

* **Max Route Duration** (Route Settings, default 60): the one cap every
  reader uses — the stop ordering, the road polish, the split pass, the ETA
  audit, the scorecard and the Route summary — through `_routeCapMin()`.
  Until 2026-09-14 there was no field for it on the page and, with the
  setting unset, the audit fell back to 60 while the polish and ordering
  fell back to 90: the polish priced Bus 2 at 92 as two minutes over (a
  penalty of ~10, so every hand-off was a near tie and none was taken),
  then the audit flagged the same bus as 31 minutes over. The old one-time
  60 → 90 migration is retired for the same reason. It is a priced budget,
  not a hard wall: a minute over costs four bus-minute equivalents plus
  half the square, so the polish hands far branches to buses with idle
  seats to stay under, and the console flags whatever is still over.

* **The ride home** (`returnToDepot`, from the **Round Trip** setting): a
  dismissal run drives back to camp when it is not the last shift (the bus
  comes back for the next one) or when Round Trip is on. One way is the
  default: a run ends at its last drop, and route minutes, Max Route
  Duration, the ordering, the polish and the map all stop there — one
  helper (`_shiftReturns`) decides, so they agree. Before this the ETA pass
  silently added a return leg to every route of the last shift (with no
  shifts configured, every route) while the map drew none: a far bus's
  reported minutes included its empty drive home, the 60-minute cap was
  being judged against that sum, and the polish was steering runs to end
  near camp to shorten a leg nobody had asked for. When the
  leg IS real, the districting polish, the road-time polish and the stop
  ordering all price it (arrival already rides back with everyone aboard);
  leaving it out had the polish reporting gains the finished routes did not
  show.

### Containment

The arc a bus covers around camp is the smallest wedge containing all its
stops beyond 1.5 mi from camp. Above **110°** a bus is on both sides of camp.
Every pass that moves a stop between buses goes through one gate
(`stopFitsRoute`): near an existing stop of the receiver, and not widening the
receiver's wedge past the limit.

### Ordering (`localTspOrder`)

Objective is **children-minutes** (minimum latency), plus `tspUnfairWeight`
(2) times the minutes a child rides beyond their allowance (`2 × direct trip
+ 10`, the same allowance the ride-ratio audit uses) plus `tspUnfairQuad`
(0.3) times their square, plus the tour length. A tour minute weighs 60. A
child 8 minutes over costs 35 — a few minutes' shuffle is not worth bus
minutes — while 36 over costs 460 and 52 over 915. The return-aware ordering
once kept two children who live 15 minutes from camp aboard for 91 minutes,
dropped last on the way home from the rural Jackson loop because the nine
children at the loop's first stop rode less that way; minimum latency is
right for the many, the allowance guards the few, and a flat weight high
enough to guard them cost 4% more fleet minutes paid on mild cases. A route
over Max Route Duration (`routeCapMin`) is also charged `tspOverCapQuad` (30)
times the square of the minutes over, so an over-cap bus leans to its
shortest order — the one the district polish priced it at — rather than
minimum latency. Small routes get 32 iterated-local-search kicks (the
unfair term makes the objective rugged: at 7 kicks a 25-stop route landed 4%
apart depending on the order it was handed over in).
Arrival mode charges the drive from the last pickup back to camp; a dismissal
shift that returns to camp charges the empty ride home as bus time only, so
a run ends nearer camp when that saves more than it costs the children.
Multi-start
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

* **Door-to-door is door-to-door.** The consolidation pass
  (`consolidateStops`, unit-tested) merges only stops at the same house in
  that mode — siblings, a duplex — never homes a quarter mile apart on one
  street. It used to run the corner-mode merges in every mode (and before
  that read a full address's town and ZIP as street names), so door-to-door
  was a corner mode in disguise: on the 751-child harness it reported 488
  stops and 1419 fleet minutes; the honest figures are 749 stops and about
  1810 minutes, with the average ride 47 minutes instead of 34. That is the
  real price of stopping at every door, and the reason the camp's own routes
  are corner stops.
* **Corner stops on the road-graph path** gather a bus's homes by walking
  distance across streets (densest corner first), stand each group at the
  intersection that minimises the children's total walk, and let the
  consolidation pass measure walks from the homes behind a corner rather
  than the corner itself, re-snapping merged stops. Before this, corner mode
  grouped by street first and produced one stop per street — about twice the
  camp's 263. A stop's street comes from the map's road name, or from the
  child's own address when the map leaves the road unnamed, so a stop with
  no intersection in reach reads "Hickory Hill Rd near 13" rather than
  "Stop corner"; consolidation matches streets from the homes behind a stop,
  not from its name. A child the map could not attach to any neighbourhood
  joins a shared stop within walking distance on any bus with seats before
  falling back to a door-drop on the nearest bus (the door-drop carries a
  home record too, so it is snapped and named like every other corner).
* **The map covers every home the buses serve.** The road-graph download
  used an IQR "outlier" trim on the roster's coordinates, which cut the far
  end of Jackson and the Toms River area off the map: those homes got no road
  segment (8 "could not be snapped"), and their travel times were made up
  from the distance to the map's edge — two stops a mile apart on Leesville
  Road read 7 minutes apart, and two buses drove to the far end of it. The
  map now spans every camper within 35 mi of camp (`serviceBbox`), so only a
  geocode in another state is left off, and the console says how many. The
  camp's own MAROON bus ran that whole rural loop as one 48-child bus.
* **Corner names.** "Albert Ave @ Albert Avenue" was one road named two
  ways in the map; street names are normalised (`normStreet`) for corner
  detection, corner naming and the preferred-street match. A stop the road
  polish moves onto a bus already standing at its corner is folded into that
  stop (`foldSameCornerStops`) rather than listed twice a minute apart.
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
