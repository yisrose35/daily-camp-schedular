/**
 * Tests for "Field Preferences" (Rules tab) in the MANUAL builder.
 *
 * The manual path is different enough from auto to need its own coverage:
 *   1. total_solver_engine.calculatePenaltyCost is the manual scorer — the real
 *      function is called here (not stubbed) so the preference term is proven to
 *      be wired into the cost the solver actually minimizes.
 *   2. Manual entries do NOT all carry _startMin/_endMin — block-A entries keep
 *      their geometry in _perBunkSlots / divisionTimes by slot index. The Phase P
 *      preference pull must resolve times the same way or it is blind in manual.
 *   3. window.fieldUsageBySlot is the manual builder's live per-slot capacity
 *      ledger; a moved block has to be re-pointed there.
 *
 * Run with: node --test tests/field_preferences_manual.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.join(__dirname, '..');

function bootSandbox(files) {
    const sandbox = {
        console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
        setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
        Date, Math, Object, Array, JSON, String, Number, Boolean, RegExp, Error,
        Map, Set, WeakMap, WeakSet, Promise, parseInt, parseFloat, isNaN, isFinite,
        Infinity, NaN, Symbol, encodeURIComponent, decodeURIComponent,
    };
    sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox; sandbox.global = sandbox;
    const makeEl = () => ({ appendChild() {}, addEventListener() {}, setAttribute() {}, style: {}, children: [], dataset: {} });
    sandbox.document = {
        readyState: 'complete', createElement: makeEl, createDocumentFragment: makeEl,
        getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; },
        addEventListener() {}, removeEventListener() {}, body: makeEl(), head: makeEl(),
    };
    sandbox.localStorage = (() => { let s = {}; return { getItem() { return null; }, setItem() {}, removeItem() {}, clear() {} }; })();
    sandbox.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
    sandbox.dispatchEvent = () => true; sandbox.addEventListener = () => {}; sandbox.removeEventListener = () => {};
    sandbox.requestAnimationFrame = () => 0; sandbox.cancelAnimationFrame = () => {};
    sandbox.location = { href: '', reload() {}, search: '' };
    sandbox.navigator = { onLine: true, userAgent: 'node' };
    sandbox.AccessControl = null;
    sandbox.currentScheduleDate = '2026-07-15';
    sandbox.loadCurrentDailyData = () => ({});
    sandbox.loadAllDailyData = () => ({});
    sandbox.getLocationForActivity = () => null;
    sandbox.scheduleAssignments = {};
    vm.createContext(sandbox);
    files.forEach(f => {
        vm.runInContext(fs.readFileSync(path.join(REPO, f), 'utf8'), sandbox, { filename: f });
    });
    return sandbox;
}

// 1st Grade → Court 1, 2nd Grade → Court 2. Both courts host Basketball and are
// open to both grades: the rule only ranks them.
const RULES = {
    fieldPreferences: [
        { id: 'fp_1', grade: '1st Grade', activity: '', fields: ['Court 1', 'Court 2'] },
        { id: 'fp_2', grade: '2nd Grade', activity: '', fields: ['Court 2', 'Court 1'] }
    ]
};
const COURTS = [
    { name: 'Court 1', activities: ['Basketball'], sharableWith: { type: 'not_sharable', capacity: 1 } },
    { name: 'Court 2', activities: ['Basketball'], sharableWith: { type: 'not_sharable', capacity: 1 } }
];
const DIVISIONS = { '1st Grade': { bunks: ['Bunk 1A'] }, '2nd Grade': { bunks: ['Bunk 2A'] } };

// The manual scorer's step (total_solver_engine.js) — top choice is -2 steps and
// the runner-up +1 step, so two host fields differ by 3 steps. The scorer also
// adds a random tie-breaker (Math.random() * TIE_BREAKER_RANDOMNESS, 300), so the
// observed gap is EXPECTED_GAP ± JITTER — and the whole point is that the
// preference term is an order of magnitude larger than that jitter, i.e. it
// decides between two otherwise-identical courts every single time.
const MANUAL_STEP = 2500;
const EXPECTED_GAP = 3 * MANUAL_STEP;
const JITTER = 300;

describe('manual scorer (total_solver calculatePenaltyCost) honors field preferences', () => {
    function bootManual() {
        const win = bootSandbox(['scheduler_core_utils.js', 'total_solver_engine.js']);
        win.loadGlobalSettings = () => ({ app1: { fields: COURTS }, schedulingRules: RULES });
        win.globalSettings = { app1: { fields: COURTS }, schedulingRules: RULES };
        win.SchedulerCoreUtils.invalidateFieldPreferenceCache();
        win.divisions = DIVISIONS;
        win.divisionTimes = { '1st Grade': [{ startMin: 600, endMin: 660 }], '2nd Grade': [{ startMin: 600, endMin: 660 }] };
        win.scheduleAssignments = { 'Bunk 1A': [null], 'Bunk 2A': [null] };
        win.activityProperties = {
            'Court 1': { available: true, activities: ['Basketball'], sharableWith: { type: 'not_sharable', capacity: 1 } },
            'Court 2': { available: true, activities: ['Basketball'], sharableWith: { type: 'not_sharable', capacity: 1 } }
        };
        win.fieldUsageBySlot = {};
        return win;
    }
    const pickOn = (field) => ({ field: field, sport: 'Basketball', _activity: 'Basketball', _type: 'sport' });
    const blockFor = (bunk, div) => ({ bunk: bunk, divName: div, startTime: 600, endTime: 660, slots: [0] });

    it('costs the grade\'s first-choice court less than the runner-up', () => {
        const win = bootManual();
        const S = win._SolverInternals;
        const blk = blockFor('Bunk 1A', '1st Grade');
        const c1 = S.calculatePenaltyCost(blk, pickOn('Court 1'));
        const c2 = S.calculatePenaltyCost(blk, pickOn('Court 2'));
        assert.ok(Number.isFinite(c1) && Number.isFinite(c2), 'both candidates stay feasible: ' + c1 + ' / ' + c2);
        assert.ok(c1 < c2, '1st Grade should prefer Court 1 (' + c1 + ' vs ' + c2 + ')');
        assert.ok(Math.abs((c2 - c1) - EXPECTED_GAP) < JITTER,
            'gap is the preference term (' + (c2 - c1) + ' ≈ ' + EXPECTED_GAP + ')');
        assert.ok(EXPECTED_GAP > JITTER * 4, 'preference outweighs the tie-breaker jitter');
    });

    it('mirrors for the other grade — Court 2 costs less for 2nd Grade', () => {
        const win = bootManual();
        const S = win._SolverInternals;
        const blk = blockFor('Bunk 2A', '2nd Grade');
        const c1 = S.calculatePenaltyCost(blk, pickOn('Court 1'));
        const c2 = S.calculatePenaltyCost(blk, pickOn('Court 2'));
        assert.ok(c2 < c1, '2nd Grade should prefer Court 2 (' + c2 + ' vs ' + c1 + ')');
        assert.ok(Math.abs((c1 - c2) - EXPECTED_GAP) < JITTER, 'gap is the preference term');
    });

    it('is a bias, not a veto — the runner-up stays feasible for the solver', () => {
        const win = bootManual();
        const S = win._SolverInternals;
        const blk = blockFor('Bunk 1A', '1st Grade');
        // The solver treats >= 900000 as infeasible; a preference must never reach it.
        assert.ok(S.calculatePenaltyCost(blk, pickOn('Court 2')) < 900000);
    });

    it('no preference configured → the two courts cost the same (jitter only)', () => {
        const win = bootManual();
        win.loadGlobalSettings = () => ({ app1: { fields: COURTS }, schedulingRules: {} });
        win.SchedulerCoreUtils.invalidateFieldPreferenceCache();
        const S = win._SolverInternals;
        const blk = blockFor('Bunk 1A', '1st Grade');
        const gap = Math.abs(S.calculatePenaltyCost(blk, pickOn('Court 1'))
                           - S.calculatePenaltyCost(blk, pickOn('Court 2')));
        assert.ok(gap <= JITTER, 'no preference term applied (gap ' + gap + ')');
    });
});

describe('manual Phase P: preference pull with manual entry geometry', () => {
    function bootPull(extra) {
        const win = bootSandbox(['scheduler_core_utils.js', 'field_quality_reopt.js']);
        win.loadGlobalSettings = () => ({ app1: { fields: COURTS }, schedulingRules: RULES });
        win.SchedulerCoreUtils.invalidateFieldPreferenceCache();
        win.divisions = DIVISIONS;
        Object.assign(win, extra || {});
        return win;
    }
    // A manual "block A" entry: no _startMin/_endMin at all.
    const bare = (field, extra) => Object.assign({
        field: field, sport: 'Basketball', _activity: 'Basketball', continuation: false
    }, extra || {});

    it('resolves times from divisionTimes when the entry carries no stamp', () => {
        const win = bootPull({
            divisionTimes: { '1st Grade': [{ startMin: 600, endMin: 660 }] },
            scheduleAssignments: { 'Bunk 1A': [bare('Court 2')] }
        });
        assert.strictEqual(win.FieldQualityReopt.pullToPreferred({}), 1);
        assert.strictEqual(win.scheduleAssignments['Bunk 1A'][0].field, 'Court 1');
    });

    it('resolves times from _perBunkSlots when the entry carries no stamp', () => {
        const win = bootPull({
            _perBunkSlots: { '1st Grade': { 'Bunk 1A': [{ startMin: 600, endMin: 660 }] } },
            divisionTimes: {},
            scheduleAssignments: { 'Bunk 1A': [bare('Court 2')] }
        });
        assert.strictEqual(win.FieldQualityReopt.pullToPreferred({}), 1);
        assert.strictEqual(win.scheduleAssignments['Bunk 1A'][0].field, 'Court 1');
    });

    it('sees an unstamped block as occupancy instead of stealing its field', () => {
        // 2nd Grade sits on Court 1 with NO time stamp. Resolved via divisionTimes,
        // it must register as occupancy so 1st Grade does not double-book the court.
        const win = bootPull({
            divisionTimes: {
                '1st Grade': [{ startMin: 600, endMin: 660 }],
                '2nd Grade': [{ startMin: 600, endMin: 660 }]
            },
            scheduleAssignments: {
                'Bunk 1A': [bare('Court 2')],
                'Bunk 2A': [bare('Court 1')]
            }
        });
        assert.strictEqual(win.FieldQualityReopt.pullToPreferred({}), 0);
        assert.strictEqual(win.scheduleAssignments['Bunk 1A'][0].field, 'Court 2');
        assert.strictEqual(win.scheduleAssignments['Bunk 2A'][0].field, 'Court 1');
    });

    it('never targets a field whose occupancy cannot be resolved at all', () => {
        // No divisionTimes / _perBunkSlots for 2nd Grade and no stamp on its entry →
        // Court 1's busy window is unknowable, so Court 1 is barred as a target.
        const win = bootPull({
            divisionTimes: { '1st Grade': [{ startMin: 600, endMin: 660 }] },
            scheduleAssignments: {
                'Bunk 1A': [bare('Court 2')],
                'Bunk 2A': [bare('Court 1')]
            }
        });
        assert.strictEqual(win.FieldQualityReopt.pullToPreferred({}), 0);
        assert.strictEqual(win.scheduleAssignments['Bunk 1A'][0].field, 'Court 2');
    });

    it('re-points fieldUsageBySlot (the manual capacity ledger) on a move', () => {
        const win = bootPull({
            divisionTimes: { '1st Grade': [{ startMin: 600, endMin: 660 }] },
            scheduleAssignments: { 'Bunk 1A': [bare('Court 2')] },
            fieldUsageBySlot: { 0: { 'Court 2': { count: 1, bunks: { 'Bunk 1A': 'Basketball' } } } }
        });
        assert.strictEqual(win.FieldQualityReopt.pullToPreferred({}), 1);
        const usage = win.fieldUsageBySlot[0];
        assert.strictEqual(usage['Court 2'].count, 0, 'old field released');
        assert.ok(!usage['Court 2'].bunks['Bunk 1A'], 'old field no longer lists the bunk');
        assert.strictEqual(usage['Court 1'].count, 1, 'new field charged');
        assert.strictEqual(usage['Court 1'].bunks['Bunk 1A'], 'Basketball');
    });

    it('re-points the ledger for a spanned block\'s continuation slots too', () => {
        const win = bootPull({
            divisionTimes: { '1st Grade': [{ startMin: 600, endMin: 660 }, { startMin: 660, endMin: 720 }] },
            scheduleAssignments: { 'Bunk 1A': [bare('Court 2'), bare('Court 2', { continuation: true })] },
            fieldUsageBySlot: {
                0: { 'Court 2': { count: 1, bunks: { 'Bunk 1A': 'Basketball' } } },
                1: { 'Court 2': { count: 1, bunks: { 'Bunk 1A': 'Basketball' } } }
            }
        });
        assert.strictEqual(win.FieldQualityReopt.pullToPreferred({}), 1);
        assert.strictEqual(win.scheduleAssignments['Bunk 1A'][1].field, 'Court 1', 'continuation follows the lead');
        assert.strictEqual(win.fieldUsageBySlot[1]['Court 1'].count, 1);
        assert.strictEqual(win.fieldUsageBySlot[1]['Court 2'].count, 0);
    });
});
