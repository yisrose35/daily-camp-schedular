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

describe('ManualBlockSplit.buildDemand', () => {
    const cands = [
        { activity: 'Slush', durations: [20] },
        { activity: 'Popcorn', durations: [20] },
        { activity: 'Ceramics', durations: [40] },
        { activity: 'Woodshop', durations: [20, 40] },
    ];

    it('counts each accessible activity at every length it can run', () => {
        assert.deepEqual(Split.buildDemand(cands, []), { 20: 3, 40: 2 });
    });

    it('skips what the bunk already had today', () => {
        assert.deepEqual(Split.buildDemand(cands, ['Slush', 'Popcorn']), { 20: 1, 40: 2 });
    });

    it('matches activity names case-insensitively', () => {
        assert.deepEqual(Split.buildDemand(cands, ['  slush  ']), { 20: 2, 40: 2 });
    });

    it('does not double-count a duration listed twice on one activity', () => {
        assert.deepEqual(Split.buildDemand([{ activity: 'X', durations: [20, 20] }], []), { 20: 1 });
    });

    it('ignores junk entries', () => {
        assert.deepEqual(Split.buildDemand([null, { durations: [20] }, { activity: 'Y', durations: [0, -5, 'x'] }], []), {});
        assert.deepEqual(Split.buildDemand(null, null), {});
    });

    it('drives the split decision end to end', () => {
        // Three unused 20-min specials → 2x20 beats a single 40.
        const demand = Split.buildDemand(cands, []);
        const r = Split.splitBlock({ startMin: 600, endMin: 640, durations: Split.collectDurations(cands), demand, ...P });
        assert.strictEqual(r.split, true);
        assert.deepEqual(durs(r), [20, 20]);
    });

    it('stops splitting once the short activities are used up', () => {
        // Only Woodshop left, and it can run 40 — one activity cannot fill 2x20.
        const demand = Split.buildDemand(cands, ['Slush', 'Popcorn', 'Ceramics']);
        const r = Split.splitBlock({ startMin: 600, endMin: 640, durations: Split.collectDurations(cands), demand, ...P });
        assert.strictEqual(r.split, false);
        assert.deepEqual(durs(r), [40]);
    });
});

describe('ManualBlockSplit.buildDemand — rotation drives the shape', () => {
    // A grade's shared pool: two short specials, one long one.
    const POOL = [
        { name: 'Slush', durations: [20] },
        { name: 'Popcorn', durations: [20] },
        { name: 'Ceramics', durations: [40] },
    ];
    const durations = Split.collectDurations(POOL);
    const carve = (counts) => Split.splitBlock({
        startMin: 600, endMin: 640, durations,
        demand: Split.buildDemand(POOL, [], { counts, limit: 2 }),
        maxSegments: 2, ...P
    });

    it('two bunks in one grade carve the SAME block differently on history alone', () => {
        // Bunk A has had both short specials plenty and is owed Ceramics.
        const a = carve({ Slush: 5, Popcorn: 5, Ceramics: 0 });
        // Bunk B is owed both short ones and has had Ceramics recently.
        const b = carve({ Slush: 0, Popcorn: 0, Ceramics: 5 });

        assert.deepEqual(durs(a), [40], 'owed the long activity → takes the whole block');
        assert.deepEqual(durs(b), [20, 20], 'owed two short ones → carves 2x20');
    });

    it('only the activities the bunk is most owed count toward the shape', () => {
        // Ceramics is the single most-owed; Slush is next. limit 2 stops Popcorn
        // from stacking a second 20 and outvoting the 40 the bunk actually needs.
        const counts = { Ceramics: 0, Slush: 1, Popcorn: 2 };
        assert.deepEqual(Split.buildDemand(POOL, [], { counts, limit: 2 }), { 40: 1, 20: 1 });
        assert.deepEqual(durs(carve(counts)), [40]);
    });

    it('without a cap the whole catalogue votes and every bunk looks alike', () => {
        const owedLong = { Ceramics: 0, Slush: 9, Popcorn: 9 };
        // Uncapped, the two short specials still contribute and win on count.
        assert.deepEqual(Split.buildDemand(POOL, [], { counts: owedLong }), { 20: 2, 40: 1 });
        // Capped to what the block could hold, the bunk's real need shows through.
        assert.deepEqual(Split.buildDemand(POOL, [], { counts: owedLong, limit: 2 }), { 40: 1, 20: 1 });
    });

    it('ranks least-used first, exactly like the solver seats specials', () => {
        const counts = { Slush: 3, Popcorn: 1, Ceramics: 2 };
        // Popcorn(1) then Ceramics(2) are the two most owed; Slush(3) drops out.
        assert.deepEqual(Split.buildDemand(POOL, [], { counts, limit: 2 }), { 20: 1, 40: 1 });
    });

    it('treats an unseen activity as most owed', () => {
        // Ceramics has no entry at all → count 0 → ahead of everything used once.
        const counts = { Slush: 1, Popcorn: 1 };
        assert.deepEqual(Split.buildDemand(POOL, [], { counts, limit: 1 }), { 40: 1 });
    });

    it('still skips what the bunk already has today, however owed it is', () => {
        const counts = { Slush: 0, Popcorn: 0, Ceramics: 9 };
        assert.deepEqual(Split.buildDemand(POOL, ['Slush'], { counts, limit: 2 }), { 20: 1, 40: 1 });
    });

    it('is deterministic when counts tie', () => {
        const counts = { Slush: 2, Popcorn: 2, Ceramics: 2 };
        const first = JSON.stringify(Split.buildDemand(POOL, [], { counts, limit: 2 }));
        for (let i = 0; i < 20; i++) {
            assert.strictEqual(JSON.stringify(Split.buildDemand(POOL, [], { counts, limit: 2 })), first);
        }
        // Alphabetical tiebreak: Ceramics then Popcorn.
        assert.deepEqual(JSON.parse(first), { 40: 1, 20: 1 });
    });

    it('falls back to counting everything when no history is supplied', () => {
        assert.deepEqual(Split.buildDemand(POOL, []), { 20: 2, 40: 1 });
    });

    it('a bunk with no history at all still gets a sensible shape', () => {
        assert.deepEqual(durs(carve({})), [40], 'all tied → alphabetical → Ceramics leads');
    });
});

describe('ManualBlockSplit.collectDurations', () => {
    it('returns every distinct length, ascending', () => {
        assert.deepEqual(Split.collectDurations([
            { activity: 'A', durations: [40, 20] },
            { activity: 'B', durations: [20, 30] },
        ]), [20, 30, 40]);
    });

    it('is empty for empty input', () => {
        assert.deepEqual(Split.collectDurations([]), []);
        assert.deepEqual(Split.collectDurations(null), []);
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
