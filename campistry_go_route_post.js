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
        avgStopMin: 2,
        roadFactor: 1.35,
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
        sweepBusOverheadMin: 5,    // cost of using a bus at all
        sweepGroupCutMin: 6,       // cost of splitting one group (neighbourhood) between two buses
        sweepMaxRideMin: 60,       // soft riding budget per bus (0 = off)
        // District polish (relocate / swap atoms between buses)
        polishMaxPasses: 12,
        polishTimeBudgetMs: 1500,
        polishRideBudgetMin: 60,   // soft riding budget per bus (0 = off)
        polishMinGainMin: 0.05,
        polishReachMi: 5.0,        // only consider a bus whose nearest atom is within this of the moving atom
        polishReachOverBudgetX: 2.5, // ...unless the source bus is over its ride budget: reach this much further
        // Stop ordering
        tspUnfairWeight: 2,        // weight on minutes a child rides beyond their allowance
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
    function driveMin(a, b, o) {
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

        const stopMin = o.avgStopMin;
        const M = new Array(n), C = new Array(n), cnt = new Array(n), allow = new Array(n);
        for (let i = 0; i < n; i++) {
            M[i] = new Float64Array(n);
            C[i] = driveMin(depot, movable[i], o);
            cnt[i] = riders(movable[i]) || 1;
            allow[i] = C[i] * 2 + 25;
        }
        for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const d = driveMin(movable[i], movable[j], o); M[i][j] = d; M[j][i] = d; }

        const arr = new Float64Array(n);
        // cost of the tour given by pos -> stop index function
        function costOf(at) {
            let time = 0, tour = 0, prev = -1;
            for (let p = 0; p < n; p++) {
                const idx = at(p);
                const leg = prev < 0 ? C[idx] : M[prev][idx];
                time += leg + stopMin; tour += leg; arr[p] = time; prev = idx;
            }
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
                for (let i = 0; i < n - 1 && !improved; i++) {
                    for (let j = i + 1; j < n && !improved; j++) {
                        const c = costOf(p => (p < i || p > j) ? t[p] : t[j - (p - i)]);
                        if (c < best - 1e-9) {
                            for (let x = i, y = j; x < y; x++, y--) { const tmp = t[x]; t[x] = t[y]; t[y] = tmp; }
                            best = c; improved = true;
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
                        let bestPos = -1, bestC = base - 1e-9, bestRev = false;
                        for (let j = 0; j <= rest.length; j++) {
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
        for (const s of seeds) {
            let t = distTwoOpt(nearestFrom(s));
            let prev = Infinity;
            for (let round = 0; round < 4; round++) {
                t = orOpt(twoOpt(t));
                const c = costOf(identity(t));
                if (c >= prev - 1e-6) break;
                prev = c;
            }
            const c = costOf(identity(t));
            if (c < bestCost - 1e-9) { bestCost = c; best = t.slice(); }
        }
        if (!best) return all.slice();
        return best.map(i => movable[i]).concat(tail);
    }

    function routeLastDropMin(route, depot, o) {
        o = opts(o);
        let t = 0, prev = depot;
        for (const s of ((route && route.stops) || [])) {
            if (!hasPos(s) || isStaff(s)) continue;
            t += driveMin(prev, s, o) + o.avgStopMin;
            prev = s;
        }
        return t;
    }
    function renumber(route) { (route.stops || []).forEach((s, i) => { s.stopNum = i + 1; }); route.camperCount = headcount(route.stops); }
    function reorder(route, depot, isArrival, o) {
        if (!route || !route.stops) return;
        if (route.stops.filter(s => hasPos(s) && !s.isMonitor).length >= 2) {
            route.stops = localTspOrder(route.stops, depot, isArrival, o);
        }
        renumber(route);
        delete route._tspLegTimes; delete route._roadPts; delete route._encodedPolyline;
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
        const PER_STOP = o.sweepRidersPerStop, OVERHEAD = o.sweepBusOverheadMin, CUT = o.sweepGroupCutMin;
        const dist = ring.map(a => haversineMi(depot.lat, depot.lng, a.lat, a.lng));

        function arcCost(agg, cutInsideGroup) {
            const stops = Math.max(1, Math.round(agg.count / PER_STOP));
            const diag = haversineMi(agg.mnLa, agg.mnLo, agg.mxLa, agg.mxLo);
            const miles = agg.far + 0.5 * Math.sqrt(stops) * diag;
            const ride = (miles * o.roadFactor / Math.max(1, o.avgSpeedMph)) * 60 + stops * o.avgStopMin;
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
        const speed = Math.max(1, o.avgSpeedMph), stopMin = o.avgStopMin, budget = o.polishRideBudgetMin;
        const leg = (a, b) => (haversineMi(a.lat, a.lng, b.lat, b.lng) * o.roadFactor / speed) * 60;
        // Riders per atom: an explicit count, else the campers list, else one.
        const cnt = x => Number.isFinite(x.count) ? x.count : (riders(x) || 1);
        const B = (buckets || []).map((atoms, i) => ({
            atoms: atoms.slice(), cap: Number.isFinite(caps && caps[i]) ? caps[i] : Infinity,
            count: atoms.reduce((a, x) => a + cnt(x), 0), tour: [], len: 0, wedge: 0,
        }));
        const N = B.length;
        if (N < 2 || !depot) return { buckets: buckets.slice(), moves: 0, before: 0, after: 0 };

        function tourLen(atoms, tour) {
            let t = 0, prev = depot;
            for (const i of tour) { t += leg(prev, atoms[i]) + stopMin; prev = atoms[i]; }
            return t;
        }
        function buildTour(b) {
            const n = b.atoms.length;
            if (!n) { b.tour = []; b.len = 0; b.wedge = 0; return; }
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
                        const y = b.atoms[t[j]], d = j + 1 < n ? b.atoms[t[j + 1]] : null;
                        const before = leg(a, x) + (d ? leg(y, d) : 0);
                        const after = leg(a, y) + (d ? leg(x, d) : 0);
                        if (after < before - 1e-9) {
                            for (let p = i, q = j; p < q; p++, q--) { const tmp = t[p]; t[p] = t[q]; t[q] = tmp; }
                            improved = true; break;
                        }
                    }
                }
            }
            b.tour = t; b.len = tourLen(b.atoms, t); b.wedge = arcDeg(b.atoms, depot, o);
        }
        const busCost = len => len + (budget > 0 ? 2 * Math.max(0, len - budget) : 0);
        const objective = () => B.reduce((a, b) => a + busCost(b.len), 0);
        // Saving from removing tour position `pos` from bus b.
        function removalSaving(b, pos) {
            const t = b.tour, cur = b.atoms[t[pos]];
            const prev = pos > 0 ? b.atoms[t[pos - 1]] : depot;
            if (pos + 1 < t.length) { const next = b.atoms[t[pos + 1]]; return leg(prev, cur) + leg(cur, next) - leg(prev, next) + stopMin; }
            return leg(prev, cur) + stopMin;
        }
        // Cheapest insertion of `atom` into bus b's tour, optionally treating
        // position `excludePos` as already removed. Returns { cost, at } where
        // `at` is the position in the tour WITHOUT the excluded stop.
        function cheapestInsert(b, atom, excludePos) {
            const t = b.tour;
            let best = Infinity, at = 0, j = 0, prev = depot;
            for (let i = 0; i <= t.length; i++) {
                if (i === excludePos) continue;
                const next = i < t.length ? b.atoms[t[i]] : null;
                const c = next ? leg(prev, atom) + leg(atom, next) - leg(prev, next) : leg(prev, atom);
                if (c < best) { best = c; at = j; }
                if (!next) break;
                prev = next; j++;
            }
            return { cost: best + stopMin, at };
        }
        // Nearest distance (mi) from an atom to any atom of bus b — cheap
        // pruning so we never price a move onto a bus that is nowhere near.
        function reachMi(b, atom) {
            let d = Infinity;
            for (const x of b.atoms) { const m = haversineMi(atom.lat, atom.lng, x.lat, x.lng); if (m < d) d = m; }
            return d;
        }
        const outOfTime = () => Date.now() - t0 > o.polishTimeBudgetMs;
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
            return atom;
        }
        function insertAt(b, atom, at) {
            b.atoms.push(atom);
            b.tour.splice(at, 0, b.atoms.length - 1);
            b.count += cnt(atom);
        }
        function refresh(b) { b.len = tourLen(b.atoms, b.tour); b.wedge = arcDeg(b.atoms, depot, o); }

        for (const b of B) buildTour(b);
        const before = objective();
        let moves = 0;
        const EPS = o.polishMinGainMin;

        let stop = false;
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
                    const saving = removalSaving(A, pos);
                    const lenA2 = A.len - saving;
                    let best = null;
                    for (let bi = 0; bi < N; bi++) {
                        if (bi === ai) continue;
                        const Bb = B[bi];
                        if (Bb.count + cnt(atom) > Bb.cap) continue;
                        if (Bb.atoms.length && reachMi(Bb, atom) > reach) continue;
                        const ins = cheapestInsert(Bb, atom, -1);
                        const lenB2 = Bb.len + ins.cost;
                        const delta = busCost(lenA2) + busCost(lenB2) - busCost(A.len) - busCost(Bb.len);
                        if (delta < -EPS && (!best || delta < best.delta)) {
                            if (!wedgeOk(Bb, [atom], -1)) continue;
                            best = { delta, bi, at: ins.at };
                        }
                    }
                    if (best) {
                        const moved = removeAt(A, pos);
                        insertAt(B[best.bi], moved, best.at);
                        refresh(A); refresh(B[best.bi]);
                        moves++; improved = true;
                        pos--; // re-examine this position (a new atom sits there now)
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
                for (let pa = 0; pa < A.tour.length; pa++) {
                    if (!aNear[pa]) continue;
                    const a = A.atoms[A.tour[pa]];
                    const sA = removalSaving(A, pa);
                    for (let pb = 0; pb < Bb.tour.length; pb++) {
                        if (!bNear[pb]) continue;
                        const b = Bb.atoms[Bb.tour[pb]];
                        if (A.count - cnt(a) + cnt(b) > A.cap) continue;
                        if (Bb.count - cnt(b) + cnt(a) > Bb.cap) continue;
                        const sB = removalSaving(Bb, pb);
                        const iA = cheapestInsert(A, b, pa), iB = cheapestInsert(Bb, a, pb);
                        const lenA2 = A.len - sA + iA.cost, lenB2 = Bb.len - sB + iB.cost;
                        const delta = busCost(lenA2) + busCost(lenB2) - busCost(A.len) - busCost(Bb.len);
                        if (delta < -EPS && (!best || delta < best.delta)) {
                            if (!wedgeOk(A, [b], A.tour[pa]) || !wedgeOk(Bb, [a], Bb.tour[pb])) continue;
                            best = { delta, pa, pb, atA: iA.at, atB: iB.at };
                        }
                    }
                }
                if (best) {
                    const a = removeAt(A, best.pa), b = removeAt(Bb, best.pb);
                    insertAt(A, b, best.atA); insertAt(Bb, a, best.atB);
                    refresh(A); refresh(Bb);
                    moves++; improved = true;
                }
            }
            // keep the tour proxy honest after a round of edits
            for (const b of B) buildTour(b);
            if (!improved) break;
        }
        const after = objective();
        return { buckets: B.map(b => b.tour.map(i => b.atoms[i])), moves, before, after };
    }

    // ---- audit --------------------------------------------------------------
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
    };
})();
