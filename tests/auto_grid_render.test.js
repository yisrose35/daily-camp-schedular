/**
 * Regression test for getBunkActivities (auto_schedule_grid.js) — the per-bunk
 * render collector for the auto grid (both the timeline and column views).
 *
 * BUG: after a date switch, _perBunkSlots (divSlots) could be rebuilt SHORTER
 *      than scheduleAssignments. The render loop was capped at
 *      `i < divSlots.length` (and bailed when divSlots[i] was missing), so every
 *      entry past the short grid was never drawn — a full schedule (verified:
 *      438 entries in memory) rendered as "+ Add" gaps in the afternoon. The
 *      realign also sized its array to divSlots.length, which could TRUNCATE and
 *      persist the loss.
 *
 * FIX: the renderer is time-based (positions by entry._startMin/_endMin), so it
 *      iterates ALL assignments and draws each from its own times, using the slot
 *      grid only as a fallback when present. Realign sizes to the longer array.
 *
 * Copies getBunkActivities verbatim.
 *
 * Run with: node --test tests/auto_grid_render.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

global.window = global;

// ── VERBATIM: getBunkActivities (auto_schedule_grid.js:202) ──
function getBunkActivities(bunk, divName) {
    var assignments = (window.scheduleAssignments || {})[bunk];
    if (!Array.isArray(assignments)) return [];

    var allDivSlots = (window.divisionTimes || {})[divName] || [];
    var divSlots = (allDivSlots._perBunkSlots && allDivSlots._perBunkSlots[bunk])
        ? allDivSlots._perBunkSlots[bunk]
        : allDivSlots;
    if (!divSlots.length) return [];

    try {
        var needsRealign = false;
        for (var _k = 0; _k < Math.min(assignments.length, divSlots.length); _k++) {
            var _a = assignments[_k]; var _ds = divSlots[_k];
            if (_a && _ds && _a._startMin != null && _ds.startMin != null && _a._startMin !== _ds.startMin) {
                needsRealign = true; break;
            }
        }
        if (needsRealign) {
            var realigned = new Array(Math.max(divSlots.length, assignments.length)).fill(null);
            for (var _i = 0; _i < assignments.length; _i++) {
                var _e = assignments[_i];
                if (!_e) continue;
                var _t = _e._startMin;
                var placed = false;
                if (_t != null) {
                    for (var _j = 0; _j < divSlots.length; _j++) {
                        if (divSlots[_j] && divSlots[_j].startMin === _t && !realigned[_j]) {
                            realigned[_j] = _e; placed = true; break;
                        }
                    }
                }
                if (!placed && _i < realigned.length && !realigned[_i]) realigned[_i] = _e;
            }
            assignments = realigned;
            window.scheduleAssignments[bunk] = realigned;
            try { window.AutoSegmentModel?.rebuildFromAssignments?.(); } catch (_e2) {}
        }
    } catch (_re) { /* non-fatal */ }

    var segmentsByBunk = (window.scheduleSegments || {})[bunk];
    var toRenderEntry = window.AutoSegmentModel?.toRenderEntry || (function (s) { return s?._source || s || null; });

    var out = [], i = 0;
    while (i < assignments.length) {
        var slotSegs = Array.isArray(segmentsByBunk?.[i]) ? segmentsByBunk[i] : null;
        if (slotSegs && slotSegs.length > 1) {
            for (var s = 0; s < slotSegs.length; s++) {
                var seg = slotSegs[s];
                var segEntry = toRenderEntry(seg);
                if (!segEntry || segEntry._isTransition) continue;
                if (segEntry.field === 'Free' || segEntry._activity === 'Free' || segEntry.event === 'Free') continue;
                var segStart = (seg.startMin != null) ? seg.startMin : (divSlots[i] ? divSlots[i].startMin : segEntry._startMin);
                var segEnd   = (seg.endMin   != null) ? seg.endMin   : (divSlots[i] ? divSlots[i].endMin   : segEntry._endMin);
                if (segStart == null || segEnd == null) continue;
                out.push({ startMin: segStart, endMin: segEnd, duration: segEnd - segStart, entry: segEntry, slotIdx: i, segIdx: s, isLeague: !!(segEntry._league || segEntry._h2h) });
            }
            i++;
            continue;
        }
        var entry = assignments[i];
        if (!entry || entry._isTransition || entry.continuation) { i++; continue; }
        if (entry.field === 'Free' || entry._activity === 'Free' || entry.event === 'Free') { i++; continue; }
        var end = i;
        while (end + 1 < assignments.length && assignments[end + 1]?.continuation) end++;
        var _dsI = divSlots[i], _dsE = divSlots[end];
        var entryStart = (typeof entry._startMin === 'number') ? entry._startMin : (_dsI ? _dsI.startMin : null);
        var entryEnd   = (typeof entry._endMin   === 'number') ? entry._endMin   : (_dsE ? _dsE.endMin   : null);
        if (entryStart == null || entryEnd == null) { i = end + 1; continue; }
        out.push({ startMin: entryStart, endMin: entryEnd, duration: entryEnd - entryStart, entry: entry, slotIdx: i, isLeague: !!(entry._league || entry._h2h) });
        i = end + 1;
    }
    return out;
}

