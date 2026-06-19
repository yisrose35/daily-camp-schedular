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

    it('GATE + multi-tile SWAP: relocates a 20+20 run (not just a single 40) to open a legal sport slot', () => {
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
        // P1 fills with food20+theme20; P2 takes the only sport; P3 is sport-blocked
        // (10min from P2) with no special left → empty. The repair must relocate the
        // 20+20 RUN from P1 into P3 and drop a sport into P1 (far from P2's sport).
        const res = Layout.planBunkLayout({
            bunk: 'B1', grade: 'G',
            periods: [P(650, 690, 'P1'), P(850, 890, 'P2'), P(900, 940, 'P3')], pinned: [],
            floating: [
                { kind: 'sport', dMin: 10, dMax: 40, window: [650, 945] },
                { kind: 'special', subcat: 'food', durations: [20], window: [650, 945], qty: 1, cap: 1 },
                { kind: 'special', subcat: 'theme', durations: [20], window: [650, 945], qty: 1, cap: 1 }
            ],
            gate: sportGate, packer: PeriodPacker
        });
        assert.strictEqual(res.stats.residualMin, 0, 'multi-tile relocation filled the gated window');
        const sports = tilesOf(res).filter(t => t.kind === 'sport');
        assert.strictEqual(sports.length, 2, 'two sports, none dropped');
        const ss = sports.map(s => [s.startMin, s.endMin]).sort((a, b) => a[0] - b[0]);
        assert.ok(ss[1][0] - ss[0][1] >= 40, 'sports spaced >=40min apart');
        const food = tilesOf(res).find(t => t.subcat === 'food');
        const theme = tilesOf(res).find(t => t.subcat === 'theme');
        assert.ok(food && theme && food.durationMin === 20 && theme.durationMin === 20, 'both 20-min specials kept');
        assert.ok(food.endMin === theme.startMin || theme.endMin === food.startMin, 'the 20+20 were relocated as a contiguous run');
    });

    it('GATE generality: a non-sport rule (two specials too close) is honored when relocating', () => {
        // Rule: no two "special" tiles within 30min of each other (end->start gap).
        const specialGate = (block, template) => {
            if (block.type !== 'special') return true;
            for (const w of template) {
                if (w.type !== 'special') continue;
                const gapBefore = (w.startMin || 0) - (block.endMin || 0);
                const gapAfter = (block.startMin || 0) - (w.endMin || 0);
                if (gapBefore >= 0 && gapBefore < 30) return false;
                if (gapAfter >= 0 && gapAfter < 30) return false;
            }
            return true;
        };
        const res = Layout.planBunkLayout({
            bunk: 'B1', grade: 'G',
            periods: [P(650, 690, 'P1'), P(690, 730, 'P2')], pinned: [],
            floating: [
                { kind: 'sport', dMin: 10, dMax: 40, window: [650, 945] },
                { kind: 'special', subcat: 'food', durations: [40], window: [650, 945], qty: 1, cap: 1 }
            ],
            gate: specialGate, packer: PeriodPacker
        });
        // both periods tile; the two specials (food + the sport filler) never violate
        // the special-spacing rule — i.e. no two 'special' tiles within 30min.
        const specials = tilesOf(res).filter(t => t.kind === 'special').map(s => [s.startMin, s.endMin]).sort((a, b) => a[0] - b[0]);
        for (let i = 1; i < specials.length; i++) {
            assert.ok(specials[i][0] - specials[i - 1][1] >= 30, 'specials are >=30min apart (rule honored across the board)');
        }
    });

    it('ELASTIC: relocates a sport into a gated empty window and back-fills its slot with a stretched special', () => {
        // Duration-aware repair (the user's move): a layer slot can be any duration in
        // its range. P1 = food20 + sport20 (sport at the END, 670-690). P2 is sport-
        // blocked everywhere (≤30min from P1's sport) and a lone 20-min food can't tile
        // the 40-min window → P2 empty. Elastic-fill slides the Sport into P2 (stretched
        // to the full 40) and re-packs the 20-min slot it vacated with a 2nd food —
        // staying within food's cap of 2. No sport is dropped; nothing exceeds its cap.
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
        const res = Layout.planBunkLayout({
            bunk: 'B1', grade: 'G',
            periods: [P(650, 690, 'P1'), P(700, 740, 'P2')], pinned: [],
            floating: [
                { kind: 'special', subcat: 'food', durations: [20], window: [650, 945], qty: 1, cap: 2 },
                { kind: 'sport', dMin: 10, dMax: 40, window: [650, 945] }
            ],
            gate: sportGate, packer: PeriodPacker
        });
        assert.strictEqual(res.stats.residualMin, 0, 'elastic-fill made it fully wall-to-wall');
        const sports = tilesOf(res).filter(t => t.kind === 'sport');
        assert.strictEqual(sports.length, 1, 'the one sport is relocated, not dropped');
        assert.strictEqual(sports[0].durationMin, 40, 'the sport stretched to fill the whole window');
        assert.deepStrictEqual([sports[0].startMin, sports[0].endMin], [700, 740], 'sport slid into the (formerly empty) P2');
        const foods = tilesOf(res).filter(t => t.subcat === 'food');
        assert.strictEqual(foods.length, 2, 'back-filled with a 2nd food — exactly its cap, never exceeded');
        assert.ok(foods.every(f => f.durationMin === 20), 'each food respects its 20-min duration');
        const p2 = res.periodPlans.find(pp => pp.period.startMin === 700).windows[0];
        assert.strictEqual(p2.reason, 'elastic-fill', 'P2 was repaired by the elastic pass');
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

    it('SWIM (set duration, moveable window): a deferred required layer is placed and outranks optional specials', () => {
        // Swim is a fixed-40 demand that may sit anywhere in its window (the manual
        // "set duration, moveable window" case). Even though P1 could fit two special
        // floors (2000 pts), the structural Swim floor must win a slot — and it must
        // stay inside its window.
        const res = Layout.planBunkLayout({
            bunk: 'B1', grade: 'G',
            periods: [P(650, 690, 'P1'), P(700, 740, 'P2')], pinned: [],
            floating: [
                { kind: 'swim', name: 'Swim', durations: [40], window: [650, 740], qty: 1, cap: 1 },
                { kind: 'special', subcat: 'food', durations: [20], window: [650, 945], qty: 1, cap: Infinity },
                { kind: 'special', subcat: 'theme', durations: [20], window: [650, 945], qty: 1, cap: Infinity },
                { kind: 'sport', dMin: 10, dMax: 40, window: [650, 945] }
            ],
            packer: PeriodPacker
        });
        assert.strictEqual(res.stats.residualMin, 0, 'both periods wall-to-wall');
        const swim = tilesOf(res).filter(t => t.kind === 'swim');
        assert.strictEqual(swim.length, 1, 'swim placed exactly once (the required layer is not dropped)');
        assert.strictEqual(swim[0].durationMin, 40, 'swim kept its set duration');
        assert.ok(swim[0].startMin >= 650 && swim[0].endMin <= 740, 'swim stayed inside its moveable window');
        assert.strictEqual(res.remaining['swim'], 0, 'swim floor consumed');
        const foods = tilesOf(res).filter(t => t.subcat === 'food');
        const themes = tilesOf(res).filter(t => t.subcat === 'theme');
        assert.ok(foods.length === 1 && themes.length === 1, 'the special floors still fill the other window');
    });

    it('SWIM only lands where its (narrow) window covers — never outside it', () => {
        const res = Layout.planBunkLayout({
            bunk: 'B1', grade: 'G',
            periods: [P(650, 690, 'P1'), P(900, 940, 'P7')], pinned: [],
            floating: [
                { kind: 'swim', name: 'Swim', durations: [40], window: [650, 690], qty: 1, cap: 1 }, // only P1
                { kind: 'sport', dMin: 10, dMax: 40, window: [650, 945] }
            ],
            packer: PeriodPacker
        });
        const swim = tilesOf(res).filter(t => t.kind === 'swim');
        assert.strictEqual(swim.length, 1);
        assert.ok(swim[0].startMin >= 650 && swim[0].endMin <= 690, 'swim stayed in P1 (its only window)');
        const p7 = res.periodPlans.find(pp => pp.period.startMin === 900).windows[0];
        assert.ok(p7.tiled, 'the far period still filled (by sport)');
    });

    it('STRUCTURAL FLOOR is kind-agnostic: any required fixed-duration layer (e.g. elective) places once, like swim', () => {
        // The engine re-floats ANY deferred fixed-duration/moveable-window layer
        // (swim, elective, a windowed custom/main, …) — not just swim. PeriodLayout
        // treats every non-special, non-filler finite-quota demand as a must-place
        // structural floor, so the behavior must not be swim-name-specific.
        const res = Layout.planBunkLayout({
            bunk: 'B1', grade: 'G',
            periods: [P(650, 690, 'P1'), P(700, 740, 'P2')], pinned: [],
            floating: [
                { kind: 'elective', name: 'Elective', durations: [40], window: [650, 740], qty: 1, cap: 1 },
                { kind: 'special', subcat: 'food', durations: [20], window: [650, 945], qty: 1, cap: Infinity },
                { kind: 'special', subcat: 'theme', durations: [20], window: [650, 945], qty: 1, cap: Infinity },
                { kind: 'sport', dMin: 10, dMax: 40, window: [650, 945] }
            ],
            packer: PeriodPacker
        });
        assert.strictEqual(res.stats.residualMin, 0, 'wall-to-wall');
        const elec = tilesOf(res).filter(t => t.kind === 'elective');
        assert.strictEqual(elec.length, 1, 'the elective floor placed exactly once');
        assert.strictEqual(elec[0].durationMin, 40);
        assert.ok(elec[0].startMin >= 650 && elec[0].endMin <= 740, 'stayed in its window');
        assert.strictEqual(res.remaining['elective'], 0, 'elective floor consumed');
    });

    it('RESOURCE GATE: a cross-bunk shared-resource limit blocks a shared kind (swim) from placing', () => {
        // The resourceGate models pool capacity across grades: here it denies swim
        // (pool full). Swim must NOT place; the window still fills with sport, and the
        // swim floor is honestly left unmet rather than oversubscribing the pool.
        const denySwim = (kind) => kind !== 'swim';
        const res = Layout.planBunkLayout({
            bunk: 'B1', grade: 'G',
            periods: [P(650, 690, 'P1')], pinned: [],
            floating: [
                { kind: 'swim', name: 'Swim', durations: [40], window: [650, 690], qty: 1, cap: 1 },
                { kind: 'sport', dMin: 10, dMax: 40, window: [650, 945] }
            ],
            resourceGate: denySwim, packer: PeriodPacker
        });
        assert.strictEqual(tilesOf(res).filter(t => t.kind === 'swim').length, 0, 'swim blocked by the resource (pool) gate');
        assert.strictEqual(res.stats.residualMin, 0, 'window still filled (by sport) — no gap left');
        assert.strictEqual(res.remaining['swim'], 1, 'swim floor left unmet rather than oversubscribing the pool');
    });

    it('RESOURCE GATE: swim places when the cross-bunk resource gate allows it', () => {
        const res = Layout.planBunkLayout({
            bunk: 'B1', grade: 'G',
            periods: [P(650, 690, 'P1')], pinned: [],
            floating: [
                { kind: 'swim', name: 'Swim', durations: [40], window: [650, 690], qty: 1, cap: 1 },
                { kind: 'sport', dMin: 10, dMax: 40, window: [650, 945] }
            ],
            resourceGate: () => true, packer: PeriodPacker
        });
        assert.strictEqual(tilesOf(res).filter(t => t.kind === 'swim').length, 1, 'swim places when the pool has room');
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

// ── LAYER SHARING watched AT PLACEMENT (the engine's _glFacilityFreeAt mirror) ──
// A re-floated layer that lives at a concrete facility (a "Main Activity" in an
// Auditorium, an elective in a room, …) carries a `_ref.share` descriptor with the
// facility's cross-grade capacity + allowedPairs. The caller threads resourceGate +
// resourceCommit so the LAYOUT keeps that facility within its limits as each tile is
// laid — across bunks — even for a facility no grade has PINNED yet (so a live
// bunkTimelines scan alone would see nothing). This enforcer is a faithful copy of
// the engine's _glFacilityFreeAt / _glResourceCommit semantics.
function makeShareEnforcer() {
    const resv = {};                                       // facKey -> [{grade, bunk, s, e}]
    const key = f => String(f == null ? '' : f).toLowerCase().trim();
    const pairAllowed = (g, others, pairs) => {
        for (const eg of others) { if (String(eg) === String(g)) continue; if (pairs[[String(g), String(eg)].sort().join('|')] !== true) return false; }
        return true;
    };
    const gate = (kind, grade, bunk, s, e, ref) => {
        if (!ref || !ref.share || !ref.share.facility) return true;
        const sh = ref.share, k = key(sh.facility);
        const type = String(sh.shareType || 'not_sharable').toLowerCase();
        const cap = type === 'not_sharable' ? 1 : (parseInt(sh.capacity) > 0 ? parseInt(sh.capacity) : 2);
        const seen = {}; let cnt = 0; const og = {};
        (resv[k] || []).forEach(r => {
            if (String(r.bunk) === String(bunk) || seen[r.bunk]) return;
            if (r.s < e && r.e > s) { seen[r.bunk] = 1; cnt++; if (r.grade && r.grade !== grade) og[r.grade] = true; }
        });
        if (cnt + 1 > cap) return false;                   // capacity counts THIS bunk too
        const ogk = Object.keys(og);
        if (!ogk.length) return true;
        if (type === 'all') return true;
        if (type === 'not_sharable' || type === 'same_division') return false;
        if (type === 'custom') { const ad = sh.allowedDivisions || []; return ogk.concat([grade]).every(g => ad.indexOf(g) !== -1); }
        return pairAllowed(grade, ogk, sh.allowedPairs || {});   // cross_division
    };
    const commit = (kind, grade, bunk, s, e, ref) => {
        if (!ref || !ref.share || !ref.share.facility) return;
        const k = key(ref.share.facility);
        (resv[k] || (resv[k] = [])).push({ grade, bunk, s, e });
    };
    return { gate, commit, resv };
}
const mainCount = (out, bunk) => out.layoutByBunk[bunk].tiles.filter(t => t.kind === 'main' && t.generic).length;

describe('PeriodLayout — LAYER SHARING watched at placement', () => {
    const sharedBunk = (grade, share) => ({
        grade, periods: [P(650, 690, 'P1')], pinned: [],
        floating: [
            { kind: 'main', name: 'Main Activity', durations: [40], window: [650, 690], qty: 1, cap: 1, score: 0, share },
            { kind: 'sport', dMin: 10, dMax: 40, window: [650, 945] }
        ]
    });

    it('not_sharable (cap 1): only ONE bunk gets the shared facility at a time; the other fills with sport', () => {
        const { gate, commit, resv } = makeShareEnforcer();
        const share = { facility: 'Auditorium', shareType: 'not_sharable', capacity: 1, allowedPairs: {} };
        const out = Layout.planAllBunksLayout({
            order: ['B1', 'B2'],
            perBunk: { B1: sharedBunk('G1', share), B2: sharedBunk('G2', share) },
            resourceGate: gate, resourceCommit: commit, packer: PeriodPacker
        });
        assert.strictEqual(mainCount(out, 'B1'), 1, 'first bunk gets the exclusive layer');
        assert.strictEqual(mainCount(out, 'B2'), 0, 'second bunk is sharing-blocked at the SAME time, not double-booked');
        assert.strictEqual(out.layoutByBunk.B2.stats.residualMin, 0, 'second bunk window still tiled wall-to-wall (sport)');
        assert.strictEqual(out.stats.unmetFloors, 1, 'the blocked layer floor is honestly left unmet, not oversubscribed');
        assert.strictEqual((resv['auditorium'] || []).length, 1, 'exactly one placement reserved on the facility');
    });

    it('cross_division (cap 2): two bunks share, the THIRD is blocked over capacity', () => {
        const { gate, commit } = makeShareEnforcer();
        const share = { facility: 'Auditorium', shareType: 'cross_division', capacity: 2, allowedPairs: { 'G1|G2': true, 'G1|G3': true, 'G2|G3': true } };
        const out = Layout.planAllBunksLayout({
            order: ['B1', 'B2', 'B3'],
            perBunk: { B1: sharedBunk('G1', share), B2: sharedBunk('G2', share), B3: sharedBunk('G3', share) },
            resourceGate: gate, resourceCommit: commit, packer: PeriodPacker
        });
        const total = mainCount(out, 'B1') + mainCount(out, 'B2') + mainCount(out, 'B3');
        assert.strictEqual(total, 2, 'capacity 2 honored — exactly two bunks share the facility concurrently');
        assert.strictEqual(out.stats.unmetFloors, 1, 'the over-capacity third is deferred, not double-booked');
    });

    it('cross_division with allowedPairs: a disallowed grade pair is blocked even with capacity to spare', () => {
        const { gate, commit } = makeShareEnforcer();
        // capacity is generous (99) but NO grade pair is whitelisted → the second grade
        // cannot join the first at this facility, so the sharing gate must block it.
        const share = { facility: 'Auditorium', shareType: 'cross_division', capacity: 99, allowedPairs: {} };
        const out = Layout.planAllBunksLayout({
            order: ['B1', 'B2'],
            perBunk: { B1: sharedBunk('G1', share), B2: sharedBunk('G2', share) },
            resourceGate: gate, resourceCommit: commit, packer: PeriodPacker
        });
        assert.strictEqual(mainCount(out, 'B1'), 1, 'first grade takes the facility');
        assert.strictEqual(mainCount(out, 'B2'), 0, 'second grade blocked by allowedPairs, not capacity');
    });

    it('same grade may share the facility regardless of cap-1 type (not a cross-division share)', () => {
        const { gate, commit } = makeShareEnforcer();
        // Two bunks of the SAME grade, cap 2 same_division → both may use the room together.
        const share = { facility: 'Auditorium', shareType: 'same_division', capacity: 2, allowedPairs: {} };
        const out = Layout.planAllBunksLayout({
            order: ['B1', 'B2'],
            perBunk: { B1: sharedBunk('G1', share), B2: sharedBunk('G1', share) },
            resourceGate: gate, resourceCommit: commit, packer: PeriodPacker
        });
        assert.strictEqual(mainCount(out, 'B1') + mainCount(out, 'B2'), 2, 'same-grade bunks share within capacity');
    });
});

// ── GAP-CLOSE: scan the schedule for gaps, fill from the layers, fewest tiles ──
// The final reader fills any free time the exact packer left, GREEDILY with the
// largest layer item that fits (fewest tiles), then grows a neighbor for slivers.
describe('PeriodLayout — GAP-CLOSE (fill the day from the layers, fewest tiles)', () => {
    it('fills with MULTIPLE distinct specials where the exact tiler cannot (80-min window, one 40-min subcat)', () => {
        // The exact packer needs durations summing to 80 with NO repeat of a kind → a
        // single 40-min subcat can never tile an 80-min window. GAP-CLOSE places two
        // 40-min specials greedily (fill assigns a DISTINCT activity to each later).
        const res = Layout.planBunkLayout({
            bunk: 'B1', grade: 'G',
            periods: [P(0, 80, 'P')], pinned: [],
            floating: [{ kind: 'special', subcat: 'regular', durations: [40], window: [0, 945], qty: 1, cap: 3, score: 1 }],
            packer: PeriodPacker
        });
        const specials = res.tiles.filter(t => t.generic && t.kind === 'special');
        assert.strictEqual(specials.length, 2, 'two 40-min specials fill the 80-min window');
        assert.strictEqual(res.stats.residualMin, 0, 'no gap left');
        assert.ok(res.stats.gapCloseTilesPlaced >= 1, 'GAP-CLOSE placed the tiles the exact packer could not');
    });

    it('closes an OFF-GRID window by greedy fill + growing a filler over the sliver', () => {
        // 23-min window (not a multiple of 5) → the exact packer rejects it outright.
        // GAP-CLOSE lays a 20-min filler then grows it to 23 to close the gap fully.
        const res = Layout.planBunkLayout({
            bunk: 'B1', grade: 'G',
            periods: [P(0, 23, 'P')], pinned: [],
            floating: [{ kind: 'sport', dMin: 10, dMax: 40, window: [0, 945] }],
            packer: PeriodPacker
        });
        const gen = res.tiles.filter(t => t.generic);
        assert.strictEqual(res.stats.residualMin, 0, 'off-grid window fully closed');
        assert.strictEqual(gen.length, 1, 'closed with a single grown tile (fewest tiles)');
        assert.strictEqual(gen[0].endMin - gen[0].startMin, 23, 'the filler was grown to span the whole 23-min window');
        assert.ok(res.stats.gapCloseGrew >= 1, 'a neighbor was grown to swallow the sliver');
    });

    it('prefers a REAL special over the generic "activity" placeholder', () => {
        // 40-min window; a 40-min special (score 1) and the activity placeholder (score 0)
        // both fit — the special must win so the day fills with real layer content.
        const res = Layout.planBunkLayout({
            bunk: 'B1', grade: 'G',
            periods: [P(0, 40, 'P')], pinned: [],
            floating: [
                { kind: 'special', subcat: 'regular', durations: [40], window: [0, 945], qty: 1, cap: 2, score: 1 },
                { kind: 'activity', dMin: 10, dMax: 40, window: [0, 945], score: 0 }
            ],
            packer: PeriodPacker
        });
        const gen = res.tiles.filter(t => t.generic);
        assert.strictEqual(gen.length, 1, 'one tile fills the window');
        assert.strictEqual(gen[0].kind, 'special', 'the real special wins over the activity placeholder');
    });

    it('never exceeds a subcat cap (distinct availability) — honest gap rather than a phantom repeat', () => {
        // 160-min window, a single 40-min subcat capped at 2 (only 2 distinct activities).
        // GAP-CLOSE places exactly 2, then leaves the rest an honest gap (no over-placement).
        const res = Layout.planBunkLayout({
            bunk: 'B1', grade: 'G',
            periods: [P(0, 160, 'P')], pinned: [],
            floating: [{ kind: 'special', subcat: 'regular', durations: [40], window: [0, 945], qty: 1, cap: 2, score: 1 }],
            packer: PeriodPacker
        });
        const specials = res.tiles.filter(t => t.generic && t.kind === 'special');
        assert.strictEqual(specials.length, 2, 'capped at the 2 distinct available activities');
        assert.strictEqual(res.stats.residualMin, 80, 'the remaining 80 min is an honest gap, not an over-cap repeat');
        assert.ok(res.gaps.some(g => g.len === 80), 'the open gap is reported for the diagnostic');
    });

    it('FLOOR-FIRST: a still-owed narrow-window floor is placed, never starved by the greedy filler', () => {
        // [0,200] is not exact-tileable (a 40-only kind cannot sum to 200 without repeat),
        // so the main pass leaves it free and GAP-CLOSE owns it. A narrow-window floor
        // (Shiur, window [125,165] = its 40-min duration) must be placed BEFORE the wide
        // sport filler greedily consumes [120,160] across it. Without floor-first the floor
        // is silently dropped while the window still reports wall-to-wall.
        const res = Layout.planBunkLayout({
            bunk: 'B1', grade: 'G',
            periods: [P(0, 200, 'P')], pinned: [],
            floating: [
                { kind: 'sport', dMin: 10, dMax: 40, window: [0, 200], score: 1 },
                { kind: 'special', subcat: 'shiur', durations: [40], window: [125, 165], qty: 1, cap: 1, score: 1 }
            ],
            packer: PeriodPacker
        });
        assert.strictEqual(res.remaining['special:shiur'], 0, 'the narrow-window Shiur floor was placed, not dropped');
        const shiur = res.tiles.find(t => t.kind === 'special' && t.subcat === 'shiur');
        assert.ok(shiur && shiur.startMin === 125 && shiur.endMin === 165, 'Shiur sits exactly in its window [125,165]');
        assert.strictEqual(res.stats.residualMin, 0, 'the rest of the period still fills wall-to-wall around it');
    });
});

// ── INTEGRATION: the live "Soloists / Duetos cannot close the day" case ──────────
// Reproduces the reported failure: the last 40-min window (3:05-3:45) was left empty
// ("all-packings-gated") because a sport could not go there (the camp's "no two sports
// within 40 min" rule) and every special subcat had been capped out. With the caps
// raised to distinct-availability + the gap reader, the day must now CLOSE.
describe('PeriodLayout — Soloists day closes under the real sport-spacing rule', () => {
    // gate: two SPORT tiles need >=40 min between them (end-to-start, either order).
    const sportSpacing = (block, template) => {
        if (block.type !== 'sport') return true;
        for (const t of template) {
            if (t.type !== 'sport') continue;
            const apart = (block.startMin >= t.endMin) ? (block.startMin - t.endMin) : (t.startMin - block.endMin);
            if (apart < 40) return false;
        }
        return true;
    };
    it('fills every gap incl. the gated last window — residual 0', () => {
        const res = Layout.planBunkLayout({
            bunk: 'Soloists א', grade: 'Soloists',
            // bell periods that, around the pinned walls, leave the four reported gaps
            periods: [P(650, 690), P(700, 730), P(735, 775), P(780, 810), P(810, 850), P(855, 895), P(905, 945)],
            pinned: [
                { kind: 'swim', name: 'Swim', startMin: 650, endMin: 690 },
                { kind: 'lunch', name: 'Lunch', startMin: 780, endMin: 810 },
                { kind: 'wall', name: 'Main Activity', startMin: 810, endMin: 850 },
                { kind: 'cleanup', name: 'Cleanup', startMin: 895, endMin: 905 }
            ],
            floating: [
                // many distinct specials per subcat → caps raised to availability (the fix)
                { kind: 'special', subcat: 'uncategorized', durations: [40], window: [650, 945], qty: 1, cap: 11, score: 1 },
                { kind: 'special', subcat: 'food', durations: [10, 20], window: [650, 945], qty: 1, cap: 6, score: 1 },
                { kind: 'special', subcat: 'shiur', durations: [20], window: [650, 945], qty: 1, cap: 3, score: 1 },
                { kind: 'special', subcat: 'theme', durations: [10, 20], window: [650, 945], qty: 1, cap: 1, score: 1 },
                { kind: 'sport', dMin: 10, dMax: 40, window: [650, 945], score: 1 }
            ],
            gate: sportSpacing, packer: PeriodPacker
        });
        assert.strictEqual(res.stats.residualMin, 0, 'the whole day is wall-to-wall — no gap left');
        const last = res.tiles.find(t => t.generic && t.startMin >= 905 && t.endMin <= 945);
        assert.ok(last, 'the last window (3:05-3:45) that used to be all-packings-gated is now filled');
        assert.ok((res.gaps || []).length === 0, 'no open gaps reported');
    });
});
