/**
 * Tests for: rotation_engine.js calculateLimitScore — fair-share hard cap.
 *
 * Run with:  node --test tests/fair_share_hard_cap.test.js
 *
 * Rule (user-requested): a bunk that has done an activity 2+ more times than the
 * least-served participant is BLOCKED (calculateLimitScore → Infinity) until the
 * laggards catch up — so no one laps the field on a scarce/contended activity.
 * Comparison pool = bunks that have actually done it (count>=1). It is placed LAST
 * in calculateLimitScore so an explicit maxUsage/exactFrequency ceiling or a
 * below-floor min-frequency pull always takes precedence.
 *
 * getActivityCount is stubbed so the cap logic is exercised deterministically.
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
    vm.runInContext(fs.readFileSync(path.join(REPO, 'rotation_engine.js'), 'utf8'), sb, { filename: 'rotation_engine.js' });
    return win;
}

const ACT = 'Soccer with Rabbi H.';

// Configure division membership + a count map, then return calculateLimitScore.
function scenario(win, { bunks, counts }) {
    win.divisions = { D: { bunks: bunks } };
    win.RotationEngine.getActivityCount = (b, a) => (counts[b] || 0);
    win.RotationEngine.clearHistoryCache();   // drop the per-gen floor cache
    return win.RotationEngine.calculateLimitScore;
}

describe('rotation_engine calculateLimitScore — fair-share hard cap', () => {
    it('exposes getFairShareFloor', () => {
        const win = boot();
        assert.equal(typeof win.RotationEngine.getFairShareFloor, 'function');
    });

    it('blocks a bunk that is 2+ above the least-served participant', () => {
        const win = boot();
        const limit = scenario(win, { bunks: ['A', 'B', 'C'], counts: { A: 5, B: 1, C: 1 } });
        assert.equal(limit('A', ACT, {}, 'D'), Infinity, 'A (5) vs floor 1 → blocked');
    });

    it('allows a bunk at or near the floor', () => {
        const win = boot();
        const limit = scenario(win, { bunks: ['A', 'B', 'C'], counts: { A: 5, B: 1, C: 1 } });
        assert.notEqual(limit('B', ACT, {}, 'D'), Infinity, 'B (1) is the floor → allowed');
    });

    it('caps exactly at floor+2 (boundary)', () => {
        const win = boot();
        const limit = scenario(win, { bunks: ['A', 'B'], counts: { A: 3, B: 1 } });
        assert.equal(limit('A', ACT, {}, 'D'), Infinity, 'floor 1, A=3 = floor+2 → blocked');
        // floor+1 must still be allowed
        const limit2 = scenario(win, { bunks: ['A', 'B'], counts: { A: 2, B: 1 } });
        assert.notEqual(limit2('A', ACT, {}, 'D'), Infinity, 'floor 1, A=2 = floor+1 → allowed');
    });

    it('does nothing when fewer than 2 bunks have done it (no real distribution)', () => {
        const win = boot();
        const limit = scenario(win, { bunks: ['A', 'B', 'C'], counts: { A: 5 } });
        assert.notEqual(limit('A', ACT, {}, 'D'), Infinity, 'sole doer → no comparison pool → not blocked');
    });

    it('honors the kill switch (window.__fairShareHardCap = false)', () => {
        const win = boot();
        const limit = scenario(win, { bunks: ['A', 'B', 'C'], counts: { A: 5, B: 1, C: 1 } });
        win.__fairShareHardCap = false;
        win.RotationEngine.clearHistoryCache();
        assert.notEqual(limit('A', ACT, {}, 'D'), Infinity, 'disabled → not blocked');
    });

    it('respects a configurable gap (window.__fairShareGap)', () => {
        const win = boot();
        win.__fairShareGap = 3;
        const limit = scenario(win, { bunks: ['A', 'B'], counts: { A: 3, B: 1 } });
        assert.notEqual(limit('A', ACT, {}, 'D'), Infinity, 'gap 3: A=3 = floor+2 → allowed');
        const limit2 = scenario(win, { bunks: ['A', 'B'], counts: { A: 4, B: 1 } });
        assert.equal(limit2('A', ACT, {}, 'D'), Infinity, 'gap 3: A=4 = floor+3 → blocked');
    });

    it('an explicit maxUsage ceiling still takes precedence', () => {
        const win = boot();
        const limit = scenario(win, { bunks: ['A', 'B'], counts: { A: 2, B: 2 } });
        // no fair-share gap here (both equal), but maxUsage=2 must hard-block at the cap
        assert.equal(limit('A', ACT, { [ACT]: { maxUsage: 2 } }, 'D'), Infinity, 'maxUsage cap reached → blocked');
    });

    it('a below-min-frequency bunk is PULLED (negative), never blocked by the cap', () => {
        const win = boot();
        // A is 2+ above the floor (would be capped) but is below its minFrequency floor:
        // the min-frequency pull must win, returning a negative score, not Infinity.
        const limit = scenario(win, { bunks: ['A', 'B'], counts: { A: 5, B: 1 } });
        const score = limit('A', ACT, { [ACT]: { minFrequency: 10 } }, 'D');
        assert.ok(score < 0, 'below-min-frequency pull takes precedence over the fair-share cap (got ' + score + ')');
        assert.notEqual(score, Infinity);
    });
});

// ★ Division-scoped floor (2026-07-08/09 live finding): the camp-wide pool let one
//   light-skeleton bunk anywhere (count 1) pin the floor at 1 for the whole camp,
//   capping every division's bunks at 3 and emptying whole candidate pools → Free
//   slots. The peer group is now the bunk's OWN division (same skeleton = same
//   opportunity count); other divisions' counts are ignored.
function scenarioMulti(win, divisionsMap, counts) {
    win.divisions = {};
    Object.keys(divisionsMap).forEach(d => { win.divisions[d] = { bunks: divisionsMap[d] }; });
    win.RotationEngine.getActivityCount = (b, a) => (counts[b] || 0);
    win.RotationEngine.clearHistoryCache();
    return win.RotationEngine.calculateLimitScore;
}

describe('rotation_engine fair-share cap — division-scoped floor', () => {
    it('a floor-1 bunk in ANOTHER division no longer caps this division', () => {
        const win = boot();
        // X's own floor is 3 → A(4) < 3+2 → allowed. Camp-wide floor would be 1 → blocked.
        const limit = scenarioMulti(win, { X: ['A', 'B'], Y: ['C'] }, { A: 4, B: 3, C: 1 });
        assert.notEqual(limit('A', ACT, {}, 'X'), Infinity, 'peer floor is 3, not the other division\'s 1');
    });

    it('a division-mate holding the low floor still blocks (real intra-division lapping)', () => {
        const win = boot();
        const limit = scenarioMulti(win, { X: ['A', 'B'], Y: ['C'] }, { A: 4, B: 1, C: 9 });
        assert.equal(limit('A', ACT, {}, 'X'), Infinity, 'A(4) vs own-division floor 1 → blocked');
    });

    it('<2 doers within the division → no cap, even with doers elsewhere', () => {
        const win = boot();
        const limit = scenarioMulti(win, { X: ['A'], Y: ['C', 'D'] }, { A: 9, C: 1, D: 1 });
        assert.notEqual(limit('A', ACT, {}, 'X'), Infinity, 'no peer group in X → no cap');
    });

    it('no divisionName (legacy caller) → camp-wide pool preserved', () => {
        const win = boot();
        const limit = scenarioMulti(win, { X: ['A', 'B'], Y: ['C'] }, { A: 4, B: 3, C: 1 });
        assert.equal(limit('A', ACT, {}, null), Infinity, 'camp-wide floor 1 → A(4) blocked');
    });

    it('unknown divisionName falls back to camp-wide (not a crash, not a free pass)', () => {
        const win = boot();
        const limit = scenarioMulti(win, { X: ['A', 'B'], Y: ['C'] }, { A: 4, B: 3, C: 1 });
        assert.equal(limit('A', ACT, {}, 'NoSuchDiv'), Infinity, 'unresolvable division → camp-wide floor 1');
    });

    it('kill switch __fairShareDivisionScope=false restores the camp-wide pool', () => {
        const win = boot();
        win.__fairShareDivisionScope = false;
        const limit = scenarioMulti(win, { X: ['A', 'B'], Y: ['C'] }, { A: 4, B: 3, C: 1 });
        assert.equal(limit('A', ACT, {}, 'X'), Infinity, 'scope off → camp-wide floor 1 → blocked');
    });

    it('per-division floors are cached independently (no cross-division bleed)', () => {
        const win = boot();
        // Same activity, same gen: X's floor is 3 (A allowed), Y's floor is 1 (C blocked).
        const limit = scenarioMulti(win, { X: ['A', 'B'], Y: ['C', 'D'] }, { A: 4, B: 3, C: 3, D: 1 });
        assert.notEqual(limit('A', ACT, {}, 'X'), Infinity, 'X floor 3 → A(4) allowed');
        assert.equal(limit('C', ACT, {}, 'Y'), Infinity, 'Y floor 1 → C(3) blocked');
    });
});
