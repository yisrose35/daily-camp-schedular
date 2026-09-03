// =============================================================================
// campistry_go_neighborhoods.js — 3-tier routing: Region → Neighborhood → Segment
//
// Replaces the 2-tier (ZIP → Zone) pipeline with an OSM-road-graph-derived
// Neighborhood layer that persists across runs. Segments (road between two
// intersections) are the planning primitive; homes attach to segments.
//
// Public API:
//   window.CampistryGoNeighborhoods.buildNeighborhoods({campers, options})
//     campers: [{name, lat, lng, address, division?, bunk?, zip?, ...}]
//     options: {
//       verbose        : bool   // log stats
//       trunkClasses   : [...]  // override what counts as trunk (default inferred)
//       bboxBuffer     : deg    // default 0.008
//       deadEndThreshold: 0..1  // default 0.30
//     }
//   Returns: {
//     regions       : [{id, zip, centroid, neighborhoodIds:[]}]
//     neighborhoods : [{id, regionId, mode, primaryName, segmentIds:[], camperCount, entryNodeId}]
//     segments      : [{id, neighborhoodId, fromNodeId, toNodeId, name, hwClass, homes:[]}]
//     nodes         : {id -> {id, lat, lng, streets:[...]}}
//     homes         : [{camperName, segmentId, lat, lng, houseNum, address}]
//     stats         : {...}
//   }
//
//   window.CampistryGoNeighborhoods.packIntoBuses({result, buses, siblings?, priorAssignments?})
//     Assigns neighborhoods to buses respecting capacity + siblings.
//     Returns: [{busId, neighborhoodIds:[], segmentIds:[], homes:[], camperCount}]
//
//   window.CampistryGoNeighborhoods.expandToPhysicalStops({assignment, result, isArrival})
//     Expands each bus assignment into per-home physical drops in spine order.
//     Returns: [{busId, stops:[{lat, lng, address, campers}], segmentOrder:[...]}]
//
// Standalone: no runtime dependency on campistry_go.js IIFE. Shares the same
// stop shape as createHouseStops() so the downstream Google optimizer can
// consume the output directly.
// =============================================================================

