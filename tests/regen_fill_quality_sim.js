'use strict';
// Simulation test for PARTIAL-REGEN FILL QUALITY (index-collision fixes).
//
// Loads the REAL scheduler_core_utils.js and proves canBlockFit's two
// regen-gated fixes:
//
//   A. TIME-AWARE CAPACITY: slot indices are per-division. During a partial
//      regen the full preserved schedule of every other division sits in
//      scheduleAssignments at raw indices, so a bunk whose entry at index N
//      is at a DIFFERENT wall-clock time must NOT count toward capacity for
//      a query at index N. Real time-overlaps must still count.
//
//   B. INDEX-LOCK TIME CHECK: a plain-index global lock carrying explicit
//      startMin/endMin that does NOT overlap the query block's window is an
//      index collision (e.g. ABBL pin @890-970 vs an 805-870 query) and must
//      be ignored during regen; overlapping locks must still block.
//
// Both fixes are gated on window.__regenSlotScope — WITHOUT it, legacy
// behavior is byte-identical (proven here too).

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function bootUtils() {
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
    sandbox.localStorage = (() => { let s = {}; return { getItem(k) { return Object.prototype.hasOwnProperty.call(s, k) ? s[k] : null; }, setItem(k, v) { s[k] = String(v); }, removeItem(k) { delete s[k]; }, clear() { s = {}; } }; })();
    sandbox.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
    sandbox.dispatchEvent = () => true; sandbox.addEventListener = () => {}; sandbox.removeEventListener = () => {};
    sandbox.requestAnimationFrame = () => 0; sandbox.cancelAnimationFrame = () => {};
    sandbox.location = { href: '', reload() {}, search: '' };
    sandbox.navigator = { onLine: true, userAgent: 'node' };
    sandbox.AccessControl = null;
    sandbox.currentScheduleDate = '2026-07-06';
    sandbox.loadCurrentDailyData = () => ({});
    sandbox.loadGlobalSettings = () => ({});
    sandbox.getLocationForActivity = () => null;

    const code = fs.readFileSync(path.join(__dirname, '..', 'scheduler_core_utils.js'), 'utf8');
    vm.runInNewContext(code, sandbox, { filename: 'scheduler_core_utils.js' });
    return sandbox;
}

// Camp shape mirroring the live bug:
//   • Div "לב" (bunk L1): slot0=740-805, slot1=805-870
//   • Div "Div9" (bunks D9a/D9b): slot0=800-890, slot1=890-970
// D9a's slot-1 entry (890-970) shares INDEX 1 with לב's 805-870 query but
// does NOT overlap it in time.
function setupCamp(win) {
    win.divisions = {
        'לב': { bunks: ['L1'] },
        'Div9': { bunks: ['D9a', 'D9b'] },
    };
    win.divisionTimes = {
        'לב': [{ startMin: 740, endMin: 805 }, { startMin: 805, endMin: 870 }],
        'Div9': [{ startMin: 800, endMin: 890 }, { startMin: 890, endMin: 970 }],
    };
    win.scheduleAssignments = {
        D9a: [null, { field: 'Beach 1', _activity: 'Volleyball', _startMin: 890, _endMin: 970 }],
    };
    win.fieldUsageBySlot = {};
    win.unifiedTimes = [{}, {}];
    win.activityProperties = {
        'Beach 1': { available: true, sharableWith: { type: 'not_sharable', capacity: 1 }, timeRules: [] },
    };
}

function mkBlock() {
    return { bunk: 'L1', divName: 'לב', slots: [1], startTime: 805, endTime: 870 };
}

