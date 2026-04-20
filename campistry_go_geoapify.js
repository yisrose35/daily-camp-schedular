// =============================================================================
// campistry_go_geoapify.js — Geoapify Route Planner API Integration
// =============================================================================
//
// Globally-optimal multi-vehicle VRP using Geoapify's Route Planner API.
// Handles all buses + all stops in ONE request — far better than any
// per-zone greedy approach.
//
// API:   https://api.geoapify.com/v1/routeplanner
// Docs:  https://apidocs.geoapify.com/docs/route-optimization/
//
// Auth:  API key (works directly from browser — no OAuth needed)
// Limit: async mode supports up to 1,000 locations per request
// Cost:  ~2,990 credits for a 580-stop / 18-bus run (≈ free tier limit of 3,000/day)
//
// Async flow:
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

        const campCoord = [campLng, campLat]; // Geoapify uses [lng, lat]

        // ── Build agents (buses) ──
        // Dismissal: start at camp, no fixed end (ends at last delivery)
        // Arrival:   no fixed start (optimizer picks first pickup), end at camp
        const agents = vehicles.map(function (v) {
            const a = {
                delivery_capacity: v.capacity || 44,
                pickup_capacity:   v.capacity || 44
            };
            if (isArrival) {
                a.end_location = campCoord;
            } else {
                a.start_location = campCoord;
            }
            return a;
        });

        // ── Build jobs (stops) ──
        // Each stop is one job with service time and passenger demand.
        // Geoapify uses "delivery_amount" for drops-offs and "pickup_amount" for pick-ups.
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

        const body = {
            mode:   'drive',
            agents: agents,
            jobs:   jobs
        };

        const totalLocations = stops.length + vehicles.length;
        const isAsync = totalLocations > 250; // use async mode when close to sync limit

        console.log('[Geoapify] ' + stops.length + ' stops, ' + vehicles.length + ' buses, ' +
            totalLocations + ' locations — ' + (isAsync ? 'async' : 'sync') + ' mode');

        // ── Submit request ──
        const url = ENDPOINT + '?apikey=' + encodeURIComponent(apiKey) +
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
            if (submitResp.status === 422) console.error('[Geoapify] 422 — request too large for sync mode. Try again (async will be used).');
            return null;
        }

        // ── Poll for async result (or use sync result directly) ──
        let result;
        if (isAsync && submitData?.id) {
            result = await _pollAsync(submitData, apiKey);
            if (!result) return null;
        } else {
            // Sync response — result is in the response body directly
            result = submitData;
        }

        if (!result?.features?.length) {
            console.warn('[Geoapify] No features in result');
            return null;
        }

        // ── Parse GeoJSON result → app route format ──
        return _parseResult(result, stops, vehicles, isArrival);
    }

    // -------------------------------------------------------------------------
    // _pollAsync — poll the job status URL until finished
    // -------------------------------------------------------------------------
    async function _pollAsync(submitData, apiKey) {
        // submitData may have a "url" or we can poll via /v1/routeplanner/{id}
        const statusUrl = submitData.url ||
            (ENDPOINT + '/' + submitData.id + '?apikey=' + encodeURIComponent(apiKey));

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
            // status === 'running' or 'pending' — keep polling
        }

        console.error('[Geoapify] Timed out after ' + (MAX_WAIT / 1000) + 's');
        return null;
    }

    // -------------------------------------------------------------------------
    // _parseResult — convert Geoapify GeoJSON to app route format
    // -------------------------------------------------------------------------
    function _parseResult(geojson, stops, vehicles, isArrival) {
        const routes = [];

        // Each Feature in the collection is one agent's (bus's) complete route.
        // Multiple features may exist per agent (one for the route geometry +
        // others for waypoints). We only need the ones with `actions`.
        const agentFeatures = (geojson.features || []).filter(function (f) {
            return f.properties?.agent_index !== undefined &&
                   Array.isArray(f.properties?.actions);
        });

        for (const feat of agentFeatures) {
            const agentIdx = feat.properties.agent_index;
            const vehicle  = vehicles[agentIdx];
            if (!vehicle) continue;

            // Extract ordered job indices from actions array
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

            // Extract road-following polyline from MultiLineString geometry
            // Geoapify returns [lng,lat] → convert to [lat,lng] for Leaflet
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
                busId:            vehicle.busId,
                busName:          vehicle.name,
                busColor:         vehicle.color     || '#10b981',
                monitor:          vehicle.monitor   || null,
                counselors:       vehicle.counselors|| [],
                stops:            orderedStops,
                camperCount:      orderedStops.reduce(function (s, st) { return s + st.campers.length; }, 0),
                _cap:             vehicle.capacity,
                totalDuration:    Math.round((feat.properties.time || 0)),
                _source:          'geoapify',
                _roadPts:         roadPts   // road-following [lat,lng] array for map cache
            });
        }

        // Handle unassigned jobs
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

    return { isConfigured, optimizeTours };
})();
