/**
 * Tests for manual_block_split.js — carving one manual skeleton block into
 * segments whose lengths sum exactly to the block.
 *
 * The driving scenario: the user drops a 40-minute Special block. One bunk
 * should be able to take a single 40-minute activity while another takes 2x20,
 * decided per bunk from what that bunk can actually receive and still wants.
 *
 * Run with: node --test tests/manual_block_split.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const Split = require('../manual_block_split.js');
const PeriodPacker = require('../period_packer.js');

const P = { packer: PeriodPacker };
const durs = (r) => r.segments.map(s => s.durationMin);
const spans = (r) => r.segments.map(s => [s.startMin, s.endMin]);

describe('ManualBlockSplit.splitBlock — the 40-minute block', () => {
    it('gives one 40 when only a 40-minute activity is available', () => {
        const r = Split.splitBlock({ startMin: 600, endMin: 640, durations: [40], ...P });
        assert.strictEqual(r.split, false);
        assert.deepEqual(durs(r), [40]);
        assert.deepEqual(spans(r), [[600, 640]]);
    });

    it('gives 2x20 when the bunk wants two 20-minute activities', () => {
        const r = Split.splitBlock({
            startMin: 600, endMin: 640,
            durations: [20, 40],
            demand: { 20: 2 },
            ...P
        });
        assert.strictEqual(r.split, true);
        assert.deepEqual(durs(r), [20, 20]);
        assert.deepEqual(spans(r), [[600, 620], [620, 640]], 'segments are contiguous and fill the block');
    });

    it('gives one 40 to a bunk that wants a 40 — same block, different bunk', () => {
        const r = Split.splitBlock({
            startMin: 600, endMin: 640,
            durations: [20, 40],
            demand: { 40: 1 },
            ...P
        });
        assert.strictEqual(r.split, false);
        assert.deepEqual(durs(r), [40]);
    });

    it('prefers the whole block when nothing signals a need to split', () => {
        const r = Split.splitBlock({ startMin: 600, endMin: 640, durations: [20, 40], ...P });
        assert.strictEqual(r.split, false, 'no demand data → keep the existing single-tile shape');
        assert.deepEqual(durs(r), [40]);
    });

    it('segments always sum to the block length', () => {
        for (const demand of [{ 20: 2 }, { 20: 1 }, { 40: 1 }, {}]) {
            const r = Split.splitBlock({ startMin: 600, endMin: 640, durations: [10, 20, 40], demand, maxSegments: 4, minSegmentMin: 10, granularityMin: 10, ...P });
            const total = r.segments.reduce((a, s) => a + s.durationMin, 0);
            assert.strictEqual(total, 40, `demand ${JSON.stringify(demand)} → ${durs(r)}`);
        }
    });
});

describe('ManualBlockSplit.splitBlock — feasibility', () => {
    it('never proposes a length no activity can run', () => {
        // 50-min block, activities run 20 or 40. 20+40=60 (too long), 20+20=40
        // (short), 40+40=80 (too long) — nothing tiles it exactly, so keep whole.
        const r = Split.splitBlock({ startMin: 600, endMin: 650, durations: [20, 40], ...P });
        assert.strictEqual(r.split, false);
        assert.strictEqual(r.reason, 'no-exact-fit');
        assert.deepEqual(durs(r), [50]);
    });

    it('tiles a 60-min block as 20+40 when both lengths are wanted', () => {
        const r = Split.splitBlock({
            startMin: 600, endMin: 660, durations: [20, 40], demand: { 20: 1, 40: 1 }, ...P
        });
        assert.strictEqual(r.split, true);
        assert.strictEqual(r.segments.reduce((a, s) => a + s.durationMin, 0), 60);
        assert.deepEqual(durs(r).slice().sort((a, b) => a - b), [20, 40]);
    });

    it('respects maxSegments', () => {
        const r = Split.splitBlock({
            startMin: 600, endMin: 660, durations: [20], demand: { 20: 3 }, maxSegments: 2, granularityMin: 10, minSegmentMin: 10, ...P
        });
        // 3x20 would satisfy more demand but exceeds maxSegments=2, and 2x20=40
        // doesn't fill 60, so there is no legal carving → keep whole.
        assert.strictEqual(r.split, false);
    });

    it('allows 3 segments when maxSegments permits', () => {
        const r = Split.splitBlock({
            startMin: 600, endMin: 660, durations: [20], demand: { 20: 3 }, maxSegments: 3, granularityMin: 10, minSegmentMin: 10, ...P
        });
        assert.strictEqual(r.split, true);
        assert.deepEqual(durs(r), [20, 20, 20]);
    });

    it('respects minSegmentMin', () => {
        const r = Split.splitBlock({
            startMin: 600, endMin: 640, durations: [10, 20, 30], demand: { 10: 4 },
            minSegmentMin: 20, granularityMin: 10, maxSegments: 4, ...P
        });
        // 10-min parts are below the floor, so 10+10+10+10 is not offered.
        assert.ok(r.segments.every(s => s.durationMin >= 20 || !r.split));
    });

    it('drops durations longer than the block', () => {
        assert.deepEqual(Split.normalizeDurations([20, 40, 90], 40), [20, 40]);
    });

    it('splitting is off when maxSegments is 1', () => {
        const r = Split.splitBlock({ startMin: 600, endMin: 640, durations: [20], demand: { 20: 2 }, maxSegments: 1, ...P });
        assert.strictEqual(r.split, false);
        assert.strictEqual(r.reason, 'split-disabled');
    });
});

describe('ManualBlockSplit.splitBlock — robustness', () => {
    it('returns a whole-block segment when there are no configured durations', () => {
        const r = Split.splitBlock({ startMin: 600, endMin: 640, durations: [], ...P });
        assert.strictEqual(r.split, false);
        assert.strictEqual(r.reason, 'no-durations');
        assert.deepEqual(durs(r), [40]);
    });

    it('rejects a bad window instead of inventing one', () => {
        assert.deepEqual(Split.splitBlock({ startMin: 640, endMin: 600, durations: [20], ...P }).segments, []);
        assert.deepEqual(Split.splitBlock({ startMin: 600, endMin: 600, durations: [20], ...P }).segments, []);
        assert.deepEqual(Split.splitBlock({ durations: [20], ...P }).segments, []);
    });

    it('falls back to the whole block when no packer is available', () => {
        const r = Split.splitBlock({ startMin: 600, endMin: 640, durations: [20], demand: { 20: 2 }, packer: {} });
        assert.strictEqual(r.split, false);
        assert.strictEqual(r.reason, 'no-packer');
        assert.deepEqual(durs(r), [40]);
    });

    it('is deterministic across repeated calls', () => {
        const args = { startMin: 600, endMin: 660, durations: [20, 30, 40], demand: { 20: 1, 40: 1 }, maxSegments: 3, granularityMin: 10, minSegmentMin: 10, ...P };
        const first = JSON.stringify(Split.splitBlock(args));
        for (let i = 0; i < 20; i++) {
            assert.strictEqual(JSON.stringify(Split.splitBlock(args)), first);
        }
    });

    it('marks each segment with its position in the block', () => {
        const r = Split.splitBlock({ startMin: 600, endMin: 640, durations: [20], demand: { 20: 2 }, ...P });
        assert.deepEqual(r.segments.map(s => s.index), [0, 1]);
        assert.ok(r.segments.every(s => s.ofTotal === 2));
    });
});

describe('ManualBlockSplit.scoreComposition', () => {
    it('rewards carvings that meet more of what the bunk wants', () => {
        assert.ok(Split.scoreComposition([20, 20], { 20: 2 }) > Split.scoreComposition([40], { 20: 2 }));
    });

    it('does not double-count demand beyond what is wanted', () => {
        // Only one 20 is wanted, so the second 20 earns nothing and the extra
        // tile costs a tiebreak point.
        assert.ok(Split.scoreComposition([20, 20], { 20: 1 }) < Split.scoreComposition([20], { 20: 1 }));
    });

    it('prefers fewer tiles when demand is equal', () => {
        assert.ok(Split.scoreComposition([40], {}) > Split.scoreComposition([20, 20], {}));
    });
});
