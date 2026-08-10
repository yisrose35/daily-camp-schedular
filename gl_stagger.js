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

    const VERSION = '0.4.0';

    // Does interval [s,e) fit inside tile t's layer window? (no window ⇒ unconstrained)
    function inWindow(t, s, e) {
        const w = t && t._ref && t._ref.window;
        if (!w) return true;
        return s >= w[0] && e <= w[1];
    }

    // Best free activity of subcat `sub` at duration `dur` that fits (cap-aware) at [s,e],
    // not already used by this bunk and not the excluded name. Returns the candidate or null.
    function pickActivity(ctx, bunk, sub, dur, s, e, used, excludeKey) {
        // Primary pool first, then the cohort-DEFERRED pool as a last resort.
        //
        // The deferred pool is not a restriction — it is explicitly "fill-if-possible
        // last resort (fills before OPEN time)": this bunk is merely AHEAD of its cohort
        // on that activity, a fairness preference, not a rule. GENERIC-FILL already
        // borrows from it when a tile would otherwise go OPEN; restructure did not, so a
        // relocation could fail with the tile left dead while a perfectly legal borrow sat
        // one list away. Live (Majors ה): every uncategorized option was either
        // exact-frequency exhausted (removed from priorityList outright) or
        // cohort-deferred, so scanning only bunk.pool found nothing and all 14 relocation
        // attempts came back empty. Every hard rule still applies below — subcat, a
        // configured duration, no same-day repeat, and capFits.
        var lists = [bunk.pool || []];
        if (bunk.deferred && bunk.deferred.length) lists.push(bunk.deferred);
        for (let li = 0; li < lists.length; li++) {
            const pool = lists[li];
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
        }
        return null;
    }

    function swapTimes(a, b) {
        const as = a.startMin, ae = a.endMin;
        a.startMin = b.startMin; a.endMin = b.endMin;
        b.startMin = as; b.endMin = ae;
    }

    // SEAT-LEDGER-AWARE swap. The caller may inject (all three or none):
    //   seatRelease(tile, grade, s, e)         — free the tile's category reservation at [s,e)
    //   seatGate(tile, grade, s, e) -> bool    — may the tile's category take a seat at [s,e)?
    //   seatCommit(tile, grade, s, e)          — reserve the tile's category seat at [s,e)
    // mirroring the auto-core resource ledger. When present, a time-swap only commits if
    // BOTH tiles still have a free seat at their NEW spans — the layout's placement gate,
    // re-applied to repair-pass moves (an ungated swap is how a third 2-seat 'food@10'
    // tile landed on one window: the audit-time "3 > 2 seats" over-caps). Refusal leaves
    // times AND ledger exactly as they were. When the hooks are absent this is swapTimes.
    function trySeatSwap(ctx, grade, a, b) {
        if (!ctx || !ctx.seatRelease || !ctx.seatGate || !ctx.seatCommit) { swapTimes(a, b); return true; }
        const as = a.startMin, ae = a.endMin, bs = b.startMin, be = b.endMin;
        ctx.seatRelease(a, grade, as, ae);
        ctx.seatRelease(b, grade, bs, be);
        if (ctx.seatGate(a, grade, bs, be)) {
            ctx.seatCommit(a, grade, bs, be);
            if (ctx.seatGate(b, grade, as, ae)) {
                ctx.seatCommit(b, grade, as, ae);
                swapTimes(a, b);
                return true;
            }
            ctx.seatRelease(a, grade, bs, be);
        }
        ctx.seatCommit(a, grade, as, ae);   // rollback to the pre-call ledger
        ctx.seatCommit(b, grade, bs, be);
        return false;
    }

    // UNCONDITIONAL seat-aware swap-back — used only to restore a previously-legal
    // arrangement (transactional rollback), so it never re-gates.
    function seatSwapBack(ctx, grade, a, b) {
        if (!ctx || !ctx.seatRelease || !ctx.seatCommit) { swapTimes(a, b); return; }
        ctx.seatRelease(a, grade, a.startMin, a.endMin);
        ctx.seatRelease(b, grade, b.startMin, b.endMin);
        swapTimes(a, b);
        ctx.seatCommit(a, grade, a.startMin, a.endMin);
        ctx.seatCommit(b, grade, b.startMin, b.endMin);
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
                        if (!trySeatSwap(ctx, grade, miss, pt)) continue;   // no free seat at a new span → try next partner
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
                        if (!trySeatSwap(ctx, grade, miss, pt)) { ctx.recordUse(a2, grade, s2, e2); continue; }   // restore the partner's usage; try next partner
                        if (replaced) delete used[String(pt._concrete).toLowerCase()];
                        miss._concrete = a1.name; miss._fillLoc = a1.location || null; used[a1key] = 1;
                        pt._concrete = keepName; pt._fillLoc = keepLoc; if (replaced) used[String(keepName).toLowerCase()] = 1;
                        ctx.recordUse(a1, grade, miss.startMin, miss.endMin);
                        ctx.recordUse(keepCand, grade, pt.startMin, pt.endMin);
                        recovered++; if (ctx.onRecover) ctx.onRecover();
                        break;
                    } else {
                        // both empty: move miss onto the free slot + opportunistically fill the partner.
                        // The partner is a GENERIC special relocating to the miss's old slot — its
                        // subcat may differ, so the seat gate is what stops it landing on a full window
                        // (the live "third food@10 tile at 11:30" over-cap came from exactly this move).
                        if (!trySeatSwap(ctx, grade, miss, pt)) continue;
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
        // Primary pool first, then the cohort-DEFERRED pool — the same fallback
        // pickActivity gained (the deferred list is a fairness preference, not a
        // rule: "fill-if-possible last resort, fills before OPEN time"). Every
        // rescue that calls this (reorder swaps, absorb real-fill) was otherwise
        // blind to legal candidates that sat one list away.
        const _lists = [(bunk && bunk.pool) || []];
        if (bunk && bunk.deferred && bunk.deferred.length) _lists.push(bunk.deferred);
        // pass 1 — prefer a special this bunk has NOT done today (variety)
        for (let li = 0; li < _lists.length; li++) {
            const pool = _lists[li];
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
        }
        // pass 2 — repeat allowed: accept an already-used special that still has a seat
        if (allowRepeat) {
            for (let li2 = 0; li2 < _lists.length; li2++) {
                const pool2 = _lists[li2];
                for (let i = 0; i < pool2.length; i++) {
                    const c = pool2[i];
                    if (!c || !c.name) continue;
                    const durs = ctx.specialDurs ? ctx.specialDurs(c.name) : null;
                    if (durs && durs.length && durs.indexOf(dur) < 0) continue;
                    if (ctx.capFits && !ctx.capFits(c, bunk.grade, s, e)) continue;
                    return c;
                }
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
    function _absSplitFill(ctx, bunk, s, end, used, canon, allowPartial) {
        // sub-tile lengths (standard 10-min grid; pickAnyFillable filters by what exists).
        // ctx.stagMenuFlip (arrangement-trial dial): smallest-first instead of biggest-
        // first — a different split SHAPE for the same block; absent = exact legacy order.
        var MENU = (ctx && ctx.stagMenuFlip) ? [10, 20, 30] : [30, 20, 10];
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
        // ★ PARTIAL PREFIX (allowPartial): full cover failed, but a lone piece is
        //   still strictly better than the whole block dead — shiur@20 + 20-min-dead
        //   beats 40-min-dead ("never worse" is this pass's own doctrine, and the
        //   old all-or-nothing rule violated it). Greedy from the block START,
        //   largest piece first at each position, so runs are deterministic. The
        //   caller advances `cur` to the last piece's end; the residue re-enters
        //   the block loop and, if it dies, gets its born-dead marking at its own
        //   (true, shorter) length — the seat audit stays honest.
        if (!ok && allowPartial) {
            var _pos = s, _mi2 = 0;
            while (_pos < end && _mi2 < MENU.length) {
                var _d2 = MENU[_mi2];
                if (_d2 >= span || _pos + _d2 > end) { _mi2++; continue; }
                var _pk2 = pickAnyFillable(ctx, bunk, _d2, _pos, _pos + _d2, used);
                if (_pk2) {
                    used[String(_pk2.name).toLowerCase()] = 1;
                    picks.push({ pick: _pk2, s: _pos, e: _pos + _d2, dur: _d2 });
                    _pos += _d2; _mi2 = 0;
                } else { _mi2++; }
            }
            ok = picks.length >= 1;
        }
        if (!ok || picks.length < (allowPartial ? 1 : 2)) {
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
        // canAbsorb(tile) -> bool (optional): the caller's repurpose policy for which OPEN
        // tiles may be merged/re-tiled at all. A rejected tile (e.g. subcat-strict: a
        // subcategory-tagged tile is its subcat or NOTHING) is passed through untouched —
        // it breaks the open run like a wall and is left for the caller's endgame
        // (honest-open drop). Omitted → every open tile participates (legacy behavior).
        var canAbsorb = (ctx && typeof ctx.canAbsorb === 'function') ? ctx.canAbsorb : null;
        var mayAbsorb = function (t) { return _isOpen(t) && (!canAbsorb || canAbsorb(t)); };
        var toSport = 0, toSpecial = 0, blockedBySpacing = 0, toFilledSpecial = 0, bornDeadSkipped = 0;
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
                if (!mayAbsorb(sorted[k])) { out.push(sorted[k]); k++; continue; }
                // maximal contiguous open run
                var runStart = sorted[k].startMin, runEnd = sorted[k].endMin, j = k + 1;
                while (j < sorted.length && mayAbsorb(sorted[j]) && sorted[j].startMin === runEnd) { runEnd = sorted[j].endMin; j++; }
                // re-tile [runStart,runEnd] into ≤maxMerge blocks: Sport where the spacing gate
                // allows; else a REAL special that still has a free seat (STEP 3 — aware of what
                // fill already took); else a generic placeholder (genuine last resort).
                for (var cur = runStart; cur < runEnd; ) {
                    var blkEnd = Math.min(cur + maxMerge, runEnd);
                    // ★ FULL-LENGTH SPORT FIRST: the fixed ≤maxMerge chop meant a 50-min run
                    //   was always tried as 40+10 — and the 10-min tail was unfillable BY
                    //   CONSTRUCTION (the just-placed 40-min sport enters the template, so the
                    //   tail's own sport test always fails the after-sport cooldown at gap 0).
                    //   When the whole remaining run fits the grade's LEGAL sport range
                    //   (ctx.sportMaxByGrade, from the real layer config — never invented),
                    //   gate-test one sport at full length first; fall back to the chop only
                    //   if the gate refuses. Live: two 50-min holes existed where a single
                    //   50-min sport was config-legal (sports 30-50) and spacing-legal.
                    var _rem = runEnd - cur;
                    var _sportMax = (ctx && ctx.sportMaxByGrade && bunk.grade != null && ctx.sportMaxByGrade[bunk.grade]) || 0;
                    if (!bunkNoSport && gate && _rem > maxMerge && _sportMax > maxMerge && _rem <= _sportMax) {
                        var _fullBlk = { type: 'sport', event: label, startMin: cur, endMin: runEnd };
                        var _fullOk = false;
                        try { _fullOk = gate(_fullBlk, tmpl); } catch (_eFl) { _fullOk = false; }
                        if (_fullOk) blkEnd = runEnd;
                    }
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
                            // Cascade, strongest cover first:
                            //   1. exact cover of THIS block (original behavior);
                            //   2. cover of the WHOLE remaining run — pieces may cross the
                            //      maxMerge boundary the chop imposed (a 50-min run as 30+20
                            //      was structurally impossible before: splits were per-block);
                            //   3. PARTIAL prefix of this block — one piece placed beats the
                            //      whole block dead; the residue re-enters the loop and keeps
                            //      its own honest born-dead marking if nothing fits it.
                            var _splitTiles = _absSplitFill(ctx, bunk, cur, blkEnd, used, canon);
                            if (!_splitTiles && runEnd > blkEnd) _splitTiles = _absSplitFill(ctx, bunk, cur, runEnd, used, canon);
                            if (!_splitTiles) _splitTiles = _absSplitFill(ctx, bunk, cur, blkEnd, used, canon, true);
                            if (_splitTiles && _splitTiles.length) {
                                for (var _si = 0; _si < _splitTiles.length; _si++) {
                                    var _stl = _splitTiles[_si];
                                    out.push(_stl);
                                    tmpl.push(_toBlk(_stl));
                                    tmplMeta.push(false);
                                }
                                toSplitFilled += _splitTiles.length;
                                // advance to the last piece's end — beyond blkEnd for a
                                // whole-run cover, short of it for a partial prefix.
                                cur = _splitTiles[_splitTiles.length - 1].endMin;
                                continue;   // covered (fully or partially) → no dead tile HERE
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
                        // ★ BORN-DEAD MARK (honest reporting): this placeholder is tagged 'uncategorized'
                        //   at THIS BLOCK'S length — but a subcat whose activities run fixed durations
                        //   cannot serve every length. Live: uncategorized runs [30,40] (12 of 13
                        //   activities are 40-min only), yet absorb minted 10- and 20-min "Special:
                        //   Uncategorized" tiles. Those can NEVER fill, on any day, at any time. The tile
                        //   is still emitted — reorderDeadToSport can rescue it into a Sport, which is a
                        //   real win — but it is MARKED so the seat audit does not report it as a phantom
                        //   over-capacity ("uncategorized@10: 1 > 0 seats") and the capacity advice does
                        //   not tell the user to "+N seats of uncategorized" when no 40-min activity could
                        //   ever fill a 10-min hole. The honest fix is a shorter activity, and the
                        //   advice must say so.
                        if (canFill && bunk.pool && ctx.specialDurs) {
                            var _fitAny = false;
                            for (var _bd = 0; _bd < bunk.pool.length; _bd++) {
                                var _bc = bunk.pool[_bd];
                                if (!_bc || !_bc.name) continue;
                                if (canon(_bc.subcategory) !== 'uncategorized') continue;
                                var _bds = ctx.specialDurs(_bc.name) || [];
                                if (!_bds.length || _bds.indexOf(dur) >= 0) { _fitAny = true; break; }
                            }
                            if (!_fitAny) { tile._bornDead = true; bornDeadSkipped++; }
                        }
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
        return { toSport: toSport, toSpecial: toSpecial, blockedBySpacing: blockedBySpacing, toFilledSpecial: toFilledSpecial, toSplitFilled: toSplitFilled, toRepeatFilled: toRepeatFilled, bornDeadSkipped: bornDeadSkipped, reorderProbe: { feasible: probeFeasible, wallStuck: probeWallStuck, detail: probeDetail } };
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
        // canConvert(tile) -> bool (optional): caller policy for which dead tiles may be
        // rescued at all. The rescue re-fills the tile from ANY subcat (pickAnyFillable),
        // so a subcat-strict caller passes only 'uncategorized' tiles. Omitted → all.
        var canConvert = (ctx && typeof ctx.canConvert === 'function') ? ctx.canConvert : null;
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
                for (var di = 0; di < tiles.length; di++) { var dt = tiles[di]; if (dt && dt.kind === 'special' && dt.generic === true && !dt._concrete && (!canConvert || canConvert(dt))) dead.push(dt); }
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
                        // Seat-gated: both tiles must have a free category seat at their new spans.
                        var wKey = String(fillPick.name).toLowerCase();
                        if (!trySeatSwap(ctx, grade, W, B)) continue;
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
        // ctx.maxBlockers (default 1 = single-hop only). When >1, a dead window blocked by SEVERAL
        // movable sports (single-hop can't free it — moving one leaves another in the 40-min shadow)
        // is freed by relocating the WHOLE set at once, atomically. Capped at 4 so it can't blow up.
        var maxBlockers = (ctx && +ctx.maxBlockers > 1) ? Math.min(4, +ctx.maxBlockers | 0) : 1;
        if (!gate) return { converted: 0, relocations: 0, attempts: 0, bunks: bunks.length };
        var converted = 0, relocations = 0, attempts = 0, filledMoves = 0, multiHops = 0;

        function tmplExcept(tiles, a, b) {
            var out = [];
            for (var i = 0; i < tiles.length; i++) { var t = tiles[i]; if (t === a || t === b) continue; out.push(_toBlk(t)); }
            return out;
        }
        function sportLegalAt(tiles, s, e, exclA, exclB) {
            try { return gate({ type: 'sport', event: label, startMin: s, endMin: e }, tmplExcept(tiles, exclA, exclB)); } catch (_e) { return false; }
        }
        // sport-at-[s,e] legal with a SET of tiles excluded (multi-blocker validation)
        function sportLegalAtSet(tiles, s, e, exclArr) {
            var out = [];
            for (var i = 0; i < tiles.length; i++) { if (exclArr.indexOf(tiles[i]) >= 0) continue; out.push(_toBlk(tiles[i])); }
            try { return gate({ type: 'sport', event: label, startMin: s, endMin: e }, out); } catch (_e) { return false; }
        }
        // does sport B alone make a Sport-at-W illegal? (B is in W's spacing radius) — pairwise probe
        function conflictsW(B, W) {
            try { return !gate({ type: 'sport', event: label, startMin: W.startMin, endMin: W.endMin }, [_toBlk(B)]); } catch (_e) { return true; }
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
                            swapTimes(B, P);                                                            // simulate B↔P (times only)
                            var okBnew = sportLegalAt(tiles, B.startMin, B.endMin, B, null);            // blocker legal at its new slot
                            var okW = sportLegalAt(tiles, W.startMin, W.endMin, W, null);               // a Sport now legal at W
                            swapTimes(B, P);                                                            // end simulation — restore times
                            if (okBnew && okW && trySeatSwap(ctx, bunk.grade, B, P)) {                  // seat-gated REAL swap
                                if (pFilled) { try { recordUse(pCand, bunk.grade, P.startMin, P.endMin); } catch (_e) {} filledMoves++; }  // P's seat at its NEW slot
                                B._origin = 'reorder-relocate'; P._origin = pFilled ? 'reorder-partner-filled' : 'reorder-partner';
                                toSport(W);
                                converted++; relocations++; passConverts++; doneW = true;
                                break;
                            }
                            if (pFilled) { try { recordUse(pCand, bunk.grade, pOldS, pOldE); } catch (_e) {} }              // restore P's seat at its old slot
                        }
                    }
                    // (C) MULTI-BLOCKER (bounded, opt-in via maxBlockers>1): when ≥2 movable sports sit
                    // in W's radius, single-hop can't free it (moving one leaves another in the shadow).
                    // Relocate the WHOLE set at once — each via a distinct equal-dur special partner —
                    // TRANSACTIONALLY: apply every swap + ledger move, validate the FINAL arrangement (a
                    // Sport legal at W AND every relocated sport legal at its new slot), then commit or
                    // FULLY roll back (reverse order). All-or-nothing ⇒ never a partial chain.
                    if (!doneW && maxBlockers > 1) {
                        var mBlockers = [], mWall = false;
                        for (var ci = 0; ci < tiles.length; ci++) {
                            var Bc = tiles[ci];
                            if (!Bc || Bc === W || Bc.kind !== 'sport') continue;
                            if (!conflictsW(Bc, W)) continue;                                            // not in W's radius
                            if (Bc.generic === true && !Bc._concrete) mBlockers.push(Bc);                // movable
                            else { mWall = true; break; }                                                // a wall/concrete sport blocks W → unmovable
                        }
                        if (!mWall && mBlockers.length >= 2 && mBlockers.length <= maxBlockers) {
                            var chosen = [], usedP = [], okChain = true;
                            for (var mb = 0; mb < mBlockers.length && okChain; mb++) {
                                var Bx = mBlockers[mb], gotP = false;
                                for (var pp = 0; pp < tiles.length; pp++) {
                                    var Pc = tiles[pp];
                                    if (!Pc || Pc === W || Pc === Bx) continue;
                                    if (usedP.indexOf(Pc) >= 0 || mBlockers.indexOf(Pc) >= 0) continue;  // a partner is used once; never a blocker
                                    if (Pc.kind !== 'special') continue;                                // a sport partner would re-block
                                    if (Pc.durationMin !== Bx.durationMin) continue;                    // equal-dur ⇒ wall-to-wall safe
                                    if (!inWindow(Bx, Pc.startMin, Pc.endMin) || !inWindow(Pc, Bx.startMin, Bx.endMin)) continue;
                                    var f = !!Pc._concrete, dead2 = (Pc.generic === true && !Pc._concrete);
                                    if (!dead2 && !(f && canMoveFilled)) continue;
                                    var cand = null, oS = Pc.startMin, oE = Pc.endMin;
                                    if (f) {                                                            // re-seat the filled partner's activity at the slot it moves INTO
                                        cand = { name: Pc._concrete, location: (Pc._fillLoc != null ? Pc._fillLoc : null), subcategory: Pc.subcat };
                                        try { removeUse(cand, bunk.grade, oS, oE); } catch (_e) {}
                                        var okc = false; try { okc = capFits(cand, bunk.grade, Bx.startMin, Bx.endMin); } catch (_e) { okc = false; }
                                        if (!okc) { try { recordUse(cand, bunk.grade, oS, oE); } catch (_e) {} continue; }
                                    }
                                    // Pc → Bx's old slot, Bx → Pc's old slot — seat-gated like every move
                                    if (!trySeatSwap(ctx, bunk.grade, Bx, Pc)) {
                                        if (f) { try { recordUse(cand, bunk.grade, oS, oE); } catch (_e) {} }
                                        continue;                                                       // no seat at a new span → try another partner
                                    }
                                    if (f) { try { recordUse(cand, bunk.grade, Pc.startMin, Pc.endMin); } catch (_e) {} }
                                    chosen.push({ B: Bx, P: Pc, f: f, cand: cand, oS: oS, oE: oE });
                                    usedP.push(Pc); gotP = true; break;
                                }
                                if (!gotP) okChain = false;                                             // this blocker has no partner → abort the chain
                            }
                            var committed = false;
                            if (okChain && chosen.length === mBlockers.length) {
                                attempts++;
                                var okWm = sportLegalAtSet(tiles, W.startMin, W.endMin, [W]);            // a Sport now fits W (all blockers moved off)
                                var okAll = true;
                                for (var vk = 0; vk < chosen.length && okAll; vk++) {
                                    var Bv = chosen[vk].B;
                                    if (!sportLegalAt(tiles, Bv.startMin, Bv.endMin, Bv, null)) okAll = false;   // each relocated sport legal where it landed
                                }
                                if (okWm && okAll) {
                                    chosen.forEach(function (c) { c.B._origin = 'reorder-relocate-multi'; c.P._origin = c.f ? 'reorder-partner-filled' : 'reorder-partner'; if (c.f) filledMoves++; });
                                    toSport(W);
                                    converted++; relocations += chosen.length; multiHops++; passConverts++; doneW = true; committed = true;
                                }
                            }
                            if (!committed) {                                                           // roll everything back, reverse order
                                for (var uk = chosen.length - 1; uk >= 0; uk--) {
                                    var cc = chosen[uk];
                                    if (cc.f) { try { removeUse(cc.cand, bunk.grade, cc.P.startMin, cc.P.endMin); } catch (_e) {} }
                                    seatSwapBack(ctx, bunk.grade, cc.B, cc.P);                          // unconditional: restores a previously-legal state
                                    if (cc.f) { try { recordUse(cc.cand, bunk.grade, cc.oS, cc.oE); } catch (_e) {} }
                                }
                            }
                        }
                    }
                }
                if (!passConverts) break;
            }
            tiles.sort(function (a, b) { return a.startMin - b.startMin; });
        }
        return { converted: converted, relocations: relocations, filledMoves: filledMoves, multiHops: multiHops, attempts: attempts, bunks: bunks.length };
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

    // reorderDeadUnequal(ctx) — the case the strict swap structurally cannot reach.
    //
    // reorderDeadWindows requires B.durationMin === W.durationMin because it SWAPS THE
    // TIME SLOTS of the two tiles: exchanging spans of unequal length would leave a
    // residue and break wall-to-wall. Live that guard is why the rescue never fires here:
    // the blocking sport is 40 min and the dead window is 30, so 40 !== 30 and the pass
    // skips — even though moving that sport is exactly what would free the window.
    // (Verified against the live rule engine: a sport at the dead window is rejected with
    // the neighbouring sport present and ACCEPTED without it.)
    //
    // This pass never moves a span. It exchanges the two tiles' KINDS in place:
    //     W (dead special, stays at its own span)  ->  becomes a generic Sport
    //     B (movable sport, stays at its own span) ->  becomes a filled Special
    // Each tile keeps its own start/end, so coverage is preserved by construction and
    // duration equality is irrelevant. Requirements, all pre-checked:
    //   1. a Sport is spacing-legal at W's span once B is no longer a sport,
    //   2. W's length is a legal sport duration for B's demand (a 30-min sport is fine
    //      when the layer says 30-50; never invent a length the config forbids),
    //   3. a special of B's OWN length is fillable at B's span (cap + no same-day repeat),
    //   4. both tiles pass the seat gate at their unchanged spans — else full rollback.
    function reorderDeadUnequal(ctx) {
        var bunks = (ctx && ctx.bunks) || [];
        var gate = (ctx && typeof ctx.gate === 'function') ? ctx.gate : null;
        var label = (ctx && ctx.sportLabel) || 'Sport';
        var canon = (ctx && typeof ctx.canon === 'function') ? ctx.canon : function (v) { return String(v || '').toLowerCase().trim(); };
        var canFill = !!(ctx && typeof ctx.capFits === 'function' && typeof ctx.recordUse === 'function');
        var canConvert = (ctx && typeof ctx.canConvert === 'function') ? ctx.canConvert : null;
        if (!gate || !canFill) return { rescued: 0, attempts: 0, bunks: bunks.length };

        // A sport tile may only take a length this pipeline already treats as legal.
        // Prefer the demand's own range when it carries one. In practice the layout's
        // sport tiles arrive with _ref.dMin/dMax NULL (measured live: 94 movable sport
        // tiles, every one null) while the layout itself has already emitted sport tiles
        // at 10/20/30/40min — so "no range" means "not recorded here", NOT "no sports".
        // Falling back to a flat refusal made this pass reject all 9 real candidates.
        // Instead, accept a length the layout has ALREADY chosen for a sport on this same
        // bunk: that is observed engine behaviour rather than an invented duration.
        function _sportLenOk(B, len, tiles) {
            var r = (B && B._ref) || {};
            var lo = (r.dMin != null) ? r.dMin : null;
            var hi = (r.dMax != null) ? r.dMax : null;
            if (lo != null || hi != null) {
                return (lo == null || len >= lo) && (hi == null || len <= hi);
            }
            var durs = (r.durations && r.durations.length) ? r.durations : null;
            if (durs) return durs.indexOf(len) >= 0;
            for (var i = 0; i < (tiles || []).length; i++) {
                var t = tiles[i];
                if (t && t.kind === 'sport' && t.durationMin === len) return true;
            }
            return false;
        }

        var rescued = 0, attempts = 0, rescuedPairs = 0;
        for (var bi = 0; bi < bunks.length; bi++) {
            var bunk = bunks[bi] || {};
            if (bunk.noSport) continue;                       // sportless grade → never inject a sport
            var tiles = bunk.tiles || [];
            if (!tiles.length) continue;
            var grade = bunk.grade;
            var used = Object.create(null);
            for (var u = 0; u < tiles.length; u++) {
                var ut = tiles[u];
                if (ut && ut.kind === 'special' && ut._concrete) used[String(ut._concrete).toLowerCase()] = 1;
            }
            var dead = [];
            for (var di = 0; di < tiles.length; di++) {
                var dt = tiles[di];
                if (dt && dt.kind === 'special' && dt.generic === true && !dt._concrete && (!canConvert || canConvert(dt))) dead.push(dt);
            }
            for (var mi = 0; mi < dead.length; mi++) {
                var W = dead[mi];
                if (W._concrete || W.kind !== 'special') continue;
                for (var pj = 0; pj < tiles.length; pj++) {
                    var B = tiles[pj];
                    if (!B || B === W) continue;
                    if (!(B.kind === 'sport' && B.generic === true && !B._concrete)) continue;
                    if (B.durationMin === W.durationMin) continue;     // equal case belongs to the strict pass
                    if (B.pinned || (B._ref && B._ref.share)) continue;
                    if (!_sportLenOk(B, W.durationMin, tiles)) continue;
                    attempts++;

                    // (1) Sport spacing-legal at W, with B no longer counting as a sport.
                    var tmpl = [];
                    for (var ti = 0; ti < tiles.length; ti++) {
                        var T = tiles[ti];
                        if (!T || T === B || T === W) continue;
                        tmpl.push(_toBlk(T));
                    }
                    var okSport = true;
                    try { okSport = gate({ type: 'sport', event: label, startMin: W.startMin, endMin: W.endMin }, tmpl); } catch (_eU1) { okSport = true; }
                    if (!okSport) continue;

                    // (2) a special of B's own length must be fillable at B's span.
                    var pick = pickAnyFillable(ctx, bunk, B.durationMin, B.startMin, B.endMin, used, false);
                    if (!pick) continue;

                    // (3) COMMIT — kinds exchange, spans untouched. Snapshot for rollback.
                    var snapW = { kind: W.kind, name: W.name, generic: W.generic, subcat: W.subcat, _ref: W._ref, _concrete: W._concrete, _origin: W._origin };
                    var snapB = { kind: B.kind, name: B.name, generic: B.generic, subcat: B.subcat, _ref: B._ref, _concrete: B._concrete, _origin: B._origin };
                    try { if (ctx.seatRelease) { ctx.seatRelease(W, grade, W.startMin, W.endMin); ctx.seatRelease(B, grade, B.startMin, B.endMin); } } catch (_eU2) {}

                    W.kind = 'sport'; W.name = label; W.generic = true; W.subcat = null;
                    W._ref = snapB._ref; W._origin = 'unequal-sport';
                    B.kind = 'special'; B.name = pick.name; B._concrete = pick.name; B.generic = false;
                    B.subcat = canon(pick.subcategory); B._ref = snapW._ref;
                    B._fillLoc = pick.location || null; B._origin = 'unequal-fill';

                    var seatOk = true;
                    try {
                        if (ctx.seatGate) {
                            seatOk = ctx.seatGate(B, grade, B.startMin, B.endMin) && ctx.seatGate(W, grade, W.startMin, W.endMin);
                        }
                    } catch (_eU3) { seatOk = false; }

                    if (!seatOk) {
                        for (var k in snapW) { if (Object.prototype.hasOwnProperty.call(snapW, k)) W[k] = snapW[k]; }
                        for (var k2 in snapB) { if (Object.prototype.hasOwnProperty.call(snapB, k2)) B[k2] = snapB[k2]; }
                        try { if (ctx.seatCommit) { ctx.seatCommit(W, grade, W.startMin, W.endMin); ctx.seatCommit(B, grade, B.startMin, B.endMin); } } catch (_eU4) {}
                        continue;
                    }
                    try { if (ctx.seatCommit) { ctx.seatCommit(B, grade, B.startMin, B.endMin); ctx.seatCommit(W, grade, W.startMin, W.endMin); } } catch (_eU5) {}
                    try { ctx.recordUse(pick, grade, B.startMin, B.endMin); } catch (_eU6) {}
                    used[String(pick.name).toLowerCase()] = 1;
                    rescued++;
                    if (ctx.onReorder) { try { ctx.onReorder(); } catch (_eU7) {} }
                    break;   // this dead window is resolved
                }

                // ── PAIR PHASE ────────────────────────────────────────────────────────
                // Some dead windows have TWO sports inside the cooldown radius, so
                // relocating one still leaves the Sport mis-spaced (live: 4 of 9
                // candidates failed the gate for exactly this reason). Relocate both:
                // W becomes the Sport, and BOTH donors become filled Specials. Net sport
                // count drops by one, which is safe here because a donor is by definition
                // a spare movable generic sport and at least one sport always remains
                // (two donors in, one Sport out). Distinct fills only — no same-day repeat.
                if (!W._concrete && W.kind === 'special') {
                    var mov = [];
                    for (var qi = 0; qi < tiles.length; qi++) {
                        var Q = tiles[qi];
                        if (!Q || Q === W) continue;
                        if (!(Q.kind === 'sport' && Q.generic === true && !Q._concrete)) continue;
                        if (Q.pinned || (Q._ref && Q._ref.share)) continue;
                        mov.push(Q);
                    }
                    var done2 = false;
                    for (var a1 = 0; a1 < mov.length && !done2; a1++) {
                        for (var a2 = a1 + 1; a2 < mov.length && !done2; a2++) {
                            var B1 = mov[a1], B2 = mov[a2];
                            if (!_sportLenOk(B1, W.durationMin, tiles)) continue;
                            attempts++;
                            // (1) Sport legal at W with BOTH donors discounted.
                            var tmpl2 = [];
                            for (var t2 = 0; t2 < tiles.length; t2++) {
                                var T2 = tiles[t2];
                                if (!T2 || T2 === W || T2 === B1 || T2 === B2) continue;
                                tmpl2.push(_toBlk(T2));
                            }
                            var ok2 = true;
                            try { ok2 = gate({ type: 'sport', event: label, startMin: W.startMin, endMin: W.endMin }, tmpl2); } catch (_eP1) { ok2 = true; }
                            if (!ok2) continue;
                            // (2) a DISTINCT fillable special for each donor, at its own length.
                            var used2 = Object.create(null);
                            for (var uk in used) { if (Object.prototype.hasOwnProperty.call(used, uk)) used2[uk] = 1; }
                            var p1 = pickAnyFillable(ctx, bunk, B1.durationMin, B1.startMin, B1.endMin, used2, false);
                            if (!p1) continue;
                            used2[String(p1.name).toLowerCase()] = 1;
                            var p2 = pickAnyFillable(ctx, bunk, B2.durationMin, B2.startMin, B2.endMin, used2, false);
                            if (!p2) continue;
                            // (3) COMMIT all three, with rollback if any seat gate refuses.
                            var snaps = [];
                            var trio = [W, B1, B2];
                            for (var si = 0; si < trio.length; si++) {
                                var X = trio[si];
                                snaps.push({ t: X, kind: X.kind, name: X.name, generic: X.generic, subcat: X.subcat, _ref: X._ref, _concrete: X._concrete, _origin: X._origin });
                            }
                            try { if (ctx.seatRelease) { for (var ri = 0; ri < trio.length; ri++) ctx.seatRelease(trio[ri], grade, trio[ri].startMin, trio[ri].endMin); } } catch (_eP2) {}
                            W.kind = 'sport'; W.name = label; W.generic = true; W.subcat = null;
                            W._ref = snaps[1]._ref; W._origin = 'unequal-sport2';
                            B1.kind = 'special'; B1.name = p1.name; B1._concrete = p1.name; B1.generic = false;
                            B1.subcat = canon(p1.subcategory); B1._ref = snaps[0]._ref; B1._fillLoc = p1.location || null; B1._origin = 'unequal-fill2';
                            B2.kind = 'special'; B2.name = p2.name; B2._concrete = p2.name; B2.generic = false;
                            B2.subcat = canon(p2.subcategory); B2._ref = snaps[0]._ref; B2._fillLoc = p2.location || null; B2._origin = 'unequal-fill2';
                            var seatOk2 = true;
                            try {
                                if (ctx.seatGate) {
                                    for (var gi = 0; gi < trio.length && seatOk2; gi++) {
                                        if (!ctx.seatGate(trio[gi], grade, trio[gi].startMin, trio[gi].endMin)) seatOk2 = false;
                                    }
                                }
                            } catch (_eP3) { seatOk2 = false; }
                            if (!seatOk2) {
                                for (var vi = 0; vi < snaps.length; vi++) {
                                    var S2 = snaps[vi];
                                    S2.t.kind = S2.kind; S2.t.name = S2.name; S2.t.generic = S2.generic;
                                    S2.t.subcat = S2.subcat; S2.t._ref = S2._ref; S2.t._concrete = S2._concrete; S2.t._origin = S2._origin;
                                }
                                try { if (ctx.seatCommit) { for (var ci = 0; ci < trio.length; ci++) ctx.seatCommit(trio[ci], grade, trio[ci].startMin, trio[ci].endMin); } } catch (_eP4) {}
                                continue;
                            }
                            try { if (ctx.seatCommit) { for (var mi2 = 0; mi2 < trio.length; mi2++) ctx.seatCommit(trio[mi2], grade, trio[mi2].startMin, trio[mi2].endMin); } } catch (_eP5) {}
                            try { ctx.recordUse(p1, grade, B1.startMin, B1.endMin); ctx.recordUse(p2, grade, B2.startMin, B2.endMin); } catch (_eP6) {}
                            used[String(p1.name).toLowerCase()] = 1;
                            used[String(p2.name).toLowerCase()] = 1;
                            rescued++; rescuedPairs++;
                            if (ctx.onReorder) { try { ctx.onReorder(); ctx.onReorder(); } catch (_eP7) {} }
                            done2 = true;
                        }
                    }
                }
            }
            tiles.sort(function (a, b) { return a.startMin - b.startMin; });
        }
        return { rescued: rescued, attempts: attempts, pairs: rescuedPairs, bunks: bunks.length };
    }

    // fillFloorFromSport(ctx) — the case with NO dead tile to rescue.
    //
    // Every other pass here starts from a dead/empty tile. But a bunk can end the day
    // wall-to-wall and STILL be missing a subcategory its layer requires: the time that
    // should have held it was filled with a sport instead. Live (Quartets א): a completely
    // gapless day, no open slot at all, yet no `uncategorized` special anywhere — while
    // its own 40-min sport slots at 13:30 and 15:05 each had 8-9 uncategorized activities
    // sitting free. Nothing targets that, because there is no hole to notice.
    //
    // So: when a bunk is short of a required subcategory, convert ONE movable generic
    // sport into that subcategory, in place — the span never changes, so the day stays
    // wall-to-wall. Sports are the right donor because the sport demand is a floor
    // ("at least 1"), not a fixed count; we still refuse to take the bunk's last sport.
    //   ctx: { bunks:[{grade,tiles,pool,deferred,noSport}], need:{grade:{subcat:qty}},
    //          canon, specialDurs, capFits, recordUse, gate?, seatRelease/seatGate/seatCommit?,
    //          sportLabel?, onConvert?() }
    function fillFloorFromSport(ctx) {
        var bunks = (ctx && ctx.bunks) || [];
        var need = (ctx && ctx.need) || {};
        var canon = (ctx && typeof ctx.canon === 'function') ? ctx.canon : function (v) { return String(v || '').toLowerCase().trim(); };
        var gate = (ctx && typeof ctx.gate === 'function') ? ctx.gate : null;
        if (!ctx || typeof ctx.capFits !== 'function' || typeof ctx.recordUse !== 'function') return { converted: 0, attempts: 0 };
        var converted = 0, attempts = 0, blockedLastSport = 0;

        for (var bi = 0; bi < bunks.length; bi++) {
            var bunk = bunks[bi] || {};
            var tiles = bunk.tiles || [];
            if (!tiles.length) continue;
            var grade = bunk.grade;
            // Per-grade static floors, PLUS this bunk's own weekly-due floors
            // (ctx.needByBunk, keyed by bunk name — e.g. shiur '<=1' is a de-facto
            // floor of 1 on the bunk's due day; per-bunk so a not-due bunk never
            // drains the scarce weekly seat through this pass).
            var want = need[grade] || null;
            var wantB = (ctx.needByBunk && bunk.name != null && ctx.needByBunk[bunk.name]) || null;
            if (wantB) {
                var mergedWant = {};
                if (want) { for (var wk in want) { if (Object.prototype.hasOwnProperty.call(want, wk)) mergedWant[wk] = want[wk]; } }
                for (var wk2 in wantB) {
                    if (!Object.prototype.hasOwnProperty.call(wantB, wk2)) continue;
                    mergedWant[wk2] = Math.max(mergedWant[wk2] || 0, wantB[wk2] || 0);
                }
                want = mergedWant;
            }
            if (!want) continue;

            var have = Object.create(null), used = Object.create(null), sportCount = 0;
            for (var i = 0; i < tiles.length; i++) {
                var t = tiles[i];
                if (!t) continue;
                if (t.kind === 'special' && t._concrete) {
                    var k = canon(t.subcat);
                    have[k] = (have[k] || 0) + 1;
                    used[String(t._concrete).toLowerCase()] = 1;
                }
                if (t.kind === 'sport') sportCount++;
            }

            var subs = Object.keys(want);
            for (var si = 0; si < subs.length; si++) {
                var sc = subs[si];
                if ((have[sc] || 0) >= want[sc]) continue;

                for (var mi = 0; mi < tiles.length; mi++) {
                    var S = tiles[mi];
                    if (!S || S.kind !== 'sport') continue;
                    if (S.generic !== true || S._concrete) continue;        // only a movable placeholder
                    if (S.pinned || (S._ref && S._ref.share)) continue;
                    attempts++;
                    var pick = pickActivity(ctx, bunk, sc, S.durationMin, S.startMin, S.endMin, used, null);
                    var splitDur = 0, splitAtEnd = false;
                    if (!pick) {
                        // ★ DONOR SPLIT: the subcat's activities may ALL run shorter than
                        //   this sport (shiur runs 20; sports 30-50) — an exact-duration
                        //   pick can never succeed, which made weekly-due shiur structurally
                        //   unreachable here. Try each distinct shorter configured length,
                        //   largest first; the sport SURVIVES as a residual tile on the
                        //   remainder of its own span (spans preserved, wall-to-wall kept),
                        //   so this path is legal even on the bunk's last sport.
                        var _dset = {}, _dlist = [];
                        var _cands = [bunk.pool || [], bunk.deferred || []];
                        for (var _ca = 0; _ca < _cands.length; _ca++) {
                            for (var _cb = 0; _cb < _cands[_ca].length; _cb++) {
                                var _cc = _cands[_ca][_cb];
                                if (!_cc || !_cc.name || canon(_cc.subcategory) !== sc) continue;
                                var _cds = (ctx.specialDurs && ctx.specialDurs(_cc.name)) || [];
                                for (var _cd = 0; _cd < _cds.length; _cd++) {
                                    var _dv = _cds[_cd];
                                    if (!(_dv > 0) || _dv >= S.durationMin) continue;   // shorter only
                                    if (S.durationMin - _dv < 10) continue;             // residual ≥ grid step
                                    if (!_dset[_dv]) { _dset[_dv] = 1; _dlist.push(_dv); }
                                }
                            }
                        }
                        _dlist.sort(function (a, b) { return b - a; });
                        // Two anchor positions per length: START-anchored (residual sport
                        // after) and END-anchored (residual sport before). The scarce seat
                        // (shiur: one activity, cap-1) is often busy at one minute but free
                        // at the other end of the same sport span.
                        for (var _dl = 0; _dl < _dlist.length && !pick; _dl++) {
                            pick = pickActivity(ctx, bunk, sc, _dlist[_dl], S.startMin, S.startMin + _dlist[_dl], used, null);
                            if (pick) { splitDur = _dlist[_dl]; splitAtEnd = false; }
                            if (!pick) {
                                pick = pickActivity(ctx, bunk, sc, _dlist[_dl], S.endMin - _dlist[_dl], S.endMin, used, null);
                                if (pick) { splitDur = _dlist[_dl]; splitAtEnd = true; }
                            }
                        }
                    }
                    if (!pick) continue;
                    // A FULL conversion consumes the sport — never take the bunk's last one.
                    // A SPLIT leaves the residual sport in place, so the guard doesn't apply.
                    if (!splitDur && sportCount <= 1) { blockedLastSport++; continue; }
                    // special span + residual-sport span (split only)
                    var spS = splitDur ? (splitAtEnd ? S.endMin - splitDur : S.startMin) : S.startMin;
                    var spE = splitDur ? (splitAtEnd ? S.endMin : S.startMin + splitDur) : S.endMin;
                    var rsS = splitAtEnd ? S.startMin : spE;
                    var rsE = splitAtEnd ? spS : S.endMin;
                    // the special must be legal at its span (spacing/content rules) — and for a
                    // split, the residual sport must be legal at ITS span too.
                    if (gate) {
                        var tmpl = [];
                        for (var ti = 0; ti < tiles.length; ti++) {
                            var T = tiles[ti];
                            if (!T || T === S) continue;
                            tmpl.push(_toBlk(T));
                        }
                        var okG = true;
                        try {
                            okG = gate({ type: 'special', event: pick.name, _assignedSpecial: pick.name, _specialLocation: pick.name, startMin: spS, endMin: spE }, tmpl);
                        } catch (_eG) { okG = true; }
                        if (okG && splitDur) {
                            var _tmplR = tmpl.concat([{ type: 'special', event: pick.name, _assignedSpecial: pick.name, _specialLocation: pick.name, startMin: spS, endMin: spE }]);
                            try { okG = gate({ type: 'sport', event: S.name || 'Sport', startMin: rsS, endMin: rsE }, _tmplR); } catch (_eG2) { okG = true; }
                        }
                        if (!okG) continue;
                    }
                    var snap = { kind: S.kind, name: S.name, generic: S.generic, subcat: S.subcat, _ref: S._ref, _concrete: S._concrete, _origin: S._origin, startMin: S.startMin, endMin: S.endMin, durationMin: S.durationMin };
                    try { if (ctx.seatRelease) ctx.seatRelease(S, grade, S.startMin, S.endMin); } catch (_e1) {}
                    var resid = null;
                    if (splitDur) {
                        resid = { kind: 'sport', subcat: null, name: snap.name, generic: true, _concrete: null, startMin: rsS, endMin: rsE, durationMin: rsE - rsS, _ref: snap._ref, _origin: 'floor-split-residual' };
                    }
                    S.kind = 'special'; S.name = pick.name; S._concrete = pick.name; S.generic = false;
                    S.subcat = canon(pick.subcategory); S._fillLoc = pick.location || null;
                    S._origin = splitDur ? 'floor-from-sport-split' : 'floor-from-sport';
                    if (splitDur) { S.startMin = spS; S.endMin = spE; S.durationMin = splitDur; }
                    var seatOk = true;
                    try {
                        if (ctx.seatGate) {
                            seatOk = ctx.seatGate(S, grade, S.startMin, S.endMin);
                            if (seatOk && resid) seatOk = ctx.seatGate(resid, grade, resid.startMin, resid.endMin);
                        }
                    } catch (_e2) { seatOk = false; }
                    if (!seatOk) {
                        S.kind = snap.kind; S.name = snap.name; S.generic = snap.generic;
                        S.subcat = snap.subcat; S._ref = snap._ref; S._concrete = snap._concrete; S._origin = snap._origin;
                        S.startMin = snap.startMin; S.endMin = snap.endMin; S.durationMin = snap.durationMin;
                        try { if (ctx.seatCommit) ctx.seatCommit(S, grade, S.startMin, S.endMin); } catch (_e3) {}
                        continue;
                    }
                    try {
                        if (ctx.seatCommit) {
                            ctx.seatCommit(S, grade, S.startMin, S.endMin);
                            if (resid) ctx.seatCommit(resid, grade, resid.startMin, resid.endMin);
                        }
                    } catch (_e4) {}
                    try { ctx.recordUse(pick, grade, S.startMin, S.endMin); } catch (_e5) {}
                    if (resid) tiles.push(resid);
                    used[String(pick.name).toLowerCase()] = 1;
                    have[sc] = (have[sc] || 0) + 1;
                    if (!splitDur) sportCount--;                            // a split keeps the sport alive
                    converted++;
                    if (ctx.onConvert) { try { ctx.onConvert(); } catch (_e6) {} }
                    break;   // this subcat is satisfied for this bunk
                }
            }
            tiles.sort(function (a, b) { return a.startMin - b.startMin; });
        }
        return { converted: converted, attempts: attempts, blockedLastSport: blockedLastSport };
    }

    const api = { VERSION: VERSION, restructure: restructure, inWindow: inWindow, absorbUnfilledToSport: absorbUnfilledToSport, reorderDeadWindows: reorderDeadWindows, reorderDeadUnequal: reorderDeadUnequal, reorderDeadToSport: reorderDeadToSport, fillFloorFromSport: fillFloorFromSport, weeklyReleasable: weeklyReleasable, trySeatSwap: trySeatSwap };

    if (typeof window !== 'undefined') {
        window.GLStagger = api;
        if (typeof console !== 'undefined') console.log('[GLStagger] v' + VERSION + ' loaded');
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})();
