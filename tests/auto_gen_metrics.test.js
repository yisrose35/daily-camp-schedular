/**
 * Tests for auto_gen_metrics.js — the Auto Builder Free/gap scoreboard.
 *
 * Run with: node --test tests/auto_gen_metrics.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { computeAutoGenMetrics, isFreeEntry } = require('../auto_gen_metrics.js');

// ---------------------------------------------------------------------------
// Helpers — build the two parallel-by-index structures the auto engine emits:
//   divisionTimes[div]._perBunkSlots[bunk][i] = { startMin, endMin }
//   scheduleAssignments[bunk][i]              = entry
// ---------------------------------------------------------------------------
function slot(startMin, endMin) { return { startMin, endMin }; }
function act(name, extra = {}) { return Object.assign({ _activity: name }, extra); }
function free(source) { return { _activity: 'Free', field: 'Free', _source: source }; }

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
