// =============================================================================
// campistry_go_google.js — Google Route Optimization API Integration
// =============================================================================
//
// Uses Google's OR-Tools cloud solver to optimise ALL buses and ALL stops
// in a single request — globally optimal routes with real road geometry.
//
// API:  https://routeoptimization.googleapis.com/v1/projects/{PROJECT_ID}:optimizeTours
// Docs: https://developers.google.com/maps/documentation/route-optimization
//
// Requires (set in Setup → Advanced Settings):
//   googleMapsKey    — Google Maps Platform API key with Route Optimization enabled
//   googleProjectId  — Google Cloud Project ID
//
// Request model
//   Each stop becomes ONE shipment.
//   Dismissal: shipment has only deliveries[] — bus starts at camp, drops off.
//   Arrival:   shipment has only pickups[]    — bus picks up, ends at camp.
//   loadDemands / loadLimits enforce seat capacity.
//   populatePolylines:true → each route comes back with a road-following
//   encoded polyline that gets decoded and cached for instant map rendering
//   (no OSRM call required).
// =============================================================================

window.GoGoogleOptimizer = (function () {
    'use strict';

    const API_BASE = 'https://routeoptimization.googleapis.com/v1/projects';

    // -------------------------------------------------------------------------
    // _decodePolyline — decode a Google encoded polyline string into [[lat,lng],...]
    // Identical algorithm to campistry_go.js decodePolyline() — kept local so this
    // module is self-contained and road geometry works without any external dependency.
    // -------------------------------------------------------------------------
    function _decodePolyline(encoded) {
        const points = []; let i = 0, lat = 0, lng = 0;
        while (i < encoded.length) {
            let b, shift = 0, result = 0;
            do { b = encoded.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
            lat += (result & 1) ? ~(result >> 1) : (result >> 1);
            shift = 0; result = 0;
            do { b = encoded.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
            lng += (result & 1) ? ~(result >> 1) : (result >> 1);
            points.push([lat / 1e5, lng / 1e5]);
        }
        return points;
    }

    // -------------------------------------------------------------------------
    // isConfigured()
    // -------------------------------------------------------------------------
    function isConfigured() {
        const s = window._GoSetup?.();
        return !!(s?.googleMapsKey && s?.googleProjectId);
    }

    // -------------------------------------------------------------------------
    // optimizeTours(options)
    //
    // options = {
    //   stops         : [{lat, lng, address, campers:[{name,...}]}]
    //   vehicles      : [{busId, name, color, capacity, monitor, counselors}]
    //   campLat/Lng   : number
    //   departureTime : "HH:MM"
    //   isArrival     : bool   — true = pickup at homes, deliver to camp
    //   serviceTimeSec: number — dwell seconds per stop
    //   apiKey        : string
    //   projectId     : string
    // }
    //
    // Returns array of route objects (same format as the rest of the app)
    // or null on failure.
    // -------------------------------------------------------------------------
    async function optimizeTours(options) {
        const {
            stops, vehicles, campLat, campLng,
            departureTime, isArrival, serviceTimeSec,
            apiKey, projectId, maxRideTimeSec
        } = options;

        if (!apiKey || !projectId) {
            console.warn('[GoGoogle] Missing API key or project ID');
            return null;
        }
        if (!stops.length || !vehicles.length) return null;

        // ── Time anchors ──
        // departureTime is:
        //   Dismissal → when buses LEAVE camp (pinned vehicle start)
        //   Arrival   → when buses must ARRIVE at camp / bell time (pinned vehicle end)
        //
        // Global window:
        //   Dismissal: [departureTime … +3 h]  — all drop-offs within 3 hours of departure
        //   Arrival:   [departureTime − 3 h … departureTime] — pickups up to 3 h before bell
        const today = new Date();
        const toRFC = d => d.toISOString();
        const [depHour, depMin] = (departureTime || (isArrival ? '08:00' : '16:00')).split(':').map(Number);
        const anchorDt = new Date(today.getFullYear(), today.getMonth(), today.getDate(), depHour, depMin, 0);

        // For dismissal: global window starts at departure, ends 3 h later.
        // For arrival:   global window starts 3 h before bell, ends at bell.
        const globalStartDt = isArrival
            ? new Date(anchorDt.getTime() - 3 * 60 * 60 * 1000)
            : anchorDt;
        const globalEndDt = isArrival
            ? anchorDt
            : new Date(anchorDt.getTime() + 3 * 60 * 60 * 1000);

        // 5-minute departure window — tight enough to pin departure, loose enough to
        // avoid infeasibility if the solver needs a few seconds of slack.
        const depWindowEndDt = new Date(anchorDt.getTime() + 5 * 60 * 1000);

        // ── Build shipments — one per stop ──
        // penaltyCost: very high value forces the solver to serve every stop.
        // Without this the solver can freely skip stops (they fall back to the
        // haversine cheapest-insert, which is substantially worse routing).
        // 10,000 = prohibitively expensive to skip; solver only skips if truly
        // infeasible (e.g. capacity mathematically cannot fit the stop).
        const durationStr  = String(Math.max(30, Math.round(serviceTimeSec))) + 's';
        const campLocation = { latitude: campLat, longitude: campLng };
        const SKIP_PENALTY = 10000; // cost units — effectively "never skip"

        const shipments = stops.map((stop, idx) => {
            const visitLocation = { latitude: stop.lat, longitude: stop.lng };
            const visit = {
                arrivalLocation: visitLocation,
                duration: durationStr
                // No per-stop time windows — we want the solver free to find the
                // optimal ordering within the vehicle's global time constraints.
            };
            return {
                label:       String(idx),
                penaltyCost: SKIP_PENALTY,   // strongly penalise skipping any stop
                loadDemands: { campers: { amount: String(stop.campers.length) } },
                ...(isArrival
                    ? { pickups:    [visit] }   // arrival:   pickup at home → deliver to camp
                    : { deliveries: [visit] })   // dismissal: deliver from camp → home
            };
        });

        // ── Build vehicles ──
        // Dismissal: startLocation = camp (bus leaves camp loaded, ends at last drop-off)
        // Arrival:   endLocation   = camp (bus collects kids, delivers to camp)
        //
        // costPerHour drives time-balance: equal cost per hour means solver minimises
        // the total hours across all buses, which naturally balances load.
        // routeDurationLimit adds a soft cap so the solver prefers routes under
        // the user's maxRideTime setting (plus service time per stop per bus).
        const avgStopsPerBus = Math.ceil(stops.length / Math.max(1, vehicles.length));
        const svcTotal       = avgStopsPerBus * Math.max(0, serviceTimeSec || 0);
        const softDurLimit   = (maxRideTimeSec || 45 * 60) + svcTotal; // ride + service

        const modelVehicles = vehicles.map((v, vi) => {
            const veh = {
                label:            v.name || ('Bus ' + (vi + 1)),
                travelMode:       1,        // DRIVING
                loadLimits:       { campers: { maxLoad: String(Math.max(1, v.capacity)) } },
                costPerHour:      40,       // time-balance: minimising total hours balances buses
                costPerKilometer: 1,
                routeDurationLimit: {
                    // Soft ride-time cap: penalises routes where the last student
                    // rides longer than maxRideTime + estimated service time.
                    softMaxDuration:         String(Math.round(softDurLimit)) + 's',
                    costPerHourAfterSoftMax: '200'   // strong incentive to stay under limit
                }
            };

            if (isArrival) {
                // Arrival: bus starts anywhere (optimal first pickup), ends at camp.
                // endTimeWindows pins the latest camp arrival to the bell time.
                veh.endLocation    = campLocation;
                veh.endTimeWindows = [{ endTime: toRFC(anchorDt) }];
            } else {
                // Dismissal: bus starts at camp at departure time, ends at last drop-off.
                // startTimeWindows pins departure to the configured time (5-min slack).
                veh.startLocation    = campLocation;
                veh.startTimeWindows = [{ startTime: toRFC(anchorDt), endTime: toRFC(depWindowEndDt) }];
            }
            return veh;
        });

        // ── Request body ──
        const body = {
            timeout: '180s',  // 3-minute solve limit — handles 700+ stops / 18 buses comfortably
            model: {
                globalStartTime: toRFC(globalStartDt),
                globalEndTime:   toRFC(globalEndDt),
                shipments:       shipments,
                vehicles:        modelVehicles
            },
            considerRoadTraffic:         true,   // use live traffic for travel time estimates
            populatePolylines:           true,   // road-following geometry for map rendering
            populateTravelStepPolylines: false    // per-leg polylines not needed (whole-route is enough)
        };

        // ── API call ──
        const url = `${API_BASE}/${encodeURIComponent(projectId)}:optimizeTours?key=${encodeURIComponent(apiKey)}`;
        console.log('[GoGoogle] Sending request — ' + stops.length + ' stops, ' + vehicles.length + ' buses...');

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
            if (resp.status === 400) {
                console.error('[GoGoogle] 400 Bad Request — check request body. Details:', JSON.stringify(data?.error?.details || []));
            }
            if (resp.status === 403) {
                console.error('[GoGoogle] 403 Forbidden — verify API key has Route Optimization API enabled in your Google Cloud project');
            }
            if (resp.status === 429) {
                console.error('[GoGoogle] 429 Quota exceeded — check your Google Cloud quota');
            }
            return null;
        }

        if (!data.routes?.length) {
            console.warn('[GoGoogle] No routes returned — all shipments may be skipped');
            if (data.skippedShipments?.length) {
                console.warn('[GoGoogle] Skipped shipments:', data.skippedShipments.length,
                    data.skippedShipments.slice(0, 3).map(s => s.reasons?.[0]?.code).join(', '));
            }
            return null;
        }

        // ── Map response routes back to app route format ──
        const routes = [];

        for (const gRoute of data.routes) {
            const vi      = gRoute.vehicleIndex ?? 0;
            const vehicle = vehicles[vi];
            if (!vehicle) continue;

            // Collect relevant visits (filtered by mode) together with their raw visit
            // objects so we can compute per-leg travel times from Google timestamps.
            // Each shipment has only pickups (arrival) or only deliveries (dismissal).
            const relevantPairs = []; // [{visit, stop}]
            for (const visit of (gRoute.visits || [])) {
                if (isArrival  && visit.isPickup === false) continue;
                if (!isArrival && visit.isPickup === true)  continue;
                const stopIdx = visit.shipmentIndex ?? 0;
                const stop    = stops[stopIdx];
                if (!stop) continue;
                relevantPairs.push({ visit, stop });
            }

            if (!relevantPairs.length) continue;

            // Build ordered stop list
            const orderedStops = relevantPairs.map((rp, i) => ({
                stopNum:  i + 1,
                campers:  rp.stop.campers,
                address:  rp.stop.address,
                lat:      rp.stop.lat,
                lng:      rp.stop.lng
            }));

            // ── Extract per-leg travel times from Google visit timestamps ──
            // legTimes[i] = road seconds to reach stop i (from camp for i=0, from stop i-1 otherwise).
            // legTimes[N] = last-stop → camp return leg seconds (arrival mode only).
            // These feed directly into the ETA pipeline (trafficLegMin) so ride time
            // calculations use real road times rather than haversine estimates.
            const legTimes = [];
            const vStartMs = gRoute.vehicleStartTime ? new Date(gRoute.vehicleStartTime).getTime() : null;
            if (vStartMs !== null) {
                for (let rpi = 0; rpi < relevantPairs.length; rpi++) {
                    const visitStartMs = new Date(relevantPairs[rpi].visit.startTime).getTime();
                    if (rpi === 0) {
                        // Camp departure → first stop arrival (no service time to subtract)
                        legTimes.push(Math.max(0, Math.round((visitStartMs - vStartMs) / 1000)));
                    } else {
                        // Previous stop departure → this stop arrival
                        // Departure from previous = previous startTime + serviceTimeSec
                        const prevDepartMs = new Date(relevantPairs[rpi - 1].visit.startTime).getTime()
                            + (serviceTimeSec || 0) * 1000;
                        legTimes.push(Math.max(0, Math.round((visitStartMs - prevDepartMs) / 1000)));
                    }
                }
                // Return-to-camp leg (arrival mode: vehicle ends at camp)
                if (isArrival && gRoute.vehicleEndTime && relevantPairs.length > 0) {
                    const lastDepartMs = new Date(relevantPairs[relevantPairs.length - 1].visit.startTime).getTime()
                        + (serviceTimeSec || 0) * 1000;
                    const endMs = new Date(gRoute.vehicleEndTime).getTime();
                    legTimes.push(Math.max(0, Math.round((endMs - lastDepartMs) / 1000)));
                }
            }

            // ── Decode road geometry from Google encoded polyline ──
            // Google returns a single encoded polyline for the whole route.
            // _decodePolyline converts it to [[lat,lng],...] which campistry_go.js
            // stores in _routeGeomCache so the map draws road-following lines instantly.
            const encoded = gRoute.routePolyline?.points || null;
            const roadPts = encoded ? _decodePolyline(encoded) : null;

            routes.push({
                busId:         vehicle.busId,
                busName:       vehicle.name,
                busColor:      vehicle.color  || '#10b981',
                monitor:       vehicle.monitor    || null,
                counselors:    vehicle.counselors || [],
                stops:         orderedStops,
                camperCount:   orderedStops.reduce((s, st) => s + st.campers.length, 0),
                _cap:          vehicle.capacity,
                totalDuration: _routeDurationSec(gRoute),
                _source:       'google-route-optimization',
                _roadPts:      roadPts,                          // [lat,lng][] for map road lines
                _tspLegTimes:  legTimes.length ? legTimes : null // seconds per leg for ETA pipeline
            });
        }

        // ── Handle skipped shipments ──
        // Insert them onto the route with the most remaining capacity using
        // cheapest-insertion (minimises extra distance).
        const assignedIdx = new Set(
            (data.routes || []).flatMap(r =>
                (r.visits || []).map(v => v.shipmentIndex)
            )
        );
        const skipped = stops
            .map((s, i) => ({ stop: s, idx: i }))
            .filter(({ idx }) => !assignedIdx.has(idx));

        if (skipped.length) {
            console.warn('[GoGoogle] ' + skipped.length + ' stop(s) skipped by solver — inserting via cheapest-insert fallback');
            for (const { stop } of skipped) {
                _cheapestInsert(routes, stop, vehicles);
            }
            // Cheapest-insert changes stop order on modified routes, so per-leg
            // times from Google are now stale for those routes. Clear them so the
            // ETA pipeline falls back to haversine rather than using wrong times.
            const affectedIds = new Set(skipped.map(() => null)); // rebuilt below
            routes.forEach(r => {
                if (r._tspLegTimes && r.stops.length !== r._tspLegTimes.length) {
                    r._tspLegTimes = null;
                }
            });
        }

        console.log('[GoGoogle] Done — ' + routes.length + ' routes, ' +
            routes.reduce((s, r) => s + r.stops.length, 0) + ' stops assigned');

        return routes;
    }

    // -------------------------------------------------------------------------
    // _routeDurationSec — extract total route duration from Google response route
    // -------------------------------------------------------------------------
    function _routeDurationSec(gRoute) {
        // gRoute.metrics.travelDuration is like "3600s"
        const raw = gRoute.metrics?.travelDuration;
        if (!raw) return 0;
        return parseInt(raw) || 0;
    }

    // -------------------------------------------------------------------------
    // _cheapestInsert — fallback for stops the solver couldn't assign
    // Finds the route + position that adds the least extra driving distance.
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

    // -------------------------------------------------------------------------
    // _hav — haversine distance in miles (cheap, for insertion cost only)
    // -------------------------------------------------------------------------
    function _hav(lat1, lng1, lat2, lng2) {
        const R = 3958.8;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLng = (lng2 - lng1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2
                + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
                * Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    return { isConfigured, optimizeTours };
})();
