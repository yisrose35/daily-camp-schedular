// =============================================================================
// gl_stagger.js — within-bunk fill-aware restructure for the GENERIC-LAYOUT auto path
// =============================================================================
// After the generic fill assigns concrete specials to category tiles, some special
// tiles are left empty because at their CURRENT time every matching activity is at its
// sharing cap (cross-bunk collision: a grade's bunks clustered their specials on one
// band). This pass recovers those by SHUFFLING the day within each bunk: swap the empty
// special tile with an EQUAL-DURATION sport or special tile so the empty one lands on a
// time where its activity has free capacity, and the partner relocates to the empty one's
// old slot.
//
//   • SPORT partner  — a generic category placeholder (no concrete activity/field in the
//     generic path), so it simply moves; nothing to re-validate.
//   • SPECIAL partner — carries a concrete activity that must still fit at the empty tile's
//     old slot; keep it if it fits, else re-pick another activity of its subcat, else skip.
//
// Equal duration keeps the day wall-to-wall (two equal, disjoint intervals exchange
// positions — nothing else moves); both tiles must stay inside their layer windows; a swap
// commits ONLY when it does not reduce the number of filled tiles. Every sharing /
// uniqueness / duration rule stays strict — only TIME position changes.
//
// PURE: the caller injects capFits/recordUse/removeUse (which close over the cross-bunk
// usage map), specialDurs, and canon. This module mutates the passed tile objects in place
// and returns a summary. All bounded for-loops + non-recursive — it cannot blow the stack
// or loop forever (the v1 inline attempt threw "Maximum call stack size exceeded"; this
// rewrite is structured and unit-tested to prevent that).
// =============================================================================
(function () {
    'use strict';

    const VERSION = '0.1.0';

    // Does interval [s,e) fit inside tile t's layer window? (no window ⇒ unconstrained)
    function inWindow(t, s, e) {
        const w = t && t._ref && t._ref.window;
        if (!w) return true;
        return s >= w[0] && e <= w[1];
    }

    // Best free activity of subcat `sub` at duration `dur` that fits (cap-aware) at [s,e],
    // not already used by this bunk and not the excluded name. Returns the candidate or null.
    function pickActivity(ctx, bunk, sub, dur, s, e, used, excludeKey) {
        const pool = bunk.pool || [];
        for (let i = 0; i < pool.length; i++) {
            const c = pool[i];
            if (!c || !c.name) continue;
            if (ctx.canon(c.subcategory) !== sub) continue;
            const durs = ctx.specialDurs(c.name);
            if (durs && durs.length && durs.indexOf(dur) < 0) continue;
            const key = String(c.name).toLowerCase();
            if (used[key]) continue;
            if (excludeKey && key === excludeKey) continue;
            if (!ctx.capFits(c, bunk.grade, s, e)) continue;
            return c;
        }
        return null;
    }

    function swapTimes(a, b) {
        const as = a.startMin, ae = a.endMin;
        a.startMin = b.startMin; a.endMin = b.endMin;
        b.startMin = as; b.endMin = ae;
    }

    // restructure(ctx) — ctx:
    //   bunks: [{ grade, tiles:[{kind,generic,_concrete,_fillLoc,subcat,durationMin,startMin,endMin,_ref}], pool:[cand] }]
    //   capFits(cand, grade, s, e) -> bool
    //   recordUse(cand, grade, s, e) -> void
    //   removeUse(cand, grade, s, e) -> void
    //   specialDurs(name) -> number[]
    //   canon(v) -> string
    //   onRecover() -> void   (optional; called once per tile newly filled)
    // Returns { recovered, attempts, bunks }.
    function restructure(ctx) {
        let recovered = 0, attempts = 0;
        const bunks = (ctx && ctx.bunks) || [];
        for (let bi = 0; bi < bunks.length; bi++) {
            const bunk = bunks[bi];
            const tiles = (bunk && bunk.tiles) || [];
            if (!tiles.length) continue;
            const grade = bunk.grade;

            // names already concrete on this bunk's special tiles (no same-day repeat)
            const used = Object.create(null);
            for (let i = 0; i < tiles.length; i++) {
                const t = tiles[i];
                if (t && t.kind === 'special' && t._concrete) used[String(t._concrete).toLowerCase()] = 1;
            }
            // snapshot the empty special tiles (don't iterate a list we mutate-fill)
            const misses = [];
            for (let i = 0; i < tiles.length; i++) {
                const t = tiles[i];
                if (t && t.kind === 'special' && t.generic && !t._concrete) misses.push(t);
            }

            for (let mi = 0; mi < misses.length; mi++) {
                const miss = misses[mi];
                if (miss._concrete) continue;            // already filled as a partner-bonus
                const d = miss.durationMin;
                const subM = ctx.canon(miss.subcat);
                const sM = miss.startMin, eM = miss.endMin;

                for (let pj = 0; pj < tiles.length; pj++) {
                    const pt = tiles[pj];
                    if (!pt || pt === miss) continue;
                    if (pt.kind !== 'sport' && pt.kind !== 'special') continue;   // walls don't move
                    if (pt.durationMin !== d) continue;                            // equal dur ⇒ wall-to-wall safe
                    const s2 = pt.startMin, e2 = pt.endMin;
                    if (!inWindow(miss, s2, e2) || !inWindow(pt, sM, eM)) continue; // both stay in window
                    attempts++;

                    // the empty tile needs a free-capacity activity at the partner's (free) time
                    const a1 = pickActivity(ctx, bunk, subM, d, s2, e2, used, null);
                    if (!a1) continue;
                    const a1key = String(a1.name).toLowerCase();

                    if (pt.kind === 'sport') {
                        // generic placeholder → just move it; fill the empty tile at the freed time
                        swapTimes(miss, pt);
                        miss._concrete = a1.name; miss._fillLoc = a1.location || null;
                        used[a1key] = 1;
                        ctx.recordUse(a1, grade, miss.startMin, miss.endMin);
                        recovered++; if (ctx.onRecover) ctx.onRecover();
                        break;
                    }

                    // SPECIAL partner
                    if (pt._concrete) {
                        const a2 = { name: pt._concrete, location: pt._fillLoc || null };
                        ctx.removeUse(a2, grade, s2, e2);                 // free partner's slot for a clean test
                        let keepName = pt._concrete, keepLoc = pt._fillLoc || null, keepCand = a2, replaced = false;
                        if (!ctx.capFits(a2, grade, sM, eM)) {
                            const alt = pickActivity(ctx, bunk, ctx.canon(pt.subcat), d, sM, eM, used, a1key);
                            if (!alt) { ctx.recordUse(a2, grade, s2, e2); continue; } // restore; try next partner
                            keepCand = alt; keepName = alt.name; keepLoc = alt.location || null; replaced = true;
                        }
                        if (replaced) delete used[String(pt._concrete).toLowerCase()];
                        swapTimes(miss, pt);
                        miss._concrete = a1.name; miss._fillLoc = a1.location || null; used[a1key] = 1;
                        pt._concrete = keepName; pt._fillLoc = keepLoc; if (replaced) used[String(keepName).toLowerCase()] = 1;
                        ctx.recordUse(a1, grade, miss.startMin, miss.endMin);
                        ctx.recordUse(keepCand, grade, pt.startMin, pt.endMin);
                        recovered++; if (ctx.onRecover) ctx.onRecover();
                        break;
                    } else {
                        // both empty: move miss onto the free slot + opportunistically fill the partner
                        swapTimes(miss, pt);
                        miss._concrete = a1.name; miss._fillLoc = a1.location || null; used[a1key] = 1;
                        ctx.recordUse(a1, grade, miss.startMin, miss.endMin);
                        recovered++; if (ctx.onRecover) ctx.onRecover();
                        const a2 = pickActivity(ctx, bunk, ctx.canon(pt.subcat), d, pt.startMin, pt.endMin, used, a1key);
                        if (a2) {
                            pt._concrete = a2.name; pt._fillLoc = a2.location || null; used[String(a2.name).toLowerCase()] = 1;
                            ctx.recordUse(a2, grade, pt.startMin, pt.endMin);
                            recovered++; if (ctx.onRecover) ctx.onRecover();
                        }
                        break;
                    }
                }
            }
        }
        return { recovered: recovered, attempts: attempts, bunks: bunks.length };
    }

    // an OPEN tile = a generic, not-yet-filled special/sport/activity (re-tileable leftover).
    // Everything else — walls (swim/lunch/change/anchor/cleanup) and FILLED specials — is
    // FIXED: a layer the day must keep, and a boundary that breaks an open run.
    function _isOpen(t) { return t && (t.kind === 'special' || t.kind === 'sport' || t.kind === 'activity') && t.generic !== false && !t._concrete; }
    // map a tile to the rules-engine block shape the gate reads (matches period_layout._toBlock)
    function _toBlk(t) {
        var b = { type: t.kind, event: t.name || null, startMin: t.startMin, endMin: t.endMin };
        if (t.kind === 'special') { b._assignedSpecial = t.name; b._specialLocation = t.name; }
        return b;
    }

    // absorbUnfilledToSport(ctx) — finalize the day per the rule "if you can't fill a
    // special, use a sport — in big tiles, and respecting the rules." After fill + stagger,
    // the still-OPEN stretches (empty specials + the layout's generic sport filler) are
    // re-tiled into ≤ maxMergeMin (default 40) blocks; each block becomes a SPORT when the
    // camp's spacing gate allows one there (e.g. honoring "no Sport within 40 min of a
    // Sport / of lunch"), otherwise a generic Special. FILLED specials and walls are left
    // untouched (the layers the day must keep) and break the runs; a break (non-contiguous
    // gap) also breaks a run. Coverage preserved (wall-to-wall within each run). The gate is
    // checked against the bunk's fixed tiles + the sports already placed in this pass, so
    // the resulting Sports obey the same spacing the layout did.
    //   ctx: { bunks:[{tiles}], gate(block,template)->bool (optional), sportLabel='Sport',
    //          specialLabel='Special: Uncategorized', maxMergeMin=40 }
    function absorbUnfilledToSport(ctx) {
        var bunks = (ctx && ctx.bunks) || [];
        var gate = (ctx && typeof ctx.gate === 'function') ? ctx.gate : null;
        var label = (ctx && ctx.sportLabel) || 'Sport';
        var spLabel = (ctx && ctx.specialLabel) || 'Special: Uncategorized';
        var maxMerge = (ctx && ctx.maxMergeMin) || 40;
        var toSport = 0, toSpecial = 0, blockedBySpacing = 0;
        for (var bi = 0; bi < bunks.length; bi++) {
            var tiles = (bunks[bi] && bunks[bi].tiles) || [];
            var sorted = tiles.slice().sort(function (a, b) { return a.startMin - b.startMin; });
            var out = [];
            var tmpl = [];   // gate template: fixed tiles + decided blocks (grows as we place)
            for (var f = 0; f < sorted.length; f++) { if (!_isOpen(sorted[f])) tmpl.push(_toBlk(sorted[f])); }
            var k = 0;
            while (k < sorted.length) {
                if (!_isOpen(sorted[k])) { out.push(sorted[k]); k++; continue; }
                // maximal contiguous open run
                var runStart = sorted[k].startMin, runEnd = sorted[k].endMin, j = k + 1;
                while (j < sorted.length && _isOpen(sorted[j]) && sorted[j].startMin === runEnd) { runEnd = sorted[j].endMin; j++; }
                // re-tile [runStart,runEnd] into ≤maxMerge blocks, sport-where-gate-allows
                for (var cur = runStart; cur < runEnd; ) {
                    var blkEnd = Math.min(cur + maxMerge, runEnd);
                    var sportBlk = { type: 'sport', event: label, startMin: cur, endMin: blkEnd };
                    var allow = true;
                    if (gate) { try { allow = gate(sportBlk, tmpl); } catch (_e) { allow = true; } }
                    var tile;
                    if (allow) {
                        tile = { kind: 'sport', subcat: null, name: label, generic: true, startMin: cur, endMin: blkEnd, durationMin: blkEnd - cur, _ref: null };
                        toSport++;
                    } else {
                        tile = { kind: 'special', subcat: 'uncategorized', name: spLabel, generic: true, startMin: cur, endMin: blkEnd, durationMin: blkEnd - cur, _ref: null };
                        toSpecial++; blockedBySpacing++;
                    }
                    out.push(tile);
                    tmpl.push(_toBlk(tile));   // later blocks are spacing-checked against this one
                    cur = blkEnd;
                }
                k = j;
            }
            out.sort(function (a, b) { return a.startMin - b.startMin; });
            tiles.length = 0;
            Array.prototype.push.apply(tiles, out);
        }
        return { toSport: toSport, toSpecial: toSpecial, blockedBySpacing: blockedBySpacing };
    }

    const api = { VERSION: VERSION, restructure: restructure, inWindow: inWindow, absorbUnfilledToSport: absorbUnfilledToSport };

    if (typeof window !== 'undefined') {
        window.GLStagger = api;
        if (typeof console !== 'undefined') console.log('[GLStagger] v' + VERSION + ' loaded');
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})();
