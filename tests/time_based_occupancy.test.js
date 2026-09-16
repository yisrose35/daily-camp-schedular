/**
 * Tests for the clock-time occupancy primitives in scheduler_core_utils.js:
 *
 *   Utils.resolveEntryTime(bunk, slotIdx, entry)
 *   Utils.getScheduleUsageInWindow(startMin, endMin, fieldName)
 *
 * Slot indices are PER-DIVISION — index N is a different wall-clock time in each
 * grade — so the older index-keyed scan was wrong in both directions:
 *   false positive: another grade's slot N doesn't overlap, but was counted
 *   false negative: another grade overlaps at a DIFFERENT index, and was missed
 *                   (this one is a real double-booking)
 *
 * Run with: node --test tests/time_based_occupancy.test.js
 */

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
    sandbox.currentScheduleDate = '2026-07-15';
    sandbox.loadCurrentDailyData = () => ({});

    const code = fs.readFileSync(path.join(__dirname, '..', 'scheduler_core_utils.js'), 'utf8');
    vm.runInNewContext(code, sandbox, { filename: 'scheduler_core_utils.js' });
    return sandbox;
}

// Two grades whose grids are offset from each other, so index != time.
//   Junior slot 0 = 600-640, slot 1 = 640-680, slot 2 = 700-740
//   Senior slot 0 = 700-740, slot 1 = 740-780
function seedCamp(win) {
    win.divisions = {
        Junior: { bunks: ['J1', 'J2'] },
        Senior: { bunks: ['S1'] },
    };
    win.divisionTimes = {
        Junior: [
            { slotIndex: 0, startMin: 600, endMin: 640, event: 'Sports Slot', type: 'slot' },
            { slotIndex: 1, startMin: 640, endMin: 680, event: 'Sports Slot', type: 'slot' },
            { slotIndex: 2, startMin: 700, endMin: 740, event: 'Sports Slot', type: 'slot' },
        ],
        Senior: [
            { slotIndex: 0, startMin: 700, endMin: 740, event: 'Sports Slot', type: 'slot' },
            { slotIndex: 1, startMin: 740, endMin: 780, event: 'Sports Slot', type: 'slot' },
        ],
    };
    win.scheduleAssignments = { J1: [null, null, null], J2: [null, null, null], S1: [null, null] };
}

function place(win, bunk, idx, field, activity, startMin, endMin) {
    win.scheduleAssignments[bunk][idx] = {
        field, sport: activity, _activity: activity,
        _startMin: startMin, _endMin: endMin, _slotIndex: idx,
    };
}

describe('Utils.resolveEntryTime', () => {
    let win, U;
    beforeEach(() => { win = bootUtils(); U = win.SchedulerCoreUtils; seedCamp(win); });

    it('is exposed on SchedulerCoreUtils', () => {
        assert.strictEqual(typeof U.resolveEntryTime, 'function');
    });

    it("prefers the entry's own stamp over the grid slot", () => {
        // Entry sits at 600-620, only the first half of Junior slot 0 (600-640).
        const entry = { field: 'Field A', _startMin: 600, _endMin: 620 };
        assert.deepEqual(U.resolveEntryTime('J1', 0, entry), { startMin: 600, endMin: 620 });
    });

    it('falls back to the grid slot when the entry carries no stamp', () => {
        assert.deepEqual(U.resolveEntryTime('J1', 1, { field: 'Field A' }), { startMin: 640, endMin: 680 });
    });

    it('resolves the grid per-division, not globally — index 0 differs by grade', () => {
        assert.deepEqual(U.resolveEntryTime('J1', 0, null), { startMin: 600, endMin: 640 });
        assert.deepEqual(U.resolveEntryTime('S1', 0, null), { startMin: 700, endMin: 740 });
    });

    it('returns nulls when neither stamp nor grid can resolve', () => {
        assert.deepEqual(U.resolveEntryTime('J1', 99, null), { startMin: null, endMin: null });
        assert.deepEqual(U.resolveEntryTime(null, 0, null), { startMin: null, endMin: null });
    });
});

