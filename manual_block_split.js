// =============================================================================
// manual_block_split.js — carve one manual skeleton block into timed segments
// =============================================================================
// A manual skeleton tile is a block of wall-clock time ("Special Activity,
// 10:00–10:40"). Historically every bunk got exactly one activity in it, so the
// block length WAS the activity length. This module lets the same block resolve
// differently per bunk: one bunk takes a single 40-minute activity, another
// takes 2x20, whichever the bunk's own accessible activities and rotation needs
// support.
//
// It decides DURATIONS ONLY — never which activity lands where. Carving is a
// layout question; filling is a content question the solver already answers with
// the full gate stack (access, field capacity, cooldown, rotation). Splitting
// here and filling there keeps one owner per decision.
//
// A carving is only offered when every one of its parts is a length some
// activity the bunk can actually receive is allowed to run, so the solver is
// never handed a 20-minute hole it has nothing to put in.
//
// Composition enumeration is window.PeriodPacker.enumerateCompositions — the
// same exact subset-sum primitive the auto builder's layout engine uses.
// node --test-able exactly like period_packer.js.
// =============================================================================
(function () {
    'use strict';

    var VERSION = '1.0.0';

    function _getPacker(opts) {
        if (opts && opts.packer) return opts.packer;
        if (typeof window !== 'undefined' && window.PeriodPacker) return window.PeriodPacker;
        if (typeof require === 'function') { try { return require('./period_packer.js'); } catch (e) { /* ignore */ } }
        return null;
    }

    function _int(v) {
        var n = parseInt(v, 10);
        return (isFinite(n) && n > 0) ? n : null;
    }

    // Allowed lengths, de-duped and ascending. An activity with no configured
    // duration runs at whatever the block is, so it contributes the full length.
    function normalizeDurations(list, blockLength) {
        var seen = {};
        var out = [];
        (list || []).forEach(function (d) {
            var n = _int(d);
            if (n == null || n > blockLength) return;
            if (seen[n]) return;
            seen[n] = true;
            out.push(n);
        });
        out.sort(function (a, b) { return a - b; });
        return out;
    }

    // Score a carving against what the bunk still wants. `demand` maps a
    // duration to how many more activities of that length the bunk could use;
    // a carving that lands two wanted 20s beats one that lands a single 40 the
    // bunk has already had its fill of. Absent demand data every carving ties
    // and the fewest-segment tiebreak below keeps today's single-tile shape.
    function scoreComposition(comp, demand) {
        var remaining = {};
        var k;
        for (k in (demand || {})) {
            var v = _int(demand[k]);
            if (v != null) remaining[k] = v;
        }
        var met = 0;
        for (var i = 0; i < comp.length; i++) {
            var d = comp[i];
            if (remaining[d] > 0) { met++; remaining[d]--; }
        }
        // Fewer, larger tiles win ties: splitting is only worth it when it
        // actually buys the bunk something.
        return met - (comp.length * 0.01);
    }

    /**
     * Carve [startMin, endMin) into segments whose lengths sum exactly to the
     * block, using only lengths the bunk's accessible activities can run.
     *
     * @param {Object} o
     *   startMin, endMin   {number}  the block's clock window
     *   durations          {number[]} allowed activity lengths for THIS bunk
     *   demand             {Object}  optional {durationMin: countStillWanted}
     *   maxSegments        {number}  default 2
     *   minSegmentMin      {number}  default 15
     *   granularityMin     {number}  default 5
     *   packer             {Object}  injectable PeriodPacker
     * @returns {{segments: Array, composition: number[], split: boolean, reason: string}}
     *   segments: [{ startMin, endMin, durationMin, index, ofTotal }]
     *   Always returns at least one segment covering the whole block, so a
     *   caller can use the result unconditionally.
     */
    function splitBlock(o) {
        o = o || {};
        var startMin = o.startMin, endMin = o.endMin;
        var whole = function (reason) {
            return {
                segments: [{ startMin: startMin, endMin: endMin, durationMin: endMin - startMin, index: 0, ofTotal: 1 }],
                composition: [endMin - startMin],
                split: false,
                reason: reason
            };
        };

        if (typeof startMin !== 'number' || typeof endMin !== 'number' || endMin <= startMin) {
            return { segments: [], composition: [], split: false, reason: 'bad-window' };
        }

        var blockLength = endMin - startMin;
        var maxSegments = _int(o.maxSegments) || 2;
        var minSegmentMin = _int(o.minSegmentMin) || 15;
        var granularityMin = _int(o.granularityMin) || 5;

        if (maxSegments < 2) return whole('split-disabled');

        var durations = normalizeDurations(o.durations, blockLength);
        if (durations.length === 0) return whole('no-durations');

        var packer = _getPacker(o);
        if (!packer || typeof packer.enumerateCompositions !== 'function') return whole('no-packer');

        var comps = packer.enumerateCompositions(blockLength, {
            maxParts: maxSegments,
            minPart: minSegmentMin,
            step: granularityMin,
            validDurations: durations
        });
        if (!comps || comps.length === 0) return whole('no-exact-fit');

        // enumerateCompositions returns ordered compositions, so [20,40] and
        // [40,20] both appear. They carve the block the same way, so keep the
        // first of each multiset — deterministic, and it halves the scoring.
        var seen = {};
        var unique = [];
        for (var i = 0; i < comps.length; i++) {
            var key = comps[i].slice().sort(function (a, b) { return a - b; }).join('+');
            if (seen[key]) continue;
            seen[key] = true;
            unique.push(comps[i]);
        }

        var best = null, bestScore = -Infinity;
        for (var j = 0; j < unique.length; j++) {
            var sc = scoreComposition(unique[j], o.demand);
            if (sc > bestScore) { bestScore = sc; best = unique[j]; }
        }
        if (!best) return whole('no-composition');
        if (best.length === 1) return whole('single-best');

        var segments = [];
        var cursor = startMin;
        for (var s = 0; s < best.length; s++) {
            segments.push({
                startMin: cursor,
                endMin: cursor + best[s],
                durationMin: best[s],
                index: s,
                ofTotal: best.length
            });
            cursor += best[s];
        }

        return { segments: segments, composition: best.slice(), split: true, reason: 'packed' };
    }

    function _nameOf(c) {
        // Specials carry `name` throughout the codebase, sports options carry
        // `activity`; accept either rather than silently dropping a whole list.
        return c && (c.activity || c.name);
    }

    /**
     * What lengths does this bunk's ROTATION actually call for right now?
     *
     * The bunk's accessible activities are ranked least-used-first out of its
     * rotation history — the same ordering the solver's own special seating uses
     * — and only the ones it is most due for are counted, at most as many as the
     * block could ever be carved into. Their lengths are the demand.
     *
     * So the same 40-minute block reads differently per bunk: a bunk whose two
     * most-owed activities are 20 minutes each wants 2x20, while a bunk owed a
     * 40-minute one wants the whole block. That is the whole point of carving
     * per bunk rather than per tile.
     *
     * This decides SHAPE only. Which activity lands in each piece is still the
     * solver's call, with the full rotation, cooldown and capacity gates — so a
     * bunk ranked here is never actually *given* anything by this function.
     *
     * @param {Array} candidates [{ activity|name, durations: [..] }]
     * @param {Array} alreadyToday activity names the bunk already has today
     * @param {Object} opts
     *   counts {Object} historicalCounts[bunk] — {activityName: timesHad}
     *   limit  {number} most pieces the block could be carved into
     * @returns {Object} { durationMin: countStillWanted }
     */
    function buildDemand(candidates, alreadyToday, opts) {
        opts = opts || {};
        var counts = opts.counts || null;
        var limit = _int(opts.limit);

        var done = {};
        (alreadyToday || []).forEach(function (n) {
            if (n) done[String(n).toLowerCase().trim()] = true;
        });

        var pool = (candidates || []).filter(function (c) {
            var actName = _nameOf(c);
            if (!actName) return false;
            // A repeat is no reason to carve the block up.
            return !done[String(actName).toLowerCase().trim()];
        });

        if (counts) {
            // Least-used first; name breaks ties so the same history always
            // produces the same carving.
            pool = pool.slice().sort(function (a, b) {
                var ca = counts[_nameOf(a)] || 0;
                var cb = counts[_nameOf(b)] || 0;
                if (ca !== cb) return ca - cb;
                return String(_nameOf(a)).localeCompare(String(_nameOf(b)));
            });
            // Past this many, an activity cannot influence the shape anyway —
            // and counting the whole catalogue would make every bunk look the
            // same, which is exactly what rotation is supposed to break up.
            if (limit != null && limit > 0) pool = pool.slice(0, limit);
        }

        var demand = {};
        pool.forEach(function (c) {
            var seen = {};
            (c.durations || []).forEach(function (d) {
                var n = _int(d);
                if (n == null || seen[n]) return;
                seen[n] = true;
                demand[n] = (demand[n] || 0) + 1;
            });
        });
        return demand;
    }

    /** Every distinct length the given candidates can run at. */
    function collectDurations(candidates) {
        var out = [];
        (candidates || []).forEach(function (c) {
            (c && c.durations || []).forEach(function (d) {
                var n = _int(d);
                if (n != null && out.indexOf(n) === -1) out.push(n);
            });
        });
        return out.sort(function (a, b) { return a - b; });
    }

    var api = {
        VERSION: VERSION,
        splitBlock: splitBlock,
        normalizeDurations: normalizeDurations,
        scoreComposition: scoreComposition,
        buildDemand: buildDemand,
        collectDurations: collectDurations
    };

    if (typeof window !== 'undefined') {
        window.ManualBlockSplit = api;
        if (typeof console !== 'undefined') console.log('[ManualBlockSplit] v' + VERSION + ' loaded');
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})();
