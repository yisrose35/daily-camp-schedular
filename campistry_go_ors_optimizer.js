// =============================================================================
// campistry_go_ors_optimizer.js — OpenRouteService Vroom VRP Optimizer
// =============================================================================
//
// Solves the full multi-vehicle Vehicle Routing Problem (VRP) for Campistry Go
// bus routing using the OpenRouteService (ORS) Optimization API, which is
// backed by the open-source Vroom solver.
//
// A single API call simultaneously assigns every stop to a bus AND sequences
// each bus's stops in globally-optimal order — no two-phase heuristic needed.
//
// API endpoint:
//   POST https://api.openrouteservice.org/optimization
//
// Auth:
//   Header  →  Authorization: <api_key>   (plain key, no "Bearer" prefix)
//   Free-tier key: https://openrouteservice.org/dev/#/signup
//
// Free-tier limits (as of 2024):
//   ~500 jobs + vehicles per request
//   No polyline geometry (geometry:true costs extra credits)
//   ~40 req/min
//
// IMPORTANT — Vroom coordinate order:
//   Vroom uses [longitude, latitude] everywhere (GeoJSON order).
//   This is the OPPOSITE of the rest of the app which uses {lat, lng}.
//   Every coordinate must be reversed before sending and results need no
//   coordinate mapping (we use stop index, not coordinates, to match stops).
//
// Request format (Vroom/ORS):
//   {
//     "jobs": [
//       { "id": 1, "location": [lng, lat], "amount": [num_campers], "service": 120 }
//     ],
//     "vehicles": [
//       { "id": 1, "profile": "driving-car", "start": [lng, lat], "capacity": [44] }
//     ]
//   }
//
// Response format:
//   {
//     "code": 0,                       // 0 = success
//     "routes": [
//       {
//         "vehicle": 1,                // vehicle id (1-indexed)
//         "steps": [
//           { "type": "start" },
//           { "type": "job", "id": 3 },  // id matches jobs[].id
//           { "type": "end" }
//         ],
//         "duration": 3600             // total route seconds
//       }
//     ],
//     "unassigned": [{ "id": 2, ... }]  // jobs that couldn't fit any vehicle
//   }
//
// Data flow:
//   1. campistry_go.js calls GoOrsOptimizer.optimizeTours(options)
//   2. stops[] → jobs[] (id = stop_index + 1, location = [lng, lat], amount = [campers])
//   3. vehicles[] → vehicles[] (id = vehicle_index + 1, capacity = [effectiveCap])
//      Dismissal: vehicle start = camp (bus leaves camp, stops end at last home)
//      Arrival:   vehicle end   = camp (bus starts at first pickup, ends at camp)
//   4. If multiple buses: recursively bisect stops by geography (bearing → distance
//      alternating) until each leaf region's camper count fits its allocated buses.
//      Each leaf is sent as an independent VROOM request, then results are merged.
//   5. Parse response: step.type === 'job', step.id → stops[id - 1]
//   6. Unassigned jobs: cheapest-insertion (haversine) onto route with most slack
//   7. Return array of route objects in app format (_source: 'ors-vroom')
//
// Requires: D.setup.orsKey set in Setup → Advanced Settings,
//           OR window.__CAMPISTRY_ORS_KEY__ defined before this script loads.
// =============================================================================

