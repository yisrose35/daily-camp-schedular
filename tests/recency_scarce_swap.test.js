/**
 * Tests for: total_solver_engine.js recencyScarceSwap — rotation-fairness post-pass.
 *
 * Run with:  node --test tests/recency_scarce_swap.test.js
 *
 * Why this exists: a single-capacity, single-sport overflow field (e.g.
 * "Soccer with Rabbi H." on "Touchdown Park") was repeatedly handed to the SAME
 * low-seniority bunk because the greedy group-matching processes the most
 * flexible bunk last, by which point every other field is taken. The recency
 * penalty cannot help when the repeat is the only feasible option. This pass
 * swaps the stuck bunk with a same-period, same-division peer for whom the trade
 * is fresher — but ONLY when the solver's own hard-feasibility gate
 * (calculatePenaltyCost < 900000) clears BOTH new placements.
 *
 * The heavy gates (recency lookup, penalty cost, field-usage index) are stubbed
 * so the swap DECISION + the undo/apply/revert plumbing are exercised
 * deterministically without standing up a full camp config.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.join(__dirname, '..');

function boot() {
    const win = {};
    const sb = {
        window: win,
        console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
        setTimeout, clearTimeout,
        Date, Math, Object, Array, JSON, String, Number, Boolean,
        Map, Set, Promise, parseInt, parseFloat, isNaN, isFinite,
        Infinity, NaN, Symbol, RegExp
    };
    sb.global = sb;
    vm.createContext(sb);
    win.scheduleAssignments = {};
    for (const f of ['scheduler_core_auto.js', 'total_solver_engine.js']) {
        vm.runInContext(fs.readFileSync(path.join(REPO, f), 'utf8'), sb, { filename: f });
    }
    return win;
}

// Build the canonical "σב stuck on rabbi-soccer, נט on Dodgeball, same period,
// same division" scenario, with the heavy gates stubbed to caller-chosen values.
function scenario(win, { daysSince, cost }) {
    const S = win._SolverInternals;
    win.scheduleAssignments = {
        'A': [{ field: 'Touchdown Park', sport: null, _activity: 'Soccer with Rabbi H.', _type: 'sport', _startMin: 805, _endMin: 870 }],
        'B': [{ field: 'Dodgeball Hill', sport: null, _activity: 'Dodgeball', _type: 'sport', _startMin: 805, _endMin: 870 }]
    };
    const blocks = [
        { bunk: 'A', divName: 'D', startTime: 805, endTime: 870, slots: [0] },
        { bunk: 'B', divName: 'D', startTime: 805, endTime: 870, slots: [0] }
    ];
    S._assignments.clear();
    S._assignments.set(0, { candIdx: 10, pick: { field: 'Touchdown Park', sport: null, _activity: 'Soccer with Rabbi H.', _type: 'sport' }, cost: 12000 });
    S._assignments.set(1, { candIdx: 11, pick: { field: 'Dodgeball Hill', sport: null, _activity: 'Dodgeball', _type: 'sport' }, cost: 50 });
    // Stubs (read via S inside the pass, so overriding the export takes effect):
    S.getFieldUsageFromTimeIndex = () => 0;                  // each bunk is sole occupant
    S.getDaysSinceActivity = (bunk, act) => daysSince(bunk, act);
    S.calculatePenaltyCost = () => cost;                     // hard-feasibility verdict
    return { S, blocks };
}

// Default recency: A did rabbi-soccer yesterday (stuck); everything else fresh.
const FRESH = (bunk, act) => {
    if (bunk === 'A' && act === 'Soccer with Rabbi H.') return 1;
    return null; // never done recently
};

describe('total_solver_engine recencyScarceSwap', () => {
    it('is exposed on the solver', () => {
        const win = boot();
        assert.equal(typeof win.TotalSolver.recencyScarceSwap, 'function');
    });

    it('rotates a stuck bunk off the single-sport field when the swap is feasible', () => {
        const win = boot();
        const { S, blocks } = scenario(win, { daysSince: FRESH, cost: 100 });
        const n = win.TotalSolver.recencyScarceSwap(blocks);
        assert.equal(n, 1, 'exactly one swap');
        assert.equal(win.scheduleAssignments['A'][0]._activity, 'Dodgeball', 'A rotated off rabbi-soccer');
        assert.equal(win.scheduleAssignments['B'][0]._activity, 'Soccer with Rabbi H.', 'B took the scarce field');
        // assignment bookkeeping followed the picks (candIdx swapped with them)
        assert.equal(S._assignments.get(0).pick._activity, 'Dodgeball');
        assert.equal(S._assignments.get(0).candIdx, 11);
        assert.equal(S._assignments.get(1).pick._activity, 'Soccer with Rabbi H.');
        assert.equal(S._assignments.get(1).candIdx, 10);
    });

    it('does NOT swap when no peer is fresher for the stuck sport (no fairness gain)', () => {
        const win = boot();
        // B also did rabbi-soccer yesterday → giving it to B is no improvement.
        const noGain = (bunk, act) => {
            if (act === 'Soccer with Rabbi H.') return 1; // both A and B did it yesterday
            return null;
        };
        const { blocks } = scenario(win, { daysSince: noGain, cost: 100 });
        const n = win.TotalSolver.recencyScarceSwap(blocks);
        assert.equal(n, 0, 'no swap without a fairness gain');
        assert.equal(win.scheduleAssignments['A'][0]._activity, 'Soccer with Rabbi H.');
        assert.equal(win.scheduleAssignments['B'][0]._activity, 'Dodgeball');
    });

    it('reverts cleanly to the original schedule when a swap is rejected', () => {
        const win = boot();
        const { blocks } = scenario(win, { daysSince: FRESH, cost: 999999 });
        const n = win.TotalSolver.recencyScarceSwap(blocks);
        assert.equal(n, 0, 'rejected swap leaves zero swaps');
        assert.equal(win.scheduleAssignments['A'][0]._activity, 'Soccer with Rabbi H.', 'A unchanged');
        assert.equal(win.scheduleAssignments['B'][0]._activity, 'Dodgeball', 'B unchanged');
    });

    it('honors the kill switch (window.__recencyScarceSwap = false)', () => {
        const win = boot();
        const { blocks } = scenario(win, { daysSince: FRESH, cost: 100 });
        win.__recencyScarceSwap = false;
        const n = win.TotalSolver.recencyScarceSwap(blocks);
        assert.equal(n, 0, 'kill switch disables the pass');
        assert.equal(win.scheduleAssignments['A'][0]._activity, 'Soccer with Rabbi H.', 'no change when disabled');
    });

    it('does not touch a bunk whose sport is NOT a recent repeat', () => {
        const win = boot();
        // A's rabbi-soccer was 5 days ago → not "stuck", leave the schedule alone.
        const stale = (bunk, act) => {
            if (bunk === 'A' && act === 'Soccer with Rabbi H.') return 5;
            return null;
        };
        const { blocks } = scenario(win, { daysSince: stale, cost: 100 });
        const n = win.TotalSolver.recencyScarceSwap(blocks);
        assert.equal(n, 0, 'no swap when the activity is not a recent repeat');
        assert.equal(win.scheduleAssignments['A'][0]._activity, 'Soccer with Rabbi H.');
    });
});
