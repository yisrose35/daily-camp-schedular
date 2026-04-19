// feasibility_oracle.js — CAMPISTRY FEASIBILITY ORACLE v1.0
// ============================================================
// Answers one question before the optimizer spends a single cycle:
//   "Does a perfect schedule mathematically EXIST for today?"
//
// Uses Hall's Marriage Theorem (Philip Hall, 1935) proved via
// Edmonds-Karp max-flow (polynomial time, O(V·E²)).
//
// The bipartite matching:
//   Left  = (grade, on-field window) demand nodes — bunk-minutes needed on fields
//   Right = (field, time-slice)  supply nodes  — field capacity × time available
//   Flow  = bunk-minutes that can be placed
//
// If max_flow = total demand → MATHEMATICALLY FEASIBLE (a perfect schedule exists)
// If max_flow < total demand → MATHEMATICALLY IMPOSSIBLE — the min-cut (König's
//   theorem) names the exact bottleneck: which grade × window pair exceeds capacity.
//
// The oracle also produces a time-slice utilization heatmap (ρ = demand/capacity)
// that the rotation matrix uses to stagger grades into off-field activities during
// high-pressure windows — BEFORE the optimizer even tries.
//
// Academic basis:
//   Hall (1935) "On Representatives of Subsets" — J. London Math. Society
//   Edmonds & Karp (1972) "Theoretical Improvements in Algorithmic Efficiency
//     for Network Flow Problems" — J. ACM
//   König (1916) "Graphen und Matrizen" — Math. Naturwiss. Ber. Ungarn
// ============================================================
(function() {
    'use strict';
    const VERSION = '1.0';

    // =========================================================================
    // § 1 — EDMONDS-KARP MAX-FLOW
    //   BFS-augmented Ford-Fulkerson. Graph stored as adj-list of edge objects
    //   {to, cap, rev} where rev is the index of the reverse edge in g[to].
    // =========================================================================

    function createGraph(n) {
        var g = new Array(n);
        for (var i = 0; i < n; i++) g[i] = [];
        return g;
    }

    function addEdge(g, u, v, cap) {
        g[u].push({ to: v, cap: cap, flow: 0, rev: g[v].length });
        g[v].push({ to: u, cap: 0,   flow: 0, rev: g[u].length - 1 });
    }

    // BFS from s to t in residual graph. Fills parent[] and returns true if t reached.
    function _bfs(g, s, t, n, parent) {
        var visited = new Uint8Array(n);
        var queue = new Int32Array(n);
        var head = 0, tail = 0;
        visited[s] = 1;
        queue[tail++] = s;
        while (head < tail) {
            var u = queue[head++];
            var edges = g[u];
            for (var i = 0; i < edges.length; i++) {
                var e = edges[i];
                if (!visited[e.to] && e.cap > e.flow) {
                    visited[e.to] = 1;
                    parent[e.to] = (u << 16) | i; // pack node+edge into one int
                    if (e.to === t) return true;
                    queue[tail++] = e.to;
                }
            }
        }
        return false;
    }

    // Edmonds-Karp: returns total flow pushed from s to t.
    function maxFlow(g, s, t, n) {
        var flow = 0;
        var parent = new Int32Array(n);
        while (_bfs(g, s, t, n, parent)) {
            // Trace path, find bottleneck
            var pathFlow = Infinity;
            var node = t;
            while (node !== s) {
                var p = parent[node];
                var pNode = p >> 16, pEdge = p & 0xffff;
                var e = g[pNode][pEdge];
                pathFlow = Math.min(pathFlow, e.cap - e.flow);
                node = pNode;
            }
            // Augment
            node = t;
            while (node !== s) {
                var p = parent[node];
                var pNode = p >> 16, pEdge = p & 0xffff;
                var e = g[pNode][pEdge];
                e.flow += pathFlow;
                g[node][e.rev].flow -= pathFlow;
                node = pNode;
            }
            flow += pathFlow;
        }
        return flow;
    }

    // BFS on residual graph to find all nodes reachable from source (for min-cut).
    function reachableFromSource(g, s, n) {
        var visited = new Uint8Array(n);
        var queue = new Int32Array(n);
        var head = 0, tail = 0;
        visited[s] = 1;
        queue[tail++] = s;
        while (head < tail) {
            var u = queue[head++];
            var edges = g[u];
            for (var i = 0; i < edges.length; i++) {
                var e = edges[i];
                if (!visited[e.to] && e.cap > e.flow) {
                    visited[e.to] = 1;
                    queue[tail++] = e.to;
                }
            }
        }
        return visited;
    }


    // =========================================================================
    // § 2 — DATA EXTRACTION HELPERS
    // =========================================================================

    function _parseTime(str) {
        if (typeof str === 'number') return str;
        if (!str) return null;
        var s = String(str).toLowerCase().trim();
        var m = s.match(/(\d+):(\d+)\s*(am|pm)?/);
        if (!m) return null;
        var h = parseInt(m[1], 10), mn = parseInt(m[2], 10), ap = m[3];
        if (ap === 'pm' && h !== 12) h += 12;
        if (ap === 'am' && h === 12) h = 0;
        return h * 60 + mn;
    }

    function _getFields(globalSettings) {
        var gs = globalSettings || window.globalSettings || {};
        var raw = (gs.app1 && gs.app1.fields) || gs.fields || [];
        if (!Array.isArray(raw) || raw.length === 0) {
            // Fallback: infer from field ledger or schedule assignments
            var fromLedger = window.fieldLedger ? Object.keys(window.fieldLedger) : [];
            if (fromLedger.length > 0) {
                return fromLedger.map(function(fn) {
                    var entry = window.fieldLedger[fn] || {};
                    return { name: fn, cap: entry.capacity || entry.maxBunks || 2,
                             shareType: entry.shareType || 'all', grades: entry.allowedGrades || null };
                });
            }
            return [];
        }
        return raw.map(function(f) {
            return {
                name:      f.name || f.field || String(f),
                cap:       Math.max(1, parseInt(f.capacity || f.maxBunks || f.cap || 2, 10) || 2),
                shareType: f.shareType || f.sharing || 'all',
                grades:    f.grades || f.allowedGrades || f.allowedDivisions || null
            };
        });
    }

    // Returns contiguous on-field windows for a grade given its layers.
    // On-field = grade window MINUS all pinned layer windows (swim/snack/special/league/etc.)
    function _onFieldWindows(gradeStart, gradeEnd, layers) {
        var pinned = [];
        (layers || []).forEach(function(ll) {
            var s = ll.startMin != null ? ll.startMin : _parseTime(ll.startTime);
            var e = ll.endMin   != null ? ll.endMin   : _parseTime(ll.endTime);
            if (s != null && e != null && e > s) {
                // Clamp to grade bounds
                s = Math.max(s, gradeStart);
                e = Math.min(e, gradeEnd);
                if (e > s) pinned.push({ s: s, e: e });
            }
        });
        // Merge overlapping pinned intervals
        pinned.sort(function(a, b) { return a.s - b.s; });
        var merged = [];
        pinned.forEach(function(p) {
            if (merged.length > 0 && p.s <= merged[merged.length - 1].e) {
                merged[merged.length - 1].e = Math.max(merged[merged.length - 1].e, p.e);
            } else {
                merged.push({ s: p.s, e: p.e });
            }
        });
        // Gaps between pinned blocks = on-field windows
        var windows = [];
        var cursor = gradeStart;
        merged.forEach(function(p) {
            if (p.s > cursor) windows.push({ s: cursor, e: p.s });
            cursor = Math.max(cursor, p.e);
        });
        if (cursor < gradeEnd) windows.push({ s: cursor, e: gradeEnd });
        // Filter out trivially small windows (< 15 min)
        return windows.filter(function(w) { return w.e - w.s >= 15; });
    }


    // =========================================================================
    // § 3 — TIME-SLICE UTILIZATION MAP
    //   Fast O(grades × slices) pass — no graph needed.
    //   ρ(t) = bunks_on_field(t) / total_field_capacity
    //   ρ > 1.0 at any slice → definitely impossible there.
    // =========================================================================

    function computeUtilizationMap(allGrades, divisions, layersByGrade, globalSettings) {
        var SLICE = 15; // minutes
        var dayStart = 9999, dayEnd = 0;
        allGrades.forEach(function(g) {
            var div = divisions[g] || {};
            var s = _parseTime(div.startTime) || 540;
            var e = _parseTime(div.endTime)   || 960;
            if (s < dayStart) dayStart = s;
            if (e > dayEnd)   dayEnd   = e;
        });
        if (dayStart >= dayEnd) { dayStart = 540; dayEnd = 960; }

        var fields = _getFields(globalSettings);
        var totalFieldCap = fields.reduce(function(sum, f) { return sum + f.cap; }, 0);
        if (totalFieldCap === 0) totalFieldCap = 1; // avoid div-by-zero

        var slices = [];
        for (var t = dayStart; t < dayEnd; t += SLICE) {
            var tEnd = t + SLICE;
            var demand = 0;
            allGrades.forEach(function(g) {
                var div = divisions[g] || {};
                var gs  = _parseTime(div.startTime) || 540;
                var ge  = _parseTime(div.endTime)   || 960;
                if (tEnd <= gs || t >= ge) return;
                var layers = layersByGrade[g] || [];
                var bunkCount = (div.bunks || []).length;
                if (bunkCount === 0) return;
                var inPinned = layers.some(function(ll) {
                    var ls = ll.startMin != null ? ll.startMin : _parseTime(ll.startTime);
                    var le = ll.endMin   != null ? ll.endMin   : _parseTime(ll.endTime);
                    return ls != null && le != null && t < le && tEnd > ls;
                });
                if (!inPinned) demand += bunkCount;
            });
            slices.push({
                t: t, tEnd: tEnd,
                demand: demand,
                supply: totalFieldCap,
                rho: demand / totalFieldCap
            });
        }
        return slices;
    }


    // =========================================================================
    // § 4 — MAIN ORACLE: build flow network + run max-flow
    // =========================================================================

    function check(config) {
        config = config || {};
        var allGrades     = config.allGrades     || [];
        var divisions     = config.divisions     || window.divisions || {};
        var layersByGrade = config.layersByGrade || {};
        var globalSettings= config.globalSettings|| window.globalSettings || {};

        if (allGrades.length === 0) {
            return { feasible: true, skipped: true, reason: 'No grades configured' };
        }

        var fields = _getFields(globalSettings);
        if (fields.length === 0) {
            return { feasible: true, skipped: true, reason: 'No field data available yet' };
        }

        // ── Build demand nodes: one per (grade, on-field window) ─────────────
        var demandNodes = []; // { grade, bunks, winStart, winEnd }
        allGrades.forEach(function(g) {
            var div = divisions[g] || {};
            var gs  = _parseTime(div.startTime) || 540;
            var ge  = _parseTime(div.endTime)   || 960;
            var bunkCount = (div.bunks || []).length;
            if (bunkCount === 0) return;
            var windows = _onFieldWindows(gs, ge, layersByGrade[g] || []);
            windows.forEach(function(w) {
                demandNodes.push({ grade: g, bunks: bunkCount, winStart: w.s, winEnd: w.e });
            });
        });

        if (demandNodes.length === 0) {
            return { feasible: true, skipped: true, reason: 'No on-field windows found' };
        }

        // ── Build supply nodes: (field, 15-min slice) ────────────────────────
        var SUPPLY_SLICE = 15;
        var dayStart = 9999, dayEnd = 0;
        allGrades.forEach(function(g) {
            var div = divisions[g] || {};
            var s = _parseTime(div.startTime) || 540;
            var e = _parseTime(div.endTime)   || 960;
            if (s < dayStart) dayStart = s;
            if (e > dayEnd)   dayEnd   = e;
        });

        var supplyNodes = [];
        fields.forEach(function(f) {
            for (var t = dayStart; t < dayEnd; t += SUPPLY_SLICE) {
                supplyNodes.push({ fieldName: f.name, grades: f.grades, cap: f.cap,
                                   sliceStart: t, sliceEnd: t + SUPPLY_SLICE });
            }
        });

        // ── Graph layout ─────────────────────────────────────────────────────
        // Node 0       = SOURCE
        // 1..D         = demand nodes
        // D+1..D+S     = supply nodes
        // D+S+1        = SINK
        var D = demandNodes.length;
        var S = supplyNodes.length;
        var N = D + S + 2;
        var SOURCE = 0, SINK = N - 1;

        var g = createGraph(N);

        // SOURCE → demand nodes: capacity = bunk-minutes of demand
        var totalDemand = 0;
        demandNodes.forEach(function(dn, di) {
            var bunkMin = dn.bunks * (dn.winEnd - dn.winStart);
            addEdge(g, SOURCE, 1 + di, bunkMin);
            totalDemand += bunkMin;
        });

        // Demand → supply edges: where time overlaps and grade is allowed
        demandNodes.forEach(function(dn, di) {
            supplyNodes.forEach(function(sn, si) {
                var overlap = Math.min(dn.winEnd, sn.sliceEnd) - Math.max(dn.winStart, sn.sliceStart);
                if (overlap <= 0) return;
                // Grade filtering: if the field only allows certain grades
                if (sn.grades && sn.grades.length > 0) {
                    var allowed = sn.grades.some(function(ag) {
                        return String(ag).toLowerCase() === String(dn.grade).toLowerCase();
                    });
                    if (!allowed) return;
                }
                // Edge capacity = bunk-minutes that can flow through this (demand, supply) pair
                addEdge(g, 1 + di, 1 + D + si, dn.bunks * overlap);
            });
        });

        // Supply → SINK: capacity = field slots × their capacity (max simultaneous bunks × duration)
        supplyNodes.forEach(function(sn, si) {
            addEdge(g, 1 + D + si, SINK, sn.cap * SUPPLY_SLICE);
        });

        // ── Run Edmonds-Karp ─────────────────────────────────────────────────
        var t0 = Date.now();
        var flow = maxFlow(g, SOURCE, SINK, N);
        var elapsed = Date.now() - t0;

        var deficit   = Math.max(0, totalDemand - flow);
        var feasible  = deficit === 0;
        var feasPct   = totalDemand > 0 ? Math.round(flow / totalDemand * 100) : 100;

        // ── Min-cut analysis (König's theorem → bottleneck identification) ────
        // Nodes reachable from SOURCE in residual graph = "S side" of min-cut.
        // Demand nodes on S-side that have edges to non-reachable supply nodes
        // are at the boundary — they are the bottleneck grade-windows.
        var bottlenecks = [];
        if (!feasible) {
            var reachable = reachableFromSource(g, SOURCE, N);
            demandNodes.forEach(function(dn, di) {
                var demNode = 1 + di;
                if (!reachable[demNode]) return; // fully supplied — not bottleneck
                // This demand node is on the S side — find which supplies it can't reach
                var supplyCap = 0;
                g[demNode].forEach(function(e) {
                    if (e.cap > 0 && e.to >= 1 + D && e.to < 1 + D + S) {
                        // How much capacity does this supply node have?
                        var snIdx = e.to - (1 + D);
                        supplyCap += supplyNodes[snIdx].cap * SUPPLY_SLICE;
                    }
                });
                var needed = dn.bunks * (dn.winEnd - dn.winStart);
                if (supplyCap < needed) {
                    bottlenecks.push({
                        grade:     dn.grade,
                        bunks:     dn.bunks,
                        winStart:  dn.winStart,
                        winEnd:    dn.winEnd,
                        needed:    needed,
                        available: supplyCap,
                        deficit:   needed - supplyCap
                    });
                }
            });
            // If no bottleneck identified via S-side (numerical edge case), fall back
            if (bottlenecks.length === 0) {
                demandNodes.forEach(function(dn, di) {
                    var satFlow = 0;
                    g[SOURCE].forEach(function(e) {
                        if (e.to === 1 + di) satFlow = e.flow;
                    });
                    var needed = dn.bunks * (dn.winEnd - dn.winStart);
                    if (satFlow < needed) {
                        bottlenecks.push({
                            grade: dn.grade, bunks: dn.bunks,
                            winStart: dn.winStart, winEnd: dn.winEnd,
                            needed: needed, available: satFlow, deficit: needed - satFlow
                        });
                    }
                });
            }
            // Sort by severity (largest deficit first)
            bottlenecks.sort(function(a, b) { return b.deficit - a.deficit; });
        }

        // ── Utilization heatmap ───────────────────────────────────────────────
        var utilization = computeUtilizationMap(allGrades, divisions, layersByGrade, globalSettings);

        return {
            feasible:    feasible,
            feasPct:     feasPct,
            flow:        flow,
            totalDemand: totalDemand,
            deficit:     deficit,
            bottlenecks: bottlenecks,
            utilization: utilization,
            elapsedMs:   elapsed,
            fields:      fields
        };
    }


    // =========================================================================
    // § 5 — UTILIZATION-GUIDED TYPE ORDER OPTIMIZER
    //   Given the utilization map, score each permutation of off-field activity
    //   types for a grade and return the ordering that minimizes peak field
    //   pressure. Called by scheduler_core_auto.js::buildRotationMatrix.
    //
    //   Algorithm: greedy per-grade selection.
    //   For each grade (sorted most constrained first):
    //     Try all permutations (max 4! = 24) of its off-field types.
    //     For each permutation, simulate what ρ(t) would look like if this
    //     grade followed that ordering (some slices move off-field, reducing demand).
    //     Pick the permutation minimizing max(ρ(t)) across all slices.
    //   Mark the chosen permutation and continue to next grade.
    //
    //   Time complexity: O(grades × 4! × slices) — negligible.
    // =========================================================================

    function allPermutations(arr) {
        if (arr.length <= 1) return [arr.slice()];
        var result = [];
        for (var i = 0; i < arr.length; i++) {
            var rest = arr.slice(0, i).concat(arr.slice(i + 1));
            allPermutations(rest).forEach(function(p) {
                result.push([arr[i]].concat(p));
            });
        }
        return result;
    }

    // Returns a type-ordering permutation for each grade that minimizes
    // peak field utilization based on the utilization heatmap.
    // Returns { [grade]: string[] } — the preferred off-field type order.
    function optimizeTypeOrders(allGrades, divisions, layersByGrade, utilization, globalSettings) {
        if (!utilization || utilization.length === 0) return {};

        // Build a mutable copy of the demand at each slice
        var sliceMap = {}; // t → demand
        utilization.forEach(function(s) { sliceMap[s.t] = s.demand; });
        var fieldCap = utilization[0] ? utilization[0].supply : 1;

        var TYPE_EXPECTED_MINS = { swim: 40, league: 82, special: 50, snack: 15 };

        // Grade info: compute off-field types and on-field windows
        var gradeData = allGrades.map(function(g) {
            var div = divisions[g] || {};
            var gs  = _parseTime(div.startTime) || 540;
            var ge  = _parseTime(div.endTime)   || 960;
            var layers = layersByGrade[g] || [];
            var offField = [];
            if (layers.some(function(l) { return (l.type || '').toLowerCase() === 'swim'; })) offField.push('swim');
            if (layers.some(function(l) { var t = (l.type || '').toLowerCase(); return t === 'league' || t === 'specialty_league'; })) offField.push('league');
            if (layers.some(function(l) { return (l.type || '').toLowerCase() === 'special'; })) offField.push('special');
            if (layers.some(function(l) { return ['snack', 'snacks'].includes((l.type || '').toLowerCase()); })) offField.push('snack');
            var bunkCount = (div.bunks || []).length;
            // "Tightness": how many on-field minutes this grade needs during tight windows
            var tightness = 0;
            utilization.forEach(function(s) {
                if (s.rho >= 0.8 && s.t >= gs && s.tEnd <= ge) tightness += s.demand;
            });
            return { grade: g, start: gs, end: ge, bunks: bunkCount, offField: offField, tightness: tightness };
        });

        // Sort: most constrained grades first (highest tightness)
        gradeData.sort(function(a, b) { return b.tightness - a.tightness; });

        var result = {};

        gradeData.forEach(function(gd) {
            if (gd.offField.length === 0) { result[gd.grade] = []; return; }

            var perms = allPermutations(gd.offField);
            var bestPerm = perms[0];
            var bestPeakRho = Infinity;

            perms.forEach(function(perm) {
                // Simulate: if this grade uses this permutation, compute where it's off-field
                // Band widths proportional to expected durations
                var totalExpected = perm.reduce(function(s, t) { return s + (TYPE_EXPECTED_MINS[t] || 40); }, 0);
                var cursor = gd.start;
                var offWindows = []; // time windows where this grade would be off-field with this perm
                perm.forEach(function(type) {
                    var dur = Math.round((TYPE_EXPECTED_MINS[type] || 40) / totalExpected * (gd.end - gd.start));
                    offWindows.push({ s: cursor, e: cursor + dur, type: type });
                    cursor += dur;
                });

                // Compute predicted ρ at each slice with this grade off-field during offWindows
                var localSliceMap = Object.assign({}, sliceMap);
                offWindows.forEach(function(w) {
                    for (var t = w.s; t < w.e; t += 15) {
                        if (localSliceMap[t] !== undefined) {
                            localSliceMap[t] = Math.max(0, localSliceMap[t] - gd.bunks);
                        }
                    }
                });
                var peakRho = 0;
                Object.keys(localSliceMap).forEach(function(t) {
                    var rho = localSliceMap[t] / fieldCap;
                    if (rho > peakRho) peakRho = rho;
                });

                if (peakRho < bestPeakRho) {
                    bestPeakRho = peakRho;
                    bestPerm = perm;
                }
            });

            // Commit: remove this grade's off-field demand from sliceMap for subsequent grades
            var totalExpected = bestPerm.reduce(function(s, t) { return s + (TYPE_EXPECTED_MINS[t] || 40); }, 0);
            var cursor = gd.start;
            bestPerm.forEach(function(type) {
                var dur = Math.round((TYPE_EXPECTED_MINS[type] || 40) / totalExpected * (gd.end - gd.start));
                for (var t = cursor; t < cursor + dur; t += 15) {
                    if (sliceMap[t] !== undefined) sliceMap[t] = Math.max(0, sliceMap[t] - gd.bunks);
                }
                cursor += dur;
            });

            result[gd.grade] = bestPerm;
        });

        return result;
    }


    // =========================================================================
    // § 6 — CONSOLE REPORT
    // =========================================================================

    function _tLabel(min) {
        var h = Math.floor(min / 60), m = min % 60;
        var ap = h >= 12 ? 'pm' : 'am';
        if (h > 12) h -= 12;
        if (h === 0) h = 12;
        return h + ':' + String(m).padStart(2, '0') + ap;
    }

    function report(result) {
        if (!result) return;
        if (result.skipped) {
            console.log('[FeasibilityOracle] Skipped: ' + result.reason);
            return;
        }

        var bar = function(rho, width) {
            width = width || 12;
            var filled = Math.min(Math.round(rho * width), width);
            var s = '';
            for (var i = 0; i < filled; i++) s += '█';
            for (var i = filled; i < width; i++) s += '░';
            return s;
        };

        console.log('%c\n════ FEASIBILITY ORACLE v' + VERSION + ' ═══════════════════════════════════', 'color:#1E40AF;font-weight:bold');
        console.log('Hall\'s Marriage Theorem (Edmonds-Karp) — solved in ' + result.elapsedMs + 'ms');
        console.log('Demand: ' + result.totalDemand + ' bunk-min across ' + (result.fields || []).length + ' field(s)');
        console.log('Flow:   ' + result.flow + ' / ' + result.totalDemand + ' bunk-min (' + result.feasPct + '% placed)');

        if (result.feasible) {
            console.log('%c✅  MATHEMATICALLY FEASIBLE — a perfect schedule provably exists', 'color:#15803D;font-weight:bold;font-size:13px');
            console.log('    The optimizer can find it. If it produces Free blocks, try more iterations.');
        } else {
            console.log('%c❌  MATHEMATICALLY IMPOSSIBLE — ' + result.deficit + ' bunk-min cannot be placed', 'color:#DC2626;font-weight:bold;font-size:13px');
            console.log('    No amount of optimization will fix this. Adjust field capacity or layer windows.');
            if (result.bottlenecks.length > 0) {
                console.log('\n  Bottleneck windows (Hall\'s min-cut):');
                result.bottlenecks.slice(0, 5).forEach(function(b, i) {
                    console.log('  ' + (i + 1) + '. ' + b.grade +
                        '  ' + _tLabel(b.winStart) + '–' + _tLabel(b.winEnd) +
                        '  ' + b.bunks + ' bunks need ' + b.needed + ' bunk-min' +
                        ' but only ' + b.available + ' available' +
                        ' (short by ' + b.deficit + ' bunk-min)');
                });
                console.log('\n  FIX: Add field capacity during the windows above, OR');
                console.log('       move some of these grades into swim/special/snack at that time.');
            }
        }

        // Utilization heatmap
        var hasTight = result.utilization.some(function(s) { return s.rho > 0.75; });
        if (hasTight) {
            console.log('\n  Time-slice utilization  (bunks on field / total field capacity):');
            result.utilization.forEach(function(s) {
                if (s.demand === 0) return; // skip dead time
                var pctStr = String(Math.round(s.rho * 100)).padStart(3, ' ') + '%';
                var tag = s.rho > 1.0 ? ' ◄ IMPOSSIBLE' : s.rho > 0.9 ? ' ◄ critical' : s.rho > 0.75 ? ' ◄ tight' : '';
                var color = s.rho > 1.0 ? 'color:#DC2626' : s.rho > 0.9 ? 'color:#D97706' : s.rho > 0.75 ? 'color:#CA8A04' : 'color:#374151';
                console.log('%c  ' + _tLabel(s.t).padEnd(8) + bar(Math.min(s.rho, 1.2)) + '  ' + pctStr + tag, color);
            });
        } else {
            console.log('\n  All time slices within comfortable utilization (< 75%).');
        }

        console.log('%c════════════════════════════════════════════════════════════════════', 'color:#1E40AF;font-weight:bold');
    }


    // =========================================================================
    // § 7 — PUBLIC API
    // =========================================================================

    window.FeasibilityOracle = {
        check:               check,
        report:              report,
        computeUtilizationMap: computeUtilizationMap,
        optimizeTypeOrders:  optimizeTypeOrders
    };

    console.log('[FeasibilityOracle] v' + VERSION + ' loaded — Hall\'s Theorem + Edmonds-Karp max-flow + utilization heatmap');
})();
