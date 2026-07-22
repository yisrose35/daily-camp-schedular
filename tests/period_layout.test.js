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

    it('a capped special fills up to its cap, then the sport filler covers the rest', () => {
        // food cap 1 → after the one food, the second period has no special left, so the
        // sport FILLER legitimately covers it. (Specials are preferred over the sport
        // filler; sport is the last resort for time no special can fill.)
        const res = Layout.planBunkLayout({
            bunk: 'B1', grade: 'G',
            periods: [P(855, 895, 'P6'), P(905, 945, 'P7')], pinned: [],
            floating: [
                { kind: 'special', subcat: 'food', durations: [10, 20], window: [650, 945], qty: 1, cap: 1 },
                { kind: 'sport', durations: [30, 40], window: [650, 945] }
            ],
            packer: PeriodPacker
        });
        assert.strictEqual(res.stats.residualMin, 0, 'both periods wall-to-wall');
        const foods = tilesOf(res).filter(t => t.subcat === 'food');
        assert.strictEqual(foods.length, 1, 'food placed exactly its cap (1)');
        assert.strictEqual(res.remaining['special:food'], 0, 'food quota consumed');
        // the period with no special left is filled by the sport filler
        const p7sports = res.tiles.filter(t => t.generic && t.startMin >= 905 && t.kind === 'sport');
        assert.ok(p7sports.length >= 1, 'second period (no special left) filled by the sport filler');
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

    it('EVEN DAY: the FLOOR special is placed, then the over-floor remainder fills with SPORT', () => {
        // The user's rule: "give the minimum special, then a sport, then a special, then a
        // sport — even." food floor=1, cap=2. The first (floor) food lands; the SECOND window
        // is over-floor, so a SPORT fills it (not a stacked extra food). Floor guaranteed by
        // floorBonus; past the floor sport is the preferred filler.
        const res = Layout.planBunkLayout({
            bunk: 'B1', grade: 'G',
            periods: [P(650, 690, 'P1'), P(690, 730, 'P2')], pinned: [],
            floating: [
                { kind: 'sport', dMin: 10, dMax: 40, window: [650, 945] },
                { kind: 'special', subcat: 'food', durations: [40], window: [650, 945], qty: 1, cap: 2, score: 1 }
            ],
            packer: PeriodPacker
        });
        assert.strictEqual(res.stats.residualMin, 0, 'wall-to-wall');
        assert.strictEqual(tilesOf(res).filter(t => t.subcat === 'food').length, 1, 'exactly the FLOOR food (1), not the over-floor extra');
        assert.ok(tilesOf(res).filter(t => t.kind === 'sport').length >= 1, 'the over-floor remainder fills with sport (even day)');
    });

    it('OVER-PRODUCTION GUARD: a high-cap subcat is NOT stacked past its floor — sport fills the rest', () => {
        // The live bug behind uncat peaking at 32 across 38 bunks: uncategorized floor=1 but
        // cap=12, so the layout flooded the day with uncat. Now only the FLOOR uncat lands and
        // sport fills the remainder. (Without a sport demand — a sports-free camp — the uncat
        // WOULD fill the day, which the separate sports-free test covers.)
        const res = Layout.planBunkLayout({
            bunk: 'B1', grade: 'G',
            periods: [P(650, 690, 'P1'), P(690, 730, 'P2'), P(735, 775, 'P3'), P(905, 945, 'P7')], pinned: [],
            floating: [
                { kind: 'special', subcat: 'uncategorized', durations: [20, 40], window: [650, 945], qty: 1, cap: 12, score: 1 },
                { kind: 'sport', dMin: 10, dMax: 40, window: [650, 945] }
            ],
            packer: PeriodPacker
        });
        assert.strictEqual(res.stats.residualMin, 0, 'wall-to-wall');
        assert.strictEqual(tilesOf(res).filter(t => t.subcat === 'uncategorized').length, 1, 'only the floor uncat — NOT stacked to cap 12');
        assert.ok(tilesOf(res).filter(t => t.kind === 'sport').length >= 2, 'the rest of the day is sport (even, sport-rich)');
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

    it('fills the FLOOR special first, then the remaining window with sport — wall-to-wall', () => {
        // food floor=1, cap=2. The ONE floor food lands at its 20-min size; the rest of the
        // day (over-floor) fills with SPORT (the even day), never over the cap, wall-to-wall.
        const res = Layout.planBunkLayout({
            bunk: 'B1', grade: 'G',
            periods: [P(650, 690, 'P1'), P(700, 740, 'P2')], pinned: [],
            floating: [
                { kind: 'special', subcat: 'food', durations: [20], window: [650, 945], qty: 1, cap: 2, score: 1 },
                { kind: 'sport', dMin: 10, dMax: 40, window: [650, 945] }
            ],
            packer: PeriodPacker
        });
        assert.strictEqual(res.stats.residualMin, 0, 'fully wall-to-wall');
        const foods = tilesOf(res).filter(t => t.subcat === 'food');
        assert.strictEqual(foods.length, 1, 'exactly the FLOOR food (1), not stacked to cap 2');
        assert.ok(foods.every(f => f.durationMin === 20), 'the food respects its 20-min duration');
        assert.ok(tilesOf(res).filter(t => t.kind === 'sport').length >= 1, 'the over-floor remainder fills with sport');
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

    it('GUARANTEED FILL: a window where BOTH sport and special are spacing-gated still fills with a special (never blank), never a too-close sport', () => {
        // The live Neranina case behind the "+ Add" blank slots: sports must be
        // spaced AND the camp also spaces specials. P1 takes a food (sport blocked).
        // In P2 the sport is blocked (spacing) AND a 2nd food is blocked (too close
        // to P1's food) → under the old code P2 went BLANK ("all-packings-gated").
        // The model is "categories repeat, activities don't": the guaranteed-fill
        // fallback drops the content gate for NON-SPORT tiles only, so a 2nd food
        // fills P2 (categories repeat freely) while NO sport is ever placed too close.
        const gate = (block, template) => {
            if (block.type === 'sport') return false;          // sport always spacing-blocked here
            if (block.type === 'special') {                    // specials also spaced (40-min cooldown)
                for (const w of template) {
                    if (!w || w.type !== 'special') continue;
                    const gapBefore = (w.startMin || 0) - (block.endMin || 0);
                    const gapAfter  = (block.startMin || 0) - (w.endMin || 0);
                    if (gapBefore >= 0 && gapBefore < 40) return false;
                    if (gapAfter  >= 0 && gapAfter  < 40) return false;
                }
            }
            return true;
        };
        const res = Layout.planBunkLayout({
            bunk: 'B1', grade: 'G',
            periods: [P(650, 690, 'P1'), P(690, 730, 'P2')], pinned: [],
            floating: [
                { kind: 'sport', dMin: 10, dMax: 40, window: [650, 945] },
                { kind: 'special', subcat: 'food', durations: [40], window: [650, 945], qty: 1, cap: Infinity }
            ],
            gate, packer: PeriodPacker
        });
        assert.strictEqual(res.stats.residualMin, 0, 'both windows fill — a spacing-only block never leaves a blank');
        const foods = tilesOf(res).filter(t => t.subcat === 'food');
        assert.strictEqual(foods.length, 2, 'the doubly-gated window fell back to a 2nd food (categories repeat)');
        const sports = tilesOf(res).filter(t => t.kind === 'sport');
        assert.strictEqual(sports.length, 0, 'a sport is NEVER forced into a spacing-blocked window');
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

    it('LEAK FIX: the SWAP/ELASTIC repair paths honor the cross-bunk seat gate (no over-placement)', () => {
        // Repro of the live leak: a sport-spacing gate forces SWAP-REPAIR to pull a special
        // into a gated window. A shared seat ledger caps each special bucket at 1 camp-wide.
        // Before the fix, swap/elastic committed the special WITHOUT recording the seat, so a
        // 2nd/3rd bunk over-placed it. Now every commit routes through the gate+reservation.
        const resv = [];   // {cat, s, e}
        const catOf = (kind, ref, s, e) => kind === 'special' ? ('special:' + (ref && ref.subcat) + '@' + (e - s)) : (kind === 'sport' ? 'sport' : null);
        const seats = { 'special:food@40': 1, 'special:theme@40': 1 };   // 1 seat each, camp-wide
        const resourceGate = (kind, grade, bunk, s, e, ref) => {
            const c = catOf(kind, ref, s, e); if (!c || seats[c] == null) return true;
            let n = 0; for (const r of resv) if (r.cat === c && r.s < e && r.e > s) n++;
            return (n + 1) <= seats[c];
        };
        const resourceCommit = (kind, grade, bunk, s, e, ref) => { const c = catOf(kind, ref, s, e); if (c && seats[c] != null) resv.push({ cat: c, s, e }); };
        const sportGate = (block, template) => {   // no two sports within 40 min (forces swap/elastic)
            if (block.type !== 'sport') return true;
            for (const w of template) { if (w.type !== 'sport') continue; const a = (w.startMin || 0) - (block.endMin || 0), b = (block.startMin || 0) - (w.endMin || 0); if (a >= 0 && a < 40) return false; if (b >= 0 && b < 40) return false; }
            return true;
        };
        const mk = (b) => ({ bunk: b, grade: 'G', periods: [P(650, 690, 'P1'), P(690, 730, 'P2'), P(730, 770, 'P3'), P(770, 810, 'P4')], pinned: [],
            floating: [ { kind: 'sport', dMin: 10, dMax: 40, window: [650, 945] },
                        { kind: 'special', subcat: 'food', durations: [40], window: [650, 945], qty: 1, cap: 3 },
                        { kind: 'special', subcat: 'theme', durations: [40], window: [650, 945], qty: 1, cap: 3 } ] });
        // release hook so a relocated tile's seat follows it (release-old → commit-new)
        const resourceRelease = (kind, grade, bunk, s, e, ref) => { const c = catOf(kind, ref, s, e); if (c && seats[c] != null) { for (let i = 0; i < resv.length; i++) { if (resv[i].cat === c && resv[i].s === s && resv[i].e === e) { resv.splice(i, 1); break; } } } };
        const out = Layout.planAllBunksLayout({ order: ['B1', 'B2', 'B3'], perBunk: { B1: mk('B1'), B2: mk('B2'), B3: mk('B3') },
            packer: PeriodPacker, gate: sportGate, resourceGate, resourceCommit, resourceRelease, opts: {} });
        // TRUE concurrent peak from the FINAL tiles (sweep distinct edges; a band counts
        // a tile if it spans the whole [pt[i], pt[i+1]] slice). The bug was over-placing
        // the same bucket at the SAME band across bunks — not total tiles in the day.
        const concurrentPeak = (cat) => {
            const ivs = [];
            ['B1', 'B2', 'B3'].forEach(b => out.layoutByBunk[b].tiles.forEach(t => { if (catOf(t.kind, t, t.startMin, t.endMin) === cat) ivs.push([t.startMin, t.endMin]); }));
            const pts = [...new Set(ivs.reduce((a, iv) => a.concat(iv), []))].sort((a, b) => a - b);
            let mx = 0;
            for (let i = 0; i + 1 < pts.length; i++) { let n = 0; ivs.forEach(iv => { if (iv[0] <= pts[i] && iv[1] >= pts[i + 1]) n++; }); if (n > mx) mx = n; }
            return mx;
        };
        // across all bunks, no special@40 bucket exceeds its 1 seat at any overlapping band
        assert.ok(concurrentPeak('special:food@40') <= 1, 'food@40 within its 1 seat across bunks (swap/elastic respected the gate)');
        assert.ok(concurrentPeak('special:theme@40') <= 1, 'theme@40 within its 1 seat across bunks');
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

    it('SEAT GATE: a category capped via resourceGate is never exceeded across bunks; excess flows elsewhere', () => {
        // The swim-pool rule, generalized: cap "sport" at 1 concurrent seat. Two bunks each
        // have a food FLOOR (P1) then an over-floor slot (P2) the scorer would fill with sport.
        // Only ONE bunk may take sport in P2 (seat 1); the other is steered to a special.
        const resv = [];
        const catOf = (kind) => kind === 'sport' ? 'sport' : (kind === 'special' ? 'special' : null);
        const seats = { sport: 1 };
        const resourceGate = (kind, grade, bunk, s, e) => {
            const c = catOf(kind); if (!c || seats[c] == null) return true;
            let n = 0; for (const r of resv) if (r.c === c && r.s < e && r.e > s) n++;
            return (n + 1) <= seats[c];
        };
        const resourceCommit = (kind, grade, bunk, s, e) => { const c = catOf(kind); if (c) resv.push({ c, s, e }); };
        const mk = (bunk) => ({ bunk, grade: 'G', periods: [P(650, 690, 'P1'), P(700, 740, 'P2')], pinned: [],
            floating: [{ kind: 'sport', dMin: 10, dMax: 40, window: [650, 945] },
                       { kind: 'special', subcat: 'food', durations: [40], window: [650, 945], qty: 1, cap: 3, score: 1 }] });
        const out = Layout.planAllBunksLayout({
            order: ['B1', 'B2'], perBunk: { B1: mk('B1'), B2: mk('B2') },
            packer: PeriodPacker, resourceGate, resourceCommit, opts: {}
        });
        let sportsP2 = 0, specialsP2 = 0;
        ['B1', 'B2'].forEach(b => out.layoutByBunk[b].tiles.forEach(t => {
            if (!t.generic || t.startMin < 700 || t.endMin > 740) return;
            if (t.kind === 'sport') sportsP2++; else if (t.kind === 'special') specialsP2++;
        }));
        assert.ok(sportsP2 <= 1, 'sport seat cap (1) respected across bunks in P2, got ' + sportsP2);
        assert.strictEqual(specialsP2, 1, 'the seat-blocked bunk got a special in P2 instead (no blank)');
        assert.strictEqual(out.stats.residualMin, 0, 'still wall-to-wall — the cap rerouted, it did not blank');
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
    it('fills an 80-min window with TWO distinct specials of one 40-min subcat (categories repeat)', () => {
        // "Categories repeat, activities don't": an 80-min window with a single 40-min
        // subcat (cap 3 ⇒ 3 distinct available) now tiles wall-to-wall as two 40-min
        // specials IN THE MAIN PASS — the packer is offered up to `cap` synthetic slots
        // of the subcat, so it composes 40+40 directly (fill later assigns a DISTINCT
        // activity to each). No "Activity" placeholder, no leftover gap.
        const res = Layout.planBunkLayout({
            bunk: 'B1', grade: 'G',
            periods: [P(0, 80, 'P')], pinned: [],
            floating: [{ kind: 'special', subcat: 'regular', durations: [40], window: [0, 945], qty: 1, cap: 3, score: 1 }],
            packer: PeriodPacker
        });
        const specials = res.tiles.filter(t => t.generic && t.kind === 'special');
        assert.strictEqual(specials.length, 2, 'two 40-min specials fill the 80-min window');
        assert.strictEqual(res.stats.residualMin, 0, 'no gap left');
        assert.ok(specials.every(s => s.durationMin === 40), 'each is a full 40-min special, not a fragment');
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

    it('big sports-free window fills with MULTIPLE real specials, NOT the "activity" placeholder', () => {
        // The live Leebi case: no sport layer, so the only filler is the abstract
        // "activity" placeholder. A 120-min window with one Regular subcat (cap 7 ⇒ 7
        // distinct available activities) + the activity placeholder must fill with THREE
        // 40-min real specials (categories repeat), NOT [one special + a giant Activity
        // block]. Proves the scoring no longer lets the placeholder win on size and the
        // packer is offered enough synthetic special slots to compose 40+40+40.
        const res = Layout.planBunkLayout({
            bunk: 'B1', grade: 'G',
            periods: [P(0, 120, 'P')], pinned: [],
            floating: [
                { kind: 'special', subcat: 'regular', durations: [40], window: [0, 945], qty: 1, cap: 7, score: 1 },
                { kind: 'activity', dMin: 10, dMax: 120, window: [0, 945], score: 0 }
            ],
            packer: PeriodPacker
        });
        assert.strictEqual(res.stats.residualMin, 0, 'window fills wall-to-wall');
        const specials = res.tiles.filter(t => t.generic && t.kind === 'special');
        const activity = res.tiles.filter(t => t.generic && t.kind === 'activity');
        assert.strictEqual(specials.length, 3, 'three 40-min real specials fill the 120-min window');
        assert.strictEqual(activity.length, 0, 'the abstract "activity" placeholder is NOT used when real specials can fill');
    });

    it('declines to grow a special to a length its subcat cannot FILL (duration-trap guard)', () => {
        // 30-min window, specials only 20-min → the exact tiler does [special20 +
        // activity10]. The OLD absorb grew the special to 30 on the premise that
        // "fill assigns a real activity that simply runs the extra minutes" — but the
        // fill's DURATION GATE refuses (no 30-min activity exists), so the grown tile
        // was BORN DEAD (live: sports@30/@50/@110, cause no-activity-at-Nmin). Now the
        // grow only happens to a fillable length; here none exists, so the 20-min
        // special stays fillable and the 10-min remainder stays honest.
        const res = Layout.planBunkLayout({
            bunk: 'B1', grade: 'G',
            periods: [P(0, 30, 'P')], pinned: [],
            floating: [
                { kind: 'special', subcat: 'regular', durations: [20], window: [0, 945], qty: 1, cap: 2, score: 1 },
                { kind: 'activity', dMin: 10, dMax: 30, window: [0, 945], score: 0 }
            ],
            packer: PeriodPacker
        });
        const specials = tilesOf(res).filter(t => t.kind === 'special');
        assert.strictEqual(specials.length, 1, 'the 20-min special stays');
        assert.strictEqual(specials[0].endMin - specials[0].startMin, 20, 'NOT grown to an unfillable 30');
        // the 10-min remainder survives as the honest leftover (the engine's absorb/
        // honest-open endgame turns it into open time — never a born-dead special).
        const activity = tilesOf(res).filter(t => t.kind === 'activity');
        assert.strictEqual(activity.length, 1, 'the 10-min sliver remains (honest remainder)');
        assert.strictEqual(activity[0].endMin - activity[0].startMin, 10);
    });

    it('DOES grow a special over an activity sliver when the grown length is fillable', () => {
        // Same geometry, but the subcat also runs 30-min → growing 20→30 produces a
        // tile the fill CAN assign. The expand-the-special absorb stays alive for
        // exactly the case it was built for.
        const res = Layout.planBunkLayout({
            bunk: 'B1', grade: 'G',
            periods: [P(0, 30, 'P')], pinned: [],
            floating: [
                { kind: 'special', subcat: 'regular', durations: [20, 30], window: [0, 945], qty: 1, cap: 2, score: 1 },
                { kind: 'activity', dMin: 10, dMax: 30, window: [0, 945], score: 0 }
            ],
            packer: PeriodPacker
        });
        assert.strictEqual(res.stats.residualMin, 0, 'window fills wall-to-wall');
        assert.strictEqual(tilesOf(res).filter(t => t.kind === 'activity').length, 0, 'no "activity" placeholder remains');
        const specials = tilesOf(res).filter(t => t.kind === 'special');
        assert.strictEqual(specials.length, 1, 'a single special covers the whole window');
        assert.strictEqual(specials[0].endMin - specials[0].startMin, 30, 'grown to the FILLABLE 30');
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

    it('FLOORS guaranteed + EVEN remainder: each floor special lands (shiur not squished), then sport fills the rest (Majors case)', () => {
        // The live Majors case: shiur/food/theme/uncategorized floors (1 each) in a 110-min
        // window. ALL four FLOORS must land — a sport can NEVER swallow a window the bunk owes
        // a special (the floorBonus guarantee / the "that sport shouldn't be there" fix) — and
        // the 20-min shiur keeps its full size. But PAST the floors the over-floor remainder
        // fills with SPORT, NOT a stack of extra uncategorized (the user's "even day": minimum
        // special, then sport). Guards floor-guarantee AND no over-production together.
        // Realistic Majors: 4 gaps (~40min each, like the live day), floors distributed
        // across them. maxSegments caps tiles/window, so floors spread over gaps (the live
        // structure), not crammed into one window.
        const res = Layout.planBunkLayout({
            bunk: 'M', grade: 'Majors',
            periods: [P(650, 690, 'P1'), P(690, 730, 'P2'), P(735, 775, 'P3'), P(810, 840, 'P5')], pinned: [],
            floating: [
                { kind: 'special', subcat: 'shiur', durations: [20], window: [650, 945], qty: 1, cap: 1, score: 1 },
                { kind: 'special', subcat: 'food', durations: [10, 20], window: [650, 945], qty: 1, cap: 6, score: 1 },
                { kind: 'special', subcat: 'theme', durations: [10, 20], window: [650, 945], qty: 1, cap: 1, score: 1 },
                { kind: 'special', subcat: 'uncategorized', durations: [20, 40], window: [650, 945], qty: 1, cap: 11, score: 1 },
                { kind: 'sport', dMin: 10, dMax: 40, window: [650, 945], score: 1 }
            ],
            packer: PeriodPacker
        });
        assert.strictEqual(res.stats.residualMin, 0, 'wall-to-wall');
        // EVERY floor placed (guaranteed) — none swallowed by sport
        ['shiur', 'food', 'theme', 'uncategorized'].forEach(function (sc) {
            assert.strictEqual(res.remaining['special:' + sc], 0, 'floor special ' + sc + ' met (not dropped)');
        });
        const shiur = tilesOf(res).find(t => t.subcat === 'shiur');
        assert.ok(shiur && shiur.durationMin === 20, 'the 20-min shiur kept its full size, not squished');
        // no over-production: uncategorized appears exactly its floor (1), not stacked to cap 11
        assert.strictEqual(tilesOf(res).filter(t => t.subcat === 'uncategorized').length, 1, 'uncategorized at its floor (1), not stacked past it');
        // the over-floor remainder is sport (the even day, sport-rich)
        assert.ok(tilesOf(res).filter(t => t.kind === 'sport').length >= 1, 'over-floor remainder fills with sport');
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

    it('INVERSE-ELASTIC: with every subcat cap=1, the greedy front-loads specials and a sport blocks the last window — a special is SHIFTED in and the sport SHIFTED out', () => {
        // The exact live Neranina/Friday config: each subcategory is configured "=1" so
        // there are only FOUR special tiles for the day. The greedy main pass spends them
        // in the early windows and leaves a sport in period 6 (855-895); the last window
        // (905-945) then has no special left AND can't take a sport (it would sit 10 min
        // from the period-6 sport, < the 40-min spacing rule) → it used to blank ("+ Add").
        // The inverse-elastic pass must pull a special INTO the last window and drop a
        // sport where that special was (a window a sport welcomes).
        const res = Layout.planBunkLayout({
            bunk: 'Soloists ב', grade: 'Soloists',
            periods: [P(650, 690), P(700, 730), P(735, 775), P(780, 810), P(810, 850), P(855, 895), P(905, 945)],
            pinned: [
                { kind: 'swim', name: 'Swim', startMin: 650, endMin: 690 },
                { kind: 'lunch', name: 'Lunch', startMin: 780, endMin: 810 },
                { kind: 'wall', name: 'Main Activity', startMin: 810, endMin: 850 },
                { kind: 'cleanup', name: 'Cleanup', startMin: 895, endMin: 905 }
            ],
            floating: [
                { kind: 'special', subcat: 'uncategorized', durations: [30, 40], window: [650, 945], qty: 1, cap: 1, score: 1 },
                { kind: 'special', subcat: 'shiur', durations: [20], window: [650, 945], qty: 1, cap: 1, score: 1 },
                { kind: 'special', subcat: 'food', durations: [10, 20], window: [650, 945], qty: 1, cap: 1, score: 1 },
                { kind: 'special', subcat: 'theme', durations: [10, 20], window: [650, 945], qty: 1, cap: 1, score: 1 },
                { kind: 'sport', dMin: 10, dMax: 40, window: [650, 945], score: 1 }
            ],
            gate: sportSpacing, packer: PeriodPacker
        });
        assert.strictEqual(res.stats.residualMin, 0, 'cap-1 day is still wall-to-wall — the blocked last window got filled');
        assert.ok((res.gaps || []).length === 0, 'no open gaps reported');
        // the last window must hold a SPECIAL (pulled in), never blank and never a sport
        const lastTiles = res.tiles.filter(t => t.generic && t.startMin >= 905 && t.endMin <= 945);
        assert.ok(lastTiles.length > 0, 'last window filled');
        assert.ok(lastTiles.every(t => t.kind === 'special'), 'last window is all-special (a sport is illegal there)');
        // sport-spacing is never violated by the shift
        const sports = res.tiles.filter(t => t.generic && t.kind === 'sport').sort((a, b) => a.startMin - b.startMin);
        for (let i = 1; i < sports.length; i++) {
            assert.ok(sports[i].startMin - sports[i - 1].endMin >= 40, 'sports stay >=40 min apart after the shift');
        }
    });
});

// ── GAP PROBE: each surviving gap says whether PLACEMENT or CONFIG can fill it ──
describe('PeriodLayout — gap probe classifies why a gap survived', () => {
    it('caps-exhausted: gap where every short-enough activity is used → placement-immune', () => {
        // 160-min window, one 40-min subcat with only 2 distinct activities, no sport.
        // GAP-CLOSE lays 2 tiles, 80 min survive — and the probe must say the hole is
        // config-stuck (moving tiles would only relocate it, day quotas don't change).
        const res = Layout.planBunkLayout({
            bunk: 'B1', grade: 'G',
            periods: [P(0, 160, 'P')], pinned: [],
            floating: [{ kind: 'special', subcat: 'regular', durations: [40], window: [0, 945], qty: 1, cap: 2, score: 1 }],
            packer: PeriodPacker
        });
        assert.strictEqual(res.stats.residualMin, 80);
        const g = (res.gaps || []).find(x => x.len === 80);
        assert.ok(g, 'the 80-min gap is reported');
        assert.ok(String(g.probe || '').includes('caps-exhausted'),
            'probe must classify it caps-exhausted/placement-immune, got: ' + g.probe);
    });

    it('no-activity-this-short: a gap shorter than every configured duration', () => {
        // 50-min window, only a 40-min special (cap 1) → 40 lays, 10-min gap survives
        // and nothing configured is that short.
        const res = Layout.planBunkLayout({
            bunk: 'B1', grade: 'G',
            periods: [P(0, 50, 'P')], pinned: [],
            floating: [{ kind: 'special', subcat: 'regular', durations: [40], window: [0, 945], qty: 1, cap: 1, score: 1 }],
            packer: PeriodPacker
        });
        const g = (res.gaps || []).find(x => x.len === 10);
        assert.ok(g, 'the 10-min gap is reported');
        assert.ok(String(g.probe || '').includes('no-activity-this-short'),
            'probe must say nothing configured is short enough, got: ' + g.probe);
    });

    it('spacing-gated: a sport has quota + duration but the spacing rule blocks it here', () => {
        // Sport rejected EVERYWHERE by the gate (extreme spacing), one 40-min special
        // cap 1 → the special lays in one window, the other window's gap has a sport
        // that FITS but is spacing-gated → probe must call it placement-territory.
        const noSportEver = (block) => block.type !== 'sport';
        const res = Layout.planBunkLayout({
            bunk: 'B1', grade: 'G',
            periods: [P(0, 40, 'P1'), P(50, 90, 'P2')], pinned: [],
            floating: [
                { kind: 'special', subcat: 'regular', durations: [40], window: [0, 945], qty: 1, cap: 1, score: 1 },
                { kind: 'sport', dMin: 40, dMax: 40, window: [0, 945], score: 1 }
            ],
            gate: noSportEver, packer: PeriodPacker
        });
        const g = (res.gaps || []).find(x => x.len === 40);
        assert.ok(g, 'one 40-min window survives (special spent, sport gated): '
            + JSON.stringify((res.gaps || []).map(x => x.len)));
        assert.ok(String(g.probe || '').includes('spacing-gated'),
            'probe must classify the sport as spacing-gated, got: ' + g.probe);
    });
});

// ── FINAL SWAP-CHAIN REPAIR: executes the probe's "swap-chain-possible" move ──
describe('PeriodLayout — swap-chain repair moves an own tile into a stuck gap', () => {
    it('partial move the exact-sum passes cannot do: 20-min special → 40-min gap, sport → its old slot', () => {
        // Live Neranina shape: a gap survives BOTH run-swap (needs a contiguous run
        // summing EXACTLY to the gap) and inverse-elastic (needs the re-pack to
        // consume exactly the freed donors) because the only movable donor is
        // SHORTER than the gap. The swap-chain repair moves it anyway (partial
        // fill beats dead time) and drops a sport in its old slot.
        // Gate: a sport is legal ONLY at exactly [20,40] — nowhere else.
        const sportOnlyAt2040 = (block) =>
            block.type !== 'sport' || (block.startMin === 20 && block.endMin === 40);
        const res = Layout.planBunkLayout({
            bunk: 'B1', grade: 'G',
            periods: [P(0, 40, 'P1'), P(50, 90, 'P2')], pinned: [],
            floating: [
                { kind: 'special', subcat: 'shiur', durations: [20], window: [0, 945], qty: 1, cap: 1, score: 1 },
                { kind: 'special', subcat: 'food', durations: [20], window: [0, 945], qty: 1, cap: 1, score: 1 },
                { kind: 'sport', dMin: 20, dMax: 20, window: [0, 945], score: 1 }
            ],
            gate: sportOnlyAt2040, packer: PeriodPacker
        });
        // both specials pack P1 (floors win); P2 could not fill (sport illegal
        // there, specials spent) — the swap-chain must move the [20,40] special
        // into P2 and back-fill its slot with the sport.
        assert.ok((res.stats.swapChainRepaired || 0) >= 1,
            'the swap-chain repair must fire (repaired=' + res.stats.swapChainRepaired + ')');
        assert.strictEqual(res.stats.residualMin, 20,
            'gap shrinks 40 → 20 (the 20-min donor moved in; nothing else is legal)');
        const inP2 = res.tiles.filter(t => t.generic && t.startMin >= 50 && t.endMin <= 90);
        assert.ok(inP2.some(t => t.kind === 'special' && t.durationMin === 20),
            'a 20-min special now sits in the stuck window: ' + JSON.stringify(inP2.map(t => t.kind + '@' + t.startMin)));
        const sportAt = res.tiles.find(t => t.kind === 'sport' && t.startMin === 20 && t.endMin === 40);
        assert.ok(sportAt, 'the sport back-fills the donor\'s old [20,40] slot');
    });

    it('no sport in the pool → repair never fires (sportless day unchanged)', () => {
        const res = Layout.planBunkLayout({
            bunk: 'B1', grade: 'G',
            periods: [P(0, 160, 'P')], pinned: [],
            floating: [{ kind: 'special', subcat: 'regular', durations: [40], window: [0, 945], qty: 1, cap: 2, score: 1 }],
            packer: PeriodPacker
        });
        assert.strictEqual(res.stats.swapChainRepaired || 0, 0);
        assert.strictEqual(res.stats.residualMin, 80, 'honest gap untouched');
    });
});

    it('SPORT mover: relocating the blocking sport itself into the gap (backfill its slot) when no special can move', () => {
        // The live "swap-chain-possible(Sport→gap, sport→its slot)" verdict: the only
        // legal chain moves a SPORT. Asymmetric spacing stand-in: a sport in the LATE
        // window is legal only when NO sport sits in the mid window (think "the mid
        // sport is the spacing blocker"); the mid window itself always welcomes a
        // sport. The special is window-locked to P1, so no special can move — the old
        // executor (specials-only movers) left the gap dead.
        const midSpan = (b) => b.startMin === 40 && b.endMin === 60;
        const lateSpan = (b) => b.startMin === 70 && b.endMin === 90;
        const asymGate = (block, template) => {
            if (block.type !== 'sport') return true;
            if (midSpan(block)) return true;                       // mid window always welcomes a sport
            if (lateSpan(block)) {
                for (const t of template) if (t.type === 'sport' && midSpan(t)) return false;
                return true;
            }
            return true;
        };
        const res = Layout.planBunkLayout({
            bunk: 'B1', grade: 'G',
            periods: [P(0, 20, 'P1'), P(40, 60, 'P2'), P(70, 90, 'P3')], pinned: [],
            floating: [
                { kind: 'special', subcat: 'reg', durations: [20], window: [0, 25], qty: 1, cap: 1, score: 1 },
                { kind: 'sport', dMin: 20, dMax: 20, window: [0, 945], score: 1 }
            ],
            gate: asymGate, packer: PeriodPacker
        });
        // main pass: special→P1, sport→P2; P3 gated (sport at P2 present) → gap.
        // swap-chain must move the P2 sport into P3 (now legal: no mid sport in the
        // no-mover template) and back-fill P2 with a fresh sport (always legal).
        assert.ok((res.stats.swapChainRepaired || 0) >= 1,
            'sport-mover chain must fire (repaired=' + res.stats.swapChainRepaired + ')');
        assert.strictEqual(res.stats.residualMin, 0, 'the day closes wall-to-wall');
        const late = res.tiles.filter(t => t.generic && t.startMin >= 70 && t.endMin <= 90);
        assert.ok(late.some(t => t.kind === 'sport'), 'the late window now holds the relocated sport');
        const mid = res.tiles.filter(t => t.generic && t.startMin >= 40 && t.endMin <= 60);
        assert.ok(mid.some(t => t.kind === 'sport'), 'the mid window is back-filled with a sport');
    });

// ── CONGESTION-AWARE PLACER: pressure steers sports out of packed hours ──
describe('PeriodLayout — window pressure flips the over-floor filler from sport to special', () => {
    const FLOATING = [
        // floor 1 special (cap 2 distinct) + unlimited sport filler; window 0-80
        { kind: 'special', subcat: 'regular', durations: [40], window: [0, 945], qty: 1, cap: 2, score: 1 },
        { kind: 'sport', dMin: 40, dMax: 40, window: [0, 945], score: 1 }
    ];
    it('no pressure → floor special + SPORT filler (the tuned even-day default, unchanged)', () => {
        const res = Layout.planBunkLayout({
            bunk: 'B1', grade: 'G',
            periods: [P(0, 80, 'P')], pinned: [],
            floating: JSON.parse(JSON.stringify(FLOATING)),
            packer: PeriodPacker
        });
        const kinds = res.tiles.filter(t => t.generic).map(t => t.kind).sort();
        assert.deepStrictEqual(kinds, ['special', 'sport'],
            'over-floor slot fills with a sport when the hour is empty: ' + JSON.stringify(kinds));
    });
    it('full sport pressure → the over-floor slot takes the SECOND SPECIAL instead (sport goes elsewhere)', () => {
        const res = Layout.planBunkLayout({
            bunk: 'B1', grade: 'G',
            periods: [P(0, 80, 'P')], pinned: [],
            floating: JSON.parse(JSON.stringify(FLOATING)),
            pressure: (kind) => (kind === 'sport' ? 1 : 0),   // this hour is at the field ceiling
            packer: PeriodPacker
        });
        const kinds = res.tiles.filter(t => t.generic).map(t => t.kind).sort();
        assert.deepStrictEqual(kinds, ['special', 'special'],
            'a window at the field ceiling must NOT take another sport: ' + JSON.stringify(kinds));
    });
});