// A full generated day (5 activities, morning → afternoon), each with its own times.
function fullDay() {
    return [
        { _activity: 'Swim',         _startMin: 650, _endMin: 690, _autoMode: true },
        { _activity: 'Shiur 1',      _startMin: 735, _endMin: 775, _autoSpecial: true },
        { _activity: 'Lunch',        _startMin: 780, _endMin: 810, _fixed: true },
        { _activity: 'Gymnastics',   _startMin: 855, _endMin: 895, _autoSpecial: true },
        { _activity: 'Golf Carting', _startMin: 905, _endMin: 945, _autoSpecial: true }
    ];
}

describe('auto grid render tolerates a short/reverted _perBunkSlots grid', () => {
    beforeEach(() => {
        window.scheduleSegments = undefined;
        window.AutoSegmentModel = undefined;
    });

    it('draws ALL entries when _perBunkSlots is shorter than scheduleAssignments', () => {
        // The reverted base grid has only the first 2 slots; the schedule has 5.
        window.divisionTimes = { Minors: { _perBunkSlots: { 'Minors א': [
            { startMin: 650, endMin: 690 }, { startMin: 735, endMin: 775 }
        ] } } };
        window.scheduleAssignments = { 'Minors א': fullDay() };

        const blocks = getBunkActivities('Minors א', 'Minors');
        const names = blocks.map(b => b.entry._activity);
        assert.deepEqual(names, ['Swim', 'Shiur 1', 'Lunch', 'Gymnastics', 'Golf Carting'],
            'all 5 activities render despite the 2-slot grid');
        // Afternoon entries keep their real times.
        const golf = blocks.find(b => b.entry._activity === 'Golf Carting');
        assert.equal(golf.startMin, 905);
        assert.equal(golf.endMin, 945);
    });

    it('still renders correctly when the grid matches (no regression)', () => {
        window.divisionTimes = { Minors: { _perBunkSlots: { 'Minors א': [
            { startMin: 650, endMin: 690 }, { startMin: 735, endMin: 775 },
            { startMin: 780, endMin: 810 }, { startMin: 855, endMin: 895 },
            { startMin: 905, endMin: 945 }
        ] } } };
        window.scheduleAssignments = { 'Minors א': fullDay() };
        const blocks = getBunkActivities('Minors א', 'Minors');
        assert.equal(blocks.length, 5);
    });

    it('an empty _perBunkSlots grid (length 0) still bails (no crash)', () => {
        window.divisionTimes = { Minors: { _perBunkSlots: { 'Minors א': [] } } };
        window.scheduleAssignments = { 'Minors א': fullDay() };
        assert.deepEqual(getBunkActivities('Minors א', 'Minors'), []);
    });

    it('realign never truncates scheduleAssignments to the short grid', () => {
        // Force a realign (slot[0].startMin differs from entry[0]._startMin) with a
        // grid shorter than the schedule. The persisted array must keep all entries.
        window.divisionTimes = { Minors: { _perBunkSlots: { 'Minors א': [
            { startMin: 999, endMin: 1010 }   // mismatched + short → triggers realign
        ] } } };
        window.scheduleAssignments = { 'Minors א': fullDay() };
        getBunkActivities('Minors א', 'Minors');
        assert.equal(window.scheduleAssignments['Minors א'].filter(Boolean).length, 5,
            'all 5 entries survive realign (not truncated to the 1-slot grid)');
    });
});
