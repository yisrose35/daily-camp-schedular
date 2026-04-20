// =============================================================================
// campistry_go_google.js — Google Route Optimization API Integration
// =============================================================================
//
// Replaces the per-zone VROOM/GraphHopper/nearest-neighbor pipeline with
// Google's OR-Tools cloud solver, which optimizes ALL buses and ALL stops
// in a single request — finding globally optimal routes that no greedy
// per-zone approach can match.
//
// API: https://routeoptimization.googleapis.com/v1/projects/{PROJECT_ID}:optimizeTours
// Docs: https://developers.google.com/maps/documentation/route-optimization
//
// Requires:
//   - Google Maps API Key (with Route Optimization API enabled)
//   - Google Cloud Project ID
//   Both are set in Setup → Advanced Settings → Google Optimization
//
// =============================================================================

window.GoGoogleOptimizer = (function () {
    'use strict';

    const API_BASE = 'https://routeoptimization.googleapis.com/v1/projects';

    // -------------------------------------------------------------------------
    // isConfigured()
    // Returns true if both key and project ID are present in D.setup
    // -------------------------------------------------------------------------
    function isConfigured() {
        const s = window._GoSetup?.();
        return !!(s?.googleMapsKey && s?.googleProjectId);
    }

    // -------------------------------------------------------------------------
    // optimizeTours(options)
    //
    // options = {
    //   stops        : [{lat, lng, address, campers:[{name,...}]}]  — already grouped stops
    //   vehicles     : [{busId, name, color, capacity, monitor, counselors}]
    //   campLat/Lng  : number
    //   departureTime: "16:00" (HH:MM)
    //   isArrival    : bool   — true = pickup at homes, deliver to camp
    //   serviceTimeSec: number — seconds per stop
    //   apiKey       : string
    //   projectId    : string
    // }
    //
    // Returns array of route objects matching the existing format, or null on failure.
    // -------------------------------------------------------------------------
    async function optimizeTours(options) {
        const {
            stops, vehicles, campLat, campLng,
            departureTime, isArrival, serviceTimeSec,
            apiKey, projectId
        } = options;

        if (!apiKey || !projectId) {
            console.warn('[GoGoogle] Missing API key or project ID');
            return null;
        }
        if (!stops.length || !vehicles.length) return null;

        // ── Build start/end time window ──
        // Use today's date with the configured departure time
        const today = new Date();
        const [depHour, depMin] = (departureTime || (isArrival ? '07:30' : '16:00')).split(':').map(Number);
        const startDt = new Date(today.getFullYear(), today.getMonth(), today.getDate(), depHour, depMin, 0);
        const endDt   = new Date(startDt.getTime() + 5 * 60 * 60 * 1000); // +5 hours window

        const toRFC3339 = (d) => d.toISOString();

        // ── Build shipments (one per stop) ──
        const shipments = stops.map((stop, idx) => {
            const visitLocation = { latitude: stop.lat, longitude: stop.lng };
            const visitDuration = serviceTimeSec + 's';
            const camperCount   = stop.campers.length;

            const visit = {
                arrivalLocation: visitLocation,
                duration: visitDuration,
                timeWindows: []   // no hard time windows — let optimizer be free
            };

            // Dismissal = deliver campers to their homes (bus starts at camp full)
            // Arrival   = pick campers up from their homes (bus ends at camp full)
            return {
                label: String(idx),
                loadDemands: { campers: { amount: String(camperCount) } },
                ...(isArrival
                    ? { pickups:   [visit] }
                    : { deliveries:[visit] })
            };
        });

        // ── Build vehicles ──
        const campLocation = { latitude: campLat, longitude: campLng };
        const modelVehicles = vehicles.map((v, vi) => {
            const veh = {
                label:       v.name || ('Bus ' + vi),
                travelMode:  1,          // DRIVING
                loadLimits:  { campers: { maxLoad: String(Math.max(1, v.capacity)) } },
                costPerHour: 40,         // encourages balanced routes (not just shortest total)
                costPerKilometer: 1
            };
            // Dismissal: start at camp (buses leave camp loaded)
            // Arrival:   end at camp (buses return to camp)
            if (isArrival) {
                veh.endLocation = campLocation;
            } else {
                veh.startLocation = campLocation;
            }
            return veh;
        });

        // ── Assemble request body ──
        const body = {
            model: {
                globalStartTime: toRFC3339(startDt),
                globalEndTime:   toRFC3339(endDt),
                shipments:       shipments,
                vehicles:        modelVehicles
            },
            considerRoadTraffic:   true,
            populatePolylines:     false,
            populateTravelStepPolylines: false
        };

        // ── Call the API ──
        const url = `${API_BASE}/${encodeURIComponent(projectId)}:optimizeTours?key=${encodeURIComponent(apiKey)}`;
        console.log('[GoGoogle] Calling Route Optimization API —', stops.length, 'stops,', vehicles.length, 'vehicles...');

        let resp, data;
        try {
            resp = await fetch(url, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(body)
            });
            data = await resp.json();
        } catch (e) {
            console.error('[GoGoogle] Network error:', e.message);
            return null;
        }

        if (!resp.ok) {
            const msg = data?.error?.message || ('HTTP ' + resp.status);
            console.error('[GoGoogle] API error:', msg);
            // Surface quota/auth errors clearly
            if (resp.status === 403) console.error('[GoGoogle] 403 — check API key permissions and that Route Optimization API is enabled in your Google Cloud project');
            if (resp.status === 429) console.error('[GoGoogle] 429 — quota exceeded');
            return null;
        }

        if (!data.routes?.length) {
            console.warn('[GoGoogle] API returned no routes — all shipments may be unassigned');
            return null;
        }

        // ── Map response back to existing route format ──
        const routes = [];

        for (const gRoute of data.routes) {
            const vi = gRoute.vehicleIndex ?? 0;
            const vehicle = vehicles[vi];
            if (!vehicle) continue;

            // Collect ordered stops for this route
            const orderedStops = [];
            for (const visit of (gRoute.visits || [])) {
                const stopIdx = visit.shipmentIndex ?? 0;
                const stop    = stops[stopIdx];
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

            routes.push({
                busId:       vehicle.busId,
                busName:     vehicle.name,
                busColor:    vehicle.color || '#10b981',
                monitor:     vehicle.monitor   || null,
                counselors:  vehicle.counselors|| [],
                stops:       orderedStops,
                camperCount: orderedStops.reduce((s, st) => s + st.campers.length, 0),
                _cap:        vehicle.capacity,
                totalDuration: 0,
                _source:     'google-route-optimization'
            });
        }

        // Handle skipped/unassigned stops — insert via cheapest position
        const assignedStopIdxs = new Set(
            (data.routes || []).flatMap(r => (r.visits || []).map(v => v.shipmentIndex))
        );
        const unassigned = stops
            .map((s, i) => ({ stop: s, idx: i }))
            .filter(({ idx }) => !assignedStopIdxs.has(idx));

        if (unassigned.length) {
            console.warn('[GoGoogle] ' + unassigned.length + ' stops unassigned — inserting via cheapest position');
            for (const { stop } of unassigned) {
                _cheapestInsert(routes, stop, vehicles);
            }
        }

        console.log('[GoGoogle] Optimization complete —', routes.length, 'routes,',
            routes.reduce((s, r) => s + r.stops.length, 0), 'stops assigned');

        return routes;
    }

    // -------------------------------------------------------------------------
    // _cheapestInsert — fallback for unassigned stops
    // Finds the route+position that adds the least extra distance
    // -------------------------------------------------------------------------
    function _cheapestInsert(routes, stop, vehicles) {
        let bestRoute = null, bestPos = 0, bestCost = Infinity;

        for (const route of routes) {
            const v = vehicles.find(v => v.busId === route.busId);
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
            bestRoute.stops.splice(bestPos, 0, {
                stopNum:  bestPos + 1,
                campers:  stop.campers,
                address:  stop.address,
                lat:      stop.lat,
                lng:      stop.lng
            });
            bestRoute.stops.forEach((s, i) => { s.stopNum = i + 1; });
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