describe('A. time-aware capacity during partial regen', () => {
    let win, U;
    beforeEach(() => { win = bootUtils(); setupCamp(win); U = win.SchedulerCoreUtils; });

    it('LEGACY (no regen scope): same-index different-time entry still blocks (unchanged behavior)', () => {
        delete win.__regenSlotScope;
        const ok = U.canBlockFit(mkBlock(), 'Beach 1', win.activityProperties, null, 'Volleyball', false);
        assert.strictEqual(ok, false, 'legacy index-keyed capacity must be untouched without regen scope');
    });

    it('REGEN: time-disjoint same-index entry is filtered → field is usable', () => {
        win.__regenSlotScope = { L1: { regen: new Set([1]), keep: {}, orig: {} } };
        const ok = U.canBlockFit(mkBlock(), 'Beach 1', win.activityProperties, null, 'Volleyball', false);
        assert.strictEqual(ok, true, 'D9a@890-970 must not block an 805-870 query on the same index');
    });

    it('REGEN: REAL time-overlap still blocks (not_sharable cap 1)', () => {
        win.__regenSlotScope = { L1: { regen: new Set([1]), keep: {}, orig: {} } };
        win.scheduleAssignments.D9a[1] = { field: 'Beach 1', _activity: 'Volleyball', _startMin: 820, _endMin: 900 };
        const ok = U.canBlockFit(mkBlock(), 'Beach 1', win.activityProperties, null, 'Volleyball', false);
        assert.strictEqual(ok, false, 'a genuinely overlapping occupant must still block');
    });

    it('REGEN: entry with no _startMin falls back to divisionTimes of its OWN division', () => {
        win.__regenSlotScope = { L1: { regen: new Set([1]), keep: {}, orig: {} } };
        win.scheduleAssignments.D9a[1] = { field: 'Beach 1', _activity: 'Volleyball' }; // bare entry
        // Div9 slot 1 = 890-970 per divisionTimes → still disjoint → usable
        const ok = U.canBlockFit(mkBlock(), 'Beach 1', win.activityProperties, null, 'Volleyball', false);
        assert.strictEqual(ok, true, 'time must resolve via the occupant division grid, not the querying grid');
    });

    it('REGEN: kill switch __regenTimeAwareCapacity=false restores legacy blocking', () => {
        win.__regenSlotScope = { L1: { regen: new Set([1]), keep: {}, orig: {} } };
        win.__regenTimeAwareCapacity = false;
        const ok = U.canBlockFit(mkBlock(), 'Beach 1', win.activityProperties, null, 'Volleyball', false);
        assert.strictEqual(ok, false, 'kill switch must restore index-keyed behavior');
    });

    it('REGEN: same-division same-grid occupant (true overlap by definition) still blocks', () => {
        win.divisions['לב'].bunks.push('L2');
        win.__regenSlotScope = { L1: { regen: new Set([1]), keep: {}, orig: {} } };
        win.scheduleAssignments.L2 = [null, { field: 'Beach 1', _activity: 'Volleyball', _startMin: 805, _endMin: 870 }];
        delete win.scheduleAssignments.D9a; // isolate
        const ok = U.canBlockFit(mkBlock(), 'Beach 1', win.activityProperties, null, 'Volleyball', false);
        assert.strictEqual(ok, false, 'preserved sibling in the SAME division must still be respected');
    });
});

describe('B. index-lock time check during partial regen', () => {
    let win, U;
    beforeEach(() => {
        win = bootUtils(); setupCamp(win); U = win.SchedulerCoreUtils;
        delete win.scheduleAssignments.D9a; // no capacity interference
    });

    function installLock(startMin, endMin) {
        win.GlobalFieldLocks = {
            isFieldLocked(fieldName, slots) {
                if (String(fieldName).toLowerCase().trim() === 'beach 1') {
                    return { lockedBy: 'pinned_event_location', lockType: 'global', startMin, endMin };
                }
                return null;
            },
        };
    }

    it('LEGACY (no regen scope): time-disjoint indexed lock still blocks (unchanged behavior)', () => {
        delete win.__regenSlotScope;
        installLock(890, 970); // ABBL-style pin, disjoint from 805-870
        const ok = U.canBlockFit(mkBlock(), 'Beach 1', win.activityProperties, null, 'Volleyball', false);
        assert.strictEqual(ok, false);
    });

    it('REGEN: time-disjoint indexed lock is ignored → field is usable', () => {
        win.__regenSlotScope = { L1: { regen: new Set([1]), keep: {}, orig: {} } };
        installLock(890, 970);
        const ok = U.canBlockFit(mkBlock(), 'Beach 1', win.activityProperties, null, 'Volleyball', false);
        assert.strictEqual(ok, true, 'a pin @890-970 must not block an 805-870 query');
    });

    it('REGEN: overlapping indexed lock still blocks', () => {
        win.__regenSlotScope = { L1: { regen: new Set([1]), keep: {}, orig: {} } };
        installLock(800, 860);
        const ok = U.canBlockFit(mkBlock(), 'Beach 1', win.activityProperties, null, 'Volleyball', false);
        assert.strictEqual(ok, false);
    });

    it('REGEN: lock WITHOUT explicit times keeps blocking (conservative)', () => {
        win.__regenSlotScope = { L1: { regen: new Set([1]), keep: {}, orig: {} } };
        win.GlobalFieldLocks = { isFieldLocked: () => ({ lockedBy: 'legacy', lockType: 'global' }) };
        const ok = U.canBlockFit(mkBlock(), 'Beach 1', win.activityProperties, null, 'Volleyball', false);
        assert.strictEqual(ok, false, 'no-times lock must stay blocking');
    });

    it('REGEN: kill switch __regenIndexLockTimeCheck=false restores legacy blocking', () => {
        win.__regenSlotScope = { L1: { regen: new Set([1]), keep: {}, orig: {} } };
        win.__regenIndexLockTimeCheck = false;
        installLock(890, 970);
        const ok = U.canBlockFit(mkBlock(), 'Beach 1', win.activityProperties, null, 'Volleyball', false);
        assert.strictEqual(ok, false);
    });
});
