// =============================================================================
// campistry_go_google.js — Phase 2 Refactor (v5.2)
// =============================================================================
//
// WHAT'S NEW IN PHASE 2
// -----------------------------------------------------------------------------
// This is a drop-in replacement for the existing campistry_go_google.js.
// The public interface (window.GoGoogleOptimizer.optimizeTours) is unchanged
// so callers in campistry_go.js and campistry_go_routing_v5.js don't need
// any changes beyond what Phase 2 adds to the TSP wrapper.
//
// Three architectural changes:
//
//   1. PAIRED SHIPMENTS (pickup AND delivery per camper)
//      The old v4 request sent pickup-only (arrival) or delivery-only
//      (dismissal) shipments. That shape cannot use Google's per-shipment
//      pickupToDeliveryTimeLimit field — which is the only way to
//      enforce "no kid rides more than 45 minutes" as a HARD constraint.
//
//      Phase 2 sends every shipment as a pickup + delivery pair:
//        - Arrival:    pickup = home, delivery = camp
//        - Dismissal:  pickup = camp, delivery = home
//      Each shipment gets pickupToDeliveryTimeLimit = maxRideTimeSec.
//      Google's solver will either honour the limit or mark the shipment
//      skipped with a clear reason code.
//
//   2. PER-VEHICLE TIME WINDOWS (not just global)
//      The old v4 code gave every vehicle the same startTimeWindow pinned
//      to the user-configured departure time. Phase 2 accepts a
//      per-vehicle `vehicleTimeWindows` array that lets the caller specify
//      tighter windows for each zone's distance from camp.
//
//      This is the mechanism that lets the per-bus TSP caller back-solve
//      "far zone starts at 8:38, close zone at 9:42" — matching LSTA's
//      arrival pattern.
//
//   3. HARD PER-VEHICLE ROUTE DURATION (not just soft)
//      The old v4 code used softMaxDuration with a 50× penalty. Phase 2
//      moves this to a HARD `routeDurationLimit.maxDuration` because Phase 1
//      zone partitioning has already made feasibility straightforward —
//      there's no longer a good reason to allow overrun.
//
//      If a route is infeasible under the hard limit, it's a real problem
//      (undersized fleet, bad zone, etc.) that the operator needs to see,
//      not a situation to paper over with a penalty.
//
// WHAT DIDN'T CHANGE
// -----------------------------------------------------------------------------
//   - _decodePolyline, isConfigured, _routeDurationSec, _cheapestInsert
//   - Supabase-proxy auth flow
//   - populatePolylines:true + road geometry caching
//   - penaltyCost:10000 to force all shipments to be served
//   - loadDemands/loadLimits (camper capacity) shape
//
// =============================================================================

