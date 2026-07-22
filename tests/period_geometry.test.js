/**
 * Tests for Utils.getPeriodCampDayGeometry — the TRUE period camp-day geometry
 * (D = camp-days in the period, e = 1-based camp-day index of the ref date).
 *
 * REGRESSION GUARD for the permanent-deadline bug: the generator's weekly-quota
 * floor, seat round-robin, release-weekly and shortfall report all hand-rolled
 * the period end as start + N*7 - 1 days, where any period that isn't
 * '2/3/4weeks' — notably 'half' — fell through to ONE WEEK. For a "2 per half"
 * minimum that made D≈6 while e kept counting the real half (15-20+), so
 * remaining = max(1, D-e+1) collapsed to 1: every under-quota bunk fired its
 * floor every day in "deadline" mode and release-weekly saw every reservation
 * as now-or-never (the 34-kept last-day pileup).
 *
 * Run with: node --test tests/period_geometry.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function bootUtils(campDates) {
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
    sandbox.location = { href: '', reload() {}, search: '' };
    sandbox.navigator = { onLine: true, userAgent: 'node' };
    sandbox.loadGlobalSettings = () => (campDates ? { campDates } : {});
    sandbox.loadAllDailyData = () => ({});
    vm.createContext(sandbox);
    const src = fs.readFileSync(path.join(__dirname, '..', 'scheduler_core_utils.js'), 'utf8');
    vm.runInContext(src, sandbox, { filename: 'scheduler_core_utils.js' });
    return sandbox;
}

// A camp with real halves: 4 weeks in half 1.
const CAMP = {
    startDate: '2026-06-29',   // Monday
    half1End: '2026-07-24',    // Friday, ~4 weeks later
    half2Start: '2026-07-26',
    endDate: '2026-08-21',
};

test("'half' period spans the CONFIGURED half, not one week", () => {
    const win = bootUtils(CAMP);
    const g = win.SchedulerCoreUtils.getPeriodCampDayGeometry('half', '2026-07-21');
    assert.ok(g, 'geometry resolves when camp dates exist');
    assert.strictEqual(g.start, '2026-06-29');
    assert.strictEqual(g.end, '2026-07-24');
    // the whole point: D is the REAL half (~3-4 weeks of camp days), not ≤6.
    assert.ok(g.D >= 15, `D must span the half (got ${g.D}) — the old hand-roll gave ~6`);
    // Jul 21 (Tue) → remaining camp days after today are exactly Wed 22, Thu 23,
    // Fri 24 (no Sat/Sun in range), so D - e === 3 regardless of Sunday policy.
    assert.strictEqual(g.D - g.e, 3, `remaining-after-today must be 3 (D=${g.D}, e=${g.e})`);
    // → remaining = D - e + 1 = 4: NOT deadline mode for a bunk needing 1-2 more.
});

test("legacy 'week' alias normalizes (getPeriodEndDate alone would return null)", () => {
    const win = bootUtils(CAMP);
    const U = win.SchedulerCoreUtils;
    assert.strictEqual(U.getPeriodEndDate('week', '2026-07-21'), null, 'precondition: raw week is unaliased in getPeriodEndDate');
    const g = U.getPeriodCampDayGeometry('week', '2026-07-21');
    assert.ok(g, "'week' must resolve via the '1week' alias");
    assert.strictEqual(g.start, '2026-07-20');            // camp-anchored week (Mon)
    assert.ok(g.D >= 5 && g.D <= 6, `one week of camp days (got ${g.D})`);
    assert.strictEqual(g.e, 2);                            // Jul 21 = day 2 of that week
    const g1 = U.getPeriodCampDayGeometry('1week', '2026-07-21');
    assert.deepStrictEqual(g, g1, "'week' and '1week' agree");
});

test('multi-week periods still work (2weeks)', () => {
    const win = bootUtils(CAMP);
    const g = win.SchedulerCoreUtils.getPeriodCampDayGeometry('2weeks', '2026-07-21');
    assert.ok(g);
    // weeks 3-4 of camp: Jul 13 - Jul 26 (clamped by the end-date math)
    assert.strictEqual(g.start, '2026-07-13');
    assert.ok(g.D >= 10 && g.D <= 12, `two weeks of camp days (got ${g.D})`);
    assert.ok(g.e >= 6 && g.e <= 8, `Jul 21 is in week 2 of the period (got e=${g.e})`);
});

test('no camp dates → null (callers keep their legacy fallback)', () => {
    const win = bootUtils(null);
    const g = win.SchedulerCoreUtils.getPeriodCampDayGeometry('half', '2026-07-21');
    assert.strictEqual(g, null);
});

test('second half resolves against half2Start → camp end', () => {
    const win = bootUtils(CAMP);
    const g = win.SchedulerCoreUtils.getPeriodCampDayGeometry('half', '2026-08-03');
    assert.ok(g);
    assert.strictEqual(g.start, '2026-07-26');
    assert.strictEqual(g.end, '2026-08-21');
    assert.ok(g.D >= 15, `second half spans weeks (got ${g.D})`);
});
