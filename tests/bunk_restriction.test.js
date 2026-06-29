/**
 * Tests for Utils.isBunkRestrictedFromTarget — the per-date, FACILITY-SCOPED
 * "only available for these bunk(s) today" gate (Daily Adjustments → Resources,
 * inside each facility's detail pane). Restriction-only allow-list: a matching
 * (facility, activity) restriction blocks every bunk NOT in its list.
 *
 *   - entry = { id, facility, activity, bunks } ; activity '*' = whole facility
 *   - field-level callers pass the concrete fieldName
 *   - field-agnostic callers pass fieldName=null → host resolved via
 *     window.getLocationForActivity (specials only; sports resolve to null and
 *     are left to the field-level gates)
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
    // Host resolver: specials resolve to their location; everything else → null.
    sandbox._specialHosts = {};
    sandbox.getLocationForActivity = (n) => sandbox._specialHosts[String(n).toLowerCase()] || null;

    const code = fs.readFileSync(path.join(__dirname, '..', 'scheduler_core_utils.js'), 'utf8');
    vm.runInNewContext(code, sandbox, { filename: 'scheduler_core_utils.js' });
    return sandbox;
}

describe('isBunkRestrictedFromTarget (facility-scoped)', () => {
    let win, U;
    beforeEach(() => { win = bootUtils(); U = win.SchedulerCoreUtils; win.loadCurrentDailyData = () => ({}); win._specialHosts = {}; });

    it('is exposed on SchedulerCoreUtils', () => {
        assert.strictEqual(typeof U.isBunkRestrictedFromTarget, 'function');
    });

    it('empty / no restrictions → never blocked', () => {
        win.loadCurrentDailyData = () => ({ dailyActivityBunkRestrictions: [] });
        assert.strictEqual(U.isBunkRestrictedFromTarget('Bunk 2', 'Soccer', 'Field A', 'Div'), false);
        win.loadCurrentDailyData = () => ({});
        assert.strictEqual(U.isBunkRestrictedFromTarget('Bunk 2', 'Soccer', 'Field A', 'Div'), false);
    });

    it('facility+sport: blocks non-listed bunk only on THAT facility/activity', () => {
        win.loadCurrentDailyData = () => ({ dailyActivityBunkRestrictions: [
            { id: 'r1', facility: 'Field A', activity: 'Soccer', bunks: ['Bunk 1'] }
        ] });
        assert.strictEqual(U.isBunkRestrictedFromTarget('Bunk 2', 'Soccer', 'Field A', 'Div'), true);   // blocked here
        assert.strictEqual(U.isBunkRestrictedFromTarget('Bunk 1', 'Soccer', 'Field A', 'Div'), false);  // allowed
        assert.strictEqual(U.isBunkRestrictedFromTarget('Bunk 2', 'Soccer', 'Field B', 'Div'), false);  // other facility unaffected
        assert.strictEqual(U.isBunkRestrictedFromTarget('Bunk 2', 'Kickball', 'Field A', 'Div'), false); // other activity unaffected
    });

    it('entire-facility (activity "*") blocks every activity on that facility', () => {
        win.loadCurrentDailyData = () => ({ dailyActivityBunkRestrictions: [
            { id: 'r2', facility: 'Field A', activity: '*', bunks: ['Bunk 1'] }
        ] });
        assert.strictEqual(U.isBunkRestrictedFromTarget('Bunk 2', 'Soccer', 'Field A', 'Div'), true);
        assert.strictEqual(U.isBunkRestrictedFromTarget('Bunk 2', 'Kickball', 'Field A', 'Div'), true);
        assert.strictEqual(U.isBunkRestrictedFromTarget('Bunk 1', 'Soccer', 'Field A', 'Div'), false);
        assert.strictEqual(U.isBunkRestrictedFromTarget('Bunk 2', 'Soccer', 'Field B', 'Div'), false);
    });

    it('field-agnostic call resolves a special host via getLocationForActivity', () => {
        win._specialHosts = { 'pottery': 'Art Room' };
        win.loadCurrentDailyData = () => ({ dailyActivityBunkRestrictions: [
            { id: 'r3', facility: 'Art Room', activity: 'Pottery', bunks: ['Bunk 3'] }
        ] });
        // fieldName null → host resolves to Art Room → enforced
        assert.strictEqual(U.isBunkRestrictedFromTarget('Bunk 9', 'Pottery', null, 'Div'), true);
        assert.strictEqual(U.isBunkRestrictedFromTarget('Bunk 3', 'Pottery', null, 'Div'), false);
    });

    it('field-agnostic call for a multi-field sport (no host) does NOT block', () => {
        // No host for 'Soccer' → can't evaluate facility scope → leave to field gates.
        win.loadCurrentDailyData = () => ({ dailyActivityBunkRestrictions: [
            { id: 'r4', facility: 'Field A', activity: 'Soccer', bunks: ['Bunk 1'] }
        ] });
        assert.strictEqual(U.isBunkRestrictedFromTarget('Bunk 2', 'Soccer', null, 'Div'), false);
    });

    it('case-insensitive on facility and activity', () => {
        win.loadCurrentDailyData = () => ({ dailyActivityBunkRestrictions: [
            { id: 'r5', facility: 'field a', activity: 'soccer', bunks: ['Bunk 1'] }
        ] });
        assert.strictEqual(U.isBunkRestrictedFromTarget('Bunk 2', 'SOCCER', 'FIELD A', 'Div'), true);
    });

    it('bunk membership tolerates string/number coercion', () => {
        win.loadCurrentDailyData = () => ({ dailyActivityBunkRestrictions: [
            { id: 'r6', facility: 'Field A', activity: 'Soccer', bunks: [1, 2] }
        ] });
        assert.strictEqual(U.isBunkRestrictedFromTarget('1', 'Soccer', 'Field A', 'Div'), false);
        assert.strictEqual(U.isBunkRestrictedFromTarget('3', 'Soccer', 'Field A', 'Div'), true);
    });

    it('blocked if ANY matching entry excludes the bunk (whole-facility + per-activity)', () => {
        win.loadCurrentDailyData = () => ({ dailyActivityBunkRestrictions: [
            { id: 'a', facility: 'Field A', activity: 'Soccer', bunks: ['Bunk 1', 'Bunk 2'] },
            { id: 'b', facility: 'Field A', activity: '*', bunks: ['Bunk 1'] }
        ] });
        // Bunk 2 allowed by the Soccer entry but blocked by the whole-facility entry
        assert.strictEqual(U.isBunkRestrictedFromTarget('Bunk 2', 'Soccer', 'Field A', 'Div'), true);
        assert.strictEqual(U.isBunkRestrictedFromTarget('Bunk 1', 'Soccer', 'Field A', 'Div'), false);
    });

    it('falls back to localStorage campResourceOverrides_<date>', () => {
        win.loadCurrentDailyData = () => ({});
        win.currentScheduleDate = '2026-07-15';
        win.localStorage.setItem('campResourceOverrides_2026-07-15', JSON.stringify({
            dailyActivityBunkRestrictions: [{ id: 'r7', facility: 'Field A', activity: 'Soccer', bunks: ['Bunk 1'] }]
        }));
        assert.strictEqual(U.isBunkRestrictedFromTarget('Bunk 2', 'Soccer', 'Field A', 'Div'), true);
        assert.strictEqual(U.isBunkRestrictedFromTarget('Bunk 1', 'Soccer', 'Field A', 'Div'), false);
    });

    it('missing bunk name → not blocked (fail-open)', () => {
        win.loadCurrentDailyData = () => ({ dailyActivityBunkRestrictions: [
            { id: 'r8', facility: 'Field A', activity: 'Soccer', bunks: ['Bunk 1'] }
        ] });
        assert.strictEqual(U.isBunkRestrictedFromTarget(null, 'Soccer', 'Field A', 'Div'), false);
    });
});

describe('canBlockFit honors facility-scoped bunk restriction', () => {
    it('rejects a restricted bunk on the matching facility, leaves listed bunk unrestricted', () => {
        const win = bootUtils();
        const U = win.SchedulerCoreUtils;
        win.loadCurrentDailyData = () => ({ dailyActivityBunkRestrictions: [
            { id: 'r1', facility: 'Field A', activity: 'Soccer', bunks: ['Bunk 1'] }
        ] });
        const activityProperties = { 'Field A': {
            available: true, sharable: true,
            sharableWith: { capacity: 99, type: 'all', divisions: [] },
            timeRules: [], transition: { preMin: 0, postMin: 0, zone: 'default', occupiesField: false }
        } };
        win.fieldUsageBySlot = {};
        const mk = (bunk) => ({ bunk, divName: 'Div', startTime: 600, endTime: 660, slots: [600] });
        assert.strictEqual(U.canBlockFit(mk('Bunk 2'), 'Field A', activityProperties, {}, 'Soccer'), false);
        assert.strictEqual(U.isBunkRestrictedFromTarget('Bunk 1', 'Soccer', 'Field A', 'Div'), false);
    });
});
