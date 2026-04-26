
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

    const ROAD_FACTOR = 1.35; // haversine × road-factor → approximate driving distance

    // =========================================================================
    // STATE
    // =========================================================================
    let D = {
        setup: {
            campAddress: '', campName: '', avgSpeed: 25,
            reserveSeats: 2, dropoffMode: 'door-to-door',
            avgStopTime: 2, maxWalkDistance: 375, maxRouteDuration: 90, maxRideTime: 45,
            googleMapsKey: '', googleProjectId: '',
            geoapifyKey: '',
            campLat: null, campLng: null,
            // Neighborhood mode uses the OSM road graph to cluster campers by
            // shared road segments (which arterials they share, which streets
            // are connected). Spatial-sort uses lat/lng k-means, which
            // produces wedges that mix campers across natural neighborhood
            // boundaries — e.g. lumping Whitesville Rd corridor with interior
            // Toms River streets, even though those routes don't share any
            // common driving path. Camp's reference output groups by
            // neighborhood/arterial, so default to that.
            routingPipeline: 'neighborhood',
            clusterSoftCapPct: 112, clusterDissolvePct: 55, clusterFloorPct: 30,
            clusterSpreadRatio: 150, clusterMaxSpreadMi: 3.5
        },
        activeMode: 'dismissal',
        buses: [], shifts: [], monitors: [], counselors: [],
        savedRoutes: null, dismissal: null, arrival: null,
        addresses: {}
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

    /**
     * drivingDist — the universal distance function.
     * Returns driving duration in SECONDS between two points.
     * Uses haversine × ROAD_FACTOR approximation.
     *
     * Use drivingDistMi() for miles (approximate).
     */
    function drivingDist(lat1, lng1, lat2, lng2) {
        if (!lat1 || !lng1 || !lat2 || !lng2) return Infinity;
        if (Math.abs(lat1 - lat2) < 1e-5 && Math.abs(lng1 - lng2) < 1e-5) return 0;
        const avgSpeedMph = D.setup.avgSpeed || 25;
        return (haversineMi(lat1, lng1, lat2, lng2) * ROAD_FACTOR / avgSpeedMph) * 3600;
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
    // SMART CLUSTERING ENGINE
    // Street-aware distance, major road barriers, capacity caps
    // =========================================================================

    // =========================================================================
    // DIRECTIONAL HELPERS — used by all code paths that order/insert stops
    // All use drivingDist (driving seconds) for ordering, not haversine.
    // =========================================================================

    /**
     * Order stops using nearest-neighbor TSP heuristic + 2-opt improvement.
     *
     * Much better than the old 1D distance-from-camp sort, which produced
     * routes that zigzagged (skipping a nearby stop, driving far away, then
     * looping back). NN always moves to the closest unvisited stop, producing
     * a coherent path with no unnecessary doubling-back.
     *
     * Dismissal: camp → nearest unvisited → ... → farthest stop
     * Arrival:   reversed (bus starts farthest, works back toward camp)
     *
     * 2-opt sweeps remove remaining crossing segments (runs up to 3 passes,
     * fast for the typical 8-20 stops per bus).
     */
    function directionalSort(stops, campLat, campLng) {
        if (stops.length < 2) { stops.forEach((s, i) => { s.stopNum = i + 1; }); return; }
        const isArr = D.activeMode === 'arrival';

        // ── Nearest-neighbor heuristic (start from camp) ──
        const visited = new Array(stops.length).fill(false);
        const order = [];
        let curLat = campLat, curLng = campLng;

        for (let step = 0; step < stops.length; step++) {
            let bestI = -1, bestD = Infinity;
            for (let i = 0; i < stops.length; i++) {
                if (visited[i]) continue;
                const s = stops[i];
                if (!s.lat || !s.lng) { if (bestI < 0) bestI = i; continue; }
                const d = drivingDist(curLat, curLng, s.lat, s.lng);
                if (d < bestD) { bestD = d; bestI = i; }
            }
            if (bestI < 0) break;
            visited[bestI] = true;
            order.push(bestI);
            curLat = stops[bestI].lat || curLat;
            curLng = stops[bestI].lng || curLng;
        }

        // Arrival: bus picks up from farthest point → toward camp, so reverse
        if (isArr) order.reverse();

        // Rearrange stops in-place according to NN order
        const orig = stops.slice();
        for (let i = 0; i < order.length; i++) {
            stops[i] = orig[order[i]];
            stops[i].stopNum = i + 1;
        }

        // ── 2-opt improvement (up to 3 passes) ──
        // Reverses sub-sequences that would shorten the total path.
        // Eliminates crossing segments that NN can introduce.
        for (let pass = 0; pass < 3; pass++) {
            let improved = false;
            for (let i = 0; i < stops.length - 1; i++) {
                for (let j = i + 1; j < stops.length; j++) {
                    const sA = stops[i], sB = stops[j];
                    if (!sA.lat || !sB.lat) continue;
                    const prevLat = i === 0 ? campLat : (stops[i - 1].lat || campLat);
                    const prevLng = i === 0 ? campLng : (stops[i - 1].lng || campLng);
                    const nextLat = j === stops.length - 1 ? campLat : (stops[j + 1].lat || campLat);
                    const nextLng = j === stops.length - 1 ? campLng : (stops[j + 1].lng || campLng);
                    const before = drivingDist(prevLat, prevLng, sA.lat, sA.lng) +
                                   drivingDist(sB.lat, sB.lng, nextLat, nextLng);
                    const after  = drivingDist(prevLat, prevLng, sB.lat, sB.lng) +
                                   drivingDist(sA.lat, sA.lng, nextLat, nextLng);
                    if (after < before * 0.99) { // accept 1%+ improvement
                        // Reverse stops[i..j]
                        let lo = i, hi = j;
                        while (lo < hi) { const t = stops[lo]; stops[lo] = stops[hi]; stops[hi] = t; lo++; hi--; }
                        stops.forEach((s, idx) => { s.stopNum = idx + 1; });
                        improved = true;
                    }
                }
            }
            if (!improved) break;
        }
        stops.forEach((s, i) => { s.stopNum = i + 1; });
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
    let _majorRoadsBboxKey = null; // cache key so we don't refetch within a session

    /** Standalone fetch of just the major-roads layer for clustering use.
     *  Mirrors the major-roads query in fetchIntersections but doesn't
     *  also fetch the larger intersection set. Sets _majorRoadSegments. */
    async function _prefetchMajorRoads(campers) {
        const lats = campers.map(c => c.lat).filter(Boolean).sort((a, b) => a - b);
        const lngs = campers.map(c => c.lng).filter(Boolean).sort((a, b) => a - b);
        if (lats.length < 4 || lngs.length < 4) return;
        const q1Lat = lats[Math.floor(lats.length * 0.25)], q3Lat = lats[Math.floor(lats.length * 0.75)];
        const q1Lng = lngs[Math.floor(lngs.length * 0.25)], q3Lng = lngs[Math.floor(lngs.length * 0.75)];
        const iqrLat = q3Lat - q1Lat, iqrLng = q3Lng - q1Lng;
        const cleanLats = lats.filter(v => v >= q1Lat - 1.5*iqrLat && v <= q3Lat + 1.5*iqrLat);
        const cleanLngs = lngs.filter(v => v >= q1Lng - 1.5*iqrLng && v <= q3Lng + 1.5*iqrLng);
        if (cleanLats.length < 2 || cleanLngs.length < 2) return;
        const buf = 0.012;
        const minLat = cleanLats[0] - buf, maxLat = cleanLats[cleanLats.length-1] + buf;
        const minLng = cleanLngs[0] - buf, maxLng = cleanLngs[cleanLngs.length-1] + buf;
        const bboxKey = [minLat, minLng, maxLat, maxLng].map(v => v.toFixed(3)).join(',');
        if (_majorRoadsBboxKey === bboxKey && _majorRoadSegments) return;
        const bbox = minLat + ',' + minLng + ',' + maxLat + ',' + maxLng;
        const query = '[out:json][timeout:25];' +
            'way["highway"~"^(primary|secondary|trunk|tertiary)$"]["name"](' + bbox + ');' +
            'out body;>;out skel qt;';
        const endpoints = [
            '/api/overpass',
            'https://overpass-api.de/api/interpreter',
            'https://overpass.kumi.systems/api/interpreter'
        ];
        for (const url of endpoints) {
            try {
                const ctrl = new AbortController();
                const t = setTimeout(() => ctrl.abort(), 15000);
                const r = await fetch(url + '?data=' + encodeURIComponent(query), { signal: ctrl.signal });
                clearTimeout(t);
                if (!r.ok) continue;
                const data = await r.json();
                if (!data?.elements?.length) continue;
                const nodes = {};
                data.elements.filter(e => e.type === 'node' && e.lat && e.lon)
                    .forEach(e => { nodes[e.id] = { lat: e.lat, lng: e.lon }; });
                const segs = [];
                data.elements.filter(e => e.type === 'way' && e.nodes?.length >= 2).forEach(way => {
                    const name = way.tags?.name || '';
                    for (let i = 0; i < way.nodes.length - 1; i++) {
                        const a = nodes[way.nodes[i]], b = nodes[way.nodes[i+1]];
                        if (a && b) segs.push({ lat1: a.lat, lng1: a.lng, lat2: b.lat, lng2: b.lng, name });
                    }
                });
                _majorRoadSegments = segs;
                _majorRoadsBboxKey = bboxKey;
                console.log('[Go v6] Prefetched ' + segs.length + ' major road segments for clustering');
                return;
            } catch (_) { continue; }
        }
        console.warn('[Go v6] Could not prefetch major roads — clustering will use plain spread');
    }

    /** For each atom, find the closest major-road name within ~0.25mi. Returns Map(atom→name|null). */
    function _buildArterialFingerprints(atoms) {
        const fingerprint = new Map();
        if (!_majorRoadSegments || !_majorRoadSegments.length) {
            atoms.forEach(a => fingerprint.set(a, null));
            return fingerprint;
        }
        const MAX_MI = 0.25;
        // Precompute segment midpoints for cheap haversine pre-filter
        for (const atom of atoms) {
            let bestName = null, bestD = MAX_MI;
            for (const seg of _majorRoadSegments) {
                if (!seg.name) continue;
                const midLat = (seg.lat1 + seg.lat2) / 2;
                const midLng = (seg.lng1 + seg.lng2) / 2;
                const d = haversineMi(atom.lat, atom.lng, midLat, midLng);
                if (d < bestD) { bestD = d; bestName = seg.name.toLowerCase(); }
            }
            fingerprint.set(atom, bestName);
        }
        return fingerprint;
    }

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
        // 3. If camp location known, hard limit 30 miles (was 100 — too loose for urban camps)
        if (_campCoordsCache) {
            const dist = haversineMi(_campCoordsCache.lat, _campCoordsCache.lng, lat, lng);
            if (dist > 30) {
                console.warn('[Go] Geocode rejected for ' + camperName + ': ' + dist.toFixed(0) + 'mi from camp (max 30)');
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
        // 5. ZIP mismatch — reject if confidence is not high enough to trust a cross-ZIP match
        if (addrData?.zip && returnedResult?.zip) {
            const inputZip = addrData.zip.substring(0, 5);
            const returnedZip = (returnedResult.zip + '').substring(0, 5);
            if (inputZip && returnedZip && inputZip !== returnedZip) {
                const conf = returnedResult.confidence || 0;
                if (conf < 0.75) {
                    // Low-confidence cross-ZIP result — likely matched a different street in a neighboring ZIP
                    console.warn('[Go] Geocode REJECTED for ' + camperName + ': ZIP mismatch (' + inputZip + ' vs ' + returnedZip + ') at confidence ' + (conf * 100).toFixed(0) + '% < 75%');
                    return false;
                }
                console.warn('[Go] Geocode ZIP mismatch for ' + camperName + ': input ' + inputZip + ' vs returned ' + returnedZip + ' — accepting at ' + (conf * 100).toFixed(0) + '% confidence');
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
        let total = Math.round(totalMin);
        let h = Math.floor(total / 60), m = total % 60;
        if (m === 60) { m = 0; h += 1; }
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

            // One-time migration: spatial-sort → neighborhood. Spatial-sort was
            // the default before we recognized it produced wedges that mix
            // corridors. Existing users have 'spatial-sort' saved from when
            // it was the default; upgrade them so they get road-graph-aware
            // clustering. Users who explicitly chose spatial-sort can flip
            // back via settings; this migration only runs once.
            if (D.setup && D.setup.routingPipeline === 'spatial-sort' &&
                !D.setup._pipelineMigrated_v1) {
                D.setup.routingPipeline = 'neighborhood';
                D.setup._pipelineMigrated_v1 = true;
                console.log('[Go] Upgraded routing pipeline: spatial-sort → neighborhood ' +
                    '(road-graph aware). Set routingPipeline back to spatial-sort to revert.');
            }
            // One-time migration: maxRouteDuration 60 → 90. The 60-min cap was
            // too tight for hard geographic clusters (camp's MAROON runs 71min
            // with 24mi distance), causing the solver to drop stops via
            // cheapest-insert and produce 100+min routes. Bumping to 90 lets
            // the solver finish naturally; tight clusters still come in well
            // under 90 (camp's typical is 30-50min).
            if (D.setup && D.setup.maxRouteDuration === 60 &&
                !D.setup._maxRouteDurationMigrated_v1) {
                D.setup.maxRouteDuration = 90;
                D.setup._maxRouteDurationMigrated_v1 = true;
                console.log('[Go] Upgraded maxRouteDuration: 60 → 90 min ' +
                    '(prevents solver from dropping stops on hard clusters). ' +
                    'Set back to 60 in settings to revert.');
            }

            // Recover geocoding checkpoint: if the tab was closed mid-geocode,
            // the checkpoint key has more geocodes than the main store.
            try {
                const ckptRaw = localStorage.getItem(STORE + '_addr_ckpt');
                if (ckptRaw) {
                    const ckpt = JSON.parse(ckptRaw);
                    const ckptGeocoded = Object.values(ckpt).filter(a => a.geocoded).length;
                    const mainGeocoded = Object.values(D.addresses || {}).filter(a => a.geocoded).length;
                    if (ckptGeocoded > mainGeocoded) {
                        D.addresses = ckpt;
                        console.log('[Go] Recovered geocode checkpoint (' + ckptGeocoded + ' geocoded vs ' + mainGeocoded + ' in main store)');
                    }
                    localStorage.removeItem(STORE + '_addr_ckpt');
                }
            } catch (_) {}
        } catch (e) { console.error('[Go] Load error:', e); }
    }

    // -------------------------------------------------------------------------
    // fetchGoConfig() — loads API keys from Supabase secrets via get-config
    // edge function. Keys are injected into D.setup at runtime only — they are
    // NEVER saved to localStorage, globalSettings, or the cloud table.
    // Called after auth is confirmed (campistry-cloud-hydrated + 1.5s fallback).
    // -------------------------------------------------------------------------
    async function fetchGoConfig() {
        const cfg = window.__CAMPISTRY_SUPABASE__;
        if (!cfg?.url || !cfg?.anonKey) return; // Supabase not wired in
        try {
            const sess = await window.supabase?.auth?.getSession?.();
            const token = sess?.data?.session?.access_token;
            if (!token) return; // Not logged in — skip

            const resp = await fetch(cfg.url + '/functions/v1/get-config', {
                headers: {
                    'Authorization': 'Bearer ' + token,
                    'apikey': cfg.anonKey
                }
            });
            if (!resp.ok) {
                console.warn('[Go] fetchGoConfig: HTTP', resp.status);
                return;
            }
            const config = await resp.json();

            // Inject keys into D.setup (runtime only — not persisted)
            if (config.googleMapsKey)  D.setup.googleMapsKey  = config.googleMapsKey;
            if (config.geoapifyKey)    D.setup.geoapifyKey    = config.geoapifyKey;
            if (config.googleProjectId) D.setup.googleProjectId = config.googleProjectId;
            if (config.orsKey) {
                D.setup.orsKey = config.orsKey;
                window.__CAMPISTRY_ORS_KEY__ = config.orsKey;
            }

            console.log('[Go] Config loaded from Supabase secrets — keys:', [
                config.googleMapsKey  ? 'googleMaps ✅'  : 'googleMaps ❌',
                config.geoapifyKey    ? 'geoapify ✅'    : 'geoapify ❌',
                config.googleProjectId ? 'projectId ✅'  : 'projectId ❌'
            ].join(', '));
        } catch (e) {
            console.warn('[Go] fetchGoConfig error:', e.message);
        }
    }

    // -------------------------------------------------------------------------
    // loadGoCloudData() — async supplement to load()
    // Fetches addresses and routes from the go_standalone_data table.
    // Called after campistry-cloud-hydrated fires (and optionally on init).
    // Merges only fields that are currently empty so it never overwrites
    // data the user just entered.
    // -------------------------------------------------------------------------
    async function loadGoCloudData() {
        if (!window.GoCloudSync) return;
        try {
            const cloud = await window.GoCloudSync.loadAll();
            if (!cloud) return;

            let changed = false;

            // ── Restore full state (setup, buses, shifts, monitors, counselors) ─
            // Only hydrates fields that are empty/default locally so we never
            // overwrite data the user just entered.
            if (cloud.state && typeof cloud.state === 'object') {
                const s = cloud.state;

                // Setup: restore if local campName is empty but cloud has one
                if (s.setup && !D.setup.campName && s.setup.campName) {
                    D.setup = Object.assign({}, D.setup, s.setup);
                    changed = true;
                    console.log('[Go] Restored setup from GoCloud (campName:', s.setup.campName + ')');
                }

                // Fleet config: restore if local is empty
                if (!D.buses?.length && s.buses?.length) {
                    D.buses = s.buses;
                    changed = true;
                    console.log('[Go] Restored', s.buses.length, 'buses from GoCloud');
                }
                if (!D.shifts?.length && s.shifts?.length) {
                    D.shifts = s.shifts;
                    changed = true;
                }
                if (!D.monitors?.length && s.monitors?.length) {
                    D.monitors = s.monitors;
                    changed = true;
                }
                if (!D.counselors?.length && s.counselors?.length) {
                    D.counselors = s.counselors;
                    changed = true;
                }

                // Mode snapshots
                if (s.dismissal && (!D.dismissal || !D.dismissal.buses?.length)) {
                    D.dismissal = Object.assign(D.dismissal || {}, s.dismissal);
                    changed = true;
                }
                if (s.arrival && (!D.arrival || !D.arrival.buses?.length)) {
                    D.arrival = Object.assign(D.arrival || {}, s.arrival);
                    changed = true;
                }

            }

            // ── Restore addresses ─────────────────────────────────────────────
            if (cloud.addresses && typeof cloud.addresses === 'object') {
                const localCount = Object.keys(D.addresses || {}).length;
                const cloudCount = Object.keys(cloud.addresses).length;
                if (cloudCount > localCount) {
                    // Cloud has more addresses — merge (cloud wins for matching keys)
                    D.addresses = Object.assign({}, D.addresses || {}, cloud.addresses);
                    changed = true;
                    console.log('[Go] Restored', cloudCount, 'addresses from GoCloud');
                }
            }

            // ── Restore routes ────────────────────────────────────────────────
            if (cloud.routes && typeof cloud.routes === 'object') {
                if (!D.savedRoutes && cloud.routes.savedRoutes) {
                    D.savedRoutes = cloud.routes.savedRoutes;
                    changed = true;
                    console.log('[Go] Restored savedRoutes from GoCloud');
                }
                if (D.dismissal && !D.dismissal.savedRoutes && cloud.routes.dismissalRoutes) {
                    D.dismissal.savedRoutes = cloud.routes.dismissalRoutes;
                    changed = true;
                }
                if (D.arrival && !D.arrival.savedRoutes && cloud.routes.arrivalRoutes) {
                    D.arrival.savedRoutes = cloud.routes.arrivalRoutes;
                    changed = true;
                }
                if (changed && (cloud.routes.savedRoutes || cloud.routes.dismissalRoutes)) {
                    _generatedRoutes = D.savedRoutes;
                    console.log('[Go] Restored routes from GoCloud — re-rendering');
                }
            }

            if (changed) {
                // Persist the restored data to localStorage so subsequent
                // sync loads find it without another round-trip
                try { localStorage.setItem(STORE, JSON.stringify(D)); } catch (_) {}
                renderFleet();
                renderShifts();
                renderStaff();
                renderAddresses();
                updateStats();
                populateSetup();
                if (D.savedRoutes && D.savedRoutes.length) {
                    setTimeout(() => { renderRouteResults(D.savedRoutes); toast('Routes restored from cloud'); }, 200);
                }
            }
        } catch (e) {
            console.error('[Go] loadGoCloudData error:', e);
        }
    }

    function merge(d) {
        const def = { setup: { campAddress:'',campName:'',avgSpeed:25,reserveSeats:2,dropoffMode:'door-to-door',avgStopTime:2,maxWalkDistance:375,googleMapsKey:'',googleProjectId:'',geoapifyKey:'',campLat:null,campLng:null,standaloneMode:false }, activeMode:'dismissal', buses:[], shifts:[], monitors:[], counselors:[], addresses:{}, savedRoutes:null, dismissal:null, arrival:null };
        const result = { setup: { ...def.setup, ...(d.setup || {}) }, activeMode: d.activeMode || 'dismissal', buses: d.buses || [], shifts: d.shifts || [], monitors: d.monitors || [], counselors: d.counselors || [], addresses: d.addresses || {}, savedRoutes: d.savedRoutes || null, dismissal: d.dismissal || null, arrival: d.arrival || null };
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
            // Sync to global settings without any route data (too large for localStorage quota).
            // Road geometry (_roadPts) alone can be several MB — strip all savedRoutes
            // from every mode before writing to globalSettings / localStorage.
            if (typeof window.saveGlobalSettings === 'function') {
                const lite = Object.assign({}, D);
                delete lite.savedRoutes;
                if (lite.dismissal) { lite.dismissal = Object.assign({}, lite.dismissal); delete lite.dismissal.savedRoutes; }
                if (lite.arrival)   { lite.arrival   = Object.assign({}, lite.arrival);   delete lite.arrival.savedRoutes;   }
                window.saveGlobalSettings('campistryGo', lite);
            }
            // ── Go-specific cloud persistence ─────────────────────────────────
            // ALL Campistry Go data is saved to the go_standalone_data table so
            // it survives cache clears / new devices / non-standalone mode.
            // standaloneMode only controls WHERE camper+staff data comes from
            // (Campistry Me vs manual/CSV) — it does NOT affect cloud saves.
            //
            // Data types saved:
            //   'state'     — setup, buses, shifts, monitors, counselors (all modes)
            //   'addresses' — geocoded camper addresses (large; kept separate)
            //   'routes'    — computed route results (large; kept separate)
            if (window.GoCloudSync) {
                // ── State: setup + fleet config for both modes ────────────────
                // Snapshot the current mode's live data back into D[activeMode]
                // before saving so the cloud copy is always up-to-date.
                const _currentModeSnap = {
                    buses:      D.buses      || [],
                    shifts:     D.shifts     || [],
                    monitors:   D.monitors   || [],
                    counselors: D.counselors || []
                };
                // Strip runtime-only API keys — these come from Supabase secrets
                // via fetchGoConfig() and must never be written back to the DB.
                const _setupForCloud = Object.assign({}, D.setup);
                delete _setupForCloud.googleMapsKey;
                delete _setupForCloud.googleProjectId;
                delete _setupForCloud.geoapifyKey;

                const stateSnap = {
                    setup:       _setupForCloud,
                    activeMode:  D.activeMode,
                    buses:       D.buses      || [],
                    shifts:      D.shifts     || [],
                    monitors:    D.monitors   || [],
                    counselors:  D.counselors || [],
                    dismissal: D.dismissal ? {
                        buses:      D.activeMode === 'dismissal' ? _currentModeSnap.buses      : (D.dismissal.buses      || []),
                        shifts:     D.activeMode === 'dismissal' ? _currentModeSnap.shifts     : (D.dismissal.shifts     || []),
                        monitors:   D.activeMode === 'dismissal' ? _currentModeSnap.monitors   : (D.dismissal.monitors   || []),
                        counselors: D.activeMode === 'dismissal' ? _currentModeSnap.counselors : (D.dismissal.counselors || [])
                    } : null,
                    arrival: D.arrival ? {
                        buses:      D.activeMode === 'arrival' ? _currentModeSnap.buses      : (D.arrival.buses      || []),
                        shifts:     D.activeMode === 'arrival' ? _currentModeSnap.shifts     : (D.arrival.shifts     || []),
                        monitors:   D.activeMode === 'arrival' ? _currentModeSnap.monitors   : (D.arrival.monitors   || []),
                        counselors: D.activeMode === 'arrival' ? _currentModeSnap.counselors : (D.arrival.counselors || [])
                    } : null,
                };
                window.GoCloudSync.save('state', stateSnap);

                // ── Addresses: save whenever there is at least one entry ───────
                if (D.addresses && Object.keys(D.addresses).length > 0) {
                    window.GoCloudSync.save('addresses', D.addresses);
                }
                // ── Routes: save dismissal + arrival savedRoutes together ──────
                const routePayload = {
                    savedRoutes:     D.savedRoutes            || null,
                    dismissalRoutes: D.dismissal?.savedRoutes || null,
                    arrivalRoutes:   D.arrival?.savedRoutes   || null
                };
                if (routePayload.savedRoutes || routePayload.dismissalRoutes || routePayload.arrivalRoutes) {
                    window.GoCloudSync.save('routes', routePayload);
                }
            }
            // ─────────────────────────────────────────────────────────────────
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
        if (D.savedRoutes) { renderRouteResults(D.savedRoutes); }
        else { document.getElementById('routeResults').style.display = 'none'; document.getElementById('shiftResultsContainer').innerHTML = ''; }
        toast('Switched to ' + (mode === 'arrival' ? 'Arrival' : 'Dismissal') + ' mode');
    }

    // =========================================================================
    // CAPACITY WARNINGS
    // =========================================================================
    function getCapacityWarnings() {
        if (!_generatedRoutes) return [];
        const applied = _generatedRoutes;
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
            // Skip staff — they're tracked in D.monitors/D.counselors, not the camper roster
            if (a._isStaff) return;
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
        if (document.getElementById('clusterSoftCapPct')) document.getElementById('clusterSoftCapPct').value = s.clusterSoftCapPct ?? 112;
        if (document.getElementById('clusterDissolvePct')) document.getElementById('clusterDissolvePct').value = s.clusterDissolvePct ?? 55;
        if (document.getElementById('clusterFloorPct')) document.getElementById('clusterFloorPct').value = s.clusterFloorPct ?? 30;
        if (document.getElementById('clusterSpreadRatio')) document.getElementById('clusterSpreadRatio').value = s.clusterSpreadRatio ?? 150;
        window._GoSetup = () => D.setup;
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
        D.setup.clusterSoftCapPct = parseInt(el('clusterSoftCapPct')?.value) || 112;
        D.setup.clusterDissolvePct = parseInt(el('clusterDissolvePct')?.value) || 55;
        D.setup.clusterFloorPct = parseInt(el('clusterFloorPct')?.value) || 30;
        D.setup.clusterSpreadRatio = parseInt(el('clusterSpreadRatio')?.value) || 150;
        window._GoSetup = () => D.setup;
        save(); toast('Setup saved');
    }

    // ── Google Route Optimization connection test ──────────────────────────────
    (function () {
        const btn = document.getElementById('btnTestGoogleProxy');
        const box = document.getElementById('googleProxyStatus');
        if (!btn || !box) return;

        btn.addEventListener('click', async function () {
            btn.disabled = true;
            btn.textContent = '⏳ Testing...';
            box.style.display = 'block';
            box.textContent = 'Connecting to Supabase edge function…';

            const supabaseUrl = window.__CAMPISTRY_SUPABASE__?.url || '';
            const anonKey    = window.__CAMPISTRY_SUPABASE__?.anonKey || '';
            let token = null;
            try {
                const sess = await window.supabase?.auth?.getSession();
                token = sess?.data?.session?.access_token || anonKey || null;
            } catch (_) { token = anonKey || null; }

            const lines = [];

            // Step 1: Supabase session
            if (supabaseUrl && token) {
                lines.push('✅ Supabase: connected');
            } else if (!supabaseUrl) {
                lines.push('❌ Supabase URL not found');
                finish(false, lines); return;
            } else {
                lines.push('❌ No auth token available');
                finish(false, lines); return;
            }

            // Step 2: Call edge function health check
            lines.push('🔄 Calling edge function health check…');
            box.textContent = lines.join('\n');
            try {
                const resp = await fetch(supabaseUrl + '/functions/v1/optimize-routes', {
                    method: 'GET',
                    headers: {
                        'Authorization': 'Bearer ' + token,
                        'apikey': anonKey
                    }
                });
                const data = await resp.json();

                if (data.checks) {
                    Object.entries(data.checks).forEach(([k, v]) => lines.push(v + '  (' + k + ')'));
                }

                if (data.ok) {
                    lines.push('');
                    lines.push('🎉 All good! Google Route Optimization is ready.');
                    lines.push('   Project: ' + (data.projectId || 'unknown'));
                    finish(true, lines);
                } else {
                    lines.push('');
                    lines.push('⚠️  Fix the issues above, then re-deploy the edge function.');
                    finish(false, lines);
                }
            } catch (e) {
                lines.push('❌ Could not reach edge function: ' + e.message);
                lines.push('   Make sure it is deployed in Supabase → Edge Functions.');
                finish(false, lines);
            }

            function finish(ok, lines) {
                box.textContent = lines.join('\n');
                box.style.borderColor = ok ? '#22c55e' : '#ef4444';
                btn.disabled = false;
                btn.textContent = '🔍 Test Google Connection';
            }
        });
    })();

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
    function renderStaff() {
        renderMonitors(); renderCounselors();
        document.getElementById('staffCount').textContent = (D.monitors.length + D.counselors.length) + ' staff';
        // Show "Accept All" button only when there are pending suggestions
        const pending = [...D.monitors, ...D.counselors].some(s =>
            s._suggestedBusId && s._assignStatus !== 'accepted' && s._assignStatus !== 'denied'
        );
        const btn = document.getElementById('acceptAllStaffBtn');
        if (btn) btn.style.display = pending ? '' : 'none';
    }
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
            const suggestionHtml = _staffSuggestionHtml(c, 'counselor');
            const idCol = c._personId ? '<td style="font-size:.8rem;color:var(--text-muted)">' + c._personId + '</td>' : '<td style="color:var(--text-muted)">—</td>';
            const geoBadge = _staffGeoBadge(c);
            return '<tr style="cursor:pointer" onclick="CampistryGo.editCounselor(\'' + c.id + '\')">' + idCol + '<td>' + esc(c.lastName || '') + '</td><td style="font-weight:600">' + esc(c.firstName || c.name) + '</td><td>' + (esc(c.address) || '—') + '</td><td>' + geoBadge + '</td><td>' + (esc(c.bunk) || '—') + '</td><td>' + modeBadge + suggestionHtml + '</td><td>' + (c._walkFt ? c._walkFt + 'ft' : '—') + '</td></tr>';
        }).join('');
    }

    // ── Staff assignment actions ──
    function acceptAllStaffSuggestions() {
        let accepted = 0;
        const all = [
            ...D.monitors.map(m => ({ staff: m, type: 'monitor' })),
            ...D.counselors.map(c => ({ staff: c, type: 'counselor' }))
        ];
        for (const { staff } of all) {
            if (!staff._suggestedBusId) continue;
            if (staff._assignStatus === 'accepted' || staff._assignStatus === 'denied') continue;
            staff._assignStatus = 'accepted';
            staff._acceptedBus = staff._suggestedBus;
            staff._acceptedBusId = staff._suggestedBusId;
            staff._acceptedStop = staff._suggestedStop;
            staff._acceptedStopNum = staff._suggestedStopNum;
            staff.assignedBus = staff._suggestedBusId;
            accepted++;
        }
        if (!accepted) { toast('No pending suggestions to accept'); return; }
        save(); renderStaff();
        toast('Accepted ' + accepted + ' staff suggestion' + (accepted > 1 ? 's' : ''));
    }

    // ── Capacity check helper ────────────────────────────────────────────────
    // Returns how many seats over capacity a bus will be AFTER adding one more
    // staff member. Positive = over capacity.
    function _capacityAfterStaffAdd(busId) {
        const bus = D.buses.find(b => b.id === busId);
        if (!bus) return 0;
        const brs    = getBusReserve(bus);
        const mon    = D.monitors.find(m => m.assignedBus === busId);
        const couns  = D.counselors.filter(c => c.assignedBus === busId);
        // +1 accounts for the staff member we're about to add
        const usedByStaff = (mon ? 1 : 0) + couns.length + 1 + brs;
        const maxCampers  = Math.max(0, (bus.capacity || 0) - usedByStaff);
        let camperCount   = 0;
        (D.savedRoutes || []).forEach(sr => {
            const r = (sr.routes || []).find(r => r.busId === busId);
            if (r) camperCount += r.camperCount || 0;
        });
        return { overBy: camperCount - maxCampers, camperCount, maxCampers, busName: bus.name };
    }

    // ── Commit a staff assignment and refresh the UI ─────────────────────────
    function _commitStaffAssign(staff, busId, busName, stopAddr, stopNum) {
        staff._assignStatus  = 'accepted';
        staff._acceptedBus   = busName;
        staff._acceptedBusId = busId;
        staff._acceptedStop  = stopAddr;
        staff._acceptedStopNum = stopNum;
        staff.assignedBus    = busId;
        save();
        renderStaff();
        // Re-render routes so capacity badges + stop lists reflect the new assignment
        if (typeof CampistryGo !== 'undefined' && CampistryGo._refreshRoutes) {
            CampistryGo._refreshRoutes();
        }
        toast(staff.name + ' confirmed on ' + busName);
    }

    // ── Overcapacity warning modal ───────────────────────────────────────────
    function _showCapacityWarning(staff, type, busId, busName, stopAddr, stopNum, overBy) {
        const existing = document.getElementById('staffCapWarningModal');
        if (existing) existing.remove();
        const overlay = document.createElement('div');
        overlay.id = 'staffCapWarningModal';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;';
        overlay.innerHTML = '<div class="modal" style="max-width:400px;padding:1.5rem;">'
            + '<h3 style="margin:0 0 .75rem;color:var(--red-600);">⚠ Bus Over Capacity</h3>'
            + '<p style="margin:0 0 1.25rem;line-height:1.5;">Adding <strong>' + esc(staff.name) + '</strong> to <strong>' + esc(busName) + '</strong> will put it <strong>' + overBy + ' seat' + (overBy > 1 ? 's' : '') + ' over capacity</strong>.</p>'
            + '<div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;">'
            + '<button class="btn btn-secondary" id="scwCancel">Cancel</button>'
            + '<button class="btn btn-secondary" id="scwManual">Choose Different Bus</button>'
            + '<button class="btn btn-danger" id="scwForce">Force Anyway</button>'
            + '</div></div>';
        document.body.appendChild(overlay);

        overlay.querySelector('#scwCancel').onclick  = () => overlay.remove();
        overlay.querySelector('#scwForce').onclick   = () => { overlay.remove(); _commitStaffAssign(staff, busId, busName, stopAddr, stopNum); };
        overlay.querySelector('#scwManual').onclick  = () => { overlay.remove(); manualStaffAssign(staff.id, type); };
    }

    function acceptStaffAssign(staffId, type) {
        const staff = type === 'monitor' ? D.monitors.find(m => m.id === staffId) : D.counselors.find(c => c.id === staffId);
        if (!staff || !staff._suggestedBusId) return;

        const cap = _capacityAfterStaffAdd(staff._suggestedBusId);
        if (cap.overBy > 0) {
            _showCapacityWarning(staff, type,
                staff._suggestedBusId, staff._suggestedBus,
                staff._suggestedStop, staff._suggestedStopNum,
                cap.overBy);
            return;
        }
        _commitStaffAssign(staff, staff._suggestedBusId, staff._suggestedBus, staff._suggestedStop, staff._suggestedStopNum);
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

            // Capacity check before committing
            const cap = _capacityAfterStaffAdd(busId);
            if (cap.overBy > 0) {
                overlay.remove();
                _showCapacityWarning(staff, type, busId, bus?.name || '', stopAddr, stopNum, cap.overBy);
                return;
            }

            overlay.remove();
            _commitStaffAssign(staff, busId, bus?.name || '', stopAddr, stopNum);
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
            else if (sc === 'bunk') {
                var ai = parseInt(a.bunk, 10), bi = parseInt(b.bunk, 10);
                av = isNaN(ai) ? (a.bunk || '').toLowerCase() : ai;
                bv = isNaN(bi) ? (b.bunk || '').toLowerCase() : bi;
                if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
                if (typeof av === 'number') return -1 * dir;
                if (typeof bv === 'number') return 1 * dir;
            }
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
            const safeName = esc(r.name.replace(/'/g, "\\'"));
            const deleteBtn = r.hasAddr ? '<button class="btn btn-ghost btn-sm" onclick="if(confirm(\'Delete address for ' + safeName + '?\'))CampistryGo._quickDeleteAddress(\'' + safeName + '\')" title="Delete address" style="color:var(--danger,#ef4444);font-size:.75rem;">🗑</button>' : '';
            return '<tr><td style="font-size:.75rem;color:var(--text-muted);font-family:monospace;">' + (r.id ? '#' + String(r.id).padStart(4, '0') : '') + '</td><td style="font-weight:600">' + esc(r.last) + '</td><td>' + esc(r.first) + '</td><td>' + (esc(r.division) || '—') + '</td><td>' + (esc(r.grade) || '—') + '</td><td>' + (esc(r.bunk) || '—') + '</td><td>' + (full ? esc(full) : '<span style="color:var(--text-muted)">No address</span>') + '</td><td>' + badge + '</td><td><div style="display:flex;gap:4px;"><button class="btn btn-ghost btn-sm" onclick="CampistryGo.editAddress(\'' + safeName + '\')">' + (r.hasAddr ? 'Edit' : 'Add') + '</button>' + (r.geocoded ? '<button class="btn btn-ghost btn-sm" onclick="CampistryGo.locateCamper(\'' + safeName + '\')" title="Show on map" style="font-size:.7rem;">📍</button>' : '') + deleteBtn + '</div></td></tr>';
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
        const deleteBtn = document.getElementById('addrDeleteBtn');
        if (deleteBtn) deleteBtn.style.display = D.addresses[name] ? 'inline-flex' : 'none';
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
    function deleteAddress() {
        if (!_editCamper) return;
        if (!confirm('Delete all address data for ' + _editCamper + '?\n\nThis cannot be undone.')) return;
        delete D.addresses[_editCamper];
        save(); closeModal('addressModal'); renderAddresses(); updateStats();
        toast(_editCamper + ': address deleted');
    }
    function _quickDeleteAddress(name) {
        // Called directly from table row — confirmation already shown inline
        delete D.addresses[name];
        save(); renderAddresses(); updateStats();
        toast(name + ': address deleted');
    }

    // ── Clear-all helpers ──────────────────────────────────────────────────────
    // Each wipes the relevant data from D, localStorage (via save()), and the
    // go_standalone_data Supabase table.

    function _clearCloudDataType(dataType) {
        // Overwrite the cloud row with an empty object so it can't restore stale data
        if (window.GoCloudSync) window.GoCloudSync.save(dataType, {});
    }

    function clearAllAddresses() {
        if (!Object.keys(D.addresses).length) { toast('No addresses to clear', 'error'); return; }
        const count = Object.keys(D.addresses).length;
        if (!confirm('Delete all ' + count + ' camper addresses?\n\nGeocodes and imported data will be permanently removed from this device and the cloud. This cannot be undone.')) return;
        D.addresses = {};
        D.savedRoutes = null;
        _generatedRoutes = null;
        if (D.dismissal) D.dismissal.savedRoutes = null;
        if (D.arrival)   D.arrival.savedRoutes   = null;
        save();
        _clearCloudDataType('addresses');
        _clearCloudDataType('routes');
        _clearCloudDataType('state');
        _goStandaloneRoster = {};
        renderAddresses(); updateStats();
        document.getElementById('routeResults').style.display = 'none';
        document.getElementById('shiftResultsContainer').innerHTML = '';
        toast(count + ' addresses cleared');
    }

    function clearAllMonitors() {
        if (!D.monitors.length) { toast('No monitors to clear', 'error'); return; }
        const count = D.monitors.length;
        if (!confirm('Delete all ' + count + ' monitor(s)?\n\nThis cannot be undone.')) return;
        // Also remove their address entries
        D.monitors.forEach(m => { if (D.addresses[m.name]?._isStaff) delete D.addresses[m.name]; });
        D.monitors = [];
        save();
        _clearCloudDataType('state');
        if (Object.keys(D.addresses).length > 0) _clearCloudDataType('addresses');
        renderStaff(); updateStats();
        toast(count + ' monitor(s) cleared');
    }

    function clearAllCounselors() {
        if (!D.counselors.length) { toast('No counselors to clear', 'error'); return; }
        const count = D.counselors.length;
        if (!confirm('Delete all ' + count + ' counselor(s)?\n\nThis cannot be undone.')) return;
        // Also remove their address entries
        D.counselors.forEach(c => { if (D.addresses[c.name]?._isStaff) delete D.addresses[c.name]; });
        D.counselors = [];
        save();
        _clearCloudDataType('state');
        if (Object.keys(D.addresses).length > 0) _clearCloudDataType('addresses');
        renderStaff(); updateStats();
        toast(count + ' counselor(s) cleared');
    }
    // ──────────────────────────────────────────────────────────────────────────

    // =========================================================================
    // GEOCODING — Multi-provider confidence-ranked pipeline
    // Priority: Google (best accuracy) → Census (free/unlimited) → Nominatim
    // Each provider returns { lat, lng, confidence, source, zipMatch, precision }
    // The highest-confidence valid result wins.
    // =========================================================================

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

    // ── Google Address Validation API (primary — USPS-certified + geocoded) ──
    async function googleAddressValidationScored(street, city, state, zip) {
        const key = D.setup.googleMapsKey;
        if (!key) return null;
        try {
            const resp = await fetch(
                'https://addressvalidation.googleapis.com/v1:validateAddress?key=' + encodeURIComponent(key),
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        address: {
                            addressLines: [street],
                            locality: city || '',
                            administrativeArea: state || '',
                            postalCode: zip || '',
                            regionCode: 'US'
                        }
                    })
                }
            );
            if (!resp.ok) {
                if (resp.status === 403) console.warn('[Go] Google Address Validation: 403 — enable Address Validation API in Cloud Console');
                return null;
            }
            const data = await resp.json();
            const result = data.result;
            if (!result?.geocode?.location?.latitude) return null;

            const lat = result.geocode.location.latitude;
            const lng = result.geocode.location.longitude;
            const verdict = result.verdict || {};
            const usps   = result.uspsData || {};
            const gran   = verdict.validationGranularity || '';

            // Confidence from granularity
            let confidence =
                (gran === 'PREMISE' || gran === 'SUB_PREMISE') ? 0.97 :
                gran === 'PREMISE_PROXIMITY'                   ? 0.88 :
                gran === 'BLOCK'                               ? 0.75 :
                gran === 'ROUTE'                               ? 0.60 : 0.40;

            // USPS DPV match code
            const dpv = usps.dpvMatchCode || '';
            if (dpv === 'Y') confidence = Math.max(confidence, 0.97);      // full match
            else if (dpv === 'S') confidence = Math.min(confidence, 0.80); // missing unit/apt
            else if (dpv === 'D') confidence = Math.min(confidence, 0.72); // missing secondary
            else if (dpv === 'N') confidence = Math.min(confidence, 0.40); // no match

            // ZIP check
            const retZip  = (usps.zipCode || result.address?.postalAddress?.postalCode || '').substring(0, 5);
            const inZip   = (zip || '').substring(0, 5);
            const zipMatch = !!(inZip && retZip && inZip === retZip);
            if (!zipMatch && inZip && retZip) confidence -= 0.08;

            // Capture corrected/standardized address from Google/USPS
            const corrected = {};
            if (usps.address1) {
                corrected.street = usps.address1;
                corrected.city   = usps.city  || city;
                corrected.state  = usps.state || state;
                corrected.zip    = usps.zipCode + (usps.zipPlus4Code ? '-' + usps.zipPlus4Code : '');
            } else if (result.address?.postalAddress) {
                const pa = result.address.postalAddress;
                corrected.street = (pa.addressLines || [])[0] || street;
                corrected.city   = pa.locality             || city;
                corrected.state  = pa.administrativeArea   || state;
                corrected.zip    = pa.postalCode           || zip;
            }

            return {
                lat, lng,
                confidence:  Math.min(Math.max(confidence, 0), 1),
                source:      'google-address-validation',
                zipMatch,
                precision:   (gran === 'PREMISE' || gran === 'SUB_PREMISE') ? 'interpolated' : 'approximate',
                zip:         retZip,
                corrected,
                _dpv:        dpv,
                _granularity: gran
            };
        } catch (e) {
            console.warn('[Go] Google Address Validation error:', e.message);
            return null;
        }
    }

    // ── ORS geocoder (tertiary fallback) ──
    async function orsGeocodeScored(street, city, state, zip) {
        const key = window.__CAMPISTRY_ORS_KEY__ || '';
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

        // Run providers in priority order, stop early if high-confidence
        const results = [];

        // 0. Google Address Validation (best — USPS-certified, corrects typos, returns precise coords)
        if (D.setup.googleMapsKey) {
            const gav = await googleAddressValidationScored(a.street, a.city, a.state, a.zip);
            if (gav && validateGeocode(gav.lat, gav.lng, a.street, name, gav)) {
                // Apply address standardization back to stored record
                if (gav.corrected?.street) {
                    const changed = gav.corrected.street !== a.street
                                 || (gav.corrected.city  && gav.corrected.city  !== a.city)
                                 || (gav.corrected.zip   && gav.corrected.zip.substring(0,5) !== (a.zip||'').substring(0,5));
                    if (changed) {
                        const oldAddr = [a.street, a.city, a.state, a.zip].join(', ');
                        a.street = gav.corrected.street || a.street;
                        a.city   = gav.corrected.city   || a.city;
                        a.state  = gav.corrected.state  || a.state;
                        a.zip    = gav.corrected.zip    || a.zip;
                        a._addressCorrected = true;
                        console.log('[Go] Address corrected for ' + name + ':\n  was: ' + oldAddr + '\n  now: ' + [a.street, a.city, a.state, a.zip].join(', '));
                    }
                }
                results.push(gav);
                // PREMISE-level Google match — best possible result, use immediately
                if (gav.confidence >= 0.85) {
                    applyBestGeocode(a, gav, name);
                    return true;
                }
            }
        }

        // 1. Census (free, unlimited, excellent for US residential)
        const cen = await censusGeocodeScored(a.street, a.city, a.state, a.zip);
        if (cen && validateGeocode(cen.lat, cen.lng, a.street, name, cen)) {
            results.push(cen);
            // If Census returns high confidence with ZIP match and no Google result, use immediately
            if (cen.confidence >= 0.8 && cen.zipMatch !== false && results.length === 1) {
                applyBestGeocode(a, cen, name);
                return true;
            }
        }

        // 2. ORS (fallback if Census failed or low confidence)
        if (results.length === 0 || results.every(r => r.confidence < 0.6)) {
            const ors = await orsGeocodeScored(a.street, a.city, a.state, a.zip);
            // Enforce minimum confidence for ORS — it's a looser provider
            if (ors && ors.confidence >= 0.45 && validateGeocode(ors.lat, ors.lng, a.street, name, ors)) {
                results.push(ors);
            } else if (ors && ors.confidence < 0.45) {
                console.warn('[Go] ORS result for ' + name + ' rejected — confidence too low (' + (ors.confidence * 100).toFixed(0) + '%)');
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
        if (result._dpv === 'N') {
            a._geocodeWarning = 'USPS: address not found — verify address is real and deliverable';
        } else if (result._dpv === 'S' || result._dpv === 'D') {
            a._geocodeWarning = 'USPS: missing apartment/unit number — add unit to complete address';
        } else if (result.confidence < 0.5) {
            a._geocodeWarning = 'Low confidence (' + Math.round(result.confidence * 100) + '%) — verify address';
        } else if (result.precision === 'approximate' && !result._crossValidated) {
            a._geocodeWarning = 'Approximate match — street not found exactly, verify address';
        } else if (result._zipMismatch) {
            a._geocodeWarning = 'ZIP mismatch — geocoded to a different ZIP, verify address';
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
        // Route through the full geocodeOne pipeline:
        // Google Address Validation (primary) → Census → ORS
        await geocodeAll(true);
    }

    // ── Lightweight address-only save used inside the geocoding loop ──────────
    // Full save() serialises D.savedRoutes (can be several MB of road geometry)
    // and fires 3 cloud upserts on every call. During geocoding we only need to
    // checkpoint the addresses to localStorage so work isn't lost if the tab
    // is closed; the full cloud sync runs once at the end.
    function _saveAddressesCheckpoint() {
        try {
            // Write only the addresses object — not the full D state with routes
            localStorage.setItem(STORE + '_addr_ckpt', JSON.stringify(D.addresses));
        } catch (e) {
            // Quota exceeded for checkpoint is non-fatal; the final save() handles it
            console.warn('[Go] Address checkpoint quota exceeded — skipping mid-run save');
        }
    }

    async function geocodeAll(force) {
        if (!_campCoordsCache && D.setup.campAddress) { const cc = await geocodeSingle(D.setup.campAddress); if (cc) { _campCoordsCache = cc; D.setup.campLat = cc.lat; D.setup.campLng = cc.lng; save(); } }

        const todo = Object.keys(D.addresses).filter(n => {
            const a = D.addresses[n];
            if (!a?.street) return false;
            if (force) {
                a.geocoded = false; a.lat = null; a.lng = null;
                a._zipMismatch = false; a._geocodeConfidence = null;
                a._geocodePrecision = null; a._crossValidated = false;
                a._dpv = null; a._addressCorrected = null; a._geocodeSource = null;
                return true;
            }
            return !a.geocoded;
        });
        if (!todo.length) return;

        const hasGoogle = !!D.setup.googleMapsKey;
        const primaryLabel = hasGoogle ? 'Google' : 'Census';
        progressStart('Geocoding Addresses');
        let totalOk = 0, totalFail = 0, googleCount = 0, censusCount = 0, orsCount = 0;

        for (let i = 0; i < todo.length; i++) {
            const name = todo[i];
            const ok = await geocodeOne(name);
            if (ok) {
                totalOk++;
                const src = D.addresses[name]?._geocodeSource || '';
                if (src.includes('google'))  googleCount++;
                else if (src.includes('census')) censusCount++;
                else orsCount++;
            } else {
                totalFail++;
                if (D.addresses[name]) D.addresses[name]._geocodeWarning = 'All providers failed — verify address';
            }

            // Update progress bar every address — but skip the heavy DOM table
            // rebuild (renderAddresses) until the very end. Rebuilding a 500-row
            // table 100 times creates / destroys thousands of DOM nodes and is
            // a primary cause of the Out-of-Memory error on large imports.
            const parts = [];
            if (googleCount) parts.push('Google: ' + googleCount);
            if (censusCount) parts.push('Census: ' + censusCount);
            if (orsCount)    parts.push('ORS: ' + orsCount);
            progressUpdate(i + 1, todo.length, primaryLabel + ' · ' + totalOk + ' geocoded' + (parts.length > 1 ? ' (' + parts.join(', ') + ')' : ''));

            // Checkpoint addresses to localStorage every 25 addresses.
            // Does NOT serialise routes or fire cloud upserts — those only
            // happen in the final save() below once all geocoding is done.
            if ((i + 1) % 25 === 0) _saveAddressesCheckpoint();

            // Small delay to avoid hammering APIs and to yield the event loop
            if (i < todo.length - 1) await new Promise(r => setTimeout(r, 200));
        }

        // One full save + render at the end — this is the only point we write
        // to cloud storage during the geocode run.
        save(); renderAddresses(); updateStats();
        // Clean up checkpoint key now that the real save succeeded
        try { localStorage.removeItem(STORE + '_addr_ckpt'); } catch (_) {}

        const lowConf  = todo.filter(n => D.addresses[n]?.geocoded && (D.addresses[n]._geocodeConfidence || 0) < 0.75).length;
        let summary = totalOk + ' geocoded';
        if (googleCount) summary += ' · Google: ' + googleCount;
        if (censusCount) summary += ' · Census: ' + censusCount;
        if (orsCount)    summary += ' · ORS: ' + orsCount;
        if (lowConf)     summary += ' · ' + lowConf + ' low confidence';
        if (totalFail)   summary += ' · ' + totalFail + ' failed';
        progressEnd(summary, totalFail > 0);
        console.log('[Go] Geocoding complete: ' + totalOk + '/' + todo.length + ' — Google: ' + googleCount + ', Census: ' + censusCount + ', ORS: ' + orsCount + ', failed: ' + totalFail);
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
        const key = window.__CAMPISTRY_ORS_KEY__ || '';
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
        P('Mode: ' + D.activeMode); D.buses.length > 0 ? P('Buses: ' + D.buses.length) : F('Buses: NONE');
        D.setup.campAddress ? P('Camp: ' + D.setup.campAddress) : F('Camp address: NOT SET');
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
        // ── Column detection: two-phase ──────────────────────────────────────────
        //
        // Phase 1 — Header matching: normalise each header (lowercase, trim,
        //   underscores→spaces) then match against known aliases.
        //
        // Phase 2 — Data inference: for any critical column still undetected,
        //   score every unclaimed column against a content fingerprint (regex
        //   applied to up to 20 sampled data rows). The column with the highest
        //   match rate wins. This handles columns named "leave_blank1", "col7",
        //   or any arbitrary name, as long as the DATA looks right.
        //
        const hdr = parseLine(lines[0]).map(h => h.toLowerCase().trim().replace(/_/g, ' '));
        console.log('[Go] CSV headers (' + hdr.length + '):', hdr.join(' | '));

        // Sample up to 20 data rows for content scoring
        const _sampleRows = [];
        for (let _r = 1; _r < Math.min(lines.length, 21); _r++) _sampleRows.push(parseLine(lines[_r]));

        // Returns the fraction of non-empty values in a column that pass testFn
        function _scoreCol(colIdx, testFn) {
            let hits = 0, total = 0;
            for (const row of _sampleRows) {
                const v = (row[colIdx] || '').trim();
                if (!v) continue;
                total++;
                if (testFn(v)) hits++;
            }
            return total >= 2 ? hits / total : 0;   // require at least 2 non-empty values
        }

        // Greedily find the unclaimed column with the best score for a test.
        // claimedSet is a Set of already-assigned column indices.
        // minScore: only accept if score is at least this fraction (0-1).
        function _inferCol(claimedSet, testFn, minScore) {
            let best = -1, bestScore = minScore - 0.001;
            for (let c = 0; c < hdr.length; c++) {
                if (claimedSet.has(c)) continue;
                const s = _scoreCol(c, testFn);
                if (s > bestScore) { bestScore = s; best = c; }
            }
            return best;
        }

        // ── Phase 1: header matching ──────────────────────────────────────────
        const _hm = h => hdr.findIndex(x => x === h);
        let idi  = hdr.findIndex(h => ['camper id','id','camperid','#','person id','personid','camper number'].includes(h));
        let lni  = hdr.findIndex(h => ['last name','last','lastname','family name','surname','lname','l name','last nm'].includes(h));
        let fni  = hdr.findIndex(h => ['first name','first','firstname','given name','fname','f name','preferred name','preferred','first nm'].includes(h));
        let ni   = hdr.findIndex(h => ['name','camper name','camper','full name','fullname','student name','child name','participant'].includes(h));
        let divi = hdr.findIndex(h => ['division','div','group','section','unit','age group'].includes(h));
        let gri  = hdr.findIndex(h => ['grade','grade level','school grade'].includes(h));
        let bki  = hdr.findIndex(h => ['bunk','cabin','room','bunk name','bunk number'].includes(h));
        let si   = hdr.findIndex(h => ['address','street address','home address','address 1','address1','mailing address','residential address'].includes(h) || h.includes('street'));
        let ci   = hdr.findIndex(h => ['city','city/town','town','municipality','locality'].includes(h));
        let sti  = hdr.findIndex(h => ['state','state/province','province','st'].includes(h));
        let zi   = hdr.findIndex(h => ['zip','zip code','zipcode','postal code','postalcode','zip postal'].includes(h) || (h.includes('zip') && !h.includes('zipwith')));
        let tri  = hdr.findIndex(h => ['transport','mode','transportation','bus or pickup','travel mode'].includes(h) || h.includes('pickup') || h.includes('carpool'));
        let rwi  = hdr.findIndex(h => ['ride with','ridewith','ride-with','pair with'].includes(h) || h.includes('pair'));
        let roi  = hdr.findIndex(h => ['role','type','person type','participant type'].includes(h));
        let nsi  = hdr.findIndex(h => ['needs stop','needsstop','needs a stop','stop'].includes(h));
        let arri = hdr.findIndex(h => ['arrival','arr','morning','am'].includes(h));
        let disi = hdr.findIndex(h => ['dismissal','dis','dismiss','afternoon','pm'].includes(h));

        // ── Phase 2: data-content inference for undetected columns ─────────────
        // US state abbreviations used by the state scorer
        const _usStates = new Set(['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC']);

        // Build claimed set from Phase 1 results
        const _claimed = () => new Set([idi,lni,fni,ni,divi,gri,bki,si,ci,sti,zi,tri,rwi,roi,nsi,arri,disi].filter(x => x >= 0));

        // Infer address (most distinctive: digits then word, e.g. "15 Oak Drive")
        if (si < 0) {
            si = _inferCol(_claimed(), v => /^\d+\s+[A-Za-z]/.test(v), 0.4);
            if (si >= 0) console.log('[Go] Inferred address col from data: index ' + si + ' ("' + hdr[si] + '")');
        }

        // Infer zip (4-5 digits, possibly Excel-stripped leading zero)
        if (zi < 0) {
            zi = _inferCol(_claimed(), v => /^\d{4,5}(-\d{4})?$/.test(v), 0.6);
            if (zi >= 0) console.log('[Go] Inferred zip col from data: index ' + zi + ' ("' + hdr[zi] + '")');
        }

        // Infer state (2-letter US abbreviation)
        if (sti < 0) {
            sti = _inferCol(_claimed(), v => _usStates.has(v.toUpperCase()), 0.6);
            if (sti >= 0) console.log('[Go] Inferred state col from data: index ' + sti + ' ("' + hdr[sti] + '")');
        }

        // Infer city (alphabetic, no digits, 2-30 chars — must score higher than names)
        if (ci < 0) {
            ci = _inferCol(_claimed(), v => /^[A-Za-z][A-Za-z .'-]{1,29}$/.test(v) && !/\d/.test(v) && !v.includes('  '), 0.7);
            if (ci >= 0) console.log('[Go] Inferred city col from data: index ' + ci + ' ("' + hdr[ci] + '")');
        }

        // Infer full name (two or more words separated by a single space, all alpha)
        if (ni < 0 && fni < 0 && lni < 0) {
            ni = _inferCol(_claimed(), v => /^[A-Za-z][A-Za-z']{0,19} [A-Za-z][A-Za-z' -]{0,29}$/.test(v), 0.7);
            if (ni >= 0) console.log('[Go] Inferred full-name col from data: index ' + ni + ' ("' + hdr[ni] + '")');
        }

        // Infer first name (single word, alphabetic, 2-20 chars) if still missing both name columns
        if (fni < 0 && ni < 0) {
            fni = _inferCol(_claimed(), v => /^[A-Za-z][A-Za-z'-]{1,19}$/.test(v) && !/\s/.test(v), 0.7);
            if (fni >= 0) console.log('[Go] Inferred first-name col from data: index ' + fni + ' ("' + hdr[fni] + '")');
        }
        if (lni < 0 && fni >= 0 && ni < 0) {
            lni = _inferCol(_claimed(), v => /^[A-Za-z][A-Za-z'-]{1,24}$/.test(v) && !/\s/.test(v), 0.7);
            if (lni >= 0) console.log('[Go] Inferred last-name col from data: index ' + lni + ' ("' + hdr[lni] + '")');
        }

        console.log('[Go] Final column map → first/last:' + fni + '/' + lni + ' name:' + ni + ' addr:' + si + ' city:' + ci + ' state:' + sti + ' zip:' + zi + ' role:' + roi);

        // Must have either (first+last) or (full name), plus an address
        const hasFirstLast = fni >= 0 && lni >= 0;
        const hasFullName = ni >= 0;
        if (!hasFirstLast && !hasFullName) { toast('CSV needs either "First Name" + "Last Name" columns, or a "Name" column', 'error'); return; }
        if (si < 0) { toast('CSV needs an "Address" or "Street Address" column', 'error'); return; }

        // Merge import — preserve existing geocodes for unchanged addresses.
        // D.addresses is NOT wiped: if a person is already geocoded and their
        // address hasn't changed, we keep their lat/lng so no re-geocoding needed.
        // The standalone roster IS reset so it exactly reflects the new CSV.
        // Routes are cleared since the roster may have changed.
        _goStandaloneRoster = {};
        D.savedRoutes = null;
        _generatedRoutes = null;
        _detectedRegions = null;
        _slicedZones = null;
        // Clear staff imported from CSV (keep manually added ones)
        D.counselors = D.counselors.filter(c => !c._fromCsv);
        D.monitors = D.monitors.filter(m => !m._fromCsv);
        let camperCount = 0, staffCount = 0, _skippedEmpty = 0, _skippedNoAddr = 0;

        for (let i = 1; i < lines.length; i++) {
            const cols = parseLine(lines[i]);

            // Build full name
            let firstName = '', lastName = '', name = '';
            if (hasFirstLast) {
                firstName = (cols[fni] || '').trim();
                lastName = (cols[lni] || '').trim();
                if (!firstName && !lastName) { _skippedEmpty++; continue; }
                name = firstName + (lastName ? ' ' + lastName : '');
            } else {
                name = (cols[ni] || '').trim();
                if (!name) { _skippedEmpty++; continue; }
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

                // All staff get an address entry so they're geocoded with campers.
                // Preserve existing geocode if the street hasn't changed.
                if (street) {
                    const _ex = D.addresses[name];
                    const _normStreet = s => { const ab = { dr:'drive',st:'street',ave:'avenue',blvd:'boulevard',ct:'court',ln:'lane',rd:'road',pl:'place',cir:'circle',hwy:'highway',pkwy:'parkway',trl:'trail',ter:'terrace',terr:'terrace',expy:'expressway',crst:'crest',crk:'creek',xing:'crossing',aly:'alley' }; return (s||'').trim().toLowerCase().replace(/[.,#]/g,'').split(/\s+/).map(w=>ab[w]||w).join(' '); };
                    const _keepGeocode = !!_ex?.geocoded && _normStreet(_ex.street) === _normStreet(street);
                    D.addresses[name] = Object.assign({}, _keepGeocode ? _ex : {}, {
                        street, city, state, zip,
                        lat:      _keepGeocode ? (_ex.lat || null) : null,
                        lng:      _keepGeocode ? (_ex.lng || null) : null,
                        geocoded: _keepGeocode,
                        transport: 'bus', rideWith: '',
                        _camperId: personId ? parseInt(personId) : 0,
                        _division: division, _grade: '', _bunk: bunk,
                        _isStaff: true,
                        _arrival: forArrival, _dismissal: forDismissal
                    });
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
                    const _ex = D.addresses[rn];
                    // Compare addresses case-insensitively and whitespace-normalised.
                    // If the geocoded position still makes sense (house number + street
                    // name unchanged), keep it. If the street component changed
                    // (person moved), reset so it gets re-geocoded.
                    // Normalize street type abbreviations before comparing so that
                    // Google-corrected addresses ("Drive") match CSV originals ("Dr").
                    const _normStreet = s => { const ab = { dr:'drive',st:'street',ave:'avenue',blvd:'boulevard',ct:'court',ln:'lane',rd:'road',pl:'place',cir:'circle',hwy:'highway',pkwy:'parkway',trl:'trail',ter:'terrace',terr:'terrace',expy:'expressway',crst:'crest',crk:'creek',xing:'crossing',aly:'alley' }; return (s||'').trim().toLowerCase().replace(/[.,#]/g,'').split(/\s+/).map(w=>ab[w]||w).join(' '); };
                    const _keepGeocode = !!_ex?.geocoded && _normStreet(_ex.street) === _normStreet(street);
                    // Spread existing entry first so ALL geocode metadata
                    // (_geocodeConfidence, _geocodeWarning, _zipMismatch, etc.)
                    // is preserved — then overlay the updated CSV fields on top.
                    D.addresses[rn] = Object.assign({}, _keepGeocode ? _ex : {}, {
                        street, city, state, zip,
                        lat:      _keepGeocode ? (_ex.lat || null) : null,
                        lng:      _keepGeocode ? (_ex.lng || null) : null,
                        geocoded: _keepGeocode,
                        transport: _ex?.transport || ((transport === 'pickup' || transport === 'carpool') ? 'pickup' : 'bus'),
                        rideWith: rideWith || _ex?.rideWith || '',
                        _camperId: personId ? parseInt(personId) : 0,
                        _division: division, _grade: grade, _bunk: bunk,
                        _arrival: forArrival, _dismissal: forDismissal
                    });
                } else {
                    _skippedNoAddr++;
                }

                _goStandaloneRoster[rn] = {
                    camperId: personId ? parseInt(personId) : i,
                    division: division, grade: grade, bunk: bunk
                };

                camperCount++;
            }
        }
        // Count how many geocodes were preserved (address unchanged, already geocoded)
        const preserved = Object.values(D.addresses).filter(a => a.geocoded).length;
        console.log('[Go] CSV parse done — campers:' + camperCount + ' staff:' + staffCount +
            ' skipped(empty name):' + _skippedEmpty + ' skipped(no address):' + _skippedNoAddr +
            ' geocodes kept:' + preserved + ' total rows:' + (lines.length - 1));
        save(); renderAddresses(); renderStaff(); updateStats();
        // ★ Update starter banner camper count
        if (window.refreshStarterBanner) window.refreshStarterBanner(camperCount);
        const total = camperCount + staffCount;
        const preservedNote = preserved > 0 ? ', ' + preserved + ' geocodes kept' : '';
        if (_goCapped > 0) {
            toast(camperCount + ' imported, ' + _goCapped + ' skipped (plan limit)' + (staffCount > 0 ? ', ' + staffCount + ' staff' : '') + preservedNote);
        } else if (staffCount > 0) {
            toast(camperCount + ' campers + ' + staffCount + ' staff imported' + preservedNote);
            console.log('[Go] CSV import: ' + camperCount + ' campers, ' + staffCount + ' staff, ' + preserved + ' geocodes preserved');
        } else {
            toast(camperCount + ' addresses imported' + preservedNote);
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
            { label: 'Route optimizer ready (Geoapify/haversine)', status: 'ok', detail: '' },
            { label: pickupCount + ' carpool/pickup (excluded)', status: 'ok' }
        ];
        const anyFail = checks.some(c => c.status === 'fail'); const canGen = D.buses.length > 0 && geocoded > 0;
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

async function generateRoutes() {
    // -------------------------------------------------------------------------
    // PRE-FLIGHT
    // -------------------------------------------------------------------------
    _intersectionCache = null;

    const roster = getRoster();
    const reserveSeats = parseInt(document.getElementById('routeReserveSeats')?.value) || 0;
    const avgStopMin = D.setup.avgStopTime || 2;
    const avgSpeedMph = D.setup.avgSpeed || 25;
    const isArrival = D.activeMode === 'arrival';
    const mode = document.getElementById('routeMode')?.value || 'corner-stops';

    // Escape hatch for emergencies only — default is always neighborhood mode.
    const bypassNeighborhoodMode = D.setup.useNeighborhoodMode === 'bypass';

    // Hard preflight: must have buses
    if (!D.buses.length) {
        toast('Add buses first', 'error');
        return;
    }

    // Hard preflight: every bus-mode camper must be geocoded. v4 silently
    // dropped ungeocoded campers — that's a data-integrity bug, not a feature.
    const ungeocoded = [];
    let hasAnyGeocoded = false;
    Object.keys(roster).forEach(name => {
        const a = D.addresses[name];
        if (!a || a.transport === 'pickup') return;
        if (a._isStaff) return;
        if (a.geocoded && a.lat && a.lng) { hasAnyGeocoded = true; return; }
        ungeocoded.push(name);
    });
    if (!hasAnyGeocoded) {
        toast('No geocoded campers — geocode addresses first', 'error');
        return;
    }
    if (ungeocoded.length) {
        console.error('[Go] PREFLIGHT FAIL: ' + ungeocoded.length +
            ' camper(s) not geocoded. They will be dropped from routing.');
        console.error('[Go] Ungeocoded:', ungeocoded.slice(0, 20),
            ungeocoded.length > 20 ? '(+' + (ungeocoded.length - 20) + ' more)' : '');
        toast(ungeocoded.length + ' camper(s) not geocoded — geocode them first to include',
              'error');
        // We continue rather than abort — but we've told the user loudly.
    }

    // Hard preflight: neighborhood modules must be loaded (unless bypassing)
    if (!bypassNeighborhoodMode) {
        if (!window.CampistryGoNeighborhoods?.buildNeighborhoods) {
            console.error('[Go] CampistryGoNeighborhoods module not loaded. ' +
                'Routing cannot proceed with the primary path.');
            toast('Neighborhood module missing — cannot generate routes', 'error');
            return;
        }
    }

    // -------------------------------------------------------------------------
    // CAMP COORDS — must already be geocoded from the Setup tab
    // -------------------------------------------------------------------------
    _routeProgStart = Date.now();
    if (_campCoordsCache) {
        // already resolved this session
    } else if (D.setup.campLat && D.setup.campLng) {
        _campCoordsCache = { lat: D.setup.campLat, lng: D.setup.campLng };
    } else {
        toast('Camp coordinates not found — geocode the camp address in Setup first', 'error');
        return;
    }
    const campCoords = _campCoordsCache;
    const campLat = campCoords.lat;
    const campLng = campCoords.lng;

    // -------------------------------------------------------------------------
    // VEHICLES
    // -------------------------------------------------------------------------
    const vehicles = D.buses.map(b => {
        const mon = D.monitors.find(m => m.assignedBus === b.id);
        const couns = D.counselors.filter(c => c.assignedBus === b.id);
        const brs = getBusReserve(b);
        return {
            busId: b.id,
            name: b.name,
            color: b.color || '#10b981',
            capacity: Math.max(0, (b.capacity || 0) - (mon ? 1 : 0) - couns.length - brs),
            monitor: mon,
            counselors: couns
        };
    });

    // -------------------------------------------------------------------------
    // OPTIMIZER AVAILABILITY (for per-bus TSP)
    // -------------------------------------------------------------------------
    const googleKey    = D.setup.googleMapsKey || '';
    const googleProjId = D.setup.googleProjectId || '';
    const geoapifyKey  = D.setup.geoapifyKey || '';
    const googleAvailable = !!(googleKey && googleProjId &&
                               window.GoGoogleOptimizer?.optimizeTours);

    // Supabase proxy token (for Google edge-function auth)
    const _supabaseUrl = window.__CAMPISTRY_SUPABASE__?.url || '';
    let _googleProxyToken = null;
    if (_supabaseUrl && window.supabase?.auth?.getSession) {
        try {
            const _sess = await window.supabase.auth.getSession();
            _googleProxyToken = _sess?.data?.session?.access_token || null;
        } catch (_e) { /* non-fatal */ }
    }

    const _pipelineMode = D.setup.routingPipeline || 'neighborhood';
    console.log('[Go v6] Routing strategy: ' +
                (_pipelineMode === 'spatial-sort' ? 'SPATIAL SORT (primary)' : 'NEIGHBORHOOD (primary)') +
                ' → ' + (googleAvailable ? 'Google Route Optimization (fallback)' : 'NO FALLBACK'));
    console.log('[Go v6] Per-bus TSP optimizer: ' +
                (googleAvailable ? 'Google' : geoapifyKey ? 'Geoapify' : 'local 2-opt'));

    // -------------------------------------------------------------------------
    // SHIFT LOOP
    // -------------------------------------------------------------------------
    const allShiftResults = [];

    // Phase 3: load persistent flags before the shift loop
    if (window.GoFlagPersistence) await _ensureFlags();

    const shifts = D.shifts.length ? D.shifts : [{
        id: '__all__', label: 'All Campers', divisions: [],
        departureTime: isArrival ? '07:00' : '16:00', _isVirtual: true
    }];

    for (let si = 0; si < shifts.length; si++) {
        const shift = shifts[si];
        const pctPerShift = 100 / shifts.length;
        const pctBase = si * pctPerShift;
        const shiftLabel = shift.label || 'Shift ' + (si + 1);

        // ── Bus set for this shift ──
        let shiftBusIds = shift.assignedBuses?.length
            ? shift.assignedBuses
            : vehicles.map(v => v.busId);
        if (shift.assignedBuses?.length) {
            const validIds = shiftBusIds.filter(bid => vehicles.some(v => v.busId === bid));
            if (validIds.length < shiftBusIds.length) {
                console.warn('[Go v5] Shift "' + shiftLabel + '": ' +
                    (shiftBusIds.length - validIds.length) +
                    ' assigned buses no longer exist — using all buses');
                shift.assignedBuses = [];
                shiftBusIds = vehicles.map(v => v.busId);
                save();
            }
        }
        const shiftVehicles = shiftBusIds
            .map(bid => vehicles.find(v => v.busId === bid))
            .filter(Boolean);

        // ── Gather campers for this shift ──
        const allCampers = [];
        Object.keys(roster).forEach(name => {
            const c = roster[name];
            const a = D.addresses[name];
            if (!c || !a?.geocoded || !a.lat || !a.lng) return;
            if (a._isStaff) return;
            if (a.transport === 'pickup') return;
            const modeKey = isArrival ? '_arrival' : '_dismissal';
            if (a[modeKey] === false) return;
            if (shift._isVirtual || camperMatchesShift(c, shift)) {
                allCampers.push({
                    name,
                    division: c.division,
                    bunk: c.bunk || '',
                    lat: a.lat,
                    lng: a.lng,
                    address: [a.street, a.city, a.state, a.zip].filter(Boolean).join(', ')
                });
            }
        });

        // ── Apply rideWith so siblings/pairs share coords ──
        applyRideWith(allCampers);

        // ── Deduplicate by name ──
        const seenNames = new Set();
        for (let di = allCampers.length - 1; di >= 0; di--) {
            if (seenNames.has(allCampers[di].name)) allCampers.splice(di, 1);
            else seenNames.add(allCampers[di].name);
        }

        if (!allCampers.length || !shiftVehicles.length) {
            if (!allCampers.length) {
                console.error('[Go v5] Shift "' + shiftLabel + '": 0 campers matched — skipping');
            }
            if (!shiftVehicles.length) {
                console.error('[Go v5] Shift "' + shiftLabel + '": 0 vehicles available — skipping');
            }
            allShiftResults.push({ shift, routes: [], camperCount: 0 });
            continue;
        }

        // ── Staff noStopStaff — collected exactly as v4 did ──
        const noStopStaff = _collectNoStopStaff();

        // =====================================================================
        // PRIMARY PATH: Spatial Sort (default) or Neighborhood pipeline
        // =====================================================================
        let routes = null;
        let routeSource = null;
        const pipelineMode = D.setup.routingPipeline || 'neighborhood';

        if (!bypassNeighborhoodMode) {
            // Spatial sort — compact lat/lng bands + snake pattern
            if (pipelineMode === 'spatial-sort') {
                try {
                    routes = await _trySpatialSortPipeline({
                        shift, shiftLabel, pctBase,
                        allCampers, shiftVehicles,
                        campLat, campLng,
                        reserveSeats, dropoffMode: mode,
                        isArrival,
                        googleAvailable, googleKey, googleProjId,
                        _supabaseUrl, _googleProxyToken,
                        serviceTimeSec: avgStopMin * 60,
                        shiftIdx: si
                    });
                    if (routes) routeSource = 'spatial-sort';
                } catch (e) {
                    console.error('[Go v6] Spatial sort pipeline threw:', e);
                    routes = null;
                }
            }

            // Neighborhood fallback (or explicit neighborhood mode)
            if (!routes && pipelineMode !== 'bypass') {
                try {
                    routes = await _tryNeighborhoodPipeline({
                        shift, shiftLabel, pctBase,
                        allCampers, shiftVehicles,
                        campLat, campLng,
                        reserveSeats, dropoffMode: mode,
                        isArrival,
                        googleAvailable, googleKey, googleProjId,
                        _supabaseUrl, _googleProxyToken,
                        serviceTimeSec: avgStopMin * 60,
                        shiftIdx: si
                    });
                    if (routes) routeSource = 'neighborhood';
                } catch (e) {
                    console.error('[Go v5] Neighborhood pipeline threw:', e);
                    routes = null;
                }
            }
        }

        // =====================================================================
        // FALLBACK PATH: Global corner-stops + Google Route Optimization
        // Runs ONLY if the primary path returned null or errored.
        // Loud: toast + console.error so operator knows to fix the root cause.
        // =====================================================================
        if (!routes) {
            if (!googleAvailable) {
                console.error('[Go v5] Both paths unavailable. Primary (neighborhoods) ' +
                    'failed and fallback (Google Route Optimization) is not configured.');
                toast('Route generation failed — see console. Configure Google API key ' +
                      'or fix neighborhood preflight errors.', 'error');
                allShiftResults.push({ shift, routes: [], camperCount: 0 });
                continue;
            }

            console.error('[Go v5] FALLBACK: neighborhood pipeline failed, using ' +
                'Google Route Optimization over global corner stops. Route quality ' +
                'will be lower; investigate root cause.');
            toast('Route quality warning: primary pipeline failed, using fallback. ' +
                  'See console.', 'error');

            try {
                routes = await _fallbackGoogleGlobal({
                    shift, shiftLabel, pctBase,
                    allCampers, shiftVehicles,
                    campLat, campLng,
                    reserveSeats,
                    isArrival,
                    googleKey, googleProjId,
                    _supabaseUrl, _googleProxyToken,
                    serviceTimeSec: avgStopMin * 60
                });
                if (routes) routeSource = 'google-fallback';
            } catch (e) {
                console.error('[Go v5] Fallback pipeline threw:', e);
                routes = null;
            }
        }

        if (!routes) {
            console.error('[Go v5] Shift "' + shiftLabel + '": all routing paths failed');
            toast('Failed to generate routes for ' + shiftLabel, 'error');
            allShiftResults.push({ shift, routes: [], camperCount: 0 });
            continue;
        }

        // =====================================================================
        // COMMON POST-PROCESSING (runs regardless of which path produced routes)
        // =====================================================================
        // - capacity rebalancing (Phase 2 — equalize bus loads)
        // - stopNum numbering
        // - ETA / estimatedTime pipeline (first pass, so we know totalDuration)
        // - duration-based stop redistribution (Phase 3 — honor route cap)
        // - ETA pipeline second pass after splits
        // - max-ride-time audit
        // - staff nearest-stop suggestions
        // =====================================================================
        _rebalanceBusLoads(routes, shiftVehicles);

        _applyETAsAndAudits(routes, {
            shift, isArrival, campLat, campLng,
            avgStopMin,
            shiftNeedsReturn: si === shifts.length - 1 && !isArrival
        });

        // Hard-split any route that's still over the duration cap. Use
        // setup.maxRouteDuration as the target — same value the solver got
        // as a soft cap, but enforced after the fact.
        const _maxRouteMin = D.setup.maxRouteDuration || 60;
        const _hadOverlong = routes.some(r => (r.totalDuration || 0) > _maxRouteMin);
        if (_hadOverlong) {
            _splitOverlongRoutes(routes, shiftVehicles, campLat, campLng, _maxRouteMin);
            // Recompute ETAs after stops moved
            _applyETAsAndAudits(routes, {
                shift, isArrival, campLat, campLng,
                avgStopMin,
                shiftNeedsReturn: si === shifts.length - 1 && !isArrival
            });
        }

        // Staff suggestions (unchanged from v4) — mutate D.monitors / D.counselors
        _suggestStaffStops(routes, noStopStaff, campLat, campLng);

        routes.forEach(r => { r._source = r._source || routeSource; });

        allShiftResults.push({
            shift,
            routes,
            camperCount: routes.reduce((s, r) => s + r.camperCount, 0)
        });
    }

    // -------------------------------------------------------------------------
    // FINALIZE
    // -------------------------------------------------------------------------
    _generatedRoutes = allShiftResults;
    _routeGeomCache = {}; window._routeGeomCache = _routeGeomCache;

    // ── Shift-level imbalance audit ────────────────────────────────────────
    // Surface bus-load imbalance per shift. The professional camp routes
    // run in a 27-54 camper band; we want max/min ratio under ~1.5×.
    allShiftResults.forEach((sr, si) => {
        const active = sr.routes.filter(r => r.camperCount > 0);
        if (active.length < 2) return;
        const counts = active.map(r => r.camperCount);
        const min = Math.min(...counts), max = Math.max(...counts);
        const ratio = max / Math.max(1, min);
        if (ratio >= 2 || (max - min) >= 25) {
            const label = sr.shift?.label || ('Shift ' + (si + 1));
            console.warn('[Go v5.2] ' + label + ': bus load imbalance — min=' +
                min + ', max=' + max + ' (ratio ' + ratio.toFixed(2) + 'x). ' +
                'Lightest: ' + active.find(r => r.camperCount === min).busName +
                '; heaviest: ' + active.find(r => r.camperCount === max).busName);
        }
    });

    // Cache road geometry (unchanged from v4)
    let geomCached = 0;
    allShiftResults.forEach((sr, si) => {
        sr.routes.forEach(r => {
            if (_routeGeomCache[r.busId + '_' + si]) { geomCached++; return; }
            if (r._roadPts?.length) {
                _routeGeomCache[r.busId + '_' + si] = r._roadPts;
                geomCached++;
            } else if (r._encodedPolyline) {
                try {
                    const decoded = decodePolyline(r._encodedPolyline);
                    if (decoded?.length) {
                        _routeGeomCache[r.busId + '_' + si] = decoded;
                        r._roadPts = decoded;
                        geomCached++;
                    }
                } catch (_) { /* ignore */ }
            }
        });
    });
    if (geomCached) console.log('[Go v5] Road geometry cached: ' + geomCached + ' routes');

    D.savedRoutes = allShiftResults;
    save();

    const elapsed = Math.round((Date.now() - _routeProgStart) / 1000);
    const elapsedStr = elapsed < 60 ? elapsed + 's' : Math.floor(elapsed / 60) + 'm ' + (elapsed % 60) + 's';
    const totalRoutes = allShiftResults.reduce((s, sr) => s + sr.routes.length, 0);
    const totalCampers = allShiftResults.reduce((s, sr) => s + sr.camperCount, 0);

    showProgressDone('Routes generated',
        totalRoutes + ' route(s), ' + totalCampers + ' camper(s) in ' + elapsedStr);
    renderRouteResults(allShiftResults);
    renderStaff();
    setTimeout(hideProgress, 2000);
}


// =============================================================================
// PRIMARY PATH: Road-graph neighborhoods
// =============================================================================
//
// Returns an array of route objects, or null if the pipeline cannot produce
// valid routes (triggers the fallback in the caller).
//
// Route flow:
//   1. Build neighborhoods from OSM road graph (persisted across runs)
//   2. If >5% of campers can't snap to any segment: return null → fallback
//   3. packIntoBuses: assigns each neighborhood to a bus (geographic locality
//      + capacity + sibling coherence + prior-year stability)
//   4. expandToPhysicalStops: for each bus, generate its stops from its own
//      zone's campers only (door-to-door or corner, per user setting)
//   5. For each bus: run a per-bus TSP (Google Route Optimization on one
//      vehicle) to optimally sequence its stops.  This gets globally-optimal
//      ordering WITHIN each bus without allowing the solver to move campers
//      BETWEEN buses (which would undo the zone partitioning).
//   6. Cross-bus camper deduplication safety net (defensive — should never
//      trigger after zones are drawn correctly).
//   7. Record year-over-year assignment state.
// =============================================================================
async function _tryNeighborhoodPipeline({
    shift, shiftLabel, pctBase,
    allCampers, shiftVehicles,
    campLat, campLng,
    reserveSeats, dropoffMode,
    isArrival,
    googleAvailable, googleKey, googleProjId,
    _supabaseUrl, _googleProxyToken,
    serviceTimeSec,
    shiftIdx
}) {
    showProgress(shiftLabel + ': detecting neighborhoods...', pctBase + 10);

    // ── Prep input for buildNeighborhoods ──
    const nhCampers = allCampers.map(c => {
        const a = D.addresses[c.name] || {};
        return {
            name: c.name, lat: c.lat, lng: c.lng,
            address: c.address,
            division: c.division, bunk: c.bunk,
            zip: a.zip || ''
        };
    });

    const sibMap = detectSiblings(allCampers);
    const siblingGroups = {};
    for (const [name, gid] of Object.entries(sibMap)) {
        (siblingGroups[gid] ||= []).push(name);
    }

    // ── Run neighborhood detection ──
    const nhResult = await window.CampistryGoNeighborhoods.buildNeighborhoods({
        campers: nhCampers,
        options: { verbose: true, siblingGroups }
    });

    if (!nhResult || !nhResult.neighborhoods?.length) {
        console.warn('[Go v5] Neighborhood detection produced 0 neighborhoods');
        return null;
    }

    // ── Safety gate: don't ship a roster missing too many kids ──
    const unattachedCount = nhResult.unattachedCampers?.length || 0;
    const unattachedPct = unattachedCount / Math.max(1, allCampers.length);
    if (unattachedPct > 0.05) {
        console.warn('[Go v5] Neighborhood mode: ' + (unattachedPct * 100).toFixed(1) +
            '% of campers unattached (exceeds 5% threshold) — falling through');
        return null;
    }

    showProgress(shiftLabel + ': packing neighborhoods into buses...', pctBase + 25);

    // ── Bus assignment ──
    const priorAssignments = window.GoNhPersistence
        ? await window.GoNhPersistence.getPriorAssignments()
        : {};

    const reducedBuses = shiftVehicles.map(v => ({
        id: v.busId, name: v.name,
        capacity: Math.max(0, (v.capacity || 0) - reserveSeats)
    }));

    const nhAssignment = window.CampistryGoNeighborhoods.packIntoBuses({
        result: nhResult,
        buses: reducedBuses,
        priorAssignments,
        siblingGroups,
        depot: { lat: campLat, lng: campLng }
    });

    showProgress(shiftLabel + ': generating per-zone stops...', pctBase + 40);

    // ── Expand each zone into physical stops ──
    // This is the heart of the "stops per zone, not globally" fix.
    // expandToPhysicalStops creates stops for each bus using ONLY that bus's
    // assigned segments/homes, so stops can never land on zone seams.
    const nhPhysical = window.CampistryGoNeighborhoods.expandToPhysicalStops({
        assignment: nhAssignment,
        result: nhResult,
        isArrival,
        dropoffMode
    });

    // ── Append any unsnapped campers to their nearest bus as door drops ──
    // Gated at 5% above; these are the trailing few.
    const attachedNames = new Set(nhResult.homes.map(h => h.camperName));
    const leftover = allCampers.filter(c => !attachedNames.has(c.name));
    if (leftover.length) {
        console.warn('[Go v5] ' + leftover.length +
            ' un-snapped camper(s) — appending as door-drops to nearest bus');
        for (const c of leftover) {
            let bestBus = null, bestDist = Infinity;
            for (const bus of nhPhysical) {
                if (!bus.stops?.length) continue;
                for (const s of bus.stops) {
                    const d = haversineMi(c.lat, c.lng, s.lat, s.lng);
                    if (d < bestDist) { bestDist = d; bestBus = bus; }
                }
            }
            if (bestBus) {
                bestBus.stops.push({
                    lat: c.lat, lng: c.lng,
                    address: c.address,
                    campers: [{ name: c.name, division: c.division, bunk: c.bunk }]
                });
                bestBus.camperCount = (bestBus.camperCount || 0) + 1;
            }
        }
    }

    // ── Build route objects (still in NH-spine order — will be TSP'd next) ──
    const nhNameById = {};
    for (const nh of nhResult.neighborhoods) nhNameById[nh.id] = nh.primaryName;

    let routes = nhPhysical.map(bus => {
        const vehicle = shiftVehicles.find(v => v.busId === bus.busId) || {};
        const names = (bus.neighborhoodIds || []).map(id =>
            nhNameById[id.replace(/_p\d+$/, '')] || id);
        return {
            busId:          bus.busId,
            busName:        vehicle.name || bus.name || bus.busId,
            busColor:       vehicle.color || '#10b981',
            monitor:        vehicle.monitor    || null,
            counselors:     vehicle.counselors || [],
            stops:          bus.stops.map((s, i) => ({
                stopNum: i + 1,
                campers: s.campers,
                address: s.address,
                lat: s.lat, lng: s.lng
            })),
            camperCount:    bus.camperCount,
            _cap:           vehicle.capacity,
            totalDuration:  0,
            _neighborhoodIds:   bus.neighborhoodIds,
            _neighborhoodNames: [...new Set(names)],
            _segmentOrder:      bus.segmentOrder,
            _source:        'neighborhood-mode'
        };
    });

    // ── Cross-bus dedup safety net ──
    // Should not trigger once zones are drawn correctly, but guards against
    // any regression in neighborhood detection.
    (function dedupAcrossBuses() {
        const seen = new Set();
        let removed = 0;
        for (const r of routes) {
            for (const st of r.stops) {
                const keep = [];
                for (const cc of (st.campers || [])) {
                    const n = typeof cc === 'string' ? cc : cc.name;
                    if (!n || seen.has(n)) { removed++; continue; }
                    seen.add(n);
                    keep.push(cc);
                }
                st.campers = keep;
            }
            r.stops = r.stops.filter(s => s.campers.length > 0);
            r.stops.forEach((s, i) => s.stopNum = i + 1);
            r.camperCount = r.stops.reduce((sum, s) => sum + s.campers.length, 0);
        }
        if (removed) {
            console.warn('[Go v5] Cross-bus dedup removed ' + removed + ' duplicate(s) ' +
                '(upstream detection bug — please investigate)');
        }
    })();


    // ── Per-bus TSP re-ordering ──
    // Now that each bus has its stops fixed (who is on it is decided), run
    // a single-vehicle TSP on each bus to find the best stop sequence.
    // This gets LSTA-grade stop ordering within each zone without letting
    // the solver move campers between zones.
    if (googleAvailable && routes.length) {
        showProgress(shiftLabel + ': optimizing stop order per bus...', pctBase + 60);
        for (const r of routes) {
            if (r.stops.length < 3) continue;
            try {
                const tspResult = await _perBusGoogleTSP({
                    route: r,
                    campLat, campLng,
                    isArrival,
                    serviceTimeSec,
                    googleKey, googleProjId,
                    _supabaseUrl, _googleProxyToken,
                    shift,
                    shiftIdx
                });
                if (tspResult) {
                    r.stops = tspResult.stops;
                    r.stops.forEach((s, i) => s.stopNum = i + 1);
                    r.totalDuration = tspResult.totalDuration || r.totalDuration;
                    if (tspResult.roadPts) r._roadPts = tspResult.roadPts;
                    if (tspResult.tspLegTimes) r._tspLegTimes = tspResult.tspLegTimes;
                }
            } catch (e) {
                console.warn('[Go v5] Per-bus TSP failed for ' + r.busName +
                    ' — using NH-spine order (' + e.message + ')');
                // Fall through with spine-order stops; still a valid route.
            }
        }
    }

    // ── Record year-over-year assignment state ──
    if (window.GoNhPersistence) {
        try {
            const prevPayload = await window.GoNhPersistence.load();
            await window.GoNhPersistence.recordAssignment(nhAssignment, nhResult);
            const curPayload = await window.GoNhPersistence.load();
            const changes = window.GoNhPersistence.diff(prevPayload, curPayload);
            if (changes.length) {
                console.log('[Go v5] Year-over-year neighborhood changes:');
                for (const ch of changes) {
                    console.log('  ' + ch.primaryName + ' (' + ch.nhId + '): ' +
                        (ch.fromBus || '∅') + ' → ' + (ch.toBus || '∅') +
                        ' (' + ch.reason + ')');
                }
            } else {
                console.log('[Go v5] No neighborhood changes from last run');
            }
        } catch (e) {
            console.warn('[Go v5] Neighborhood persistence failed:', e.message);
        }
    }

    toast('✓ Routes generated — ' + routes.length + ' buses, ' +
          nhResult.neighborhoods.length + ' neighborhoods');
    console.log('[Go v5] Primary path complete: ' + routes.length + ' routes, ' +
        routes.reduce((s, r) => s + r.stops.length, 0) + ' stops, ' +
        nhResult.neighborhoods.length + ' neighborhoods');

    return routes;
}


// =============================================================================
// SPATIAL SORT PIPELINE — Two-Phase Density-Aware Clustering
//
// Phase 1: K-means into k=numBuses clusters on pure lat/lng
// Phase 2: Dissolve clusters under MIN_BUS_THRESHOLD (75% capacity = 34)
//          and re-cluster the dense areas with freed-up buses
// =============================================================================
async function _trySpatialSortPipeline({
    shift, shiftLabel, pctBase,
    allCampers, shiftVehicles,
    campLat, campLng,
    reserveSeats, dropoffMode,
    isArrival,
    googleAvailable, googleKey, googleProjId,
    _supabaseUrl, _googleProxyToken,
    serviceTimeSec,
    shiftIdx
}) {
    const avgCapacity = shiftVehicles.length
        ? Math.floor(shiftVehicles.reduce((s, v) => s + (v.capacity || 0), 0) / shiftVehicles.length)
        : 48;
    const _softPct = (D.setup.clusterSoftCapPct ?? 112) / 100;
    const _dissPct = (D.setup.clusterDissolvePct ?? 55) / 100;
    const _floorPct = (D.setup.clusterFloorPct ?? 30) / 100;
    const SOFT_CAPACITY = Math.ceil(avgCapacity * _softPct);
    const MIN_BUS_THRESHOLD = Math.ceil(avgCapacity * _dissPct);
    const CASCADE_FLOOR = Math.ceil(avgCapacity * _floorPct);
    console.log('[Go v6] Fleet avg capacity: ' + avgCapacity +
        ', soft cap: ' + SOFT_CAPACITY + ' (' + Math.round(_softPct * 100) + '%)' +
        ', dissolve threshold: ' + MIN_BUS_THRESHOLD + ' (' + Math.round(_dissPct * 100) + '%)' +
        ', cascade floor: ' + CASCADE_FLOOR + ' (' + Math.round(_floorPct * 100) + '%)');

    // ── Helper: run k-means N times with random seeds, return tightest result ──
    function runKMeans(atomSet, numClusters) {
        if (!atomSet.length || numClusters <= 0) return [];
        const RESTARTS = 7;
        let bestBuckets = null;
        let bestScore = Infinity;
        for (let r = 0; r < RESTARTS; r++) {
            const buckets = runKMeansOnce(atomSet, numClusters);
            // Score: sum of (spread-mi × sqrt(atoms)) — penalizes elongated and big clusters
            let score = 0;
            for (const b of buckets) {
                if (b.length < 2) continue;
                const lats = b.map(a => a.lat);
                const lngs = b.map(a => a.lng);
                const spread = haversineMi(
                    Math.min(...lats), Math.min(...lngs),
                    Math.max(...lats), Math.max(...lngs));
                score += spread * Math.sqrt(b.length);
            }
            if (score < bestScore) { bestScore = score; bestBuckets = buckets; }
        }
        console.log('[Go v6] K-means: best of ' + RESTARTS + ' restarts (score ' +
            bestScore.toFixed(2) + ')');
        return bestBuckets;
    }

    function runKMeansOnce(atomSet, numClusters) {
        if (!atomSet.length || numClusters <= 0) return [];

        // K-means++ seeding
        const cents = [];
        const firstIdx = Math.floor(Math.random() * atomSet.length);
        cents.push({ lat: atomSet[firstIdx].lat, lng: atomSet[firstIdx].lng });

        while (cents.length < numClusters) {
            // True k-means++: weighted-random pick, probability ∝ distance²
            const weights = new Array(atomSet.length);
            let total = 0;
            for (let i = 0; i < atomSet.length; i++) {
                let minDist = Infinity;
                for (const c of cents) {
                    const d = (atomSet[i].lat - c.lat) ** 2 + (atomSet[i].lng - c.lng) ** 2;
                    if (d < minDist) minDist = d;
                }
                weights[i] = minDist;
                total += minDist;
            }
            let target = Math.random() * total;
            let pickIdx = 0;
            for (let i = 0; i < atomSet.length; i++) {
                target -= weights[i];
                if (target <= 0) { pickIdx = i; break; }
            }
            cents.push({ lat: atomSet[pickIdx].lat, lng: atomSet[pickIdx].lng });
        }

        // Iterate
        const asgn = new Array(atomSet.length).fill(0);
        for (let iter = 0; iter < 30; iter++) {
            let changed = false;
            for (let i = 0; i < atomSet.length; i++) {
                let bestC = 0, bestD = Infinity;
                for (let ci = 0; ci < numClusters; ci++) {
                    const d = (atomSet[i].lat - cents[ci].lat) ** 2 +
                              (atomSet[i].lng - cents[ci].lng) ** 2;
                    if (d < bestD) { bestD = d; bestC = ci; }
                }
                if (asgn[i] !== bestC) { asgn[i] = bestC; changed = true; }
            }
            if (!changed) break;
            for (let ci = 0; ci < numClusters; ci++) {
                let sLat = 0, sLng = 0, n = 0;
                for (let i = 0; i < atomSet.length; i++) {
                    if (asgn[i] === ci) { sLat += atomSet[i].lat; sLng += atomSet[i].lng; n++; }
                }
                if (n > 0) { cents[ci].lat = sLat / n; cents[ci].lng = sLng / n; }
            }
        }

        const buckets = [];
        for (let ci = 0; ci < numClusters; ci++) buckets.push([]);
        for (let i = 0; i < atomSet.length; i++) buckets[asgn[i]].push(atomSet[i]);
        return buckets;
    }

    function bucketSize(bucket) {
        return bucket.reduce((s, a) => s + a.size, 0);
    }

    function bucketCentroid(bucket) {
        if (!bucket.length) return null;
        let sLat = 0, sLng = 0;
        for (const a of bucket) { sLat += a.lat; sLng += a.lng; }
        return { lat: sLat / bucket.length, lng: sLng / bucket.length };
    }

    // Spatial snake sort — direction adapts to spread relative to camp.
    // Campers spread N/S from camp → primary sort by LNG (vertical E/W slices)
    // Campers spread E/W from camp → primary sort by LAT (horizontal N/S slices)
    function spatialSnakeSort(atomList) {
        if (atomList.length < 2) return [...atomList];
        const lats = atomList.map(a => a.lat);
        const lngs = atomList.map(a => a.lng);
        const latSpread = Math.max(...lats) - Math.min(...lats);
        const lngSpread = Math.max(...lngs) - Math.min(...lngs);
        // lngSpread is in degrees — scale to approx miles at this latitude
        const avgLat = lats.reduce((s, l) => s + l, 0) / lats.length;
        const lngMiles = lngSpread * Math.cos(avgLat * Math.PI / 180) * 69;
        const latMiles = latSpread * 69;

        const northSouth = latMiles >= lngMiles;
        if (northSouth) {
            // Buses travel N/S → split into vertical columns (sort by lng first)
            return [...atomList].sort((a, b) => a.lng - b.lng || a.lat - b.lat);
        } else {
            // Buses travel E/W → split into horizontal rows (sort by lat first)
            return [...atomList].sort((a, b) => a.lat - b.lat || a.lng - b.lng);
        }
    }

    // Even spatial split: sort atoms with direction-aware snake, cut into n chunks
    function evenSpatialSplit(atomList, n) {
        const sorted = spatialSnakeSort(atomList);
        const total = sorted.reduce((s, a) => s + a.size, 0);
        const target = Math.ceil(total / n);
        const buckets = [];
        let cur = [], curSz = 0;
        for (const atom of sorted) {
            if (curSz + atom.size > target && cur.length > 0 && buckets.length < n - 1) {
                buckets.push(cur);
                cur = []; curSz = 0;
            }
            cur.push(atom);
            curSz += atom.size;
        }
        if (cur.length) buckets.push(cur);
        return buckets;
    }

    // Capacity-preserving boundary-swap rebalance.
    // For each atom, if another cluster's centroid is closer than its current,
    // swap with the most "misplaced" atom in that other cluster (one whose own
    // best move is back to ours). Cluster sizes never change. Iterate until stable.
    function rebalanceToNearest(buckets, maxIter) {
        if (buckets.length < 2) return 0;
        let totalSwaps = 0;
        for (let iter = 0; iter < (maxIter || 8); iter++) {
            const cents = buckets.map(b => bucketCentroid(b));
            let swaps = 0;
            for (let bi = 0; bi < buckets.length; bi++) {
                if (!cents[bi]) continue;
                for (let ai = 0; ai < buckets[bi].length; ai++) {
                    const atom = buckets[bi][ai];
                    let bestB = bi, bestD = haversineMi(atom.lat, atom.lng, cents[bi].lat, cents[bi].lng);
                    for (let bj = 0; bj < buckets.length; bj++) {
                        if (bj === bi || !cents[bj]) continue;
                        const d = haversineMi(atom.lat, atom.lng, cents[bj].lat, cents[bj].lng);
                        if (d < bestD) { bestD = d; bestB = bj; }
                    }
                    if (bestB === bi) continue;
                    // Find swap partner in bestB whose nearest is bi (or improvement is largest)
                    let partnerIdx = -1, partnerGain = 0;
                    for (let pj = 0; pj < buckets[bestB].length; pj++) {
                        const p = buckets[bestB][pj];
                        const dHere = haversineMi(p.lat, p.lng, cents[bestB].lat, cents[bestB].lng);
                        const dThere = haversineMi(p.lat, p.lng, cents[bi].lat, cents[bi].lng);
                        const gain = dHere - dThere;
                        if (gain > partnerGain) { partnerGain = gain; partnerIdx = pj; }
                    }
                    if (partnerIdx < 0) continue;
                    const tmp = buckets[bi][ai];
                    buckets[bi][ai] = buckets[bestB][partnerIdx];
                    buckets[bestB][partnerIdx] = tmp;
                    swaps++;
                }
            }
            totalSwaps += swaps;
            if (swaps === 0) break;
        }
        return totalSwaps;
    }

    // Time estimate for a bucket: drive to/from camp + per-stop time + intra-cluster spread.
    // Used by Phase 3 (split trigger + split count) and Phase 5 (cascade).
    const STOP_WEIGHT = 120;   // seconds per camper (boarding, walking)
    const INTRA_WEIGHT = 120;  // seconds per spread-mi × sqrt(atoms)
    // Arterial-aware spread: atoms sharing a primary arterial are conceptually close
    // because the bus drives the arterial fast. Without this, two clusters strung
    // along Hillside Blvd 4mi apart read as 4mi spread → fail the cap → get split.
    // Closes the historical-vs-ours fragmentation gap (PEACH/PURPLE/MAROON cases).
    let _arterialFingerprint = null;
    function bucketSpread(bucket) {
        if (!bucket.length) return 0;
        const lats = bucket.map(a => a.lat);
        const lngs = bucket.map(a => a.lng);
        const raw = haversineMi(
            Math.min(...lats), Math.min(...lngs),
            Math.max(...lats), Math.max(...lngs));
        if (!_arterialFingerprint) return raw;
        // Find the dominant arterial in the bucket
        const counts = new Map();
        for (const atom of bucket) {
            const a = _arterialFingerprint.get(atom);
            if (a) counts.set(a, (counts.get(a) || 0) + 1);
        }
        if (!counts.size) return raw;
        let domName = null, domN = 0;
        for (const [n, c] of counts) if (c > domN) { domN = c; domName = n; }
        // Discount: if ≥70% of atoms share the dominant arterial, allow up to 25%
        // discount, but never reduce by more than 1.0mi absolute. A 5mi cluster
        // along an arterial still reads as 4mi — too wide for the cap. Only
        // moderately-spread arterial-aligned clusters benefit.
        const share = domN / bucket.length;
        if (share < 0.7) return raw;
        const pctDiscount = Math.min(0.25, (share - 0.7) * 0.83); // 0.7→0, 1.0→0.25
        const absDiscount = Math.min(raw * pctDiscount, 1.0);
        return raw - absDiscount;
    }
    function estimateBucketTime(bucket) {
        if (!bucket.length) return 0;
        const cent = bucketCentroid(bucket);
        const driveSec = drivingDist(campLat, campLng, cent.lat, cent.lng);
        const spread = bucketSpread(bucket);
        const numKids = bucket.reduce((s, a) => s + a.size, 0);
        const intra = spread * Math.sqrt(bucket.length) * INTRA_WEIGHT;
        return 2 * driveSec + numKids * STOP_WEIGHT + intra;
    }

    showProgress(shiftLabel + ': clustering — building atoms...', pctBase + 10);

    // Prefetch major roads so spread metric can discount intra-arterial atoms.
    // Cached across shifts via _majorRoadsBboxKey.
    await _prefetchMajorRoads(allCampers);

    // ── A. Build sibling atoms ──
    const sibMap = detectSiblings(allCampers);
    applyRideWith(allCampers);

    const sibGroups = {};
    for (const [name, gid] of Object.entries(sibMap)) {
        (sibGroups[gid] ||= []).push(name);
    }
    const camperByName = {};
    allCampers.forEach(c => { camperByName[c.name] = c; });

    const atoms = [];
    const atomized = new Set();

    for (const members of Object.values(sibGroups)) {
        const campers = members.map(n => camperByName[n]).filter(Boolean);
        if (!campers.length) continue;
        campers.forEach(c => atomized.add(c.name));
        atoms.push({
            members: campers,
            size: campers.length,
            lat: campers.reduce((s, c) => s + c.lat, 0) / campers.length,
            lng: campers.reduce((s, c) => s + c.lng, 0) / campers.length
        });
    }
    allCampers.forEach(c => {
        if (!atomized.has(c.name)) {
            atoms.push({ members: [c], size: 1, lat: c.lat, lng: c.lng });
        }
    });

    console.log('[Go v6] Clustering: ' + atoms.length + ' atoms from ' +
        allCampers.length + ' campers (' + Object.keys(sibGroups).length + ' sibling groups)');

    // Build per-atom arterial fingerprint so bucketSpread can discount intra-arterial atoms.
    _arterialFingerprint = _buildArterialFingerprints(atoms);
    if (_majorRoadSegments?.length) {
        const tagged = [..._arterialFingerprint.values()].filter(Boolean).length;
        console.log('[Go v6] Arterial fingerprints: ' + tagged + '/' + atoms.length + ' atoms tagged');
    }

    // ── B. Phase 1: Initial k-means with k = numBuses ──
    showProgress(shiftLabel + ': phase 1 — initial k-means...', pctBase + 15);

    const k = shiftVehicles.length;
    let busBuckets = runKMeans(atoms, k);
    const p1Swaps = rebalanceToNearest(busBuckets, 8);

    console.log('[Go v6] ═══════════════════════════════════════');
    console.log('[Go v6] PHASE 1: Initial k-means (' + k + ' clusters, ' + p1Swaps + ' rebalance swaps)');
    console.log('[Go v6] ═══════════════════════════════════════');
    for (let i = 0; i < busBuckets.length; i++) {
        const count = bucketSize(busBuckets[i]);
        console.log('[Go v6]   Cluster ' + (i + 1) + ': ' + count + ' campers' +
            (count < MIN_BUS_THRESHOLD ? ' ← DISSOLVE' : ''));
    }

    // ── C. Phase 2: Dissolve small clusters, re-cluster dense areas ──
    showProgress(shiftLabel + ': phase 2 — dissolving small clusters...', pctBase + 25);

    // ── C. Phase 2: Dissolve small clusters in rounds until all are 34+ ──
    // Each round: find smallest cluster, merge into nearest neighbor.
    // Repeat until every cluster has 34+ campers. Freed buses stay unused.
    let round = 0;
    while (true) {
        let smallestIdx = -1, smallestSize = Infinity;
        for (let i = 0; i < busBuckets.length; i++) {
            const sz = bucketSize(busBuckets[i]);
            if (sz > 0 && sz < MIN_BUS_THRESHOLD && sz < smallestSize) {
                smallestSize = sz;
                smallestIdx = i;
            }
        }
        if (smallestIdx < 0) break;

        round++;
        const cent = bucketCentroid(busBuckets[smallestIdx]);
        let nearestIdx = -1, nearestDist = Infinity;
        for (let i = 0; i < busBuckets.length; i++) {
            if (i === smallestIdx || busBuckets[i].length === 0) continue;
            const c = bucketCentroid(busBuckets[i]);
            if (!c) continue;
            const d = haversineMi(cent.lat, cent.lng, c.lat, c.lng);
            if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
        }
        if (nearestIdx < 0) break;

        const fromSize = bucketSize(busBuckets[smallestIdx]);
        const toSize = bucketSize(busBuckets[nearestIdx]);
        for (const atom of busBuckets[smallestIdx]) {
            busBuckets[nearestIdx].push(atom);
        }
        console.log('[Go v6] Round ' + round + ': merged cluster ' + (smallestIdx + 1) +
            ' (' + fromSize + ' campers) → cluster ' + (nearestIdx + 1) +
            ' (' + toSize + ' → ' + bucketSize(busBuckets[nearestIdx]) + ' campers, ' +
            nearestDist.toFixed(2) + 'mi apart)');
        busBuckets[smallestIdx] = [];
    }

    // Remove empty buckets
    busBuckets = busBuckets.filter(b => b.length > 0);
    let unusedBuses = k - busBuckets.length;
    if (round > 0) {
        const p2Swaps = rebalanceToNearest(busBuckets, 8);
        console.log('[Go v6] Dissolve complete: ' + round + ' merges, ' +
            busBuckets.length + ' clusters remain, ' + unusedBuses + ' buses to redistribute, ' +
            p2Swaps + ' rebalance swaps');
    } else {
        console.log('[Go v6] No clusters dissolved — all had ' + MIN_BUS_THRESHOLD + '+ campers');
    }

    // ── D. Phase 3: Split oversized clusters using freed buses ──
    // Find largest cluster, compute how many buses it needs (ceil(size/capacity)),
    // re-cluster its atoms into that many sub-clusters via k-means.
    // Repeat until we run out of freed buses.
    showProgress(shiftLabel + ': phase 3 — splitting large clusters...', pctBase + 35);

    // Target time per bus = 1.4 × median of initial bucket times. Far-from-camp clusters
    // exceed this naturally; splitting them produces more buses with smaller territories.
    const initBucketTimes = busBuckets.map(b => estimateBucketTime(b));
    const sortedInit = [...initBucketTimes].sort((a, b) => a - b);
    const initMedian = sortedInit[Math.floor(sortedInit.length / 2)] || 1;
    const TARGET_BUS_TIME = initMedian * 1.4;
    const PHASE3_HARD_SPREAD = D.setup.clusterMaxSpreadMi ?? 3.5;
    const SPREAD_SEC_PER_MI = 3600 / (D.setup.avgSpeed || 25);
    console.log('[Go v6] Time target per bus: ' + (TARGET_BUS_TIME / 60).toFixed(1) +
        'min (1.4× median ' + (initMedian / 60).toFixed(1) + 'min), spread cap ' +
        PHASE3_HARD_SPREAD.toFixed(1) + 'mi');

    let splitRound = 0;
    let splitSafety = 0;
    let lastWorstScore = Infinity;
    let stagnantRounds = 0;
    while (splitSafety++ < k * 2) {
        // Worst cluster = max overrun across capacity AND time. Score combines both:
        // capOver = (size - SOFT_CAPACITY) when over; timeOver = (time - TARGET) when over.
        // Convert capacity to seconds via STOP_WEIGHT for unified comparison.
        let largestIdx = -1, worstScore = 0;
        for (let i = 0; i < busBuckets.length; i++) {
            const sz = bucketSize(busBuckets[i]);
            const t = estimateBucketTime(busBuckets[i]);
            const sp = bucketSpread(busBuckets[i]);
            const capOverSec = Math.max(0, (sz - SOFT_CAPACITY) * STOP_WEIGHT);
            const timeOverSec = Math.max(0, t - TARGET_BUS_TIME);
            const spreadOverSec = Math.max(0, sp - PHASE3_HARD_SPREAD) * SPREAD_SEC_PER_MI;
            const score = Math.max(capOverSec, timeOverSec, spreadOverSec);
            if (score > worstScore) { worstScore = score; largestIdx = i; }
        }
        if (largestIdx < 0 || worstScore <= 0) break;
        const largestSize = bucketSize(busBuckets[largestIdx]);
        const largestTime = estimateBucketTime(busBuckets[largestIdx]);
        if (worstScore >= lastWorstScore) {
            if (++stagnantRounds >= 2) {
                console.log('[Go v6] Split aborted: no progress (worst score ' + worstScore.toFixed(0) + ')');
                break;
            }
        } else {
            stagnantRounds = 0;
        }
        lastWorstScore = worstScore;

        // Need enough buses to bring capacity, time, AND spread under their targets
        const largestSpread = bucketSpread(busBuckets[largestIdx]);
        const busesForCap = Math.ceil(largestSize / avgCapacity);
        const busesForTime = Math.ceil(largestTime / TARGET_BUS_TIME);
        const busesForSpread = largestSpread > PHASE3_HARD_SPREAD
            ? Math.max(2, Math.ceil(largestSpread / PHASE3_HARD_SPREAD))
            : 1;
        let neededBuses = Math.max(busesForCap, busesForTime, busesForSpread);
        let extraBuses = neededBuses - 1;
        if (extraBuses <= 0) break;

        // Anti-ping-pong: refuse to split if sub-clusters would land below CASCADE_FLOOR.
        // Splitting a 16-camper cluster into 8+8 just triggers a free-up merge, which
        // creates a new oversized cluster, which gets split again — infinite loop.
        //
        // EXCEPT: when the cluster's spread is severely over the hard cap
        // (≥1.8× PHASE3_HARD_SPREAD), the wedge is geographically broken and
        // routing it on one bus produces 100+ minute routes. In that case
        // the floor is overridden — better to have small sub-clusters than
        // an unroutable mega-wedge.
        const minSubSize = Math.floor(largestSize / neededBuses);
        const spreadIsSevere = largestSpread >= PHASE3_HARD_SPREAD * 1.8;
        if (minSubSize < CASCADE_FLOOR && !spreadIsSevere) {
            console.log('[Go v6] Skip split: cluster ' + (largestIdx + 1) +
                ' (' + largestSize + ' campers) would produce sub-clusters of ' +
                minSubSize + ' < floor ' + CASCADE_FLOOR);
            break;
        }
        if (spreadIsSevere && minSubSize < CASCADE_FLOOR) {
            console.warn('[Go v6] Forcing split despite floor: cluster ' +
                (largestIdx + 1) + ' has ' + largestSpread.toFixed(2) +
                'mi spread (' + (PHASE3_HARD_SPREAD * 1.8).toFixed(1) +
                'mi threshold). Sub-clusters of ' + minSubSize + ' < floor ' +
                CASCADE_FLOOR + ' but a 1-bus mega-wedge is worse.');
        }

        // If we don't have enough freed buses, free more by merging smallest clusters
        // into their nearest neighbor (as long as the merge doesn't exceed capacity).
        // If no valid pair exists, absorb nearest small cluster INTO the largest and
        // re-split the bigger result. Keeps cluster count balanced.
        while (unusedBuses < extraBuses) {
            let smallIdx = -1, smallSize = Infinity;
            for (let i = 0; i < busBuckets.length; i++) {
                if (i === largestIdx) continue;
                const sz = bucketSize(busBuckets[i]);
                if (sz < smallSize) { smallSize = sz; smallIdx = i; }
            }

            let merged = false;
            if (smallIdx >= 0) {
                const sCent = bucketCentroid(busBuckets[smallIdx]);
                let nearIdx = -1, nearDist = Infinity;
                for (let i = 0; i < busBuckets.length; i++) {
                    if (i === smallIdx || i === largestIdx) continue;
                    if (bucketSize(busBuckets[i]) + smallSize > SOFT_CAPACITY) continue;
                    const c = bucketCentroid(busBuckets[i]);
                    const d = haversineMi(sCent.lat, sCent.lng, c.lat, c.lng);
                    if (d < nearDist) { nearDist = d; nearIdx = i; }
                }

                if (nearIdx >= 0) {
                    console.log('[Go v6] Free-up merge: cluster ' + (smallIdx + 1) +
                        ' (' + smallSize + ' campers) → cluster ' + (nearIdx + 1) +
                        ' (' + bucketSize(busBuckets[nearIdx]) + ' → ' +
                        (bucketSize(busBuckets[nearIdx]) + smallSize) + ' campers)');
                    busBuckets[nearIdx] = busBuckets[nearIdx].concat(busBuckets[smallIdx]);
                    busBuckets.splice(smallIdx, 1);
                    if (smallIdx < largestIdx) largestIdx--;
                    unusedBuses++;
                    merged = true;
                }
            }

            if (!merged) {
                // Steal-from-smallest: force-dissolve the globally smallest cluster
                // (excluding the over-capacity one). Each atom moves to its nearest
                // remaining cluster by haversine. Frees 1 bus without creating a mega-blob.
                let stealIdx = -1, stealSize = Infinity;
                for (let i = 0; i < busBuckets.length; i++) {
                    if (i === largestIdx) continue;
                    const sz = bucketSize(busBuckets[i]);
                    if (sz < stealSize) { stealSize = sz; stealIdx = i; }
                }
                if (stealIdx < 0) break;

                console.log('[Go v6] Steal-from-smallest: dissolving cluster ' + (stealIdx + 1) +
                    ' (' + stealSize + ' campers) into geographic neighbors');

                // Redistribute each atom to nearest other cluster centroid
                const dissolved = busBuckets[stealIdx];
                busBuckets.splice(stealIdx, 1);
                if (stealIdx < largestIdx) largestIdx--;

                for (const atom of dissolved) {
                    let bestIdx = -1, bestDist = Infinity;
                    // Prefer nearest cluster that won't exceed SOFT_CAPACITY
                    for (let i = 0; i < busBuckets.length; i++) {
                        if (bucketSize(busBuckets[i]) + atom.size > SOFT_CAPACITY) continue;
                        const c = bucketCentroid(busBuckets[i]);
                        const d = haversineMi(atom.lat, atom.lng, c.lat, c.lng);
                        if (d < bestDist) { bestDist = d; bestIdx = i; }
                    }
                    // Fallback: no cluster has room → nearest regardless
                    if (bestIdx < 0) {
                        for (let i = 0; i < busBuckets.length; i++) {
                            const c = bucketCentroid(busBuckets[i]);
                            const d = haversineMi(atom.lat, atom.lng, c.lat, c.lng);
                            if (d < bestDist) { bestDist = d; bestIdx = i; }
                        }
                    }
                    if (bestIdx >= 0) busBuckets[bestIdx].push(atom);
                }

                unusedBuses++;
                const newSize = bucketSize(busBuckets[largestIdx]);
                const newTime = estimateBucketTime(busBuckets[largestIdx]);
                const newSpread = bucketSpread(busBuckets[largestIdx]);
                const newBusesForSpread = newSpread > PHASE3_HARD_SPREAD
                    ? Math.max(2, Math.ceil(newSpread / PHASE3_HARD_SPREAD))
                    : 1;
                neededBuses = Math.max(
                    Math.ceil(newSize / avgCapacity),
                    Math.ceil(newTime / TARGET_BUS_TIME),
                    newBusesForSpread
                );
                extraBuses = neededBuses - 1;
            }
        }

        const busesToUse = Math.min(extraBuses, unusedBuses);
        if (busesToUse <= 0) break;
        const splitInto = busesToUse + 1;

        splitRound++;
        console.log('[Go v6] Split ' + splitRound + ': cluster ' + (largestIdx + 1) +
            ' (' + largestSize + ' campers) → ' + splitInto + ' sub-clusters' +
            ' (needs ' + neededBuses + ' buses, using ' + busesToUse + ' freed buses)');

        const clusterAtoms = busBuckets[largestIdx];
        const subBuckets = evenSpatialSplit(clusterAtoms, splitInto);

        busBuckets.splice(largestIdx, 1, ...subBuckets);

        unusedBuses -= busesToUse;

        for (let si = 0; si < subBuckets.length; si++) {
            console.log('[Go v6]   Sub-cluster ' + (si + 1) + ': ' +
                bucketSize(subBuckets[si]) + ' campers, ' + subBuckets[si].length + ' atoms');
        }
    }

    if (splitRound > 0) {
        const p3Swaps = rebalanceToNearest(busBuckets, 12);
        console.log('[Go v6] Split complete: ' + splitRound + ' splits, ' +
            busBuckets.length + ' total clusters, ' + unusedBuses + ' buses still unused, ' +
            p3Swaps + ' rebalance swaps');
    }

    // Remove any empty buckets
    busBuckets = busBuckets.filter(b => b.length > 0);

    // ── F. Phase 5: Min-max hill climb on route time ──
    // Goal: minimize the LONGEST route. Pick the worst cluster, try moving each
    // of its atoms to every other cluster, apply the move that lowers the max
    // by the most. Repeat until no move improves the max. Equality is NOT a goal.
    showProgress(shiftLabel + ': phase 5 — min-max hill climb...', pctBase + 55);

    const clusterMeta = busBuckets.map((bucket, idx) => {
        const cent = bucketCentroid(bucket);
        const distSec = drivingDist(campLat, campLng, cent.lat, cent.lng);
        return { idx, cent, distSec };
    });

    const estTime = (bucketIdx) => estimateBucketTime(busBuckets[bucketIdx]);

    function median(arr) {
        const sorted = [...arr].sort((a, b) => a - b);
        const m = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
    }

    console.log('[Go v6] ═══════════════════════════════════════');
    console.log('[Go v6] PHASE 5: Sum-minimization hill climb (lower every route)');
    console.log('[Go v6] ═══════════════════════════════════════');
    const initTimes = busBuckets.map((_, i) => estTime(i));
    const initMax = Math.max(...initTimes);
    console.log('[Go v6] Initial: max ' + (initMax / 60).toFixed(1) +
        'min, median ' + (median(initTimes) / 60).toFixed(1) + 'min, min ' +
        (Math.min(...initTimes) / 60).toFixed(1) + 'min');

    // Per-cluster spread cap, scaled by distance from camp.
    // cap(c) = medianSpread × ratio × (c.distFromCamp / medianDistFromCamp)
    // Close-to-camp clusters get tight caps (kids are dense, no excuse to sprawl);
    // far-from-camp clusters get proportionally larger caps (kids are sparse).
    const spreadRatio = (D.setup.clusterSpreadRatio ?? 150) / 100;
    const HARD_SPREAD_CAP = D.setup.clusterMaxSpreadMi ?? 3.5;
    console.log('[Go v6] Spread cap: ' + spreadRatio.toFixed(2) +
        '× median, scaled by distance-from-camp, hard ceiling ' + HARD_SPREAD_CAP.toFixed(1) + 'mi');

    // Spread relief pre-pass: any cluster over the hard cap gets its outermost
    // atoms peeled to the nearest under-cap cluster with capacity, regardless of
    // sum impact. Prevents the rare 6+mi route (Bus 13 = 111min in last run).
    let reliefMoves = 0;
    for (let safety = 0; safety < 200; safety++) {
        const spreads = busBuckets.map(b => bucketSpread(b));
        let worstI = -1, worstSpread = HARD_SPREAD_CAP;
        for (let i = 0; i < spreads.length; i++) if (spreads[i] > worstSpread) { worstSpread = spreads[i]; worstI = i; }
        if (worstI < 0) break;

        const cent = bucketCentroid(busBuckets[worstI]);
        if (!cent) break;
        // Find the atom furthest from centroid (the outlier)
        let outAi = -1, outD = -1;
        for (let ai = 0; ai < busBuckets[worstI].length; ai++) {
            const a = busBuckets[worstI][ai];
            const d = haversineMi(a.lat, a.lng, cent.lat, cent.lng);
            if (d > outD) { outD = d; outAi = ai; }
        }
        if (outAi < 0) break;
        const outlier = busBuckets[worstI][outAi];
        if (bucketSize(busBuckets[worstI]) - outlier.size < CASCADE_FLOOR) break;

        // Pick nearest cluster with capacity. Under-cap receivers must stay under;
        // over-cap receivers must not get worse.
        let bestRi = -1, bestD = Infinity;
        for (let ri = 0; ri < busBuckets.length; ri++) {
            if (ri === worstI) continue;
            if (bucketSize(busBuckets[ri]) + outlier.size > SOFT_CAPACITY) continue;
            const rc = bucketCentroid(busBuckets[ri]);
            if (!rc) continue;
            const curRcvSpread = spreads[ri];
            busBuckets[ri].push(outlier);
            const newSpread = bucketSpread(busBuckets[ri]);
            busBuckets[ri].pop();
            const ok = curRcvSpread <= HARD_SPREAD_CAP
                ? newSpread <= HARD_SPREAD_CAP
                : newSpread <= curRcvSpread;
            if (!ok) continue;
            const d = haversineMi(outlier.lat, outlier.lng, rc.lat, rc.lng);
            if (d < bestD) { bestD = d; bestRi = ri; }
        }
        if (bestRi < 0) break;
        busBuckets[worstI].splice(outAi, 1);
        busBuckets[bestRi].push(outlier);
        reliefMoves++;
    }
    if (reliefMoves > 0) console.log('[Go v6] Spread relief: ' + reliefMoves + ' outlier atoms peeled to fit hard cap');

    let moves = 0;
    let blockedBySpread = 0;
    for (let pass = 0; pass < 500; pass++) {
        // Snapshot all current times for fast sum-delta calculations
        const allTimes = busBuckets.map((_, i) => estTime(i));
        const currentSum = allTimes.reduce((s, t) => s + t, 0);
        const allSpreads = busBuckets.map(b => bucketSpread(b));
        const sortedSpreads = [...allSpreads].sort((a, b) => a - b);
        const medianSpread = sortedSpreads[Math.floor(sortedSpreads.length / 2)] || 0;

        // Distance-from-camp per cluster (use centroid → camp haversine for speed)
        const allDists = busBuckets.map(b => {
            const c = bucketCentroid(b);
            return c ? haversineMi(campLat, campLng, c.lat, c.lng) : 0;
        });
        const sortedDists = [...allDists].sort((a, b) => a - b);
        const medianDist = sortedDists[Math.floor(sortedDists.length / 2)] || 1;
        const baseCap = medianSpread * spreadRatio;

        // Search every (source, atom, receiver) tuple. Best move = one that
        // reduces the GLOBAL SUM by the most. Reduces every bus that can be
        // reduced; the worst falls naturally as it gets atoms peeled off.
        let bestMove = null;
        let bestNewSum = currentSum;

        for (let si = 0; si < busBuckets.length; si++) {
            const sourceSize = bucketSize(busBuckets[si]);
            if (sourceSize <= CASCADE_FLOOR) continue;

            for (let ai = 0; ai < busBuckets[si].length; ai++) {
                const atom = busBuckets[si][ai];
                if (sourceSize - atom.size < CASCADE_FLOOR) continue;

                // Simulate removal once
                busBuckets[si].splice(ai, 1);
                const newSourceTime = estTime(si);

                // Geographic constraint: receiver must be atom's nearest centroid
                // (other than the source). Prevents atoms leaking to far clusters.
                let nearestRi = -1, nearestD = Infinity;
                for (let ri = 0; ri < busBuckets.length; ri++) {
                    if (ri === si) continue;
                    const c = bucketCentroid(busBuckets[ri]);
                    if (!c) continue;
                    const d = haversineMi(atom.lat, atom.lng, c.lat, c.lng);
                    if (d < nearestD) { nearestD = d; nearestRi = ri; }
                }

                const ri = nearestRi;
                if (ri >= 0 && ri !== si) {
                    const receiverCap = Math.min(HARD_SPREAD_CAP, baseCap * Math.max(0.4, allDists[ri] / medianDist));

                    // === SINGLE MOVE: atom A → bus Y (no swap) ===
                    if (bucketSize(busBuckets[ri]) + atom.size <= SOFT_CAPACITY) {
                        busBuckets[ri].push(atom);
                        const newReceiverTime = estTime(ri);
                        const newReceiverSpread = bucketSpread(busBuckets[ri]);
                        busBuckets[ri].pop();

                        // Hard-cap semantics: under-cap clusters can't grow past it;
                        // over-cap clusters can only accept moves that don't worsen them.
                        const rcvOk = allSpreads[ri] <= HARD_SPREAD_CAP
                            ? newReceiverSpread <= HARD_SPREAD_CAP
                            : newReceiverSpread <= allSpreads[ri];
                        if (rcvOk && (newReceiverSpread <= receiverCap || newReceiverSpread <= allSpreads[ri])) {
                            const newSum = currentSum
                                - allTimes[si] - allTimes[ri]
                                + newSourceTime + newReceiverTime;
                            if (newSum < bestNewSum) {
                                bestNewSum = newSum;
                                bestMove = { type: 'single', si, ai, ri };
                            }
                        } else {
                            blockedBySpread++;
                        }
                    }

                    // === PAIR SWAP: atom A in si ↔ atom B in ri ===
                    // Only attempt if atom B's nearest cluster is si (mutual nearness)
                    // and the swap keeps both clusters under spread caps.
                    const sourceCent = bucketCentroid(busBuckets[si]);  // si without atom
                    for (let bi = 0; bi < busBuckets[ri].length; bi++) {
                        const atomB = busBuckets[ri][bi];

                        // Capacity check after swap
                        const newSrcSize = sourceSize - atom.size + atomB.size;
                        const newRcvSize = bucketSize(busBuckets[ri]) - atomB.size + atom.size;
                        if (newSrcSize > SOFT_CAPACITY || newRcvSize > SOFT_CAPACITY) continue;
                        if (newSrcSize < CASCADE_FLOOR || newRcvSize < CASCADE_FLOOR) continue;

                        // Mutual-nearness: atomB's nearest cluster (excluding ri) must be si
                        let bNearest = -1, bNearestD = Infinity;
                        for (let cj = 0; cj < busBuckets.length; cj++) {
                            if (cj === ri) continue;
                            const c = (cj === si) ? sourceCent : bucketCentroid(busBuckets[cj]);
                            if (!c) continue;
                            const d = haversineMi(atomB.lat, atomB.lng, c.lat, c.lng);
                            if (d < bNearestD) { bNearestD = d; bNearest = cj; }
                        }
                        if (bNearest !== si) continue;

                        // Simulate the swap
                        busBuckets[si].splice(ai, 0, atomB);   // put B into si at A's old slot
                        busBuckets[ri].splice(bi, 1);          // remove B from ri
                        busBuckets[ri].push(atom);             // put A into ri
                        const swappedSrcTime = estTime(si);
                        const swappedRcvTime = estTime(ri);
                        const swappedSrcSpread = bucketSpread(busBuckets[si]);
                        const swappedRcvSpread = bucketSpread(busBuckets[ri]);
                        // Undo
                        busBuckets[ri].pop();
                        busBuckets[ri].splice(bi, 0, atomB);
                        busBuckets[si].splice(ai, 1);

                        const srcCap = Math.min(HARD_SPREAD_CAP, baseCap * Math.max(0.4, allDists[si] / medianDist));
                        // Hard cap: under-cap clusters can't grow past it; over-cap can't get worse
                        const srcOver = (allSpreads[si] <= HARD_SPREAD_CAP)
                            ? swappedSrcSpread > HARD_SPREAD_CAP
                            : swappedSrcSpread > allSpreads[si];
                        const rcvOver = (allSpreads[ri] <= HARD_SPREAD_CAP)
                            ? swappedRcvSpread > HARD_SPREAD_CAP
                            : swappedRcvSpread > allSpreads[ri];
                        if (srcOver || rcvOver ||
                            (swappedSrcSpread > srcCap && swappedSrcSpread > allSpreads[si]) ||
                            (swappedRcvSpread > receiverCap && swappedRcvSpread > allSpreads[ri])) {
                            blockedBySpread++;
                            continue;
                        }

                        const swappedSum = currentSum
                            - allTimes[si] - allTimes[ri]
                            + swappedSrcTime + swappedRcvTime;
                        if (swappedSum < bestNewSum) {
                            bestNewSum = swappedSum;
                            bestMove = { type: 'swap', si, ai, ri, bi };
                        }
                    }
                }

                // Restore
                busBuckets[si].splice(ai, 0, atom);
            }
        }

        if (!bestMove) break;
        if (bestMove.type === 'swap') {
            const a = busBuckets[bestMove.si][bestMove.ai];
            const b = busBuckets[bestMove.ri][bestMove.bi];
            busBuckets[bestMove.si][bestMove.ai] = b;
            busBuckets[bestMove.ri][bestMove.bi] = a;
        } else {
            const movedAtom = busBuckets[bestMove.si].splice(bestMove.ai, 1)[0];
            busBuckets[bestMove.ri].push(movedAtom);
        }
        moves++;
    }

    const finalTimes = busBuckets.map((_, i) => estTime(i));
    const finalMax = Math.max(...finalTimes);
    const initSum = initTimes.reduce((s, t) => s + t, 0);
    const finalSum = finalTimes.reduce((s, t) => s + t, 0);
    console.log('[Go v6] Hill climb: ' + moves + ' atoms moved (sum ' +
        (initSum / 60).toFixed(0) + 'min → ' + (finalSum / 60).toFixed(0) +
        'min, max ' + (initMax / 60).toFixed(1) + 'min → ' + (finalMax / 60).toFixed(1) + 'min, ' +
        blockedBySpread + ' moves blocked by spread cap)');
    console.log('[Go v6] Final: max ' + (finalMax / 60).toFixed(1) +
        'min, median ' + (median(finalTimes) / 60).toFixed(1) + 'min, min ' +
        (Math.min(...finalTimes) / 60).toFixed(1) + 'min');

    // Refresh centroids after moves
    clusterMeta.forEach(m => { m.cent = bucketCentroid(busBuckets[m.idx]); });
    clusterMeta.forEach(m => { m.estTime = estTime(m.idx); });
    clusterMeta.sort((a, b) => b.distSec - a.distSec);

    // ── G. Log final cluster results ──
    console.log('[Go v6] ═══════════════════════════════════════');
    console.log('[Go v6] FINAL CLUSTERS');
    console.log('[Go v6] ═══════════════════════════════════════');
    const metaByIdx = {};
    clusterMeta.forEach(m => { metaByIdx[m.idx] = m; });
    for (let i = 0; i < busBuckets.length; i++) {
        const count = bucketSize(busBuckets[i]);
        const lats = busBuckets[i].map(a => a.lat);
        const lngs = busBuckets[i].map(a => a.lng);
        const meta = metaByIdx[i];
        const targetStr = meta ? ' (~' + (meta.estTime / 60).toFixed(0) + 'min est, ' + (meta.distSec / 60).toFixed(1) + 'min from camp)' : '';
        if (lats.length) {
            const spread = haversineMi(
                Math.min(...lats), Math.min(...lngs),
                Math.max(...lats), Math.max(...lngs));
            const cent = bucketCentroid(busBuckets[i]);
            console.log('[Go v6] Cluster ' + (i + 1) + ': ' +
                count + ' campers, ' + busBuckets[i].length + ' atoms, ' +
                spread.toFixed(2) + 'mi spread' + targetStr);
        } else {
            console.log('[Go v6] Cluster ' + (i + 1) + ': EMPTY');
        }
    }
    const totalCampers = busBuckets.reduce((s, b) => s + bucketSize(b), 0);
    console.log('[Go v6] Total: ' + totalCampers + ' campers in ' + busBuckets.length + ' clusters');
    console.log('[Go v6] ═══════════════════════════════════════');

    // ── G. Per-cluster stop creation based on dropoff mode ──
    // Each cluster is FROZEN — stop creators only operate on the campers given.
    // No camper crosses cluster boundaries from here on.
    showProgress(shiftLabel + ': building stops (' + dropoffMode + ')...', pctBase + 70);

    const routes = [];
    for (let bi = 0; bi < busBuckets.length; bi++) {
        const bucket = busBuckets[bi];
        const vehicle = shiftVehicles[bi] || shiftVehicles[0];
        const campers = bucket.flatMap(a => a.members);

        let stopsRaw;
        if (dropoffMode === 'corner-stops') {
            stopsRaw = await createCornerStops(campers);
        } else if (dropoffMode === 'optimized-stops') {
            stopsRaw = createOptimizedStops(campers);
        } else {
            stopsRaw = createHouseStops(campers);
        }

        routes.push({
            busId:        vehicle.busId,
            busName:      vehicle.name || vehicle.busId,
            busColor:     vehicle.color || '#10b981',
            monitor:      vehicle.monitor || null,
            counselors:   vehicle.counselors || [],
            stops:        stopsRaw.map((s, i) => ({
                stopNum: i + 1,
                campers: s.campers,
                address: s.address || '',
                lat: s.lat, lng: s.lng
            })),
            camperCount:  campers.length,
            _cap:         vehicle.capacity,
            totalDuration: 0,
            _source:      'spatial-sort'
        });
    }
    console.log('[Go v6] Stops created: ' + routes.reduce((s, r) => s + r.stops.length, 0) +
        ' total (mode: ' + dropoffMode + ')');

    // ── H. Per-bus Google TSP — orders stops within each bus, never crosses buses ──
    if (googleAvailable && routes.length) {
        showProgress(shiftLabel + ': optimizing stop order per bus...', pctBase + 80);
        for (const r of routes) {
            if (r.stops.length < 3) continue;
            try {
                const tspResult = await _perBusGoogleTSP({
                    route: r,
                    campLat, campLng,
                    isArrival,
                    serviceTimeSec,
                    googleKey, googleProjId,
                    _supabaseUrl, _googleProxyToken,
                    shift,
                    shiftIdx
                });
                if (tspResult) {
                    r.stops = tspResult.stops;
                    r.totalDuration = tspResult.totalDuration || r.totalDuration;
                    if (tspResult.roadPts) r._roadPts = tspResult.roadPts;
                    if (tspResult.tspLegTimes) r._tspLegTimes = tspResult.tspLegTimes;
                }
            } catch (e) {
                console.warn('[Go v6] Per-bus TSP failed for ' + r.busName +
                    ' — keeping unsorted stop order (' + e.message + ')');
            }
        }

        // Override TSP order: closest-to-camp first.
        // For dismissal: bus drops the nearest kid first, then fans outward.
        // For arrival: bus picks up the farthest first, returns toward camp.
        for (const r of routes) {
            if (r.stops.length < 2) continue;
            r.stops.sort((a, b) => {
                const da = haversineMi(campLat, campLng, a.lat, a.lng);
                const db = haversineMi(campLat, campLng, b.lat, b.lng);
                return isArrival ? (db - da) : (da - db);
            });
            r.stops.forEach((s, i) => s.stopNum = i + 1);
            // Drop solver leg times — they no longer match the new order
            delete r._tspLegTimes;
            delete r._roadPts;
        }
    }

    toast('✓ Routes complete — ' + routes.length + ' buses, ' +
        routes.reduce((s, r) => s + r.stops.length, 0) + ' stops (' + dropoffMode + ')');
    return routes;
}


function computeZoneTimeWindow(stops, campLat, campLng, isArrival,
                               shiftTargetHHMM, avgSpeedMph, avgStopMin) {
    if (!stops?.length) return { startHHMM: null, startWindowEndHHMM: null, endHHMM: null };

    // Mean distance from camp (miles).  Haversine is fine for back-solving —
    // the final stop times come from Google's real road matrix.
    let sumDist = 0;
    for (const s of stops) {
        sumDist += haversineMi(campLat, campLng, s.lat, s.lng);
    }
    const meanDist = sumDist / stops.length;

    // Estimate round-trip drive time from camp.  We use mean (not max) distance
    // because stops on the way back are closer to camp by definition.  The
    // factor of 2 accounts for going out and coming back.
    const estDriveMin = (meanDist * 2) / Math.max(1, avgSpeedMph) * 60;
    const estServiceMin = stops.length * Math.max(0.5, avgStopMin);
    const bufferMin = 10; // fudge factor for traffic, stop lights, boarding
    const totalMin = Math.round(estDriveMin + estServiceMin + bufferMin);

    const [tH, tM] = (shiftTargetHHMM || (isArrival ? '08:00' : '16:00'))
        .split(':').map(Number);
    const targetMin = tH * 60 + tM;

    if (isArrival) {
        // Bus starts early enough to reach camp by target.
        const startMinOfDay = Math.max(0, targetMin - totalMin);
        return {
            startHHMM:          _minsToHHMM(startMinOfDay),
            startWindowEndHHMM: null,
            endHHMM:            _minsToHHMM(targetMin)
        };
    } else {
        // Dismissal: bus leaves camp at target with a 5-min dispatch window.
        return {
            startHHMM:          _minsToHHMM(targetMin),
            startWindowEndHHMM: _minsToHHMM(targetMin + 5),
            endHHMM:            null
        };
    }
}

function _minsToHHMM(totalMin) {
    const h = Math.floor(totalMin / 60) % 24;
    const m = totalMin % 60;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
}


// =============================================================================
// REPLACEMENT _perBusGoogleTSP
//
// Same signature as Phase 1; inside, it now computes a per-bus time window
// from the bus's stops and passes it to Google so the solver back-solves
// from the correct arrival/departure target per zone.
// =============================================================================
async function _perBusGoogleTSP({
    route, campLat, campLng,
    isArrival, serviceTimeSec,
    googleKey, googleProjId,
    _supabaseUrl, _googleProxyToken,
    shift,
    shiftIdx    // NEW PHASE 3: the shift index for anchor lookup
}) {
    if (!window.GoGoogleOptimizer?.optimizeTours) return null;

    const singleBus = [{
        busId:    route.busId,
        name:     route.busName,
        color:    route.busColor,
        capacity: Math.max(route.camperCount + 10, 1000),
        monitor:  route.monitor,
        counselors: route.counselors
    }];

    const avgSpeedMph = D.setup.avgSpeed || 25;
    const avgStopMin  = D.setup.avgStopTime || 2;

    const shiftTarget = shift.departureTime || (isArrival ? '08:00' : '16:00');
    const zw = computeZoneTimeWindow(
        route.stops, campLat, campLng, isArrival,
        shiftTarget, avgSpeedMph, avgStopMin
    );

    const vehicleTimeWindows = [{
        busId:          route.busId,
        startTime:      zw.startHHMM,
        startWindowEnd: zw.startWindowEndHHMM,
        endTime:        zw.endHHMM
    }];

    // NEW PHASE 3: look up a user-pinned anchor, if any.
    // Requires _ensureFlags() to have been called at least once; the caller
    // (generateRoutes) ensures this before entering the shift loop.
    const pinnedIdx = _getPinnedAnchorIndex(route, shiftIdx);
    if (pinnedIdx != null) {
        console.log('[Go v5.3] Pinned anchor for ' + route.busName + ': stop #' +
            (pinnedIdx + 1) + ' (' + route.stops[pinnedIdx].address + ')');
    }

    console.log('[Go v5.3] Per-bus TSP ' + route.busName +
        ' (' + route.stops.length + ' stops, ' + route.camperCount + ' campers): ' +
        (isArrival
            ? 'pickup ' + (zw.startHHMM || '?') + ' → camp ' + (zw.endHHMM || '?')
            : 'camp ' + (zw.startHHMM || '?') + ' → dropoffs'));

    const result = await window.GoGoogleOptimizer.optimizeTours({
        stops: route.stops,
        vehicles: singleBus,
        campLat, campLng,
        isArrival,
        serviceTime:   serviceTimeSec,
        departureTime: shiftTarget,
        maxRideTimeSec: (D.setup.maxRideTime || 45) * 60,
        maxRouteDurationSec: (D.setup.maxRouteDuration || 60) * 60,
        vehicleTimeWindows,
        pinnedAnchorIndex: pinnedIdx,  // NEW PHASE 3
        googleKey, googleProjId,
        supabaseUrl: _supabaseUrl,
        accessToken: _googleProxyToken,
        anonKey: window.__CAMPISTRY_SUPABASE__?.anonKey || ''
    });

    if (!result || !result.length || !result[0].stops?.length) {
        console.warn('[Go v5.3] Per-bus TSP ' + route.busName + ' infeasible — retaining spine');
        return null;
    }

    const r = result[0];

    // Sanity: same campers in and out
    const inNames = new Set();
    for (const s of route.stops) for (const c of s.campers) {
        inNames.add(typeof c === 'string' ? c : c.name);
    }
    const outNames = new Set();
    for (const s of r.stops) for (const c of s.campers) {
        outNames.add(typeof c === 'string' ? c : c.name);
    }
    if (inNames.size !== outNames.size ||
        [...inNames].some(n => !outNames.has(n))) {
        console.error('[Go v5.3] Per-bus TSP altered camper set for ' + route.busName +
            ' — rejecting, keeping spine order');
        return null;
    }

    return {
        stops:         r.stops,
        totalDuration: r.totalDuration || 0,
        roadPts:       r._roadPts      || null,
        tspLegTimes:   r._tspLegTimes  || null
    };
}



// =============================================================================
// REPLACEMENT _fallbackGoogleGlobal
//
// Unchanged in shape from Phase 1 (Phase 2's hardening is inside the optimizer,
// not the caller).  The one difference: pass `vehicleTimeWindows` computed from
// each bus's share of stops.  Since the fallback path hasn't decided zones yet,
// we use a crude heuristic: sort stops by angle from camp, split into equal
// chunks per bus, then use those chunks to back-solve time windows.
// =============================================================================
async function _fallbackGoogleGlobal({
    shift, shiftLabel, pctBase,
    allCampers, shiftVehicles,
    campLat, campLng,
    reserveSeats,
    isArrival,
    googleKey, googleProjId,
    _supabaseUrl, _googleProxyToken,
    serviceTimeSec
}) {
    showProgress(shiftLabel + ': FALLBACK — creating corner stops...', pctBase + 15);

    const allStops = await createCornerStops(allCampers);

    const seen = new Set();
    const dedupStops = allStops.filter(s => {
        const key = Math.round(s.lat * 5000) + ',' + Math.round(s.lng * 5000);
        if (seen.has(key)) return false;
        seen.add(key); return true;
    });

    if (!dedupStops.length) {
        console.error('[Go v5.2] Fallback: createCornerStops produced 0 stops');
        return null;
    }

    showProgress(shiftLabel + ': FALLBACK — Google Route Optimization...', pctBase + 45);

    // Pre-assign stops to buses by angle-from-camp + equal-size chunks, purely
    // for the purpose of back-solving time windows.  The real assignment
    // happens inside Google; this is just an estimate.
    const avgSpeedMph = D.setup.avgSpeed || 25;
    const avgStopMin  = D.setup.avgStopTime || 2;
    const vehicleTimeWindows = _estimateFallbackTimeWindows(
        dedupStops, shiftVehicles, campLat, campLng,
        isArrival, shift.departureTime, avgSpeedMph, avgStopMin
    );

    const result = await window.GoGoogleOptimizer.optimizeTours({
        stops: dedupStops,
        vehicles: shiftVehicles,
        campLat, campLng,
        isArrival,
        serviceTime: serviceTimeSec,
        departureTime: shift.departureTime || (isArrival ? '07:30' : '16:00'),
        maxRideTimeSec: (D.setup.maxRideTime || 45) * 60,
        maxRouteDurationSec: (D.setup.maxRouteDuration || 60) * 60,
        vehicleTimeWindows,
        googleKey, googleProjId,
        supabaseUrl: _supabaseUrl,
        accessToken: _googleProxyToken,
        anonKey: window.__CAMPISTRY_SUPABASE__?.anonKey || ''
    });

    if (!result || !result.length) {
        console.error('[Go v5.2] Fallback: Google Route Optimization returned empty');
        return null;
    }

    result.forEach(r => {
        r.stops.forEach((s, i) => s.stopNum = i + 1);
        r.camperCount = r.stops.reduce((sum, s) => sum + s.campers.length, 0);
    });

    return result;
}


// =============================================================================
// _estimateFallbackTimeWindows — crude per-bus time window estimate for the
// fallback path, based on angular sweep + equal-size chunks.  Only used when
// the neighborhood pipeline fails — so these are rough numbers, not the
// LSTA-grade back-solve.
// =============================================================================
function _estimateFallbackTimeWindows(stops, vehicles, campLat, campLng,
                                       isArrival, shiftTargetHHMM,
                                       avgSpeedMph, avgStopMin) {
    if (!stops.length || !vehicles.length) return [];

    // Sort stops by angle from camp for a coarse spatial chunking.
    const annotated = stops.map(s => ({
        stop: s,
        angle: Math.atan2(s.lng - campLng, s.lat - campLat)
    }));
    annotated.sort((a, b) => a.angle - b.angle);

    const chunkSize = Math.ceil(annotated.length / vehicles.length);
    return vehicles.map((v, vi) => {
        const chunk = annotated
            .slice(vi * chunkSize, (vi + 1) * chunkSize)
            .map(a => a.stop);
        if (!chunk.length) {
            return {
                busId: v.busId,
                startTime: shiftTargetHHMM, endTime: shiftTargetHHMM
            };
        }
        const zw = computeZoneTimeWindow(
            chunk, campLat, campLng, isArrival,
            shiftTargetHHMM, avgSpeedMph, avgStopMin
        );
        return {
            busId:          v.busId,
            startTime:      zw.startHHMM,
            startWindowEnd: zw.startWindowEndHHMM,
            endTime:        zw.endHHMM
        };
    });
}


// =============================================================================
// _splitOverlongRoutes — peel stops off any route exceeding the duration cap
//
// The solver receives maxRouteDuration as a soft cap; an overlong route
// here means the solver couldn't honor it (usually because too many stops
// landed on one bus). Peel the farthest-from-camp stops onto the
// geographically-closest sibling route that has room and runs shorter.
//
// We don't know the precise duration of a hypothetical bus path, so use
// stop count as a proxy (every dropped stop saves ~serviceTime + leg time).
// =============================================================================
function _splitOverlongRoutes(routes, shiftVehicles, campLat, campLng, maxRouteMin) {
    if (!routes || routes.length < 2 || !maxRouteMin) return;
    const active = routes.filter(r => r && r.stops && r.stops.length > 0);
    if (active.length < 2) return;

    const capById = {};
    (shiftVehicles || []).forEach(v => { capById[v.busId] = v.capacity || 0; });

    function camperCount(r) {
        return r.stops.reduce((s, st) =>
            s + (st.isMonitor || st.isCounselor ? 0 : (st.campers?.length || 0)), 0);
    }
    function dist2(a, b) {
        const dx = a.lat - b.lat, dy = a.lng - b.lng;
        return dx * dx + dy * dy;
    }
    function distToCamp2(st) {
        return dist2(st, { lat: campLat, lng: campLng });
    }
    function routeMaxStopDistFromCamp(r) {
        let max = 0;
        r.stops.forEach(st => {
            if (st.isMonitor || st.isCounselor || !st.lat || !st.lng) return;
            const d = distToCamp2(st);
            if (d > max) max = d;
        });
        return max;
    }

    const MAX_ITER = 200;
    const MAX_MOVES_PER_BUS = 4;
    // Hard gate: a stop transfer is only allowed when the receiver bus has
    // at least one stop within MAX_TRANSFER_MI of the candidate. Without this
    // the splitter happily moves a Toms River stop onto a Lakewood bus —
    // bumping the receiver from 60min to 100+min because the optimizer now
    // has to detour 15+ miles. 1.5mi keeps moves within neighborhood.
    const MAX_TRANSFER_MI = 1.5;
    const MAX_TRANSFER_MI2 = (MAX_TRANSFER_MI * MAX_TRANSFER_MI) / (69 * 69);
    // Only run the splitter on routes that are MEANINGFULLY over cap.
    // A route 5 min over (e.g. 65min on a 60min cap) is not worth a transfer
    // that risks adding 15+ minutes to another bus.
    const SLACK_BEFORE_SPLITTING = 12; // min — only act on >12min over
    const movesPerBus = {};
    const giveUp = new Set();

    // Approximate the time cost of inserting a stop at distance D miles
    // from the receiver's nearest existing stop. Drive there + dwell + drive
    // back. avgSpeed ~25mph → 2.4 min/mi each way + 2 min dwell.
    function approxInsertMin(distMi) {
        return Math.max(3, Math.round(distMi * 4.8 + 2));
    }
    function dist2ToMi(d2) {
        // dist2 is squared lat/lng degrees. Convert: 1 deg lat ≈ 69 mi.
        return Math.sqrt(d2) * 69;
    }

    for (let iter = 0; iter < MAX_ITER; iter++) {
        // Pick the WORST over-cap route that we haven't given up on.
        let overlong = null, worstOver = 0;
        active.forEach(r => {
            if (giveUp.has(r.busId)) return;
            const over = (r.totalDuration || 0) - maxRouteMin;
            if (over <= SLACK_BEFORE_SPLITTING) return;
            if (over > worstOver) { worstOver = over; overlong = r; }
        });
        if (!overlong) return;

        movesPerBus[overlong.busId] = (movesPerBus[overlong.busId] || 0) + 1;
        if (movesPerBus[overlong.busId] > MAX_MOVES_PER_BUS) {
            giveUp.add(overlong.busId);
            console.warn('[Go v5.2] ' + overlong.busName + ' still ' +
                overlong.totalDuration + 'min after ' + MAX_MOVES_PER_BUS +
                ' splits — root cause is likely upstream clustering. ' +
                'Consider raising maxRouteDuration or adding a bus.');
            continue;
        }

        // Pull the farthest-from-camp stop on this route.
        let farthestIdx = -1, farthestDist = 0;
        overlong.stops.forEach((st, idx) => {
            if (st.isMonitor || st.isCounselor || !st.lat || !st.lng) return;
            const d = distToCamp2(st);
            if (d > farthestDist) { farthestDist = d; farthestIdx = idx; }
        });
        if (farthestIdx < 0) { giveUp.add(overlong.busId); continue; }
        const candidate = overlong.stops[farthestIdx];
        const candCount = candidate.campers?.length || 0;
        if (candCount === 0) {
            overlong.stops.splice(farthestIdx, 1);
            continue;
        }

        // Find the best receiver: a route with room AND with at least one
        // stop within MAX_TRANSFER_MI of the candidate. If no receiver
        // qualifies, leave the over-cap route alone — moving the stop to
        // a far-away bus would only make things worse.
        let receiver = null, bestDist2 = MAX_TRANSFER_MI2;
        active.forEach(r => {
            if (r === overlong) return;
            const cap = capById[r.busId] || 0;
            const cur = camperCount(r);
            if (cap && cur + candCount > cap) return;

            let nearest = Infinity;
            r.stops.forEach(st => {
                if (st.isMonitor || st.isCounselor || !st.lat || !st.lng) return;
                const d2 = dist2(candidate, st);
                if (d2 < nearest) nearest = d2;
            });
            if (nearest > MAX_TRANSFER_MI2) return; // hard distance gate

            // Estimate cost of inserting on this receiver. If projected
            // duration exceeds cap, skip — don't trade one over-cap route
            // for another.
            const insertMin = approxInsertMin(dist2ToMi(nearest));
            if ((r.totalDuration || 0) + insertMin > maxRouteMin) return;

            if (nearest < bestDist2) { bestDist2 = nearest; receiver = r; }
        });

        if (!receiver) {
            giveUp.add(overlong.busId);
            const candDistMi = dist2ToMi(distToCamp2(candidate));
            console.warn('[Go v5.2] ' + overlong.busName + ' is ' +
                Math.round(worstOver) + 'min over cap, but no receiver bus ' +
                'has room within ' + MAX_TRANSFER_MI + 'mi of "' +
                (candidate.address || '?') + '" (' + candDistMi.toFixed(1) +
                'mi from camp) — leaving as-is. Cluster is geographically ' +
                'broken; needs upstream fix.');
            continue;
        }

        overlong.stops.splice(farthestIdx, 1);
        receiver.stops.push(candidate);
        const insertMin = approxInsertMin(dist2ToMi(bestDist2));
        overlong.totalDuration = Math.max(0, (overlong.totalDuration || 0) - insertMin);
        receiver.totalDuration = (receiver.totalDuration || 0) + insertMin;
        overlong.camperCount = camperCount(overlong);
        receiver.camperCount = camperCount(receiver);
        console.log('[Go v5.2] Split: moved "' +
            (candidate.address || '?') + '" (' + candCount + ' campers, ' +
            dist2ToMi(bestDist2).toFixed(2) + 'mi to receiver) from ' +
            overlong.busName + ' (-' + insertMin + 'min) to ' +
            receiver.busName + ' (+' + insertMin + 'min)');
    }
}


// =============================================================================
// _rebalanceBusLoads — post-routing capacity equalization
//
// VROOM/Google sometimes return solutions where one bus is near capacity
// while another is half-empty (the geographic bisection step over-allocates
// stops to the denser wedge). Equalize by peeling a stop off the heaviest
// bus and re-attaching it to the lightest, but only when:
//   1. The stop is geographically close to the lightest bus's current path
//      (closer to the light bus's centroid than to the heavy bus's centroid).
//   2. The light bus has room (within capacity).
//   3. The transfer brings them measurably closer in load.
//
// Safe by construction: never moves campers individually, never violates
// capacity, and only moves stops that geographically fit better elsewhere.
// =============================================================================
function _rebalanceBusLoads(routes, shiftVehicles) {
    if (!routes || routes.length < 2) return;
    const active = routes.filter(r => r && r.stops && r.stops.length > 0);
    if (active.length < 2) return;

    // Capacity lookup by busId
    const capById = {};
    (shiftVehicles || []).forEach(v => { capById[v.busId] = v.capacity || 0; });

    function camperCount(r) {
        return r.stops.reduce((s, st) =>
            s + (st.isMonitor || st.isCounselor ? 0 : (st.campers?.length || 0)), 0);
    }
    function centroid(r) {
        const stops = r.stops.filter(s => !s.isMonitor && !s.isCounselor && s.lat && s.lng);
        if (!stops.length) return null;
        const lat = stops.reduce((s, st) => s + st.lat, 0) / stops.length;
        const lng = stops.reduce((s, st) => s + st.lng, 0) / stops.length;
        return { lat, lng };
    }
    function dist2(a, b) {
        const dx = a.lat - b.lat, dy = a.lng - b.lng;
        return dx * dx + dy * dy;
    }

    // Refresh camper counts in case the caller didn't.
    active.forEach(r => { r.camperCount = camperCount(r); });

    const MAX_PASSES = 6;       // bounded loop — each pass moves at most one stop
    const TARGET_RATIO = 1.4;   // stop once max/min camper ratio is under this
    const MIN_GAP = 8;          // and max-min difference is under this many campers

    for (let pass = 0; pass < MAX_PASSES; pass++) {
        active.forEach(r => { r.camperCount = camperCount(r); });
        const sorted = [...active].sort((a, b) => a.camperCount - b.camperCount);
        const lightest = sorted[0];
        const heaviest = sorted[sorted.length - 1];
        const ratio = heaviest.camperCount / Math.max(1, lightest.camperCount);
        const gap = heaviest.camperCount - lightest.camperCount;
        if (ratio < TARGET_RATIO && gap < MIN_GAP) break;

        const lightCap = capById[lightest.busId] || 999;
        const lightRoom = lightCap - lightest.camperCount;
        if (lightRoom <= 0) break; // no room to receive

        const lightC = centroid(lightest);
        const heavyC = centroid(heaviest);
        if (!lightC || !heavyC) break;

        // Find the best transfer candidate: a non-staff stop on the heavy
        // bus that (a) fits in the light bus's remaining capacity, (b) is
        // closer to the light bus's centroid than to the heavy bus's, and
        // (c) when moved, doesn't flip the imbalance the other way.
        let bestStopIdx = -1;
        let bestScore = 0;
        heaviest.stops.forEach((st, idx) => {
            if (st.isMonitor || st.isCounselor) return;
            const stopCount = st.campers?.length || 0;
            if (stopCount === 0 || stopCount > lightRoom) return;
            // Don't flip the imbalance
            const projHeavy = heaviest.camperCount - stopCount;
            const projLight = lightest.camperCount + stopCount;
            if (projLight > projHeavy) return;

            const dToLight = dist2({ lat: st.lat, lng: st.lng }, lightC);
            const dToHeavy = dist2({ lat: st.lat, lng: st.lng }, heavyC);
            // Score: how much closer to light than to heavy. Higher = better candidate.
            const score = dToHeavy - dToLight;
            if (score > bestScore) { bestScore = score; bestStopIdx = idx; }
        });

        if (bestStopIdx < 0) break; // no geographically-suitable transfer found

        // Perform the transfer. Append to the light bus; the per-bus TSP
        // pass (already deferred to the optimizer or done in _applyETAs)
        // will reorder the stops.
        const moved = heaviest.stops.splice(bestStopIdx, 1)[0];
        lightest.stops.push(moved);
        heaviest.camperCount = camperCount(heaviest);
        lightest.camperCount = camperCount(lightest);
        console.log('[Go v5.2] Rebalance: moved stop "' + (moved.address || moved.label || '?') +
            '" (' + (moved.campers?.length || 0) + ' campers) from ' +
            heaviest.busName + ' (' + (heaviest.camperCount + (moved.campers?.length || 0)) +
            '→' + heaviest.camperCount + ') to ' +
            lightest.busName + ' (' + (lightest.camperCount - (moved.campers?.length || 0)) +
            '→' + lightest.camperCount + ')');
    }
}


// =============================================================================
// REPLACEMENT _applyETAsAndAudits
//
// Unchanged overall shape from Phase 1, but:
//   - Prefers solver-provided _tspLegTimes (which, post-Phase-2, ARE the
//     real travel times from Google's road matrix including traffic-free
//     routing).
//   - The maxRideTime audit is now a SANITY check rather than a potential
//     data-quality issue, because the solver hard-capped ride time before
//     returning.  Violations here mean either (a) the fallback path was used
//     without full time-window support, or (b) haversine fallback kicked in
//     because _tspLegTimes was null.  Both get logged as warnings with a
//     note to that effect.
// =============================================================================
function _applyETAsAndAudits(routes, {
    shift, isArrival, campLat, campLng,
    avgStopMin, shiftNeedsReturn
}) {
    const [depHour, depMin] = (shift.departureTime ||
        (isArrival ? '08:00' : '16:00')).split(':').map(Number);
    const shiftTargetMin = depHour * 60 + depMin;
    const maxRideMin = D.setup.maxRideTime || 45;

    function driveMin(a, b) {
        if (a.lat && b.lat) return drivingDist(a.lat, a.lng, b.lat, b.lng) / 60;
        return 3;
    }
    function campToStop(s) {
        if (s.lat) return drivingDist(campLat, campLng, s.lat, s.lng) / 60;
        return 15;
    }
    function stopToCamp(s) {
        if (s.lat) return drivingDist(s.lat, s.lng, campLat, campLng) / 60;
        return 15;
    }

    for (const r of routes) {
        if (!r.stops?.length) continue;

        const legs = r._tspLegTimes;
        const legMinAt = i => (legs && legs[i] != null) ? legs[i] / 60 : null;
        const usedSolverTimes = !!legs;

        // ── Arrival (pickup) or Dismissal (dropoff) ETA pipeline ─────────────
        // Phase 2 note: for arrival, each bus now has its OWN start time
        // (per-zone back-solve).  We derive each bus's start time from its
        // own first leg + stop chain, NOT from shift.departureTime.  The bus's
        // arrival at camp is what's pinned; its start time is back-computed.
        if (isArrival) {
            // Arrival mode: bus ENDS at camp at shiftTargetMin (for this bus).
            // If the solver honored per-vehicle endTimeWindows, camp arrival
            // is shiftTargetMin minus any per-zone offset.  We don't know the
            // exact offset here (it's internal to the solver), but the sum of
            // legTimes + service gives the route duration, and camp arrival
            // is the anchor — so we count backwards.
            let totalDur = 0;
            for (let i = 0; i < r.stops.length; i++) {
                const tLeg = legMinAt(i);
                if (i === 0) totalDur += (tLeg != null ? tLeg : campToStop(r.stops[0]));
                else totalDur += (tLeg != null ? tLeg : driveMin(r.stops[i - 1], r.stops[i]));
                totalDur += avgStopMin;
            }
            const returnLeg = legMinAt(r.stops.length);
            totalDur += (returnLeg != null ? returnLeg : stopToCamp(r.stops[r.stops.length - 1]));

            let cum = shiftTargetMin - totalDur;
            for (let i = 0; i < r.stops.length; i++) {
                const tLeg = legMinAt(i);
                if (i === 0) cum += (tLeg != null ? tLeg : campToStop(r.stops[0]));
                else cum += (tLeg != null ? tLeg : driveMin(r.stops[i - 1], r.stops[i]));
                cum += avgStopMin;
                r.stops[i].estimatedTime = formatTime(cum);
                r.stops[i].estimatedMin = cum;
            }
            r.totalDuration = Math.round(totalDur);
        } else {
            // Dismissal mode: bus STARTS at camp at shiftTargetMin.
            let cum = shiftTargetMin;
            for (let i = 0; i < r.stops.length; i++) {
                const tLeg = legMinAt(i);
                if (i === 0) cum += (tLeg != null ? tLeg : campToStop(r.stops[0]));
                else cum += (tLeg != null ? tLeg : driveMin(r.stops[i - 1], r.stops[i]));
                cum += avgStopMin;
                r.stops[i].estimatedTime = formatTime(cum);
                r.stops[i].estimatedMin = cum;
            }
            r.totalDuration = Math.round(cum - shiftTargetMin);
            if (shiftNeedsReturn && r.stops.length > 0) {
                const returnLeg = legMinAt(r.stops.length);
                r.returnTocamp = Math.round(returnLeg != null
                    ? returnLeg
                    : stopToCamp(r.stops[r.stops.length - 1]));
                r.totalDuration += r.returnTocamp;
            }
        }

        r.camperCount = r.stops.reduce((s, st) => s + st.campers.length, 0);

        // ── Max-ride-time audit ─────────────────────────────────────────────
        // Post-Phase-2, this is a sanity check: the solver already hard-capped
        // each camper's ride time.  A violation here indicates:
        //   - The fallback path was used (non-NH, less strict time windows), or
        //   - _tspLegTimes was null and we used haversine, which overestimates
        //     ride time on routes with good highway access.
        // Either way, log it but don't treat it as a data-quality problem.
        let violations = 0;
        for (const st of r.stops) {
            if (!st.estimatedMin) continue;
            const rideMin = isArrival
                ? (shiftTargetMin - st.estimatedMin)
                : (st.estimatedMin - shiftTargetMin);
            st._rideTimeMin = Math.round(Math.abs(rideMin));
            if (st._rideTimeMin > maxRideMin) {
                st._rideTimeWarning = true;
                violations++;
            }
        }
        if (violations) {
            r._rideTimeViolations = violations;
            // The solver does NOT enforce per-camper ride caps as a hard
            // constraint (paired-shipment models choke on it — see
            // campistry_go_google.js comments). _rideTimeWarning is kept on
            // the stop so the dashboard can flag long rides for review, but
            // we don't spam the console: most violations come from the
            // haversine fallback estimator over-counting drive time, and
            // the per-route cap is the real budget anyway.
        }

        // ── Route-duration audit ────────────────────────────────────────────
        // The solver received maxRouteDuration as a soft cap. If the result
        // still exceeds the cap, surface it loudly so we can investigate
        // (most likely cause: too few buses for the load, or one of the
        // post-solver TSP / time-window passes blew the budget).
        const _maxRouteMin = D.setup.maxRouteDuration || 60;
        if (r.totalDuration > _maxRouteMin) {
            r._overRouteCap = true;
            const overBy = r.totalDuration - _maxRouteMin;
            console.warn('[Go v5.2] ' + r.busName + ': route is ' + r.totalDuration +
                'min — ' + overBy + 'min over the ' + _maxRouteMin + 'min cap (' +
                r.camperCount + ' campers, ' + r.stops.length + ' stops)');
        }
    }
}


// =============================================================================
// HELPER: Collect staff members who need a stop suggestion
// =============================================================================
function _collectNoStopStaff() {
    const out = [];

    for (const counselor of D.counselors) {
        if (!counselor.address) continue;
        let staffCoords = null;
        if (counselor._lat && counselor._lng) {
            staffCoords = { lat: counselor._lat, lng: counselor._lng };
        }
        if (!staffCoords) {
            const a = D.addresses[counselor.name] ||
                      D.addresses[counselor.firstName + ' ' + counselor.lastName];
            if (a?.geocoded && a.lat && a.lng) {
                staffCoords = { lat: a.lat, lng: a.lng };
                counselor._lat = a.lat; counselor._lng = a.lng;
            }
        }
        if (!staffCoords) continue;
        out.push({
            name: counselor.name, address: counselor.address,
            lat: staffCoords.lat, lng: staffCoords.lng,
            busId: counselor.assignedBus || null,
            role: 'counselor', id: counselor.id
        });
    }

    for (const monitor of D.monitors) {
        if (!monitor.address) continue;
        let staffCoords = null;
        if (monitor._lat && monitor._lng) {
            staffCoords = { lat: monitor._lat, lng: monitor._lng };
        }
        if (!staffCoords) {
            const a = D.addresses[monitor.name] ||
                      D.addresses[monitor.firstName + ' ' + monitor.lastName];
            if (a?.geocoded && a.lat && a.lng) {
                staffCoords = { lat: a.lat, lng: a.lng };
                monitor._lat = a.lat; monitor._lng = a.lng;
            }
        }
        if (!staffCoords) continue;
        out.push({
            name: monitor.name, address: monitor.address,
            lat: staffCoords.lat, lng: staffCoords.lng,
            busId: monitor.assignedBus || null,
            role: 'monitor', id: monitor.id
        });
    }

    if (out.length) console.log('[Go v5] Staff for post-gen suggestions: ' + out.length);
    return out;
}


// =============================================================================
// HELPER: Suggest nearest stops for staff
//
// Moves the v4 staff-suggestion logic out of generateRoutes for clarity.
// Walks each staff member to the nearest (bus, stop) pair by haversine.
// =============================================================================
function _suggestStaffStops(routes, noStopStaff, campLat, campLng) {
    if (!noStopStaff?.length || !routes?.length) return;

    for (const staff of noStopStaff) {
        let bestBus = null, bestStop = null, bestStopIdx = 0, bestDist = Infinity;
        for (const r of routes) {
            for (let si = 0; si < r.stops.length; si++) {
                const st = r.stops[si];
                const d = haversineMi(staff.lat, staff.lng, st.lat, st.lng);
                if (d < bestDist) {
                    bestDist = d; bestBus = r; bestStop = st; bestStopIdx = si;
                }
            }
        }
        if (!bestBus) continue;

        const rec = staff.role === 'monitor'
            ? D.monitors.find(m => m.id === staff.id)
            : D.counselors.find(c => c.id === staff.id);
        if (!rec) continue;

        rec._suggestedBus      = bestBus.busName;
        rec._suggestedBusId    = bestBus.busId;
        rec._suggestedStop     = bestStop.address;
        rec._suggestedStopNum  = bestStop.stopNum;
        rec._suggestedDistMi   = bestDist;
        rec._walkFt            = Math.round(bestDist * 5280);
    }
}


// =============================================================================
// KEPT — findAnchorStop (UNUSED IN PHASE 1, PRESERVED FOR PHASE 3)
//
// Extracted from the deleted buildGreedyZones().  Returns the stop in a
// camper set that's farthest from camp and has the most kids within walk
// radius — i.e. the "keystone" for a route, per the LSTA analysis.
//
// Phase 3 will wire this into the per-bus TSP as a mandatory first visit
// (AM) / last visit (PM).  For Phase 1 we just keep the code alive.
// =============================================================================
function findAnchorStop(campers, intersections, walkMi = 0.2) {
    if (!campers?.length) return null;

    // For each intersection, count kids within walkMi
    let best = null, bestScore = -Infinity;
    const distFromCamp = {};
    const campLat = D.setup.campLat, campLng = D.setup.campLng;

    for (const inter of (intersections || [])) {
        let kidsHere = 0;
        for (const c of campers) {
            const d = haversineMi(c.lat, c.lng, inter.lat, inter.lng);
            if (d <= walkMi) kidsHere++;
        }
        if (!kidsHere) continue;
        const dc = haversineMi(inter.lat, inter.lng, campLat, campLng);
        // Score: many kids + far from camp
        const score = kidsHere * 2 + dc;
        if (score > bestScore) { bestScore = score; best = { ...inter, kidsHere, distFromCamp: dc }; }
    }
    return best;
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
            + '<p style="color:var(--text-muted);font-size:.85rem;margin-bottom:1rem">These counselors live more than a 10-minute walk from the nearest bus stop. You can ignore this or add a dedicated stop on their nearest bus (that one bus will be re-optimized).</p>'
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

        document.getElementById('counselorOutlierApply').addEventListener('click', async () => {
            const selects = modal.querySelectorAll('.counselor-outlier-action');
            let added = 0;
            // Track which (busId, shiftIdx) pairs got a new stop so we can re-TSP each once
            const busesToReoptimize = new Map(); // key = busId + ':' + shiftIdx

            for (const sel of selects) {
                const idx = parseInt(sel.dataset.idx);
                const action = sel.value;
                const c = outliers[idx];
                if (action !== 'add-stop' || !c._lat || !c._lng) continue;

                // Find the bus whose route passes closest across all shifts
                let bestRoute = null, bestShiftIdx = 0, bestDist = Infinity;
                (D.savedRoutes || []).forEach((sr, shiftIdx) => {
                    for (const r of sr.routes) {
                        if (!r.stops.length) continue;
                        for (const st of r.stops) {
                            if (!st.lat) continue;
                            const d = haversineMi(c._lat, c._lng, st.lat, st.lng);
                            if (d < bestDist) { bestDist = d; bestRoute = r; bestShiftIdx = shiftIdx; }
                        }
                    }
                });
                if (!bestRoute) continue;

                const newStop = {
                    stopNum: 0, campers: [],
                    address: c.address,
                    lat: c._lat, lng: c._lng,
                    isCounselor: true, counselorName: c.name,
                    _counselors: [{ name: c.name, walkFt: 0, address: c.address, id: c.id }]
                };
                // Append — reOptimizeBus will run TSP and place it optimally
                bestRoute.stops.push(newStop);
                bestRoute.stops.forEach((s, i) => { s.stopNum = i + 1; });

                c._assignedBus = bestRoute.busId;
                c._assignedBusName = bestRoute.busName;
                c._assignedStop = c.address;
                c._walkFt = 0;
                // Update the persisted counselor record
                const cc = D.counselors.find(x => x.id === c.id);
                if (cc) {
                    cc._assignStatus = 'accepted';
                    cc.assignedBus = bestRoute.busId;
                    cc._acceptedBus = bestRoute.busName;
                    cc._acceptedBusId = bestRoute.busId;
                    cc._acceptedStop = c.address;
                    cc._acceptedStopNum = newStop.stopNum;
                    cc._walkFt = 0;
                }
                busesToReoptimize.set(bestRoute.busId + ':' + bestShiftIdx, { busId: bestRoute.busId, shiftIdx: bestShiftIdx });
                added++;
                console.log('[Go] Added dedicated stop for ' + c.name + ' on ' + bestRoute.busName + ' (shift ' + bestShiftIdx + ')');
            }

            modal.remove();

            if (added) {
                save();
                _generatedRoutes = D.savedRoutes;
                // Re-optimize each affected bus (single-bus TSP rerun)
                toast('Re-optimizing ' + busesToReoptimize.size + ' route' + (busesToReoptimize.size > 1 ? 's' : '') + '...');
                for (const { busId, shiftIdx } of busesToReoptimize.values()) {
                    try { await reOptimizeBus(busId, shiftIdx); }
                    catch (e) { console.error('[Go] reOptimizeBus failed for ' + busId, e); }
                }
                renderRouteResults(D.savedRoutes);
                if (typeof renderStaff === 'function') renderStaff();
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
        // Counselor stops with real coordinates ARE included in TSP so they get
        // properly placed in the sequence. Monitor-only stops have no location
        // and remain as tail-end metadata.
        const stops = route.stops.filter(s => !s.isMonitor && s.lat && s.lng);
        const specialStops = route.stops.filter(s => s.isMonitor || !s.lat || !s.lng);
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
        renderRouteResults(D.savedRoutes);
        console.log('[Go] Re-optimized ' + route.busName + ': ~' + Math.round(bestCost / 60) + ' min (' + (matrix ? 'road-matrix' : 'haversine') + ')');
        toast(route.busName + ' re-optimized!');
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

        // Build a set of major-road street names from the OSM major-roads layer.
        // Anchoring stops at arterial corners keeps the bus on through-roads instead
        // of detouring into cul-de-sacs — historical Neranina's MAROON route packs
        // 48 kids in 63min by routing along Bennetts Mills Rd and Whitesville Rd
        // and letting kids walk ~500ft to the arterial.
        const majorNames = new Set(
            (_majorRoadSegments || [])
                .map(s => (s.name || '').toLowerCase().trim())
                .filter(Boolean)
        );
        const ARTERIAL_REACH_MI = 0.50; // ~2640ft — bus-time savings outweigh walk distance
        function isArterialInter(inter) {
            return (inter.streets || []).some(s => majorNames.has(s.toLowerCase().trim()));
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
                        const arterial = isArterialInter(inter);
                        // Arterial intersections get a wider reach — kids walk further to a through-road.
                        const reach = arterial ? Math.max(walkMi * 2, ARTERIAL_REACH_MI) : walkMi * 2;
                        const d = haversineMi(fallbackLat, fallbackLng, inter.lat, inter.lng);
                        if (d > reach) return;

                        const interStreets = (inter.streets || []).map(s => s.toLowerCase());
                        const mainMatch = interStreets.some(s => streetMatch(s, mainStreet));
                        const crossMatch = interStreets.some(s => streetMatch(s, crossStreet));

                        let score = 0;
                        if (mainMatch && crossMatch) score = 10;
                        else if (mainMatch) score = 4;
                        else if (crossMatch) score = 2;
                        else if (!arterial) return; // no street match AND no arterial — skip

                        // Arterial bonus: bus-time saved by staying on through-road > kid walk.
                        // A 5-min driver detour into a cul-de-sac costs more than asking
                        // a kid to walk an extra 2000ft to the arterial corner.
                        if (arterial) score += 60;

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
                // Default fallback name when no intersection is available:
                //   1 house → exact street number ("12 Newberry Ct")
                //   2+ houses → median number, NOT a range ("15 Newberry Ct
                //              area"). Avoids the wide ranges ("10-29 Newberry Ct")
                //              that drivers find ambiguous.
                const nums = cluster.map(c => parseAddress(c.address).num).filter(n => n > 0).sort((a, b) => a - b);
                if (nums.length >= 2) {
                    const median = nums[Math.floor(nums.length / 2)];
                    stopName = median + ' ' + mainStreet + ' (' + nums.length + ' houses)';
                } else if (nums.length === 1) {
                    stopName = nums[0] + ' ' + mainStreet;
                } else {
                    stopName = mainStreet;
                }

                if (osmIntersections) {
                    // Single-street cluster (e.g. cul-de-sac). Score by arterial bonus + walk.
                    // Prefer an arterial corner within ~1500ft over an on-street cul-de-sac
                    // corner — keeps the bus on the through-road.
                    let bestInter = null, bestScore = -Infinity;
                    osmIntersections.forEach(inter => {
                        const arterial = isArterialInter(inter);
                        const reach = arterial ? ARTERIAL_REACH_MI : walkMi * 2;
                        const d = haversineMi(fallbackLat, fallbackLng, inter.lat, inter.lng);
                        if (d > reach) return;
                        const interStreets = (inter.streets || []).map(s => s.toLowerCase());
                        const onStreet = interStreets.some(s => streetMatch(s, mainStreet));
                        let score = onStreet ? 4 : (arterial ? 0 : -Infinity);
                        if (arterial) score += 60;
                        score -= totalWalkTo(inter.lat, inter.lng) * 20;
                        if (score > bestScore) { bestScore = score; bestInter = inter; }
                    });

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
                    } else if (isArterialInter(bestInter)) {
                        console.log('[Go]   Arterial corner for ' + mainStreet + ': ' + bestInter.name + ' (walk ' + (totalWalkTo(bestInter.lat, bestInter.lng) * 5280).toFixed(0) + 'ft)');
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

        // Merge small stops into nearest neighbor.
        // Historical Neranina averages 3.14 kids/stop (corner-clustered onto real
        // intersections). Without Overpass we get 2.14 kids/stop (33% more stops
        // than needed). Merge stops with ≤4 kids within full walkMi to collapse
        // the over-granular fallback stops into fewer, bigger groups.
        const mergeRadius = walkMi;
        const MERGE_THRESHOLD = 4;
        let didMerge = true;
        while (didMerge) {
            didMerge = false;
            for (let i = stops.length - 1; i >= 0; i--) {
                if (stops[i].campers.length > MERGE_THRESHOLD) continue;
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

        // Street-segment merge: collapse stops sharing a street name within ~1300ft.
        // Historical Neranina groups by block face (e.g. "Lehigh Blvd@Dartmouth Dr"
        // pulls every kid on that block). Two kids 1000ft apart on the same street
        // become one stop for them, two for us. This pass closes that gap.
        // The wider radius (was 0.18mi) reflects camp's actual stops, which
        // routinely span ~1200ft of frontage when families share a corner.
        function streetsOf(addr) {
            if (!addr) return [];
            return addr.split(' & ')
                .map(p => p.replace(/^\d[\d\s\-]*/, '').trim().toLowerCase())
                .filter(Boolean);
        }
        const SEG_RADIUS_MI = 0.25;
        let segMerged = true;
        while (segMerged) {
            segMerged = false;
            for (let i = stops.length - 1; i >= 0; i--) {
                const sA = streetsOf(stops[i].address);
                if (sA.length === 0) continue;
                let bestJ = -1, bestDist = SEG_RADIUS_MI;
                for (let j = 0; j < stops.length; j++) {
                    if (j === i) continue;
                    if (stops[j].campers.length + stops[i].campers.length > MAX_STOP_CAPACITY) continue;
                    const sB = streetsOf(stops[j].address);
                    if (!sA.some(n => sB.includes(n))) continue;
                    const d = manhattanMi(stops[i].lat, stops[i].lng, stops[j].lat, stops[j].lng);
                    if (d < bestDist) { bestDist = d; bestJ = j; }
                }
                if (bestJ >= 0) {
                    stops[bestJ].campers.push(...stops[i].campers);
                    stops.splice(i, 1);
                    segMerged = true;
                    break;
                }
            }
        }

        // Arterial absorb: small outlier stops (≤2 campers) fold into the
        // nearest larger stop (≥3 campers) within ~1500ft.
        // Historical pattern: 51% of singleton-equivalent kids landed in 2-8
        // kid stops by anchoring at a shared arterial corner (e.g. Cox Cro
        // Rd@Vermont Ave pulled kids from Vermont Ave + Paddock Pl into one
        // stop). The previous version only absorbed singletons; widening to
        // pairs closes the residual outlier gap (camp routinely consolidates
        // 2-kid stops into 5-7 kid arterial stops).
        const ARTERIAL_RADIUS_MI = 0.30;
        const SMALL_STOP_CAMPERS = 2;
        const ANCHOR_MIN_CAMPERS = 3;
        const majorSegs = _majorRoadSegments || [];
        function nearestMajorIntersection(lat, lng, maxMi) {
            if (!osmIntersections || majorSegs.length === 0) return null;
            const majorNames = new Set(majorSegs.map(s => (s.name || '').toLowerCase()).filter(Boolean));
            let best = null, bestD = maxMi;
            for (const inter of osmIntersections) {
                const onMajor = (inter.streets || []).some(s => majorNames.has(s.toLowerCase()));
                if (!onMajor) continue;
                const d = haversineMi(lat, lng, inter.lat, inter.lng);
                if (d < bestD) { bestD = d; best = inter; }
            }
            return best;
        }
        let arterialMerged = true;
        while (arterialMerged) {
            arterialMerged = false;
            for (let i = stops.length - 1; i >= 0; i--) {
                const cnt = stops[i].campers.length;
                if (cnt < 1 || cnt > SMALL_STOP_CAMPERS) continue;
                let bestJ = -1, bestDist = ARTERIAL_RADIUS_MI;
                for (let j = 0; j < stops.length; j++) {
                    if (j === i) continue;
                    // Anchors must already be a real stop, not another tiny outlier.
                    if (stops[j].campers.length < ANCHOR_MIN_CAMPERS) continue;
                    if (stops[j].campers.length + cnt > MAX_STOP_CAPACITY) continue;
                    const d = manhattanMi(stops[i].lat, stops[i].lng, stops[j].lat, stops[j].lng);
                    if (d < bestDist) { bestDist = d; bestJ = j; }
                }
                if (bestJ >= 0) {
                    stops[bestJ].campers.push(...stops[i].campers);
                    // Re-anchor to a major-road intersection between the two if possible
                    const midLat = (stops[bestJ].lat + stops[i].lat) / 2;
                    const midLng = (stops[bestJ].lng + stops[i].lng) / 2;
                    const arterial = nearestMajorIntersection(midLat, midLng, ARTERIAL_RADIUS_MI);
                    if (arterial) {
                        stops[bestJ].lat = arterial.lat;
                        stops[bestJ].lng = arterial.lng;
                        stops[bestJ].address = arterial.name;
                    }
                    stops.splice(i, 1);
                    arterialMerged = true;
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

        // Same-origin proxy (Vercel api/overpass.js) tried first — sidesteps CORS
        // and adds the User-Agent header Overpass requires. External mirrors as fallback.
        const endpoints = [
            '/api/overpass',
            'https://overpass-api.de/api/interpreter',
            'https://overpass.kumi.systems/api/interpreter',
            'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
        ];

        async function runQuery(query, label) {
            for (const url of endpoints) {
                try {
                    // Use GET to avoid CORS preflight (POST with custom content-type triggers it)
                    const getUrl = url + '?data=' + encodeURIComponent(query);
                    const host = url.startsWith('/') ? 'same-origin proxy' : url.split('//')[1].split('/')[0];
                    console.log('[Go] Overpass ' + label + ': trying ' + host + '...');
                    // Fail fast after 15 seconds — don't let a slow Overpass mirror block routing
                    const controller = new AbortController();
                    const timeoutId = setTimeout(function() { controller.abort(); }, 15000);
                    const resp = await fetch(getUrl, { signal: controller.signal });
                    clearTimeout(timeoutId);
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
            console.warn('[Go] Overpass ' + label + ': all mirrors failed — proceeding without street data');
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
        renderDispatcherDashboard(allShifts);
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
            routes
                .filter(r => r.stops.length > 0)
                .slice()
                .sort((a, b) => (a.busName || '').localeCompare(b.busName || '', undefined, { numeric: true, sensitivity: 'base' }))
                .forEach(r => {
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
        // Natural sort: Bus 1, 2, ..., 9, 10, 11, 12, 13 (not 1, 10, 11, 12, 13, 2, ..., 9)
        uniqueBuses.sort((a, b) => (a.busName || '').localeCompare(b.busName || '', undefined, { numeric: true, sensitivity: 'base' }));
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

                // Road geometry comes from Geoapify _roadPts (cached in _routeGeomCache)
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
    // CAMPER SEARCH + MOVE
    // =========================================================================
    function searchCamperInRoutes(query) {
        if (!_generatedRoutes || !query) return;
        const q = query.toLowerCase().trim(); if (!q) { if (_generatedRoutes) renderRouteResults(_generatedRoutes); return; }
        const results = []; const applied = _generatedRoutes;
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
        _generatedRoutes = D.savedRoutes; save(); renderRouteResults(D.savedRoutes); toast(camperName + ' moved to ' + toRoute.busName);
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
    // TABS + INIT
    // =========================================================================
    function initTabs() {
        document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            const t = btn.dataset.tab; document.getElementById('tab-' + t)?.classList.add('active');
            if (t === 'fleet') { renderFleet(); renderShifts(); } else if (t === 'shifts') renderShifts(); else if (t === 'staff') renderStaff(); else if (t === 'addresses') renderAddresses(); else if (t === 'routes') {
                runPreflight();
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
            setTimeout(() => { renderRouteResults(D.savedRoutes); toast('Saved routes loaded'); }, 200);
        }
        document.querySelectorAll('.modal-overlay').forEach(o => o.addEventListener('click', e => { if (e.target === o) o.classList.remove('open'); }));
        document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open')); });
        window.addEventListener('campistry-cloud-hydrated', () => {
            console.log('[Go] Cloud data hydrated');
            load();
            renderAddresses(); updateStats(); renderShifts();
            // Fetch API keys from Supabase secrets (non-blocking)
            fetchGoConfig();
            // Fetch addresses + routes from go_standalone_data table
            // (they're stripped from the main camp_state payload)
            loadGoCloudData();
        });
        // Also attempt Go-cloud restore on boot (in case cloud is already ready)
        setTimeout(() => { fetchGoConfig(); loadGoCloudData(); }, 1500);
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
    // =========================================================================
    // GEOAPIFY CVRP TEST
    // Run from browser console: CampistryGo.testGeoapify()
    //
    // Sends a real 5-stop / 2-bus CVRP request to Geoapify and verifies:
    //   • API key is accepted (not 401/402)
    //   • Solver assigns stops to buses correctly
    //   • Road geometry comes back in the response
    //   • Credit cost reported
    // =========================================================================
    async function testGeoapify() {
        const L = (icon, msg) => console.log(icon + ' ' + msg);
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('   Campistry Go — Geoapify CVRP Live Test');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        // ── 1. Config checks ──
        const apiKey  = D.setup.geoapifyKey?.trim();
        const campLat = D.setup.campLat;
        const campLng = D.setup.campLng;

        if (!apiKey) {
            L('❌', 'geoapifyKey not set — go to Setup → Advanced Settings → Geoapify Route Planner');
            L('💡', 'Get a free key at https://myprojects.geoapify.com');
            return;
        }
        L('✅', 'API key found: ' + apiKey.slice(0, 6) + '...' + apiKey.slice(-4));

        if (!campLat || !campLng) {
            L('❌', 'Camp coordinates not set — save Setup with a valid camp address first');
            return;
        }
        L('✅', 'Camp: ' + campLat.toFixed(5) + ', ' + campLng.toFixed(5));

        // ── 2. Build a tiny 5-stop / 2-bus test request ──
        // 5 stops scattered ~1–3 miles from camp, total 8 kids → 2 buses of cap 5
        const offsets = [
            [  0.012,  0.015, 2 ],   // ~1.2mi NE
            [ -0.008,  0.022, 3 ],   // ~1.5mi NW-ish
            [  0.025, -0.010, 1 ],   // ~1.7mi N
            [ -0.018, -0.020, 1 ],   // ~1.7mi SW
            [  0.035,  0.005, 1 ]    // ~2.4mi N
        ];
        const campCoord = [campLng, campLat];
        const agents = [
            { delivery_capacity: 5, start_location: campCoord },
            { delivery_capacity: 5, start_location: campCoord }
        ];
        const jobs = offsets.map(function(o) {
            return {
                location: [ campLng + o[1], campLat + o[0] ],
                duration: 60,
                delivery_amount: o[2]
            };
        });
        const body = { mode: 'drive', agents: agents, jobs: jobs };

        L('⏳', 'Sending 5-stop / 2-bus CVRP test to Geoapify...');
        const url = 'https://api.geoapify.com/v1/routeplanner?apiKey=' + encodeURIComponent(apiKey);

        let resp, data;
        try {
            resp = await fetch(url, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(body)
            });
            data = await resp.json();
        } catch (e) {
            L('❌', 'Network error: ' + e.message);
            return;
        }

        // ── 3. Check HTTP status ──
        if (!resp.ok) {
            const msg = data?.message || data?.error || ('HTTP ' + resp.status);
            L('❌', 'API error: ' + msg);
            if (resp.status === 401) L('💡', '401 — API key is wrong or inactive. Check https://myprojects.geoapify.com');
            if (resp.status === 402) L('💡', '402 — Out of credits. Check quota at https://myprojects.geoapify.com');
            if (resp.status === 422) L('💡', '422 — Request format error (unexpected for this test)');
            console.log('Full response:', data);
            return;
        }

        // ── 4. Parse result ──
        const features = data?.features || [];
        const agentFeatures = features.filter(function(f) {
            return f.properties?.agent_index !== undefined &&
                   Array.isArray(f.properties?.actions);
        });

        if (!agentFeatures.length) {
            L('⚠️ ', 'No route features returned — unexpected. Raw response:');
            console.log(data);
            return;
        }

        L('✅', 'Geoapify responded — ' + agentFeatures.length + ' bus route(s) returned');
        console.log('');

        let totalStopsAssigned = 0;
        let totalKidsAssigned  = 0;

        agentFeatures.forEach(function(feat, i) {
            const actions   = feat.properties.actions || [];
            const jobActions = actions.filter(function(a) {
                return a.type === 'job' || a.type === 'delivery' || a.type === 'pickup';
            });
            const kids = jobActions.reduce(function(s, a) {
                return s + (offsets[a.job_index]?.[2] || 0);
            }, 0);
            const hasGeom = !!(feat.geometry?.coordinates?.length);
            totalStopsAssigned += jobActions.length;
            totalKidsAssigned  += kids;

            console.log('  🚌 Bus ' + (i + 1) + ': ' + jobActions.length + ' stop(s), ' + kids + ' kids' +
                (hasGeom ? '  ✅ road geometry' : '  ⚠️  no geometry'));
            jobActions.forEach(function(a) {
                const o = offsets[a.job_index];
                if (o) console.log('     Stop ' + (a.job_index + 1) + ': ' + o[2] + ' kid(s)  [job_index=' + a.job_index + ']');
            });
        });

        const unassigned = data.unassigned_jobs || [];

        console.log('');
        L(totalStopsAssigned === 5 ? '✅' : '⚠️ ',
            totalStopsAssigned + '/5 stops assigned, ' + totalKidsAssigned + '/8 kids assigned');

        if (unassigned.length) {
            L('⚠️ ', unassigned.length + ' stop(s) unassigned — capacity may be too tight for test data');
        }

        // ── 5. Credit cost estimate ──
        const busCount  = D.buses.length  || 18;
        const stopCount = Object.values(D.addresses).filter(function(a) { return a?.geocoded; }).length;
        const estCost   = stopCount + busCount + 4; // Geoapify: N_locations + small overhead
        console.log('');
        L('ℹ️ ', 'Test cost: ~' + (5 + 2) + ' credits (5 stops + 2 buses)');
        L('ℹ️ ', 'Est. real-run cost: ~' + estCost + ' credits (' + stopCount + ' stops + ' + busCount + ' buses)');
        L('ℹ️ ', 'Free tier: 3,000 credits/day → ~' + Math.floor(3000 / Math.max(estCost, 1)) + ' full runs/day');

        console.log('\n🟢 Geoapify CVRP is working. Generate Routes will use the global VRP solver.');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    }


window.GoFlagPersistence = (function () {
    'use strict';

    const DATA_TYPE = 'route_flags';
    const LS_KEY = 'campistry_go_flags_v1';
    const VERSION = 1;

    const EMPTY = () => ({
        version: VERSION, savedAt: null,
        flags: { stops: {}, buses: {}, approvals: {}, anchors: {} }
    });

    function cloudAvailable() { return !!window.GoCloudSync; }

    async function _loadFromCloud() {
        if (!cloudAvailable()) return null;
        try {
            const all = await window.GoCloudSync.loadAll();
            return all?.[DATA_TYPE] || null;
        } catch (e) {
            console.warn('[GoFlagPersistence] cloud load failed:', e.message);
            return null;
        }
    }

    async function _saveToCloud(payload) {
        if (!cloudAvailable()) return { ok: false, reason: 'no-cloud' };
        try { return await window.GoCloudSync.save(DATA_TYPE, payload); }
        catch (e) { return { ok: false, error: e }; }
    }

    function _loadLocal() {
        try {
            const raw = localStorage.getItem(LS_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (_) { return null; }
    }

    function _saveLocal(payload) {
        try { localStorage.setItem(LS_KEY, JSON.stringify(payload)); return true; }
        catch (_) { return false; }
    }

    async function load() {
        const cloud = await _loadFromCloud();
        if (cloud && cloud.version === VERSION) { _saveLocal(cloud); return cloud; }
        const local = _loadLocal();
        if (local && local.version === VERSION) return local;
        return EMPTY();
    }

    async function save(payload) {
        payload.savedAt = new Date().toISOString();
        payload.version = VERSION;
        _saveLocal(payload);
        const res = await _saveToCloud(payload);
        return res.ok || !cloudAvailable();
    }

    // Key helpers — normalize so regeneration doesn't orphan flags
    function _stopKey(shiftIdx, address) {
        const norm = (address || '').toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
        return shiftIdx + ':' + norm;
    }
    function _busKey(shiftIdx, busId) {
        return shiftIdx + ':' + busId;
    }

    return {
        load, save,
        EMPTY,
        _stopKey, _busKey
    };
})();


// =============================================================================
// IN-MEMORY FLAG CACHE
//
// Loaded on first use, re-saved when mutated. Prevents every click from
// hitting Supabase.
// =============================================================================
let _flagCache = null;

async function _ensureFlags() {
    if (_flagCache) return _flagCache;
    _flagCache = await window.GoFlagPersistence.load();
    return _flagCache;
}

async function _persistFlags() {
    if (!_flagCache) return;
    await window.GoFlagPersistence.save(_flagCache);
}


// =============================================================================
// PUBLIC FLAG API — called from the dashboard UI
// =============================================================================
async function flagStop(shiftIdx, stopAddress, reason, notes) {
    await _ensureFlags();
    const key = window.GoFlagPersistence._stopKey(shiftIdx, stopAddress);
    _flagCache.flags.stops[key] = {
        reason:    reason || 'review',
        notes:     notes || '',
        flaggedAt: new Date().toISOString()
    };
    await _persistFlags();
    renderDispatcherDashboard(_generatedRoutes);
    if (typeof toast === 'function') toast('Stop flagged for review');
}

async function unflagStop(shiftIdx, stopAddress) {
    await _ensureFlags();
    const key = window.GoFlagPersistence._stopKey(shiftIdx, stopAddress);
    delete _flagCache.flags.stops[key];
    await _persistFlags();
    renderDispatcherDashboard(_generatedRoutes);
}

async function flagRoute(shiftIdx, busId, reason, notes) {
    await _ensureFlags();
    const key = window.GoFlagPersistence._busKey(shiftIdx, busId);
    _flagCache.flags.buses[key] = {
        reason:    reason || 'review',
        notes:     notes || '',
        flaggedAt: new Date().toISOString()
    };
    await _persistFlags();
    renderDispatcherDashboard(_generatedRoutes);
    if (typeof toast === 'function') toast('Route flagged for review');
}

async function unflagRoute(shiftIdx, busId) {
    await _ensureFlags();
    const key = window.GoFlagPersistence._busKey(shiftIdx, busId);
    delete _flagCache.flags.buses[key];
    await _persistFlags();
    renderDispatcherDashboard(_generatedRoutes);
}

async function approveRoute(shiftIdx, busId) {
    await _ensureFlags();
    const key = window.GoFlagPersistence._busKey(shiftIdx, busId);
    _flagCache.flags.approvals[key] = {
        approvedAt: new Date().toISOString()
    };
    await _persistFlags();
    renderDispatcherDashboard(_generatedRoutes);
    if (typeof toast === 'function') toast('Route approved');
}

async function unapproveRoute(shiftIdx, busId) {
    await _ensureFlags();
    const key = window.GoFlagPersistence._busKey(shiftIdx, busId);
    delete _flagCache.flags.approvals[key];
    await _persistFlags();
    renderDispatcherDashboard(_generatedRoutes);
}

async function approveAllRoutes() {
    if (!_generatedRoutes) return;
    await _ensureFlags();
    _generatedRoutes.forEach((sr, si) => {
        sr.routes.forEach(r => {
            if (r.stops.length === 0) return;
            const key = window.GoFlagPersistence._busKey(si, r.busId);
            _flagCache.flags.approvals[key] = {
                approvedAt: new Date().toISOString()
            };
        });
    });
    await _persistFlags();
    renderDispatcherDashboard(_generatedRoutes);
    if (typeof toast === 'function') toast('All routes approved');
}

async function pinAnchor(shiftIdx, busId, stopAddress, lat, lng) {
    await _ensureFlags();
    const key = window.GoFlagPersistence._busKey(shiftIdx, busId);
    _flagCache.flags.anchors[key] = {
        stopAddress, lat, lng,
        pinnedAt: new Date().toISOString()
    };
    await _persistFlags();
    renderDispatcherDashboard(_generatedRoutes);
    if (typeof toast === 'function') {
        toast('Anchor pinned — will take effect on next regenerate');
    }
}

async function unpinAnchor(shiftIdx, busId) {
    await _ensureFlags();
    const key = window.GoFlagPersistence._busKey(shiftIdx, busId);
    delete _flagCache.flags.anchors[key];
    await _persistFlags();
    renderDispatcherDashboard(_generatedRoutes);
}


// =============================================================================
// ANCHOR DETECTION
//
// LSTA's "keystone stop" heuristic: within a bus's zone, find the stop that
//   1. is farthest from camp (represents the route's outer edge)
//   2. has the most kids (is a real mega-cluster worth anchoring on)
//
// Score = (distFromCamp in miles) * (kids at stop).  This naturally prefers
// a 15-kid stop 10 miles out over a 2-kid stop 12 miles out.
//
// For arrival mode: the anchor is the FIRST stop (bus starts there, drives in)
// For dismissal mode: the anchor is the LAST stop (bus ends there, closing out)
//
// NOTE: For Phase 3 we only RECOMMEND the anchor. The dispatcher must click
// "Pin anchor" in the dashboard to make it a hard constraint on next regen.
// This prevents the anchor from hurting routes where the solver already
// chose a different (and equally-good or better) stop order.
// =============================================================================
function _detectAnchorForRoute(route, campLat, campLng) {
    if (!route.stops || route.stops.length < 2) return null;

    let best = null, bestScore = -Infinity;
    for (const st of route.stops) {
        if (!st.lat || !st.lng) continue;
        if (st.isMonitor || st.isCounselor) continue;
        const distMi = haversineMi(st.lat, st.lng, campLat, campLng);
        const kidCount = (st.campers || []).length;
        const score = distMi * Math.max(1, kidCount);
        if (score > bestScore) {
            bestScore = score;
            best = { stop: st, distMi, kidCount, score };
        }
    }
    return best;
}

// Called from Phase 2's _perBusGoogleTSP to look up any user-pinned anchor.
// Returns the stop INDEX in route.stops if one is pinned, else null.
function _getPinnedAnchorIndex(route, shiftIdx) {
    if (!_flagCache) return null; // not loaded yet → no pin
    const key = window.GoFlagPersistence._busKey(shiftIdx ?? 0, route.busId);
    const anchor = _flagCache.flags.anchors[key];
    if (!anchor) return null;

    // Find the stop in route.stops whose address matches the pinned anchor.
    // We match on address because stop order may have changed since pin.
    const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const target = norm(anchor.stopAddress);
    for (let i = 0; i < route.stops.length; i++) {
        if (norm(route.stops[i].address) === target) return i;
    }
    // No match — the pinned anchor stop no longer exists on this route.
    // Don't fall back, just ignore (the dispatcher can re-pin if needed).
    return null;
}


// =============================================================================
// ROUTE QUALITY HEURISTIC (LSTA-style)
//
// Returns an object describing potential issues with a route. Used by the
// dashboard to surface problems. These are advisory — some "problems" may
// be intentional (e.g. single-rider stops for outliers).
//
// Checks:
//   - oversized:   > 55 kids
//   - undersized:  < 15 kids (may indicate bus can be dropped)
//   - too-long:    > maxRideTime minutes total duration
//   - too-many-singleton-stops: >40% of stops have 1 kid (inefficient)
//   - ride-time-violations:  any stop with _rideTimeWarning
//   - no-mega-stop: no stop has 5+ kids (likely a low-density zone but worth
//     flagging for review)
//   - anchor-mismatch: solver's first (AM) / last (PM) stop differs from the
//     detected mega-cluster (informational)
// =============================================================================
function _analyzeRoute(route, shiftIdx, campLat, campLng, maxRideMin, isArrival, maxRouteMin) {
    const issues = [];
    const details = {};

    // Basic size checks
    if (route.camperCount > 55) {
        issues.push({ type: 'oversized', severity: 'warn',
            msg: route.camperCount + ' campers (over 55 LSTA guideline)' });
    }
    if (route.camperCount < 15 && route.camperCount > 0) {
        issues.push({ type: 'undersized', severity: 'info',
            msg: 'Only ' + route.camperCount + ' campers (may be mergeable)' });
    }
    // Use maxRouteDuration if available; falls back to maxRideMin+15 for legacy callers.
    const tooLongThreshold = (maxRouteMin && maxRouteMin > 0) ? maxRouteMin : (maxRideMin + 15);
    if (route.totalDuration > tooLongThreshold) {
        issues.push({ type: 'too-long', severity: 'warn',
            msg: 'Route takes ' + route.totalDuration + ' min (cap ' + tooLongThreshold + ' min)' });
    }

    // Stop-distribution checks
    const stopCount = route.stops.filter(s => !s.isMonitor && !s.isCounselor).length;
    const singletonStops = route.stops
        .filter(s => !s.isMonitor && !s.isCounselor && s.campers.length === 1).length;
    if (stopCount > 0 && singletonStops / stopCount > 0.5) {
        issues.push({ type: 'too-many-singletons', severity: 'info',
            msg: singletonStops + ' of ' + stopCount + ' stops have only 1 kid' });
    }

    const maxStopSize = Math.max(0,
        ...route.stops
            .filter(s => !s.isMonitor && !s.isCounselor)
            .map(s => s.campers.length)
    );
    if (maxStopSize < 3 && route.camperCount >= 15) {
        issues.push({ type: 'no-mega-stop', severity: 'warn',
            msg: 'Largest stop has ' + maxStopSize +
                ' kids (no anchor cluster — route may be too spread out)' });
    }
    details.maxStopSize = maxStopSize;

    // Ride-time violations (solver-detected)
    const rideViolations = route.stops
        .filter(s => s._rideTimeWarning).length;
    if (rideViolations > 0) {
        issues.push({ type: 'ride-violations', severity: 'error',
            msg: rideViolations + ' stop(s) over ' + maxRideMin + ' min ride' });
    }

    // Anchor analysis
    const anchor = _detectAnchorForRoute(route, campLat, campLng);
    if (anchor && anchor.kidCount >= 3) {
        details.detectedAnchor = {
            address: anchor.stop.address,
            kidCount: anchor.kidCount,
            distMi: anchor.distMi
        };

        // For arrival mode: bus should START at anchor
        // For dismissal mode: bus should END at anchor
        const solverExtremeIdx = isArrival ? 0 : route.stops.length - 1;
        const solverExtreme = route.stops[solverExtremeIdx];
        if (solverExtreme && solverExtreme.address !== anchor.stop.address) {
            // Only flag if the current extreme has significantly fewer kids
            const extremeKids = solverExtreme.campers.length;
            if (anchor.kidCount > extremeKids + 2) {
                issues.push({ type: 'anchor-mismatch', severity: 'info',
                    msg: (isArrival ? 'First' : 'Last') + ' stop has ' + extremeKids +
                        ' kid(s); mega-cluster has ' + anchor.kidCount +
                        ' at ' + anchor.stop.address });
            }
        }
    }

    // Check for a pinned anchor on this route
    const pinKey = window.GoFlagPersistence?._busKey(shiftIdx, route.busId);
    const pinned = _flagCache?.flags?.anchors?.[pinKey];
    if (pinned) {
        details.pinnedAnchor = pinned;
    }

    return { issues, details };
}


// =============================================================================
// DISPATCHER DASHBOARD RENDERER
//
// Injects the dashboard into the existing #dispatcherDashboard container.
// Lists every active route with: status indicator, quality summary, issues,
// and action buttons (flag, approve, pin anchor).
//
// Called from renderRouteResults after the route cards are built.
// =============================================================================
async function renderDispatcherDashboard(allShifts) {
    const container = document.getElementById('dispatcherDashboard');
    if (!container) return; // dashboard not yet added to HTML

    if (!allShifts || !allShifts.length) {
        container.innerHTML = '';
        container.style.display = 'none';
        return;
    }

    // Load flags if not already
    await _ensureFlags();

    const campLat = D.setup.campLat || _campCoordsCache?.lat || 0;
    const campLng = D.setup.campLng || _campCoordsCache?.lng || 0;
    const maxRideMin = D.setup.maxRideTime || 45;
    const maxRouteMin = D.setup.maxRouteDuration || 60;
    const isArrival = D.activeMode === 'arrival';

    // Count buckets across all shifts
    let approved = 0, flagged = 0, issues = 0, total = 0;
    const perShift = [];

    allShifts.forEach((sr, si) => {
        const activeRoutes = sr.routes.filter(r => r.stops.length > 0);
        const shiftData = { shiftIdx: si, shift: sr.shift, routes: [] };

        activeRoutes.forEach(r => {
            const analysis = _analyzeRoute(r, si, campLat, campLng, maxRideMin, isArrival, maxRouteMin);

            const approveKey = window.GoFlagPersistence._busKey(si, r.busId);
            const flagKey = approveKey;
            const isApproved = !!_flagCache.flags.approvals[approveKey];
            const isFlagged  = !!_flagCache.flags.buses[flagKey];

            // Also count stop-level flags for this route
            const stopFlagCount = r.stops.filter(s => {
                const k = window.GoFlagPersistence._stopKey(si, s.address);
                return !!_flagCache.flags.stops[k];
            }).length;

            total++;
            if (isApproved) approved++;
            if (isFlagged || stopFlagCount > 0) flagged++;
            if (analysis.issues.length > 0) issues++;

            shiftData.routes.push({
                route: r,
                analysis,
                isApproved,
                isFlagged,
                stopFlagCount
            });
        });

        perShift.push(shiftData);
    });

    // Top-level summary bar
    let html = '<div class="dispatch-summary">' +
        '<div class="dispatch-summary-cell">' +
            '<div class="dispatch-num">' + total + '</div>' +
            '<div class="dispatch-lbl">Total routes</div>' +
        '</div>' +
        '<div class="dispatch-summary-cell">' +
            '<div class="dispatch-num" style="color:#10b981">' + approved + '</div>' +
            '<div class="dispatch-lbl">Approved</div>' +
        '</div>' +
        '<div class="dispatch-summary-cell">' +
            '<div class="dispatch-num" style="color:#f59e0b">' + issues + '</div>' +
            '<div class="dispatch-lbl">Have issues</div>' +
        '</div>' +
        '<div class="dispatch-summary-cell">' +
            '<div class="dispatch-num" style="color:#ef4444">' + flagged + '</div>' +
            '<div class="dispatch-lbl">Flagged</div>' +
        '</div>' +
        '<div class="dispatch-summary-actions">' +
            '<button class="btn btn-primary btn-sm" onclick="CampistryGo.approveAllRoutes()">' +
                'Approve all' +
            '</button>' +
        '</div>' +
    '</div>';

    // Per-shift, per-route detail table
    perShift.forEach(shiftData => {
        const { shift, routes } = shiftData;
        html += '<div class="dispatch-shift">' +
            '<div class="dispatch-shift-header">' +
                esc(shift.label || 'Shift ' + (shiftData.shiftIdx + 1)) +
                ' <span style="color:var(--text-muted);font-weight:400;font-size:.75rem;">' +
                    routes.length + ' routes' +
                '</span>' +
            '</div>' +
            '<div class="dispatch-routes">';

        routes.forEach(rd => {
            const { route: r, analysis, isApproved, isFlagged, stopFlagCount } = rd;
            const totalFlags = (isFlagged ? 1 : 0) + stopFlagCount;

            const statusClass = isApproved ? 'approved'
                : analysis.issues.some(i => i.severity === 'error') ? 'error'
                : analysis.issues.some(i => i.severity === 'warn') ? 'warn'
                : 'ok';
            const statusIcon = isApproved ? '✓'
                : statusClass === 'error' ? '✗'
                : statusClass === 'warn'  ? '!'
                : '·';

            html += '<div class="dispatch-route dispatch-route-' + statusClass + '">' +
                '<div class="dispatch-route-header">' +
                    '<div class="dispatch-route-title">' +
                        '<span class="dispatch-status-dot dispatch-status-' + statusClass + '">' +
                            statusIcon +
                        '</span>' +
                        '<span style="background:' + esc(r.busColor) +
                            ';width:10px;height:10px;border-radius:50%;display:inline-block;"></span>' +
                        '<strong>' + esc(r.busName) + '</strong>' +
                        '<span class="dispatch-route-summary">' +
                            r.camperCount + ' kids · ' + r.stops.length + ' stops · ' +
                            r.totalDuration + ' min' +
                        '</span>' +
                    '</div>' +
                    '<div class="dispatch-route-actions">';

            if (totalFlags > 0) {
                html += '<span class="dispatch-flag-badge">' + totalFlags +
                    ' flag' + (totalFlags === 1 ? '' : 's') + '</span>';
            }

            if (isApproved) {
                html += '<button class="btn btn-ghost btn-sm"' +
                    ' onclick="CampistryGo.unapproveRoute(' + shiftData.shiftIdx + ',\'' +
                        esc(r.busId) + '\')">' +
                    'Unapprove</button>';
            } else {
                html += '<button class="btn btn-secondary btn-sm"' +
                    ' onclick="CampistryGo.flagRoute(' + shiftData.shiftIdx + ',\'' +
                        esc(r.busId) + '\',\'review\',\'\')">' +
                    'Flag</button>' +
                    '<button class="btn btn-primary btn-sm"' +
                    ' onclick="CampistryGo.approveRoute(' + shiftData.shiftIdx + ',\'' +
                        esc(r.busId) + '\')">' +
                    'Approve</button>';
            }
            html += '</div></div>';

            // Issues list
            if (analysis.issues.length > 0) {
                html += '<ul class="dispatch-issues">';
                analysis.issues.forEach(iss => {
                    html += '<li class="dispatch-issue dispatch-issue-' + iss.severity + '">' +
                        esc(iss.msg) + '</li>';
                });
                html += '</ul>';
            }

            // Anchor info + pin/unpin control
            if (analysis.details.detectedAnchor) {
                const da = analysis.details.detectedAnchor;
                const pa = analysis.details.pinnedAnchor;
                const isPinned = !!pa;
                const pinnedMatches = isPinned && pa.stopAddress === da.address;

                html += '<div class="dispatch-anchor">' +
                    '<span class="dispatch-anchor-icon">📍</span>' +
                    '<span>Mega-cluster: <strong>' + esc(da.address) + '</strong> ' +
                        '(' + da.kidCount + ' kids, ' + da.distMi.toFixed(1) + ' mi from camp)' +
                    '</span>';

                if (isPinned && !pinnedMatches) {
                    html += '<span class="dispatch-anchor-badge">pinned: ' +
                        esc(pa.stopAddress) + '</span>' +
                        '<button class="btn btn-ghost btn-sm"' +
                        ' onclick="CampistryGo.unpinAnchor(' + shiftData.shiftIdx + ',\'' +
                            esc(r.busId) + '\')">' +
                        'Unpin</button>';
                } else if (isPinned) {
                    html += '<span class="dispatch-anchor-badge dispatch-anchor-pinned">📌 pinned</span>' +
                        '<button class="btn btn-ghost btn-sm"' +
                        ' onclick="CampistryGo.unpinAnchor(' + shiftData.shiftIdx + ',\'' +
                            esc(r.busId) + '\')">' +
                        'Unpin</button>';
                } else {
                    html += '<button class="btn btn-ghost btn-sm"' +
                        ' onclick="CampistryGo.pinAnchor(' + shiftData.shiftIdx + ',\'' +
                            esc(r.busId) + '\',\'' + esc(da.address) + '\',' +
                            da.kidCount /* unused but keeps API parity */ + ',' + 0 + ')">' +
                        'Pin as anchor' +
                        '</button>';
                }
                html += '</div>';
            }

            html += '</div>'; // end dispatch-route
        });

        html += '</div></div>'; // end dispatch-routes, dispatch-shift
    });

    container.innerHTML = html;
    container.style.display = '';
}
// =========================================================================
    // PUBLIC API
    // =========================================================================
    window.CampistryGo = {
        saveSetup, toggleStandalone,
        openBusModal, saveBus, editBus, deleteBus, deleteBusFromModal, _pickColor, quickCreateBuses,
        addShift, deleteShift, toggleShiftDiv, updateShiftTime, renameShift,
        toggleShiftGrade, setShiftGradeMode, toggleShiftBus, setAllShiftBuses,
        openMonitorModal, saveMonitor, editMonitor, deleteMonitor,
        openCounselorModal, saveCounselor, editCounselor, deleteCounselor,
        acceptStaffAssign, denyStaffAssign, manualStaffAssign, acceptAllStaffSuggestions,
        editAddress, saveAddress, deleteAddress, _quickDeleteAddress, geocodeAll, validateAllAddresses, downloadAddressTemplate, importAddressCsv, sortAddresses,
        clearAllAddresses, clearAllMonitors, clearAllCounselors,
        regeocodeAll: function() { geocodeAll(true); },
        testGeocode, systemCheck, testGeoapify,
        generateRoutes, reOptimizeBus, exportRoutesCsv, printRoutes, detectRegions, diagnoseBus,
        renderMap, selectMapBus, toggleMapBus, toggleMapShift, setMapShiftsAll, toggleMapFullscreen,
        setAddressPinMode, toggleHideRoutes, toggleZones,
        toggleAddressPins, showAddressesOnMap, locateCamper,
        searchCamperInRoutes, zoomToStop, openMoveModal, renderFilteredMasterList, sortMasterBy,
        switchMode,
        closeModal, openModal,
        _getMap: function() { return _map; },
        _getSavedRoutes: function() { return D.savedRoutes; },
        _setSavedRoutes: function(r) { D.savedRoutes = r; _generatedRoutes = r; },
        _save: function() { save(); },
        _refreshRoutes: function() {
            if (D.savedRoutes) {
                _generatedRoutes = D.savedRoutes;
                var c = _map ? _map.getCenter() : null, z = _map ? _map.getZoom() : null;
                renderRouteResults(D.savedRoutes);
                if (_map && c && z != null) setTimeout(function() { _map.setView(c, z, { animate: false }); }, 200);
            }
        },
        _getRouteGeomCache: function() { return _routeGeomCache; },
        _clearGeomCache: function(key) { if (key) delete _routeGeomCache[key]; else _routeGeomCache = {}; },

        // Phase 3 dispatcher API
        flagStop, unflagStop,
        flagRoute, unflagRoute,
        approveRoute, unapproveRoute, approveAllRoutes,
        pinAnchor, unpinAnchor,
        renderDispatcherDashboard
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

    // Temporary debug helper — remove after diagnosis
    window._GoDebug = {
        getAddresses:  () => D.addresses,
        getRoster:     () => _goStandaloneRoster,
        getD:          () => D,
    };
})();
