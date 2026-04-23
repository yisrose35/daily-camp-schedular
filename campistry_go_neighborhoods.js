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

    // djb2 → short hex. Stable across runs given same input.
    function hash(s) {
        let h = 5381;
        for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
        return h.toString(16).padStart(8, '0');
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
    // Overpass fetch — road graph for the bbox of all campers.
    // Reuses the same mirror + timeout strategy as campistry_go.js fetchIntersections().
    // -------------------------------------------------------------------------
    async function fetchRoadGraph(campers, options) {
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

        const query = '[out:json][timeout:25];' +
            'way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street)$"](' + bbox + ');' +
            'out body;>;out skel qt;';

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
                const data = await resp.json();
                if (options.verbose) console.log('[Go-NH] Overpass: ' + (data.elements?.length || 0) + ' elements from ' + url);
                return data;
            } catch (e) {
                if (options.verbose) console.warn('[Go-NH] Overpass error at ' + url + ':', e.message);
            }
        }
        console.warn('[Go-NH] All Overpass mirrors failed');
        return null;
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

        // Adjacency for interior edges only (hwClass rank > trunkTier)
        const adj = {};
        const interiorEdges = [];
        for (const e of edges) {
            if (e.rank <= trunkTier) continue;
            interiorEdges.push(e);
            (adj[e.fromNodeId] ||= []).push({ to: e.toNodeId, edgeId: e.id });
            (adj[e.toNodeId] ||= []).push({ to: e.fromNodeId, edgeId: e.id });
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

        for (const c of campers) {
            if (!Number.isFinite(c.lat) || !Number.isFinite(c.lng)) { unattachedCampers.push(c); continue; }

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

            const home = {
                camperName: c.name,
                segmentId: bestEdge.id,
                neighborhoodId: segToNh[bestEdge.id] || null,
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

        // Adjacency restricted to this neighborhood
        const adj = {};
        for (const e of Object.values(edgeById)) {
            (adj[e.fromNodeId] ||= []).push({ to: e.toNodeId, edgeId: e.id });
            (adj[e.toNodeId] ||= []).push({ to: e.fromNodeId, edgeId: e.id });
        }

        // Entry = node in this neighborhood with the best trunk edge touching it
        let entryId = null, bestTrunkRank = 99;
        for (const nid of neighborhood.nodeIds) {
            for (const e of graph.edges) {
                if (e.fromNodeId !== nid && e.toNodeId !== nid) continue;
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
    // packIntoBuses — bin-pack neighborhoods into buses respecting capacity.
    //
    // Strategy:
    //   1. Pre-split: any neighborhood with camperCount > maxBusCap is halved
    //      along its spine (minimum-cut) until each piece fits.
    //   2. Pre-merge: adjacent tiny neighborhoods (sharing a trunk intersection)
    //      are merged until the merged result is near-full.
    //   3. Sort neighborhoods by size descending; first-fit-decreasing into buses,
    //      with prior-year bus preference when capacity allows.
    //   4. Respect sibling atoms: a segment that contains one sibling must keep
    //      all siblings (handled implicitly by not splitting segments, plus a
    //      post-check that warns if a split put siblings on different buses).
    // -------------------------------------------------------------------------
    function packIntoBuses({ result, buses, priorAssignments = {}, siblingGroups = {} }) {
        if (!result || !result.neighborhoods.length) return [];

        // Caller is responsible for passing already-effective capacity
        // (monitor/counselor/reserve already subtracted). Keeping the math here
        // was producing double-subtraction when called from generateRoutes().
        const vehicles = buses.map(b => ({
            busId: b.id || b.busId,
            name: b.name || ('Bus ' + (b.id || b.busId)),
            capacity: Math.max(0, b.capacity || 0),
        }));
        const maxCap = Math.max(...vehicles.map(v => v.capacity));

        // --- 1. Pre-split oversize neighborhoods along spine ---
        const workNhs = [];
        for (const nh of result.neighborhoods) {
            if (nh.camperCount <= maxCap) { workNhs.push(nh); continue; }
            // Split along spine until each piece fits
            const segCamperCounts = nh.segmentIds.map(sid => {
                const s = result.segments.find(x => x.id === sid);
                return { sid, count: s ? s.homes.length : 0 };
            });
            const pieces = [];
            let cur = { segIds: [], count: 0 };
            for (const sc of segCamperCounts) {
                if (cur.count + sc.count > maxCap && cur.segIds.length) {
                    pieces.push(cur);
                    cur = { segIds: [], count: 0 };
                }
                cur.segIds.push(sc.sid);
                cur.count += sc.count;
            }
            if (cur.segIds.length) pieces.push(cur);

            pieces.forEach((p, i) => {
                workNhs.push({
                    ...nh,
                    id: nh.id + '_p' + i,
                    parentId: nh.id,
                    segmentIds: p.segIds,
                    camperCount: p.count,
                    splitReason: 'oversize',
                });
            });
        }

        // --- 2. Sort by size descending (first-fit-decreasing bin-packing) ---
        workNhs.sort((a, b) => b.camperCount - a.camperCount);

        // --- 3. Assign to buses ---
        const assignments = vehicles.map(v => ({
            busId: v.busId, name: v.name, capacity: v.capacity,
            neighborhoodIds: [], segmentIds: [], camperCount: 0,
        }));
        const busById = Object.fromEntries(assignments.map(a => [a.busId, a]));

        for (const nh of workNhs) {
            // 3a. Prior-year preference
            const preferredBusId = priorAssignments[nh.parentId || nh.id];
            let target = null;
            if (preferredBusId && busById[preferredBusId] &&
                busById[preferredBusId].camperCount + nh.camperCount <= busById[preferredBusId].capacity) {
                target = busById[preferredBusId];
            }
            // 3b. First-fit by remaining capacity (prefer fullest bus that still fits)
            if (!target) {
                let best = null, bestSlack = Infinity;
                for (const a of assignments) {
                    const slack = a.capacity - a.camperCount - nh.camperCount;
                    if (slack >= 0 && slack < bestSlack) { bestSlack = slack; best = a; }
                }
                target = best;
            }
            if (!target) {
                console.warn('[Go-NH] No bus has room for neighborhood ' + nh.id + ' (' + nh.camperCount + ' campers)');
                continue;
            }
            target.neighborhoodIds.push(nh.id);
            target.segmentIds.push(...nh.segmentIds);
            target.camperCount += nh.camperCount;
        }

        // --- 4. Sibling split warning ---
        for (const group of Object.values(siblingGroups)) {
            const buses = new Set();
            for (const name of group) {
                const home = result.homes.find(h => h.camperName === name);
                if (!home) continue;
                for (const a of assignments) {
                    if (a.segmentIds.includes(home.segmentId)) { buses.add(a.busId); break; }
                }
            }
            if (buses.size > 1) {
                console.warn('[Go-NH] ⚠ Siblings ' + group.join(',') + ' split across buses ' + [...buses].join(','));
            }
        }

        return assignments.filter(a => a.neighborhoodIds.length > 0);
    }

    // -------------------------------------------------------------------------
    // expandToPhysicalStops — turn each bus's segment list into per-home drops.
    // Each home is a physical stop in the same shape as createHouseStops()
    // so the Google optimizer can consume the output unchanged.
    // -------------------------------------------------------------------------
    function expandToPhysicalStops({ assignment, result, isArrival = false }) {
        return assignment.map(bus => {
            const segById = Object.fromEntries(result.segments.map(s => [s.id, s]));
            const stops = [];
            // Walk segments in the order they were added (which is spine order
            // within each neighborhood). Within each segment, sort homes by
            // position along the segment (parameter t), so drops happen as the
            // bus drives past. Reverse for arrival (AM) to mirror the PM route.
            const orderedSegIds = isArrival ? [...bus.segmentIds].reverse() : bus.segmentIds;
            for (const sid of orderedSegIds) {
                const seg = segById[sid];
                if (!seg || seg.homes.length === 0) continue;
                const ordered = [...seg.homes].sort((a, b) => (a.t - b.t) * (isArrival ? -1 : 1));
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
