// =============================================================================
// campistry_go_geoapify.js — Geoapify Route Planner API Integration
// =============================================================================
//
// Globally-optimal multi-vehicle VRP using Geoapify's Route Planner API.
//
// API:   https://api.geoapify.com/v1/routeplanner
// Docs:  https://apidocs.geoapify.com/docs/route-optimization/
//
// Auth:  API key (works directly from browser — no OAuth needed)
//
// Free-tier limits:
//   • 300 total coordinates per request (stops + buses)
//   • 300,000,000 meters estimated sum distance
//
// Large runs are handled via geographic pre-splitting:
//   Stops are sorted by bearing from camp and divided into wedge-shaped groups,
//   each under the 300-coord and 300M-meter limits.  Each group is optimized
//   independently with a proportional share of buses, then results are merged.
//
// Async flow (used when totalLocations > 200):
//   1. POST request → 202 Accepted, body contains { id, status, url }
//   2. Poll GET {url} every 2s until status === "finished"
//   3. Parse GeoJSON FeatureCollection → routes in app format
//
// Requires:  geoapifyKey in Setup → Advanced Settings
// =============================================================================

window.GoGeoapifyOptimizer = (function () {
    'use strict';

    const ENDPOINT = 'https://api.geoapify.com/v1/routeplanner';
    const POLL_MS  = 2000;   // 2s between status polls
    const MAX_WAIT = 180000; // 3 minutes max wait

    // Free-tier hard limits.  Leave headroom so we never hit the wall.
    const MAX_STOPS_PER_REQUEST = 120; // 120 stops + up to 20 buses = 140 coords, ~120M sum dist
    const MAX_COORDS_PER_REQUEST = 280; // absolute location count cap (stops + buses)

    // -------------------------------------------------------------------------
    // isConfigured() — true if API key is present
    // -------------------------------------------------------------------------
    function isConfigured() {
        return !!(window._GoSetup?.()?.geoapifyKey);
    }

    // -------------------------------------------------------------------------
    // optimizeTours(options)
    //
    // options = {
    //   stops         : [{lat, lng, address, campers:[{name,...}]}]
    //   vehicles      : [{busId, name, color, capacity, monitor, counselors}]
    //   campLat/Lng   : number
    //   isArrival     : bool   — true = pickup at homes, end at camp
    //   serviceTimeSec: number — dwell seconds per stop
    //   apiKey        : string
    // }
    //
    // Returns array of route objects (app format) or null on failure.
    // -------------------------------------------------------------------------
    async function optimizeTours(options) {
        const { stops, vehicles, campLat, campLng, isArrival, serviceTimeSec, apiKey } = options;

        if (!apiKey)             { console.warn('[Geoapify] No API key');         return null; }
        if (!stops.length)       { console.warn('[Geoapify] No stops');           return null; }
        if (!vehicles.length)    { console.warn('[Geoapify] No vehicles');        return null; }

        // ── Geographic pre-split when too many stops for free-tier limits ──
        // The free plan caps at 300 coords AND ~300M meters sum distance.
        // 281 stops / 18 buses = 299 coords and ~558M meters → always fails.
        // Solution: divide stops into wedge-shaped angular groups from camp,
        // optimize each group with a proportional share of buses, then merge.
        if (stops.length > MAX_STOPS_PER_REQUEST || stops.length + vehicles.length > MAX_COORDS_PER_REQUEST) {
            return await _splitAndOptimize(options);
        }

        return await _singleRequest(options);
    }

    // -------------------------------------------------------------------------
    // _splitAndOptimize — divide stops into geographic groups, optimize each
    // -------------------------------------------------------------------------
    async function _splitAndOptimize(options) {
        const { stops, vehicles, campLat, campLng, apiKey } = options;

        // Number of groups needed to keep each group under MAX_STOPS_PER_REQUEST
        const numGroups = Math.ceil(stops.length / MAX_STOPS_PER_REQUEST);
        console.log('[Geoapify] ' + stops.length + ' stops exceed single-request limit — ' +
            'splitting into ' + numGroups + ' geographic groups');

        // Sort stops by bearing from camp so each group is a contiguous wedge
        const sorted = stops.slice().sort(function (a, b) {
            const bA = Math.atan2(a.lng - campLng, a.lat - campLat);
            const bB = Math.atan2(b.lng - campLng, b.lat - campLat);
            return bA - bB;
        });

        // Divide stops evenly across groups
        const chunkSize = Math.ceil(sorted.length / numGroups);
        const stopGroups = [];
        for (let i = 0; i < sorted.length; i += chunkSize) {
            stopGroups.push(sorted.slice(i, i + chunkSize));
        }

        // Allocate buses proportionally by camper count in each group
        const vehicleGroups = _allocateVehicles(vehicles, stopGroups);

        // Optimize each group sequentially (API rate-limit friendly)
        const allRoutes = [];
        for (let i = 0; i < stopGroups.length; i++) {
            const gStops = stopGroups[i];
            const gVehs  = vehicleGroups[i];
            console.log('[Geoapify] Group ' + (i + 1) + '/' + numGroups +
                ': ' + gStops.length + ' stops, ' + gVehs.length + ' buses (' +
                (gStops.length + gVehs.length) + ' coords)');
            const groupRoutes = await _singleRequest(Object.assign({}, options, {
                stops:    gStops,
                vehicles: gVehs
            }));
            if (groupRoutes && groupRoutes.length) {
                allRoutes.push.apply(allRoutes, groupRoutes);
            } else {
                console.warn('[Geoapify] Group ' + (i + 1) + ' returned no routes');
            }
        }

        console.log('[Geoapify] Split-optimize complete: ' + allRoutes.length + ' total routes');
        return allRoutes.length ? allRoutes : null;
    }

    // -------------------------------------------------------------------------
    // _allocateVehicles — split vehicle array proportionally by camper count
    // -------------------------------------------------------------------------
    function _allocateVehicles(vehicles, stopGroups) {
        const groupCampers = stopGroups.map(function (g) {
            return g.reduce(function (s, st) { return s + st.campers.length; }, 0);
        });
        const totalCampers = groupCampers.reduce(function (s, n) { return s + n; }, 0);
        const result = stopGroups.map(function () { return []; });
        let vIdx = 0;

        for (let g = 0; g < stopGroups.length; g++) {
            const isLast  = g === stopGroups.length - 1;
            const frac    = totalCampers > 0 ? groupCampers[g] / totalCampers : 1 / stopGroups.length;
            const count   = isLast
                ? vehicles.length - vIdx
                : Math.max(1, Math.round(vehicles.length * frac));
            const clamped = Math.min(count, vehicles.length - vIdx - (stopGroups.length - g - 1));
            result[g] = vehicles.slice(vIdx, vIdx + Math.max(1, clamped));
            vIdx += result[g].length;
        }
        return result;
    }

    // -------------------------------------------------------------------------
    // _singleRequest — send one VRP request for a given set of stops + vehicles
    // -------------------------------------------------------------------------
    async function _singleRequest(options) {
        const { stops, vehicles, campLat, campLng, isArrival, serviceTimeSec, apiKey } = options;

        const campCoord = [campLng, campLat]; // Geoapify uses [lng, lat]

        // ── Build agents (buses) ──
        const agents = vehicles.map(function (v) {
            const cap = v.capacity || 44;
            return isArrival
                ? { pickup_capacity:   cap, end_location:   campCoord }
                : { delivery_capacity: cap, start_location: campCoord };
        });

        // ── Build jobs (stops) ──
        const jobs = stops.map(function (s) {
            const j = {
                location: [s.lng, s.lat],
                duration: Math.max(30, Math.round(serviceTimeSec))
            };
            if (isArrival) {
                j.pickup_amount   = s.campers.length;
            } else {
                j.delivery_amount = s.campers.length;
            }
            return j;
        });

        const body = { mode: 'drive', agents: agents, jobs: jobs };

        const totalLocations = stops.length + vehicles.length;
        const isAsync = totalLocations > 200;

        console.log('[Geoapify] Sending ' + stops.length + ' stops + ' + vehicles.length +
            ' buses (' + totalLocations + ' coords, ' + (isAsync ? 'async' : 'sync') + ')');

        const url = ENDPOINT + '?apiKey=' + encodeURIComponent(apiKey) +
                    (isAsync ? '&mode=async' : '');

        let submitResp, submitData;
        try {
            submitResp = await fetch(url, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(body)
            });
            submitData = await submitResp.json();
        } catch (e) {
            console.error('[Geoapify] Network error:', e.message);
            return null;
        }

        if (!submitResp.ok) {
            const msg = submitData?.message || submitData?.error || ('HTTP ' + submitResp.status);
            console.error('[Geoapify] Submit error:', msg);
            if (submitResp.status === 401) console.error('[Geoapify] 401 — check API key at https://myprojects.geoapify.com');
            if (submitResp.status === 402) console.error('[Geoapify] 402 — insufficient credits. Add credits at https://www.geoapify.com/pricing');
            if (submitResp.status === 422) console.error('[Geoapify] 422 — request too large for sync mode.');
            return null;
        }

        // ── Poll for async result or use sync result directly ──
        let result;
        if (isAsync && submitData?.id) {
            result = await _pollAsync(submitData, apiKey);
            if (!result) return null;
        } else {
            result = submitData;
        }

        if (!result?.features?.length) {
            console.warn('[Geoapify] No features in result');
            return null;
        }

        return _parseResult(result, stops, vehicles, isArrival);
    }

    // -------------------------------------------------------------------------
    // _pollAsync — poll the job status URL until finished
    // -------------------------------------------------------------------------
    async function _pollAsync(submitData, apiKey) {
        const statusUrl = submitData.url ||
            (ENDPOINT + '/' + submitData.id + '?apiKey=' + encodeURIComponent(apiKey));

        const deadline = Date.now() + MAX_WAIT;
        console.log('[Geoapify] Job submitted (id=' + submitData.id + '), polling...');

        while (Date.now() < deadline) {
            await new Promise(function (r) { setTimeout(r, POLL_MS); });

            let pollResp, pollData;
            try {
                pollResp = await fetch(statusUrl);
                pollData = await pollResp.json();
            } catch (e) {
                console.warn('[Geoapify] Poll error:', e.message);
                continue;
            }

            const status = pollData?.status || pollData?.type;
            console.log('[Geoapify] Status:', status);

            if (status === 'finished' || pollData?.features) {
                console.log('[Geoapify] Async job complete');
                return pollData;
            }
            if (status === 'failed' || status === 'error') {
                console.error('[Geoapify] Job failed:', pollData?.error || pollData?.message || 'unknown error');
                return null;
            }
        }

        console.error('[Geoapify] Timed out after ' + (MAX_WAIT / 1000) + 's');
        return null;
    }

    // -------------------------------------------------------------------------
    // _parseResult — convert Geoapify GeoJSON to app route format
    // -------------------------------------------------------------------------
    function _parseResult(geojson, stops, vehicles, isArrival) {
        const routes = [];

        const agentFeatures = (geojson.features || []).filter(function (f) {
            return f.properties?.agent_index !== undefined &&
                   Array.isArray(f.properties?.actions);
        });

        for (const feat of agentFeatures) {
            const agentIdx = feat.properties.agent_index;
            const vehicle  = vehicles[agentIdx];
            if (!vehicle) continue;

            const orderedStops = [];
            for (const action of (feat.properties.actions || [])) {
                if (action.type !== 'job' && action.type !== 'pickup' && action.type !== 'delivery') continue;
                const jobIdx = action.job_index;
                if (jobIdx === undefined || jobIdx === null) continue;
                const stop = stops[jobIdx];
                if (!stop) continue;
                orderedStops.push({
                    stopNum:  orderedStops.length + 1,
                    campers:  stop.campers,
                    address:  stop.address,
                    lat:      stop.lat,
                    lng:      stop.lng
                });
            }

            if (!orderedStops.length) continue;

            let roadPts = null;
            if (feat.geometry?.type === 'MultiLineString') {
                roadPts = feat.geometry.coordinates
                    .flat()
                    .map(function (c) { return [c[1], c[0]]; });
            } else if (feat.geometry?.type === 'LineString') {
                roadPts = feat.geometry.coordinates
                    .map(function (c) { return [c[1], c[0]]; });
            }

            routes.push({
                busId:         vehicle.busId,
                busName:       vehicle.name,
                busColor:      vehicle.color      || '#10b981',
                monitor:       vehicle.monitor    || null,
                counselors:    vehicle.counselors || [],
                stops:         orderedStops,
                camperCount:   orderedStops.reduce(function (s, st) { return s + st.campers.length; }, 0),
                _cap:          vehicle.capacity,
                totalDuration: Math.round((feat.properties.time || 0)),
                _source:       'geoapify',
                _roadPts:      roadPts
            });
        }

        // Handle unassigned jobs with cheapest-insert fallback
        const unassignedJobs = geojson.unassigned_jobs || [];
        if (unassignedJobs.length) {
            console.warn('[Geoapify] ' + unassignedJobs.length + ' unassigned stops — cheapest-insert fallback');
            for (const idx of unassignedJobs) {
                _cheapestInsert(routes, stops[idx], vehicles);
            }
        }

        console.log('[Geoapify] Parsed ' + routes.length + ' routes, ' +
            routes.reduce(function (s, r) { return s + r.stops.length; }, 0) + ' stops assigned');

        return routes.length ? routes : null;
    }

    // -------------------------------------------------------------------------
    // _cheapestInsert — fallback for unassigned stops
    // -------------------------------------------------------------------------
    function _cheapestInsert(routes, stop, vehicles) {
        if (!stop) return;
        let bestRoute = null, bestPos = 0, bestCost = Infinity;
        for (const route of routes) {
            const v = vehicles.find(function (v) { return v.busId === route.busId; });
            if (v && route.camperCount + stop.campers.length > v.capacity) continue;
            for (let i = 0; i <= route.stops.length; i++) {
                const prev = route.stops[i - 1] || null;
                const next = route.stops[i]     || null;
                const cost = (prev ? _hav(prev.lat, prev.lng, stop.lat, stop.lng) : 0)
                           + (next ? _hav(stop.lat, stop.lng, next.lat, next.lng) : 0)
                           - (prev && next ? _hav(prev.lat, prev.lng, next.lat, next.lng) : 0);
                if (cost < bestCost) { bestCost = cost; bestRoute = route; bestPos = i; }
            }
        }
        if (bestRoute) {
            bestRoute.stops.splice(bestPos, 0, { stopNum: bestPos + 1, campers: stop.campers, address: stop.address, lat: stop.lat, lng: stop.lng });
            bestRoute.stops.forEach(function (s, i) { s.stopNum = i + 1; });
            bestRoute.camperCount += stop.campers.length;
        }
    }

    function _hav(lat1, lng1, lat2, lng2) {
        const R = 3958.8, dLat = (lat2 - lat1) * Math.PI / 180, dLng = (lng2 - lng1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    // -------------------------------------------------------------------------
    // optimizeSingleBus(options)
    //
    // Single-vehicle TSP: sends one bus + its assigned stops to Geoapify to get
    // the optimal within-bus stop ordering and road-following geometry.
    //
    // options = {
    //   stops         : [{lat, lng, address, campers:[{name,...}]}]
    //   vehicle       : {busId, name, color, capacity, monitor, counselors}
    //   campLat/Lng   : number
    //   isArrival     : bool
    //   serviceTimeSec: number
    //   apiKey        : string
    // }
    //
    // Returns { orderedStops, roadPts } or null on failure.
    // orderedStops preserves the original stop objects in optimal order.
    // roadPts is [[lat,lng], ...] road-following geometry or null.
    // -------------------------------------------------------------------------
    async function optimizeSingleBus(options) {
        const { stops, vehicle, campLat, campLng, isArrival, serviceTimeSec, apiKey } = options;

        if (!apiKey)          { return null; }
        if (!vehicle)         { return null; }
        if (!stops || stops.length < 2) { return null; } // 0-1 stops need no TSP

        const campCoord = [campLng, campLat]; // Geoapify uses [lng, lat]
        const cap = vehicle.capacity || 44;

        // Single agent — one bus
        const agent = isArrival
            ? { pickup_capacity:   cap, end_location:   campCoord }
            : { delivery_capacity: cap, start_location: campCoord };

        // Build jobs preserving original index so we can map results back
        const jobs = stops.map(function (s) {
            const j = {
                location: [s.lng, s.lat],
                duration: Math.max(30, Math.round(serviceTimeSec || 60))
            };
            if (isArrival) {
                j.pickup_amount   = s.campers.length || 1;
            } else {
                j.delivery_amount = s.campers.length || 1;
            }
            return j;
        });

        const body = { mode: 'drive', agents: [agent], jobs: jobs };

        // 1 vehicle + N stops — always well under 300-coord limit, always sync
        const url = ENDPOINT + '?apiKey=' + encodeURIComponent(apiKey);

        let resp, data;
        try {
            resp = await fetch(url, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(body)
            });
            data = await resp.json();
        } catch (e) {
            console.warn('[Geoapify/TSP] Network error for bus ' + (vehicle.busId || '?') + ':', e.message);
            return null;
        }

        if (!resp.ok) {
            const msg = data?.message || data?.error || ('HTTP ' + resp.status);
            console.warn('[Geoapify/TSP] Error for bus ' + (vehicle.busId || '?') + ':', msg);
            return null;
        }

        if (!data?.features?.length) {
            console.warn('[Geoapify/TSP] No features for bus ' + (vehicle.busId || '?'));
            return null;
        }

        // ── Find the single agent feature ──
        const feat = (data.features || []).find(function (f) {
            return f.properties?.agent_index !== undefined &&
                   Array.isArray(f.properties?.actions);
        });

        if (!feat) {
            console.warn('[Geoapify/TSP] No agent feature for bus ' + (vehicle.busId || '?'));
            return null;
        }

        // ── Extract ordered stops + actual per-leg road travel times ──
        //
        // Geoapify returns action.travel_duration (seconds of actual road travel
        // to reach each stop from the previous location). We capture these so the
        // ETA / ride-time computation can use real road times instead of haversine.
        //
        // legTimes[i]  = seconds of road travel to reach stop[i]
        //   leg[0]     = depot (camp) → stop[0]
        //   leg[i>0]   = stop[i-1] → stop[i]
        // legTimes[N]  = last stop → depot (return leg, for arrival mode)
        //
        const orderedStops = [];
        const legTimes = []; // seconds, parallel to orderedStops + 1 optional return leg
        let returnLegSec = null;

        for (const action of (feat.properties.actions || [])) {
            if (action.type === 'end') {
                // Return leg: last stop → camp
                if (typeof action.travel_duration === 'number') {
                    returnLegSec = action.travel_duration;
                }
                continue;
            }
            if (action.type !== 'job' && action.type !== 'pickup' && action.type !== 'delivery') continue;
            const jobIdx = action.job_index;
            if (jobIdx === undefined || jobIdx === null) continue;
            const stop = stops[jobIdx];
            if (!stop) continue;
            orderedStops.push(stop);
            // travel_duration is seconds of road driving to reach this stop
            legTimes.push(typeof action.travel_duration === 'number' ? action.travel_duration : null);
        }

        // Append return leg as legTimes[N] so ETA code can use it for arrival mode
        if (returnLegSec !== null) legTimes.push(returnLegSec);

        if (!orderedStops.length) {
            console.warn('[Geoapify/TSP] No ordered stops returned for bus ' + (vehicle.busId || '?'));
            return null;
        }

        // ── Extract road geometry ──
        let roadPts = null;
        if (feat.geometry?.type === 'MultiLineString') {
            roadPts = feat.geometry.coordinates
                .flat()
                .map(function (c) { return [c[1], c[0]]; });
        } else if (feat.geometry?.type === 'LineString') {
            roadPts = feat.geometry.coordinates
                .map(function (c) { return [c[1], c[0]]; });
        }

        // ── Handle any unassigned jobs by appending them at the end ──
        const unassigned = data.unassigned_jobs || [];
        if (unassigned.length) {
            console.warn('[Geoapify/TSP] ' + unassigned.length + ' unassigned stops for bus ' + (vehicle.busId || '?') + ' — appending at end');
            for (const idx of unassigned) {
                if (stops[idx]) {
                    orderedStops.push(stops[idx]);
                    legTimes.splice(legTimes.length - (returnLegSec !== null ? 1 : 0), 0, null); // no leg time for appended
                }
            }
        }

        return { orderedStops, roadPts, legTimes };
    }

    return { isConfigured, optimizeTours, optimizeSingleBus };
})();
