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

    var VERSION = '0.2.0';

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
        // Optional LAYOUT gate: gate(block,template)->bool. Lets the caller veto a
        // generic tile that breaks a SPACING rule (e.g. "no sport within 40min of a
        // sport") — checked against already-placed tiles. NOT a content gate (it
        // never decides WHICH activity); a sport blocked here is replaced by a
        // special so the period still tiles wall-to-wall. Omitted => no gating.
        var gate = (typeof ctx.gate === 'function') ? ctx.gate : null;

        var periods = (ctx.periods || []).filter(function (p) {
            return p && !p.isBreak && _num(p.startMin) != null && _num(p.endMin) != null && p.endMin > p.startMin;
        });
        var pinned = (ctx.pinned || []).filter(function (b) { return b && _num(b.startMin) != null && _num(b.endMin) != null; });
        var floating = ctx.floating || [];

        // Two quotas per demand key:
        //   remaining = FLOOR (qty) — drives the floor bonus + unmetSpecialFloors;
        //               consumed once the floor is met. (sport => Infinity)
        //   capRem    = CAP — the MAX times the kind may appear; drives candidate
        //               eligibility. Specials may exceed their floor up to the cap
        //               (so a sport-spacing-blocked window can still tile with an
        //               extra special). Uncapped => Infinity.
        var remaining = {}, capRem = {};
        floating.forEach(function (d) {
            var k = _demandKey(d);
            var floor = (d.qty == null) ? Infinity : d.qty;
            var cap = (d.cap == null) ? Infinity : d.cap;
            remaining[k] = (remaining[k] == null) ? floor : Math.max(remaining[k], floor);
            capRem[k] = (capRem[k] == null) ? cap : Math.max(capRem[k], cap);
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

        // Lay a packing's segments at absolute times from `start` (no commit).
        function _laySegs(segs, start) {
            var c = start, out = [];
            for (var i = 0; i < segs.length; i++) {
                out.push({ kind: segs[i].kind, subcat: segs[i].subcat || null, name: segs[i].name, _key: segs[i]._key,
                           startMin: c, endMin: c + segs[i].durationMin, durationMin: segs[i].durationMin });
                c += segs[i].durationMin;
            }
            return out;
        }
        // Map a layout tile/segment ({kind,name,...}) to a rules-engine block
        // ({type,event,...}) — the gate + rules.js blockMatchesDescriptor read
        // .type/.event, so the template entries MUST expose them.
        function _toBlock(x) {
            var b = { type: x.kind, event: x.name, startMin: x.startMin, endMin: x.endMin };
            if (x.kind === 'special') { b._assignedSpecial = x.name; b._specialLocation = x.name; }
            return b;
        }
        // Every laid segment must pass the gate against the already-placed `tiles`
        // PLUS the other segments in this same window (so two tiles in one window
        // are spacing-checked against each other too).
        function _gatePass(laid) {
            if (!gate) return true;
            for (var i = 0; i < laid.length; i++) {
                var block = _toBlock(laid[i]);
                var template = tiles.concat(laid.slice(0, i)).concat(laid.slice(i + 1)).map(_toBlock);
                var ok = true;
                try { ok = gate(block, template); } catch (e) { ok = true; }
                if (!ok) return false;
            }
            return true;
        }
        // First packing (best-scored first) whose laid segments all pass the gate.
        function _pickGated(packings, start) {
            for (var p = 0; p < packings.length; p++) {
                var laid = _laySegs(packings[p].segments, start);
                if (_gatePass(laid)) return laid;
            }
            return null;
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
                    if (!(capRem[key] > 0)) continue;
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

                // Pick the best packing that passes the spacing gate. If none pass —
                // a filler (sport) is spacing-blocked here — SWAP it for a still-NEEDED
                // demand rather than dropping it: retry with ONLY specials, scored so an
                // unmet layer floor wins first (floorBonus), so the window fills with
                // something the bunk still owes (the human "put a needed special between
                // two sports" move). The blocked sport is NOT lost — sport is unlimited
                // filler, so it simply lands in the next rule-compliant window.
                // No gate => packings[0] outright (unchanged legacy behavior).
                var laid = _pickGated(packings, w.start);
                if (!laid && gate) {
                    var spCands = [];
                    for (var sci = 0; sci < cands.length; sci++) { if (cands[sci].kind === 'special') spCands.push(cands[sci]); }
                    var spPack = [];
                    if (spCands.length) {
                        try { spPack = packer.pack({ periodLengthMin: len, candidates: spCands, granularityMin: gran, minSegmentMin: minSeg, allowRepeat: false, maxSegments: maxSegments, topN: topN, scoreFn: scoreFn }) || []; } catch (e) { spPack = []; }
                    }
                    laid = _pickGated(spPack, w.start);
                }
                if (!laid) { rec.reason = packings.length ? 'all-packings-gated' : 'no-exact-tiling'; planWindows.push(rec); stats.residualMin += len; continue; }

                for (var ci = 0; ci < laid.length; ci++) {
                    var seg = laid[ci];
                    var t = { kind: seg.kind, subcat: seg.subcat || null, name: seg.name,
                              startMin: seg.startMin, endMin: seg.endMin, durationMin: seg.durationMin,
                              generic: true, pinned: false };
                    tiles.push(t); rec.tiles.push(t);
                    if (seg.kind === 'special') {
                        if (remaining[seg._key] > 0 && remaining[seg._key] !== Infinity) remaining[seg._key]--;
                        if (capRem[seg._key] > 0 && capRem[seg._key] !== Infinity) capRem[seg._key]--;
                    }
                    stats.tilesPlaced++;
                }
                rec.tiled = true; rec.residualMin = 0;
                stats.windowsTiled++;
                planWindows.push(rec);
            }
            periodPlans.push({ period: period, windows: planWindows });
        }

        // ── SWAP REPAIR (gate-only, general) ──────────────────────────────────
        // A window the gate left untiled is NOT abandoned. To open a legal slot we
        // relocate a CONTIGUOUS RUN of already-placed tiles whose durations sum to
        // the empty window (a 40, or 30+10, 20+20, 4×10, …) into that window, and
        // drop a replacement tile into the region they vacated — EVERY move re-checked
        // against the gate (which carries ALL the camp's rules: sport↔sport spacing,
        // special↔special spacing, no-sport-after-lunch, …). So the same "move that
        // over and put the needed thing in its place" works across the board, for any
        // rule and any kind. Bounded; default (no gate) leaves this off.
        if (gate) {
            var _resid = [];
            for (var ppi = 0; ppi < periodPlans.length; ppi++) {
                var pw = periodPlans[ppi].windows;
                for (var pwi = 0; pwi < pw.length; pwi++) {
                    var rr = pw[pwi];
                    if (!rr.tiled && rr.len >= minSeg && rr.len % gran === 0) _resid.push(rr);
                }
            }
            var _moved = [];                                  // tiles already relocated (no thrash)
            var _isMoved = function (t) { for (var i = 0; i < _moved.length; i++) if (_moved[i] === t) return true; return false; };
            for (var ridx = 0; ridx < _resid.length; ridx++) {
                var W2 = _resid[ridx];
                var L = W2.len;
                // Replacement-tile candidates for the vacated region (a single tile of
                // length L): the filler (sport/activity) first, then any special whose
                // configured duration is exactly L and still has cap. The gate decides
                // which is legal there.
                var kCands = [];
                for (var fk = 0; fk < floating.length; fk++) {
                    var fd = floating[fk]; var kk = _demandKey(fd);
                    if (fd.kind !== 'special') { kCands.push({ kind: fd.kind, name: _label(fd), subcat: null, key: kk }); continue; }
                    var durs = (fd.durations && fd.durations.length) ? fd.durations : _durRange(fd.dMin, fd.dMax, gran);
                    if (capRem[kk] > 0 && durs.indexOf(L) >= 0) kCands.push({ kind: 'special', name: _label(fd), subcat: fd.subcat || null, key: kk });
                }
                if (!kCands.length) continue;
                // movable tiles (generic, not pinned, not already relocated), by time
                var mov = [];
                for (var mi = 0; mi < tiles.length; mi++) { var tt = tiles[mi]; if (tt.generic && !tt.pinned && !_isMoved(tt)) mov.push(tt); }
                mov.sort(function (a, b) { return a.startMin - b.startMin; });

                var done = false;
                for (var s = 0; s < mov.length && !done; s++) {
                    // grow a CONTIGUOUS run from s whose durations sum to exactly L
                    var run = [mov[s]], sum = mov[s].durationMin, e = s;
                    while (sum < L && e + 1 < mov.length && mov[e + 1].startMin === mov[e].endMin) { e++; run.push(mov[e]); sum += mov[e].durationMin; }
                    if (sum !== L) continue;
                    var Rs = run[0].startMin, Re = Rs + L;
                    if (Rs === W2.start) continue;
                    var keep = [];
                    for (var ki = 0; ki < tiles.length; ki++) { if (run.indexOf(tiles[ki]) < 0) keep.push(_toBlock(tiles[ki])); }
                    for (var kc = 0; kc < kCands.length && !done; kc++) {
                        var K = kCands[kc];
                        var kBlock = { type: K.kind, event: K.name, startMin: Rs, endMin: Re };
                        if (K.kind === 'special') { kBlock._assignedSpecial = K.name; kBlock._specialLocation = K.name; }
                        var okK = true; try { okK = gate(kBlock, keep); } catch (e2) { okK = true; }
                        if (!okK) continue;
                        // relocate the run into W (sequential), gate-checking each move
                        var cur = W2.start, movedBlocks = [], allOk = true;
                        for (var r2 = 0; r2 < run.length; r2++) {
                            var rt = run[r2];
                            var rb = { type: rt.kind, event: rt.name, startMin: cur, endMin: cur + rt.durationMin };
                            if (rt.kind === 'special') { rb._assignedSpecial = rt.name; rb._specialLocation = rt.name; }
                            var okM = true; try { okM = gate(rb, keep.concat([kBlock]).concat(movedBlocks)); } catch (e3) { okM = true; }
                            if (!okM) { allOk = false; break; }
                            movedBlocks.push(rb); cur += rt.durationMin;
                        }
                        if (!allOk) continue;
                        // COMMIT: run -> W (in order), replacement K -> vacated region
                        var c2 = W2.start;
                        for (var r3 = 0; r3 < run.length; r3++) { run[r3].startMin = c2; run[r3].endMin = c2 + run[r3].durationMin; c2 += run[r3].durationMin; _moved.push(run[r3]); }
                        tiles.push({ kind: K.kind, subcat: K.subcat || null, name: K.name, startMin: Rs, endMin: Re, durationMin: L, generic: true, pinned: false });
                        if (K.kind === 'special') {
                            if (remaining[K.key] > 0 && remaining[K.key] !== Infinity) remaining[K.key]--;
                            if (capRem[K.key] > 0 && capRem[K.key] !== Infinity) capRem[K.key]--;
                        }
                        W2.tiled = true; W2.residualMin = 0; W2.reason = 'swap-repaired';
                        stats.windowsTiled++; stats.tilesPlaced++; stats.residualMin -= L;
                        done = true;
                    }
                }
            }
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
                floating: b.floating, opts: opts, packer: o.packer, gate: o.gate
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
