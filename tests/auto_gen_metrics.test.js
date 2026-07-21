/**
 * Tests for auto_gen_metrics.js — the Auto Builder Free/gap scoreboard.
 *
 * Run with: node --test tests/auto_gen_metrics.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { computeAutoGenMetrics, isFreeEntry, isPlaceholderEntry } = require('../auto_gen_metrics.js');

// ---------------------------------------------------------------------------
// Helpers — build the two parallel-by-index structures the auto engine emits:
//   divisionTimes[div]._perBunkSlots[bunk][i] = { startMin, endMin }
//   scheduleAssignments[bunk][i]              = entry
// ---------------------------------------------------------------------------
function slot(startMin, endMin) { return { startMin, endMin }; }
function act(name, extra = {}) { return Object.assign({ _activity: name }, extra); }
function free(source) { return { _activity: 'Free', field: 'Free', _source: source }; }
// A generic-layout placeholder tile: rendered as a category name, _generic:true.
function placeholder(subcat, extra = {}) {
    return Object.assign({ _activity: 'Special', event: 'Special', _generic: true, _subcat: subcat }, extra);
}

// ---------------------------------------------------------------------------
describe('isFreeEntry', () => {
    it('treats null/undefined as free (empty slot)', () => {
        assert.strictEqual(isFreeEntry(null), true);
        assert.strictEqual(isFreeEntry(undefined), true);
    });
    it('treats a "Free" activity/event/field as free', () => {
        assert.strictEqual(isFreeEntry({ _activity: 'Free' }), true);
        assert.strictEqual(isFreeEntry({ event: 'free' }), true);
        assert.strictEqual(isFreeEntry({ field: 'Free' }), true);
    });
    it('treats a real activity as not free', () => {
        assert.strictEqual(isFreeEntry({ _activity: 'Basketball' }), false);
    });
});

describe('isPlaceholderEntry', () => {
    it('flags an unfilled generic tile (_generic:true)', () => {
        assert.strictEqual(isPlaceholderEntry({ _activity: 'Special', _generic: true }), true);
    });
    it('does not flag a filled tile (_generic:false) or a normal entry', () => {
        assert.strictEqual(isPlaceholderEntry({ _activity: 'Cooking', _generic: false }), false);
        assert.strictEqual(isPlaceholderEntry({ _activity: 'Cooking' }), false);
        assert.strictEqual(isPlaceholderEntry(null), false);
    });
});

describe('computeAutoGenMetrics — generic placeholders are NOT filled', () => {
    it('counts a _generic tile as placeholder, excludes it from fill', () => {
        const divisionTimes = { A: { _perBunkSlots: { b1: [slot(600, 640), slot(640, 680)] } } };
        const sched = { b1: [act('Basketball'), placeholder('uncategorized')] };
        const m = computeAutoGenMetrics(sched, divisionTimes);
        assert.strictEqual(m.total.filledMinutes, 40);
        assert.strictEqual(m.total.placeholderMinutes, 40);
        assert.strictEqual(m.total.placeholderSlots, 1);
        assert.strictEqual(m.total.freeMinutes, 0);
        assert.strictEqual(m.total.deadMinutes, 40);
        // real fill is 40/80 = 50%, NOT 100% — this is the whole point.
        assert.strictEqual(m.fillRatePct, 50);
        assert.strictEqual(m.placeholderBySubcat.uncategorized.count, 1);
        assert.strictEqual(m.placeholderBySubcat.uncategorized.minutes, 40);
    });

    it('a filled generic tile (_generic:false) counts as real fill', () => {
        const divisionTimes = { A: { _perBunkSlots: { b1: [slot(600, 640)] } } };
        const sched = { b1: [act('Cooking', { _generic: false, _subcat: 'uncategorized' })] };
        const m = computeAutoGenMetrics(sched, divisionTimes);
        assert.strictEqual(m.total.filledMinutes, 40);
        assert.strictEqual(m.total.placeholderMinutes, 0);
        assert.strictEqual(m.fillRatePct, 100);
    });

    it('buckets placeholders by subcategory and ranks worst bunks', () => {
        const divisionTimes = { A: { _perBunkSlots: {
            b1: [slot(600, 640), slot(640, 680)],
            b2: [slot(600, 640), slot(640, 680)]
        } } };
        const sched = {
            b1: [placeholder('uncategorized'), placeholder('sports')],
            b2: [act('Cooking'), act('Art')]
        };
        const m = computeAutoGenMetrics(sched, divisionTimes);
        assert.strictEqual(m.total.placeholderMinutes, 80);
        assert.strictEqual(m.placeholderBySubcat.uncategorized.minutes, 40);
        assert.strictEqual(m.placeholderBySubcat.sports.minutes, 40);
        assert.strictEqual(m.worstBunks[0].bunk, 'b1');
        assert.strictEqual(m.worstBunks[0].placeholderMinutes, 80);
    });
});

describe('computeAutoGenMetrics — capacity advice (seats short)', () => {
    it('reports peak simultaneous placeholder demand per subcat as seatsShort', () => {
        // Two bunks, both with an uncategorized placeholder overlapping 10:00-10:40
        // → at the peak, 2 tiles want uncategorized at once → 2 seats short.
        const divisionTimes = { A: { _perBunkSlots: {
            b1: [slot(600, 640)],
            b2: [slot(600, 640)]
        } } };
        const sched = {
            b1: [placeholder('uncategorized')],
            b2: [placeholder('uncategorized')]
        };
        const m = computeAutoGenMetrics(sched, divisionTimes);
        assert.strictEqual(m.capacityAdvice.length, 1);
        assert.strictEqual(m.capacityAdvice[0].subcat, 'uncategorized');
        assert.strictEqual(m.capacityAdvice[0].placeholderSlots, 2);
        assert.strictEqual(m.capacityAdvice[0].seatsShort, 2);
    });

    it('non-overlapping placeholders of the same subcat need only 1 seat', () => {
        const divisionTimes = { A: { _perBunkSlots: {
            b1: [slot(600, 640), slot(640, 680)]
        } } };
        const sched = { b1: [placeholder('workshops'), placeholder('workshops')] };
        const m = computeAutoGenMetrics(sched, divisionTimes);
        assert.strictEqual(m.capacityAdvice[0].subcat, 'workshops');
        assert.strictEqual(m.capacityAdvice[0].placeholderSlots, 2);
        assert.strictEqual(m.capacityAdvice[0].seatsShort, 1); // serialized, not concurrent
    });

    it('ranks subcats by dead minutes and is empty when nothing is placeholder', () => {
        const divisionTimes = { A: { _perBunkSlots: { b1: [slot(600, 640)] } } };
        const sched = { b1: [act('Cooking')] };
        const m = computeAutoGenMetrics(sched, divisionTimes);
        assert.deepStrictEqual(m.capacityAdvice, []);
    });
});

describe('computeAutoGenMetrics — filled vs free minutes', () => {
    it('counts a fully-filled bunk as 100% fill, zero dead', () => {
        const divisionTimes = { A: { _perBunkSlots: { b1: [slot(600, 640), slot(640, 685)] } } };
        const sched = { b1: [act('Basketball'), act('Cooking')] };
        const m = computeAutoGenMetrics(sched, divisionTimes);
        assert.strictEqual(m.total.bunks, 1);
        assert.strictEqual(m.total.filledMinutes, 85);
        assert.strictEqual(m.total.freeMinutes, 0);
        assert.strictEqual(m.total.uncoveredMinutes, 0);
        assert.strictEqual(m.total.deadMinutes, 0);
        assert.strictEqual(m.fillRatePct, 100);
    });

    it('counts a Free cell as free minutes and buckets it by _source', () => {
        const divisionTimes = { A: { _perBunkSlots: { b1: [slot(600, 640), slot(640, 680)] } } };
        const sched = { b1: [act('Basketball'), free('sub-min-sweep')] };
        const m = computeAutoGenMetrics(sched, divisionTimes);
        assert.strictEqual(m.total.filledMinutes, 40);
        assert.strictEqual(m.total.freeMinutes, 40);
        assert.strictEqual(m.total.freeSlots, 1);
        assert.strictEqual(m.freeBySource['sub-min-sweep'].count, 1);
        assert.strictEqual(m.freeBySource['sub-min-sweep'].minutes, 40);
        assert.strictEqual(m.fillRatePct, 50);
    });

    it('labels an unlabeled Free (no _source) as "(unlabeled)"', () => {
        const divisionTimes = { A: { _perBunkSlots: { b1: [slot(600, 620)] } } };
        const sched = { b1: [{ _activity: 'Free' }] };
        const m = computeAutoGenMetrics(sched, divisionTimes);
        assert.ok(m.freeBySource['(unlabeled)']);
        assert.strictEqual(m.freeBySource['(unlabeled)'].minutes, 20);
    });

    it('treats a null entry as an empty free slot', () => {
        const divisionTimes = { A: { _perBunkSlots: { b1: [slot(600, 620), slot(620, 640)] } } };
        const sched = { b1: [act('Soccer'), null] };
        const m = computeAutoGenMetrics(sched, divisionTimes);
        assert.strictEqual(m.total.freeSlots, 1);
        assert.strictEqual(m.total.freeMinutes, 20);
    });
});

describe('computeAutoGenMetrics — uncovered (physical) gaps', () => {
    it('detects a hole between two slots that no cell covers', () => {
        // 10:00-10:40 filled, then a 20-min physical hole, then 11:00-11:40 filled.
        const divisionTimes = { A: { _perBunkSlots: { b1: [slot(600, 640), slot(660, 700)] } } };
        const sched = { b1: [act('Basketball'), act('Cooking')] };
        const m = computeAutoGenMetrics(sched, divisionTimes);
        assert.strictEqual(m.total.filledMinutes, 80);
        assert.strictEqual(m.total.freeMinutes, 0);
        assert.strictEqual(m.total.uncoveredMinutes, 20);
        assert.strictEqual(m.total.deadMinutes, 20);
        // span = 700-600 = 100, filled 80 -> 80%
        assert.strictEqual(m.fillRatePct, 80);
    });
});

describe('computeAutoGenMetrics — empty "+ Add" cells vs the day window', () => {
    it('counts leading empty time (before the first slot) as uncovered', () => {
        // Division day runs 9:20–11:20 (560–680). Bunk only has a slot at
        // 10:20–11:00 filled — the 60 min before it (the "+ Add" cells the
        // grid draws) must count as uncovered, not vanish.
        const divisionTimes = { A: { _perBunkSlots: { b1: [slot(620, 660)] } } };
        const sched = { b1: [act('Davening')] };
        const m = computeAutoGenMetrics(sched, divisionTimes, {
            dayWindows: { A: { startMin: 560, endMin: 680 } }
        });
        assert.strictEqual(m.total.filledMinutes, 40);
        // window 560–680 = 120 min; filled 40 → 80 uncovered (60 lead + 20 trail)
        assert.strictEqual(m.total.uncoveredMinutes, 80);
        assert.strictEqual(m.total.deadMinutes, 80);
        assert.strictEqual(m.fillRatePct, Math.round((40 / 120) * 1000) / 10);
    });

    it('counts trailing empty time (after the last slot) as uncovered', () => {
        const divisionTimes = { A: { _perBunkSlots: { b1: [slot(540, 600)] } } };
        const sched = { b1: [act('Swim')] };
        const m = computeAutoGenMetrics(sched, divisionTimes, {
            dayWindows: { A: { startMin: 540, endMin: 660 } }
        });
        assert.strictEqual(m.total.filledMinutes, 60);
        assert.strictEqual(m.total.uncoveredMinutes, 60); // 600–660 empty tail
    });

    it('never yields negative uncovered when a slot runs past the day window', () => {
        // Slot 540–700 but the window says the day ends at 660 — the extra
        // filled time extends the span, it does not subtract from it.
        const divisionTimes = { A: { _perBunkSlots: { b1: [slot(540, 700)] } } };
        const sched = { b1: [act('Trip')] };
        const m = computeAutoGenMetrics(sched, divisionTimes, {
            dayWindows: { A: { startMin: 540, endMin: 660 } }
        });
        assert.strictEqual(m.total.filledMinutes, 160);
        assert.strictEqual(m.total.uncoveredMinutes, 0);
        assert.strictEqual(m.fillRatePct, 100);
    });

    it('with no dayWindow, span stays the bunk extent (backward compatible)', () => {
        const divisionTimes = { A: { _perBunkSlots: { b1: [slot(620, 660)] } } };
        const sched = { b1: [act('Davening')] };
        const m = computeAutoGenMetrics(sched, divisionTimes); // no opts
        assert.strictEqual(m.total.uncoveredMinutes, 0);
        assert.strictEqual(m.fillRatePct, 100);
    });

    it('reports WHERE the empty time is (the 1st-Grade morning-gap case)', () => {
        // 1st Grade day starts 9:20 (560); first activity is Davening 10:20 (620).
        // The 9:20–10:20 lead must be reported as an empty interval, not just a count.
        const divisionTimes = { '1st Grade': { _perBunkSlots: { Leebi5: [slot(620, 660)] } } };
        const sched = { Leebi5: [act('Davening')] };
        const m = computeAutoGenMetrics(sched, divisionTimes, {
            dayWindows: { '1st Grade': { startMin: 560, endMin: 660 } }
        });
        const wb = m.worstBunks[0];
        assert.strictEqual(wb.bunk, 'Leebi5');
        assert.strictEqual(wb.uncoveredMinutes, 60);
        assert.deepStrictEqual(wb.emptyIntervals, [{ startMin: 560, endMin: 620 }]);
        // and the division reports the window it measured against
        assert.strictEqual(m.byDivision['1st Grade'].dayWindow.startMin, 560);
        assert.strictEqual(m.byDivision['1st Grade'].dayWindow.endMin, 660);
    });

    it('locates an internal hole as its own empty interval', () => {
        const divisionTimes = { A: { _perBunkSlots: { b1: [slot(600, 640), slot(660, 700)] } } };
        const sched = { b1: [act('Swim'), act('Art')] };
        const m = computeAutoGenMetrics(sched, divisionTimes); // no window → bunk extent
        assert.deepStrictEqual(m.worstBunks[0].emptyIntervals, [{ startMin: 640, endMin: 660 }]);
    });
});

describe('computeAutoGenMetrics — continuation slots count as filled', () => {
    it('a multi-slot block (activity + continuation) is all filled time', () => {
        const divisionTimes = { A: { _perBunkSlots: { b1: [slot(600, 640), slot(640, 680)] } } };
        const sched = { b1: [act('Swim'), { _activity: 'Swim', continuation: true }] };
        const m = computeAutoGenMetrics(sched, divisionTimes);
        assert.strictEqual(m.total.filledMinutes, 80);
        assert.strictEqual(m.total.freeMinutes, 0);
        assert.strictEqual(m.total.continuationSlots, 1);
        assert.strictEqual(m.fillRatePct, 100);
    });
});

describe('computeAutoGenMetrics — aggregation', () => {
    it('rolls up per-division and ranks worst bunks by dead minutes', () => {
        const divisionTimes = {
            A: { _perBunkSlots: {
                b1: [slot(600, 640), slot(640, 680)],   // 40 filled + 40 free
                b2: [slot(600, 640), slot(640, 680)]    // 80 filled
            } },
            B: { _perBunkSlots: {
                b3: [slot(600, 660), slot(680, 720)]    // 100 filled + 20 uncovered
            } }
        };
        const sched = {
            b1: [act('Basketball'), free('null-bucket-fill-free')],
            b2: [act('Soccer'), act('Cooking')],
            b3: [act('Hockey'), act('Art')]
        };
        const m = computeAutoGenMetrics(sched, divisionTimes);
        assert.strictEqual(m.total.divisions, 2);
        assert.strictEqual(m.total.bunks, 3);
        assert.strictEqual(m.byDivision.A.freeMinutes, 40);
        assert.strictEqual(m.byDivision.B.uncoveredMinutes, 20);
        // worst bunk should be b1 (40 dead) ahead of b3 (20 dead); b2 has none.
        assert.strictEqual(m.worstBunks[0].bunk, 'b1');
        assert.strictEqual(m.worstBunks[0].deadMinutes, 40);
        assert.strictEqual(m.worstBunks[1].bunk, 'b3');
    });

    it('ignores divisions without per-bunk slots (manual-mode grids)', () => {
        const divisionTimes = { M: [slot(600, 640)] }; // array, not _perBunkSlots
        const sched = { b1: [act('Basketball')] };
        const m = computeAutoGenMetrics(sched, divisionTimes);
        assert.strictEqual(m.total.divisions, 0);
        assert.strictEqual(m.total.bunks, 0);
    });

    it('handles empty inputs without throwing', () => {
        const m = computeAutoGenMetrics({}, {});
        assert.strictEqual(m.total.bunks, 0);
        assert.strictEqual(m.fillRatePct, 100);
        assert.deepStrictEqual(m.freeBySource, {});
    });
});
