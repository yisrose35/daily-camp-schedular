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
    // return null — they don't draw on category supply. Specials key by canon subcat;
    // with byDur, also by DURATION (e.g. 'special:uncategorized@30') because an activity
    // that only runs 40 min can't fill a 30-min slot — seats are per-length.
    function categoryOf(t, canon, byDur) {
        if (!t || !t.kind) return null;
        if (t.kind === 'special') {
            var sub = 'special:' + (canon ? canon(t.subcat) : canonDefault(t.subcat));
            if (byDur) { var d = (t.durationMin != null) ? t.durationMin : (t.endMin - t.startMin); sub += '@' + d; }
            return sub;
        }
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
        var byDur = !!(ctx && ctx.byDuration);
        var byCat = {};
        for (var b = 0; b < bunks.length; b++) {
            var tiles = (bunks[b] && bunks[b].tiles) || [];
            for (var t = 0; t < tiles.length; t++) {
                var tile = tiles[t];
                var k = categoryOf(tile, canon, byDur);
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

    // enforce(ctx) — HARD seat cap on the FINAL laid tiles, regardless of which pass
    // created them. For each UNFILLED generic special tile whose category is over its
    // seats at that moment (camp-wide OR for its grade), relabel it to a category that
    // still has room: SPORT first (if the spacing gate allows + sport is under its own
    // seats), else another special subcat the grade can access that is under cap. If
    // nothing has room, leave it (genuine over-capacity) and report it. Only UNFILLED
    // generic tiles are touched — a filled special (a real activity) is never moved, and
    // filled tiles are always ≤ seats anyway (you can't fill more than distinct activities).
    //   ctx: { bunks:[{grade,tiles}], seats:{cat:int}, seatsByGrade:{grade:{cat:int}},
    //          canon?, gate?(block,template)->bool, sportLabel='Sport' }
    // Returns { toSport, toOtherSpecial, left, violations:[{cat,grade,peak,cap,at}] }
    function enforce(ctx) {
        var bunks = (ctx && ctx.bunks) || [];
        var seats = (ctx && ctx.seats) || {};
        var byGrade = (ctx && ctx.seatsByGrade) || {};
        var canon = (ctx && ctx.canon) || canonDefault;
        var gate = (ctx && typeof ctx.gate === 'function') ? ctx.gate : null;
        var sportLabel = (ctx && ctx.sportLabel) || 'Sport';
        var byDur = !!(ctx && ctx.byDuration);
        var ents = [];
        bunks.forEach(function (b) { (b.tiles || []).forEach(function (t) { var c = categoryOf(t, canon, byDur); if (c) ents.push({ grade: b.grade, t: t, cat: c, tiles: b.tiles }); }); });
        function cap(cat) { return (seats[cat] != null && isFinite(seats[cat])) ? seats[cat] : Infinity; }
        function gcap(cat, grade) { var gm = byGrade[grade]; if (!gm) return Infinity; var v = gm[cat]; if (v != null && isFinite(v)) return v; return (cat.indexOf('special:') === 0) ? 0 : Infinity; }
        function conc(cat, s, e, grade) { var c = 0, g = 0; for (var i = 0; i < ents.length; i++) { var en = ents[i]; if (en.cat !== cat) continue; if (en.t.startMin < e && en.t.endMin > s) { c++; if (grade != null && en.grade === grade) g++; } } return { camp: c, grade: g }; }
        function toBlk(t) { return { type: t.kind, event: t.name || null, startMin: t.startMin, endMin: t.endMin }; }
        var toSport = 0, toOtherSpecial = 0, left = 0;
        for (var i = 0; i < ents.length; i++) {
            var en = ents[i], t = en.t;
            if (t.kind !== 'special' || t.generic === false || t._concrete) continue;  // only UNFILLED generic specials
            var cur = conc(en.cat, t.startMin, t.endMin, en.grade);
            if (!(cur.camp > cap(en.cat) || cur.grade > gcap(en.cat, en.grade))) continue;
            var target = null;
            // (1) sport — preferred (the user's "use the sports"), if under its seats + spacing-legal
            var sc = conc('sport', t.startMin, t.endMin, en.grade);
            if (sc.camp + 1 <= cap('sport')) {
                var ok = true;
                if (gate) { var tmpl = []; en.tiles.forEach(function (o) { if (o !== t) tmpl.push(toBlk(o)); }); try { ok = gate({ type: 'sport', event: sportLabel, startMin: t.startMin, endMin: t.endMin }, tmpl); } catch (e) { ok = true; } }
                if (ok) target = 'sport';
            }
            // (2) else another special subcat this grade can access that is under cap — and,
            //     when seats are duration-keyed, one that does THIS tile's length.
            if (!target) {
                var gm = byGrade[en.grade] || {};
                var keys = Object.keys(gm);
                var durSfx = byDur ? ('@' + ((t.durationMin != null) ? t.durationMin : (t.endMin - t.startMin))) : '';
                for (var k = 0; k < keys.length; k++) {
                    var ck = keys[k];
                    if (ck === en.cat || ck.indexOf('special:') !== 0 || !(gm[ck] > 0)) continue;
                    if (durSfx && ck.slice(-durSfx.length) !== durSfx) continue;   // must run this length
                    var cc = conc(ck, t.startMin, t.endMin, en.grade);
                    if (cc.camp + 1 <= cap(ck) && cc.grade + 1 <= gcap(ck, en.grade)) { target = ck; break; }
                }
            }
            if (!target) { left++; continue; }
            if (target === 'sport') { t.kind = 'sport'; t.subcat = null; t.name = sportLabel; t._fillLoc = null; en.cat = 'sport'; toSport++; }
            else { var body = target.slice(8); var at = body.indexOf('@'); var sub = at >= 0 ? body.slice(0, at) : body; t.subcat = sub; t.name = 'Special: ' + (sub.charAt(0).toUpperCase() + sub.slice(1)); en.cat = target; toOtherSpecial++; }
        }
        // AUDIT the final state: any category still over its seats (camp-wide or per-grade)?
        var violations = [];
        var seen = {};
        for (var j = 0; j < ents.length; j++) {
            var e2 = ents[j];
            if (e2.cat.indexOf('special:') !== 0 && e2.cat !== 'sport') continue;
            var c2 = conc(e2.cat, e2.t.startMin, e2.t.endMin, e2.grade);
            var campKey = e2.cat + '|camp';
            if (c2.camp > cap(e2.cat) && !seen[campKey]) { seen[campKey] = 1; violations.push({ cat: e2.cat, grade: null, peak: c2.camp, cap: cap(e2.cat), at: [e2.t.startMin, e2.t.endMin] }); }
            var gKey = e2.cat + '|' + e2.grade;
            if (c2.grade > gcap(e2.cat, e2.grade) && !seen[gKey]) { seen[gKey] = 1; violations.push({ cat: e2.cat, grade: e2.grade, peak: c2.grade, cap: gcap(e2.cat, e2.grade), at: [e2.t.startMin, e2.t.endMin] }); }
        }
        return { toSport: toSport, toOtherSpecial: toOtherSpecial, left: left, violations: violations };
    }

    return { VERSION: VERSION, canonDefault: canonDefault, categoryOf: categoryOf, sweep: sweep, peakOverlap: peakOverlap, measure: measure, enforce: enforce };
});

if (typeof window !== 'undefined' && window.console) {
    try { console.log('[GLBandPlan] v' + (window.GLBandPlan && window.GLBandPlan.VERSION) + ' loaded'); } catch (e) {}
}
