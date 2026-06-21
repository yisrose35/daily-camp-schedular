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

    const VERSION = '0.2.0';

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

    // Any free activity (ANY subcat) of exactly `dur` minutes that still fits (cap-aware) at
    // [s,e] for this bunk and isn't already used by it. Used by absorb's STEP-3 fallback: when
    // a Sport is spacing-blocked, place a REAL special that still has a seat instead of a dead
    // generic placeholder ("aware of what step-2 took"). Returns the candidate or null.
    //   allowRepeat (sportless repeat-fill): when no UNUSED special fits, a second pass
    //   accepts a special the bunk already did today — so a sports-free camp with few
    //   distinct specials still fills the day with REAL specials instead of a dead
    //   placeholder. Pass 1 (prefer unused) keeps variety; pass 2 only repeats as needed.
    function pickAnyFillable(ctx, bunk, dur, s, e, used, allowRepeat) {
        const pool = (bunk && bunk.pool) || [];
        // pass 1 — prefer a special this bunk has NOT done today (variety)
        for (let i = 0; i < pool.length; i++) {
            const c = pool[i];
            if (!c || !c.name) continue;
            const durs = ctx.specialDurs ? ctx.specialDurs(c.name) : null;
            if (durs && durs.length && durs.indexOf(dur) < 0) continue;
            const key = String(c.name).toLowerCase();
            if (used[key]) continue;
            if (ctx.capFits && !ctx.capFits(c, bunk.grade, s, e)) continue;
            return c;
        }
        // pass 2 — repeat allowed: accept an already-used special that still has a seat
        if (allowRepeat) {
            for (let i = 0; i < pool.length; i++) {
                const c = pool[i];
                if (!c || !c.name) continue;
                const durs = ctx.specialDurs ? ctx.specialDurs(c.name) : null;
                if (durs && durs.length && durs.indexOf(dur) < 0) continue;
                if (ctx.capFits && !ctx.capFits(c, bunk.grade, s, e)) continue;
                return c;
            }
        }
        return null;
    }

    // SPLIT FALLBACK: a [s,end] block that can take NO spacing-legal sport AND no single
    // full-length special is the dead "Special: Uncategorized" the user flagged. But a 40-min
    // gap can often be covered by TWO shorter specials (e.g. theme@20 + food@20) drawn from
    // pools that still have seats — the human "do the smaller specials for some bunks." This
    // recursively tiles [s,end] with 2+ DISTINCT fillable specials (each a free seat, cap-aware
    // via ctx.capFits inside pickAnyFillable, no same-day repeat via `used`), largest pieces
    // first (fewer/bigger tiles, human-like). Returns the committed sub-tiles (recordUse done +
    // `used` marked) or null if it can't FULLY cover the block (then it stays dead — never worse).
    // Pieces are strictly SHORTER than the block (the full length already failed), so ≥2 pieces.
    function _absSplitFill(ctx, bunk, s, end, used, canon) {
        var MENU = [30, 20, 10];          // sub-tile lengths (standard 10-min grid; pickAnyFillable filters by what exists)
        var span = end - s;
        var picks = [];
        function rec(pos) {
            if (pos === end) return true;
            for (var mi = 0; mi < MENU.length; mi++) {
                var d = MENU[mi];
                if (d >= span) continue;       // a piece must be shorter than the whole block
                if (pos + d > end) continue;
                var pk = pickAnyFillable(ctx, bunk, d, pos, pos + d, used);
                if (!pk) continue;
                var nm = String(pk.name).toLowerCase();
                used[nm] = 1;                   // tentatively reserve (no same-day repeat across pieces)
                picks.push({ pick: pk, s: pos, e: pos + d, dur: d });
                if (rec(pos + d)) return true;
                picks.pop(); delete used[nm];   // backtrack
            }
            return false;
        }
        var ok = rec(s);
        if (!ok || picks.length < 2) {
            for (var p = 0; p < picks.length; p++) delete used[String(picks[p].pick.name).toLowerCase()];
            return null;
        }
        var tiles = [];
        for (var q = 0; q < picks.length; q++) {
            var P = picks[q];
            try { ctx.recordUse(P.pick, bunk.grade, P.s, P.e); } catch (_e) {}
            tiles.push({ kind: 'special', subcat: canon(P.pick.subcategory), name: P.pick.name, _concrete: P.pick.name, _fillLoc: P.pick.location || null, generic: false, startMin: P.s, endMin: P.e, durationMin: P.dur, _ref: null, _origin: 'absorb-split' });
        }
        return tiles;
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
    //   ctx: { bunks:[{tiles, grade, pool}], gate(block,template)->bool (optional),
    //          sportLabel='Sport', specialLabel='Special: Uncategorized', maxMergeMin=40,
    //          // STEP-3 real-fill fallback (all optional; when present, a Sport-blocked block
    //          // is filled with a REAL special that still has a seat before a dead placeholder):
    //          capFits(cand,grade,s,e)->bool, recordUse(cand,grade,s,e), specialDurs(name)->[], canon(v)->str,
    //          probeReorder:bool (measure-only — report per dead window whether a movable sport blocks it) }
    //   bunk objects may carry .name (used only by the reorder probe's per-window detail).
    function absorbUnfilledToSport(ctx) {
        var bunks = (ctx && ctx.bunks) || [];
        var gate = (ctx && typeof ctx.gate === 'function') ? ctx.gate : null;
        var label = (ctx && ctx.sportLabel) || 'Sport';
        var spLabel = (ctx && ctx.specialLabel) || 'Special: Uncategorized';
        var maxMerge = (ctx && ctx.maxMergeMin) || 40;
        var canon = (ctx && typeof ctx.canon === 'function') ? ctx.canon : function (v) { return String(v || '').toLowerCase().trim(); };
        var canFill = !!(ctx && typeof ctx.capFits === 'function' && typeof ctx.recordUse === 'function');
        // SPLIT FALLBACK (ctx.splitFill): cover a stuck block with 2+ shorter specials before
        // dropping it dead. Strictly additive — only fires where a dead placeholder would land.
        var canSplit = canFill && !!(ctx && ctx.splitFill);
        var toSplitFilled = 0;
        // SPORTLESS MODE (per-bunk bunk.noSport): a grade with NO sport layer must never get
        // a "Sport" block — skip the sport step so open time goes to a REAL special (fill →
        // split → repeat) and only a neutral placeholder as last resort. allowRepeatFill lets
        // a sports-free day fill with REAL specials (repeating when its few distinct specials
        // run out) rather than leaving dead placeholders.
        var allowRepeatFill = !!(ctx && ctx.allowRepeatFill);
        var toRepeatFilled = 0;
        // REORDER FEASIBILITY PROBE (measure-only, ctx.probeReorder): for every dead "kept"
        // window, decide whether it is blocked SOLELY by a MOVABLE generic sport (a reorder
        // could relocate that sport and free a properly-spaced sport here) or by a WALL
        // (lunch/swim/anchor — no reorder can help; the only lever is config: more seats/cap).
        // Read-only: it never mutates a tile, it only hypothesizes removing one movable sport
        // from the spacing template and re-tests the gate. This is the necessary condition for
        // the reorder the user asked for; if it comes back ~0 the dead tiles are wall-bound.
        var probeReorder = !!(ctx && ctx.probeReorder);
        var probeFeasible = 0, probeWallStuck = 0, probeDetail = [];
        var toSport = 0, toSpecial = 0, blockedBySpacing = 0, toFilledSpecial = 0;
        for (var bi = 0; bi < bunks.length; bi++) {
            var bunk = bunks[bi] || {};
            var tiles = bunk.tiles || [];
            var bunkNoSport = !!bunk.noSport;   // sportless grade → never emit a Sport block
            var sorted = tiles.slice().sort(function (a, b) { return a.startMin - b.startMin; });
            // names already concrete on this bunk's special tiles (no same-day repeat)
            var used = Object.create(null);
            for (var u = 0; u < sorted.length; u++) { var ut = sorted[u]; if (ut && ut.kind === 'special' && ut._concrete) used[String(ut._concrete).toLowerCase()] = 1; }
            var out = [];
            var tmpl = [];   // gate template: fixed tiles + decided blocks (grows as we place)
            var tmplMeta = []; // parallel to tmpl: true ⇔ a MOVABLE generic sport (a reorder candidate)
            for (var f = 0; f < sorted.length; f++) { if (!_isOpen(sorted[f])) { tmpl.push(_toBlk(sorted[f])); tmplMeta.push(false); } }
            var k = 0;
            while (k < sorted.length) {
                if (!_isOpen(sorted[k])) { out.push(sorted[k]); k++; continue; }
                // maximal contiguous open run
                var runStart = sorted[k].startMin, runEnd = sorted[k].endMin, j = k + 1;
                while (j < sorted.length && _isOpen(sorted[j]) && sorted[j].startMin === runEnd) { runEnd = sorted[j].endMin; j++; }
                // re-tile [runStart,runEnd] into ≤maxMerge blocks: Sport where the spacing gate
                // allows; else a REAL special that still has a free seat (STEP 3 — aware of what
                // fill already took); else a generic placeholder (genuine last resort).
                for (var cur = runStart; cur < runEnd; ) {
                    var blkEnd = Math.min(cur + maxMerge, runEnd);
                    var dur = blkEnd - cur;
                    var sportBlk = { type: 'sport', event: label, startMin: cur, endMin: blkEnd };
                    var allow = true;
                    if (bunkNoSport) { allow = false; }   // sportless grade → force the special path (never a Sport block)
                    else if (gate) { try { allow = gate(sportBlk, tmpl); } catch (_e) { allow = true; } }
                    var tile = null;
                    if (allow) {
                        tile = { kind: 'sport', subcat: null, name: label, generic: true, startMin: cur, endMin: blkEnd, durationMin: dur, _ref: null, _origin: 'absorb-sport' };
                        toSport++;
                    } else if (canFill) {
                        // Sport spacing-blocked → place a REAL special of this exact length that
                        // still has a seat (cap-aware), instead of a dead "Special: Uncategorized".
                        var pick = pickAnyFillable(ctx, bunk, dur, cur, blkEnd, used);
                        if (pick) {
                            tile = { kind: 'special', subcat: canon(pick.subcategory), name: pick.name, _concrete: pick.name, _fillLoc: pick.location || null, generic: false, startMin: cur, endMin: blkEnd, durationMin: dur, _ref: null, _origin: 'absorb-fill' };
                            used[String(pick.name).toLowerCase()] = 1;
                            try { ctx.recordUse(pick, bunk.grade, cur, blkEnd); } catch (_e) {}
                            toFilledSpecial++;
                        }
                    }
                    if (!tile) {
                        // PROBE (measure-only): this window took no sport (spacing gate) AND no free
                        // special seat → it WILL become a dead placeholder. Before recording it, decide
                        // whether a reorder could ever rescue it: hypothesize removing each movable generic
                        // sport (within the cooldown radius) from the template and re-test the sport gate.
                        // If ANY single removal makes the gate pass, the window is blocked by a relocatable
                        // sport (RELOCATABLE); else it is blocked by a wall (WALL-STUCK). Pure read-only.
                        if (probeReorder && gate) {
                            var _pBlk = { type: 'sport', event: label, startMin: cur, endMin: blkEnd };
                            var _pFeasible = false;
                            for (var _pi = 0; _pi < tmpl.length; _pi++) {
                                if (!tmplMeta[_pi]) continue;                                   // only movable generic sports
                                var _pb = tmpl[_pi];
                                if (!(_pb.startMin < blkEnd + maxMerge && _pb.endMin > cur - maxMerge)) continue; // outside cooldown radius → not a blocker
                                var _pMinus = tmpl.slice(0, _pi).concat(tmpl.slice(_pi + 1));
                                var _pOk = true; try { _pOk = gate(_pBlk, _pMinus); } catch (_pe) { _pOk = true; }
                                if (_pOk) { _pFeasible = true; break; }
                            }
                            if (_pFeasible) probeFeasible++; else probeWallStuck++;
                            if (probeDetail.length < 60) probeDetail.push({ bunk: (bunk.name || ('bunk#' + bi)), s: cur, e: blkEnd, feasible: _pFeasible });
                        }
                        // ── SPLIT FALLBACK: before going dead, try to cover this block with 2+
                        // shorter REAL specials drawn from pools that still have seats (the "do the
                        // smaller specials for some bunks" fix). If it fully covers, emit those tiles
                        // and skip the dead drop entirely.
                        if (canSplit) {
                            var _splitTiles = _absSplitFill(ctx, bunk, cur, blkEnd, used, canon);
                            if (_splitTiles && _splitTiles.length) {
                                for (var _si = 0; _si < _splitTiles.length; _si++) {
                                    var _stl = _splitTiles[_si];
                                    out.push(_stl);
                                    tmpl.push(_toBlk(_stl));
                                    tmplMeta.push(false);
                                }
                                toSplitFilled += _splitTiles.length;
                                cur = blkEnd;
                                continue;   // covered by splits → no dead tile for this block
                            }
                        }
                        // SPORTLESS REPEAT-FILL: a sports-free camp with few distinct specials
                        // can run out of UNUSED specials before the day is full. Rather than a
                        // dead placeholder (or a Sport this camp can't staff), fill with a REAL
                        // special the bunk already did today — a same-day repeat is the lesser
                        // evil in a camp that has no sports. Only fires when explicitly enabled
                        // (window.__sportlessRepeatFill) for a sportless bunk.
                        if (!tile && allowRepeatFill && bunkNoSport && canFill) {
                            var rpick = pickAnyFillable(ctx, bunk, dur, cur, blkEnd, used, true);
                            if (rpick) {
                                tile = { kind: 'special', subcat: canon(rpick.subcategory), name: rpick.name, _concrete: rpick.name, _fillLoc: rpick.location || null, generic: false, startMin: cur, endMin: blkEnd, durationMin: dur, _ref: null, _origin: 'absorb-repeat' };
                                try { ctx.recordUse(rpick, bunk.grade, cur, blkEnd); } catch (_e) {}
                                toRepeatFilled++;
                            }
                        }
                        if (tile) { out.push(tile); tmpl.push(_toBlk(tile)); tmplMeta.push(false); cur = blkEnd; continue; }
                        // genuinely stuck: no sport (spacing) AND no free special here → the "blind"
                        // dead placeholder the user flagged. Tagged so the provenance log names it.
                        tile = { kind: 'special', subcat: 'uncategorized', name: spLabel, generic: true, startMin: cur, endMin: blkEnd, durationMin: dur, _ref: null, _origin: 'absorb-kept' };
                        toSpecial++; blockedBySpacing++;
                    }
                    out.push(tile);
                    tmpl.push(_toBlk(tile));   // later blocks are spacing-checked against this one
                    tmplMeta.push(tile.kind === 'sport' && tile.generic === true); // a placed generic sport is a future reorder candidate
                    cur = blkEnd;
                }
                k = j;
            }
            out.sort(function (a, b) { return a.startMin - b.startMin; });
            tiles.length = 0;
            Array.prototype.push.apply(tiles, out);
        }
        return { toSport: toSport, toSpecial: toSpecial, blockedBySpacing: blockedBySpacing, toFilledSpecial: toFilledSpecial, toSplitFilled: toSplitFilled, toRepeatFilled: toRepeatFilled, reorderProbe: { feasible: probeFeasible, wallStuck: probeWallStuck, detail: probeDetail } };
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
