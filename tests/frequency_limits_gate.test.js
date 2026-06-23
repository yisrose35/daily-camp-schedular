/**
 * Tests for: scheduler_core_utils.js SchedulerCoreUtils.checkFrequencyLimits —
 *            the single shared HARD gate for the ceiling + cooldown frequency
 *            constraints (maxUsage, exactFrequency ceiling, frequencyDays).
 *
 * Run with:  node --test tests/frequency_limits_gate.test.js
 *
 * Why this exists: max / exact / cooldown are user-set promises that must hold
 * across the ENTIRE build (auto + manual + edits + auto-fill). They used to be
 * enforced only in scattered scoring/pre-filter code; the write trust points
 * (commitWriteIfLegal / commitManualWriteIfLegal) and the auto-fill candidate
 * builders now all route through this helper, so its semantics are the contract.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeCtx() {
    const win = {};
    const doc = { addEventListener() {} };
    const sandbox = {
        window: win,
        document: doc,
        console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
        setTimeout, clearTimeout,
        Date, Math, Object, Array, JSON, String, Number, Boolean,
        Map, Set, Promise, parseInt, parseFloat, isNaN, isFinite,
        Infinity, NaN, Symbol
    };
    win.addEventListener = () => {};
    sandbox.global = sandbox;
    vm.createContext(sandbox);
    return sandbox;
}

function setup() {
    const sb = makeCtx();
    // Minimal globals checkFrequencyLimits + getPeriodActivityCount need.
    sb.window.currentScheduleDate = '2026-06-22';
    sb.window.scheduleAssignments = {};
    sb.window.activityProperties = {};
    sb.window.loadAllDailyData = () => ({});          // no prior-day history
    sb.window.loadGlobalSettings = () => ({});        // → getCampDates() = null
    sb.window.RotationEngine = { getDaysSinceActivity: () => null };

    const src = fs.readFileSync(path.join(__dirname, '..', 'scheduler_core_utils.js'), 'utf8');
    vm.runInContext(src, sb, { filename: 'scheduler_core_utils.js' });
    return sb;
}

// helper: place N non-continuation instances of `act` in a bunk's grid
function place(sb, bunk, act, n) {
    const arr = [];
    for (let i = 0; i < n; i++) arr.push({ _activity: act, continuation: false });
    sb.window.scheduleAssignments[bunk] = arr;
}

describe('checkFrequencyLimits — exposure + no-op cases', () => {
    it('is exposed on SchedulerCoreUtils', () => {
        const sb = setup();
        assert.equal(typeof sb.window.SchedulerCoreUtils.checkFrequencyLimits, 'function');
    });

    it('allows Free / empty / unknown activities', () => {
        const sb = setup();
        const f = sb.window.SchedulerCoreUtils.checkFrequencyLimits;
        assert.equal(f('B1', 'Free', 'G1').ok, true);
        assert.equal(f('B1', '', 'G1').ok, true);
        assert.equal(f('B1', 'NoSuchActivity', 'G1').ok, true);
    });
});

describe('checkFrequencyLimits — maxUsage ceiling', () => {
    let sb, f;
    beforeEach(() => {
        sb = setup();
        sb.window.activityProperties = { Pottery: { maxUsage: 2, maxUsagePeriod: 'half' } };
        f = sb.window.SchedulerCoreUtils.checkFrequencyLimits;
    });

    it('allows when below the cap', () => {
        place(sb, 'B1', 'Pottery', 1);
        assert.equal(f('B1', 'Pottery', 'G1').ok, true);
    });

    it('blocks when at the cap (counts same-day placements)', () => {
        place(sb, 'B1', 'Pottery', 2);
        const r = f('B1', 'Pottery', 'G1');
        assert.equal(r.ok, false);
        assert.equal(r.kind, 'max');
    });

    it('excludeSlots drops the slot being rewritten from the tally', () => {
        place(sb, 'B1', 'Pottery', 1); // one at slot 0
        // Rewriting slot 0 itself: it must not count against the cap of... raise cap to 1
        sb.window.activityProperties.Pottery.maxUsage = 1;
        assert.equal(f('B1', 'Pottery', 'G1').ok, false);              // blocked without exclude
        assert.equal(f('B1', 'Pottery', 'G1', { excludeSlots: [0] }).ok, true); // allowed when excluding self
    });

    it('per-grade override beats the global cap', () => {
        sb.window.activityProperties = { Pottery: { maxUsage: 5, maxUsagePerGrade: { G1: 1 }, maxUsagePeriod: 'half' } };
        place(sb, 'B1', 'Pottery', 1);
        assert.equal(f('B1', 'Pottery', 'G1').ok, false); // grade cap of 1 reached
        assert.equal(f('B1', 'Pottery', 'G2').ok, true);  // other grade uses global 5
    });
});

describe('checkFrequencyLimits — exactFrequency ceiling', () => {
    it('blocks once the exact target is reached', () => {
        const sb = setup();
        sb.window.activityProperties = { Swim: { exactFrequency: 1, exactFrequencyPeriod: '1week' } };
        const f = sb.window.SchedulerCoreUtils.checkFrequencyLimits;
        assert.equal(f('B1', 'Swim', 'G1').ok, true);
        place(sb, 'B1', 'Swim', 1);
        const r = f('B1', 'Swim', 'G1');
        assert.equal(r.ok, false);
        assert.equal(r.kind, 'exact');
    });
});

describe('checkFrequencyLimits — frequencyDays cooldown', () => {
    let sb, f;
    beforeEach(() => {
        sb = setup();
        sb.window.activityProperties = { TripDay: { frequencyDays: 3 } };
        f = sb.window.SchedulerCoreUtils.checkFrequencyLimits;
    });

    it('blocks within the cooldown window', () => {
        sb.window.RotationEngine.getDaysSinceActivity = () => 2; // only 2 days ago, need 3
        const r = f('B1', 'TripDay', 'G1');
        assert.equal(r.ok, false);
        assert.equal(r.kind, 'cooldown');
    });

    it('allows once the cooldown has elapsed', () => {
        sb.window.RotationEngine.getDaysSinceActivity = () => 3;
        assert.equal(f('B1', 'TripDay', 'G1').ok, true);
    });

    it('allows when never done (null)', () => {
        sb.window.RotationEngine.getDaysSinceActivity = () => null;
        assert.equal(f('B1', 'TripDay', 'G1').ok, true);
    });

    it('does not treat same-day (0) as a cooldown violation', () => {
        sb.window.RotationEngine.getDaysSinceActivity = () => 0;
        assert.equal(f('B1', 'TripDay', 'G1').ok, true);
    });
});

describe('enforceFrequencyLimitsSweep — final backstop', () => {
    function withGrid(sb, bunk, grade, entries) {
        sb.window.divisions = { [grade]: { bunks: [bunk] } };
        sb.window.scheduleAssignments = { [bunk]: entries };
    }

    it('frees the EXCESS over a max cap, keeping the first N', () => {
        const sb = setup();
        sb.window.activityProperties = { Pottery: { maxUsage: 2, maxUsagePeriod: 'half' } };
        withGrid(sb, 'B1', 'G1', [
            { _activity: 'Pottery', continuation: false },
            { _activity: 'Pottery', continuation: false },
            { _activity: 'Pottery', continuation: false }, // 3rd — excess
        ]);
        const r = sb.window.SchedulerCoreUtils.enforceFrequencyLimitsSweep({ date: '2026-06-22' });
        assert.equal(r.count, 1);
        const arr = sb.window.scheduleAssignments.B1;
        assert.equal(arr[0]._activity, 'Pottery'); // kept
        assert.equal(arr[1]._activity, 'Pottery'); // kept
        assert.equal(arr[2]._activity, 'Free');     // demoted
        assert.equal(arr[2]._constraintDemoted, true);
    });

    it('clears trailing continuation slots of a demoted multi-period block', () => {
        const sb = setup();
        sb.window.activityProperties = { Swim: { maxUsage: 1, maxUsagePeriod: 'half' } };
        withGrid(sb, 'B1', 'G1', [
            { _activity: 'Swim', continuation: false },
            { _activity: 'Swim', continuation: false }, // 2nd lead — excess
            { _activity: 'Swim', continuation: true },  // its continuation
        ]);
        const r = sb.window.SchedulerCoreUtils.enforceFrequencyLimitsSweep({ date: '2026-06-22' });
        assert.equal(r.count, 1);
        const arr = sb.window.scheduleAssignments.B1;
        assert.equal(arr[0]._activity, 'Swim');
        assert.equal(arr[1]._activity, 'Free');
        assert.equal(arr[2]._activity, 'Free'); // continuation cleared
    });

    it('never demotes protected entries (pins, league, trips, overrides, post-edit)', () => {
        const sb = setup();
        sb.window.activityProperties = { Pottery: { maxUsage: 1, maxUsagePeriod: 'half' } };
        withGrid(sb, 'B1', 'G1', [
            { _activity: 'Pottery', continuation: false },                 // 1st kept
            { _activity: 'Pottery', continuation: false, _pinned: true },  // protected
            { _activity: 'Pottery', continuation: false, _postEdit: true },// protected
        ]);
        const r = sb.window.SchedulerCoreUtils.enforceFrequencyLimitsSweep({ date: '2026-06-22' });
        assert.equal(r.count, 0);
        assert.equal(sb.window.scheduleAssignments.B1[1]._activity, 'Pottery');
        assert.equal(sb.window.scheduleAssignments.B1[2]._activity, 'Pottery');
    });

    it('leaves activities WITHOUT a configured limit untouched', () => {
        const sb = setup();
        sb.window.activityProperties = { Basketball: {} };
        withGrid(sb, 'B1', 'G1', [
            { _activity: 'Basketball', continuation: false },
            { _activity: 'Basketball', continuation: false },
            { _activity: 'Basketball', continuation: false },
        ]);
        const r = sb.window.SchedulerCoreUtils.enforceFrequencyLimitsSweep({ date: '2026-06-22' });
        assert.equal(r.count, 0);
    });

    it('frees ALL today occurrences when a prior saved day is within cooldown', () => {
        const sb = setup();
        sb.window.activityProperties = { TripDay: { frequencyDays: 3 } };
        // Prior saved day 1 day before → within the 3-day cooldown.
        sb.window.loadAllDailyData = () => ({
            '2026-06-21': { scheduleAssignments: { B1: [{ _activity: 'TripDay', continuation: false }] } }
        });
        withGrid(sb, 'B1', 'G1', [
            { _activity: 'TripDay', continuation: false },
            { _activity: 'TripDay', continuation: false },
        ]);
        const r = sb.window.SchedulerCoreUtils.enforceFrequencyLimitsSweep({ date: '2026-06-22' });
        assert.equal(r.count, 2); // both freed — can't be here at all today
        assert.equal(sb.window.scheduleAssignments.B1[0]._activity, 'Free');
        assert.equal(sb.window.scheduleAssignments.B1[1]._activity, 'Free');
    });

    it('respects per-grade max override', () => {
        const sb = setup();
        sb.window.activityProperties = { Pottery: { maxUsage: 5, maxUsagePerGrade: { G1: 1 }, maxUsagePeriod: 'half' } };
        withGrid(sb, 'B1', 'G1', [
            { _activity: 'Pottery', continuation: false },
            { _activity: 'Pottery', continuation: false }, // excess for grade cap of 1
        ]);
        const r = sb.window.SchedulerCoreUtils.enforceFrequencyLimitsSweep({ date: '2026-06-22' });
        assert.equal(r.count, 1);
    });
});

describe('enforceFieldCombosSweep — combined-field backstop', () => {
    // Stub FieldCombos so the sweep's combo math is driven deterministically:
    // any entry whose field is in `blockedFields` is reported as a combo clash.
    function withCombos(sb, blockedFields) {
        const set = new Set(blockedFields.map(s => s.toLowerCase()));
        sb.window.FieldCombos = {
            isBlockedByCombo: (field, s, e, exclude) =>
                set.has(String(field).toLowerCase())
                    ? { blocked: true, blocker: 'partner', blockerBunk: 'X' }
                    : { blocked: false }
        };
    }

    it('demotes a combined-field double-booking and clears its continuations', () => {
        const sb = setup();
        withCombos(sb, ['Full Gym']);
        sb.window.scheduleAssignments = { B1: [
            { _activity: 'Basketball', field: 'Full Gym', _startMin: 540, _endMin: 600, continuation: false },
            { _activity: 'Basketball', field: 'Full Gym', _startMin: 600, _endMin: 645, continuation: true },
            { _activity: 'Soccer', field: 'Soccer Field', _startMin: 645, _endMin: 690, continuation: false },
        ] };
        const r = sb.window.SchedulerCoreUtils.enforceFieldCombosSweep();
        assert.equal(r.count, 1);
        const arr = sb.window.scheduleAssignments.B1;
        assert.equal(arr[0]._activity, 'Free');     // demoted
        assert.equal(arr[1]._activity, 'Free');     // continuation cleared
        assert.equal(arr[2]._activity, 'Soccer');   // untouched (not a combo field)
    });

    it('never demotes protected entries (pins, league, trips)', () => {
        const sb = setup();
        withCombos(sb, ['Full Gym']);
        sb.window.scheduleAssignments = { B1: [
            { _activity: 'Game', field: 'Full Gym', _startMin: 540, _endMin: 600, continuation: false, _league: true },
            { _activity: 'X', field: 'Full Gym', _startMin: 600, _endMin: 645, continuation: false, _pinned: true },
        ] };
        const r = sb.window.SchedulerCoreUtils.enforceFieldCombosSweep();
        assert.equal(r.count, 0);
    });

    it('skips entries without resolved start/end times', () => {
        const sb = setup();
        withCombos(sb, ['Full Gym']);
        sb.window.scheduleAssignments = { B1: [
            { _activity: 'Basketball', field: 'Full Gym', continuation: false }, // no _startMin/_endMin
        ] };
        const r = sb.window.SchedulerCoreUtils.enforceFieldCombosSweep();
        assert.equal(r.count, 0);
    });

    it('is a no-op when FieldCombos is unavailable', () => {
        const sb = setup();
        // no sb.window.FieldCombos
        sb.window.scheduleAssignments = { B1: [
            { _activity: 'Basketball', field: 'Full Gym', _startMin: 540, _endMin: 600, continuation: false },
        ] };
        const r = sb.window.SchedulerCoreUtils.enforceFieldCombosSweep();
        assert.equal(r.count, 0);
        assert.equal(sb.window.scheduleAssignments.B1[0]._activity, 'Basketball');
    });
});