window.CampistryGoNeighborhoods = (function () {
    'use strict';

    // -------------------------------------------------------------------------
    // Geometry helpers (self-contained; mirror campistry_go.js)
    // -------------------------------------------------------------------------
    function haversineMi(lat1, lng1, lat2, lng2) {
        const R = 3959;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLng = (lng2 - lng1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    // Perpendicular distance (miles) from point P to segment A-B, plus the
    // snapped point and the parameter t in [0,1] along the segment.
    function pointToSegment(pLat, pLng, aLat, aLng, bLat, bLng) {
        // Project in a local equirectangular frame (fine for <10mi segments)
        const mLat = (aLat + bLat + pLat) / 3;
        const kx = Math.cos(mLat * Math.PI / 180);
        const ax = aLng * kx, ay = aLat;
        const bx = bLng * kx, by = bLat;
        const px = pLng * kx, py = pLat;
        const dx = bx - ax, dy = by - ay;
        const lenSq = dx * dx + dy * dy;
        let t = lenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
        t = Math.max(0, Math.min(1, t));
        const sx = ax + t * dx, sy = ay + t * dy;
        const snapLat = sy, snapLng = sx / kx;
        return { dist: haversineMi(pLat, pLng, snapLat, snapLng), snapLat, snapLng, t };
    }

    // Two djb2 passes with different seeds → 64-bit-effective, collision-resistant
    // at our scale (10k+ segments, 10k+ communities). Stable across runs.
    function hash(s) {
        let h1 = 5381, h2 = 52711;
        for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i);
            h1 = ((h1 << 5) + h1 + c) >>> 0;
            h2 = ((h2 << 5) + h2 ^ c) >>> 0;
        }
        return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
    }

    function parseHouseNum(address) {
        if (!address) return 0;
        const m = address.match(/^\s*(\d+)/);
        return m ? parseInt(m[1], 10) : 0;
    }

    // -------------------------------------------------------------------------
    // Road class tiers. Edges of class ≤ trunkTier are "trunks" and are the
    // natural boundaries between neighborhoods. Remaining edges form the
    // interior graph whose connected components are the neighborhoods.
    // -------------------------------------------------------------------------
    const HW_CLASS_RANK = {
        motorway: 1, trunk: 2, primary: 3, secondary: 4,
        tertiary: 5, unclassified: 6, residential: 7, living_street: 8
    };

    function classRank(cls) { return HW_CLASS_RANK[cls] || 99; }

    // -------------------------------------------------------------------------
    // Persistent road-graph cache. Overpass mirrors flake (502, CORS, rate
    // limits) often enough that a single failed run wipes out neighborhood
    // mode. Cache successful responses by bbox + TTL so the next run can
    // reuse them even if Overpass is currently down.
    //
    // Key: rounded bbox to 0.01° (~0.7mi) — small bbox shifts (a camper
    // moves a block) reuse the same cache. TTL 30 days, since road graphs
    // are stable.
    // -------------------------------------------------------------------------
    const ROAD_GRAPH_CACHE_KEY = 'campistry_go_roadgraph_v1';
    const ROAD_GRAPH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

    function _bboxCacheKey(minLat, minLng, maxLat, maxLng) {
        const r = (n) => Math.round(n * 100) / 100;
        return r(minLat) + ',' + r(minLng) + ',' + r(maxLat) + ',' + r(maxLng);
    }
    function _loadRoadGraphCache(key) {
        try {
            const raw = localStorage.getItem(ROAD_GRAPH_CACHE_KEY);
            if (!raw) return null;
            const cache = JSON.parse(raw);
            const entry = cache[key];
            if (!entry) return null;
            if (Date.now() - entry.savedAt > ROAD_GRAPH_TTL_MS) return null;
            return entry.data;
        } catch (_) { return null; }
    }
    function _saveRoadGraphCache(key, data) {
        try {
            // Roll the whole cache: drop expired entries on every save so the
            // file doesn't balloon.
            let cache = {};
            try {
                const raw = localStorage.getItem(ROAD_GRAPH_CACHE_KEY);
                if (raw) cache = JSON.parse(raw) || {};
            } catch (_) { cache = {}; }
            const now = Date.now();
            for (const k of Object.keys(cache)) {
                if (now - (cache[k]?.savedAt || 0) > ROAD_GRAPH_TTL_MS) delete cache[k];
            }
            cache[key] = { savedAt: now, data: data };
            localStorage.setItem(ROAD_GRAPH_CACHE_KEY, JSON.stringify(cache));
            return true;
        } catch (e) {
            // Quota exceeded: drop other entries and keep just this one.
            try {
                const fallback = {};
                fallback[key] = { savedAt: Date.now(), data: data };
                localStorage.setItem(ROAD_GRAPH_CACHE_KEY, JSON.stringify(fallback));
                return true;
            } catch (_) { return false; }
        }
    }

    // -------------------------------------------------------------------------
    // Overpass fetch — road graph for the bbox of all campers.
    // Reuses the same mirror + timeout strategy as campistry_go.js fetchIntersections().
    // -------------------------------------------------------------------------
    async function fetchRoadGraph(campers, options) {
        // Sandbox: no Overpass/OSM network call — the router falls back to its
        // haversine road-distance approximation, no road graph fetched.
        if (window.CampistryGoSandbox && window.CampistryGoSandbox.isSandbox()) return null;
        const lats = campers.map(c => c.lat).filter(Number.isFinite).sort((a, b) => a - b);
        const lngs = campers.map(c => c.lng).filter(Number.isFinite).sort((a, b) => a - b);
        if (lats.length < 4 || lngs.length < 4) return null;

        // IQR outlier trim
        const q1Lat = lats[Math.floor(lats.length * 0.25)];
        const q3Lat = lats[Math.floor(lats.length * 0.75)];
        const q1Lng = lngs[Math.floor(lngs.length * 0.25)];
        const q3Lng = lngs[Math.floor(lngs.length * 0.75)];
        const iqrLat = q3Lat - q1Lat, iqrLng = q3Lng - q1Lng;
        const cleanLats = lats.filter(v => v >= q1Lat - 1.5 * iqrLat && v <= q3Lat + 1.5 * iqrLat);
        const cleanLngs = lngs.filter(v => v >= q1Lng - 1.5 * iqrLng && v <= q3Lng + 1.5 * iqrLng);
        if (cleanLats.length < 2 || cleanLngs.length < 2) return null;

        const buf = options.bboxBuffer ?? 0.008;
        const minLat = cleanLats[0] - buf, maxLat = cleanLats[cleanLats.length - 1] + buf;
        const minLng = cleanLngs[0] - buf, maxLng = cleanLngs[cleanLngs.length - 1] + buf;
        const area = (maxLat - minLat) * (maxLng - minLng);
        if (area > 1.0) {
            console.warn('[Go-NH] bbox too large (' + area.toFixed(3) + ' deg²); aborting road-graph fetch');
            return null;
        }
        const bbox = minLat + ',' + minLng + ',' + maxLat + ',' + maxLng;
        const cacheKey = _bboxCacheKey(minLat, minLng, maxLat, maxLng);

        // 1. Try persistent cache first. Road graphs barely change month to
        //    month, so a 30-day-old cached graph is fine. This makes the
        //    pipeline survive Overpass outages — once cached, neighborhood
        //    mode keeps working even when the API is down.
        const cached = _loadRoadGraphCache(cacheKey);
        if (cached) {
            console.log('[Go-NH] Road graph: using cached copy (' +
                (cached.elements?.length || 0) + ' elements, bbox ' + cacheKey + ')');
            return cached;
        }

        const query = '[out:json][timeout:25];' +
            'way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street)$"](' + bbox + ');' +
            'out body;>;out skel qt;';

        // 2. Try the Supabase edge proxy (dodges browser CORS + retries mirrors
        //    server-side). Cache and return on success.
        const data = await fetchOverpassViaProxy(query, options);
        if (data) {
            _saveRoadGraphCache(cacheKey, data);
            return data;
        }

        // 3. Fall through to direct mirrors. Cache on first success.
        const endpoints = [
            'https://overpass-api.de/api/interpreter',
            'https://overpass.kumi.systems/api/interpreter',
            'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
        ];
        for (const url of endpoints) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 20000);
                const resp = await fetch(url + '?data=' + encodeURIComponent(query), { signal: controller.signal });
                clearTimeout(timeoutId);
                if (!resp.ok) continue;
                const direct = await resp.json();
                if (options.verbose) console.log('[Go-NH] Overpass (direct): ' + (direct.elements?.length || 0) + ' elements from ' + url);
                _saveRoadGraphCache(cacheKey, direct);
                return direct;
            } catch (e) {
                if (options.verbose) console.warn('[Go-NH] Overpass error at ' + url + ':', e.message);
            }
        }
        console.warn('[Go-NH] All Overpass routes failed (proxy + direct) and no cache available — neighborhood mode unavailable this run');
        return null;
    }

    async function fetchOverpassViaProxy(query, options) {
        const cfg = window.__CAMPISTRY_SUPABASE__;
        if (!cfg?.url || !cfg?.anonKey) return null;
        let token = '';
        try {
            const sess = await window.supabase?.auth?.getSession?.();
            token = sess?.data?.session?.access_token || '';
        } catch (_) { /* ignore */ }
        if (!token) return null;
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 50000);
            const resp = await fetch(cfg.url + '/functions/v1/overpass-proxy', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer ' + token,
                    'apikey': cfg.anonKey,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ query: query }),
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (!resp.ok) {
                if (options.verbose) console.warn('[Go-NH] Overpass proxy HTTP ' + resp.status);
                return null;
            }
            const data = await resp.json();
            if (options.verbose) {
                const mirror = resp.headers.get('X-Overpass-Mirror') || '(unknown)';
                console.log('[Go-NH] Overpass (proxy): ' + (data.elements?.length || 0) + ' elements via ' + mirror);
            }
            return data;
        } catch (e) {
            if (options.verbose) console.warn('[Go-NH] Overpass proxy error:', e.message);
            return null;
        }
    }

    // -------------------------------------------------------------------------
    // Build a graph from raw Overpass output.
    //   nodes: id -> {id, lat, lng, streets:Set, wayIds:Set}
    //   edges: list of {id, fromNodeId, toNodeId, wayId, hwClass, name, lenMi}
    //
    // Each OSM way is broken at every node that is shared with another way —
    // so "segment" = one stretch of road between two intersections.
    // -------------------------------------------------------------------------
    function buildGraph(overpassData) {
        const rawNodes = {};
        const ways = [];

        for (const el of overpassData.elements) {
            if (el.type === 'node' && el.lat != null && el.lon != null) {
                rawNodes[el.id] = { id: el.id, lat: el.lat, lng: el.lon, streets: new Set(), wayIds: new Set() };
            } else if (el.type === 'way' && el.nodes?.length >= 2 && el.tags?.highway) {
                ways.push(el);
            }
        }

        // Count how many ways reference each node → nodes with count ≥ 2 are intersections
        const nodeRefCount = {};
        for (const w of ways) {
            for (const nid of w.nodes) nodeRefCount[nid] = (nodeRefCount[nid] || 0) + 1;
            if (w.tags?.name) {
                for (const nid of w.nodes) {
                    if (rawNodes[nid]) rawNodes[nid].streets.add(w.tags.name);
                }
            }
        }

        // Build edges by splitting ways at intersections AND at endpoints
        const edges = [];
        const usedNodeIds = new Set();
        for (const w of ways) {
            const hwClass = w.tags.highway;
            const name = w.tags.name || '';
            const wayId = w.id;
            const n = w.nodes;

            // Find split points: index i such that n[i] is an intersection OR the endpoint
            const splits = [0];
            for (let i = 1; i < n.length - 1; i++) {
                if (nodeRefCount[n[i]] >= 2) splits.push(i);
            }
            splits.push(n.length - 1);

            for (let s = 0; s < splits.length - 1; s++) {
                const i0 = splits[s], i1 = splits[s + 1];
                const fromId = n[i0], toId = n[i1];
                if (!rawNodes[fromId] || !rawNodes[toId] || fromId === toId) continue;
                usedNodeIds.add(fromId); usedNodeIds.add(toId);
                rawNodes[fromId].wayIds.add(wayId);
                rawNodes[toId].wayIds.add(wayId);

                // Length = sum of sub-segment haversines along intermediate nodes
                let lenMi = 0;
                for (let i = i0; i < i1; i++) {
                    const a = rawNodes[n[i]], b = rawNodes[n[i + 1]];
                    if (a && b) lenMi += haversineMi(a.lat, a.lng, b.lat, b.lng);
                }

                // Stable segment ID: wayId + sorted endpoint node IDs
                const [lo, hi] = fromId < toId ? [fromId, toId] : [toId, fromId];
                const segId = 'seg_' + hash(wayId + ':' + lo + ':' + hi);

                edges.push({
                    id: segId,
                    fromNodeId: fromId, toNodeId: toId,
                    wayId, hwClass, name, lenMi,
                    rank: classRank(hwClass),
                });
            }
        }

        // Keep only nodes that actually participate in an edge
        const nodes = {};
        for (const id of usedNodeIds) {
            const n = rawNodes[id];
            nodes[id] = {
                id: n.id, lat: n.lat, lng: n.lng,
                streets: [...n.streets],
                wayIds: [...n.wayIds],
                degree: 0,
            };
        }
        for (const e of edges) {
            if (nodes[e.fromNodeId]) nodes[e.fromNodeId].degree++;
            if (nodes[e.toNodeId]) nodes[e.toNodeId].degree++;
        }

        return { nodes, edges };
    }

    // -------------------------------------------------------------------------
    // Choose trunk tier. Everything with rank ≤ trunkTier is a "trunk" edge and
    // becomes a boundary between neighborhoods. Remaining edges (interior) form
    // the subgraph whose connected components are neighborhoods.
    //
    // Default: trunkTier = 4 (primary + secondary), meaning tertiary and below
    // are interior. Grid mode lifts trunk tier up to 3 (primary avenues only).
    // -------------------------------------------------------------------------
    function pickTrunkTier(graph, mode) {
        if (mode === 'grid') return 3;     // only primary avenues separate super-blocks
        return 4;                          // primary+secondary separate suburban pods
    }

    // Compute dead-end ratio for a set of node IDs. Dead-end = degree-1 node.
    function deadEndRatio(nodeIds, nodes) {
        if (nodeIds.length === 0) return 0;
        let dead = 0;
        for (const id of nodeIds) if (nodes[id]?.degree === 1) dead++;
        return dead / nodeIds.length;
    }

    // -------------------------------------------------------------------------
    // Connected components of the interior subgraph → neighborhoods.
    // -------------------------------------------------------------------------
    function findCommunities(graph, trunkTier) {
        const { nodes, edges } = graph;

        // Adjacency for interior edges only (hwClass rank > trunkTier).
        // NOTE: stringify node IDs so the `to` field matches what Object.keys(adj)
        // yields. Otherwise `seen` gets populated with numbers (from nb.to) but
        // checked with strings (from outer loop) → BFS restarts on already-
        // visited nodes, emitting duplicate components that share edges.
        const adj = {};
        const interiorEdges = [];
        for (const e of edges) {
            if (e.rank <= trunkTier) continue;
            interiorEdges.push(e);
            const fromKey = String(e.fromNodeId);
            const toKey = String(e.toNodeId);
            (adj[fromKey] ||= []).push({ to: toKey, edgeId: e.id });
            (adj[toKey] ||= []).push({ to: fromKey, edgeId: e.id });
        }

        // BFS over interior subgraph
        const seen = new Set();
        const components = [];
        for (const startId of Object.keys(adj)) {
            if (seen.has(startId)) continue;
            const comp = { nodeIds: [], edgeIds: new Set() };
            const stack = [startId];
            seen.add(startId);
            while (stack.length) {
                const cur = stack.pop();
                comp.nodeIds.push(cur);
                for (const nb of adj[cur] || []) {
                    comp.edgeIds.add(nb.edgeId);
                    if (!seen.has(nb.to)) { seen.add(nb.to); stack.push(nb.to); }
                }
            }
            components.push(comp);
        }
        return components;
    }

    // -------------------------------------------------------------------------
    // Detect neighborhoods with dual suburban/grid mode.
    //   1. Run community detection with trunkTier=4 (default suburban setting)
    //   2. Compute global dead-end ratio. If low (<0.15) → the area is grid-like;
    //      re-run with trunkTier=3 to get super-blocks between primary avenues.
    //   3. Per-component mode is assigned based on its own dead-end ratio.
    // -------------------------------------------------------------------------
    function detectNeighborhoods(graph, options) {
        const threshold = options.deadEndThreshold ?? 0.30;

        // Global mode probe — does the area look grid-like overall?
        const allInteriorNodeIds = Object.keys(graph.nodes);
        const globalDeadEnd = deadEndRatio(allInteriorNodeIds, graph.nodes);
        const globalMode = globalDeadEnd < 0.15 ? 'grid' : 'suburban';

        const trunkTier = pickTrunkTier(graph, globalMode);
        const components = findCommunities(graph, trunkTier);

        if (options.verbose) {
            console.log('[Go-NH] Global dead-end ratio: ' + globalDeadEnd.toFixed(2) + ' → ' + globalMode + ' mode, trunkTier=' + trunkTier);
            console.log('[Go-NH] ' + components.length + ' communities detected');
        }

        return components.map((comp, idx) => {
            const der = deadEndRatio(comp.nodeIds, graph.nodes);
            const mode = der >= threshold ? 'suburban' : 'grid';

            // Neighborhood "primary name" = most common street among its edges
            const nameCounts = {};
            for (const eid of comp.edgeIds) {
                const e = graph.edges.find(x => x.id === eid);
                if (e?.name) nameCounts[e.name] = (nameCounts[e.name] || 0) + 1;
            }
            const primaryName = Object.entries(nameCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unnamed';

            // Content-addressed ID: sorted segment IDs in the community
            const sortedSegIds = [...comp.edgeIds].sort();
            const nhId = 'nh_' + hash(sortedSegIds.join('|'));

            return {
                id: nhId,
                index: idx,
                mode,
                deadEndRatio: der,
                primaryName,
                nodeIds: comp.nodeIds,
                segmentIds: sortedSegIds,
                trunkTier,
            };
        });
    }

    // -------------------------------------------------------------------------
    // Attach each camper to the nearest segment (by perpendicular distance).
    // -------------------------------------------------------------------------
    function attachCampersToSegments(campers, graph, neighborhoods) {
        // Map segId → neighborhood for quick lookup
        const segToNh = {};
        for (const nh of neighborhoods) for (const sid of nh.segmentIds) segToNh[sid] = nh.id;

        // Bucket edges into a coarse lat/lng grid (0.01 deg ~ 0.7mi cells) for fast lookup
        const cellSize = 0.01;
        const cells = {};
        const edgeById = {};
        for (const e of graph.edges) {
            edgeById[e.id] = e;
            const a = graph.nodes[e.fromNodeId], b = graph.nodes[e.toNodeId];
            if (!a || !b) continue;
            const minLat = Math.min(a.lat, b.lat), maxLat = Math.max(a.lat, b.lat);
            const minLng = Math.min(a.lng, b.lng), maxLng = Math.max(a.lng, b.lng);
            for (let lat = Math.floor(minLat / cellSize); lat <= Math.floor(maxLat / cellSize); lat++) {
                for (let lng = Math.floor(minLng / cellSize); lng <= Math.floor(maxLng / cellSize); lng++) {
                    const key = lat + ',' + lng;
                    (cells[key] ||= []).push(e.id);
                }
            }
        }

        const homes = [];
        const segmentHomes = {}; // segId -> [homes]
        const unattachedCampers = [];
        const seenCamperNames = new Set();

        for (const c of campers) {
            if (!Number.isFinite(c.lat) || !Number.isFinite(c.lng)) { unattachedCampers.push(c); continue; }
            if (seenCamperNames.has(c.name)) continue; // defensive: each name at most once
            seenCamperNames.add(c.name);

            // Search expanding rings of cells
            let bestEdge = null, bestDist = Infinity, bestSnap = null;
            const cellLat = Math.floor(c.lat / cellSize), cellLng = Math.floor(c.lng / cellSize);
            const seenEdges = new Set();
            for (let ring = 0; ring <= 4; ring++) {
                for (let dLat = -ring; dLat <= ring; dLat++) {
                    for (let dLng = -ring; dLng <= ring; dLng++) {
                        if (ring > 0 && Math.abs(dLat) !== ring && Math.abs(dLng) !== ring) continue;
                        const key = (cellLat + dLat) + ',' + (cellLng + dLng);
                        const eids = cells[key];
                        if (!eids) continue;
                        for (const eid of eids) {
                            if (seenEdges.has(eid)) continue;
                            seenEdges.add(eid);
                            const e = edgeById[eid];
                            const a = graph.nodes[e.fromNodeId], b = graph.nodes[e.toNodeId];
                            if (!a || !b) continue;
                            const snap = pointToSegment(c.lat, c.lng, a.lat, a.lng, b.lat, b.lng);
                            // Prefer interior (non-trunk) edges with a small penalty on trunks
                            const effective = e.rank <= 4 ? snap.dist * 1.5 : snap.dist;
                            if (effective < bestDist) {
                                bestDist = effective;
                                bestEdge = e;
                                bestSnap = snap;
                            }
                        }
                    }
                }
                if (bestEdge && bestDist < 0.05) break; // found a close match (<0.05mi)
            }

            if (!bestEdge) { unattachedCampers.push(c); continue; }

            // If the closest edge is a trunk (motorway/trunk/primary/secondary),
            // it's not interior to any neighborhood — treat as unattached so
            // the caller's leftover-append picks the camper up.
            const nhForEdge = segToNh[bestEdge.id];
            if (!nhForEdge) { unattachedCampers.push(c); continue; }

            const home = {
                camperName: c.name,
                segmentId: bestEdge.id,
                neighborhoodId: nhForEdge,
                lat: c.lat, lng: c.lng,
                snapLat: bestSnap.snapLat, snapLng: bestSnap.snapLng,
                t: bestSnap.t,
                houseNum: parseHouseNum(c.address),
                address: c.address,
                division: c.division, bunk: c.bunk,
            };
            homes.push(home);
            (segmentHomes[bestEdge.id] ||= []).push(home);
        }

        return { homes, segmentHomes, unattachedCampers };
    }

    // -------------------------------------------------------------------------
    // Spine ordering — BFS inside a neighborhood from the entry intersection
    // (the node with the highest-class adjacent trunk edge). Returns segmentIds
    // in traversal order.
    // -------------------------------------------------------------------------
    function spineOrder(neighborhood, graph) {
        const segIds = new Set(neighborhood.segmentIds);
        const edgeById = {};
        for (const e of graph.edges) if (segIds.has(e.id)) edgeById[e.id] = e;

        // Adjacency restricted to this neighborhood.
        // Stringify node IDs (same reason as findCommunities) so queue/seenNodes
        // stay consistent.
        const adj = {};
        for (const e of Object.values(edgeById)) {
            const fromKey = String(e.fromNodeId);
            const toKey = String(e.toNodeId);
            (adj[fromKey] ||= []).push({ to: toKey, edgeId: e.id });
            (adj[toKey] ||= []).push({ to: fromKey, edgeId: e.id });
        }

        // Entry = node in this neighborhood with the best trunk edge touching it.
        // neighborhood.nodeIds are strings; graph edges carry numeric OSM ids —
        // compare via String().
        let entryId = null, bestTrunkRank = 99;
        for (const nid of neighborhood.nodeIds) {
            for (const e of graph.edges) {
                if (String(e.fromNodeId) !== nid && String(e.toNodeId) !== nid) continue;
                if (segIds.has(e.id)) continue; // interior edge, not a trunk
                if (e.rank < bestTrunkRank) { bestTrunkRank = e.rank; entryId = nid; }
            }
        }
        if (!entryId) entryId = neighborhood.nodeIds[0];

        // BFS from entry, emitting segments in order
        const orderedSegs = [];
        const seenSegs = new Set();
        const queue = [entryId];
        const seenNodes = new Set([entryId]);
        while (queue.length) {
            const cur = queue.shift();
            for (const nb of adj[cur] || []) {
                if (seenSegs.has(nb.edgeId)) continue;
                seenSegs.add(nb.edgeId);
                orderedSegs.push(nb.edgeId);
                if (!seenNodes.has(nb.to)) { seenNodes.add(nb.to); queue.push(nb.to); }
            }
        }

        return { entryNodeId: entryId, orderedSegmentIds: orderedSegs };
    }

    // -------------------------------------------------------------------------
    // buildNeighborhoods — public entrypoint (Phase 1 pipeline)
    // -------------------------------------------------------------------------
    async function buildNeighborhoods({ campers, options = {} }) {
        const verbose = options.verbose ?? false;
        const stats = { camperCount: campers.length };

        // 1. Fetch OSM road graph
        const overpass = await fetchRoadGraph(campers, options);
        if (!overpass) {
            console.warn('[Go-NH] Road-graph fetch failed; neighborhood detection unavailable');
            return null;
        }

        // 2. Build graph
        const graph = buildGraph(overpass);
        stats.nodeCount = Object.keys(graph.nodes).length;
        stats.edgeCount = graph.edges.length;
        if (verbose) console.log('[Go-NH] Graph: ' + stats.nodeCount + ' nodes, ' + stats.edgeCount + ' edges');

        // 3. Regions from ZIP (simple grouping; real slicing in Phase 3 integration)
        const regionMap = {};
        for (const c of campers) {
            const zip = (c.zip || '').toString().split('-')[0] || 'unknown';
            (regionMap[zip] ||= []).push(c);
        }
        const regions = Object.entries(regionMap).map(([zip, cs]) => ({
            id: 'reg_' + hash(zip),
            zip,
            centroid: {
                lat: cs.reduce((s, c) => s + (c.lat || 0), 0) / cs.length,
                lng: cs.reduce((s, c) => s + (c.lng || 0), 0) / cs.length,
            },
            camperCount: cs.length,
            neighborhoodIds: [], // filled below
        }));

        // 4. Community detection
        const nhRaw = detectNeighborhoods(graph, options);

        // 5. Attach campers → homes
        const { homes, segmentHomes, unattachedCampers } = attachCampersToSegments(campers, graph, nhRaw);

        // 5b. Sibling reconciliation — if campers with the same last name live
        // within 0.02mi of each other but snapped to different segments, move
        // them all to the segment that hosts the majority of the group. This
        // avoids accidentally splitting a family across buses in step 7.
        if (options.siblingGroups) {
            for (const group of Object.values(options.siblingGroups)) {
                if (!Array.isArray(group) || group.length < 2) continue;
                const groupHomes = group.map(n => homes.find(h => h.camperName === n)).filter(Boolean);
                if (groupHomes.length < 2) continue;
                const counts = {};
                for (const h of groupHomes) counts[h.segmentId] = (counts[h.segmentId] || 0) + 1;
                const [winnerSid] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
                if (Object.keys(counts).length === 1) continue;
                const target = groupHomes.find(h => h.segmentId === winnerSid);
                for (const h of groupHomes) {
                    if (h.segmentId === winnerSid) continue;
                    const src = segmentHomes[h.segmentId];
                    const idx = src.indexOf(h);
                    if (idx >= 0) src.splice(idx, 1);
                    h.segmentId = winnerSid;
                    h.neighborhoodId = target.neighborhoodId;
                    h.snapLat = target.snapLat; h.snapLng = target.snapLng; h.t = target.t;
                    (segmentHomes[winnerSid] ||= []).push(h);
                }
                if (verbose) console.log('[Go-NH] Sibling group reunited on segment ' + winnerSid + ': ' + group.join(', '));
            }
        }

        stats.homeCount = homes.length;
        stats.unattachedCount = unattachedCampers.length;
        if (verbose && unattachedCampers.length) {
            console.warn('[Go-NH] ' + unattachedCampers.length + ' campers could not be snapped to any segment');
        }

        // 6. Build final segment records (only keep segments with homes OR on spine routes)
        const segmentsById = {};
        for (const e of graph.edges) {
            segmentsById[e.id] = {
                id: e.id,
                neighborhoodId: null, // set below
                fromNodeId: e.fromNodeId,
                toNodeId: e.toNodeId,
                wayId: e.wayId,
                hwClass: e.hwClass,
                name: e.name,
                lenMi: e.lenMi,
                rank: e.rank,
                homes: segmentHomes[e.id] || [],
            };
        }

        // 7. Finalize neighborhoods with spine order + camper counts, discard empties
        const neighborhoods = [];
        for (const nh of nhRaw) {
            // Tag each segment with its neighborhood
            for (const sid of nh.segmentIds) {
                if (segmentsById[sid]) segmentsById[sid].neighborhoodId = nh.id;
            }
            const homesInNh = nh.segmentIds.reduce((n, sid) => n + (segmentHomes[sid]?.length || 0), 0);
            if (homesInNh === 0) continue; // skip empty neighborhoods (no campers)

            const { entryNodeId, orderedSegmentIds } = spineOrder(nh, graph);

            // Associate with a region by majority vote of home ZIPs
            const zipCounts = {};
            for (const sid of nh.segmentIds) {
                for (const h of (segmentHomes[sid] || [])) {
                    const c = campers.find(x => x.name === h.camperName);
                    const zip = (c?.zip || '').toString().split('-')[0] || 'unknown';
                    zipCounts[zip] = (zipCounts[zip] || 0) + 1;
                }
            }
            const bestZip = Object.entries(zipCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';
            const regionId = regions.find(r => r.zip === bestZip)?.id || regions[0].id;

            neighborhoods.push({
                id: nh.id,
                regionId,
                mode: nh.mode,
                deadEndRatio: nh.deadEndRatio,
                primaryName: nh.primaryName,
                entryNodeId,
                segmentIds: orderedSegmentIds.filter(sid => nh.segmentIds.includes(sid)),
                camperCount: homesInNh,
                nodeIds: nh.nodeIds,
            });

            const reg = regions.find(r => r.id === regionId);
            if (reg) reg.neighborhoodIds.push(nh.id);
        }

        // Audit: confirm camperCount sum matches actual home count BEFORE merge.
        {
            const pre = neighborhoods.reduce((s, n) => s + (n.camperCount || 0), 0);
            const segOwners = {};
            let segDupes = 0;
            for (const nh of neighborhoods) {
                for (const sid of nh.segmentIds) {
                    if (segOwners[sid] && segOwners[sid] !== nh.id) segDupes++;
                    segOwners[sid] = nh.id;
                }
            }
            console.log('[Go-NH] pre-merge audit: ' + neighborhoods.length + ' NHs, ' +
                pre + ' campers (expected ' + homes.length + '), ' + segDupes + ' cross-NH seg dupes');
        }

        // 8. Merge tiny neighborhoods into nearby larger ones. Community detection
        // cuts aggressively (each cul-de-sac becomes its own component), producing
        // 100s of 1-camper "neighborhoods" that are useless for routing. Absorb
        // any neighborhood below minSize into its geographically nearest neighbor
        // within maxDistMi. Repeat until stable.
        const minSize   = options.minNeighborhoodSize ?? 5;
        const maxMergeMi = options.maxMergeDistMi ?? 0.6;
        {
            const centroids = {};
            for (const nh of neighborhoods) {
                const nhHomes = homes.filter(h => h.neighborhoodId === nh.id);
                if (!nhHomes.length) continue;
                centroids[nh.id] = {
                    lat: nhHomes.reduce((s, h) => s + h.lat, 0) / nhHomes.length,
                    lng: nhHomes.reduce((s, h) => s + h.lng, 0) / nhHomes.length,
                };
            }
            let mergedCount = 0, pass = 0;
            const isolatedIds = new Set(); // tinies with no nearby neighbor — skip
            while (pass++ < 2000) {
                // Find the smallest still-mergeable neighborhood below minSize
                let target = null;
                for (const nh of neighborhoods) {
                    if (nh.camperCount >= minSize) continue;
                    if (isolatedIds.has(nh.id)) continue;
                    if (!target || nh.camperCount < target.camperCount) target = nh;
                }
                if (!target) break;

                const tc = centroids[target.id];
                if (!tc) {
                    const idx = neighborhoods.indexOf(target);
                    if (idx >= 0) neighborhoods.splice(idx, 1);
                    continue;
                }

                // Nearest other neighborhood within maxMergeMi
                let best = null, bestDist = Infinity;
                for (const other of neighborhoods) {
                    if (other.id === target.id) continue;
                    const oc = centroids[other.id];
                    if (!oc) continue;
                    const d = haversineMi(tc.lat, tc.lng, oc.lat, oc.lng);
                    if (d < bestDist) { bestDist = d; best = other; }
                }
                if (!best || bestDist > maxMergeMi) {
                    isolatedIds.add(target.id);
                    continue;
                }

                // Reassign segments & homes from target → best
                for (const sid of target.segmentIds) {
                    if (segmentsById[sid]) segmentsById[sid].neighborhoodId = best.id;
                }
                for (const h of homes) {
                    if (h.neighborhoodId === target.id) h.neighborhoodId = best.id;
                }
                // Concatenate spine orders. The merged NH may be disconnected
                // across a trunk edge — that's fine, within-bus NN ordering
                // in packIntoBuses reorders by geography anyway.
                const bestSegSet = new Set(best.segmentIds);
                for (const sid of target.segmentIds) {
                    if (!bestSegSet.has(sid)) best.segmentIds.push(sid);
                }
                const bestNodeSet = new Set(best.nodeIds);
                for (const nid of target.nodeIds) {
                    if (!bestNodeSet.has(nid)) best.nodeIds.push(nid);
                }

                // Update camper counts + centroid (weighted)
                const totalBefore = best.camperCount + target.camperCount;
                centroids[best.id] = {
                    lat: (centroids[best.id].lat * best.camperCount + tc.lat * target.camperCount) / totalBefore,
                    lng: (centroids[best.id].lng * best.camperCount + tc.lng * target.camperCount) / totalBefore,
                };
                best.camperCount = totalBefore;

                // Remove target
                const idx = neighborhoods.indexOf(target);
                if (idx >= 0) neighborhoods.splice(idx, 1);
                const reg = regions.find(r => r.neighborhoodIds.includes(target.id));
                if (reg) reg.neighborhoodIds = reg.neighborhoodIds.filter(id => id !== target.id);
                delete centroids[target.id];
                mergedCount++;
            }
            if (verbose) {
                console.log('[Go-NH] Merged ' + mergedCount + ' tiny neighborhoods (< ' + minSize +
                    ' campers, < ' + maxMergeMi + 'mi apart); ' + isolatedIds.size + ' isolated tinies retained');
            }
            // Post-merge audit — catch any drift in camperCount sum or segment overlap.
            {
                const post = neighborhoods.reduce((s, n) => s + (n.camperCount || 0), 0);
                const segOwners = {};
                let segDupes = 0;
                for (const nh of neighborhoods) {
                    for (const sid of nh.segmentIds) {
                        if (segOwners[sid] && segOwners[sid] !== nh.id) segDupes++;
                        segOwners[sid] = nh.id;
                    }
                }
                console.log('[Go-NH] post-merge audit: ' + neighborhoods.length + ' NHs, ' +
                    post + ' campers (expected ' + homes.length + '), ' + segDupes + ' cross-NH seg dupes');
            }
        }

        const segments = Object.values(segmentsById).filter(s => s.neighborhoodId && s.homes.length > 0);
        stats.neighborhoodCount = neighborhoods.length;
        stats.segmentCount = segments.length;

        if (verbose) {
            console.log('[Go-NH] Phase 1 done:');
            console.log('  ' + stats.neighborhoodCount + ' neighborhoods, ' + stats.segmentCount + ' stop-segments, ' + stats.homeCount + ' homes');
            const modeCounts = neighborhoods.reduce((m, n) => { m[n.mode] = (m[n.mode] || 0) + 1; return m; }, {});
            console.log('  modes: ', modeCounts);
        }

        return {
            regions,
            neighborhoods,
            segments,
            nodes: graph.nodes,
            homes,
            unattachedCampers,
            stats,
        };
    }

    // -------------------------------------------------------------------------
    // packIntoBuses — bin-pack neighborhoods into buses with geographic locality.
    //
    // Strategy:
    //   1. Pre-split oversize neighborhoods along spine.
    //   2. Prior-year pass: keep known NH → bus mapping when capacity allows.
    //   3. Spatial-sweep pass: unassigned NHs, sorted by angle from the global
    //      centroid, placed into the bus whose current centroid is closest
    //      (empty buses score last). This keeps neighborhoods on the same bus
    //      geographically clustered, which is what prevents the 5hr zigzag runs.
    //   4. Within-bus ordering: segments are grouped by their NH and NHs are
    //      reordered via NN from the depot (camp), so the bus drives outward
    //      from camp in a sensible sequence instead of back-tracking.
    //   5. Overflow: if no bus fits, place on least-full (+warn) rather than
    //      silently dropping the neighborhood's campers.
    // -------------------------------------------------------------------------
    function packIntoBuses({ result, buses, priorAssignments = {}, siblingGroups = {}, depot = null, maxRideMin = 45, avgStopMin = 2, paceMinPerMi = 6,
                             rideSpeedMph = 25, rideStopMin = 1, maxChildRideMin = 0 }) {
        if (!result || !result.neighborhoods.length) return [];

        // Input audit: any duplicate nhIds in result.neighborhoods, or duplicate
        // segmentIds across different NHs, is a detection-pass bug we want to
        // see rather than silently absorb downstream.
        {
            const nhIdCounts = {};
            for (const nh of result.neighborhoods) nhIdCounts[nh.id] = (nhIdCounts[nh.id] || 0) + 1;
            const dupeNhIds = Object.entries(nhIdCounts).filter(([, c]) => c > 1);
            if (dupeNhIds.length) {
                console.warn('[Go-NH] ⚠ duplicate NH ids in result.neighborhoods: ' +
                    dupeNhIds.slice(0, 5).map(([id, c]) => id + '×' + c).join(' '));
            }
            const segOwner = {};
            let crossNhSegDupes = 0;
            for (const nh of result.neighborhoods) {
                for (const sid of nh.segmentIds) {
                    if (segOwner[sid] && segOwner[sid] !== nh.id) crossNhSegDupes++;
                    segOwner[sid] = nh.id;
                }
            }
            if (crossNhSegDupes) {
                console.warn('[Go-NH] ⚠ ' + crossNhSegDupes + ' segment(s) appear in >1 neighborhood (should be 0)');
            }
            const totalCampers = result.neighborhoods.reduce((s, n) => s + (n.camperCount || 0), 0);
            console.log('[Go-NH] packIntoBuses input: ' + result.neighborhoods.length + ' NHs, ' + totalCampers + ' campers');
        }

        const vehicles = buses.map(b => ({
            busId: b.id || b.busId,
            name: b.name || ('Bus ' + (b.id || b.busId)),
            capacity: Math.max(0, b.capacity || 0),
        }));
        const maxCap = Math.max(...vehicles.map(v => v.capacity));

        // Neighborhood centroid = mean of its homes' coords, plus how far the bus
        // must drive WITHIN it. Treating a neighbourhood as a single point makes a
        // sprawling one look free: the trip out to a township 6mi away scored ~37
        // minutes while the real route was ~80, because the ~12mi loop among its
        // own houses was never counted. Bounding-box diagonal is a cheap, stable
        // proxy for that internal driving.
        const nhCentroids = {};
        const nhInternalMi = {};
        {
            const byNh = {};
            for (const h of result.homes) {
                if (!Number.isFinite(h.lat) || !Number.isFinite(h.lng)) continue;
                (byNh[h.neighborhoodId] || (byNh[h.neighborhoodId] = [])).push(h);
            }
            for (const nh of result.neighborhoods) {
                const nhHomes = byNh[nh.id];
                if (!nhHomes || !nhHomes.length) continue;
                let mnLa = Infinity, mxLa = -Infinity, mnLo = Infinity, mxLo = -Infinity;
                let sLa = 0, sLo = 0;
                for (const h of nhHomes) {
                    sLa += h.lat; sLo += h.lng;
                    if (h.lat < mnLa) mnLa = h.lat; if (h.lat > mxLa) mxLa = h.lat;
                    if (h.lng < mnLo) mnLo = h.lng; if (h.lng > mxLo) mxLo = h.lng;
                }
                nhCentroids[nh.id] = { lat: sLa / nhHomes.length, lng: sLo / nhHomes.length };
                nhInternalMi[nh.id] = haversineMi(mnLa, mnLo, mxLa, mxLo);
            }
        }

        // --- 1. Pre-split oversize neighborhoods GEOGRAPHICALLY ------------------
        // Community detection can hand back one enormous neighborhood: on the
        // camp's real data a single NH held 509 of 744 campers (68%) across 5405
        // segments with a 16-MILE bounding box, while every other NH was 0.3-2.3mi.
        // The old split walked segmentIds in spine order and cut every time the
        // running total hit a bus, so consecutive graph-traversal segments — which
        // can be miles apart — landed in the same piece. Each piece was therefore
        // smeared across the whole territory, and any bus receiving one instantly
        // spanned 7-13mi. That, not the packer, was the real source of the
        // map-crossing routes.
        //
        // Split on GEOGRAPHY instead: recursively cut the segment set at its
        // camper-count median along whichever axis it is widest, until each piece
        // fits a bus. That yields compact, bus-sized blocks.
        const _segIndex = {};
        for (const s of result.segments) _segIndex[s.id] = s;

        // Split `items` into exactly `k` geographically-compact groups of roughly
        // equal camper load. Splitting by "halve until it fits" instead overshoots
        // badly: 509 campers against a 48-seat bus halves 509 -> 254 -> 127 -> 63
        // -> 31, and pieces of 31 tile terribly into 48-seat buses (one piece
        // wastes 17 seats, two won't fit). That left 5 pieces homeless, which the
        // overflow path then force-dumped onto buses ALREADY FULL — producing
        // 53-61 campers on 50-seat buses. Choosing k up front gives pieces of
        // ~total/k that fill a bus properly.
        function _splitByGeography(items, k) {
            if (k <= 1 || items.length <= 1) return [items];
            const placed = items.filter(x => x.lat != null);
            if (placed.length < 2) return [items];
            let mnLa = Infinity, mxLa = -Infinity, mnLo = Infinity, mxLo = -Infinity;
            for (const x of placed) {
                if (x.lat < mnLa) mnLa = x.lat; if (x.lat > mxLa) mxLa = x.lat;
                if (x.lng < mnLo) mnLo = x.lng; if (x.lng > mxLo) mxLo = x.lng;
            }
            // compare spans in comparable units (lng shrinks with latitude)
            const latSpan = mxLa - mnLa;
            const lngSpan = (mxLo - mnLo) * Math.cos(((mnLa + mxLa) / 2) * Math.PI / 180);
            const key = latSpan >= lngSpan ? 'lat' : 'lng';
            const sorted = items.slice().sort((a, b) => {
                if (a[key] == null) return 1;
                if (b[key] == null) return -1;
                return a[key] - b[key];
            });
            // Cut so each side gets its share of the k pieces (by camper load).
            const total = sorted.reduce((a, x) => a + x.count, 0);
            const kLeft = Math.floor(k / 2), kRight = k - kLeft;
            const targetLeft = total * (kLeft / k);
            let acc = 0, cut = 0;
            for (let i = 0; i < sorted.length; i++) {
                acc += sorted[i].count;
                if (acc >= targetLeft) { cut = i + 1; break; }
            }
            if (cut <= 0) cut = 1;
            if (cut >= sorted.length) cut = sorted.length - 1;
            return _splitByGeography(sorted.slice(0, cut), kLeft)
               .concat(_splitByGeography(sorted.slice(cut), kRight));
        }

        // Minutes for one bus to serve this neighbourhood alone from the depot.
        // A tour through n scattered points runs roughly 0.5*sqrt(n) times the
        // area's diagonal — the diagonal alone badly understates a dense loop.
        function soloRideMin(camperCount, centroid, internalMi) {
            if (!depot || !centroid) return 0;
            const out = haversineMi(depot.lat, depot.lng, centroid.lat, centroid.lng);
            const stops = Math.max(1, Math.round(camperCount / 2.5));
            const inner = 0.5 * Math.sqrt(stops) * (internalMi || 0);
            return ((out + inner) * 1.35 / Math.max(1, rideSpeedMph)) * 60 + stops * rideStopMin;
        }

        const workNhs = [];
        for (const nh of result.neighborhoods) {
            // Split on RIDE TIME as well as capacity. A township 6mi out with 42
            // children fits a 48-seat bus, so it was never split — and the one bus
            // covering it ran ~80 minutes while the fleet median was 18. Sharing it
            // between two buses halves that, and capacity alone can never see it.
            const solo = maxChildRideMin > 0
                ? soloRideMin(nh.camperCount, nhCentroids[nh.id], nhInternalMi[nh.id])
                : 0;
            const needRideSplit = maxChildRideMin > 0 && solo > maxChildRideMin;
            if (nh.camperCount <= maxCap && !needRideSplit) { workNhs.push(nh); continue; }
            // one point per segment = the mean of its homes
            const segPts = nh.segmentIds.map(sid => {
                const s = _segIndex[sid];
                if (!s || !s.homes || !s.homes.length) return { sid, lat: null, lng: null, count: 0 };
                let la = 0, lo = 0, n = 0;
                for (const h of s.homes) {
                    if (Number.isFinite(h.lat) && Number.isFinite(h.lng)) { la += h.lat; lo += h.lng; n++; }
                }
                return { sid, lat: n ? la / n : null, lng: n ? lo / n : null, count: s.homes.length };
            });
            // Aim for pieces that fill a bus. Grow k if a piece still overflows
            // (uneven geography can make one side heavier than its share).
            let k = Math.max(2, Math.ceil(nh.camperCount / maxCap));
            if (needRideSplit) k = Math.max(k, Math.ceil(solo / maxChildRideMin));
            let buckets = _splitByGeography(segPts, k).filter(b => b.length);
            for (let guard = 0; guard < 8; guard++) {
                const worst = buckets.reduce((m, b) => Math.max(m, b.reduce((a, x) => a + x.count, 0)), 0);
                if (worst <= maxCap || k >= segPts.length) break;
                k++;
                buckets = _splitByGeography(segPts, k).filter(b => b.length);
            }
            const pieces = buckets
                .map(b => ({ segIds: b.map(x => x.sid), count: b.reduce((a, x) => a + x.count, 0) }));

            pieces.forEach((p, i) => {
                const pieceId = nh.id + '_p' + i;
                workNhs.push({
                    ...nh,
                    id: pieceId,
                    parentId: nh.id,
                    segmentIds: p.segIds,
                    camperCount: p.count,
                    splitReason: 'oversize',
                });
                // Centroid from THIS piece's own homes — never the parent's.
                // Inheriting the parent centroid made every piece of a big
                // neighborhood report the same location, so the packer measured
                // ~0 distance between pieces that are actually miles apart and
                // happily paired one with a far-away neighborhood. On the camp's
                // real data one core neighborhood split into 12 pieces and a
                // piece landed on every one of the worst (7-13mi) buses.
                const pieceHomes = [];
                for (const sid of p.segIds) {
                    const seg = _segIndex[sid];
                    if (seg && seg.homes) {
                        for (const h of seg.homes) {
                            if (Number.isFinite(h.lat) && Number.isFinite(h.lng)) pieceHomes.push(h);
                        }
                    }
                }
                if (pieceHomes.length) {
                    let mnLa = Infinity, mxLa = -Infinity, mnLo = Infinity, mxLo = -Infinity;
                    for (const h of pieceHomes) {
                        if (h.lat < mnLa) mnLa = h.lat; if (h.lat > mxLa) mxLa = h.lat;
                        if (h.lng < mnLo) mnLo = h.lng; if (h.lng > mxLo) mxLo = h.lng;
                    }
                    nhCentroids[pieceId] = {
                        lat: pieceHomes.reduce((s, h) => s + h.lat, 0) / pieceHomes.length,
                        lng: pieceHomes.reduce((s, h) => s + h.lng, 0) / pieceHomes.length,
                    };
                    nhInternalMi[pieceId] = haversineMi(mnLa, mnLo, mxLa, mxLo);
                } else if (nhCentroids[nh.id]) {
                    nhCentroids[pieceId] = nhCentroids[nh.id];
                    nhInternalMi[pieceId] = nhInternalMi[nh.id] || 0;
                }
            });
        }

        // --- 2. Set up buses with running centroid tracking ---
        let assignments = vehicles.map(v => ({
            busId: v.busId, name: v.name, capacity: v.capacity,
            neighborhoodIds: [], segmentIds: [], camperCount: 0,
            _centroidSum: { lat: 0, lng: 0, w: 0 },
        }));
        const busById = Object.fromEntries(assignments.map(a => [a.busId, a]));

        function assignToBus(nh, bus) {
            bus.neighborhoodIds.push(nh.id);
            bus.segmentIds.push(...nh.segmentIds);
            bus.camperCount += nh.camperCount;
            const c = nhCentroids[nh.id];
            if (c) {
                bus._centroidSum.lat += c.lat * nh.camperCount;
                bus._centroidSum.lng += c.lng * nh.camperCount;
                bus._centroidSum.w += nh.camperCount;
            }
        }
        function busCentroid(bus) {
            if (bus._centroidSum.w === 0) return null;
            return { lat: bus._centroidSum.lat / bus._centroidSum.w, lng: bus._centroidSum.lng / bus._centroidSum.w };
        }

        // Spread cap used by all placement passes. Defined up here so
        // the prior-year pass can respect it too (otherwise last year's
        // wide buses stick permanently).
        // Tightened 3.0 → 2.5mi: camp's reference routes typically span
        // 2-3mi within a corridor; 3.0 was letting too many fallback
        // violations through, producing 5-6mi mega-routes.
        const MAX_BUS_SPREAD_MI = 2.5;
        const EMPTY_BUS_START_COST_MI = 2.5;
        function wouldSpreadExceed(bus, nh, capMi) {
            const c = nhCentroids[nh.id]; if (!c) return false;
            for (const existingId of bus.neighborhoodIds) {
                const ec = nhCentroids[existingId]; if (!ec) continue;
                if (haversineMi(c.lat, c.lng, ec.lat, ec.lng) > capMi) return true;
            }
            return false;
        }
        // Compute the bus's max pair distance (current spread). 0 if <2 NHs.
        function busSpread(bus) {
            const ids = bus.neighborhoodIds;
            let max = 0;
            for (let i = 0; i < ids.length; i++) {
                const ci = nhCentroids[ids[i]]; if (!ci) continue;
                for (let j = i + 1; j < ids.length; j++) {
                    const cj = nhCentroids[ids[j]]; if (!cj) continue;
                    const d = haversineMi(ci.lat, ci.lng, cj.lat, cj.lng);
                    if (d > max) max = d;
                }
            }
            return max;
        }
        // Compute what the spread would BECOME if we added this NH.
        // Used as the fallback metric when no bus passes the soft cap —
        // pick the bus that grows LEAST, not the one with closest centroid.
        // Closest-centroid was producing 6mi mega-buses because it didn't
        // account for existing internal spread.
        function resultingSpread(bus, nh) {
            const c = nhCentroids[nh.id]; if (!c) return Infinity;
            let max = busSpread(bus);
            for (const existingId of bus.neighborhoodIds) {
                const ec = nhCentroids[existingId]; if (!ec) continue;
                const d = haversineMi(c.lat, c.lng, ec.lat, ec.lng);
                if (d > max) max = d;
            }
            return max;
        }
        // Distance from this NH to its NEAREST other NH. Isolated NHs
        // (large min-distance) should be placed first so they grab empty
        // buses before being squeezed into already-busy buses far away.
        function nhIsolation(nhId, others) {
            const c = nhCentroids[nhId]; if (!c) return 0;
            let minD = Infinity;
            for (const other of others) {
                if (other.id === nhId) continue;
                const oc = nhCentroids[other.id]; if (!oc) continue;
                const d = haversineMi(c.lat, c.lng, oc.lat, oc.lng);
                if (d < minD) minD = d;
            }
            return minD === Infinity ? 0 : minD;
        }

        // --- Sector (depot-bearing) awareness -----------------------------------
        // City-district model: buses radiate from the depot as sectors. A bus
        // that must cover two areas should take ADJACENT ones (a narrow wedge),
        // never OPPOSITE sides (north AND south through the depot), which forces
        // an out-and-back straddle. We only use this on the FORCED paths
        // (fallback + rebalance) where the spread cap can't be met — the clean
        // under-cap path is unchanged. STRADDLE_PENALTY_MI is an effective-miles
        // weight: a full 180° straddle costs this much extra vs a 0° alignment.
        const STRADDLE_PENALTY_MI = 5.0;
        function bearingFromDepot(c) {
            if (!depot || !c) return null;
            return Math.atan2(c.lng - depot.lng, c.lat - depot.lat); // radians
        }
        function angDiff(a, b) {
            let d = Math.abs(a - b) % (2 * Math.PI);
            return d > Math.PI ? 2 * Math.PI - d : d; // 0..π
        }
        // Bearing is meaningless for stops sitting on top of the depot: two homes
        // 0.3mi from camp on opposite sides read as a 180-degree "straddle" while
        // being 0.6mi apart — a perfectly good compact route. Only stops that are
        // genuinely far out can straddle, so ignore anything inside this radius.
        const MIN_ARC_RADIUS_MI = 1.5;
        // Max angular span (from depot) among a bus's NHs, optionally adding one.
        function busAngularSpan(bus, extraNhId) {
            const ids = extraNhId ? bus.neighborhoodIds.concat(extraNhId) : bus.neighborhoodIds;
            const bearings = [];
            for (const id of ids) {
                const c = nhCentroids[id];
                const b = bearingFromDepot(c);
                if (b == null) continue;
                if (depot && haversineMi(depot.lat, depot.lng, c.lat, c.lng) < MIN_ARC_RADIUS_MI) continue;
                bearings.push(b);
            }
            if (bearings.length < 2) return 0;
            let max = 0;
            for (let i = 0; i < bearings.length; i++)
                for (let j = i + 1; j < bearings.length; j++) {
                    const d = angDiff(bearings[i], bearings[j]);
                    if (d > max) max = d;
                }
            return max; // radians, 0..π
        }
        // Straddle cost in effective miles for putting nh on bus.
        function straddleCost(bus, nhId) {
            return STRADDLE_PENALTY_MI * (busAngularSpan(bus, nhId) / Math.PI);
        }

        // --- 2a. Pass 1: prior-year preference (size-DESC for priority) ---
        const sortedBySize = [...workNhs].sort((a, b) => b.camperCount - a.camperCount);
        const assignedIds = new Set();
        let priorHits = 0, priorSpreadSkips = 0;
        for (const nh of sortedBySize) {
            const pid = nh.parentId || nh.id;
            const preferredBusId = priorAssignments[pid];
            if (!preferredBusId) continue;
            const bus = busById[preferredBusId];
            if (!bus || bus.camperCount + nh.camperCount > bus.capacity) continue;
            if (wouldSpreadExceed(bus, nh, MAX_BUS_SPREAD_MI)) { priorSpreadSkips++; continue; }
            assignToBus(nh, bus);
            assignedIds.add(nh.id);
            priorHits++;
        }
        if (priorSpreadSkips) console.log('[Go-NH] Prior-year pass: skipped ' + priorSpreadSkips + ' NH(s) that would exceed spread cap');

        // --- 2b. Pass 2: spatial-sweep + proximity-aware for the rest ---
        const unassigned = sortedBySize.filter(nh => !assignedIds.has(nh.id));

        // Global centroid (weighted by camperCount)
        let globalCentroid = null;
        {
            let sL = 0, sG = 0, w = 0;
            for (const nh of workNhs) {
                const c = nhCentroids[nh.id]; if (!c) continue;
                sL += c.lat * nh.camperCount; sG += c.lng * nh.camperCount; w += nh.camperCount;
            }
            if (w > 0) globalCentroid = { lat: sL / w, lng: sG / w };
        }

        // Sort by ISOLATION descending: most-isolated NHs (no close partner)
        // get assigned first so they can grab an empty bus. Otherwise they
        // get jammed onto a busy bus far away at the end of the loop, which
        // produced 6mi mega-buses. Tie-break by size DESC so a big lonely
        // cluster outranks a tiny one.
        const _allForIsolation = unassigned.slice();
        // Big neighborhoods FIRST (first-fit-decreasing), isolation only for the
        // small ones. Isolation-first alone sprinkled a few campers from remote
        // NHs onto every bus, so by the time a near-bus-sized piece was placed
        // NO bus had room and it overflowed onto the "least-full" bus with no
        // regard for geography — on the camp's real data three 44-46 camper
        // pieces overflowed that way and produced the 13-mile buses. A piece
        // that needs most of a bus has to be placed while buses are still empty.
        const BIG_NH_FRACTION = 0.5;
        const bigThreshold = maxCap * BIG_NH_FRACTION;
        unassigned.sort((a, b) => {
            const aBig = a.camperCount >= bigThreshold;
            const bBig = b.camperCount >= bigThreshold;
            if (aBig !== bBig) return aBig ? -1 : 1;
            if (aBig && bBig) return b.camperCount - a.camperCount;
            const ia = nhIsolation(a.id, _allForIsolation);
            const ib = nhIsolation(b.id, _allForIsolation);
            if (ia !== ib) return ib - ia;
            return b.camperCount - a.camperCount;
        });

        // For each unassigned NH, pick the best bus:
        //   1. PREFERRED: a bus where adding this NH stays under the spread cap.
        //      Among those, pick the one with smallest current spread (tightest).
        //   2. FALLBACK: when no bus stays under the cap, pick the bus that
        //      results in the SMALLEST spread after adding (not closest centroid).
        //      Closest-centroid was producing 6mi buses because it ignored the
        //      bus's existing internal spread — adding to a bus 4mi away whose
        //      stops already span 2mi makes a 6mi bus.
        //   3. OVERFLOW: if every bus is over capacity, place on least-full.
        for (const nh of unassigned) {
            let target = null, targetScore = Infinity;
            let fallbackTarget = null, fallbackScore = Infinity;

            for (const bus of assignments) {
                if (bus.camperCount + nh.camperCount > bus.capacity) continue;
                const newSpread = resultingSpread(bus, nh);

                // Track best fallback. When no bus can stay under the spread cap,
                // prefer the one that keeps this bus SECTORAL (adjacent bearings)
                // over one that would straddle the depot — a north+south bus and a
                // compact blob can have the same raw spread, but only the straddle
                // drives the "out and back for no reason" route.
                const fbCost = newSpread + straddleCost(bus, nh.id);
                if (fbCost < fallbackScore) {
                    fallbackScore = fbCost; fallbackTarget = bus;
                }
                // Track best primary (must keep spread under cap)
                if (newSpread > MAX_BUS_SPREAD_MI) continue;
                // ...and must keep the bus inside its riding-time budget. A
                // district far from camp burns most of its budget just getting
                // there, so filling it to the last seat leaves the children
                // dropped last sitting on the bus far longer than anyone else.
                // Capacity alone can't see that — on the camp's real data one
                // township 6mi out took 42 children on a single bus and its last
                // drops rode 80 minutes while the fleet median was 18.
                // Off unless the caller sets a budget, so existing callers and the
                // synthetic benchmarks behave exactly as before. The fallback path
                // below still places the NH, so this can never strand anyone.
                if (maxChildRideMin > 0 &&
                    estimateBusRideMinWith(bus, nh) > maxChildRideMin) continue;
                // Among compliant buses, prefer the one already containing this
                // NH's neighborhood — i.e. the smallest existing spread, breaks
                // ties toward empty buses.
                const tieBreaker = bus.neighborhoodIds.length === 0
                    ? EMPTY_BUS_START_COST_MI
                    : busSpread(bus);
                if (tieBreaker < targetScore) { targetScore = tieBreaker; target = bus; }
            }

            if (!target) target = fallbackTarget;
            if (!target) {
                // No single bus can take the whole neighborhood. Dumping it on the
                // "least-full" bus used to blow straight through capacity — the
                // camp's real data ended with 61 and 63 campers on 48-seat buses,
                // which no school can run. Spill it SEGMENT BY SEGMENT into the
                // buses that still have seats, nearest bus first, so capacity is
                // respected and the pieces still land somewhere sensible.
                const segs = nh.segmentIds.map(sid => {
                    const s = _segIndex[sid];
                    let la = 0, lo = 0, n = 0;
                    if (s && s.homes) for (const h of s.homes) {
                        if (Number.isFinite(h.lat) && Number.isFinite(h.lng)) { la += h.lat; lo += h.lng; n++; }
                    }
                    return { sid, count: s && s.homes ? s.homes.length : 0,
                             lat: n ? la / n : null, lng: n ? lo / n : null };
                }).sort((a, b) => b.count - a.count);

                let spilled = 0, stranded = 0;
                for (const seg of segs) {
                    const room = assignments.filter(b => b.camperCount + seg.count <= b.capacity);
                    if (!room.length) { stranded += seg.count; continue; }
                    let best = room[0], bestD = Infinity;
                    for (const b of room) {
                        const c = busCentroid(b);
                        const d = (c && seg.lat != null)
                            ? haversineMi(seg.lat, seg.lng, c.lat, c.lng)
                            : (b.neighborhoodIds.length ? Infinity : EMPTY_BUS_START_COST_MI);
                        if (d < bestD) { bestD = d; best = b; }
                    }
                    best.segmentIds.push(seg.sid);
                    best.camperCount += seg.count;
                    if (seg.lat != null) {
                        best._centroidSum.lat += seg.lat * seg.count;
                        best._centroidSum.lng += seg.lng * seg.count;
                        best._centroidSum.w += seg.count;
                    }
                    spilled += seg.count;
                }
                console.warn('[Go-NH] Overflow: no single bus fit ' + nh.id + ' (' +
                    nh.camperCount + ' campers) — spilled ' + spilled +
                    ' across buses with room' + (stranded ? ', ' + stranded + ' STRANDED (fleet is full)' : ''));
                continue; // already placed segment-wise
            }
            assignToBus(nh, target);
        }

        // Diagnostic: per-bus max intra-bus spread (farthest pair of NH centroids
        // on the same bus). Big numbers here = the cluster-packing failed.
        {
            const spreads = [];
            for (const bus of assignments) {
                if (bus.neighborhoodIds.length < 2) continue;
                let maxD = 0;
                for (let i = 0; i < bus.neighborhoodIds.length; i++) {
                    const ci = nhCentroids[bus.neighborhoodIds[i]];
                    if (!ci) continue;
                    for (let j = i + 1; j < bus.neighborhoodIds.length; j++) {
                        const cj = nhCentroids[bus.neighborhoodIds[j]];
                        if (!cj) continue;
                        const d = haversineMi(ci.lat, ci.lng, cj.lat, cj.lng);
                        if (d > maxD) maxD = d;
                    }
                }
                spreads.push({ bus: bus.busId, nhs: bus.neighborhoodIds.length, spreadMi: +maxD.toFixed(2) });
            }
            spreads.sort((a, b) => b.spreadMi - a.spreadMi);
            if (spreads.length) {
                console.log('[Go-NH] bus spread (worst 5): ' +
                    spreads.slice(0, 5).map(s => s.bus + '=' + s.spreadMi + 'mi/' + s.nhs + 'NH').join(' '));
            }
        }

        // --- 2c. Spread + ride-time rebalance pass ---
        // Two triggers:
        //  (1) bus spread > MAX_BUS_SPREAD_MI — initial placement's cap-honor
        //      fallback can still produce wide buses; peel until under cap
        //  (2) estimated bus ride time > maxRideMin — NN tour × pace + stops
        // Peel the centroid-outlier NH (or farthest-from-depot) and move to
        // a bus with capacity + spread headroom.
        function estimateBusRideMin(bus) {
            if (!bus.neighborhoodIds.length) return 0;
            const remaining = new Set(bus.neighborhoodIds);
            let curLat = depot?.lat ?? null, curLng = depot?.lng ?? null;
            let mi = 0;
            while (remaining.size) {
                let nextId = null, nextD = Infinity;
                for (const id of remaining) {
                    const c = nhCentroids[id]; if (!c) continue;
                    const d = (curLat != null) ? haversineMi(curLat, curLng, c.lat, c.lng) : 0;
                    if (d < nextD) { nextD = d; nextId = id; }
                }
                if (!nextId) break;
                mi += isFinite(nextD) ? nextD : 0;
                const c = nhCentroids[nextId];
                if (c) { curLat = c.lat; curLng = c.lng; }
                remaining.delete(nextId);
            }
            return mi * paceMinPerMi + bus.neighborhoodIds.length * avgStopMin;
        }
        // Riding time if this NH were added to the bus. Self-contained rather than
        // reusing estimateBusRideMin, whose defaults (10mph, stop time counted per
        // NEIGHBOURHOOD rather than per stop) are far off the real numbers and are
        // fine for a rebalance trigger but not as an assignment constraint.
        // Real roads are ~1.35x straight-line, and a stop serves ~2.5 children.
        // These live INSIDE the function on purpose: the declaration hoists but a
        // const beside it would not, and the assignment loop above calls this
        // before that point — which threw a temporal-dead-zone ReferenceError and
        // silently dropped the whole pipeline to the old k-means fallback.
        function estimateBusRideMinWith(bus, nh) {
            const RIDE_ROAD_FACTOR = 1.35;
            const RIDE_CHILDREN_PER_STOP = 2.5;
            if (!depot) return 0;
            const ids = bus.neighborhoodIds.concat(nh.id);
            const pts = [];
            for (const id of ids) { const c = nhCentroids[id]; if (c) pts.push(c); }
            if (!pts.length) return 0;
            // nearest-neighbour walk from the depot through the centroids
            const remaining = pts.slice();
            let miles = 0, la = depot.lat, lo = depot.lng;
            while (remaining.length) {
                let bi = 0, bd = Infinity;
                for (let i = 0; i < remaining.length; i++) {
                    const d = haversineMi(la, lo, remaining[i].lat, remaining[i].lng);
                    if (d < bd) { bd = d; bi = i; }
                }
                miles += bd; la = remaining[bi].lat; lo = remaining[bi].lng;
                remaining.splice(bi, 1);
            }
            // ...plus the driving WITHIN each neighbourhood, which is most of the
            // route for a dense one and is invisible if you only walk centroids.
            for (const id of ids) miles += (nhInternalMi[id] || 0);
            const campers = (bus.camperCount || 0) + (nh.camperCount || 0);
            const stops = Math.max(ids.length, Math.round(campers / RIDE_CHILDREN_PER_STOP));
            const speed = Math.max(1, rideSpeedMph);
            return (miles * RIDE_ROAD_FACTOR / speed) * 60 + stops * rideStopMin;
        }

        function farthestNhFromDepot(bus) {
            let bestId = null, bestD = -1;
            for (const id of bus.neighborhoodIds) {
                const c = nhCentroids[id]; if (!c || !depot) continue;
                const d = haversineMi(depot.lat, depot.lng, c.lat, c.lng);
                if (d > bestD) { bestD = d; bestId = id; }
            }
            return bestId;
        }
        function busMaxSpreadMi(bus) {
            let maxD = 0;
            const ids = bus.neighborhoodIds;
            for (let i = 0; i < ids.length; i++) {
                const ci = nhCentroids[ids[i]]; if (!ci) continue;
                for (let j = i + 1; j < ids.length; j++) {
                    const cj = nhCentroids[ids[j]]; if (!cj) continue;
                    const d = haversineMi(ci.lat, ci.lng, cj.lat, cj.lng);
                    if (d > maxD) maxD = d;
                }
            }
            return maxD;
        }
        function outlierNh(bus) {
            // NH that contributes most to spread = one with max mean-distance
            // to other NHs on the bus. Falls back to farthest-from-depot.
            const ids = bus.neighborhoodIds; if (ids.length < 2) return ids[0];
            let worstId = null, worstMean = -1;
            for (const id of ids) {
                const ci = nhCentroids[id]; if (!ci) continue;
                let sum = 0, n = 0;
                for (const other of ids) {
                    if (other === id) continue;
                    const co = nhCentroids[other]; if (!co) continue;
                    sum += haversineMi(ci.lat, ci.lng, co.lat, co.lng); n++;
                }
                const mean = n ? sum / n : 0;
                if (mean > worstMean) { worstMean = mean; worstId = id; }
            }
            return worstId || farthestNhFromDepot(bus);
        }
        function unassign(nhId, bus) {
            const workNh = workNhs.find(n => n.id === nhId); if (!workNh) return null;
            bus.neighborhoodIds = bus.neighborhoodIds.filter(x => x !== nhId);
            bus.segmentIds = bus.segmentIds.filter(sid => !workNh.segmentIds.includes(sid));
            bus.camperCount -= workNh.camperCount;
            const c = nhCentroids[nhId];
            if (c && bus._centroidSum.w > 0) {
                bus._centroidSum.lat -= c.lat * workNh.camperCount;
                bus._centroidSum.lng -= c.lng * workNh.camperCount;
                bus._centroidSum.w  -= workNh.camperCount;
            }
            return workNh;
        }
        {
            let rebalanceMoves = 0;
            const isOverloaded = (b) => b.neighborhoodIds.length >= 2 && (
                busMaxSpreadMi(b) > MAX_BUS_SPREAD_MI ||
                estimateBusRideMin(b) > maxRideMin
            );
            for (let pass = 0; pass < 8; pass++) {
                let moved = false;
                const overloaded = assignments
                    .filter(isOverloaded)
                    .sort((a, b) => busMaxSpreadMi(b) - busMaxSpreadMi(a));
                for (const src of overloaded) {
                    const nhId = outlierNh(src); if (!nhId) continue;
                    const workNh = workNhs.find(n => n.id === nhId); if (!workNh) continue;
                    // Find best recipient: has capacity, passes spread cap (relaxed
                    // slightly so we don't deadlock), lowest resulting centroid delta.
                    let best = null, bestScore = Infinity;
                    for (const dst of assignments) {
                        if (dst === src) continue;
                        if (dst.camperCount + workNh.camperCount > dst.capacity) continue;
                        if (wouldSpreadExceed(dst, workNh, MAX_BUS_SPREAD_MI)) continue;
                        const dstC = busCentroid(dst), nhC = nhCentroids[nhId];
                        const baseScore = (dstC && nhC) ? haversineMi(nhC.lat, nhC.lng, dstC.lat, dstC.lng) : EMPTY_BUS_START_COST_MI;
                        // Prefer a recipient that keeps the moved NH sectoral, not straddling.
                        const score = baseScore + straddleCost(dst, nhId);
                        if (score < bestScore) { bestScore = score; best = dst; }
                    }
                    if (!best) continue;
                    // Don't move if recipient would itself become over-spread after the move
                    unassign(nhId, src);
                    assignToBus(workNh, best);
                    if (busMaxSpreadMi(best) > MAX_BUS_SPREAD_MI) {
                        // undo
                        unassign(nhId, best);
                        assignToBus(workNh, src);
                        continue;
                    }
                    rebalanceMoves++;
                    moved = true;
                }
                if (!moved) break;
            }
            if (rebalanceMoves) console.log('[Go-NH] Spread/ride rebalance: ' + rebalanceMoves + ' NH move(s)');
        }

        // --- 2d. SWEEP candidate + pick the better districting ---------------
        // The greedy passes above are excellent when the fleet has slack (they
        // produce near-perfect 1-degree sectors), but they degrade badly when
        // the fleet is tight: the forced-merge fallback can hand one bus two
        // OPPOSITE sides of the depot (arcs up to 180deg), which is what draws a
        // route line straight across the map.
        //
        // The classic sweep heuristic is the reverse: mediocre with slack, but
        // it can't straddle, because it walks stops in bearing order around the
        // depot and gives each bus one CONTIGUOUS arc.
        //
        // Neither wins everywhere, so build both and keep whichever districts
        // better. This is what makes the result independent of how many buses
        // the camp happens to own — no tuning required.
        function districtScore(cands) {
            let worstArc = 0, worstSpread = 0;
            for (const bus of cands) {
                if (!bus || bus.neighborhoodIds.length < 2) continue;
                const arc = busAngularSpan(bus, null);
                if (arc > worstArc) worstArc = arc;
                const sp = busMaxSpreadMi(bus);
                if (sp > worstSpread) worstSpread = sp;
            }
            // arc is radians (0..PI); weight it so a half-turn straddle (~9.4)
            // outweighs a few extra miles of spread.
            return worstArc * 3 + worstSpread;
        }

        function buildSweepCandidate() {
            if (!depot || !vehicles.length) return null;
            const ordered = workNhs
                .map(nh => ({ nh, b: bearingFromDepot(nhCentroids[nh.id]) }))
                .filter(x => x.b != null)
                .sort((a, b) => a.b - b.b)
                .map(x => x.nh);
            // If any NH lacks a centroid we can't sweep reliably — skip.
            if (ordered.length !== workNhs.length) return null;

            const totalC = workNhs.reduce((s, n) => s + n.camperCount, 0);
            const target = Math.ceil(totalC / vehicles.length);
            // Try rotations of the starting bearing (where we "cut" the circle).
            // Cap the number tried so a big camp stays fast.
            const N = ordered.length;
            const stride = Math.max(1, Math.ceil(N / 60));
            let best = null;

            for (let start = 0; start < N; start += stride) {
                const order = ordered.slice(start).concat(ordered.slice(0, start));
                const cand = vehicles.map(v => ({
                    busId: v.busId, name: v.name, capacity: v.capacity,
                    neighborhoodIds: [], segmentIds: [], camperCount: 0,
                    _centroidSum: { lat: 0, lng: 0, w: 0 },
                }));
                let bi = 0, ok = true;
                for (const nh of order) {
                    // Move on once this bus has its fair share, so the final bus
                    // doesn't get a tiny scrap arc.
                    while (bi < cand.length - 1 && cand[bi].camperCount >= target) bi++;
                    while (bi < cand.length &&
                           cand[bi].camperCount + nh.camperCount > cand[bi].capacity) bi++;
                    if (bi >= cand.length) { ok = false; break; }
                    assignToBus(nh, cand[bi]);
                }
                if (!ok) continue; // this rotation didn't fit the fleet
                const score = districtScore(cand);
                if (!best || score < best.score) best = { score, cand };
            }
            return best;
        }

        {
            const greedyScore = districtScore(assignments);
            const sweep = buildSweepCandidate();
            if (sweep) {
                // Only switch on a clear win. The greedy pass carries the
                // prior-year bus mapping (route stability year to year), so we
                // don't churn it for a marginal gain.
                if (sweep.score < greedyScore * 0.85) {
                    console.log('[Go-NH] Districting: SWEEP wins (score ' +
                        sweep.score.toFixed(2) + ' vs greedy ' + greedyScore.toFixed(2) +
                        ') — using contiguous bearing arcs');
                    assignments = sweep.cand;
                } else {
                    console.log('[Go-NH] Districting: greedy kept (score ' +
                        greedyScore.toFixed(2) + ' vs sweep ' + sweep.score.toFixed(2) + ')');
                }
            }
        }

        // --- 3. Within-bus ordering: group segments by NH, order NHs via NN from depot ---
        const segById = Object.fromEntries(result.segments.map(s => [s.id, s]));
        for (const bus of assignments) {
            if (!bus.neighborhoodIds.length) continue;

            // Group segmentIds by the ORIGINAL neighborhood id (so split pieces
            // of the same NH stay contiguous), preserving spine order within.
            const nhSegOrder = {};
            const seenSegs = new Set();
            for (const sid of bus.segmentIds) {
                if (seenSegs.has(sid)) continue;
                seenSegs.add(sid);
                const seg = segById[sid];
                const key = (seg && seg.neighborhoodId) || 'orphan';
                (nhSegOrder[key] ||= []).push(sid);
            }

            // NN ordering of NHs within this bus, starting from depot (or the
            // NH closest to depot if no depot given)
            const nhIds = Object.keys(nhSegOrder);
            const remaining = new Set(nhIds);
            const orderedNhIds = [];
            let curLat = depot?.lat ?? null, curLng = depot?.lng ?? null;
            while (remaining.size) {
                let nextId = null, nextDist = Infinity;
                for (const nhid of remaining) {
                    const c = nhCentroids[nhid];
                    if (!c) continue;
                    const d = (curLat != null && curLng != null)
                        ? haversineMi(curLat, curLng, c.lat, c.lng)
                        : 0;
                    if (d < nextDist) { nextDist = d; nextId = nhid; }
                }
                if (!nextId) nextId = [...remaining][0];
                remaining.delete(nextId);
                orderedNhIds.push(nextId);
                const c = nhCentroids[nextId];
                if (c) { curLat = c.lat; curLng = c.lng; }
            }

            bus.segmentIds = orderedNhIds.flatMap(nhid => nhSegOrder[nhid] || []);
        }

        // --- 4. Sibling split warning ---
        for (const group of Object.values(siblingGroups)) {
            const busesHit = new Set();
            for (const name of group) {
                const home = result.homes.find(h => h.camperName === name);
                if (!home) continue;
                for (const a of assignments) {
                    if (a.segmentIds.includes(home.segmentId)) { busesHit.add(a.busId); break; }
                }
            }
            if (busesHit.size > 1) {
                console.warn('[Go-NH] ⚠ Siblings ' + group.join(',') + ' split across buses ' + [...busesHit].join(','));
            }
        }

        // --- 4b. Diagnostics: detect segments assigned to more than one bus,
        // and report the input-vs-output camper totals. Any divergence here
        // is the root cause of downstream cross-bus camper duplication. ---
        {
            const segToBuses = {};
            for (const a of assignments) {
                const uniq = new Set(a.segmentIds);
                for (const sid of uniq) {
                    (segToBuses[sid] ||= []).push(a.busId);
                }
            }
            const dupedSegs = Object.entries(segToBuses).filter(([, bs]) => bs.length > 1);
            if (dupedSegs.length) {
                const sample = dupedSegs.slice(0, 5).map(([sid, bs]) => sid + '→[' + bs.join(',') + ']').join(' ');
                console.warn('[Go-NH] ⚠ ' + dupedSegs.length + ' segments assigned to >1 bus — sample: ' + sample);
            }
            const inTotal = workNhs.reduce((s, n) => s + (n.camperCount || 0), 0);
            const outTotal = assignments.reduce((s, a) => s + a.camperCount, 0);
            if (inTotal !== outTotal) {
                console.warn('[Go-NH] ⚠ camper total mismatch: workNhs=' + inTotal + ' assignments=' + outTotal);
            }
        }

        // --- 5. Strip bookkeeping fields before returning ---
        return assignments
            .filter(a => a.neighborhoodIds.length > 0)
            .map(a => {
                delete a._centroidSum;
                return a;
            });
    }

    // -------------------------------------------------------------------------
    // expandToPhysicalStops — turn each bus's segment list into physical drops.
    //
    // dropoffMode = 'door-to-door' (default): one stop per home, ordered along
    //   the segment (parameter t). Mirrors createHouseStops() shape.
    // dropoffMode = 'corner-stops': all homes on the same segment merge into
    //   ONE stop at the mean home location, with every camper on that segment
    //   bundled into its `campers` array. Mirrors createCornerStops() shape.
    // -------------------------------------------------------------------------
    function expandToPhysicalStops({ assignment, result, isArrival = false, dropoffMode = 'door-to-door' }) {
        const corner = dropoffMode === 'corner-stops';
        // Diagnostic: detect homes attached to segments that appear on more
        // than one bus. This is the precise upstream cause of cross-bus
        // camper duplication.
        {
            const segToBuses = {};
            for (const bus of assignment) {
                const uniq = new Set(bus.segmentIds);
                for (const sid of uniq) (segToBuses[sid] ||= new Set()).add(bus.busId);
            }
            let dupedHomeCount = 0;
            for (const seg of result.segments) {
                const bs = segToBuses[seg.id];
                if (bs && bs.size > 1) dupedHomeCount += seg.homes.length * (bs.size - 1);
            }
            if (dupedHomeCount > 0) {
                console.warn('[Go-NH] ⚠ expandToPhysicalStops: ' + dupedHomeCount + ' would-be duplicated home emissions (segments on multiple buses)');
            }
        }
        return assignment.map(bus => {
            const segById = Object.fromEntries(result.segments.map(s => [s.id, s]));
            const stops = [];
            // Dedup segment IDs inside a single bus so a segment listed twice
            // (from overlapping NH pieces, say) can't duplicate its homes.
            const uniqueSegIds = [];
            const seenOnBus = new Set();
            for (const sid of bus.segmentIds) {
                if (seenOnBus.has(sid)) continue;
                seenOnBus.add(sid);
                uniqueSegIds.push(sid);
            }
            const orderedSegIds = isArrival ? [...uniqueSegIds].reverse() : uniqueSegIds;
            for (const sid of orderedSegIds) {
                const seg = segById[sid];
                if (!seg || seg.homes.length === 0) continue;
                const ordered = [...seg.homes].sort((a, b) => (a.t - b.t) * (isArrival ? -1 : 1));
                if (corner) {
                    // Collapse all homes on this segment into one corner stop
                    // at the mean home location. Campers array holds everyone.
                    const meanLat = ordered.reduce((s, h) => s + h.lat, 0) / ordered.length;
                    const meanLng = ordered.reduce((s, h) => s + h.lng, 0) / ordered.length;
                    const addrCount = {};
                    for (const h of ordered) {
                        const a = h.address || (seg.name || 'unnamed');
                        addrCount[a] = (addrCount[a] || 0) + 1;
                    }
                    const topAddr = Object.entries(addrCount).sort((a, b) => b[1] - a[1])[0][0];
                    stops.push({
                        lat: meanLat, lng: meanLng,
                        address: (seg.name || topAddr) + ' corner',
                        segmentId: sid,
                        neighborhoodId: seg.neighborhoodId,
                        campers: ordered.map(h => ({ name: h.camperName, division: h.division, bunk: h.bunk })),
                    });
                } else {
                    for (const h of ordered) {
                        stops.push({
                            lat: h.lat, lng: h.lng,
                            address: h.address || (h.houseNum + ' ' + (seg.name || 'unnamed')),
                            segmentId: sid,
                            neighborhoodId: seg.neighborhoodId,
                            campers: [{ name: h.camperName, division: h.division, bunk: h.bunk }],
                        });
                    }
                }
            }
            return {
                busId: bus.busId, name: bus.name,
                stops, camperCount: bus.camperCount,
                segmentOrder: orderedSegIds,
                neighborhoodIds: bus.neighborhoodIds,
            };
        });
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------
    return {
        buildNeighborhoods,
        packIntoBuses,
        expandToPhysicalStops,
        // Exposed for testing / debug
        _internal: { buildGraph, detectNeighborhoods, spineOrder, hash, fetchRoadGraph },
    };
})();
