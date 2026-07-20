/**
 * Tests for the "Don't Give Unless Needed" SOFT rule (Rules tab).
 *
 *   - rules live in settings.schedulingRules.avoidUnlessNeeded:
 *       [{ id, grade, sports: [] }]
 *   - Utils.isSportAvoidedUnlessNeeded(divName, activityName) is the lookup
 *     (case-insensitive, 3s cache, invalidateAvoidRulesCache to drop it)
 *   - SOFT semantics: canBlockFit must NOT reject an avoided sport — the rule
 *     works through a huge finite rotation-score penalty
 *     (CONFIG.AVOID_UNLESS_NEEDED_PENALTY), so the sport is placed only when
 *     the alternative is a Free slot.
 *
 * Run with: node --test tests/avoid_unless_needed.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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
    sandbox.localStorage = (() => { let s = {}; return { getItem(k) { return Object.prototype.hasOwnProperty.call(s, k) ? s[k] : null; }, setItem(k, v) { s[k] = String(v); }, removeItem(k) { delete s[k]; }, clear() { s = {}; } }; })();
    sandbox.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
    sandbox.dispatchEvent = () => true; sandbox.addEventListener = () => {}; sandbox.removeEventListener = () => {};
    sandbox.requestAnimationFrame = () => 0; sandbox.cancelAnimationFrame = () => {};
    sandbox.location = { href: '', reload() {}, search: '' };
    sandbox.navigator = { onLine: true, userAgent: 'node' };
    sandbox.AccessControl = null;
    sandbox.currentScheduleDate = '2026-07-15';
    sandbox.loadCurrentDailyData = () => ({});
    sandbox.getLocationForActivity = () => null;

    files.forEach(f => {
        const code = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
        vm.runInNewContext(code, sandbox, { filename: f });
    });
    return sandbox;
}

const RULES = { avoidUnlessNeeded: [{ id: 'aun_1', grade: '7th Grade', sports: ['Volleyball', 'Newcomb'] }] };

describe('isSportAvoidedUnlessNeeded (soft rule lookup)', () => {
    let win, U;
    beforeEach(() => {
        win = bootSandbox(['scheduler_core_utils.js']);
        U = win.SchedulerCoreUtils;
    });

    it('no rules configured → nothing avoided', () => {
        assert.strictEqual(U.isSportAvoidedUnlessNeeded('7th Grade', 'Volleyball'), false);
    });

    it('matches the configured grade + sports only', () => {
        win.loadGlobalSettings = () => ({ schedulingRules: RULES });
        U.invalidateAvoidRulesCache();
        assert.strictEqual(U.isSportAvoidedUnlessNeeded('7th Grade', 'Volleyball'), true);
        assert.strictEqual(U.isSportAvoidedUnlessNeeded('7th Grade', 'Newcomb'), true);
        assert.strictEqual(U.isSportAvoidedUnlessNeeded('7th Grade', 'Basketball'), false); // other sport
        assert.strictEqual(U.isSportAvoidedUnlessNeeded('6th Grade', 'Volleyball'), false); // other grade
    });

    it('matching is case/whitespace-insensitive', () => {
        win.loadGlobalSettings = () => ({ schedulingRules: RULES });
        U.invalidateAvoidRulesCache();
        assert.strictEqual(U.isSportAvoidedUnlessNeeded(' 7TH GRADE ', 'volleyball '), true);
    });

    it('cache serves stale rules until invalidated', () => {
        win.loadGlobalSettings = () => ({ schedulingRules: RULES });
        U.invalidateAvoidRulesCache();
        assert.strictEqual(U.isSportAvoidedUnlessNeeded('7th Grade', 'Volleyball'), true);
        win.loadGlobalSettings = () => ({ schedulingRules: { avoidUnlessNeeded: [] } });
        // within the 3s TTL the old answer persists…
        assert.strictEqual(U.isSportAvoidedUnlessNeeded('7th Grade', 'Volleyball'), true);
        // …until the Rules tab save invalidates it
        U.invalidateAvoidRulesCache();
        assert.strictEqual(U.isSportAvoidedUnlessNeeded('7th Grade', 'Volleyball'), false);
    });

    it('fail-open on malformed rules and missing args', () => {
        win.loadGlobalSettings = () => ({ schedulingRules: { avoidUnlessNeeded: [null, {}, { grade: '7th Grade' }, { sports: ['Volleyball'] }] } });
        U.invalidateAvoidRulesCache();
        assert.strictEqual(U.isSportAvoidedUnlessNeeded('7th Grade', 'Volleyball'), false);
        assert.strictEqual(U.isSportAvoidedUnlessNeeded(null, 'Volleyball'), false);
        assert.strictEqual(U.isSportAvoidedUnlessNeeded('7th Grade', null), false);
    });
});

describe('soft semantics: canBlockFit does NOT hard-block avoided sports', () => {
    it('an avoided sport still passes the fit check (penalty, not veto)', () => {
        const win = bootSandbox(['scheduler_core_utils.js']);
        const U = win.SchedulerCoreUtils;
        win.loadGlobalSettings = () => ({ schedulingRules: RULES });
        U.invalidateAvoidRulesCache();
        const activityProperties = { 'Volleyball Court': {
            available: true, sharable: true,
            sharableWith: { capacity: 99, type: 'all', divisions: [] },
            timeRules: [], transition: { preMin: 0, postMin: 0, zone: 'default', occupiesField: false }
        } };
        win.fieldUsageBySlot = {};
        const blk = { bunk: 'Bunk 7A', divName: '7th Grade', startTime: 600, endTime: 660, slots: [600] };
        assert.strictEqual(U.canBlockFit(blk, 'Volleyball Court', activityProperties, {}, 'Volleyball'), true);
    });
});

describe('rotation engine applies the avoid penalty', () => {
    it('avoided sport scores >= AVOID_UNLESS_NEEDED_PENALTY; others stay far below', () => {
        const win = bootSandbox(['scheduler_core_utils.js', 'rotation_engine.js']);
        const U = win.SchedulerCoreUtils;
        win.loadGlobalSettings = () => ({ schedulingRules: RULES });
        U.invalidateAvoidRulesCache();
        const RE = win.RotationEngine;
        assert.ok(RE && typeof RE.calculateRotationScore === 'function', 'RotationEngine booted');
        const PEN = RE.CONFIG.AVOID_UNLESS_NEEDED_PENALTY;
        assert.ok(PEN >= 100000, 'penalty constant exists and is huge');

        const opts = (act) => ({
            bunkName: 'Bunk 7A', activityName: act, divisionName: '7th Grade',
            beforeSlotIndex: 0, allActivities: null, activityProperties: {}
        });
        const avoided = RE.calculateRotationScore(opts('Volleyball'));
        const normal = RE.calculateRotationScore(opts('Basketball'));
        assert.ok(Number.isFinite(avoided), 'avoided sport is NOT hard-blocked (finite score)');
        // Organic components (never-done / coverage bonuses) can offset the raw
        // constant by a few thousand — what matters is the avoided sport ranks
        // an order of magnitude worse than any organic score.
        assert.ok(avoided >= PEN / 2, `avoided score ${avoided} carries the penalty`);
        assert.ok(normal < PEN / 2, `normal sport score ${normal} is far below the penalty`);
        assert.ok(avoided - normal >= PEN / 2, `penalty separates avoided (${avoided}) from normal (${normal})`);

        // Other grades are not penalized for the same sport
        const otherGrade = RE.calculateRotationScore({
            bunkName: 'Bunk 6A', activityName: 'Volleyball', divisionName: '6th Grade',
            beforeSlotIndex: 0, allActivities: null, activityProperties: {}
        });
        assert.ok(otherGrade < PEN / 2, `other grade's score ${otherGrade} is unpenalized`);
    });
});
