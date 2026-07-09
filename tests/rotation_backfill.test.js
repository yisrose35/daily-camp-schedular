/**
 * Tests for: rotation_backfill.js (backfillRotationMemory) and the shared
 * RotationCloud.deriveCounts extraction.
 *
 * Run with:  node --test tests/rotation_backfill.test.js
 *
 * What must hold:
 *  1. deriveCounts applies the writer's exact rules (skips leagues, frees,
 *     transitions, continuations, non-catalog names; sport fallback works).
 *  2. The backfill heals a date missing from cloud rotation_counts and a
 *     date whose stored counts diverge, but leaves in-sync dates alone.
 *  3. Degraded-local safety: a date deriving to zero activities while the
 *     cloud has rows is SKIPPED, never deleted.
 *  4. dryRun changes nothing.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Objects/arrays created inside the vm sandbox have a different realm's
// prototypes; strict deepEqual rejects them. JSON-roundtrip to normalize.
const norm = (v) => JSON.parse(JSON.stringify(v));
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
    sandbox.window.currentScheduleDate = '2026-07-08';
    return sandbox;
}

function loadInto(filename, ctx) {
    const src = fs.readFileSync(path.join(__dirname, '..', filename), 'utf8');
    vm.runInContext(src, ctx, { filename });
}

const CATALOG_SETTINGS = {
    app1: {
        fields: [{ name: 'Court', activities: ['Basketball', 'Soccer'] }],
        specialActivities: [{ name: 'Canteen' }]
    }
};

function entry(act, extra) {
    return Object.assign({ field: 'Court', _activity: act }, extra || {});
}

function setup(allDaily, cloudCountsByDate) {
    const sb = makeSandbox();
    const win = sb.window;
    win.loadGlobalSettings = () => CATALOG_SETTINGS;
    win.loadAllDailyData = () => allDaily;
    win.hydrateLocalStorageFromCloud = async () => true;
    win.SchedulerCoreUtils = { rebuildHistoricalCounts: () => { win.__rebuilt = true; } };

    // RotationCloud stub with real deriveCounts wired in afterward
    const savedDates = [];
    win.__savedDates = savedDates;
    const cloudPayload = () => ({ counts: {}, lastDone: {}, countsByDate: cloudCountsByDate });
    win.RotationCloud = {
        load: async () => cloudPayload(),
        save: async (dateKey) => { savedDates.push(dateKey); return true; },
        getCachedData: () => cloudPayload(),
        deriveCounts: null // replaced below with the real implementation
    };

    // Load the REAL rotation_cloud.js in a scratch sandbox to steal deriveCounts?
    // Simpler: load rotation_cloud.js here — it overwrites win.RotationCloud, so
    // capture deriveCounts and graft it onto our stub.
    const realCloudSb = makeSandbox();
    realCloudSb.window.loadGlobalSettings = () => CATALOG_SETTINGS;
    loadInto('rotation_cloud.js', realCloudSb);
    win.RotationCloud.deriveCounts = realCloudSb.window.RotationCloud.deriveCounts;

    win.RotationEngine = {
        clearHistoryCache() {}, rebuildAllHistory() {}, mergeCloudData() {}
    };

    loadInto('rotation_backfill.js', sb);
    return sb;
}

describe('RotationCloud.deriveCounts — shared counting rules', () => {
    it('counts catalog activities, skips leagues/frees/continuations/non-catalog', () => {
        const sb = makeSandbox();
        sb.window.loadGlobalSettings = () => CATALOG_SETTINGS;
        loadInto('rotation_cloud.js', sb);
        const derive = sb.window.RotationCloud.deriveCounts;
        const counts = derive({
            'Bunk 1': [
                entry('Basketball'),
                entry('Basketball', { continuation: true }),      // skip
                entry('Free'),                                     // skip
                entry('Swim'),                                     // skip (not in catalog)
                entry('League Game', { _leagueName: 'ABBL', sport: 'Basketball' }), // skip (league)
                { field: 'Court', sport: 'Soccer' },               // sport fallback → Soccer
                entry('Canteen')
            ]
        });
        assert.deepEqual(norm(counts), {
            'Bunk 1|Basketball': 1,
            'Bunk 1|Soccer': 1,
            'Bunk 1|Canteen': 1
        });
    });
});

describe('backfillRotationMemory', () => {
    const day = (acts) => ({ scheduleAssignments: { 'Bunk 1': acts.map(a => entry(a)) } });

    it('heals missing and divergent dates, leaves in-sync dates alone', async () => {
        const allDaily = {
            '2026-06-23': day(['Basketball']),               // missing from cloud → heal
            '2026-06-24': day(['Soccer']),                    // divergent in cloud → heal
            '2026-06-25': day(['Canteen'])                    // in sync → leave
        };
        const cloud = {
            '2026-06-24': { 'Bunk 1': { Basketball: 1 } },    // stored says Basketball, derived says Soccer
            '2026-06-25': { 'Bunk 1': { Canteen: 1 } }
        };
        const sb = setup(allDaily, cloud);
        const report = await sb.window.backfillRotationMemory();
        assert.deepEqual(norm(sb.window.__savedDates).sort(), ['2026-06-23', '2026-06-24']);
        assert.deepEqual(norm(report.healed).sort(), ['2026-06-23', '2026-06-24']);
        assert.deepEqual(norm(report.ok), ['2026-06-25']);
        assert.equal(sb.window.__rebuilt, true, 'historicalCounts rebuilt after heal');
    });

    it('never deletes cloud rows for a degraded local day (derives to zero)', async () => {
        const allDaily = {
            '2026-06-26': { scheduleAssignments: { 'Bunk 1': [entry('Free'), null] } } // derives 0
        };
        const cloud = { '2026-06-26': { 'Bunk 1': { Basketball: 1 } } };
        const sb = setup(allDaily, cloud);
        const report = await sb.window.backfillRotationMemory();
        assert.deepEqual(norm(sb.window.__savedDates), [], 'no save may run for a degraded day');
        assert.deepEqual(norm(report.skippedDegraded), ['2026-06-26']);
    });

    it('dryRun reports but writes nothing', async () => {
        const allDaily = { '2026-06-23': day(['Basketball']) };
        const sb = setup(allDaily, {});
        const report = await sb.window.backfillRotationMemory({ dryRun: true });
        assert.deepEqual(norm(sb.window.__savedDates), []);
        assert.deepEqual(norm(report.healed), []);
        assert.match(report.dates['2026-06-23'], /NEEDS HEAL/);
        assert.notEqual(sb.window.__rebuilt, true, 'no rebuild in dry run');
    });
});