window.GoOrsOptimizer = (function () {
    'use strict';

    const ENDPOINT = 'https://api.openrouteservice.org/optimization';

    // Split threshold: if total job+vehicle count exceeds this, use geographic split.
    // ORS free tier handles ~500 but we stay conservative to avoid timeouts.
    const SPLIT_THRESHOLD = 150;

    // -------------------------------------------------------------------------
    // isConfigured() — true when an ORS API key is available
    // -------------------------------------------------------------------------
    function isConfigured() {
        const setup = window._GoSetup ? window._GoSetup() : null;
        return !!(setup?.orsKey || window.__CAMPISTRY_ORS_KEY__);
    }

    // -------------------------------------------------------------------------
    // optimizeTours(options)
    //
    // options = {
    //   stops         : [{lat, lng, address, campers:[{name,...}]}]
    //   vehicles      : [{busId, name, color, capacity, monitor, counselors:[]}]
    //   campLat       : number
    //   campLng       : number
    //   isArrival     : bool   — true = pickup at homes and deliver to camp
    //   serviceTimeSec: number — dwell time per stop in seconds (default 120)
    //   apiKey        : string — ORS API key (caller may supply directly)
    // }
    //
    // Returns array of route objects (app format) or null on any failure.
    // -------------------------------------------------------------------------
    async function optimizeTours(options) {
        const { stops, vehicles, campLat, campLng, isArrival, serviceTimeSec, apiKey } = options;

        const key = apiKey
            || (window._GoSetup ? window._GoSetup()?.orsKey : null)
            || window.__CAMPISTRY_ORS_KEY__
            || null;

        if (!key)             { console.warn('[OrsVroom] No API key — set D.setup.orsKey or window.__CAMPISTRY_ORS_KEY__'); return null; }
        if (!stops || !stops.length)    { console.warn('[OrsVroom] No stops provided');    return null; }
        if (!vehicles || !vehicles.length) { console.warn('[OrsVroom] No vehicles provided'); return null; }
        if (campLat == null || campLng == null) { console.warn('[OrsVroom] Camp coordinates missing'); return null; }

        // Recursively bisect the region by geography so each bus is pre-assigned
        // to a coherent sub-region before VROOM routes it.  Falls back to a
        // single VROOM call when only one bus is available or the region is small.
        if (vehicles.length > 1) {
            return await _recursiveSplit(options, key, 0);
        }

        return await _singleRequest(options, key);
    }

    // -------------------------------------------------------------------------
    // _splitAndOptimize — divide stops into two geographic halves and optimize
    // each half independently with a proportional share of buses.
    //
    // Stops are sorted by compass bearing from camp so each half is a contiguous
    // geographic wedge (north/south or east/west), which keeps intra-group
    // distances short and avoids cross-assignments.
    // -------------------------------------------------------------------------
    async function _splitAndOptimize(options, key) {
        const { stops, vehicles, campLat, campLng } = options;

        console.log('[OrsVroom] ' + stops.length + ' stops + ' + vehicles.length +
            ' vehicles (' + (stops.length + vehicles.length) + ' total) exceeds threshold ' +
            SPLIT_THRESHOLD + ' — splitting into 2 geographic halves');

        // Sort stops by bearing angle from camp so groups are angular wedges
        const sorted = stops.slice().sort(function (a, b) {
            const bA = Math.atan2(a.lng - campLng, a.lat - campLat);
            const bB = Math.atan2(b.lng - campLng, b.lat - campLat);
            return bA - bB;
        });

        const half = Math.ceil(sorted.length / 2);
        const stopGroups = [sorted.slice(0, half), sorted.slice(half)];

        // Allocate vehicles proportionally by camper count in each half
        const vehicleGroups = _allocateVehicles(vehicles, stopGroups);

        console.log('[OrsVroom] Half 1: ' + stopGroups[0].length + ' stops, ' +
            vehicleGroups[0].length + ' buses');
        console.log('[OrsVroom] Half 2: ' + stopGroups[1].length + ' stops, ' +
            vehicleGroups[1].length + ' buses');

        const allRoutes = [];
        for (let i = 0; i < 2; i++) {
            if (!stopGroups[i].length || !vehicleGroups[i].length) {
                console.warn('[OrsVroom] Half ' + (i + 1) + ' is empty — skipping');
                continue;
            }
            const groupRoutes = await _singleRequest(
                Object.assign({}, options, {
                    stops:    stopGroups[i],
                    vehicles: vehicleGroups[i]
                }),
                key
            );
            if (groupRoutes && groupRoutes.length) {
                allRoutes.push.apply(allRoutes, groupRoutes);
            } else {
                console.warn('[OrsVroom] Half ' + (i + 1) + ' returned no routes');
            }
        }

        console.log('[OrsVroom] Split-optimize complete: ' + allRoutes.length + ' total routes');
        return allRoutes.length ? allRoutes : null;
    }

    // -------------------------------------------------------------------------
    // _recursiveSplit — capacity-driven recursive geographic bisection
    //
    // Recursively splits stops into geographic sub-regions until each leaf
    // region's total camper count fits within the buses assigned to it.
    // Each leaf is sent to VROOM independently, guaranteeing every bus stays
    // in its own contiguous geographic zone.
    //
    // Alternates split axis each level (KD-tree style):
    //   Even depth → angular wedges by compass bearing from camp
    //   Odd depth  → inner/outer rings by distance from camp
    // -------------------------------------------------------------------------
    // -------------------------------------------------------------------------
     // _buildAtoms — merge close-by stops into indivisible neighborhood atoms.
     // Any two stops within NEIGHBORHOOD_EPS_MI of each other (single-link chain)
     // belong to the same atom, so splits never tear a dense block apart.
     // Returns an array of { stops:[...], kids:N, lat, lng } grouped objects.
     // -------------------------------------------------------------------------
    function _buildAtoms(stops) {
        var NEIGHBORHOOD_EPS_MI = 0.08; // ~420 ft — single block radius
        var n = stops.length;
        var parent = new Array(n);
        for (var i = 0; i < n; i++) parent[i] = i;
        function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
        function union(a, b) { var ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
        for (var i = 0; i < n; i++) {
            for (var j = i + 1; j < n; j++) {
                if (_hav(stops[i].lat, stops[i].lng, stops[j].lat, stops[j].lng) <= NEIGHBORHOOD_EPS_MI) {
                    union(i, j);
                }
            }
        }
        var groups = {};
        for (var i = 0; i < n; i++) {
            var r = find(i);
            (groups[r] = groups[r] || []).push(stops[i]);
        }
        return Object.values(groups).map(function (grp) {
            var kids = grp.reduce(function (s, st) { return s + st.campers.length; }, 0);
            var lat = grp.reduce(function (s, st) { return s + st.lat; }, 0) / grp.length;
            var lng = grp.reduce(function (s, st) { return s + st.lng; }, 0) / grp.length;
            return { stops: grp, kids: kids, lat: lat, lng: lng };
        });
    }

    // -------------------------------------------------------------------------
     // _principalAxis — 2×2 lat/lng covariance eigen-analysis, returns the unit
     // vector along the direction of maximum spread. Projecting onto this axis
     // gives the shape-aware 1-D coordinate used for balanced bisection.
     // -------------------------------------------------------------------------
    function _principalAxis(atoms) {
        var mLat = 0, mLng = 0, total = 0;
        atoms.forEach(function (a) { mLat += a.lat * a.kids; mLng += a.lng * a.kids; total += a.kids; });
        if (total <= 0) return { ax: 1, ay: 0, mLat: 0, mLng: 0 };
        mLat /= total; mLng /= total;
        var sxx = 0, syy = 0, sxy = 0;
        atoms.forEach(function (a) {
            var dx = a.lng - mLng, dy = a.lat - mLat, w = a.kids;
            sxx += w * dx * dx; syy += w * dy * dy; sxy += w * dx * dy;
        });
        // Eigenvector of max eigenvalue of [[sxx,sxy],[sxy,syy]]
        var tr = sxx + syy, det = sxx * syy - sxy * sxy;
        var lam = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - det));
        var ax, ay;
        if (Math.abs(sxy) > 1e-12) { ax = lam - syy; ay = sxy; }
        else if (sxx >= syy)       { ax = 1;        ay = 0;   }
        else                        { ax = 0;        ay = 1;   }
        var mag = Math.sqrt(ax * ax + ay * ay) || 1;
        return { ax: ax / mag, ay: ay / mag, mLat: mLat, mLng: mLng };
    }

    async function _recursiveSplit(options, key, depth) {
        var stops    = options.stops;
        var vehicles = options.vehicles;
        var prefix   = '[OrsVroom][d=' + depth + '] ';

        var totalKids = stops.reduce(function (s, st) { return s + st.campers.length; }, 0);
        var totalCap  = vehicles.reduce(function (s, v) {
            var reserved = (v.monitor ? 1 : 0) + ((v.counselors && v.counselors.length) ? v.counselors.length : 0);
            return s + Math.max(1, (v.capacity || 44) - reserved);
        }, 0);

        // Base case: fits in assigned capacity, single bus, or below API threshold
        if (vehicles.length <= 1 || totalKids <= totalCap ||
                stops.length <= 1 || stops.length + vehicles.length <= SPLIT_THRESHOLD) {
            console.log(prefix + 'Leaf → ' + stops.length + ' stops, ' +
                totalKids + ' kids, ' + vehicles.length + ' bus(es)');
            return await _singleRequest(options, key);
        }

        // Build neighborhood atoms so tightly-clustered stops never split across
        // buses regardless of which axis we pick.
        var atoms = _buildAtoms(stops);

        // Project atom centroids onto the principal axis of the camper-weighted
        // point cloud. The split is taken perpendicular to the direction of
        // maximum spread, producing compact halves that follow the actual shape
        // of the service area (unlike bearing-from-camp wedges).
        var pa = _principalAxis(atoms);
        atoms.forEach(function (a) {
            a._proj = (a.lng - pa.mLng) * pa.ax + (a.lat - pa.mLat) * pa.ay;
        });
        atoms.sort(function (a, b) { return a._proj - b._proj; });

        console.log(prefix + stops.length + ' stops (' + atoms.length + ' atoms) / ' +
            totalKids + ' kids / ' + vehicles.length + ' buses — bisecting along principal axis');

        // Balanced split on atoms by camper count
        var half = totalKids / 2, cum = 0, splitIdx = Math.ceil(atoms.length / 2);
        for (var i = 0; i < atoms.length; i++) {
            cum += atoms[i].kids;
            if (cum >= half) { splitIdx = i + 1; break; }
        }
        // Guarantee both sides non-empty
        if (splitIdx <= 0) splitIdx = 1;
        if (splitIdx >= atoms.length) splitIdx = atoms.length - 1;

        function flatten(atomSlice) {
            var out = [];
            atomSlice.forEach(function (a) { out.push.apply(out, a.stops); });
            return out;
        }
        var stopGroups    = [flatten(atoms.slice(0, splitIdx)), flatten(atoms.slice(splitIdx))];
        var vehicleGroups = _allocateVehicles(vehicles, stopGroups);

        var allRoutes = [];
        for (var g = 0; g < 2; g++) {
            if (!stopGroups[g].length || !vehicleGroups[g].length) continue;
            var groupRoutes = await _recursiveSplit(
                Object.assign({}, options, { stops: stopGroups[g], vehicles: vehicleGroups[g] }),
                key,
                depth + 1
            );
            if (groupRoutes && groupRoutes.length) {
                allRoutes.push.apply(allRoutes, groupRoutes);
            }
        }
        return allRoutes.length ? allRoutes : null;
    }

    // -------------------------------------------------------------------------
    // _allocateVehicles — distribute vehicle array across stop groups
    // proportionally by camper count, ensuring every group gets at least 1 bus.
    // -------------------------------------------------------------------------
    function _allocateVehicles(vehicles, stopGroups) {
        const groupCampers = stopGroups.map(function (g) {
            return g.reduce(function (sum, st) { return sum + st.campers.length; }, 0);
        });
        const totalCampers = groupCampers.reduce(function (sum, n) { return sum + n; }, 0);
        const result = stopGroups.map(function () { return []; });
        let vIdx = 0;

        for (let g = 0; g < stopGroups.length; g++) {
            const isLast = g === stopGroups.length - 1;
            const frac   = totalCampers > 0
                ? groupCampers[g] / totalCampers
                : 1 / stopGroups.length;
            // Remaining groups after this one need at least 1 bus each
            const remaining = stopGroups.length - g - 1;
            const raw   = isLast
                ? vehicles.length - vIdx
                : Math.max(1, Math.round(vehicles.length * frac));
            const count = Math.max(1, Math.min(raw, vehicles.length - vIdx - remaining));
            result[g]   = vehicles.slice(vIdx, vIdx + count);
            vIdx       += result[g].length;
        }
        return result;
    }

    // -------------------------------------------------------------------------
    // _singleRequest — build and send one ORS optimization request
    // -------------------------------------------------------------------------
    async function _singleRequest(options, key) {
        const { stops, vehicles, campLat, campLng, isArrival, serviceTimeSec, departureTime, maxRideTimeSec } = options;

        const svcSec   = Math.round(serviceTimeSec || 120);
        const campCoord = [campLng, campLat]; // Vroom: [lng, lat] !

        // Parse "HH:MM" → seconds from midnight. Used below to impose a vehicle
        // time_window so Vroom pegs arrivals to bell time (arrival) or departures
        // from camp to bell time (dismissal), mirroring Transfinder behavior.
        var bellSec = null;
        if (typeof departureTime === 'string' && /^\d{1,2}:\d{2}$/.test(departureTime)) {
            var parts = departureTime.split(':');
            bellSec = (parseInt(parts[0], 10) * 3600) + (parseInt(parts[1], 10) * 60);
        }
        var rideSec = Math.max(60, (maxRideTimeSec || 45 * 60) | 0);

        // ── Build jobs array — one per stop, 1-indexed ──
        // amount: [N] is a 1-dimensional capacity vector (seats needed).
        // service: dwell time in seconds Vroom adds to the stop visit.
        // priority (0-100): higher = more preferred by Vroom when it must drop jobs.
        //   Grandfathered stops get a boost so they stick to last year's pattern.
        // skills:  used for hard bus pins. A stop whose campers are all forced onto
        //   one bus gets a unique skill; only that vehicle declares that skill.
        const jobs = stops.map(function (stop, idx) {
            var job = {
                id:       idx + 1,
                location: [stop.lng, stop.lat],
                amount:   [stop.campers.length],
                service:  svcSec
            };
            if (typeof stop._priority === 'number') {
                job.priority = Math.max(0, Math.min(100, stop._priority | 0));
            }
            if (stop._forcedBusIdx != null) {
                // Skill id 1000+idx encodes the forced vehicle index
                job.skills = [1000 + (stop._forcedBusIdx | 0)];
            }
            return job;
        });

        // ── Build vehicles array — one per bus, 1-indexed ──
        // effectiveCap: subtract reserved seat for monitor (if present) and each counselor.
        // Dismissal: start = camp (bus leaves camp, no fixed end → Vroom ends at last job)
        // Arrival:   end   = camp (bus has no fixed start → Vroom starts at first job)
        const vroomVehicles = vehicles.map(function (v, idx) {
            const reservedSeats = (v.monitor ? 1 : 0) + ((v.counselors && v.counselors.length) ? v.counselors.length : 0);
            const effectiveCap  = Math.max(1, (v.capacity || 44) - reservedSeats);

            const veh = {
                id:       idx + 1,            // 1-indexed
                // HGV = heavy-goods-vehicle. Closest ORS profile to a school bus:
                // respects truck turn restrictions, avoids low bridges and roads
                // posted against heavy vehicles, and applies lower free-flow speeds.
                profile:  'driving-hgv',
                capacity: [effectiveCap],     // must match jobs[].amount dimensionality
                skills:   [1000 + idx]        // identity skill — supports hard "pin to bus" via job.skills
            };

            if (isArrival) {
                // Arrival mode: bus starts at first pickup (no fixed start),
                // ends at camp after collecting all campers.
                veh.end = campCoord;
            } else {
                // Dismissal mode: bus starts at camp (loaded with campers),
                // ends at last drop-off (no fixed end).
                veh.start = campCoord;
            }

            // Vehicle time_window pegs the shift to bell time.
            //   Arrival:   must land at camp by bell → window = [bell - rideSec, bell]
            //   Dismissal: must leave camp at bell    → window = [bell, bell + rideSec]
            // Vroom also enforces this as a per-job upper bound via route completion.
            if (bellSec != null) {
                veh.time_window = isArrival
                    ? [Math.max(0, bellSec - rideSec), bellSec]
                    : [bellSec, bellSec + rideSec];
            }

            return veh;
        });

        const body = { jobs: jobs, vehicles: vroomVehicles };

        console.log('[OrsVroom] Sending ' + stops.length + ' stops + ' + vehicles.length +
            ' buses to ORS Vroom (isArrival=' + !!isArrival + ', svcSec=' + svcSec + ')');

        let resp, data;
        try {
            resp = await fetch(ENDPOINT, {
                method:  'POST',
                headers: {
                    'Content-Type':  'application/json',
                    'Authorization': key        // ORS uses plain key, no "Bearer" prefix
                },
                body: JSON.stringify(body)
            });
            data = await resp.json();
        } catch (e) {
            console.error('[OrsVroom] Network error:', e.message);
            return null;
        }

        if (!resp.ok) {
            const msg = data?.message || data?.error || ('HTTP ' + resp.status);
            console.error('[OrsVroom] API error (' + resp.status + '):', msg);
            if (resp.status === 403) {
                console.error('[OrsVroom] 403 Forbidden — verify your ORS API key at https://openrouteservice.org/dev/#/home');
            }
            if (resp.status === 429) {
                console.error('[OrsVroom] 429 Too Many Requests — ORS free tier is ~40 req/min');
            }
            if (resp.status === 400) {
                console.error('[OrsVroom] 400 Bad Request — check jobs/vehicles structure. Full response:', JSON.stringify(data));
            }
            return null;
        }

        // ORS returns code:0 for success, non-zero on solver error
        if (data.code !== 0) {
            const errMsg = data.error || data.message || ('code ' + data.code);
            console.error('[OrsVroom] Solver error:', errMsg);
            return null;
        }

        if (!data.routes || !data.routes.length) {
            console.warn('[OrsVroom] Response OK but no routes returned');
            return null;
        }

        return _parseResponse(data, stops, vehicles, isArrival);
    }

    // -------------------------------------------------------------------------
    // _parseResponse — convert ORS/Vroom response to app route format
    //
    // Vroom routes reference jobs by 1-indexed id.  We map step.id → stops[id-1].
    // For arrival mode Vroom already routes pickup → camp correctly (end=camp),
    // so we do NOT reverse the stop order.
    // For dismissal mode the order is camp → stops, which is also correct as-is.
    // -------------------------------------------------------------------------
    function _parseResponse(data, stops, vehicles, isArrival) {
        const routes = [];

        for (var ri = 0; ri < data.routes.length; ri++) {
            var route   = data.routes[ri];
            // Vroom vehicle ids are 1-indexed; map back to vehicles array
            var vehId   = route.vehicle;                   // 1-indexed
            var vehicle = vehicles[vehId - 1];
            if (!vehicle) {
                console.warn('[OrsVroom] Route references unknown vehicle id ' + vehId);
                continue;
            }

            // Filter steps to job-type only (skip 'start' and 'end' depot steps)
            var jobSteps = (route.steps || []).filter(function (step) {
                return step.type === 'job';
            });

            if (!jobSteps.length) {
                console.warn('[OrsVroom] Vehicle ' + vehId + ' (' + vehicle.name + ') has no job steps — skipping');
                continue;
            }

            // Map each step back to the original stop using 1-indexed id
            var orderedStops = [];
            for (var si = 0; si < jobSteps.length; si++) {
                var step    = jobSteps[si];
                var stopIdx = step.id - 1;    // convert 1-indexed → 0-indexed
                var stop    = stops[stopIdx];
                if (!stop) {
                    console.warn('[OrsVroom] Step references unknown job id ' + step.id + ' — skipping step');
                    continue;
                }
                orderedStops.push({
                    stopNum: orderedStops.length + 1,
                    campers: stop.campers,
                    address: stop.address,
                    lat:     stop.lat,
                    lng:     stop.lng
                });
            }

            if (!orderedStops.length) continue;

            var camperCount = orderedStops.reduce(function (sum, st) {
                return sum + st.campers.length;
            }, 0);

            routes.push({
                busId:         vehicle.busId,
                busName:       vehicle.name,
                busColor:      vehicle.color      || '#10b981',
                monitor:       vehicle.monitor    || null,
                counselors:    vehicle.counselors || [],
                stops:         orderedStops,
                camperCount:   camperCount,
                _cap:          vehicle.capacity,
                totalDuration: route.duration || 0,  // seconds, from Vroom response
                _source:       'ors-vroom'
            });
        }

        // ── Handle unassigned jobs ──
        // Vroom reports jobs it couldn't fit into any vehicle.
        // Use haversine cheapest-insertion to place them on the route with the
        // most remaining capacity, minimising extra driving distance added.
        var unassigned = data.unassigned || [];
        if (unassigned.length) {
            console.warn('[OrsVroom] ' + unassigned.length + ' unassigned stop(s) — cheapest-insert fallback');
            for (var ui = 0; ui < unassigned.length; ui++) {
                var jobId    = unassigned[ui].id;
                var stopIdx  = jobId - 1;
                var stop     = stops[stopIdx];
                if (stop) {
                    _cheapestInsert(routes, stop, vehicles);
                } else {
                    console.warn('[OrsVroom] Unassigned job id ' + jobId + ' has no matching stop');
                }
            }
        }

        console.log('[OrsVroom] Parsed ' + routes.length + ' routes, ' +
            routes.reduce(function (s, r) { return s + r.stops.length; }, 0) + ' stops total');

        return routes.length ? routes : null;
    }

    // -------------------------------------------------------------------------
    // _cheapestInsert — fallback for unassigned stops
    //
    // Scans every route and every insertion position to find the spot that adds
    // the least extra driving distance (haversine triangle inequality).
    // Only considers routes where the vehicle has remaining seat capacity.
    // -------------------------------------------------------------------------
    function _cheapestInsert(routes, stop, vehicles) {
        if (!stop) return;

        var bestRoute = null;
        var bestPos   = 0;
        var bestCost  = Infinity;

        for (var ri = 0; ri < routes.length; ri++) {
            var route = routes[ri];
            var v     = null;
            for (var vi = 0; vi < vehicles.length; vi++) {
                if (vehicles[vi].busId === route.busId) { v = vehicles[vi]; break; }
            }
            // Skip routes that are already at capacity
            if (v && route.camperCount + stop.campers.length > v.capacity) continue;

            for (var i = 0; i <= route.stops.length; i++) {
                var prev = route.stops[i - 1] || null;
                var next = route.stops[i]     || null;
                // Extra distance = (prev→new) + (new→next) − (prev→next) [triangle inequality]
                var cost = (prev ? _hav(prev.lat, prev.lng, stop.lat, stop.lng) : 0)
                         + (next ? _hav(stop.lat, stop.lng, next.lat, next.lng) : 0)
                         - (prev && next ? _hav(prev.lat, prev.lng, next.lat, next.lng) : 0);
                if (cost < bestCost) {
                    bestCost  = cost;
                    bestRoute = route;
                    bestPos   = i;
                }
            }
        }

        if (bestRoute) {
            bestRoute.stops.splice(bestPos, 0, {
                stopNum:  bestPos + 1,
                campers:  stop.campers,
                address:  stop.address,
                lat:      stop.lat,
                lng:      stop.lng
            });
            // Re-number all stops after insertion
            bestRoute.stops.forEach(function (s, i) { s.stopNum = i + 1; });
            bestRoute.camperCount += stop.campers.length;
        } else {
            console.warn('[OrsVroom] cheapestInsert: no route has capacity for stop at ' + stop.address);
        }
    }

    // -------------------------------------------------------------------------
    // _hav — haversine distance in miles (used only for insertion cost ranking)
    // -------------------------------------------------------------------------
    function _hav(lat1, lng1, lat2, lng2) {
        var R    = 3958.8;
        var dLat = (lat2 - lat1) * Math.PI / 180;
        var dLng = (lng2 - lng1) * Math.PI / 180;
        var a    = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
                 * Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    // ── Public API ────────────────────────────────────────────────────────────
    return { isConfigured: isConfigured, optimizeTours: optimizeTours };

})();