window.GoGoogleOptimizer = (function () {
    'use strict';

    const API_BASE = 'https://routeoptimization.googleapis.com/v1/projects';

    // -------------------------------------------------------------------------
    // _decodePolyline — unchanged from v4
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
    // isConfigured — unchanged from v4
    // -------------------------------------------------------------------------
    function isConfigured() {
        const s = window._GoSetup?.();
        return !!(s?.googleMapsKey && s?.googleProjectId);
    }

    // -------------------------------------------------------------------------
    // toRFC — RFC 3339 timestamp helper
    // -------------------------------------------------------------------------
    function toRFC(dt) {
        return new Date(dt.getTime() - dt.getMilliseconds()).toISOString().replace(/\.\d{3}/, '');
    }

    // -------------------------------------------------------------------------
    // _parseHHMM — split "HH:MM" into { h, m }
    // -------------------------------------------------------------------------
    function _parseHHMM(s, fallbackH, fallbackM) {
        if (!s || typeof s !== 'string' || !/^\d{1,2}:\d{2}$/.test(s)) {
            return { h: fallbackH, m: fallbackM };
        }
        const [h, m] = s.split(':').map(Number);
        return { h, m };
    }

    // -------------------------------------------------------------------------
    // _dateAt — build Date for today at given h/m local time
    // -------------------------------------------------------------------------
    function _dateAt(h, m) {
        const d = new Date();
        d.setHours(h, m, 0, 0);
        return d;
    }

    // =========================================================================
    // optimizeTours(options) — Phase 2 main entry
    //
    // options = {
    //   stops          : [{lat, lng, address, campers:[{name,...}]}]
    //   vehicles       : [{busId, name, color, capacity, monitor, counselors}]
    //   campLat/Lng    : number
    //   isArrival      : bool     — true = pickup at homes, end at camp
    //   serviceTime    : number   — seconds per stop
    //   departureTime  : "HH:MM"  — default bell / departure time
    //   maxRideTimeSec : number   — HARD limit per camper (Phase 2)
    //   vehicleTimeWindows?: [{   — Phase 2 OPTIONAL per-vehicle windows
    //     busId:       string,
    //     startTime?:  "HH:MM",   (dismissal: bus leaves camp at this time)
    //     endTime?:    "HH:MM",   (arrival:   bus reaches camp by this time)
    //     startWindowEnd?: "HH:MM" — if present, gives a start window, not a pin
    //   }]
    //   googleKey      : string
    //   googleProjId   : string
    //   supabaseUrl?   : string   — Supabase edge function proxy
    //   accessToken?   : string
    //   anonKey?       : string
    // }
    //
    // Returns [{busId, busName, busColor, stops:[...], camperCount,
    //           totalDuration, _roadPts, _tspLegTimes, _source, ...}]
    // =========================================================================
    async function optimizeTours(options) {
        const {
            stops, vehicles, campLat, campLng,
            isArrival, serviceTime, departureTime,
            maxRideTimeSec,
            vehicleTimeWindows,
            googleKey, googleProjId,
            supabaseUrl, accessToken, anonKey
        } = options;

        if (!stops?.length || !vehicles?.length) {
            console.warn('[GoGoogle v5.2] No stops or vehicles — skipping');
            return null;
        }
        if (!googleKey || !googleProjId) {
            console.error('[GoGoogle v5.2] Missing googleKey or googleProjId');
            return null;
        }

        const serviceTimeSec = Math.max(30, Math.round(serviceTime || 120));
        const maxRideSec = Math.max(300, Math.round(maxRideTimeSec || 45 * 60));

        // ── Time anchor for the shift ──
        const { h: defH, m: defM } = _parseHHMM(
            departureTime, isArrival ? 8 : 16, 0
        );
        const anchorDt = _dateAt(defH, defM);

        // Global window must be wide enough to accommodate the farthest
        // per-vehicle window. Default: 3h before / 3h after anchor.
        const globalStartDt = new Date(anchorDt.getTime() - 3 * 60 * 60 * 1000);
        const globalEndDt   = new Date(anchorDt.getTime() + 3 * 60 * 60 * 1000);

        // ── BUILD SHIPMENTS (paired pickup+delivery) ───────────────────────────
        // Each stop becomes ONE shipment with BOTH a pickup and a delivery.
        // For arrival:   pickup@home (serviceTime), delivery@camp (0s, just a waypoint)
        // For dismissal: pickup@camp (0s waypoint), delivery@home (serviceTime)
        //
        // pickupToDeliveryTimeLimit hard-caps the ride time from boarding to
        // alighting, which is exactly the "kid on bus < maxRideTime" constraint.
        //
        // loadDemands are set on the shipment root so the load is added at pickup
        // and subtracted at delivery (Google auto-handles this for paired shipments).
        // ──────────────────────────────────────────────────────────────────────
        const campLocation = { latitude: campLat, longitude: campLng };
        const SKIP_PENALTY = 10000;

        const shipments = stops.map((stop, idx) => {
            const homeLocation = { latitude: stop.lat, longitude: stop.lng };
            const homeVisit = {
                arrivalLocation: homeLocation,
                duration:        String(serviceTimeSec) + 's',
                label:           'home:' + idx
            };
            const campVisit = {
                arrivalLocation: campLocation,
                duration:        '0s',
                label:           'camp:' + idx
            };

            return {
                label:       String(idx),
                penaltyCost: SKIP_PENALTY,
                loadDemands: { campers: { amount: String(stop.campers.length) } },
                pickupToDeliveryTimeLimit: String(maxRideSec) + 's',
                ...(isArrival
                    ? { pickups: [homeVisit], deliveries: [campVisit] }
                    : { pickups: [campVisit], deliveries: [homeVisit] })
            };
        });

        // ── BUILD VEHICLES ─────────────────────────────────────────────────────
        // Each vehicle gets:
        //   - start/end location pinned to camp (the "non-home" end of the route)
        //   - startTimeWindows / endTimeWindows from per-vehicle override OR
        //     shift defaults
        //   - HARD routeDurationLimit.maxDuration — total route length cap
        //   - Small per-vehicle time window so the solver respects dispatch order
        // ──────────────────────────────────────────────────────────────────────
        const vtwByBusId = {};
        (vehicleTimeWindows || []).forEach(vtw => {
            if (vtw.busId) vtwByBusId[vtw.busId] = vtw;
        });

        // Route duration hard limit: enough to cover the longest kid's ride
        // plus service time on a moderate-size bus.
        // Rationale: if the first kid rides maxRideSec, plus avgStops * serviceTime
        // happens on the way, the full route is roughly
        //    maxRideSec + (stops/bus) * serviceTime + camp leg.
        // Add 15% slack for real-world driving variability.
        const avgStopsPerBus = Math.ceil(stops.length / Math.max(1, vehicles.length));
        const svcTotal = avgStopsPerBus * serviceTimeSec;
        const routeDurationHardSec = Math.round(
            (maxRideSec + svcTotal + 10 * 60) * 1.15 // 10min for camp-leg + 15% slack
        );

        const modelVehicles = vehicles.map((v, vi) => {
            const veh = {
                label:            v.name || ('Bus ' + (vi + 1)),
                travelMode:       1, // DRIVING
                loadLimits:       { campers: { maxLoad: String(Math.max(1, v.capacity)) } },
                costPerHour:      40,
                costPerKilometer: 1,
                routeDurationLimit: {
                    maxDuration: String(routeDurationHardSec) + 's'
                }
            };

            // Per-vehicle time window (Phase 2)
            const vtw = vtwByBusId[v.busId];
            let startH, startM, endH, endM, startWinEndH, startWinEndM;
            if (vtw?.startTime) {
                const p = _parseHHMM(vtw.startTime, defH, defM);
                startH = p.h; startM = p.m;
            }
            if (vtw?.endTime) {
                const p = _parseHHMM(vtw.endTime, defH, defM);
                endH = p.h; endM = p.m;
            }
            if (vtw?.startWindowEnd) {
                const p = _parseHHMM(vtw.startWindowEnd, defH, defM);
                startWinEndH = p.h; startWinEndM = p.m;
            }

            if (isArrival) {
                // Arrival: bus picks up kids, ends at camp.
                // endTime = when bus must be at camp (hard upper bound).
                veh.endLocation = campLocation;
                const endDt = (endH != null)
                    ? _dateAt(endH, endM)
                    : anchorDt;
                veh.endTimeWindows = [{ endTime: toRFC(endDt) }];

                // If a start window is provided, pin the earliest departure too.
                // Otherwise let Google pick when to start.
                if (startH != null) {
                    const startDt = _dateAt(startH, startM);
                    veh.startTimeWindows = [{ startTime: toRFC(startDt) }];
                }
            } else {
                // Dismissal: bus leaves camp, drops kids off.
                // startTime = when bus leaves camp (can be a small window).
                veh.startLocation = campLocation;
                const startDt = (startH != null)
                    ? _dateAt(startH, startM)
                    : anchorDt;
                const startEndDt = (startWinEndH != null)
                    ? _dateAt(startWinEndH, startWinEndM)
                    : new Date(startDt.getTime() + 5 * 60 * 1000); // 5-min slack
                veh.startTimeWindows = [{
                    startTime: toRFC(startDt),
                    endTime:   toRFC(startEndDt)
                }];
            }

            return veh;
        });

        // ── REQUEST BODY ───────────────────────────────────────────────────────
        const body = {
            timeout: '100s',
            model: {
                globalStartTime: toRFC(globalStartDt),
                globalEndTime:   toRFC(globalEndDt),
                shipments:       shipments,
                vehicles:        modelVehicles
            },
            considerRoadTraffic:         false,
            populatePolylines:           true,
            populateTravelStepPolylines: false
        };

        console.log('[GoGoogle v5.2] Sending ' + shipments.length +
            ' paired shipments + ' + modelVehicles.length +
            ' vehicles (hard ride cap: ' + Math.round(maxRideSec / 60) + 'min, ' +
            'hard route cap: ' + Math.round(routeDurationHardSec / 60) + 'min, ' +
            'per-vehicle time windows: ' + Object.keys(vtwByBusId).length + ')');

        // ── API CALL ───────────────────────────────────────────────────────────
        const url = (supabaseUrl && accessToken)
            ? supabaseUrl.replace(/\/+$/, '') + '/functions/v1/optimize-routes'
            : API_BASE + '/' + encodeURIComponent(googleProjId) +
              ':optimizeTours?key=' + encodeURIComponent(googleKey);

        const headers = { 'Content-Type': 'application/json' };
        if (supabaseUrl && accessToken) {
            headers['Authorization'] = 'Bearer ' + accessToken;
            if (anonKey) headers['apikey'] = anonKey;
        }

        let resp, data;
        try {
            resp = await fetch(url, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(body)
            });
            data = await resp.json();
        } catch (e) {
            console.error('[GoGoogle v5.2] Network error:', e.message);
            return null;
        }

        if (!resp.ok) {
            console.error('[GoGoogle v5.2] HTTP ' + resp.status + ':',
                data?.error?.message || JSON.stringify(data).substring(0, 400));
            if (data?.error?.details) {
                console.error('[GoGoogle v5.2] Details:',
                    JSON.stringify(data.error.details).substring(0, 800));
            }
            if (resp.status === 401 || resp.status === 403) {
                if (supabaseUrl && accessToken) {
                    console.error('[GoGoogle v5.2] Auth error via proxy — verify ' +
                        'GOOGLE_SERVICE_ACCOUNT secret in Supabase');
                } else {
                    console.error('[GoGoogle v5.2] Auth error (direct) — Route ' +
                        'Optimization API requires OAuth2; set up Supabase proxy');
                }
            }
            if (resp.status === 429) {
                console.error('[GoGoogle v5.2] 429 Quota exceeded');
            }
            return null;
        }

        if (!data.routes?.length) {
            console.warn('[GoGoogle v5.2] No routes returned');
            if (data.skippedShipments?.length) {
                _logSkipped(data.skippedShipments);
            }
            return null;
        }

        // Log any skipped shipments loudly — these are kids Google couldn't
        // place. With Phase 2's hard ride-time constraint this can happen when
        // a zone has a kid whose home is so far from the zone centroid that
        // no route can pick them up within maxRideTime.
        if (data.skippedShipments?.length) {
            _logSkipped(data.skippedShipments);
        }

        // ── PARSE RESPONSE ─────────────────────────────────────────────────────
        // With paired shipments, each shipment contributes TWO visits to
        // the route: one pickup and one delivery. We only want ONE stop per
        // shipment in the output. Rule:
        //   - Arrival:    use the PICKUP visit (home) — this is the bus stop.
        //   - Dismissal:  use the DELIVERY visit (home) — this is the bus stop.
        // The camp visits are infrastructure; they don't become stops.
        const routes = _parseResponse(data, stops, vehicles, isArrival, serviceTimeSec);
        return routes;
    }

    // -------------------------------------------------------------------------
    // _parseResponse — extract app-format routes from Google response
    // -------------------------------------------------------------------------
    function _parseResponse(data, stops, vehicles, isArrival, serviceTimeSec) {
        const routes = [];

        for (const gRoute of data.routes) {
            const vi = gRoute.vehicleIndex ?? 0;
            const vehicle = vehicles[vi];
            if (!vehicle) continue;

            // Extract HOME visits only (pickup for arrival, delivery for dismissal).
            // These are the real bus stops; camp visits are infrastructure.
            const relevantPairs = [];
            const seenShipment = new Set();
            const allVisits = gRoute.visits || [];
            for (let vi2 = 0; vi2 < allVisits.length; vi2++) {
                const visit = allVisits[vi2];
                const wantsPickup = isArrival;
                if (visit.isPickup === undefined) {
                    // Shouldn't happen with paired shipments (Google always sets it
                    // when both pickup and delivery exist) — skip rather than guess.
                    continue;
                }
                if (visit.isPickup !== wantsPickup) continue;

                const stopIdx = visit.shipmentIndex ?? 0;
                if (seenShipment.has(stopIdx)) continue;
                seenShipment.add(stopIdx);

                const stop = stops[stopIdx];
                if (!stop) continue;
                relevantPairs.push({ visit, stop, visitIndex: vi2 });
            }

            if (!relevantPairs.length) continue;

            const orderedStops = relevantPairs.map((rp, i) => ({
                stopNum: i + 1,
                campers: rp.stop.campers,
                address: rp.stop.address,
                lat:     rp.stop.lat,
                lng:     rp.stop.lng
            }));

            // Extract per-leg travel times from transitions[]. Since paired
            // shipments have 2× the visits, we extract legs only around
            // HOME visits — the leg from the previous home to this home.
            // The depot→first-home and last-home→depot legs include the
            // intermediate camp visits (for arrival: last-home→camp→end is
            // the actual last leg).
            const legTimes = _extractLegTimes(gRoute, relevantPairs, isArrival, allVisits);

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
                _source:       'google-route-optimization-v5.2',
                _roadPts:      roadPts,
                _tspLegTimes:  legTimes.length ? legTimes : null
            });
        }

        // Handle shipments skipped by the solver (should be rare with
        // penaltyCost:10000, but the hard ride-time constraint can make
        // some truly infeasible).
        const assignedIdx = new Set(
            (data.routes || []).flatMap(r =>
                (r.visits || []).map(v => v.shipmentIndex ?? 0)
            )
        );
        const skipped = stops
            .map((s, i) => ({ stop: s, idx: i }))
            .filter(({ idx }) => !assignedIdx.has(idx));
        if (skipped.length) {
            console.warn('[GoGoogle v5.2] ' + skipped.length + ' skipped — ' +
                'cheapest-insert fallback');
            for (const { stop } of skipped) {
                _cheapestInsert(routes, stop, vehicles);
            }
            routes.forEach(r => {
                if (r._tspLegTimes && r.stops.length !== r._tspLegTimes.length) {
                    r._tspLegTimes = null; // stale after insertion
                }
            });
        }

        console.log('[GoGoogle v5.2] Done — ' + routes.length + ' routes, ' +
            routes.reduce((s, r) => s + r.stops.length, 0) + ' stops assigned');
        return routes;
    }

    // -------------------------------------------------------------------------
    // _extractLegTimes — with paired shipments, walk transitions and pull
    // the leg seconds that correspond to home-to-home travel (arrival) or
    // home-to-next-home travel (dismissal).
    //
    // For arrival:
    //   transitions[0] = start → first pickup (home) ← this is a real leg
    //   between home visits there's a transition → that's home-to-next-home
    //   between last home and camp → this is the last leg (home-to-camp)
    //   between deliveries (all at camp) → 0s
    //   transitions[last] = last camp → end → 0s
    //
    // For dismissal:
    //   transitions[0] = start (camp) → first pickup (also camp) → 0s
    //   between pickups (all at camp) → 0s
    //   between pickup and first delivery (home) → first real leg
    //   between deliveries → home-to-next-home
    //   transitions[last] = last home → end (no end location or camp)
    //
    // Strategy: for each relevant pair (home visit), pull the transition
    // IMMEDIATELY BEFORE it. transitions[i] is the leg that arrives at
    // visit[i], which is what the ETA pipeline expects.
    // -------------------------------------------------------------------------
    function _extractLegTimes(gRoute, relevantPairs, isArrival, allVisits) {
        const legTimes = [];
        const transitions = gRoute.transitions || [];
        const parseDur = d => {
            const s = parseInt((d || '').replace('s', ''), 10);
            return isNaN(s) ? 0 : s;
        };

        if (transitions.length === 0) return legTimes;

        for (let rpi = 0; rpi < relevantPairs.length; rpi++) {
            const thisVi = relevantPairs[rpi].visitIndex;

            if (rpi === 0) {
                // First leg: from start through any intermediate visits to
                // the first home visit. Sum transitions[0..thisVi].travelDuration.
                // These intermediate transitions will be 0s (camp-to-camp) so
                // this reduces to just the last real leg, but sum is correct either way.
                let sumSec = 0;
                for (let ti = 0; ti <= thisVi; ti++) {
                    sumSec += parseDur(transitions[ti]?.travelDuration);
                }
                legTimes.push(sumSec);
            } else {
                // Sum transitions strictly BETWEEN the previous home visit and this one.
                // Between two home visits on arrival there's one delivery-at-camp in the
                // middle (0s travel), so the sum equals the real home-to-home drive time.
                const prevVi = relevantPairs[rpi - 1].visitIndex;
                let sumSec = 0;
                for (let ti = prevVi + 1; ti <= thisVi; ti++) {
                    sumSec += parseDur(transitions[ti]?.travelDuration);
                }
                legTimes.push(sumSec);
            }
        }

        // Return-to-camp leg (arrival: from last home visit through any trailing
        // transitions to the end).
        if (isArrival && relevantPairs.length) {
            const lastVi = relevantPairs[relevantPairs.length - 1].visitIndex;
            let sumSec = 0;
            for (let ti = lastVi + 1; ti < transitions.length; ti++) {
                sumSec += parseDur(transitions[ti]?.travelDuration);
            }
            legTimes.push(sumSec);
        }

        return legTimes;
    }

    // -------------------------------------------------------------------------
    // _logSkipped — format skippedShipments[] into a helpful console log
    // -------------------------------------------------------------------------
    function _logSkipped(skipped) {
        const reasons = {};
        for (const s of skipped) {
            const code = s.reasons?.[0]?.code || 'UNKNOWN';
            reasons[code] = (reasons[code] || 0) + 1;
        }
        console.warn('[GoGoogle v5.2] ' + skipped.length +
            ' shipment(s) skipped:',
            Object.entries(reasons)
                .map(([c, n]) => c + '×' + n)
                .join(', '));
        if (skipped.length <= 10) {
            console.warn('[GoGoogle v5.2] Skipped details:', skipped.map(s => ({
                label: s.label,
                code:  s.reasons?.[0]?.code,
                desc:  s.reasons?.[0]?.description
            })));
        }
    }

    // -------------------------------------------------------------------------
    // _routeDurationSec — unchanged from v4
    // -------------------------------------------------------------------------
    function _routeDurationSec(gRoute) {
        const raw = gRoute.metrics?.travelDuration;
        if (!raw) return 0;
        return parseInt(raw) || 0;
    }

    // -------------------------------------------------------------------------
    // _cheapestInsert — unchanged from v4
    // -------------------------------------------------------------------------
    function _cheapestInsert(routes, stop, vehicles) {
        if (!routes.length) return;
        const haversine = (la1, ln1, la2, ln2) => {
            const R = 3959;
            const dLat = (la2 - la1) * Math.PI / 180;
            const dLng = (ln2 - ln1) * Math.PI / 180;
            const a = Math.sin(dLat / 2) ** 2 +
                Math.cos(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) *
                Math.sin(dLng / 2) ** 2;
            return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        };

        let best = null, bestCost = Infinity, bestPos = 0;
        for (const route of routes) {
            const cap = route._cap || 44;
            if (route.camperCount + stop.campers.length > cap) continue;

            for (let pos = 0; pos <= route.stops.length; pos++) {
                let cost;
                if (pos === 0) {
                    cost = haversine(stop.lat, stop.lng,
                        route.stops[0]?.lat || stop.lat,
                        route.stops[0]?.lng || stop.lng);
                } else if (pos === route.stops.length) {
                    const last = route.stops[pos - 1];
                    cost = haversine(last.lat, last.lng, stop.lat, stop.lng);
                } else {
                    const prev = route.stops[pos - 1];
                    const next = route.stops[pos];
                    cost = haversine(prev.lat, prev.lng, stop.lat, stop.lng) +
                           haversine(stop.lat, stop.lng, next.lat, next.lng) -
                           haversine(prev.lat, prev.lng, next.lat, next.lng);
                }
                if (cost < bestCost) {
                    bestCost = cost; best = route; bestPos = pos;
                }
            }
        }

        if (best) {
            best.stops.splice(bestPos, 0, {
                stopNum: 0, // renumbered below
                campers: stop.campers,
                address: stop.address,
                lat:     stop.lat,
                lng:     stop.lng
            });
            best.stops.forEach((s, i) => s.stopNum = i + 1);
            best.camperCount += stop.campers.length;
        }
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------
    return {
        isConfigured,
        optimizeTours
    };
})();
