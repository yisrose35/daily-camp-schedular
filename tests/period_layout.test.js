/**
 * Tests for period_layout.js — the generic-tile LAYOUT engine.
 *
 * Run with: node --test tests/period_layout.test.js
 *
 * LAYOUT lays generic kind-labeled tiles (Sport / Special:Food / ...) wall-to-
 * wall across each bell period, durations summing exactly, with NO content gates
 * and NO concrete activity. It is the manual-skeleton half of "manual-model-in-
 * auto": fill (picking a real activity per tile) is a separate, later step.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const PeriodPacker = require('../period_packer.js');
const Layout = require('../period_layout.js');

const P = (startMin, endMin, name, isBreak) => ({ startMin, endMin, name, isBreak: !!isBreak });
function tilesOf(res) { return res.tiles.filter(t => t.generic); }
function sumGenericInWindow(res, s, e) {
    return res.tiles.filter(t => t.generic && t.startMin >= s && t.endMin <= e).reduce((a, t) => a + t.durationMin, 0);
}

describe('PeriodLayout.freeSubWindows', () => {
    it('returns the whole period when nothing is pinned', () => {
        assert.deepStrictEqual(Layout.freeSubWindows(650, 690, []), [{ start: 650, end: 690 }]);
    });
    it('splits around a pinned wall', () => {
        assert.deepStrictEqual(
            Layout.freeSubWindows(650, 730, [{ startMin: 690, endMin: 710 }]),
            [{ start: 650, end: 690 }, { start: 710, end: 730 }]);
    });
});

describe('PeriodLayout.planBunkLayout — wall-to-wall generic tiling', () => {
    it('tiles a 40-min period to exactly 40 with generic tiles, no gates', () => {
        const res = Layout.planBunkLayout({
            bunk: 'B1', grade: 'G', periods: [P(855, 895, 'Period 6')], pinned: [],
            floating: [
                { kind: 'special', subcat: 'food', durations: [10, 20], window: [650, 945], qty: 1 },
                { kind: 'special', subcat: 'shiur', durations: [20], window: [650, 945], qty: 1 },
                { kind: 'sport', durations: [30, 40], window: [650, 945] } // qty omitted => unlimited filler
            ],
            packer: PeriodPacker
        });
        assert.strictEqual(res.stats.windowsTiled, 1);
        assert.strictEqual(res.stats.residualMin, 0, 'no within-period gap');
        assert.strictEqual(sumGenericInWindow(res, 855, 895), 40, 'tiles fill the period exactly');
        // floor-bonus makes two unmet specials (food20 + shiur20) beat sport40
        const kinds = tilesOf(res).map(t => t.subcat || t.kind).sort();
        assert.deepStrictEqual(kinds, ['food', 'shiur']);
    });

    it('NO content gates: two cap-1-in-reality specials coexist in one window (the orchestrator would have vetoed)', () => {
        const res = Layout.planBunkLayout({
            bunk: 'B1', grade: 'G', periods: [P(600, 640, 'P')], pinned: [],
            floating: [
                { kind: 'special', subcat: 'food', durations: [20], window: [600, 640], qty: 1 },
                { kind: 'special', subcat: 'theme', durations: [20], window: [600, 640], qty: 1 }
            ],
            packer: PeriodPacker
        });
        assert.strictEqual(res.stats.residualMin, 0);
        const subs = tilesOf(res).map(t => t.subcat).sort();
        assert.deepStrictEqual(subs, ['food', 'theme'], 'both specials placed — layout never gates on capacity');
    });

    it('meets a special floor exactly ONCE, then fills later periods with sport filler', () => {
        const res = Layout.planBunkLayout({
            bunk: 'B1', grade: 'G',
            periods: [P(855, 895, 'P6'), P(905, 945, 'P7')], pinned: [],
            floating: [
                { kind: 'special', subcat: 'food', durations: [10, 20], window: [650, 945], qty: 1 },
                { kind: 'sport', durations: [30, 40], window: [650, 945] }
            ],
            packer: PeriodPacker
        });
        assert.strictEqual(res.stats.residualMin, 0, 'both periods wall-to-wall');
        const foods = tilesOf(res).filter(t => t.subcat === 'food');
        assert.strictEqual(foods.length, 1, 'food floor met exactly once, not twice');
        assert.strictEqual(res.remaining['special:food'], 0, 'food quota consumed');
        // the period without food is all sport
        const p7sports = res.tiles.filter(t => t.generic && t.startMin >= 905 && t.kind === 'sport');
        assert.ok(p7sports.length >= 1, 'second period filled by sport filler');
    });

    it('tiles AROUND a pinned wall and never overlaps it', () => {
        const res = Layout.planBunkLayout({
            bunk: 'B1', grade: 'G', periods: [P(650, 730, 'P')],
            pinned: [{ kind: 'change', name: 'Change', startMin: 690, endMin: 710 }],
            floating: [
                { kind: 'sport', durations: [30, 40], window: [650, 945] },
                { kind: 'special', subcat: 'food', durations: [10, 20], window: [650, 945], qty: 2 }
            ],
            packer: PeriodPacker
        });
        const gen = tilesOf(res);
        assert.ok(gen.every(t => t.endMin <= 690 || t.startMin >= 710), 'no generic tile overlaps the pinned wall');
        assert.ok(res.tiles.some(t => t.pinned && t.name === 'Change'), 'pinned wall preserved');
    });

    it('leaves bell breaks empty (isBreak periods are never tiled)', () => {
        const res = Layout.planBunkLayout({
            bunk: 'B1', grade: 'G',
            periods: [P(650, 690, 'P1'), P(690, 695, 'break', true), P(695, 735, 'P2')], pinned: [],
            floating: [{ kind: 'sport', durations: [40], window: [650, 945] }],
            packer: PeriodPacker
        });
        assert.strictEqual(res.stats.periodsConsidered, 2, 'break period skipped');
        assert.ok(res.tiles.every(t => t.endMin <= 690 || t.startMin >= 695), 'no tile lands in the 5-min break');
    });

    it('respects a demand window — a narrow-window special only lands where its window covers', () => {
        const res = Layout.planBunkLayout({
            bunk: 'B1', grade: 'G',
            periods: [P(650, 690, 'P1'), P(905, 945, 'P7')], pinned: [],
            floating: [
                { kind: 'special', subcat: 'shiur', durations: [40], window: [650, 690], qty: 1 }, // only P1
                { kind: 'sport', durations: [40], window: [650, 945] }
            ],
            packer: PeriodPacker
        });
        const shiur = tilesOf(res).filter(t => t.subcat === 'shiur');
        assert.strictEqual(shiur.length, 1);
        assert.ok(shiur[0].startMin >= 650 && shiur[0].endMin <= 690, 'shiur stayed in its window (P1)');
    });

    it('GATE: a sport-spacing rule replaces a 2nd adjacent sport with a special (still wall-to-wall)', () => {
        // sport-vs-sport <40min gap = blocked (mirrors rules.js isCandidateAllowed)
        const sportGate = (block, template) => {
            if (block.type !== 'sport') return true;
            for (const w of template) {
                if (w.type !== 'sport') continue;
                const gapBefore = (w.startMin || 0) - (block.endMin || 0);
                const gapAfter = (block.startMin || 0) - (w.endMin || 0);
                if (gapBefore >= 0 && gapBefore < 40) return false;
                if (gapAfter >= 0 && gapAfter < 40) return false;
            }
            return true;
        };
        const base = {
            bunk: 'B1', grade: 'G',
            periods: [P(650, 690, 'P1'), P(690, 730, 'P2')], pinned: [],
            floating: [
                { kind: 'sport', dMin: 10, dMax: 40, window: [650, 945] },
                { kind: 'special', subcat: 'food', durations: [40], window: [650, 945], qty: 0, cap: Infinity }
            ],
            packer: PeriodPacker
        };
        // baseline (no gate): both adjacent periods tile with sport
        const noGate = Layout.planBunkLayout(base);
        assert.strictEqual(tilesOf(noGate).filter(t => t.kind === 'sport').length, 2, 'baseline: two back-to-back sports');
        // gated: the 2nd sport is spacing-blocked → window fills with a special instead
        const gated = Layout.planBunkLayout(Object.assign({}, base, { gate: sportGate }));
        assert.strictEqual(gated.stats.residualMin, 0, 'still wall-to-wall');
        assert.strictEqual(tilesOf(gated).filter(t => t.kind === 'sport').length, 1, 'only one sport survives the gate');
        assert.strictEqual(tilesOf(gated).filter(t => t.subcat === 'food').length, 1, 'spacing-blocked window filled by a special');
    });

    it('GATE + SWAP: a window the gate emptied is repaired by moving a placed special in and relocating the sport to a legal slot', () => {
        const sportGate = (block, template) => {
            if (block.type !== 'sport') return true;
            for (const w of template) {
                if (w.type !== 'sport') continue;
                const gapBefore = (w.startMin || 0) - (block.endMin || 0);
                const gapAfter = (block.startMin || 0) - (w.endMin || 0);
                if (gapBefore >= 0 && gapBefore < 40) return false;
                if (gapAfter >= 0 && gapAfter < 40) return false;
            }
            return true;
        };
        // 4 adjacent 40-min periods, 2 cap-1 specials + sport filler. Greedy front-loads
        // the 2 specials into P1/P2, leaving sports in P3/P4 — and P4's sport is gated
        // (10/0-min gap to P3). Without repair P4 is empty; the swap moves a special into
        // P4 and relocates a sport to P1, spacing the two sports 40min apart.
        const res = Layout.planBunkLayout({
            bunk: 'B1', grade: 'G',
            periods: [P(650, 690, 'P1'), P(690, 730, 'P2'), P(730, 770, 'P3'), P(770, 810, 'P4')], pinned: [],
            floating: [
                { kind: 'sport', dMin: 10, dMax: 40, window: [650, 945] },
                { kind: 'special', subcat: 'food', durations: [40], window: [650, 945], qty: 1, cap: 1 },
                { kind: 'special', subcat: 'theme', durations: [40], window: [650, 945], qty: 1, cap: 1 }
            ],
            gate: sportGate, packer: PeriodPacker
        });
        assert.strictEqual(res.stats.residualMin, 0, 'swap repair filled the gated window — fully wall-to-wall');
        const sports = tilesOf(res).filter(t => t.kind === 'sport');
        assert.strictEqual(sports.length, 2, 'two sports placed (none dropped)');
        const ss = sports.map(s => [s.startMin, s.endMin]).sort((a, b) => a[0] - b[0]);
        assert.ok(ss[1][0] - ss[0][1] >= 40, 'the two sports end up >=40min apart after the swap');
    });

    it('GATE + cap: a special used as filler never exceeds its subcategory cap', () => {
        const blockAllSport = (block) => block.type !== 'sport'; // sport always blocked
        const res = Layout.planBunkLayout({
            bunk: 'B1', grade: 'G',
            periods: [P(650, 690, 'P1'), P(690, 730, 'P2')], pinned: [],
            floating: [
                { kind: 'sport', dMin: 10, dMax: 40, window: [650, 945] },
                { kind: 'special', subcat: 'food', durations: [40], window: [650, 945], qty: 1, cap: 1 }
            ],
            gate: blockAllSport, packer: PeriodPacker
        });
        assert.strictEqual(tilesOf(res).filter(t => t.subcat === 'food').length, 1, 'food placed exactly its cap (1)');
        assert.ok(res.stats.residualMin >= 40, 'capped special cannot over-fill the 2nd window — left for legacy fill');
    });

    it('no-candidates window is reported, not crashed', () => {
        const res = Layout.planBunkLayout({
            bunk: 'B1', grade: 'G', periods: [P(855, 895, 'P6')], pinned: [],
            floating: [], packer: PeriodPacker
        });
        assert.strictEqual(res.stats.windowsTiled, 0);
        assert.strictEqual(res.periodPlans[0].windows[0].reason, 'no-candidates');
    });

    it('is deterministic', () => {
        const mk = () => Layout.planBunkLayout({
            bunk: 'B1', grade: 'G', periods: [P(855, 895, 'P6')], pinned: [],
            floating: [
                { kind: 'special', subcat: 'food', durations: [10, 20], window: [650, 945], qty: 1 },
                { kind: 'sport', durations: [30, 40], window: [650, 945] }
            ], packer: PeriodPacker
        });
        const a = JSON.stringify(tilesOf(mk()).map(t => [t.name, t.startMin, t.durationMin]));
        const b = JSON.stringify(tilesOf(mk()).map(t => [t.name, t.startMin, t.durationMin]));
        assert.strictEqual(a, b);
    });
});

describe('PeriodLayout.planAllBunksLayout', () => {
    it('lays out every bunk independently and aggregates stats', () => {
        const perBunk = {
            B1: { grade: 'G', periods: [P(855, 895, 'P6')], pinned: [],
                  floating: [{ kind: 'sport', durations: [40], window: [650, 945] }] },
            B2: { grade: 'G', periods: [P(855, 895, 'P6')], pinned: [],
                  floating: [{ kind: 'special', subcat: 'food', durations: [40], window: [650, 945], qty: 1 }] }
        };
        const out = Layout.planAllBunksLayout({ order: ['B1', 'B2'], perBunk, packer: PeriodPacker });
        assert.strictEqual(out.stats.bunks, 2);
        assert.strictEqual(out.stats.windowsTiled, 2, 'both bunks fully tiled');
        assert.strictEqual(out.stats.bunksFullyTiled, 2);
        assert.strictEqual(out.stats.unmetSpecialFloors, 0);
    });

    it('counts an unmet special floor when the window cannot fit it', () => {
        const out = Layout.planAllBunksLayout({
            order: ['B1'],
            perBunk: {
                B1: { grade: 'G', periods: [P(855, 875, 'tiny')], pinned: [],
                      floating: [{ kind: 'special', subcat: 'food', durations: [40], window: [650, 945], qty: 1 }] }
            },
            packer: PeriodPacker
        });
        assert.strictEqual(out.stats.unmetSpecialFloors, 1, '40-min food cannot fit a 20-min window → unmet');
    });
});
