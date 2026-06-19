// =============================================================================
// period_orchestrator.js — per-bunk, per-period exact-tiling orchestrator
// =============================================================================
// The human scheduler fills each bell PERIOD wall-to-wall by stacking short
// pieces whose durations sum EXACTLY to the period (e.g. 2:15-2:55 =
// food(10) + sport(10) + food(20)). Our solver instead pins specials, fills
// leftover gaps with one sport, and abandons the sub-min remainder — leaving
// within-period gaps.
//
// This module wraps the finished, unit-tested exact subset-sum primitive
// `window.PeriodPacker.pack()` with the glue it never had: per bunk, per
// non-break period, it builds a candidate pool (sports + specials × their
// configured durations), packs the free remainder around already-pinned walls
// into an exact tiling, then picks the best packing whose every segment passes
// the injected HARD gates (field capacity/access, special sharing/capacity).
//
// PURE by construction: this module reads only its inputs + injected gate
// callbacks and returns a plan. It NEVER mutates window state — the CALLER
// (scheduler_core_auto.js) decides whether to apply the plan. That makes it
// node --test-able exactly like period_packer.js.
//
// See plan: period tiling (PeriodOrchestrator). Phase A = shadow (plan + log).
// =============================================================================
(function () {
    'use strict';

    var VERSION = '0.1.0';

    function _getPacker(opts) {
        if (opts && opts.packer) return opts.packer;
        if (typeof window !== 'undefined' && window.PeriodPacker) return window.PeriodPacker;
        if (typeof require === 'function') { try { return require('./period_packer.js'); } catch (e) { /* ignore */ } }
        return null;
    }

    function _num(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }

    // Subtract pinned walls (and any occupied block) overlapping [pStart,pEnd]
    // → list of free [start,end] sub-windows, left-to-right. `occupied` is a
    // list of {startMin,endMin}. Anything < 0 length is dropped.
    function freeSubWindows(pStart, pEnd, occupied) {
        var blocks = (occupied || [])
            .filter(function (b) { return b && _num(b.startMin) != null && _num(b.endMin) != null && b.endMin > pStart && b.startMin < pEnd; })
            .map(function (b) { return { s: Math.max(pStart, b.startMin), e: Math.min(pEnd, b.endMin) }; })
            .sort(function (a, b) { return a.s - b.s; });
        var out = [];
        var cursor = pStart;
        for (var i = 0; i < blocks.length; i++) {
            if (blocks[i].s > cursor) out.push({ start: cursor, end: blocks[i].s });
            if (blocks[i].e > cursor) cursor = blocks[i].e;
        }
        if (cursor < pEnd) out.push({ start: cursor, end: pEnd });
        return out.filter(function (w) { return w.end - w.start > 0; });
    }

    // Build the flat candidate list (one entry per (activity,duration)) for a
    // sub-window of length `len`. Pure. `sports`/`specials` are pre-collected by
    // the caller; `usedToday` excludes activities the bunk already has (no
    // same-day repeat); `remaining` drives the subcategory-floor bonus.
    function buildPeriodCandidates(o) {
        var len = o.len;
        var minSeg = o.minSegmentMin || 10;
        var gran = o.granularityMin || 5;
        var sports = o.sports || [];
        var specials = o.specials || [];
        var used = o.usedToday || {};
        var out = [];

        function okDur(d) { return _num(d) != null && d >= minSeg && d <= len && d % gran === 0; }

        for (var si = 0; si < sports.length; si++) {
            var sp = sports[si];
            if (!sp || !sp.name || used[String(sp.name).toLowerCase()]) continue;
            var sdurs = (sp.durations && sp.durations.length) ? sp.durations
                : _durRange(sp.dMin, sp.dMax, gran);
            var seenS = {};
            for (var d1 = 0; d1 < sdurs.length; d1++) {
                var dS = sdurs[d1];
                if (!okDur(dS) || seenS[dS]) continue;
                seenS[dS] = 1;
                out.push({
                    activity: 'sport:' + sp.name, durationMin: dS,
                    score: (typeof sp.baseScore === 'number' ? sp.baseScore : 0),
                    kind: 'sport', name: sp.name, fields: sp.fields || [],
                    dIdeal: sp.dIdeal, subcategoryKey: null, _ref: sp
                });
            }
        }
        for (var xi = 0; xi < specials.length; xi++) {
            var spc = specials[xi];
            if (!spc || !spc.name || used[String(spc.name).toLowerCase()]) continue;
            var xdurs = (spc.durations && spc.durations.length) ? spc.durations
                : _durRange(spc.dMin, spc.dMax, gran);
            var seenX = {};
            for (var d2 = 0; d2 < xdurs.length; d2++) {
                var dX = xdurs[d2];
                if (!okDur(dX) || seenX[dX]) continue;
                seenX[dX] = 1;
                out.push({
                    activity: 'special:' + spc.name, durationMin: dX,
                    score: (typeof spc.baseScore === 'number' ? spc.baseScore : 0),
                    kind: 'special', name: spc.name, location: spc.location || spc.name,
                    subcategoryKey: spc.subcategoryKey || 'uncategorized', _ref: spc
                });
            }
        }
        return out;
    }

    function _durRange(dMin, dMax, gran) {
        var lo = _num(dMin), hi = _num(dMax);
        if (lo == null && hi == null) return [];
        if (lo == null) lo = hi;
        if (hi == null) hi = lo;
        if (hi < lo) { var t = lo; lo = hi; hi = t; }
        var out = [];
        // align lo up to a granularity multiple
        var start = Math.ceil(lo / gran) * gran;
        for (var d = start; d <= hi; d += gran) out.push(d);
        if (!out.length && hi >= gran) out.push(Math.floor(hi / gran) * gran);
        return out;
    }

    // Plan one bunk's day: tile each non-break period's free remainder.
    // Returns { periodPlans:[{period, windows:[{start,end,tiled,segments,residualMin}]}],
    //           stats:{periodsConsidered, windowsConsidered, windowsTiled, residualMin},
    //           usedToday }
    // gates: { validateSport(name,fields,start,end)->field|null,
    //          validateSpecial(name,location,start,end)->bool,
    //          onReserve(seg) }  — all optional; absent gate => accept (shadow).
    function planBunkPeriods(ctx) {
        var packer = _getPacker(ctx);
        var opts = ctx.opts || {};
        var gran = opts.granularityMin || 5;
        var minSeg = opts.minSegmentMin || 10;
        var topN = opts.topN || 6;
        var maxSegments = opts.maxSegments || 4;
        var gates = ctx.gates || {};
        var periods = (ctx.periods || []).filter(function (p) { return p && !p.isBreak && _num(p.startMin) != null && _num(p.endMin) != null && p.endMin > p.startMin; });
        var sports = ctx.sports || [];
        var specials = ctx.specials || [];
        var floors = ctx.floors || {};            // { subcategoryKey: requiredCount }
        var remaining = {};                       // running unmet floor, tapers as we place
        Object.keys(floors).forEach(function (k) { remaining[k] = floors[k]; });
        var usedToday = {};                       // lowercased activity names already on this bunk's day
        (ctx.alreadyOnDay || []).forEach(function (n) { if (n) usedToday[String(n).toLowerCase()] = 1; });

        var periodPlans = [];
        var stats = { periodsConsidered: 0, windowsConsidered: 0, windowsTiled: 0, residualMin: 0, segmentsPlaced: 0 };

        if (!packer || typeof packer.pack !== 'function') {
            return { periodPlans: periodPlans, stats: stats, usedToday: usedToday, error: 'no-packer' };
        }

        // floor bonus: strong while a demanded subcategory is unmet, 0 once met.
        function floorBonus(seg) {
            if (seg.kind !== 'special') return 0;
            var k = seg.subcategoryKey || 'uncategorized';
            return (remaining[k] > 0) ? 1000 : 0;
        }
        function scoreFn(packing) {
            var total = 0;
            for (var i = 0; i < packing.segments.length; i++) {
                var s = packing.segments[i];
                total += (s.score || 0) + floorBonus(s);
                if (typeof s.dIdeal === 'number' && s.durationMin === s.dIdeal) total += 5;
            }
            // prefer fewer/larger segments (human-like) as a mild tie-break
            total -= 0.01 * packing.segments.length;
            return total;
        }

        for (var pi = 0; pi < periods.length; pi++) {
            var period = periods[pi];
            stats.periodsConsidered++;
            var windows = freeSubWindows(period.startMin, period.endMin, ctx.occupied || []);
            var planWindows = [];
            for (var wi = 0; wi < windows.length; wi++) {
                var w = windows[wi];
                var len = w.end - w.start;
                stats.windowsConsidered++;
                var rec = { start: w.start, end: w.end, len: len, tiled: false, segments: [], residualMin: len, reason: null };
                if (len % gran !== 0) { rec.reason = 'window-not-granular'; planWindows.push(rec); stats.residualMin += len; continue; }
                var candidates = buildPeriodCandidates({ len: len, minSegmentMin: minSeg, granularityMin: gran, sports: sports, specials: specials, usedToday: usedToday });
                if (!candidates.length) { rec.reason = 'no-candidates'; planWindows.push(rec); stats.residualMin += len; continue; }

                var packings = [];
                try {
                    packings = packer.pack({ periodLengthMin: len, candidates: candidates, granularityMin: gran, minSegmentMin: minSeg, allowRepeat: false, maxSegments: maxSegments, topN: topN, scoreFn: scoreFn }) || [];
                } catch (e) { rec.reason = 'pack-error:' + (e && e.message); planWindows.push(rec); stats.residualMin += len; continue; }
                if (!packings.length) { rec.reason = 'no-packing'; planWindows.push(rec); stats.residualMin += len; continue; }

                var chosen = _firstValidPacking(packings, w.start, gates, usedToday);
                if (!chosen) { rec.reason = 'no-valid-packing'; planWindows.push(rec); stats.residualMin += len; continue; }

                // commit (to the plan + local running state, NOT window)
                rec.tiled = true; rec.residualMin = 0; rec.segments = chosen;
                for (var ci = 0; ci < chosen.length; ci++) {
                    var seg = chosen[ci];
                    usedToday[String(seg.name).toLowerCase()] = 1;
                    if (seg.kind === 'special') {
                        var k2 = seg.subcategoryKey || 'uncategorized';
                        if (remaining[k2] > 0) remaining[k2]--;
                    }
                    if (typeof gates.onReserve === 'function') { try { gates.onReserve(seg); } catch (e) { /* ignore */ } }
                    stats.segmentsPlaced++;
                }
                stats.windowsTiled++;
                planWindows.push(rec);
            }
            periodPlans.push({ period: period, windows: planWindows });
        }
        return { periodPlans: periodPlans, stats: stats, usedToday: usedToday, unmetFloors: remaining };
    }

    // Walk packings best-first; lay segments left-to-right from windowStart and
    // assign each a concrete time + field via the gates. First packing whose
    // every segment validates wins. Returns the placed segment list or null.
    function _firstValidPacking(packings, windowStart, gates, usedToday) {
        for (var pi = 0; pi < packings.length; pi++) {
            var segs = packings[pi].segments;
            var placed = [];
            var localUsed = {};
            var cursor = windowStart;
            var ok = true;
            for (var si = 0; si < segs.length; si++) {
                var seg = segs[si];
                var nm = String(seg.name).toLowerCase();
                if (usedToday[nm] || localUsed[nm]) { ok = false; break; }
                var segStart = cursor, segEnd = cursor + seg.durationMin;
                if (seg.kind === 'sport') {
                    var field = (typeof gates.validateSport === 'function')
                        ? gates.validateSport(seg.name, seg.fields || [], segStart, segEnd)
                        : ((seg.fields && seg.fields[0]) || null);
                    if (field === false || field == null) { ok = false; break; }
                    placed.push({ kind: 'sport', name: seg.name, field: field, startMin: segStart, endMin: segEnd, durationMin: seg.durationMin, _ref: seg._ref });
                } else {
                    var good = (typeof gates.validateSpecial === 'function')
                        ? gates.validateSpecial(seg.name, seg.location, segStart, segEnd)
                        : true;
                    if (!good) { ok = false; break; }
                    placed.push({ kind: 'special', name: seg.name, field: seg.location, location: seg.location, subcategoryKey: seg.subcategoryKey, startMin: segStart, endMin: segEnd, durationMin: seg.durationMin, _ref: seg._ref });
                }
                localUsed[nm] = 1;
                cursor = segEnd;
            }
            if (ok && placed.length) return placed;
        }
        return null;
    }

    // Plan all bunks in the given order, threading a cross-bunk reservation map
    // through the gates the caller provides. `perBunk` maps bunk -> a ctx-like
    // object ({grade, periods, occupied, sports, specials, floors, alreadyOnDay}).
    // `makeGates(bunk, grade)` returns the gate object for that bunk (the caller
    // closes over its own reservation state). Returns { planByBunk, stats }.
    function planAllBunks(o) {
        var order = o.order || Object.keys(o.perBunk || {});
        var opts = o.opts || {};
        var planByBunk = {};
        var totals = { bunks: 0, periodsConsidered: 0, windowsConsidered: 0, windowsTiled: 0, residualMin: 0, segmentsPlaced: 0, bunksFullyTiled: 0 };
        for (var i = 0; i < order.length; i++) {
            var bunk = order[i];
            var b = (o.perBunk || {})[bunk];
            if (!b) continue;
            var gates = (typeof o.makeGates === 'function') ? o.makeGates(bunk, b.grade) : {};
            var res = planBunkPeriods({
                bunk: bunk, grade: b.grade, periods: b.periods, occupied: b.occupied,
                sports: b.sports, specials: b.specials, floors: b.floors,
                alreadyOnDay: b.alreadyOnDay, gates: gates, opts: opts, packer: o.packer
            });
            planByBunk[bunk] = res;
            totals.bunks++;
            totals.periodsConsidered += res.stats.periodsConsidered;
            totals.windowsConsidered += res.stats.windowsConsidered;
            totals.windowsTiled += res.stats.windowsTiled;
            totals.residualMin += res.stats.residualMin;
            totals.segmentsPlaced += res.stats.segmentsPlaced;
            if (res.stats.windowsConsidered > 0 && res.stats.windowsTiled === res.stats.windowsConsidered) totals.bunksFullyTiled++;
        }
        return { planByBunk: planByBunk, stats: totals };
    }

    var api = {
        VERSION: VERSION,
        buildPeriodCandidates: buildPeriodCandidates,
        freeSubWindows: freeSubWindows,
        planBunkPeriods: planBunkPeriods,
        planAllBunks: planAllBunks,
        _durRange: _durRange
    };

    if (typeof window !== 'undefined') {
        window.PeriodOrchestrator = api;
        if (typeof console !== 'undefined') console.log('[PeriodOrchestrator] v' + VERSION + ' loaded');
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})();
