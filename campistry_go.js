// =============================================================================
// campistry_go.js — Campistry Go v3.1
// VROOM-powered bus routing with ZIP-based region clustering
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
// =============================================================================
(function () {
    'use strict';
    console.log('[Go] Campistry Go v3.1 loading...');

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
    function openModal(id) { document.getElementById(id)?.classList.add('open'); }
    function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }
    function getApiKey() { return window.__CAMPISTRY_ORS_KEY__ || D.setup.orsApiKey || ''; }
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

    const MAX_STOP_CAPACITY = 15; // split clusters bigger than this
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
        const mbToken = D.setup.mapboxToken || '';
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
        applied.forEach(sr => { sr.routes.forEach(r => { const bus = D.buses.find(b => b.id === r.busId); if (!bus) return; const rs = D.setup.reserveSeats || 0; const mon = D.monitors.find(m => m.assignedBus === bus.id); const couns = D.counselors.filter(c => c.assignedBus === bus.id); const maxCampers = Math.max(0, (bus.capacity || 0) - 1 - (mon ? 1 : 0) - couns.length - rs); if (r.camperCount > maxCampers) warnings.push({ busName: r.busName, busColor: r.busColor, shift: sr.shift.label || 'Shift', actual: r.camperCount, max: maxCampers, over: r.camperCount - maxCampers }); }); });
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
    function getRoster() {
        const g = readCampistrySettings();
        const roster = g?.app1?.camperRoster || {};
        let needsSave = false, maxId = 0;
        Object.values(roster).forEach(c => { if (c.camperId && c.camperId > maxId) maxId = c.camperId; });
        let nextId = (g?.campistryMe?.nextCamperId) || maxId + 1;
        if (maxId >= nextId) nextId = maxId + 1;
        Object.entries(roster).forEach(([n, c]) => { if (!c.camperId) { c.camperId = nextId; nextId++; needsSave = true; } });
        if (needsSave) {
            try { const raw = localStorage.getItem('campGlobalSettings_v1'); if (raw) { const data = JSON.parse(raw); data.app1.camperRoster = roster; if (!data.campistryMe) data.campistryMe = {}; data.campistryMe.nextCamperId = nextId; localStorage.setItem('campGlobalSettings_v1', JSON.stringify(data)); } } catch (e) {}
        }
        return roster;
    }
    function getStructure() { const g = readCampistrySettings(); return g?.campStructure || {}; }
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
        document.getElementById('dropoffMode').value = s.dropoffMode || 'door-to-door';
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
    function renderFleet() {
        const c = document.getElementById('fleetContainer'), e = document.getElementById('fleetEmptyState');
        document.getElementById('fleetCount').textContent = D.buses.length + ' bus' + (D.buses.length !== 1 ? 'es' : '');
        if (!D.buses.length) { c.innerHTML = ''; c.style.display = 'none'; e.style.display = ''; return; }
        e.style.display = 'none'; c.style.display = '';
        const rs = D.setup.reserveSeats || 0;
        c.innerHTML = '<div class="fleet-grid">' + D.buses.map(b => {
            const mon = D.monitors.find(m => m.assignedBus === b.id);
            const couns = D.counselors.filter(x => x.assignedBus === b.id);
            const staff = (mon ? 1 : 0) + couns.length;
            const avail = Math.max(0, (b.capacity || 0) - 1 - staff - rs);
            return '<div class="bus-card"><div class="bus-card-stripe" style="background:' + esc(b.color) + '"></div><div class="bus-card-header"><div><div class="bus-card-name">' + esc(b.name) + '</div>' + (b.notes ? '<div class="bus-card-number">' + esc(b.notes) + '</div>' : '') + '</div><div class="bus-card-actions"><button onclick="CampistryGo.editBus(\'' + b.id + '\')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button><button class="delete" onclick="CampistryGo.deleteBus(\'' + b.id + '\')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button></div></div><div class="bus-card-stats"><div class="bus-stat"><div class="bus-stat-value">' + b.capacity + '</div><div class="bus-stat-label">Total</div></div><div class="bus-stat"><div class="bus-stat-value">' + avail + '</div><div class="bus-stat-label">For Kids</div></div><div class="bus-stat"><div class="bus-stat-value">' + staff + '</div><div class="bus-stat-label">Staff</div></div><div class="bus-stat"><div class="bus-stat-value">' + rs + '</div><div class="bus-stat-label">Reserved</div></div></div>' + (mon ? '<div style="margin-top:.75rem;font-size:.75rem;color:var(--text-muted)">Monitor: <strong style="color:var(--text-secondary)">' + esc(mon.name) + '</strong></div>' : '') + '</div>';
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
        openModal('busModal'); document.getElementById('busName').focus();
    }
    function _pickColor(el) { el.parentElement.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected')); el.classList.add('selected'); }
    function saveBus() {
        const name = document.getElementById('busName')?.value.trim(), cap = parseInt(document.getElementById('busCapacity')?.value);
        const color = document.querySelector('#busColorPicker .color-swatch.selected')?.dataset.color || BUS_COLORS[0];
        const notes = document.getElementById('busNotes')?.value.trim();
        if (!name) { toast('Enter name', 'error'); return; } if (!cap || cap < 1) { toast('Enter capacity', 'error'); return; }
        if (_editBusId) { const b = D.buses.find(x => x.id === _editBusId); if (b) { b.name = name; b.capacity = cap; b.color = color; b.notes = notes; } }
        else D.buses.push({ id: uid(), name, capacity: cap, color, notes });
        save(); closeModal('busModal'); renderFleet(); updateStats(); updateBusSelects(); toast(_editBusId ? 'Updated' : 'Bus added');
    }
    function editBus(id) { openBusModal(id); }
    function deleteBus(id) { const b = D.buses.find(x => x.id === id); if (!b || !confirm('Delete "' + b.name + '"?')) return; D.buses = D.buses.filter(x => x.id !== id); D.monitors.forEach(m => { if (m.assignedBus === id) m.assignedBus = ''; }); D.counselors.forEach(c => { if (c.assignedBus === id) c.assignedBus = ''; }); save(); renderFleet(); renderStaff(); updateStats(); updateBusSelects(); toast('Deleted'); }
    function updateBusSelects() { ['monitorBusAssign', 'counselorBusAssign'].forEach(sid => { const s = document.getElementById(sid); if (!s) return; const cur = s.value; s.innerHTML = '<option value="">— Later —</option>' + D.buses.map(b => '<option value="' + esc(b.id) + '"' + (b.id === cur ? ' selected' : '') + '>' + esc(b.name) + '</option>').join(''); }); }

    // =========================================================================
    // SHIFTS
    // =========================================================================
    function renderShifts() {
        const container = document.getElementById('shiftsContainer'), empty = document.getElementById('shiftsEmptyState');
        document.getElementById('shiftCount').textContent = D.shifts.length + ' shift' + (D.shifts.length !== 1 ? 's' : '');
        if (!D.shifts.length) { container.innerHTML = ''; empty.style.display = ''; return; }
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
    function renderAddresses() {
        const roster = getRoster();
        const names = Object.keys(roster).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        const filter = (document.getElementById('addressSearch')?.value || '').toLowerCase().trim();
        let filtered = names;
        if (filter) filtered = names.filter(n => { const c = roster[n]; const a = D.addresses[n]; return n.toLowerCase().includes(filter) || (c.division || '').toLowerCase().includes(filter) || (a?.street || '').toLowerCase().includes(filter) || (a?.city || '').toLowerCase().includes(filter); });
        const tbody = document.getElementById('addressTableBody'), empty = document.getElementById('addressEmptyState');
        const tw = tbody?.closest('.table-wrapper');
        document.getElementById('addressCount').textContent = filter ? filtered.length + ' of ' + names.length : names.length;
        if (!names.length) { if (tw) tw.style.display = 'none'; if (empty) empty.style.display = ''; updateAddrProgress(0, 0); return; }
        if (tw) tw.style.display = ''; if (empty) empty.style.display = 'none';
        let withAddr = 0; names.forEach(n => { if (D.addresses[n]?.street) withAddr++; });
        updateAddrProgress(withAddr, names.length);
        tbody.innerHTML = filtered.map(n => {
            const c = roster[n], a = D.addresses[n];
            const hasA = a?.street;
            const full = hasA ? [a.street, a.city, a.state, a.zip].filter(Boolean).join(', ') : '';
            const badge = hasA ? (a.geocoded ? (a._zipMismatch ? '<span class="badge badge-warning" title="ZIP mismatch">⚠ Check</span>' : '<span class="badge badge-success">Geocoded</span>') : '<span class="badge badge-warning">Not geocoded</span>') : '<span class="badge badge-danger">Missing</span>';
            return '<tr><td style="font-size:.75rem;color:var(--text-muted);font-family:monospace;">' + (c.camperId ? '#' + String(c.camperId).padStart(4, '0') : '') + '</td><td style="font-weight:600">' + esc(n) + '</td><td>' + (esc(c.division) || '—') + '</td><td>' + (esc(c.bunk) || '—') + '</td><td>' + (full ? esc(full) : '<span style="color:var(--text-muted)">No address</span>') + '</td><td>' + badge + '</td><td><button class="btn btn-ghost btn-sm" onclick="CampistryGo.editAddress(\'' + esc(n.replace(/'/g, "\\'")) + '\')">' + (hasA ? 'Edit' : 'Add') + '</button></td></tr>';
        }).join('');
    }
    function updateAddrProgress(n, t) { const p = t > 0 ? Math.round(n / t * 100) : 0; document.getElementById('addressProgressBar').style.width = p + '%'; document.getElementById('addressProgressText').textContent = n + ' of ' + t + ' (' + p + '%)'; }
    function editAddress(name) {
        _editCamper = name; const roster = getRoster(), c = roster[name] || {}, a = D.addresses[name] || {};
        document.getElementById('addressCamperName').textContent = name;
        document.getElementById('addressCamperBunk').textContent = [c.division, c.bunk].filter(Boolean).join(' / ');
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
        const q = [a.street, a.city, a.state, a.zip].filter(Boolean).join(', ');
        try { const d = await censusGeocode(q); if (d?.result?.addressMatches?.length) { const best = d.result.addressMatches[0]; a.lat = best.coordinates.y; a.lng = best.coordinates.x; a.geocoded = true; a._zipMismatch = false; a._geocodeSource = 'census'; return true; } } catch (e) { console.warn('[Go] Census error for', name, e.message); }
        const key = getApiKey(); if (!key) return false;
        const params = { text: q, size: '5', 'boundary.country': 'US' };
        if (_campCoordsCache) { params['focus.point.lat'] = _campCoordsCache.lat; params['focus.point.lon'] = _campCoordsCache.lng; }
        try { const r = await fetch('https://api.openrouteservice.org/geocode/search?' + new URLSearchParams(params), { headers: { 'Authorization': key, 'Accept': 'application/json' } }); if (!r.ok) return false; const d = await r.json(); if (!d.features?.length) return false; let best = null; if (a.zip) best = d.features.find(f => (f.properties?.postalcode || '') === a.zip); if (!best) best = d.features[0]; const co = best.geometry.coordinates; a.lng = co[0]; a.lat = co[1]; a.geocoded = true; a._geocodeSource = 'ors'; a._zipMismatch = !!(a.zip && best.properties?.postalcode && best.properties.postalcode !== a.zip); return true; } catch (e) { return false; }
    }

    async function geocodeAll(force) {
        if (!_campCoordsCache && D.setup.campAddress) { toast('Geocoding camp address first...'); const cc = await geocodeSingle(D.setup.campAddress); if (cc) { _campCoordsCache = cc; D.setup.campLat = cc.lat; D.setup.campLng = cc.lng; save(); } }
        const todo = Object.keys(D.addresses).filter(n => { const a = D.addresses[n]; if (!a?.street) return false; if (force) { a.geocoded = false; a.lat = null; a.lng = null; a._zipMismatch = false; return true; } return !a.geocoded; });
        if (!todo.length) { toast('All addresses already geocoded!'); return; }
        toast('Pass 1: Census — ' + todo.length + ' addresses...');
        let censusOk = 0, censusFail = [];
        for (let i = 0; i < todo.length; i++) {
            const name = todo[i]; const a = D.addresses[name]; if (!a?.street) { censusFail.push(name); continue; }
            const q = [a.street, a.city, a.state, a.zip].filter(Boolean).join(', ');
            try { const d = await censusGeocode(q); if (d?.result?.addressMatches?.length) { const best = d.result.addressMatches[0]; a.lat = best.coordinates.y; a.lng = best.coordinates.x; a.geocoded = true; a._zipMismatch = false; a._geocodeSource = 'census'; censusOk++; } else censusFail.push(name); } catch (e) { censusFail.push(name); }
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
                try { const r = await fetch('https://api.openrouteservice.org/geocode/search?' + new URLSearchParams(params), { headers: { 'Authorization': getApiKey(), 'Accept': 'application/json' } }); if (r.ok) { const d = await r.json(); if (d.features?.length) { let best = null; if (a.zip) best = d.features.find(f => (f.properties?.postalcode || '') === a.zip); if (!best) best = d.features[0]; const co = best.geometry.coordinates; a.lng = co[0]; a.lat = co[1]; a.geocoded = true; a._geocodeSource = 'ors'; a._zipMismatch = !!(a.zip && best.properties?.postalcode && best.properties.postalcode !== a.zip); orsOk++; } else orsFail++; } else { orsFail++; if (r.status === 429 || r.status === 403) { orsFail += censusFail.length - i - 1; break; } } } catch (e) { orsFail++; }
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
        try { const d = await censusGeocode(addr); if (d?.result?.addressMatches?.length) { const m = d.result.addressMatches[0]; return { lat: m.coordinates.y, lng: m.coordinates.x }; } } catch (_) {}
        const key = getApiKey(); if (!key) return null;
        try { const r = await fetch('https://api.openrouteservice.org/geocode/search?' + new URLSearchParams({ text: addr, size: '1', 'boundary.country': 'US' }), { headers: { 'Authorization': key, 'Accept': 'application/json' } }); if (!r.ok) return null; const d = await r.json(); if (d.features?.length) { const co = d.features[0].geometry.coordinates; return { lat: co[1], lng: co[0] }; } } catch (_) {} return null;
    }

    // =========================================================================
    // SYSTEM CHECK
    // =========================================================================
    async function systemCheck() {
        let pass = 0, fail = 0, warn = 0;
        function P(msg) { pass++; console.log('✅ ' + msg); } function F(msg) { fail++; console.log('❌ ' + msg); } function Wr(msg) { warn++; console.log('⚠️  ' + msg); }
        console.log('\n╔══════════════════════════════════════╗\n║   CAMPISTRY GO v3.1 — SYSTEM CHECK   ║\n╚══════════════════════════════════════╝\n');
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
        let csv = '\uFEFFID,Name,Division,Bunk,Street Address,City,State,ZIP,Transport,Ride With\n';
        names.forEach(n => { const c = roster[n], a = D.addresses[n] || {}; csv += [c.camperId ? String(c.camperId).padStart(4, '0') : '', n, c.division || '', c.bunk || '', a.street || '', a.city || '', a.state || 'NY', a.zip || '', a.transport || 'bus', a.rideWith || ''].map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',') + '\n'; });
        const blob = new Blob([csv], { type: 'text/csv' }); const el = document.createElement('a'); el.href = URL.createObjectURL(blob); el.download = 'campistry_go_addresses.csv'; el.click(); toast('Template downloaded');
    }
    function importAddressCsv() { const inp = document.getElementById('csvFileInput'); inp.onchange = function () { if (!inp.files[0]) return; const r = new FileReader(); r.onload = e => { parseCsv(e.target.result); inp.value = ''; }; r.readAsText(inp.files[0]); }; inp.click(); }
    function parseCsv(text) {
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        const lines = text.split(/\r?\n/).filter(l => l.trim()); if (lines.length < 2) { toast('Empty CSV', 'error'); return; }
        const hdr = parseLine(lines[0]).map(h => h.toLowerCase().trim());
        const ni = hdr.findIndex(h => h === 'name' || h === 'camper name' || h === 'camper'), si = hdr.findIndex(h => h.includes('street') || h === 'address'), ci = hdr.findIndex(h => h === 'city'), sti = hdr.findIndex(h => h === 'state'), zi = hdr.findIndex(h => h === 'zip' || h.includes('zip')), tri = hdr.findIndex(h => h === 'transport' || h === 'mode' || h.includes('pickup') || h.includes('carpool')), rwi = hdr.findIndex(h => h === 'ride-with' || h === 'ridewith' || h === 'ride with' || h.includes('pair'));
        if (ni < 0 || si < 0) { toast('Need Name + Street columns', 'error'); return; }
        D.addresses = {};
        const roster = getRoster(); let up = 0;
        for (let i = 1; i < lines.length; i++) {
            const cols = parseLine(lines[i]); const name = (cols[ni] || '').trim(); if (!name) continue;
            const rn = Object.keys(roster).find(k => k.toLowerCase() === name.toLowerCase()) || name;
            const street = (cols[si] || '').trim(); if (!street) continue;
            const transport = tri >= 0 ? (cols[tri] || '').trim().toLowerCase() : 'bus';
            const rideWith = rwi >= 0 ? (cols[rwi] || '').trim() : '';
            D.addresses[rn] = { street, city: ci >= 0 ? (cols[ci] || '').trim() : '', state: sti >= 0 ? (cols[sti] || '').trim().toUpperCase() : 'NY', zip: zi >= 0 ? (cols[zi] || '').trim() : '', lat: null, lng: null, geocoded: false, transport: (transport === 'pickup' || transport === 'carpool') ? 'pickup' : 'bus', rideWith: rideWith }; up++;
        }
        save(); renderAddresses(); updateStats(); toast(up + ' addresses imported');
    }
    function parseLine(line) { const r = []; let cur = '', inQ = false; for (let i = 0; i < line.length; i++) { const ch = line[i]; if (inQ) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += ch; } else { if (ch === '"') inQ = true; else if (ch === ',' || ch === '\t') { r.push(cur); cur = ''; } else cur += ch; } } r.push(cur); return r; }
    function updateStats() {
        const roster = getRoster(); const c = Object.keys(roster).length; let wA = 0; Object.keys(roster).forEach(n => { if (D.addresses[n]?.street) wA++; });
        document.getElementById('statBuses').textContent = D.buses.length; document.getElementById('statCampers').textContent = c;
        document.getElementById('statShifts').textContent = D.shifts.length; document.getElementById('statAddresses').textContent = wA + '/' + c;
    }

    // =========================================================================
    // PREFLIGHT
    // =========================================================================
    function runPreflight() {
        const roster = getRoster(); const camperCount = Object.keys(roster).length;
        let geocoded = 0; Object.keys(roster).forEach(n => { if (D.addresses[n]?.geocoded) geocoded++; });
        const rs = parseInt(document.getElementById('routeReserveSeats')?.value) || D.setup.reserveSeats || 0;
        let totalSeats = 0; D.buses.forEach(b => { const m = D.monitors.find(x => x.assignedBus === b.id); const co = D.counselors.filter(x => x.assignedBus === b.id); totalSeats += Math.max(0, (b.capacity || 0) - 1 - (m ? 1 : 0) - co.length - rs); });
        let inShifts = 0; Object.entries(roster).forEach(([n, c]) => { if (D.shifts.some(sh => camperMatchesShift(c, sh))) inShifts++; });
        const largestShift = D.shifts.length ? Math.max(...D.shifts.map(s => countCampersForShift(s))) : 0;
        let pickupCount = 0; Object.keys(roster).forEach(n => { if (D.addresses[n]?.transport === 'pickup') pickupCount++; });
        const checks = [
            { label: D.buses.length + ' bus(es)', status: D.buses.length > 0 ? 'ok' : 'fail' },
            { label: D.shifts.length + ' shift(s)', status: D.shifts.length > 0 ? 'ok' : 'warn', detail: D.shifts.length === 0 ? 'No shifts — all campers in one group' : '' },
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
        let perBusCap = 0; if (D.buses.length) { let tc = 0; D.buses.forEach(b => { const m = D.monitors.find(x => x.assignedBus === b.id); const co = D.counselors.filter(x => x.assignedBus === b.id); tc += Math.max(0, (b.capacity || 0) - 1 - (m ? 1 : 0) - co.length - rs); }); perBusCap = Math.floor(tc / D.buses.length); }
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
    // ROUTING ENGINE v10.1 — VROOM-powered
    //
    // v10.1 changes: OSRM retry, aggressive rebalancing, Manhattan walk distance
    // =========================================================================

    async function generateRoutes() {
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
            return { busId: b.id, name: b.name, color: b.color || '#10b981', capacity: Math.max(0, (b.capacity || 0) - 1 - (mon ? 1 : 0) - couns.length - reserveSeats), monitor: mon, counselors: couns };
        });

        let campCoords = null;
        if (D.setup.campAddress) {
            showProgress('Geocoding camp...', 5);
            campCoords = _campCoordsCache || await geocodeSingle(D.setup.campAddress);
            if (campCoords) { _campCoordsCache = campCoords; D.setup.campLat = campCoords.lat; D.setup.campLng = campCoords.lng; }
        }
        const campLat = campCoords?.lat || _detectedRegions[0].centroidLat;
        const campLng = campCoords?.lng || _detectedRegions[0].centroidLng;

        showProgress('Assigning buses to regions...', 10);
        const assignments = assignBusesToRegions(vehicles, _detectedRegions, D.shifts);

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
                routes = await solveWithVROOM(allCampers, shiftVehicles, campLat, campLng, mode, key, shift, si, shifts.length);
            }

            // Add monitor + counselor stops
            routes.forEach(r => {
                if (r.monitor?.address) r.stops.push({ stopNum: r.stops.length + 1, campers: [], address: r.monitor.address, lat: null, lng: null, isMonitor: true, monitorName: r.monitor.name });
                r.counselors.filter(c => c.needsStop === 'yes' && c.address).forEach(c => { r.stops.push({ stopNum: r.stops.length + 1, campers: [], address: c.address, lat: null, lng: null, isCounselor: true, counselorName: c.name }); });
            });

            // Calculate ETAs
            const isArrival = D.activeMode === 'arrival';
            const hasShifts = shifts.length > 1;
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
                    if (hasShifts && r.stops.length > 0) {
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
    async function solveWithVROOM(campers, vehicles, campLat, campLng, mode, apiKey, shift, shiftIdx, totalShifts) {
        const isArrival = D.activeMode === 'arrival';
        const hasShifts = totalShifts > 1;
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

        // Post-clustering deduplication (~200ft)
        const dedupDist = 0.038;
        let dedups = 0;
        for (let i = 0; i < stops.length; i++) {
            for (let j = i + 1; j < stops.length; j++) {
                if (haversineMi(stops[i].lat, stops[i].lng, stops[j].lat, stops[j].lng) <= dedupDist) {
                    stops[i].campers.push(...stops[j].campers);
                    if (stops[j].address.includes('&') && !stops[i].address.includes('&')) stops[i].address = stops[j].address;
                    stops.splice(j, 1);
                    j--; dedups++;
                }
            }
        }
        if (dedups) console.log('[Go] Dedup: merged ' + dedups + ' nearby duplicate stop(s)');

        console.log('[Go] VROOM Engine: ' + stops.length + ' stops, ' + numBuses + ' buses, mode=' + mode);

        // ══════════════════════════════════════════════════════════════
        // UNIFIED VROOM SOLVER
        //
        // Based on the "Cluster-first, Route-second" approach from VRP
        // literature (Fisher & Jaikumar, BiRD/MIT, etc.):
        //
        // 1. Stop creation already happened per-region (density-adaptive)
        // 2. Send ALL stops + ALL buses to ONE VROOM call
        //    - VROOM handles both assignment (which bus) AND ordering
        //    - Real bus capacity enforced natively by VROOM
        //    - Geographically coherent routes emerge naturally because
        //      VROOM minimizes total drive time
        // 3. Orient each route (reverse if pointing wrong direction)
        // 4. Post-routing same-street merge
        //
        // This replaces the old region-split → per-region VROOM → rebalance
        // → local TSP → hard sort pipeline that fought itself at every step.
        // ══════════════════════════════════════════════════════════════

        showProgress('Optimizing routes (VROOM)...', 30);

        // Build VROOM jobs from ALL stops
        const vroomJobs = stops.map((stop, i) => ({
            id: i + 1,
            location: [stop.lng, stop.lat],
            service: serviceTime,
            amount: [stop.campers.length],
            description: stop.address
        }));

        // Build VROOM vehicles from ALL buses with REAL capacity
        const vroomVehicles = vehicles.map((v, vi) => {
            const veh = {
                id: vi + 1,
                profile: 'driving-car',
                capacity: [v.capacity],
                description: v.name
            };
            // Set start/end based on mode
            if (isArrival) {
                veh.end = [campLng, campLat]; // bus ends at camp
            } else {
                veh.start = [campLng, campLat]; // bus starts at camp
                if (hasShifts) veh.end = [campLng, campLat]; // returns for next shift
            }
            return veh;
        });

        console.log('[Go] VROOM: ' + vroomJobs.length + ' jobs, ' + vroomVehicles.length + ' vehicles');

        let allRoutes = [];
        let vroomSuccess = false;

        try {
            const resp = await fetch('https://api.openrouteservice.org/optimization', {
                method: 'POST',
                headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ jobs: vroomJobs, vehicles: vroomVehicles })
            });

            if (resp.ok) {
                const result = await resp.json();
                console.log('[Go] VROOM: ' + (result.routes?.length || 0) + ' routes, ' +
                    (result.unassigned?.length || 0) + ' unassigned');

                // Parse VROOM routes
                (result.routes || []).forEach(vroomRoute => {
                    const vehicleIdx = vroomRoute.vehicle - 1;
                    const v = vehicles[vehicleIdx]; if (!v) return;
                    const routeStops = [];
                    vroomRoute.steps.forEach(step => {
                        if (step.type !== 'job') return;
                        const stop = stops[step.id - 1]; if (!stop) return;
                        routeStops.push({
                            stopNum: routeStops.length + 1,
                            campers: stop.campers,
                            address: stop.address,
                            lat: stop.lat,
                            lng: stop.lng
                        });
                    });
                    if (routeStops.length > 0) {
                        allRoutes.push({
                            busId: v.busId, busName: v.name, busColor: v.color,
                            monitor: v.monitor, counselors: v.counselors || [],
                            stops: routeStops,
                            camperCount: routeStops.reduce((s, st) => s + st.campers.length, 0),
                            _cap: v.capacity,
                            totalDuration: Math.round((vroomRoute.duration || 0) / 60)
                        });
                    }
                });

                // Handle unassigned — force-insert into nearest bus (never drop kids)
                if (result.unassigned?.length) {
                    console.log('[Go] VROOM: ' + result.unassigned.length + ' unassigned — force-inserting');
                    result.unassigned.forEach(ua => {
                        const stop = stops[ua.id - 1]; if (!stop) return;
                        let bestRoute = null, bestDist = Infinity;
                        // First: nearest bus with capacity
                        allRoutes.forEach(r => {
                            if (r.camperCount + stop.campers.length > r._cap) return;
                            const last = r.stops[r.stops.length - 1];
                            if (last?.lat) {
                                const d = haversineMi(last.lat, last.lng, stop.lat, stop.lng);
                                if (d < bestDist) { bestDist = d; bestRoute = r; }
                            }
                        });
                        // Fallback: nearest bus regardless of capacity
                        if (!bestRoute) {
                            allRoutes.forEach(r => {
                                const last = r.stops.length ? r.stops[r.stops.length - 1] : null;
                                if (last?.lat) {
                                    const d = haversineMi(last.lat, last.lng, stop.lat, stop.lng);
                                    if (d < bestDist) { bestDist = d; bestRoute = r; }
                                }
                            });
                        }
                        if (bestRoute) {
                            directionalInsert(bestRoute.stops, {
                                stopNum: 0, campers: stop.campers,
                                address: stop.address, lat: stop.lat, lng: stop.lng
                            }, campLat, campLng);
                            bestRoute.camperCount += stop.campers.length;
                        }
                    });
                }

                vroomSuccess = true;
            } else {
                console.error('[Go] VROOM HTTP ' + resp.status);
            }
        } catch (e) {
            console.error('[Go] VROOM failed:', e.message);
        }

        // Fallback: geographic routing if VROOM fails
        if (!vroomSuccess || allRoutes.length === 0) {
            console.warn('[Go] Using fallback geographic routing');
            allRoutes = fallbackRouting(stops, vehicles, campLat, campLng);
        }

        // Ensure all buses have route entries (even if empty)
        vehicles.forEach(v => {
            if (!allRoutes.find(r => r.busId === v.busId)) {
                allRoutes.push({
                    busId: v.busId, busName: v.name, busColor: v.color,
                    monitor: v.monitor, counselors: v.counselors || [],
                    stops: [], camperCount: 0, _cap: v.capacity, totalDuration: 0
                });
            }
        });

        // ══════════════════════════════════════════════════════════════
        // ORIENT ROUTES
        //
        // VROOM found the optimal ordering. Just check direction:
        // Arrival: first stop should be farther from camp than last
        // Dismissal: first stop should be closer to camp than last
        // If wrong, reverse the whole route.
        // ══════════════════════════════════════════════════════════════
        showProgress('Finalizing routes...', 85);

        allRoutes.forEach(r => {
            if (r.stops.length < 2) return;
            const fd = haversineMi(campLat, campLng, r.stops[0].lat, r.stops[0].lng);
            const ld = haversineMi(campLat, campLng, r.stops[r.stops.length - 1].lat, r.stops[r.stops.length - 1].lng);
            if (isArrival && fd < ld) r.stops.reverse();
            if (!isArrival && fd > ld) r.stops.reverse();
            r.stops.forEach((s, i) => { s.stopNum = i + 1; });
        });

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
                const d = haversineMi(a.lat, a.lng, b.lat, b.lng);
                if (d > 0.057) continue; // ~300ft
                const stA = normalizeStreet(parseAddress(a.address).street);
                const stB = normalizeStreet(parseAddress(b.address).street);
                if (!stA || !stB) continue;
                if (stA === stB || stA.includes(stB) || stB.includes(stA)) {
                    a.campers.push(...b.campers);
                    if (b.address.includes('&') && !a.address.includes('&')) a.address = b.address;
                    r.stops.splice(i + 1, 1);
                    merged++; i--;
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
        // Hard constraint: no bus exceeds its seat count.
        // Strategy:
        //   1. Try moving whole stops (farthest outlier first)
        //   2. If no bus can fit the whole stop, split it — move
        //      individual campers to the nearest bus with any room
        // ══════════════════════════════════════════════════════════════
        let capMoves = 0;
        for (let capPass = 0; capPass < 100; capPass++) {
            // Find any bus over capacity
            let overBus = null, worstOver = 0;
            for (const r of allRoutes) {
                const over = r.camperCount - r._cap;
                if (over > worstOver && r.stops.length > 0) { worstOver = over; overBus = r; }
            }
            if (!overBus) break; // all buses within capacity

            // Find the outlier stop (farthest from centroid)
            const cLat = overBus.stops.reduce((s, st) => s + st.lat, 0) / overBus.stops.length;
            const cLng = overBus.stops.reduce((s, st) => s + st.lng, 0) / overBus.stops.length;
            let moveIdx = 0, moveDist = 0;
            overBus.stops.forEach((st, i) => {
                const d = haversineMi(cLat, cLng, st.lat, st.lng);
                if (d > moveDist) { moveDist = d; moveIdx = i; }
            });
            const stopToMove = overBus.stops[moveIdx];

            // Try 1: move the whole stop to a bus with room
            let bestBus = null, bestDist = Infinity;
            for (const r of allRoutes) {
                if (r === overBus) continue;
                if (r.camperCount + stopToMove.campers.length > r._cap) continue;
                const rLat = r.stops.length ? r.stops.reduce((s, st) => s + st.lat, 0) / r.stops.length : campLat;
                const rLng = r.stops.length ? r.stops.reduce((s, st) => s + st.lng, 0) / r.stops.length : campLng;
                const d = haversineMi(stopToMove.lat, stopToMove.lng, rLat, rLng);
                if (d < bestDist) { bestDist = d; bestBus = r; }
            }

            if (bestBus) {
                // Whole-stop move
                overBus.stops.splice(moveIdx, 1);
                overBus.camperCount -= stopToMove.campers.length;
                overBus.stops.forEach((s, i) => { s.stopNum = i + 1; });
                directionalInsert(bestBus.stops, stopToMove, campLat, campLng);
                bestBus.camperCount += stopToMove.campers.length;
                capMoves++;
            } else {
                // Try 2: split the stop — move campers one at a time to buses with room
                let movedAny = false;
                while (overBus.camperCount > overBus._cap && stopToMove.campers.length > 1) {
                    // Find nearest bus with at least 1 seat
                    let splitBus = null, splitDist = Infinity;
                    for (const r of allRoutes) {
                        if (r === overBus) continue;
                        if (r.camperCount >= r._cap) continue;
                        const rLat = r.stops.length ? r.stops.reduce((s, st) => s + st.lat, 0) / r.stops.length : campLat;
                        const rLng = r.stops.length ? r.stops.reduce((s, st) => s + st.lng, 0) / r.stops.length : campLng;
                        const d = haversineMi(stopToMove.lat, stopToMove.lng, rLat, rLng);
                        if (d < splitDist) { splitDist = d; splitBus = r; }
                    }
                    if (!splitBus) break; // truly no room anywhere

                    // How many can this bus take?
                    const room = splitBus._cap - splitBus.camperCount;
                    const toMove = Math.min(room, overBus.camperCount - overBus._cap);
                    if (toMove <= 0) break;

                    // Split: move campers to a new stop on the receiving bus
                    const movedCampers = stopToMove.campers.splice(0, toMove);
                    overBus.camperCount -= toMove;
                    const newStop = {
                        stopNum: 0, campers: movedCampers,
                        address: stopToMove.address, lat: stopToMove.lat, lng: stopToMove.lng
                    };
                    directionalInsert(splitBus.stops, newStop, campLat, campLng);
                    splitBus.camperCount += toMove;
                    movedAny = true;
                    capMoves++;
                }
                // Remove the stop if all campers were moved
                if (stopToMove.campers.length === 0) {
                    overBus.stops.splice(moveIdx, 1);
                    overBus.stops.forEach((s, i) => { s.stopNum = i + 1; });
                }
                if (!movedAny) {
                    console.warn('[Go] ⚠ ' + overBus.busName + ': ' + overBus.camperCount + '/' + overBus._cap + ' — no room anywhere');
                    break;
                }
            }
        }
        if (capMoves) console.log('[Go] Capacity enforcement: ' + capMoves + ' move(s)');

        // Route quality summary
        const totalKids = allRoutes.reduce((s, r) => s + r.camperCount, 0);
        const totalStops = allRoutes.reduce((s, r) => s + r.stops.length, 0);
        const busesUsed = allRoutes.filter(r => r.stops.length > 0).length;
        const maxKids = Math.max(...allRoutes.map(r => r.camperCount));
        const minKids = Math.min(...allRoutes.filter(r => r.camperCount > 0).map(r => r.camperCount));
        const avgKids = totalKids / Math.max(1, busesUsed);
        const imbalance = maxKids > 0 ? ((maxKids - minKids) / maxKids * 100).toFixed(0) : 0;

        console.log('[Go] ═══ ROUTE QUALITY SUMMARY ═══');
        console.log('[Go]   Mode: ' + (isArrival ? 'ARRIVAL' : 'DISMISSAL' + (hasShifts ? ' (return to camp)' : ' (no return)')));
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

        return allRoutes;
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
        const mbTok = D.setup.mapboxToken || '';

        if (nn <= 11 && mbTok) {
            // Build coords for Mapbox Optimize
            let coords, sourceP, destP, roundtripP;
            if (isArrival) {
                coords = stops.map(s => s.lng + ',' + s.lat).join(';') + ';' + campLng + ',' + campLat;
                sourceP = 'any'; destP = 'last'; roundtripP = 'false';
            } else if (hasShifts) {
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
            const endsAtCamp = isArrival || hasShifts;
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
            if (hasShifts) route.totalDuration += Math.round(campToStopMin(rStops[rStops.length - 1]));
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
                osmIntersections = null;
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
                        if (d > walkMi * 3) return;

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
                    }
                }
            } else if (mainStreet) {
                const nums = cluster.map(c => parseAddress(c.address).num).filter(n => n > 0).sort((a, b) => a - b);
                if (nums.length >= 2) stopName = nums[0] + '-' + nums[nums.length - 1] + ' ' + mainStreet;
                else stopName = mainStreet;

                if (osmIntersections) {
                    // Single street — find the intersection on this street
                    // that minimizes total walk from all kids
                    let bestInter = null, bestWalk = Infinity;
                    osmIntersections.forEach(inter => {
                        const d = haversineMi(fallbackLat, fallbackLng, inter.lat, inter.lng);
                        if (d > walkMi * 3) return;
                        const interStreets = (inter.streets || []).map(s => s.toLowerCase());
                        if (!interStreets.some(s => streetMatch(s, mainStreet))) return;
                        const tw = totalWalkTo(inter.lat, inter.lng);
                        if (tw < bestWalk) { bestWalk = tw; bestInter = inter; }
                    });
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
        const buf = 0.003;
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
        if (_activeMapBus && _activeMapBus !== 'all') rows = rows.filter(r => r.busId === _activeMapBus);
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
    let _activeShifts = new Set();
    let _activeMapBus = 'all';
    let _pendingMapInit = null;
    let _routeGeomCache = {};
    window._routeGeomCache = _routeGeomCache;

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
        _activeMapBus = 'all';
        const container = document.getElementById('routeMap');
        if (_map) { _map.remove(); _map = null; }
        _map = L.map(container, { scrollWheelZoom: true, zoomControl: true });
        const streetLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OSM', maxZoom: 19 });
        const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { attribution: '&copy; Esri', maxZoom: 19 });
        streetLayer.addTo(_map);
        L.control.layers({ 'Street': streetLayer, 'Satellite': satelliteLayer }, null, { position: 'topright', collapsed: true }).addTo(_map);
        renderMap();
    }

    async function renderMap() {
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
        tabsEl.innerHTML = '<button class="bus-tab all-tab' + (_activeMapBus === 'all' ? ' active' : '') + '" onclick="CampistryGo.selectMapBus(\'all\')">All Buses</button>' +
            uniqueBuses.map(b => '<button class="bus-tab' + (_activeMapBus === b.busId ? ' active' : '') + '" onclick="CampistryGo.selectMapBus(\'' + b.busId + '\')"><span class="bus-tab-dot" style="background:' + esc(b.busColor) + '"></span>' + esc(b.busName) + '</button>').join('') +
            '<button class="bus-tab' + (_showAddressPins ? ' active' : '') + '" onclick="CampistryGo.toggleAddressPins()" style="margin-left:auto;' + (_showAddressPins ? 'background:var(--blue-50);border-color:var(--blue-300);' : '') + '">📍 Addresses</button>';

        _mapLayers.forEach(l => _map.removeLayer(l)); _mapLayers = [];
        const allLatLngs = [];

        if (_campCoordsCache) {
            const campIcon = L.divIcon({ html: '<div style="width:32px;height:32px;background:#1e293b;border:3px solid #fff;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,.4);"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></div>', className: '', iconSize: [32, 32], iconAnchor: [16, 16] });
            const campMarker = L.marker([_campCoordsCache.lat, _campCoordsCache.lng], { icon: campIcon, zIndexOffset: 1000 }).addTo(_map);
            campMarker.bindPopup('<strong>' + esc(D.setup.campName || 'Camp') + '</strong><br>' + esc(D.setup.campAddress));
            _mapLayers.push(campMarker); allLatLngs.push([_campCoordsCache.lat, _campCoordsCache.lng]);
        }

        const visibleRoutes = _activeMapBus === 'all' ? allRoutes : allRoutes.filter(r => r.busId === _activeMapBus);
        function getDash(shiftIdx) { if (totalShifts <= 1 || !multiShift) return null; if (shiftIdx === 0) return null; if (shiftIdx === 1) return '18, 12'; return '6, 10'; }

        for (const route of visibleRoutes) {
            const stopsWithCoords = route.stops.filter(s => s.lat && s.lng);
            if (!stopsWithCoords.length) continue;
            const isArrival = D.activeMode === 'arrival';
            const needsReturn = !isArrival && D.shifts.length > 1;
            const straightCoords = [];
            if (!isArrival && _campCoordsCache) straightCoords.push([_campCoordsCache.lat, _campCoordsCache.lng]);
            stopsWithCoords.forEach(s => straightCoords.push([s.lat, s.lng]));
            if (isArrival && _campCoordsCache) straightCoords.push([_campCoordsCache.lat, _campCoordsCache.lng]);
            if (needsReturn && _campCoordsCache) straightCoords.push([_campCoordsCache.lat, _campCoordsCache.lng]);
            allLatLngs.push(...straightCoords);

            const dashPattern = getDash(route.shiftIdx);
            const lineWeight = _activeMapBus === 'all' ? 3 : 5;
            const lineOpacity = _activeMapBus === 'all' ? 0.7 : 0.9;
            const cacheKey = route.busId + '_' + route.shiftIdx;
            let roadCoords = _routeGeomCache[cacheKey];

            if (roadCoords) {
                const polyline = L.polyline(roadCoords, { color: route.busColor, weight: lineWeight, opacity: lineOpacity, dashArray: dashPattern }).addTo(_map);
                polyline._goRouteKey = cacheKey; _mapLayers.push(polyline);
                const arrows = addArrowsToLine(roadCoords, route.busColor, _map);
                arrows.forEach(a => { a._goRouteKey = cacheKey; _mapLayers.push(a); });
            } else {
                const tempLine = L.polyline(straightCoords, { color: route.busColor, weight: lineWeight, opacity: lineOpacity * 0.4, dashArray: dashPattern }).addTo(_map);
                tempLine._goRouteKey = cacheKey; _mapLayers.push(tempLine);

                if (straightCoords.length >= 2) {
                    const mbToken = D.setup.mapboxToken || '';
                    const wp = [];
                    if (!isArrival && _campCoordsCache) wp.push(_campCoordsCache.lng + ',' + _campCoordsCache.lat);
                    stopsWithCoords.forEach(s => wp.push(s.lng + ',' + s.lat));
                    if (isArrival && _campCoordsCache) wp.push(_campCoordsCache.lng + ',' + _campCoordsCache.lat);
                    if (needsReturn && _campCoordsCache) wp.push(_campCoordsCache.lng + ',' + _campCoordsCache.lat);
                    (async function(coordStr, color, ck, temp, dash, w, o) {
                        try {
                            const url = mbToken ? 'https://api.mapbox.com/directions/v5/mapbox/driving/' + coordStr + '?overview=full&geometries=geojson&access_token=' + mbToken : 'https://router.project-osrm.org/route/v1/driving/' + coordStr + '?overview=full&geometries=geojson&continue_straight=true';
                            const resp = await fetch(url); if (resp.ok) { const data = await resp.json(); const coords = data.routes?.[0]?.geometry?.coordinates; if (coords) { const pts = coords.map(c => [c[1], c[0]]); if (pts.length > 0 && _map) { _routeGeomCache[ck] = pts; _map.removeLayer(temp); const idx = _mapLayers.indexOf(temp); if (idx >= 0) _mapLayers.splice(idx, 1); const road = L.polyline(pts, { color, weight: w, opacity: o, dashArray: dash }).addTo(_map); road._goRouteKey = ck; _mapLayers.push(road); const arrows = addArrowsToLine(pts, color, _map); arrows.forEach(a => { a._goRouteKey = ck; _mapLayers.push(a); }); } } }
                        } catch (e) { console.warn('[Go] Road geometry failed:', e.message); }
                    })(wp.join(';'), route.busColor, cacheKey, tempLine, dashPattern, lineWeight, lineOpacity);
                }
            }

            stopsWithCoords.forEach(stop => {
                const isSpecial = stop.isMonitor || stop.isCounselor;
                const size = isSpecial ? 20 : 26;
                const icon = L.divIcon({ html: '<div class="stop-marker-icon" style="width:' + size + 'px;height:' + size + 'px;background:' + esc(route.busColor) + ';' + (isSpecial ? 'font-size:10px;' : '') + '">' + (isSpecial ? (stop.isMonitor ? 'M' : 'C') : stop.stopNum) + '</div>', className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
                const names = stop.isMonitor ? '🛡️ ' + (stop.monitorName || 'Monitor') : stop.isCounselor ? '👤 ' + (stop.counselorName || 'Counselor') : stop.campers.map(c => c.name).join('<br>');
                const popup = '<div style="font-family:DM Sans,sans-serif;min-width:160px;"><div style="font-weight:700;color:' + route.busColor + '">' + esc(route.busName) + ' — ' + esc(route.shiftLabel) + '</div><div style="font-weight:600;">Stop ' + stop.stopNum + '</div><div style="font-size:12px;">' + names + '</div><div style="font-size:11px;color:#888;">' + esc(stop.address) + '</div>' + (stop.estimatedTime ? '<div style="font-weight:600;">Est: ' + stop.estimatedTime + '</div>' : '') + '</div>';
                const marker = L.marker([stop.lat, stop.lng], { icon, draggable: !isSpecial }).addTo(_map);
                marker.bindPopup(popup);
                (function(theStop, theBusId, theShiftIdx) { marker.on('click', function(e) { if (window._mapEditorStopClick && window._mapEditorStopClick(theStop, theBusId, theShiftIdx)) marker.closePopup(); }); })(stop, route.busId, route.shiftIdx);
                _mapLayers.push(marker);
            });
        }

        if (allLatLngs.length > 0) _map.fitBounds(L.latLngBounds(allLatLngs), { padding: [50, 50], maxZoom: 14 });

        const legendEl = document.getElementById('mapLegend');
        if (legendEl) {
            if (multiShift) { legendEl.innerHTML = shiftIndices.map(si => { const sr = _generatedRoutes[si]; const d = getDash(si); const svgLine = !d ? '<line x1="0" y1="6" x2="40" y2="6" stroke="#555" stroke-width="3"/>' : d.startsWith('18') ? '<line x1="0" y1="6" x2="40" y2="6" stroke="#555" stroke-width="3" stroke-dasharray="9,6"/>' : '<line x1="0" y1="6" x2="40" y2="6" stroke="#555" stroke-width="3" stroke-dasharray="3,5"/>'; return '<span style="display:inline-flex;align-items:center;gap:.375rem;font-size:.75rem;"><svg width="40" height="12">' + svgLine + '</svg>' + esc(sr.shift.label || 'Shift ' + (si + 1)) + '</span>'; }).join('<span style="margin:0 .5rem;color:var(--border-medium);">|</span>'); legendEl.style.display = ''; }
            else legendEl.style.display = 'none';
        }
        if (_showAddressPins) renderAddressPins();
    }

    function selectMapBus(busId) { _activeMapBus = busId; renderMap(); renderFilteredMasterList(); }
    function toggleMapShift(idx) { if (_activeShifts.has(idx)) { if (_activeShifts.size > 1) _activeShifts.delete(idx); } else _activeShifts.add(idx); renderMap(); renderFilteredMasterList(); }
    function setMapShiftsAll() { _activeShifts = new Set(_generatedRoutes.map((_, i) => i)); renderMap(); renderFilteredMasterList(); }
    function toggleMapFullscreen() { const card = document.getElementById('routeMapCard'); if (!card) return; card.classList.toggle('map-fullscreen'); setTimeout(() => { if (_map) _map.invalidateSize(); }, 100); }

    // =========================================================================
    // ADDRESS PINS
    // =========================================================================
    function toggleAddressPins() { _showAddressPins = !_showAddressPins; if (_showAddressPins) renderAddressPins(); else clearAddressPins(); if (_generatedRoutes) renderMap(); else if (_showAddressPins) renderAddressPinsAll(); }
    function clearAddressPins() { _addressPinLayers.forEach(l => { if (_map) _map.removeLayer(l); }); _addressPinLayers = []; }
    function renderAddressPins() {
        if (!_map) return; clearAddressPins();
        const roster = getRoster(); const shiftIndices = [..._activeShifts].sort();
        const camperPins = [];
        if (_generatedRoutes) {
            shiftIndices.forEach(si => { const sr = _generatedRoutes[si]; if (!sr) return; sr.routes.forEach(r => { if (_activeMapBus !== 'all' && r.busId !== _activeMapBus) return; r.stops.forEach(st => { if (st.isMonitor || st.isCounselor) return; st.campers.forEach(c => { const a = D.addresses[c.name]; if (!a?.geocoded || !a.lat || !a.lng) return; camperPins.push({ name: c.name, lat: a.lat, lng: a.lng, address: [a.street, a.city, a.state, a.zip].filter(Boolean).join(', '), color: r.busColor, busName: r.busName, division: c.division || '', bunk: c.bunk || '' }); }); }); }); });
        } else { renderAddressPinsAll(); return; }
        camperPins.forEach(pin => {
            const icon = L.divIcon({ html: '<div style="width:10px;height:10px;background:' + esc(pin.color) + ';border:2px solid #fff;border-radius:50%;box-shadow:0 1px 3px rgba(0,0,0,.4);"></div>', className: '', iconSize: [10, 10], iconAnchor: [5, 5] });
            const marker = L.marker([pin.lat, pin.lng], { icon, zIndexOffset: -100 }).addTo(_map);
            marker.bindPopup('<div style="font-family:DM Sans,sans-serif;min-width:150px;"><div style="font-weight:700;">' + esc(pin.name) + '</div><div style="font-size:12px;color:#666;">' + esc(pin.division) + (pin.bunk ? ' / Bunk ' + esc(pin.bunk) : '') + '</div><div style="font-size:12px;margin-top:4px;">' + esc(pin.address) + '</div><div style="font-size:11px;margin-top:4px;display:flex;align-items:center;gap:4px;"><span style="width:8px;height:8px;border-radius:50%;background:' + esc(pin.color) + ';display:inline-block;"></span><span style="font-weight:600;">' + esc(pin.busName) + '</span></div></div>');
            _addressPinLayers.push(marker);
        });
        console.log('[Go] Address pins: ' + camperPins.length + ' campers' + (_activeMapBus !== 'all' ? ' (filtered)' : ''));
    }
    function renderAddressPinsAll() {
        if (!_map) return; clearAddressPins();
        const roster = getRoster(); const allLatLngs = [];
        Object.entries(roster).forEach(([name, c]) => { const a = D.addresses[name]; if (!a?.geocoded || !a.lat || !a.lng) return; if (a.transport === 'pickup') return; const icon = L.divIcon({ html: '<div style="width:8px;height:8px;background:#3b82f6;border:2px solid #fff;border-radius:50%;box-shadow:0 1px 3px rgba(0,0,0,.3);"></div>', className: '', iconSize: [8, 8], iconAnchor: [4, 4] }); const marker = L.marker([a.lat, a.lng], { icon, zIndexOffset: -100 }).addTo(_map); marker.bindPopup('<div style="font-family:DM Sans,sans-serif;"><div style="font-weight:700;">' + esc(name) + '</div><div style="font-size:12px;color:#666;">' + esc(c.division || '') + (c.bunk ? ' / Bunk ' + esc(c.bunk) : '') + '</div><div style="font-size:12px;margin-top:4px;">' + esc([a.street, a.city, a.state, a.zip].filter(Boolean).join(', ')) + '</div></div>'); _addressPinLayers.push(marker); allLatLngs.push([a.lat, a.lng]); });
        if (allLatLngs.length > 0 && !_generatedRoutes) _map.fitBounds(L.latLngBounds(allLatLngs), { padding: [50, 50], maxZoom: 14 });
        console.log('[Go] Address pins: ' + _addressPinLayers.length + ' campers (all)');
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
    function zoomToStop(lat, lng, busId, shiftIdx) { if (!_map || !lat || !lng) return; _activeShifts = new Set([shiftIdx]); _activeMapBus = busId; renderMap(); _map.setView([lat, lng], 16); const sr = document.getElementById('camperSearchResults'); if (sr) sr.style.display = 'none'; }

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
            if (t === 'fleet') renderFleet(); else if (t === 'shifts') renderShifts(); else if (t === 'staff') renderStaff(); else if (t === 'addresses') renderAddresses(); else if (t === 'preflight') runPreflight(); else if (t === 'routes') {
                runPreflight(); renderDailyOverrides(); renderCarpool();
                if (_pendingMapInit) { setTimeout(function() { initMap(_pendingMapInit); _pendingMapInit = null; }, 150); }
                else { setTimeout(function() { if (_map) _map.invalidateSize(); }, 150); }
            }
        }));
        document.getElementById('addressSearch')?.addEventListener('input', () => { clearTimeout(_addrSearchTimer); _addrSearchTimer = setTimeout(renderAddresses, 200); });
    }
    let _addrSearchTimer;

    function init() {
        console.log('[Go] Initializing v3.1 (VROOM + Manhattan walk)...');
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
    // PUBLIC API
    // =========================================================================
    window.CampistryGo = {
        saveSetup, testApiKey,
        openBusModal, saveBus, editBus, deleteBus, _pickColor,
        addShift, deleteShift, toggleShiftDiv, updateShiftTime, renameShift,
        toggleShiftGrade, setShiftGradeMode, toggleShiftBus, setAllShiftBuses,
        openMonitorModal, saveMonitor, editMonitor, deleteMonitor,
        openCounselorModal, saveCounselor, editCounselor, deleteCounselor,
        editAddress, saveAddress, geocodeAll, downloadAddressTemplate, importAddressCsv,
        regeocodeAll: function() { geocodeAll(true); },
        testGeocode, systemCheck,
        generateRoutes, reOptimizeBus, exportRoutesCsv, printRoutes, detectRegions,
        renderMap, selectMapBus, toggleMapShift, setMapShiftsAll, toggleMapFullscreen,
        toggleAddressPins, showAddressesOnMap,
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
