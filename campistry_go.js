
// =============================================================================
// campistry_go.js — Campistry Go v4.0
// VROOM-powered bus routing with zone-based clustering
//
// v4.0 Changes:
//   ZONE: sliceRegionsIntoZones() — driving-time k-medoids zone builder
//         Replaces old merge logic, geoBisect, FIX 16, and FIX 18
//         Decides bus territories up-front using real driving time
//   ZONE: Dry-run preview — shows proposed zones on map before routing
//
// v3.1 Changes:
//   FIX 1: Distance matrix: Mapbox Matrix API (primary) → OSRM (fallback)
//          Staggered requests with retry on 429
//   FIX 2: Per-region bus rebalancing (only between buses in same ZIP region)
//   FIX 3: Overpass API retry + kumi.systems mirror fallback
//   FIX 4: Stop marker uses nearest-kid coords when no OSM snap (not centroid)
//   FIX 5: Default walk cap 375ft; user setting now acts as optional cap
//   FIX 6: Manhattan distance for walk checks (models grid streets, not crow-flies)
//   FIX 7: Dynamic cluster radius — auto-scales to housing density
//          Dense city (~0.01mi NN) → ~0.07mi radius
//          Suburban   (~0.03mi NN) → ~0.15mi radius
//          Spread out (~0.10mi NN) → ~0.50mi radius
//          Rural      (~0.20mi NN) → ~1.00mi radius
//   FIX 8: Region merging when more ZIPs than buses (nearest-neighbor merge)
//   FIX 9: Optimal stop placement within each cluster
//          Optimized mode: coordinate-wise median (exact L1 optimum) — the
//            mathematically most central point, can be anywhere on the grid
//          Corner mode: scores intersections by street match + total kid walking
//  FIX 10: Unified VROOM solver — single call with ALL stops + ALL buses.
//          VROOM handles both assignment (which bus) and ordering (stop sequence)
//          with real bus capacity enforced natively. Replaces the old
//          region-split → per-region VROOM → rebalance → local TSP pipeline.
//          Orient flip (reverse if wrong direction) is the only post-processing.
//          Mapbox Optimize API + local TSP kept for single-bus re-optimization.
//  FIX 11: Per-region density — each ZIP gets its own cluster radius
//          Inwood (dense grid) → tight clusters; Hewlett (suburban) → wider
//  FIX 12: Post-routing same-street merge — consecutive stops on the same
//          street within 300ft get consolidated into one stop
//  FIX 13: Real bus capacity in VROOM — no artificial inflation or balancing.
//  FIX 14: Walk-split threshold uses user's maxWalkDistance setting (not hard-coded 500ft)
//  FIX 15: Or-opt (single-stop relocation) pass after 2-opt for better route ordering
//  FIX 16: Pre-VROOM capacity check — rebalances geographic clusters before routing
//  FIX 17: Toast warning when Overpass API fails and corner-stops degrade to fallback
//  FIX 18: Boundary-swap pass — moves stops between buses if it reduces total drive time
//  FIX 19: Dynamic capacity enforcement — expands search from 1mi to 2mi if needed
//  FIX 20: Boundary-aware scoring for cap moves — prefers stops far from own bus
//          and close to target bus (actual boundary stops), not arbitrary closest
//  FIX 21: Aggressive outlier swap (10 passes, 0.85 threshold) + compactness
//          enforcement — moves stops >2x avg radius to nearest cluster
// =============================================================================
(function () {
    'use strict';
    console.log('[Go] Campistry Go v4.0 loading...');

    // =========================================================================
    // PLATFORM API KEYS — loaded from config.js via window globals
    // Users never need to configure these; setup fields are optional overrides
    // =========================================================================
    const _PLATFORM_KEYS = {
        ors: window.__CAMPISTRY_ORS_KEY__ || '',
        graphhopper: window.__CAMPISTRY_GH_KEY__ || '',
        mapbox: window.__CAMPISTRY_MAPBOX_TOKEN__ || ''
    };

    // =========================================================================
    // STATE
    // =========================================================================
    let D = {
        setup: {
            campAddress: '', campName: '', avgSpeed: 25,
            reserveSeats: 2, dropoffMode: 'door-to-door',
            avgStopTime: 2, maxWalkDistance: 375, orsApiKey: '', graphhopperKey: '', mapboxToken: '',
            campLat: null, campLng: null
        },
        activeMode: 'dismissal',
        buses: [], shifts: [], monitors: [], counselors: [],
        savedRoutes: null, dismissal: null, arrival: null,
        addresses: {}, dailyOverrides: {}, carpoolGroups: {}
    };
    let _editBusId = null, _editMonitorId = null, _editCounselorId = null, _editCamper = null;
    let _generatedRoutes = null;
    let _toastTimer = null;
    const BUS_COLORS = ['#3b82f6','#ef4444','#22c55e','#f59e0b','#a855f7','#ec4899','#06b6d4','#f97316','#8b5cf6','#14b8a6','#6366f1','#84cc16','#e11d48','#0ea5e9','#d946ef'];
    const STORE = 'campistry_go_data';
    const REGION_COLORS = ['#3b82f6','#ef4444','#22c55e','#f59e0b','#a855f7','#ec4899','#06b6d4','#f97316','#8b5cf6','#14b8a6','#6366f1','#e11d48'];
    let _detectedRegions = null;
    let _detectedRadius = null;
    let _busAssignments = null;

    // =========================================================================
    // HELPERS
    // =========================================================================
    const esc = s => { if (s == null) return ''; const m = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#x27;'}; return String(s).replace(/[&<>"']/g, c => m[c]); };
    const uid = () => 'go_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6);
    function toast(msg, type) { const el = document.getElementById('toastEl'); el.textContent = msg; el.className = 'toast' + (type === 'error' ? ' error' : ''); clearTimeout(_toastTimer); requestAnimationFrame(() => { el.classList.add('show'); _toastTimer = setTimeout(() => el.classList.remove('show'), 2500); }); }
    function openModal(id) {
        const el = document.getElementById(id);
        if (!el) return;
        el.classList.add('open', 'modal-entering');
        requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('modal-entering')));
    }
    function closeModal(id) {
        const el = document.getElementById(id);
        if (!el) return;
        el.classList.add('modal-entering');
        setTimeout(() => { el.classList.remove('open', 'modal-entering'); }, 200);
    }
    function getApiKey() { return window.__CAMPISTRY_ORS_KEY__ || D.setup.orsApiKey || _PLATFORM_KEYS.ors; }
    let _campCoordsCache = null;

    function haversineMi(lat1, lng1, lat2, lng2) {
        const R = 3958.8, toRad = d => d * Math.PI / 180;
        const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    // ── FIX 6: Manhattan distance for realistic grid-street walking ──
    // Instead of crow-flies haversine, this measures "walk north/south then
    // east/west" — which is how kids actually walk on a street grid.
    // At ~40.6° latitude this adds ~40% over haversine for diagonal paths.
    function manhattanMi(lat1, lng1, lat2, lng2) {
        return haversineMi(lat1, lng1, lat2, lng1) + haversineMi(lat2, lng1, lat2, lng2);
    }

    // =========================================================================
    // SMART CLUSTERING ENGINE
    // Street-aware distance, major road barriers, capacity caps
    // =========================================================================

    // =========================================================================
    // DIRECTIONAL HELPERS — used by all code paths that order/insert stops
    // =========================================================================

    /** Sort stops by distance from camp: farthest-first for arrival, nearest-first for dismissal */
    function directionalSort(stops, campLat, campLng) {
        if (stops.length < 2) return;
        const isArr = D.activeMode === 'arrival';
        stops.forEach(s => {
            s._dSort = (s.lat && s.lng) ? haversineMi(campLat, campLng, s.lat, s.lng) : 0;
        });
        if (isArr) stops.sort((a, b) => b._dSort - a._dSort);
        else stops.sort((a, b) => a._dSort - b._dSort);
        stops.forEach((s, i) => { s.stopNum = i + 1; delete s._dSort; });
    }

    /** Insert a stop at the directionally correct position (by distance from camp) */
    function directionalInsert(stops, newStop, campLat, campLng) {
        if (!newStop.lat || !newStop.lng) { stops.push(newStop); return; }
        const isArr = D.activeMode === 'arrival';
        const nd = haversineMi(campLat, campLng, newStop.lat, newStop.lng);
        let insertAt = stops.length; // default: append
        for (let i = 0; i < stops.length; i++) {
            if (!stops[i].lat || !stops[i].lng) continue;
            const sd = haversineMi(campLat, campLng, stops[i].lat, stops[i].lng);
            if (isArr ? (nd > sd) : (nd < sd)) { insertAt = i; break; }
        }
        stops.splice(insertAt, 0, newStop);
        stops.forEach((s, i) => { s.stopNum = i + 1; });
    }

    /** Insert a stop where it adds the least driving distance (preserves VROOM's route flow) */
    function cheapestInsert(stops, newStop) {
        if (!newStop.lat || !newStop.lng || stops.length === 0) {
            stops.push(newStop);
            stops.forEach((s, i) => { s.stopNum = i + 1; });
            return;
        }
        let bestPos = stops.length, bestCost = Infinity;
        for (let i = 0; i <= stops.length; i++) {
            const prev = i > 0 ? stops[i - 1] : null;
            const next = i < stops.length ? stops[i] : null;
            let cost = 0;
            if (prev && prev.lat) cost += haversineMi(prev.lat, prev.lng, newStop.lat, newStop.lng);
            if (next && next.lat) cost += haversineMi(newStop.lat, newStop.lng, next.lat, next.lng);
            if (prev && next && prev.lat && next.lat) cost -= haversineMi(prev.lat, prev.lng, next.lat, next.lng);
            if (cost < bestCost) { bestCost = cost; bestPos = i; }
        }
        stops.splice(bestPos, 0, newStop);
        stops.forEach((s, i) => { s.stopNum = i + 1; });
    }

    const MAX_STOP_CAPACITY = Infinity; // no cap — walk distance is the only constraint
    let _majorRoadSegments = null; // [{lat1,lng1,lat2,lng2,name}] from Overpass

    /** Line segment intersection test (2D) */
    function segmentsIntersect(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2) {
        const d = (bx2 - bx1) * (ay2 - ay1) - (by2 - by1) * (ax2 - ax1);
        if (Math.abs(d) < 1e-12) return false;
        const t = ((bx1 - ax1) * (ay2 - ay1) - (by1 - ay1) * (ax2 - ax1)) / d;
        const u = ((bx1 - ax1) * (by2 - by1) - (by1 - ay1) * (bx2 - bx1)) / d;
        return t >= 0 && t <= 1 && u >= 0 && u <= 1;
    }

    /** Check if a straight line between two points crosses any cached major road */
    function crossesMajorRoad(lat1, lng1, lat2, lng2) {
        if (!_majorRoadSegments || !_majorRoadSegments.length) return false;
        for (const seg of _majorRoadSegments) {
            if (segmentsIntersect(lat1, lng1, lat2, lng2, seg.lat1, seg.lng1, seg.lat2, seg.lng2)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Street-aware cluster distance.
     * - Same street: 0.7× (kids can walk along their own block)
     * - Different street, no major road between: 1.0×
     * - Different street, major road between: 2.5× (don't make kids cross Broadway)
     * - Same street + same parity (same side): extra 0.1× bonus
     */
    function smartClusterDist(lat1, lng1, addr1, lat2, lng2, addr2) {
        let dist = manhattanMi(lat1, lng1, lat2, lng2);
        if (dist < 0.001) return dist; // same house

        const p1 = parseAddress(addr1);
        const p2 = parseAddress(addr2);
        const st1 = normalizeStreet(p1.street);
        const st2 = normalizeStreet(p2.street);

        if (st1 && st2 && st1 === st2) {
            // Same street — big bonus
            dist *= 0.7;
            // Same parity = same side of street → extra bonus
            if (p1.num > 0 && p2.num > 0 && (p1.num % 2) === (p2.num % 2)) {
                dist *= 0.85;
            }
        } else if (crossesMajorRoad(lat1, lng1, lat2, lng2)) {
            // Crossing a major arterial — heavy penalty
            dist *= 2.5;
        }

        return dist;
    }

    /**
     * Smart clustering: shared by both optimized and corner stop modes.
     * Uses smartClusterDist for street-aware grouping.
     * Supports sibling linking and multi-start strategies.
     */
    function smartCluster(campers, walkMi, sibMap) {

        function runOnePass(sortedList) {
            const clusters = [], assigned = new Set();
            sortedList.forEach(c => {
                if (assigned.has(c.name)) return;
                const cluster = [];
                const sibGid = sibMap[c.name];
                if (sibGid) {
                    sortedList.forEach(k => { if (!assigned.has(k.name) && sibMap[k.name] === sibGid) { cluster.push(k); assigned.add(k.name); } });
                } else {
                    cluster.push(c); assigned.add(c.name);
                }

                let changed = true;
                while (changed) {
                    changed = false;
                    sortedList.forEach(other => {
                        if (assigned.has(other.name)) return;
                        const toAdd = [other];
                        const oGid = sibMap[other.name];
                        if (oGid) sortedList.forEach(k => { if (!assigned.has(k.name) && k.name !== other.name && sibMap[k.name] === oGid) toAdd.push(k); });
                        const trial = [...cluster, ...toAdd];
                        const nLat = trial.reduce((s, k) => s + k.lat, 0) / trial.length;
                        const nLng = trial.reduce((s, k) => s + k.lng, 0) / trial.length;

                        // Use street-aware distance for every kid in the trial
                        const allFit = trial.every(k =>
                            smartClusterDist(nLat, nLng, '', k.lat, k.lng, k.address) <= walkMi
                        );
                        if (allFit) {
                            toAdd.forEach(k => { cluster.push(k); assigned.add(k.name); });
                            changed = true;
                        }
                    });
                }
                clusters.push(cluster);
            });
            return clusters;
        }

        // Multi-start: different sort orders find different cluster groupings
        const avgLat = campers.reduce((s, c) => s + c.lat, 0) / campers.length;
        const avgLng = campers.reduce((s, c) => s + c.lng, 0) / campers.length;
        const strategies = [
            [...campers].sort((a, b) => a.lat - b.lat),
            [...campers].sort((a, b) => b.lat - a.lat),
            [...campers].sort((a, b) => a.lng - b.lng),
            [...campers].sort((a, b) => b.lng - a.lng),
            [...campers].sort((a, b) => haversineMi(avgLat, avgLng, a.lat, a.lng) - haversineMi(avgLat, avgLng, b.lat, b.lng)),
            [...campers].sort((a, b) => haversineMi(avgLat, avgLng, b.lat, b.lng) - haversineMi(avgLat, avgLng, a.lat, a.lng)),
            // Sort by street name then house number — groups same-street kids
            [...campers].sort((a, b) => {
                const pa = parseAddress(a.address), pb = parseAddress(b.address);
                const sc = (pa.street || '').localeCompare(pb.street || '');
                return sc !== 0 ? sc : pa.num - pb.num;
            }),
        ];

        let bestClusters = null, bestCount = Infinity;
        strategies.forEach(s => {
            const r = runOnePass(s);
            if (r.length < bestCount) { bestCount = r.length; bestClusters = r; }
        });

        // ── Capacity cap: split oversized clusters ──
        const finalClusters = [];
        bestClusters.forEach(cluster => {
            if (cluster.length <= MAX_STOP_CAPACITY) {
                finalClusters.push(cluster);
                return;
            }
            // Split using K-means (k=2) on the cluster positions
            console.log('[Go] Splitting oversized cluster (' + cluster.length + ' kids) into 2');
            const sorted = [...cluster].sort((a, b) => {
                // Split along the longer axis (lat or lng spread)
                const latSpread = Math.abs(a.lat - b.lat);
                const lngSpread = Math.abs(a.lng - b.lng);
                return latSpread > lngSpread ? a.lat - b.lat : a.lng - b.lng;
            });
            const mid = Math.ceil(sorted.length / 2);
            finalClusters.push(sorted.slice(0, mid));
            finalClusters.push(sorted.slice(mid));
        });

        console.log('[Go] Clustered ' + campers.length + ' campers → ' + finalClusters.length + ' groups (best of ' + strategies.length + ')' +
            (finalClusters.length > bestClusters.length ? ', ' + (finalClusters.length - bestClusters.length) + ' split for capacity' : ''));

        return finalClusters;
    }

    // ── Distance matrix: Mapbox (primary) → OSRM (fallback) ──
    // Mapbox Matrix API is more reliable than public OSRM and uses the
    // same token already configured for route geometry rendering.
    // Returns an NxN duration matrix in seconds, or null on failure.
    async function fetchDistanceMatrix(coords, campLat, campLng) {
        // coords = array of {lat, lng} with index 0 = camp
        const n = coords.length;
        if (n < 2) return null;

        // Build coordinate string: lng,lat;lng,lat;...
        const coordStr = coords.map(c => c.lng + ',' + c.lat).join(';');

        // ── Try Mapbox Matrix API first ──
        const mbToken = D.setup.mapboxToken || _PLATFORM_KEYS.mapbox;
        if (mbToken) {
            try {
                // Mapbox allows up to 25 coordinates per request
                if (n <= 25) {
                    const url = 'https://api.mapbox.com/directions-matrix/v1/mapbox/driving/' + coordStr + '?annotations=duration&access_token=' + mbToken;
                    const resp = await fetch(url);
                    if (resp.ok) {
                        const data = await resp.json();
                        if (data.code === 'Ok' && data.durations) {
                            console.log('[Go] Matrix: Mapbox (' + n + ' points)');
                            return data.durations;
                        }
                    }
                } else {
                    // >25 coords: split into chunks (rare for bus routes)
                    console.log('[Go] Matrix: ' + n + ' points exceeds Mapbox limit, falling back to OSRM');
                }
            } catch (e) {
                console.warn('[Go] Mapbox Matrix failed:', e.message);
            }
        }

        // ── Fallback: OSRM with retry ──
        return await fetchOSRMWithRetry(coordStr, 3);
    }

    async function fetchOSRMWithRetry(coordStr, retries) {
        if (retries === undefined) retries = 3;
        for (let attempt = 0; attempt < retries; attempt++) {
            if (attempt > 0) {
                const delay = 1000 * Math.pow(2, attempt - 1);
                console.log('[Go] OSRM retry ' + attempt + ' after ' + delay + 'ms...');
                await new Promise(r => setTimeout(r, delay));
            }
            try {
                const resp = await fetch('https://router.project-osrm.org/table/v1/driving/' + coordStr + '?annotations=duration');
                if (resp.status === 429) {
                    console.warn('[Go] OSRM 429 (rate limited) — attempt ' + (attempt + 1) + '/' + retries);
                    continue;
                }
                if (resp.ok) {
                    const data = await resp.json();
                    if (data.code === 'Ok' && data.durations) return data.durations;
                }
                return null;
            } catch (e) {
                if (attempt === retries - 1) return null;
            }
        }
        return null;
    }

    function decodePolyline(encoded) {
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

    // ── Address normalization for Census geocoder ──
    // Census is very strict about formatting. This cleans addresses
    // to maximize match rate before sending.
    function normalizeCensusAddress(street, city, state, zip) {
        let s = (street || '').trim();

        // Remove apartment/unit/suite/floor — Census can't match these
        s = s.replace(/\s*[,#]\s*(apt|suite|ste|unit|fl|floor|rm|room|bldg|building|lot|spc|space|trlr|trailer|dept)\.?\s*\S*/gi, '');
        s = s.replace(/\s*[,#]\s*\d+[a-z]?\s*$/i, ''); // trailing "#2B" or ", 3"
        s = s.replace(/\s*apartment\s+\S+/gi, '');

        // Standardize directionals — Census prefers abbreviated
        const dirs = { 'north': 'N', 'south': 'S', 'east': 'E', 'west': 'W',
                       'northeast': 'NE', 'northwest': 'NW', 'southeast': 'SE', 'southwest': 'SW' };
        Object.entries(dirs).forEach(([full, abbr]) => {
            s = s.replace(new RegExp('\\b' + full + '\\b', 'gi'), abbr);
        });

        // Standardize street suffixes — Census prefers standard USPS abbreviations
        const suffixes = {
            'street': 'St', 'avenue': 'Ave', 'boulevard': 'Blvd', 'drive': 'Dr',
            'road': 'Rd', 'court': 'Ct', 'lane': 'Ln', 'place': 'Pl',
            'circle': 'Cir', 'terrace': 'Ter', 'parkway': 'Pkwy', 'highway': 'Hwy',
            'way': 'Way', 'trail': 'Trl', 'turnpike': 'Tpke', 'pike': 'Pike',
            'crescent': 'Cres', 'square': 'Sq', 'crossing': 'Xing'
        };
        Object.entries(suffixes).forEach(([full, abbr]) => {
            s = s.replace(new RegExp('\\b' + full + '\\b', 'gi'), abbr);
        });

        // Remove extra whitespace
        s = s.replace(/\s+/g, ' ').trim();

        // Normalize state — Census wants 2-letter abbreviation
        let st = (state || '').trim().toUpperCase();
        const stateMap = {
            'NEW YORK': 'NY', 'NEW JERSEY': 'NJ', 'CONNECTICUT': 'CT', 'PENNSYLVANIA': 'PA',
            'CALIFORNIA': 'CA', 'FLORIDA': 'FL', 'TEXAS': 'TX', 'MASSACHUSETTS': 'MA',
            'MARYLAND': 'MD', 'VIRGINIA': 'VA', 'OHIO': 'OH', 'ILLINOIS': 'IL',
            'GEORGIA': 'GA', 'MICHIGAN': 'MI', 'NORTH CAROLINA': 'NC', 'COLORADO': 'CO'
        };
        if (stateMap[st]) st = stateMap[st];

        // Build the query — Census works best with: "street, city, state zip"
        const parts = [s];
        if (city) parts.push((city || '').trim());
        if (st) parts.push(st);
        let q = parts.join(', ');
        if (zip) q += ' ' + (zip || '').trim().replace(/\s+/g, '').substring(0, 5); // 5-digit zip only

        return q;
    }

    // ── Geocode validation — reject results that don't make sense ──
    function validateGeocode(lat, lng, address, camperName) {
        // 1. Null or zero coordinates
        if (!lat || !lng || lat === 0 || lng === 0) {
            console.warn('[Go] Geocode rejected for ' + camperName + ': null coordinates');
            return false;
        }
        // 2. Outside continental US bounds (rough)
        if (lat < 24 || lat > 50 || lng < -125 || lng > -66) {
            console.warn('[Go] Geocode rejected for ' + camperName + ': outside continental US (' + lat.toFixed(4) + ', ' + lng.toFixed(4) + ')');
            return false;
        }
        // 3. If camp location is known, reject if >100 miles away
        if (_campCoordsCache) {
            const dist = haversineMi(_campCoordsCache.lat, _campCoordsCache.lng, lat, lng);
            if (dist > 100) {
                console.warn('[Go] Geocode rejected for ' + camperName + ': ' + dist.toFixed(1) + ' miles from camp (max 100) — likely wrong location');
                return false;
            }
        }
        // 4. Coordinates that land in the ocean (rough Atlantic/Pacific checks near common camp areas)
        // Atlantic: east of -71 lng AND south of 41 lat (ocean off Long Island / NJ)
        if (lng > -71 && lat < 40.4 && lng < -60) {
            console.warn('[Go] Geocode rejected for ' + camperName + ': appears to be in the ocean');
            return false;
        }
        return true;
    }

    function censusGeocode(address) {
        return new Promise((resolve) => {
            const cbName = '_cg_' + Math.random().toString(36).slice(2, 8);
            const timeout = setTimeout(() => { cleanup(); resolve(null); }, 10000);
            function cleanup() { clearTimeout(timeout); try { delete window[cbName]; } catch(_) {} document.querySelectorAll('script[data-census="' + cbName + '"]').forEach(s => s.remove()); }
            window[cbName] = function(data) { cleanup(); resolve(data); };
            const url = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?' + new URLSearchParams({ address: address, benchmark: 'Public_AR_Current', format: 'jsonp', callback: cbName });
            const script = document.createElement('script');
            script.setAttribute('data-census', cbName);
            script.setAttribute('data-campistry-allowed', 'true');
            script.src = url;
            script.onerror = function() { cleanup(); resolve(null); };
            document.head.appendChild(script);
        });
    }

    function formatTime(totalMin) {
        const h = Math.floor(totalMin / 60), m = Math.round(totalMin % 60);
        const p = h >= 12 ? 'PM' : 'AM', h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
        return h12 + ':' + String(m).padStart(2, '0') + ' ' + p;
    }
    function parseTime(t) { const [h, m] = (t || '16:00').split(':').map(Number); return h * 60 + (m || 0); }


    // =========================================================================
    // DATA: LOAD / SAVE / ROSTER
    // =========================================================================
    function readCampistrySettings() {
        if (typeof window.loadGlobalSettings === 'function') { try { return window.loadGlobalSettings() || {}; } catch (_) {} }
        const keys = ['CAMPISTRY_UNIFIED_STATE', 'campGlobalSettings_v1', 'CAMPISTRY_LOCAL_CACHE'];
        for (const key of keys) { try { const raw = localStorage.getItem(key); if (raw) return JSON.parse(raw) || {}; } catch (_) {} }
        return {};
    }

    function load() {
        try {
            const g = readCampistrySettings();
            if (g.campistryGo && Object.keys(g.campistryGo).length) { D = merge(g.campistryGo); console.log('[Go] Loaded from cloud settings'); return; }
            const raw = localStorage.getItem(STORE);
            if (raw) { D = merge(JSON.parse(raw)); console.log('[Go] Loaded from localStorage'); }
        } catch (e) { console.error('[Go] Load error:', e); }
    }

    function merge(d) {
        const def = { setup: { campAddress:'',campName:'',avgSpeed:25,reserveSeats:2,dropoffMode:'door-to-door',avgStopTime:2,maxWalkDistance:375,orsApiKey:'',graphhopperKey:'',mapboxToken:'',campLat:null,campLng:null }, activeMode:'dismissal', buses:[], shifts:[], monitors:[], counselors:[], addresses:{}, savedRoutes:null, dismissal:null, arrival:null, dailyOverrides:{}, carpoolGroups:{} };
        const result = { setup: { ...def.setup, ...(d.setup || {}) }, activeMode: d.activeMode || 'dismissal', buses: d.buses || [], shifts: d.shifts || [], monitors: d.monitors || [], counselors: d.counselors || [], addresses: d.addresses || {}, savedRoutes: d.savedRoutes || null, dismissal: d.dismissal || null, arrival: d.arrival || null, dailyOverrides: d.dailyOverrides || {}, carpoolGroups: d.carpoolGroups || {} };
        if (!result.dismissal && result.buses.length) { result.dismissal = { buses: [...result.buses], shifts: [...result.shifts], monitors: [...result.monitors], counselors: [...result.counselors], savedRoutes: result.savedRoutes }; }
        if (!result.arrival) { result.arrival = { buses: [], shifts: [], monitors: [], counselors: [], savedRoutes: null }; }
        return result;
    }

    function save() {
        try {
            setSyncStatus('syncing');
            saveModeData();
            localStorage.setItem(STORE, JSON.stringify(D));
            if (typeof window.saveGlobalSettings === 'function') window.saveGlobalSettings('campistryGo', D);
            setTimeout(() => setSyncStatus('synced'), 300);
        } catch (e) { console.error('[Go] Save:', e); setSyncStatus('error'); }
    }

    function setSyncStatus(s) {
        const dot = document.getElementById('syncDot'), txt = document.getElementById('syncText');
        if (!dot) return;
        dot.className = 'sync-dot' + (s === 'syncing' ? ' syncing' : s === 'error' ? ' error' : '');
        txt.textContent = s === 'syncing' ? 'Saving...' : s === 'error' ? 'Error' : 'Synced';
    }

    // =========================================================================
    // ARRIVAL / DISMISSAL MODE SWITCHING
    // =========================================================================
    function saveModeData() { D[D.activeMode] = { buses: D.buses, shifts: D.shifts, monitors: D.monitors, counselors: D.counselors, savedRoutes: D.savedRoutes }; }
    function loadModeData(mode) { const data = D[mode] || { buses: [], shifts: [], monitors: [], counselors: [], savedRoutes: null }; D.buses = data.buses || []; D.shifts = data.shifts || []; D.monitors = data.monitors || []; D.counselors = data.counselors || []; D.savedRoutes = data.savedRoutes || null; }

    function switchMode(mode) {
        if (mode === D.activeMode) return;
        saveModeData(); D.activeMode = mode; loadModeData(mode);
        _routeGeomCache = {}; window._routeGeomCache = _routeGeomCache; _generatedRoutes = D.savedRoutes;
        save(); renderFleet(); renderShifts(); renderStaff(); renderAddresses(); updateStats(); updateBusSelects();
        document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
        const sub = document.getElementById('modeLabel');
        if (sub) sub.textContent = mode === 'arrival' ? 'Morning Pickup Routes' : 'Afternoon Drop-off Routes';
        if (D.savedRoutes) { renderRouteResults(applyOverrides(D.savedRoutes)); }
        else { document.getElementById('routeResults').style.display = 'none'; document.getElementById('shiftResultsContainer').innerHTML = ''; }
        toast('Switched to ' + (mode === 'arrival' ? 'Arrival' : 'Dismissal') + ' mode');
    }

    // =========================================================================
    // CAPACITY WARNINGS
    // =========================================================================
    function getCapacityWarnings() {
        if (!_generatedRoutes) return [];
        const applied = applyOverrides(_generatedRoutes);
        const warnings = [];
        applied.forEach(sr => { sr.routes.forEach(r => { const bus = D.buses.find(b => b.id === r.busId); if (!bus) return; const brs = getBusReserve(bus); const mon = D.monitors.find(m => m.assignedBus === bus.id); const couns = D.counselors.filter(c => c.assignedBus === bus.id); const maxCampers = Math.max(0, (bus.capacity || 0) - (mon ? 1 : 0) - couns.length - brs); if (r.camperCount > maxCampers) warnings.push({ busName: r.busName, busColor: r.busColor, shift: sr.shift.label || 'Shift', actual: r.camperCount, max: maxCampers, over: r.camperCount - maxCampers }); }); });
        return warnings;
    }

    function renderCapacityWarnings() {
        const el = document.getElementById('capacityWarnings');
        if (!el) return;
        const warnings = getCapacityWarnings();
        if (!warnings.length) { el.style.display = 'none'; return; }
        el.style.display = '';
        el.innerHTML = warnings.map(w => '<div style="display:flex;align-items:center;gap:.5rem;padding:.5rem .75rem;background:var(--red-50);border:1px solid var(--red-100);border-radius:var(--radius-sm);margin-bottom:.375rem;font-size:.8125rem;"><span style="width:10px;height:10px;border-radius:50%;background:' + esc(w.busColor) + ';flex-shrink:0;"></span><strong style="color:var(--red-600);">⚠ ' + esc(w.busName) + '</strong> (' + esc(w.shift) + ') — <span>' + w.actual + ' campers, only ' + w.max + ' seats (' + w.over + ' over)</span></div>').join('');
    }

    // =========================================================================
    // ROSTER (from Campistry Me — auto-synced)
    // =========================================================================
    // Go's own standalone roster — used when Me has no campers
    let _goStandaloneRoster = {};

    function getRoster() {
        // 1. Try Campistry Me roster first
        const g = readCampistrySettings();
        const meRoster = g?.app1?.camperRoster || {};
        if (Object.keys(meRoster).length > 0) {
            let needsSave = false, maxId = 0;
            Object.values(meRoster).forEach(c => { if (c.camperId && c.camperId > maxId) maxId = c.camperId; });
            let nextId = (g?.campistryMe?.nextCamperId) || maxId + 1;
            if (maxId >= nextId) nextId = maxId + 1;
            Object.entries(meRoster).forEach(([n, c]) => { if (!c.camperId) { c.camperId = nextId; nextId++; needsSave = true; } });
            if (needsSave) {
                try { const raw = localStorage.getItem('campGlobalSettings_v1'); if (raw) { const data = JSON.parse(raw); data.app1.camperRoster = meRoster; if (!data.campistryMe) data.campistryMe = {}; data.campistryMe.nextCamperId = nextId; localStorage.setItem('campGlobalSettings_v1', JSON.stringify(data)); } } catch (e) {}
            }
            return meRoster;
        }
        // 2. Fall back to Go's standalone roster (from CSV import)
        if (Object.keys(_goStandaloneRoster).length > 0) return _goStandaloneRoster;
        // 3. Build roster from Go's own address data (campers added directly in Go)
        const addrRoster = {};
        Object.keys(D.addresses).forEach(name => {
            const a = D.addresses[name];
            addrRoster[name] = {
                camperId: a._camperId || 0,
                division: a._division || '',
                bunk: a._bunk || '',
                grade: ''
            };
        });
        return addrRoster;
    }
    function getStructure() {
        // Try Me's camp structure first
        const g = readCampistrySettings();
        const meStruct = g?.campStructure || {};
        if (Object.keys(meStruct).length) return meStruct;

        // Build structure from Go's standalone data (CSV import or addresses)
        const roster = getRoster();
        const struct = {};
        Object.values(roster).forEach(c => {
            const div = c.division || '';
            if (!div) return;
            if (!struct[div]) struct[div] = { color: BUS_COLORS[Object.keys(struct).length % BUS_COLORS.length], grades: {} };
            const grade = c.grade || 'Default';
            if (!struct[div].grades[grade]) struct[div].grades[grade] = { bunks: [] };
            const bunk = c.bunk || '';
            if (bunk && struct[div].grades[grade].bunks.indexOf(bunk) < 0) struct[div].grades[grade].bunks.push(bunk);
        });

        // Also scan addresses for division/grade/bunk from CSV import
        if (!Object.keys(struct).length) {
            Object.values(D.addresses).forEach(a => {
                const div = a._division || '';
                if (!div) return;
                if (!struct[div]) struct[div] = { color: BUS_COLORS[Object.keys(struct).length % BUS_COLORS.length], grades: {} };
                const grade = a._grade || 'Default';
                if (!struct[div].grades[grade]) struct[div].grades[grade] = { bunks: [] };
                if (a._bunk && struct[div].grades[grade].bunks.indexOf(a._bunk) < 0) struct[div].grades[grade].bunks.push(a._bunk);
            });
        }

        return struct;
    }
    function getDivisionNames() { return Object.keys(getStructure()).sort(); }

    // =========================================================================
    // SETUP
    // =========================================================================
    function populateSetup() {
        const s = D.setup;
        document.getElementById('campAddress').value = s.campAddress || '';
        document.getElementById('campName').value = s.campName || '';
        document.getElementById('avgSpeed').value = s.avgSpeed ?? 25;
        document.getElementById('reserveSeats').value = s.reserveSeats ?? 2;
        if (document.getElementById('dropoffMode')) document.getElementById('dropoffMode').value = s.dropoffMode || 'door-to-door';
        document.getElementById('avgStopTime').value = s.avgStopTime ?? 2;
        document.getElementById('maxWalkDistance').value = s.maxWalkDistance ?? 375;
        document.getElementById('orsApiKey').value = s.orsApiKey || '';
        if (document.getElementById('ghApiKey')) document.getElementById('ghApiKey').value = s.graphhopperKey || '';
        if (document.getElementById('mapboxToken')) document.getElementById('mapboxToken').value = s.mapboxToken || '';
    }
    function saveSetup() {
        const el = id => document.getElementById(id);
        D.setup.campAddress = el('campAddress')?.value.trim() || '';
        D.setup.campName = el('campName')?.value.trim() || '';
        D.setup.avgSpeed = parseInt(el('avgSpeed')?.value) || 25;
        D.setup.reserveSeats = parseInt(el('reserveSeats')?.value) || 0;
        D.setup.dropoffMode = el('dropoffMode')?.value || 'door-to-door';
        D.setup.avgStopTime = parseInt(el('avgStopTime')?.value) || 2;
        D.setup.maxWalkDistance = parseInt(el('maxWalkDistance')?.value) || 375;
        D.setup.orsApiKey = el('orsApiKey')?.value.trim() || '';
        D.setup.graphhopperKey = el('ghApiKey')?.value.trim() || '';
        D.setup.mapboxToken = el('mapboxToken')?.value.trim() || '';
        save(); toast('Setup saved');
    }
    async function testApiKey() {
        const key = document.getElementById('orsApiKey')?.value.trim();
        const st = document.getElementById('apiKeyStatus');
        if (!key) { st.innerHTML = '<span style="color:var(--red-600)">Enter key first</span>'; return; }
        st.innerHTML = '<span style="color:var(--text-muted)">Testing...</span>';
        try { const r = await fetch('https://api.openrouteservice.org/geocode/search?text=Times+Square+New+York&size=1', { headers: { 'Authorization': key, 'Accept': 'application/json' } }); st.innerHTML = r.status === 200 ? '<span style="color:var(--green-600)">✓ Connected</span>' : r.status === 401 ? '<span style="color:var(--red-600)">✗ Invalid key</span>' : '<span style="color:var(--amber-600)">⚠ HTTP ' + r.status + '</span>'; } catch (_) { st.innerHTML = '<span style="color:var(--red-600)">✗ Network error</span>'; }
    }

    // =========================================================================
    // BUS FLEET
    // =========================================================================
    // Helper: get effective reserve seats for a bus (per-bus override or default)
    function getBusReserve(bus) {
        if (bus.reserveMode === 'custom' && bus.reserveSeats != null) return bus.reserveSeats;
        return D.setup.reserveSeats || 0;
    }

    function renderFleet() {
        const c = document.getElementById('fleetContainer'), e = document.getElementById('fleetEmptyState');
        document.getElementById('fleetCount').textContent = D.buses.length + ' bus' + (D.buses.length !== 1 ? 'es' : '');
        if (!D.buses.length) { c.innerHTML = ''; c.style.display = 'none'; e.style.display = ''; return; }
        e.style.display = 'none'; c.style.display = '';
        c.innerHTML = '<div class="fleet-grid">' + D.buses.map(b => {
            const mon = D.monitors.find(m => m.assignedBus === b.id);
            const couns = D.counselors.filter(x => x.assignedBus === b.id);
            const staff = (mon ? 1 : 0) + couns.length;
            const rs = getBusReserve(b);
            const avail = Math.max(0, (b.capacity || 0) - staff - rs);
            const rsLabel = b.reserveMode === 'custom' ? rs + ' (custom)' : rs;
            return '<div class="bus-card" style="cursor:pointer" onclick="CampistryGo.editBus(\'' + b.id + '\')"><div class="bus-card-stripe" style="background:' + esc(b.color) + '"></div><div class="bus-card-header"><div><div class="bus-card-name">' + esc(b.name) + '</div>' + (b.notes ? '<div class="bus-card-number">' + esc(b.notes) + '</div>' : '') + '</div></div><div class="bus-card-stats"><div class="bus-stat"><div class="bus-stat-value">' + b.capacity + '</div><div class="bus-stat-label">Seats</div></div><div class="bus-stat"><div class="bus-stat-value">' + avail + '</div><div class="bus-stat-label">For Kids</div></div><div class="bus-stat"><div class="bus-stat-value">' + staff + '</div><div class="bus-stat-label">Staff</div></div><div class="bus-stat"><div class="bus-stat-value">' + rsLabel + '</div><div class="bus-stat-label">Reserved</div></div></div>' + (mon ? '<div style="margin-top:.75rem;font-size:.75rem;color:var(--text-muted)">Monitor: <strong style="color:var(--text-secondary)">' + esc(mon.name) + '</strong></div>' : '') + '</div>';
        }).join('') + '</div>';
    }
    function openBusModal(editId) {
        _editBusId = editId || null;
        document.getElementById('busModalTitle').textContent = editId ? 'Edit Bus' : 'Add Bus';
        const ex = editId ? D.buses.find(b => b.id === editId) : null;
        const col = ex?.color || BUS_COLORS[D.buses.length % BUS_COLORS.length];
        document.getElementById('busColorPicker').innerHTML = BUS_COLORS.map(c => '<div class="color-swatch' + (c === col ? ' selected' : '') + '" style="background:' + c + '" data-color="' + c + '" onclick="CampistryGo._pickColor(this)"></div>').join('');
        document.getElementById('busName').value = ex?.name || '';
        document.getElementById('busCapacity').value = ex?.capacity || '';
        document.getElementById('busNotes').value = ex?.notes || '';
        // Per-bus reserve seats
        const mode = ex?.reserveMode || 'default';
        document.getElementById('busReserveMode').value = mode;
        document.getElementById('busReserveCustom').value = ex?.reserveSeats ?? '';
        document.getElementById('busReserveCustom').style.display = mode === 'custom' ? '' : 'none';
        // Show delete button only when editing existing bus
        const delBtn = document.getElementById('busDeleteBtn');
        if (delBtn) delBtn.style.display = editId ? '' : 'none';
        openModal('busModal'); document.getElementById('busName').focus();
    }
    function _pickColor(el) { el.parentElement.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected')); el.classList.add('selected'); }
    function saveBus() {
        const name = document.getElementById('busName')?.value.trim(), cap = parseInt(document.getElementById('busCapacity')?.value);
        const color = document.querySelector('#busColorPicker .color-swatch.selected')?.dataset.color || BUS_COLORS[0];
        const notes = document.getElementById('busNotes')?.value.trim();
        const reserveMode = document.getElementById('busReserveMode')?.value || 'default';
        const reserveSeats = reserveMode === 'custom' ? (parseInt(document.getElementById('busReserveCustom')?.value) || 0) : null;
        if (!name) { toast('Enter name', 'error'); return; } if (!cap || cap < 1) { toast('Enter capacity', 'error'); return; }
        if (_editBusId) { const b = D.buses.find(x => x.id === _editBusId); if (b) { b.name = name; b.capacity = cap; b.color = color; b.notes = notes; b.reserveMode = reserveMode; b.reserveSeats = reserveSeats; } }
        else D.buses.push({ id: uid(), name, capacity: cap, color, notes, reserveMode, reserveSeats });
        save(); closeModal('busModal'); renderFleet(); updateStats(); updateBusSelects(); toast(_editBusId ? 'Updated' : 'Bus added');
    }

    // ── Quick Create: smart batch bus creation ──
    const COLOR_NAME_MAP = {
        'red': '#ef4444', 'blue': '#3b82f6', 'green': '#22c55e', 'yellow': '#f59e0b',
        'purple': '#a855f7', 'pink': '#ec4899', 'orange': '#f97316', 'teal': '#06b6d4',
        'black': '#1e293b', 'white': '#94a3b8', 'gold': '#f59e0b', 'silver': '#94a3b8',
        'navy': '#1e3a5f', 'maroon': '#991b1b', 'lime': '#84cc16', 'cyan': '#06b6d4'
    };
    const COLOR_SEQUENCE = ['Blue', 'Red', 'Green', 'Yellow', 'Purple', 'Pink', 'Orange', 'Teal', 'Navy', 'Maroon', 'Lime', 'Cyan', 'Gold', 'Silver', 'Black', 'White'];

    function quickCreateBuses() {
        const h = '<div style="margin-bottom:14px;font-size:.85rem;color:var(--text-secondary)">Create multiple buses at once. Smart naming auto-generates the rest.</div>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">' +
            '<div class="form-group"><label class="form-label">Number of Buses</label><input type="number" class="form-input" id="qcCount" value="8" min="1" max="30"></div>' +
            '<div class="form-group"><label class="form-label">Seats Per Bus</label><input type="number" class="form-input" id="qcSeats" value="46" min="1" max="100"></div>' +
            '</div>' +
            '<div class="form-group"><label class="form-label">First Bus Name</label><input type="text" class="form-input" id="qcName" placeholder="e.g. Bus 1, Blue Bus, Van A" value="Bus 1"><span class="form-hint">System will auto-name the rest: Bus 1 → Bus 2, Bus 3... or Blue → Red, Green...</span></div>' +
            '<div id="qcPreview" style="margin-top:12px;max-height:200px;overflow-y:auto;font-size:.8rem;border:1px solid var(--border-light,#e2e8f0);border-radius:8px;padding:8px"></div>';

        // Use the existing modal infrastructure
        const existing = document.getElementById('quickCreateModal');
        if (existing) existing.remove();
        const overlay = document.createElement('div');
        overlay.id = 'quickCreateModal';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;';
        overlay.innerHTML = '<div class="modal" style="max-width:480px"><div class="modal-header"><h3>Quick Create Buses</h3><button class="modal-close" onclick="document.getElementById(\'quickCreateModal\').remove()"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div><div class="modal-body">' + h + '</div><div class="modal-footer"><button class="btn btn-secondary" onclick="document.getElementById(\'quickCreateModal\').remove()">Cancel</button><button class="btn btn-primary" id="qcCreate">Create Buses</button></div></div>';
        document.body.appendChild(overlay);
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

        function updatePreview() {
            const count = parseInt(document.getElementById('qcCount').value) || 1;
            const seats = parseInt(document.getElementById('qcSeats').value) || 46;
            const firstName = (document.getElementById('qcName').value || '').trim() || 'Bus 1';
            const names = generateBusNames(firstName, count);
            document.getElementById('qcPreview').innerHTML = '<div style="font-weight:600;margin-bottom:6px">Preview:</div>' +
                names.map((n, i) => '<div style="display:flex;align-items:center;gap:8px;padding:3px 0"><span style="width:12px;height:12px;border-radius:50%;background:' + n.color + ';flex-shrink:0"></span><span style="font-weight:500">' + esc(n.name) + '</span><span style="color:var(--text-muted);font-size:.75rem">' + seats + ' seats</span></div>').join('');
        }
        updatePreview();
        document.getElementById('qcCount').oninput = updatePreview;
        document.getElementById('qcName').oninput = updatePreview;

        document.getElementById('qcCreate').onclick = function () {
            const count = parseInt(document.getElementById('qcCount').value) || 1;
            const seats = parseInt(document.getElementById('qcSeats').value) || 46;
            const firstName = (document.getElementById('qcName').value || '').trim() || 'Bus 1';
            const names = generateBusNames(firstName, count);
            names.forEach(n => {
                D.buses.push({ id: uid(), name: n.name, capacity: seats, color: n.color, notes: '', reserveMode: 'default', reserveSeats: null });
            });
            save(); overlay.remove(); renderFleet(); updateStats(); updateBusSelects();
            toast(count + ' bus' + (count !== 1 ? 'es' : '') + ' created');
        };
    }

    function generateBusNames(firstName, count) {
        const results = [];
        // Detect naming pattern
        const numMatch = firstName.match(/^(.+?)(\d+)\s*$/);
        const colorMatch = firstName.match(/^(.+?\s+)?(blue|red|green|yellow|purple|pink|orange|teal|black|white|gold|silver|navy|maroon|lime|cyan)\s*(.*?)$/i);

        if (colorMatch) {
            // Color-based naming: "Blue Bus" → Red Bus, Green Bus...
            const prefix = (colorMatch[1] || '').trim();
            const startColor = colorMatch[2];
            const suffix = (colorMatch[3] || '').trim();
            const startIdx = COLOR_SEQUENCE.findIndex(c => c.toLowerCase() === startColor.toLowerCase());
            for (let i = 0; i < count; i++) {
                const colorName = COLOR_SEQUENCE[(startIdx >= 0 ? startIdx : 0) + i] || COLOR_SEQUENCE[i % COLOR_SEQUENCE.length];
                const hexColor = COLOR_NAME_MAP[colorName.toLowerCase()] || BUS_COLORS[i % BUS_COLORS.length];
                const name = (prefix ? prefix + ' ' : '') + colorName + (suffix ? ' ' + suffix : '');
                results.push({ name, color: hexColor });
            }
        } else if (numMatch) {
            // Numbered: "Bus 1" → Bus 2, Bus 3...
            const prefix = numMatch[1];
            const startNum = parseInt(numMatch[2]);
            for (let i = 0; i < count; i++) {
                results.push({ name: prefix + (startNum + i), color: BUS_COLORS[(D.buses.length + i) % BUS_COLORS.length] });
            }
        } else {
            // Letter-based: "Van A" → Van B, Van C... or just numbered fallback
            const letterMatch = firstName.match(/^(.+?)([A-Z])\s*$/);
            if (letterMatch) {
                const prefix = letterMatch[1];
                const startChar = letterMatch[2].charCodeAt(0);
                for (let i = 0; i < count; i++) {
                    results.push({ name: prefix + String.fromCharCode(startChar + i), color: BUS_COLORS[(D.buses.length + i) % BUS_COLORS.length] });
                }
            } else {
                for (let i = 0; i < count; i++) {
                    results.push({ name: firstName + (i > 0 ? ' ' + (i + 1) : ''), color: BUS_COLORS[(D.buses.length + i) % BUS_COLORS.length] });
                }
            }
        }
        return results;
    }
    function editBus(id) { openBusModal(id); }
    function deleteBusFromModal() {
        if (!_editBusId) return;
        const b = D.buses.find(x => x.id === _editBusId);
        if (!b || !confirm('Delete "' + b.name + '"?')) return;
        D.buses = D.buses.filter(x => x.id !== _editBusId);
        D.monitors.forEach(m => { if (m.assignedBus === _editBusId) m.assignedBus = ''; });
        D.counselors.forEach(c => { if (c.assignedBus === _editBusId) c.assignedBus = ''; });
        save(); closeModal('busModal'); renderFleet(); renderStaff(); updateStats(); updateBusSelects(); toast('Deleted');
    }
    function deleteBus(id) { const b = D.buses.find(x => x.id === id); if (!b || !confirm('Delete "' + b.name + '"?')) return; D.buses = D.buses.filter(x => x.id !== id); D.monitors.forEach(m => { if (m.assignedBus === id) m.assignedBus = ''; }); D.counselors.forEach(c => { if (c.assignedBus === id) c.assignedBus = ''; }); save(); renderFleet(); renderStaff(); updateStats(); updateBusSelects(); toast('Deleted'); }
    function updateBusSelects() { ['monitorBusAssign', 'counselorBusAssign'].forEach(sid => { const s = document.getElementById(sid); if (!s) return; const cur = s.value; s.innerHTML = '<option value="">— Later —</option>' + D.buses.map(b => '<option value="' + esc(b.id) + '"' + (b.id === cur ? ' selected' : '') + '>' + esc(b.name) + '</option>').join(''); }); }

    // =========================================================================
    // SHIFTS
    // =========================================================================
    function renderShifts() {
        const container = document.getElementById('shiftsContainer'), empty = document.getElementById('shiftsEmptyState');
        if (!D.shifts.length) {
            // No shifts = single shift with all campers (default behavior)
            document.getElementById('shiftCount').textContent = '1 shift (default)';
            empty.style.display = 'none';
            const isArrival = D.activeMode === 'arrival';
            const camperCount = Object.keys(getRoster()).length || Object.keys(D.addresses).length;
            container.innerHTML = '<div style="padding:1rem;background:var(--blue-50,#eff6ff);border:1px solid var(--blue-100,#dbeafe);border-radius:8px;font-size:.8125rem;color:var(--text-secondary)"><strong style="color:var(--blue-600)">Default: Single Shift</strong> — All ' + camperCount + ' campers in one run. ' + (isArrival ? 'Arrive by 8:00 AM.' : 'Depart at 4:00 PM.') + ' <strong>Add a shift only if your buses do multiple runs</strong> (e.g., Freshies first, then Juniors).</div>';
            return;
        }
        document.getElementById('shiftCount').textContent = D.shifts.length + ' shift' + (D.shifts.length !== 1 ? 's' : '');
        empty.style.display = 'none';
        const divNames = getDivisionNames();
        const struct = getStructure();
        container.innerHTML = D.shifts.map((sh, idx) => {
            if (!sh.grades) sh.grades = {};
            const divChips = divNames.map(dName => {
                const isActive = (sh.divisions || []).includes(dName);
                const color = struct[dName]?.color || '#888';
                const gradeNames = Object.keys(struct[dName]?.grades || {}).sort();
                const gradeMode = sh.grades[dName];
                let gradeHtml = '';
                if (isActive && gradeNames.length > 1) {
                    const allGrades = !gradeMode || gradeMode === 'all';
                    gradeHtml = '<div style="display:flex;flex-wrap:wrap;gap:.25rem;margin-top:.375rem;margin-left:1.5rem;">' +
                        '<span class="division-chip' + (allGrades ? ' active' : '') + '" style="font-size:.65rem;padding:.15rem .5rem;" onclick="CampistryGo.setShiftGradeMode(\'' + sh.id + '\',\'' + esc(dName.replace(/'/g, "\\'")) + '\',\'all\')">All Grades</span>' +
                        gradeNames.map(g => {
                            const gActive = allGrades || (Array.isArray(gradeMode) && gradeMode.includes(g));
                            return '<span class="division-chip' + (gActive ? ' active' : '') + '" style="font-size:.65rem;padding:.15rem .5rem;" onclick="CampistryGo.toggleShiftGrade(\'' + sh.id + '\',\'' + esc(dName.replace(/'/g, "\\'")) + '\',\'' + esc(g.replace(/'/g, "\\'")) + '\')">' + esc(g) + '</span>';
                        }).join('') + '</div>';
                }
                return '<div><span class="division-chip' + (isActive ? ' active' : '') + '" onclick="CampistryGo.toggleShiftDiv(\'' + sh.id + '\',\'' + esc(dName.replace(/'/g, "\\'")) + '\')"><span class="chip-dot" style="background:' + esc(color) + '"></span>' + esc(dName) + '</span>' + gradeHtml + '</div>';
            }).join('');
            const camperCount = countCampersForShift(sh);
            const isArrival = D.activeMode === 'arrival';
            const timeLabel = isArrival ? 'Arrive by:' : 'Depart:';
            if (!sh.assignedBuses) sh.assignedBuses = D.buses.map(b => b.id);
            const busChips = D.buses.map(b => {
                const active = sh.assignedBuses.includes(b.id);
                return '<span class="division-chip' + (active ? ' active' : '') + '" style="font-size:.65rem;padding:.15rem .5rem;" onclick="CampistryGo.toggleShiftBus(\'' + sh.id + '\',\'' + b.id + '\')"><span class="chip-dot" style="background:' + esc(b.color || '#10b981') + '"></span>' + esc(b.name) + '</span>';
            }).join('');
            const busCount = sh.assignedBuses.length;
            const busSection = D.buses.length ? '<div style="margin-top:.5rem;border-top:1px solid var(--border-light);padding-top:.5rem;"><div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.375rem;"><span style="font-size:.75rem;font-weight:600;color:var(--text-secondary);">Buses (' + busCount + '/' + D.buses.length + '):</span><span class="division-chip' + (busCount === D.buses.length ? ' active' : '') + '" style="font-size:.6rem;padding:.1rem .4rem;" onclick="CampistryGo.setAllShiftBuses(\'' + sh.id + '\')">All</span></div><div style="display:flex;flex-wrap:wrap;gap:.25rem;">' + busChips + '</div></div>' : '';
            return '<div class="shift-card"><div class="shift-card-header"><div class="shift-card-title"><span class="shift-num">' + (idx + 1) + '</span><input type="text" class="form-input" value="' + esc(sh.label || '') + '" placeholder="Shift name" style="max-width:200px;font-size:.875rem;font-weight:700;padding:.25rem .5rem;border:1px solid transparent;" onfocus="this.style.borderColor=\'var(--border-medium)\'" onblur="this.style.borderColor=\'transparent\';CampistryGo.renameShift(\'' + sh.id + '\',this.value)"><span style="font-size:.75rem;font-weight:400;color:var(--text-muted);">' + camperCount + ' campers</span></div><div style="display:flex;align-items:center;gap:.5rem;"><label style="font-size:.75rem;font-weight:600;color:var(--text-secondary)">' + timeLabel + '</label><input type="time" class="form-input" value="' + esc(sh.departureTime || (isArrival ? '08:00' : '16:00')) + '" style="width:110px;padding:.35rem .5rem;font-size:.8125rem;" onchange="CampistryGo.updateShiftTime(\'' + sh.id + '\',this.value)"><button class="btn btn-ghost btn-sm" style="color:var(--red-500);" onclick="CampistryGo.deleteShift(\'' + sh.id + '\')">Remove</button></div></div><div style="display:flex;flex-direction:column;gap:.375rem;">' + (divNames.length ? divChips : '<span style="font-size:.8125rem;color:var(--text-muted)">No divisions in Campistry Me</span>') + '</div>' + busSection + '</div>';
        }).join('');
    }

    function countCampersForShift(sh) {
        const roster = getRoster(); const divs = sh.divisions || []; if (!divs.length) return 0;
        return Object.values(roster).filter(c => { if (!divs.includes(c.division)) return false; const gm = sh.grades?.[c.division]; if (!gm || gm === 'all') return true; if (Array.isArray(gm)) return gm.includes(c.grade); return true; }).length;
    }
    function camperMatchesShift(camper, shift) {
        if (!(shift.divisions || []).includes(camper.division)) return false;
        const gm = shift.grades?.[camper.division]; if (!gm || gm === 'all') return true; if (Array.isArray(gm)) return gm.includes(camper.grade); return true;
    }
    function addShift() {
        const idx = D.shifts.length + 1; const isArrival = D.activeMode === 'arrival'; const defaultTime = isArrival ? '08:00' : '16:00';
        const prevTime = D.shifts.length ? D.shifts[D.shifts.length - 1].departureTime : defaultTime;
        const prevMin = parseTime(prevTime); const newMin = isArrival ? prevMin - 45 : prevMin + 45;
        const h = Math.floor(Math.max(0, newMin) / 60), m = Math.max(0, newMin) % 60;
        const newTime = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
        D.shifts.push({ id: uid(), label: 'Shift ' + idx, divisions: [], grades: {}, departureTime: newTime, assignedBuses: D.buses.map(b => b.id) });
        save(); renderShifts(); updateStats(); toast('Shift added');
    }
    function deleteShift(id) { D.shifts = D.shifts.filter(s => s.id !== id); save(); renderShifts(); updateStats(); toast('Shift removed'); }
    function toggleShiftDiv(shiftId, divName) {
        const sh = D.shifts.find(s => s.id === shiftId); if (!sh) return;
        if (!sh.divisions) sh.divisions = []; if (!sh.grades) sh.grades = {};
        D.shifts.forEach(s => { if (s.id !== shiftId) { s.divisions = (s.divisions || []).filter(d => d !== divName); if (s.grades) delete s.grades[divName]; } });
        const idx = sh.divisions.indexOf(divName);
        if (idx >= 0) { sh.divisions.splice(idx, 1); delete sh.grades[divName]; } else { sh.divisions.push(divName); sh.grades[divName] = 'all'; }
        save(); renderShifts();
    }
    function toggleShiftGrade(shiftId, divName, gradeName) {
        const sh = D.shifts.find(s => s.id === shiftId); if (!sh) return; if (!sh.grades) sh.grades = {};
        const struct = getStructure(); const allGrades = Object.keys(struct[divName]?.grades || {});
        if (!sh.grades[divName] || sh.grades[divName] === 'all') { sh.grades[divName] = allGrades.filter(g => g !== gradeName); }
        else { const arr = sh.grades[divName]; const gi = arr.indexOf(gradeName); if (gi >= 0) { arr.splice(gi, 1); if (!arr.length) arr.push(allGrades[0] || gradeName); } else arr.push(gradeName); if (arr.length >= allGrades.length) sh.grades[divName] = 'all'; }
        save(); renderShifts();
    }
    function setShiftGradeMode(shiftId, divName, mode) { const sh = D.shifts.find(s => s.id === shiftId); if (!sh) return; if (!sh.grades) sh.grades = {}; sh.grades[divName] = mode; save(); renderShifts(); }
    function updateShiftTime(id, val) { const sh = D.shifts.find(s => s.id === id); if (sh) { sh.departureTime = val; save(); } }
    function toggleShiftBus(shiftId, busId) { const sh = D.shifts.find(s => s.id === shiftId); if (!sh) return; if (!sh.assignedBuses) sh.assignedBuses = D.buses.map(b => b.id); const idx = sh.assignedBuses.indexOf(busId); if (idx >= 0) { if (sh.assignedBuses.length > 1) sh.assignedBuses.splice(idx, 1); } else sh.assignedBuses.push(busId); save(); renderShifts(); }
    function setAllShiftBuses(shiftId) { const sh = D.shifts.find(s => s.id === shiftId); if (!sh) return; sh.assignedBuses = D.buses.map(b => b.id); save(); renderShifts(); }
    function renameShift(id, val) { const sh = D.shifts.find(s => s.id === id); if (sh) { sh.label = val.trim(); save(); } }

    // =========================================================================
    // STAFF (Monitors + Counselors)
    // =========================================================================
    function renderStaff() { renderMonitors(); renderCounselors(); document.getElementById('staffCount').textContent = (D.monitors.length + D.counselors.length) + ' staff'; }
    function renderMonitors() {
        const tbody = document.getElementById('monitorTableBody'), empty = document.getElementById('monitorEmptyState');
        const tw = tbody?.closest('.table-wrapper');
        document.getElementById('monitorCount').textContent = D.monitors.length;
        if (!D.monitors.length) { if (tw) tw.style.display = 'none'; if (empty) empty.style.display = ''; return; }
        if (tw) tw.style.display = ''; if (empty) empty.style.display = 'none';
        tbody.innerHTML = D.monitors.map(m => { const bus = D.buses.find(b => b.id === m.assignedBus); return '<tr><td style="font-weight:600">' + esc(m.name) + '</td><td>' + (esc(m.address) || '—') + '</td><td>' + (esc(m.phone) || '—') + '</td><td>' + (bus ? '<span style="display:inline-flex;align-items:center;gap:6px"><span style="width:10px;height:10px;border-radius:50%;background:' + esc(bus.color) + '"></span>' + esc(bus.name) + '</span>' : '—') + '</td><td><div style="display:flex;gap:4px"><button class="btn btn-ghost btn-sm" onclick="CampistryGo.editMonitor(\'' + m.id + '\')">Edit</button><button class="btn btn-ghost btn-sm" style="color:var(--red-500)" onclick="CampistryGo.deleteMonitor(\'' + m.id + '\')">×</button></div></td></tr>'; }).join('');
    }
    function renderCounselors() {
        const tbody = document.getElementById('counselorTableBody'), empty = document.getElementById('counselorEmptyState');
        const tw = tbody?.closest('.table-wrapper');
        document.getElementById('counselorCount').textContent = D.counselors.length;
        if (!D.counselors.length) { if (tw) tw.style.display = 'none'; if (empty) empty.style.display = ''; return; }
        if (tw) tw.style.display = ''; if (empty) empty.style.display = 'none';
        tbody.innerHTML = D.counselors.map(c => { const bus = D.buses.find(b => b.id === c.assignedBus); return '<tr><td style="font-weight:600">' + esc(c.name) + '</td><td>' + (esc(c.address) || '—') + '</td><td>' + (esc(c.bunk) || '—') + '</td><td>' + (c.needsStop === 'yes' ? '<span class="badge badge-warning">Yes</span>' : '<span class="badge badge-neutral">No</span>') + '</td><td>' + (bus ? '<span style="display:inline-flex;align-items:center;gap:6px"><span style="width:10px;height:10px;border-radius:50%;background:' + esc(bus.color) + '"></span>' + esc(bus.name) + '</span>' : '—') + '</td><td><div style="display:flex;gap:4px"><button class="btn btn-ghost btn-sm" onclick="CampistryGo.editCounselor(\'' + c.id + '\')">Edit</button><button class="btn btn-ghost btn-sm" style="color:var(--red-500)" onclick="CampistryGo.deleteCounselor(\'' + c.id + '\')">×</button></div></td></tr>'; }).join('');
    }
    function openMonitorModal(eId) { _editMonitorId = eId || null; document.getElementById('monitorModalTitle').textContent = eId ? 'Edit Monitor' : 'Add Monitor'; updateBusSelects(); const m = eId ? D.monitors.find(x => x.id === eId) : null; document.getElementById('monitorName').value = m?.name || ''; document.getElementById('monitorAddress').value = m?.address || ''; document.getElementById('monitorPhone').value = m?.phone || ''; document.getElementById('monitorBusAssign').value = m?.assignedBus || ''; openModal('monitorModal'); document.getElementById('monitorName').focus(); }
    function saveMonitor() { const n = document.getElementById('monitorName')?.value.trim(); if (!n) { toast('Enter name', 'error'); return; } const a = document.getElementById('monitorAddress')?.value.trim(), p = document.getElementById('monitorPhone')?.value.trim(), b = document.getElementById('monitorBusAssign')?.value || ''; if (_editMonitorId) { const m = D.monitors.find(x => x.id === _editMonitorId); if (m) { m.name = n; m.address = a; m.phone = p; m.assignedBus = b; } } else D.monitors.push({ id: uid(), name: n, address: a, phone: p, assignedBus: b }); save(); closeModal('monitorModal'); renderStaff(); renderFleet(); updateStats(); toast(_editMonitorId ? 'Updated' : 'Monitor added'); }
    function editMonitor(id) { openMonitorModal(id); }
    function deleteMonitor(id) { const m = D.monitors.find(x => x.id === id); if (!m || !confirm('Delete "' + m.name + '"?')) return; D.monitors = D.monitors.filter(x => x.id !== id); save(); renderStaff(); renderFleet(); updateStats(); toast('Deleted'); }
    function openCounselorModal(eId) { _editCounselorId = eId || null; document.getElementById('counselorModalTitle').textContent = eId ? 'Edit Counselor' : 'Add Counselor'; updateBusSelects(); const c = eId ? D.counselors.find(x => x.id === eId) : null; document.getElementById('counselorName').value = c?.name || ''; document.getElementById('counselorAddress').value = c?.address || ''; document.getElementById('counselorBunk').value = c?.bunk || ''; document.getElementById('counselorNeedsStop').value = c?.needsStop || 'no'; document.getElementById('counselorBusAssign').value = c?.assignedBus || ''; openModal('counselorModal'); document.getElementById('counselorName').focus(); }
    function saveCounselor() { const n = document.getElementById('counselorName')?.value.trim(); if (!n) { toast('Enter name', 'error'); return; } const a = document.getElementById('counselorAddress')?.value.trim(), b = document.getElementById('counselorBunk')?.value.trim(), ns = document.getElementById('counselorNeedsStop')?.value || 'no', bus = document.getElementById('counselorBusAssign')?.value || ''; if (_editCounselorId) { const c = D.counselors.find(x => x.id === _editCounselorId); if (c) { c.name = n; c.address = a; c.bunk = b; c.needsStop = ns; c.assignedBus = bus; } } else D.counselors.push({ id: uid(), name: n, address: a, bunk: b, needsStop: ns, assignedBus: bus }); save(); closeModal('counselorModal'); renderStaff(); renderFleet(); updateStats(); toast(_editCounselorId ? 'Updated' : 'Counselor added'); }
    function editCounselor(id) { openCounselorModal(id); }
    function deleteCounselor(id) { const c = D.counselors.find(x => x.id === id); if (!c || !confirm('Delete "' + c.name + '"?')) return; D.counselors = D.counselors.filter(x => x.id !== id); save(); renderStaff(); renderFleet(); updateStats(); toast('Deleted'); }

    // =========================================================================
    // ADDRESSES
    // =========================================================================
    let _addrSort = { col: 'last', dir: 'asc' };

    function sortAddresses(col) {
        if (_addrSort.col === col) _addrSort.dir = _addrSort.dir === 'asc' ? 'desc' : 'asc';
        else { _addrSort.col = col; _addrSort.dir = 'asc'; }
        renderAddresses();
    }

    function renderAddresses() {
        const roster = getRoster();
        const allNames = new Set(Object.keys(roster));
        Object.keys(D.addresses).forEach(n => allNames.add(n));

        // Build row data
        let rows = [...allNames].map(n => {
            const c = roster[n] || {}; const a = D.addresses[n] || {};
            const parts = n.split(/\s+/);
            const first = parts[0] || '';
            const last = parts.slice(1).join(' ') || '';
            return {
                name: n, first, last,
                id: c.camperId || a._camperId || 0,
                division: c.division || a._division || '',
                grade: c.grade || a._grade || '',
                bunk: c.bunk || a._bunk || '',
                street: a.street || '', city: a.city || '', state: a.state || '', zip: a.zip || '',
                geocoded: !!a.geocoded, zipMismatch: !!a._zipMismatch,
                geocodeWarning: a._geocodeWarning || '',
                hasAddr: !!a.street
            };
        });

        // Filter
        const filter = (document.getElementById('addressSearch')?.value || '').toLowerCase().trim();
        if (filter) rows = rows.filter(r => r.name.toLowerCase().includes(filter) || r.first.toLowerCase().includes(filter) || r.last.toLowerCase().includes(filter) || r.division.toLowerCase().includes(filter) || r.grade.toLowerCase().includes(filter) || r.bunk.toLowerCase().includes(filter) || r.street.toLowerCase().includes(filter) || r.city.toLowerCase().includes(filter));

        // Sort
        const dir = _addrSort.dir === 'asc' ? 1 : -1;
        const sc = _addrSort.col;
        rows.sort((a, b) => {
            let av, bv;
            if (sc === 'id') { av = a.id; bv = b.id; return (av - bv) * dir; }
            if (sc === 'first') { av = a.first.toLowerCase(); bv = b.first.toLowerCase(); }
            else if (sc === 'last') { av = a.last.toLowerCase(); bv = b.last.toLowerCase(); }
            else if (sc === 'division') { av = a.division.toLowerCase(); bv = b.division.toLowerCase(); }
            else if (sc === 'grade') { av = a.grade.toLowerCase(); bv = b.grade.toLowerCase(); }
            else if (sc === 'bunk') { av = a.bunk.toLowerCase(); bv = b.bunk.toLowerCase(); }
            else if (sc === 'address') { av = a.street.toLowerCase(); bv = b.street.toLowerCase(); }
            else if (sc === 'status') { av = a.geocoded ? 1 : a.hasAddr ? 0 : -1; bv = b.geocoded ? 1 : b.hasAddr ? 0 : -1; return (av - bv) * dir; }
            else { av = a.last.toLowerCase(); bv = b.last.toLowerCase(); }
            if (av < bv) return -1 * dir; if (av > bv) return 1 * dir; return 0;
        });

        const total = [...allNames].length;
        const tbody = document.getElementById('addressTableBody'), empty = document.getElementById('addressEmptyState');
        const tw = tbody?.closest('.table-wrapper');
        document.getElementById('addressCount').textContent = filter ? rows.length + ' of ' + total : total;
        if (!total) { if (tw) tw.style.display = 'none'; if (empty) empty.style.display = ''; updateAddrProgress(0, 0); return; }
        if (tw) tw.style.display = ''; if (empty) empty.style.display = 'none';
        let withAddr = 0; rows.forEach(r => { if (r.hasAddr) withAddr++; });
        updateAddrProgress(withAddr, total);

        // Update header arrows
        document.querySelectorAll('#addressTableBody')?.forEach(() => {});
        const thead = tbody?.closest('table')?.querySelector('thead');
        if (thead) {
            const cols = ['id','last','first','division','grade','bunk','address','status'];
            thead.querySelectorAll('th').forEach((th, i) => {
                if (i < cols.length) {
                    const arrow = _addrSort.col === cols[i] ? (_addrSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
                    const base = th.textContent.replace(/ [▲▼]$/, '');
                    th.textContent = base + arrow;
                }
            });
        }

        tbody.innerHTML = rows.map(r => {
            const full = r.hasAddr ? [r.street, r.city, r.state, r.zip].filter(Boolean).join(', ') : '';
            const badge = r.hasAddr ? (r.geocodeWarning ? '<span class="badge badge-danger" title="' + esc(r.geocodeWarning) + '">⚠ Rejected</span>' : r.geocoded ? (r.zipMismatch ? '<span class="badge badge-warning" title="ZIP mismatch">⚠ Check</span>' : '<span class="badge badge-success">Geocoded</span>') : '<span class="badge badge-warning">Not geocoded</span>') : '<span class="badge badge-danger">Missing</span>';
            return '<tr><td style="font-size:.75rem;color:var(--text-muted);font-family:monospace;">' + (r.id ? '#' + String(r.id).padStart(4, '0') : '') + '</td><td style="font-weight:600">' + esc(r.last) + '</td><td>' + esc(r.first) + '</td><td>' + (esc(r.division) || '—') + '</td><td>' + (esc(r.grade) || '—') + '</td><td>' + (esc(r.bunk) || '—') + '</td><td>' + (full ? esc(full) : '<span style="color:var(--text-muted)">No address</span>') + '</td><td>' + badge + '</td><td><div style="display:flex;gap:4px;"><button class="btn btn-ghost btn-sm" onclick="CampistryGo.editAddress(\'' + esc(r.name.replace(/'/g, "\\'")) + '\')">' + (r.hasAddr ? 'Edit' : 'Add') + '</button>' + (r.geocoded ? '<button class="btn btn-ghost btn-sm" onclick="CampistryGo.locateCamper(\'' + esc(r.name.replace(/'/g, "\\'")) + '\')" title="Show on map" style="font-size:.7rem;">📍</button>' : '') + '</div></td></tr>';
        }).join('');
    }
    function updateAddrProgress(n, t) { const p = t > 0 ? Math.round(n / t * 100) : 0; document.getElementById('addressProgressBar').style.width = p + '%'; document.getElementById('addressProgressText').textContent = n + ' of ' + t + ' (' + p + '%)'; }
    function editAddress(name) {
        _editCamper = name; const roster = getRoster(), c = roster[name] || {}, a = D.addresses[name] || {};
        document.getElementById('addressCamperName').textContent = name;
        const div = c.division || a._division || '';
        const grade = c.grade || a._grade || '';
        const bunk = c.bunk || a._bunk || '';
        document.getElementById('addressCamperBunk').textContent = [div, grade, bunk].filter(Boolean).join(' / ');
        document.getElementById('addrStreet').value = a.street || ''; document.getElementById('addrCity').value = a.city || '';
        document.getElementById('addrState').value = a.state || 'NY'; document.getElementById('addrZip').value = a.zip || '';
        openModal('addressModal'); document.getElementById('addrStreet').focus();
    }
    function saveAddress() {
        if (!_editCamper) return;
        const st = document.getElementById('addrStreet')?.value.trim(), ci = document.getElementById('addrCity')?.value.trim(), sa = document.getElementById('addrState')?.value.trim().toUpperCase(), z = document.getElementById('addrZip')?.value.trim();
        if (!st) { delete D.addresses[_editCamper]; save(); closeModal('addressModal'); renderAddresses(); updateStats(); toast('Address cleared'); return; }
        D.addresses[_editCamper] = { street: st, city: ci, state: sa, zip: z, lat: null, lng: null, geocoded: false };
        save(); closeModal('addressModal'); renderAddresses(); updateStats(); toast('Saved — geocoding...');
        geocodeOne(_editCamper).then(ok => { if (ok) { save(); renderAddresses(); toast('Geocoded'); } });
    }

    // =========================================================================
    // GEOCODING
    // =========================================================================
    async function geocodeOne(name) {
        const a = D.addresses[name]; if (!a?.street) return false;
        const censusQ = normalizeCensusAddress(a.street, a.city, a.state, a.zip);
        try { const d = await censusGeocode(censusQ); if (d?.result?.addressMatches?.length) { const best = d.result.addressMatches[0]; const clat = best.coordinates.y, clng = best.coordinates.x; if (validateGeocode(clat, clng, q, name)) { a.lat = clat; a.lng = clng; a.geocoded = true; a._zipMismatch = false; a._geocodeSource = 'census'; return true; } } } catch (e) { console.warn('[Go] Census error for', name, e.message); }
        const key = getApiKey(); if (!key) return false;
        const params = { text: q, size: '5', 'boundary.country': 'US' };
        if (_campCoordsCache) { params['focus.point.lat'] = _campCoordsCache.lat; params['focus.point.lon'] = _campCoordsCache.lng; }
        try { const r = await fetch('https://api.openrouteservice.org/geocode/search?' + new URLSearchParams(params), { headers: { 'Authorization': key, 'Accept': 'application/json' } }); if (!r.ok) return false; const d = await r.json(); if (!d.features?.length) return false; let best = null; if (a.zip) best = d.features.find(f => (f.properties?.postalcode || '') === a.zip); if (!best) best = d.features[0]; const co = best.geometry.coordinates; if (!validateGeocode(co[1], co[0], q, name)) return false; a.lng = co[0]; a.lat = co[1]; a.geocoded = true; a._geocodeSource = 'ors'; a._zipMismatch = !!(a.zip && best.properties?.postalcode && best.properties.postalcode !== a.zip); return true; } catch (e) { return false; }
    }

    async function geocodeAll(force) {
        if (!_campCoordsCache && D.setup.campAddress) { toast('Geocoding camp address first...'); const cc = await geocodeSingle(D.setup.campAddress); if (cc) { _campCoordsCache = cc; D.setup.campLat = cc.lat; D.setup.campLng = cc.lng; save(); } }
        const todo = Object.keys(D.addresses).filter(n => { const a = D.addresses[n]; if (!a?.street) return false; if (force) { a.geocoded = false; a.lat = null; a.lng = null; a._zipMismatch = false; return true; } return !a.geocoded; });
        if (!todo.length) { toast('All addresses already geocoded!'); return; }
        toast('Pass 1: Census — ' + todo.length + ' addresses...');
        let censusOk = 0, censusFail = [];
        for (let i = 0; i < todo.length; i++) {
            const name = todo[i]; const a = D.addresses[name]; if (!a?.street) { censusFail.push(name); continue; }
            const censusQ = normalizeCensusAddress(a.street, a.city, a.state, a.zip);
            try { const d = await censusGeocode(censusQ); if (d?.result?.addressMatches?.length) { const best = d.result.addressMatches[0]; const clat = best.coordinates.y, clng = best.coordinates.x; if (validateGeocode(clat, clng, censusQ, name)) { a.lat = clat; a.lng = clng; a.geocoded = true; a._zipMismatch = false; a._geocodeSource = 'census'; censusOk++; } else { censusFail.push(name); a._geocodeWarning = 'Location rejected — too far or invalid'; } } else censusFail.push(name); } catch (e) { censusFail.push(name); }
            if ((i + 1) % 10 === 0 || i === todo.length - 1) { renderAddresses(); updateStats(); toast('Census: ' + censusOk + ' ✓  ' + censusFail.length + ' remaining  (' + (i + 1) + '/' + todo.length + ')'); }
            if (i < todo.length - 1) await new Promise(r => setTimeout(r, 300));
        }
        save();
        if (censusFail.length > 0 && getApiKey()) {
            toast('Pass 2: ORS — ' + censusFail.length + ' addresses...'); let orsOk = 0, orsFail = 0;
            for (let i = 0; i < censusFail.length; i++) {
                const name = censusFail[i]; const a = D.addresses[name]; if (!a?.street || a.geocoded) continue;
                const q = [a.street, a.city, a.state, a.zip].filter(Boolean).join(', ');
                const params = { text: q, size: '5', 'boundary.country': 'US' }; if (_campCoordsCache) { params['focus.point.lat'] = _campCoordsCache.lat; params['focus.point.lon'] = _campCoordsCache.lng; }
                try { const r = await fetch('https://api.openrouteservice.org/geocode/search?' + new URLSearchParams(params), { headers: { 'Authorization': getApiKey(), 'Accept': 'application/json' } }); if (r.ok) { const d = await r.json(); if (d.features?.length) { let best = null; if (a.zip) best = d.features.find(f => (f.properties?.postalcode || '') === a.zip); if (!best) best = d.features[0]; const co = best.geometry.coordinates; if (validateGeocode(co[1], co[0], q, name)) { a.lng = co[0]; a.lat = co[1]; a.geocoded = true; a._geocodeSource = 'ors'; a._zipMismatch = !!(a.zip && best.properties?.postalcode && best.properties.postalcode !== a.zip); orsOk++; } else { orsFail++; a._geocodeWarning = 'Location rejected — too far or invalid'; } } else orsFail++; } else { orsFail++; if (r.status === 429 || r.status === 403) { orsFail += censusFail.length - i - 1; break; } } } catch (e) { orsFail++; }
                if ((i + 1) % 5 === 0 || i === censusFail.length - 1) { renderAddresses(); updateStats(); toast('ORS: ' + orsOk + ' ✓  ' + orsFail + ' ✗  (' + (i + 1) + '/' + censusFail.length + ')'); }
                if (i < censusFail.length - 1) await new Promise(r => setTimeout(r, 1500));
            }
            save(); renderAddresses(); updateStats();
            const totalOk = censusOk + orsOk, totalFail = censusFail.length - orsOk;
            if (totalFail > 0) toast(totalOk + ' geocoded, ' + totalFail + ' failed', 'error');
            else toast('All ' + totalOk + ' geocoded!');
        } else {
            renderAddresses(); updateStats();
            if (censusFail.length > 0) toast(censusOk + ' geocoded, ' + censusFail.length + ' failed', 'error');
            else toast('All ' + censusOk + ' geocoded via Census!');
        }
    }

    async function geocodeSingle(addr) {
        // For single address string, do basic cleanup before Census
        const cleanAddr = (addr || '').replace(/\s*[,#]\s*(apt|suite|ste|unit|fl|floor|rm|room)\.?\s*\S*/gi, '').replace(/\s+/g, ' ').trim();
        try { const d = await censusGeocode(cleanAddr); if (d?.result?.addressMatches?.length) { const m = d.result.addressMatches[0]; return { lat: m.coordinates.y, lng: m.coordinates.x }; } } catch (_) {}
        const key = getApiKey(); if (!key) return null;
        try { const r = await fetch('https://api.openrouteservice.org/geocode/search?' + new URLSearchParams({ text: addr, size: '1', 'boundary.country': 'US' }), { headers: { 'Authorization': key, 'Accept': 'application/json' } }); if (!r.ok) return null; const d = await r.json(); if (d.features?.length) { const co = d.features[0].geometry.coordinates; return { lat: co[1], lng: co[0] }; } } catch (_) {} return null;
    }

    // =========================================================================
    // SYSTEM CHECK
    // =========================================================================
    async function systemCheck() {
        let pass = 0, fail = 0, warn = 0;
        function P(msg) { pass++; console.log('✅ ' + msg); } function F(msg) { fail++; console.log('❌ ' + msg); } function Wr(msg) { warn++; console.log('⚠️  ' + msg); }
        console.log('\n╔══════════════════════════════════════╗\n║   CAMPISTRY GO v4.0 — SYSTEM CHECK   ║\n╚══════════════════════════════════════╝\n');
        const roster = getRoster(); const cc = Object.keys(roster).length;
        cc > 0 ? P('Roster: ' + cc + ' campers') : F('Roster: EMPTY');
        const ac = Object.keys(D.addresses).length, gc = Object.values(D.addresses).filter(a => a.geocoded).length;
        ac > 0 ? P('Addresses: ' + ac) : F('Addresses: NONE'); gc > 0 ? P('Geocoded: ' + gc + '/' + ac) : F('Geocoded: 0');
        P('Mode: ' + D.activeMode); D.buses.length > 0 ? P('Buses: ' + D.buses.length) : F('Buses: NONE');
        D.setup.campAddress ? P('Camp: ' + D.setup.campAddress) : F('Camp address: NOT SET');
        const key = getApiKey(); key ? P('ORS key: set') : Wr('ORS key: not set — VROOM optimization will not work');
        if (key) { try { const r = await fetch('https://api.openrouteservice.org/optimization', { method: 'POST', headers: { 'Authorization': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ jobs: [{ id: 1, location: [-73.747, 40.606], service: 60 }], vehicles: [{ id: 1, profile: 'driving-car', start: [-73.747, 40.606], end: [-73.747, 40.606], capacity: [47] }] }) }); r.ok ? P('VROOM optimization: working') : F('VROOM: HTTP ' + r.status); } catch (e) { F('VROOM: ' + e.message); } }
        try { const tr = await fetch('https://a.tile.openstreetmap.org/0/0/0.png', { method: 'HEAD' }); tr.ok ? P('OSM tiles: OK') : F('OSM tiles: ' + tr.status); } catch (e) { F('OSM tiles: BLOCKED'); }
        console.log('\n' + pass + ' passed | ' + fail + ' failed | ' + warn + ' warnings');
        if (fail === 0) console.log('🟢 System ready!'); else console.log('🔴 Fix ' + fail + ' failure(s)');
    }
    const testGeocode = systemCheck;

    // =========================================================================
    // CSV IMPORT / EXPORT
    // =========================================================================
    function downloadAddressTemplate() {
        const roster = getRoster(); const names = Object.keys(roster).sort();
        // Always download a clean template with 2 example rows
        let csv = '\uFEFFCamper ID,Last Name,First Name,Division,Grade,Bunk,Street Address,City,State,ZIP\n';
        csv += '"0001","Smith","Sarah","Juniors","1st Grade","1A","123 Main Street","Anytown","NY","11559"\n';
        csv += '"0002","Goldberg","Moshe","Seniors","4th Grade","4B","456 Oak Avenue","Woodmere","NY","11598"\n';
        const blob = new Blob([csv], { type: 'text/csv' }); const el = document.createElement('a'); el.href = URL.createObjectURL(blob); el.download = 'campistry_go_addresses.csv'; el.click(); toast('Template downloaded');
    }
    function importAddressCsv() {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = '.csv,.tsv,.txt,.xlsx,.xls';
        inp.onchange = function () {
            if (!inp.files[0]) return;
            const file = inp.files[0];
            const ext = file.name.split('.').pop().toLowerCase();
            if (ext === 'xlsx' || ext === 'xls') {
                // Excel file — read as array buffer and parse
                const r = new FileReader();
                r.onload = e => { parseExcel(e.target.result); };
                r.readAsArrayBuffer(file);
            } else {
                // CSV/TSV/TXT — read as text
                const r = new FileReader();
                r.onload = e => { parseCsv(e.target.result); };
                r.readAsText(file);
            }
        };
        inp.click();
    }

    // Parse Excel (.xlsx) using SheetJS loaded on demand
    async function parseExcel(buffer) {
        // Load SheetJS if not already loaded
        if (!window.XLSX) {
            toast('Loading Excel reader...');
            await new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
                script.onload = resolve;
                script.onerror = () => { toast('Failed to load Excel reader', 'error'); reject(); };
                document.head.appendChild(script);
            });
        }
        try {
            const wb = XLSX.read(buffer, { type: 'array' });
            const ws = wb.Sheets[wb.SheetNames[0]];
            const csvText = XLSX.utils.sheet_to_csv(ws);
            parseCsv(csvText);
        } catch (e) {
            console.error('[Go] Excel parse error:', e);
            toast('Could not read Excel file: ' + e.message, 'error');
        }
    }
    function parseCsv(text) {
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        const lines = text.split(/\r?\n/).filter(l => l.trim()); if (lines.length < 2) { toast('Empty CSV', 'error'); return; }
        const hdr = parseLine(lines[0]).map(h => h.toLowerCase().trim());

        // Detect column indices — support multiple naming conventions
        const idi = hdr.findIndex(h => h === 'camper id' || h === 'id' || h === 'camperid' || h === '#');
        const lni = hdr.findIndex(h => h === 'last name' || h === 'last' || h === 'lastname' || h === 'family name');
        const fni = hdr.findIndex(h => h === 'first name' || h === 'first' || h === 'firstname' || h === 'given name');
        const ni = hdr.findIndex(h => h === 'name' || h === 'camper name' || h === 'camper' || h === 'full name');
        const divi = hdr.findIndex(h => h === 'division' || h === 'div');
        const gri = hdr.findIndex(h => h === 'grade');
        const bki = hdr.findIndex(h => h === 'bunk' || h === 'cabin');
        const si = hdr.findIndex(h => h === 'address' || h.includes('street') || h === 'street address');
        const ci = hdr.findIndex(h => h === 'city' || h === 'city/town' || h === 'town');
        const sti = hdr.findIndex(h => h === 'state');
        const zi = hdr.findIndex(h => h === 'zip' || h === 'zip code' || h === 'zipcode' || h.includes('zip'));
        const tri = hdr.findIndex(h => h === 'transport' || h === 'mode' || h.includes('pickup') || h.includes('carpool'));
        const rwi = hdr.findIndex(h => h === 'ride-with' || h === 'ridewith' || h === 'ride with' || h.includes('pair'));

        // Must have either (first+last) or (full name), plus an address
        const hasFirstLast = fni >= 0 && lni >= 0;
        const hasFullName = ni >= 0;
        if (!hasFirstLast && !hasFullName) { toast('CSV needs either "First Name" + "Last Name" columns, or a "Name" column', 'error'); return; }
        if (si < 0) { toast('CSV needs an "Address" or "Street Address" column', 'error'); return; }

        // Full overwrite — clear all existing data
        D.addresses = {};
        _goStandaloneRoster = {};
        D.savedRoutes = null;
        _generatedRoutes = null;
        _detectedRegions = null;
        _slicedZones = null;
        let up = 0;

        for (let i = 1; i < lines.length; i++) {
            const cols = parseLine(lines[i]);

            // Build full name
            let name = '';
            if (hasFirstLast) {
                const first = (cols[fni] || '').trim();
                const last = (cols[lni] || '').trim();
                if (!first && !last) continue;
                name = first + (last ? ' ' + last : '');
            } else {
                name = (cols[ni] || '').trim();
                if (!name) continue;
            }

            // Try to match existing roster name (case-insensitive)
            const meRoster = readCampistrySettings()?.app1?.camperRoster || {};
            const rn = Object.keys(meRoster).find(k => k.toLowerCase() === name.toLowerCase()) || name;

            const street = (cols[si] || '').trim();
            if (!street) continue;

            const camperId = idi >= 0 ? (cols[idi] || '').trim() : '';
            const division = divi >= 0 ? (cols[divi] || '').trim() : '';
            const grade = gri >= 0 ? (cols[gri] || '').trim() : '';
            const bunk = bki >= 0 ? (cols[bki] || '').trim() : '';
            const transport = tri >= 0 ? (cols[tri] || '').trim().toLowerCase() : 'bus';
            const rideWith = rwi >= 0 ? (cols[rwi] || '').trim() : '';

            D.addresses[rn] = {
                street,
                city: ci >= 0 ? (cols[ci] || '').trim() : '',
                state: sti >= 0 ? (cols[sti] || '').trim().toUpperCase() : 'NY',
                zip: zi >= 0 ? (cols[zi] || '').trim() : '',
                lat: null, lng: null, geocoded: false,
                transport: (transport === 'pickup' || transport === 'carpool') ? 'pickup' : 'bus',
                rideWith: rideWith,
                _camperId: camperId ? parseInt(camperId) : 0,
                _division: division,
                _grade: grade,
                _bunk: bunk
            };

            // Build standalone roster entry (for when Me has no data)
            _goStandaloneRoster[rn] = {
                camperId: camperId ? parseInt(camperId) : i,
                division: division, grade: grade, bunk: bunk
            };

            up++;
        }
        save(); renderAddresses(); updateStats();
        const meCount = Object.keys(readCampistrySettings()?.app1?.camperRoster || {}).length;
        if (meCount === 0 && up > 0) {
            console.log('[Go] Standalone mode: ' + up + ' campers imported directly into Go');
            toast(up + ' campers imported (standalone mode)');
        } else {
            toast(up + ' addresses imported');
        }
    }
    function parseLine(line) { const r = []; let cur = '', inQ = false; for (let i = 0; i < line.length; i++) { const ch = line[i]; if (inQ) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += ch; } else { if (ch === '"') inQ = true; else if (ch === ',' || ch === '\t') { r.push(cur); cur = ''; } else cur += ch; } } r.push(cur); return r; }
    function updateStats() {
        const roster = getRoster();
        const addrCount = Object.keys(D.addresses).length;
        const rosterCount = Object.keys(roster).length;
        // Use whichever is larger — roster from Me or addresses in Go
        const c = Math.max(rosterCount, addrCount);
        let wA = 0; Object.keys(D.addresses).forEach(n => { if (D.addresses[n]?.street) wA++; });
        document.getElementById('statBuses').textContent = D.buses.length;
        document.getElementById('statCampers').textContent = c;
        document.getElementById('statShifts').textContent = D.shifts.length;
        document.getElementById('statAddresses').textContent = wA + '/' + c;
    }

    // =========================================================================
    // PREFLIGHT
    // =========================================================================
    function runPreflight() {
        const roster = getRoster(); const camperCount = Object.keys(roster).length;
        let geocoded = 0; Object.keys(roster).forEach(n => { if (D.addresses[n]?.geocoded) geocoded++; });
        const rs = parseInt(document.getElementById('routeReserveSeats')?.value) || D.setup.reserveSeats || 0;
        let totalSeats = 0; D.buses.forEach(b => { const m = D.monitors.find(x => x.assignedBus === b.id); const co = D.counselors.filter(x => x.assignedBus === b.id); const brs = getBusReserve(b); totalSeats += Math.max(0, (b.capacity || 0) - (m ? 1 : 0) - co.length - brs); });
        let inShifts = 0;
        if (D.shifts.length) {
            Object.entries(roster).forEach(([n, c]) => { if (D.shifts.some(sh => camperMatchesShift(c, sh))) inShifts++; });
        } else {
            inShifts = camperCount; // default single shift = all campers
        }
        const largestShift = D.shifts.length ? Math.max(...D.shifts.map(s => countCampersForShift(s))) : camperCount;
        let pickupCount = 0; Object.keys(roster).forEach(n => { if (D.addresses[n]?.transport === 'pickup') pickupCount++; });
        const checks = [
            { label: D.buses.length + ' bus(es)', status: D.buses.length > 0 ? 'ok' : 'fail' },
            { label: D.shifts.length ? D.shifts.length + ' shift(s)' : '1 shift (default — all campers)', status: 'ok' },
            { label: inShifts + '/' + camperCount + ' campers in shifts', status: inShifts === camperCount && camperCount > 0 ? 'ok' : inShifts > 0 ? 'warn' : 'fail' },
            { label: geocoded + '/' + camperCount + ' geocoded', status: geocoded === camperCount && camperCount > 0 ? 'ok' : geocoded > 0 ? 'warn' : 'fail' },
            { label: totalSeats + ' seats for ' + largestShift + ' in largest shift', status: 'ok' },
            { label: D.setup.campAddress ? 'Camp address set' : 'No camp address', status: D.setup.campAddress ? 'ok' : 'warn' },
            { label: getApiKey() ? 'ORS key set (VROOM enabled)' : 'No ORS key — VROOM disabled', status: getApiKey() ? 'ok' : 'fail', detail: getApiKey() ? '' : 'VROOM optimization requires an ORS API key' },
            { label: pickupCount + ' carpool/pickup (excluded)', status: 'ok' }
        ];
        const anyFail = checks.some(c => c.status === 'fail'); const canGen = D.buses.length > 0 && geocoded > 0 && getApiKey();
        const badge = document.getElementById('preflightStatus'); badge.className = 'badge ' + (anyFail ? 'badge-danger' : canGen ? 'badge-success' : 'badge-warning'); badge.textContent = anyFail ? 'Not ready' : 'Ready';
        document.getElementById('preflightBody').innerHTML = checks.map(c => '<div class="preflight-item preflight-' + c.status + '"><div class="preflight-icon">' + (c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : '✗') + '</div><div><div style="font-weight:600;color:var(--text-primary)">' + esc(c.label) + '</div>' + (c.detail ? '<div style="font-size:.75rem;color:var(--text-muted)">' + esc(c.detail) + '</div>' : '') + '</div></div>').join('');
        document.getElementById('routeMode').value = D.setup.dropoffMode || 'door-to-door';
        document.getElementById('routeReserveSeats').value = D.setup.reserveSeats ?? 2;
        const btn = document.getElementById('generateRoutesBtn'); btn.disabled = !canGen; btn.style.opacity = canGen ? '1' : '0.5';
    }

    // =========================================================================
    // REGION DETECTION (ZIP-based)
    // =========================================================================
    function detectRegions() {
        const roster = getRoster(); const zipGroups = {};
        Object.keys(roster).forEach(name => { const a = D.addresses[name]; if (!a?.geocoded || !a.lat || !a.lng) return; if (a.transport === 'pickup') return; const zip = (a.zip || '').trim(); if (!zip) return; if (!zipGroups[zip]) zipGroups[zip] = { campers: [], cities: {} }; zipGroups[zip].campers.push({ name, lat: a.lat, lng: a.lng, city: a.city || '', division: roster[name].division || '' }); const city = a.city || 'Unknown'; zipGroups[zip].cities[city] = (zipGroups[zip].cities[city] || 0) + 1; });
        if (!Object.keys(zipGroups).length) { toast('No geocoded campers with ZIP codes', 'error'); return; }
        const clusters = [];
        Object.entries(zipGroups).forEach(([zip, data]) => { const campers = data.campers; const regionName = Object.keys(data.cities).sort((a, b) => data.cities[b] - data.cities[a])[0] || zip; const cLat = campers.reduce((s, c) => s + c.lat, 0) / campers.length; const cLng = campers.reduce((s, c) => s + c.lng, 0) / campers.length; clusters.push({ id: 'zip_' + zip, name: regionName + ' (' + zip + ')', color: REGION_COLORS[clusters.length % REGION_COLORS.length], centroidLat: cLat, centroidLng: cLng, camperNames: campers.map(c => c.name), zip: zip }); });
        clusters.sort((a, b) => b.camperNames.length - a.camperNames.length);
        _detectedRegions = clusters; _detectedRadius = null; renderRegionPreview();
        console.log('[Go] ZIP-based regions:'); clusters.forEach(r => console.log('[Go]   ' + r.name + ': ' + r.camperNames.length + ' campers'));
        toast(clusters.length + ' regions from ZIP codes');
    }

    function renderRegionPreview() {
        const body = document.getElementById('regionPreviewBody');
        if (!_detectedRegions?.length) { body.innerHTML = '<div style="text-align:center;padding:1.5rem;color:var(--text-muted);">No regions detected yet</div>'; return; }
        const roster = getRoster(); const rs = parseInt(document.getElementById('routeReserveSeats')?.value) || D.setup.reserveSeats || 0;
        let perBusCap = 0; if (D.buses.length) { let tc = 0; D.buses.forEach(b => { const m = D.monitors.find(x => x.assignedBus === b.id); const co = D.counselors.filter(x => x.assignedBus === b.id); const brs = getBusReserve(b); tc += Math.max(0, (b.capacity || 0) - (m ? 1 : 0) - co.length - brs); }); perBusCap = Math.floor(tc / D.buses.length); }
        let html = '';
        _detectedRegions.forEach(reg => {
            const shiftBadges = D.shifts.map(sh => { let count = 0; reg.camperNames.forEach(n => { const c = roster[n]; if (c && camperMatchesShift(c, sh)) count++; }); const busesNeeded = perBusCap > 0 ? Math.ceil(count / perBusCap) : '?'; return '<span class="region-shift-badge">' + esc(sh.label || 'Shift') + ': <strong>' + count + '</strong> → ' + busesNeeded + ' bus(es)</span>'; }).join('');
            html += '<div class="region-row"><span class="region-dot" style="background:' + esc(reg.color) + '"></span><span class="region-name">' + esc(reg.name) + '</span><span style="font-weight:600;min-width:40px;text-align:center">' + reg.camperNames.length + '</span><div class="region-counts">' + shiftBadges + '</div></div>';
        });
        html = '<div style="margin-bottom:.75rem;font-size:.8125rem;color:var(--text-secondary);"><strong>' + _detectedRegions.length + '</strong> regions from <strong>' + _detectedRegions.reduce((s, r) => s + r.camperNames.length, 0) + '</strong> addresses. <strong>' + D.buses.length + '</strong> bus(es).</div>' + html;
        body.innerHTML = html;
    }

    function assignBusesToRegions(vehicles, regions, shifts) {
        const roster = getRoster(); const perBusCap = vehicles.length ? Math.floor(vehicles.reduce((s, v) => s + v.capacity, 0) / vehicles.length) : 30;
        const demand = {}; shifts.forEach(sh => { demand[sh.id] = {}; regions.forEach(reg => { let count = 0; reg.camperNames.forEach(n => { const c = roster[n]; if (c && camperMatchesShift(c, sh)) count++; }); demand[sh.id][reg.id] = Math.ceil(count / Math.max(1, perBusCap)); }); });
        const assignments = {}; let prevAssign = {};
        shifts.forEach((sh, si) => {
            assignments[sh.id] = {}; regions.forEach(reg => { assignments[sh.id][reg.id] = []; });
            const needed = demand[sh.id]; const currAssign = {}; const usedBuses = new Set();
            if (si === 0) {
                const regionsBySize = [...regions].sort((a, b) => (needed[b.id] || 0) - (needed[a.id] || 0)); let busIdx = 0;
                regionsBySize.forEach(reg => { const n = needed[reg.id] || 0; for (let i = 0; i < n && busIdx < vehicles.length; i++) { const v = vehicles[busIdx]; assignments[sh.id][reg.id].push(v.busId); currAssign[v.busId] = reg.id; busIdx++; } });
                while (busIdx < vehicles.length) { const v = vehicles[busIdx]; const bestReg = regions.reduce((best, reg) => (needed[reg.id] || 0) > (needed[best.id] || 0) ? reg : best, regions[0]); assignments[sh.id][bestReg.id].push(v.busId); currAssign[v.busId] = bestReg.id; busIdx++; }
            } else {
                const remaining = { ...needed };
                vehicles.forEach(v => { const prevRegion = prevAssign[v.busId]; if (prevRegion && remaining[prevRegion] > 0) { assignments[sh.id][prevRegion].push(v.busId); currAssign[v.busId] = prevRegion; usedBuses.add(v.busId); remaining[prevRegion]--; } });
                const unassigned = vehicles.filter(v => !usedBuses.has(v.busId));
                regions.filter(r => (remaining[r.id] || 0) > 0).forEach(reg => { while ((remaining[reg.id] || 0) > 0 && unassigned.length > 0) { let bestIdx = 0, bestDist = Infinity; unassigned.forEach((v, i) => { const prevReg = prevAssign[v.busId]; const prevRegObj = prevReg ? regions.find(r => r.id === prevReg) : null; const d = prevRegObj ? haversineMi(prevRegObj.centroidLat, prevRegObj.centroidLng, reg.centroidLat, reg.centroidLng) : 999; if (d < bestDist) { bestDist = d; bestIdx = i; } }); const v = unassigned.splice(bestIdx, 1)[0]; assignments[sh.id][reg.id].push(v.busId); currAssign[v.busId] = reg.id; remaining[reg.id]--; } });
                unassigned.forEach(v => { const biggest = regions.reduce((best, r) => (needed[r.id] || 0) > (needed[best.id] || 0) ? r : best, regions[0]); assignments[sh.id][biggest.id].push(v.busId); currAssign[v.busId] = biggest.id; });
            }
            prevAssign = currAssign;
        });
        _busAssignments = assignments; return assignments;
    }

    // =========================================================================
    // ZONE RECONFIGURATION — sliceRegionsIntoZones()
    //
    // Runs after detectRegions(), before stop creation.
    // Takes raw ZIP regions and produces bus-ready zones using driving-time
    // k-medoids clustering. Replaces the old merge logic, geoBisect,
    // FIX 16 pre-VROOM rebalance, and FIX 18 boundary-swap pass.
    // =========================================================================
    let _slicedZones = null; // result of sliceRegionsIntoZones()
    let _zonePreviewLayers = []; // Leaflet layers for zone preview

    async function sliceRegionsIntoZones(regions, buses, reserveSeats) {
        const roster = getRoster();
        const allCampers = [];

        // Gather all geocoded, bus-riding campers
        Object.keys(roster).forEach(name => {
            const a = D.addresses[name];
            if (!a?.geocoded || !a.lat || !a.lng) return;
            if (a.transport === 'pickup') return;
            allCampers.push({
                name, lat: a.lat, lng: a.lng,
                address: [a.street, a.city, a.state, a.zip].filter(Boolean).join(', '),
                zip: (a.zip || '').trim(),
                division: roster[name].division || '',
                bunk: roster[name].bunk || ''
            });
        });

        if (!allCampers.length) {
            console.error('[Go] Zone: no geocoded campers');
            return null;
        }

        // ── A. Compute capacity budget ──
        const effectiveCaps = buses.map(b => {
            const mon = D.monitors.find(m => m.assignedBus === b.id);
            const couns = D.counselors.filter(c => c.assignedBus === b.id);
            const brs = b.reserveMode === 'custom' && b.reserveSeats != null ? b.reserveSeats : (reserveSeats || 0);
            return Math.max(0, (b.capacity || 0) - (mon ? 1 : 0) - couns.length - brs);
        });
        const totalCapacity = effectiveCaps.reduce((s, c) => s + c, 0);
        let targetFillPct = 0.90;
        if (allCampers.length > totalCapacity * targetFillPct) {
            // Slide toward 100% until all kids fit
            targetFillPct = Math.min(1.0, allCampers.length / totalCapacity);
        }
        if (allCampers.length > totalCapacity) {
            const shortfall = allCampers.length - totalCapacity;
            console.error('[Go] Zone: ABORT — ' + allCampers.length + ' campers but only ' + totalCapacity + ' total capacity (' + shortfall + ' short)');
            toast('Cannot generate zones: ' + shortfall + ' more campers than bus seats', 'error');
            return null;
        }

        const avgEffCap = totalCapacity / buses.length;
        const targetFill = Math.floor(avgEffCap * targetFillPct);
        console.log('[Go] Zone: target fill = ' + targetFill + ' per bus (' + Math.round(targetFillPct * 100) + '% of ' + Math.round(avgEffCap) + ' avg capacity)');

        // ── Detect siblings for indivisible atoms ──
        const sibMap = detectSiblings(allCampers);

        // Build atom groups: siblings + same-house kids move together
        function buildAtoms(campers) {
            const atoms = [];
            const assigned = new Set();
            // Group by sibling ID first
            const sibGroups = {};
            campers.forEach(c => {
                const sid = sibMap[c.name];
                if (sid) {
                    if (!sibGroups[sid]) sibGroups[sid] = [];
                    sibGroups[sid].push(c);
                }
            });
            Object.values(sibGroups).forEach(group => {
                group.forEach(c => assigned.add(c.name));
                atoms.push({ campers: group, size: group.length,
                    lat: group.reduce((s, c) => s + c.lat, 0) / group.length,
                    lng: group.reduce((s, c) => s + c.lng, 0) / group.length
                });
            });
            // Same-house grouping (same lat/lng to 5 decimals)
            const houseGroups = {};
            campers.forEach(c => {
                if (assigned.has(c.name)) return;
                const key = Math.round(c.lat * 100000) + ',' + Math.round(c.lng * 100000);
                if (!houseGroups[key]) houseGroups[key] = [];
                houseGroups[key].push(c);
            });
            Object.values(houseGroups).forEach(group => {
                group.forEach(c => assigned.add(c.name));
                atoms.push({ campers: group, size: group.length,
                    lat: group.reduce((s, c) => s + c.lat, 0) / group.length,
                    lng: group.reduce((s, c) => s + c.lng, 0) / group.length
                });
            });
            return atoms;
        }

        // ── B. Categorize each ZIP region ──
        const wholeZips = [];  // fit in one bus
        const bigZips = [];    // need 2+ buses → slice
        const smallZips = [];  // < 60% of target → absorb

        regions.forEach(reg => {
            const count = reg.camperNames.length;
            if (count === 0) return;
            if (count <= targetFill) {
                if (count < targetFill * 0.60) {
                    smallZips.push(reg);
                    console.log('[Go] Zone: ' + reg.name + ' (' + count + ' kids) → small ZIP, will absorb');
                } else {
                    wholeZips.push(reg);
                    console.log('[Go] Zone: ' + reg.name + ' (' + count + ' kids) → whole ZIP, one zone');
                }
            } else {
                bigZips.push(reg);
                const k = Math.ceil(count / targetFill);
                console.log('[Go] Zone: ' + reg.name + ' (' + count + ' kids) → big ZIP, slicing into ' + k);
            }
        });

        // ── C. Slice big ZIPs using driving-time clustering ──
        const zones = []; // final output: [{name, camperNames, centroidLat, centroidLng, busIdx, regionIds}]

        // Helper: stitch multiple matrix calls for >25 coords into one NxN matrix
        async function fetchLargeMatrix(coords) {
            const n = coords.length;
            if (n <= 25) {
                return await fetchDistanceMatrix(coords);
            }
            // Chunk into groups under 25, run multiple calls, stitch
            console.log('[Go] Zone: stitching matrix for ' + n + ' points (>' + 25 + ')');
            const matrix = Array.from({ length: n }, () => new Array(n).fill(null));
            const CHUNK = 24; // leave room for overhead
            for (let i = 0; i < n; i += CHUNK) {
                for (let j = 0; j < n; j += CHUNK) {
                    const rowEnd = Math.min(i + CHUNK, n);
                    const colEnd = Math.min(j + CHUNK, n);
                    // Build unique index set for this sub-matrix
                    const indices = new Set();
                    for (let r = i; r < rowEnd; r++) indices.add(r);
                    for (let c = j; c < colEnd; c++) indices.add(c);
                    const idxArr = [...indices];
                    if (idxArr.length > 25) {
                        // Too many unique indices — fallback to haversine for this chunk
                        for (let r = i; r < rowEnd; r++) {
                            for (let c = j; c < colEnd; c++) {
                                if (matrix[r][c] === null) {
                                    matrix[r][c] = haversineMi(coords[r].lat, coords[r].lng, coords[c].lat, coords[c].lng) * 3600 / 25;
                                }
                            }
                        }
                        continue;
                    }
                    const subCoords = idxArr.map(idx => coords[idx]);
                    const subMatrix = await fetchDistanceMatrix(subCoords);
                    if (!subMatrix) {
                        // Fallback for this chunk
                        for (let r = i; r < rowEnd; r++) {
                            for (let c = j; c < colEnd; c++) {
                                if (matrix[r][c] === null) {
                                    matrix[r][c] = haversineMi(coords[r].lat, coords[r].lng, coords[c].lat, coords[c].lng) * 3600 / 25;
                                }
                            }
                        }
                        continue;
                    }
                    // Map sub-matrix back to full matrix
                    const idxMap = {};
                    idxArr.forEach((globalIdx, localIdx) => { idxMap[globalIdx] = localIdx; });
                    for (let r = i; r < rowEnd; r++) {
                        for (let c = j; c < colEnd; c++) {
                            const lr = idxMap[r], lc = idxMap[c];
                            if (lr !== undefined && lc !== undefined && subMatrix[lr]?.[lc] != null) {
                                matrix[r][c] = subMatrix[lr][lc];
                            }
                        }
                    }
                }
                // Stagger to avoid rate limiting
                if (i + CHUNK < n) await new Promise(r => setTimeout(r, 200));
            }
            // Fill any remaining nulls with haversine fallback
            for (let r = 0; r < n; r++) {
                for (let c = 0; c < n; c++) {
                    if (matrix[r][c] === null) {
                        matrix[r][c] = haversineMi(coords[r].lat, coords[r].lng, coords[c].lat, coords[c].lng) * 3600 / 25;
                    }
                }
            }
            return matrix;
        }

        // k-medoids with driving-time matrix
        function kMedoids(atoms, durMatrix, k, useDriveTime) {
            const n = atoms.length;
            if (n <= k) return atoms.map((_, i) => [i]);

            // dist helper
            function dist(i, j) {
                if (useDriveTime && durMatrix?.[i]?.[j] != null && durMatrix[i][j] >= 0) return durMatrix[i][j];
                return haversineMi(atoms[i].lat, atoms[i].lng, atoms[j].lat, atoms[j].lng) * 3600 / 25;
            }

            // Seed selection: first two = max pairwise drive time
            const seeds = [];
            let maxD = 0, s1 = 0, s2 = 1;
            for (let i = 0; i < n; i++) {
                for (let j = i + 1; j < n; j++) {
                    const d = dist(i, j);
                    if (d > maxD) { maxD = d; s1 = i; s2 = j; }
                }
            }
            seeds.push(s1, s2);
            // Greedy add remaining seeds
            while (seeds.length < k) {
                let bestIdx = -1, bestMinDist = -1;
                for (let i = 0; i < n; i++) {
                    if (seeds.includes(i)) continue;
                    let minDist = Infinity;
                    seeds.forEach(s => { const d = dist(i, s); if (d < minDist) minDist = d; });
                    if (minDist > bestMinDist) { bestMinDist = minDist; bestIdx = i; }
                }
                if (bestIdx >= 0) seeds.push(bestIdx);
                else break;
            }

            // Assign atoms to nearest medoid
            let assignments = new Array(n).fill(0);
            function assignAll() {
                atoms.forEach((_, i) => {
                    let bestM = 0, bestD = Infinity;
                    seeds.forEach((s, mi) => {
                        const d = dist(i, s);
                        if (d < bestD) { bestD = d; bestM = mi; }
                    });
                    assignments[i] = bestM;
                });
            }
            assignAll();

            // Iterate: recompute medoids, reassign
            for (let iter = 0; iter < 20; iter++) {
                let changed = false;
                // Recompute each medoid
                for (let mi = 0; mi < k; mi++) {
                    const members = [];
                    assignments.forEach((a, i) => { if (a === mi) members.push(i); });
                    if (!members.length) continue;
                    // Find member that minimizes total drive time to all others
                    let bestMed = seeds[mi], bestTotal = Infinity;
                    members.forEach(cand => {
                        let total = 0;
                        members.forEach(m => { if (m !== cand) total += dist(cand, m); });
                        if (total < bestTotal) { bestTotal = total; bestMed = cand; }
                    });
                    if (bestMed !== seeds[mi]) { seeds[mi] = bestMed; changed = true; }
                }
                if (!changed) break;
                // Reassign
                const oldAssign = [...assignments];
                assignAll();
                if (oldAssign.every((a, i) => a === assignments[i])) break;
            }

            // Build clusters
            const clusters = Array.from({ length: k }, () => []);
            assignments.forEach((a, i) => clusters[a].push(i));
            return clusters;
        }

        // Process big ZIPs
        for (const reg of bigZips) {
            const regCampers = allCampers.filter(c => reg.camperNames.includes(c.name));
            const atoms = buildAtoms(regCampers);
            const k = Math.ceil(regCampers.length / targetFill);

            // Build coords for matrix call
            const coords = atoms.map(a => ({ lat: a.lat, lng: a.lng }));

            let durMatrix = null;
            let useDriveTime = true;
            showProgress('Building zone matrix for ' + reg.name + '...', 12);

            try {
                durMatrix = await fetchLargeMatrix(coords);
            } catch (e) {
                console.warn('[Go] Zone: matrix failed for ' + reg.name + ':', e.message);
            }

            if (!durMatrix) {
                useDriveTime = false;
                toast('Zone optimization for ' + reg.name + ': road data unavailable, using approximate distances', 'error');
                console.warn('[Go] Zone: falling back to haversine for ' + reg.name);
            }

            const clusters = kMedoids(atoms, durMatrix, k, useDriveTime);

            clusters.forEach((cluster, ci) => {
                const pocketCampers = [];
                cluster.forEach(ai => atoms[ai].campers.forEach(c => pocketCampers.push(c)));
                if (!pocketCampers.length) return;

                const cLat = pocketCampers.reduce((s, c) => s + c.lat, 0) / pocketCampers.length;
                const cLng = pocketCampers.reduce((s, c) => s + c.lng, 0) / pocketCampers.length;

                // ── F. Naming: most common street or geographic descriptor ──
                const streetCounts = {};
                pocketCampers.forEach(c => {
                    const p = parseAddress(c.address);
                    if (p.street) {
                        const ns = normalizeStreet(p.street);
                        streetCounts[ns] = (streetCounts[ns] || { count: 0, raw: p.street });
                        streetCounts[ns].count++;
                    }
                });
                const sortedStreets = Object.values(streetCounts).sort((a, b) => b.count - a.count);
                const regCity = reg.name.split(' (')[0];
                let zoneName;
                if (sortedStreets.length && sortedStreets[0].count >= pocketCampers.length * 0.25) {
                    zoneName = regCity + ' (' + sortedStreets[0].raw + ' area)';
                } else {
                    // Geographic descriptor based on medoid position relative to ZIP centroid
                    const dLat = cLat - reg.centroidLat;
                    const dLng = cLng - reg.centroidLng;
                    let dir = '';
                    if (Math.abs(dLat) > Math.abs(dLng)) dir = dLat > 0 ? 'North' : 'South';
                    else dir = dLng > 0 ? 'East' : 'West';
                    zoneName = dir + ' ' + regCity;
                }

                zones.push({
                    id: 'zone_' + reg.zip + '_' + ci,
                    name: zoneName,
                    camperNames: pocketCampers.map(c => c.name),
                    centroidLat: cLat,
                    centroidLng: cLng,
                    regionIds: [reg.id],
                    sourceType: 'sliced',
                    color: REGION_COLORS[zones.length % REGION_COLORS.length]
                });
                console.log('[Go] Zone: sliced ' + reg.name + ' pocket ' + ci + ' → "' + zoneName + '" (' + pocketCampers.length + ' kids)');
            });
        }

        // Whole ZIPs become zones unchanged
        wholeZips.forEach(reg => {
            zones.push({
                id: 'zone_' + reg.zip,
                name: reg.name,
                camperNames: [...reg.camperNames],
                centroidLat: reg.centroidLat,
                centroidLng: reg.centroidLng,
                regionIds: [reg.id],
                sourceType: 'whole',
                color: REGION_COLORS[zones.length % REGION_COLORS.length]
            });
        });

        // ── D. Border rebalance for over-capacity pockets ──
        for (let pass = 0; pass < 30; pass++) {
            let anyOver = false;
            for (const zone of zones) {
                if (zone.camperNames.length <= targetFill) continue;
                anyOver = true;

                // Rank campers by distance to zone centroid, farthest first
                const campersWithDist = zone.camperNames.map(name => {
                    const c = allCampers.find(x => x.name === name);
                    if (!c) return { name, dist: 0 };
                    return { name, dist: haversineMi(c.lat, c.lng, zone.centroidLat, zone.centroidLng) };
                }).sort((a, b) => b.dist - a.dist);

                // Median distance — interior threshold
                const dists = campersWithDist.map(c => c.dist).sort((a, b) => a - b);
                const medianDist = dists[Math.floor(dists.length / 2)];

                // Try to move border kids (above median distance)
                let moved = false;
                for (const candidate of campersWithDist) {
                    if (candidate.dist <= medianDist) break; // interior kid
                    if (zone.camperNames.length <= targetFill) break;

                    // Check if this is part of a sibling atom
                    const atomNames = [candidate.name];
                    const sid = sibMap[candidate.name];
                    if (sid) {
                        zone.camperNames.forEach(n => {
                            if (n !== candidate.name && sibMap[n] === sid) atomNames.push(n);
                        });
                    }
                    // Also check same-house
                    const candCamper = allCampers.find(x => x.name === candidate.name);
                    if (candCamper) {
                        const houseKey = Math.round(candCamper.lat * 100000) + ',' + Math.round(candCamper.lng * 100000);
                        zone.camperNames.forEach(n => {
                            if (atomNames.includes(n)) return;
                            const nc = allCampers.find(x => x.name === n);
                            if (nc && Math.round(nc.lat * 100000) + ',' + Math.round(nc.lng * 100000) === houseKey) atomNames.push(n);
                        });
                    }

                    // Find nearest under-capacity zone
                    let bestZone = null, bestDist = Infinity;
                    for (const tz of zones) {
                        if (tz === zone) continue;
                        if (tz.camperNames.length + atomNames.length > targetFill) continue;
                        const d = candCamper ? haversineMi(candCamper.lat, candCamper.lng, tz.centroidLat, tz.centroidLng) : Infinity;
                        if (d < bestDist) { bestDist = d; bestZone = tz; }
                    }

                    if (bestZone) {
                        atomNames.forEach(n => {
                            zone.camperNames = zone.camperNames.filter(x => x !== n);
                            bestZone.camperNames.push(n);
                        });
                        const familyLabel = atomNames.length > 1 ? atomNames[0].split(/\s+/).pop() + ' family + ' + (atomNames.length - 1) : atomNames[0];
                        console.log('[Go] Zone: Moved ' + atomNames.length + ' border kid(s) (' + familyLabel + ') from ' + zone.name + ' to ' + bestZone.name + ' — ' + zone.name + ' was ' + (zone.camperNames.length + atomNames.length) + '/' + targetFill + ', ' + bestZone.name + ' had room at ' + (bestZone.camperNames.length - atomNames.length) + '/' + targetFill + ', drive time ' + bestDist.toFixed(2) + 'mi');
                        moved = true;
                        break;
                    }
                }
                if (!moved) break;
            }
            if (!anyOver) break;
        }

        // ── E. Absorb small ZIPs ──
        for (const smallReg of smallZips) {
            const regCampers = allCampers.filter(c => smallReg.camperNames.includes(c.name));
            if (!regCampers.length) continue;

            const centLat = regCampers.reduce((s, c) => s + c.lat, 0) / regCampers.length;
            const centLng = regCampers.reduce((s, c) => s + c.lng, 0) / regCampers.length;

            // Try at 90%, 95%, 100% fill
            let absorbed = false;
            for (const tryPct of [targetFillPct, 0.95, 1.0]) {
                const tryFill = Math.floor(avgEffCap * tryPct);
                // Find closest pocket with room
                let bestZone = null, bestDist = Infinity;
                for (const z of zones) {
                    if (z.camperNames.length + smallReg.camperNames.length > tryFill) continue;
                    const d = haversineMi(centLat, centLng, z.centroidLat, z.centroidLng);
                    if (d < bestDist) { bestDist = d; bestZone = z; }
                }
                if (bestZone) {
                    const oldName = bestZone.name;
                    bestZone.camperNames.push(...smallReg.camperNames);
                    bestZone.regionIds.push(smallReg.id);
                    // Recalculate centroid
                    const allInZone = allCampers.filter(c => bestZone.camperNames.includes(c.name));
                    if (allInZone.length) {
                        bestZone.centroidLat = allInZone.reduce((s, c) => s + c.lat, 0) / allInZone.length;
                        bestZone.centroidLng = allInZone.reduce((s, c) => s + c.lng, 0) / allInZone.length;
                    }
                    // Rename: two-component max
                    const parts = oldName.split(' + ');
                    const smallCity = smallReg.name.split(' (')[0];
                    if (parts.length >= 2) {
                        bestZone.name = parts[0] + ' + ' + parts[1].split(' +')[0] + ' + others';
                    } else {
                        bestZone.name = oldName.split(' (')[0] + ' + ' + smallCity;
                    }
                    console.log('[Go] Zone: Absorbed ' + smallReg.name + ' (' + smallReg.camperNames.length + ' kids) into ' + oldName + ' → "' + bestZone.name + '" (' + bestZone.camperNames.length + ' kids, ' + bestDist.toFixed(2) + 'mi away)');
                    // List all parts
                    console.log('[Go] Zone:   Parts: ' + bestZone.regionIds.map(id => regions.find(r => r.id === id)?.name || id).join(', '));
                    absorbed = true;
                    break;
                }
            }
            if (!absorbed) {
                console.error('[Go] Zone: ABORT — could not absorb ' + smallReg.name + ' (' + smallReg.camperNames.length + ' kids), no zone has room');
                toast('Cannot absorb ' + smallReg.name + ': no zone has room', 'error');
                return null;
            }
        }

        // ── H. Invariant check ──
        const allZonedNames = new Set();
        let invariantFail = false;
        zones.forEach(z => {
            z.camperNames.forEach(n => {
                if (allZonedNames.has(n)) {
                    console.error('[Go] Zone INVARIANT FAIL: ' + n + ' appears in multiple zones!');
                    invariantFail = true;
                }
                allZonedNames.add(n);
            });
        });
        // Check every input camper is in exactly one zone
        allCampers.forEach(c => {
            if (!allZonedNames.has(c.name)) {
                console.error('[Go] Zone INVARIANT FAIL: ' + c.name + ' missing from all zones!');
                invariantFail = true;
            }
        });
        // Check capacity
        zones.forEach(z => {
            // Find which bus cap to check against — use max single bus effective cap
            const maxBusCap = Math.max(...effectiveCaps);
            if (z.camperNames.length > maxBusCap) {
                console.error('[Go] Zone INVARIANT FAIL: ' + z.name + ' has ' + z.camperNames.length + ' kids but max bus cap is ' + maxBusCap);
                invariantFail = true;
            }
        });

        if (invariantFail) {
            console.error('[Go] Zone: invariant check FAILED — falling back to raw ZIP regions');
            toast('Zone optimization failed invariant check — using raw regions', 'error');
            return null;
        }

        console.log('[Go] Zone: ' + zones.length + ' zones created from ' + regions.length + ' regions, ' + allCampers.length + ' campers');
        zones.forEach(z => console.log('[Go] Zone:   ' + z.name + ': ' + z.camperNames.length + ' kids'));

        _slicedZones = zones;
        return zones;
    }

    // ── Dry-run preview: show zones on map before routing ──
    function clearZonePreview() {
        if (_map) {
            _zonePreviewLayers.forEach(l => _map.removeLayer(l));
        }
        _zonePreviewLayers = [];
        const banner = document.getElementById('zonePreviewBanner');
        if (banner) banner.remove();
    }

    function renderZonePreview(zones) {
        if (!_map || !zones?.length) return;
        clearZonePreview();

        const allLatLngs = [];
        zones.forEach((zone, zi) => {
            const roster = getRoster();
            const camperCoords = zone.camperNames.map(n => {
                const a = D.addresses[n];
                return a?.lat ? [a.lat, a.lng] : null;
            }).filter(Boolean);

            if (!camperCoords.length) return;
            allLatLngs.push(...camperCoords);

            // Draw convex hull polygon
            const hull = convexHull(camperCoords);
            if (hull.length >= 3) {
                const polygon = L.polygon(hull, {
                    color: zone.color || REGION_COLORS[zi % REGION_COLORS.length],
                    weight: 2,
                    fillOpacity: 0.15,
                    dashArray: '5, 5'
                }).addTo(_map);
                polygon.bindPopup('<strong>' + esc(zone.name) + '</strong><br>' + zone.camperNames.length + ' campers');
                _zonePreviewLayers.push(polygon);
            }

            // Label at centroid
            const labelIcon = L.divIcon({
                html: '<div style="background:' + esc(zone.color || REGION_COLORS[zi % REGION_COLORS.length]) + ';color:#fff;padding:4px 8px;border-radius:6px;font-size:11px;font-weight:700;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.3);font-family:DM Sans,sans-serif;">' + esc(zone.name) + ' (' + zone.camperNames.length + ')</div>',
                className: '',
                iconAnchor: [60, 12]
            });
            const label = L.marker([zone.centroidLat, zone.centroidLng], { icon: labelIcon, interactive: false }).addTo(_map);
            _zonePreviewLayers.push(label);

            // Camper dots
            camperCoords.forEach(([lat, lng]) => {
                const dotIcon = L.divIcon({
                    html: '<div style="width:6px;height:6px;background:' + esc(zone.color || REGION_COLORS[zi % REGION_COLORS.length]) + ';border:1px solid #fff;border-radius:50%;"></div>',
                    className: '',
                    iconSize: [6, 6],
                    iconAnchor: [3, 3]
                });
                const dot = L.marker([lat, lng], { icon: dotIcon, interactive: false }).addTo(_map);
                _zonePreviewLayers.push(dot);
            });
        });

        if (allLatLngs.length) {
            _map.fitBounds(L.latLngBounds(allLatLngs), { padding: [50, 50], maxZoom: 14 });
        }
    }

    // Simple convex hull (Graham scan)
    function convexHull(points) {
        if (points.length < 3) return points;
        const pts = points.map(p => ({ x: p[1], y: p[0] })); // lng, lat
        // Find bottom-most (then leftmost)
        let start = 0;
        for (let i = 1; i < pts.length; i++) {
            if (pts[i].y < pts[start].y || (pts[i].y === pts[start].y && pts[i].x < pts[start].x)) start = i;
        }
        [pts[0], pts[start]] = [pts[start], pts[0]];
        const p0 = pts[0];
        pts.sort((a, b) => {
            if (a === p0) return -1;
            if (b === p0) return 1;
            const cross = (a.x - p0.x) * (b.y - p0.y) - (a.y - p0.y) * (b.x - p0.x);
            if (Math.abs(cross) < 1e-12) {
                const dA = (a.x - p0.x) ** 2 + (a.y - p0.y) ** 2;
                const dB = (b.x - p0.x) ** 2 + (b.y - p0.y) ** 2;
                return dA - dB;
            }
            return -cross;
        });
        const stack = [pts[0], pts[1]];
        for (let i = 2; i < pts.length; i++) {
            while (stack.length > 1) {
                const top = stack[stack.length - 1], sec = stack[stack.length - 2];
                const cross = (top.x - sec.x) * (pts[i].y - sec.y) - (top.y - sec.y) * (pts[i].x - sec.x);
                if (cross <= 0) stack.pop();
                else break;
            }
            stack.push(pts[i]);
        }
        return stack.map(p => [p.y, p.x]); // back to [lat, lng]
    }

    // Show zone preview and wait for user confirmation
    function showZonePreviewModal(zones) {
        return new Promise((resolve) => {
            // Ensure map is visible
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            document.querySelector('.tab-btn[data-tab="routes"]')?.classList.add('active');
            document.getElementById('tab-routes')?.classList.add('active');

            // Initialize map if needed
            if (!_map) {
                const container = document.getElementById('routeMap');
                if (container) {
                    _map = L.map(container, { scrollWheelZoom: true, zoomControl: true });
                    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OSM', maxZoom: 19 }).addTo(_map);
                }
            }
            if (_map) {
                setTimeout(() => _map.invalidateSize(), 100);
            }

            // Add camp marker
            if (_map && _campCoordsCache) {
                const campIcon = L.divIcon({ html: '<div style="width:32px;height:32px;background:#1e293b;border:3px solid #fff;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,.4);"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></div>', className: '', iconSize: [32, 32], iconAnchor: [16, 16] });
                const campMarker = L.marker([_campCoordsCache.lat, _campCoordsCache.lng], { icon: campIcon, zIndexOffset: 1000 }).addTo(_map);
                campMarker.bindPopup('<strong>' + esc(D.setup.campName || 'Camp') + '</strong>');
                _zonePreviewLayers.push(campMarker);
            }

            // Render zones on map
            setTimeout(() => renderZonePreview(zones), 200);

            // Build zone summary
            const zoneList = zones.map((z, i) => {
                const color = z.color || REGION_COLORS[i % REGION_COLORS.length];
                return '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border-light);font-size:.8125rem;">'
                    + '<span style="width:12px;height:12px;border-radius:50%;background:' + esc(color) + ';flex-shrink:0;"></span>'
                    + '<strong>' + esc(z.name) + '</strong>'
                    + '<span style="margin-left:auto;font-weight:600;">' + z.camperNames.length + ' kids</span></div>';
            }).join('');

            // Create banner
            const banner = document.createElement('div');
            banner.id = 'zonePreviewBanner';
            banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:10000;background:var(--bg-primary,#fff);border-bottom:3px solid var(--blue-500,#3b82f6);box-shadow:0 4px 20px rgba(0,0,0,.15);padding:1rem 1.5rem;display:flex;align-items:flex-start;gap:1.5rem;';
            banner.innerHTML = '<div style="flex:1;max-height:60vh;overflow-y:auto;">'
                + '<h3 style="margin:0 0 .5rem;font-size:1.1rem;">Zone Preview — ' + zones.length + ' zones, ' + zones.reduce((s, z) => s + z.camperNames.length, 0) + ' campers</h3>'
                + '<p style="margin:0 0 .75rem;font-size:.8125rem;color:var(--text-muted);">Review the proposed bus zones on the map. Each zone will be served by one bus.</p>'
                + '<div style="max-height:300px;overflow-y:auto;">' + zoneList + '</div>'
                + '</div>'
                + '<div style="display:flex;flex-direction:column;gap:8px;flex-shrink:0;">'
                + '<button id="zonePreviewConfirm" style="padding:10px 24px;border-radius:8px;border:none;background:var(--blue-600,#2563eb);color:#fff;cursor:pointer;font-size:.9rem;font-weight:700;">Looks good — generate routes</button>'
                + '<button id="zonePreviewCancel" style="padding:10px 24px;border-radius:8px;border:1px solid var(--border-primary,#d1d5db);background:var(--bg-primary,#fff);cursor:pointer;font-size:.9rem;">Cancel</button>'
                + '</div>';
            document.body.appendChild(banner);

            document.getElementById('zonePreviewConfirm').addEventListener('click', () => {
                clearZonePreview();
                resolve(true);
            });
            document.getElementById('zonePreviewCancel').addEventListener('click', () => {
                clearZonePreview();
                resolve(false);
            });
        });
    }

    // =========================================================================
    // ROUTING ENGINE v10.1 — VROOM-powered
    //
    // v10.1 changes: OSRM retry, aggressive rebalancing, Manhattan walk distance
    // =========================================================================

    async function generateRoutes() {
        // Clear intersection cache on each generation so fresh data is fetched
        // for the full service area (not stale single-region data)
        _intersectionCache = null;

        const roster = getRoster();
        const mode = document.getElementById('routeMode')?.value || 'door-to-door';
        const reserveSeats = parseInt(document.getElementById('routeReserveSeats')?.value) || 0;
        const avgStopMin = D.setup.avgStopTime || 2;
        const avgSpeedMph = D.setup.avgSpeed || 25;
        const key = getApiKey();
        if (!key) { toast('ORS API key required for VROOM optimization', 'error'); return; }

        if (!_detectedRegions?.length) detectRegions();
        if (!_detectedRegions?.length) { toast('No regions detected', 'error'); return; }

        const vehicles = D.buses.map(b => {
            const mon = D.monitors.find(m => m.assignedBus === b.id);
            const couns = D.counselors.filter(c => c.assignedBus === b.id);
            const brs = getBusReserve(b);
            return { busId: b.id, name: b.name, color: b.color || '#10b981', capacity: Math.max(0, (b.capacity || 0) - (mon ? 1 : 0) - couns.length - brs), monitor: mon, counselors: couns };
        });

        let campCoords = null;
        if (D.setup.campAddress) {
            showProgress('Geocoding camp...', 5);
            campCoords = _campCoordsCache || await geocodeSingle(D.setup.campAddress);
            if (campCoords) { _campCoordsCache = campCoords; D.setup.campLat = campCoords.lat; D.setup.campLng = campCoords.lng; }
        }
        const campLat = campCoords?.lat || _detectedRegions[0].centroidLat;
        const campLng = campCoords?.lng || _detectedRegions[0].centroidLng;

        // ── Zone Reconfiguration Step ──
        showProgress('Building bus zones...', 10);
        const zones = await sliceRegionsIntoZones(_detectedRegions, D.buses, reserveSeats);
        const useZones = zones && zones.length > 0;

        if (useZones) {
            // Zone preview logged to console — proceed directly to route generation
            console.log('[Go] Zone preview: ' + zones.length + ' zones ready, proceeding to route generation');
            toast(zones.length + ' bus zones created — generating routes...');
        }

        // Fall back to old region-based assignments if zones failed
        if (!useZones) {
            console.warn('[Go] Zone optimization failed — using raw ZIP regions');
        }

        const assignments = useZones ? null : assignBusesToRegions(vehicles, _detectedRegions, D.shifts);

        const allShiftResults = [];
        const shifts = D.shifts.length ? D.shifts : [{ id: '__all__', label: 'All Campers', divisions: [], departureTime: D.activeMode === 'arrival' ? '07:00' : '16:00', _isVirtual: true }];

        for (let si = 0; si < shifts.length; si++) {
            const shift = shifts[si];
            const pctBase = (si / shifts.length) * 100;
            showProgress((shift.label || 'Shift ' + (si + 1)) + ': creating stops...', pctBase + 10);

            const shiftBusIds = shift.assignedBuses?.length ? shift.assignedBuses : vehicles.map(v => v.busId);
            const shiftVehicles = shiftBusIds.map(bid => vehicles.find(v => v.busId === bid)).filter(Boolean);

            const allCampers = [];
            Object.keys(roster).forEach(name => {
                const c = roster[name]; const a = D.addresses[name];
                if (!c || !a?.geocoded || !a.lat || !a.lng) return;
                if (a.transport === 'pickup') return;
                if (shift._isVirtual || camperMatchesShift(c, shift)) {
                    allCampers.push({ name, division: c.division, bunk: c.bunk || '', lat: a.lat, lng: a.lng, address: [a.street, a.city, a.state, a.zip].filter(Boolean).join(', ') });
                }
            });

            let routes = [];
            if (allCampers.length && shiftVehicles.length) {
                routes = await solveWithVROOM(allCampers, shiftVehicles, campLat, campLng, mode, key, shift, si, shifts.length, useZones ? zones : null);
            }

            // Add monitor stops (counselors handled post-generation)
            routes.forEach(r => {
                if (r.monitor?.address) r.stops.push({ stopNum: r.stops.length + 1, campers: [], address: r.monitor.address, lat: null, lng: null, isMonitor: true, monitorName: r.monitor.name });
            });

            // Calculate ETAs
            const isArrival = D.activeMode === 'arrival';
            const hasShifts = shifts.length > 1;
            const isLastShift = si === shifts.length - 1;
            const shiftNeedsReturn = hasShifts && !isLastShift;
            const timeMin = parseTime(shift.departureTime || (isArrival ? '08:00' : '16:00'));

            for (const r of routes) {
                if (!r.stops.length) continue;
                const mx = r._osrmMatrix;

                function driveMin(stopA, stopB) {
                    if (mx && stopA._matrixIdx != null && stopB._matrixIdx != null) {
                        const val = mx[stopA._matrixIdx]?.[stopB._matrixIdx];
                        if (val != null && val >= 0) return val / 60;
                    }
                    if (stopA.lat && stopB.lat) return (haversineMi(stopA.lat, stopA.lng, stopB.lat, stopB.lng) / avgSpeedMph) * 60;
                    return 3;
                }
                function campToStop(stop) {
                    if (mx && stop._matrixIdx != null) {
                        const val = mx[0]?.[stop._matrixIdx];
                        if (val != null && val >= 0) return val / 60;
                    }
                    if (stop.lat && _campCoordsCache) return (haversineMi(_campCoordsCache.lat, _campCoordsCache.lng, stop.lat, stop.lng) / avgSpeedMph) * 60;
                    return 15;
                }
                function stopToCamp(stop) {
                    if (mx && stop._matrixIdx != null) {
                        const val = mx[stop._matrixIdx]?.[0];
                        if (val != null && val >= 0) return val / 60;
                    }
                    if (stop.lat && _campCoordsCache) return (haversineMi(stop.lat, stop.lng, _campCoordsCache.lat, _campCoordsCache.lng) / avgSpeedMph) * 60;
                    return 15;
                }

                if (isArrival) {
                    let totalDur = 0;
                    for (let i = 0; i < r.stops.length; i++) {
                        if (i === 0) totalDur += campToStop(r.stops[0]);
                        else totalDur += driveMin(r.stops[i - 1], r.stops[i]);
                        totalDur += avgStopMin;
                    }
                    totalDur += stopToCamp(r.stops[r.stops.length - 1]);
                    let cum = timeMin - totalDur;
                    for (let i = 0; i < r.stops.length; i++) {
                        if (i === 0) cum += campToStop(r.stops[0]);
                        else cum += driveMin(r.stops[i - 1], r.stops[i]);
                        cum += avgStopMin;
                        r.stops[i].estimatedTime = formatTime(cum);
                        r.stops[i].estimatedMin = cum;
                    }
                    r.totalDuration = Math.round(totalDur);
                } else {
                    let cum = timeMin;
                    for (let i = 0; i < r.stops.length; i++) {
                        if (i === 0) cum += campToStop(r.stops[0]);
                        else cum += driveMin(r.stops[i - 1], r.stops[i]);
                        cum += avgStopMin;
                        r.stops[i].estimatedTime = formatTime(cum);
                        r.stops[i].estimatedMin = cum;
                    }
                    r.totalDuration = Math.round(cum - timeMin);
                    if (shiftNeedsReturn && r.stops.length > 0) {
                        r.returnTocamp = Math.round(stopToCamp(r.stops[r.stops.length - 1]));
                        r.totalDuration += r.returnTocamp;
                    }
                }
                r.camperCount = r.stops.reduce((s, st) => s + st.campers.length, 0);
                r.stops.forEach(s => { delete s._matrixIdx; });
                delete r._osrmMatrix;
            }

            allShiftResults.push({ shift, routes, camperCount: routes.reduce((s, r) => s + r.camperCount, 0) });
        }

        _generatedRoutes = allShiftResults;
        _routeGeomCache = {}; window._routeGeomCache = _routeGeomCache;
        D.savedRoutes = allShiftResults;
        save();
        showProgress('Done!', 100);
        setTimeout(() => { hideProgress(); renderRouteResults(applyOverrides(allShiftResults)); }, 400);
    }

    // =========================================================================
    // VROOM SOLVER — the core engine
    // =========================================================================
    async function solveWithVROOM(campers, vehicles, campLat, campLng, mode, apiKey, shift, shiftIdx, totalShifts, zones) {
        const isArrival = D.activeMode === 'arrival';
        const hasShifts = totalShifts > 1;
        const isLastShift = shiftIdx === totalShifts - 1;
        const needsReturn = hasShifts && !isLastShift; // last shift doesn't come back
        const numBuses = vehicles.length;
        const serviceTime = (D.setup.avgStopTime || 2) * 60;

        // Phase 1: Create stops PER REGION
        // Each ZIP region gets its own density radius — Inwood (dense grid)
        // produces tighter clusters than Hewlett (suburban cul-de-sacs).
        let stops = [];
        if (_detectedRegions?.length && mode !== 'door-to-door') {
            // Group campers by their ZIP region
            const campersByRegion = {};
            _detectedRegions.forEach(reg => { campersByRegion[reg.id] = []; });
            campers.forEach(c => {
                let bestReg = _detectedRegions[0].id;
                _detectedRegions.forEach(reg => { if (reg.camperNames.includes(c.name)) bestReg = reg.id; });
                if (!campersByRegion[bestReg]) campersByRegion[bestReg] = [];
                campersByRegion[bestReg].push(c);
            });

            // Pre-fetch intersections for ALL campers at once (corner-stops mode)
            // so the bbox covers the entire service area, not just one ZIP region.
            // Without this, the first region's fetch populates the cache, and
            // subsequent regions (e.g., Hewlett) reuse that cache which only
            // covers the first region's area — resulting in address ranges
            // instead of intersection names.
            if (mode === 'corner-stops' && !_intersectionCache) {
                showProgress('Fetching real intersections...', 15);
                const allIntersections = await fetchIntersections(campers);
                if (allIntersections?.length) {
                    _intersectionCache = allIntersections;
                    try { localStorage.setItem('campistry_go_intersections', JSON.stringify({ intersections: allIntersections, timestamp: Date.now() })); } catch (_) {}
                    console.log('[Go] OSM: ' + allIntersections.length + ' real intersections (full service area)');
                }
            }

            // Create stops per region — each with its own density
            for (const [regId, regCampers] of Object.entries(campersByRegion)) {
                if (!regCampers.length) continue;
                const regName = _detectedRegions.find(r => r.id === regId)?.name || regId;
                let regionStops;
                if (mode === 'optimized-stops') regionStops = createOptimizedStops(regCampers);
                else if (mode === 'corner-stops') regionStops = await createCornerStops(regCampers);
                else regionStops = createHouseStops(regCampers);
                console.log('[Go]   ' + regName + ': density → ' + regionStops.length + ' stops from ' + regCampers.length + ' campers');
                stops.push(...regionStops);
            }
        } else {
            // Single region or door-to-door — create globally
            if (mode === 'optimized-stops') stops = createOptimizedStops(campers);
            else if (mode === 'corner-stops') stops = await createCornerStops(campers);
            else stops = createHouseStops(campers);
        }
        if (!stops.length) return [];

        // FIX 14: Use user's maxWalkDistance setting instead of hard-coded 500ft
        const MAX_WALK_FT = (D.setup.maxWalkDistance && D.setup.maxWalkDistance > 0) ? D.setup.maxWalkDistance : 500;

        // Post-clustering deduplication (~200ft)
        const dedupDist = 0.038;
        let dedups = 0;
        for (let i = 0; i < stops.length; i++) {
            for (let j = i + 1; j < stops.length; j++) {
                if (haversineMi(stops[i].lat, stops[i].lng, stops[j].lat, stops[j].lng) <= dedupDist) {
                    // Don't merge if any kid would walk > MAX_WALK_FT to combined stop
                    const keepLat = stops[i].lat, keepLng = stops[i].lng;
                    let tooFar = false;
                    for (const c of [...stops[i].campers, ...stops[j].campers]) {
                        const a = D.addresses[c.name];
                        if (a?.lat && a.lng && manhattanMi(a.lat, a.lng, keepLat, keepLng) * 5280 > MAX_WALK_FT) {
                            tooFar = true; break;
                        }
                    }
                    if (tooFar) continue;
                    stops[i].campers.push(...stops[j].campers);
                    if (stops[j].address.includes('&') && !stops[i].address.includes('&')) stops[i].address = stops[j].address;
                    stops.splice(j, 1);
                    j--; dedups++;
                }
            }
        }
        if (dedups) console.log('[Go] Dedup: merged ' + dedups + ' nearby duplicate stop(s)');

        // ── Walk audit: split stops where any kid walks too far ──
        // The cluster centroid may be close to all kids, but the actual stop
        // (at an intersection) can be at one end of a long street cluster.
        let walkSplits = 0;
        for (let i = 0; i < stops.length; i++) {
            const st = stops[i];
            if (st.campers.length <= 1) continue; // can't split a single kid

            // Check max walk from any kid to this stop
            let maxWalk = 0;
            st.campers.forEach(c => {
                const a = D.addresses[c.name];
                if (!a?.lat || !a.lng || !st.lat || !st.lng) return;
                const ft = manhattanMi(a.lat, a.lng, st.lat, st.lng) * 5280;
                if (ft > maxWalk) maxWalk = ft;
            });

            if (maxWalk <= MAX_WALK_FT) continue;

            // Split: sort kids by walk distance, move far half to a new stop
            const withDist = st.campers.map(c => {
                const a = D.addresses[c.name];
                const ft = (a?.lat && st.lat) ? manhattanMi(a.lat, a.lng, st.lat, st.lng) * 5280 : 0;
                return { camper: c, ft, lat: a?.lat || st.lat, lng: a?.lng || st.lng };
            }).sort((a, b) => a.ft - b.ft);

            const keepCount = Math.ceil(withDist.length / 2);
            const keepKids = withDist.slice(0, keepCount);
            const moveKids = withDist.slice(keepCount);

            if (!moveKids.length) continue;

            // New stop at median of moved kids' homes
            const mLats = moveKids.map(k => k.lat).sort((a, b) => a - b);
            const mLngs = moveKids.map(k => k.lng).sort((a, b) => a - b);
            const newLat = mLats[Math.floor(mLats.length / 2)];
            const newLng = mLngs[Math.floor(mLngs.length / 2)];

            // Update original stop
            st.campers = keepKids.map(k => k.camper);

            // Create new stop
            const newStop = {
                lat: newLat, lng: newLng,
                address: st.address + ' (split)',
                campers: moveKids.map(k => k.camper)
            };
            stops.splice(i + 1, 0, newStop);
            walkSplits++;
            i++; // skip the new stop
        }
        if (walkSplits) console.log('[Go] Walk audit: split ' + walkSplits + ' stop(s) where kids walked > ' + MAX_WALK_FT + 'ft');

        console.log('[Go] VROOM Engine: ' + stops.length + ' stops, ' + numBuses + ' buses, mode=' + mode);


        // ══════════════════════════════════════════════════════════════
        // ZONE-BASED or LEGACY REGION-BASED BUS ASSIGNMENT
        //
        // Zone path (v4.0): zones are pre-decided, one bus per zone,
        //   VROOM only orders stops within each zone.
        // Legacy path: old region merge + geoBisect (fallback only).
        // ══════════════════════════════════════════════════════════════

        showProgress('Assigning buses to zones...', 25);

        let allRoutes = [];

        if (zones && zones.length > 0) {
            // ══════════════════════════════════════════════════════════════
            // ZONE PATH — v4.0 zone-based routing
            //
            // Each zone gets one bus. VROOM only orders stops, no
            // assignment decisions needed.
            // ══════════════════════════════════════════════════════════════
            showProgress('Optimizing routes (VROOM)...', 35);

            // Filter zones to this shift's campers
            const shiftCamperNames = new Set(campers.map(c => c.name));
            const shiftZones = zones.map(z => ({
                ...z,
                camperNames: z.camperNames.filter(n => shiftCamperNames.has(n))
            })).filter(z => z.camperNames.length > 0);

            // Sort zones by size (biggest first), assign biggest bus to biggest zone
            shiftZones.sort((a, b) => b.camperNames.length - a.camperNames.length);
            const sortedVehicles = [...vehicles].sort((a, b) => b.capacity - a.capacity);

            // Assign one bus per zone
            const zoneAssignments = [];
            for (let i = 0; i < shiftZones.length && i < sortedVehicles.length; i++) {
                zoneAssignments.push({ zone: shiftZones[i], vehicle: sortedVehicles[i] });
            }
            // Any extra zones go to the bus with most remaining capacity
            for (let i = sortedVehicles.length; i < shiftZones.length; i++) {
                // Merge into nearest zone that has a bus
                const z = shiftZones[i];
                let bestIdx = 0, bestDist = Infinity;
                for (let j = 0; j < zoneAssignments.length; j++) {
                    const d = haversineMi(z.centroidLat, z.centroidLng, zoneAssignments[j].zone.centroidLat, zoneAssignments[j].zone.centroidLng);
                    if (d < bestDist) { bestDist = d; bestIdx = j; }
                }
                zoneAssignments[bestIdx].zone.camperNames.push(...z.camperNames);
                console.log('[Go] Zone overflow: merged ' + z.name + ' into ' + zoneAssignments[bestIdx].zone.name);
            }

            // Log zone→bus assignment
            zoneAssignments.forEach(za => {
                console.log('[Go]   Zone "' + za.zone.name + '": ' + za.zone.camperNames.length + ' kids → ' + za.vehicle.name + ' (cap ' + za.vehicle.capacity + ')');
            });

            // Create stops PER ZONE, then VROOM order each
            const zonePromises = zoneAssignments.map(async (za) => {
                const zoneCampers = za.zone.camperNames.map(n => campers.find(c => c.name === n)).filter(Boolean);
                if (!zoneCampers.length) return null;

                // Create stops for this zone
                let zoneStops;
                if (mode === 'optimized-stops') zoneStops = createOptimizedStops(zoneCampers);
                else if (mode === 'corner-stops') zoneStops = await createCornerStops(zoneCampers);
                else zoneStops = createHouseStops(zoneCampers);

                if (!zoneStops.length) return null;

                console.log('[Go]   Zone "' + za.zone.name + '": ' + zoneStops.length + ' stops from ' + zoneCampers.length + ' campers');

                // VROOM call: one bus, just ordering
                const jobs = zoneStops.map((stop, i) => ({
                    id: i + 1,
                    location: [stop.lng, stop.lat],
                    service: serviceTime,
                    amount: [stop.campers.length],
                    description: stop.address
                }));

                const v = za.vehicle;
                const veh = { id: 1, profile: 'driving-car', capacity: [v.capacity], description: v.name };
                if (isArrival) {
                    let fIdx = 0, fDist = 0;
                    zoneStops.forEach((s, i) => {
                        const d = haversineMi(campLat, campLng, s.lat, s.lng);
                        if (d > fDist) { fDist = d; fIdx = i; }
                    });
                    veh.start = [zoneStops[fIdx].lng, zoneStops[fIdx].lat];
                    veh.end = [campLng, campLat];
                } else {
                    veh.start = [campLng, campLat];
                    if (needsReturn) veh.end = [campLng, campLat];
                }

                console.log('[Go] VROOM → ' + v.name + ' (' + za.zone.name + '): ' + jobs.length + ' stops, ' + zoneCampers.length + ' kids');

                let orderedStops = zoneStops;
                try {
                    const resp = await fetch('https://api.openrouteservice.org/optimization', {
                        method: 'POST',
                        headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ jobs, vehicles: [veh] })
                    });

                    if (resp.ok) {
                        const result = await resp.json();
                        const vroomRoute = result.routes?.[0];
                        if (vroomRoute) {
                            const ordered = [];
                            vroomRoute.steps.forEach(step => {
                                if (step.type !== 'job') return;
                                const stop = zoneStops[step.id - 1];
                                if (stop) ordered.push(stop);
                            });
                            if (result.unassigned?.length) {
                                result.unassigned.forEach(ua => {
                                    const stop = zoneStops[ua.id - 1];
                                    if (stop) cheapestInsert(ordered, stop);
                                });
                            }
                            orderedStops = ordered;
                        }
                    } else {
                        console.warn('[Go] VROOM error for ' + v.name + ': HTTP ' + resp.status);
                        directionalSort(zoneStops, campLat, campLng);
                    }
                } catch (e) {
                    console.warn('[Go] VROOM failed for ' + v.name + ':', e.message);
                    directionalSort(zoneStops, campLat, campLng);
                }

                // 2-opt improvement
                if (orderedStops.length >= 3) {
                    let improved = true;
                    for (let pass = 0; pass < 5 && improved; pass++) {
                        improved = false;
                        for (let i = 0; i < orderedStops.length - 2; i++) {
                            for (let j = i + 2; j < orderedStops.length; j++) {
                                const a = orderedStops[i], b = orderedStops[i + 1];
                                const c = orderedStops[j], d = orderedStops[j + 1] || (isArrival ? { lat: campLat, lng: campLng } : null);
                                if (!a?.lat || !b?.lat || !c?.lat) continue;
                                const curDist = haversineMi(a.lat, a.lng, b.lat, b.lng) + (d ? haversineMi(c.lat, c.lng, d.lat, d.lng) : 0);
                                const newDist = haversineMi(a.lat, a.lng, c.lat, c.lng) + (d ? haversineMi(b.lat, b.lng, d.lat, d.lng) : 0);
                                if (newDist < curDist * 0.95) {
                                    const seg = orderedStops.splice(i + 1, j - i);
                                    seg.reverse();
                                    orderedStops.splice(i + 1, 0, ...seg);
                                    improved = true;
                                }
                            }
                        }
                    }
                }

                // Or-opt
                if (orderedStops.length >= 4) {
                    for (let pass = 0; pass < 3; pass++) {
                        let relocated = false;
                        for (let i = 0; i < orderedStops.length; i++) {
                            const s = orderedStops[i];
                            if (!s?.lat) continue;
                            const prev = i > 0 ? orderedStops[i - 1] : null;
                            const next = i < orderedStops.length - 1 ? orderedStops[i + 1] : null;
                            let removeCost = 0;
                            if (prev?.lat && next?.lat) removeCost = haversineMi(prev.lat, prev.lng, next.lat, next.lng);
                            let currentCost = 0;
                            if (prev?.lat) currentCost += haversineMi(prev.lat, prev.lng, s.lat, s.lng);
                            if (next?.lat) currentCost += haversineMi(s.lat, s.lng, next.lat, next.lng);
                            const savings = currentCost - removeCost;
                            let bestJ = -1, bestInsertCost = Infinity;
                            for (let j = 0; j <= orderedStops.length - 1; j++) {
                                if (j === i || j === i + 1) continue;
                                const tempStops = [...orderedStops];
                                tempStops.splice(i, 1);
                                const insertAt = j > i ? j - 1 : j;
                                const pBefore = insertAt > 0 ? tempStops[insertAt - 1] : null;
                                const pAfter = insertAt < tempStops.length ? tempStops[insertAt] : null;
                                let ic = 0;
                                if (pBefore?.lat) ic += haversineMi(pBefore.lat, pBefore.lng, s.lat, s.lng);
                                if (pAfter?.lat) ic += haversineMi(s.lat, s.lng, pAfter.lat, pAfter.lng);
                                if (pBefore?.lat && pAfter?.lat) ic -= haversineMi(pBefore.lat, pBefore.lng, pAfter.lat, pAfter.lng);
                                if (ic < bestInsertCost) { bestInsertCost = ic; bestJ = j; }
                            }
                            if (bestJ >= 0 && bestInsertCost < savings * 0.9) {
                                orderedStops.splice(i, 1);
                                const insertAt = bestJ > i ? bestJ - 1 : bestJ;
                                orderedStops.splice(insertAt, 0, s);
                                relocated = true;
                                break;
                            }
                        }
                        if (!relocated) break;
                    }
                }

                // ── Orientation check: ensure correct direction ──
                // Arrival: first stop should be FARTHEST from camp, last stop NEAREST
                // Dismissal: first stop should be NEAREST to camp, last stop FARTHEST
                if (orderedStops.length >= 2) {
                    const firstDist = haversineMi(campLat, campLng, orderedStops[0].lat, orderedStops[0].lng);
                    const lastDist = haversineMi(campLat, campLng, orderedStops[orderedStops.length - 1].lat, orderedStops[orderedStops.length - 1].lng);
                    if (isArrival && firstDist < lastDist) {
                        orderedStops.reverse();
                        console.log('[Go] Orient flip (arrival): reversed — first stop was closer than last');
                    }
                    if (!isArrival && firstDist > lastDist) {
                        orderedStops.reverse();
                        console.log('[Go] Orient flip (dismissal): reversed — first stop was farther than last');
                    }
                }

                const routeStops = orderedStops.map((stop, i) => ({
                    stopNum: i + 1, campers: stop.campers, address: stop.address, lat: stop.lat, lng: stop.lng
                }));

                return {
                    busId: v.busId, busName: v.name, busColor: v.color,
                    monitor: v.monitor, counselors: v.counselors || [],
                    stops: routeStops,
                    camperCount: routeStops.reduce((s, st) => s + st.campers.length, 0),
                    _cap: v.capacity,
                    totalDuration: 0
                };
            });

            const zoneResults = await Promise.all(zonePromises);
            zoneResults.forEach(r => { if (r) allRoutes.push(r); });

            // Ensure all buses have route entries
            vehicles.forEach(v => {
                if (!allRoutes.find(r => r.busId === v.busId)) {
                    allRoutes.push({
                        busId: v.busId, busName: v.name, busColor: v.color,
                        monitor: v.monitor, counselors: v.counselors || [],
                        stops: [], camperCount: 0, _cap: v.capacity, totalDuration: 0
                    });
                }
            });

        } else {
            // ══════════════════════════════════════════════════════════════
            // LEGACY PATH — old region merge + geographic bisection (fallback)
            // ══════════════════════════════════════════════════════════════
            showProgress('Building region groups (legacy)...', 25);

            // Map stops to regions
            const stopRegions = [];
            if (_detectedRegions?.length) {
                stops.forEach(stop => {
                    let bestReg = _detectedRegions[0].id;
                    _detectedRegions.forEach(reg => {
                        if (stop.campers.some(c => reg.camperNames.includes(c.name))) bestReg = reg.id;
                    });
                    stopRegions.push(bestReg);
                });
            } else {
                stops.forEach(() => stopRegions.push('all'));
            }

            // Count kids per region
            const regionKids = {};
            stops.forEach((stop, i) => {
                const regId = stopRegions[i];
                regionKids[regId] = (regionKids[regId] || 0) + stop.campers.length;
            });

            let groups = Object.entries(regionKids)
                .filter(([_, kids]) => kids > 0)
                .sort((a, b) => b[1] - a[1])
                .map(([regId, kids]) => ({
                    id: regId, kids,
                    name: _detectedRegions?.find(r => r.id === regId)?.name || regId,
                    centroidLat: _detectedRegions?.find(r => r.id === regId)?.centroidLat || campLat,
                    centroidLng: _detectedRegions?.find(r => r.id === regId)?.centroidLng || campLng,
                    regionIds: [regId]
                }));

            // Merge: while more groups than buses
            while (groups.length > vehicles.length) {
                groups.sort((a, b) => a.kids - b.kids);
                const smallest = groups[0];
                let nearestIdx = 1, nearestDist = Infinity;
                for (let i = 1; i < groups.length; i++) {
                    const d = haversineMi(smallest.centroidLat, smallest.centroidLng, groups[i].centroidLat, groups[i].centroidLng);
                    if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
                }
                const target = groups[nearestIdx];
                target.kids += smallest.kids;
                target.regionIds.push(...smallest.regionIds);
                target.name = target.name.split(' + ')[0] + ' + ' + smallest.name.split(' (')[0];
                stops.forEach((_, i) => { if (smallest.regionIds.includes(stopRegions[i])) stopRegions[i] = target.id; });
                groups.splice(groups.indexOf(smallest), 1);
            }

            console.log('[Go] Legacy: ' + groups.length + ' groups, ' + vehicles.length + ' buses');

            // Allocate buses to groups
            groups.sort((a, b) => b.kids - a.kids);
            const groupBuses = {};
            groups.forEach(g => { groupBuses[g.id] = []; });
            let busPool = vehicles.map((v, i) => i);
            groups.forEach(g => { if (busPool.length) groupBuses[g.id].push(busPool.shift()); });
            let changed = true;
            while (changed && busPool.length) {
                changed = false;
                let worstGroup = null, worstDeficit = 0;
                groups.forEach(g => {
                    const cap = groupBuses[g.id].reduce((s, vi) => s + vehicles[vi].capacity, 0);
                    const deficit = g.kids - cap;
                    if (deficit > worstDeficit) { worstDeficit = deficit; worstGroup = g; }
                });
                if (worstGroup && worstDeficit > 0) { groupBuses[worstGroup.id].push(busPool.shift()); changed = true; }
            }
            while (busPool.length) {
                let worstGroup = groups[0], worstRatio = 0;
                groups.forEach(g => {
                    const cap = groupBuses[g.id].reduce((s, vi) => s + vehicles[vi].capacity, 0);
                    const ratio = g.kids / Math.max(1, cap);
                    if (ratio > worstRatio) { worstRatio = ratio; worstGroup = g; }
                });
                groupBuses[worstGroup.id].push(busPool.shift());
            }

            showProgress('Optimizing routes (VROOM legacy)...', 35);

            // Legacy per-bus VROOM calls with directional sort
            const groupPromises = groups.map(async (group) => {
                const groupStops = [];
                stops.forEach((stop, i) => {
                    if (group.regionIds.includes(stopRegions[i])) groupStops.push(stop);
                });
                if (!groupStops.length) return [];
                const busIndices = groupBuses[group.id] || [];
                if (!busIndices.length) return [];

                // Simple: one bus per group in legacy mode
                const routes = [];
                for (let rank = 0; rank < busIndices.length; rank++) {
                    const vi = busIndices[rank];
                    const v = vehicles[vi];
                    // Split stops evenly
                    const perBus = Math.ceil(groupStops.length / busIndices.length);
                    const busStops = groupStops.slice(rank * perBus, (rank + 1) * perBus);
                    if (!busStops.length) continue;
                    directionalSort(busStops, campLat, campLng);
                    const routeStops = busStops.map((stop, i) => ({
                        stopNum: i + 1, campers: stop.campers, address: stop.address, lat: stop.lat, lng: stop.lng
                    }));
                    routes.push({
                        busId: v.busId, busName: v.name, busColor: v.color,
                        monitor: v.monitor, counselors: v.counselors || [],
                        stops: routeStops,
                        camperCount: routeStops.reduce((s, st) => s + st.campers.length, 0),
                        _cap: v.capacity, totalDuration: 0
                    });
                }
                return routes;
            });

            const groupResults = await Promise.all(groupPromises);
            groupResults.forEach(routes => allRoutes.push(...routes));

            vehicles.forEach(v => {
                if (!allRoutes.find(r => r.busId === v.busId)) {
                    allRoutes.push({
                        busId: v.busId, busName: v.name, busColor: v.color,
                        monitor: v.monitor, counselors: v.counselors || [],
                        stops: [], camperCount: 0, _cap: v.capacity, totalDuration: 0
                    });
                }
            });
        }

        console.log('[Go] All routes complete: ' + allRoutes.length + ' bus routes');

        // ══════════════════════════════════════════════════════════════
        // POST-ROUTING: Merge consecutive same-street stops
        // ══════════════════════════════════════════════════════════════
        let totalMerged = 0;
        allRoutes.forEach(r => {
            if (r.stops.length < 2) return;
            let merged = 0;
            for (let i = 0; i < r.stops.length - 1; i++) {
                const a = r.stops[i], b = r.stops[i + 1];
                if (!a.lat || !b.lat) continue;
                if (haversineMi(a.lat, a.lng, b.lat, b.lng) > 0.057) continue;
                const stA = normalizeStreet(parseAddress(a.address).street);
                const stB = normalizeStreet(parseAddress(b.address).street);
                if (!stA || !stB) continue;
                if (stA === stB || stA.includes(stB) || stB.includes(stA)) {
                    // Don't merge if any kid would walk > MAX_WALK_FT to the combined stop
                    const mergedLat = a.lat, mergedLng = a.lng; // keep stop A's location
                    const allKids = [...a.campers, ...b.campers];
                    let wouldBeFar = false;
                    for (const c of allKids) {
                        const addr = D.addresses[c.name];
                        if (!addr?.lat || !addr.lng) continue;
                        if (manhattanMi(addr.lat, addr.lng, mergedLat, mergedLng) * 5280 > MAX_WALK_FT) {
                            wouldBeFar = true; break;
                        }
                    }
                    if (wouldBeFar) continue;
                    a.campers.push(...b.campers);
                    if (b.address.includes('&') && !a.address.includes('&')) a.address = b.address;
                    r.stops.splice(i + 1, 1); merged++; i--;
                }
            }
            if (merged) {
                r.stops.forEach((s, i) => { s.stopNum = i + 1; });
                r.camperCount = r.stops.reduce((s, st) => s + st.campers.length, 0);
                totalMerged += merged;
            }
        });
        if (totalMerged) console.log('[Go] Post-route merge: ' + totalMerged + ' stop(s) consolidated');

        // ══════════════════════════════════════════════════════════════
        // CAPACITY ENFORCEMENT
        //
        // Border-stop strategy: find the (stop, receiving bus) pair where
        // the stop is closest to the receiving bus. This naturally picks
        // stops on the boundary between adjacent regions.
        // Uses cheapestInsert to preserve VROOM's route flow.
        // ══════════════════════════════════════════════════════════════
        let capMoves = 0;
        for (let capPass = 0; capPass < 100; capPass++) {
            let overBus = null, worstOver = 0;
            for (const r of allRoutes) {
                const over = r.camperCount - r._cap;
                if (over > worstOver && r.stops.length > 0) { worstOver = over; overBus = r; }
            }
            if (!overBus) break;

            // Find best (stop, receiving bus) pair — prefer stops on the BOUNDARY
            // FIX 19+20: Score = distFromOwnCentroid - distToTargetCentroid
            // This picks stops that are far from their own bus AND close to the target.
            // Dynamic max distance: try 1mi first, expand to 2mi if needed.
            const overCentLat = overBus.stops.reduce((s, x) => s + (x.lat || 0), 0) / overBus.stops.length;
            const overCentLng = overBus.stops.reduce((s, x) => s + (x.lng || 0), 0) / overBus.stops.length;
            let capMaxMoveMi = 1.0;
            let bestStopIdx = -1, bestBus = null, bestScore = -Infinity;
            for (let attempt = 0; attempt < 2; attempt++) {
                bestStopIdx = -1; bestBus = null; bestScore = -Infinity;
                for (let si = 0; si < overBus.stops.length; si++) {
                    const st = overBus.stops[si];
                    if (!st.lat) continue;
                    const distFromOwn = haversineMi(st.lat, st.lng, overCentLat, overCentLng);
                    for (const r of allRoutes) {
                        if (r === overBus) continue;
                        if (r.camperCount + st.campers.length > r._cap) continue;
                        const rLat = r.stops.length ? r.stops.reduce((s, x) => s + x.lat, 0) / r.stops.length : campLat;
                        const rLng = r.stops.length ? r.stops.reduce((s, x) => s + x.lng, 0) / r.stops.length : campLng;
                        const distToTarget = haversineMi(st.lat, st.lng, rLat, rLng);
                        if (distToTarget > capMaxMoveMi) continue;
                        // Higher score = better candidate (far from own bus, close to target)
                        const score = distFromOwn - distToTarget;
                        if (score > bestScore) { bestScore = score; bestStopIdx = si; bestBus = r; }
                    }
                }
                if (bestBus) break;
                capMaxMoveMi = 2.0; // widen search on second attempt
            }

            if (bestBus && bestStopIdx >= 0) {
                // Whole-stop move — stop keeps its geographic location
                const stopToMove = overBus.stops[bestStopIdx];
                const moveDist = haversineMi(stopToMove.lat, stopToMove.lng, bestBus.stops.length ? bestBus.stops.reduce((s, x) => s + x.lat, 0) / bestBus.stops.length : campLat, bestBus.stops.length ? bestBus.stops.reduce((s, x) => s + x.lng, 0) / bestBus.stops.length : campLng);
                console.log('[Go]   Cap move: ' + stopToMove.campers.length + ' kids (' + stopToMove.address + ') from ' + overBus.busName + ' → ' + bestBus.busName + ' (' + moveDist.toFixed(2) + 'mi, boundary score ' + bestScore.toFixed(2) + ')');
                overBus.stops.splice(bestStopIdx, 1);
                overBus.camperCount -= stopToMove.campers.length;
                overBus.stops.forEach((s, i) => { s.stopNum = i + 1; });
                cheapestInsert(bestBus.stops, stopToMove);
                bestBus.camperCount += stopToMove.campers.length;
                capMoves++;
            } else {
                // No whole-stop fits — split: move campers individually
                // Creates a NEW stop on the receiving bus at the same location
                // Use same boundary scoring: prefer stops far from own bus, close to target
                let splitStopIdx = -1, splitBus = null, splitScore = -Infinity;
                capMaxMoveMi = 1.0;
                for (let attempt = 0; attempt < 2; attempt++) {
                    splitStopIdx = -1; splitBus = null; splitScore = -Infinity;
                    for (let si = 0; si < overBus.stops.length; si++) {
                        const st = overBus.stops[si];
                        if (!st.lat || st.campers.length <= 1) continue;
                        const distFromOwn = haversineMi(st.lat, st.lng, overCentLat, overCentLng);
                        for (const r of allRoutes) {
                            if (r === overBus || r.camperCount >= r._cap) continue;
                            const rLat = r.stops.length ? r.stops.reduce((s, x) => s + x.lat, 0) / r.stops.length : campLat;
                            const rLng = r.stops.length ? r.stops.reduce((s, x) => s + x.lng, 0) / r.stops.length : campLng;
                            const distToTarget = haversineMi(st.lat, st.lng, rLat, rLng);
                            if (distToTarget > capMaxMoveMi) continue;
                            const score = distFromOwn - distToTarget;
                            if (score > splitScore) { splitScore = score; splitStopIdx = si; splitBus = r; }
                        }
                    }
                    if (splitBus) break;
                    capMaxMoveMi = 2.0;
                }
                if (!splitBus || splitStopIdx < 0) {
                    console.warn('[Go] ⚠ ' + overBus.busName + ': ' + overBus.camperCount + '/' + overBus._cap + ' — no nearby bus with room (max ' + capMaxMoveMi + 'mi)');
                    break;
                }
                const stopToSplit = overBus.stops[splitStopIdx];
                const room = splitBus._cap - splitBus.camperCount;
                const toMove = Math.min(room, overBus.camperCount - overBus._cap);
                if (toMove <= 0) break;
                const movedCampers = stopToSplit.campers.splice(0, toMove);
                overBus.camperCount -= toMove;
                // Create a NEW stop on receiving bus at the SAME location — kids stay near their home
                const splitDist = haversineMi(stopToSplit.lat, stopToSplit.lng, splitBus.stops.length ? splitBus.stops.reduce((s, x) => s + x.lat, 0) / splitBus.stops.length : campLat, splitBus.stops.length ? splitBus.stops.reduce((s, x) => s + x.lng, 0) / splitBus.stops.length : campLng);
                console.log('[Go]   Cap split: ' + toMove + ' kids from ' + stopToSplit.address + ' → new stop on ' + splitBus.busName + ' (' + splitDist.toFixed(2) + 'mi)');
                cheapestInsert(splitBus.stops, { stopNum: 0, campers: movedCampers, address: stopToSplit.address, lat: stopToSplit.lat, lng: stopToSplit.lng });
                splitBus.camperCount += toMove;
                if (stopToSplit.campers.length === 0) {
                    overBus.stops.splice(splitStopIdx, 1);
                    overBus.stops.forEach((s, i) => { s.stopNum = i + 1; });
                }
                capMoves++;
            }
        }
        if (capMoves) console.log('[Go] Capacity enforcement: ' + capMoves + ' move(s)');

        // ══════════════════════════════════════════════════════════════
        // FINAL ROUTE ORDERING — nearest-neighbor chain using road matrix
        //
        // Only runs for LEGACY path. When zones are used, VROOM already
        // ordered stops optimally within each zone — re-ordering with
        // nearest-neighbor would override VROOM's better decisions.
        // ══════════════════════════════════════════════════════════════
        showProgress('Finalizing routes...', 95);

        const orderPromises = zones ? [] : allRoutes.map(async (r) => {
            if (r.stops.length < 2) return;
            const validStops = r.stops.filter(s => s.lat && s.lng);
            if (validStops.length < 2) return;

            // Build coords: [camp, stop0, stop1, ...]
            const coords = [{ lat: campLat, lng: campLng }]; // index 0 = camp
            r.stops.forEach((s, i) => { s._mIdx = i + 1; coords.push({ lat: s.lat || campLat, lng: s.lng || campLng }); });

            let matrix = null;
            try {
                matrix = await fetchDistanceMatrix(coords, campLat, campLng);
            } catch (_) {}

            // Drive time helper: matrix-based or haversine fallback
            function driveSec(fromIdx, toIdx) {
                if (matrix?.[fromIdx]?.[toIdx] != null && matrix[fromIdx][toIdx] >= 0) return matrix[fromIdx][toIdx];
                const a = coords[fromIdx], b = coords[toIdx];
                return haversineMi(a.lat, a.lng, b.lat, b.lng) * 3600 / (D.setup.avgSpeed || 25);
            }

            // Find starting point
            let startIdx; // matrix index of the first stop
            if (isArrival) {
                // Arrival: start at stop farthest from camp (by drive time)
                let maxTime = 0;
                r.stops.forEach(s => {
                    const t = driveSec(0, s._mIdx);
                    if (t > maxTime) { maxTime = t; startIdx = s._mIdx; }
                });
            } else {
                // Dismissal: start at camp, go to nearest stop first
                startIdx = 0; // will pick nearest from camp
            }

            // Nearest-neighbor chain
            const ordered = [];
            const used = new Set();
            let currentIdx = isArrival ? startIdx : 0; // matrix index of current position

            while (ordered.length < r.stops.length) {
                let bestStop = null, bestTime = Infinity;
                for (const s of r.stops) {
                    if (used.has(s._mIdx)) continue;
                    const t = driveSec(currentIdx, s._mIdx);
                    if (t < bestTime) { bestTime = t; bestStop = s; }
                }
                if (!bestStop) break;
                ordered.push(bestStop);
                used.add(bestStop._mIdx);
                currentIdx = bestStop._mIdx;
            }

            // Replace stops with ordered version
            r.stops = ordered;
            r.stops.forEach((s, i) => { s.stopNum = i + 1; delete s._mIdx; });
        });
        await Promise.all(orderPromises);
        if (zones) console.log('[Go] Route sort: VROOM ordering preserved (zone path)');
        else console.log('[Go] Route sort: nearest-neighbor chain using road driving times');

        // Route quality summary
        const totalKids = allRoutes.reduce((s, r) => s + r.camperCount, 0);
        const totalStops = allRoutes.reduce((s, r) => s + r.stops.length, 0);
        const busesUsed = allRoutes.filter(r => r.stops.length > 0).length;
        const maxKids = Math.max(...allRoutes.map(r => r.camperCount));
        const minKids = Math.min(...allRoutes.filter(r => r.camperCount > 0).map(r => r.camperCount));
        const avgKids = totalKids / Math.max(1, busesUsed);
        const imbalance = maxKids > 0 ? ((maxKids - minKids) / maxKids * 100).toFixed(0) : 0;

        console.log('[Go] ═══ ROUTE QUALITY SUMMARY ═══');
        console.log('[Go]   Mode: ' + (isArrival ? 'ARRIVAL' : 'DISMISSAL' + (needsReturn ? ' (return to camp)' : ' (no return)')));
        console.log('[Go]   ' + totalKids + ' kids across ' + totalStops + ' stops on ' + busesUsed + ' buses');
        console.log('[Go]   Kids per bus: avg ' + Math.round(avgKids) + ', min ' + minKids + ', max ' + maxKids + ' (imbalance: ' + imbalance + '%)');
        allRoutes.filter(r => r.stops.length > 0).forEach(r => {
            const farthest = r.stops.length ? haversineMi(campLat, campLng, r.stops[r.stops.length - 1].lat, r.stops[r.stops.length - 1].lng).toFixed(1) : '?';
            console.log('[Go]   ' + r.busName + ': ' + r.camperCount + ' kids, ' + r.stops.length + ' stops, farthest: ' + farthest + ' mi');
        });
        // Flag buses over capacity (real problem) — skip global imbalance warning
        // since different-sized ZIP regions naturally produce different bus loads
        allRoutes.filter(r => r.camperCount > r._cap).forEach(r => {
            console.warn('[Go]   ⚠ ' + r.busName + ': ' + r.camperCount + ' kids exceeds capacity ' + r._cap);
        });
        console.log('[Go] ═══════════════════════════════');

        // ── Per-bus stop + camper distance audit ──
        console.log('\n[Go] ═══ PER-BUS STOP AUDIT ═══');
        allRoutes.filter(r => r.stops.length > 0).forEach(r => {
            console.log('\n[Go] ── ' + r.busName + ' (' + r.camperCount + '/' + r._cap + ' kids) ──');
            r.stops.forEach(st => {
                if (st.isMonitor || st.isCounselor) return;
                const stopDist = (st.lat && campLat) ? haversineMi(campLat, campLng, st.lat, st.lng).toFixed(2) : '?';
                let farKids = 0;
                const kidLines = st.campers.map(c => {
                    const a = D.addresses[c.name];
                    if (!a?.geocoded || !a.lat || !a.lng || !st.lat || !st.lng) return '      ' + c.name + ' (no address)';
                    const walkFt = Math.round(manhattanMi(a.lat, a.lng, st.lat, st.lng) * 5280);
                    const flag = walkFt > 500 ? ' ⚠ FAR' : '';
                    if (walkFt > 500) farKids++;
                    return '      ' + c.name + ' — ' + walkFt + 'ft' + flag + '  [' + (a.zip || '') + ']';
                });
                const farTag = farKids > 0 ? ' ⚠ ' + farKids + ' far' : '';
                console.log('[Go]   Stop ' + st.stopNum + ': ' + st.address + ' (' + st.campers.length + ' kids, ' + stopDist + 'mi from camp)' + farTag);
                kidLines.forEach(l => console.log('[Go] ' + l));
                // Show counselors assigned to this stop
                if (st._counselors?.length) {
                    st._counselors.forEach(c => {
                        const tag = c.walkFt > 1850 ? ' ⚠ FAR' : '';
                        console.log('[Go]       🎒 ' + c.name + ' (counselor) — ' + c.walkFt + 'ft walk' + tag + '  [' + c.address + ']');
                    });
                }
            });
        });
        console.log('\n[Go] ═══ END AUDIT ═══\n');

        // ══════════════════════════════════════════════════════════════
        // COUNSELOR STOP ASSIGNMENT
        // Counselors don't get their own stops — they get off at the
        // closest existing camper stop. Flag anyone >7 min walk away.
        // ══════════════════════════════════════════════════════════════
        const allStops = []; // flat list of {stop, route} for proximity search
        allRoutes.forEach(r => r.stops.forEach(st => {
            if (!st.isMonitor && st.lat && st.lng) allStops.push({ stop: st, route: r });
        }));

        const counselorsToAssign = D.counselors.filter(c => c.address);
        if (counselorsToAssign.length && allStops.length) {
            console.log('[Go] ═══ COUNSELOR ASSIGNMENT ═══');
            const OUTLIER_WALK_FT = 1850; // ~7 min at 3mph
            const outliers = [];

            for (const c of counselorsToAssign) {
                // Geocode if we don't have coords yet
                if (!c._lat || !c._lng) {
                    const geo = await geocodeSingle(c.address);
                    if (geo) { c._lat = geo.lat; c._lng = geo.lng; }
                    else {
                        console.warn('[Go]   ⚠ Could not geocode: ' + c.name + ' (' + c.address + ')');
                        continue;
                    }
                }

                // Find nearest stop
                let bestStop = null, bestRoute = null, bestDist = Infinity;
                for (const { stop, route } of allStops) {
                    const d = manhattanMi(c._lat, c._lng, stop.lat, stop.lng);
                    if (d < bestDist) { bestDist = d; bestStop = stop; bestRoute = route; }
                }

                if (!bestStop) continue;

                const walkFt = Math.round(bestDist * 5280);
                c._assignedStop = bestStop.address;
                c._assignedBus = bestRoute.busId;
                c._assignedBusName = bestRoute.busName;
                c._walkFt = walkFt;

                // Tag the stop with counselor info
                if (!bestStop._counselors) bestStop._counselors = [];
                bestStop._counselors.push({ name: c.name, walkFt, address: c.address, id: c.id });

                if (walkFt > OUTLIER_WALK_FT) {
                    outliers.push(c);
                    console.warn('[Go]   ⚠ ' + c.name + ' → ' + bestStop.address + ' on ' + bestRoute.busName + ' — ' + walkFt + 'ft walk (>' + OUTLIER_WALK_FT + 'ft)');
                } else {
                    console.log('[Go]   ' + c.name + ' → ' + bestStop.address + ' on ' + bestRoute.busName + ' — ' + walkFt + 'ft walk ✓');
                }
            }

            console.log('[Go] ═══════════════════════════════');

            // Store outliers for UI prompt
            if (outliers.length) {
                _counselorOutliers = outliers;
                // Defer UI prompt until after routes render
                setTimeout(() => showCounselorOutlierModal(outliers), 800);
            }
        }

        return allRoutes;
    }

    // ── Counselor outlier prompt ──
    let _counselorOutliers = [];

    function showCounselorOutlierModal(outliers) {
        const existing = document.getElementById('counselorOutlierModal');
        if (existing) existing.remove();

        const rows = outliers.map((c, i) => {
            const walkMin = (c._walkFt / 264).toFixed(1); // ~264ft per min at 3mph
            return '<tr data-idx="' + i + '">'
                + '<td style="font-weight:600">' + esc(c.name) + '</td>'
                + '<td style="font-size:.8rem">' + esc(c.address) + '</td>'
                + '<td style="font-size:.8rem">' + esc(c._assignedStop) + '<br><span style="color:var(--text-muted)">' + esc(c._assignedBusName) + '</span></td>'
                + '<td style="text-align:center"><span style="color:var(--red-600);font-weight:600">' + walkMin + ' min</span><br><span style="font-size:.7rem;color:var(--text-muted)">' + c._walkFt + 'ft</span></td>'
                + '<td style="text-align:center"><select class="counselor-outlier-action" data-idx="' + i + '" style="padding:4px 8px;border-radius:6px;border:1px solid var(--border-primary);font-size:.8rem;background:var(--bg-primary)">'
                + '<option value="ignore">Ignore</option>'
                + '<option value="add-stop">Add dedicated stop</option>'
                + '</select></td></tr>';
        }).join('');

        const modal = document.createElement('div');
        modal.id = 'counselorOutlierModal';
        modal.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5)';
        modal.innerHTML = '<div style="background:var(--bg-primary);border-radius:12px;max-width:800px;width:95%;max-height:80vh;overflow:auto;padding:1.5rem;box-shadow:0 20px 60px rgba(0,0,0,.3)">'
            + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem"><h3 style="margin:0;font-size:1.1rem">⚠️ Counselors Far From Any Stop</h3>'
            + '<button onclick="document.getElementById(\'counselorOutlierModal\').remove()" style="background:none;border:none;font-size:1.5rem;cursor:pointer;color:var(--text-muted)">×</button></div>'
            + '<p style="color:var(--text-muted);font-size:.85rem;margin-bottom:1rem">These counselors live more than a 7-minute walk from the nearest bus stop. You can ignore this or add a dedicated stop for them (routes will regenerate).</p>'
            + '<table style="width:100%;border-collapse:collapse;font-size:.85rem"><thead><tr style="border-bottom:2px solid var(--border-primary)">'
            + '<th style="text-align:left;padding:8px">Name</th><th style="text-align:left;padding:8px">Home Address</th><th style="text-align:left;padding:8px">Nearest Stop</th><th style="text-align:center;padding:8px">Walk</th><th style="text-align:center;padding:8px">Action</th></tr></thead>'
            + '<tbody>' + rows + '</tbody></table>'
            + '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:1.25rem">'
            + '<button id="counselorOutlierIgnoreAll" style="padding:8px 16px;border-radius:8px;border:1px solid var(--border-primary);background:var(--bg-primary);cursor:pointer;font-size:.85rem">Ignore All</button>'
            + '<button id="counselorOutlierApply" style="padding:8px 16px;border-radius:8px;border:none;background:var(--blue-600);color:white;cursor:pointer;font-size:.85rem;font-weight:600">Apply Changes</button>'
            + '</div></div>';

        document.body.appendChild(modal);

        document.getElementById('counselorOutlierIgnoreAll').addEventListener('click', () => {
            modal.remove();
            toast('Counselor assignments kept as-is');
        });

        document.getElementById('counselorOutlierApply').addEventListener('click', () => {
            const selects = modal.querySelectorAll('.counselor-outlier-action');
            let added = 0;

            selects.forEach(sel => {
                const idx = parseInt(sel.dataset.idx);
                const action = sel.value;
                const c = outliers[idx];
                if (action === 'add-stop' && c._lat && c._lng) {
                    // Find the bus whose route centroid is closest
                    let bestRoute = null, bestDist = Infinity;
                    const routes = D.savedRoutes?.[0]?.routes || [];
                    for (const r of routes) {
                        if (!r.stops.length) continue;
                        for (const st of r.stops) {
                            if (!st.lat) continue;
                            const d = haversineMi(c._lat, c._lng, st.lat, st.lng);
                            if (d < bestDist) { bestDist = d; bestRoute = r; }
                        }
                    }
                    if (bestRoute) {
                        const newStop = {
                            stopNum: 0, campers: [],
                            address: c.address,
                            lat: c._lat, lng: c._lng,
                            isCounselor: true, counselorName: c.name,
                            _counselors: [{ name: c.name, walkFt: 0, address: c.address, id: c.id }]
                        };
                        cheapestInsert(bestRoute.stops, newStop);
                        bestRoute.stops.forEach((s, i) => { s.stopNum = i + 1; });
                        c._assignedBus = bestRoute.busId;
                        c._assignedBusName = bestRoute.busName;
                        c._assignedStop = c.address;
                        c._walkFt = 0;
                        added++;
                        console.log('[Go] Added dedicated stop for ' + c.name + ' on ' + bestRoute.busName);
                    }
                }
            });

            modal.remove();

            if (added) {
                save();
                _generatedRoutes = D.savedRoutes;
                renderRouteResults(applyOverrides(D.savedRoutes));
                toast(added + ' dedicated counselor stop' + (added > 1 ? 's' : '') + ' added');
            } else {
                toast('Counselor assignments kept as-is');
            }
        });
    }

    // =========================================================================
    // SINGLE ROUTE RE-OPTIMIZATION
    // =========================================================================
    async function reOptimizeBus(busId, shiftIdx) {
        if (!_generatedRoutes || !D.savedRoutes) { toast('Generate routes first', 'error'); return; }
        const sr = D.savedRoutes[shiftIdx ?? 0]; if (!sr) { toast('Shift not found', 'error'); return; }
        const route = sr.routes.find(r => r.busId === busId);
        if (!route || route.stops.length < 2) { toast('Bus has < 2 stops', 'error'); return; }

        const isArrival = D.activeMode === 'arrival';
        const hasShifts = D.shifts.length > 1;
        const isLastShift = (shiftIdx ?? 0) === (D.savedRoutes?.length || 1) - 1;
        const reoptNeedsReturn = hasShifts && !isLastShift;
        const campLat = D.setup.campLat || _campCoordsCache?.lat;
        const campLng = D.setup.campLng || _campCoordsCache?.lng;
        if (!campLat || !campLng) { toast('No camp coordinates', 'error'); return; }

        toast('Re-optimizing ' + route.busName + '...');
        const stops = route.stops.filter(s => !s.isMonitor && !s.isCounselor);
        const specialStops = route.stops.filter(s => s.isMonitor || s.isCounselor);
        const nn = stops.length; if (nn < 2) { toast('Not enough stops'); return; }

        // ── Try Mapbox Optimization API first ──
        let optimizedOrder = null;
        let matrix = null;
        const mbTok = D.setup.mapboxToken || _PLATFORM_KEYS.mapbox;

        if (nn <= 11 && mbTok) {
            // Build coords for Mapbox Optimize
            let coords, sourceP, destP, roundtripP;
            if (isArrival) {
                coords = stops.map(s => s.lng + ',' + s.lat).join(';') + ';' + campLng + ',' + campLat;
                sourceP = 'any'; destP = 'last'; roundtripP = 'false';
            } else if (reoptNeedsReturn) {
                coords = campLng + ',' + campLat + ';' + stops.map(s => s.lng + ',' + s.lat).join(';');
                sourceP = 'first'; destP = 'any'; roundtripP = 'true';
            } else {
                coords = campLng + ',' + campLat + ';' + stops.map(s => s.lng + ',' + s.lat).join(';');
                sourceP = 'first'; destP = 'any'; roundtripP = 'false';
            }
            try {
                const url = 'https://api.mapbox.com/optimized-trips/v1/mapbox/driving/' + coords + '?source=' + sourceP + '&destination=' + destP + '&roundtrip=' + roundtripP + '&access_token=' + mbTok;
                const resp = await fetch(url);
                if (resp.ok) {
                    const data = await resp.json();
                    if (data.code === 'Ok' && data.waypoints?.length) {
                        const offset = isArrival ? 0 : 1;
                        const stopWps = data.waypoints.slice(offset, offset + nn);
                        optimizedOrder = stopWps.map((wp, origIdx) => ({ origIdx, wpIdx: wp.waypoint_index })).sort((a, b) => a.wpIdx - b.wpIdx).map(s => s.origIdx);
                        console.log('[Go] Re-optimize via Mapbox Optimize');
                    }
                }
            } catch (e) { console.warn('[Go] Mapbox Optimize failed:', e.message); }
        }

        // ── Fallback: local TSP with directional bias ──
        if (!optimizedOrder) {
            const coordsArr = [{ lat: campLat, lng: campLng }];
            stops.forEach(s => coordsArr.push({ lat: s.lat, lng: s.lng }));
            matrix = await fetchDistanceMatrix(coordsArr, campLat, campLng);

            const startsAtCamp = !isArrival;
            const endsAtCamp = isArrival || reoptNeedsReturn;
            const DPEN = 1.5;
            function dist(i, j) {
                if (matrix && matrix[i]?.[j] != null && matrix[i][j] >= 0) return matrix[i][j];
                const a = i === 0 ? { lat: campLat, lng: campLng } : stops[i - 1];
                const b = j === 0 ? { lat: campLat, lng: campLng } : stops[j - 1];
                return (haversineMi(a.lat, a.lng, b.lat, b.lng) / (D.setup.avgSpeed || 25)) * 3600;
            }
            const campDists = []; for (let i = 0; i < nn; i++) campDists[i] = haversineMi(campLat, campLng, stops[i].lat, stops[i].lng);
            function tourCost(tour) {
                let c = 0; if (startsAtCamp) c += dist(0, tour[0] + 1);
                for (let i = 0; i < tour.length - 1; i++) {
                    c += dist(tour[i] + 1, tour[i + 1] + 1);
                    const dC = campDists[tour[i]], dN = campDists[tour[i + 1]];
                    if (isArrival && dN > dC * 1.05) c += (dN - dC) * DPEN;
                    else if (!isArrival && dN < dC * 0.95) c += (dC - dN) * DPEN;
                }
                if (endsAtCamp) c += dist(tour[tour.length - 1] + 1, 0); return c;
            }
            function nearestNeighbor(si) { const t = [si]; const v = new Set([si]); while (t.length < nn) { const l = t[t.length-1]; let bi=-1,bd=Infinity; for(let i=0;i<nn;i++){if(v.has(i))continue;const d=dist(l+1,i+1);if(d<bd){bd=d;bi=i;}} if(bi<0)break;t.push(bi);v.add(bi);} return t; }
            function twoOpt(tour) { const t=[...tour];let imp=true,it=0;while(imp&&it<Math.min(nn*nn*4,3000)){imp=false;it++;for(let i=0;i<t.length-1;i++)for(let j=i+2;j<t.length;j++){const p=i===0?0:t[i-1]+1,a=t[i]+1,b=t[j]+1,x=j+1<t.length?t[j+1]+1:-1;if(dist(p,b)+(x>=0?dist(a,x):0)<dist(p,a)+(x>=0?dist(b,x):0)-0.1){const s=t.slice(i,j+1).reverse();for(let k=0;k<s.length;k++)t[i+k]=s[k];imp=true;}}}return t; }
            function orOpt(tour) { const t=[...tour];let imp=true,it=0;while(imp&&it<500){imp=false;it++;for(let i=0;i<t.length;i++){const p=i===0?0:t[i-1]+1,c=t[i]+1,nx=i+1<t.length?t[i+1]+1:-1;const sv=(dist(p,c)+(nx>=0?dist(c,nx):0))-(nx>=0?dist(p,nx):0);let bj=-1,bg=0;for(let j=0;j<t.length;j++){if(j===i||j===i-1)continue;const a=j===0?0:t[j-1]+1,b=t[j]+1;const g=sv-(dist(a,c)+dist(c,b)-dist(a,b));if(g>bg+0.1){bg=g;bj=j;}}if(bj>=0){const si=t.splice(i,1)[0];t.splice(bj>i?bj-1:bj,0,si);imp=true;break;}}}return t; }
            function doubleBridge(tour) { if(tour.length<8)return[...tour];const l=tour.length,ps=new Set();while(ps.size<3)ps.add(1+Math.floor(Math.random()*(l-2)));const c=[0,...[...ps].sort((a,b)=>a-b),l];return[...tour.slice(c[0],c[1]),...tour.slice(c[2],c[3]),...tour.slice(c[1],c[2]),...tour.slice(c[3],c[4])]; }
            function fullImprove(t) { t=[...t];let pc=tourCost(t);for(let c=0;c<5;c++){t=twoOpt(t);t=orOpt(t);t=twoOpt(t);const nc=tourCost(t);if(nc>=pc-0.5)break;pc=nc;}return t; }

            let bestTour = null, bestCost = Infinity;
            { const t = fullImprove(Array.from({length:nn},(_,i)=>i)); const c = tourCost(t); if (c < bestCost) { bestCost = c; bestTour = t; } }
            for (let s = 0; s < nn; s++) { let t = fullImprove(nearestNeighbor(s)); const c = tourCost(t); if (c < bestCost) { bestCost = c; bestTour = t; } }
            const byDist = campDists.map((d,i) => ({d,i})).sort((a,b) => a.d - b.d).map(x => x.i);
            [isArrival ? [...byDist].reverse() : [...byDist], isArrival ? [...byDist] : [...byDist].reverse()].forEach(seed => { const t = fullImprove(seed); const c = tourCost(t); if (c < bestCost) { bestCost = c; bestTour = t; } });
            if (nn >= 6 && bestTour) { for (let p = 0; p < Math.min(nn, 25) * 3; p++) { const t = fullImprove(doubleBridge(bestTour)); const c = tourCost(t); if (c < bestCost) { bestCost = c; bestTour = t; } } }

            optimizedOrder = bestTour;
            console.log('[Go] Re-optimize via local TSP (' + (matrix ? 'road-matrix' : 'haversine') + ')');
        }

        if (optimizedOrder && optimizedOrder.length === nn) {
            const newStops = optimizedOrder.map(i => stops[i]);

            // Orient: reverse if pointing wrong direction
            if (newStops.length >= 2) {
                const fd = haversineMi(campLat, campLng, newStops[0].lat, newStops[0].lng);
                const ld = haversineMi(campLat, campLng, newStops[newStops.length - 1].lat, newStops[newStops.length - 1].lng);
                if (isArrival && fd < ld) newStops.reverse();
                if (!isArrival && fd > ld) newStops.reverse();
            }

            route.stops = [...newStops, ...specialStops];
        }

        route.stops.forEach((s, i) => { s.stopNum = i + 1; });
        route._osrmMatrix = matrix;
        route.camperCount = route.stops.reduce((s, st) => s + st.campers.length, 0);

        const avgStopMin = D.setup.avgStopTime || 2;
        const avgSpeedMph = D.setup.avgSpeed || 25;
        const timeMin = parseTime(sr.shift.departureTime || (isArrival ? '08:00' : '16:00'));
        function driveMin(a, b) { if (matrix && a._matrixIdx != null && b._matrixIdx != null) { const v = matrix[a._matrixIdx]?.[b._matrixIdx]; if (v != null && v >= 0) return v / 60; } if (a.lat && b.lat) return (haversineMi(a.lat, a.lng, b.lat, b.lng) / avgSpeedMph) * 60; return 3; }
        function campToStopMin(s) { if (matrix && s._matrixIdx != null) { const v = matrix[0]?.[s._matrixIdx]; if (v != null && v >= 0) return v / 60; } if (s.lat) return (haversineMi(campLat, campLng, s.lat, s.lng) / avgSpeedMph) * 60; return 15; }

        const rStops = route.stops.filter(s => !s.isMonitor && !s.isCounselor);
        if (isArrival) {
            let totalDur = 0;
            for (let i = 0; i < rStops.length; i++) { totalDur += (i === 0 ? campToStopMin(rStops[0]) : driveMin(rStops[i-1], rStops[i])) + avgStopMin; }
            totalDur += campToStopMin(rStops[rStops.length - 1]);
            let cum = timeMin - totalDur;
            rStops.forEach((s, i) => { cum += (i === 0 ? campToStopMin(s) : driveMin(rStops[i-1], s)) + avgStopMin; s.estimatedTime = formatTime(cum); s.estimatedMin = cum; });
            route.totalDuration = Math.round(totalDur);
        } else {
            let cum = timeMin;
            rStops.forEach((s, i) => { cum += (i === 0 ? campToStopMin(s) : driveMin(rStops[i-1], s)) + avgStopMin; s.estimatedTime = formatTime(cum); s.estimatedMin = cum; });
            route.totalDuration = Math.round(cum - timeMin);
            if (reoptNeedsReturn) route.totalDuration += Math.round(campToStopMin(rStops[rStops.length - 1]));
        }

        route.stops.forEach(s => { delete s._matrixIdx; }); delete route._osrmMatrix;
        _generatedRoutes = D.savedRoutes; save();
        renderRouteResults(applyOverrides(D.savedRoutes));
        console.log('[Go] Re-optimized ' + route.busName + ': ~' + Math.round(bestCost / 60) + ' min (' + (matrix ? 'road-matrix' : 'haversine') + ')');
        toast(route.busName + ' re-optimized!');
    }

    // =========================================================================
    // FALLBACK ROUTING
    // =========================================================================
    function fallbackRouting(stops, vehicles, campLat, campLng) {
        console.warn('[Go] Using fallback geographic routing');
        const numBuses = vehicles.length;
        stops.forEach(s => { s._angle = Math.atan2(s.lng - campLng, s.lat - campLat); });
        stops.sort((a, b) => a._angle - b._angle);
        const routes = [];
        const perBus = Math.ceil(stops.length / numBuses);
        for (let i = 0; i < numBuses; i++) {
            const v = vehicles[i];
            const busStops = stops.slice(i * perBus, (i + 1) * perBus);
            directionalSort(busStops, campLat, campLng);
            busStops.forEach(s => { delete s._angle; });
            routes.push({ busId: v.busId, busName: v.name, busColor: v.color, monitor: v.monitor, counselors: v.counselors || [], stops: busStops, camperCount: busStops.reduce((s, st) => s + st.campers.length, 0), _cap: v.capacity, totalDuration: 0 });
        }
        return routes;
    }

    function fallbackRegionRouting(stops, vehicles, campLat, campLng) {
        const routes = [];
        const perBus = Math.ceil(stops.length / vehicles.length);
        // Sort all stops directionally before slicing into buses
        directionalSort(stops, campLat, campLng);
        for (let i = 0; i < vehicles.length; i++) {
            const v = vehicles[i];
            const busStops = stops.slice(i * perBus, (i + 1) * perBus);
            busStops.forEach((s, si) => { s.stopNum = si + 1; });
            routes.push({ busId: v.busId, busName: v.name, busColor: v.color, monitor: v.monitor, counselors: v.counselors || [], stops: busStops, camperCount: busStops.reduce((s, st) => s + st.campers.length, 0), _cap: v.capacity, totalDuration: 0 });
        }
        return routes;
    }

    // =========================================================================
    // STOP CREATION
    // =========================================================================

    /** Detect sibling groups: same last name + addresses within ~100ft */
    function detectSiblings(campers) {
        const byLastName = {};
        campers.forEach(c => {
            const parts = (c.name || '').trim().split(/\s+/);
            const lastName = parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
            if (!lastName) return;
            if (!byLastName[lastName]) byLastName[lastName] = [];
            byLastName[lastName].push(c);
        });
        const sibMap = {};
        let gid = 0;
        Object.values(byLastName).forEach(group => {
            if (group.length < 2) return;
            const used = new Set();
            group.forEach(c => {
                if (used.has(c.name)) return;
                const family = [c]; used.add(c.name);
                group.forEach(o => {
                    if (used.has(o.name)) return;
                    if (haversineMi(c.lat, c.lng, o.lat, o.lng) < 0.02) { family.push(o); used.add(o.name); }
                });
                if (family.length >= 2) {
                    const id = 'sib_' + gid++;
                    family.forEach(k => { sibMap[k.name] = id; });
                }
            });
        });
        if (Object.keys(sibMap).length) console.log('[Go] Siblings: ' + Object.keys(sibMap).length + ' kids in ' + gid + ' families');
        return sibMap;
    }

    function applyRideWith(campers) {
        const map = {}; campers.forEach(c => { map[c.name] = c; });
        campers.forEach(c => {
            const a = D.addresses[c.name];
            if (a?.rideWith) {
                const partner = map[a.rideWith];
                if (partner) { c.lat = partner.lat; c.lng = partner.lng; c.address = partner.address; }
            }
        });
    }

    function createHouseStops(campers) {
        const camperMap = {}; campers.forEach(c => { camperMap[c.name] = c; });
        campers.forEach(c => { const a = D.addresses[c.name]; if (a?.rideWith) { const partner = camperMap[a.rideWith]; if (partner) { c.lat = partner.lat; c.lng = partner.lng; c.address = partner.address; } } });
        const groups = {};
        campers.forEach(c => {
            const key = Math.round(c.lat * 5000) + ',' + Math.round(c.lng * 5000);
            if (!groups[key]) groups[key] = [];
            groups[key].push(c);
        });
        return Object.values(groups).map(g => ({
            lat: g.reduce((s, c) => s + c.lat, 0) / g.length,
            lng: g.reduce((s, c) => s + c.lng, 0) / g.length,
            address: g[0].address,
            campers: g.map(c => ({ name: c.name, division: c.division, bunk: c.bunk }))
        }));
    }

    // =========================================================================
    // DYNAMIC CLUSTER RADIUS — adapts to housing density
    //
    // Measures median nearest-neighbor distance among campers to detect
    // whether we're in a dense city grid (~0.01mi between houses) or
    // a spread-out rural/suburban area (~0.2mi between houses).
    //
    // Dense city  → median NN ~0.01mi → cluster radius ~0.07mi (~370ft)
    // Suburban    → median NN ~0.03mi → cluster radius ~0.15mi (~790ft)
    // Spread out  → median NN ~0.10mi → cluster radius ~0.50mi (~2640ft)
    // Rural       → median NN ~0.20mi → cluster radius ~1.00mi
    //
    // The radius is clamped between 0.05mi (floor) and 1.0mi (ceiling).
    // User's maxWalkDistance setting acts as an additional cap.
    // =========================================================================
    function calcDensityRadius(campers) {
        if (campers.length < 3) return 0.1; // not enough data, use reasonable default

        // Calculate nearest-neighbor distance for each camper
        const nnDists = [];
        for (let i = 0; i < campers.length; i++) {
            let minDist = Infinity;
            for (let j = 0; j < campers.length; j++) {
                if (i === j) continue;
                const d = haversineMi(campers[i].lat, campers[i].lng, campers[j].lat, campers[j].lng);
                if (d < minDist) minDist = d;
            }
            if (minDist < Infinity) nnDists.push(minDist);
        }

        if (!nnDists.length) return 0.1;

        // Median nearest-neighbor distance
        nnDists.sort((a, b) => a - b);
        const median = nnDists[Math.floor(nnDists.length / 2)];

        // Scale: cluster radius = 5× median NN distance
        // This means a cluster can span roughly 5 "house gaps"
        const FLOOR = 0.05;   // ~265ft — minimum even in Manhattan
        const CEILING = 1.0;  // ~1 mile — maximum even in rural areas
        const MULTIPLIER = 5;

        const radius = Math.max(FLOOR, Math.min(CEILING, median * MULTIPLIER));

        return radius;
    }

    function createOptimizedStops(campers) {
        const camperMap = {}; campers.forEach(c => { camperMap[c.name] = c; });
        campers.forEach(c => { const a = D.addresses[c.name]; if (a?.rideWith) { const partner = camperMap[a.rideWith]; if (partner) { c.lat = partner.lat; c.lng = partner.lng; c.address = partner.address; } } });

        // Dynamic cluster radius based on housing density
        const densityRadius = calcDensityRadius(campers);
        const userCapMi = (D.setup.maxWalkDistance || 0) > 0 ? D.setup.maxWalkDistance * 0.000189394 : Infinity;
        const walkMi = Math.min(densityRadius, userCapMi);
        console.log('[Go] Density radius: ' + (densityRadius * 5280).toFixed(0) + 'ft → cluster radius: ' + (walkMi * 5280).toFixed(0) + 'ft');

        const sibMap = detectSiblings(campers);

        // Smart clustering: street-aware, capacity-capped
        const bestClusters = smartCluster(campers, walkMi, sibMap);

        // Build stops — median point for optimal pickup location
        const stops = bestClusters.map(cluster => {
            if (cluster.length === 1) {
                return { lat: cluster[0].lat, lng: cluster[0].lng, address: cluster[0].address, campers: cluster.map(c => ({ name: c.name, division: c.division, bunk: c.bunk })) };
            }

            // Coordinate-wise median = exact L1 optimal point
            const sortedLats = cluster.map(k => k.lat).sort((a, b) => a - b);
            const sortedLngs = cluster.map(k => k.lng).sort((a, b) => a - b);
            const medianLat = sortedLats[Math.floor(sortedLats.length / 2)];
            const medianLng = sortedLngs[Math.floor(sortedLngs.length / 2)];

            let nearestAddr = cluster[0].address, nearestDist = Infinity;
            cluster.forEach(k => {
                const d = manhattanMi(medianLat, medianLng, k.lat, k.lng);
                if (d < nearestDist) { nearestDist = d; nearestAddr = k.address; }
            });

            const parsed = parseAddress(nearestAddr);
            const streetLabel = parsed.street || nearestAddr.split(',')[0];
            const label = nearestDist < 0.01 ? nearestAddr : 'Near ' + streetLabel;

            return { lat: medianLat, lng: medianLng, address: label, campers: cluster.map(c => ({ name: c.name, division: c.division, bunk: c.bunk })) };
        });

        console.log('[Go] Optimized stops: ' + stops.length + ' from ' + campers.length + ' campers');
        return stops;
    }

    // =========================================================================
    // CORNER STOPS — Real intersection-aware
    // FIX 3: Overpass retry + mirror
    // FIX 4: Nearest-kid coords when no OSM snap
    // FIX 5+6: Manhattan distance + 375ft default
    // =========================================================================

    let _intersectionCache = null;

    try {
        const cached = localStorage.getItem('campistry_go_intersections');
        if (cached) {
            const parsed = JSON.parse(cached);
            if (parsed.intersections?.length && parsed.timestamp > Date.now() - 7 * 24 * 60 * 60 * 1000) {
                _intersectionCache = parsed.intersections;
                console.log('[Go] Loaded ' + _intersectionCache.length + ' cached intersections (saved ' + new Date(parsed.timestamp).toLocaleDateString() + ')');
            }
        }
    } catch (_) {}

    async function createCornerStops(campers) {
        applyRideWith(campers);

        // Dynamic cluster radius based on housing density
        const densityRadius = calcDensityRadius(campers);
        const userCapMi = (D.setup.maxWalkDistance || 0) > 0 ? D.setup.maxWalkDistance * 0.000189394 : Infinity;
        const walkMi = Math.min(densityRadius, userCapMi);
        console.log('[Go] Corner stops — density radius: ' + (densityRadius * 5280).toFixed(0) + 'ft → cluster radius: ' + (walkMi * 5280).toFixed(0) + 'ft');

        const sibMap = detectSiblings(campers);

        // Smart clustering: street-aware, capacity-capped
        const bestClusters = smartCluster(campers, walkMi, sibMap);

        let osmIntersections = _intersectionCache;
        if (!osmIntersections) {
            showProgress('Fetching real intersections...', 15);
            osmIntersections = await fetchIntersections(campers);
            if (osmIntersections && osmIntersections.length > 0) {
                _intersectionCache = osmIntersections;
                try { localStorage.setItem('campistry_go_intersections', JSON.stringify({ intersections: osmIntersections, timestamp: Date.now() })); } catch (_) {}
                console.log('[Go] OSM: ' + osmIntersections.length + ' real intersections');
            } else {
                // FIX 17: Warn user when OSM intersection fetch fails
                osmIntersections = null;
                console.warn('[Go] ⚠ Overpass API failed — corner stops will use approximate locations instead of real intersections');
                toast('Corner stops: intersection data unavailable — using approximate locations', 'error');
            }
        }

        // For each cluster, find the best corner
        const stops = bestClusters.map(cluster => {
            const streetCounts = {};
            cluster.forEach(c => {
                const p = parseAddress(c.address);
                if (p.street) streetCounts[p.street] = (streetCounts[p.street] || 0) + 1;
            });

            const sortedStreets = Object.entries(streetCounts).sort((a, b) => b[1] - a[1]);
            const mainStreet = sortedStreets[0]?.[0] || '';
            const crossStreet = sortedStreets[1]?.[0] || '';

            // ── Helper: total Manhattan walk from all kids to a point ──
            function totalWalkTo(lat, lng) {
                return cluster.reduce((sum, k) => sum + manhattanMi(lat, lng, k.lat, k.lng), 0);
            }

            // ── Fallback: best kid location (minimizes total walk, guaranteed on-street) ──
            let fallbackLat = cluster[0].lat, fallbackLng = cluster[0].lng;
            if (cluster.length > 1) {
                let bestKidWalk = Infinity;
                cluster.forEach(k => {
                    const tw = totalWalkTo(k.lat, k.lng);
                    if (tw < bestKidWalk) { bestKidWalk = tw; fallbackLat = k.lat; fallbackLng = k.lng; }
                });
            }

            let stopName = '', stopLat = fallbackLat, stopLng = fallbackLng;

            if (mainStreet && crossStreet) {
                stopName = crossStreet + ' & ' + mainStreet;

                if (osmIntersections) {
                    // ── Score intersections by: street match + total walk from all kids ──
                    // Street match gives a bonus; total walk is the tiebreaker.
                    // This finds the intersection most accessible to the whole cluster.
                    let bestInter = null, bestScore = -Infinity;

                    osmIntersections.forEach(inter => {
                        // Quick reject: too far from any kid
                        const d = haversineMi(fallbackLat, fallbackLng, inter.lat, inter.lng);
                        if (d > walkMi * 4) return;

                        const interStreets = (inter.streets || []).map(s => s.toLowerCase());
                        const mainMatch = interStreets.some(s => streetMatch(s, mainStreet));
                        const crossMatch = interStreets.some(s => streetMatch(s, crossStreet));

                        let score = 0;
                        if (mainMatch && crossMatch) score = 10;
                        else if (mainMatch) score = 4;
                        else if (crossMatch) score = 2;
                        else return; // no street match — skip

                        // Subtract total walking distance (lower = better)
                        score -= totalWalkTo(inter.lat, inter.lng) * 20;

                        if (score > bestScore) { bestScore = score; bestInter = inter; }
                    });

                    if (bestInter) {
                        stopLat = bestInter.lat;
                        stopLng = bestInter.lng;
                        stopName = bestInter.name;
                        console.log('[Go]   Best corner: ' + bestInter.name + ' (score ' + bestScore.toFixed(1) + ', total walk ' + (totalWalkTo(bestInter.lat, bestInter.lng) * 5280).toFixed(0) + 'ft)');
                    } else {
                        // No street-matched intersection — find nearest of ANY kind
                        let nearestDist = Infinity, nearestInter = null;
                        osmIntersections.forEach(inter => {
                            const d = haversineMi(fallbackLat, fallbackLng, inter.lat, inter.lng);
                            if (d < nearestDist && d <= walkMi * 4) { nearestDist = d; nearestInter = inter; }
                        });
                        if (nearestInter) {
                            stopLat = nearestInter.lat; stopLng = nearestInter.lng;
                            stopName = nearestInter.name;
                            console.log('[Go]   No match for ' + mainStreet + '/' + crossStreet + ' — nearest: ' + nearestInter.name + ' (' + (nearestDist * 5280).toFixed(0) + 'ft)');
                        }
                    }
                }
            } else if (mainStreet) {
                // Default: address range (used only if no intersection found)
                const nums = cluster.map(c => parseAddress(c.address).num).filter(n => n > 0).sort((a, b) => a - b);
                if (nums.length >= 2) stopName = nums[0] + '-' + nums[nums.length - 1] + ' ' + mainStreet;
                else stopName = mainStreet;

                if (osmIntersections) {
                    // Single street — first try intersections ON this street
                    let bestInter = null, bestWalk = Infinity;
                    osmIntersections.forEach(inter => {
                        const d = haversineMi(fallbackLat, fallbackLng, inter.lat, inter.lng);
                        if (d > walkMi * 4) return;
                        const interStreets = (inter.streets || []).map(s => s.toLowerCase());
                        if (!interStreets.some(s => streetMatch(s, mainStreet))) return;
                        const tw = totalWalkTo(inter.lat, inter.lng);
                        if (tw < bestWalk) { bestWalk = tw; bestInter = inter; }
                    });

                    // Fallback: find the NEAREST intersection of ANY kind
                    // Drivers need cross-street names, not address ranges
                    if (!bestInter) {
                        let nearestDist = Infinity;
                        osmIntersections.forEach(inter => {
                            const d = haversineMi(fallbackLat, fallbackLng, inter.lat, inter.lng);
                            if (d < nearestDist && d <= walkMi * 4) {
                                nearestDist = d; bestInter = inter;
                            }
                        });
                        if (bestInter) {
                            console.log('[Go]   No intersection on ' + mainStreet + ' — using nearest: ' + bestInter.name + ' (' + (nearestDist * 5280).toFixed(0) + 'ft)');
                        }
                    }

                    if (bestInter) { stopLat = bestInter.lat; stopLng = bestInter.lng; stopName = bestInter.name; }
                }
            } else {
                stopName = 'Stop';
            }

            return {
                lat: stopLat, lng: stopLng, address: stopName,
                campers: cluster.map(c => ({ name: c.name, division: c.division, bunk: c.bunk }))
            };
        });

        // Merge tiny stops (<=2 kids) into nearest within walkMi
        // FIX 6: Use manhattanMi for merge distance check too
        let didMerge = true;
        while (didMerge) {
            didMerge = false;
            for (let i = stops.length - 1; i >= 0; i--) {
                if (stops[i].campers.length > 2) continue;
                let bestJ = -1, bestDist = walkMi;
                for (let j = 0; j < stops.length; j++) {
                    if (j === i) continue;
                    const d = manhattanMi(stops[i].lat, stops[i].lng, stops[j].lat, stops[j].lng);
                    if (d < bestDist) { bestDist = d; bestJ = j; }
                }
                if (bestJ >= 0) {
                    stops[bestJ].campers.push(...stops[i].campers);
                    stops.splice(i, 1);
                    didMerge = true;
                    break;
                }
            }
        }

        const final = stops.filter(s => s.campers.length > 0);
        console.log('[Go] Corner stops: ' + final.length + ' stops from ' + campers.length + ' campers');
        final.forEach(s => console.log('[Go]   ' + s.address + ' (' + s.campers.length + ' kids)'));
        return final;
    }

    // ── FIX 3: Fetch intersections with retry + mirror fallback ──
    async function fetchIntersections(campers) {
        let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
        campers.forEach(c => { if (c.lat < minLat) minLat = c.lat; if (c.lat > maxLat) maxLat = c.lat; if (c.lng < minLng) minLng = c.lng; if (c.lng > maxLng) maxLng = c.lng; });
        // Buffer of ~0.005 deg ≈ ~0.35mi — ensures intersections near cluster edges are included
        const buf = 0.005;
        const bbox = (minLat - buf) + ',' + (minLng - buf) + ',' + (maxLat + buf) + ',' + (maxLng + buf);

        const query = '[out:json][timeout:30];' +
            'way["highway"~"^(residential|secondary|tertiary|primary|trunk|unclassified|living_street)$"]["name"](' + bbox + ');' +
            'out body;>;out skel;';

        // Try primary + mirror
        const endpoints = [
            'https://overpass-api.de/api/interpreter',
            'https://overpass.kumi.systems/api/interpreter'
        ];

        for (const url of endpoints) {
            try {
                console.log('[Go] Overpass: trying ' + url.split('//')[1].split('/')[0] + '...');
                const resp = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: 'data=' + encodeURIComponent(query)
                });

                if (resp.status === 504 || resp.status === 429) {
                    console.warn('[Go] Overpass ' + resp.status + ' at ' + url + ', trying next mirror...');
                    continue;
                }
                if (!resp.ok) {
                    console.warn('[Go] Overpass HTTP ' + resp.status + ' at ' + url);
                    continue;
                }

                const data = await resp.json();
                if (!data.elements?.length) return null;

                const nodes = {};
                data.elements.filter(e => e.type === 'node' && e.lat && e.lon).forEach(e => { nodes[e.id] = { lat: e.lat, lng: e.lon }; });

                const nodeStreets = {};
                data.elements.filter(e => e.type === 'way' && e.tags?.name && e.nodes?.length).forEach(way => {
                    way.nodes.forEach(nid => { if (!nodeStreets[nid]) nodeStreets[nid] = new Set(); nodeStreets[nid].add(way.tags.name); });
                });

                const intersections = [];
                Object.entries(nodeStreets).forEach(([nid, streets]) => {
                    if (streets.size < 2) return;
                    const node = nodes[nid]; if (!node) return;
                    const arr = [...streets].sort();
                    intersections.push({ lat: node.lat, lng: node.lng, name: arr[0] + ' & ' + arr[1], streets: arr });
                });

                // ── Extract major road segments for crossing detection ──
                const majorSegments = [];
                data.elements.filter(e => e.type === 'way' && e.tags?.highway && e.nodes?.length >= 2).forEach(way => {
                    const cls = way.tags.highway;
                    // Only primary, secondary, and trunk roads count as "major"
                    if (cls !== 'primary' && cls !== 'secondary' && cls !== 'trunk') return;
                    for (let i = 0; i < way.nodes.length - 1; i++) {
                        const a = nodes[way.nodes[i]], b = nodes[way.nodes[i + 1]];
                        if (a && b) majorSegments.push({ lat1: a.lat, lng1: a.lng, lat2: b.lat, lng2: b.lng, name: way.tags.name || '' });
                    }
                });
                _majorRoadSegments = majorSegments;
                console.log('[Go] Overpass: ' + intersections.length + ' intersections, ' + majorSegments.length + ' major road segments');
                return intersections.length > 0 ? intersections : null;
            } catch (e) {
                console.warn('[Go] Overpass error at ' + url + ':', e.message);
                continue;
            }
        }

        console.error('[Go] All Overpass endpoints failed');
        return null;
    }

    function normalizeStreet(name) {
        if (!name) return '';
        let s = name.toLowerCase().trim();
        const abbrevs = [
            [/\bst\b\.?/g, 'street'], [/\bave?\b\.?/g, 'avenue'], [/\bblvd\b\.?/g, 'boulevard'],
            [/\bdr\b\.?/g, 'drive'], [/\brd\b\.?/g, 'road'], [/\bct\b\.?/g, 'court'],
            [/\bln\b\.?/g, 'lane'], [/\bpl\b\.?/g, 'place'], [/\bpkwy\b\.?/g, 'parkway'],
            [/\bhwy\b\.?/g, 'highway'], [/\bcir\b\.?/g, 'circle'], [/\bter\b\.?/g, 'terrace'],
            [/\bn\b\.?/g, 'north'], [/\bs\b\.?/g, 'south'], [/\be\b\.?/g, 'east'], [/\bw\b\.?/g, 'west'],
        ];
        abbrevs.forEach(([rx, rep]) => { s = s.replace(rx, rep); });
        return s.replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    }

    function streetMatch(osmName, ourName) {
        const a = normalizeStreet(osmName);
        const b = normalizeStreet(ourName);
        if (!a || !b) return false;
        if (a === b) return true;
        if (a.includes(b) || b.includes(a)) return true;
        const coreA = a.replace(/^(north|south|east|west)\s+/, '').replace(/\s+(street|avenue|boulevard|drive|road|court|lane|place|parkway)$/, '');
        const coreB = b.replace(/^(north|south|east|west)\s+/, '').replace(/\s+(street|avenue|boulevard|drive|road|court|lane|place|parkway)$/, '');
        if (coreA && coreB && (coreA === coreB || coreA.includes(coreB) || coreB.includes(coreA))) return true;
        return false;
    }

    function parseAddress(address) {
        if (!address) return { num: 0, street: '' };
        const firstPart = address.split(',')[0].trim();
        const numMatch = firstPart.match(/^(\d+)\s+(.+)$/);
        if (numMatch) return { num: parseInt(numMatch[1]), street: numMatch[2].trim() };
        return { num: 0, street: firstPart };
    }

    function showProgress(label, pct) { const c = document.getElementById('routeProgressCard'); c.style.display = ''; document.getElementById('routeProgressLabel').textContent = label; document.getElementById('routeProgressPct').textContent = Math.round(pct) + '%'; document.getElementById('routeProgressBar').style.width = pct + '%'; }
    function hideProgress() { document.getElementById('routeProgressCard').style.display = 'none'; }

    // =========================================================================
    // RENDER ROUTE RESULTS
    // =========================================================================
    function renderRouteResults(allShifts) {
        document.getElementById('routeResults').style.display = '';
        const btnLabel = document.getElementById('generateBtnLabel');
        if (btnLabel) btnLabel.textContent = 'Regenerate Routes';

        const assignEl = document.getElementById('busAssignmentTable');
        if (assignEl && _busAssignments && _detectedRegions) {
            let ah = '<div style="font-size:.8125rem;color:var(--text-muted);margin-bottom:.5rem">Buses stay in the same region across shifts.</div>';
            ah += '<div class="table-wrapper"><table class="data-table"><thead><tr><th>Bus</th>';
            D.shifts.forEach(sh => { ah += '<th>' + esc(sh.label || 'Shift') + '</th>'; });
            ah += '</tr></thead><tbody>';
            D.buses.forEach(b => {
                ah += '<tr><td style="font-weight:600"><span style="display:inline-flex;align-items:center;gap:6px"><span style="width:10px;height:10px;border-radius:50%;background:' + esc(b.color) + '"></span>' + esc(b.name) + '</span></td>';
                let prevRegion = null;
                D.shifts.forEach(sh => { const regionId = Object.keys(_busAssignments[sh.id] || {}).find(rid => (_busAssignments[sh.id][rid] || []).includes(b.id)); const reg = _detectedRegions.find(r => r.id === regionId); const changed = prevRegion && regionId !== prevRegion; ah += '<td style="' + (changed ? 'background:var(--amber-50);font-weight:700;color:var(--amber-700)' : '') + '">' + (reg ? '<span style="display:inline-flex;align-items:center;gap:4px"><span style="width:8px;height:8px;border-radius:50%;background:' + esc(reg.color) + '"></span>' + esc(reg.name) + '</span>' : '—') + (changed ? ' ⚡' : '') + '</td>'; prevRegion = regionId; });
                ah += '</tr>';
            });
            ah += '</tbody></table></div>'; assignEl.innerHTML = ah;
        }

        const container = document.getElementById('shiftResultsContainer');
        let html = '';
        allShifts.forEach((sr, si) => {
            const { shift, routes } = sr;
            const totalCampers = routes.reduce((s, r) => s + r.camperCount, 0);
            const totalStops = routes.reduce((s, r) => s + r.stops.filter(st => !st.isMonitor && !st.isCounselor).length, 0);
            const longest = routes.length ? Math.max(...routes.map(r => r.totalDuration), 0) : 0;
            html += '<details class="collapsible-card" open><summary class="collapsible-header"><span style="display:flex;align-items:center;gap:.5rem;"><span class="shift-num">' + (si + 1) + '</span>' + esc(shift.label || 'Shift ' + (si + 1)) + '</span><span style="font-size:.75rem;font-weight:400;color:var(--text-muted);">' + totalCampers + ' campers · ' + totalStops + ' stops · ' + longest + ' min</span></summary>';
            html += '<div class="collapsible-body" style="padding:.75rem;"><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:1rem;">';
            routes.filter(r => r.stops.length > 0).forEach(r => {
                html += '<div class="route-card"><div class="route-card-header" style="background:' + esc(r.busColor) + '"><div><h3>' + esc(r.busName) + '</h3><div class="route-meta">' + r.camperCount + ' campers · ' + r.stops.length + ' stops</div></div><div style="text-align:right"><div style="font-size:1.25rem;font-weight:700">' + r.totalDuration + ' min</div></div></div><ul class="route-stop-list">';
                r.stops.forEach(st => {
                    const names = st.isMonitor ? '🛡️ ' + esc(st.monitorName) : st.isCounselor ? '👤 ' + esc(st.counselorName) : st.campers.map(c => '<span style="display:inline-flex;align-items:center;gap:2px;">' + esc(c.name) + ' <button onclick="CampistryGo.openMoveModal(\'' + esc(c.name.replace(/'/g, "\\'")) + '\',\'' + r.busId + '\',' + si + ')" style="background:none;border:none;cursor:pointer;padding:0 2px;color:var(--text-muted);font-size:10px;" title="Move">↔</button></span>').join(', ');
                    html += '<li class="route-stop' + (st.isMonitor ? ' monitor-stop' : st.isCounselor ? ' counselor-stop' : '') + '"><div class="route-stop-num" style="background:' + esc(r.busColor) + '">' + st.stopNum + '</div><div class="route-stop-info"><div class="route-stop-names">' + names + '</div><div class="route-stop-addr">' + esc(st.address) + '</div></div><div class="route-stop-time">' + (st.estimatedTime || '—') + '</div></li>';
                });
                html += '</ul><div class="route-card-footer"><span>' + (r.monitor ? '🛡️ ' + esc(r.monitor.name) : '') + '</span><span>' + (r.counselors.length ? r.counselors.length + ' counselor(s)' : '') + '</span><button class="btn btn-ghost btn-sm" onclick="CampistryGo.reOptimizeBus(\'' + r.busId + '\',' + si + ')" title="Re-run TSP optimizer on this bus" style="margin-left:auto;font-size:.7rem;color:var(--text-muted);">⟳ Re-optimize</button></div></div>';
            });
            html += '</div></div></details>';
        });
        container.innerHTML = html;
        renderMasterList(allShifts);
        const routesTab = document.getElementById('tab-routes');
        if (routesTab && routesTab.classList.contains('active')) setTimeout(() => initMap(allShifts), 100);
        else _pendingMapInit = allShifts;
        renderCapacityWarnings();
        renderCarpool();
    }

    function renderMasterList(allShifts) {
        _allMasterRows = [];
        allShifts.forEach((sr, si) => { sr.routes.forEach(r => { r.stops.forEach(st => { if (st.isMonitor || st.isCounselor) return; st.campers.forEach(c => { const p = c.name.split(/\s+/); _allMasterRows.push({ firstName: p[0] || '', lastName: p.slice(1).join(' ') || '', shift: sr.shift.label || '', shiftIdx: si, busName: r.busName, busId: r.busId, busColor: r.busColor, stopNum: st.stopNum, address: st.address, time: st.estimatedTime || '—' }); }); }); }); });
        _allMasterRows.sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));
        renderFilteredMasterList();
    }

    let _allMasterRows = [];
    let _masterSort = { col: 'lastName', dir: 'asc' };
    function sortMasterBy(col) { if (_masterSort.col === col) _masterSort.dir = _masterSort.dir === 'asc' ? 'desc' : 'asc'; else { _masterSort.col = col; _masterSort.dir = 'asc'; } renderFilteredMasterList(); }
    function renderFilteredMasterList() {
        let rows = [..._allMasterRows];
        if (_activeShifts && _activeShifts.size < (_generatedRoutes?.length || 0)) rows = rows.filter(r => _activeShifts.has(r.shiftIdx));
        if (_activeMapBuses.size > 0) rows = rows.filter(r => _activeMapBuses.has(r.busId));
        const dir = _masterSort.dir === 'asc' ? 1 : -1; const col = _masterSort.col;
        rows.sort((a, b) => { const av = col === 'stopNum' ? a[col] : String(a[col] || '').toLowerCase(); const bv = col === 'stopNum' ? b[col] : String(b[col] || '').toLowerCase(); if (av < bv) return -1 * dir; if (av > bv) return 1 * dir; return 0; });
        const countEl = document.getElementById('masterListCount'); const label = document.getElementById('masterListLabel');
        const modeLabel = D.activeMode === 'arrival' ? 'Pickup' : 'Drop-off';
        if (countEl) countEl.textContent = rows.length + (rows.length < _allMasterRows.length ? ' of ' + _allMasterRows.length : '');
        if (label) label.textContent = rows.length < _allMasterRows.length ? 'Master ' + modeLabel + ' List (filtered)' : 'Master ' + modeLabel + ' List';
        function arrow(c) { return _masterSort.col === c ? (_masterSort.dir === 'asc' ? ' ▲' : ' ▼') : ''; }
        const thead = document.getElementById('masterListHead');
        if (thead) thead.innerHTML = '<tr><th style="cursor:pointer" onclick="CampistryGo.sortMasterBy(\'firstName\')">First' + arrow('firstName') + '</th><th style="cursor:pointer" onclick="CampistryGo.sortMasterBy(\'lastName\')">Last' + arrow('lastName') + '</th><th style="cursor:pointer" onclick="CampistryGo.sortMasterBy(\'shift\')">Shift' + arrow('shift') + '</th><th style="cursor:pointer" onclick="CampistryGo.sortMasterBy(\'busName\')">Bus' + arrow('busName') + '</th><th style="cursor:pointer" onclick="CampistryGo.sortMasterBy(\'stopNum\')">Stop' + arrow('stopNum') + '</th><th style="cursor:pointer" onclick="CampistryGo.sortMasterBy(\'address\')">Address' + arrow('address') + '</th><th style="cursor:pointer" onclick="CampistryGo.sortMasterBy(\'time\')">Time' + arrow('time') + '</th></tr>';
        document.getElementById('masterListBody').innerHTML = rows.map(r => '<tr><td style="font-weight:600">' + esc(r.firstName) + '</td><td style="font-weight:600">' + esc(r.lastName) + '</td><td>' + esc(r.shift) + '</td><td><span style="display:inline-flex;align-items:center;gap:6px"><span style="width:10px;height:10px;border-radius:50%;background:' + esc(r.busColor) + '"></span>' + esc(r.busName) + '</span></td><td style="font-weight:700;text-align:center">' + r.stopNum + '</td><td>' + esc(r.address) + '</td><td style="font-weight:600">' + r.time + '</td></tr>').join('');
    }

    // =========================================================================
    // ROUTE MAP (Leaflet) — unchanged from v3.0
    // =========================================================================
    let _map = null;
    let _mapLayers = [];
    let _addressPinLayers = [];
    let _showAddressPins = false;
    let _addressPinMode = 'both'; // 'campers', 'staff', 'both'
    let _hideRoutes = false;
    let _showZones = false;
    let _zoneLayers = [];
    let _activeShifts = new Set();
    let _activeMapBuses = new Set(); // empty = all buses visible
    let _pendingMapInit = null;
    let _routeGeomCache = {};
    window._routeGeomCache = _routeGeomCache;

    function isBusVisible(busId) { return _activeMapBuses.size === 0 || _activeMapBuses.has(busId); }
    function isAllBuses() { return _activeMapBuses.size === 0; }

    function addArrowsToLine(coords, color, map) {
        if (!coords || coords.length < 4) return [];
        const markers = []; let totalDist = 0;
        for (let i = 0; i < coords.length - 1; i++) totalDist += haversineMi(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1]);
        if (totalDist < 0.2) return [];
        const numArrows = Math.max(2, Math.min(12, Math.floor(totalDist / 0.4)));
        const interval = totalDist / (numArrows + 1);
        let accDist = 0, arrowIdx = 1;
        for (let i = 0; i < coords.length - 1 && arrowIdx <= numArrows; i++) {
            const segDist = haversineMi(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1]);
            while (accDist + segDist >= interval * arrowIdx && arrowIdx <= numArrows) {
                const frac = (interval * arrowIdx - accDist) / segDist;
                const lat = coords[i][0] + frac * (coords[i + 1][0] - coords[i][0]);
                const lng = coords[i][1] + frac * (coords[i + 1][1] - coords[i][1]);
                const dLng = (coords[i + 1][1] - coords[i][1]) * Math.PI / 180;
                const lat1 = coords[i][0] * Math.PI / 180, lat2 = coords[i + 1][0] * Math.PI / 180;
                const y = Math.sin(dLng) * Math.cos(lat2);
                const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
                const bearing = Math.atan2(y, x) * 180 / Math.PI;
                const icon = L.divIcon({ html: '<div style="font-size:11px;font-weight:900;color:' + color + ';transform:rotate(' + bearing + 'deg);opacity:0.85;text-shadow:-1px 0 0 #fff,1px 0 0 #fff;">›</div>', className: '', iconSize: [10, 10], iconAnchor: [5, 5] });
                const m = L.marker([lat, lng], { icon, interactive: false }).addTo(map);
                markers.push(m); arrowIdx++;
            }
            accDist += segDist;
        }
        return markers;
    }

    function initMap(allShifts) {
        _activeShifts = new Set(allShifts.map((_, i) => i));
        _activeMapBuses = new Set();
        const container = document.getElementById('routeMap');
        if (_map) { _map.remove(); _map = null; }
        _map = L.map(container, { scrollWheelZoom: true, zoomControl: true });
        const streetLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OSM', maxZoom: 19 });
        const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { attribution: '&copy; Esri', maxZoom: 19 });
        streetLayer.addTo(_map);
        L.control.layers({ 'Street': streetLayer, 'Satellite': satelliteLayer }, null, { position: 'topright', collapsed: true }).addTo(_map);
        renderMap();
    }

    async function renderMap(keepView) {
        if (!_map || !_generatedRoutes) return;
        const shiftIndices = [..._activeShifts].sort();
        const multiShift = shiftIndices.length > 1;
        const totalShifts = _generatedRoutes.length;

        const shiftBar = document.getElementById('mapShiftSelect');
        if (shiftBar) {
            shiftBar.innerHTML = '<button class="bus-tab all-tab' + (shiftIndices.length === totalShifts ? ' active' : '') + '" onclick="CampistryGo.setMapShiftsAll()">All Shifts</button>' +
                _generatedRoutes.map((sr, i) => '<button class="bus-tab' + (_activeShifts.has(i) ? ' active' : '') + '" onclick="CampistryGo.toggleMapShift(' + i + ')"><span class="shift-num" style="width:20px;height:20px;font-size:.65rem;">' + (i + 1) + '</span>' + esc(sr.shift.label || 'Shift ' + (i + 1)) + '</button>').join('');
        }

        const allRoutes = [];
        shiftIndices.forEach(si => { const sr = _generatedRoutes[si]; if (!sr) return; sr.routes.filter(r => r.stops.length > 0).forEach(r => { allRoutes.push({ ...r, shiftIdx: si, shiftLabel: sr.shift.label || 'Shift ' + (si + 1) }); }); });

        const tabsEl = document.getElementById('mapBusTabs');
        const uniqueBuses = []; const seen = new Set();
        allRoutes.forEach(r => { if (!seen.has(r.busId)) { seen.add(r.busId); uniqueBuses.push({ busId: r.busId, busName: r.busName, busColor: r.busColor }); } });
        tabsEl.innerHTML = '<button class="bus-tab all-tab' + (isAllBuses() ? ' active' : '') + '" onclick="CampistryGo.selectMapBus(\'all\')">All Buses</button>' +
            uniqueBuses.map(b => '<button class="bus-tab' + (_activeMapBuses.has(b.busId) ? ' active' : '') + '" onclick="CampistryGo.toggleMapBus(\'' + b.busId + '\')"><span class="bus-tab-dot" style="background:' + esc(b.busColor) + '"></span>' + esc(b.busName) + '</button>').join('') +
            '<span style="margin-left:auto;display:flex;gap:4px;align-items:center;">' +
            '<button class="bus-tab' + (!_hideRoutes ? ' active' : '') + '" onclick="CampistryGo.toggleHideRoutes()" style="' + (!_hideRoutes ? 'background:var(--blue-50);border-color:var(--blue-300);' : '') + '" title="Show/hide route lines">Routes</button>' +
            '<button class="bus-tab' + (_showZones ? ' active' : '') + '" onclick="CampistryGo.toggleZones()" style="' + (_showZones ? 'background:var(--green-50,#f0fdf4);border-color:var(--green-300,#86efac);' : '') + '" title="Show/hide bus zone regions">Zones</button>' +
            '<button class="bus-tab' + (_showAddressPins && _addressPinMode === 'both' ? ' active' : '') + '" onclick="CampistryGo.setAddressPinMode(\'both\')" style="' + (_showAddressPins && _addressPinMode === 'both' ? 'background:var(--blue-50);border-color:var(--blue-300);' : '') + '">All Pins</button>' +
            '<button class="bus-tab' + (_showAddressPins && _addressPinMode === 'campers' ? ' active' : '') + '" onclick="CampistryGo.setAddressPinMode(\'campers\')" style="' + (_showAddressPins && _addressPinMode === 'campers' ? 'background:var(--blue-50);border-color:var(--blue-300);' : '') + '">Campers</button>' +
            '<button class="bus-tab' + (_showAddressPins && _addressPinMode === 'staff' ? ' active' : '') + '" onclick="CampistryGo.setAddressPinMode(\'staff\')" style="' + (_showAddressPins && _addressPinMode === 'staff' ? 'background:var(--amber-50);border-color:var(--amber-300);' : '') + '">Staff</button>' +
            '</span>';

        _mapLayers.forEach(l => _map.removeLayer(l)); _mapLayers = [];
        const allLatLngs = [];

        if (_campCoordsCache) {
            const campIcon = L.divIcon({ html: '<div style="width:32px;height:32px;background:#1e293b;border:3px solid #fff;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,.4);"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></div>', className: '', iconSize: [32, 32], iconAnchor: [16, 16] });
            const campMarker = L.marker([_campCoordsCache.lat, _campCoordsCache.lng], { icon: campIcon, zIndexOffset: 1000 }).addTo(_map);
            campMarker.bindPopup('<strong>' + esc(D.setup.campName || 'Camp') + '</strong><br>' + esc(D.setup.campAddress));
            _mapLayers.push(campMarker); allLatLngs.push([_campCoordsCache.lat, _campCoordsCache.lng]);
        }

        const visibleRoutes = isAllBuses() ? allRoutes : allRoutes.filter(r => _activeMapBuses.has(r.busId));
        function getDash(shiftIdx) { if (totalShifts <= 1 || !multiShift) return null; if (shiftIdx === 0) return null; if (shiftIdx === 1) return '10, 6'; return '4, 6'; }

        for (const route of visibleRoutes) {
            const stopsWithCoords = route.stops.filter(s => s.lat && s.lng);
            if (!stopsWithCoords.length) continue;
            const isArrival = D.activeMode === 'arrival';
            const mapNeedsReturn = !isArrival && D.shifts.length > 1 && route.shiftIdx < _generatedRoutes.length - 1;
            const straightCoords = [];
            if (!isArrival && _campCoordsCache) straightCoords.push([_campCoordsCache.lat, _campCoordsCache.lng]);
            stopsWithCoords.forEach(s => straightCoords.push([s.lat, s.lng]));
            if (isArrival && _campCoordsCache) straightCoords.push([_campCoordsCache.lat, _campCoordsCache.lng]);
            if (mapNeedsReturn && _campCoordsCache) straightCoords.push([_campCoordsCache.lat, _campCoordsCache.lng]);
            allLatLngs.push(...straightCoords);

            const dashPattern = getDash(route.shiftIdx);
            const lineWeight = isAllBuses() ? 3 : 5;
            const lineOpacity = isAllBuses() ? 0.7 : 0.9;

            if (_hideRoutes) continue; // skip route lines + stop markers when hidden
            const cacheKey = route.busId + '_' + route.shiftIdx;
            let roadCoords = _routeGeomCache[cacheKey];

            if (roadCoords) {
                const polyline = L.polyline(roadCoords, { color: route.busColor, weight: lineWeight, opacity: lineOpacity, dashArray: dashPattern }).addTo(_map);
                polyline._goRouteKey = cacheKey; _mapLayers.push(polyline);
            } else {
                const tempLine = L.polyline(straightCoords, { color: route.busColor, weight: lineWeight, opacity: lineOpacity * 0.4, dashArray: dashPattern }).addTo(_map);
                tempLine._goRouteKey = cacheKey; _mapLayers.push(tempLine);

                if (straightCoords.length >= 2) {
                    const mbToken = D.setup.mapboxToken || _PLATFORM_KEYS.mapbox;
                    const wp = [];
                    if (!isArrival && _campCoordsCache) wp.push(_campCoordsCache.lng + ',' + _campCoordsCache.lat);
                    stopsWithCoords.forEach(s => wp.push(s.lng + ',' + s.lat));
                    if (isArrival && _campCoordsCache) wp.push(_campCoordsCache.lng + ',' + _campCoordsCache.lat);
                    if (mapNeedsReturn && _campCoordsCache) wp.push(_campCoordsCache.lng + ',' + _campCoordsCache.lat);
                    (async function(coordStr, color, ck, temp, dash, w, o) {
                        try {
                            const url = mbToken ? 'https://api.mapbox.com/directions/v5/mapbox/driving/' + coordStr + '?overview=full&geometries=geojson&access_token=' + mbToken : 'https://router.project-osrm.org/route/v1/driving/' + coordStr + '?overview=full&geometries=geojson&continue_straight=true';
                            const resp = await fetch(url); if (resp.ok) { const data = await resp.json(); const coords = data.routes?.[0]?.geometry?.coordinates; if (coords) { const pts = coords.map(c => [c[1], c[0]]); if (pts.length > 0 && _map) { _routeGeomCache[ck] = pts; _map.removeLayer(temp); const idx = _mapLayers.indexOf(temp); if (idx >= 0) _mapLayers.splice(idx, 1); const road = L.polyline(pts, { color, weight: w, opacity: o, dashArray: dash }).addTo(_map); road._goRouteKey = ck; _mapLayers.push(road); } } }
                        } catch (e) { console.warn('[Go] Road geometry failed:', e.message); }
                    })(wp.join(';'), route.busColor, cacheKey, tempLine, dashPattern, lineWeight, lineOpacity);
                }
            }

            stopsWithCoords.forEach(stop => {
                const isSpecial = stop.isMonitor || stop.isCounselor;
                const size = isSpecial ? 20 : 26;
                const icon = L.divIcon({ html: '<div class="stop-marker-icon" style="width:' + size + 'px;height:' + size + 'px;background:' + esc(route.busColor) + ';' + (isSpecial ? 'font-size:10px;' : '') + '">' + (isSpecial ? (stop.isMonitor ? 'M' : 'C') : stop.stopNum) + '</div>', className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
                const names = stop.isMonitor ? '🛡️ ' + (stop.monitorName || 'Monitor') : stop.isCounselor ? '🎒 ' + (stop.counselorName || 'Counselor') : stop.campers.map(c => c.name).join('<br>');
                const counselorNames = (stop._counselors?.length) ? '<div style="margin-top:6px;padding-top:6px;border-top:1px solid #eee;">' + stop._counselors.map(c => '<div style="font-size:11px;display:flex;align-items:center;gap:4px;">🎒 <strong>' + esc(c.name) + '</strong> <span style="color:#888;">(' + c.walkFt + 'ft walk)</span></div>').join('') + '</div>' : '';
                const popup = '<div style="font-family:DM Sans,sans-serif;min-width:160px;"><div style="font-weight:700;color:' + route.busColor + '">' + esc(route.busName) + ' — ' + esc(route.shiftLabel) + '</div><div style="font-weight:600;">Stop ' + stop.stopNum + '</div><div style="font-size:12px;">' + names + '</div>' + counselorNames + '<div style="font-size:11px;color:#888;">' + esc(stop.address) + '</div>' + (stop.estimatedTime ? '<div style="font-weight:600;">Est: ' + stop.estimatedTime + '</div>' : '') + '</div>';
                const marker = L.marker([stop.lat, stop.lng], { icon, draggable: !isSpecial }).addTo(_map);
                marker.bindPopup(popup);
                (function(theStop, theBusId, theShiftIdx) { marker.on('click', function(e) { if (window._mapEditorStopClick && window._mapEditorStopClick(theStop, theBusId, theShiftIdx)) marker.closePopup(); }); })(stop, route.busId, route.shiftIdx);
                _mapLayers.push(marker);
            });
        }

        if (allLatLngs.length > 0 && !keepView) _map.fitBounds(L.latLngBounds(allLatLngs), { padding: [50, 50], maxZoom: 14 });

        const legendEl = document.getElementById('mapLegend');
        if (legendEl) {
            if (multiShift) { legendEl.innerHTML = shiftIndices.map(si => { const sr = _generatedRoutes[si]; const d = getDash(si); const svgLine = !d ? '<line x1="0" y1="6" x2="40" y2="6" stroke="#555" stroke-width="3"/>' : d.startsWith('10') ? '<line x1="0" y1="6" x2="40" y2="6" stroke="#555" stroke-width="3" stroke-dasharray="5,3"/>' : '<line x1="0" y1="6" x2="40" y2="6" stroke="#555" stroke-width="3" stroke-dasharray="2,3"/>'; return '<span style="display:inline-flex;align-items:center;gap:.375rem;font-size:.75rem;"><svg width="40" height="12">' + svgLine + '</svg>' + esc(sr.shift.label || 'Shift ' + (si + 1)) + '</span>'; }).join('<span style="margin:0 .5rem;color:var(--border-medium);">|</span>'); legendEl.style.display = ''; }
            else legendEl.style.display = 'none';
        }
        if (_showAddressPins) renderAddressPins();
        if (_showZones) renderZoneLayers();
    }

    function selectMapBus(busId) {
        if (busId === 'all') { _activeMapBuses = new Set(); }
        else { _activeMapBuses = new Set([busId]); }
        renderMap(true); renderFilteredMasterList();
    }
    function toggleMapBus(busId) {
        if (_activeMapBuses.has(busId)) { _activeMapBuses.delete(busId); }
        else { _activeMapBuses.add(busId); }
        renderMap(true); renderFilteredMasterList();
    }
    async function setAddressPinMode(mode) {
        if (_showAddressPins && _addressPinMode === mode) {
            _showAddressPins = false; clearAddressPins();
        } else {
            _addressPinMode = mode;
            _showAddressPins = true;
            // Geocode any counselors that don't have coords yet
            if (mode === 'staff' || mode === 'both') {
                for (const c of D.counselors.filter(x => x.address && !x._lat)) {
                    const geo = await geocodeSingle(c.address);
                    if (geo) { c._lat = geo.lat; c._lng = geo.lng; }
                }
                for (const m of D.monitors.filter(x => x.address)) {
                    const a = D.addresses[m.name];
                    if (a && !a.geocoded && m.address) {
                        const geo = await geocodeSingle(m.address);
                        if (geo) { a.lat = geo.lat; a.lng = geo.lng; a.geocoded = true; }
                    }
                }
            }
            renderAddressPins();
        }
        if (_generatedRoutes) renderMap(true); else if (_showAddressPins) renderAddressPinsAll();
    }
    function toggleHideRoutes() { _hideRoutes = !_hideRoutes; renderMap(true); }
    function toggleZones() {
        _showZones = !_showZones;
        if (_showZones) renderZoneLayers();
        else clearZoneLayers();
        // Re-render map tabs to update button state
        if (_generatedRoutes) renderMap(true);
    }
    function clearZoneLayers() {
        _zoneLayers.forEach(l => { if (_map) _map.removeLayer(l); });
        _zoneLayers = [];
    }
    function renderZoneLayers() {
        if (!_map || !_generatedRoutes) return;
        clearZoneLayers();

        // Build zones from actual route data — one polygon per bus,
        // using all camper home addresses on that bus as the boundary.
        // This naturally combines multiple source zones into one shape
        // when a bus covers more than one zone.
        const shiftIndices = [..._activeShifts].sort();
        const busZones = {}; // busId → {color, name, coords[]}

        shiftIndices.forEach(si => {
            const sr = _generatedRoutes[si];
            if (!sr) return;
            sr.routes.forEach(r => {
                if (!r.stops.length) return;
                if (!isBusVisible(r.busId)) return;
                if (!busZones[r.busId]) busZones[r.busId] = { color: r.busColor, name: r.busName, coords: [], kidCount: 0 };
                r.stops.forEach(st => {
                    if (st.isMonitor || st.isCounselor) return;
                    // Use camper home addresses for a tighter hull
                    st.campers.forEach(c => {
                        const a = D.addresses[c.name];
                        if (a?.lat && a.lng) busZones[r.busId].coords.push([a.lat, a.lng]);
                    });
                    busZones[r.busId].kidCount += st.campers.length;
                });
            });
        });

        Object.values(busZones).forEach(bz => {
            if (bz.coords.length < 3) return;

            const hull = convexHull(bz.coords);
            if (hull.length < 3) return;

            const polygon = L.polygon(hull, {
                color: bz.color, weight: 4, fillOpacity: 0.25, fillColor: bz.color
            }).addTo(_map);
            polygon.bindPopup('<strong>' + esc(bz.name) + '</strong><br>' + bz.kidCount + ' campers');
            _zoneLayers.push(polygon);

            // Label at centroid of hull
            const cLat = hull.reduce((s, p) => s + p[0], 0) / hull.length;
            const cLng = hull.reduce((s, p) => s + p[1], 0) / hull.length;
            const labelIcon = L.divIcon({
                html: '<div style="background:' + esc(bz.color) + ';color:#fff;padding:6px 12px;border-radius:8px;font-size:13px;font-weight:800;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.4);font-family:DM Sans,sans-serif;letter-spacing:.3px;border:2px solid #fff;">' + esc(bz.name) + ' &mdash; ' + bz.kidCount + ' kids</div>',
                className: '', iconAnchor: [70, 14]
            });
            const label = L.marker([cLat, cLng], { icon: labelIcon, interactive: false, zIndexOffset: 900 }).addTo(_map);
            _zoneLayers.push(label);
        });

        console.log('[Go] Zone overlay: ' + Object.keys(busZones).length + ' bus zones displayed');
    }
    function toggleAddressPins() { setAddressPinMode(_addressPinMode); }
    function toggleMapShift(idx) { if (_activeShifts.has(idx)) { if (_activeShifts.size > 1) _activeShifts.delete(idx); } else _activeShifts.add(idx); renderMap(true); renderFilteredMasterList(); }
    function setMapShiftsAll() { _activeShifts = new Set(_generatedRoutes.map((_, i) => i)); renderMap(true); renderFilteredMasterList(); }
    function toggleMapFullscreen() { const card = document.getElementById('routeMapCard'); if (!card) return; card.classList.toggle('map-fullscreen'); setTimeout(() => { if (_map) _map.invalidateSize(); }, 100); }

    // =========================================================================
    // ADDRESS PINS
    // =========================================================================
    function clearAddressPins() { _addressPinLayers.forEach(l => { if (_map) _map.removeLayer(l); }); _addressPinLayers = []; if (_map?._addressLegend) { _map.removeControl(_map._addressLegend); _map._addressLegend = null; } }
    function renderAddressPins() {
        if (!_map) return; clearAddressPins();
        const roster = getRoster(); const shiftIndices = [..._activeShifts].sort();
        const showCampers = _addressPinMode === 'both' || _addressPinMode === 'campers';
        const showStaff = _addressPinMode === 'both' || _addressPinMode === 'staff';
        const camperPins = [];
        if (_generatedRoutes && showCampers) {
            shiftIndices.forEach(si => { const sr = _generatedRoutes[si]; if (!sr) return; sr.routes.forEach(r => { if (!isBusVisible(r.busId)) return; r.stops.forEach(st => { if (st.isMonitor || st.isCounselor) return; st.campers.forEach(c => { const a = D.addresses[c.name]; if (!a?.geocoded || !a.lat || !a.lng) return; camperPins.push({ name: c.name, lat: a.lat, lng: a.lng, address: [a.street, a.city, a.state, a.zip].filter(Boolean).join(', '), color: r.busColor, busName: r.busName, division: c.division || '', bunk: c.bunk || '' }); }); }); }); });
        } else if (showCampers) { renderAddressPinsAll(); return; }
        camperPins.forEach(pin => {
            const icon = L.divIcon({ html: '<div style="width:10px;height:10px;background:' + esc(pin.color) + ';border:2px solid #fff;border-radius:50%;box-shadow:0 1px 3px rgba(0,0,0,.4);"></div>', className: '', iconSize: [10, 10], iconAnchor: [5, 5] });
            const marker = L.marker([pin.lat, pin.lng], { icon, zIndexOffset: -100 }).addTo(_map);
            marker.bindPopup('<div style="font-family:DM Sans,sans-serif;min-width:150px;"><div style="font-weight:700;">' + esc(pin.name) + '</div><div style="font-size:12px;color:#666;">' + esc(pin.division) + (pin.bunk ? ' / Bunk ' + esc(pin.bunk) : '') + '</div><div style="font-size:12px;margin-top:4px;">' + esc(pin.address) + '</div><div style="font-size:11px;margin-top:4px;display:flex;align-items:center;gap:4px;"><span style="width:8px;height:8px;border-radius:50%;background:' + esc(pin.color) + ';display:inline-block;"></span><span style="font-weight:600;">' + esc(pin.busName) + '</span></div></div>');
            _addressPinLayers.push(marker);
        });
        if (camperPins.length) console.log('[Go] Address pins: ' + camperPins.length + ' campers' + (!isAllBuses() ? ' (filtered)' : ''));

        // Staff/counselor pins — diamond shape to differentiate from camper circles
        const staffPins = [];
        if (showStaff) {
        D.counselors.filter(c => c.address).forEach(c => {
            // Use cached coords, or try D.addresses fallback
            let lat = c._lat, lng = c._lng;
            if (!lat) { const a = D.addresses[c.name]; if (a?.lat) { lat = a.lat; lng = a.lng; } }
            if (!lat || !lng) return;
            if (!isAllBuses() && c._assignedBus && !_activeMapBuses.has(c._assignedBus)) return;
            const bus = D.buses.find(b => b.id === c._assignedBus);
            const color = bus?.color || '#f59e0b';
            staffPins.push({ name: c.name, lat, lng, address: c.address, color, busName: c._assignedBusName || '—', bunk: c.bunk || '', walkFt: c._walkFt || '?' });
        });
        D.monitors.filter(m => m.address).forEach(m => {
            const a = D.addresses[m.name] || {};
            if (!a.lat || !a.lng) return;
            const bus = D.buses.find(b => b.id === m.assignedBus);
            if (!isAllBuses() && m.assignedBus && !_activeMapBuses.has(m.assignedBus)) return;
            const color = bus?.color || '#f59e0b';
            staffPins.push({ name: m.name + ' (monitor)', lat: a.lat, lng: a.lng, address: [a.street, a.city, a.state, a.zip].filter(Boolean).join(', '), color, busName: bus?.name || '—', bunk: '', walkFt: '' });
        });
        } // end if (showStaff)
        staffPins.forEach(pin => {
            const icon = L.divIcon({ html: '<div style="width:14px;height:14px;background:' + esc(pin.color) + ';border:2.5px solid #fbbf24;border-radius:3px;box-shadow:0 1px 4px rgba(0,0,0,.5);transform:rotate(45deg);position:relative;"><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;transform:rotate(-45deg);font-size:8px;color:#fff;font-weight:bold;">★</div></div>', className: '', iconSize: [14, 14], iconAnchor: [7, 7] });
            const marker = L.marker([pin.lat, pin.lng], { icon, zIndexOffset: -50 }).addTo(_map);
            marker.bindPopup('<div style="font-family:DM Sans,sans-serif;min-width:150px;"><div style="font-weight:700;">🎒 ' + esc(pin.name) + '</div><div style="font-size:12px;color:#666;">Staff' + (pin.bunk ? ' / Bunk ' + esc(pin.bunk) : '') + '</div><div style="font-size:12px;margin-top:4px;">' + esc(pin.address) + '</div>' + (pin.walkFt ? '<div style="font-size:11px;margin-top:4px;color:var(--text-muted)">Walk to stop: ' + pin.walkFt + 'ft</div>' : '') + '<div style="font-size:11px;margin-top:4px;display:flex;align-items:center;gap:4px;"><span style="width:8px;height:8px;border-radius:2px;background:' + esc(pin.color) + ';display:inline-block;transform:rotate(45deg);"></span><span style="font-weight:600;">' + esc(pin.busName) + '</span></div></div>');
            _addressPinLayers.push(marker);
        });
        if (staffPins.length) console.log('[Go] Address pins: ' + staffPins.length + ' staff (◆ diamond pins)');

        // Add legend to map
        if (!_map._addressLegend) {
            const legend = L.control({ position: 'bottomleft' });
            legend.onAdd = function() {
                const div = L.DomUtil.create('div', '');
                div.style.cssText = 'background:rgba(255,255,255,.92);backdrop-filter:blur(4px);padding:8px 12px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.15);font-family:DM Sans,sans-serif;font-size:12px;line-height:1.6;';
                div.innerHTML = '<div style="font-weight:700;margin-bottom:4px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#64748b;">Map Legend</div>'
                    + '<div style="display:flex;align-items:center;gap:6px;"><div style="width:10px;height:10px;background:#3b82f6;border:2px solid #fff;border-radius:50%;box-shadow:0 1px 2px rgba(0,0,0,.3);flex-shrink:0;"></div> Camper home</div>'
                    + '<div style="display:flex;align-items:center;gap:6px;margin-top:2px;"><div style="width:12px;height:12px;background:#f59e0b;border:2px solid #fbbf24;border-radius:2px;box-shadow:0 1px 2px rgba(0,0,0,.3);transform:rotate(45deg);flex-shrink:0;position:relative;"><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;transform:rotate(-45deg);font-size:7px;color:#fff;">★</div></div> Staff home</div>';
                return div;
            };
            legend.addTo(_map);
            _map._addressLegend = legend;
        }
    }
    function renderAddressPinsAll() {
        if (!_map) return; clearAddressPins();
        const showCampers = _addressPinMode === 'both' || _addressPinMode === 'campers';
        const showStaff = _addressPinMode === 'both' || _addressPinMode === 'staff';
        const roster = getRoster(); const allLatLngs = [];
        if (showCampers) {
        Object.entries(roster).forEach(([name, c]) => { const a = D.addresses[name]; if (!a?.geocoded || !a.lat || !a.lng) return; if (a.transport === 'pickup') return; const icon = L.divIcon({ html: '<div style="width:8px;height:8px;background:#3b82f6;border:2px solid #fff;border-radius:50%;box-shadow:0 1px 3px rgba(0,0,0,.3);"></div>', className: '', iconSize: [8, 8], iconAnchor: [4, 4] }); const marker = L.marker([a.lat, a.lng], { icon, zIndexOffset: -100 }).addTo(_map); marker.bindPopup('<div style="font-family:DM Sans,sans-serif;"><div style="font-weight:700;">' + esc(name) + '</div><div style="font-size:12px;color:#666;">' + esc(c.division || '') + (c.bunk ? ' / Bunk ' + esc(c.bunk) : '') + '</div><div style="font-size:12px;margin-top:4px;">' + esc([a.street, a.city, a.state, a.zip].filter(Boolean).join(', ')) + '</div></div>'); _addressPinLayers.push(marker); allLatLngs.push([a.lat, a.lng]); });
        }
        if (allLatLngs.length > 0 && !_generatedRoutes) _map.fitBounds(L.latLngBounds(allLatLngs), { padding: [50, 50], maxZoom: 14 });
        if (showCampers) console.log('[Go] Address pins: ' + _addressPinLayers.length + ' campers (all)');

        // Staff pins (diamond, amber) — pre-generation mode
        let staffCount = 0;
        if (showStaff) {
        [...D.counselors, ...D.monitors].filter(s => s.address).forEach(s => {
            let lat = s._lat, lng = s._lng;
            const a = D.addresses[s.name];
            if (!lat && a?.lat) { lat = a.lat; lng = a.lng; }
            if (!lat || !lng) return;
            const icon = L.divIcon({ html: '<div style="width:12px;height:12px;background:#f59e0b;border:2.5px solid #fbbf24;border-radius:2px;box-shadow:0 1px 4px rgba(0,0,0,.4);transform:rotate(45deg);position:relative;"><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;transform:rotate(-45deg);font-size:7px;color:#fff;font-weight:bold;">★</div></div>', className: '', iconSize: [12, 12], iconAnchor: [6, 6] });
            const marker = L.marker([lat, lng], { icon, zIndexOffset: -50 }).addTo(_map);
            marker.bindPopup('<div style="font-family:DM Sans,sans-serif;"><div style="font-weight:700;">🎒 ' + esc(s.name) + '</div><div style="font-size:12px;color:#666;">Staff' + (s.bunk ? ' / Bunk ' + esc(s.bunk) : '') + '</div><div style="font-size:12px;margin-top:4px;">' + esc(s.address) + '</div></div>');
            _addressPinLayers.push(marker); allLatLngs.push([lat, lng]); staffCount++;
        });
        } // end if (showStaff)
        if (staffCount) console.log('[Go] Address pins: ' + staffCount + ' staff (◆ diamond pins)');

        // Add legend
        if (!_map._addressLegend) {
            const legend = L.control({ position: 'bottomleft' });
            legend.onAdd = function() {
                const div = L.DomUtil.create('div', '');
                div.style.cssText = 'background:rgba(255,255,255,.92);backdrop-filter:blur(4px);padding:8px 12px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.15);font-family:DM Sans,sans-serif;font-size:12px;line-height:1.6;';
                div.innerHTML = '<div style="font-weight:700;margin-bottom:4px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#64748b;">Map Legend</div>'
                    + '<div style="display:flex;align-items:center;gap:6px;"><div style="width:10px;height:10px;background:#3b82f6;border:2px solid #fff;border-radius:50%;box-shadow:0 1px 2px rgba(0,0,0,.3);flex-shrink:0;"></div> Camper home</div>'
                    + '<div style="display:flex;align-items:center;gap:6px;margin-top:2px;"><div style="width:12px;height:12px;background:#f59e0b;border:2px solid #fbbf24;border-radius:2px;box-shadow:0 1px 2px rgba(0,0,0,.3);transform:rotate(45deg);flex-shrink:0;position:relative;"><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;transform:rotate(-45deg);font-size:7px;color:#fff;">★</div></div> Staff home</div>';
                return div;
            };
            legend.addTo(_map);
            _map._addressLegend = legend;
        }
    }
    function showAddressesOnMap() {
        if (!_map) { const container = document.getElementById('routeMap'); if (!container) return; _map = L.map(container, { scrollWheelZoom: true, zoomControl: true }); L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OSM', maxZoom: 19 }).addTo(_map); if (_campCoordsCache) { const campIcon = L.divIcon({ html: '<div style="width:32px;height:32px;background:#1e293b;border:3px solid #fff;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,.4);"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></div>', className: '', iconSize: [32, 32], iconAnchor: [16, 16] }); L.marker([_campCoordsCache.lat, _campCoordsCache.lng], { icon: campIcon, zIndexOffset: 1000 }).addTo(_map).bindPopup('<strong>' + esc(D.setup.campName || 'Camp') + '</strong>'); } }
        _showAddressPins = true; renderAddressPinsAll();
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        document.querySelector('.tab-btn[data-tab="routes"]')?.classList.add('active');
        document.getElementById('tab-routes')?.classList.add('active');
        setTimeout(() => { if (_map) _map.invalidateSize(); }, 150);
        toast('Showing ' + _addressPinLayers.length + ' camper addresses');
    }

    // =========================================================================
    // DAILY OVERRIDES
    // =========================================================================
    function getTodayKey() { const d = new Date(); d.setHours(12, 0, 0, 0); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
    function getOverrides() { const key = getTodayKey(); if (!D.dailyOverrides[key]) D.dailyOverrides[key] = {}; return D.dailyOverrides[key]; }
    function addOverride(camperName, type, details) { const ov = getOverrides(); ov[camperName] = { type, ...details, timestamp: Date.now() }; save(); if (_generatedRoutes) renderRouteResults(applyOverrides(_generatedRoutes)); renderDailyOverrides(); toast('Override added for ' + camperName); }
    function removeOverride(camperName) { const ov = getOverrides(); delete ov[camperName]; save(); if (_generatedRoutes) renderRouteResults(applyOverrides(_generatedRoutes)); renderDailyOverrides(); toast('Override removed'); }

    function applyOverrides(routes) {
        if (!routes) return routes;
        const ov = getOverrides(); if (!Object.keys(ov).length) return routes;
        const clone = JSON.parse(JSON.stringify(routes));
        Object.entries(ov).forEach(([camperName, override]) => {
            if (override.type === 'not-riding') {
                clone.forEach(sr => { sr.routes.forEach(r => { r.stops.forEach(st => { st.campers = st.campers.filter(c => c.name !== camperName); }); r.stops = r.stops.filter(st => st.campers.length > 0 || st.isMonitor || st.isCounselor); r.stops.forEach((st, i) => { st.stopNum = i + 1; }); r.camperCount = r.stops.reduce((s, st) => s + st.campers.length, 0); }); });
            }
            if (override.type === 'ride-with') {
                const targetName = override.targetCamper;
                let targetBusId = null, targetShiftIdx = null, targetStopIdx = null;
                clone.forEach((sr, si) => { sr.routes.forEach(r => { r.stops.forEach((st, sti) => { if (st.campers.some(c => c.name === targetName)) { targetBusId = r.busId; targetShiftIdx = si; targetStopIdx = sti; } }); }); });
                if (targetBusId !== null) {
                    clone.forEach(sr => { sr.routes.forEach(r => { r.stops.forEach(st => { st.campers = st.campers.filter(c => c.name !== camperName); }); r.stops = r.stops.filter(st => st.campers.length > 0 || st.isMonitor || st.isCounselor); }); });
                    const targetRoute = clone[targetShiftIdx]?.routes.find(r => r.busId === targetBusId);
                    if (targetRoute?.stops[targetStopIdx]) { const roster = getRoster(); const camper = roster[camperName] || {}; targetRoute.stops[targetStopIdx].campers.push({ name: camperName, division: camper.division || '', bunk: camper.bunk || '' }); }
                    clone.forEach(sr => { sr.routes.forEach(r => { r.stops.forEach((st, i) => { st.stopNum = i + 1; }); r.camperCount = r.stops.reduce((s, st) => s + st.campers.length, 0); }); });
                }
            }
            if (override.type === 'add-rider') {
                const addr = D.addresses[camperName]; if (!addr?.geocoded) return;
                const roster = getRoster(); const camper = roster[camperName] || {};
                clone.forEach(sr => { const divSet = new Set(sr.shift.divisions || []); if (!divSet.has(camper.division)) return; let bestRoute = null, bestStopIdx = -1, bestDist = Infinity; sr.routes.forEach(r => { r.stops.forEach((st, sti) => { if (!st.lat || !st.lng) return; const d = haversineMi(addr.lat, addr.lng, st.lat, st.lng); if (d < bestDist) { bestDist = d; bestRoute = r; bestStopIdx = sti; } }); }); if (bestRoute && bestStopIdx >= 0) { if (bestDist <= 0.3) bestRoute.stops[bestStopIdx].campers.push({ name: camperName, division: camper.division || '', bunk: camper.bunk || '' }); else { const cLa = D.setup.campLat || _campCoordsCache?.lat || 0; const cLn = D.setup.campLng || _campCoordsCache?.lng || 0; directionalInsert(bestRoute.stops, { stopNum: 0, campers: [{ name: camperName, division: camper.division || '', bunk: camper.bunk || '' }], address: [addr.street, addr.city, addr.state, addr.zip].filter(Boolean).join(', '), lat: addr.lat, lng: addr.lng }, cLa, cLn); } bestRoute.camperCount = bestRoute.stops.reduce((s, st) => s + st.campers.length, 0); } });
            }
        });
        return clone;
    }

    function renderDailyOverrides() {
        const container = document.getElementById('dailyOverridesBody'); if (!container) return;
        const ov = getOverrides(); const entries = Object.entries(ov);
        if (!entries.length) { container.innerHTML = '<div style="text-align:center;padding:1rem;color:var(--text-muted);">No overrides for today.</div>'; return; }
        container.innerHTML = entries.map(([name, ov]) => { let desc = '', badgeCls = 'badge-neutral'; if (ov.type === 'not-riding') { desc = 'Not riding'; badgeCls = 'badge-danger'; } else if (ov.type === 'ride-with') { desc = 'With ' + esc(ov.targetCamper); badgeCls = 'badge-warning'; } else if (ov.type === 'add-rider') { desc = 'Added to bus'; badgeCls = 'badge-success'; } return '<div style="display:flex;align-items:center;justify-content:space-between;padding:.5rem 0;border-bottom:1px solid var(--border-light);font-size:.8125rem;"><div><strong>' + esc(name) + '</strong> — <span class="badge ' + badgeCls + '">' + desc + '</span></div><button class="btn btn-ghost btn-sm" style="color:var(--red-500)" onclick="CampistryGo.removeOverride(\'' + esc(name.replace(/'/g, "\\'")) + '\')">Remove</button></div>'; }).join('');
    }

    function openOverrideModal() { const roster = getRoster(); const names = Object.keys(roster).sort(); const sel = document.getElementById('overrideCamper'); sel.innerHTML = '<option value="">— Select —</option>' + names.map(n => '<option value="' + esc(n) + '">' + esc(n) + '</option>').join(''); document.getElementById('overrideSearch').value = ''; document.getElementById('overrideType').value = 'not-riding'; document.getElementById('overrideRideWithGroup').style.display = 'none'; openModal('overrideModal'); }
    function filterOverrideSelect(inputId, selectId) { const q = (document.getElementById(inputId)?.value || '').toLowerCase().trim(); const sel = document.getElementById(selectId); const roster = getRoster(); const names = Object.keys(roster).sort(); const filtered = q ? names.filter(n => n.toLowerCase().includes(q)) : names; sel.innerHTML = '<option value="">— Select —</option>' + filtered.map(n => '<option value="' + esc(n) + '">' + esc(n) + '</option>').join(''); if (filtered.length === 1) sel.value = filtered[0]; }
    function onOverrideTypeChange() { const type = document.getElementById('overrideType')?.value; document.getElementById('overrideRideWithGroup').style.display = type === 'ride-with' ? '' : 'none'; if (type === 'ride-with') { document.getElementById('overrideTargetSearch').value = ''; filterOverrideSelect('overrideTargetSearch', 'overrideTarget'); } }
    function saveOverride() { const camper = document.getElementById('overrideCamper')?.value; const type = document.getElementById('overrideType')?.value; if (!camper) { toast('Select a camper', 'error'); return; } if (type === 'ride-with') { const target = document.getElementById('overrideTarget')?.value; if (!target) { toast('Select target', 'error'); return; } addOverride(camper, 'ride-with', { targetCamper: target }); } else if (type === 'add-rider') { if (!D.addresses[camper]?.geocoded) { toast('Need geocoded address', 'error'); return; } addOverride(camper, 'add-rider', {}); } else addOverride(camper, 'not-riding', {}); closeModal('overrideModal'); }

    // =========================================================================
    // CAMPER SEARCH + MOVE
    // =========================================================================
    function searchCamperInRoutes(query) {
        if (!_generatedRoutes || !query) return;
        const q = query.toLowerCase().trim(); if (!q) { if (_generatedRoutes) renderRouteResults(applyOverrides(_generatedRoutes)); return; }
        const results = []; const applied = applyOverrides(_generatedRoutes);
        applied.forEach(sr => { sr.routes.forEach(r => { r.stops.forEach(st => { st.campers.forEach(c => { if (c.name.toLowerCase().includes(q)) results.push({ name: c.name, shift: sr.shift.label || '', busName: r.busName, busColor: r.busColor, busId: r.busId, stopNum: st.stopNum, address: st.address, time: st.estimatedTime || '—', lat: st.lat, lng: st.lng, shiftIdx: _generatedRoutes.indexOf(sr) }); }); }); }); });
        const container = document.getElementById('camperSearchResults'); if (!container) return;
        if (!results.length) { container.innerHTML = '<div style="padding:.75rem;color:var(--text-muted);">No match for "' + esc(query) + '"</div>'; container.style.display = ''; return; }
        container.innerHTML = results.map(r => '<div style="display:flex;align-items:center;gap:.75rem;padding:.625rem .75rem;border-bottom:1px solid var(--border-light);font-size:.8125rem;cursor:pointer;" onclick="CampistryGo.zoomToStop(' + (r.lat||0) + ',' + (r.lng||0) + ',\'' + esc(r.busId) + '\',' + r.shiftIdx + ')"><span style="width:10px;height:10px;border-radius:50%;background:' + esc(r.busColor) + ';display:inline-block;"></span><strong>' + esc(r.name) + '</strong><span style="color:var(--text-muted)">' + esc(r.shift) + ' · ' + esc(r.busName) + ' · Stop ' + r.stopNum + '</span><span style="margin-left:auto;font-weight:600;">' + r.time + '</span></div>').join('');
        container.style.display = '';
    }
    function zoomToStop(lat, lng, busId, shiftIdx) { if (!_map || !lat || !lng) return; _activeShifts = new Set([shiftIdx]); _activeMapBuses = new Set([busId]); renderMap(); _map.setView([lat, lng], 16); const sr = document.getElementById('camperSearchResults'); if (sr) sr.style.display = 'none'; }

    let _locateMarker = null;
    function locateCamper(name) {
        const a = D.addresses[name]; if (!a?.geocoded || !a.lat || !a.lng) { toast('No geocoded address for ' + name, 'error'); return; }
        // Switch to routes tab and ensure map is initialized
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        document.querySelector('.tab-btn[data-tab="routes"]')?.classList.add('active');
        document.getElementById('tab-routes')?.classList.add('active');
        if (!_map) showAddressesOnMap();
        setTimeout(() => {
            if (!_map) return;
            _map.invalidateSize();
            // Remove previous locate marker
            if (_locateMarker) { _map.removeLayer(_locateMarker); _locateMarker = null; }
            // Add highlighted pin
            const roster = getRoster(); const c = roster[name] || {};
            const icon = L.divIcon({
                html: '<div style="width:16px;height:16px;background:#ef4444;border:3px solid #fff;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,.5);animation:pulse 1.5s ease infinite;"></div>',
                className: '', iconSize: [16, 16], iconAnchor: [8, 8]
            });
            _locateMarker = L.marker([a.lat, a.lng], { icon, zIndexOffset: 2000 }).addTo(_map);
            _locateMarker.bindPopup('<div style="font-family:DM Sans,sans-serif;min-width:150px;"><div style="font-weight:700;">' + esc(name) + '</div><div style="font-size:12px;color:#666;">' + esc(c.division || '') + (c.bunk ? ' / Bunk ' + esc(c.bunk) : '') + '</div><div style="font-size:12px;margin-top:4px;">' + esc([a.street, a.city, a.state, a.zip].filter(Boolean).join(', ')) + '</div></div>').openPopup();
            _map.setView([a.lat, a.lng], 16);
        }, 200);
    }

    function moveCamperToBus(camperName, fromBusId, toBusId, shiftIdx) {
        if (!_generatedRoutes || !D.savedRoutes) return;
        const sr = D.savedRoutes[shiftIdx]; if (!sr) return;
        let camperData = null, camperStop = null;
        const fromRoute = sr.routes.find(r => r.busId === fromBusId);
        if (fromRoute) { for (const st of fromRoute.stops) { const ci = st.campers.findIndex(c => c.name === camperName); if (ci >= 0) { camperData = st.campers.splice(ci, 1)[0]; camperStop = st; break; } } fromRoute.stops = fromRoute.stops.filter(st => st.campers.length > 0 || st.isMonitor || st.isCounselor); fromRoute.stops.forEach((st, i) => { st.stopNum = i + 1; }); fromRoute.camperCount = fromRoute.stops.reduce((s, st) => s + st.campers.length, 0); }
        if (!camperData || !camperStop) { toast('Camper not found', 'error'); return; }
        const toRoute = sr.routes.find(r => r.busId === toBusId); if (!toRoute) { toast('Bus not found', 'error'); return; }
        let added = false;
        if (camperStop.lat && camperStop.lng) { for (const st of toRoute.stops) { if (st.lat && st.lng && haversineMi(camperStop.lat, camperStop.lng, st.lat, st.lng) < 0.3) { st.campers.push(camperData); added = true; break; } } }
        if (!added) { const cLat = D.setup.campLat || _campCoordsCache?.lat || 0; const cLng = D.setup.campLng || _campCoordsCache?.lng || 0; directionalInsert(toRoute.stops, { stopNum: 0, campers: [camperData], address: camperStop.address, lat: camperStop.lat, lng: camperStop.lng, estimatedTime: camperStop.estimatedTime }, cLat, cLng); }
        toRoute.stops.forEach((st, i) => { st.stopNum = i + 1; }); toRoute.camperCount = toRoute.stops.reduce((s, st) => s + st.campers.length, 0);
        _generatedRoutes = D.savedRoutes; save(); renderRouteResults(applyOverrides(D.savedRoutes)); toast(camperName + ' moved to ' + toRoute.busName);
    }
    function openMoveModal(camperName, fromBusId, shiftIdx) { const sr = _generatedRoutes?.[shiftIdx]; if (!sr) return; const otherBuses = sr.routes.filter(r => r.busId !== fromBusId && r.stops.length > 0); document.getElementById('moveCamperName').textContent = camperName; const sel = document.getElementById('moveToBus'); sel.innerHTML = otherBuses.map(r => '<option value="' + r.busId + '">' + esc(r.busName) + ' (' + r.camperCount + ')</option>').join(''); document.getElementById('moveConfirmBtn').onclick = function() { moveCamperToBus(camperName, fromBusId, sel.value, shiftIdx); closeModal('moveModal'); }; openModal('moveModal'); }

    // =========================================================================
    // EXPORT / PRINT
    // =========================================================================
    function exportRoutesCsv() {
        if (!_generatedRoutes) { toast('Generate first', 'error'); return; }
        const roster = getRoster(); const modeLabel = D.activeMode === 'arrival' ? 'Pickup' : 'Drop-off';
        let csv = '\uFEFFID,First Name,Last Name,Division,Grade,Bunk,Address,City,State,ZIP,Transport,Bus,Stop #,' + modeLabel + ' Location,Est. Time,Shift\n';
        const rows = [];
        _generatedRoutes.forEach(sr => { sr.routes.forEach(r => { r.stops.forEach(st => { if (st.isMonitor || st.isCounselor) return; st.campers.forEach(c => { const p = c.name.split(/\s+/); const cd = roster[c.name] || {}; const addr = D.addresses[c.name] || {}; rows.push([cd.camperId ? String(cd.camperId).padStart(4, '0') : '', p[0] || '', p.slice(1).join(' ') || '', c.division || cd.division || '', cd.grade || '', c.bunk || cd.bunk || '', addr.street || '', addr.city || '', addr.state || '', addr.zip || '', 'Bus', r.busName, st.stopNum, st.address, st.estimatedTime || '', sr.shift.label || '']); }); }); }); });
        Object.keys(roster).forEach(name => { const a = D.addresses[name]; if (a?.transport !== 'pickup') return; const c = roster[name]; const p = name.split(/\s+/); let carpoolLabel = 'Pickup'; if (D.carpoolGroups) Object.entries(D.carpoolGroups).forEach(([num, g]) => { if ((g.kids || []).includes(name)) carpoolLabel = 'Carpool ' + num; }); rows.push([c.camperId ? String(c.camperId).padStart(4, '0') : '', p[0] || '', p.slice(1).join(' ') || '', c.division || '', c.grade || '', c.bunk || '', a?.street || '', a?.city || '', a?.state || '', a?.zip || '', carpoolLabel, '', '', '', '', '']); });
        rows.sort((a, b) => a[2].localeCompare(b[2]) || a[1].localeCompare(b[1]));
        rows.forEach(r => { csv += r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',') + '\n'; });
        const blob = new Blob([csv], { type: 'text/csv' }); const el = document.createElement('a'); el.href = URL.createObjectURL(blob); el.download = 'campistry_go_' + D.activeMode + '_routes.csv'; el.click(); toast('Exported ' + rows.length + ' campers');
    }

    function printRoutes(printWhat) {
        if (!_generatedRoutes) { toast('Generate first', 'error'); return; }
        if (!printWhat) { const modal = '<div style="display:flex;flex-direction:column;gap:.75rem;padding:1rem;"><h3 style="margin:0;">Print Options</h3><button class="btn btn-primary" onclick="CampistryGo.printRoutes(\'routes\');CampistryGo.closeModal(\'printModal\')">Bus Routes</button><button class="btn btn-primary" onclick="CampistryGo.printRoutes(\'master\');CampistryGo.closeModal(\'printModal\')">Master List</button><button class="btn btn-primary" onclick="CampistryGo.printRoutes(\'busSheets\');CampistryGo.closeModal(\'printModal\')">Bus Sheets (1/page)</button><button class="btn btn-primary" onclick="CampistryGo.printRoutes(\'driverSheets\');CampistryGo.closeModal(\'printModal\')">Driver Sheets</button><button class="btn btn-primary" onclick="CampistryGo.printRoutes(\'all\');CampistryGo.closeModal(\'printModal\')">Everything</button><button class="btn btn-secondary" onclick="CampistryGo.closeModal(\'printModal\')">Cancel</button></div>'; let overlay = document.getElementById('printModal'); if (!overlay) { overlay = document.createElement('div'); overlay.id = 'printModal'; overlay.className = 'modal-overlay'; overlay.innerHTML = '<div class="modal" style="max-width:360px;">' + modal + '</div>'; document.body.appendChild(overlay); overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('open'); }); } else overlay.querySelector('.modal').innerHTML = modal; overlay.classList.add('open'); return; }
        const cn = D.setup.campName || 'Camp'; const modeLabel = D.activeMode === 'arrival' ? 'Pickup' : 'Drop-off'; const timeLabel = D.activeMode === 'arrival' ? 'Arrive by' : 'Departs';
        let h = '<!DOCTYPE html><html><head><title>Bus Routes — ' + esc(cn) + '</title><style>body{font-family:Arial,sans-serif;font-size:11pt;color:#222;margin:20px}h1{font-size:18pt;margin-bottom:4px}h2{font-size:14pt;margin:20px 0 8px;padding:6px 10px;color:#fff;border-radius:4px}.sub{color:#666;font-size:10pt;margin-bottom:20px}table{width:100%;border-collapse:collapse;margin-bottom:20px;font-size:10pt}th{background:#f5f5f5;text-align:left;padding:6px 8px;border:1px solid #ddd;font-size:9pt;text-transform:uppercase}td{padding:5px 8px;border:1px solid #ddd}@media print{.no-print{display:none}}</style></head><body>';
        h += '<h1>' + esc(cn) + ' — ' + modeLabel + ' Routes</h1><div class="sub">Generated: ' + new Date().toLocaleDateString() + ' | Powered by VROOM</div>';
        if (printWhat === 'routes' || printWhat === 'all') { _generatedRoutes.forEach((sr, si) => { h += '<h1 style="margin-top:30px">' + esc(sr.shift.label || 'Shift ' + (si + 1)) + ' — ' + timeLabel + ' ' + esc(sr.shift.departureTime) + '</h1>'; sr.routes.filter(r => r.stops.length > 0).forEach(r => { h += '<div style="page-break-inside:avoid"><h2 style="background:' + esc(r.busColor) + '">' + esc(r.busName) + ' — ' + r.camperCount + ' campers, ' + r.stops.length + ' stops (' + r.totalDuration + ' min)</h2><table><thead><tr><th>Stop</th><th>Camper(s)</th><th>Address</th><th>Time</th></tr></thead><tbody>'; r.stops.forEach(st => { const nm = st.isMonitor ? esc(st.monitorName) : st.isCounselor ? esc(st.counselorName) : st.campers.map(c => esc(c.name)).join(', '); h += '<tr><td style="text-align:center;font-weight:bold">' + st.stopNum + '</td><td>' + nm + '</td><td>' + esc(st.address) + '</td><td style="font-weight:600">' + (st.estimatedTime || '—') + '</td></tr>'; }); h += '</tbody></table></div>'; }); }); }
        if (printWhat === 'busSheets') { _generatedRoutes.forEach((sr, si) => { sr.routes.filter(r => r.stops.length > 0).forEach((r, ri) => { if (ri > 0 || si > 0) h += '<div style="page-break-before:always"></div>'; h += '<h1>' + esc(r.busName) + '</h1><div class="sub">' + esc(sr.shift.label || 'Shift') + ' | ' + r.camperCount + ' campers | ' + r.stops.length + ' stops | ' + r.totalDuration + ' min</div><table><thead><tr><th>Stop</th><th>Camper(s)</th><th>Address</th><th>Time</th></tr></thead><tbody>'; r.stops.forEach(st => { const nm = st.isMonitor ? esc(st.monitorName) : st.isCounselor ? esc(st.counselorName) : st.campers.map(c => esc(c.name)).join(', '); h += '<tr><td style="text-align:center;font-weight:bold;font-size:14pt;">' + st.stopNum + '</td><td>' + nm + '</td><td>' + esc(st.address) + '</td><td style="font-weight:600">' + (st.estimatedTime || '—') + '</td></tr>'; }); h += '</tbody></table>'; }); }); }
        if (printWhat === 'driverSheets') { const action = D.activeMode === 'arrival' ? 'PICKUP' : 'DROP-OFF'; _generatedRoutes.forEach((sr, si) => { sr.routes.filter(r => r.stops.length > 0).forEach((r, ri) => { if (ri > 0 || si > 0) h += '<div style="page-break-before:always"></div>'; h += '<div style="border:3px solid ' + esc(r.busColor) + ';border-radius:8px;padding:20px;"><div style="display:flex;justify-content:space-between;margin-bottom:15px;padding-bottom:10px;border-bottom:3px solid ' + esc(r.busColor) + ';"><div><h1 style="margin:0;color:' + esc(r.busColor) + ';">' + esc(r.busName) + '</h1><div style="color:#666;">' + esc(sr.shift.label || 'Shift') + ' — ' + action + '</div></div><div style="text-align:right;"><div style="font-size:14pt;font-weight:bold;">' + r.stops.filter(s => !s.isMonitor && !s.isCounselor).length + ' Stops</div><div style="color:#666;">' + r.camperCount + ' campers · ' + r.totalDuration + ' min</div></div></div><table style="width:100%;border-collapse:collapse;"><thead><tr><th style="width:60px;text-align:center;padding:8px;border:2px solid #ddd;background:#f0f0f0;">STOP</th><th style="padding:8px;border:2px solid #ddd;background:#f0f0f0;">' + action + ' ADDRESS</th><th style="width:70px;text-align:center;padding:8px;border:2px solid #ddd;background:#f0f0f0;">TIME</th><th style="width:50px;text-align:center;padding:8px;border:2px solid #ddd;background:#f0f0f0;">KIDS</th></tr></thead><tbody>'; r.stops.forEach(st => { if (st.isMonitor || st.isCounselor) return; h += '<tr><td style="text-align:center;font-weight:bold;font-size:18pt;padding:10px;border:2px solid #ddd;color:' + esc(r.busColor) + ';">' + st.stopNum + '</td><td style="padding:10px;border:2px solid #ddd;font-size:12pt;font-weight:600;">' + esc(st.address) + '</td><td style="text-align:center;padding:10px;border:2px solid #ddd;font-weight:700;">' + (st.estimatedTime || '—') + '</td><td style="text-align:center;padding:10px;border:2px solid #ddd;font-weight:bold;">' + st.campers.length + '</td></tr>'; }); h += '</tbody></table></div>'; }); }); }
        if (printWhat === 'master' || printWhat === 'all') { if (printWhat === 'all') h += '<div style="page-break-before:always"></div>'; h += '<h1>Master ' + modeLabel + ' List</h1><table><thead><tr><th>First</th><th>Last</th><th>Shift</th><th>Bus</th><th>Stop</th><th>Address</th><th>Time</th></tr></thead><tbody>'; const rows = []; _generatedRoutes.forEach(sr => { sr.routes.forEach(r => { r.stops.forEach(st => { if (st.isMonitor || st.isCounselor) return; st.campers.forEach(c => { const p = c.name.split(/\s+/); rows.push({ fn: p[0], ln: p.slice(1).join(' '), sh: sr.shift.label, bn: r.busName, sn: st.stopNum, ad: st.address, t: st.estimatedTime || '—' }); }); }); }); }); rows.sort((a, b) => a.ln.localeCompare(b.ln)); rows.forEach(r => { h += '<tr><td>' + esc(r.fn) + '</td><td><strong>' + esc(r.ln) + '</strong></td><td>' + esc(r.sh) + '</td><td>' + esc(r.bn) + '</td><td style="text-align:center;font-weight:bold">' + r.sn + '</td><td>' + esc(r.ad) + '</td><td style="font-weight:600">' + r.t + '</td></tr>'; }); h += '</tbody></table>'; }
        h += '</body></html>'; const w = window.open('', '_blank'); w.document.write(h); w.document.close(); setTimeout(() => w.print(), 500);
    }

    // =========================================================================
    // CARPOOL & RIDE-WITH
    // =========================================================================
    function renderCarpool() {
        const card = document.getElementById('carpoolCard'), body = document.getElementById('carpoolBody'), countEl = document.getElementById('carpoolCount');
        if (!card || !body) return;
        const roster = getRoster(); if (!D.carpoolGroups) D.carpoolGroups = {};
        const pickups = [], rideWithPairs = [], allKidsInGroups = new Set();
        Object.values(D.carpoolGroups).forEach(g => (g.kids || []).forEach(k => allKidsInGroups.add(k)));
        Object.keys(roster).forEach(name => { const a = D.addresses[name]; if (!a) return; if (a.transport === 'pickup') pickups.push({ name, division: roster[name].division || '', address: [a.street, a.city].filter(Boolean).join(', ') }); if (a.rideWith) rideWithPairs.push({ name, partner: a.rideWith, division: roster[name].division || '' }); });
        const ungrouped = pickups.filter(p => !allKidsInGroups.has(p.name));
        const groups = Object.entries(D.carpoolGroups).sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
        card.style.display = '';
        if (countEl) countEl.textContent = pickups.length + ' pickup, ' + groups.length + ' group' + (groups.length !== 1 ? 's' : '');
        let html = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.75rem;"><div style="font-size:.875rem;font-weight:700;">🚗 Carpool Groups</div><button class="btn btn-primary btn-sm" onclick="CampistryGo.openCarpoolGroupModal()">+ New Group</button></div>';
        if (groups.length) { html += groups.map(([num, g]) => { const kidRows = (g.kids || []).map(kid => { const c = roster[kid]; return '<div style="display:flex;align-items:center;justify-content:space-between;padding:.3rem 0;border-bottom:1px solid var(--border-light);"><span style="font-size:.8125rem;"><strong>' + esc(kid) + '</strong>' + (c?.division ? ' <span style="color:var(--text-muted);font-size:.75rem;">' + esc(c.division) + '</span>' : '') + '</span><button class="btn btn-ghost btn-sm" style="color:var(--red-500);font-size:.7rem;padding:2px 6px;" onclick="CampistryGo.removeFromCarpoolGroup(\'' + esc(num) + '\',\'' + esc(kid.replace(/'/g, "\\'")) + '\')">×</button></div>'; }).join(''); return '<div style="border:1px solid var(--border-light);border-radius:8px;margin-bottom:.75rem;overflow:hidden;"><div style="display:flex;align-items:center;justify-content:space-between;padding:.625rem .75rem;background:var(--surface-secondary,#f9fafb);"><div><span style="font-weight:700;font-size:.875rem;">Carpool ' + esc(num) + '</span>' + (g.driver ? ' <span style="font-size:.75rem;color:var(--text-muted);">— ' + esc(g.driver) + (g.phone ? ' · ' + esc(g.phone) : '') + '</span>' : '') + '</div><div style="display:flex;gap:4px;"><button class="btn btn-ghost btn-sm" style="font-size:.7rem;" onclick="CampistryGo.openAddToCarpoolModal(\'' + esc(num) + '\')">+ Add</button><button class="btn btn-ghost btn-sm" style="font-size:.7rem;" onclick="CampistryGo.editCarpoolGroup(\'' + esc(num) + '\')">Edit</button><button class="btn btn-ghost btn-sm" style="color:var(--red-500);font-size:.7rem;" onclick="CampistryGo.deleteCarpoolGroup(\'' + esc(num) + '\')">Delete</button></div></div><div style="padding:.5rem .75rem;">' + (kidRows || '<div style="font-size:.8125rem;color:var(--text-muted);">No kids yet</div>') + '</div></div>'; }).join(''); }
        else html += '<div style="text-align:center;padding:1rem;color:var(--text-muted);font-size:.8125rem;border:1px dashed var(--border-light);border-radius:8px;">No carpool groups yet</div>';
        if (ungrouped.length) { html += '<div style="margin-top:.75rem;border-top:1px solid var(--border-light);padding-top:.75rem;"><div style="font-size:.8125rem;font-weight:700;color:var(--text-secondary);margin-bottom:.5rem;">Ungrouped Pickup Kids (' + ungrouped.length + ')</div>'; html += ungrouped.map(p => { const opts = groups.map(([n]) => '<option value="' + esc(n) + '">Carpool ' + esc(n) + '</option>').join(''); return '<div style="display:flex;align-items:center;justify-content:space-between;padding:.35rem 0;border-bottom:1px solid var(--border-light);font-size:.8125rem;"><strong>' + esc(p.name) + '</strong><div style="display:flex;gap:4px;">' + (groups.length ? '<select class="form-input" style="font-size:.7rem;padding:2px 4px;width:auto;" onchange="if(this.value)CampistryGo.addToCarpoolGroup(this.value,\'' + esc(p.name.replace(/'/g, "\\'")) + '\');this.value=\'\'"><option value="">Add to...</option>' + opts + '</select>' : '') + '<button class="btn btn-ghost btn-sm" style="font-size:.7rem;" onclick="CampistryGo.setTransport(\'' + esc(p.name.replace(/'/g, "\\'")) + '\',\'bus\')">→ Bus</button></div></div>'; }).join(''); html += '</div>'; }
        if (rideWithPairs.length) { html += '<div style="margin-top:.75rem;border-top:1px solid var(--border-light);padding-top:.75rem;"><div style="font-size:.8125rem;font-weight:700;color:var(--text-secondary);margin-bottom:.5rem;">🤝 Ride-With Pairs (' + rideWithPairs.length + ')</div>'; rideWithPairs.forEach(p => { html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:.35rem 0;border-bottom:1px solid var(--border-light);font-size:.8125rem;"><span><strong>' + esc(p.name) + '</strong> rides with <strong>' + esc(p.partner) + '</strong></span><button class="btn btn-ghost btn-sm" style="color:var(--red-500);font-size:.7rem;" onclick="CampistryGo.removeRideWith(\'' + esc(p.name.replace(/'/g, "\\'")) + '\')">Remove</button></div>'; }); html += '</div>'; }
        body.innerHTML = html;
    }

    function setTransport(name, mode) { if (!D.addresses[name]) return; D.addresses[name].transport = mode; save(); renderCarpool(); renderAddresses(); updateStats(); toast(name + ' → ' + (mode === 'pickup' ? 'carpool' : 'bus')); }
    function setRideWith(name, partner) { if (!D.addresses[name]) return; D.addresses[name].rideWith = partner; save(); renderCarpool(); toast(name + ' paired with ' + partner); }
    function removeRideWith(name) { if (!D.addresses[name]) return; D.addresses[name].rideWith = ''; save(); renderCarpool(); toast('Pairing removed'); }
    function openCarpoolGroupModal(editNum) { const existing = editNum ? D.carpoolGroups[editNum] : null; document.getElementById('carpoolGroupNum').value = editNum || ''; document.getElementById('carpoolGroupDriver').value = existing?.driver || ''; document.getElementById('carpoolGroupPhone').value = existing?.phone || ''; document.getElementById('carpoolGroupNum').disabled = !!editNum; document.getElementById('carpoolGroupModalTitle').textContent = editNum ? 'Edit Carpool ' + editNum : 'New Carpool Group'; openModal('carpoolGroupModal'); }
    function saveCarpoolGroup() { const num = document.getElementById('carpoolGroupNum')?.value.trim(); if (!num) { toast('Enter a number', 'error'); return; } if (!D.carpoolGroups) D.carpoolGroups = {}; if (!D.carpoolGroups[num]) D.carpoolGroups[num] = { label: 'Carpool ' + num, driver: '', phone: '', kids: [] }; D.carpoolGroups[num].driver = document.getElementById('carpoolGroupDriver')?.value.trim() || ''; D.carpoolGroups[num].phone = document.getElementById('carpoolGroupPhone')?.value.trim() || ''; save(); closeModal('carpoolGroupModal'); renderCarpool(); toast('Carpool ' + num + ' saved'); }
    function editCarpoolGroup(num) { openCarpoolGroupModal(num); }
    function deleteCarpoolGroup(num) { if (!D.carpoolGroups?.[num]) return; if (!confirm('Delete Carpool ' + num + '?')) return; delete D.carpoolGroups[num]; save(); renderCarpool(); toast('Deleted'); }
    function addToCarpoolGroup(num, kidName) { if (!D.carpoolGroups?.[num]) return; if (!D.carpoolGroups[num].kids) D.carpoolGroups[num].kids = []; if (!D.carpoolGroups[num].kids.includes(kidName)) D.carpoolGroups[num].kids.push(kidName); if (D.addresses[kidName]) D.addresses[kidName].transport = 'pickup'; save(); renderCarpool(); toast(kidName + ' → Carpool ' + num); }
    function removeFromCarpoolGroup(num, kidName) { if (!D.carpoolGroups?.[num]) return; D.carpoolGroups[num].kids = (D.carpoolGroups[num].kids || []).filter(k => k !== kidName); save(); renderCarpool(); toast(kidName + ' removed'); }
    function openAddToCarpoolModal(num) { const roster = getRoster(); const existing = new Set(D.carpoolGroups[num]?.kids || []); const available = Object.keys(roster).sort().filter(n => D.addresses[n] && !existing.has(n)); const sel = document.getElementById('addToCarpoolSelect'); if (sel) sel.innerHTML = '<option value="">— Select —</option>' + available.map(n => '<option value="' + esc(n) + '">' + esc(n) + (D.addresses[n]?.transport === 'pickup' ? ' 🚗' : ' 🚌') + '</option>').join(''); document.getElementById('addToCarpoolSearch').value = ''; document.getElementById('addToCarpoolNum').value = num; document.getElementById('addToCarpoolTitle').textContent = 'Add to Carpool ' + num; openModal('addToCarpoolModal'); }
    function filterAddToCarpool() { const q = (document.getElementById('addToCarpoolSearch')?.value || '').toLowerCase().trim(); const num = document.getElementById('addToCarpoolNum')?.value; const roster = getRoster(); const existing = new Set(D.carpoolGroups[num]?.kids || []); const names = Object.keys(roster).sort().filter(n => D.addresses[n] && !existing.has(n) && (!q || n.toLowerCase().includes(q))); const sel = document.getElementById('addToCarpoolSelect'); if (sel) sel.innerHTML = '<option value="">— Select —</option>' + names.map(n => '<option value="' + esc(n) + '">' + esc(n) + (D.addresses[n]?.transport === 'pickup' ? ' 🚗' : ' 🚌') + '</option>').join(''); if (names.length === 1 && sel) sel.value = names[0]; }
    function confirmAddToCarpool() { const num = document.getElementById('addToCarpoolNum')?.value; const kid = document.getElementById('addToCarpoolSelect')?.value; if (!num || !kid) { toast('Select a camper', 'error'); return; } addToCarpoolGroup(num, kid); closeModal('addToCarpoolModal'); }

    // =========================================================================
    // TABS + INIT
    // =========================================================================
    function initTabs() {
        document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            const t = btn.dataset.tab; document.getElementById('tab-' + t)?.classList.add('active');
            if (t === 'fleet') { renderFleet(); renderShifts(); } else if (t === 'shifts') renderShifts(); else if (t === 'staff') renderStaff(); else if (t === 'addresses') renderAddresses(); else if (t === 'routes') {
                runPreflight(); renderDailyOverrides(); renderCarpool();
                if (_pendingMapInit) { setTimeout(function() { initMap(_pendingMapInit); _pendingMapInit = null; }, 150); }
                else { setTimeout(function() { if (_map) _map.invalidateSize(); }, 150); }
            }
        }));
        document.getElementById('addressSearch')?.addEventListener('input', () => { clearTimeout(_addrSearchTimer); _addrSearchTimer = setTimeout(renderAddresses, 200); });
    }
    let _addrSearchTimer;

    function init() {
        console.log('[Go] Initializing v4.0 (zone-based + VROOM + Manhattan walk)...');
        load();
        if (D[D.activeMode]) loadModeData(D.activeMode);
        document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === D.activeMode));
        const modeLabel = document.getElementById('modeLabel');
        if (modeLabel) modeLabel.textContent = D.activeMode === 'arrival' ? 'Morning Pickup Routes' : 'Afternoon Drop-off Routes';
        initTabs(); populateSetup(); renderFleet(); renderShifts(); renderStaff(); renderAddresses(); updateStats(); updateBusSelects();
        if (D.setup.campLat && D.setup.campLng) { _campCoordsCache = { lat: D.setup.campLat, lng: D.setup.campLng }; }
        if (D.savedRoutes && D.savedRoutes.length) {
            let needsSave = false;
            D.savedRoutes.forEach(sr => { sr.routes.forEach(r => { r.stops.forEach(st => { if (st.address && st.address.startsWith('Shared stop')) { let bestAddr = null, bestDist = Infinity; (st.campers || []).forEach(c => { const a = D.addresses[c.name]; if (a?.geocoded && a.lat && a.lng && st.lat && st.lng) { const d = haversineMi(st.lat, st.lng, a.lat, a.lng); if (d < bestDist) { bestDist = d; bestAddr = [a.street, a.city, a.state, a.zip].filter(Boolean).join(', '); } } }); if (bestAddr) { st.address = bestAddr; needsSave = true; } } }); }); });
            if (needsSave) save();
            _generatedRoutes = D.savedRoutes;
            setTimeout(() => { renderRouteResults(applyOverrides(D.savedRoutes)); toast('Saved routes loaded'); }, 200);
        }
        document.querySelectorAll('.modal-overlay').forEach(o => o.addEventListener('click', e => { if (e.target === o) o.classList.remove('open'); }));
        document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open')); });
        window.addEventListener('campistry-cloud-hydrated', () => { console.log('[Go] Cloud data hydrated'); load(); renderAddresses(); updateStats(); renderShifts(); });
        window.addEventListener('storage', (e) => { if (e.key === 'campGlobalSettings_v1') { console.log('[Go] Roster changed — refreshing'); renderAddresses(); updateStats(); } });
        console.log('[Go] Ready —', D.buses.length, 'buses,', D.shifts.length, 'shifts,', Object.keys(getRoster()).length, 'campers');
    }

    // =========================================================================
    // DIAGNOSTIC: Bus stop + camper distance audit
    // Usage: CampistryGo.diagnoseBus('Bus 2')  or  CampistryGo.diagnoseBus(2)
    // =========================================================================
    function diagnoseBus(busNameOrNum, shiftIdx) {
        if (!_generatedRoutes?.length) { console.error('[Go] No routes generated'); return; }
        const si = shiftIdx || 0;
        const sr = _generatedRoutes[si];
        if (!sr) { console.error('[Go] Shift ' + si + ' not found'); return; }

        // Find bus by name or number
        let route = null;
        if (typeof busNameOrNum === 'number') {
            const busName = 'Bus ' + busNameOrNum;
            route = sr.routes.find(r => r.busName === busName);
        } else {
            route = sr.routes.find(r => r.busName === busNameOrNum || r.busId === busNameOrNum);
        }
        if (!route) { console.error('[Go] Bus "' + busNameOrNum + '" not found in shift ' + si); return; }

        const campLat = D.setup.campLat || _campCoordsCache?.lat;
        const campLng = D.setup.campLng || _campCoordsCache?.lng;

        console.log('\n╔══════════════════════════════════════════════════════════════╗');
        console.log('║  BUS DIAGNOSTIC: ' + route.busName + ' (' + route.camperCount + ' kids, cap ' + route._cap + ')');
        console.log('╚══════════════════════════════════════════════════════════════╝\n');

        let totalKids = 0;
        let flagged = 0;

        route.stops.forEach(st => {
            if (st.isMonitor || st.isCounselor) return;

            const stopDistFromCamp = (st.lat && campLat) ? haversineMi(campLat, campLng, st.lat, st.lng).toFixed(2) : '?';
            console.log('── Stop ' + st.stopNum + ': ' + st.address + ' (' + st.campers.length + ' kids) — ' + stopDistFromCamp + ' mi from camp ──');

            st.campers.forEach(c => {
                const a = D.addresses[c.name];
                if (!a?.geocoded || !a.lat || !a.lng || !st.lat || !st.lng) {
                    console.log('   ' + c.name + ' — no geocoded address');
                    return;
                }
                const walkFt = Math.round(manhattanMi(a.lat, a.lng, st.lat, st.lng) * 5280);
                const homeZip = a.zip || '?';
                const flag = walkFt > 500 ? ' ⚠ FAR' : '';
                if (walkFt > 500) flagged++;
                console.log('   ' + c.name + ' — ' + walkFt + 'ft walk' + flag + '  [' + [a.street, a.city, homeZip].filter(Boolean).join(', ') + ']');
                totalKids++;
            });
            console.log('');
        });

        console.log('═══════════════════════════════════════');
        console.log('Total: ' + totalKids + ' kids across ' + route.stops.length + ' stops');
        if (flagged) console.warn(flagged + ' kid(s) walking > 500ft — may be misassigned');
        console.log('Capacity: ' + route.camperCount + '/' + route._cap + (route.camperCount > route._cap ? ' ⚠ OVER' : ' ✓'));
        console.log('═══════════════════════════════════════\n');
    }

    // =========================================================================
    // PUBLIC API
    // =========================================================================
    window.CampistryGo = {
        saveSetup, testApiKey,
        openBusModal, saveBus, editBus, deleteBus, deleteBusFromModal, _pickColor, quickCreateBuses,
        addShift, deleteShift, toggleShiftDiv, updateShiftTime, renameShift,
        toggleShiftGrade, setShiftGradeMode, toggleShiftBus, setAllShiftBuses,
        openMonitorModal, saveMonitor, editMonitor, deleteMonitor,
        openCounselorModal, saveCounselor, editCounselor, deleteCounselor,
        editAddress, saveAddress, geocodeAll, downloadAddressTemplate, importAddressCsv, sortAddresses,
        regeocodeAll: function() { geocodeAll(true); },
        testGeocode, systemCheck,
        generateRoutes, reOptimizeBus, exportRoutesCsv, printRoutes, detectRegions, diagnoseBus,
        renderMap, selectMapBus, toggleMapBus, toggleMapShift, setMapShiftsAll, toggleMapFullscreen,
        setAddressPinMode, toggleHideRoutes, toggleZones,
        toggleAddressPins, showAddressesOnMap, locateCamper,
        openOverrideModal, onOverrideTypeChange, saveOverride, removeOverride, filterOverrideSelect,
        searchCamperInRoutes, zoomToStop, openMoveModal, renderFilteredMasterList, sortMasterBy,
        switchMode,
        setTransport, setRideWith, removeRideWith, renderCarpool,
        openCarpoolGroupModal, saveCarpoolGroup, editCarpoolGroup, deleteCarpoolGroup,
        addToCarpoolGroup, removeFromCarpoolGroup,
        openAddToCarpoolModal, filterAddToCarpool, confirmAddToCarpool,
        closeModal, openModal,
        _getMap: function() { return _map; },
        _getSavedRoutes: function() { return D.savedRoutes; },
        _setSavedRoutes: function(r) { D.savedRoutes = r; _generatedRoutes = r; },
        _save: function() { save(); },
        _refreshRoutes: function() {
            if (D.savedRoutes) {
                _generatedRoutes = D.savedRoutes;
                var c = _map ? _map.getCenter() : null, z = _map ? _map.getZoom() : null;
                renderRouteResults(applyOverrides(D.savedRoutes));
                if (_map && c && z != null) setTimeout(function() { _map.setView(c, z, { animate: false }); }, 200);
            }
        },
        _getRouteGeomCache: function() { return _routeGeomCache; },
        _clearGeomCache: function(key) { if (key) delete _routeGeomCache[key]; else _routeGeomCache = {}; }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
