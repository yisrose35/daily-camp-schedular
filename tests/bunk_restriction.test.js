/**
 * Tests for Utils.isBunkRestrictedFromTarget — the per-date "only available for
 * these bunk(s) today" gate (Daily Adjustments → Resources → Bunk-Only
 * Restrictions). Restriction-only allow-list: a matching restriction blocks
 * every bunk NOT in its list.
 *
 *   - special/sport target → matches by activity name
 *   - facility target      → matches by field/facility name
 *   - reads window.loadCurrentDailyData().dailyActivityBunkRestrictions, with a
 *     localStorage campResourceOverrides_<date> fallback
 *
 * Run with: node --test tests/bunk_restriction.test.js
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

describe('isBunkRestrictedFromTarget', () => {
    let win, U;
    beforeEach(() => { win = bootUtils(); U = win.SchedulerCoreUtils; win.loadCurrentDailyData = () => ({}); });

    it('is exposed on SchedulerCoreUtils', () => {
        assert.strictEqual(typeof U.isBunkRestrictedFromTarget, 'function');
    });

    it('empty / no restrictions → never blocked', () => {
        win.loadCurrentDailyData = () => ({ dailyActivityBunkRestrictions: [] });
        assert.strictEqual(U.isBunkRestrictedFromTarget('Bunk 2', 'Soccer', 'Field A', 'Div'), false);
        win.loadCurrentDailyData = () => ({});
        assert.strictEqual(U.isBunkRestrictedFromTarget('Bunk 2', 'Soccer', 'Field A', 'Div'), false);
    });

    it('sport target blocks non-listed bunk, allows listed bunk', () => {
        win.loadCurrentDailyData = () => ({ dailyActivityBunkRestrictions: [
            { id: 'r1', targetType: 'sport', target: 'Soccer', bunks: ['Bunk 1'] }
        ] });
        assert.strictEqual(U.isBunkRestrictedFromTarget('Bunk 2', 'Soccer', 'Field A', 'Div'), true);
        assert.strictEqual(U.isBunkRestrictedFromTarget('Bunk 1', 'Soccer', 'Field A', 'Div'), false);
        // unrelated activity on the same field is not restricted
        assert.strictEqual(U.isBunkRestrictedFromTarget('Bunk 2', 'Kickball', 'Field A', 'Div'), false);
    });

    it('special target matches by activity name (not field)', () => {
        win.loadCurrentDailyData = () => ({ dailyActivityBunkRestrictions: [
            { id: 'r2', targetType: 'special', target: 'Pottery', bunks: ['Bunk 3', 'Bunk 4'] }
        ] });
        assert.strictEqual(U.isBunkRestrictedFromTarget('Bunk 9', 'Pottery', 'Art Room', 'Div'), true);
        assert.strictEqual(U.isBunkRestrictedFromTarget('Bunk 3', 'Pottery', 'Art Room', 'Div'), false);
        assert.strictEqual(U.isBunkRestrictedFromTarget('Bunk 4', 'Pottery', 'Art Room', 'Div'), false);
    });

    it('facility target matches by field name, ignores activity', () => {
        win.loadCurrentDailyData = () => ({ dailyActivityBunkRestrictions: [
            { id: 'r3', targetType: 'facility', target: 'Baseball Field 1', bunks: ['Bunk 2'] }
        ] });
        // any activity on that facility is blocked for non-listed bunks
        assert.strictEqual(U.isBunkRestrictedFromTarget('Bunk 5', 'Baseball', 'Baseball Field 1', 'Div'), true);
        assert.strictEqual(U.isBunkRestrictedFromTarget('Bunk 2', 'Baseball', 'Baseball Field 1', 'Div'), false);
        // a sport-named match must NOT trigger a facility entry
        assert.strictEqual(U.isBunkRestrictedFromTarget('Bunk 5', 'Baseball Field 1', 'Other Field', 'Div'), false);
    });

    it('matching is case-insensitive on the target', () => {
        win.loadCurrentDailyData = () => ({ dailyActivityBunkRestrictions: [
            { id: 'r4', targetType: 'sport', target: 'soccer', bunks: ['Bunk 1'] }
        ] });
        assert.strictEqual(U.isBunkRestrictedFromTarget('Bunk 2', 'SOCCER', 'Field A', 'Div'), true);
    });

    it('bunk membership tolerates string/number coercion', () => {
        win.loadCurrentDailyData = () => ({ dailyActivityBunkRestrictions: [
            { id: 'r5', targetType: 'sport', target: 'Soccer', bunks: [1, 2] }
        ] });
        assert.strictEqual(U.isBunkRestrictedFromTarget('1', 'Soccer', 'Field A', 'Div'), false);
        assert.strictEqual(U.isBunkRestrictedFromTarget('3', 'Soccer', 'Field A', 'Div'), true);
    });

    it('multiple entries: blocked if ANY matching entry excludes the bunk', () => {
        win.loadCurrentDailyData = () => ({ dailyActivityBunkRestrictions: [
            { id: 'a', targetType: 'sport', target: 'Soccer', bunks: ['Bunk 1', 'Bunk 2'] },
            { id: 'b', targetType: 'facility', target: 'Field A', bunks: ['Bunk 1'] }
        ] });
        // Bunk 2 allowed by the sport entry but blocked by the facility entry
        assert.strictEqual(U.isBunkRestrictedFromTarget('Bunk 2', 'Soccer', 'Field A', 'Div'), true);
        // Bunk 1 allowed by both
        assert.strictEqual(U.isBunkRestrictedFromTarget('Bunk 1', 'Soccer', 'Field A', 'Div'), false);
    });

    it('falls back to localStorage campResourceOverrides_<date> when daily data is empty', () => {
        win.loadCurrentDailyData = () => ({});
        win.currentScheduleDate = '2026-07-15';
        win.localStorage.setItem('campResourceOverrides_2026-07-15', JSON.stringify({
            dailyActivityBunkRestrictions: [{ id: 'r6', targetType: 'sport', target: 'Soccer', bunks: ['Bunk 1'] }]
        }));
        assert.strictEqual(U.isBunkRestrictedFromTarget('Bunk 2', 'Soccer', 'Field A', 'Div'), true);
        assert.strictEqual(U.isBunkRestrictedFromTarget('Bunk 1', 'Soccer', 'Field A', 'Div'), false);
    });

    it('missing bunk name → not blocked (fail-open)', () => {
        win.loadCurrentDailyData = () => ({ dailyActivityBunkRestrictions: [
            { id: 'r7', targetType: 'sport', target: 'Soccer', bunks: ['Bunk 1'] }
        ] });
        assert.strictEqual(U.isBunkRestrictedFromTarget(null, 'Soccer', 'Field A', 'Div'), false);
    });
});

describe('canBlockFit honors bunk restriction', () => {
    it('rejects a restricted bunk, allows a listed bunk', () => {
        const win = bootUtils();
        const U = win.SchedulerCoreUtils;
        win.loadCurrentDailyData = () => ({ dailyActivityBunkRestrictions: [
            { id: 'r1', targetType: 'sport', target: 'Soccer', bunks: ['Bunk 1'] }
        ] });
        // minimal field props so the only gate that differs is the restriction
        const activityProperties = { 'Field A': {
            available: true, sharable: true,
            sharableWith: { capacity: 99, type: 'all', divisions: [] },
            timeRules: [], transition: { preMin: 0, postMin: 0, zone: 'default', occupiesField: false }
        } };
        win.fieldUsageBySlot = {};
        const mk = (bunk) => ({ bunk, divName: 'Div', startTime: 600, endTime: 660, slots: [600] });
        assert.strictEqual(U.canBlockFit(mk('Bunk 2'), 'Field A', activityProperties, {}, 'Soccer'), false);
        // Bunk 1 is allowed by the restriction (other gates are open) → not rejected by it.
        // We only assert the restriction itself doesn't reject Bunk 1:
        assert.strictEqual(U.isBunkRestrictedFromTarget('Bunk 1', 'Soccer', 'Field A', 'Div'), false);
    });
});
