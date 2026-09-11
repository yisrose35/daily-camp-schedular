// =============================================================================
// campistry_go_route_post.js — Campistry Go post-routing passes (pure)
// =============================================================================
//
// Everything that touches a route AFTER districting has decided who rides
// which bus lives here: stop ordering, ride-time relief, duration splitting,
// optional load balancing, hard capacity enforcement and the containment
// audit. The module is pure (no DOM, no network, no global state) so it runs
// in the browser and under `node --test` alike — the districting bugs this
// camp kept hitting were all in passes that could not be exercised offline.
//
// THE RULE EVERY PASS OBEYS — "containment":
//   A stop may only move to another bus when it genuinely belongs on that
//   bus's ground: it must sit within a short distance of one of the bus's
//   EXISTING stops (never "near the centroid" — a bus serving 0-2mi north has
//   its centroid a mile north of camp, which put stops two miles SOUTH of camp
//   inside a 3-mile centroid radius), and it must not widen the bus's angular
//   arc around camp past MAX_DISTRICT_ARC_DEG. That second test is what stops
//   a bus from ending up north AND south of camp, which draws the classic
//   "drive out north, turn around, drive back through camp and out south"
//   route. Points inside MIN_ARC_RADIUS_MI of camp are ignored by the arc
//   test — two homes 0.3mi either side of camp are a compact route, not a
//   straddle.
//
//   Every pass that moves a stop also RE-ORDERS the routes it touched. The
//   old passes appended the moved stop to the end of the receiving route and
//   nothing downstream re-sequenced it, so the receiving bus finished its
//   sweep and then drove back across its district for one more drop.
//
// Load balancing is OFF by default. The camp wants efficient routes, not
// equal ones; a fixed fleet with a fixed seat count is the constraint, and
// evening out head-counts was the single biggest source of straddles.
// =============================================================================
window.CampistryGoRoutePost = (function () {
    'use strict';

    const DEFAULTS = {
        avgSpeedMph: 25,
        avgStopMin: 2,             // base dwell per stop (minutes)
        secPerRider: 0,            // extra dwell per child boarding/alighting (seconds); school-bus studies
                                   // measure ~19s + 2.6s/student, camps set their own
        roadFactor: 1.35,
        busOverheadMin: 5,         // cost of running a bus at all (min-equivalent); raise to prefer fewer buses
        maxRideRatio: 2.0,         // a child should not ride more than this x their direct trip (+ slack)
        rideRatioSlackMin: 10,
        // Road network (when the OSM graph is available)
        roadEdgePenaltyMin: 0.05,  // ~3s per edge: intersections, turns, slowing for stops
        roadOffMph: 10,            // speed for the off-graph bit between a stop and its nearest node
        legMinutes: null,          // (a, b) -> minutes on the road network; null = straight-line x roadFactor
        // Containment
        minArcRadiusMi: 1.5,        // stops closer than this to camp don't count toward the arc
        maxDistrictArcDeg: 110,     // a bus may fan out this wide around camp; beyond it, it straddles
        maxHandoffMi: 2.0,          // ride-relief: batch must be within this of the receiver's stops
        maxSplitHandoffMi: 1.5,     // duration split: same, tighter
        maxRebalanceHandoffMi: 1.0, // load balancing (opt-in): tighter still
        maxCapacityHandoffMi: 2.5,  // capacity enforcement prefers contained receivers within this
        // Load balancing (opt-in)
        equalizeLoads: false,
        // Capacity-aware sweep (shared by both districting pipelines)
        sweepRotations: 48,        // seam positions tried around the ring
        sweepRidersPerStop: 2.5,   // stops ≈ riders / this
        sweepBusOverheadMin: null, // cost of using a bus at all (null = busOverheadMin)
        sweepGroupCutMin: 6,       // cost of splitting one group (neighbourhood) between two buses
        sweepMaxRideMin: 60,       // soft riding budget per bus (0 = off)
        // District polish (relocate / swap atoms between buses)
        polishMaxPasses: 12,
        polishTimeBudgetMs: 1500,
        polishRideBudgetMin: 60,   // soft riding budget per bus (0 = off)
        polishMinGainMin: 0.05,
        polishLnsIters: 0,         // ruin-and-recreate attempts after local search converges.
                                   // Measured on camp-shaped layouts: no gain over relocate/swap,
                                   // and it spends the whole time budget — off unless experimenting.
        polishLnsRuinMin: 4,       // atoms removed per attempt (radial cluster)
        polishLnsRuinMax: 12,
        polishReachMi: 5.0,        // only consider a bus whose nearest atom is within this of the moving atom
        polishReachOverBudgetX: 2.5, // ...unless the source bus is over its ride budget: reach this much further
        polishChildMinuteWeight: 0, // bus-minute equivalents per child-minute aboard (0 = bus minutes only).
                                   // 0.03 would mean a stop that keeps 33 children a minute longer costs one
                                   // bus minute. Off by default: on camp-shaped maps every weight tried
                                   // (0.01–0.05) made the FINAL routes longer for buses and children alike —
                                   // the proxy tour cannot see the road-time ordering that runs afterwards,
                                   // which already minimises children's minutes within each bus.
        polishStreetSplitMin: 0,   // penalty (bus-minute equivalents) per extra bus serving the same street.
                                   // Off by default: measured on camp-shaped maps it traded real minutes for
                                   // a tidier map without cutting split streets; merge-aware dwell (below)
                                   // is what actually keeps a street on one bus.
        polishMergeSameStreetMi: 0, // stops on the same street within this of a same-bus stop share it (no
                                    // base dwell) — mirror the stop consolidation the pipeline runs later
        polishMergeAnyMi: 0,        // ...and any two stops within this share regardless of street
        polishMsPerAtom: 5,        // time budget grows with the camp: max(polishTimeBudgetMs, this x atoms)
        isArrival: false,          // arrival: a bus's minutes run until it is back at camp, a child's from pickup
        // Stop ordering
        tspUnfairWeight: 2,        // weight on minutes a child rides beyond their allowance
        tspNeighborK: 10,          // candidate moves only among each stop's K nearest (LKH-style neighbour lists)
        tspKicks: null,            // iterated-local-search kicks around the best tour (null = 4 + n/8, max 12)
    };
    function opts(o) { return Object.assign({}, DEFAULTS, o || {}); }

    // ---- geometry -----------------------------------------------------------
    function haversineMi(lat1, lng1, lat2, lng2) {
        const R = 3958.8, toRad = d => d * Math.PI / 180;
        const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }
    function hasPos(s) { return !!s && Number.isFinite(s.lat) && Number.isFinite(s.lng) && !(s.lat === 0 && s.lng === 0); }
    function isStaff(s) { return !!(s && (s.isMonitor || s.isCounselor)); }
    function riders(s) { return Array.isArray(s && s.campers) ? s.campers.length : 0; }
    function headcount(stops) { let n = 0; for (const s of (stops || [])) if (!isStaff(s)) n += riders(s); return n; }
    // Dwell at a stop: base minutes plus seconds per child. Flat when secPerRider is 0.
    function stopDwellMin(stop, o) {
        o = o && Number.isFinite(o.avgStopMin) ? o : opts(o);
        const k = stop ? (Number.isFinite(stop.count) ? stop.count : riders(stop)) : 0;
        return o.avgStopMin + (o.secPerRider > 0 ? k * o.secPerRider / 60 : 0);
    }
    function driveMin(a, b, o) {
        if (!o || !Number.isFinite(o.roadFactor)) o = opts(o);
        if (!hasPos(a) || !hasPos(b)) return 3;
        if (Math.abs(a.lat - b.lat) < 1e-5 && Math.abs(a.lng - b.lng) < 1e-5) return 0;
        return (haversineMi(a.lat, a.lng, b.lat, b.lng) * o.roadFactor / Math.max(1, o.avgSpeedMph)) * 60;
    }
    function bearing(depot, p) { return Math.atan2(p.lng - depot.lng, p.lat - depot.lat); }
    function angDiff(a, b) { let d = Math.abs(a - b) % (2 * Math.PI); return d > Math.PI ? 2 * Math.PI - d : d; }

    // Smallest wedge (degrees, as seen from camp) that contains every one of
    // `points`, ignoring points inside minArcRadiusMi. 0 when fewer than two
    // count. Measured as 360° minus the largest empty gap between bearings,
    // so a bus that surrounds camp on three sides reads as ~240°, not as the
    // widest pair.
    function arcDeg(points, depot, o) {
        o = opts(o);
        if (!depot) return 0;
        const bs = [];
        for (const p of points) {
            if (!hasPos(p) || isStaff(p)) continue;
            if (haversineMi(depot.lat, depot.lng, p.lat, p.lng) < o.minArcRadiusMi) continue;
            bs.push(bearing(depot, p));
        }
        if (bs.length < 2) return 0;
        bs.sort((a, b) => a - b);
        let gap = bs[0] + 2 * Math.PI - bs[bs.length - 1];
        for (let i = 1; i < bs.length; i++) gap = Math.max(gap, bs[i] - bs[i - 1]);
        return (2 * Math.PI - gap) * 180 / Math.PI;
    }
    function spreadMi(points) {
        const ps = points.filter(p => hasPos(p) && !isStaff(p));
        let max = 0;
        for (let i = 0; i < ps.length; i++)
            for (let j = i + 1; j < ps.length; j++) {
                const d = haversineMi(ps[i].lat, ps[i].lng, ps[j].lat, ps[j].lng);
                if (d > max) max = d;
            }
        return max;
    }
    function nearestStopMi(stop, stops, skip) {
        let best = Infinity;
        for (const s of stops) {
            if (s === skip || s === stop || !hasPos(s) || isStaff(s)) continue;
            const d = haversineMi(stop.lat, stop.lng, s.lat, s.lng);
            if (d < best) best = d;
        }
        return best;
    }

    // The containment gate. `extra` lets a caller test a batch: the stops that
    // will arrive together with `stop`.
    function stopFitsRoute(stop, routeStops, depot, o, maxHandoffMi, extra) {
        o = opts(o);
        const limit = maxHandoffMi != null ? maxHandoffMi : o.maxHandoffMi;
        const live = (routeStops || []).filter(s => hasPos(s) && !isStaff(s));
        if (!hasPos(stop)) return { ok: false, reason: 'no-position', nearestMi: Infinity, arcDeg: 0 };
        if (!live.length) return { ok: true, reason: 'empty', nearestMi: 0, arcDeg: 0 };
        const nearestMi = nearestStopMi(stop, live);
        if (nearestMi > limit) return { ok: false, reason: 'too-far', nearestMi, arcDeg: arcDeg(live, depot, o) };
        const before = arcDeg(live, depot, o);
        const after = arcDeg(live.concat([stop], extra || []), depot, o);
        if (after > o.maxDistrictArcDeg && after > before + 1e-9) {
            return { ok: false, reason: 'straddle', nearestMi, arcDeg: after };
        }
        return { ok: true, reason: 'ok', nearestMi, arcDeg: after };
    }

    // ---- stop ordering ------------------------------------------------------
    // Rider-weighted local TSP. What a school cares about is children-minutes,
    // not miles: a pure shortest tour is happy to drop a 9-child family last.
    // Objective (unchanged from the measured original): total riding minutes
    // weighted by riders, plus 2x the minutes a child rides beyond a generous
    // allowance over their own direct trip, plus the tour length as a gentle
    // tie-break. Implemented on a precomputed leg matrix with allocation-free
    // candidate evaluation so a 50-stop door-to-door bus orders in well under
    // a second instead of six.
    function localTspOrder(stops, depot, isArrival, o) {
        o = opts(o);
        const all = stops || [];
        const movable = all.filter(s => hasPos(s) && !s.isMonitor);
        const tail = all.filter(s => !(hasPos(s) && !s.isMonitor));
        const n = movable.length;
        if (n < 2) return all.slice();

        const M = new Array(n), C = new Array(n), cnt = new Array(n), allow = new Array(n), dwell = new Array(n);
        const L = typeof o.legMinutes === 'function' ? o.legMinutes : null;
        const legOf = (a, b) => L ? L(a, b) : driveMin(a, b, o);
        for (let i = 0; i < n; i++) {
            M[i] = new Float64Array(n);
            C[i] = legOf(depot, movable[i]);
            cnt[i] = riders(movable[i]) || 1;
            allow[i] = C[i] * o.maxRideRatio + 25;
            dwell[i] = stopDwellMin(movable[i], o);
        }
        // Road legs can be asymmetric (one-way streets): fill both directions.
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { if (i === j) continue; M[i][j] = L ? L(movable[i], movable[j]) : (j > i ? driveMin(movable[i], movable[j], o) : M[j][i]); }

        // Neighbour lists: each stop's K nearest by leg time. Local moves only
        // consider edges to a neighbour, which is what keeps a 50-stop bus
        // ordering in a fraction of a second without hurting quality.
        const K = Math.min(n - 1, Math.max(3, o.tspNeighborK | 0));
        const nbr = new Array(n);
        for (let i = 0; i < n; i++) {
            const cand = [];
            for (let j = 0; j < n; j++) if (j !== i) cand.push(j);
            cand.sort((a, b) => Math.min(M[i][a], M[a][i]) - Math.min(M[i][b], M[b][i]));
            nbr[i] = cand.slice(0, K);
        }
        const pos = new Int32Array(n);
        const arr = new Float64Array(n);
        // cost of the tour given by pos -> stop index function
        function costOf(at) {
            let time = 0, tour = 0, prev = -1;
            for (let p = 0; p < n; p++) {
                const idx = at(p);
                const leg = prev < 0 ? C[idx] : M[prev][idx];
                time += leg + dwell[idx]; tour += leg; arr[p] = time; prev = idx;
            }
            // Arrival: everyone aboard still rides from the last pickup back to
            // camp. Leaving that leg out let the search end a route five miles
            // out and hand every child the drive back.
            if (isArrival) { const back = L ? L(movable[prev], depot) : C[prev]; time += back; tour += back; }
            let total = 0, head = 0, unfair = 0;
            for (let p = 0; p < n; p++) {
                const idx = at(p), k = cnt[idx];
                const ride = isArrival ? (time - arr[p]) : arr[p];
                head += k; total += k * ride;
                if (ride > allow[idx]) unfair += k * (ride - allow[idx]);
            }
            // tour is kept in seconds to preserve the original weighting
            return total + unfair * o.tspUnfairWeight + (tour * 60) * Math.max(1, head / 40);
        }
        const identity = (t) => (p) => t[p];

        function nearestFrom(start) {
            const rem = []; for (let i = 0; i < n; i++) if (i !== start) rem.push(i);
            const out = [start];
            while (rem.length) {
                const last = out[out.length - 1];
                let bi = 0, bd = Infinity;
                for (let i = 0; i < rem.length; i++) { const d = M[last][rem[i]]; if (d < bd) { bd = d; bi = i; } }
                out.push(rem.splice(bi, 1)[0]);
            }
            return out;
        }
        // Plain-distance 2-opt with O(1) deltas: cheap way to a sane tour
        // before the (expensive) rider objective polishes it.
        function distTwoOpt(t) {
            let improved = true, guard = 0;
            while (improved && guard++ < 200) {
                improved = false;
                for (let i = 0; i < n - 1; i++) {
                    const a = i === 0 ? -1 : t[i - 1], b = t[i];
                    for (let j = i + 1; j < n; j++) {
                        const c = t[j], d = j + 1 < n ? t[j + 1] : -1;
                        const before = (a < 0 ? C[b] : M[a][b]) + (d < 0 ? 0 : M[c][d]);
                        const after = (a < 0 ? C[c] : M[a][c]) + (d < 0 ? 0 : M[b][d]);
                        if (after < before - 1e-9) {
                            for (let x = i, y = j; x < y; x++, y--) { const tmp = t[x]; t[x] = t[y]; t[y] = tmp; }
                            improved = true; break;
                        }
                    }
                    if (improved) break;
                }
            }
            return t;
        }
        function twoOpt(t) {
            let best = costOf(identity(t));
            let improved = true, guard = 0;
            while (improved && guard++ < 30) {
                improved = false;
                for (let p = 0; p < n; p++) pos[t[p]] = p;
                for (let i = 0; i < n - 1 && !improved; i++) {
                    // reversing [i..j] creates edges (t[i-1],t[j]) and (t[i],t[j+1]):
                    // only try j where t[j] neighbours t[i-1], or t[j+1] neighbours t[i]
                    const cands = new Set();
                    if (i > 0) for (const nb of nbr[t[i - 1]]) { const j = pos[nb]; if (j > i) cands.add(j); }
                    for (const nb of nbr[t[i]]) { const j = pos[nb] - 1; if (j > i) cands.add(j); }
                    if (i === 0) for (const nb of nbr[t[0]]) { const j = pos[nb]; if (j > 0) cands.add(j); }
                    cands.add(n - 1);
                    for (const j of cands) {
                        const c = costOf(p => (p < i || p > j) ? t[p] : t[j - (p - i)]);
                        if (c < best - 1e-9) {
                            for (let x = i, y = j; x < y; x++, y--) { const tmp = t[x]; t[x] = t[y]; t[y] = tmp; }
                            best = c; improved = true; break;
                        }
                    }
                }
            }
            return t;
        }
        // Or-opt: lift a run of 1-3 stops and re-insert it (optionally reversed).
        function orOpt(t) {
            let base = costOf(identity(t));
            let improved = true, guard = 0;
            while (improved && guard++ < 30) {
                improved = false;
                for (let len = 1; len <= 3 && !improved; len++) {
                    for (let i = 0; i + len <= n && !improved; i++) {
                        const rest = t.slice(0, i).concat(t.slice(i + len));
                        const seg = t.slice(i, i + len);
                        if (rest.length < 2) continue;
                        // insertion slots next to a neighbour of either segment end (+ the ends of the route)
                        for (let p = 0; p < rest.length; p++) pos[rest[p]] = p;
                        const slots = new Set([0, rest.length]);
                        for (const end of [seg[0], seg[len - 1]]) for (const nb of nbr[end]) {
                            const q = pos[nb];
                            if (rest[q] !== nb) continue; // nb is inside the segment
                            slots.add(q); slots.add(q + 1);
                        }
                        let bestPos = -1, bestC = base - 1e-9, bestRev = false;
                        for (const j of slots) {
                            if (j === i) continue; // same place, same orientation is a no-op
                            for (let rev = 0; rev < 2; rev++) {
                                const c = costOf(p => p < j ? rest[p] : p < j + len ? (rev ? seg[len - 1 - (p - j)] : seg[p - j]) : rest[p - len]);
                                if (c < bestC) { bestC = c; bestPos = j; bestRev = !!rev; }
                            }
                        }
                        if (bestPos >= 0) {
                            const piece = bestRev ? seg.slice().reverse() : seg;
                            const next = rest.slice(0, bestPos).concat(piece, rest.slice(bestPos));
                            for (let p = 0; p < n; p++) t[p] = next[p];
                            base = bestC; improved = true;
                        }
                    }
                }
            }
            return t;
        }

        // Seeds: the stops nearest and farthest from camp, plus a spread of
        // stops evenly spaced by bearing around camp. Chosen by GEOMETRY, not
        // by array position, so the result depends only on the set of stops —
        // generation and a later re-optimize land on the same order. Fewer
        // for big routes — the distance 2-opt already lands close.
        const seeds = new Set();
        let nearIdx = 0, nearD = Infinity, farIdx = 0, farD = -Infinity;
        for (let i = 0; i < n; i++) { if (C[i] < nearD) { nearD = C[i]; nearIdx = i; } if (C[i] > farD) { farD = C[i]; farIdx = i; } }
        seeds.add(nearIdx); seeds.add(farIdx);
        const seedCount = n > 30 ? 3 : n > 20 ? 4 : 6;
        const byBearing = movable.map((s, i) => ({ i, b: Math.atan2(s.lng - depot.lng, s.lat - depot.lat) }))
            .sort((a, b) => a.b - b.b || a.i - b.i);
        const step = Math.max(1, Math.floor(n / seedCount));
        for (let k = 0; k < n; k += step) seeds.add(byBearing[k].i);

        // The order we were handed is a candidate too: polishing it makes
        // re-optimizing an already-ordered route idempotent, and guarantees
        // the result is never worse than what the caller had.
        const identityOrder = []; for (let i = 0; i < n; i++) identityOrder.push(i);
        let best = identityOrder.slice(), bestCost = costOf(identity(identityOrder));
        {
            let t = identityOrder.slice(), prev = bestCost;
            for (let round = 0; round < 4; round++) {
                t = orOpt(twoOpt(t));
                const c = costOf(identity(t));
                if (c >= prev - 1e-6) break;
                prev = c;
            }
            const c = costOf(identity(t));
            if (c < bestCost - 1e-9) { bestCost = c; best = t.slice(); }
        }
        function improve(t0) {
            let t = t0, prev = Infinity;
            for (let round = 0; round < 4; round++) {
                t = orOpt(twoOpt(t));
                const c = costOf(identity(t));
                if (c >= prev - 1e-6) break;
                prev = c;
            }
            return t;
        }
        for (const s of seeds) {
            const t = improve(distTwoOpt(nearestFrom(s)));
            const c = costOf(identity(t));
            if (c < bestCost - 1e-9) { bestCost = c; best = t.slice(); }
        }
        if (!best) return all.slice();

        // Iterated local search: perturb the best tour with a double-bridge
        // kick (swap two inner blocks), re-polish, keep if better. Neighbour-
        // list moves settle in shallow optima; kicks make the result depend
        // on the stops, not on the order they were handed over in. The RNG is
        // seeded from the stop set, so re-runs reproduce themselves.
        const kicks = Number.isFinite(o.tspKicks) ? o.tspKicks : (n < 8 ? 0 : Math.min(12, 4 + (n >> 3)));
        if (kicks > 0 && n >= 8) {
            let seed = (n * 7919 + Math.round(C.reduce((a, b) => a + b, 0) * 100)) & 0x7fffffff;
            const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
            for (let k = 0; k < kicks; k++) {
                const a = 1 + Math.floor(rnd() * (n - 6));
                const b = a + 1 + Math.floor(rnd() * (n - a - 4));
                const c = b + 1 + Math.floor(rnd() * (n - b - 2));
                const kicked = best.slice(0, a).concat(best.slice(b, c), best.slice(a, b), best.slice(c));
                const t = improve(kicked);
                const cost = costOf(identity(t));
                if (cost < bestCost - 1e-9) { bestCost = cost; best = t.slice(); }
            }
        }

        return best.map(i => movable[i]).concat(tail);
    }

    // The ordering objective of a given order (children-minutes + fairness +
    // tour tie-break), for tests and diagnostics.
    function routeObjective(stops, depot, isArrival, o) {
        o = opts(o);
        const movable = (stops || []).filter(s => hasPos(s) && !s.isMonitor);
        const n = movable.length;
        if (n < 1) return 0;
        const L = typeof o.legMinutes === 'function' ? o.legMinutes : null;
        const legOf = (a, b) => L ? L(a, b) : driveMin(a, b, o);
        let time = 0, tour = 0, prev = depot; const arr = [];
        for (const s of movable) { const l = legOf(prev, s); time += l + stopDwellMin(s, o); tour += l; arr.push(time); prev = s; }
        if (isArrival) { const back = legOf(prev, depot); time += back; tour += back; }
        let total = 0, head = 0, unfair = 0;
        movable.forEach((s, i) => {
            const k = riders(s) || 1, ride = isArrival ? (time - arr[i]) : arr[i];
            head += k; total += k * ride;
            const allow = legOf(depot, s) * o.maxRideRatio + 25;
            if (ride > allow) unfair += k * (ride - allow);
        });
        return total + unfair * o.tspUnfairWeight + (tour * 60) * Math.max(1, head / 40);
    }

    function routeLastDropMin(route, depot, o) {
        o = opts(o);
        let t = 0, prev = depot;
        const L = typeof o.legMinutes === 'function' ? o.legMinutes : null;
        for (const s of ((route && route.stops) || [])) {
            if (!hasPos(s) || isStaff(s)) continue;
            t += (L ? L(prev, s) : driveMin(prev, s, o)) + stopDwellMin(s, o);
            prev = s;
        }
        return t;
    }
    // Street geometry of the whole run in its current order, for the map.
    // Falls back to straight segments for any leg the network cannot trace.
    function stampRoadPath(route, depot, L, isArrival, needsReturn) {
        if (!route || typeof L !== 'function' || typeof L.pathFor !== 'function') return null;
        const stops = ((route && route.stops) || []).filter(s => hasPos(s) && !isStaff(s));
        if (!stops.length) { delete route._roadPts; return null; }
        const seq = [depot].concat(stops);
        if (isArrival || needsReturn) seq.push(depot);
        const out = [];
        for (let i = 0; i + 1 < seq.length; i++) {
            const a = seq[i], b = seq[i + 1];
            const p = L.pathFor(a, b) || [[a.lat, a.lng], [b.lat, b.lng]];
            for (let k = (out.length ? 1 : 0); k < p.length; k++) out.push(p[k]);
        }
        route._roadPts = out;
        return out;
    }

    // ---- bus colours ---------------------------------------------------------
    // `n` well-separated colours: hues spread around the wheel with a golden-
    // angle step (so consecutive picks are far apart), alternating lightness.
    function distinctColors(n) {
        const out = [];
        const hsl = (h, s, l) => {
            const a = s * Math.min(l, 1 - l);
            const f = k => { const x = (k + h / 30) % 12; return l - a * Math.max(-1, Math.min(x - 3, 9 - x, 1)); };
            const hex = v => Math.round(v * 255).toString(16).padStart(2, '0');
            return '#' + hex(f(0)) + hex(f(8)) + hex(f(4));
        };
        for (let i = 0; i < n; i++) {
            const hue = (i * 137.508) % 360;
            const light = [0.45, 0.58, 0.36][i % 3], sat = [0.78, 0.68, 0.85][i % 3];
            out.push(hsl(hue, sat, light));
        }
        return out;
    }
    // When two buses share a colour (fleet bigger than the palette), give every
    // bus of the run its own. Buses are ordered by the bearing of their route
    // from camp, and neighbours on the map are handed colours far apart on the
    // wheel, so adjacent districts never look alike. Returns Map(busId -> colour).
    function assignRouteColors(routes, depot, o) {
        const byBus = new Map();
        for (const r of (routes || [])) if (r && r.busId && !byBus.has(r.busId)) byBus.set(r.busId, r);
        const buses = Array.from(byBus.values());
        const colors = buses.map(r => String(r.busColor || '').toLowerCase());
        const dup = colors.some((c, i) => !c || colors.indexOf(c) !== i);
        if (!dup) return new Map(buses.map(r => [r.busId, r.busColor]));
        const withBearing = buses.map(r => {
            const pts = (r.stops || []).filter(hasPos);
            if (!pts.length || !depot) return { r, b: 0 };
            const la = pts.reduce((a, s) => a + s.lat, 0) / pts.length, lo = pts.reduce((a, s) => a + s.lng, 0) / pts.length;
            return { r, b: Math.atan2(lo - depot.lng, la - depot.lat) };
        }).sort((x, y) => x.b - y.b);
        const palette = distinctColors(withBearing.length);
        const out = new Map();
        withBearing.forEach((x, i) => out.set(x.r.busId, palette[i]));
        return out;
    }

    // Per-leg seconds along the route's current order (index i = leg INTO stop
    // i, last entry = leg back to camp), the shape the ETA pass consumes.
    function stampLegTimes(route, depot, L) {
        const stops = ((route && route.stops) || []).filter(s => hasPos(s) && !isStaff(s));
        if (!stops.length || typeof L !== 'function') { if (route) delete route._tspLegTimes; return null; }
        const legs = [];
        let prev = depot;
        for (const s of stops) { legs.push(Math.round(L(prev, s) * 60)); prev = s; }
        legs.push(Math.round(L(prev, depot) * 60));
        route._tspLegTimes = legs;
        return legs;
    }
    function renumber(route) { (route.stops || []).forEach((s, i) => { s.stopNum = i + 1; }); route.camperCount = headcount(route.stops); }
    function reorder(route, depot, isArrival, o) {
        if (!route || !route.stops) return;
        if (route.stops.filter(s => hasPos(s) && !s.isMonitor).length >= 2) {
            route.stops = localTspOrder(route.stops, depot, isArrival, o);
        }
        renumber(route);
        delete route._tspLegTimes; delete route._roadPts; delete route._encodedPolyline;
        if (typeof o.legMinutes === 'function') stampLegTimes(route, depot, o.legMinutes);
        route.totalDuration = Math.round(routeLastDropMin(route, depot, o));
    }
    function orderRoutes(routes, depot, isArrival, o) {
        let n = 0;
        for (const r of (routes || [])) { if (!r || !r.stops || r.stops.length < 2) continue; reorder(r, depot, isArrival, o); n++; }
        return n;
    }

    // ---- ride-time relief ---------------------------------------------------
    // A compact district far from camp can still leave its last children on
    // the bus far longer than the rest of the camp. Hand the tail of the
    // longest route to a bus with seats whose ground it already sits on.
    // (The original compared a MILES limit against a value in SECONDS, so the
    // gate was ~0.03mi and the pass never fired.)
    function relieveLongRoutes(routes, depot, isArrival, o) {
        o = opts(o);
        const MAX_MOVES = 24, MIN_GAIN_MIN = 2;
        const est = r => routeLastDropMin(r, depot, o);
        let moves = 0;
        for (let pass = 0; pass < MAX_MOVES; pass++) {
            const live = routes.filter(r => r && r.stops && r.stops.length > 2);
            if (live.length < 2) break;
            const times = live.map(est).sort((a, b) => a - b);
            const median = times[Math.floor(times.length / 2)];
            const target = Math.max(40, median * 1.35);
            const scored = live.map(r => ({ r, t: est(r) })).sort((a, b) => b.t - a.t);
            if (scored[0].t <= target) break;
            const src = scored[0].r, before = scored[0].t;

            let bestMove = null;
            const maxBatch = Math.max(1, Math.min(8, src.stops.length - 3));
            const tryBatch = (startIdx, len, single) => {
                const batch = single ? [src.stops[startIdx]] : src.stops.slice(startIdx);
                if (batch.some(s => !hasPos(s) || isStaff(s))) return;
                const n = batch.reduce((a, s) => a + riders(s), 0);
                if (!n) return;
                for (const dst of routes) {
                    if (dst === src || !dst || !dst.stops) continue;
                    const cap = dst._cap;
                    if (!Number.isFinite(cap) || cap - headcount(dst.stops) < n) continue;
                    let fits = true;
                    for (let k = 0; k < batch.length && fits; k++) {
                        const others = batch.filter((_, q) => q !== k);
                        if (!stopFitsRoute(batch[k], dst.stops, depot, o, o.maxHandoffMi, others).ok) fits = false;
                    }
                    if (!fits) continue;
                    const trySrc = single ? src.stops.filter((_, i) => i !== startIdx) : src.stops.slice(0, startIdx);
                    if (trySrc.length < 2) continue;
                    const sOrd = localTspOrder(trySrc, depot, isArrival, o);
                    const dOrd = localTspOrder(dst.stops.concat(batch), depot, isArrival, o);
                    const sAfter = est({ stops: sOrd }), dAfter = est({ stops: dOrd });
                    const after = Math.max(sAfter, dAfter);
                    if (dAfter > before - 5) continue;           // don't create a new worst
                    if (after < before - MIN_GAIN_MIN && (!bestMove || after < bestMove.after)) {
                        bestMove = { after, dst, sOrd, dOrd };
                        if (!single) return;                       // longest batch that works wins
                    }
                }
            };
            for (let len = maxBatch; len >= 1 && !bestMove; len--) tryBatch(src.stops.length - len, len, false);
            if (!bestMove) {
                const tailCount = Math.min(6, Math.max(1, src.stops.length - 2));
                for (let k = 0; k < tailCount; k++) tryBatch(src.stops.length - 1 - k, 1, true);
            }
            if (!bestMove) break;
            src.stops = bestMove.sOrd; bestMove.dst.stops = bestMove.dOrd;
            renumber(src); renumber(bestMove.dst);
            src.totalDuration = Math.round(est(src)); bestMove.dst.totalDuration = Math.round(est(bestMove.dst));
            moves++;
        }
        return moves;
    }

    // ---- duration cap -------------------------------------------------------
    // Peel the farthest stop off any route more than SLACK over the cap and
    // hand it to a bus it belongs on. Receivers are re-ordered afterwards.
    function splitOverlongRoutes(routes, capById, depot, maxRouteMin, isArrival, o) {
        o = opts(o);
        if (!routes || routes.length < 2 || !maxRouteMin) return 0;
        const active = routes.filter(r => r && r.stops && r.stops.length > 0);
        if (active.length < 2) return 0;
        const MAX_ITER = 200, MAX_MOVES_PER_BUS = 4, SLACK = 12;
        const approxInsertMin = mi => Math.max(3, Math.round(mi * 4.8 + 2));
        const movesPerBus = {}, giveUp = new Set(), dirty = new Set();
        let moves = 0;
        for (let iter = 0; iter < MAX_ITER; iter++) {
            let src = null, worstOver = 0;
            for (const r of active) {
                if (giveUp.has(r.busId)) continue;
                const over = (r.totalDuration || 0) - maxRouteMin;
                if (over > SLACK && over > worstOver) { worstOver = over; src = r; }
            }
            if (!src) break;
            movesPerBus[src.busId] = (movesPerBus[src.busId] || 0) + 1;
            if (movesPerBus[src.busId] > MAX_MOVES_PER_BUS) { giveUp.add(src.busId); continue; }

            let farIdx = -1, farD = -1;
            src.stops.forEach((st, i) => {
                if (isStaff(st) || !hasPos(st)) return;
                const d = haversineMi(depot.lat, depot.lng, st.lat, st.lng);
                if (d > farD) { farD = d; farIdx = i; }
            });
            if (farIdx < 0) { giveUp.add(src.busId); continue; }
            const cand = src.stops[farIdx], n = riders(cand);
            if (!n) { src.stops.splice(farIdx, 1); dirty.add(src); continue; }

            let receiver = null, bestMi = Infinity;
            for (const r of active) {
                if (r === src) continue;
                const cap = capById ? capById[r.busId] : undefined;
                if (cap && headcount(r.stops) + n > cap) continue;
                const fit = stopFitsRoute(cand, r.stops, depot, o, o.maxSplitHandoffMi);
                if (!fit.ok) continue;
                if ((r.totalDuration || 0) + approxInsertMin(fit.nearestMi) > maxRouteMin) continue;
                if (fit.nearestMi < bestMi) { bestMi = fit.nearestMi; receiver = r; }
            }
            if (!receiver) { giveUp.add(src.busId); continue; }
            src.stops.splice(farIdx, 1);
            receiver.stops.push(cand);
            const ins = approxInsertMin(bestMi);
            src.totalDuration = Math.max(0, (src.totalDuration || 0) - ins);
            receiver.totalDuration = (receiver.totalDuration || 0) + ins;
            dirty.add(src); dirty.add(receiver);
            moves++;
        }
        for (const r of dirty) reorder(r, depot, isArrival, o);
        return moves;
    }

    // ---- load balancing (OPT-IN) --------------------------------------------
    function rebalanceBusLoads(routes, capById, depot, isArrival, o) {
        o = opts(o);
        if (!o.equalizeLoads) return 0;
        const active = (routes || []).filter(r => r && r.stops && r.stops.length > 0);
        if (active.length < 2) return 0;
        const TARGET_RATIO = 1.4, MIN_GAP = 8, MAX_PASSES = 6;
        const dirty = new Set();
        let moves = 0;
        for (let pass = 0; pass < MAX_PASSES; pass++) {
            active.forEach(r => { r.camperCount = headcount(r.stops); });
            const sorted = active.slice().sort((a, b) => a.camperCount - b.camperCount);
            const light = sorted[0], heavy = sorted[sorted.length - 1];
            const ratio = heavy.camperCount / Math.max(1, light.camperCount);
            if (ratio < TARGET_RATIO && heavy.camperCount - light.camperCount < MIN_GAP) break;
            const cap = capById ? (capById[light.busId] || 999) : 999;
            const room = cap - light.camperCount;
            if (room <= 0) break;
            let bestIdx = -1, bestScore = 0;
            heavy.stops.forEach((st, idx) => {
                if (isStaff(st) || !hasPos(st)) return;
                const k = riders(st);
                if (!k || k > room) return;
                if (light.camperCount + k > heavy.camperCount - k) return;
                const fit = stopFitsRoute(st, light.stops, depot, o, o.maxRebalanceHandoffMi);
                if (!fit.ok) return;
                const dHeavy = nearestStopMi(st, heavy.stops, st);
                const score = dHeavy - fit.nearestMi;    // must be closer to the light bus's own stops
                if (score > bestScore) { bestScore = score; bestIdx = idx; }
            });
            if (bestIdx < 0) break;
            light.stops.push(heavy.stops.splice(bestIdx, 1)[0]);
            dirty.add(light); dirty.add(heavy);
            moves++;
        }
        for (const r of dirty) reorder(r, depot, isArrival, o);
        return moves;
    }

    // ---- hard capacity ------------------------------------------------------
    // Buses have a definite seat count. Districting normally respects it, but
    // the k-means path works to a soft cap and the leftover/append paths can
    // overshoot. Move stops off any over-capacity bus onto a contained
    // receiver with room; fall back to the nearest receiver with room (and
    // say so) rather than ship a bus with more children than seats.
    // One-step ejection chain for enforceCapacity: src stop -> mid (contained,
    // full) while mid stop -> far (contained, has room). Returns the cheapest
    // such pair or null. Bounded: only src stops with riders, only the mid
    // buses the stop is contained on.
    function findChain(src, active, capOf, depot, o) {
        let best = null;
        for (let i = 0; i < src.stops.length; i++) {
            const st = src.stops[i];
            if (isStaff(st) || !hasPos(st)) continue;
            const k = riders(st);
            if (!k) continue;
            for (const mid of active) {
                if (mid === src) continue;
                const fitMid = stopFitsRoute(st, mid.stops, depot, o, o.maxCapacityHandoffMi);
                if (!fitMid.ok) continue;
                const midRoom = capOf(mid) - headcount(mid.stops);
                if (midRoom >= k) continue; // then it is not a chain case
                for (let j = 0; j < mid.stops.length; j++) {
                    const ms = mid.stops[j];
                    if (isStaff(ms) || !hasPos(ms)) continue;
                    const mk = riders(ms);
                    if (!mk || midRoom + mk < k) continue; // must free enough seats
                    for (const far of active) {
                        if (far === src || far === mid) continue;
                        if (headcount(far.stops) + mk > capOf(far)) continue;
                        const fitFar = stopFitsRoute(ms, far.stops, depot, o, o.maxCapacityHandoffMi);
                        if (!fitFar.ok) continue;
                        const rank = fitMid.nearestMi + fitFar.nearestMi;
                        if (!best || rank < best.rank) best = { rank, srcIdx: i, mid, midIdx: j, midStop: ms, far };
                    }
                }
            }
        }
        return best;
    }

    function enforceCapacity(routes, capById, depot, isArrival, o) {
        o = opts(o);
        const active = (routes || []).filter(r => r && r.stops);
        const dirty = new Set();
        let moved = 0, stranded = 0, uncontained = 0;
        const capOf = r => { const c = capById ? capById[r.busId] : undefined; return Number.isFinite(c) && c > 0 ? c : Infinity; };
        for (const src of active) {
            let guard = 0;
            while (headcount(src.stops) > capOf(src) && guard++ < 200) {
                const over = headcount(src.stops) - capOf(src);
                let best = null;
                for (let i = 0; i < src.stops.length; i++) {
                    const st = src.stops[i];
                    if (isStaff(st) || !hasPos(st)) continue;
                    const k = riders(st);
                    if (!k) continue;
                    for (const dst of active) {
                        if (dst === src) continue;
                        if (headcount(dst.stops) + k > capOf(dst)) continue;
                        const fit = stopFitsRoute(st, dst.stops, depot, o, o.maxCapacityHandoffMi);
                        const nearest = fit.ok ? fit.nearestMi : nearestStopMi(st, dst.stops);
                        // Prefer contained receivers; among them the nearest;
                        // among equals, the stop that clears the overage best.
                        const rank = (fit.ok ? 0 : 1000) + nearest + (k >= over ? 0 : 0.5);
                        if (!best || rank < best.rank) best = { rank, i, dst, contained: fit.ok };
                    }
                }
                // No contained receiver has room: before falling back to a bus
                // outside the stop's area, try a one-step chain — a contained
                // neighbour B with no room hands one of ITS stops to a contained
                // bus C that does have room, then takes ours.
                if (best && !best.contained) {
                    const chain = findChain(src, active, capOf, depot, o);
                    if (chain) {
                        chain.mid.stops.splice(chain.midIdx, 1);                  // mid gives up one stop...
                        chain.far.stops.push(chain.midStop);                      // ...to a contained bus with room,
                        chain.mid.stops.push(src.stops.splice(chain.srcIdx, 1)[0]); // and takes ours.
                        dirty.add(src); dirty.add(chain.mid); dirty.add(chain.far);
                        moved += 2;
                        continue;
                    }
                }
                if (!best) { stranded += over; break; }
                if (!best.contained) uncontained++;
                best.dst.stops.push(src.stops.splice(best.i, 1)[0]);
                dirty.add(src); dirty.add(best.dst);
                moved++;
            }
        }
        for (const r of dirty) reorder(r, depot, isArrival, o);
        return { moved, stranded, uncontained };
    }

    // ---- road network -------------------------------------------------------
    // Travel times on the real street network, the way every commercial
    // routing product measures them: class-based speeds, one-way streets,
    // rivers and highways with no crossing, cul-de-sacs. Built from the
    // OpenStreetMap graph the neighbourhood pass already fetches, so it costs
    // no extra network call. Straight-line x roadFactor remains the fallback.
    const CLASS_MPH = {
        motorway: 55, motorway_link: 35, trunk: 45, trunk_link: 30, primary: 35, primary_link: 25,
        secondary: 30, secondary_link: 25, tertiary: 25, tertiary_link: 20,
        unclassified: 22, residential: 20, living_street: 12, service: 12,
    };
    function buildRoadNet(graph, o) {
        o = opts(o);
        if (!graph || !graph.nodes || !Array.isArray(graph.edges) || !graph.edges.length) return null;
        const ids = Object.keys(graph.nodes);
        const N = ids.length;
        if (N < 2) return null;
        const idx = new Map();
        const lat = new Float64Array(N), lng = new Float64Array(N);
        ids.forEach((id, i) => { idx.set(String(id), i); lat[i] = graph.nodes[id].lat; lng[i] = graph.nodes[id].lng; });
        // The camp's Avg Speed setting calibrates the whole table (25 = as listed).
        const scale = Math.max(0.2, (o.avgSpeedMph || 25) / 25);
        const arcs = []; // a, b, minutes, edgeIndex, reversed(0/1)
        graph.edges.forEach((e, ei) => {
            const a = idx.get(String(e.fromNodeId)), b = idx.get(String(e.toNodeId));
            if (a == null || b == null || a === b) return;
            const mph = (CLASS_MPH[e.hwClass] || 20) * scale;
            const min = (Number(e.lenMi) || 0) / mph * 60 + o.roadEdgePenaltyMin;
            const ow = e.oneway;
            if (ow !== -1 && ow !== 'reverse') arcs.push(a, b, min, ei, 0);
            if (!ow || ow === -1 || ow === 'reverse' || ow === false) arcs.push(b, a, min, ei, 1);
        });
        // CSR adjacency
        const head = new Int32Array(N + 1);
        for (let k = 0; k < arcs.length; k += 5) head[arcs[k] + 1]++;
        for (let i = 0; i < N; i++) head[i + 1] += head[i];
        const M = arcs.length / 5;
        const to = new Int32Array(M), w = new Float64Array(M), arcEdge = new Int32Array(M), arcRev = new Uint8Array(M), fill = head.slice(0, N);
        for (let k = 0; k < arcs.length; k += 5) { const a = arcs[k]; const f = fill[a]++; to[f] = arcs[k + 1]; w[f] = arcs[k + 2]; arcEdge[f] = arcs[k + 3]; arcRev[f] = arcs[k + 4]; }
        // spatial grid for nearest-node lookup
        const CELL = 0.005;
        const grid = new Map();
        for (let i = 0; i < N; i++) {
            const key = Math.floor(lat[i] / CELL) + ':' + Math.floor(lng[i] / CELL);
            let arr = grid.get(key); if (!arr) { arr = []; grid.set(key, arr); } arr.push(i);
        }
        function nearest(pLat, pLng) {
            const cy = Math.floor(pLat / CELL), cx = Math.floor(pLng / CELL);
            let best = -1, bestD = Infinity;
            for (let ring = 0; ring <= 4 && best < 0; ring++) {
                for (let dy = -ring; dy <= ring; dy++) for (let dx = -ring; dx <= ring; dx++) {
                    if (ring && Math.abs(dy) !== ring && Math.abs(dx) !== ring) continue;
                    const arr = grid.get((cy + dy) + ':' + (cx + dx)); if (!arr) continue;
                    for (const i of arr) { const d = haversineMi(pLat, pLng, lat[i], lng[i]); if (d < bestD) { bestD = d; best = i; } }
                }
            }
            return best < 0 ? null : { i: best, offMi: bestD };
        }
        // Binary-heap Dijkstra from `src`, stopping once every node in `targets`
        // is settled. Returns a sparse Map(node -> minutes); with `pred` given,
        // fills it with node -> arc index used to reach it (for path recovery).
        function dijkstra(src, targets, pred) {
            const dist = new Map(); dist.set(src, 0);
            const settled = new Set();
            let want = 0; for (const t of targets) if (!settled.has(t)) want++;
            const hd = [0], hn = [src];
            const push = (d, n) => { hd.push(d); hn.push(n); let i = hd.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (hd[p] <= hd[i]) break; [hd[p], hd[i]] = [hd[i], hd[p]]; [hn[p], hn[i]] = [hn[i], hn[p]]; i = p; } };
            const pop = () => { const d = hd[0], n = hn[0]; const ld = hd.pop(), ln = hn.pop(); if (hd.length) { hd[0] = ld; hn[0] = ln; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < hd.length && hd[l] < hd[m]) m = l; if (r < hd.length && hd[r] < hd[m]) m = r; if (m === i) break; [hd[m], hd[i]] = [hd[i], hd[m]]; [hn[m], hn[i]] = [hn[i], hn[m]]; i = m; } } return [d, n]; };
            while (hd.length && want > 0) {
                const [d, n] = pop();
                if (settled.has(n)) continue;
                settled.add(n);
                if (targets.has(n)) want--;
                for (let k = head[n]; k < head[n + 1]; k++) {
                    const m = to[k], nd = d + w[k];
                    const cur = dist.get(m);
                    if (cur == null || nd < cur) { dist.set(m, nd); if (pred) pred.set(m, k); push(nd, m); }
                }
            }
            return dist;
        }
        // Street coordinates of the shortest path from node `src` to node `dst`
        // given the predecessor map of a Dijkstra run from `src`.
        function pathCoords(src, dst, pred) {
            if (src === dst) return [[lat[src], lng[src]]];
            const arcsBack = [];
            let cur = dst, guard = 0;
            while (cur !== src && guard++ < 200000) {
                const k = pred.get(cur);
                if (k == null) return null;
                arcsBack.push(k);
                cur = to[k] === cur ? (function () { // arc k goes from ? -> cur; find its tail
                    // tail is the node whose adjacency range contains k
                    let lo = 0, hi = N - 1;
                    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (head[mid] <= k) lo = mid; else hi = mid - 1; }
                    return lo;
                })() : cur;
            }
            if (cur !== src) return null;
            const out = [[lat[src], lng[src]]];
            for (let i = arcsBack.length - 1; i >= 0; i--) {
                const k = arcsBack[i];
                const e = graph.edges[arcEdge[k]];
                const shape = (e && Array.isArray(e.pts)) ? (arcRev[k] ? e.pts.slice().reverse() : e.pts) : [];
                for (const q of shape) out.push([q[0], q[1]]);
                out.push([lat[to[k]], lng[to[k]]]);
            }
            return out;
        }
        const snapCache = new WeakMap();
        const rowCache = new Map(); // "srcNode|targetsKey" -> Map(targetNode -> minutes)
        function snap(p) {
            if (!hasPos(p)) return null;
            let s = snapCache.get(p);
            if (s === undefined) { s = nearest(p.lat, p.lng); snapCache.set(p, s); }
            return s;
        }
        const offMin = mi => mi / Math.max(1, o.roadOffMph) * 60;
        // Minutes between every pair of `points` (stop objects with lat/lng).
        // Returns legMinutes(a, b) that answers from the matrix for known
        // points and falls back to straight-line x roadFactor otherwise.
        function legMinutesFor(points) {
            const pts = points.filter(hasPos);
            const snaps = pts.map(snap);
            const targets = new Set(snaps.filter(Boolean).map(x => x.i));
            const targetsKey = Array.from(targets).sort((a, b) => a - b).join(',');
            const bySrc = new Map(); // node -> Map(node -> min)
            const predBySrc = new Map(); // node -> pred map (this call only; for path recovery)
            const table = new Map(); // point -> Map(point -> min)
            for (let i = 0; i < pts.length; i++) {
                const si = snaps[i]; if (!si) continue;
                let dist = bySrc.get(si.i);
                if (!dist) {
                    const key = si.i + '|' + targetsKey;
                    dist = rowCache.get(key);
                    if (!dist) {
                        const pred = new Map();
                        const full = dijkstra(si.i, targets, pred);
                        predBySrc.set(si.i, pred);
                        dist = new Map();
                        for (const t of targets) { const d = full.get(t); if (d != null) dist.set(t, d); }
                        if (rowCache.size > 4000) rowCache.clear();
                        rowCache.set(key, dist);
                    }
                    bySrc.set(si.i, dist);
                }
                const row = new Map();
                for (let j = 0; j < pts.length; j++) {
                    if (j === i) { row.set(pts[j], 0); continue; }
                    const sj = snaps[j]; if (!sj) continue;
                    const d = dist.get(sj.i);
                    if (d != null) row.set(pts[j], d + offMin(si.offMi) + offMin(sj.offMi));
                }
                table.set(pts[i], row);
            }
            // Callers rebuild the depot as a fresh {lat,lng} object all the
            // time, so answer by coordinates too, not only by object identity.
            const ck = p => p.lat.toFixed(6) + ',' + p.lng.toFixed(6);
            const byKey = new Map();
            for (const p of pts) if (!byKey.has(ck(p))) byKey.set(ck(p), p);
            const resolve = p => table.has(p) ? p : (hasPos(p) ? byKey.get(ck(p)) : undefined);
            const legMinutes = function (a, b) {
                const pa = resolve(a), pb = resolve(b);
                const row = pa && table.get(pa);
                const v = row && pb ? row.get(pb) : undefined;
                return v != null ? v : driveMin(a, b, o);
            };
            // Street path between two known points: [[lat,lng],...] from a to b
            // through the network, or null when either is off the network.
            legMinutes.pathFor = function (a, b) {
                const sa = snap(a), sb = snap(b);
                if (!sa || !sb) return null;
                let pred = predBySrc.get(sa.i);
                if (!pred) { pred = new Map(); dijkstra(sa.i, new Set([sb.i]), pred); predBySrc.set(sa.i, pred); }
                const p = pathCoords(sa.i, sb.i, pred);
                if (!p) return null;
                return [[a.lat, a.lng]].concat(p, [[b.lat, b.lng]]);
            };
            return legMinutes;
        }
        return { nodeCount: N, arcCount: to.length, snap, legMinutesFor, dijkstra, _nearest: nearest };
    }

    // ---- capacity-aware sweep -----------------------------------------------
    // `ring`: atoms in circular order around camp, each {count, lat, lng,
    // groupId?}. `caps`: seats per bus, in the order arcs are handed out.
    // Cuts the ring into at most caps.length CONTIGUOUS arcs, each within its
    // bus's seats, minimising the fleet's total estimated riding minutes
    // (plus a per-bus overhead, a penalty for splitting a group between two
    // buses, and a penalty for arcs over the riding budget). Every rotation
    // of the seam is tried, so the cut can fall anywhere. Because each arc is
    // one wedge of the map, no bus can end up on both sides of camp, and
    // because cuts may fall inside a group it never fails on a tight fleet
    // the way packing whole neighbourhoods in order did.
    // Returns { cost, arcs } with arcs[k] an array of ring atoms (or null for
    // an unused bus), or null when the fleet cannot seat everyone.
    function sweepPartition(ring, caps, depot, o) {
        o = opts(o);
        const M = (ring || []).length, N = (caps || []).length;
        if (M < 2 || !N || !depot) return null;
        const total = ring.reduce((a, x) => a + (x.count || 0), 0);
        if (total > caps.reduce((a, c) => a + c, 0)) return null;
        const PER_STOP = o.sweepRidersPerStop, CUT = o.sweepGroupCutMin;
        const OVERHEAD = Number.isFinite(o.sweepBusOverheadMin) ? o.sweepBusOverheadMin : o.busOverheadMin;
        const dist = ring.map(a => haversineMi(depot.lat, depot.lng, a.lat, a.lng));

        function arcCost(agg, cutInsideGroup) {
            const stops = Math.max(1, Math.round(agg.count / PER_STOP));
            const diag = haversineMi(agg.mnLa, agg.mnLo, agg.mxLa, agg.mxLo);
            const miles = agg.far + 0.5 * Math.sqrt(stops) * diag;
            const ride = (miles * o.roadFactor / Math.max(1, o.avgSpeedMph)) * 60 +
                stops * o.avgStopMin + (o.secPerRider > 0 ? agg.count * o.secPerRider / 60 : 0);
            const over = o.sweepMaxRideMin > 0 ? Math.max(0, ride - o.sweepMaxRideMin) : 0;
            return ride + over * 2 + OVERHEAD + (cutInsideGroup ? CUT : 0);
        }
        function solve(order, odist) {
            const INF = Infinity;
            const dp = [], from = [];
            for (let k = 0; k <= N; k++) { dp.push(new Float64Array(M + 1).fill(INF)); from.push(new Int32Array(M + 1).fill(-1)); }
            dp[0][0] = 0;
            for (let k = 1; k <= N; k++) {
                const cap = caps[k - 1];
                for (let i = 0; i <= M; i++) {
                    if (dp[k - 1][i] < dp[k][i]) { dp[k][i] = dp[k - 1][i]; from[k][i] = i; } // bus unused
                    if (i === 0) continue;
                    const agg = { count: 0, far: 0, mnLa: Infinity, mxLa: -Infinity, mnLo: Infinity, mxLo: -Infinity };
                    for (let s = i - 1; s >= 0; s--) {
                        const a = order[s];
                        agg.count += a.count || 0;
                        if (agg.count > cap) break;
                        if (odist[s] > agg.far) agg.far = odist[s];
                        if (a.lat < agg.mnLa) agg.mnLa = a.lat; if (a.lat > agg.mxLa) agg.mxLa = a.lat;
                        if (a.lng < agg.mnLo) agg.mnLo = a.lng; if (a.lng > agg.mxLo) agg.mxLo = a.lng;
                        if (dp[k - 1][s] === INF) continue;
                        const cut = s > 0 && a.groupId != null && order[s - 1].groupId === a.groupId;
                        const c = dp[k - 1][s] + arcCost(agg, cut);
                        if (c < dp[k][i]) { dp[k][i] = c; from[k][i] = s; }
                    }
                }
            }
            if (dp[N][M] === INF) return null;
            const arcs = new Array(N).fill(null);
            let i = M;
            for (let k = N; k >= 1; k--) {
                const s = from[k][i];
                if (s !== i) arcs[k - 1] = order.slice(s, i);
                i = s;
            }
            return { cost: dp[N][M], arcs };
        }
        const stride = Math.max(1, Math.ceil(M / Math.max(1, o.sweepRotations)));
        let best = null;
        for (let start = 0; start < M; start += stride) {
            const order = start ? ring.slice(start).concat(ring.slice(0, start)) : ring;
            const odist = start ? dist.slice(start).concat(dist.slice(0, start)) : dist;
            const sol = solve(order, odist);
            if (sol && (!best || sol.cost < best.cost)) best = sol;
        }
        return best;
    }

    // ---- district polish ----------------------------------------------------
    // Local search on the districting itself. Once buses have their areas
    // (from the packer or the sweep), move single atoms — road segments or
    // sibling groups, {count, lat, lng} — between buses, or swap two, whenever
    // that lowers the fleet's total estimated minutes. Each bus is priced by a
    // nearest-neighbour + 2-opt tour through its atoms from camp, so a move
    // is judged by what it really does to the two routes involved rather
    // than by distance to a centroid. Hard rules: seats, and containment (a
    // bus may not widen its wedge around camp past the limit). Soft rule: a
    // per-bus riding budget, priced like the sweep does. Returns
    // { buckets, moves, before, after } with buckets in visiting order.
    function polishDistricts(buckets, caps, depot, o) {
        o = opts(o);
        const t0 = Date.now();
        const speed = Math.max(1, o.avgSpeedMph), budget = o.polishRideBudgetMin, OVERHEAD = o.busOverheadMin;
        const LAMBDA = Math.max(0, o.polishChildMinuteWeight || 0);
        const SPLIT = Math.max(0, o.polishStreetSplitMin || 0);
        const ARR = !!o.isArrival;
        const MERGE_SAME = Math.max(0, o.polishMergeSameStreetMi || 0), MERGE_ANY = Math.max(0, o.polishMergeAnyMi || 0);
        // Street travel times when the caller has the road network (legMinutes),
        // else straight-line x road factor.
        const L = typeof o.legMinutes === 'function' ? o.legMinutes : null;
        const leg = (a, b) => L ? L(a, b) : (haversineMi(a.lat, a.lng, b.lat, b.lng) * o.roadFactor / speed) * 60;
        // Riders per atom: an explicit count, else the campers list, else one.
        const cnt = x => Number.isFinite(x.count) ? x.count : (riders(x) || 1);
        const perRider = x => o.secPerRider > 0 ? cnt(x) * o.secPerRider / 60 : 0;
        const dwellOf = x => o.avgStopMin + perRider(x);
        // Street an atom sits on (for coherence). Empty = unknown, never penalised.
        const streetOf = x => {
            const k = x.streetKey != null ? x.streetKey : x.street;
            return k == null ? '' : String(k).toLowerCase().trim();
        };
        // Would x share a stop with y on the same bus? Mirrors the pipeline's
        // stop consolidation (same street within one radius, anything within
        // a tighter one). A shared stop costs no base dwell of its own.
        const mergeable = (x, y) => {
            if (!MERGE_SAME && !MERGE_ANY) return false;
            // Manhattan miles, as the consolidation pass measures walks.
            const d = Math.abs(x.lat - y.lat) * 69 + Math.abs(x.lng - y.lng) * 54.6;
            if (MERGE_ANY && d <= MERGE_ANY) return true;
            if (MERGE_SAME && d <= MERGE_SAME) { const k = streetOf(x); return !!k && k === streetOf(y); }
            return false;
        };
        const B = (buckets || []).map((atoms, i) => ({
            atoms: atoms.slice(), cap: Number.isFinite(caps && caps[i]) ? caps[i] : Infinity,
            count: atoms.reduce((a, x) => a + cnt(x), 0), tour: [], len: 0, childMin: 0, wedge: 0,
            arr: [], dep: [], suf: [], pre: [], dw: [], streets: new Map(),
        }));
        const N = B.length;
        if (N < 2 || !depot) return { buckets: buckets.slice(), moves: 0, before: 0, after: 0,
                                       fleetBefore: 0, fleetAfter: 0, childMinBefore: 0, childMinAfter: 0 };
        const totalAtoms = B.reduce((a, b) => a + b.atoms.length, 0);
        const timeBudgetMs = Math.max(o.polishTimeBudgetMs, (o.polishMsPerAtom || 0) * totalAtoms);

        // ── street coherence bookkeeping ──
        // streetBuses[k] = how many buses currently serve street k. The fleet
        // pays SPLIT for every bus beyond the first on the same street.
        const streetBuses = new Map();
        function addStreet(b, atom) {
            const k = streetOf(atom); if (!k) return;
            const c = (b.streets.get(k) || 0) + 1; b.streets.set(k, c);
            if (c === 1) streetBuses.set(k, (streetBuses.get(k) || 0) + 1);
        }
        function delStreet(b, atom) {
            const k = streetOf(atom); if (!k) return;
            const c = (b.streets.get(k) || 0) - 1;
            if (c <= 0) { b.streets.delete(k); streetBuses.set(k, (streetBuses.get(k) || 0) - 1); }
            else b.streets.set(k, c);
        }
        // Change in the split penalty when `atom` leaves `from` for `to`.
        function streetDelta(from, to, atom) {
            if (!SPLIT) return 0;
            const k = streetOf(atom); if (!k) return 0;
            let n = streetBuses.get(k) || 0, d = 0;
            if (from.streets.get(k) === 1) { if (n >= 2) d -= SPLIT; n--; }
            if (!to.streets.has(k)) { if (n >= 1) d += SPLIT; }
            return d;
        }
        function streetPenalty() {
            let p = 0; for (const n of streetBuses.values()) if (n > 1) p += (n - 1) * SPLIT; return p;
        }
        for (const b of B) for (const a of b.atoms) addStreet(b, a);

        // ── tour pricing ──
        // Walk a tour once: bus minutes (dismissal: to the last drop; arrival:
        // back to camp) and child-minutes (each rider x their time aboard).
        // Also fills the per-position arrays used for O(1) move pricing.
        function evalTour(atoms, tour, out) {
            let t = 0, prev = depot, cm = 0, wsum = 0;
            const arr = out ? out.arr : null, dep = out ? out.dep : null, dwv = out ? out.dw : null;
            if (arr) { arr.length = 0; dep.length = 0; dwv.length = 0; }
            // Shared stops: atoms linked by mergeable pairs (transitively, as the
            // consolidation pass chains them) form one stop; its first atom in
            // tour order carries the base dwell.
            let charged = null;
            if (MERGE_SAME || MERGE_ANY) {
                const n = tour.length, parent = new Int32Array(n);
                for (let i = 0; i < n; i++) parent[i] = i;
                const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
                for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
                    if (mergeable(atoms[tour[i]], atoms[tour[j]])) { const a = find(i), b = find(j); if (a !== b) parent[a] = b; }
                }
                charged = new Uint8Array(n); const seen = new Set();
                for (let i = 0; i < n; i++) { const r = find(i); if (!seen.has(r)) { seen.add(r); charged[i] = 1; } }
            }
            let pos = 0, tot = 0;
            for (const i of tour) {
                const a = atoms[i];
                t += leg(prev, a);
                if (arr) arr.push(t);
                const k = cnt(a); tot += k;
                if (ARR) wsum += k * t; else cm += k * t;
                const dw = perRider(a) + ((!charged || charged[pos]) ? o.avgStopMin : 0);
                pos++;
                t += dw;
                if (dep) { dep.push(t); dwv.push(dw); }
                prev = a;
            }
            if (ARR) { if (tour.length) t += leg(prev, depot); cm = t * tot - wsum; } // each child: camp arrival minus pickup
            if (out) {
                const n = tour.length, suf = out.suf, pre = out.pre;
                suf.length = n + 1; pre.length = n + 1;
                suf[n] = 0; for (let i = n - 1; i >= 0; i--) suf[i] = suf[i + 1] + cnt(atoms[tour[i]]);
                pre[0] = 0; for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + cnt(atoms[tour[i]]);
                out.len = t; out.childMin = cm;
            }
            return { len: t, childMin: cm };
        }
        function buildTour(b) {
            const n = b.atoms.length;
            if (!n) { b.tour = []; b.len = 0; b.childMin = 0; b.wedge = 0; b.arr = []; b.dep = []; b.dw = []; b.suf = [0]; b.pre = [0]; return; }
            const rem = []; for (let i = 0; i < n; i++) rem.push(i);
            const t = []; let cur = depot;
            while (rem.length) {
                let bi = 0, bd = Infinity;
                for (let k = 0; k < rem.length; k++) { const d = leg(cur, b.atoms[rem[k]]); if (d < bd) { bd = d; bi = k; } }
                t.push(rem.splice(bi, 1)[0]); cur = b.atoms[t[t.length - 1]];
            }
            // open-path 2-opt on distance
            let improved = true, guard = 0;
            while (improved && guard++ < 100) {
                improved = false;
                for (let i = 0; i < n - 1 && !improved; i++) {
                    const a = i === 0 ? depot : b.atoms[t[i - 1]], x = b.atoms[t[i]];
                    for (let j = i + 1; j < n; j++) {
                        const y = b.atoms[t[j]], d = j + 1 < n ? b.atoms[t[j + 1]] : (ARR ? depot : null);
                        const before = leg(a, x) + (d ? leg(y, d) : 0);
                        const after = leg(a, y) + (d ? leg(x, d) : 0);
                        if (after < before - 1e-9) {
                            for (let p = i, q = j; p < q; p++, q--) { const tmp = t[p]; t[p] = t[q]; t[q] = tmp; }
                            improved = true; break;
                        }
                    }
                }
            }
            b.tour = t; refresh(b);
        }
        function refresh(b) { evalTour(b.atoms, b.tour, b); b.wedge = arcDeg(b.atoms, depot, o); }
        // Cost of one bus: its minutes, the cost of running it at all, a
        // penalty for exceeding the riding budget, and the children's minutes.
        const busCost = (len, cm) => len <= 0 ? 0 : len + OVERHEAD + (budget > 0 ? 2 * Math.max(0, len - budget) : 0) + LAMBDA * cm;
        const objective = () => B.reduce((a, b) => a + busCost(b.len, b.childMin), 0) + streetPenalty();
        const fleetMin = () => B.reduce((a, b) => a + b.len, 0);
        const childMin = () => B.reduce((a, b) => a + b.childMin, 0);

        // Removing tour position `pos` from bus b: { dLen, dCm } (both ≤ 0).
        function removalDelta(b, pos) {
            const t = b.tour, cur = b.atoms[t[pos]], k = cnt(cur);
            const prev = pos > 0 ? b.atoms[t[pos - 1]] : depot;
            const next = pos + 1 < t.length ? b.atoms[t[pos + 1]] : (ARR ? depot : null);
            const dw = b.dw[pos] != null ? b.dw[pos] : dwellOf(cur); // the dwell this stop is actually charged
            const S = next ? leg(prev, cur) + leg(cur, next) - leg(prev, next) + dw : leg(prev, cur) + dw;
            const dCm = ARR ? -(S * b.pre[pos] + k * (b.len - b.arr[pos]))
                            : -(S * b.suf[pos + 1] + k * b.arr[pos]);
            return { dLen: -S, dCm };
        }
        // Best insertion of `atom` into bus b's tour under the full bus cost,
        // optionally treating tour position `excludePos` as already removed
        // (child-minutes are then approximate; callers re-price on apply).
        // Returns { at, dLen, dCm, delta } with `at` the position in the tour
        // WITHOUT the excluded stop.
        function bestInsert(b, atom, excludePos) {
            const t = b.tour, k = cnt(atom);
            // Joining a stop the bus already makes costs only the per-child time.
            let dw = dwellOf(atom);
            if (MERGE_SAME || MERGE_ANY) {
                const ex = excludePos >= 0 ? t[excludePos] : -1;
                for (let i = 0; i < b.atoms.length; i++) if (i !== ex && mergeable(atom, b.atoms[i])) { dw = perRider(atom); break; }
            }
            const base = busCost(b.len, b.childMin);
            let best = null, j = 0, prev = depot;
            for (let i = 0; i <= t.length; i++) {
                if (i === excludePos) continue; // the gap: prev stays the stop before it
                const next = i < t.length ? b.atoms[t[i]] : (ARR ? depot : null);
                const lp = leg(prev, atom);
                const D = (next ? lp + leg(atom, next) - leg(prev, next) : lp) + dw;
                const pi = i - 1 === excludePos ? i - 2 : i - 1;
                const arrX = (pi >= 0 ? b.dep[pi] : 0) + lp;
                const dCm = ARR ? D * b.pre[i] + k * (b.len + D - arrX)
                                : D * b.suf[i] + k * arrX;
                const delta = busCost(b.len + D, b.childMin + dCm) - base;
                if (!best || delta < best.delta) best = { at: j, dLen: D, dCm, delta };
                if (!next || i >= t.length) break;
                prev = next; j++;
            }
            return best;
        }
        // Nearest distance (mi) from an atom to any atom of bus b — cheap
        // pruning so we never price a move onto a bus that is nowhere near.
        function reachMi(b, atom) {
            let d = Infinity;
            for (const x of b.atoms) { const m = haversineMi(atom.lat, atom.lng, x.lat, x.lng); if (m < d) d = m; }
            return d;
        }
        const outOfTime = () => Date.now() - t0 > timeBudgetMs;
        function wedgeOk(b, adding, removingIdx) {
            const pts = [];
            for (let i = 0; i < b.atoms.length; i++) if (i !== removingIdx) pts.push(b.atoms[i]);
            for (const a of adding) pts.push(a);
            const w = arcDeg(pts, depot, o);
            return w <= o.maxDistrictArcDeg || w <= b.wedge + 1e-9;
        }
        function removeAt(b, pos) {
            const idx = b.tour[pos];
            const atom = b.atoms[idx];
            b.atoms.splice(idx, 1);
            b.tour.splice(pos, 1);
            for (let i = 0; i < b.tour.length; i++) if (b.tour[i] > idx) b.tour[i]--;
            b.count -= cnt(atom);
            delStreet(b, atom);
            return atom;
        }
        function insertAt(b, atom, at) {
            b.atoms.push(atom);
            b.tour.splice(at, 0, b.atoms.length - 1);
            b.count += cnt(atom);
            addStreet(b, atom);
        }
        const snap = b => ({ atoms: b.atoms.slice(), tour: b.tour.slice(), count: b.count, streets: new Map(b.streets) });
        function restore(b, s) {
            for (const [k, c] of b.streets) if (c > 0 && !(s.streets.get(k) > 0)) streetBuses.set(k, (streetBuses.get(k) || 0) - 1);
            for (const [k, c] of s.streets) if (c > 0 && !(b.streets.get(k) > 0)) streetBuses.set(k, (streetBuses.get(k) || 0) + 1);
            b.atoms = s.atoms; b.tour = s.tour; b.count = s.count; b.streets = s.streets; refresh(b);
        }

        for (const b of B) buildTour(b);
        const before = objective(), fleetBefore = fleetMin(), childMinBefore = childMin();
        let moves = 0;
        const EPS = o.polishMinGainMin;

        let stop = false;
        function localSearch() {
        for (let pass = 0; pass < o.polishMaxPasses && !stop; pass++) {
            if (outOfTime()) break;
            let improved = false;
            // ── relocate ──
            for (let ai = 0; ai < N && !stop; ai++) {
                const A = B[ai];
                // A bus over its riding budget may hand work to a bus further
                // away — a remote township's relief IS a longer hand-off.
                const reach = (budget > 0 && A.len > budget) ? o.polishReachMi * o.polishReachOverBudgetX : o.polishReachMi;
                for (let pos = 0; pos < A.tour.length; pos++) {
                    if ((pos & 15) === 0 && outOfTime()) { stop = true; break; }
                    const atom = A.atoms[A.tour[pos]];
                    const rem = removalDelta(A, pos);
                    const dA = busCost(A.len + rem.dLen, A.childMin + rem.dCm) - busCost(A.len, A.childMin);
                    let best = null;
                    for (let bi = 0; bi < N; bi++) {
                        if (bi === ai) continue;
                        const Bb = B[bi];
                        if (Bb.count + cnt(atom) > Bb.cap) continue;
                        if (Bb.atoms.length && reachMi(Bb, atom) > reach) continue;
                        const ins = bestInsert(Bb, atom, -1);
                        const delta = dA + ins.delta + streetDelta(A, Bb, atom);
                        if (delta < -EPS && (!best || delta < best.delta)) {
                            if (!wedgeOk(Bb, [atom], -1)) continue;
                            best = { delta, bi, at: ins.at };
                        }
                    }
                    if (best) {
                        // Priced with O(1) deltas; apply, re-price exactly, keep only a real gain.
                        const Bb = B[best.bi], sA = snap(A), sB = snap(Bb), objBefore = objective();
                        const moved = removeAt(A, pos);
                        insertAt(Bb, moved, best.at);
                        refresh(A); refresh(Bb);
                        if (objective() < objBefore - EPS / 2) {
                            moves++; improved = true;
                            pos--; // re-examine this position (a new atom sits there now)
                        } else { restore(A, sA); restore(Bb, sB); }
                    }
                }
            }
            // ── swap ──
            for (let ai = 0; ai < N && !stop; ai++) for (let bi = ai + 1; bi < N && !stop; bi++) {
                const A = B[ai], Bb = B[bi];
                if (!A.tour.length || !Bb.tour.length) continue;
                if (outOfTime()) { stop = true; break; }
                // Only atoms that could plausibly ride the other bus.
                const aNear = A.tour.map(i => reachMi(Bb, A.atoms[i]) <= o.polishReachMi);
                if (!aNear.some(Boolean)) continue;
                const bNear = Bb.tour.map(i => reachMi(A, Bb.atoms[i]) <= o.polishReachMi);
                if (!bNear.some(Boolean)) continue;
                let best = null;
                const baseA = busCost(A.len, A.childMin), baseB = busCost(Bb.len, Bb.childMin);
                for (let pa = 0; pa < A.tour.length; pa++) {
                    if (!aNear[pa]) continue;
                    const a = A.atoms[A.tour[pa]];
                    const rA = removalDelta(A, pa);
                    for (let pb = 0; pb < Bb.tour.length; pb++) {
                        if (!bNear[pb]) continue;
                        const b = Bb.atoms[Bb.tour[pb]];
                        if (A.count - cnt(a) + cnt(b) > A.cap) continue;
                        if (Bb.count - cnt(b) + cnt(a) > Bb.cap) continue;
                        const rB = removalDelta(Bb, pb);
                        const iA = bestInsert(A, b, pa), iB = bestInsert(Bb, a, pb);
                        const dA = busCost(A.len + rA.dLen + iA.dLen, A.childMin + rA.dCm + iA.dCm) - baseA;
                        const dB = busCost(Bb.len + rB.dLen + iB.dLen, Bb.childMin + rB.dCm + iB.dCm) - baseB;
                        const dS = streetOf(a) === streetOf(b) ? 0 : streetDelta(A, Bb, a) + streetDelta(Bb, A, b);
                        const delta = dA + dB + dS;
                        if (delta < -EPS && (!best || delta < best.delta)) {
                            if (!wedgeOk(A, [b], A.tour[pa]) || !wedgeOk(Bb, [a], Bb.tour[pb])) continue;
                            best = { delta, pa, pb, atA: iA.at, atB: iB.at };
                        }
                    }
                }
                if (best) {
                    // The swap was priced approximately; apply, re-price
                    // exactly, and keep it only if the fleet really gained.
                    const sA = snap(A), sB = snap(Bb), objBefore = objective();
                    const a = removeAt(A, best.pa), b = removeAt(Bb, best.pb);
                    insertAt(A, b, best.atA); insertAt(Bb, a, best.atB);
                    refresh(A); refresh(Bb);
                    if (objective() < objBefore - EPS / 2) { moves++; improved = true; }
                    else { restore(A, sA); restore(Bb, sB); }
                }
            }
            // keep the tour proxy honest after a round of edits
            for (const b of B) buildTour(b);
            if (!improved) break;
        }
        }

        // ── ruin & recreate (the jsprit / VROOM large-neighbourhood step) ──
        // Single relocate/swap moves get stuck when several atoms have to move
        // together. Remove a radial cluster of atoms (a random seed and its
        // nearest neighbours, across buses), re-insert them cheapest-first
        // under seats + containment, and keep the result only if the fleet
        // objective fell. Deterministic seed, so a re-run reproduces itself.
        function ruinAndRecreate() {
            let seed = 0x9e3779b1 ^ B.reduce((a, b) => a + b.atoms.length * 31, 0);
            const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
            let accepted = 0;
            for (let it = 0; it < o.polishLnsIters; it++) {
                if (outOfTime()) break;
                const pool = [];
                B.forEach((b, bi) => b.atoms.forEach(a => pool.push({ a, bi })));
                if (pool.length < 6) break;
                const k = Math.min(pool.length - 2, o.polishLnsRuinMin + Math.floor(rnd() * (o.polishLnsRuinMax - o.polishLnsRuinMin + 1)));
                const seedAtom = pool[Math.floor(rnd() * pool.length)].a;
                pool.sort((x, y) => haversineMi(seedAtom.lat, seedAtom.lng, x.a.lat, x.a.lng) - haversineMi(seedAtom.lat, seedAtom.lng, y.a.lat, y.a.lng));
                const removed = pool.slice(0, k);
                const snapshot = B.map(snap);
                const objBefore = objective();
                const touched = new Set();
                for (const { a, bi } of removed) {
                    const b = B[bi];
                    const idx = b.atoms.indexOf(a); if (idx < 0) continue;
                    const pos = b.tour.indexOf(idx); if (pos < 0) continue;
                    removeAt(b, pos); touched.add(b);
                }
                for (const b of touched) refresh(b);
                // farthest-from-camp first: the hardest atoms to place go while
                // there is still room next to them
                removed.sort((x, y) => haversineMi(depot.lat, depot.lng, y.a.lat, y.a.lng) - haversineMi(depot.lat, depot.lng, x.a.lat, x.a.lng));
                let ok = true;
                for (const { a } of removed) {
                    let best = null;
                    for (let bi = 0; bi < N; bi++) {
                        const Bb = B[bi];
                        if (Bb.count + cnt(a) > Bb.cap) continue;
                        if (Bb.atoms.length && reachMi(Bb, a) > o.polishReachMi) continue;
                        const ins = bestInsert(Bb, a, -1);
                        const c = ins.delta + (SPLIT && streetOf(a) && !Bb.streets.has(streetOf(a)) && (streetBuses.get(streetOf(a)) || 0) >= 1 ? SPLIT : 0);
                        if (!best || c < best.c) { if (!wedgeOk(Bb, [a], -1)) continue; best = { c, bi, at: ins.at }; }
                    }
                    if (!best) { ok = false; break; }
                    insertAt(B[best.bi], a, best.at); refresh(B[best.bi]);
                }
                if (ok) for (const b of B) buildTour(b);
                if (!ok || objective() > objBefore - EPS) {
                    B.forEach((b, i) => restore(b, snapshot[i]));
                } else { accepted++; moves++; }
            }
            return accepted;
        }

        localSearch();
        for (let round = 0; round < 4 && !stop && !outOfTime(); round++) {
            if (!ruinAndRecreate()) break;
            localSearch();
        }
        const after = objective();
        return { buckets: B.map(b => b.tour.map(i => b.atoms[i])), moves, before, after,
                 fleetBefore, fleetAfter: fleetMin(), childMinBefore, childMinAfter: childMin() };
    }

    // ---- audit --------------------------------------------------------------
    // Children whose ride is longer than maxRideRatio x their direct trip from
    // camp (+ slack). Uses the ETA pass's _rideTimeMin when present, else a
    // straight-line estimate along the current order.
    function rideRatioViolations(route, depot, isArrival, o) {
        o = opts(o);
        const out = [];
        const stops = ((route && route.stops) || []).filter(s => hasPos(s) && !isStaff(s));
        if (!stops.length) return out;
        let t = 0, prev = depot; const arr = [];
        for (const s of stops) { t += driveMin(prev, s, o) + stopDwellMin(s, o); arr.push(t); prev = s; }
        const back = isArrival ? driveMin(prev, depot, o) : 0;
        stops.forEach((s, i) => {
            const ride = Number.isFinite(s._rideTimeMin) ? s._rideTimeMin : (isArrival ? t + back - arr[i] : arr[i]);
            const direct = driveMin(depot, s, o);
            const limit = direct * o.maxRideRatio + o.rideRatioSlackMin;
            if (ride > limit) out.push({ stop: s, rideMin: Math.round(ride), directMin: Math.round(direct), limitMin: Math.round(limit) });
        });
        return out;
    }
    // Stops the bus drives past (within `nearMi` of a leg) before it serves
    // them — the "the bus went right by our house and came back twenty minutes
    // later" complaint. Dismissal: a later stop passed by an earlier leg.
    // Arrival: an earlier pickup passed by a later leg (mirror).
    function passBys(route, depot, isArrival, o, nearMi) {
        o = opts(o);
        const near = nearMi || 0.08; // ~400ft
        const stops = ((route && route.stops) || []).filter(s => hasPos(s) && !isStaff(s));
        if (stops.length < 3) return [];
        // distance from point p to segment a-b in miles (equirectangular, fine at this scale)
        const kx = 69 * Math.cos((depot.lat || stops[0].lat) * Math.PI / 180), ky = 69;
        function segDist(p, a, b) {
            const ax = a.lng * kx, ay = a.lat * ky, bx = b.lng * kx, by = b.lat * ky, px = p.lng * kx, py = p.lat * ky;
            const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
            let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
            t = Math.max(0, Math.min(1, t));
            const qx = ax + t * dx, qy = ay + t * dy;
            return Math.hypot(px - qx, py - qy);
        }
        const seq = isArrival ? stops.slice().reverse() : stops; // walk in "riding" direction
        const out = [];
        for (let k = 1; k < seq.length; k++) {
            const target = seq[k];
            let prev = depot;
            for (let i = 0; i < k; i++) {
                const cur = seq[i];
                // ignore legs that start or end at a stop within `near` of the target (adjacent stops)
                if (haversineMi(cur.lat, cur.lng, target.lat, target.lng) > near && segDist(target, prev, cur) <= near) {
                    out.push({ stop: target, passedOnLegTo: cur });
                    break;
                }
                prev = cur;
            }
        }
        return out;
    }
    function containmentReport(routes, depot, o) {
        o = opts(o);
        return (routes || []).filter(r => r && r.stops && r.stops.length).map(r => {
            const arc = arcDeg(r.stops, depot, o);
            return {
                busId: r.busId, busName: r.busName || r.busId,
                stops: r.stops.length, campers: headcount(r.stops),
                arcDeg: Math.round(arc), spreadMi: +spreadMi(r.stops).toFixed(2),
                straddle: arc > o.maxDistrictArcDeg,
            };
        });
    }

    return {
        DEFAULTS, haversineMi, driveMin, arcDeg, spreadMi, nearestStopMi, stopFitsRoute,
        localTspOrder, routeLastDropMin, orderRoutes,
        relieveLongRoutes, splitOverlongRoutes, rebalanceBusLoads, enforceCapacity,
        sweepPartition, polishDistricts, containmentReport,
        stopDwellMin, rideRatioViolations, passBys, buildRoadNet, stampLegTimes, stampRoadPath, routeObjective,
        distinctColors, assignRouteColors,
    };
})();
