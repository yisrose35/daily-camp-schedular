/**
 * Tests for period_packer.js — the bounded subset-sum packer.
 *
 * Run with: node --test tests/period_packer.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const PeriodPacker = require('../period_packer.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function cand(activity, durationMin, extra = {}) {
    return { activity, durationMin, score: 1, field: activity + ' Field', ...extra };
}

function durationsOf(packing) {
    return packing.segments.map(s => s.durationMin);
}

function activitiesOf(packing) {
    return packing.segments.map(s => s.activity);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PeriodPacker.pack — single-activity cells', () => {
    it('returns one packing of [40] when only a 40-min candidate fits', () => {
        const out = PeriodPacker.pack({
            periodLengthMin: 40,
            candidates: [cand('Swim', 40, { fixed: true })],
            topN: 5
        });
        assert.strictEqual(out.length, 1);
        assert.deepStrictEqual(durationsOf(out[0]), [40]);
        assert.deepStrictEqual(activitiesOf(out[0]), ['Swim']);
        assert.strictEqual(out[0].totalMin, 40);
    });

    it('respects max 4 segments for an all-10s period', () => {
        const out = PeriodPacker.pack({
            periodLengthMin: 40,
            candidates: [
                cand('A', 10), cand('B', 10), cand('C', 10), cand('D', 10), cand('E', 10)
            ],
            maxSegments: 4,
            topN: 100
        });
        assert.ok(out.length > 0);
        for (const p of out) {
            assert.ok(p.segments.length <= 4, 'no packing should exceed maxSegments');
            assert.strictEqual(p.segments.reduce((s, x) => s + x.durationMin, 0), 40);
        }
    });
});

describe('PeriodPacker.pack — multi-segment cells', () => {
    it('produces [20,20] when two 20-min candidates exist', () => {
        const out = PeriodPacker.pack({
            periodLengthMin: 40,
            candidates: [cand('Archery', 20), cand('Climbing', 20)],
            topN: 10
        });
        const dur = out.map(durationsOf);
        assert.ok(dur.some(d => d.length === 2 && d[0] === 20 && d[1] === 20));
    });

    it('produces [10,30] / [30,10] when both durations present', () => {
        const out = PeriodPacker.pack({
            periodLengthMin: 40,
            candidates: [cand('Short', 10), cand('Long', 30)],
            topN: 10
        });
        const dur = out.map(durationsOf).map(d => d.join(','));
        assert.ok(dur.includes('10,30'));
        assert.ok(dur.includes('30,10'));
    });

    it('produces [20,10,10] / [10,20,10] / [10,10,20] ordered variants', () => {
        const out = PeriodPacker.pack({
            periodLengthMin: 40,
            candidates: [cand('A', 20), cand('B', 10), cand('C', 10)],
            topN: 100
        });
        const triples = out.map(durationsOf).filter(d => d.length === 3).map(d => d.join(','));
        assert.ok(triples.includes('20,10,10'));
        assert.ok(triples.includes('10,20,10'));
        assert.ok(triples.includes('10,10,20'));
    });
});

describe('PeriodPacker.pack — constraints', () => {
    it('returns empty when no valid packing exists', () => {
        const out = PeriodPacker.pack({
            periodLengthMin: 40,
            candidates: [cand('Only30', 30)],
            topN: 5
        });
        assert.deepStrictEqual(out, []);
    });

    it('no-repeat by default: same activity cannot appear twice', () => {
        const out = PeriodPacker.pack({
            periodLengthMin: 40,
            candidates: [cand('OnlyOne', 20)],
            topN: 10
        });
        assert.strictEqual(out.length, 0, 'should not build [20,20] from a single 20-min activity');
    });

    it('allowRepeat:true permits same activity twice', () => {
        const out = PeriodPacker.pack({
            periodLengthMin: 40,
            candidates: [cand('OnlyOne', 20)],
            allowRepeat: true,
            topN: 10
        });
        assert.ok(out.length >= 1);
        assert.deepStrictEqual(activitiesOf(out[0]), ['OnlyOne', 'OnlyOne']);
    });

    it('rejects non-multiple-of-granularity period lengths', () => {
        assert.throws(() => PeriodPacker.pack({
            periodLengthMin: 35,
            candidates: [cand('X', 10)]
        }), /multiple of granularityMin/);
    });

    it('honors minSegmentMin', () => {
        const out = PeriodPacker.pack({
            periodLengthMin: 20,
            candidates: [cand('Tiny', 5), cand('Half', 10), cand('Full', 20)],
            granularityMin: 5,
            minSegmentMin: 10,
            topN: 100
        });
        for (const p of out) {
            for (const s of p.segments) {
                assert.ok(s.durationMin >= 10, 'no segment shorter than minSegmentMin');
            }
        }
    });
});

describe('PeriodPacker.pack — scoring', () => {
    it('returns top-N ranked by default sum-of-scores', () => {
        const out = PeriodPacker.pack({
            periodLengthMin: 40,
            candidates: [
                cand('HighA', 20, { score: 100 }),
                cand('HighB', 20, { score: 100 }),
                cand('LowA', 20, { score: 1 }),
                cand('LowB', 20, { score: 1 })
            ],
            topN: 3
        });
        assert.strictEqual(out.length, 3);
        // Best packing should be two high-scorers, total = 200
        assert.strictEqual(out[0].score, 200);
        assert.ok(out[0].score >= out[1].score);
        assert.ok(out[1].score >= out[2].score);
    });

    it('respects custom scoreFn', () => {
        const out = PeriodPacker.pack({
            periodLengthMin: 40,
            candidates: [cand('A', 20), cand('B', 20), cand('C', 40)],
            scoreFn: (p) => p.segments.length, // prefer MORE segments
            topN: 5
        });
        assert.ok(out[0].segments.length >= out[out.length - 1].segments.length);
    });
});

describe('PeriodPacker.pack — realistic camp scenarios', () => {
    it('40-min period with Swim-fixed-40 packs as [Swim]', () => {
        const out = PeriodPacker.pack({
            periodLengthMin: 40,
            candidates: [
                cand('Swim', 40, { fixed: true, score: 50 }),
                cand('Archery', 20, { score: 10 }),
                cand('Gaga', 20, { score: 10 })
            ],
            topN: 1
        });
        assert.strictEqual(out.length, 1);
        assert.deepStrictEqual(activitiesOf(out[0]), ['Swim']);
    });

    it('40-min period with sport durations {10,20,40} enumerates expected compositions', () => {
        const durs = [10, 20, 40];
        const cands = [];
        ['Archery', 'Basketball', 'Soccer'].forEach(a => {
            durs.forEach(d => cands.push(cand(a, d)));
        });
        const out = PeriodPacker.pack({
            periodLengthMin: 40,
            candidates: cands,
            topN: 1000
        });
        // All packings must sum to 40, all must have ≤4 segments, no activity repeats
        for (const p of out) {
            assert.strictEqual(p.totalMin, 40);
            assert.ok(p.segments.length >= 1 && p.segments.length <= 4);
            const names = activitiesOf(p);
            assert.strictEqual(new Set(names).size, names.length, 'no activity repeats');
        }
        assert.ok(out.length > 5, 'expected multiple valid packings');
    });
});
