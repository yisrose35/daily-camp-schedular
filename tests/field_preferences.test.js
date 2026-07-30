/**
 * Tests for the "Field Preferences" SOFT rule (Rules tab).
 *
 *   - rules live in settings.schedulingRules.fieldPreferences:
 *       [{ id, grade, activity: '' | 'Basketball', fields: ['Court 1','Court 2'] }]
 *     `fields` is ORDERED, most-preferred first; empty `activity` = every activity.
 *   - Utils.getGradeFieldPreference(div, field, activity) is the lookup
 *     → { rank, of } | null   (case-insensitive, 3s cache,
 *       invalidateFieldPreferenceCache to drop it)
 *   - Utils.getFieldPreferencePenalty(div, field, activity, step) is what the
 *     solvers add to a candidate's score: 0 for the top choice, rank*step below.
 *   - SOFT semantics: canBlockFit must NOT reject a less-preferred field — the
 *     rule works purely through a finite score penalty, so a bunk still lands on
 *     the runner-up field rather than getting a Free period.
 *
 * Run with: node --test tests/field_preferences.test.js
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

// The user's case: both courts are open to both grades, but 1st Grade should get
// Court 1 and 2nd Grade Court 2.
const RULES = {
    fieldPreferences: [
        { id: 'fp_1', grade: '1st Grade', activity: '', fields: ['Court 1', 'Court 2'] },
        { id: 'fp_2', grade: '2nd Grade', activity: '', fields: ['Court 2', 'Court 1'] }
    ]
};

function boot(rules) {
    const win = bootSandbox(['scheduler_core_utils.js']);
    if (rules) win.loadGlobalSettings = () => ({ schedulingRules: rules });
    win.SchedulerCoreUtils.invalidateFieldPreferenceCache();
    return win;
}

// The lookup returns an object built inside the VM realm, so deepStrictEqual
// would fail on prototype identity — compare the fields.
function assertRank(actual, rank, of, msg) {
    assert.ok(actual, (msg || 'preference') + ': expected a rank, got ' + actual);
    assert.strictEqual(actual.rank, rank, msg);
    assert.strictEqual(actual.of, of, msg);
}

describe('getGradeFieldPreference (rule lookup)', () => {
    let U;
    beforeEach(() => { U = boot(RULES).SchedulerCoreUtils; });

    it('no rules configured → no preference anywhere', () => {
        const U0 = boot(null).SchedulerCoreUtils;
        assert.strictEqual(U0.getGradeFieldPreference('1st Grade', 'Court 1'), null);
        assert.strictEqual(U0.getFieldPreferencePenalty('1st Grade', 'Court 2', 'Basketball', 400), 0);
    });

    it('ranks each grade\'s fields in the order the user listed them', () => {
        assertRank(U.getGradeFieldPreference('1st Grade', 'Court 1'), 0, 2, '1st/Court 1');
        assertRank(U.getGradeFieldPreference('1st Grade', 'Court 2'), 1, 2, '1st/Court 2');
        assertRank(U.getGradeFieldPreference('2nd Grade', 'Court 2'), 0, 2, '2nd/Court 2');
        assertRank(U.getGradeFieldPreference('2nd Grade', 'Court 1'), 1, 2, '2nd/Court 1');
    });

    it('top choice costs nothing; each rank step costs one step', () => {
        assert.strictEqual(U.getFieldPreferencePenalty('1st Grade', 'Court 1', 'Basketball', 400), 0);
        assert.strictEqual(U.getFieldPreferencePenalty('1st Grade', 'Court 2', 'Basketball', 400), 400);
        assert.strictEqual(U.getFieldPreferencePenalty('2nd Grade', 'Court 1', 'Basketball', 2500), 2500);
        assert.strictEqual(U.getFieldPreferencePenalty('2nd Grade', 'Court 2', 'Basketball', 2500), 0);
    });

    it('leaves fields nobody expressed a preference about alone', () => {
        assert.strictEqual(U.getGradeFieldPreference('1st Grade', 'Baseball Field'), null);
        assert.strictEqual(U.getFieldPreferencePenalty('1st Grade', 'Baseball Field', 'Baseball', 400), 0);
    });

    it('grades with no rule of their own are never steered', () => {
        assert.strictEqual(U.getGradeFieldPreference('3rd Grade', 'Court 1'), null);
        assert.strictEqual(U.getFieldPreferencePenalty('3rd Grade', 'Court 2', 'Basketball', 400), 0);
    });

    it('a one-field list still steers the grade off the other listed courts', () => {
        // "1st Grade gets Court 1" alone: Court 2 is in the managed set (2nd Grade
        // named it), so it ranks after 1st Grade's only listed field.
        const U1 = boot({ fieldPreferences: [
            { id: 'a', grade: '1st Grade', activity: '', fields: ['Court 1'] },
            { id: 'b', grade: '2nd Grade', activity: '', fields: ['Court 2'] }
        ] }).SchedulerCoreUtils;
        assert.strictEqual(U1.getFieldPreferencePenalty('1st Grade', 'Court 1', 'Basketball', 400), 0);
        assert.strictEqual(U1.getFieldPreferencePenalty('1st Grade', 'Court 2', 'Basketball', 400), 400);
        assert.strictEqual(U1.getFieldPreferencePenalty('2nd Grade', 'Court 2', 'Basketball', 400), 0);
        assert.strictEqual(U1.getFieldPreferencePenalty('2nd Grade', 'Court 1', 'Basketball', 400), 400);
        // …but an unmentioned field is still untouched
        assert.strictEqual(U1.getFieldPreferencePenalty('1st Grade', 'Court 3', 'Basketball', 400), 0);
    });

    it('matching is case/whitespace-insensitive', () => {
        assertRank(U.getGradeFieldPreference(' 1ST GRADE ', 'court 2 '), 1, 2, 'messy casing');
    });

    it('an activity-scoped rule only applies to that activity', () => {
        const U2 = boot({ fieldPreferences: [
            { id: 'a', grade: '1st Grade', activity: 'Basketball', fields: ['Court 1', 'Court 2'] }
        ] }).SchedulerCoreUtils;
        assert.strictEqual(U2.getFieldPreferencePenalty('1st Grade', 'Court 2', 'Basketball', 400), 400);
        assert.strictEqual(U2.getFieldPreferencePenalty('1st Grade', 'Court 2', 'Volleyball', 400), 0);
        // a caller that names no activity gets any-activity rules only
        assert.strictEqual(U2.getFieldPreferencePenalty('1st Grade', 'Court 2', null, 400), 0);
    });

    it('an activity-scoped rule wins over the same grade\'s any-activity rule', () => {
        const U3 = boot({ fieldPreferences: [
            { id: 'any', grade: '1st Grade', activity: '', fields: ['Court 1', 'Court 2'] },
            { id: 'vb', grade: '1st Grade', activity: 'Volleyball', fields: ['Court 2', 'Court 1'] }
        ] }).SchedulerCoreUtils;
        assert.strictEqual(U3.getFieldPreferencePenalty('1st Grade', 'Court 1', 'Basketball', 400), 0);
        assert.strictEqual(U3.getFieldPreferencePenalty('1st Grade', 'Court 1', 'Volleyball', 400), 400);
        assert.strictEqual(U3.getFieldPreferencePenalty('1st Grade', 'Court 2', 'Volleyball', 400), 0);
    });

    it('cache serves stale rules until invalidated', () => {
        const win = boot(RULES);
        const UC = win.SchedulerCoreUtils;
        assert.strictEqual(UC.getFieldPreferencePenalty('1st Grade', 'Court 2', 'Basketball', 400), 400);
        win.loadGlobalSettings = () => ({ schedulingRules: { fieldPreferences: [] } });
        // within the 3s TTL the old answer persists…
        assert.strictEqual(UC.getFieldPreferencePenalty('1st Grade', 'Court 2', 'Basketball', 400), 400);
        // …until the Rules tab save invalidates it
        UC.invalidateFieldPreferenceCache();
        assert.strictEqual(UC.getFieldPreferencePenalty('1st Grade', 'Court 2', 'Basketball', 400), 0);
    });

    it('fail-open on malformed rules and missing args', () => {
        const UM = boot({ fieldPreferences: [
            null, {}, { grade: '1st Grade' }, { fields: ['Court 1'] }, { grade: '1st Grade', fields: [] }
        ] }).SchedulerCoreUtils;
        assert.strictEqual(UM.getGradeFieldPreference('1st Grade', 'Court 1'), null);
        assert.strictEqual(UM.getGradeFieldPreference(null, 'Court 1'), null);
        assert.strictEqual(UM.getGradeFieldPreference('1st Grade', null), null);
        assert.strictEqual(UM.getFieldPreferencePenalty('1st Grade', 'Court 1', 'Basketball', 400), 0);
    });

    it('a bad/absent step falls back to a sane default, never NaN', () => {
        assert.strictEqual(U.getFieldPreferencePenalty('1st Grade', 'Court 2', 'Basketball'), 100);
        assert.strictEqual(U.getFieldPreferencePenalty('1st Grade', 'Court 2', 'Basketball', 0), 100);
    });
});

describe('soft semantics: a less-preferred field is never hard-blocked', () => {
    it('canBlockFit still accepts the runner-up field (penalty, not veto)', () => {
        const win = boot(RULES);
        const U = win.SchedulerCoreUtils;
        const activityProperties = { 'Court 2': {
            available: true, sharable: true,
            sharableWith: { capacity: 99, type: 'all', divisions: [] },
            timeRules: [], transition: { preMin: 0, postMin: 0, zone: 'default', occupiesField: false }
        } };
        win.fieldUsageBySlot = {};
        const blk = { bunk: 'Bunk 1A', divName: '1st Grade', startTime: 600, endTime: 660, slots: [600] };
        assert.strictEqual(U.canBlockFit(blk, 'Court 2', activityProperties, {}, 'Basketball'), true);
    });
});
