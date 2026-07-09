/**
 * Tests for: the rotation "split-brain" fix (found via the 2026-07-08
 * generation brain trace).
 *
 * Run with:  node --test tests/rotation_split_brain.test.js
 *
 * The bug: RotationEngine keeps two views of history —
 *   (a) the day-by-day history scan (local allDailyData + cloud overlay via
 *       mergeCloudData), consumed by recency/streak/coverage scoring;
 *   (b) the cumulative count store (historicalCounts / rotation_counts),
 *       consumed by frequency/distribution/fair-share/cooldowns.
 * TotalSolver.solveSchedule cleared the history cache AFTER the generation
 * preamble merged cloud data into it, so on devices with incomplete local
 * allDailyData view (a) went empty while view (b) stayed populated: 65% of
 * scored pairs claimed "never done" (-5000 bonus) for activities the count
 * store proved were done — recency stopped rotating anything.
 *
 * The fix, three layers:
 *   1. RotationEngine.reoverlayCloudCache() re-merges RotationCloud's cached
 *      payload after any mid-pipeline cache clear (wired into
 *      TotalSolver.solveSchedule and the hydrate path).
 *   2. calculateRecencyScore consults the count store before granting the
 *      never-done bonus; count > 0 routes to the fallback chain instead.
 *   3. calculateCoverageScore does the same for the missing-activity bonus.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeSandbox() {
    const win = {};
    const sandbox = {
        window: win,
        console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
        setTimeout, clearTimeout,
        Date, Math, Object, Array, JSON, String, Number, Boolean,
        Map, Set, Promise, parseInt, parseFloat, isNaN, isFinite,
        Infinity, NaN, Symbol
    };
    sandbox.global = sandbox;
    vm.createContext(sandbox);
    sandbox.window.currentScheduleDate = '2026-07-15';
    return sandbox;
}

function loadInto(filename, ctx) {
    const src = fs.readFileSync(path.join(__dirname, '..', filename), 'utf8');
    vm.runInContext(src, ctx, { filename });
}

function setup(historicalCounts) {
    const sb = makeSandbox();
    sb.window.scheduleAssignments = {};
    sb.window.activityProperties = {};
    sb.window.loadRotationHistory = () => ({ bunks: {}, leagues: {} });
    sb.window.loadGlobalSettings = () => ({
        app1: {
            fields: [{ name: 'Field A', activities: ['Soccer', 'Basketball', 'Hockey'] }],
            specialActivities: [{ name: 'Canteen' }]
        },
        historicalCounts: historicalCounts || {}
    });
    sb.window.loadAllDailyData = () => ({});   // ← local history EMPTY (the split-brain device)
    sb.window.divisions = { Juniors: { bunks: ['Bunk 1', 'Bunk 2'] } };
    loadInto('rotation_engine.js', sb);
    return sb;
}

describe('split-brain guard — recency vs count store', () => {
    it('does NOT grant the never-done bonus when the count store says count > 0', () => {
        const sb = setup({ 'Bunk 1': { Soccer: 3 } });
        const RE = sb.window.RotationEngine;
        const score = RE.calculateRecencyScore('Bunk 1', 'Soccer', 0);
        assert.notEqual(score, RE.CONFIG.NEVER_DONE_BONUS,
            'count store has Soccer=3 — recency must not reward it as brand-new');
        // Fallback chain: no timestamp → counts>0 ⇒ assume 14 days ⇒ decayed
        // week-plus penalty (a small positive number), never a -5000 bonus.
        assert.ok(score > 0, 'expected a mild recency penalty, got ' + score);
    });

    it('still grants the never-done bonus when the activity truly was never done', () => {
        const sb = setup({ 'Bunk 1': { Soccer: 3 } });
        const RE = sb.window.RotationEngine;
        const score = RE.calculateRecencyScore('Bunk 1', 'Hockey', 0);
        assert.equal(score, RE.CONFIG.NEVER_DONE_BONUS,
            'Hockey has no history AND no counts — genuine novelty keeps its bonus');
    });

    it('coverage: no missing-activity bonus when the count store says count > 0', () => {
        const sb = setup({ 'Bunk 1': { Soccer: 3 } });
        const RE = sb.window.RotationEngine;
        const cov = RE.calculateCoverageScore('Bunk 1', 'Soccer');
        // Full missing bonus would be MISSING_ACTIVITY_BONUS * 1.0 (coverage
        // ratio is 0 on this device). The guard must route to hasTried instead.
        assert.notEqual(cov, RE.CONFIG.MISSING_ACTIVITY_BONUS,
            'count store has Soccer=3 — must not score it as a never-tried activity');
    });
});

describe('reoverlayCloudCache — cloud overlay survives a cache wipe', () => {
    it('re-merges RotationCloud cached data after clearHistoryCache', () => {
        const sb = setup({});
        const win = sb.window;
        // Simulate the preamble's RotationCloud load having populated the cache
        win.RotationCloud = {
            getCachedData: () => ({
                counts: { 'Bunk 1': { Soccer: 2 } },
                lastDone: { 'Bunk 1': { Soccer: '2026-07-12' } }   // 3 days before 07-15
            })
        };
        const RE = win.RotationEngine;
        // First merge (as the preamble does), then the destructive clear
        RE.mergeCloudData(win.RotationCloud.getCachedData());
        RE.clearHistoryCache();
        // Without re-overlay the history is empty again → -5000. With the fix:
        const ok = RE.reoverlayCloudCache();
        assert.equal(ok, true, 'reoverlay must report success when cache data exists');
        const score = RE.calculateRecencyScore('Bunk 1', 'Soccer', 0);
        assert.equal(score, RE.CONFIG.THREE_DAYS_AGO_PENALTY,
            'cloud lastDone 3 days ago must surface as the 3-day recency penalty');
    });

    it('returns false gracefully when RotationCloud is absent or empty', () => {
        const sb = setup({});
        const RE = sb.window.RotationEngine;
        assert.equal(RE.reoverlayCloudCache(), false, 'no RotationCloud → false, no throw');
        sb.window.RotationCloud = { getCachedData: () => null };
        assert.equal(RE.reoverlayCloudCache(), false, 'empty cache → false, no throw');
    });
});
