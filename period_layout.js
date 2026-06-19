// =============================================================================
// period_layout.js — generic-tile LAYOUT engine (manual-model-in-auto)
// =============================================================================
// The manual builder is simple because the human lays a SKELETON of generic
// tiles ("sport here 10:30-11:00, swim here, special here") and the computer
// only fills each tile with a concrete activity. Auto mode is hard because it
// historically decided BOTH the timing AND the content at once, activity-first,
// and the content gates (rotation / capacity / cooldown) would veto a placement
// and leave a hole — a LAYOUT failure caused by a CONTENT constraint.
//
// This module does the LAYOUT half only, the manual way: given a bunk's per-day
// DEMAND derived from the layers (1 swim+change, 1 lunch, 1 special·food,
// 1 special·shiur, N sports, ...), it lays GENERIC kind-labeled tiles wall-to-
// wall across each bell period — durations summing EXACTLY to the period via
// window.PeriodPacker — with NO activity chosen and NO content gates. A later
// FILL step drops a concrete activity into each generic tile; if a tile can't
// be filled it stays generic/"TBD", but the wall-to-wall layout never breaks.
//
// Pin rule (from the user): a demand whose layer TIME-WINDOW equals its DURATION
// has only one place it can sit, so it is PINNED (a wall). A demand whose window
// is wider than its duration FLOATS — the packer positions it. The caller passes
// `pinned` (already-placed walls) and `floating` (demands to position); this
// module never decides pinned-ness — it just tiles the free remainder.
//
// PURE by construction: reads only its inputs, returns a plan, mutates nothing.
// Layout is per-bunk INDEPENDENT (generic tiles don't compete for resources —
// only the later FILL step does), so there is no cross-bunk reservation here.
// node --test-able exactly like period_packer.js / period_orchestrator.js.
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

    // Subtract pinned walls overlapping [pStart,pEnd] → free [start,end] sub-windows.
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

    function _durRange(dMin, dMax, gran) {
        var lo = _num(dMin), hi = _num(dMax);
        if (lo == null && hi == null) return [];
        if (lo == null) lo = hi;
        if (hi == null) hi = lo;
        if (hi < lo) { var t = lo; lo = hi; hi = t; }
        var out = [];
        var start = Math.ceil(lo / gran) * gran;
        for (var d = start; d <= hi; d += gran) out.push(d);
        if (!out.length && hi >= gran) out.push(Math.floor(hi / gran) * gran);
        return out;
    }

    // A stable key per demand "kind" so the packer's allowRepeat=false dedupes
    // within a window (no two special·food, no two sports in one window) while a
    // kind may still recur across windows (a fresh pack() call per window).
    function _demandKey(d) {
        return d.kind === 'special' ? ('special:' + (d.subcat || 'uncategorized')) : (d.kind || 'sport');
    }

    function _label(d) {
        if (d.name) return d.name;
        if (d.kind === 'special') {
            var sc = d.subcat || 'uncategorized';
            return 'Special: ' + sc.charAt(0).toUpperCase() + sc.slice(1);
        }
        if (d.kind === 'sport') return 'Sport';
        return (d.kind || 'Activity').charAt(0).toUpperCase() + (d.kind || 'Activity').slice(1);
    }

    // Lay out ONE bunk's day: pinned walls stay; each non-break period's free
    // remainder is tiled wall-to-wall with generic tiles from `floating`.
    //
    //  pinned:   [{kind,subcat,name,startMin,endMin}]  already-placed walls
    //  floating: [{kind,subcat,name,durations?,dMin?,dMax?,window:[s,e],qty,score}]
    //            qty omitted/Infinity => unlimited filler (sports). window omitted
    //            => whole day. Specials should carry an exact qty (their floor).
    function planBunkLayout(ctx) {
        var packer = _getPacker(ctx);
        var opts = ctx.opts || {};
        var gran = opts.granularityMin || 5;
        var minSeg = opts.minSegmentMin || 10;
        var topN = opts.topN || 8;
        var maxSegments = opts.maxSegments || 4;

        var periods = (ctx.periods || []).filter(function (p) {
            return p && !p.isBreak && _num(p.startMin) != null && _num(p.endMin) != null && p.endMin > p.startMin;
        });
        var pinned = (ctx.pinned || []).filter(function (b) { return b && _num(b.startMin) != null && _num(b.endMin) != null; });
        var floating = ctx.floating || [];

        // remaining quota per demand key (specials = their floor; sport = Infinity)
        var remaining = {};
        floating.forEach(function (d) {
            var k = _demandKey(d);
            var q = (d.qty == null) ? Infinity : d.qty;
            remaining[k] = (remaining[k] == null) ? q : Math.max(remaining[k], q);
        });

        var tiles = pinned.map(function (b) {
            return { kind: b.kind || 'wall', subcat: b.subcat || null, name: b.name || b.event || b.kind || 'Block',
                     startMin: b.startMin, endMin: b.endMin, durationMin: b.endMin - b.startMin, generic: false, pinned: true };
        });

        var stats = { periodsConsidered: 0, windowsConsidered: 0, windowsTiled: 0, residualMin: 0, tilesPlaced: 0 };
        var periodPlans = [];

        if (!packer || typeof packer.pack !== 'function') {
            return { tiles: tiles, periodPlans: periodPlans, stats: stats, remaining: remaining, error: 'no-packer' };
        }

        function floorBonus(seg) {
            if (seg.kind !== 'special') return 0;
            return (remaining[seg._key] > 0) ? 1000 : 0;
        }
        function scoreFn(packing) {
            var total = 0;
            for (var i = 0; i < packing.segments.length; i++) {
                var s = packing.segments[i];
                total += (s.score || 0) + floorBonus(s);
            }
            total -= 0.01 * packing.segments.length; // prefer fewer/larger tiles (human-like)
            return total;
        }

        for (var pi = 0; pi < periods.length; pi++) {
            var period = periods[pi];
            stats.periodsConsidered++;
            var windows = freeSubWindows(period.startMin, period.endMin, tiles);
            var planWindows = [];
            for (var wi = 0; wi < windows.length; wi++) {
                var w = windows[wi];
                var len = w.end - w.start;
                stats.windowsConsidered++;
                var rec = { start: w.start, end: w.end, len: len, tiled: false, tiles: [], residualMin: len, reason: null };
                if (len % gran !== 0) { rec.reason = 'window-not-granular'; planWindows.push(rec); stats.residualMin += len; continue; }

                // candidates: each floating demand whose window covers this sub-window
                // and still has quota, expanded by each allowed duration that fits.
                var cands = [];
                for (var fi = 0; fi < floating.length; fi++) {
                    var d = floating[fi];
                    var key = _demandKey(d);
                    if (!(remaining[key] > 0)) continue;
                    var win = d.window;
                    if (win && (win[0] > w.start || win[1] < w.end)) continue; // demand window must cover the sub-window
                    var durs = (d.durations && d.durations.length) ? d.durations : _durRange(d.dMin, d.dMax, gran);
                    var seen = {};
                    for (var di = 0; di < durs.length; di++) {
                        var dur = durs[di];
                        if (_num(dur) == null || dur < minSeg || dur > len || dur % gran !== 0 || seen[dur]) continue;
                        seen[dur] = 1;
                        cands.push({ activity: key, durationMin: dur, kind: d.kind, subcat: d.subcat || null,
                                     name: _label(d), score: (typeof d.score === 'number' ? d.score : (d.kind === 'sport' ? 1 : 0)),
                                     _key: key, _ref: d });
                    }
                }
                if (!cands.length) { rec.reason = 'no-candidates'; planWindows.push(rec); stats.residualMin += len; continue; }

                var packings = [];
                try {
                    packings = packer.pack({ periodLengthMin: len, candidates: cands, granularityMin: gran, minSegmentMin: minSeg, allowRepeat: false, maxSegments: maxSegments, topN: topN, scoreFn: scoreFn }) || [];
                } catch (e) { rec.reason = 'pack-error:' + (e && e.message); planWindows.push(rec); stats.residualMin += len; continue; }
                if (!packings.length) { rec.reason = 'no-exact-tiling'; planWindows.push(rec); stats.residualMin += len; continue; }

                // LAYOUT has no content gates → take the best packing outright.
                var chosen = packings[0].segments;
                var cursor = w.start;
                for (var ci = 0; ci < chosen.length; ci++) {
                    var seg = chosen[ci];
                    var t = { kind: seg.kind, subcat: seg.subcat || null, name: seg.name,
                              startMin: cursor, endMin: cursor + seg.durationMin, durationMin: seg.durationMin,
                              generic: true, pinned: false };
                    tiles.push(t); rec.tiles.push(t);
                    if (seg.kind === 'special' && remaining[seg._key] > 0) remaining[seg._key]--;
                    cursor += seg.durationMin;
                    stats.tilesPlaced++;
                }
                rec.tiled = true; rec.residualMin = 0;
                stats.windowsTiled++;
                planWindows.push(rec);
            }
            periodPlans.push({ period: period, windows: planWindows });
        }

        tiles.sort(function (a, b) { return a.startMin - b.startMin; });
        return { tiles: tiles, periodPlans: periodPlans, stats: stats, remaining: remaining };
    }

    // Lay out all bunks (independent per bunk — no cross-bunk competition at the
    // LAYOUT stage). `perBunk` maps bunk -> ctx-like object.
    function planAllBunksLayout(o) {
        var order = o.order || Object.keys(o.perBunk || {});
        var opts = o.opts || {};
        var layoutByBunk = {};
        var totals = { bunks: 0, periodsConsidered: 0, windowsConsidered: 0, windowsTiled: 0, residualMin: 0, tilesPlaced: 0, bunksFullyTiled: 0, unmetSpecialFloors: 0 };
        for (var i = 0; i < order.length; i++) {
            var bunk = order[i];
            var b = (o.perBunk || {})[bunk];
            if (!b) continue;
            var res = planBunkLayout({
                bunk: bunk, grade: b.grade, periods: b.periods, pinned: b.pinned,
                floating: b.floating, opts: opts, packer: o.packer
            });
            layoutByBunk[bunk] = res;
            totals.bunks++;
            totals.periodsConsidered += res.stats.periodsConsidered;
            totals.windowsConsidered += res.stats.windowsConsidered;
            totals.windowsTiled += res.stats.windowsTiled;
            totals.residualMin += res.stats.residualMin;
            totals.tilesPlaced += res.stats.tilesPlaced;
            if (res.stats.windowsConsidered > 0 && res.stats.windowsTiled === res.stats.windowsConsidered) totals.bunksFullyTiled++;
            Object.keys(res.remaining || {}).forEach(function (k) { if (k.indexOf('special:') === 0 && res.remaining[k] > 0 && res.remaining[k] !== Infinity) totals.unmetSpecialFloors += res.remaining[k]; });
        }
        return { layoutByBunk: layoutByBunk, stats: totals };
    }

    var api = {
        VERSION: VERSION,
        freeSubWindows: freeSubWindows,
        planBunkLayout: planBunkLayout,
        planAllBunksLayout: planAllBunksLayout,
        _durRange: _durRange,
        _demandKey: _demandKey
    };

    if (typeof window !== 'undefined') {
        window.PeriodLayout = api;
        if (typeof console !== 'undefined') console.log('[PeriodLayout] v' + VERSION + ' loaded');
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})();
