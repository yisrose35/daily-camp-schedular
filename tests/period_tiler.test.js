/**
 * Tests for period_tiler.js — the PeriodTiler packing engine.
 *
 * Goal: the tiler must produce a correct, non-overlapping, in-bounds tiling
 * for ANY camp shape. These tests act as the guard while we harden it.
 *
 * Run with: node --test tests/period_tiler.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const PeriodTiler = require('../period_tiler.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// A movable/resizable piece (snack-like).
function flex(name, start, dur, opts = {}) {
    return {
        name,
        kind: opts.kind || 'anchor',
        configuredStart: start,
        configuredDur: dur,
        dMin: opts.dMin != null ? opts.dMin : dur,
        dMax: opts.dMax != null ? opts.dMax : dur,
        earliestStart: opts.earliestStart != null ? opts.earliestStart : start,
        latestStart: opts.latestStart != null ? opts.latestStart : start,
        isMovable: opts.isMovable != null ? opts.isMovable : true,
        isResizable: opts.isResizable != null ? opts.isResizable : true
    };
}

// A fixed wall (swim/lunch/anchor).
function wall(name, start, dur, opts = {}) {
    return flex(name, start, dur, Object.assign({ isMovable: false, isResizable: false }, opts));
}

// Validate a single period's layout: in-bounds, non-overlapping, durations within flex.
function assertLayoutSane(period, inhabitants, result) {
    const layout = result.layout || [];
    // sorted by start
    const sorted = layout.slice().sort((a, b) => a.start - b.start);
    let prevEnd = -Infinity;
    for (const p of sorted) {
        assert.ok(p.start >= period.startMin,
            `${p.name} starts ${p.start} before period ${period.startMin}`);
        assert.ok(p.end <= period.endMin,
            `${p.name} ends ${p.end} after period ${period.endMin}`);
        assert.ok(p.end > p.start, `${p.name} has non-positive duration`);
        assert.ok(p.start >= prevEnd,
            `${p.name} overlaps previous block (starts ${p.start}, prev ended ${prevEnd})`);
        prevEnd = p.end;
        // duration within [dMin, dMax]
        const ref = p.ref;
        if (ref) {
            assert.ok(p.dur >= ref.dMin,
                `${p.name} dur ${p.dur} < dMin ${ref.dMin}`);
            assert.ok(p.dur <= ref.dMax,
                `${p.name} dur ${p.dur} > dMax ${ref.dMax}`);
        }
    }
}

// Every inhabitant that belongs to the period must appear exactly once in the layout.
function assertNoDroppedPieces(period, inhabitants, result) {
    const inPeriod = inhabitants.filter(x =>
        x.configuredStart >= period.startMin && x.configuredStart < period.endMin);
    const placedNames = (result.layout || []).map(p => p.name).sort();
    const wantNames = inPeriod.map(x => x.name).sort();
    assert.deepStrictEqual(placedNames, wantNames,
        `period ${period.name}: placed ${JSON.stringify(placedNames)} != expected ${JSON.stringify(wantNames)}`);
}

// ---------------------------------------------------------------------------
// 1. Module smoke fixtures (the cases the author designed for)
// ---------------------------------------------------------------------------

describe('PeriodTiler — author smoke fixtures', () => {
    it('passes its own bundled smoke test', () => {
        const out = PeriodTiler._smokeTest();
        assert.ok(out.allPass, 'bundled smoke test should pass: ' + JSON.stringify(out.results, null, 2));
    });
});

// ---------------------------------------------------------------------------
// 2. Single-period correctness (the core invariant)
// ---------------------------------------------------------------------------

describe('PeriodTiler.tilePeriod — invariants hold for any shape', () => {
    it('empty period: no inhabitants → whole period is leftover', () => {
        const period = { startMin: 600, endMin: 660, name: 'P1' };
        const r = PeriodTiler.tilePeriod(period, [], 25);
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.leftover, 60);
        assertLayoutSane(period, [], r);
    });

    it('single fixed wall that fills the period exactly', () => {
        const period = { startMin: 600, endMin: 640, name: 'P1' };
        const inh = [wall('Swim', 600, 40)];
        const r = PeriodTiler.tilePeriod(period, inh, 25);
        assertLayoutSane(period, inh, r);
        assert.strictEqual(r.leftover, 0);
    });

    it('fixed wall longer than dMin must not be treated as dMin-sized', () => {
        // Wall configured 40 min but dMin defaults to 40 here; make a case where
        // a long fixed block + another fixed block would overlap if footprint
        // is mis-measured as dMin.
        const period = { startMin: 600, endMin: 700, name: 'P1' };
        const inh = [
            wall('Lunch', 600, 50),   // 600-650
            wall('Rest', 650, 50)     // 650-700, abuts exactly
        ];
        const r = PeriodTiler.tilePeriod(period, inh, 25);
        assertLayoutSane(period, inh, r);
    });

    it('two movable snacks in one period tile without overlap', () => {
        const period = { startMin: 600, endMin: 660, name: 'P1' };
        const inh = [
            flex('Slush', 610, 10, { dMin: 10, dMax: 20, earliestStart: 600, latestStart: 640 }),
            flex('Popcorn', 630, 10, { dMin: 10, dMax: 10, earliestStart: 600, latestStart: 650 })
        ];
        const r = PeriodTiler.tilePeriod(period, inh, 25);
        assertLayoutSane(period, inh, r);
        assertNoDroppedPieces(period, inh, r);
    });

    it('chooses the lower-shift layout among valid ok solutions', () => {
        // Slush can sit at 600 (no shift, leaves 610-660=50 sport-ok) or be shifted.
        // The minimal-shift ok solution keeps it near configured.
        const period = { startMin: 600, endMin: 660, name: 'P1' };
        const inh = [
            flex('Slush', 600, 10, { dMin: 10, dMax: 10, earliestStart: 600, latestStart: 650 })
        ];
        const r = PeriodTiler.tilePeriod(period, inh, 25);
        assertLayoutSane(period, inh, r);
        const slush = r.layout.find(p => p.name === 'Slush');
        assert.strictEqual(slush.start, 600, 'should not shift when no shift is needed');
    });
});

// ---------------------------------------------------------------------------
// 3. Full bunk-day: pieces must never be dropped or overlap
// ---------------------------------------------------------------------------

describe('PeriodTiler.tileBunkDay — no piece is ever dropped or overlapped', () => {
    function runDay(periods, inhabitants) {
        const res = PeriodTiler.tileBunkDay({
            bunk: 'B1', grade: 'G', periods, inhabitants, minSportDMin: 25
        });
        // validate each period's debug layout
        (res.debug.perPeriod || []).forEach((pd, i) => {
            const period = periods.find(p => p.name === pd.period) || periods[i];
            const inP = inhabitants.filter(x =>
                x.configuredStart >= period.startMin && x.configuredStart < period.endMin);
            assertLayoutSane(period, inP, pd.result);
            assertNoDroppedPieces(period, inP, pd.result);
        });
        return res;
    }

    it('multi-period day with walls + snacks stays sane', () => {
        const periods = [
            { startMin: 600, endMin: 660, name: 'P1' },
            { startMin: 660, endMin: 720, name: 'P2' },
            { startMin: 720, endMin: 780, name: 'P3' }
        ];
        const inhabitants = [
            wall('Swim', 600, 40),
            flex('Slush', 665, 10, { dMin: 10, dMax: 20, earliestStart: 660, latestStart: 700 }),
            wall('Lunch', 720, 30)
        ];
        runDay(periods, inhabitants);
    });

    it('piece whose configuredStart is outside every period is not silently corrupting', () => {
        const periods = [{ startMin: 600, endMin: 660, name: 'P1' }];
        const inhabitants = [
            wall('Swim', 600, 40),
            flex('Stray', 900, 10) // far outside the only period
        ];
        const res = runDay(periods, inhabitants);
        // Stray belongs to no period — it must not appear in any layout.
        (res.debug.perPeriod || []).forEach(pd => {
            const names = (pd.result.layout || []).map(p => p.name);
            assert.ok(!names.includes('Stray'), 'stray piece leaked into a period layout');
        });
    });
});

// ---------------------------------------------------------------------------
// 4. Stress: many movable pieces (permutation cap / fallback must stay sane)
// ---------------------------------------------------------------------------

describe('PeriodTiler — stress and degenerate shapes', () => {
    it('many movable pieces (> permutation cap) still produce a sane layout', () => {
        const period = { startMin: 600, endMin: 760, name: 'BigP' };
        const inh = [];
        for (let i = 0; i < 9; i++) {
            inh.push(flex('Snack' + i, 600 + i * 15, 10,
                { dMin: 10, dMax: 10, earliestStart: 600, latestStart: 750 }));
        }
        const r = PeriodTiler.tilePeriod(period, inh, 25);
        assertLayoutSane(period, inh, r);
        assertNoDroppedPieces(period, inh, r);
    });

    it('over-full period (pieces sum > period) does not produce overlaps', () => {
        const period = { startMin: 600, endMin: 640, name: 'Tight' };
        const inh = [
            wall('A', 600, 30),
            wall('B', 620, 30) // overlaps A and overflows the period
        ];
        const r = PeriodTiler.tilePeriod(period, inh, 25);
        // It may be !ok, but whatever layout it returns must not overlap/overflow.
        assertLayoutSane(period, inh, r);
    });

    it('zero-length period is handled', () => {
        const period = { startMin: 600, endMin: 600, name: 'Zero' };
        const r = PeriodTiler.tilePeriod(period, [], 25);
        assert.strictEqual(r.leftover, 0);
    });
});

// ---------------------------------------------------------------------------
// 5. Adversarial: footprint accounting and multi-period spans
// ---------------------------------------------------------------------------

describe('PeriodTiler — footprint and span correctness', () => {
    it('fixed block measured by its real duration, not dMin (no period overflow)', () => {
        // A fixed block configured 50 min but with a smaller dMin. Its real
        // footprint is 50 min and overflows a 40-min period. The tiler must NOT
        // emit a layout block that ends past the period boundary.
        const period = { startMin: 600, endMin: 640, name: 'P1' };
        const inh = [{
            name: 'BigFixed', kind: 'special',
            configuredStart: 600, configuredDur: 50,
            dMin: 20, dMax: 50,
            earliestStart: 600, latestStart: 600,
            isMovable: false, isResizable: false
        }];
        const r = PeriodTiler.tilePeriod(period, inh, 25);
        assertLayoutSane(period, inh, r);
    });

    it('two fixed blocks: footprint overlap is detected by real duration', () => {
        // A=600-650 (50 min), B configured 630 (would overlap A). A correct tiler
        // must not place them overlapping.
        const period = { startMin: 600, endMin: 700, name: 'P1' };
        const inh = [
            { name: 'A', kind: 'special', configuredStart: 600, configuredDur: 50,
              dMin: 50, dMax: 50, earliestStart: 600, latestStart: 600,
              isMovable: false, isResizable: false },
            { name: 'B', kind: 'special', configuredStart: 630, configuredDur: 40,
              dMin: 40, dMax: 40, earliestStart: 630, latestStart: 630,
              isMovable: false, isResizable: false }
        ];
        const r = PeriodTiler.tilePeriod(period, inh, 25);
        assertLayoutSane(period, inh, r);
    });

    it('eliminates a sliver by shifting a movable snack to the wall', () => {
        // 60-min period, two 10-min snacks configured mid-period leaving three
        // sub-25 slivers. A correct tiler packs them at the wall, leaving one
        // 40-min sport-fillable block → zero unsolvable slivers.
        const periods = [{ startMin: 600, endMin: 660, name: 'P1' }];
        const inhabitants = [
            flex('Slush', 620, 10, { dMin: 10, dMax: 10, earliestStart: 600, latestStart: 640 }),
            flex('Popcorn', 645, 10, { dMin: 10, dMax: 10, earliestStart: 600, latestStart: 650 })
        ];
        const res = PeriodTiler.tileBunkDay({
            bunk: 'B1', grade: 'G', periods, inhabitants, minSportDMin: 25
        });
        assert.strictEqual(res.unsolvableSlivers.length, 0,
            'tiler should pack the snacks to leave a sport-fillable block: ' +
            JSON.stringify(res.unsolvableSlivers));
    });

    it('does not shift pieces when the configured layout is already clean', () => {
        // Snack at the wall already; rest is a 50-min sport block. No change needed.
        const periods = [{ startMin: 600, endMin: 660, name: 'P1' }];
        const inhabitants = [
            flex('Slush', 600, 10, { dMin: 10, dMax: 10, earliestStart: 600, latestStart: 650 })
        ];
        const res = PeriodTiler.tileBunkDay({
            bunk: 'B1', grade: 'G', periods, inhabitants, minSportDMin: 25
        });
        assert.strictEqual(res.shifts.length, 0, 'no shift should be proposed: ' + JSON.stringify(res.shifts));
        assert.strictEqual(res.unsolvableSlivers.length, 0);
    });

    it('a piece spanning two periods does not overflow its assigned period', () => {
        const periods = [
            { startMin: 600, endMin: 660, name: 'P1' },
            { startMin: 660, endMin: 720, name: 'P2' }
        ];
        // LongSpecial configured 640, 40 min → 640-680, straddles P1/P2.
        const inhabitants = [wall('LongSpecial', 640, 40)];
        const res = PeriodTiler.tileBunkDay({
            bunk: 'B1', grade: 'G', periods, inhabitants, minSportDMin: 25
        });
        (res.debug.perPeriod || []).forEach((pd, i) => {
            const period = periods.find(p => p.name === pd.period) || periods[i];
            (pd.result.layout || []).forEach(p => {
                assert.ok(p.end <= period.endMin,
                    `${p.name} ends ${p.end} past period ${period.name} end ${period.endMin}`);
                assert.ok(p.start >= period.startMin,
                    `${p.name} starts ${p.start} before period ${period.name} start ${period.startMin}`);
            });
        });
    });
});
