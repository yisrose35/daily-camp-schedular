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
