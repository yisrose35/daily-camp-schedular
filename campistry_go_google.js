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
            apiKey, projectId
        } = options;

        if (!apiKey || !projectId) {
            console.warn('[GoGoogle] Missing API key or project ID');
            return null;
        }
        if (!stops.length || !vehicles.length) return null;

        // ── Global time window ──
        // Use today's date with the configured departure time.
        // 5-hour planning horizon is generous for any camp route.
        const today = new Date();
        const [depHour, depMin] = (departureTime || (isArrival ? '07:30' : '16:00')).split(':').map(Number);
        const startDt = new Date(today.getFullYear(), today.getMonth(), today.getDate(), depHour, depMin, 0);
        const endDt   = new Date(startDt.getTime() + 5 * 60 * 60 * 1000);
        const toRFC    = d => d.toISOString();

        // ── Build shipments — one per stop ──
        // Dismissal → deliveries (bus starts loaded at camp, drops kids at home)
        // Arrival   → pickups   (bus collects kids from home, ends at camp)
        const durationStr = String(Math.max(30, Math.round(serviceTimeSec))) + 's';
        const campLocation = { latitude: campLat, longitude: campLng };

        const shipments = stops.map((stop, idx) => {
            const visitLocation = { latitude: stop.lat, longitude: stop.lng };
            const visit = {
                arrivalLocation: visitLocation,
                duration: durationStr
                // no timeWindows — let the solver be free to find optimal order
            };
            return {
                label: String(idx),
                loadDemands: { campers: { amount: String(stop.campers.length) } },
                ...(isArrival
                    ? { pickups:    [visit] }   // arrival:   pickup at home
                    : { deliveries: [visit] })   // dismissal: delivery to home
            };
        });

        // ── Build vehicles ──
        // Dismissal: startLocation = camp (bus leaves camp loaded)
        //            no endLocation (bus ends at last drop-off — doesn't return)
        // Arrival:   endLocation = camp (bus delivers everyone to camp)
        //            no startLocation (solver picks optimal first pickup)
        const modelVehicles = vehicles.map((v, vi) => {
            const veh = {
                label:       v.name || ('Bus ' + (vi + 1)),
                travelMode:  1,     // DRIVING
                loadLimits:  { campers: { maxLoad: String(Math.max(1, v.capacity)) } },
                costPerHour: 40,    // encourages balanced routes
                costPerKilometer: 1
            };
            if (isArrival) {
                veh.endLocation = campLocation;
            } else {
                veh.startLocation = campLocation;
            }
            return veh;
        });

        // ── Request body ──
        const body = {
            timeout: '120s',  // 2-minute solve limit — plenty for 700 stops / 18 buses
            model: {
                globalStartTime: toRFC(startDt),
                globalEndTime:   toRFC(endDt),
                shipments:       shipments,
                vehicles:        modelVehicles
            },
            considerRoadTraffic:         true,
            populatePolylines:           true,   // road-following route geometry
            populateTravelStepPolylines: false    // per-leg detail not needed
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

            // Build ordered stop list from visits[]
            // Each visit has shipmentIndex pointing back to our stops[] array.
            // Filter to only the relevant visit type:
            //   arrival  → isPickup = true
            //   dismissal → isPickup = false (or undefined for delivery-only shipments)
            const orderedStops = [];
            for (const visit of (gRoute.visits || [])) {
                // Each shipment has either only pickups (arrival) or only deliveries (dismissal).
                // The API sets isPickup: true for pickup visits, false/absent for deliveries.
                // Skip any visit that's explicitly the wrong type for our current mode.
                if (isArrival  && visit.isPickup === false) continue; // delivery visit in arrival mode
                if (!isArrival && visit.isPickup === true)  continue; // pickup visit in dismissal mode

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
                busId:            vehicle.busId,
                busName:          vehicle.name,
                busColor:         vehicle.color  || '#10b981',
                monitor:          vehicle.monitor    || null,
                counselors:       vehicle.counselors || [],
                stops:            orderedStops,
                camperCount:      orderedStops.reduce((s, st) => s + st.campers.length, 0),
                _cap:             vehicle.capacity,
                totalDuration:    _routeDurationSec(gRoute),
                _source:          'google-route-optimization',
                // Encoded polyline from Google — decoded by campistry_go.js
                // and stored in _routeGeomCache so map draws road-following lines immediately.
                _encodedPolyline: gRoute.routePolyline?.points || null
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
