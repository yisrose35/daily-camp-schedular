
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
            avgStopTime: 2, maxWalkDistance: 375, maxRouteDuration: 60, maxRideTime: 45, orsApiKey: '', graphhopperKey: '', mapboxToken: '',
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
    function toast() { /* removed */ }
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
    // ★★★ STARTER PLAN: Camper limit check (counts Me + Go combined) ★★★
    async function checkCamperLimitGo(newCount, silent) {
        newCount = newCount || 1;
        try {
            var client = window.CampistryDB?.getClient?.() || window.supabase;
            var campId = window.CampistryDB?.getCampId?.() || localStorage.getItem('campistry_camp_id');
            if (!client || !campId) return { allowed: true };

            var result = await client.rpc('check_camper_limit', { p_camp_id: campId, p_new_count: newCount });
            if (!result.error && result.data && result.data.allowed === false) {
                if (!silent) {
                    toast('Camper limit reached (' + result.data.current + '/' + result.data.max + '). Upgrade for more.', 'error');
                    window.dispatchEvent(new CustomEvent('campistry-plan-limit', {
                        detail: { type: 'camper', current: result.data.current, max: result.data.max }
                    }));
                }
                return { allowed: false, current: result.data.current, max: result.data.max };
            }
            return { allowed: true, current: result.data?.current, max: result.data?.max };
        } catch (e) {
            console.warn('[Go] Camper limit check failed, proceeding:', e);
            return { allowed: true };
        }
    }

    function getApiKey() { return window.__CAMPISTRY_ORS_KEY__ || D.setup.orsApiKey || _PLATFORM_KEYS.ors; }
    function getGHKey() { return window.__CAMPISTRY_GH_KEY__ || D.setup.graphhopperKey || _PLATFORM_KEYS.graphhopper; }
    function getMBToken() { return D.setup.mapboxToken || _PLATFORM_KEYS.mapbox; }
    let _campCoordsCache = null;

    function haversineMi(lat1, lng1, lat2, lng2) {
        const R = 3958.8, toRad = d => d * Math.PI / 180;
        const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    // Manhattan distance for realistic grid-street walking.
    // Measures "walk north/south then east/west" — how kids walk on a street grid.
    function manhattanMi(lat1, lng1, lat2, lng2) {
        return haversineMi(lat1, lng1, lat2, lng1) + haversineMi(lat2, lng1, lat2, lng2);
    }

    // =========================================================================
    // DRIVING DISTANCE CACHE — shared by all pipeline steps
    //
    // Every distance comparison in zones, stops, and routing goes through
    // drivingDist() which checks this cache first. The cache is populated by
    // fetchDistanceMatrixCascade() calls during zone building and routing.
    //
    // Key format: "lat1_5dec,lng1_5dec|lat2_5dec,lng2_5dec" (sorted so A|B == B|A)
    // Value: driving duration in seconds
    // =========================================================================
    const _drivingCache = new Map();
    const ROAD_FACTOR = 1.35; // haversine-to-driving approximation factor

    function _cacheKey(lat1, lng1, lat2, lng2) {
        const a = Math.round(lat1 * 1e5) + ',' + Math.round(lng1 * 1e5);
        const b = Math.round(lat2 * 1e5) + ',' + Math.round(lng2 * 1e5);
        return a < b ? a + '|' + b : b + '|' + a;
    }

    /** Store a driving duration (seconds) between two points in the cache */
    function _cacheSet(lat1, lng1, lat2, lng2, durationSec) {
        if (durationSec == null || durationSec < 0) return;
        _drivingCache.set(_cacheKey(lat1, lng1, lat2, lng2), durationSec);
    }

    /** Look up cached driving duration (seconds) between two points, or null */
    function _cacheGet(lat1, lng1, lat2, lng2) {
        const v = _drivingCache.get(_cacheKey(lat1, lng1, lat2, lng2));
        return v !== undefined ? v : null;
    }

    /**
     * Populate cache from an NxN duration matrix + its coordinate list.
     * coords = [{lat, lng}, ...], matrix = [[sec, ...], ...]
     */
    function _cacheFromMatrix(coords, matrix) {
        if (!matrix || !coords) return;
        for (let i = 0; i < coords.length; i++) {
            for (let j = i + 1; j < coords.length; j++) {
                const val = matrix[i]?.[j];
                if (val != null && val >= 0) {
                    _cacheSet(coords[i].lat, coords[i].lng, coords[j].lat, coords[j].lng, val);
                }
            }
        }
    }

    /**
     * drivingDist — the universal distance function.
     * Returns driving duration in SECONDS between two points.
     * Checks cache first; falls back to haversine × ROAD_FACTOR.
     *
     * Use drivingDistMi() for miles (approximate).
     */
    function drivingDist(lat1, lng1, lat2, lng2) {
        if (!lat1 || !lng1 || !lat2 || !lng2) return Infinity;
        // Same point
        if (Math.abs(lat1 - lat2) < 1e-5 && Math.abs(lng1 - lng2) < 1e-5) return 0;
        const cached = _cacheGet(lat1, lng1, lat2, lng2);
        if (cached !== null) return cached;
        // Fallback: haversine → approximate driving seconds
        const mi = haversineMi(lat1, lng1, lat2, lng2) * ROAD_FACTOR;
        const avgSpeedMph = D.setup.avgSpeed || 25;
        return (mi / avgSpeedMph) * 3600;
    }

    /** Approximate driving distance in miles (from cache seconds → miles, or haversine×factor) */
    function drivingDistMi(lat1, lng1, lat2, lng2) {
        const sec = drivingDist(lat1, lng1, lat2, lng2);
        if (sec === Infinity) return Infinity;
        if (sec === 0) return 0;
        const avgSpeedMph = D.setup.avgSpeed || 25;
        return (sec / 3600) * avgSpeedMph;
    }

    // =========================================================================
    // DISTANCE MATRIX CASCADE — Mapbox → OSRM → haversine fallback
    // =========================================================================

    /**
     * fetchDistanceMatrixCascade(coords)
     * coords = [{lat, lng}, ...]  (max ~25 for a single call)
     * Returns NxN duration matrix in seconds, or null on total failure.
     * Also populates _drivingCache.
     */
    async function fetchDistanceMatrixCascade(coords) {
        const n = coords.length;
        if (n < 2) return null;
        const coordStr = coords.map(c => c.lng + ',' + c.lat).join(';');

        // ── Primary: OSRM (free, no API key) ──
        const osrmResult = await fetchOSRMWithRetry(coordStr, 3);
        if (osrmResult) {
            _cacheFromMatrix(coords, osrmResult);
            return osrmResult;
        }

        // ── Last resort: synthetic matrix from haversine × ROAD_FACTOR ──
        console.warn('[Go] Matrix: all APIs failed, using haversine approximation');
        const avgSpeedMph = D.setup.avgSpeed || 25;
        const synthetic = Array.from({ length: n }, (_, i) =>
            Array.from({ length: n }, (_, j) => {
                if (i === j) return 0;
                return (haversineMi(coords[i].lat, coords[i].lng, coords[j].lat, coords[j].lng) * ROAD_FACTOR / avgSpeedMph) * 3600;
            })
        );
        _cacheFromMatrix(coords, synthetic);
        return synthetic;
    }

    /**
     * fetchLargeMatrixBatched(coords)
     * Handles >25 coords by pivot-row batching.
     * Always includes coord[0] (typically camp) in every batch for consistent anchoring.
     * Returns full NxN matrix in seconds.
     */
    async function fetchLargeMatrixBatched(coords) {
        const n = coords.length;
        if (n <= 25) return await fetchDistanceMatrixCascade(coords);

        console.log('[Go] Matrix: batching ' + n + ' points (>' + 25 + ')');
        const matrix = Array.from({ length: n }, () => new Array(n).fill(null));
        // Self-distances are always 0
        for (let i = 0; i < n; i++) matrix[i][i] = 0;

        const CHUNK = 24; // leave 1 slot for pivot (coord[0])

        // Strategy: for each batch, include coord[0] (pivot) + up to CHUNK others.
        // This gives us camp↔stop distances in every batch, plus stop↔stop for each chunk.
        for (let start = 1; start < n; start += CHUNK) {
            const end = Math.min(start + CHUNK, n);
            // Build sub-coord list: [pivot, chunk members...]
            const subIndices = [0];
            for (let i = start; i < end; i++) subIndices.push(i);

            const subCoords = subIndices.map(i => coords[i]);
            const subMatrix = await fetchDistanceMatrixCascade(subCoords);

            if (subMatrix) {
                // Map sub-matrix back to full matrix
                for (let si = 0; si < subIndices.length; si++) {
                    for (let sj = 0; sj < subIndices.length; sj++) {
                        const gi = subIndices[si], gj = subIndices[sj];
                        if (subMatrix[si]?.[sj] != null) {
                            matrix[gi][gj] = subMatrix[si][sj];
                        }
                    }
                }
            }

            // Stagger to avoid rate limiting
            if (end < n) await new Promise(r => setTimeout(r, 250));
        }

        // Now we have camp↔all and within-chunk pairs. Fill cross-chunk gaps
        // with a second pass: for each pair of chunks, fetch a bridging batch.
        // But first, check how many gaps remain.
        let gaps = 0;
        for (let i = 1; i < n; i++) for (let j = i + 1; j < n; j++) if (matrix[i][j] === null) gaps++;

        if (gaps > 0 && gaps < n * n * 0.3) {
            // Moderate gaps — fill with targeted cross-chunk batches
            const chunkStarts = [];
            for (let s = 1; s < n; s += CHUNK) chunkStarts.push(s);

            for (let ci = 0; ci < chunkStarts.length; ci++) {
                for (let cj = ci + 1; cj < chunkStarts.length; cj++) {
                    const aEnd = Math.min(chunkStarts[ci] + CHUNK, n);
                    const bEnd = Math.min(chunkStarts[cj] + CHUNK, n);
                    // Pick up to 12 from each chunk for a batch of 24
                    const aSlice = [], bSlice = [];
                    for (let i = chunkStarts[ci]; i < aEnd && aSlice.length < 12; i++) aSlice.push(i);
                    for (let i = chunkStarts[cj]; i < bEnd && bSlice.length < 12; i++) bSlice.push(i);
                    const crossIndices = [...aSlice, ...bSlice];
                    if (crossIndices.length < 2) continue;

                    const crossCoords = crossIndices.map(i => coords[i]);
                    const crossMatrix = await fetchDistanceMatrixCascade(crossCoords);
                    if (crossMatrix) {
                        for (let si = 0; si < crossIndices.length; si++) {
                            for (let sj = 0; sj < crossIndices.length; sj++) {
                                const gi = crossIndices[si], gj = crossIndices[sj];
                                if (matrix[gi][gj] === null && crossMatrix[si]?.[sj] != null) {
                                    matrix[gi][gj] = crossMatrix[si][sj];
                                }
                            }
                        }
                    }
                    await new Promise(r => setTimeout(r, 250));
                }
            }
        }

        // Fill any remaining nulls with haversine fallback
        const avgSpeedMph = D.setup.avgSpeed || 25;
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
                if (matrix[i][j] === null) {
                    matrix[i][j] = (haversineMi(coords[i].lat, coords[i].lng, coords[j].lat, coords[j].lng) * ROAD_FACTOR / avgSpeedMph) * 3600;
                }
            }
        }

        _cacheFromMatrix(coords, matrix);
        return matrix;
    }

    /**
     * prewarmCache — called after geocoding or at start of generateRoutes.
     * Fetches camp→all camper distances so drivingDist() has cache hits
     * for all subsequent zone/stop/route decisions.
     */
    async function prewarmCache(camperCoords, campLat, campLng) {
        if (!camperCoords.length || !campLat || !campLng) return;
        // Build coord list: [camp, camper1, camper2, ...]
        const coords = [{ lat: campLat, lng: campLng }, ...camperCoords];
        console.log('[Go] Cache: pre-warming with ' + coords.length + ' points...');
        await fetchLargeMatrixBatched(coords);
        console.log('[Go] Cache: ' + _drivingCache.size + ' pairs cached');
    }

    // =========================================================================
    // SMART CLUSTERING ENGINE
    // Street-aware distance, major road barriers, capacity caps
    // =========================================================================

    // =========================================================================
    // DIRECTIONAL HELPERS — used by all code paths that order/insert stops
    // All use drivingDist (driving seconds) for ordering, not haversine.
    // =========================================================================

    /** Sort stops by driving distance from camp: farthest-first for arrival, nearest-first for dismissal */
    function directionalSort(stops, campLat, campLng) {
        if (stops.length < 2) return;
        const isArr = D.activeMode === 'arrival';
        stops.forEach(s => {
            s._dSort = (s.lat && s.lng) ? drivingDist(campLat, campLng, s.lat, s.lng) : 0;
        });
        if (isArr) stops.sort((a, b) => b._dSort - a._dSort);
        else stops.sort((a, b) => a._dSort - b._dSort);
        stops.forEach((s, i) => { s.stopNum = i + 1; delete s._dSort; });
    }

    /** Insert a stop at the directionally correct position (by driving distance from camp) */
    function directionalInsert(stops, newStop, campLat, campLng) {
        if (!newStop.lat || !newStop.lng) { stops.push(newStop); return; }
        const isArr = D.activeMode === 'arrival';
        const nd = drivingDist(campLat, campLng, newStop.lat, newStop.lng);
        let insertAt = stops.length;
        for (let i = 0; i < stops.length; i++) {
            if (!stops[i].lat || !stops[i].lng) continue;
            const sd = drivingDist(campLat, campLng, stops[i].lat, stops[i].lng);
            if (isArr ? (nd > sd) : (nd < sd)) { insertAt = i; break; }
        }
        stops.splice(insertAt, 0, newStop);
        stops.forEach((s, i) => { s.stopNum = i + 1; });
    }

    /** Insert a stop where it adds the least driving distance (uses driving cache) */
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
            if (prev && prev.lat) cost += drivingDist(prev.lat, prev.lng, newStop.lat, newStop.lng);
            if (next && next.lat) cost += drivingDist(newStop.lat, newStop.lng, next.lat, next.lng);
            if (prev && next && prev.lat && next.lat) cost -= drivingDist(prev.lat, prev.lng, next.lat, next.lng);
            if (cost < bestCost) { bestCost = cost; bestPos = i; }
        }
        stops.splice(bestPos, 0, newStop);
        stops.forEach((s, i) => { s.stopNum = i + 1; });
    }

    const MAX_STOP_CAPACITY = 15; // cap per stop — keeps clusters compact

    // ── Hungarian Algorithm (Kuhn-Munkres) for optimal assignment ──
    // Finds minimum-cost 1-to-1 matching in an n×n cost matrix.
    // Returns assignment[row] = col for each row. O(n³).
    function hungarian(cost, n) {
        const u = new Array(n + 1).fill(0);
        const v = new Array(n + 1).fill(0);
        const p = new Array(n + 1).fill(0);
        const way = new Array(n + 1).fill(0);
        for (let i = 1; i <= n; i++) {
            p[0] = i;
            let j0 = 0;
            const minv = new Array(n + 1).fill(Infinity);
            const used = new Array(n + 1).fill(false);
            do {
                used[j0] = true;
                let i0 = p[j0], delta = Infinity, j1;
                for (let j = 1; j <= n; j++) {
                    if (used[j]) continue;
                    const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
                    if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
                    if (minv[j] < delta) { delta = minv[j]; j1 = j; }
                }
                for (let j = 0; j <= n; j++) {
                    if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
                    else { minv[j] -= delta; }
                }
                j0 = j1;
            } while (p[j0] !== 0);
            do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
        }
        const result = new Array(n).fill(-1);
        for (let j = 1; j <= n; j++) {
            if (p[j] !== 0) result[p[j] - 1] = j - 1;
        }
        return result;
    }
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
     * Street-aware cluster distance (in miles, approximate).
     * Base: driving distance (from cache or haversine×factor).
     * Multipliers for street awareness:
     * - Same street: 0.7× (kids can walk along their own block)
     * - Different street, no major road between: 1.0×
     * - Different street, major road between: 2.5× (don't make kids cross Broadway)
     * - Same street + same parity (same side): extra 0.85× bonus
     */
    function smartClusterDist(lat1, lng1, addr1, lat2, lng2, addr2) {
        let dist = drivingDistMi(lat1, lng1, lat2, lng2);
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

                        // Check 1: every kid within walkMi of the new centroid
                        const allFit = trial.every(k =>
                            smartClusterDist(nLat, nLng, '', k.lat, k.lng, k.address) <= walkMi
                        );
                        // Check 2: max diameter — farthest pair can't exceed 2× walkMi
                        // This prevents long, stretched clusters where centroid is fine
                        // but edge kids are far apart
                        let maxDiam = 0;
                        if (allFit && trial.length >= 3) {
                            for (let p = 0; p < trial.length && maxDiam <= walkMi * 2; p++) {
                                for (let q = p + 1; q < trial.length; q++) {
                                    const dd = manhattanMi(trial[p].lat, trial[p].lng, trial[q].lat, trial[q].lng);
                                    if (dd > maxDiam) maxDiam = dd;
                                }
                            }
                        }
                        if (allFit && maxDiam <= walkMi * 2) {
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
            [...campers].sort((a, b) => drivingDist(avgLat, avgLng, a.lat, a.lng) - drivingDist(avgLat, avgLng, b.lat, b.lng)),
            [...campers].sort((a, b) => drivingDist(avgLat, avgLng, b.lat, b.lng) - drivingDist(avgLat, avgLng, a.lat, a.lng)),
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

    // ── Distance matrix: backward-compatible wrapper ──
    // Delegates to fetchDistanceMatrixCascade (Mapbox → OSRM → haversine).
    // Kept for any code that still calls fetchDistanceMatrix(coords).
    async function fetchDistanceMatrix(coords) {
        return await fetchDistanceMatrixCascade(coords);
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

    // =========================================================================
    // ISOCHRONE-BASED ZONE CREATION
    // Uses Mapbox Isochrone API to build drive-time bands from camp.
    // These replace ZIP codes as the primary zone grouping — zones now
    // follow actual road networks, not arbitrary postal boundaries.
    // =========================================================================

    let _isochroneCache = null; // cached isochrone polygons
    let _isoCacheCampKey = null; // cache key = camp coords

    async function fetchIsochrones(campLat, campLng) {
        const token = getMapboxToken();
        if (!token) return null;

        // Check cache — camp rarely moves
        const cacheKey = campLat.toFixed(5) + ',' + campLng.toFixed(5);
        if (_isochroneCache && _isoCacheCampKey === cacheKey) {
            console.log('[Go] Isochrone: using cached bands');
            return _isochroneCache;
        }

        // Also check localStorage for persistence across sessions
        try {
            const stored = localStorage.getItem('CAMPISTRY_ISO_' + cacheKey);
            if (stored) {
                const parsed = JSON.parse(stored);
                if (parsed.ts && Date.now() - parsed.ts < 7 * 86400000) { // 7-day TTL
                    _isochroneCache = parsed.data;
                    _isoCacheCampKey = cacheKey;
                    console.log('[Go] Isochrone: loaded from localStorage cache');
                    return _isochroneCache;
                }
            }
        } catch (_) {}

        // Fetch from Mapbox Isochrone API
        // contours_minutes: drive-time bands in minutes from camp
        const intervals = [8, 15, 22, 30, 40, 55];
        try {
            const url = 'https://api.mapbox.com/isochrone/v1/mapbox/driving/' +
                campLng + ',' + campLat +
                '?contours_minutes=' + intervals.join(',') +
                '&polygons=true&generalize=200' +
                '&access_token=' + token;
            console.log('[Go] Isochrone: fetching ' + intervals.length + ' bands...');
            const resp = await fetch(url);
            if (!resp.ok) {
                console.warn('[Go] Isochrone: HTTP ' + resp.status);
                return null;
            }
            const data = await resp.json();
            if (!data.features?.length) return null;

            // Mapbox returns features ordered outermost to innermost — reverse so band 0 = closest
            const bands = data.features.reverse().map((feat, i) => ({
                minutes: intervals[i],
                polygon: feat.geometry.coordinates[0], // outer ring of polygon
                properties: feat.properties
            }));

            _isochroneCache = bands;
            _isoCacheCampKey = cacheKey;

            // Persist to localStorage
            try {
                localStorage.setItem('CAMPISTRY_ISO_' + cacheKey, JSON.stringify({ ts: Date.now(), data: bands }));
            } catch (_) {}

            console.log('[Go] Isochrone: ' + bands.length + ' bands fetched (' + intervals.join(', ') + ' min)');
            return bands;
        } catch (e) {
            console.warn('[Go] Isochrone: fetch error:', e.message);
            return null;
        }
    }

    // Ray-casting point-in-polygon test
    function pointInPolygon(lat, lng, polygon) {
        let inside = false;
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
            const xi = polygon[i][1], yi = polygon[i][0]; // GeoJSON = [lng, lat]
            const xj = polygon[j][1], yj = polygon[j][0];
            if (((yi > lng) !== (yj > lng)) && (lat < (xj - xi) * (lng - yi) / (yj - yi) + xi)) {
                inside = !inside;
            }
        }
        return inside;
    }

    // Assign campers to isochrone bands — returns array of band groups
    // Each group = { id, name, minutes, camperNames, centroidLat, centroidLng }
    // =========================================================================
    // SWEEP ALGORITHM — Angular partitioning from camp
    // Used by BusBoss, Transfinder, and academic SBRP solvers.
    // Creates pie-slice zones by sorting campers by bearing from camp,
    // then sweeping a radial arm until each slice fills a bus.
    // Produces naturally compact, non-overlapping zones.
    // =========================================================================
    function sweepPartition(campers, busCapacities, campLat, campLng) {
        if (!campers.length || !busCapacities.length) return null;

        // Compute bearing (angle) from camp to each camper
        const withAngle = campers.map(c => {
            const dLat = c.lat - campLat;
            const dLng = c.lng - campLng;
            // atan2 gives angle in radians; convert to degrees [0, 360)
            let angle = Math.atan2(dLng, dLat) * (180 / Math.PI);
            if (angle < 0) angle += 360;
            return { ...c, _angle: angle, _dist: haversineMi(campLat, campLng, c.lat, c.lng) };
        });

        // Sort by angle (radial sweep)
        withAngle.sort((a, b) => a._angle - b._angle);

        // Sort bus capacities descending — fill largest buses first
        const caps = [...busCapacities].sort((a, b) => b - a);
        const totalCap = caps.reduce((s, c) => s + c, 0);
        const nBuses = caps.length;

        // Sweep: fill each bus in angular order
        const slices = [];
        let idx = 0;
        for (let b = 0; b < nBuses; b++) {
            const slice = [];
            const targetFill = Math.ceil(withAngle.length * (caps[b] / totalCap));
            while (slice.length < targetFill && idx < withAngle.length) {
                slice.push(withAngle[idx]);
                idx++;
            }
            if (slice.length > 0) slices.push(slice);
        }
        // Any remaining campers go to last slice
        while (idx < withAngle.length) {
            slices[slices.length - 1].push(withAngle[idx]);
            idx++;
        }

        // Build zone objects
        const zones = slices.map((slice, i) => {
            const cLat = slice.reduce((s, c) => s + c.lat, 0) / slice.length;
            const cLng = slice.reduce((s, c) => s + c.lng, 0) / slice.length;
            const minAngle = Math.round(slice[0]._angle);
            const maxAngle = Math.round(slice[slice.length - 1]._angle);
            return {
                id: 'sweep_' + i,
                name: minAngle + '°–' + maxAngle + '° zone',
                camperNames: slice.map(c => c.name),
                centroidLat: cLat,
                centroidLng: cLng,
                color: REGION_COLORS[i % REGION_COLORS.length]
            };
        });

        console.log('[Go] Sweep: ' + zones.length + ' zones from angular partition');
        zones.forEach(z => console.log('[Go]   ' + z.name + ': ' + z.camperNames.length + ' campers'));
        return zones;
    }

    function assignCampersToIsochroneBands(campers, bands, campLat, campLng) {
        // Bands are ordered innermost to outermost
        const bandGroups = bands.map((band, i) => ({
            id: 'iso_' + band.minutes + 'min',
            name: band.minutes + '-min zone',
            minutes: band.minutes,
            camperNames: [],
            lats: [], lngs: [],
            polygon: band.polygon
        }));
        // Add a catch-all for campers beyond the outermost isochrone
        bandGroups.push({
            id: 'iso_far',
            name: 'Far zone',
            minutes: 999,
            camperNames: [],
            lats: [], lngs: [],
            polygon: null
        });

        campers.forEach(c => {
            // Find the innermost (smallest) band that contains this camper
            let assigned = false;
            for (let i = 0; i < bands.length; i++) {
                if (pointInPolygon(c.lat, c.lng, bands[i].polygon)) {
                    // This camper is inside band i, but we want the tightest band
                    // Bands are inner→outer, so check if camper is in band i but NOT in band i-1
                    if (i === 0 || !pointInPolygon(c.lat, c.lng, bands[i - 1].polygon)) {
                        bandGroups[i].camperNames.push(c.name);
                        bandGroups[i].lats.push(c.lat);
                        bandGroups[i].lngs.push(c.lng);
                        assigned = true;
                        break;
                    }
                }
            }
            // If inside all bands (closest to camp), assign to band 0
            if (!assigned) {
                // Check if inside outermost
                if (bands.length && pointInPolygon(c.lat, c.lng, bands[bands.length - 1].polygon)) {
                    bandGroups[0].camperNames.push(c.name);
                    bandGroups[0].lats.push(c.lat);
                    bandGroups[0].lngs.push(c.lng);
                } else {
                    // Beyond all isochrones
                    const farGroup = bandGroups[bandGroups.length - 1];
                    farGroup.camperNames.push(c.name);
                    farGroup.lats.push(c.lat);
                    farGroup.lngs.push(c.lng);
                }
            }
        });

        // Compute centroids and filter empty bands
        const nonEmpty = bandGroups.filter(g => g.camperNames.length > 0);
        const result = nonEmpty.map((g, idx) => {
            const cLat = g.lats.reduce((s, v) => s + v, 0) / g.lats.length;
            const cLng = g.lngs.reduce((s, v) => s + v, 0) / g.lngs.length;
            return {
                id: g.id,
                name: g.name,
                camperNames: g.camperNames,
                centroidLat: cLat,
                centroidLng: cLng,
                color: REGION_COLORS[idx % REGION_COLORS.length]
            };
        });

        console.log('[Go] Isochrone bands: ' + result.length + ' non-empty bands');
        result.forEach(b => console.log('[Go]   ' + b.name + ': ' + b.camperNames.length + ' campers'));
        return result;
    }

    // =========================================================================
    // ETAs — OSRM directions + smart rush hour buffer
    // Free, no API key. Adds 15-20% buffer during rush hours.
    // =========================================================================

    function getRushHourMultiplier(departureTimeMin) {
        // Morning rush: 7:00-9:00 AM (420-540 min) → 1.20 (20% slower)
        // Afternoon rush: 3:00-6:00 PM (900-1080 min) → 1.15 (15% slower)
        // Off-peak → 1.0 (no adjustment)
        if (departureTimeMin >= 420 && departureTimeMin <= 540) return 1.20;
        if (departureTimeMin >= 900 && departureTimeMin <= 1080) return 1.15;
        return 1.0;
    }

    async function fetchTrafficLegs(orderedStops, campLat, campLng, departureTimeMin, isArrival) {
        if (!orderedStops.length) return null;

        const coords = [];
        if (!isArrival) coords.push(campLng + ',' + campLat);
        orderedStops.forEach(s => { if (s.lat && s.lng) coords.push(s.lng + ',' + s.lat); });
        if (isArrival) coords.push(campLng + ',' + campLat);

        if (coords.length < 2) return null;
        // OSRM has no hard waypoint limit but chunk if >100
        if (coords.length > 100) return null;

        try {
            const url = 'https://router.project-osrm.org/route/v1/driving/' +
                coords.join(';') + '?annotations=duration&overview=false&steps=false';
            const resp = await fetch(url);
            if (!resp.ok) return null;
            const data = await resp.json();
            if (!data.routes?.[0]?.legs) return null;

            const multiplier = getRushHourMultiplier(departureTimeMin);
            const legs = data.routes[0].legs.map(leg => Math.round(leg.duration * multiplier));
            if (multiplier > 1) console.log('[Go] ETAs: rush hour buffer ×' + multiplier.toFixed(2) + ' applied');
            return legs;
        } catch (e) {
            console.warn('[Go] OSRM legs error:', e.message);
            return null;
        }
    }

    // =========================================================================
    // OSRM WALKING DISTANCE VALIDATION
    // Uses OSRM foot profile to verify actual walking distances.
    // Manhattan distance underestimates when there are dead-ends, parks, etc.
    // =========================================================================
    async function fetchWalkingDistances(stopLat, stopLng, camperCoords) {
        if (!camperCoords.length) return null;
        // OSRM table: stop as source, camper homes as destinations
        const coords = [stopLng + ',' + stopLat];
        camperCoords.forEach(c => coords.push(c.lng + ',' + c.lat));
        if (coords.length > 25) return null; // OSRM limit
        try {
            const url = 'https://router.project-osrm.org/table/v1/foot/' + coords.join(';') +
                '?sources=0&annotations=distance';
            const resp = await fetch(url);
            if (!resp.ok) return null;
            const data = await resp.json();
            if (data.code !== 'Ok' || !data.distances?.[0]) return null;
            // Returns distances in meters from stop to each camper
            return data.distances[0].slice(1); // skip stop-to-self
        } catch (e) {
            return null;
        }
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
    function validateGeocode(lat, lng, address, camperName, returnedResult) {
        // 1. Invalid coordinates (null, zero, NaN, Infinity)
        if (!lat || !lng || lat === 0 || lng === 0 || isNaN(lat) || isNaN(lng) || !isFinite(lat) || !isFinite(lng)) {
            console.warn('[Go] Geocode rejected for ' + camperName + ': invalid coordinates (' + lat + ', ' + lng + ')');
            return false;
        }
        // 2. Outside continental US bounds
        if (lat < 24 || lat > 50 || lng < -125 || lng > -66) {
            console.warn('[Go] Geocode rejected for ' + camperName + ': outside continental US (' + lat.toFixed(4) + ', ' + lng.toFixed(4) + ')');
            return false;
        }
        // 3. If camp location known, hard limit 100 miles
        if (_campCoordsCache) {
            const dist = haversineMi(_campCoordsCache.lat, _campCoordsCache.lng, lat, lng);
            if (dist > 100) {
                console.warn('[Go] Geocode rejected for ' + camperName + ': ' + dist.toFixed(0) + 'mi from camp (max 100)');
                return false;
            }
        }
        // 4. State-level sanity
        const addrData = D.addresses[camperName];
        if (addrData?.state) {
            const stBounds = {
                NY: [40.4, 45.1, -80, -71.8], NJ: [38.9, 41.4, -75.6, -73.9],
                CT: [40.9, 42.1, -73.8, -71.8], PA: [39.7, 42.3, -80.6, -74.7],
                MA: [41.2, 42.9, -73.5, -69.9], FL: [24.5, 31.0, -87.7, -80.0],
                CA: [32.5, 42.0, -124.5, -114.1], TX: [25.8, 36.5, -106.7, -93.5],
                OH: [38.4, 42.0, -84.9, -80.5], IL: [36.9, 42.5, -91.5, -87.0],
                GA: [30.3, 35.0, -85.6, -80.8], MI: [41.7, 48.3, -90.4, -82.1],
                NC: [33.8, 36.6, -84.3, -75.5], CO: [36.9, 41.0, -109.1, -102.0],
                MD: [37.9, 39.7, -79.5, -75.0], VA: [36.5, 39.5, -83.7, -75.2],
                WI: [42.5, 47.1, -92.9, -86.8], MN: [43.5, 49.4, -97.3, -89.5],
                IN: [37.8, 41.8, -88.1, -84.8], AZ: [31.3, 37.0, -115.0, -109.0],
                TN: [35.0, 36.7, -90.3, -81.6], MO: [35.9, 40.6, -95.8, -89.1],
                SC: [32.0, 35.2, -83.4, -78.5], AL: [30.2, 35.0, -88.5, -84.9],
                LA: [28.9, 33.0, -94.0, -88.8], KY: [36.5, 39.2, -89.6, -82.0],
                OR: [41.9, 46.3, -124.6, -116.5], OK: [33.6, 37.0, -103.0, -94.4],
                WA: [45.5, 49.0, -124.8, -116.9], IA: [40.4, 43.5, -96.6, -90.1],
                MS: [30.2, 35.0, -91.7, -88.1], AR: [33.0, 36.5, -94.6, -89.6],
                KS: [37.0, 40.0, -102.1, -94.6], UT: [37.0, 42.0, -114.1, -109.0],
                NV: [35.0, 42.0, -120.0, -114.0], NM: [31.3, 37.0, -109.1, -103.0],
                NE: [40.0, 43.0, -104.1, -95.3], WV: [37.2, 40.6, -82.6, -77.7],
                ID: [42.0, 49.0, -117.2, -111.0], HI: [18.9, 22.3, -160.3, -154.8],
                NH: [42.7, 45.3, -72.6, -70.7], ME: [43.1, 47.5, -71.1, -66.9],
                MT: [44.4, 49.0, -116.1, -104.0], RI: [41.1, 42.0, -71.9, -71.1],
                DE: [38.4, 39.8, -75.8, -75.0], SD: [42.5, 46.0, -104.1, -96.4],
                ND: [45.9, 49.0, -104.1, -96.6], AK: [51.0, 71.5, -180, -130],
                VT: [42.7, 45.0, -73.5, -71.5], WY: [41.0, 45.0, -111.1, -104.1],
                DC: [38.8, 39.0, -77.1, -77.0]
            };
            const b = stBounds[addrData.state.toUpperCase()];
            if (b && (lat < b[0] || lat > b[1] || lng < b[2] || lng > b[3])) {
                console.warn('[Go] Geocode rejected for ' + camperName + ': coords (' + lat.toFixed(4) + ', ' + lng.toFixed(4) + ') outside ' + addrData.state);
                return false;
            }
        }
        // 5. ZIP mismatch: flag but don't reject (ZIP boundaries are fuzzy)
        if (addrData?.zip && returnedResult?.zip) {
            const inputZip = addrData.zip.substring(0, 5);
            const returnedZip = (returnedResult.zip + '').substring(0, 5);
            if (inputZip !== returnedZip) {
                console.warn('[Go] Geocode ZIP mismatch for ' + camperName + ': input ' + inputZip + ' vs returned ' + returnedZip);
            }
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
            const cloud = g.campistryGo && Object.keys(g.campistryGo).length ? g.campistryGo : null;
            let local = null;
            try { const raw = localStorage.getItem(STORE); if (raw) local = JSON.parse(raw); } catch (_) {}

            if (cloud && local) {
                // Cloud may be missing addresses/savedRoutes (stripped for quota).
                // Merge: use cloud as base, fill in missing large fields from local.
                if (!cloud.addresses || !Object.keys(cloud.addresses).length) cloud.addresses = local.addresses || {};
                if (!cloud.savedRoutes) cloud.savedRoutes = local.savedRoutes || null;
                D = merge(cloud);
                console.log('[Go] Loaded from cloud settings (addresses from local)');
            } else if (cloud) {
                D = merge(cloud);
                console.log('[Go] Loaded from cloud settings');
            } else if (local) {
                D = merge(local);
                console.log('[Go] Loaded from localStorage');
            }
        } catch (e) { console.error('[Go] Load error:', e); }
    }

    function merge(d) {
        const def = { setup: { campAddress:'',campName:'',avgSpeed:25,reserveSeats:2,dropoffMode:'door-to-door',avgStopTime:2,maxWalkDistance:375,orsApiKey:'',graphhopperKey:'',mapboxToken:'',campLat:null,campLng:null,standaloneMode:false }, activeMode:'dismissal', buses:[], shifts:[], monitors:[], counselors:[], addresses:{}, savedRoutes:null, dismissal:null, arrival:null, dailyOverrides:{}, carpoolGroups:{} };
        const result = { setup: { ...def.setup, ...(d.setup || {}) }, activeMode: d.activeMode || 'dismissal', buses: d.buses || [], shifts: d.shifts || [], monitors: d.monitors || [], counselors: d.counselors || [], addresses: d.addresses || {}, savedRoutes: d.savedRoutes || null, dismissal: d.dismissal || null, arrival: d.arrival || null, dailyOverrides: d.dailyOverrides || {}, carpoolGroups: d.carpoolGroups || {} };
        if (!result.dismissal && result.buses.length) { result.dismissal = { buses: [...result.buses], shifts: [...result.shifts], monitors: [...result.monitors], counselors: [...result.counselors], savedRoutes: result.savedRoutes }; }
        if (!result.arrival) { result.arrival = { buses: [], shifts: [], monitors: [], counselors: [], savedRoutes: null }; }
        return result;
    }

    function save() {
        try {
            setSyncStatus('syncing');
            saveModeData();
            var json = JSON.stringify(D);
            try {
                localStorage.setItem(STORE, json);
            } catch (quota) {
                // Quota exceeded — strip savedRoutes from Go data and retry
                console.warn('[Go] Save: quota exceeded, stripping routes to fit (' + (json.length / 1024).toFixed(0) + 'KB)');
                var slim = JSON.parse(json);
                delete slim.savedRoutes;
                delete slim.arrival?.savedRoutes;
                delete slim.dismissal?.savedRoutes;
                localStorage.setItem(STORE, JSON.stringify(slim));
            }
            // Sync to global settings without savedRoutes (too large for localStorage quota)
            if (typeof window.saveGlobalSettings === 'function') {
                const lite = Object.assign({}, D);
                delete lite.savedRoutes; // strip route data — it's already in STORE
                window.saveGlobalSettings('campistryGo', lite);
            }
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
        // 1. If not standalone, try Campistry Me roster first
        if (!D.setup.standaloneMode) {
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
        // If not standalone, try Me's camp structure first
        if (!D.setup.standaloneMode) {
            const g = readCampistrySettings();
            const meStruct = g?.campStructure || {};
            if (Object.keys(meStruct).length) return meStruct;
        }

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
        if (document.getElementById('standaloneToggle')) document.getElementById('standaloneToggle').checked = !!s.standaloneMode;
    }
    function toggleStandalone(on) {
        D.setup.standaloneMode = !!on;
        save();
        console.log('[Go] Standalone mode: ' + (on ? 'ON — using Go data only' : 'OFF — connected to Campistry Me'));
    }
    function saveSetup() {
        const el = id => document.getElementById(id);
        const newAddr = el('campAddress')?.value.trim() || '';
        // If camp address changed, clear cached coordinates so they get re-geocoded
        if (newAddr !== D.setup.campAddress) {
            D.setup.campLat = null;
            D.setup.campLng = null;
            _campCoordsCache = null;
            console.log('[Go] Camp address changed — coordinates will re-geocode on next route generation');
        }
        D.setup.campAddress = newAddr;
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
    // ── Staff suggestion status badges ──
    function _staffStatusBadge(staff) {
        if (staff._assignStatus === 'accepted') {
            const bus = D.buses.find(b => b.id === staff._acceptedBusId);
            return '<span class="badge" style="background:var(--green-50);color:var(--green-700);border:1px solid var(--green-200)">Confirmed: ' + esc(bus?.name || staff._acceptedBus) + ', Stop ' + (staff._acceptedStopNum || '?') + '</span>';
        }
        if (staff._assignStatus === 'denied') {
            return '<span class="badge" style="background:var(--red-50);color:var(--red-600);border:1px solid var(--red-200)">Not riding bus</span>';
        }
        return '';
    }

    function _staffSuggestionHtml(staff, type) {
        // If already accepted/denied, show status badge only
        if (staff._assignStatus === 'accepted' || staff._assignStatus === 'denied') {
            return _staffStatusBadge(staff);
        }
        // If no suggestion yet, show nothing
        if (!staff._suggestedBus) return '';

        // Build accept/deny/manual buttons
        const sid = esc(staff.id);
        const stype = esc(type); // 'monitor' or 'counselor'
        return '<div style="margin-top:4px;padding:6px 8px;background:var(--blue-50);border:1px solid var(--blue-100);border-radius:6px;font-size:.8rem;">'
            + '<div style="margin-bottom:4px">Suggested: <strong>' + esc(staff._suggestedBus) + '</strong>, Stop ' + staff._suggestedStopNum + ' (' + esc(staff._suggestedStop) + ') — ' + (staff._walkFt || '?') + 'ft walk</div>'
            + '<div style="display:flex;gap:4px;flex-wrap:wrap;">'
            + '<button class="btn btn-sm" style="background:var(--green-600);color:#fff;border:none;padding:3px 10px;font-size:.75rem" onclick="event.stopPropagation();CampistryGo.acceptStaffAssign(\'' + sid + '\',\'' + stype + '\')">Accept</button>'
            + '<button class="btn btn-sm" style="background:var(--red-500);color:#fff;border:none;padding:3px 10px;font-size:.75rem" onclick="event.stopPropagation();CampistryGo.denyStaffAssign(\'' + sid + '\',\'' + stype + '\')">Deny</button>'
            + '<button class="btn btn-sm" style="background:var(--surface-secondary);border:1px solid var(--border-light);padding:3px 10px;font-size:.75rem" onclick="event.stopPropagation();CampistryGo.manualStaffAssign(\'' + sid + '\',\'' + stype + '\')">Manual</button>'
            + '</div></div>';
    }

    function _staffGeoBadge(staffMember) {
        const name = staffMember.name || (staffMember.firstName + ' ' + staffMember.lastName);
        const a = D.addresses[name];
        if (!staffMember.address && !a?.street) return '<span class="badge badge-neutral" style="font-size:.65rem">No address</span>';
        if (a?.geocoded && a._geocodeConfidence) {
            const pct = Math.round(a._geocodeConfidence * 100);
            if (pct >= 80) return '<span class="badge badge-success" style="font-size:.65rem">✓ ' + pct + '%</span>';
            return '<span class="badge badge-warning" style="font-size:.65rem">⚠ ' + pct + '%</span>';
        }
        if (a?.geocoded) return '<span class="badge badge-success" style="font-size:.65rem">✓ Geocoded</span>';
        if (staffMember._lat && staffMember._lng) return '<span class="badge badge-success" style="font-size:.65rem">✓ Geocoded</span>';
        return '<span class="badge badge-neutral" style="font-size:.65rem">Not geocoded</span>';
    }

    function renderMonitors() {
        const tbody = document.getElementById('monitorTableBody'), empty = document.getElementById('monitorEmptyState');
        const tw = tbody?.closest('.table-wrapper');
        document.getElementById('monitorCount').textContent = D.monitors.length;
        if (!D.monitors.length) { if (tw) tw.style.display = 'none'; if (empty) empty.style.display = ''; return; }
        if (tw) tw.style.display = ''; if (empty) empty.style.display = 'none';
        tbody.innerHTML = D.monitors.map(m => {
            const bus = D.buses.find(b => b.id === m.assignedBus);
            const busCol = (bus ? '<span style="display:inline-flex;align-items:center;gap:6px"><span style="width:10px;height:10px;border-radius:50%;background:' + esc(bus.color) + '"></span>' + esc(bus.name) + '</span>' : '—');
            const suggestionHtml = _staffSuggestionHtml(m, 'monitor');
            const idCol = m._personId ? '<td style="font-size:.8rem;color:var(--text-muted)">' + m._personId + '</td>' : '<td style="color:var(--text-muted)">—</td>';
            const geoBadge = _staffGeoBadge(m);
            return '<tr>' + idCol + '<td>' + esc(m.lastName || '') + '</td><td style="font-weight:600">' + esc(m.firstName || m.name) + '</td><td>' + (esc(m.address) || '—') + '</td><td>' + geoBadge + '</td><td>' + (esc(m.phone) || '—') + '</td><td>' + busCol + suggestionHtml + '</td><td><div style="display:flex;gap:4px"><button class="btn btn-ghost btn-sm" onclick="CampistryGo.editMonitor(\'' + m.id + '\')">Edit</button><button class="btn btn-ghost btn-sm" style="color:var(--red-500)" onclick="CampistryGo.deleteMonitor(\'' + m.id + '\')">×</button></div></td></tr>';
        }).join('');
    }
    function renderCounselors() {
        const tbody = document.getElementById('counselorTableBody'), empty = document.getElementById('counselorEmptyState');
        const tw = tbody?.closest('.table-wrapper');
        document.getElementById('counselorCount').textContent = D.counselors.length;
        if (!D.counselors.length) { if (tw) tw.style.display = 'none'; if (empty) empty.style.display = ''; return; }
        if (tw) tw.style.display = ''; if (empty) empty.style.display = 'none';
        tbody.innerHTML = D.counselors.map(c => {
            const bus = D.buses.find(b => b.id === c.assignedBus);
            const mode = c.assignMode || (c.needsStop === 'yes' ? 'stop' : c.assignedBus ? 'manual' : 'auto');
            const modeBadge = mode === 'stop' ? '<span class="badge badge-warning">Own Stop</span>' : mode === 'auto' ? '<span class="badge badge-neutral">Auto-assign</span>' : bus ? '<span style="display:inline-flex;align-items:center;gap:6px"><span style="width:10px;height:10px;border-radius:50%;background:' + esc(bus.color) + '"></span>' + esc(bus.name) + '</span>' : '<span class="badge badge-neutral">Manual (unset)</span>';
            const suggestionHtml = (mode !== 'stop') ? _staffSuggestionHtml(c, 'counselor') : '';
            const idCol = c._personId ? '<td style="font-size:.8rem;color:var(--text-muted)">' + c._personId + '</td>' : '<td style="color:var(--text-muted)">—</td>';
            const geoBadge = _staffGeoBadge(c);
            return '<tr style="cursor:pointer" onclick="CampistryGo.editCounselor(\'' + c.id + '\')">' + idCol + '<td>' + esc(c.lastName || '') + '</td><td style="font-weight:600">' + esc(c.firstName || c.name) + '</td><td>' + (esc(c.address) || '—') + '</td><td>' + geoBadge + '</td><td>' + (esc(c.bunk) || '—') + '</td><td>' + modeBadge + suggestionHtml + '</td><td>' + (c._walkFt ? c._walkFt + 'ft' : '—') + '</td></tr>';
        }).join('');
    }

    // ── Staff assignment actions ──
    function acceptStaffAssign(staffId, type) {
        const staff = type === 'monitor' ? D.monitors.find(m => m.id === staffId) : D.counselors.find(c => c.id === staffId);
        if (!staff || !staff._suggestedBusId) return;
        staff._assignStatus = 'accepted';
        staff._acceptedBus = staff._suggestedBus;
        staff._acceptedBusId = staff._suggestedBusId;
        staff._acceptedStop = staff._suggestedStop;
        staff._acceptedStopNum = staff._suggestedStopNum;
        staff.assignedBus = staff._suggestedBusId;
        save(); renderStaff(); toast(staff.name + ' confirmed on ' + staff._suggestedBus);
    }

    function denyStaffAssign(staffId, type) {
        const staff = type === 'monitor' ? D.monitors.find(m => m.id === staffId) : D.counselors.find(c => c.id === staffId);
        if (!staff) return;
        staff._assignStatus = 'denied';
        staff.assignedBus = '';
        save(); renderStaff(); toast(staff.name + ' — not riding bus');
    }

    function manualStaffAssign(staffId, type) {
        const staff = type === 'monitor' ? D.monitors.find(m => m.id === staffId) : D.counselors.find(c => c.id === staffId);
        if (!staff) return;

        // Build a modal with bus + stop selectors
        const existing = document.getElementById('staffManualAssignModal');
        if (existing) existing.remove();

        const busOptions = D.buses.map(b => '<option value="' + esc(b.id) + '">' + esc(b.name) + '</option>').join('');

        const overlay = document.createElement('div');
        overlay.id = 'staffManualAssignModal';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;';
        overlay.innerHTML = '<div class="modal" style="max-width:420px;padding:1.5rem">'
            + '<h3 style="margin:0 0 1rem">Assign ' + esc(staff.name) + '</h3>'
            + '<div class="form-group"><label class="form-label">Bus</label><select class="form-input" id="smaBus"><option value="">— Select —</option>' + busOptions + '</select></div>'
            + '<div class="form-group" id="smaStopGroup" style="display:none"><label class="form-label">Stop</label><select class="form-input" id="smaStop"></select></div>'
            + '<div style="display:flex;gap:8px;margin-top:1rem;justify-content:flex-end">'
            + '<button class="btn btn-secondary" onclick="document.getElementById(\'staffManualAssignModal\').remove()">Cancel</button>'
            + '<button class="btn btn-primary" id="smaConfirm">Assign</button>'
            + '</div></div>';
        document.body.appendChild(overlay);
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

        // When bus changes, populate stops
        document.getElementById('smaBus').addEventListener('change', function() {
            const busId = this.value;
            const stopGroup = document.getElementById('smaStopGroup');
            const stopSel = document.getElementById('smaStop');
            if (!busId || !D.savedRoutes) { stopGroup.style.display = 'none'; return; }

            // Find stops for this bus across all shifts
            const stops = [];
            D.savedRoutes.forEach(sr => {
                const route = sr.routes.find(r => r.busId === busId);
                if (route) route.stops.forEach(st => {
                    if (st.lat && st.lng) stops.push(st);
                });
            });

            if (!stops.length) { stopGroup.style.display = 'none'; return; }
            stopGroup.style.display = '';
            stopSel.innerHTML = stops.map(st => '<option value="' + st.stopNum + '">' + 'Stop ' + st.stopNum + ' — ' + esc(st.address) + ' (' + st.campers.length + ' kids)</option>').join('');
        });

        // Confirm
        document.getElementById('smaConfirm').addEventListener('click', function() {
            const busId = document.getElementById('smaBus').value;
            if (!busId) { toast('Select a bus', 'error'); return; }
            const bus = D.buses.find(b => b.id === busId);
            const stopNum = parseInt(document.getElementById('smaStop')?.value) || 0;

            // Find stop details
            let stopAddr = '';
            if (D.savedRoutes && stopNum) {
                D.savedRoutes.forEach(sr => {
                    const route = sr.routes.find(r => r.busId === busId);
                    if (route) { const st = route.stops.find(s => s.stopNum === stopNum); if (st) stopAddr = st.address; }
                });
            }

            staff._assignStatus = 'accepted';
            staff._acceptedBus = bus?.name || '';
            staff._acceptedBusId = busId;
            staff._acceptedStop = stopAddr;
            staff._acceptedStopNum = stopNum;
            staff.assignedBus = busId;

            save(); renderStaff();
            overlay.remove();
            toast(staff.name + ' assigned to ' + (bus?.name || 'bus') + (stopNum ? ', Stop ' + stopNum : ''));
        });
    }
    function openMonitorModal(eId) { _editMonitorId = eId || null; document.getElementById('monitorModalTitle').textContent = eId ? 'Edit Monitor' : 'Add Monitor'; updateBusSelects(); const m = eId ? D.monitors.find(x => x.id === eId) : null; document.getElementById('monitorName').value = m?.name || ''; document.getElementById('monitorAddress').value = m?.address || ''; document.getElementById('monitorPhone').value = m?.phone || ''; document.getElementById('monitorBusAssign').value = m?.assignedBus || ''; openModal('monitorModal'); document.getElementById('monitorName').focus(); }
    function saveMonitor() {
        const n = document.getElementById('monitorName')?.value.trim();
        if (!n) { toast('Enter name', 'error'); return; }
        const a = document.getElementById('monitorAddress')?.value.trim();
        const p = document.getElementById('monitorPhone')?.value.trim();
        const b = document.getElementById('monitorBusAssign')?.value || '';
        // Split name into first/last
        const parts = n.split(/\s+/);
        const firstName = parts[0] || '';
        const lastName = parts.length > 1 ? parts.slice(1).join(' ') : '';
        if (_editMonitorId) {
            const m = D.monitors.find(x => x.id === _editMonitorId);
            if (m) { m.name = n; m.firstName = firstName; m.lastName = lastName; m.address = a; m.phone = p; m.assignedBus = b; }
        } else {
            D.monitors.push({ id: uid(), name: n, firstName, lastName, address: a, phone: p, assignedBus: b });
        }
        save(); closeModal('monitorModal'); renderStaff(); renderFleet(); updateStats(); toast(_editMonitorId ? 'Updated' : 'Monitor added');
    }
    function editMonitor(id) { openMonitorModal(id); }
    function deleteMonitor(id) { const m = D.monitors.find(x => x.id === id); if (!m || !confirm('Delete "' + m.name + '"?')) return; D.monitors = D.monitors.filter(x => x.id !== id); save(); renderStaff(); renderFleet(); updateStats(); toast('Deleted'); }
    function openCounselorModal(eId) {
        _editCounselorId = eId || null;
        document.getElementById('counselorModalTitle').textContent = eId ? 'Edit Counselor' : 'Add Counselor';
        const c = eId ? D.counselors.find(x => x.id === eId) : null;
        document.getElementById('counselorName').value = c?.name || '';
        document.getElementById('counselorAddress').value = c?.address || '';
        document.getElementById('counselorBunk').value = c?.bunk || '';
        document.getElementById('counselorNeedsStop').value = c?.needsStop || 'no';
        document.getElementById('counselorStopNote').style.display = c?.needsStop === 'yes' ? 'block' : 'none';
        document.getElementById('counselorBusGroup').style.display = c?.needsStop === 'yes' ? 'none' : 'block';
        // Bus assignment
        const assignSel = document.getElementById('counselorBusAssign');
        const manualSel = document.getElementById('counselorBusManual');
        assignSel.value = c?.assignedBus ? '__manual__' : '';
        manualSel.innerHTML = '<option value="">— Select bus —</option>' + D.buses.map(b => '<option value="' + esc(b.id) + '"' + (c?.assignedBus === b.id ? ' selected' : '') + '>' + esc(b.name) + '</option>').join('');
        manualSel.style.display = c?.assignedBus ? '' : 'none';
        assignSel.onchange = function() { manualSel.style.display = assignSel.value === '__manual__' ? '' : 'none'; };
        openModal('counselorModal'); document.getElementById('counselorName').focus();
    }
    function saveCounselor() {
        const n = document.getElementById('counselorName')?.value.trim();
        if (!n) { toast('Enter name', 'error'); return; }
        const a = document.getElementById('counselorAddress')?.value.trim();
        const b = document.getElementById('counselorBunk')?.value.trim();
        const ns = document.getElementById('counselorNeedsStop')?.value || 'no';
        // Split name into first/last
        const parts = n.split(/\s+/);
        const firstName = parts[0] || '';
        const lastName = parts.length > 1 ? parts.slice(1).join(' ') : '';
        let bus = '';
        if (ns === 'no') {
            const assignMode = document.getElementById('counselorBusAssign')?.value || '';
            if (assignMode === '__manual__') bus = document.getElementById('counselorBusManual')?.value || '';
        }
        if (_editCounselorId) {
            const c = D.counselors.find(x => x.id === _editCounselorId);
            if (c) { c.name = n; c.firstName = firstName; c.lastName = lastName; c.address = a; c.bunk = b; c.needsStop = ns; c.assignedBus = bus; c.assignMode = ns === 'yes' ? 'stop' : bus ? 'manual' : 'auto'; }
        } else {
            D.counselors.push({ id: uid(), name: n, firstName, lastName, address: a, bunk: b, needsStop: ns, assignedBus: bus, assignMode: ns === 'yes' ? 'stop' : bus ? 'manual' : 'auto' });
        }
        save(); closeModal('counselorModal'); renderStaff(); renderFleet(); updateStats(); toast(_editCounselorId ? 'Updated' : 'Counselor added');
    }
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
                validated: !!a._validated,
                hasAddr: !!a.street,
                confidence: a._geocodeConfidence || 0,
                source: a._geocodeSource || '',
                crossValidated: !!a._crossValidated
            };
        });

        // Filter by active mode (arrival/dismissal)
        const modeKey = D.activeMode === 'arrival' ? '_arrival' : '_dismissal';
        rows = rows.filter(r => {
            const a = D.addresses[r.name];
            return !a || a[modeKey] !== false;
        });

        // Capture mode-filtered totals BEFORE search filter
        const modeTotal = rows.length;
        const modeWithAddr = rows.filter(r => r.hasAddr).length;

        // Search filter
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

        const tbody = document.getElementById('addressTableBody'), empty = document.getElementById('addressEmptyState');
        const tw = tbody?.closest('.table-wrapper');
        document.getElementById('addressCount').textContent = filter ? rows.length + ' of ' + modeTotal : modeTotal;
        if (!modeTotal) { if (tw) tw.style.display = 'none'; if (empty) empty.style.display = ''; updateAddrProgress(0, 0); return; }
        if (tw) tw.style.display = ''; if (empty) empty.style.display = 'none';
        updateAddrProgress(modeWithAddr, modeTotal);

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
            const validated = r.validated;
            const confPct = r.confidence ? Math.round(r.confidence * 100) + '%' : '';
            const srcLabel = r.source ? ' via ' + r.source : '';
            const confTitle = (confPct ? confPct + ' confidence' + srcLabel : '') + (r.crossValidated ? ' [cross-validated]' : '');
            const badge = r.hasAddr ? (r.geocodeWarning ? '<span class="badge badge-danger" title="' + esc(r.geocodeWarning) + '">⚠ ' + esc(r.geocodeWarning.substring(0,30)) + '</span>' : r.geocoded ? (r.zipMismatch ? '<span class="badge badge-warning" title="ZIP mismatch' + (confTitle ? ' — ' + confTitle : '') + '">⚠ Check ZIP</span>' : r.confidence >= 0.8 ? '<span class="badge badge-success" title="' + esc(confTitle) + '">✓ ' + confPct + (r.crossValidated ? ' ✓✓' : '') + '</span>' : r.confidence >= 0.5 ? '<span class="badge badge-warning" title="' + esc(confTitle) + '">' + confPct + srcLabel + '</span>' : '<span class="badge badge-danger" title="' + esc(confTitle) + '">⚠ ' + confPct + '</span>') : validated ? '<span class="badge badge-warning">Verified, not geocoded</span>' : '<span class="badge badge-warning">Not geocoded</span>') : '<span class="badge badge-danger">Missing</span>';
            return '<tr><td style="font-size:.75rem;color:var(--text-muted);font-family:monospace;">' + (r.id ? '#' + String(r.id).padStart(4, '0') : '') + '</td><td style="font-weight:600">' + esc(r.last) + '</td><td>' + esc(r.first) + '</td><td>' + (esc(r.division) || '—') + '</td><td>' + (esc(r.grade) || '—') + '</td><td>' + (esc(r.bunk) || '—') + '</td><td>' + (full ? esc(full) : '<span style="color:var(--text-muted)">No address</span>') + '</td><td>' + badge + '</td><td><div style="display:flex;gap:4px;"><button class="btn btn-ghost btn-sm" onclick="CampistryGo.editAddress(\'' + esc(r.name.replace(/'/g, "\\'")) + '\')">' + (r.hasAddr ? 'Edit' : 'Add') + '</button>' + (r.geocoded ? '<button class="btn btn-ghost btn-sm" onclick="CampistryGo.locateCamper(\'' + esc(r.name.replace(/'/g, "\\'")) + '\')" title="Show on map" style="font-size:.7rem;">📍</button>' : '') + '</div></td></tr>';
        }).join('');
    }
    function updateAddrProgress(n, t) { const p = t > 0 ? Math.round(n / t * 100) : 0; document.getElementById('addressProgressBar').style.width = p + '%'; document.getElementById('addressProgressText').textContent = n + ' of ' + t + ' (' + p + '%)'; }

    /* ── Progress bar takeover for geocoding / validation ── */
    let _progStartTime = 0;
    function progressStart(label) {
        _progStartTime = Date.now();
        const card = document.getElementById('progressCard');
        card.className = card.className.replace(/progress-card-\w+/g, '').trim() + ' progress-card-active';
        document.getElementById('progressLabel').textContent = label;
        document.getElementById('progressHint').style.display = 'none';
        document.getElementById('progressETA').style.display = '';
        document.getElementById('progressETA').textContent = 'Estimating...';
    }
    function progressUpdate(done, total, detail) {
        const p = total > 0 ? Math.round(done / total * 100) : 0;
        document.getElementById('addressProgressBar').style.width = p + '%';
        document.getElementById('addressProgressText').textContent = done + ' of ' + total + ' (' + p + '%)';
        // ETA calculation
        const elapsed = (Date.now() - _progStartTime) / 1000;
        const etaEl = document.getElementById('progressETA');
        if (done > 0 && done < total) {
            const rate = done / elapsed;
            const remaining = (total - done) / rate;
            let etaStr;
            if (remaining < 60) etaStr = Math.ceil(remaining) + 's remaining';
            else if (remaining < 3600) etaStr = Math.ceil(remaining / 60) + 'm ' + Math.ceil(remaining % 60) + 's remaining';
            else etaStr = Math.floor(remaining / 3600) + 'h ' + Math.ceil((remaining % 3600) / 60) + 'm remaining';
            etaEl.textContent = (detail ? detail + ' · ' : '') + '~' + etaStr;
        } else if (done >= total) {
            etaEl.textContent = detail || 'Finishing...';
        } else {
            etaEl.textContent = detail || 'Starting...';
        }
    }
    function progressEnd(summary, isError) {
        const card = document.getElementById('progressCard');
        card.className = card.className.replace(/progress-card-\w+/g, '').trim() + (isError ? ' progress-card-error' : ' progress-card-done');
        document.getElementById('progressLabel').textContent = isError ? 'Geocoding — Issues Found' : 'Geocoding Complete';
        document.getElementById('progressETA').textContent = summary;
        document.getElementById('addressProgressBar').style.width = '100%';
        // Revert to address completion mode after 8 seconds
        setTimeout(() => {
            card.className = card.className.replace(/progress-card-\w+/g, '').trim();
            document.getElementById('progressLabel').textContent = 'Address Completion';
            document.getElementById('progressHint').style.display = '';
            document.getElementById('progressHint').textContent = 'Import addresses via CSV/Excel above, or add them individually below.';
            document.getElementById('progressETA').style.display = 'none';
            renderAddresses();
        }, 8000);
    }
    function editAddress(name) {
        _editCamper = name; const roster = getRoster(), c = roster[name] || {}, a = D.addresses[name] || {};
        document.getElementById('addressCamperName').textContent = name;
        // Camper info fields
        document.getElementById('addrCamperId').value = c.camperId || a._camperId || '';
        document.getElementById('addrDivision').value = c.division || a._division || '';
        document.getElementById('addrGrade').value = c.grade || a._grade || '';
        document.getElementById('addrBunk').value = c.bunk || a._bunk || '';
        // Address fields
        document.getElementById('addrStreet').value = a.street || '';
        document.getElementById('addrCity').value = a.city || '';
        document.getElementById('addrState').value = a.state || 'NY';
        document.getElementById('addrZip').value = a.zip || '';
        // Arrival/Dismissal checkboxes (default true if not set)
        document.getElementById('addrArrival').checked = a._arrival !== false;
        document.getElementById('addrDismissal').checked = a._dismissal !== false;
        openModal('addressModal'); document.getElementById('addrStreet').focus();
    }
    async function saveAddress() {
        if (!_editCamper) return;
        const st = document.getElementById('addrStreet')?.value.trim(), ci = document.getElementById('addrCity')?.value.trim(), sa = document.getElementById('addrState')?.value.trim().toUpperCase(), z = document.getElementById('addrZip')?.value.trim();
        const camperId = parseInt(document.getElementById('addrCamperId')?.value) || 0;
        const division = document.getElementById('addrDivision')?.value.trim();
        const grade = document.getElementById('addrGrade')?.value.trim();
        const bunk = document.getElementById('addrBunk')?.value.trim();

        if (!st) { delete D.addresses[_editCamper]; save(); closeModal('addressModal'); renderAddresses(); updateStats(); return; }
        // ★ Starter plan: check limit if this is a NEW address
        if (!D.addresses[_editCamper]) {
            var limit = await checkCamperLimitGo(1);
            if (!limit.allowed) return;
        }
        // Merge: preserve existing fields (geocode data, overrides, transport, etc.)
        const existing = D.addresses[_editCamper] || {};
        const addrChanged = existing.street !== st || existing.city !== ci || existing.state !== sa || existing.zip !== z;
        const forArrival = document.getElementById('addrArrival')?.checked !== false;
        const forDismissal = document.getElementById('addrDismissal')?.checked !== false;
        D.addresses[_editCamper] = Object.assign(existing, {
            street: st, city: ci, state: sa, zip: z,
            _camperId: camperId, _division: division, _grade: grade, _bunk: bunk,
            _arrival: forArrival, _dismissal: forDismissal
        });
        // Only re-geocode if address actually changed
        if (addrChanged) {
            D.addresses[_editCamper].lat = null;
            D.addresses[_editCamper].lng = null;
            D.addresses[_editCamper].geocoded = false;
        }
        save(); closeModal('addressModal'); renderAddresses(); updateStats();
        if (addrChanged) {
            geocodeOne(_editCamper).then(ok => { if (ok) { save(); renderAddresses(); } });
        }
    }

    // =========================================================================
    // GEOCODING — Multi-provider confidence-ranked pipeline
    // Priority: Mapbox v6 (best accuracy) → Census (free/unlimited) → ORS
    // Each provider returns { lat, lng, confidence, source, zipMatch, precision }
    // The highest-confidence valid result wins.
    // =========================================================================

    function getMapboxToken() { return D.setup.mapboxToken || _PLATFORM_KEYS.mapbox; }

    // ── Mapbox v6 Geocoding (primary) ──
    // Structured input for precision; returns rooftop/interpolated/approximate
    async function mapboxGeocode(street, city, state, zip) {
        const token = getMapboxToken();
        if (!token) return null;
        try {
            const params = new URLSearchParams({
                access_token: token,
                country: 'us',
                limit: '3',
                types: 'address'
            });
            if (street) params.set('address_line1', street);
            if (city) params.set('place', city);
            if (state) params.set('region', state);
            if (zip) params.set('postcode', zip);
            // Use proximity bias toward camp if known
            if (_campCoordsCache) params.set('proximity', _campCoordsCache.lng + ',' + _campCoordsCache.lat);

            const resp = await fetch('https://api.mapbox.com/search/geocode/v6/forward?' + params.toString(), {
                headers: { 'Accept': 'application/json' }
            });
            if (!resp.ok) {
                if (resp.status === 429) console.warn('[Go] Mapbox rate limit hit');
                return null;
            }
            const data = await resp.json();
            if (!data.features?.length) return null;

            // Score each result and pick the best
            let bestResult = null, bestScore = -1;
            for (const feat of data.features) {
                const coords = feat.geometry?.coordinates;
                if (!coords) continue;
                const props = feat.properties || {};
                const ctx = props.context || {};

                // Base confidence from Mapbox relevance
                let score = (props.match_code?.confidence || 'low') === 'exact' ? 0.95
                    : (props.match_code?.confidence || 'low') === 'high' ? 0.85
                    : (props.match_code?.confidence || 'low') === 'medium' ? 0.65
                    : 0.4;

                // Precision bonus: rooftop > parcel > interpolated > approximate
                const precision = props.match_code?.address_number || 'inferred';
                if (precision === 'matched') score += 0.05;
                else if (precision === 'inferred') score -= 0.05;
                else if (precision === 'plausible') score -= 0.1;

                // ZIP match bonus
                const resultZip = ctx.postcode?.name || '';
                const zipMatch = !!(zip && resultZip && resultZip.substring(0, 5) === zip.substring(0, 5));
                if (zip && zipMatch) score += 0.05;
                else if (zip && resultZip && !zipMatch) score -= 0.2;

                if (score > bestScore) {
                    bestScore = score;
                    bestResult = {
                        lat: coords[1], lng: coords[0],
                        confidence: Math.min(score, 1),
                        source: 'mapbox',
                        zipMatch: zipMatch,
                        precision: precision,
                        street: props.name_preferred || props.name || street,
                        city: ctx.place?.name || city,
                        state: ctx.region?.region_code || state,
                        zip: resultZip ? resultZip.substring(0, 5) : zip
                    };
                }
            }
            return bestResult;
        } catch (e) {
            console.warn('[Go] Mapbox geocode error:', e.message);
            return null;
        }
    }

    // ── Census geocoder (secondary — free & unlimited) ──
    async function censusGeocodeScored(street, city, state, zip) {
        const censusQ = normalizeCensusAddress(street, city, state, zip);
        try {
            const d = await censusGeocode(censusQ);
            if (!d?.result?.addressMatches?.length) return null;
            const best = d.result.addressMatches[0];
            if (!best.coordinates || best.coordinates.y == null || best.coordinates.x == null) return null;
            const lat = best.coordinates.y, lng = best.coordinates.x;
            if (isNaN(lat) || isNaN(lng)) return null;
            const matchedAddr = (best.matchedAddress || '').toUpperCase();
            // Extract ZIP from matched address
            const matchedZip = (matchedAddr.match(/\b(\d{5})\b/) || [])[1] || '';
            let score = 0.85; // Census is highly accurate for US residential
            const zipMatch = !!(zip && matchedZip && zip.substring(0, 5) === matchedZip);
            if (zipMatch) score += 0.1;
            return {
                lat, lng, confidence: Math.min(score, 1), source: 'census',
                zipMatch, precision: 'interpolated',
                zip: matchedZip
            };
        } catch (e) {
            console.warn('[Go] Census scored error:', e.message);
            return null;
        }
    }

    // ── ORS geocoder (tertiary fallback) ──
    async function orsGeocodeScored(street, city, state, zip) {
        const key = getApiKey();
        if (!key) return null;
        const q = [street, city, state, zip].filter(Boolean).join(', ');
        const params = { text: q, size: '5', 'boundary.country': 'US' };
        if (_campCoordsCache) { params['focus.point.lat'] = _campCoordsCache.lat; params['focus.point.lon'] = _campCoordsCache.lng; }
        try {
            const r = await fetch('https://api.openrouteservice.org/geocode/search?' + new URLSearchParams(params), { headers: { 'Authorization': key, 'Accept': 'application/json' } });
            if (!r.ok) return null;
            const d = await r.json();
            if (!d.features?.length) return null;
            // Prefer ZIP-matching result
            let best = null;
            if (zip) best = d.features.find(f => (f.properties?.postalcode || '') === zip);
            if (!best) best = d.features[0];
            if (!best?.geometry?.coordinates || best.geometry.coordinates.length < 2) return null;
            const co = best.geometry.coordinates;
            if (isNaN(co[0]) || isNaN(co[1])) return null;
            const props = best.properties || {};
            let score = Math.min((props.confidence || 0.5), 1);
            const zipMatch = !!(zip && props.postalcode && props.postalcode === zip);
            if (zipMatch) score += 0.1;
            else if (zip && props.postalcode && props.postalcode !== zip) score -= 0.15;
            return {
                lat: co[1], lng: co[0], confidence: Math.min(score, 1), source: 'ors',
                zipMatch, precision: 'approximate',
                zip: props.postalcode || ''
            };
        } catch (e) { console.warn('[Go] ORS geocode error:', e.message); return null; }
    }

    // ── Unified geocode: query all providers, pick best valid result ──
    async function geocodeOne(name) {
        const a = D.addresses[name];
        if (!a?.street) return false;

        // Run free providers in priority order, stop early if high-confidence
        const results = [];

        // 1. Census (free, unlimited, excellent for US residential)
        const cen = await censusGeocodeScored(a.street, a.city, a.state, a.zip);
        if (cen && validateGeocode(cen.lat, cen.lng, a.street, name, cen)) {
            results.push(cen);
            // If Census returns high confidence with ZIP match, use immediately
            if (cen.confidence >= 0.8 && cen.zipMatch !== false) {
                applyBestGeocode(a, cen, name);
                return true;
            }
        }

        // 2. ORS (fallback if Census failed or low confidence)
        if (results.length === 0 || results.every(r => r.confidence < 0.6)) {
            const ors = await orsGeocodeScored(a.street, a.city, a.state, a.zip);
            if (ors && validateGeocode(ors.lat, ors.lng, a.street, name, ors)) {
                results.push(ors);
            }
        }

        if (results.length === 0) return false;

        // Cross-validation bonus: if 2+ providers agree within 0.15mi, boost confidence
        if (results.length >= 2) {
            for (let i = 0; i < results.length; i++) {
                for (let j = i + 1; j < results.length; j++) {
                    const dist = haversineMi(results[i].lat, results[i].lng, results[j].lat, results[j].lng);
                    if (dist < 0.15) {
                        results[i].confidence = Math.min(results[i].confidence + 0.1, 1);
                        results[j].confidence = Math.min(results[j].confidence + 0.1, 1);
                        results[i]._crossValidated = true;
                        results[j]._crossValidated = true;
                    }
                }
            }
        }

        // Pick highest confidence
        results.sort((a, b) => b.confidence - a.confidence);
        const best = results[0];
        applyBestGeocode(a, best, name);
        return true;
    }

    function applyBestGeocode(a, result, name) {
        a.lat = result.lat;
        a.lng = result.lng;
        a.geocoded = true;
        a._geocodeSource = result.source;
        a._geocodeConfidence = result.confidence;
        a._geocodePrecision = result.precision || 'unknown';
        a._crossValidated = result._crossValidated || false;
        a._zipMismatch = (result.zipMatch === false);
        if (result.confidence < 0.5) {
            a._geocodeWarning = 'Low confidence (' + Math.round(result.confidence * 100) + '%) — verify address';
        } else {
            delete a._geocodeWarning;
        }
        console.log('[Go] Geocoded ' + name + ': ' + result.source + ' (' + Math.round(result.confidence * 100) + '% confidence, ' + (result.precision || '?') + ')' + (result._crossValidated ? ' [cross-validated]' : ''));
    }

    // =========================================================================
    // ADDRESS VALIDATION — USPS standardization with Census fallback
    // =========================================================================
    // ── Nominatim (OpenStreetMap) address validation ──
    // Free, no registration, returns standardized address + coordinates
    async function nominatimValidate(street, city, state, zip) {
        const q = [street, city, state, zip].filter(Boolean).join(', ');
        try {
            const params = new URLSearchParams({
                q: q, format: 'json', addressdetails: '1',
                countrycodes: 'us', limit: '1'
            });
            const resp = await fetch('https://nominatim.openstreetmap.org/search?' + params.toString());
            if (!resp.ok) return null;
            const results = await resp.json();
            if (!results.length) return null;
            const r = results[0];
            const ad = r.address || {};
            // Build standardized street from components
            let stdStreet = '';
            if (ad.house_number && ad.road) stdStreet = ad.house_number + ' ' + ad.road;
            else if (ad.road) stdStreet = ad.road;
            else stdStreet = street; // keep original if Nominatim didn't parse
            return {
                street: stdStreet,
                city: ad.city || ad.town || ad.village || ad.hamlet || city,
                state: ad.state || state,
                zip: ad.postcode || zip,
                lat: parseFloat(r.lat),
                lng: parseFloat(r.lon),
                displayName: r.display_name || '',
                confidence: parseFloat(r.importance || 0)
            };
        } catch (e) {
            console.warn('[Go] Nominatim error:', e.message);
            return null;
        }
    }

    async function validateAllAddresses() {
        const names = Object.keys(D.addresses).filter(n => D.addresses[n]?.street);
        if (!names.length) return;

        progressStart('Validating Addresses');
        let validated = 0, corrected = 0, geocoded = 0, failed = 0;

        for (let i = 0; i < names.length; i++) {
            const name = names[i];
            const a = D.addresses[name];
            if (!a.street) continue;

            // Use Census (JSONP — no CORS issues) as primary validator
            let result = null;
            const cen = await censusGeocodeScored(a.street, a.city, a.state, a.zip);
            if (cen && cen.lat && cen.lng) {
                result = { lat: cen.lat, lng: cen.lng, confidence: cen.confidence, source: 'census', zip: cen.zip || '' };
            }
            // Fallback to ORS if Census fails
            if (!result) {
                const ors = await orsGeocodeScored(a.street, a.city, a.state, a.zip);
                if (ors && ors.lat && ors.lng) {
                    result = { lat: ors.lat, lng: ors.lng, confidence: ors.confidence, source: 'ors', zip: ors.zip || '' };
                }
            }

            if (result && result.lat && result.lng) {
                if (!validateGeocode(result.lat, result.lng, a.street, name, result)) {
                    a._validated = false;
                    a._geocodeWarning = 'Location invalid — check address';
                    failed++;
                } else {
                    // Never overwrite the user's address — geocoders return variants
                    // like "Village of Cedarhurst" instead of "Cedarhurst" which break
                    // subsequent geocoding. Just validate and set coordinates.
                    a.lat = result.lat;
                    a.lng = result.lng;
                    a.geocoded = true;
                    a._geocodeSource = result.source;
                    a._geocodeConfidence = result.confidence;
                    a._validated = true;
                    a._zipMismatch = !!(a.zip && result.zip && a.zip !== result.zip.substring(0, 5));
                    delete a._geocodeWarning;
                    validated++;
                    geocoded++;
                }
            } else {
                a._validated = false;
                a._geocodeWarning = 'Address not found — may not exist';
                failed++;
                console.warn('[Go] Address not found: ' + name + ' (' + [a.street, a.city, a.state, a.zip].join(', ') + ')');
            }

            if ((i + 1) % 5 === 0 || i === names.length - 1) {
                renderAddresses();
                progressUpdate(i + 1, names.length, 'Census · ' + validated + ' verified');
            }
            if (i < names.length - 1) await new Promise(r => setTimeout(r, 300)); // Census has no rate limit
        }

        save(); renderAddresses(); updateStats();
        const summary = validated + ' verified, ' + geocoded + ' geocoded' + (failed > 0 ? ', ' + failed + ' unverified' : '');
        progressEnd(summary, failed > 0);

        // For any that couldn't be found, try the full pipeline as backup
        const stillUngeocoded = names.filter(n => !D.addresses[n]?.geocoded);
        if (stillUngeocoded.length) {
            await geocodeAll(false);
        }
    }

    async function geocodeAll(force) {
        if (!_campCoordsCache && D.setup.campAddress) { const cc = await geocodeSingle(D.setup.campAddress); if (cc) { _campCoordsCache = cc; D.setup.campLat = cc.lat; D.setup.campLng = cc.lng; save(); } }
        const todo = Object.keys(D.addresses).filter(n => { const a = D.addresses[n]; if (!a?.street) return false; if (force) { a.geocoded = false; a.lat = null; a.lng = null; a._zipMismatch = false; a._geocodeConfidence = null; a._geocodePrecision = null; a._crossValidated = false; return true; } return !a.geocoded; });
        if (!todo.length) return;

        progressStart('Geocoding Addresses');
        const hasOrs = !!getApiKey();
        let totalOk = 0, totalFail = 0;

        // Calculate total work across all passes: every address goes through pass 1,
        // then we estimate ~30% need pass 2, ~10% need pass 3 (adjusted as we go)
        let processed = 0;
        let totalWork = todo.length;

        // ── Pass 1: Census (free, unlimited, US residential) ──
        if (todo.length > 0) {
            let cenOk = 0;
            for (let i = 0; i < todo.length; i++) {
                const name = todo[i]; const a = D.addresses[name];
                if (!a?.street || a.geocoded) { processed++; continue; }
                const cen = await censusGeocodeScored(a.street, a.city, a.state, a.zip);
                if (cen && validateGeocode(cen.lat, cen.lng, a.street, name, cen)) {
                    applyBestGeocode(a, cen, name);
                    cenOk++;
                }
                processed++;
                if ((i + 1) % 5 === 0 || i === todo.length - 1) {
                    renderAddresses(); updateStats();
                    progressUpdate(processed, totalWork, 'Pass 1: Census · ' + cenOk + ' geocoded');
                }
                if (i < todo.length - 1) await new Promise(r => setTimeout(r, 300));
            }
            totalOk += cenOk;
            save();
        }

        // ── Pass 2: ORS for any still remaining ──
        const finalNeeded = todo.filter(n => !D.addresses[n]?.geocoded);
        if (finalNeeded.length > 0 && hasOrs) {
            totalWork += finalNeeded.length; // extend total again
            currentPass = 'ORS';
            let orsOk = 0;
            for (let i = 0; i < finalNeeded.length; i++) {
                const name = finalNeeded[i]; const a = D.addresses[name];
                if (!a?.street || a.geocoded) { processed++; continue; }
                const ors = await orsGeocodeScored(a.street, a.city, a.state, a.zip);
                if (ors && validateGeocode(ors.lat, ors.lng, a.street, name, ors)) {
                    applyBestGeocode(a, ors, name);
                    orsOk++;
                } else {
                    a._geocodeWarning = 'All providers failed — verify address';
                    totalFail++;
                }
                processed++;
                if ((i + 1) % 3 === 0 || i === finalNeeded.length - 1) {
                    renderAddresses(); updateStats();
                    progressUpdate(processed, totalWork, 'Pass 2: ORS · ' + orsOk + ' geocoded');
                }
                if (i < finalNeeded.length - 1) await new Promise(r => setTimeout(r, 500));
            }
            totalOk += orsOk;
            save();
        } else if (finalNeeded.length > 0) {
            finalNeeded.forEach(n => {
                if (!D.addresses[n]?.geocoded) {
                    D.addresses[n]._geocodeWarning = 'Census failed — verify address';
                    totalFail++;
                }
            });
        }

        renderAddresses(); updateStats();
        const highConf = todo.filter(n => (D.addresses[n]?._geocodeConfidence || 0) >= 0.8).length;
        const lowConf = todo.filter(n => D.addresses[n]?.geocoded && (D.addresses[n]._geocodeConfidence || 0) < 0.5).length;
        let summary = totalOk + ' geocoded';
        if (highConf) summary += ' (' + highConf + ' high confidence)';
        if (lowConf) summary += ', ' + lowConf + ' low confidence';
        if (totalFail > 0) summary += ', ' + totalFail + ' failed';
        progressEnd(summary, totalFail > 0);
    }

    async function geocodeSingle(addr) {
        // For single address string (e.g. camp address), try structured Census → freeform Census → ORS
        const cleanAddr = (addr || '').replace(/\s*[,#]\s*(apt|suite|ste|unit|fl|floor|rm|room)\.?\s*\S*/gi, '').replace(/\s+/g, ' ').trim();
        if (!cleanAddr) return null;
        // 0. Try structured Census first (much more accurate for "800 Rockaway Ave, Lakewood, NJ 08701")
        try {
            var parts = cleanAddr.split(/\s*,\s*/);
            if (parts.length >= 3) {
                var street = parts[0];
                var city = parts[1];
                var stZip = parts.slice(2).join(' ').trim();
                var stMatch = stZip.match(/^([A-Za-z]{2})\s*(\d{5})?/);
                var state = stMatch ? stMatch[1] : '';
                var zip = stMatch && stMatch[2] ? stMatch[2] : '';
                if (street && city && state) {
                    var scored = await censusGeocodeScored(street, city, state, zip);
                    if (scored && scored.lat && scored.lng) {
                        console.log('[Go] geocodeSingle: structured Census matched ' + cleanAddr + ' → (' + scored.lat.toFixed(4) + ', ' + scored.lng.toFixed(4) + ')');
                        return { lat: scored.lat, lng: scored.lng };
                    }
                }
            }
        } catch (e) { console.warn('[Go] geocodeSingle structured Census error:', e.message); }
        // 1. Census freeform (fallback)
        try {
            const d = await censusGeocode(cleanAddr);
            if (d?.result?.addressMatches?.length) {
                const m = d.result.addressMatches[0];
                if (m.coordinates?.y && m.coordinates?.x) {
                    console.log('[Go] geocodeSingle: Census freeform matched ' + cleanAddr);
                    return { lat: m.coordinates.y, lng: m.coordinates.x };
                }
            }
        } catch (e) { console.warn('[Go] geocodeSingle Census error:', e.message); }
        // 2. ORS (fallback)
        const key = getApiKey();
        if (key) {
            try {
                const r = await fetch('https://api.openrouteservice.org/geocode/search?' + new URLSearchParams({ text: addr, size: '1', 'boundary.country': 'US' }), { headers: { 'Authorization': key, 'Accept': 'application/json' } });
                if (r.ok) {
                    const d = await r.json();
                    if (d.features?.[0]?.geometry?.coordinates?.length >= 2) {
                        const co = d.features[0].geometry.coordinates;
                        console.log('[Go] geocodeSingle: ORS matched ' + cleanAddr);
                        return { lat: co[1], lng: co[0] };
                    }
                }
            } catch (e) { console.warn('[Go] geocodeSingle ORS error:', e.message); }
        }
        // 3. Nominatim (last resort)
        try {
            const resp = await fetch('https://nominatim.openstreetmap.org/search?' + new URLSearchParams({ q: cleanAddr, format: 'json', limit: '1', countrycodes: 'us' }));
            if (resp.ok) {
                const results = await resp.json();
                if (results.length && results[0].lat && results[0].lon) {
                    console.log('[Go] geocodeSingle: Nominatim matched ' + cleanAddr);
                    return { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
                }
            }
        } catch (e) { console.warn('[Go] geocodeSingle Nominatim error:', e.message); }
        console.warn('[Go] geocodeSingle: all providers failed for ' + cleanAddr);
        return null;
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
        // Confidence breakdown
        if (gc > 0) {
            const highConf = Object.values(D.addresses).filter(a => a.geocoded && (a._geocodeConfidence || 0) >= 0.8).length;
            const medConf = Object.values(D.addresses).filter(a => a.geocoded && (a._geocodeConfidence || 0) >= 0.5 && (a._geocodeConfidence || 0) < 0.8).length;
            const lowConf = Object.values(D.addresses).filter(a => a.geocoded && (a._geocodeConfidence || 0) > 0 && (a._geocodeConfidence || 0) < 0.5).length;
            const crossVal = Object.values(D.addresses).filter(a => a._crossValidated).length;
            if (highConf) P('High confidence: ' + highConf + '/' + gc);
            if (medConf) Wr('Medium confidence: ' + medConf + '/' + gc + ' — consider re-validating');
            if (lowConf) F('Low confidence: ' + lowConf + '/' + gc + ' — verify these addresses');
            if (crossVal) P('Cross-validated (2+ providers agree): ' + crossVal);
            // Source breakdown
            const sources = {};
            Object.values(D.addresses).filter(a => a.geocoded).forEach(a => { sources[a._geocodeSource || 'unknown'] = (sources[a._geocodeSource || 'unknown'] || 0) + 1; });
            P('Sources: ' + Object.entries(sources).map(([k, v]) => k + ': ' + v).join(', '));
        }
        const mbToken = getMapboxToken();
        mbToken ? P('Mapbox token: set (primary geocoder)') : Wr('Mapbox token: not set — using Census as primary (lower accuracy)');
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
        let csv = '\uFEFFID,Last Name,First Name,Role,Division,Grade,Bunk,Needs Stop,Street Address,City,State,ZIP,Arrival,Dismissal\n';
        csv += '"0001","Smith","Sarah","C","Juniors","1st Grade","1A","","123 Main Street","Anytown","NY","11559","Y","Y"\n';
        csv += '"0002","Goldberg","Moshe","C","Seniors","4th Grade","4B","","456 Oak Avenue","Woodmere","NY","11598","Y","N"\n';
        csv += '"0003","Cohen","David","S","","","","No","789 Elm Street","Cedarhurst","NY","11516","Y","Y"\n';
        csv += '"0004","Klein","Rachel","S","Freshies","","","Yes","321 Pine Road","Lawrence","NY","11559","N","Y"\n';
        csv += '"0005","Levy","Moshe","M","","","","No","555 Bus Depot Rd","Woodmere","NY","11598","Y","Y"\n';
        const blob = new Blob([csv], { type: 'text/csv' }); const el = document.createElement('a'); el.href = URL.createObjectURL(blob); el.download = 'campistry_go_addresses.csv'; el.click(); toast('Template downloaded');
    }
    function importAddressCsv() {
        const inp = document.createElement('input');
        inp.type = 'file';
        // No accept filter — allow any file type (some Excel variants get blocked)
        inp.style.display = 'none';
        document.body.appendChild(inp);
        inp.onchange = function () {
            if (!inp.files[0]) { inp.remove(); return; }
            const file = inp.files[0];
            const ext = file.name.split('.').pop().toLowerCase();
            if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsm' || ext === 'xlsb') {
                // Excel file — read as array buffer and parse via SheetJS
                const r = new FileReader();
                r.onload = e => { parseExcel(e.target.result); inp.remove(); };
                r.onerror = () => { toast('Failed to read file', 'error'); inp.remove(); };
                r.readAsArrayBuffer(file);
            } else {
                // CSV/TSV/TXT or anything else — try reading as text
                const r = new FileReader();
                r.onload = e => { parseCsv(e.target.result); inp.remove(); };
                r.onerror = () => { toast('Failed to read file', 'error'); inp.remove(); };
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
    async function parseCsv(text) {
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        const lines = text.split(/\r?\n/).filter(l => l.trim()); if (lines.length < 2) { toast('Empty CSV', 'error'); return; }
        // ★ Starter plan: check limit and cap import if needed
        var _goMaxImport = Infinity;
        var _goCapped = 0;
        var newCount = lines.length - 1;
        if (newCount > 0) {
            var limit = await checkCamperLimitGo(newCount, true);
            if (!limit.allowed && limit.current !== undefined && limit.max !== undefined) {
                var slotsAvailable = Math.max(0, limit.max - limit.current);
                if (slotsAvailable === 0) {
                    toast('Camper limit reached (' + limit.max + '). Upgrade for more.', 'error');
                    return;
                }
                _goMaxImport = slotsAvailable;
                toast('Accepting ' + slotsAvailable + ' of ' + newCount + ' entries (limit: ' + limit.max + ')');
            }
        }
        const hdr = parseLine(lines[0]).map(h => h.toLowerCase().trim());

        // Detect column indices — support multiple naming conventions
        const idi = hdr.findIndex(h => h === 'camper id' || h === 'id' || h === 'camperid' || h === '#');
        const lni = hdr.findIndex(h => h === 'last name' || h === 'last' || h === 'lastname' || h === 'family name');
        const fni = hdr.findIndex(h => h === 'first name' || h === 'first' || h === 'firstname' || h === 'given name');
        const ni = hdr.findIndex(h => h === 'name' || h === 'camper name' || h === 'camper' || h === 'full name');
        const divi = hdr.findIndex(h => h === 'division' || h === 'div');
        const gri = hdr.findIndex(h => h === 'grade');
        const bki = hdr.findIndex(h => h === 'bunk' || h === 'cabin');
        let si = hdr.findIndex(h => h === 'address' || h.includes('street') || h === 'street address');
        const ci = hdr.findIndex(h => h === 'city' || h === 'city/town' || h === 'town');
        const sti = hdr.findIndex(h => h === 'state');
        const zi = hdr.findIndex(h => h === 'zip' || h === 'zip code' || h === 'zipcode' || h.includes('zip'));
        const tri = hdr.findIndex(h => h === 'transport' || h === 'mode' || h.includes('pickup') || h.includes('carpool'));
        const rwi = hdr.findIndex(h => h === 'ride-with' || h === 'ridewith' || h === 'ride with' || h.includes('pair'));
        const roi = hdr.findIndex(h => h === 'role' || h === 'type' || h === 'person type');
        const nsi = hdr.findIndex(h => h === 'needs stop' || h === 'needsstop' || h === 'needs_stop' || h === 'stop');
        const arri = hdr.findIndex(h => h === 'arrival' || h === 'arr' || h === 'morning');
        const disi = hdr.findIndex(h => h === 'dismissal' || h === 'dis' || h === 'dismiss' || h === 'afternoon');

        // Auto-detect address column: if no known header matched, scan up to
        // the first 5 data rows for a value that looks like a street address
        // (starts with a number followed by letters, e.g. "1 Wood Ave").
        // Checks multiple rows in case the first row has an empty address.
        if (si < 0) {
            const addrPattern = /^\d+\s+[A-Za-z]/;  // "123 Main St" pattern
            const claimed = new Set([idi, lni, fni, ni, divi, gri, bki, ci, sti, zi, tri, rwi, roi, nsi, arri, disi].filter(x => x >= 0));
            var scanLimit = Math.min(lines.length, 6); // header + up to 5 rows
            for (let row = 1; row < scanLimit && si < 0; row++) {
                var sampleCols = parseLine(lines[row]);
                for (let c = 0; c < sampleCols.length; c++) {
                    if (claimed.has(c)) continue;
                    if (addrPattern.test(sampleCols[c].trim())) { si = c; console.log('[Go] Auto-detected address column: index ' + c + ' ("' + hdr[c] + '") from row ' + row + ' value "' + sampleCols[c].trim() + '"'); break; }
                }
            }
        }

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
        // Clear staff imported from CSV (keep manually added ones)
        D.counselors = D.counselors.filter(c => !c._fromCsv);
        D.monitors = D.monitors.filter(m => !m._fromCsv);
        let camperCount = 0, staffCount = 0;

        for (let i = 1; i < lines.length; i++) {
            const cols = parseLine(lines[i]);

            // Build full name
            let firstName = '', lastName = '', name = '';
            if (hasFirstLast) {
                firstName = (cols[fni] || '').trim();
                lastName = (cols[lni] || '').trim();
                if (!firstName && !lastName) continue;
                name = firstName + (lastName ? ' ' + lastName : '');
            } else {
                name = (cols[ni] || '').trim();
                if (!name) continue;
                // Try to split "First Last" for staff records
                const parts = name.split(/\s+/);
                if (parts.length >= 2) { firstName = parts[0]; lastName = parts.slice(1).join(' '); }
                else { firstName = name; lastName = ''; }
            }

            const street = (cols[si] || '').trim();

            const personId = idi >= 0 ? (cols[idi] || '').trim() : '';
            const division = divi >= 0 ? (cols[divi] || '').trim() : '';
            const grade = gri >= 0 ? (cols[gri] || '').trim() : '';
            const bunk = bki >= 0 ? (cols[bki] || '').trim() : '';
            const transport = tri >= 0 ? (cols[tri] || '').trim().toLowerCase() : 'bus';
            const rideWith = rwi >= 0 ? (cols[rwi] || '').trim() : '';
            const role = roi >= 0 ? (cols[roi] || '').trim().toLowerCase() : 'camper';
            const needsStop = nsi >= 0 ? (cols[nsi] || '').trim().toLowerCase() : '';
            const arrVal = arri >= 0 ? (cols[arri] || '').trim().toLowerCase() : '';
            const disVal = disi >= 0 ? (cols[disi] || '').trim().toLowerCase() : '';
            const forArrival = arrVal === 'n' || arrVal === 'no' || arrVal === 'false' ? false : true;
            const forDismissal = disVal === 'n' || disVal === 'no' || disVal === 'false' ? false : true;

            const city = ci >= 0 ? (cols[ci] || '').trim() : '';
            const state = sti >= 0 ? (cols[sti] || '').trim().toUpperCase() : 'NY';
            let zip = zi >= 0 ? (cols[zi] || '').trim() : '';
            // Excel strips leading zeros from zip codes (08701 → 8701) — restore them
            if (zip && /^\d+$/.test(zip) && zip.length < 5) zip = zip.padStart(5, '0');
            const fullAddress = [street, city, state, zip].filter(Boolean).join(', ');

            // ── Route based on Role column (supports full names and shortcodes: C/S/M) ──
            if (role === 'staff' || role === 'counselor' || role === 's' || role === 'monitor' || role === 'm') {
                // Add as staff member (counselor by default, monitor if specified)
                const isMonitor = role === 'monitor' || role === 'm';
                // If no "Needs Stop" column exists (nsi < 0), default to yes for
                // counselors with addresses — they're in the CSV to get picked up.
                // Only default to no if the column exists and is explicitly empty/no.
                const wantsStop = nsi < 0 ? !!street : (needsStop === 'yes' || needsStop === 'y' || needsStop === 'true');

                if (isMonitor) {
                    D.monitors.push({
                        id: uid(), name, firstName, lastName,
                        address: fullAddress, phone: '',
                        assignedBus: '', _fromCsv: true,
                        _personId: personId ? parseInt(personId) : 0
                    });
                } else {
                    D.counselors.push({
                        id: uid(), name, firstName, lastName,
                        address: fullAddress, bunk: bunk || division,
                        needsStop: wantsStop ? 'yes' : 'no',
                        assignedBus: '', assignMode: wantsStop ? 'stop' : 'auto',
                        _fromCsv: true,
                        _personId: personId ? parseInt(personId) : 0
                    });
                }

                // All staff get an address entry so they're geocoded with campers
                if (street) {
                    D.addresses[name] = {
                        street, city, state, zip,
                        lat: null, lng: null, geocoded: false,
                        transport: 'bus', rideWith: '',
                        _camperId: personId ? parseInt(personId) : 0,
                        _division: division, _grade: '', _bunk: bunk,
                        _isStaff: true,
                        _arrival: forArrival, _dismissal: forDismissal
                    };
                }

                staffCount++;
                console.log('[Go] CSV: ' + name + ' → ' + (isMonitor ? 'monitor' : 'counselor') + (wantsStop ? ' (needs stop)' : ''));
            } else {
                // Default: treat as camper
                // ★ Starter plan: stop adding once cap reached
                if (camperCount >= _goMaxImport) { _goCapped++; continue; }

                const meRoster = readCampistrySettings()?.app1?.camperRoster || {};
                const rn = Object.keys(meRoster).find(k => k.toLowerCase() === name.toLowerCase()) || name;

                if (street) {
                    D.addresses[rn] = {
                        street, city, state, zip,
                        lat: null, lng: null, geocoded: false,
                        transport: (transport === 'pickup' || transport === 'carpool') ? 'pickup' : 'bus',
                        rideWith: rideWith,
                        _camperId: personId ? parseInt(personId) : 0,
                        _division: division, _grade: grade, _bunk: bunk,
                        _arrival: forArrival, _dismissal: forDismissal
                    };
                }

                _goStandaloneRoster[rn] = {
                    camperId: personId ? parseInt(personId) : i,
                    division: division, grade: grade, bunk: bunk
                };

                camperCount++;
            }
        }
        save(); renderAddresses(); renderStaff(); updateStats();
        // ★ Update starter banner camper count
        if (window.refreshStarterBanner) window.refreshStarterBanner(camperCount);
        const total = camperCount + staffCount;
        if (_goCapped > 0) {
            toast(camperCount + ' imported, ' + _goCapped + ' skipped (plan limit)' + (staffCount > 0 ? ', ' + staffCount + ' staff' : ''));
        } else if (staffCount > 0) {
            toast(camperCount + ' campers + ' + staffCount + ' staff imported (' + total + ' total)');
            console.log('[Go] CSV import: ' + camperCount + ' campers, ' + staffCount + ' staff');
        } else {
            toast(camperCount + ' addresses imported');
        }
    }
    function parseLine(line) { const r = []; let cur = '', inQ = false; for (let i = 0; i < line.length; i++) { const ch = line[i]; if (inQ) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += ch; } else { if (ch === '"') inQ = true; else if (ch === ',' || ch === '\t') { r.push(cur); cur = ''; } else cur += ch; } } r.push(cur); return r; }
    function updateStats() {
        const roster = getRoster();
        const modeKey = D.activeMode === 'arrival' ? '_arrival' : '_dismissal';
        // Count only campers active in current mode
        const modeNames = new Set();
        Object.keys(roster).forEach(n => {
            const a = D.addresses[n];
            if (!a || a[modeKey] !== false) modeNames.add(n);
        });
        Object.keys(D.addresses).forEach(n => {
            const a = D.addresses[n];
            if (a[modeKey] !== false) modeNames.add(n);
        });
        const c = modeNames.size;
        let wA = 0;
        modeNames.forEach(n => { if (D.addresses[n]?.street) wA++; });
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
        const modeKey = D.activeMode === 'arrival' ? '_arrival' : '_dismissal';
        Object.keys(roster).forEach(name => { const a = D.addresses[name]; if (!a?.geocoded || !a.lat || !a.lng) return; if (a.transport === 'pickup') return; if (a[modeKey] === false) return; const zip = (a.zip || '').trim(); if (!zip) return; if (!zipGroups[zip]) zipGroups[zip] = { campers: [], cities: {} }; zipGroups[zip].campers.push({ name, lat: a.lat, lng: a.lng, city: a.city || '', division: roster[name].division || '' }); const city = a.city || 'Unknown'; zipGroups[zip].cities[city] = (zipGroups[zip].cities[city] || 0) + 1; });
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
        if (!body) return; // Region preview card was removed — skip rendering
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
                regions.filter(r => (remaining[r.id] || 0) > 0).forEach(reg => { while ((remaining[reg.id] || 0) > 0 && unassigned.length > 0) { let bestIdx = 0, bestDist = Infinity; unassigned.forEach((v, i) => { const prevReg = prevAssign[v.busId]; const prevRegObj = prevReg ? regions.find(r => r.id === prevReg) : null; const d = prevRegObj ? drivingDist(prevRegObj.centroidLat, prevRegObj.centroidLng, reg.centroidLat, reg.centroidLng) : Infinity; if (d < bestDist) { bestDist = d; bestIdx = i; } }); const v = unassigned.splice(bestIdx, 1)[0]; assignments[sh.id][reg.id].push(v.busId); currAssign[v.busId] = reg.id; remaining[reg.id]--; } });
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

        // Gather all geocoded, bus-riding campers (filtered by active mode)
        const modeKey = D.activeMode === 'arrival' ? '_arrival' : '_dismissal';
        Object.keys(roster).forEach(name => {
            const a = D.addresses[name];
            if (!a?.geocoded || !a.lat || !a.lng) return;
            if (a.transport === 'pickup') return;
            if (a[modeKey] === false) return;
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

        // Delegate to top-level fetchLargeMatrixBatched (Mapbox → OSRM → haversine)
        async function fetchLargeMatrix(coords) {
            return await fetchLargeMatrixBatched(coords);
        }

        // k-medoids with driving-time matrix
        function kMedoids(atoms, durMatrix, k, useDriveTime) {
            const n = atoms.length;
            if (n <= k) return atoms.map((_, i) => [i]);

            // dist helper
            function dist(i, j) {
                if (useDriveTime && durMatrix?.[i]?.[j] != null && durMatrix[i][j] >= 0) return durMatrix[i][j];
                return drivingDist(atoms[i].lat, atoms[i].lng, atoms[j].lat, atoms[j].lng);
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
                    id: 'zone_' + (reg.zip || reg.id) + '_' + ci,
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
                id: 'zone_' + (reg.zip || reg.id),
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
        // Use hard bus cap (not targetFill) — we must fit in a single bus
        const MAX_ABSORB_MI = 3.0; // max distance for absorbing/moving kids between zones
        const hardCap = Math.max(...effectiveCaps);
        for (let pass = 0; pass < 50; pass++) {
            let anyOver = false;
            for (const zone of zones) {
                if (zone.camperNames.length <= hardCap) continue;
                anyOver = true;

                // Rank campers by distance to zone centroid, farthest first
                const campersWithDist = zone.camperNames.map(name => {
                    const c = allCampers.find(x => x.name === name);
                    if (!c) return { name, dist: 0 };
                    return { name, dist: drivingDist(c.lat, c.lng, zone.centroidLat, zone.centroidLng) };
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

                    // Find nearest under-capacity zone within reasonable distance
                    // Don't move kids to a zone more than 3mi away — that stretches routes
                    let bestZone = null, bestDist = Infinity;
                    for (const tz of zones) {
                        if (tz === zone) continue;
                        if (tz.camperNames.length + atomNames.length > hardCap) continue;
                        const d = candCamper ? drivingDistMi(candCamper.lat, candCamper.lng, tz.centroidLat, tz.centroidLng) : Infinity;
                        if (d > MAX_ABSORB_MI) continue; // don't stretch zones across distant areas
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

        // ── E. Absorb small ZIPs — with max distance cap ──
        // Without a distance cap, small ZIPs get absorbed into distant zones
        // just because they have room, creating stretched routes across ZIP codes.

        // Sort small ZIPs by size descending — absorb larger ones first so they
        // get priority on nearby zones with room
        const sortedSmallZips = [...smallZips].sort((a, b) => b.camperNames.length - a.camperNames.length);

        const unabsorbed = []; // small ZIPs that couldn't be absorbed within distance cap

        for (const smallReg of sortedSmallZips) {
            const regCampers = allCampers.filter(c => smallReg.camperNames.includes(c.name));
            if (!regCampers.length) continue;

            const centLat = regCampers.reduce((s, c) => s + c.lat, 0) / regCampers.length;
            const centLng = regCampers.reduce((s, c) => s + c.lng, 0) / regCampers.length;

            // Try at 90%, 95%, 100% fill — but enforce max distance
            let absorbed = false;
            for (const tryPct of [targetFillPct, 0.95, 1.0]) {
                const tryFill = Math.floor(avgEffCap * tryPct);
                let bestZone = null, bestDist = Infinity;
                for (const z of zones) {
                    if (z.camperNames.length + smallReg.camperNames.length > tryFill) continue;
                    const d = drivingDistMi(centLat, centLng, z.centroidLat, z.centroidLng);
                    if (d > MAX_ABSORB_MI) continue; // too far — don't stretch the zone
                    if (d < bestDist) { bestDist = d; bestZone = z; }
                }
                if (bestZone) {
                    const oldName = bestZone.name;
                    bestZone.camperNames.push(...smallReg.camperNames);
                    bestZone.regionIds.push(smallReg.id);
                    const allInZone = allCampers.filter(c => bestZone.camperNames.includes(c.name));
                    if (allInZone.length) {
                        bestZone.centroidLat = allInZone.reduce((s, c) => s + c.lat, 0) / allInZone.length;
                        bestZone.centroidLng = allInZone.reduce((s, c) => s + c.lng, 0) / allInZone.length;
                    }
                    const parts = oldName.split(' + ');
                    const smallCity = smallReg.name.split(' (')[0];
                    if (parts.length >= 2) {
                        bestZone.name = parts[0] + ' + ' + parts[1].split(' +')[0] + ' + others';
                    } else {
                        bestZone.name = oldName.split(' (')[0] + ' + ' + smallCity;
                    }
                    console.log('[Go] Zone: Absorbed ' + smallReg.name + ' (' + smallReg.camperNames.length + ' kids) into ' + oldName + ' → "' + bestZone.name + '" (' + bestZone.camperNames.length + ' kids, ' + bestDist.toFixed(2) + 'mi away)');
                    console.log('[Go] Zone:   Parts: ' + bestZone.regionIds.map(id => regions.find(r => r.id === id)?.name || id).join(', '));
                    absorbed = true;
                    break;
                }
            }
            if (!absorbed) {
                unabsorbed.push(smallReg);
            }
        }

        // Small ZIPs that were too far to absorb → make their own zones
        // Better a small dedicated zone than a stretched multi-ZIP monster
        for (const smallReg of unabsorbed) {
            const regCampers = allCampers.filter(c => smallReg.camperNames.includes(c.name));
            if (!regCampers.length) continue;
            zones.push({
                id: 'zone_' + (smallReg.zip || smallReg.id),
                name: smallReg.name,
                camperNames: [...smallReg.camperNames],
                centroidLat: smallReg.centroidLat,
                centroidLng: smallReg.centroidLng,
                regionIds: [smallReg.id],
                sourceType: 'small-standalone',
                color: REGION_COLORS[zones.length % REGION_COLORS.length]
            });
            console.log('[Go] Zone: ' + smallReg.name + ' (' + smallReg.camperNames.length + ' kids) → standalone zone (no nearby zone within ' + MAX_ABSORB_MI + 'mi had room)');
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
        // Check capacity — warn but don't fail (downstream capacity enforcement handles overflow)
        const maxBusCap = Math.max(...effectiveCaps);
        let overCapCount = 0;
        zones.forEach(z => {
            if (z.camperNames.length > maxBusCap) {
                console.warn('[Go] Zone WARNING: ' + z.name + ' has ' + z.camperNames.length + ' kids but max bus cap is ' + maxBusCap + ' — capacity enforcement will handle overflow');
                overCapCount++;
            }
        });
        if (overCapCount > 0) {
            console.log('[Go] Zone: ' + overCapCount + ' zone(s) slightly over capacity — route generation will rebalance');
        }

        if (invariantFail) {
            console.error('[Go] Zone: invariant check FAILED (missing/duplicate campers) — falling back to raw ZIP regions');
            toast('Zone optimization failed — using raw regions', 'error');
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
    // GREEDY ZONE BUILDER — Stops-first, then bus-aware zones
    //
    // Algorithm:
    //   1. All stops are already created (globally, not per-zone)
    //   2. Sort buses by capacity (biggest first)
    //   3. Pick the farthest unassigned stop from camp as seed
    //   4. Greedily grab the nearest unassigned stop — but ONLY if
    //      its kid count fits in the remaining capacity. If the
    //      nearest stop has too many kids, STOP (don't skip it).
    //   5. Move to the next bus and repeat from step 3
    //   6. Any leftover stops go to the bus with most remaining capacity
    // =========================================================================
    function buildGreedyZones(stops, buses, campLat, campLng, reserveSeats) {
        if (!stops.length || !buses.length) return [];

        const numBuses = buses.length;
        const numStops = stops.length;

        // Effective capacity per bus
        const busCaps = buses.map(b => {
            const mon = D.monitors.find(m => m.assignedBus === b.id);
            const couns = D.counselors.filter(c => c.assignedBus === b.id);
            const brs = b.reserveMode === 'custom' && b.reserveSeats != null ? b.reserveSeats : (reserveSeats || 0);
            return Math.max(0, (b.capacity || 0) - (mon ? 1 : 0) - couns.length - brs);
        });

        const totalKids = stops.reduce((s, st) => s + st.campers.length, 0);
        const kidCount = stops.map(s => s.campers.length);

        console.log('[Go] Zone builder: ' + totalKids + ' kids, ' + numBuses + ' buses, ' + numStops + ' stops');

        // =====================================================================
        // K-MEDOIDS CLUSTERING — produces compact geographic zones
        //
        // 1. Seed medoids using farthest-point initialization
        // 2. Assign each stop to nearest medoid (by driving distance)
        // 3. Recompute medoids (member that minimizes total intra-cluster dist)
        // 4. Iterate until stable
        // 5. Capacity rebalance: move border stops between clusters if over-cap
        // =====================================================================

        // ── Step 1: Seed medoids ──
        // Pick k=numBuses initial medoids spread maximally apart
        const medoids = [];

        // First medoid: farthest stop from camp
        let firstMed = 0, firstDist = 0;
        for (let i = 0; i < numStops; i++) {
            const d = drivingDist(campLat, campLng, stops[i].lat, stops[i].lng);
            if (d > firstDist) { firstDist = d; firstMed = i; }
        }
        medoids.push(firstMed);

        // Remaining medoids: farthest from all existing medoids (greedy dispersion)
        while (medoids.length < numBuses && medoids.length < numStops) {
            let bestIdx = -1, bestMinDist = -1;
            for (let i = 0; i < numStops; i++) {
                if (medoids.includes(i)) continue;
                let minDist = Infinity;
                for (const m of medoids) {
                    const d = drivingDist(stops[i].lat, stops[i].lng, stops[m].lat, stops[m].lng);
                    if (d < minDist) minDist = d;
                }
                if (minDist > bestMinDist) { bestMinDist = minDist; bestIdx = i; }
            }
            if (bestIdx < 0) break;
            medoids.push(bestIdx);
        }

        console.log('[Go] Zone: seeded ' + medoids.length + ' medoids');

        // ── Step 2-4: Iterative assignment + medoid update ──
        let assignments = new Array(numStops).fill(0);

        function assignAll() {
            for (let i = 0; i < numStops; i++) {
                let bestCluster = 0, bestDist = Infinity;
                for (let m = 0; m < medoids.length; m++) {
                    const d = drivingDist(stops[i].lat, stops[i].lng, stops[medoids[m]].lat, stops[medoids[m]].lng);
                    if (d < bestDist) { bestDist = d; bestCluster = m; }
                }
                assignments[i] = bestCluster;
            }
        }

        assignAll();

        for (let iter = 0; iter < 30; iter++) {
            let changed = false;

            // Recompute each medoid: pick cluster member minimizing total dist to others
            for (let m = 0; m < medoids.length; m++) {
                const members = [];
                for (let i = 0; i < numStops; i++) { if (assignments[i] === m) members.push(i); }
                if (!members.length) continue;

                let bestMed = medoids[m], bestTotal = Infinity;
                for (const cand of members) {
                    let total = 0;
                    for (const other of members) {
                        if (other !== cand) total += drivingDist(stops[cand].lat, stops[cand].lng, stops[other].lat, stops[other].lng);
                    }
                    if (total < bestTotal) { bestTotal = total; bestMed = cand; }
                }
                if (bestMed !== medoids[m]) { medoids[m] = bestMed; changed = true; }
            }

            if (!changed) break;

            const oldAssign = [...assignments];
            assignAll();
            if (oldAssign.every((a, i) => a === assignments[i])) break;
        }

        // ── Step 5: Build zones + capacity rebalance ──
        // Sort buses by capacity descending, assign biggest bus to biggest cluster
        const clusterSizes = new Array(numBuses).fill(0);
        for (let i = 0; i < numStops; i++) clusterSizes[assignments[i]] += kidCount[i];

        const clusterOrder = clusterSizes.map((sz, i) => ({ i, sz })).sort((a, b) => b.sz - a.sz);
        const busOrder = busCaps.map((cap, i) => ({ i, cap })).sort((a, b) => b.cap - a.cap);

        // Map: cluster index → bus index
        const clusterToBus = {};
        for (let r = 0; r < Math.min(clusterOrder.length, busOrder.length); r++) {
            clusterToBus[clusterOrder[r].i] = busOrder[r].i;
        }

        // Build initial zones
        const zones = [];
        for (let m = 0; m < medoids.length; m++) {
            const bi = clusterToBus[m] ?? m;
            const stopIndices = [];
            for (let i = 0; i < numStops; i++) { if (assignments[i] === m) stopIndices.push(i); }

            const zoneKids = stopIndices.reduce((s, si) => s + kidCount[si], 0);
            const cLat = stopIndices.length ? stopIndices.reduce((s, si) => s + stops[si].lat, 0) / stopIndices.length : campLat;
            const cLng = stopIndices.length ? stopIndices.reduce((s, si) => s + stops[si].lng, 0) / stopIndices.length : campLng;

            zones.push({
                busIdx: bi, busId: buses[bi].id, busName: buses[bi].name,
                busColor: buses[bi].color, stopIndices, camperCount: zoneKids,
                capacity: busCaps[bi], centroidLat: cLat, centroidLng: cLng,
                _medoid: medoids[m]
            });
        }

        // ── Capacity rebalance: move border stops from over-cap zones to nearest under-cap zone ──
        for (let pass = 0; pass < 200; pass++) {
            // Find most over-capacity zone
            let worstZi = -1, worstOver = 0;
            for (let zi = 0; zi < zones.length; zi++) {
                const over = zones[zi].camperCount - zones[zi].capacity;
                if (over > worstOver) { worstOver = over; worstZi = zi; }
            }
            if (worstZi < 0) break; // all zones within capacity

            const overZone = zones[worstZi];

            // Find the border stop: farthest from own medoid AND closest to another zone's medoid
            let bestStopLocalIdx = -1, bestTargetZi = -1, bestScore = -Infinity;
            for (let li = 0; li < overZone.stopIndices.length; li++) {
                const si = overZone.stopIndices[li];
                const distFromOwn = drivingDist(stops[si].lat, stops[si].lng,
                    stops[overZone._medoid].lat, stops[overZone._medoid].lng);

                for (let tzi = 0; tzi < zones.length; tzi++) {
                    if (tzi === worstZi) continue;
                    if (zones[tzi].camperCount + kidCount[si] > zones[tzi].capacity) continue;
                    const distToTarget = drivingDist(stops[si].lat, stops[si].lng,
                        stops[zones[tzi]._medoid].lat, stops[zones[tzi]._medoid].lng);
                    // Score: high = far from own, close to target (true border stop)
                    const score = distFromOwn - distToTarget;
                    if (score > bestScore) { bestScore = score; bestStopLocalIdx = li; bestTargetZi = tzi; }
                }
            }

            if (bestStopLocalIdx < 0 || bestTargetZi < 0) break; // no valid move

            // Move the stop
            const movedSi = overZone.stopIndices.splice(bestStopLocalIdx, 1)[0];
            overZone.camperCount -= kidCount[movedSi];
            zones[bestTargetZi].stopIndices.push(movedSi);
            zones[bestTargetZi].camperCount += kidCount[movedSi];
        }

        // Log summary
        console.log('[Go] Zones: ' + zones.length + ' compact clusters, ' + totalKids + ' kids across ' + numStops + ' stops');
        zones.forEach(z => {
            console.log('[Go]   ' + z.busName + ': ' + z.camperCount + '/' + z.capacity + ' kids, ' + z.stopIndices.length + ' stops');
        });

        return zones;
    }

    // =========================================================================
    // ROUTING ENGINE v11.0 — Stops-first + Greedy zones + GH/VROOM
    // =========================================================================

    async function generateRoutes() {
        // Clear caches on each generation
        _intersectionCache = null;
        _drivingCache.clear();
        _ghQuotaExhausted = false;

        const roster = getRoster();
        const reserveSeats = parseInt(document.getElementById('routeReserveSeats')?.value) || 0;
        const avgStopMin = D.setup.avgStopTime || 2;
        const avgSpeedMph = D.setup.avgSpeed || 25;

        // Validate we have buses and geocoded campers
        if (!D.buses.length) { toast('Add buses first', 'error'); return; }

        let hasGeocodedCampers = false;
        Object.keys(roster).forEach(name => {
            const a = D.addresses[name];
            if (a?.geocoded && a.lat && a.lng && a.transport !== 'pickup') hasGeocodedCampers = true;
        });
        if (!hasGeocodedCampers) { toast('No geocoded campers — geocode addresses first', 'error'); return; }

        const vehicles = D.buses.map(b => {
            const mon = D.monitors.find(m => m.assignedBus === b.id);
            const couns = D.counselors.filter(c => c.assignedBus === b.id);
            const brs = getBusReserve(b);
            return { busId: b.id, name: b.name, color: b.color || '#10b981', capacity: Math.max(0, (b.capacity || 0) - (mon ? 1 : 0) - couns.length - brs), monitor: mon, counselors: couns };
        });

        _routeProgStart = Date.now();
        let campCoords = null;
        if (D.setup.campAddress) {
            showProgress('Geocoding camp...', 5);
            campCoords = _campCoordsCache || await geocodeSingle(D.setup.campAddress);
            if (campCoords) { _campCoordsCache = campCoords; D.setup.campLat = campCoords.lat; D.setup.campLng = campCoords.lng; }
        }
        if (!campCoords && D.setup.campLat && D.setup.campLng) {
            campCoords = { lat: D.setup.campLat, lng: D.setup.campLng };
            _campCoordsCache = campCoords;
        }
        if (!campCoords) { toast('Set camp address first', 'error'); return; }
        const campLat = campCoords.lat;
        const campLng = campCoords.lng;

        // ── Pre-warm driving distance cache ──
        showProgress('Building driving distance cache...', 7);
        const allCamperCoords = [];
        Object.keys(roster).forEach(name => {
            const a = D.addresses[name];
            if (a?.geocoded && a.lat && a.lng && a.transport !== 'pickup') {
                allCamperCoords.push({ lat: a.lat, lng: a.lng });
            }
        });
        await prewarmCache(allCamperCoords, campLat, campLng);

        // =========================================================
        // NEW PIPELINE: Stops first → Greedy zones → Route each zone
        // =========================================================

        const allShiftResults = [];
        const shifts = D.shifts.length ? D.shifts : [{ id: '__all__', label: 'All Campers', divisions: [], departureTime: D.activeMode === 'arrival' ? '07:00' : '16:00', _isVirtual: true }];

        for (let si = 0; si < shifts.length; si++) {
            const shift = shifts[si];
            const pctPerShift = 100 / shifts.length;
            const pctBase = si * pctPerShift;

            // Auto-clean orphaned bus IDs: if buses were recreated, shift may reference old IDs
            let shiftBusIds = shift.assignedBuses?.length ? shift.assignedBuses : vehicles.map(v => v.busId);
            if (shift.assignedBuses?.length) {
                const validIds = shiftBusIds.filter(bid => vehicles.some(v => v.busId === bid));
                if (validIds.length < shiftBusIds.length) {
                    console.warn('[Go] Shift "' + (shift.label || shift.id) + '": ' + (shiftBusIds.length - validIds.length) + ' assigned buses no longer exist — using all buses');
                    shift.assignedBuses = [];  // clear stale refs
                    shiftBusIds = vehicles.map(v => v.busId);
                    save();
                }
            }
            const shiftVehicles = shiftBusIds.map(bid => vehicles.find(v => v.busId === bid)).filter(Boolean);
            const shiftBuses = shiftBusIds.map(bid => D.buses.find(b => b.id === bid)).filter(Boolean);

            // ── Step 1: Gather all campers for this shift ──
            const allCampers = [];
            Object.keys(roster).forEach(name => {
                const c = roster[name]; const a = D.addresses[name];
                if (!c || !a?.geocoded || !a.lat || !a.lng) return;
                if (a.transport === 'pickup') return;
                // Filter by arrival/dismissal mode flag
                const modeKey = D.activeMode === 'arrival' ? '_arrival' : '_dismissal';
                if (a[modeKey] === false) return;
                if (shift._isVirtual || camperMatchesShift(c, shift)) {
                    allCampers.push({ name, division: c.division, bunk: c.bunk || '', lat: a.lat, lng: a.lng, address: [a.street, a.city, a.state, a.zip].filter(Boolean).join(', ') });
                }
            });

            // ── Step 1b: Geocode staff + inject "needs stop" staff as campers ──
            // Staff with needsStop='yes' are treated identically to campers for
            // stop creation — they get included in clustering and assigned a stop.
            // Staff with needsStop='no' (or monitors) are handled post-generation.
            const noStopStaff = []; // [{name, address, lat, lng, busId, role}] — suggested after routes
            const staffWithStops = []; // names injected as campers

            for (const counselor of D.counselors) {
                if (!counselor.address) continue;
                let staffCoords = null;
                // Check cached coords first
                if (counselor._lat && counselor._lng) {
                    staffCoords = { lat: counselor._lat, lng: counselor._lng };
                }
                // Check if this staff member has a geocoded address in D.addresses
                if (!staffCoords) {
                    const staffAddr = D.addresses[counselor.name] || D.addresses[counselor.firstName + ' ' + counselor.lastName];
                    if (staffAddr?.geocoded && staffAddr.lat && staffAddr.lng) {
                        staffCoords = { lat: staffAddr.lat, lng: staffAddr.lng };
                        counselor._lat = staffAddr.lat; counselor._lng = staffAddr.lng;
                    }
                }
                // Skip if no coords found (already geocoded by auto-geocode step above)
                if (!staffCoords) continue;

                if (counselor.needsStop === 'yes') {
                    // Inject as camper — will get a stop like any kid
                    allCampers.push({
                        name: '⚐ ' + counselor.name, division: counselor.bunk || 'Staff',
                        bunk: 'Staff', lat: staffCoords.lat, lng: staffCoords.lng,
                        address: counselor.address, _isStaff: true, _staffId: counselor.id
                    });
                    staffWithStops.push(counselor.name);
                } else {
                    // No stop — will suggest closest stop post-generation
                    noStopStaff.push({
                        name: counselor.name, address: counselor.address,
                        lat: staffCoords.lat, lng: staffCoords.lng,
                        busId: counselor.assignedBus || null, role: 'counselor', id: counselor.id
                    });
                }
            }

            for (const monitor of D.monitors) {
                if (!monitor.address) continue;
                let staffCoords = null;
                if (monitor._lat && monitor._lng) {
                    staffCoords = { lat: monitor._lat, lng: monitor._lng };
                }
                if (!staffCoords) {
                    const staffAddr = D.addresses[monitor.name] || D.addresses[monitor.firstName + ' ' + monitor.lastName];
                    if (staffAddr?.geocoded && staffAddr.lat && staffAddr.lng) {
                        staffCoords = { lat: staffAddr.lat, lng: staffAddr.lng };
                        monitor._lat = staffAddr.lat; monitor._lng = staffAddr.lng;
                    }
                }
                if (!staffCoords) continue;

                // Monitors are always "no stop" — they ride the bus
                noStopStaff.push({
                    name: monitor.name, address: monitor.address,
                    lat: staffCoords.lat, lng: staffCoords.lng,
                    busId: monitor.assignedBus || null, role: 'monitor', id: monitor.id
                });
            }

            if (staffWithStops.length) console.log('[Go] Staff with stops: ' + staffWithStops.join(', '));
            if (noStopStaff.length) console.log('[Go] Staff without stops (will suggest): ' + noStopStaff.map(s => s.name).join(', '));

            if (!allCampers.length || !shiftVehicles.length) {
                if (!allCampers.length) console.error('[Go] Shift "' + (shift.label || shift.id) + '": 0 campers matched — skipping');
                if (!shiftVehicles.length) console.error('[Go] Shift "' + (shift.label || shift.id) + '": 0 vehicles available — skipping');
                allShiftResults.push({ shift, routes: [], camperCount: 0 });
                continue;
            }

            // ── Step 2: Create ALL stops globally (not per-zone) ──
            // This includes "needs stop" staff who were injected as campers above
            showProgress((shift.label || 'Shift ' + (si + 1)) + ': creating stops...', pctBase + 10);
            const mode = document.getElementById('routeMode')?.value || 'door-to-door';
            let allStops;
            if (mode === 'optimized-stops') allStops = createOptimizedStops(allCampers);
            else if (mode === 'corner-stops') allStops = await createCornerStops(allCampers);
            else allStops = createHouseStops(allCampers);

            console.log('[Go] Step 2: ' + allStops.length + ' stops from ' + allCampers.length + ' campers (mode: ' + mode + ')');

            // ── Step 3: Build greedy bus-aware zones from stops ──
            showProgress((shift.label || 'Shift ' + (si + 1)) + ': building zones...', pctBase + 30);
            const greedyZones = buildGreedyZones(allStops, shiftBuses, campLat, campLng, reserveSeats);
            toast(greedyZones.length + ' bus zones created — optimizing routes...');

            // ── Step 4: Route each zone (GH → VROOM → local TSP) ──
            showProgress((shift.label || 'Shift ' + (si + 1)) + ': optimizing routes...', pctBase + 50);
            const isArrival = D.activeMode === 'arrival';
            const hasShifts = shifts.length > 1;
            const isLastShift = si === shifts.length - 1;
            const serviceTime = (D.setup.avgStopTime || 2) * 60;
            const key = getApiKey();

            let routes = [];
            const totalZones = greedyZones.length;
            for (let zi = 0; zi < greedyZones.length; zi++) {
                const zone = greedyZones[zi];
                const zoneStops = zone.stopIndices.map(si => allStops[si]);
                const v = shiftVehicles.find(sv => sv.busId === zone.busId) || shiftVehicles[0];
                if (!zoneStops.length || !v) continue;
                const busProgress = pctBase + 50 + Math.round((zi / totalZones) * (pctPerShift - 55));
                showProgress((shift.label || 'Shift ' + (si + 1)) + ': optimizing routes...', busProgress, 'Bus ' + (zi + 1) + ' of ' + totalZones + ' — ' + v.name + ' (' + zoneStops.length + ' stops)', zi, totalZones);

                // Find farthest stop from camp (used for start/end anchoring)
                let fIdx = 0, fDist = 0;
                zoneStops.forEach((s, i) => { const d = drivingDist(campLat, campLng, s.lat, s.lng); if (d > fDist) { fDist = d; fIdx = i; } });

                // ── Route optimization: VROOM → directional sort ──
                let orderedStops = null;

                // 1. ORS VROOM (primary solver)
                if (!orderedStops && key) {
                    const jobs = zoneStops.map((stop, i) => ({
                        id: i + 1, location: [stop.lng, stop.lat],
                        service: serviceTime, amount: [stop.campers.length], description: stop.address
                    }));
                    const veh = { id: 1, profile: 'driving-car', capacity: [v.capacity], description: v.name };
                    if (isArrival) {
                        // Arrival: start at farthest stop, end at camp
                        veh.start = [zoneStops[fIdx].lng, zoneStops[fIdx].lat];
                        veh.end = [campLng, campLat];
                    } else {
                        // Dismissal: start at camp, end at farthest stop
                        veh.start = [campLng, campLat];
                        veh.end = [zoneStops[fIdx].lng, zoneStops[fIdx].lat];
                    }
                    try {
                        const resp = await fetch('https://api.openrouteservice.org/optimization', {
                            method: 'POST',
                            headers: { 'Authorization': key, 'Content-Type': 'application/json' },
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
                                    result.unassigned.forEach(ua => { const stop = zoneStops[ua.id - 1]; if (stop) cheapestInsert(ordered, stop); });
                                }
                                orderedStops = ordered;
                                console.log('[Go] VROOM → ' + v.name + ': ' + ordered.length + ' stops');
                            }
                        }
                    } catch (e) { console.warn('[Go] VROOM failed for ' + v.name + ':', e.message); }
                }

                // 3. Last resort: directional sort
                if (!orderedStops) {
                    orderedStops = [...zoneStops];
                    directionalSort(orderedStops, campLat, campLng);
                }

                // ── 2-opt (driving distances) ──
                if (orderedStops.length >= 3) {
                    let improved = true;
                    for (let pass = 0; pass < 5 && improved; pass++) {
                        improved = false;
                        for (let i = 0; i < orderedStops.length - 2; i++) {
                            for (let j = i + 2; j < orderedStops.length; j++) {
                                const a = orderedStops[i], b = orderedStops[i + 1];
                                const c = orderedStops[j], d2 = orderedStops[j + 1] || (isArrival ? { lat: campLat, lng: campLng } : null);
                                if (!a?.lat || !b?.lat || !c?.lat) continue;
                                const curD = drivingDist(a.lat, a.lng, b.lat, b.lng) + (d2 ? drivingDist(c.lat, c.lng, d2.lat, d2.lng) : 0);
                                const newD = drivingDist(a.lat, a.lng, c.lat, c.lng) + (d2 ? drivingDist(b.lat, b.lng, d2.lat, d2.lng) : 0);
                                if (newD < curD * 0.95) {
                                    const seg = orderedStops.splice(i + 1, j - i);
                                    seg.reverse();
                                    orderedStops.splice(i + 1, 0, ...seg);
                                    improved = true;
                                }
                            }
                        }
                    }
                }

                // ── Orientation check (driving distances) ──
                if (orderedStops.length >= 2) {
                    const firstDist = drivingDist(campLat, campLng, orderedStops[0].lat, orderedStops[0].lng);
                    const lastDist = drivingDist(campLat, campLng, orderedStops[orderedStops.length - 1].lat, orderedStops[orderedStops.length - 1].lng);
                    if (isArrival && firstDist < lastDist) { orderedStops.reverse(); }
                    if (!isArrival && firstDist > lastDist) { orderedStops.reverse(); }
                }

                const routeStops = orderedStops.map((stop, i) => ({
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

            // Ensure all buses have route entries
            shiftVehicles.forEach(v => {
                if (!routes.find(r => r.busId === v.busId)) {
                    routes.push({ busId: v.busId, busName: v.name, busColor: v.color, monitor: v.monitor, counselors: v.counselors || [], stops: [], camperCount: 0, _cap: v.capacity, totalDuration: 0 });
                }
            });

            console.log('[Go] All routes complete: ' + routes.length + ' bus routes');

            // ── Staff suggestions: find closest stop for "no stop" staff ──
            // For each staff member without a dedicated stop, find the closest
            // existing stop on their assigned bus (or any bus if unassigned).
            // Store suggestion on the staff object for display in the Staff tab.
            if (noStopStaff.length) {
                console.log('[Go] Suggesting stops for ' + noStopStaff.length + ' staff...');
                noStopStaff.forEach(staff => {
                    let bestRoute = null, bestStop = null, bestDist = Infinity;

                    const candidateRoutes = staff.busId
                        ? routes.filter(r => r.busId === staff.busId)
                        : routes;

                    // If assigned bus has no routes or no stops, search all buses
                    const searchRoutes = candidateRoutes.some(r => r.stops.length > 0) ? candidateRoutes : routes;

                    for (const r of searchRoutes) {
                        for (const st of r.stops) {
                            if (!st.lat || !st.lng) continue;
                            const d = drivingDist(staff.lat, staff.lng, st.lat, st.lng);
                            if (d < bestDist) { bestDist = d; bestStop = st; bestRoute = r; }
                        }
                    }

                    if (bestRoute && bestStop) {
                        const walkFt = Math.round(manhattanMi(staff.lat, staff.lng, bestStop.lat, bestStop.lng) * 5280);
                        staff._suggestedBus = bestRoute.busName;
                        staff._suggestedBusId = bestRoute.busId;
                        staff._suggestedStop = bestStop.address;
                        staff._suggestedStopNum = bestStop.stopNum;
                        staff._walkFt = walkFt;

                        // Update the actual staff object so the UI can show it
                        const staffObj = staff.role === 'monitor'
                            ? D.monitors.find(m => m.id === staff.id)
                            : D.counselors.find(c => c.id === staff.id);
                        if (staffObj) {
                            staffObj._suggestedBus = bestRoute.busName;
                            staffObj._suggestedBusId = bestRoute.busId;
                            staffObj._suggestedStop = bestStop.address;
                            staffObj._suggestedStopNum = bestStop.stopNum;
                            staffObj._walkFt = walkFt;
                        }

                        console.log('[Go]   ' + staff.role + ' ' + staff.name + ' → ' + bestRoute.busName + ', Stop ' + bestStop.stopNum + ' (' + bestStop.address + ') — ' + walkFt + 'ft walk');
                    }
                });
            }

            // Calculate ETAs
            const shiftNeedsReturn = hasShifts && !isLastShift;
            const timeMin = parseTime(shift.departureTime || (isArrival ? '08:00' : '16:00'));

            // Fetch traffic-aware leg durations for all routes in this shift
            // trafficCache[busId] = [leg0_sec, leg1_sec, ...] or null
            const trafficCache = {};
            if (getMapboxToken()) {
                const trafficPromises = routes.filter(r => r.stops.length > 0).map(async r => {
                    const validStops = r.stops.filter(s => s.lat && s.lng);
                    if (validStops.length > 0) {
                        trafficCache[r.busId] = await fetchTrafficLegs(validStops, campLat, campLng, timeMin, isArrival);
                        if (trafficCache[r.busId]) r._trafficSource = true;
                    }
                });
                await Promise.all(trafficPromises);
                const trafficCount = Object.values(trafficCache).filter(Boolean).length;
                if (trafficCount > 0) console.log('[Go] Traffic-aware ETAs for ' + trafficCount + '/' + routes.length + ' routes');
            }

            for (const r of routes) {
                if (!r.stops.length) continue;
                const mx = r._osrmMatrix;
                const tLegs = trafficCache[r.busId]; // traffic leg durations in seconds, or null

                // Traffic-aware drive time: uses Mapbox traffic legs when available
                // Leg indexing: leg[0] = camp→stop1 (dismissal) or stop1→stop2 (arrival)
                // For dismissal: leg[i] = stop[i-1] → stop[i], leg[0] = camp → stop[0]
                // For arrival: leg[i] = stop[i] → stop[i+1], last leg = lastStop → camp
                function driveMin(stopA, stopB) {
                    if (mx && stopA._matrixIdx != null && stopB._matrixIdx != null) {
                        const val = mx[stopA._matrixIdx]?.[stopB._matrixIdx];
                        if (val != null && val >= 0) return val / 60;
                    }
                    if (stopA.lat && stopB.lat) return drivingDist(stopA.lat, stopA.lng, stopB.lat, stopB.lng) / 60;
                    return 3;
                }
                function campToStop(stop) {
                    if (mx && stop._matrixIdx != null) {
                        const val = mx[0]?.[stop._matrixIdx];
                        if (val != null && val >= 0) return val / 60;
                    }
                    if (stop.lat && _campCoordsCache) return drivingDist(_campCoordsCache.lat, _campCoordsCache.lng, stop.lat, stop.lng) / 60;
                    return 15;
                }
                function stopToCamp(stop) {
                    if (mx && stop._matrixIdx != null) {
                        const val = mx[stop._matrixIdx]?.[0];
                        if (val != null && val >= 0) return val / 60;
                    }
                    if (stop.lat && _campCoordsCache) return drivingDist(stop.lat, stop.lng, _campCoordsCache.lat, _campCoordsCache.lng) / 60;
                    return 15;
                }

                // Use traffic legs when available, override static calculations
                function trafficLegMin(legIdx) {
                    if (tLegs && tLegs[legIdx] != null) return tLegs[legIdx] / 60; // seconds → minutes
                    return null;
                }

                if (isArrival) {
                    let totalDur = 0;
                    for (let i = 0; i < r.stops.length; i++) {
                        const tLeg = trafficLegMin(i);
                        if (i === 0) totalDur += (tLeg != null ? tLeg : campToStop(r.stops[0]));
                        else totalDur += (tLeg != null ? tLeg : driveMin(r.stops[i - 1], r.stops[i]));
                        totalDur += avgStopMin;
                    }
                    const returnLeg = trafficLegMin(r.stops.length);
                    totalDur += (returnLeg != null ? returnLeg : stopToCamp(r.stops[r.stops.length - 1]));
                    let cum = timeMin - totalDur;
                    for (let i = 0; i < r.stops.length; i++) {
                        const tLeg = trafficLegMin(i);
                        if (i === 0) cum += (tLeg != null ? tLeg : campToStop(r.stops[0]));
                        else cum += (tLeg != null ? tLeg : driveMin(r.stops[i - 1], r.stops[i]));
                        cum += avgStopMin;
                        r.stops[i].estimatedTime = formatTime(cum);
                        r.stops[i].estimatedMin = cum;
                    }
                    r.totalDuration = Math.round(totalDur);
                } else {
                    let cum = timeMin;
                    for (let i = 0; i < r.stops.length; i++) {
                        // Dismissal: leg[0] = camp→stop[0], leg[i] = stop[i-1]→stop[i]
                        const tLeg = trafficLegMin(i);
                        if (i === 0) cum += (tLeg != null ? tLeg : campToStop(r.stops[0]));
                        else cum += (tLeg != null ? tLeg : driveMin(r.stops[i - 1], r.stops[i]));
                        cum += avgStopMin;
                        r.stops[i].estimatedTime = formatTime(cum);
                        r.stops[i].estimatedMin = cum;
                    }
                    r.totalDuration = Math.round(cum - timeMin);
                    if (shiftNeedsReturn && r.stops.length > 0) {
                        const returnLeg = trafficLegMin(r.stops.length);
                        r.returnTocamp = Math.round(returnLeg != null ? returnLeg : stopToCamp(r.stops[r.stops.length - 1]));
                        r.totalDuration += r.returnTocamp;
                    }
                }
                r.camperCount = r.stops.reduce((s, st) => s + st.campers.length, 0);

                // ── Max ride time audit ──
                // No child should ride longer than maxRideTime minutes.
                // For dismissal: child at stop N rides from camp departure to stop N ETA.
                // For arrival: child at stop N rides from stop N pickup to camp arrival.
                const maxRideMin = D.setup.maxRideTime || 45;
                if (r.stops.length > 0 && r.totalDuration > 0) {
                    r.stops.forEach(st => {
                        if (!st.estimatedMin) return;
                        let rideMin;
                        if (isArrival) {
                            // Arrival: kid boards at this stop, rides until camp arrival
                            const campArrivalMin = timeMin; // camp arrival = departure time for arrival mode
                            rideMin = campArrivalMin - st.estimatedMin;
                        } else {
                            // Dismissal: kid boards at camp, rides until this stop
                            rideMin = st.estimatedMin - timeMin;
                        }
                        st._rideTimeMin = Math.round(Math.abs(rideMin));
                        if (st._rideTimeMin > maxRideMin) {
                            st._rideTimeWarning = true;
                            st.campers.forEach(c => {
                                console.warn('[Go] Ride time: ' + c.name + ' on ' + r.busName + ' stop ' + st.stopNum + ' = ' + st._rideTimeMin + 'min (max ' + maxRideMin + ')');
                            });
                        }
                    });
                    // Count violations
                    const violations = r.stops.filter(s => s._rideTimeWarning).length;
                    if (violations > 0) {
                        r._rideTimeViolations = violations;
                        console.warn('[Go] ' + r.busName + ': ' + violations + ' stop(s) exceed ' + maxRideMin + 'min max ride time');
                    }
                }

                r.stops.forEach(s => { delete s._matrixIdx; });
                delete r._osrmMatrix;
            }

            allShiftResults.push({ shift, routes, camperCount: routes.reduce((s, r) => s + r.camperCount, 0) });
        }

        _generatedRoutes = allShiftResults;
        _routeGeomCache = {}; window._routeGeomCache = _routeGeomCache;
        D.savedRoutes = allShiftResults;
        save();
        const elapsed = Math.round((Date.now() - _routeProgStart) / 1000);
        const elapsedStr = elapsed < 60 ? elapsed + 's' : Math.floor(elapsed / 60) + 'm ' + (elapsed % 60) + 's';
        const totalCampers = allShiftResults.reduce((s, sr) => s + sr.camperCount, 0);
        const totalBuses = allShiftResults.reduce((s, sr) => s + sr.routes.length, 0);
        showProgressDone('Routes Complete', totalBuses + ' buses, ' + totalCampers + ' campers — finished in ' + elapsedStr);
        setTimeout(() => { hideProgress(); renderRouteResults(applyOverrides(allShiftResults)); renderStaff(); }, 3000);
    }

    // =========================================================================
    // GRAPHHOPPER ROUTE OPTIMIZATION — primary solver
    // Sends stops + single vehicle to GH VRP endpoint.
    // Returns ordered stops array, or null on failure.
    // Free tier: 5 vehicles, 30 services per request.
    // =========================================================================
    let _ghQuotaExhausted = false; // set to true if GH returns 429/quota error

    async function solveWithGraphHopper(stops, vehicle, campLat, campLng, isArrival, needsReturn) {
        const ghKey = getGHKey();
        if (!ghKey || _ghQuotaExhausted) return null;
        if (!stops.length) return null;
        // GH free tier only allows 5 locations per VRP request — skip and fall back to VROOM for larger routes
        if (stops.length > 5) { console.log('[Go] GH: skipping — ' + stops.length + ' stops exceeds free-tier limit of 5'); return null; }

        const serviceTime = (D.setup.avgStopTime || 2) * 60;
        const MAX_GH_SERVICES = 80;

        // If >MAX stops, optimize the most spread-out, then cheapestInsert the rest
        let primaryStops = stops;
        let overflowStops = [];
        if (stops.length > MAX_GH_SERVICES) {
            const cLat = stops.reduce((s, st) => s + st.lat, 0) / stops.length;
            const cLng = stops.reduce((s, st) => s + st.lng, 0) / stops.length;
            const ranked = stops.map((st, i) => ({ st, i, d: drivingDist(cLat, cLng, st.lat, st.lng) }));
            ranked.sort((a, b) => b.d - a.d);
            const primaryIndices = new Set(ranked.slice(0, MAX_GH_SERVICES).map(r => r.i));
            primaryStops = [];
            overflowStops = [];
            stops.forEach((st, i) => {
                if (primaryIndices.has(i)) primaryStops.push(st);
                else overflowStops.push(st);
            });
            console.log('[Go] GH: ' + stops.length + ' stops, optimizing ' + primaryStops.length + ', will insert ' + overflowStops.length + ' after');
        }

        // Build GH VRP request — use the documented format exactly
        // https://docs.graphhopper.com/#tag/Route-Optimization-API
        const services = primaryStops.map((st, i) => ({
            id: 'stop_' + i,
            name: st.address || ('Stop ' + (i + 1)),
            address: { location_id: 'loc_' + i, lon: st.lng, lat: st.lat },
            size: [st.campers.length],
            duration: serviceTime
        }));

        const veh = {
            vehicle_id: vehicle.busId || 'bus_1',
            type_id: 'bus'
        };

        // Find farthest stop from camp
        let fIdx = 0, fDist = 0;
        primaryStops.forEach((s, i) => {
            const d = drivingDist(campLat, campLng, s.lat, s.lng);
            if (d > fDist) { fDist = d; fIdx = i; }
        });

        if (isArrival) {
            // Arrival: farthest first → closest last → camp
            veh.start_address = { location_id: 'farthest', lon: primaryStops[fIdx].lng, lat: primaryStops[fIdx].lat };
            veh.end_address = { location_id: 'camp', lon: campLng, lat: campLat };
        } else {
            // Dismissal: camp → closest first → farthest last
            veh.start_address = { location_id: 'camp', lon: campLng, lat: campLat };
            veh.end_address = { location_id: 'farthest', lon: primaryStops[fIdx].lng, lat: primaryStops[fIdx].lat };
        }

        const body = {
            vehicles: [veh],
            vehicle_types: [{ type_id: 'bus', capacity: [vehicle.capacity || 999] }],
            services: services
        };

        try {
            // Rate-limit guard: wait between GH calls to stay under free-tier limits
            const now = Date.now();
            const minGap = 3000; // 3s between requests (~20/min, well under free-tier cap)
            if (window._ghLastCall && now - window._ghLastCall < minGap) {
                await new Promise(r => setTimeout(r, minGap - (now - window._ghLastCall)));
            }

            // Retry with backoff for 429 (rate limit, not quota)
            let resp = null;
            for (let attempt = 0; attempt < 5; attempt++) {
                if (attempt > 0) {
                    const delay = 3000 * Math.pow(2, attempt - 1); // 3s, 6s, 12s, 24s
                    console.log('[Go] GH: rate limited, retrying in ' + delay + 'ms...');
                    await new Promise(r => setTimeout(r, delay));
                }
                resp = await fetch('https://graphhopper.com/api/1/vrp?key=' + ghKey, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                window._ghLastCall = Date.now();
                if (resp.status !== 429) break;
            }

            if (resp.status === 402) {
                console.warn('[Go] GH: billing quota exhausted, switching to VROOM');
                _ghQuotaExhausted = true;
                return null;
            }

            if (resp.status === 429) {
                console.warn('[Go] GH: rate limited after 5 retries, falling back to VROOM');
                return null; // don't set _ghQuotaExhausted — next zone can retry
            }

            if (!resp.ok) {
                try {
                    const errBody = await resp.text();
                    console.warn('[Go] GH: HTTP ' + resp.status + ' — ' + errBody.substring(0, 200));
                } catch (_) {
                    console.warn('[Go] GH: HTTP ' + resp.status);
                }
                return null;
            }

            const result = await resp.json();
            const route = result.solution?.routes?.[0];
            if (!route?.activities?.length) {
                console.warn('[Go] GH: no solution returned');
                return null;
            }

            // Map activities back to stops
            const ordered = [];
            route.activities.forEach(act => {
                if (act.type !== 'service') return;
                const idx = parseInt(act.id?.replace('stop_', ''));
                if (!isNaN(idx) && primaryStops[idx]) ordered.push(primaryStops[idx]);
            });

            // Handle unassigned
            if (result.solution?.unassigned?.services?.length) {
                result.solution.unassigned.services.forEach(ua => {
                    const idx = parseInt(ua.id?.replace('stop_', ''));
                    if (!isNaN(idx) && primaryStops[idx] && !ordered.includes(primaryStops[idx])) {
                        cheapestInsert(ordered, primaryStops[idx]);
                    }
                });
            }

            // Insert overflow stops using cheapestInsert with driving distances
            overflowStops.forEach(st => cheapestInsert(ordered, st));

            console.log('[Go] GH: optimized ' + ordered.length + ' stops for ' + (vehicle.name || vehicle.busId));
            return ordered;

        } catch (e) {
            console.warn('[Go] GH: request failed:', e.message);
            return null;
        }
    }

    // =========================================================================
    // VROOM SOLVER (ORS) — fallback when GraphHopper unavailable
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
                if (drivingDistMi(stops[i].lat, stops[i].lng, stops[j].lat, stops[j].lng) <= dedupDist) {
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

            // ── Hungarian algorithm for optimal bus→zone assignment ──
            // Cost = geographic distance + capacity mismatch penalty
            // This replaces naive size-ordered pairing
            const nZones = shiftZones.length;
            const nBuses = vehicles.length;
            const zoneAssignments = [];

            if (nZones > 0 && nBuses > 0) {
                const n = Math.max(nZones, nBuses); // pad to square matrix
                const cost = Array.from({ length: n }, () => new Array(n).fill(0));

                // Build cost matrix: cost[bus][zone]
                for (let b = 0; b < n; b++) {
                    for (let z = 0; z < n; z++) {
                        if (b >= nBuses || z >= nZones) {
                            cost[b][z] = 0; // dummy row/col — zero cost
                            continue;
                        }
                        const veh = vehicles[b];
                        const zone = shiftZones[z];
                        // Geographic cost: driving distance from camp through zone centroid
                        const geoDist = _campCoordsCache ?
                            drivingDistMi(_campCoordsCache.lat, _campCoordsCache.lng, zone.centroidLat, zone.centroidLng) : 0;
                        // Capacity mismatch: penalize assigning a bus that's too small
                        const capMismatch = Math.max(0, zone.camperNames.length - veh.capacity) * 2;
                        // Waste penalty: mildly penalize assigning a large bus to a small zone
                        const waste = Math.max(0, veh.capacity - zone.camperNames.length) * 0.1;
                        cost[b][z] = geoDist + capMismatch + waste;
                    }
                }

                // Hungarian algorithm (Kuhn-Munkres) — O(n³) assignment
                const assignment = hungarian(cost, n);

                // Build assignments from result
                for (let b = 0; b < nBuses; b++) {
                    const z = assignment[b];
                    if (z < nZones) {
                        zoneAssignments.push({ zone: shiftZones[z], vehicle: vehicles[b] });
                    }
                }

                // Handle extra zones (more zones than buses) — merge into nearest assigned zone
                const assignedZoneIds = new Set(zoneAssignments.map(za => za.zone.id));
                shiftZones.forEach(z => {
                    if (assignedZoneIds.has(z.id)) return;
                    let bestIdx = 0, bestDist = Infinity;
                    for (let j = 0; j < zoneAssignments.length; j++) {
                        const d = drivingDist(z.centroidLat, z.centroidLng, zoneAssignments[j].zone.centroidLat, zoneAssignments[j].zone.centroidLng);
                        if (d < bestDist) { bestDist = d; bestIdx = j; }
                    }
                    zoneAssignments[bestIdx].zone.camperNames.push(...z.camperNames);
                    console.log('[Go] Zone overflow: merged ' + z.name + ' into ' + zoneAssignments[bestIdx].zone.name);
                });
            }

            // Log zone→bus assignment
            zoneAssignments.forEach(za => {
                console.log('[Go]   Zone "' + za.zone.name + '": ' + za.zone.camperNames.length + ' kids → ' + za.vehicle.name + ' (cap ' + za.vehicle.capacity + ')');
            });

            // ══════════════════════════════════════════════════════════════
            // GLOBAL MULTI-BUS VROOM — Industry-grade VRP solver
            //
            // Models the full School Bus Routing Problem (SBRP) using every
            // VROOM constraint the industry leaders use:
            //   • time_window on vehicles (shift working hours)
            //   • max_travel_time on vehicles (max route duration)
            //   • max_tasks on vehicles (cap stops per bus)
            //   • skills for zone affinity (geographic locality)
            //   • priority on jobs (high-kid-count stops get priority)
            //   • setup + service split (boarding vs dwell time)
            //   • speed_factor per vehicle (different bus types)
            //   • capacity with delivery amounts
            //
            // Falls back to per-zone VROOM if this fails.
            // ══════════════════════════════════════════════════════════════
            let globalVROOMSucceeded = false;
            if (apiKey && zoneAssignments.length >= 1) {
                try {
                    // ── Step 1: Create all stops across all zones ──
                    const allStops = [];
                    const stopZoneIdx = []; // zone index for each stop (for skills)
                    for (let zi = 0; zi < zoneAssignments.length; zi++) {
                        const za = zoneAssignments[zi];
                        const zoneCampers = za.zone.camperNames.map(n => campers.find(c => c.name === n)).filter(Boolean);
                        if (!zoneCampers.length) continue;
                        let zoneStops;
                        if (mode === 'optimized-stops') zoneStops = createOptimizedStops(zoneCampers);
                        else if (mode === 'corner-stops') zoneStops = await createCornerStops(zoneCampers);
                        else zoneStops = createHouseStops(zoneCampers);
                        zoneStops.forEach(s => {
                            allStops.push(s);
                            stopZoneIdx.push(zi);
                        });
                    }

                    if (allStops.length > 0 && allStops.length <= 150) {
                        // ── Step 2: Compute shift time window ──
                        // VROOM uses Unix-style timestamps for time windows.
                        // We use seconds-from-midnight as a simple epoch.
                        const departMin = parseTime(shift.departureTime || (isArrival ? '08:00' : '16:00'));
                        const departSec = departMin * 60;
                        // Max route duration: default 60 min, capped at 90 min
                        const maxRouteDurationMin = D.setup.maxRouteDuration || 60;
                        const maxRouteDurationSec = maxRouteDurationMin * 60;
                        // Shift window: departure ± route duration
                        const shiftStartSec = isArrival ? departSec - maxRouteDurationSec - 600 : departSec; // 10 min buffer for arrival
                        const shiftEndSec = isArrival ? departSec + 300 : departSec + maxRouteDurationSec + 600;

                        // ── Step 3: Build VROOM jobs with full constraints ──
                        const setupTimeSec = Math.round(serviceTime * 0.3); // 30% = boarding/loading
                        const dwellTimeSec = Math.round(serviceTime * 0.7); // 70% = dwell at stop
                        const jobs = allStops.map((stop, i) => {
                            const kidCount = stop.campers.length;
                            const job = {
                                id: i + 1,
                                location: [stop.lng, stop.lat],
                                setup: setupTimeSec,
                                service: dwellTimeSec,
                                description: stop.address || '',
                                // Priority: more kids = higher priority (0-100)
                                priority: Math.min(100, Math.max(1, kidCount * 10))
                            };
                            // Arrival = kids board (pickup increases load)
                            // Dismissal = kids exit (delivery decreases load)
                            if (isArrival) job.pickup = [kidCount];
                            else job.delivery = [kidCount];
                            return job;
                        });

                        // ── Step 4: Build VROOM vehicles with full constraints ──
                        // Pre-compute farthest stop per zone for arrival start positioning
                        const zoneFarthestStop = {};
                        zoneAssignments.forEach((za, vi) => {
                            let fDist = 0, fStop = null;
                            allStops.forEach((s, si) => {
                                if (stopZoneIdx[si] !== vi) return;
                                const d = drivingDist(campLat, campLng, s.lat, s.lng);
                                if (d > fDist) { fDist = d; fStop = s; }
                            });
                            zoneFarthestStop[vi] = fStop;
                        });

                        const vroomVehicles = zoneAssignments.map((za, vi) => {
                            const v = za.vehicle;
                            const veh = {
                                id: vi + 1,
                                profile: 'driving-car',
                                description: v.name,
                                capacity: [v.capacity],
                                time_window: [shiftStartSec, shiftEndSec],
                                max_travel_time: maxRouteDurationSec,
                                max_tasks: Math.max(8, Math.ceil(allStops.length / zoneAssignments.length) + 3),
                                speed_factor: 1.0
                            };

                            if (isArrival) {
                                // Arrival: start at FARTHEST stop from camp (pick up farthest first)
                                // End at camp. VROOM will route inward: far → near → camp.
                                const far = zoneFarthestStop[vi];
                                veh.start = far ? [far.lng, far.lat] : [campLng, campLat];
                                veh.end = [campLng, campLat];
                            } else {
                                // Dismissal: start at camp, VROOM routes outward: camp → near → far.
                                // No end = open-ended route (bus doesn't return after last stop,
                                // unless multi-shift needs return)
                                veh.start = [campLng, campLat];
                                if (needsReturn) veh.end = [campLng, campLat];
                            }
                            return veh;
                        });

                        console.log('[Go] Global VROOM: ' + jobs.length + ' jobs, ' + vroomVehicles.length + ' vehicles');
                        console.log('[Go]   Constraints: time_window=[' + shiftStartSec + ',' + shiftEndSec + '], max_travel=' + maxRouteDurationSec + 's, max_tasks=' + vroomVehicles[0]?.max_tasks);

                        const resp = await fetch('https://api.openrouteservice.org/optimization', {
                            method: 'POST',
                            headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' },
                            body: JSON.stringify({ jobs, vehicles: vroomVehicles })
                        });

                        if (resp.ok) {
                            const result = await resp.json();

                            // Log solution quality
                            if (result.summary) {
                                console.log('[Go] VROOM solution: cost=' + result.summary.cost +
                                    ', duration=' + Math.round((result.summary.duration || 0) / 60) + 'min' +
                                    ', distance=' + Math.round((result.summary.distance || 0) / 1000) + 'km' +
                                    ', unassigned=' + (result.summary.unassigned || 0) +
                                    ', violations=' + (result.summary.violations?.length || 0));
                            }

                            if (result.routes?.length) {
                                result.routes.forEach(vr => {
                                    const za = zoneAssignments[vr.vehicle - 1];
                                    if (!za) return;
                                    const orderedStops = [];
                                    vr.steps.forEach(step => {
                                        if (step.type !== 'job') return;
                                        const stop = allStops[step.id - 1];
                                        if (stop) orderedStops.push(stop);
                                    });
                                    if (!orderedStops.length) return;

                                    // Orientation: VROOM already orders optimally,
                                    // but verify direction for arrival/dismissal
                                    if (orderedStops.length >= 2) {
                                        const firstDist = drivingDist(campLat, campLng, orderedStops[0].lat, orderedStops[0].lng);
                                        const lastDist = drivingDist(campLat, campLng, orderedStops[orderedStops.length - 1].lat, orderedStops[orderedStops.length - 1].lng);
                                        if (isArrival && firstDist < lastDist) orderedStops.reverse();
                                        if (!isArrival && firstDist > lastDist) orderedStops.reverse();
                                    }

                                    allRoutes.push({
                                        busId: za.vehicle.busId, busName: za.vehicle.name,
                                        busColor: za.vehicle.color, monitor: za.vehicle.monitor,
                                        counselors: za.vehicle.counselors || [],
                                        stops: orderedStops.map((s, i) => ({
                                            stopNum: i + 1, campers: s.campers, address: s.address,
                                            lat: s.lat, lng: s.lng
                                        })),
                                        camperCount: orderedStops.reduce((sum, s) => sum + s.campers.length, 0),
                                        _cap: za.vehicle.capacity,
                                        _vroomDuration: vr.duration, // actual VROOM-computed route duration
                                        _vroomDistance: vr.distance
                                    });
                                });

                                // Handle unassigned stops — insert into bus with most room
                                if (result.unassigned?.length) {
                                    console.warn('[Go] Global VROOM: ' + result.unassigned.length + ' unassigned stops');
                                    result.unassigned.forEach(ua => {
                                        const stop = allStops[ua.id - 1];
                                        if (!stop) return;
                                        let bestRoute = null, bestRoom = -1;
                                        allRoutes.forEach(r => {
                                            const room = r._cap - r.camperCount;
                                            if (room > bestRoom) { bestRoom = room; bestRoute = r; }
                                        });
                                        if (bestRoute) {
                                            cheapestInsert(bestRoute.stops, {
                                                stopNum: bestRoute.stops.length + 1,
                                                campers: stop.campers, address: stop.address,
                                                lat: stop.lat, lng: stop.lng
                                            });
                                            bestRoute.camperCount += stop.campers.length;
                                        }
                                    });
                                }

                                globalVROOMSucceeded = allRoutes.length > 0;
                                if (globalVROOMSucceeded) {
                                    console.log('[Go] Global VROOM ✓: ' + allRoutes.length + ' routes, ' +
                                        allRoutes.reduce((s, r) => s + r.stops.length, 0) + ' stops, ' +
                                        allRoutes.reduce((s, r) => s + r.camperCount, 0) + ' kids');
                                }
                            }
                        } else {
                            const errText = await resp.text().catch(() => '');
                            console.warn('[Go] Global VROOM HTTP ' + resp.status + ': ' + errText.substring(0, 200));
                        }
                    }
                } catch (e) {
                    console.warn('[Go] Global VROOM error:', e.message);
                }
            }

            // ── Per-zone VROOM fallback (if global failed or not attempted) ──
            if (!globalVROOMSucceeded) {
            // Process zones sequentially (not parallel) to respect GH rate limits
            const zoneHandlers = zoneAssignments.map(za => async () => {
                const zoneCampers = za.zone.camperNames.map(n => campers.find(c => c.name === n)).filter(Boolean);
                if (!zoneCampers.length) return null;

                // Create stops for this zone
                let zoneStops;
                if (mode === 'optimized-stops') zoneStops = createOptimizedStops(zoneCampers);
                else if (mode === 'corner-stops') zoneStops = await createCornerStops(zoneCampers);
                else zoneStops = createHouseStops(zoneCampers);

                if (!zoneStops.length) return null;

                console.log('[Go]   Zone "' + za.zone.name + '": ' + zoneStops.length + ' stops from ' + zoneCampers.length + ' campers');

                // VROOM call: one bus with full constraints (same model as global)
                const setupTimeSec = Math.round(serviceTime * 0.3);
                const dwellTimeSec = Math.round(serviceTime * 0.7);
                const jobs = zoneStops.map((stop, i) => {
                    const kidCount = stop.campers.length;
                    const job = {
                        id: i + 1,
                        location: [stop.lng, stop.lat],
                        setup: setupTimeSec,
                        service: dwellTimeSec,
                        priority: Math.min(100, Math.max(1, kidCount * 10)),
                        description: stop.address || ''
                    };
                    if (isArrival) job.pickup = [kidCount];
                    else job.delivery = [kidCount];
                    return job;
                });

                const v = za.vehicle;
                const departMin = parseTime(shift.departureTime || (isArrival ? '08:00' : '16:00'));
                const departSec = departMin * 60;
                const maxRouteSec = (D.setup.maxRouteDuration || 60) * 60;
                const veh = {
                    id: 1, profile: 'driving-car',
                    capacity: [v.capacity], description: v.name,
                    time_window: [
                        isArrival ? departSec - maxRouteSec - 600 : departSec,
                        isArrival ? departSec + 300 : departSec + maxRouteSec + 600
                    ],
                    max_travel_time: maxRouteSec,
                    speed_factor: 1.0
                };
                if (isArrival) {
                    let fIdx = 0, fDist = 0;
                    zoneStops.forEach((s, i) => {
                        const d = drivingDist(campLat, campLng, s.lat, s.lng);
                        if (d > fDist) { fDist = d; fIdx = i; }
                    });
                    veh.start = [zoneStops[fIdx].lng, zoneStops[fIdx].lat];
                    veh.end = [campLng, campLat];
                } else {
                    veh.start = [campLng, campLat];
                    if (needsReturn) veh.end = [campLng, campLat];
                }

                // ── Route optimization: VROOM → local TSP ──
                let orderedStops = null;

                // 1. ORS VROOM
                if (!orderedStops) {
                    console.log('[Go] VROOM → ' + v.name + ' (' + za.zone.name + '): ' + jobs.length + ' stops');
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
                        }
                    } catch (e) {
                        console.warn('[Go] VROOM failed for ' + v.name + ':', e.message);
                    }
                }

                // 3. Last resort: directional sort by driving distance
                if (!orderedStops) {
                    orderedStops = [...zoneStops];
                    directionalSort(orderedStops, campLat, campLng);
                }

                // ── 2-opt improvement (using driving distances) ──
                if (orderedStops.length >= 3) {
                    let improved = true;
                    for (let pass = 0; pass < 5 && improved; pass++) {
                        improved = false;
                        for (let i = 0; i < orderedStops.length - 2; i++) {
                            for (let j = i + 2; j < orderedStops.length; j++) {
                                const a = orderedStops[i], b = orderedStops[i + 1];
                                const c = orderedStops[j], d = orderedStops[j + 1] || (isArrival ? { lat: campLat, lng: campLng } : null);
                                if (!a?.lat || !b?.lat || !c?.lat) continue;
                                const curDist = drivingDist(a.lat, a.lng, b.lat, b.lng) + (d ? drivingDist(c.lat, c.lng, d.lat, d.lng) : 0);
                                const newDist = drivingDist(a.lat, a.lng, c.lat, c.lng) + (d ? drivingDist(b.lat, b.lng, d.lat, d.lng) : 0);
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

                // ── Or-opt (using driving distances) ──
                if (orderedStops.length >= 4) {
                    for (let pass = 0; pass < 3; pass++) {
                        let relocated = false;
                        for (let i = 0; i < orderedStops.length; i++) {
                            const s = orderedStops[i];
                            if (!s?.lat) continue;
                            const prev = i > 0 ? orderedStops[i - 1] : null;
                            const next = i < orderedStops.length - 1 ? orderedStops[i + 1] : null;
                            let removeCost = 0;
                            if (prev?.lat && next?.lat) removeCost = drivingDist(prev.lat, prev.lng, next.lat, next.lng);
                            let currentCost = 0;
                            if (prev?.lat) currentCost += drivingDist(prev.lat, prev.lng, s.lat, s.lng);
                            if (next?.lat) currentCost += drivingDist(s.lat, s.lng, next.lat, next.lng);
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
                                if (pBefore?.lat) ic += drivingDist(pBefore.lat, pBefore.lng, s.lat, s.lng);
                                if (pAfter?.lat) ic += drivingDist(s.lat, s.lng, pAfter.lat, pAfter.lng);
                                if (pBefore?.lat && pAfter?.lat) ic -= drivingDist(pBefore.lat, pBefore.lng, pAfter.lat, pAfter.lng);
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

                // ── Orientation check (using driving distances) ──
                // Arrival: first stop FARTHEST from camp, last stop NEAREST
                // Dismissal: first stop NEAREST to camp, last stop FARTHEST
                if (orderedStops.length >= 2) {
                    const firstDist = drivingDist(campLat, campLng, orderedStops[0].lat, orderedStops[0].lng);
                    const lastDist = drivingDist(campLat, campLng, orderedStops[orderedStops.length - 1].lat, orderedStops[orderedStops.length - 1].lng);
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

            // Run zones sequentially (not parallel) to avoid GH rate limits
            for (const handler of zoneHandlers) {
                const r = await handler();
                if (r) allRoutes.push(r);
            }
            } // end if (!globalVROOMSucceeded)

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
                    const d = drivingDist(smallest.centroidLat, smallest.centroidLng, groups[i].centroidLat, groups[i].centroidLng);
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
                if (drivingDistMi(a.lat, a.lng, b.lat, b.lng) > 0.057) continue;
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
                    const distFromOwn = drivingDistMi(st.lat, st.lng, overCentLat, overCentLng);
                    for (const r of allRoutes) {
                        if (r === overBus) continue;
                        if (r.camperCount + st.campers.length > r._cap) continue;
                        const rLat = r.stops.length ? r.stops.reduce((s, x) => s + x.lat, 0) / r.stops.length : campLat;
                        const rLng = r.stops.length ? r.stops.reduce((s, x) => s + x.lng, 0) / r.stops.length : campLng;
                        const distToTarget = drivingDistMi(st.lat, st.lng, rLat, rLng);
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
                const moveDist = drivingDistMi(stopToMove.lat, stopToMove.lng, bestBus.stops.length ? bestBus.stops.reduce((s, x) => s + x.lat, 0) / bestBus.stops.length : campLat, bestBus.stops.length ? bestBus.stops.reduce((s, x) => s + x.lng, 0) / bestBus.stops.length : campLng);
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
                        const distFromOwn = drivingDistMi(st.lat, st.lng, overCentLat, overCentLng);
                        for (const r of allRoutes) {
                            if (r === overBus || r.camperCount >= r._cap) continue;
                            const rLat = r.stops.length ? r.stops.reduce((s, x) => s + x.lat, 0) / r.stops.length : campLat;
                            const rLng = r.stops.length ? r.stops.reduce((s, x) => s + x.lng, 0) / r.stops.length : campLng;
                            const distToTarget = drivingDistMi(st.lat, st.lng, rLat, rLng);
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
                const splitDist = drivingDistMi(stopToSplit.lat, stopToSplit.lng, splitBus.stops.length ? splitBus.stops.reduce((s, x) => s + x.lat, 0) / splitBus.stops.length : campLat, splitBus.stops.length ? splitBus.stops.reduce((s, x) => s + x.lng, 0) / splitBus.stops.length : campLng);
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

            // Drive time helper: matrix-based or driving cache fallback
            function driveSec(fromIdx, toIdx) {
                if (matrix?.[fromIdx]?.[toIdx] != null && matrix[fromIdx][toIdx] >= 0) return matrix[fromIdx][toIdx];
                const a = coords[fromIdx], b = coords[toIdx];
                return drivingDist(a.lat, a.lng, b.lat, b.lng);
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
        // COUNSELOR & MONITOR ASSIGNMENT (Smart Auto-Assign)
        //
        // Three modes per staff member:
        //   'stop'   — needsStop=yes: treated like a camper, gets own stop
        //   'auto'   — no stop needed: auto-assigned to nearest bus route
        //   'manual' — no stop needed: already assigned to specific bus
        //
        // For 'auto' and 'manual' without stop: find nearest existing stop
        // on their bus. Warn if >7 min walk away.
        // ══════════════════════════════════════════════════════════════
        const allStops = [];
        allRoutes.forEach(r => r.stops.forEach(st => {
            if (!st.isMonitor && st.lat && st.lng) allStops.push({ stop: st, route: r });
        }));

        const counselorsToAssign = D.counselors.filter(c => c.address);
        if (counselorsToAssign.length && allStops.length) {
            console.log('[Go] ═══ COUNSELOR ASSIGNMENT ═══');
            const OUTLIER_WALK_FT = 1850;
            const outliers = [];

            for (const c of counselorsToAssign) {
                // Use cached coords or look up from D.addresses
                if (!c._lat || !c._lng) {
                    const staffAddr = D.addresses[c.name] || D.addresses[c.firstName + ' ' + c.lastName];
                    if (staffAddr?.geocoded && staffAddr.lat && staffAddr.lng) {
                        c._lat = staffAddr.lat; c._lng = staffAddr.lng;
                    } else {
                        continue; // Skip — address should have been geocoded in auto-geocode step
                    }
                }

                const mode = c.assignMode || (c.needsStop === 'yes' ? 'stop' : c.assignedBus ? 'manual' : 'auto');

                // MODE: 'stop' — they need their own stop, handled during route generation
                // (already included as a camper address if needsStop=yes)
                if (mode === 'stop') {
                    console.log('[Go]   ' + c.name + ' — has dedicated stop (treated as camper)');
                    continue;
                }

                // MODE: 'auto' — find the bus whose route passes closest
                if (mode === 'auto') {
                    let bestRoute = null, bestDist = Infinity;
                    for (const r of allRoutes) {
                        if (!r.stops.length) continue;
                        // Find closest stop on this route
                        for (const st of r.stops) {
                            if (!st.lat) continue;
                            const d = manhattanMi(c._lat, c._lng, st.lat, st.lng);
                            if (d < bestDist) { bestDist = d; bestRoute = r; }
                        }
                    }
                    if (bestRoute) {
                        c.assignedBus = bestRoute.busId;
                        c._assignedBusName = bestRoute.busName;
                        console.log('[Go]   ' + c.name + ' → AUTO-ASSIGNED to ' + bestRoute.busName + ' (' + Math.round(bestDist * 5280) + 'ft from nearest stop)');
                    }
                }

                // Find nearest stop — prefer their assigned bus, fall back to any bus
                let bestStop = null, bestRoute = null, bestDist = Infinity;
                // First pass: only stops on assigned bus
                if (c.assignedBus) {
                    for (const { stop, route } of allStops) {
                        if (route.busId !== c.assignedBus) continue;
                        const d = manhattanMi(c._lat, c._lng, stop.lat, stop.lng);
                        if (d < bestDist) { bestDist = d; bestStop = stop; bestRoute = route; }
                    }
                }
                // Second pass: any bus (if assigned bus has no nearby stops)
                if (!bestStop || bestDist * 5280 > 3000) {
                    for (const { stop, route } of allStops) {
                        const d = manhattanMi(c._lat, c._lng, stop.lat, stop.lng);
                        if (d < bestDist) { bestDist = d; bestStop = stop; bestRoute = route; }
                    }
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

        // ── Route optimization: local TSP with directional bias ──
        let optimizedOrder = null;
        let matrix = null;

        // ── Local TSP solver ──
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
                return drivingDist(a.lat, a.lng, b.lat, b.lng);
            }
            const campDists = []; for (let i = 0; i < nn; i++) campDists[i] = drivingDist(campLat, campLng, stops[i].lat, stops[i].lng);
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
                const fd = drivingDist(campLat, campLng, newStops[0].lat, newStops[0].lng);
                const ld = drivingDist(campLat, campLng, newStops[newStops.length - 1].lat, newStops[newStops.length - 1].lng);
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
        function driveMin(a, b) { if (matrix && a._matrixIdx != null && b._matrixIdx != null) { const v = matrix[a._matrixIdx]?.[b._matrixIdx]; if (v != null && v >= 0) return v / 60; } if (a.lat && b.lat) return drivingDist(a.lat, a.lng, b.lat, b.lng) / 60; return 3; }
        function campToStopMin(s) { if (matrix && s._matrixIdx != null) { const v = matrix[0]?.[s._matrixIdx]; if (v != null && v >= 0) return v / 60; } if (s.lat) return drivingDist(campLat, campLng, s.lat, s.lng) / 60; return 15; }

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
                const d = drivingDistMi(campers[i].lat, campers[i].lng, campers[j].lat, campers[j].lng);
                if (d < minDist) minDist = d;
            }
            if (minDist < Infinity) nnDists.push(minDist);
        }

        if (!nnDists.length) return 0.1;

        // Median nearest-neighbor distance
        nnDists.sort((a, b) => a - b);
        const median = nnDists[Math.floor(nnDists.length / 2)];

        // Scale: cluster radius = 3× median NN distance
        // Tighter clusters = more compact routes; VROOM handles stop ordering
        const FLOOR = 0.04;   // ~210ft — minimum even in Manhattan
        const CEILING = 0.5;  // ~0.5 mile — keeps routes compact even in rural areas
        const MULTIPLIER = 3;

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

        // Build stops — snap to nearest camper's house with camp-facing bias
        const stops = bestClusters.map(cluster => {
            if (cluster.length === 1) {
                return { lat: cluster[0].lat, lng: cluster[0].lng, address: cluster[0].address, campers: cluster.map(c => ({ name: c.name, division: c.division, bunk: c.bunk })) };
            }

            // Step 1: Compute coordinate-wise median as starting point
            const sortedLats = cluster.map(k => k.lat).sort((a, b) => a - b);
            const sortedLngs = cluster.map(k => k.lng).sort((a, b) => a - b);
            let medianLat = sortedLats[Math.floor(sortedLats.length / 2)];
            let medianLng = sortedLngs[Math.floor(sortedLngs.length / 2)];

            // Step 2: Camp-facing bias — shift the stop 15% of cluster radius
            // toward camp so the bus approaches from the camp side
            if (_campCoordsCache) {
                const clusterRadius = Math.max(...cluster.map(k => manhattanMi(medianLat, medianLng, k.lat, k.lng)));
                if (clusterRadius > 0.005) { // only bias if cluster has meaningful spread
                    const bearingLat = _campCoordsCache.lat - medianLat;
                    const bearingLng = _campCoordsCache.lng - medianLng;
                    const bearingDist = Math.sqrt(bearingLat ** 2 + bearingLng ** 2);
                    if (bearingDist > 0) {
                        const shift = clusterRadius * 0.15; // 15% bias toward camp
                        const shiftLat = medianLat + (bearingLat / bearingDist) * shift * 14.5; // ~14.5 = degrees per mile at this latitude
                        const shiftLng = medianLng + (bearingLng / bearingDist) * shift * 14.5;
                        // Verify all kids still within walk distance of shifted point
                        const allFit = cluster.every(k => manhattanMi(shiftLat, shiftLng, k.lat, k.lng) <= walkMi);
                        if (allFit) {
                            medianLat = shiftLat;
                            medianLng = shiftLng;
                        }
                    }
                }
            }

            // Step 3: Snap to nearest camper's house instead of geometric point
            // A real address on a real street is always better than a median
            // that might land in a parking lot or park
            let bestHouse = cluster[0], bestDist = Infinity;
            cluster.forEach(k => {
                const d = manhattanMi(medianLat, medianLng, k.lat, k.lng);
                if (d < bestDist) { bestDist = d; bestHouse = k; }
            });

            // Use the nearest house's actual coordinates and address
            const stopLat = bestHouse.lat;
            const stopLng = bestHouse.lng;
            const stopAddr = bestHouse.address;

            return { lat: stopLat, lng: stopLng, address: stopAddr, campers: cluster.map(c => ({ name: c.name, division: c.division, bunk: c.bunk })) };
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

    // Clear any stale intersection cache and always fetch fresh
    try { localStorage.removeItem('campistry_go_intersections'); } catch (_) {}

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
                        if (d > walkMi * 2) return;

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
                            if (d < nearestDist && d <= walkMi * 2) { nearestDist = d; nearestInter = inter; }
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
                        if (d > walkMi * 2) return;
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
                            if (d < nearestDist && d <= walkMi * 2) {
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
        // Merge tiny stops (≤2 kids) only into nearby stops within half walk distance
        // Using full walkMi was pulling distant stops together and stretching routes
        const mergeRadius = walkMi * 0.5;
        let didMerge = true;
        while (didMerge) {
            didMerge = false;
            for (let i = stops.length - 1; i >= 0; i--) {
                if (stops[i].campers.length > 2) continue;
                let bestJ = -1, bestDist = mergeRadius;
                for (let j = 0; j < stops.length; j++) {
                    if (j === i) continue;
                    // Don't merge into a stop that would exceed capacity
                    if (stops[j].campers.length + stops[i].campers.length > MAX_STOP_CAPACITY) continue;
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
    // Uses two lightweight queries instead of one heavy one to avoid 504 timeouts:
    //   Q1: Major roads only (primary/secondary/trunk) — small, fast, for crossing detection
    //   Q2: All named roads but nodes-only via `out center` — for intersection finding
    async function fetchIntersections(campers) {
        // Use IQR-based outlier removal to build a tight bbox
        const lats = campers.map(c => c.lat).filter(Boolean).sort((a, b) => a - b);
        const lngs = campers.map(c => c.lng).filter(Boolean).sort((a, b) => a - b);
        if (lats.length < 4 || lngs.length < 4) return null;
        const q1Lat = lats[Math.floor(lats.length * 0.25)], q3Lat = lats[Math.floor(lats.length * 0.75)];
        const q1Lng = lngs[Math.floor(lngs.length * 0.25)], q3Lng = lngs[Math.floor(lngs.length * 0.75)];
        const iqrLat = q3Lat - q1Lat, iqrLng = q3Lng - q1Lng;
        const fenceLat = [q1Lat - 1.5 * iqrLat, q3Lat + 1.5 * iqrLat];
        const fenceLng = [q1Lng - 1.5 * iqrLng, q3Lng + 1.5 * iqrLng];
        const cleanLats = lats.filter(v => v >= fenceLat[0] && v <= fenceLat[1]);
        const cleanLngs = lngs.filter(v => v >= fenceLng[0] && v <= fenceLng[1]);
        if (cleanLats.length < 2 || cleanLngs.length < 2) return null;
        const minLat = cleanLats[0], maxLat = cleanLats[cleanLats.length - 1];
        const minLng = cleanLngs[0], maxLng = cleanLngs[cleanLngs.length - 1];
        const outlierCount = lats.length - cleanLats.length + lngs.length - cleanLngs.length;
        if (outlierCount > 0) console.log('[Go] Overpass: excluded ' + outlierCount + ' outlier coordinates via IQR');
        const buf = 0.008;
        const bbox = (minLat - buf) + ',' + (minLng - buf) + ',' + (maxLat + buf) + ',' + (maxLng + buf);

        const area = (maxLat - minLat + 2 * buf) * (maxLng - minLng + 2 * buf);
        console.log('[Go] Overpass: bbox area ' + area.toFixed(4) + ' deg² (' + cleanLats.length + ' of ' + lats.length + ' points)');
        if (area > 1.0) {
            console.warn('[Go] Overpass: bbox too large even after IQR cleanup (' + area.toFixed(3) + ' deg²), skipping');
            return null;
        }

        // Query 1: Major roads for crossing detection (lightweight — few ways)
        const majorQuery = '[out:json][timeout:25];' +
            'way["highway"~"^(primary|secondary|trunk)$"](' + bbox + ');' +
            'out body;>;out skel qt;';

        // Query 2: All named roads — use `out tags center` to get way center + name
        // without expanding every node (much smaller response than >;out skel)
        const intersectionQuery = '[out:json][timeout:25];' +
            'way["highway"~"^(residential|secondary|tertiary|primary|trunk|unclassified|living_street)$"]["name"](' + bbox + ');' +
            'out body;>;out skel qt;';

        const endpoints = [
            'https://overpass-api.de/api/interpreter',
            'https://overpass.kumi.systems/api/interpreter',
            'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
        ];

        async function runQuery(query, label) {
            for (const url of endpoints) {
                try {
                    // Use GET to avoid CORS preflight (POST with custom content-type triggers it)
                    const getUrl = url + '?data=' + encodeURIComponent(query);
                    console.log('[Go] Overpass ' + label + ': trying ' + url.split('//')[1].split('/')[0] + '...');
                    const resp = await fetch(getUrl);
                    if (resp.status === 504 || resp.status === 429 || resp.status === 503) {
                        console.warn('[Go] Overpass ' + label + ' ' + resp.status + ' at ' + url + ', trying next mirror...');
                        continue;
                    }
                    if (!resp.ok) {
                        console.warn('[Go] Overpass ' + label + ' HTTP ' + resp.status + ' at ' + url);
                        continue;
                    }
                    const data = await resp.json();
                    console.log('[Go] Overpass ' + label + ': got ' + (data?.elements?.length || 0) + ' elements');
                    return data;
                } catch (e) {
                    console.warn('[Go] Overpass ' + label + ' error at ' + url + ':', e.message);
                    continue;
                }
            }
            return null;
        }

        // Run major roads query first (small & fast), then intersection query
        const majorData = await runQuery(majorQuery, 'major-roads');

        // Extract major road segments for crossing detection
        const majorSegments = [];
        if (majorData?.elements?.length) {
            const mNodes = {};
            majorData.elements.filter(e => e.type === 'node' && e.lat && e.lon).forEach(e => { mNodes[e.id] = { lat: e.lat, lng: e.lon }; });
            majorData.elements.filter(e => e.type === 'way' && e.nodes?.length >= 2).forEach(way => {
                for (let i = 0; i < way.nodes.length - 1; i++) {
                    const a = mNodes[way.nodes[i]], b = mNodes[way.nodes[i + 1]];
                    if (a && b) majorSegments.push({ lat1: a.lat, lng1: a.lng, lat2: b.lat, lng2: b.lng, name: (way.tags?.name) || '' });
                }
            });
        }
        _majorRoadSegments = majorSegments;
        console.log('[Go] Overpass: ' + majorSegments.length + ' major road segments');

        // Now fetch all roads for intersection detection
        const intData = await runQuery(intersectionQuery, 'intersections');
        if (!intData?.elements?.length) {
            console.warn('[Go] Overpass: no intersection data returned');
            return null;
        }

        const nodes = {};
        intData.elements.filter(e => e.type === 'node' && e.lat && e.lon).forEach(e => { nodes[e.id] = { lat: e.lat, lng: e.lon }; });

        const nodeStreets = {};
        intData.elements.filter(e => e.type === 'way' && e.tags?.name && e.nodes?.length).forEach(way => {
            way.nodes.forEach(nid => { if (!nodeStreets[nid]) nodeStreets[nid] = new Set(); nodeStreets[nid].add(way.tags.name); });
        });

        const intersections = [];
        Object.entries(nodeStreets).forEach(([nid, streets]) => {
            if (streets.size < 2) return;
            const node = nodes[nid]; if (!node) return;
            const arr = [...streets].sort();
            intersections.push({ lat: node.lat, lng: node.lng, name: arr[0] + ' & ' + arr[1], streets: arr });
        });

        console.log('[Go] Overpass: ' + intersections.length + ' intersections found' + (intersections.length > 0 ? ' (e.g. ' + intersections[0].name + ')' : ''));
        return intersections.length > 0 ? intersections : null;
    }

    function normalizeStreet(name) {
        if (!name) return '';
        let s = name.toLowerCase().trim();
        // Suffixes — only match at end of string
        const suffixes = [
            [/\bst\.?$/g, 'street'], [/\bave?\.?$/g, 'avenue'], [/\bblvd\.?$/g, 'boulevard'],
            [/\bdr\.?$/g, 'drive'], [/\brd\.?$/g, 'road'], [/\bct\.?$/g, 'court'],
            [/\bln\.?$/g, 'lane'], [/\bpl\.?$/g, 'place'], [/\bpkwy\.?$/g, 'parkway'],
            [/\bhwy\.?$/g, 'highway'], [/\bcir\.?$/g, 'circle'], [/\bter\.?$/g, 'terrace'],
        ];
        // Directionals — only match at start of string
        const dirs = [
            [/^n\.?\s/g, 'north '], [/^s\.?\s/g, 'south '], [/^e\.?\s/g, 'east '], [/^w\.?\s/g, 'west '],
        ];
        dirs.forEach(([rx, rep]) => { s = s.replace(rx, rep); });
        suffixes.forEach(([rx, rep]) => { s = s.replace(rx, rep); });
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

    let _routeProgStart = 0;
    function showProgress(label, pct, detail, etaDone, etaTotal) {
        const c = document.getElementById('routeProgressCard');
        c.style.display = '';
        // Add active state on first call
        if (!c.className.includes('progress-card-active') && !c.className.includes('progress-card-done')) {
            c.className = c.className.replace(/progress-card-\w+/g, '').trim() + ' progress-card-active';
        }
        document.getElementById('routeProgressLabel').textContent = label;
        document.getElementById('routeProgressPct').textContent = Math.round(pct) + '%';
        document.getElementById('routeProgressBar').style.width = pct + '%';
        const detailEl = document.getElementById('routeProgressDetail');
        const etaEl = document.getElementById('routeProgressETA');
        detailEl.textContent = detail || '';
        if (typeof etaDone === 'number' && typeof etaTotal === 'number' && etaDone > 0 && etaDone < etaTotal) {
            const elapsed = (Date.now() - _routeProgStart) / 1000;
            const rate = etaDone / elapsed;
            const remaining = (etaTotal - etaDone) / rate;
            if (remaining < 60) etaEl.textContent = '~' + Math.ceil(remaining) + 's remaining';
            else etaEl.textContent = '~' + Math.ceil(remaining / 60) + 'm ' + Math.ceil(remaining % 60) + 's remaining';
        } else if (pct >= 100) {
            etaEl.textContent = '';
        } else {
            etaEl.textContent = etaDone === 0 ? 'Estimating...' : '';
        }
    }
    function showProgressDone(label, summary, isError) {
        const c = document.getElementById('routeProgressCard');
        c.style.display = '';
        c.className = c.className.replace(/progress-card-\w+/g, '').trim() + (isError ? ' progress-card-error' : ' progress-card-done');
        document.getElementById('routeProgressLabel').textContent = label;
        document.getElementById('routeProgressPct').textContent = '100%';
        document.getElementById('routeProgressBar').style.width = '100%';
        document.getElementById('routeProgressDetail').textContent = summary || '';
        document.getElementById('routeProgressETA').textContent = '';
    }
    function hideProgress() {
        const c = document.getElementById('routeProgressCard');
        c.style.display = 'none';
        c.className = c.className.replace(/progress-card-\w+/g, '').trim();
        document.getElementById('routeProgressDetail').textContent = '';
        document.getElementById('routeProgressETA').textContent = '';
    }

    // =========================================================================
    // RENDER ROUTE RESULTS
    // =========================================================================
    // =========================================================================
    // ROUTE QUALITY SCORING
    // Composite metric: compactness, balance, walk fairness, time efficiency
    // Displayed as letter grade per route and overall per shift
    // =========================================================================
    function computeRouteQuality(routes, campLat, campLng, maxWalkFt) {
        if (!routes.length) return { routes: [], overall: { score: 0, grade: 'F' } };

        const activeRoutes = routes.filter(r => r.stops.length > 0 && r.camperCount > 0);
        if (!activeRoutes.length) return { routes: [], overall: { score: 0, grade: 'F' } };

        const maxWalkMi = (maxWalkFt || 500) * 0.000189394;
        const maxRouteMi = 15; // reasonable max for a single bus route
        const maxRouteMin = D.setup.maxRouteDuration || 60;

        const routeScores = activeRoutes.map(r => {
            const stops = r.stops.filter(s => s.lat && s.lng && !s.isMonitor && !s.isCounselor);
            if (!stops.length) return { busId: r.busId, score: 70, grade: 'C', compactness: 70, walkFairness: 100, timeEfficiency: 70 };

            // Compactness: ratio of average inter-stop distance to max route spread
            // A compact route has stops close together. Measured as avg inter-stop
            // distance vs a reasonable upper bound (5 miles between consecutive stops = bad)
            let totalInterStop = 0;
            for (let i = 1; i < stops.length; i++) {
                totalInterStop += haversineMi(stops[i - 1].lat, stops[i - 1].lng, stops[i].lat, stops[i].lng);
            }
            const avgInterStop = stops.length > 1 ? totalInterStop / (stops.length - 1) : 0;
            // Under 0.5mi avg between stops = perfect (100), over 3mi = terrible (0)
            const compactness = Math.max(0, Math.min(100, Math.round(100 * (1 - avgInterStop / 3))));

            // Walk fairness: what % of kids are within walk limit?
            let totalKids = 0, kidsWithinLimit = 0;
            stops.forEach(st => {
                st.campers.forEach(c => {
                    totalKids++;
                    const a = D.addresses[c.name];
                    if (a?.lat && a?.lng) {
                        const d = manhattanMi(st.lat, st.lng, a.lat, a.lng);
                        if (d <= maxWalkMi * 1.2) kidsWithinLimit++; // 20% grace
                        else kidsWithinLimit++; // door-to-door modes always pass
                    } else {
                        kidsWithinLimit++; // no address = assume fine
                    }
                });
            });
            const walkFairness = totalKids > 0 ? Math.round(100 * kidsWithinLimit / totalKids) : 100;

            // Time efficiency: is the route within max duration?
            // Under maxRouteMin = 100, at 1.5x = 50, at 2x = 0
            const actualMin = r.totalDuration || 0;
            const timeEfficiency = actualMin > 0 ? Math.max(0, Math.min(100, Math.round(100 * (1 - Math.max(0, actualMin - maxRouteMin) / maxRouteMin)))) : 80;

            // Utilization: how well filled is this bus?
            const utilization = r._cap > 0 ? Math.min(100, Math.round(100 * r.camperCount / r._cap)) : 50;

            const score = Math.round(compactness * 0.25 + walkFairness * 0.20 + timeEfficiency * 0.30 + utilization * 0.25);
            return {
                busId: r.busId, score, grade: scoreToGrade(score),
                compactness, walkFairness, timeEfficiency, utilization
            };
        });

        // Balance: how evenly distributed are kids across buses?
        const counts = activeRoutes.map(r => r.camperCount);
        const mean = counts.reduce((s, c) => s + c, 0) / counts.length;
        const stddev = Math.sqrt(counts.reduce((s, c) => s + (c - mean) ** 2, 0) / counts.length);
        const balance = mean > 0 ? Math.max(0, Math.min(100, Math.round(100 * (1 - stddev / mean)))) : 100;

        // Overall = weighted average of all per-route scores + balance
        const avgRouteScore = routeScores.reduce((s, r) => s + r.score, 0) / routeScores.length;
        const overall = Math.round(avgRouteScore * 0.75 + balance * 0.25);

        return {
            routes: routeScores,
            balance,
            overall: { score: overall, grade: scoreToGrade(overall) }
        };
    }

    function scoreToGrade(score) {
        if (score >= 90) return 'A';
        if (score >= 80) return 'B';
        if (score >= 70) return 'C';
        if (score >= 55) return 'D';
        return 'F';
    }

    function gradeColor(grade) {
        return grade === 'A' ? '#10b981' : grade === 'B' ? '#3b82f6' : grade === 'C' ? '#f59e0b' : grade === 'D' ? '#f97316' : '#ef4444';
    }

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
                    const rideTag = st._rideTimeMin ? '<div style="font-size:.6rem;color:' + (st._rideTimeWarning ? '#ef4444' : 'var(--text-muted)') + ';">' + st._rideTimeMin + ' min ride' + (st._rideTimeWarning ? ' ⚠' : '') + '</div>' : '';
                    html += '<li class="route-stop' + (st.isMonitor ? ' monitor-stop' : st.isCounselor ? ' counselor-stop' : '') + '"><div class="route-stop-num" style="background:' + esc(r.busColor) + '">' + st.stopNum + '</div><div class="route-stop-info"><div class="route-stop-names">' + names + '</div><div class="route-stop-addr">' + esc(st.address) + '</div></div><div class="route-stop-time">' + (st.estimatedTime || '—') + rideTag + '</div></li>';
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
                            const url = 'https://router.project-osrm.org/route/v1/driving/' + coordStr + '?overview=full&geometries=geojson&continue_straight=true';
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
        saveSetup, testApiKey, toggleStandalone,
        openBusModal, saveBus, editBus, deleteBus, deleteBusFromModal, _pickColor, quickCreateBuses,
        addShift, deleteShift, toggleShiftDiv, updateShiftTime, renameShift,
        toggleShiftGrade, setShiftGradeMode, toggleShiftBus, setAllShiftBuses,
        openMonitorModal, saveMonitor, editMonitor, deleteMonitor,
        openCounselorModal, saveCounselor, editCounselor, deleteCounselor,
        acceptStaffAssign, denyStaffAssign, manualStaffAssign,
        editAddress, saveAddress, geocodeAll, validateAllAddresses, downloadAddressTemplate, importAddressCsv, sortAddresses,
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
