// gl_bandplan.js — per-band category SPREAD for the GENERIC-LAYOUT auto path.
//
// THE CONCEPT (user's "perfect day"): a day has a few rotating activity categories
// (sport, special:uncategorized, special:food, special:theme, …) plus the shareable
// swim. With N grades, if too many grades want the SAME category at the SAME time
// band, that category's concurrent demand exceeds its SUPPLY (most concrete specials
// are not_sharable cap-1) and the tiles can't fill ("capacity-stuck"). The fix is to
// SPREAD the grades across categories per band so each category's concurrent demand
// stays <= its supply — serialize a scarce category (e.g. theme, supply 1) across
// different time bands, and let shareable swim/sport absorb the overflow.
//
// This module is PURE (no DOM, no globals) and unit-tested. PHASE 0 ships `measure()`
// (shadow, measure-only) — it reports where grades collide. PHASE 1 will add `plan()`
// (the actual category→band assignment) consuming the same inputs.
//
// Nothing here is hardcoded to a grade count or a category count: supply is a
// {categoryKey -> seats} map and categories are discovered from the tiles.
(function (root, factory) {
    var mod = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = mod;
    if (root) root.GLBandPlan = mod;
})(typeof window !== 'undefined' ? window : this, function () {
    'use strict';
    var VERSION = '0.1.0';

    // default subcat canonicalizer (mirrors scheduler_core_auto._glCanon): blank / "regular"
    // / "uncategorized" all collapse to "uncategorized"; everything else lower-cased+trimmed.
    function canonDefault(v) {
        var s = String(v == null ? '' : v).toLowerCase().trim();
        return (!s || s === 'regular' || s === 'uncategorized') ? 'uncategorized' : s;
    }

    // The category a tile competes for. Walls (lunch/change/cleanup/main/anchor/league…)
    // return null — they don't draw on category supply. Specials key by canon subcat.
    function categoryOf(t, canon) {
        if (!t || !t.kind) return null;
        if (t.kind === 'special') return 'special:' + (canon ? canon(t.subcat) : canonDefault(t.subcat));
        if (t.kind === 'sport') return 'sport';
        if (t.kind === 'swim') return 'swim';
        if (t.kind === 'activity') return 'activity';
        return null;
    }

    // Sweep a set of [s,e) intervals into maximal constant-concurrency segments {s,e,c}.
    // O(n^2) but n is tiny per category. Touching intervals ([0,40),[40,80)) do NOT overlap.
    function sweep(ivals) {
        var pts = {};
        for (var i = 0; i < ivals.length; i++) { pts[ivals[i][0]] = 1; pts[ivals[i][1]] = 1; }
        var xs = Object.keys(pts).map(Number).sort(function (a, b) { return a - b; });
        var segs = [];
        for (var k = 0; k + 1 < xs.length; k++) {
            var s = xs[k], e = xs[k + 1], c = 0;
            for (var j = 0; j < ivals.length; j++) { if (ivals[j][0] <= s && ivals[j][1] >= e) c++; }
            segs.push({ s: s, e: e, c: c });
        }
        return segs;
    }

    // Peak concurrency of a set of intervals + a representative window where it holds.
    function peakOverlap(ivals) {
        var segs = sweep(ivals), peak = 0, at = null;
        for (var i = 0; i < segs.length; i++) { if (segs[i].c > peak) { peak = segs[i].c; at = [segs[i].s, segs[i].e]; } }
        return { peak: peak, at: at };
    }

    // measure(ctx) — MEASURE-ONLY (no mutation). For each category, peak concurrent demand
    // across all bunks vs its supply, and the windows where demand exceeds supply.
    //   ctx: { bunks:[{tiles:[{kind,subcat,startMin,endMin}]}], supply:{categoryKey:int}, canon? }
    //   supply omitted for a category ⇒ Infinity (a shareable absorber like sport/swim never "over").
    // Returns { cats:{ key:{count,peak,peakAt,supply,over,overWindows:[{s,e,demand}],overMin} },
    //           overCats:[key…], totalOverMin }
    function measure(ctx) {
        var bunks = (ctx && ctx.bunks) || [];
        var supply = (ctx && ctx.supply) || {};
        var canon = (ctx && ctx.canon) || canonDefault;
        var byCat = {};
        for (var b = 0; b < bunks.length; b++) {
            var tiles = (bunks[b] && bunks[b].tiles) || [];
            for (var t = 0; t < tiles.length; t++) {
                var tile = tiles[t];
                var k = categoryOf(tile, canon);
                if (!k) continue;
                (byCat[k] = byCat[k] || []).push([tile.startMin, tile.endMin]);
            }
        }
        var cats = {}, overCats = [], totalOverMin = 0;
        Object.keys(byCat).forEach(function (k) {
            var ivals = byCat[k];
            var segs = sweep(ivals);
            var peak = 0, peakAt = null;
            segs.forEach(function (g) { if (g.c > peak) { peak = g.c; peakAt = [g.s, g.e]; } });
            var hasSup = Object.prototype.hasOwnProperty.call(supply, k) && supply[k] != null && isFinite(supply[k]);
            var sup = hasSup ? supply[k] : Infinity;
            var ow = [], cur = null, overMin = 0;
            segs.forEach(function (g) {
                if (g.c > sup) {
                    overMin += (g.e - g.s) * (g.c - sup);
                    if (cur && cur.e === g.s) { cur.e = g.e; if (g.c > cur.demand) cur.demand = g.c; }
                    else { cur = { s: g.s, e: g.e, demand: g.c }; ow.push(cur); }
                } else cur = null;
            });
            cats[k] = {
                count: ivals.length, peak: peak, peakAt: peakAt,
                supply: hasSup ? sup : null,
                over: hasSup ? Math.max(0, peak - sup) : 0,
                overWindows: ow, overMin: overMin
            };
            if (hasSup && peak > sup) { overCats.push(k); totalOverMin += overMin; }
        });
        overCats.sort(function (a, b) { return cats[b].overMin - cats[a].overMin; });
        return { cats: cats, overCats: overCats, totalOverMin: totalOverMin };
    }

    return { VERSION: VERSION, canonDefault: canonDefault, categoryOf: categoryOf, sweep: sweep, peakOverlap: peakOverlap, measure: measure };
});

if (typeof window !== 'undefined' && window.console) {
    try { console.log('[GLBandPlan] v' + (window.GLBandPlan && window.GLBandPlan.VERSION) + ' loaded'); } catch (e) {}
}
