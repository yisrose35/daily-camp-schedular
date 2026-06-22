/**
 * Tests for period_orchestrator.js — the per-period exact-tiling orchestrator.
 *
 * Run with: node --test tests/period_orchestrator.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const PeriodPacker = require('../period_packer.js');
const Orch = require('../period_orchestrator.js');

// 2:15pm..2:55pm = 855..895 (40-min period), like the human reference.
const P = (startMin, endMin, name, isBreak) => ({ startMin, endMin, name, isBreak: !!isBreak });

function sumDur(segs) { return segs.reduce((a, s) => a + s.durationMin, 0); }
function allSegs(res) {
    const out = [];
    res.periodPlans.forEach(pp => pp.windows.forEach(w => w.segments.forEach(s => out.push(s))));
    return out;
}
// gates that accept everything; sport gets its first field.
const openGates = {
    validateSport: (name, fields) => (fields && fields[0]) || (name + ' Field'),
    validateSpecial: () => true
};

describe('PeriodOrchestrator.freeSubWindows', () => {
    it('returns the whole period when nothing is pinned', () => {
        assert.deepStrictEqual(Orch.freeSubWindows(855, 895, []), [{ start: 855, end: 895 }]);
    });
    it('splits around a pinned wall into two sub-windows', () => {
        const w = Orch.freeSubWindows(600, 700, [{ startMin: 630, endMin: 650 }]);
        assert.deepStrictEqual(w, [{ start: 600, end: 630 }, { start: 650, end: 700 }]);
    });
    it('drops zero/negative windows and clamps to the period', () => {
        const w = Orch.freeSubWindows(600, 700, [{ startMin: 590, endMin: 700 }]);
        assert.deepStrictEqual(w, []);
    });
});

describe('PeriodOrchestrator.buildPeriodCandidates', () => {
    it('emits one candidate per (activity,duration), drops over-length, carries fields', () => {
        const cands = Orch.buildPeriodCandidates({
            len: 40, minSegmentMin: 10, granularityMin: 5,
            sports: [{ name: 'Soccer', durations: [10, 20, 60], fields: ['Yard', 'Field2'] }],
            specials: [{ name: 'Pizza', durations: [10, 20], subcategoryKey: 'food', location: 'Kitchen' }]
        });
        const soccer = cands.filter(c => c.name === 'Soccer');
        assert.deepStrictEqual(soccer.map(c => c.durationMin).sort((a, b) => a - b), [10, 20]); // 60 dropped (> len)
        assert.deepStrictEqual(soccer[0].fields, ['Yard', 'Field2']);
        const pizza = cands.filter(c => c.name === 'Pizza');
        assert.strictEqual(pizza.length, 2);
        assert.strictEqual(pizza[0].subcategoryKey, 'food');
        assert.strictEqual(pizza[0].location, 'Kitchen');
    });
    it('excludes activities already used today (no same-day repeat)', () => {
        const cands = Orch.buildPeriodCandidates({
            len: 40, sports: [{ name: 'Soccer', durations: [20] }], specials: [],
            usedToday: { soccer: 1 }
        });
        assert.strictEqual(cands.length, 0);
    });
    it('expands dMin/dMax into granular durations when no durations[] given', () => {
        const cands = Orch.buildPeriodCandidates({
            len: 40, granularityMin: 5, minSegmentMin: 10,
            sports: [{ name: 'Tag', dMin: 10, dMax: 20 }], specials: []
        });
        assert.deepStrictEqual(cands.map(c => c.durationMin).sort((a, b) => a - b), [10, 15, 20]);
    });
});

describe('PeriodOrchestrator.planBunkPeriods — exact tiling', () => {
    it('tiles a 40-min period to exactly 40 with zero residual', () => {
        const res = Orch.planBunkPeriods({
            bunk: 'B1', grade: 'G', periods: [P(855, 895, 'A5')], occupied: [],
            sports: [{ name: 'Soccer', durations: [10, 20, 40], baseScore: 1 }],
            specials: [
                { name: 'Pizza', durations: [10, 20], subcategoryKey: 'food', location: 'K1', baseScore: 1 },
                { name: 'Cookie', durations: [20], subcategoryKey: 'food', location: 'K2', baseScore: 1 }
            ],
            floors: { food: 2 }, gates: openGates, packer: PeriodPacker
        });
        const segs = allSegs(res);
        assert.strictEqual(res.stats.windowsTiled, 1);
        assert.strictEqual(res.stats.residualMin, 0, 'no within-period gap');
        assert.strictEqual(sumDur(segs), 40, 'segments tile the period exactly');
        const foods = segs.filter(s => s.subcategoryKey === 'food');
        assert.ok(foods.length >= 2, 'food floor (2) is met by the tiling');
        assert.strictEqual(res.unmetFloors.food, 0, 'no unmet food floor');
    });

    it('honors a mixed floor (=1 food + =1 regular)', () => {
        const res = Orch.planBunkPeriods({
            bunk: 'B1', grade: 'G', periods: [P(600, 640, 'A1')], occupied: [],
            sports: [], specials: [
                { name: 'Pizza', durations: [20], subcategoryKey: 'food', location: 'K1', baseScore: 1 },
                { name: 'Shiur', durations: [20], subcategoryKey: 'regular', location: 'R1', baseScore: 1 }
            ],
            floors: { food: 1, regular: 1 }, gates: openGates, packer: PeriodPacker
        });
        const segs = allSegs(res);
        assert.strictEqual(res.stats.residualMin, 0);
        assert.ok(segs.some(s => s.subcategoryKey === 'food'), 'food placed');
        assert.ok(segs.some(s => s.subcategoryKey === 'regular'), 'regular placed');
    });

    it('tiles AROUND a pinned wall, leaving the wall untouched (two sub-windows)', () => {
        const res = Orch.planBunkPeriods({
            bunk: 'B1', grade: 'G', periods: [P(600, 700, 'A1')],
            occupied: [{ startMin: 640, endMin: 660, name: 'Swim' }],   // a pinned wall mid-period
            sports: [{ name: 'Soccer', durations: [20, 40], baseScore: 1 }],
            specials: [{ name: 'Pizza', durations: [20, 40], subcategoryKey: 'food', location: 'K1', baseScore: 1 }],
            floors: {}, gates: openGates, packer: PeriodPacker
        });
        assert.strictEqual(res.stats.windowsConsidered, 2, 'two free sub-windows around the wall');
        const segs = allSegs(res);
        // no placed segment overlaps the [640,660] wall
        assert.ok(segs.every(s => s.endMin <= 640 || s.startMin >= 660), 'no segment overlaps the pinned wall');
    });

    it('falls through top-N when the best packing has no valid field', () => {
        const gates = {
            validateSport: (name, fields, s, e) => (name === 'Premier' ? null : ((fields && fields[0]) || 'Yard')),
            validateSpecial: () => true
        };
        const res = Orch.planBunkPeriods({
            bunk: 'B1', grade: 'G', periods: [P(855, 895, 'A5')], occupied: [],
            sports: [
                { name: 'Premier', durations: [40], baseScore: 100, fields: ['Court'] },  // best score, but field rejected
                { name: 'Backup', durations: [40], baseScore: 1, fields: ['Yard'] }
            ],
            specials: [], floors: {}, gates: gates, packer: PeriodPacker
        });
        const segs = allSegs(res);
        assert.strictEqual(res.stats.residualMin, 0);
        assert.strictEqual(segs.length, 1);
        assert.strictEqual(segs[0].name, 'Backup', 'fell through to the field-valid packing');
        assert.strictEqual(segs[0].field, 'Yard');
    });

    it('leaves a non-granular window untiled (never calls pack with a bad length)', () => {
        const res = Orch.planBunkPeriods({
            bunk: 'B1', grade: 'G', periods: [P(600, 638, 'odd')], occupied: [],  // 38-min window
            sports: [{ name: 'Soccer', durations: [20] }], specials: [], floors: {},
            gates: openGates, packer: PeriodPacker
        });
        assert.strictEqual(res.stats.windowsTiled, 0);
        assert.strictEqual(res.periodPlans[0].windows[0].reason, 'window-not-granular');
    });

    it('returns tiled:false (no throw) when there are no candidates', () => {
        const res = Orch.planBunkPeriods({
            bunk: 'B1', grade: 'G', periods: [P(855, 895, 'A5')], occupied: [],
            sports: [], specials: [], floors: {}, gates: openGates, packer: PeriodPacker
        });
        assert.strictEqual(res.stats.windowsTiled, 0);
        assert.strictEqual(res.periodPlans[0].windows[0].reason, 'no-candidates');
        assert.strictEqual(res.periodPlans[0].windows[0].tiled, false);
    });

    it('never repeats the same activity within a window', () => {
        const res = Orch.planBunkPeriods({
            bunk: 'B1', grade: 'G', periods: [P(855, 895, 'A5')], occupied: [],
            sports: [], specials: [{ name: 'Pizza', durations: [20], subcategoryKey: 'food', location: 'K1', baseScore: 1 }],
            floors: { food: 2 }, gates: openGates, packer: PeriodPacker
        });
        const segs = allSegs(res);
        const names = segs.map(s => s.name);
        assert.strictEqual(new Set(names).size, names.length, 'no activity appears twice');
        // only one Pizza exists, so the 40-min window cannot be fully tiled
        assert.notStrictEqual(res.stats.residualMin, 0);
    });

    it('is deterministic — same input yields the same plan', () => {
        const input = () => ({
            bunk: 'B1', grade: 'G', periods: [P(855, 895, 'A5')], occupied: [],
            sports: [{ name: 'Soccer', durations: [10, 20, 40], baseScore: 1 }],
            specials: [{ name: 'Pizza', durations: [10, 20], subcategoryKey: 'food', location: 'K1', baseScore: 1 }],
            floors: { food: 1 }, gates: openGates, packer: PeriodPacker
        });
        const a = JSON.stringify(allSegs(Orch.planBunkPeriods(input())).map(s => [s.name, s.startMin, s.durationMin]));
        const b = JSON.stringify(allSegs(Orch.planBunkPeriods(input())).map(s => [s.name, s.startMin, s.durationMin]));
        assert.strictEqual(a, b);
    });
});

describe('PeriodOrchestrator.planAllBunks — cross-bunk reservation', () => {
    it('a capacity-1 special goes to the first bunk; the second cannot double-book it', () => {
        const reservations = []; // {name,start,end}
        const makeGates = (bunk, grade) => ({
            validateSport: (name, fields) => (fields && fields[0]) || 'Yard',
            validateSpecial: (name, location, s, e) => {
                // Pool is capacity-1: reject if another bunk already reserved it overlapping
                const clash = reservations.some(r => r.name === name && s < r.end && e > r.start);
                return !clash;
            },
            onReserve: (seg) => { if (seg.kind === 'special') reservations.push({ name: seg.name, start: seg.startMin, end: seg.endMin }); }
        });
        const perBunk = {
            B1: { grade: 'G', periods: [P(600, 640, 'A1')], occupied: [], sports: [], floors: { swimcat: 1 },
                  specials: [{ name: 'Pool', durations: [40], subcategoryKey: 'swimcat', location: 'Pool', baseScore: 1 }] },
            B2: { grade: 'G', periods: [P(600, 640, 'A1')], occupied: [], sports: [{ name: 'Soccer', durations: [40], baseScore: 1 }], floors: { swimcat: 1 },
                  specials: [{ name: 'Pool', durations: [40], subcategoryKey: 'swimcat', location: 'Pool', baseScore: 1 }] }
        };
        const out = Orch.planAllBunks({ order: ['B1', 'B2'], perBunk, makeGates, packer: PeriodPacker, opts: {} });
        const b1 = allSegs(out.planByBunk.B1).map(s => s.name);
        const b2 = allSegs(out.planByBunk.B2).map(s => s.name);
        assert.ok(b1.includes('Pool'), 'B1 (first) got the cap-1 Pool');
        assert.ok(!b2.includes('Pool'), 'B2 could not double-book the cap-1 Pool');
        assert.ok(b2.includes('Soccer'), 'B2 fell back to its sport');
    });
});