describe('Utils.getScheduleUsageInWindow', () => {
    let win, U;
    beforeEach(() => { win = bootUtils(); U = win.SchedulerCoreUtils; seedCamp(win); });

    it('is exposed on SchedulerCoreUtils', () => {
        assert.strictEqual(typeof U.getScheduleUsageInWindow, 'function');
    });

    it('finds a bunk occupying the field inside the window', () => {
        place(win, 'J1', 0, 'Field A', 'Soccer', 600, 640);
        const u = U.getScheduleUsageInWindow(600, 640, 'Field A');
        assert.strictEqual(u.count, 1);
        assert.deepEqual(u.bunkList, ['J1']);
        assert.deepEqual(u.divisions, ['Junior']);
        assert.ok(u.activities.has('soccer'));
    });

    it('FALSE POSITIVE FIX: another grade at the same index but a different hour is not counted', () => {
        // Senior slot 0 is 700-740. Query Junior slot 0's window, 600-640.
        place(win, 'S1', 0, 'Field A', 'Soccer', 700, 740);
        const u = U.getScheduleUsageInWindow(600, 640, 'Field A');
        assert.strictEqual(u.count, 0, 'S1 does not overlap 600-640 and must not block it');
    });

    it('FALSE NEGATIVE FIX: another grade overlapping at a DIFFERENT index is counted', () => {
        // This is the double-booking the index scan missed: Senior's 700-740 sits
        // at ITS index 0, while Junior's 700-740 is index 2.
        place(win, 'S1', 0, 'Field A', 'Soccer', 700, 740);
        const u = U.getScheduleUsageInWindow(700, 740, 'Field A');
        assert.strictEqual(u.count, 1);
        assert.deepEqual(u.bunkList, ['S1']);
    });

    it('counts a bunk once even when several of its entries overlap the window', () => {
        // A 40-min block split into 2x20 — both segments belong to the same bunk.
        place(win, 'J1', 0, 'Field A', 'Slush', 600, 620);
        place(win, 'J1', 1, 'Field A', 'Popcorn', 620, 640);
        const u = U.getScheduleUsageInWindow(600, 640, 'Field A');
        assert.strictEqual(u.count, 1, 'one bunk occupies the field once, not twice');
        assert.deepEqual(u.bunkList, ['J1']);
    });

    it('treats touching ranges as non-overlapping (end is exclusive)', () => {
        place(win, 'J1', 0, 'Field A', 'Soccer', 600, 640);
        assert.strictEqual(U.getScheduleUsageInWindow(640, 680, 'Field A').count, 0);
        assert.strictEqual(U.getScheduleUsageInWindow(560, 600, 'Field A').count, 0);
    });

    it('counts a partial overlap', () => {
        place(win, 'J1', 0, 'Field A', 'Soccer', 600, 640);
        assert.strictEqual(U.getScheduleUsageInWindow(630, 700, 'Field A').count, 1);
    });

    it('is field-scoped and case/whitespace insensitive', () => {
        place(win, 'J1', 0, 'Field A', 'Soccer', 600, 640);
        assert.strictEqual(U.getScheduleUsageInWindow(600, 640, 'Field B').count, 0);
        assert.strictEqual(U.getScheduleUsageInWindow(600, 640, '  fIeLd a ').count, 1);
    });

    it('aggregates several bunks across grades', () => {
        place(win, 'J1', 2, 'Field A', 'Soccer', 700, 740);
        place(win, 'S1', 0, 'Field A', 'Soccer', 700, 740);
        const u = U.getScheduleUsageInWindow(700, 740, 'Field A');
        assert.strictEqual(u.count, 2);
        assert.deepEqual(u.bunkList.sort(), ['J1', 'S1']);
        assert.deepEqual(u.divisions.sort(), ['Junior', 'Senior']);
    });

    it('returns an empty result for missing arguments', () => {
        place(win, 'J1', 0, 'Field A', 'Soccer', 600, 640);
        assert.strictEqual(U.getScheduleUsageInWindow(null, 640, 'Field A').count, 0);
        assert.strictEqual(U.getScheduleUsageInWindow(600, 640, '').count, 0);
        assert.strictEqual(U.getScheduleUsageInWindow(600, 640, null).count, 0);
    });

    it('does not pass a field name off as an activity', () => {
        // The same-activity sharing gate reads `activities`. An entry with a
        // field but no activity name must not contribute the FIELD name there,
        // or two bunks legitimately sharing a field read as different
        // activities and the share gets rejected.
        win.scheduleAssignments.J1[0] = { field: 'Field A', _startMin: 600, _endMin: 640 };
        const u = U.getScheduleUsageInWindow(600, 640, 'Field A');
        assert.strictEqual(u.count, 1, 'the bunk is still counted');
        assert.strictEqual(u.bunks.J1, 'Field A', 'bunks still gets a label');
        assert.strictEqual(u.activities.size, 0, 'but activities stays empty');
    });

    it('falls back to the grid for an unstamped entry', () => {
        win.scheduleAssignments.J1[1] = { field: 'Field A', _activity: 'Soccer' }; // no _startMin
        assert.strictEqual(U.getScheduleUsageInWindow(640, 680, 'Field A').count, 1, 'grid says slot 1 is 640-680');
        assert.strictEqual(U.getScheduleUsageInWindow(600, 640, 'Field A').count, 0);
    });
});
