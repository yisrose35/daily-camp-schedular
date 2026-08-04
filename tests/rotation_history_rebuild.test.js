/**
 * Tests for: rotationHistory ("last done" timestamps) going stale after a
 * partial regen or a tile edit.
 *
 * Run with:  node --test tests/rotation_history_rebuild.test.js
 *
 * The bug: every writer of rotationHistory.bunks[bunk][activity] only ever
 * STAMPED what was on the grid — generation STEP 8 (scheduler_core_main.js)
 * and applyPostEditCounts (scheduler_core_utils.js) both merged today's
 * activities in and left everything else alone. Nothing ever removed the
 * stamp for an activity that was replaced, so:
 *
 *   generate → bunk gets Soccer today → rotationHistory[bunk].Soccer = today
 *   regenerate that tile → bunk now has Basketball
 *   → rotationHistory[bunk].Soccer is STILL today, forever
 *
 * The cumulative counts are re-derived from the final grid and stayed right;
 * only the recency view lied, and it is the view the rotation engine reads for
 * "days since last done" and the one the analytics last-done column shows.
 *
 * The fix: Utils.rebuildRotationHistoryForBunks(bunks) re-derives the scoped
 * bunks' timestamps from the saved daily schedules plus the live grid.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const TODAY = '2026-07-15';
const YESTERDAY = '2026-07-14';
const tsOf = (d) => new Date(d + 'T12:00:00').getTime();

function setup({ allDaily, rotHist, live, date }) {
    const win = {};
    const sandbox = {
        window: win,
        console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
        setTimeout, clearTimeout,
        Date, Math, Object, Array, JSON, String, Number, Boolean,
        Map, Set, Promise, parseInt, parseFloat, isNaN, isFinite,
        Infinity, NaN, Symbol, RegExp, Error
    };
    sandbox.global = sandbox;
    vm.createContext(sandbox);

    const saved = { rotationHistory: rotHist || { bunks: {}, leagues: {} } };
    win.currentScheduleDate = date === undefined ? TODAY : date;
    win.scheduleAssignments = live || {};
    win.loadAllDailyData = () => allDaily || {};
    win.loadRotationHistory = () => JSON.parse(JSON.stringify(saved.rotationHistory));
    win.saveRotationHistory = (h) => { saved.rotationHistory = h; };
    win.loadGlobalSettings = () => ({ app1: {} });
    win.saveGlobalSettings = () => {};

    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'scheduler_core_utils.js'), 'utf8'),
        sandbox, { filename: 'scheduler_core_utils.js' });

    return { win, saved, Utils: win.SchedulerCoreUtils };
}

const slot = (activity, startMin) => ({ _activity: activity, _startMin: startMin });

describe('rebuildRotationHistoryForBunks — stale last-done timestamps', () => {
    it('drops the replaced activity back to the last day it really happened', () => {
        // Bunk 1 did Soccer yesterday. Today it was generated with Soccer, then
        // the tile was regenerated into Basketball — the old writer left
        // Soccer stamped TODAY.
        const { saved, Utils } = setup({
            allDaily: {
                [YESTERDAY]: { scheduleAssignments: { 'Bunk 1': [slot('Soccer', 540)] } },
                [TODAY]: { scheduleAssignments: { 'Bunk 1': [slot('Basketball', 540)] } }
            },
            rotHist: { bunks: { 'Bunk 1': { Soccer: tsOf(TODAY), Basketball: tsOf(TODAY) } }, leagues: {} },
            live: { 'Bunk 1': [slot('Basketball', 540)] }
        });

        Utils.rebuildRotationHistoryForBunks(['Bunk 1']);

        assert.equal(saved.rotationHistory.bunks['Bunk 1'].Soccer, tsOf(YESTERDAY),
            'Soccer falls back to the day it actually happened');
        assert.equal(saved.rotationHistory.bunks['Bunk 1'].Basketball, tsOf(TODAY),
            'Basketball keeps today');
    });

    it('removes an activity that never really happened at all', () => {
        const { saved, Utils } = setup({
            allDaily: { [TODAY]: { scheduleAssignments: { 'Bunk 1': [slot('Basketball', 540)] } } },
            rotHist: { bunks: { 'Bunk 1': { Soccer: tsOf(TODAY) } }, leagues: {} },
            live: { 'Bunk 1': [slot('Basketball', 540)] }
        });

        Utils.rebuildRotationHistoryForBunks(['Bunk 1']);

        assert.equal(saved.rotationHistory.bunks['Bunk 1'].Soccer, undefined,
            'never-happened activity is gone, not stamped today');
        assert.equal(saved.rotationHistory.bunks['Bunk 1'].Basketball, tsOf(TODAY));
    });

    it('trusts the LIVE grid for the current date (post-edit, before the save lands)', () => {
        // allDaily still holds the pre-edit day; the edit is only in memory.
        const { saved, Utils } = setup({
            allDaily: { [TODAY]: { scheduleAssignments: { 'Bunk 1': [slot('Soccer', 540)] } } },
            rotHist: { bunks: { 'Bunk 1': { Soccer: tsOf(TODAY) } }, leagues: {} },
            live: { 'Bunk 1': [slot('Hockey', 540)] }
        });

        Utils.rebuildRotationHistoryForBunks(['Bunk 1']);

        assert.equal(saved.rotationHistory.bunks['Bunk 1'].Hockey, tsOf(TODAY),
            'the in-memory edit is recorded');
        assert.equal(saved.rotationHistory.bunks['Bunk 1'].Soccer, tsOf(TODAY),
            'the stale saved copy of the same date still contributes until it is overwritten');
    });

    it('leaves bunks outside the scope untouched', () => {
        const { saved, Utils } = setup({
            allDaily: { [TODAY]: { scheduleAssignments: { 'Bunk 1': [slot('Basketball', 540)] } } },
            rotHist: {
                bunks: {
                    'Bunk 1': { Soccer: tsOf(TODAY) },
                    'Bunk 9': { Soccer: tsOf(TODAY) }   // another scheduler's bunk
                }, leagues: {}
            },
            live: { 'Bunk 1': [slot('Basketball', 540)] }
        });

        Utils.rebuildRotationHistoryForBunks(['Bunk 1']);

        assert.equal(saved.rotationHistory.bunks['Bunk 9'].Soccer, tsOf(TODAY),
            'out-of-scope bunk is never rewritten');
    });

    it('never truncates a bunk the local daily cache cannot see (CB-72)', () => {
        // A scheduler's local cache holds none of this bunk's days. Scanning to
        // nothing must NOT be read as "the bunk did nothing".
        const { saved, Utils } = setup({
            allDaily: { [TODAY]: { scheduleAssignments: {} } },
            rotHist: { bunks: { 'Bunk 7': { Soccer: tsOf(YESTERDAY) } }, leagues: {} },
            live: {}
        });

        Utils.rebuildRotationHistoryForBunks(['Bunk 7']);

        assert.equal(saved.rotationHistory.bunks['Bunk 7'].Soccer, tsOf(YESTERDAY),
            'invisible bunk keeps its existing history');
    });

    it('skips Free / continuation / transition slots', () => {
        const { saved, Utils } = setup({
            allDaily: {
                [TODAY]: {
                    scheduleAssignments: {
                        'Bunk 1': [
                            slot('Basketball', 540),
                            Object.assign(slot('Basketball', 540), { continuation: true }),
                            slot('Free', 600),
                            Object.assign(slot('Travel', 630), { _isTransition: true })
                        ]
                    }
                }
            },
            rotHist: { bunks: {}, leagues: {} },
            live: {}
        });

        Utils.rebuildRotationHistoryForBunks(['Bunk 1']);

        assert.deepEqual(Object.keys(saved.rotationHistory.bunks['Bunk 1']), ['Basketball']);
    });
});

describe('survivingLeagueLabels', () => {
    it('buckets regular vs specialty games by league name', () => {
        const { Utils } = setup({ allDaily: {}, rotHist: { bunks: {} }, live: {} });
        const out = Utils.survivingLeagueLabels({
            A: {
                1: { leagueName: 'Camp League', gameLabel: 'Game 1' },
                2: { leagueName: 'ABBL', gameLabel: 'Game 1', isSpecialtyLeague: true }
            },
            B: {
                1: { leagueName: 'Camp League', gameLabel: 'Game 2' },
                2: { leagueName: 'Camp League' },       // no label → not a survivor
                3: { gameLabel: 'Game 3' }              // no league → ignored
            }
        });
        assert.deepEqual([...out.regular['Camp League']].sort(), ['Game 1', 'Game 2']);
        assert.deepEqual([...out.specialty['ABBL']], ['Game 1']);
        assert.equal(out.regular['ABBL'], undefined);
    });
});
