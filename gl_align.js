// =============================================================================
// gl_align.js — cluster UNIFORMLY-SHARABLE specials onto common bands (GENERIC-LAYOUT)
// =============================================================================
// PeriodLayout packs each bunk's tiles INDEPENDENTLY, so a uniformly cross_division
// special (e.g. "Theme Activity", 1 activity @ cap 15) ends up scattered across many
// start times → many under-filled shared "sessions". Worse, the fill-time staggered-
// sharing guard (_glCapFits / window.__alignShared) REJECTS a same-grade bunk that
// tries to join a shared session at a DIFFERENT start — so the scatter can't even be
// recovered at fill. This pass CLUSTERS such tiles before fill: it moves a bunk's
// off-band sharable-special tile onto a common band (where the special already runs
// with room under cap) by SWAPPING it with that same bunk's own equal-duration, same-
// time generic sport/activity tile. The special still happens (now on the shared band);
// the vacated slot becomes a Sport (fillable on a free field).
//
// SAFETY — a (kind,subcat,name) SWAP between two SAME-BUNK, EQUAL-DURATION tiles. Times
// NEVER move (the day stays wall-to-wall), per-bunk counts are preserved (each bunk
// keeps the same number of that-special tiles AND the same number of sports), and a
// band never exceeds the special's cap. Only generic (unfilled) tiles are touched.
//
// SCOPE — only UNIFORMLY cross_division subcats qualify (every activity in the subcat
// is cross_division, cap>1), so a generic tile of that subcat is GUARANTEED to fill
// with a sharable activity. A mixed subcat (uncategorized: Waterslides sharable but
// Arts&Crafts not) is excluded — pre-fill we can't know which it becomes. same_division
// sharables are left for a future pass (their bands must be single-grade).
//
// PLAN/EXECUTE + SHADOW/APPLY split: plan() is pure (mutates a lightweight view, returns
// the swaps + sessions-before/after per subcat) so the caller can SHADOW (log only) or
// APPLY (commit to the real tiles). Bounded loops, non-recursive — cannot hang. Mirrors
// gl_spread.js / gl_bandplan.js. Unit-tested in tests/gl_align.test.js.
// =============================================================================
(function () {
    'use strict';

    var VERSION = '0.1.0';

    function canonDefault(v) {
        var s = String(v == null ? '' : v).toLowerCase().trim();
        return (!s || s === 'regular' || s === 'uncategorized') ? 'uncategorized' : s;
    }

    // plan(ctx) → { subcats:[{key,cap,sessionsBefore,sessionsAfter,swaps:[{bunk,fromIdx,toIdx}]}], totalSwaps }
    // ctx: { bunks:[{tiles:[{kind,subcat,durationMin,startMin,endMin,generic,_concrete}]}],
    //        sharableSubcats:{canonSubcat:cap}, canon?, maxPasses? }
    function plan(ctx) {
        var bunks = (ctx && ctx.bunks) || [];
        var subcaps = (ctx && ctx.sharableSubcats) || {};
        var canon = (ctx && typeof ctx.canon === 'function') ? ctx.canon : canonDefault;
        var maxPasses = (ctx && ctx.maxPasses) || 24;

        // working view: mutable (kind, subcat); times immutable
        var view = bunks.map(function (b) {
            return ((b && b.tiles) || []).map(function (t) {
                return {
                    kind: t.kind, subcat: t.subcat, dur: t.durationMin, s: t.startMin, e: t.endMin,
                    swappable: (t.generic !== false) && !t._concrete
                };
            });
        });

        function distinctSessions(S) {
            var set = {};
            for (var bi = 0; bi < view.length; bi++) {
                var ts = view[bi];
                for (var ti = 0; ti < ts.length; ti++) {
                    var u = ts[ti];
                    if (u.kind === 'special' && canon(u.subcat) === S) set[u.s + '@' + u.e] = 1;
                }
            }
            return Object.keys(set).length;
        }
        function bunkHasSpecialAt(bi, S, T, Te) {
            var ts = view[bi];
            for (var ti = 0; ti < ts.length; ti++) {
                var u = ts[ti];
                if (u.kind === 'special' && canon(u.subcat) === S && u.s === T && u.e === Te) return true;
            }
            return false;
        }
        // a swappable sport/activity tile in THIS bunk sitting EXACTLY on band [T,Te]
        function findSwapTarget(bi, T, Te) {
            var ts = view[bi];
            for (var ti = 0; ti < ts.length; ti++) {
                var u = ts[ti];
                if ((u.kind === 'sport' || u.kind === 'activity') && u.swappable && u.s === T && u.e === Te) return ti;
            }
            return -1;
        }

        // group this subcat's special tiles by their band (start@end) → { s,e,dur,tiles:[{bi,ti}] }
        function gatherBands(S) {
            var bands = {};
            for (var bi = 0; bi < view.length; bi++) {
                var ts = view[bi];
                for (var ti = 0; ti < ts.length; ti++) {
                    var u = ts[ti];
                    if (u.kind !== 'special' || canon(u.subcat) !== S) continue;
                    var key = u.s + '@' + u.e;
                    (bands[key] = bands[key] || { s: u.s, e: u.e, dur: u.e - u.s, tiles: [] }).tiles.push({ bi: bi, ti: ti });
                }
            }
            return bands;
        }

        var out = [], totalSwaps = 0;
        Object.keys(subcaps).forEach(function (S) {
            var C = subcaps[S] || 0;
            if (!(C > 1)) return;
            var sessionsBefore = distinctSessions(S);
            var swaps = [];

            // CONSOLIDATE: each pass tries to EMPTY the smallest band — relocate ALL of its
            // tiles onto other reachable bands that have room — so the distinct-session count
            // actually drops by 1. A bunk's tile can only move to band B if that bunk has its
            // own swappable equal-duration sport sitting on B. Bounded: a successful pass
            // removes one band, so at most (#bands − 1) successful passes.
            for (var pass = 0; pass < maxPasses; pass++) {
                var bands = gatherBands(S);
                var keys = Object.keys(bands);
                if (keys.length <= 1) break;                 // already one session
                // smallest band first (fewest tiles to relocate), tie-break by start
                keys.sort(function (a, b) { return bands[a].tiles.length - bands[b].tiles.length || bands[a].s - bands[b].s; });

                var didEmpty = false;
                for (var si = 0; si < keys.length && !didEmpty; si++) {
                    var Bs = bands[keys[si]];
                    var tent = {};
                    keys.forEach(function (k) { tent[k] = bands[k].tiles.length; });
                    var moves = [], feasible = true;
                    for (var t = 0; t < Bs.tiles.length; t++) {
                        var src = Bs.tiles[t], placed = null;
                        for (var ki = 0; ki < keys.length; ki++) {
                            if (ki === si) continue;                       // not the source band
                            var Bt = bands[keys[ki]];
                            if (Bt.dur !== Bs.dur) continue;               // equal-duration band only
                            if (tent[keys[ki]] >= C) continue;             // target band at cap
                            if (bunkHasSpecialAt(src.bi, S, Bt.s, Bt.e)) continue; // no same-bunk dup
                            var tgt = findSwapTarget(src.bi, Bt.s, Bt.e);  // bunk's own sport on that band
                            if (tgt < 0) continue;
                            placed = { bi: src.bi, fromTi: src.ti, toTi: tgt, key: keys[ki] };
                            break;
                        }
                        if (!placed) { feasible = false; break; }
                        moves.push(placed);
                        tent[placed.key]++;
                    }
                    if (!feasible || moves.length !== Bs.tiles.length || !moves.length) continue;

                    // commit — each move swaps the bunk's special (fromTi) with its sport (toTi)
                    for (var k = 0; k < moves.length; k++) {
                        var mv = moves[k];
                        var fromU = view[mv.bi][mv.fromTi], toU = view[mv.bi][mv.toTi];
                        if (!fromU || !toU) continue;
                        if (!(fromU.kind === 'special' && canon(fromU.subcat) === S)) continue;          // stale
                        if (!((toU.kind === 'sport' || toU.kind === 'activity') && toU.swappable && toU.dur === fromU.dur)) continue; // stale
                        var k1 = fromU.kind, s1 = fromU.subcat;
                        fromU.kind = toU.kind; fromU.subcat = toU.subcat;
                        toU.kind = k1; toU.subcat = s1;
                        swaps.push({ bunk: mv.bi, fromIdx: mv.fromTi, toIdx: mv.toTi });
                        totalSwaps++;
                    }
                    didEmpty = true;
                }
                if (!didEmpty) break;
            }
            out.push({ key: S, cap: C, sessionsBefore: sessionsBefore, sessionsAfter: distinctSessions(S), swaps: swaps });
        });
        return { subcats: out, totalSwaps: totalSwaps };
    }

    // execute(ctx, planResult) — commit recorded swaps to the real tiles
    function execute(ctx, planResult) {
        var bunks = (ctx && ctx.bunks) || [];
        var n = 0;
        (planResult.subcats || []).forEach(function (sc) {
            (sc.swaps || []).forEach(function (r) {
                var tiles = (bunks[r.bunk] && bunks[r.bunk].tiles) || [];
                var fromT = tiles[r.fromIdx], toT = tiles[r.toIdx];
                if (!fromT || !toT) return;
                if (fromT.kind !== 'special') return;                                  // stale guard
                if (toT.kind !== 'sport' && toT.kind !== 'activity') return;
                if (fromT.durationMin !== toT.durationMin) return;
                if (fromT.generic === false || fromT._concrete) return;
                if (toT.generic === false || toT._concrete) return;
                // full (kind, subcat, name, _fillLoc) swap; times + generic flag stay put
                var k1 = fromT.kind, s1 = fromT.subcat, n1 = fromT.name, l1 = fromT._fillLoc;
                fromT.kind = toT.kind; fromT.subcat = toT.subcat; fromT.name = toT.name;
                fromT._fillLoc = toT._fillLoc != null ? toT._fillLoc : null; fromT._origin = 'align-vacate';
                toT.kind = k1; toT.subcat = s1; toT.name = n1;
                toT._fillLoc = l1 != null ? l1 : null; toT._origin = 'align-cluster';
                n++;
            });
        });
        return n;
    }

    function align(ctx) {
        var p = plan(ctx);
        var applied = 0;
        if (ctx && ctx.apply) applied = execute(ctx, p);
        return { plan: p, applied: applied };
    }

    var api = { VERSION: VERSION, plan: plan, execute: execute, align: align, canonDefault: canonDefault };

    if (typeof window !== 'undefined') {
        window.GLAlign = api;
        if (typeof console !== 'undefined') console.log('[GLAlign] v' + VERSION + ' loaded');
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})();
