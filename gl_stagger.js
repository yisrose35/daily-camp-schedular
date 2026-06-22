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

    const VERSION = '0.3.2';

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

    // reorderDeadWindows(ctx) — EXECUTE the swap the absorb probe only measured. After absorb,
    // some windows are dead generic "Special: Uncategorized" placeholders: at their time no
    // special seat is free, AND a Sport can't go there because a MOVABLE generic sport sits
    // within the spacing-cooldown radius. The probe flags those RELOCATABLE; this pass acts on
    // them by SWAPPING the dead special with that blocking sport — but ONLY when the swap is a
    // STRICT WIN:
    //   (1) after the swap the displaced special lands on the sport's vacated slot AND a
    //       free-seat concrete activity exists there (so a dead tile becomes a real special), and
    //   (2) a Sport is spacing-legal in the now-freed dead window (tested against the bunk's FULL
    //       fixed+sport set minus the moved sport — not the partial left-to-right template the
    //       probe used), so the relocated sport is properly spaced.
    // Equal duration keeps the day wall-to-wall (two equal disjoint intervals exchange slots);
    // both tiles stay inside their layer windows. The freed dead window becomes a GENERIC sport
    // that the later GENERIC-SPORT-FILL concretizes on a real field. Net: one fewer dead tile,
    // sport count unchanged (the sport merely relocated), filled-special count +1. PURE: only
    // TIME position + the one new concrete fill change; every sharing/cap/spacing rule stays
    // strict (capFits gates the fill, the gate gates the sport). Non-recursive, bounded loops.
    //   ctx: { bunks:[{tiles, grade, pool, noSport}], gate(block,template)->bool,
    //          capFits, recordUse, specialDurs, canon, sportLabel='Sport',
    //          onReorder() (optional; called once per dead window rescued) }
    //   Returns { reordered, attempts, bunks }.
    function reorderDeadWindows(ctx) {
        var bunks = (ctx && ctx.bunks) || [];
        var gate = (ctx && typeof ctx.gate === 'function') ? ctx.gate : null;
        var label = (ctx && ctx.sportLabel) || 'Sport';
        var canon = (ctx && typeof ctx.canon === 'function') ? ctx.canon : function (v) { return String(v || '').toLowerCase().trim(); };
        var canFill = !!(ctx && typeof ctx.capFits === 'function' && typeof ctx.recordUse === 'function');
        if (!gate || !canFill) return { reordered: 0, attempts: 0, bunks: bunks.length };
        var reordered = 0, attempts = 0;
        for (var bi = 0; bi < bunks.length; bi++) {
            var bunk = bunks[bi] || {};
            if (bunk.noSport) continue;                       // sportless grade → no sport to relocate
            var tiles = bunk.tiles || [];
            if (!tiles.length) continue;
            var grade = bunk.grade;
            // ITERATE to a fixed point: a swap can free capacity/spacing that unlocks the next
            // dead window. Bounded (≤6 passes); stop as soon as a pass rescues nothing. Each
            // rescue strictly converts a dead tile → a filled special, so this always terminates.
            for (var pass = 0; pass < 6; pass++) {
                var passReorders = 0;
                // names already concrete on this bunk's special tiles (no same-day repeat)
                var used = Object.create(null);
                for (var u = 0; u < tiles.length; u++) { var ut = tiles[u]; if (ut && ut.kind === 'special' && ut._concrete) used[String(ut._concrete).toLowerCase()] = 1; }
                // dead windows = generic, unfilled special placeholders (recomputed each pass)
                var dead = [];
                for (var di = 0; di < tiles.length; di++) { var dt = tiles[di]; if (dt && dt.kind === 'special' && dt.generic === true && !dt._concrete) dead.push(dt); }
                if (!dead.length) break;
                for (var mi = 0; mi < dead.length; mi++) {
                    var W = dead[mi];
                    if (W._concrete) continue;                // rescued earlier this pass
                    var d = W.durationMin;
                    for (var pj = 0; pj < tiles.length; pj++) {
                        var B = tiles[pj];
                        if (!B || B === W) continue;
                        if (!(B.kind === 'sport' && B.generic === true && !B._concrete)) continue; // only MOVABLE generic sports
                        if (B.durationMin !== d) continue;                                          // equal dur ⇒ wall-to-wall safe
                        if (!inWindow(W, B.startMin, B.endMin) || !inWindow(B, W.startMin, W.endMin)) continue; // both stay in window
                        attempts++;
                        // (1) STRICT WIN: the displaced special must FILL at the sport's vacated slot
                        var fillPick = pickAnyFillable(ctx, bunk, d, B.startMin, B.endMin, used, false);
                        if (!fillPick) continue;
                        // (2) a Sport must be spacing-legal in the freed dead window. Build the FULL
                        //     template = every fixed/sport/filled tile EXCEPT the sport being moved
                        //     (B is the candidate sport itself, leaving its old slot). Specials don't
                        //     constrain sport spacing, so including/excluding them is harmless.
                        var tmpl = [];
                        for (var ti = 0; ti < tiles.length; ti++) { var T = tiles[ti]; if (!T || T === B) continue; tmpl.push(_toBlk(T)); }
                        var sportAtW = { type: 'sport', event: label, startMin: W.startMin, endMin: W.endMin };
                        var ok = true; try { ok = gate(sportAtW, tmpl); } catch (_e) { ok = true; }
                        if (!ok) continue;
                        // COMMIT: swap time slots, fill the (formerly dead) special, leave B a generic
                        // sport in the freed window for GENERIC-SPORT-FILL to concretize on a field.
                        var wKey = String(fillPick.name).toLowerCase();
                        swapTimes(W, B);
                        W._concrete = fillPick.name; W.name = fillPick.name; W.generic = false;
                        W.subcat = canon(fillPick.subcategory); W._fillLoc = fillPick.location || null; W._origin = 'reorder-fill';
                        used[wKey] = 1;
                        try { ctx.recordUse(fillPick, grade, W.startMin, W.endMin); } catch (_e) {}
                        B._origin = 'reorder-sport';
                        reordered++; passReorders++;
                        if (ctx.onReorder) ctx.onReorder();
                        break;
                    }
                }
                if (!passReorders) break;
            }
            tiles.sort(function (a, b) { return a.startMin - b.startMin; });
        }
        return { reordered: reordered, attempts: attempts, bunks: bunks.length };
    }

    // reorderDeadToSport(ctx) — the case reorderDeadWindows can't reach: a dead generic special
    // (e.g. a 10-min food that found no seat) whose ONLY blocker to becoming a Sport is an
    // UNEQUAL-duration movable sport (a 40-min sport in its spacing radius). No equal-duration
    // swap exists, so the strict pass never fires (the [GENERIC-REORDER-PROBE] flags it
    // RELOCATABLE but the swap pass reports 0). Here we instead RELOCATE that blocker — a clean
    // equal-dur swap of the blocker with the bunk's own movable generic SPECIAL partner — which
    // frees the dead window for a spacing-legal Sport. The later GENERIC-SPORT-FILL concretizes
    // it on a real field (sport-fill succeeds far more often than a jammed special seat opens),
    // so a dead placeholder becomes a real activity.
    //
    // NET IMPROVEMENT, strictly guarded (verified by simulate-swap → gate → commit-or-restore):
    //   • a Sport in the freed window is spacing-legal, AND the relocated blocker is spacing-
    //     legal at its new slot (both gated).
    //   • the partner is a MOVABLE GENERIC SPECIAL (already unfilled/dead) → moving it strands
    //     nothing new; a SPORT partner is rejected (it would re-block the window).
    //   • equal-duration partner swap keeps the day wall-to-wall; both stay in their windows.
    //   • ctx.canConvert(tile) (optional) lets the caller PROTECT a subcat — e.g. a weekly-must
    //     shiur placeholder it would rather retry tomorrow than turn into a sport.
    // Each conversion strictly lowers the dead-special count (W → sport; the moved partner was
    // already dead) so it always terminates. PURE: only time-position + the one kind flip.
    //   ctx: { bunks:[{tiles,grade,noSport}], gate(block,template)->bool, sportLabel='Sport',
    //          canon, canConvert(tile)->bool }
    //   Returns { converted, relocations, attempts, bunks }.
    function reorderDeadToSport(ctx) {
        var bunks = (ctx && ctx.bunks) || [];
        var gate = (ctx && typeof ctx.gate === 'function') ? ctx.gate : null;
        var label = (ctx && ctx.sportLabel) || 'Sport';
        var canConvert = (ctx && typeof ctx.canConvert === 'function') ? ctx.canConvert : function () { return true; };
        // optional capacity fns — when present, the blocker may ALSO be relocated by swapping with a
        // FILLED special (its concrete activity's seat is re-validated at the slot it moves INTO, and the
        // ledger entry is moved), which gives the pass real partners even after every special is filled.
        // Without them, only an already-dead generic special is a partner (no ledger to keep balanced).
        var capFits = (ctx && typeof ctx.capFits === 'function') ? ctx.capFits : null;
        var recordUse = (ctx && typeof ctx.recordUse === 'function') ? ctx.recordUse : null;
        var removeUse = (ctx && typeof ctx.removeUse === 'function') ? ctx.removeUse : null;
        var canMoveFilled = !!(capFits && recordUse && removeUse);
        if (!gate) return { converted: 0, relocations: 0, attempts: 0, bunks: bunks.length };
        var converted = 0, relocations = 0, attempts = 0, filledMoves = 0;

        function tmplExcept(tiles, a, b) {
            var out = [];
            for (var i = 0; i < tiles.length; i++) { var t = tiles[i]; if (t === a || t === b) continue; out.push(_toBlk(t)); }
            return out;
        }
        function sportLegalAt(tiles, s, e, exclA, exclB) {
            try { return gate({ type: 'sport', event: label, startMin: s, endMin: e }, tmplExcept(tiles, exclA, exclB)); } catch (_e) { return false; }
        }
        function toSport(W) { W.kind = 'sport'; W.subcat = null; W.name = label; W.generic = true; W._fillLoc = null; W._origin = 'reorder-tosport'; }

        for (var bi = 0; bi < bunks.length; bi++) {
            var bunk = bunks[bi] || {};
            if (bunk.noSport) continue;                          // sportless grade → never gets a Sport
            var tiles = bunk.tiles || [];
            if (!tiles.length) continue;

            for (var pass = 0; pass < 6; pass++) {
                var passConverts = 0;
                var dead = [];
                for (var di = 0; di < tiles.length; di++) {
                    var dt = tiles[di];
                    if (dt && dt.kind === 'special' && dt.generic === true && !dt._concrete && canConvert(dt)) dead.push(dt);
                }
                if (!dead.length) break;

                for (var mi = 0; mi < dead.length; mi++) {
                    var W = dead[mi];
                    if (W.kind !== 'special' || W._concrete) continue;   // converted earlier this pass
                    // (A) a Sport already fits W's window (no blocker) → convert directly
                    if (sportLegalAt(tiles, W.startMin, W.endMin, W, null)) { toSport(W); converted++; passConverts++; continue; }
                    // (B) blocked → relocate ONE movable generic sport blocker so a Sport fits W
                    var doneW = false;
                    for (var pj = 0; pj < tiles.length && !doneW; pj++) {
                        var B = tiles[pj];
                        if (!B || B === W) continue;
                        if (!(B.kind === 'sport' && B.generic === true && !B._concrete)) continue;       // movable sport only
                        if (!sportLegalAt(tiles, W.startMin, W.endMin, W, B)) continue;                  // removing B alone must free the window
                        for (var pk = 0; pk < tiles.length; pk++) {
                            var P = tiles[pk];
                            if (!P || P === B || P === W) continue;
                            if (P.kind !== 'special') continue;                                         // a sport partner would re-block W
                            if (P.durationMin !== B.durationMin) continue;                              // equal-dur ⇒ wall-to-wall safe
                            if (!inWindow(B, P.startMin, P.endMin) || !inWindow(P, B.startMin, B.endMin)) continue;
                            var pFilled = !!P._concrete;
                            var pDead = (P.generic === true && !P._concrete);
                            if (!pDead && !(pFilled && canMoveFilled)) continue;                        // dead-generic always; filled only with a capacity ledger
                            attempts++;
                            // a FILLED partner carries a concrete activity with a live seat claim — moving it
                            // means re-validating that seat at the slot it moves INTO (B's old slot) and moving
                            // the ledger entry. Build a minimal candidate from the tile.
                            var pCand = null, pOldS = P.startMin, pOldE = P.endMin;
                            if (pFilled) {
                                pCand = { name: P._concrete, location: (P._fillLoc != null ? P._fillLoc : null), subcategory: P.subcat };
                                try { removeUse(pCand, bunk.grade, pOldS, pOldE); } catch (_e) {}
                                var okCap = false; try { okCap = capFits(pCand, bunk.grade, B.startMin, B.endMin); } catch (_e) { okCap = false; }
                                if (!okCap) { try { recordUse(pCand, bunk.grade, pOldS, pOldE); } catch (_e) {} continue; }  // can't re-seat → restore + skip
                            }
                            swapTimes(B, P);                                                            // simulate B↔P (P now at B's old slot)
                            var okBnew = sportLegalAt(tiles, B.startMin, B.endMin, B, null);            // blocker legal at its new slot
                            var okW = sportLegalAt(tiles, W.startMin, W.endMin, W, null);               // a Sport now legal at W
                            if (okBnew && okW) {
                                if (pFilled) { try { recordUse(pCand, bunk.grade, P.startMin, P.endMin); } catch (_e) {} filledMoves++; }  // P's seat at its NEW slot
                                B._origin = 'reorder-relocate'; P._origin = pFilled ? 'reorder-partner-filled' : 'reorder-partner';
                                toSport(W);
                                converted++; relocations++; passConverts++; doneW = true;
                                break;
                            }
                            swapTimes(B, P);                                                            // restore times
                            if (pFilled) { try { recordUse(pCand, bunk.grade, pOldS, pOldE); } catch (_e) {} }              // restore P's seat at its old slot
                        }
                    }
                }
                if (!passConverts) break;
            }
            tiles.sort(function (a, b) { return a.startMin - b.startMin; });
        }
        return { converted: converted, relocations: relocations, filledMoves: filledMoves, attempts: attempts, bunks: bunks.length };
    }

    // A weekly-must RESERVATION (e.g. a shiur placeholder for "≥1/week") is RELEASABLE today —
    // safe to fill with something else or convert to a Sport, because the weekly min can still be
    // met on a later camp-day — iff it is NOT now-or-never. This is the SAFETY CRUX of the release
    // pass; keep it pure + tested so the boundary can never silently drift:
    //   need      = minFreq - weekToDate                       (sessions still owed this period)
    //   remaining = max(1, daysInPeriod - dayOfPeriod + 1)     (camp-days left incl. today)
    //   releasable ⇔ need <= 0 (already met)  OR  need < remaining (a later day can still place it)
    // need >= remaining is the now-or-never deadline → NOT releasable (mirrors GENERIC-WEEKLY forceNow).
    function weeklyReleasable(o) {
        o = o || {};
        var M = parseInt(o.minFreq, 10) || 0;
        if (M <= 0) return true;
        var need = M - (parseInt(o.weekToDate, 10) || 0);
        if (need <= 0) return true;
        var D = Math.max(1, parseInt(o.daysInPeriod, 10) || 1);
        var e = Math.max(1, parseInt(o.dayOfPeriod, 10) || 1);
        var remaining = Math.max(1, D - e + 1);
        return need < remaining;
    }

    const api = { VERSION: VERSION, restructure: restructure, inWindow: inWindow, absorbUnfilledToSport: absorbUnfilledToSport, reorderDeadWindows: reorderDeadWindows, reorderDeadToSport: reorderDeadToSport, weeklyReleasable: weeklyReleasable };

    if (typeof window !== 'undefined') {
        window.GLStagger = api;
        if (typeof console !== 'undefined') console.log('[GLStagger] v' + VERSION + ' loaded');
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})();
