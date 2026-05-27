/**
 * Tests for auto-generation post-run hooks:
 *   - historicalCounts updated correctly on first generation
 *   - historicalCounts updated correctly on re-generation (old counts subtracted properly)
 *   - rotationHistory timestamps set for all bunks after generation
 *   - reIncrementHistoricalCounts uses caller-supplied oldSchedule when provided
 *
 * Run with: node --test tests/post_edit_autogen.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// =====================================================================
// MINIMAL BROWSER-GLOBAL STUBS
// =====================================================================

global.window = global;
global.document = { readyState: 'complete', addEventListener() {}, getElementById() { return null; } };
global.localStorage = (() => {
    let store = {};
    return {
        getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
        setItem(k, v) { store[k] = String(v); },
        removeItem(k) { delete store[k]; },
        clear() { store = {}; },
        _store() { return store; }
    };
})();
global.console = console;
global.setTimeout = (fn) => fn();   // run inline in tests
global.CustomEvent = class CustomEvent {
    constructor(type, opts) { this.type = type; this.detail = opts?.detail; }
};
global.dispatchEvent = () => true;
global.addEventListener = () => {};

// =====================================================================
// STUBS for SchedulerCoreUtils
// =====================================================================

// Load the real reIncrementHistoricalCounts logic inline (extracted for testing)
// rather than requiring the 12k-line scheduler_core_utils.js

let fakeGlobalSettings = {};
let fakeRotationHistory = { bunks: {}, leagues: {} };
let forceSyncCalls = 0;

global.loadGlobalSettings = () => JSON.parse(JSON.stringify(fakeGlobalSettings));
global.saveGlobalSettings = (key, val) => { fakeGlobalSettings[key] = JSON.parse(JSON.stringify(val)); };
global.forceSyncToCloud = async () => { forceSyncCalls++; };
global.loadRotationHistory = () => JSON.parse(JSON.stringify(fakeRotationHistory));
global.saveRotationHistory = (h) => { fakeRotationHistory = JSON.parse(JSON.stringify(h)); };

// Minimal getValidActivityNames — treats everything as valid
global.SchedulerCoreUtils = {
    getValidActivityNames() {
        return { has: () => true };
    },
    incrementHistoricalCounts(dateKey, scheduleAssignments, saveToCloud = true) {
        const gs = global.loadGlobalSettings();
        const counts = gs.historicalCounts || {};
        const dated = gs.historicalCountedDates || {};
        if (dated[dateKey]) return counts;   // already counted
        const sched = scheduleAssignments || {};
        Object.keys(sched).forEach(bunk => {
            (sched[bunk] || []).forEach(entry => {
                if (!entry || entry.continuation || entry._isTransition) return;
                const act = entry._activity || '';
                if (!act || act.toLowerCase() === 'free') return;
                counts[bunk] = counts[bunk] || {};
                counts[bunk][act] = (counts[bunk][act] || 0) + 1;
            });
        });
        dated[dateKey] = Date.now();
        if (saveToCloud) {
            global.saveGlobalSettings('historicalCounts', counts);
            global.saveGlobalSettings('historicalCountedDates', dated);
        }
        return counts;
    },
    reIncrementHistoricalCounts(dateKey, newScheduleAssignments, saveToCloud = true, oldScheduleAssignments = null) {
        const gs = global.loadGlobalSettings();
        const counts = gs.historicalCounts || {};
        const dated = gs.historicalCountedDates || {};

        if (dated[dateKey]) {
            const allDaily = oldScheduleAssignments ? null : (global.loadAllDailyData?.() || {});
            const oldSched = oldScheduleAssignments || allDaily?.[dateKey]?.scheduleAssignments || {};
            Object.keys(oldSched).forEach(bunk => {
                (oldSched[bunk] || []).forEach(entry => {
                    if (!entry || entry.continuation || entry._isTransition) return;
                    const act = entry._activity || '';
                    if (!act || act.toLowerCase() === 'free') return;
                    if (counts[bunk]?.[act]) {
                        counts[bunk][act] = Math.max(0, counts[bunk][act] - 1);
                    }
                });
            });
            delete dated[dateKey];
            if (saveToCloud) {
                global.saveGlobalSettings('historicalCounts', counts);
                global.saveGlobalSettings('historicalCountedDates', dated);
            }
        }
        return this.incrementHistoricalCounts(dateKey, newScheduleAssignments, saveToCloud);
    }
};

// loadAllDailyData reads from localStorage (what hookGeneration already overwrote)
global.loadAllDailyData = () => {
    try { return JSON.parse(localStorage.getItem('campDailyData_v1') || '{}'); } catch (_) { return {}; }
};

// =====================================================================
// HELPERS
// =====================================================================

function makeEntry(activity) {
    return { _activity: activity, continuation: false, _isTransition: false };
}

function makeSchedule(map) {
    // map: { bunkName: ['ActA', 'ActB', ...] }
    const sched = {};
    Object.entries(map).forEach(([bunk, acts]) => {
        sched[bunk] = acts.map(makeEntry);
    });
    return sched;
}

function resetAll() {
    localStorage.clear();
    fakeGlobalSettings = {};
    fakeRotationHistory = { bunks: {}, leagues: {} };
    forceSyncCalls = 0;
    global.scheduleAssignments = {};
    global.isRainyDay = false;
    global.rainyDayStartTime = null;
    global.leagueAssignments = {};
    global.unifiedTimes = [];
    global.divisionTimes = {};
}

// Simulate what hookGeneration does when campistry-generation-complete fires
function simulateHookGeneration(dateKey) {
    // 1. Capture old schedule snapshot (the fix)
    let oldScheduleSnapshot = null;
    try {
        const preSave = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
        oldScheduleSnapshot = preSave[dateKey]?.scheduleAssignments || null;
    } catch (_) {}

    // 2. Overwrite localStorage with new schedule
    const DAILY_KEY = 'campDailyData_v1';
    const allData = JSON.parse(localStorage.getItem(DAILY_KEY) || '{}');
    const existing = allData[dateKey] || {};
    Object.assign(existing, {
        scheduleAssignments: global.scheduleAssignments || {},
        _savedAt: Date.now()
    });
    allData[dateKey] = existing;
    localStorage.setItem(DAILY_KEY, JSON.stringify(allData));

    // 3. Update rotation history for all bunks
    const newSched = global.scheduleAssignments || {};
    const history = global.loadRotationHistory?.() || { bunks: {}, leagues: {} };
    history.bunks = history.bunks || {};
    const timestamp = Date.now();
    const SKIP = new Set(['free', 'free play', 'free (timeout)', 'transition/buffer', 'regroup', 'lineup', 'bus', 'buffer']);
    Object.keys(newSched).forEach(bunk => {
        history.bunks[bunk] = history.bunks[bunk] || {};
        (newSched[bunk] || []).forEach(entry => {
            if (!entry || entry.continuation || entry._isTransition) return;
            const actName = entry._activity || '';
            if (!actName || SKIP.has(actName.toLowerCase())) return;
            history.bunks[bunk][actName] = timestamp;
        });
    });
    global.saveRotationHistory?.(history);

    // 4. Rebuild counts with old snapshot
    if (global.SchedulerCoreUtils?.reIncrementHistoricalCounts) {
        global.SchedulerCoreUtils.reIncrementHistoricalCounts(
            dateKey,
            global.scheduleAssignments || {},
            true,
            oldScheduleSnapshot
        );
    }
}

// =====================================================================
// TESTS
// =====================================================================

describe('auto-gen historicalCounts', () => {

    it('first generation: counts incremented from zero', () => {
        resetAll();
        global.scheduleAssignments = makeSchedule({ 'Bunk 1': ['Basketball', 'Soccer'] });

        simulateHookGeneration('2026-07-15');

        const counts = fakeGlobalSettings.historicalCounts;
        assert.equal(counts['Bunk 1']['Basketball'], 1);
        assert.equal(counts['Bunk 1']['Soccer'], 1);

        const dated = fakeGlobalSettings.historicalCountedDates;
        assert.ok(dated['2026-07-15'], 'date should be marked as counted');
    });

    it('re-generation same day: old counts subtracted, new counts added', () => {
        resetAll();

        // --- First generation (day 1 already in localStorage) ---
        // Simulate that day was already counted with Basketball
        const oldSched = makeSchedule({ 'Bunk 1': ['Basketball'] });
        localStorage.setItem('campDailyData_v1', JSON.stringify({
            '2026-07-15': { scheduleAssignments: oldSched }
        }));
        fakeGlobalSettings.historicalCounts = { 'Bunk 1': { Basketball: 3, Soccer: 1 } };
        fakeGlobalSettings.historicalCountedDates = { '2026-07-15': Date.now() };

        // --- Re-generation: Bunk 1 now has Soccer instead of Basketball ---
        global.scheduleAssignments = makeSchedule({ 'Bunk 1': ['Soccer'] });

        simulateHookGeneration('2026-07-15');

        const counts = fakeGlobalSettings.historicalCounts;
        assert.equal(counts['Bunk 1']['Basketball'], 2, 'Basketball should be decremented (was 3, -1)');
        assert.equal(counts['Bunk 1']['Soccer'], 2, 'Soccer should be incremented (was 1, +1)');
    });

    it('re-generation: counts not double-incremented when old = new activity', () => {
        resetAll();

        const oldSched = makeSchedule({ 'Bunk 1': ['Basketball'] });
        localStorage.setItem('campDailyData_v1', JSON.stringify({
            '2026-07-15': { scheduleAssignments: oldSched }
        }));
        fakeGlobalSettings.historicalCounts = { 'Bunk 1': { Basketball: 5 } };
        fakeGlobalSettings.historicalCountedDates = { '2026-07-15': Date.now() };

        // Re-generate with same activity
        global.scheduleAssignments = makeSchedule({ 'Bunk 1': ['Basketball'] });
        simulateHookGeneration('2026-07-15');

        const counts = fakeGlobalSettings.historicalCounts;
        // subtract 1 (old Basketball), add 1 (new Basketball) → still 5
        assert.equal(counts['Bunk 1']['Basketball'], 5, 'Net change should be zero when activity unchanged');
    });

    it('multiple bunks: all bunks updated independently', () => {
        resetAll();
        global.scheduleAssignments = makeSchedule({
            'Bunk 1': ['Basketball', 'Soccer'],
            'Bunk 2': ['Swimming', 'Art'],
            'Bunk 3': ['Tennis']
        });

        simulateHookGeneration('2026-07-15');

        const counts = fakeGlobalSettings.historicalCounts;
        assert.equal(counts['Bunk 1']['Basketball'], 1);
        assert.equal(counts['Bunk 1']['Soccer'], 1);
        assert.equal(counts['Bunk 2']['Swimming'], 1);
        assert.equal(counts['Bunk 2']['Art'], 1);
        assert.equal(counts['Bunk 3']['Tennis'], 1);
    });

    it('"free" activity not counted', () => {
        resetAll();
        global.scheduleAssignments = makeSchedule({
            'Bunk 1': ['free', 'Basketball', 'Soccer']
        });

        simulateHookGeneration('2026-07-15');

        const counts = fakeGlobalSettings.historicalCounts;
        assert.equal(counts['Bunk 1']['Basketball'], 1);
        assert.equal(counts['Bunk 1']['Soccer'], 1);
        assert.equal(counts['Bunk 1']['free'], undefined, 'free should not be counted');
    });

});

describe('auto-gen rotationHistory', () => {

    it('rotation history timestamps set for all bunks after generation', () => {
        resetAll();
        global.scheduleAssignments = makeSchedule({
            'Bunk 1': ['Basketball', 'Soccer'],
            'Bunk 2': ['Swimming']
        });

        const before = Date.now();
        simulateHookGeneration('2026-07-15');
        const after = Date.now();

        const hist = fakeRotationHistory.bunks;
        assert.ok(hist['Bunk 1']['Basketball'] >= before && hist['Bunk 1']['Basketball'] <= after);
        assert.ok(hist['Bunk 1']['Soccer'] >= before);
        assert.ok(hist['Bunk 2']['Swimming'] >= before);
    });

    it('rotation history overwrites stale timestamps for re-generated activities', () => {
        resetAll();
        const staleTs = Date.now() - 5 * 24 * 60 * 60 * 1000; // 5 days ago
        fakeRotationHistory = { bunks: { 'Bunk 1': { Basketball: staleTs } }, leagues: {} };

        global.scheduleAssignments = makeSchedule({ 'Bunk 1': ['Basketball'] });

        simulateHookGeneration('2026-07-15');

        const ts = fakeRotationHistory.bunks['Bunk 1']['Basketball'];
        assert.ok(ts > staleTs, 'timestamp should be refreshed to now');
    });

    it('free activities not added to rotation history', () => {
        resetAll();
        global.scheduleAssignments = makeSchedule({
            'Bunk 1': ['free', 'Basketball', 'free play']
        });

        simulateHookGeneration('2026-07-15');

        const hist = fakeRotationHistory.bunks['Bunk 1'];
        assert.ok(hist['Basketball'], 'Basketball should be in history');
        assert.equal(hist['free'], undefined, 'free should not be in history');
        assert.equal(hist['free play'], undefined);
    });

});
