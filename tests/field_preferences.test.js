/**
 * Tests for the "Field Preferences" SOFT rule (Rules tab).
 *
 *   - rules live in settings.schedulingRules.fieldPreferences:
 *       [{ id, grade, activity: '' | 'Basketball', fields: ['Court 1','Court 2'] }]
 *     `fields` is ORDERED, most-preferred first; empty `activity` = every activity.
 *   - Utils.getGradeFieldPreference(div, field, activity) is the lookup
 *     → { rank, of, kind } | null   (case-insensitive, 3s cache,
 *       invalidateFieldPreferenceCache to drop it)
 *   - Utils.getFieldPreferenceBias(div, field, activity, step) is what the solvers
 *     add to a candidate's score. It LEANS, it doesn't merely avoid:
 *       top choice → -2*step (pull), rank i → +i*step,
 *       another grade's first choice → +step (leave it for them), else 0.
 *   - FieldQualityReopt.pullToPreferred() is the post-pass (Phase P) that moves an
 *     already-placed block onto its grade's preferred field when that field is
 *     usable — for blocks placed while the favorite was still busy.
 *   - SOFT semantics: canBlockFit must NOT reject a less-preferred field — the
 *     rule works purely through finite score bias, so a bunk still lands on the
 *     runner-up field rather than getting a Free period.
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
function assertPref(actual, rank, kind, msg) {
    assert.ok(actual, (msg || 'preference') + ': expected a preference, got ' + actual);
    assert.strictEqual(actual.rank, rank, msg + ' (rank)');
    assert.strictEqual(actual.kind, kind, msg + ' (kind)');
}

describe('getGradeFieldPreference (rule lookup)', () => {
    let U;
    beforeEach(() => { U = boot(RULES).SchedulerCoreUtils; });

    it('no rules configured → no preference anywhere', () => {
        const U0 = boot(null).SchedulerCoreUtils;
        assert.strictEqual(U0.getGradeFieldPreference('1st Grade', 'Court 1'), null);
        assert.strictEqual(U0.getFieldPreferenceBias('1st Grade', 'Court 2', 'Basketball', 400), 0);
    });

    it('ranks each grade\'s fields in the order the user listed them', () => {
        assertPref(U.getGradeFieldPreference('1st Grade', 'Court 1'), 0, 'top', '1st/Court 1');
        assertPref(U.getGradeFieldPreference('1st Grade', 'Court 2'), 1, 'listed', '1st/Court 2');
        assertPref(U.getGradeFieldPreference('2nd Grade', 'Court 2'), 0, 'top', '2nd/Court 2');
        assertPref(U.getGradeFieldPreference('2nd Grade', 'Court 1'), 1, 'listed', '2nd/Court 1');
        assert.strictEqual(U.getGradeFieldPreference('1st Grade', 'Court 1').of, 2);
    });

    it('leans toward the top choice (pull) and away from lower ranks', () => {
        assert.strictEqual(U.getFieldPreferenceBias('1st Grade', 'Court 1', 'Basketball', 400), -800);
        assert.strictEqual(U.getFieldPreferenceBias('1st Grade', 'Court 2', 'Basketball', 400), 400);
        assert.strictEqual(U.getFieldPreferenceBias('2nd Grade', 'Court 2', 'Basketball', 2500), -5000);
        assert.strictEqual(U.getFieldPreferenceBias('2nd Grade', 'Court 1', 'Basketball', 2500), 2500);
        // the pull must be strong enough to beat the field-quality steering it
        // competes with in the manual scorer (1500 per quality rank)
        assert.ok(Math.abs(U.getFieldPreferenceBias('2nd Grade', 'Court 2', 'Basketball', 2500)) > 1500);
    });

    it('nudges a grade with no preference off another grade\'s first choice', () => {
        // 3rd Grade has no rule: Court 1 is 1st Grade's first choice, so leave it
        // for them when there's an alternative — a mild push, never a block.
        assertPref(U.getGradeFieldPreference('3rd Grade', 'Court 1'), null, 'reserved', '3rd/Court 1');
        assert.strictEqual(U.getFieldPreferenceBias('3rd Grade', 'Court 1', 'Basketball', 400), 400);
        // …and the push is milder than the pull the preferring grade gets
        assert.ok(U.getFieldPreferenceBias('3rd Grade', 'Court 1', 'Basketball', 400)
            < Math.abs(U.getFieldPreferenceBias('1st Grade', 'Court 1', 'Basketball', 400)));
    });

    it('leaves fields nobody expressed a preference about alone', () => {
        assert.strictEqual(U.getGradeFieldPreference('1st Grade', 'Baseball Field'), null);
        assert.strictEqual(U.getFieldPreferenceBias('1st Grade', 'Baseball Field', 'Baseball', 400), 0);
        assert.strictEqual(U.getFieldPreferenceBias('3rd Grade', 'Baseball Field', 'Baseball', 400), 0);
    });

    it('a one-field list still steers the grade off the other listed courts', () => {
        // "1st Grade gets Court 1" alone: Court 2 is in the managed set (2nd Grade
        // named it), so it ranks after 1st Grade's only listed field.
        const U1 = boot({ fieldPreferences: [
            { id: 'a', grade: '1st Grade', activity: '', fields: ['Court 1'] },
            { id: 'b', grade: '2nd Grade', activity: '', fields: ['Court 2'] }
        ] }).SchedulerCoreUtils;
        assert.strictEqual(U1.getFieldPreferenceBias('1st Grade', 'Court 1', 'Basketball', 400), -800);
        assert.strictEqual(U1.getFieldPreferenceBias('1st Grade', 'Court 2', 'Basketball', 400), 400);
        assert.strictEqual(U1.getFieldPreferenceBias('2nd Grade', 'Court 2', 'Basketball', 400), -800);
        assert.strictEqual(U1.getFieldPreferenceBias('2nd Grade', 'Court 1', 'Basketball', 400), 400);
        // …but an unmentioned field is still untouched
        assert.strictEqual(U1.getFieldPreferenceBias('1st Grade', 'Court 3', 'Basketball', 400), 0);
    });

    it('matching is case/whitespace-insensitive', () => {
        assertPref(U.getGradeFieldPreference(' 1ST GRADE ', 'court 2 '), 1, 'listed', 'messy casing');
    });

    it('an activity-scoped rule only applies to that activity', () => {
        const U2 = boot({ fieldPreferences: [
            { id: 'a', grade: '1st Grade', activity: 'Basketball', fields: ['Court 1', 'Court 2'] }
        ] }).SchedulerCoreUtils;
        assert.strictEqual(U2.getFieldPreferenceBias('1st Grade', 'Court 1', 'Basketball', 400), -800);
        assert.strictEqual(U2.getFieldPreferenceBias('1st Grade', 'Court 2', 'Basketball', 400), 400);
        assert.strictEqual(U2.getFieldPreferenceBias('1st Grade', 'Court 2', 'Volleyball', 400), 0);
        // a caller that names no activity gets any-activity rules only
        assert.strictEqual(U2.getFieldPreferenceBias('1st Grade', 'Court 2', null, 400), 0);
    });

    it('an activity-scoped rule wins over the same grade\'s any-activity rule', () => {
        const U3 = boot({ fieldPreferences: [
            { id: 'any', grade: '1st Grade', activity: '', fields: ['Court 1', 'Court 2'] },
            { id: 'vb', grade: '1st Grade', activity: 'Volleyball', fields: ['Court 2', 'Court 1'] }
        ] }).SchedulerCoreUtils;
        assert.strictEqual(U3.getFieldPreferenceBias('1st Grade', 'Court 1', 'Basketball', 400), -800);
        assert.strictEqual(U3.getFieldPreferenceBias('1st Grade', 'Court 1', 'Volleyball', 400), 400);
        assert.strictEqual(U3.getFieldPreferenceBias('1st Grade', 'Court 2', 'Volleyball', 400), -800);
    });

    it('cache serves stale rules until invalidated', () => {
        const win = boot(RULES);
        const UC = win.SchedulerCoreUtils;
        assert.strictEqual(UC.getFieldPreferenceBias('1st Grade', 'Court 2', 'Basketball', 400), 400);
        win.loadGlobalSettings = () => ({ schedulingRules: { fieldPreferences: [] } });
        // within the 3s TTL the old answer persists…
        assert.strictEqual(UC.getFieldPreferenceBias('1st Grade', 'Court 2', 'Basketball', 400), 400);
        // …until the Rules tab save invalidates it
        UC.invalidateFieldPreferenceCache();
        assert.strictEqual(UC.getFieldPreferenceBias('1st Grade', 'Court 2', 'Basketball', 400), 0);
    });

    it('fail-open on malformed rules and missing args', () => {
        const UM = boot({ fieldPreferences: [
            null, {}, { grade: '1st Grade' }, { fields: ['Court 1'] }, { grade: '1st Grade', fields: [] }
        ] }).SchedulerCoreUtils;
        assert.strictEqual(UM.getGradeFieldPreference('1st Grade', 'Court 1'), null);
        assert.strictEqual(UM.getGradeFieldPreference(null, 'Court 1'), null);
        assert.strictEqual(UM.getGradeFieldPreference('1st Grade', null), null);
        assert.strictEqual(UM.getFieldPreferenceBias('1st Grade', 'Court 1', 'Basketball', 400), 0);
    });

    it('a bad/absent step falls back to a sane default, never NaN', () => {
        assert.strictEqual(U.getFieldPreferenceBias('1st Grade', 'Court 2', 'Basketball'), 100);
        assert.strictEqual(U.getFieldPreferenceBias('1st Grade', 'Court 1', 'Basketball', 0), -200);
    });
});

describe('soft semantics: a less-preferred field is never hard-blocked', () => {
    it('canBlockFit still accepts the runner-up field (bias, not veto)', () => {
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

// ============================================================================
// PHASE P — preference pull post-pass (FieldQualityReopt.pullToPreferred)
// ============================================================================
const COURTS = [
    { name: 'Court 1', activities: ['Basketball'], sharableWith: { type: 'not_sharable', capacity: 1 } },
    { name: 'Court 2', activities: ['Basketball'], sharableWith: { type: 'not_sharable', capacity: 1 } }
];

function bootPull(rules, fields, divisions, scheduleAssignments) {
    const win = bootSandbox(['scheduler_core_utils.js', 'field_quality_reopt.js']);
    win.loadGlobalSettings = () => ({ app1: { fields: fields }, schedulingRules: rules || {} });
    win.SchedulerCoreUtils.invalidateFieldPreferenceCache();
    win.divisions = divisions;
    win.scheduleAssignments = scheduleAssignments;
    return win;
}

const block = (field, extra) => Object.assign({
    field: field, sport: 'Basketball', _activity: 'Basketball',
    _startMin: 600, _endMin: 660, continuation: false
}, extra || {});

describe('preference pull (Phase P)', () => {
    it('moves a grade off the runner-up court when its first choice is free', () => {
        const win = bootPull(RULES, COURTS,
            { '1st Grade': { bunks: ['Bunk 1A'] } },
            { 'Bunk 1A': [block('Court 2')] });
        const moved = win.FieldQualityReopt.pullToPreferred({});
        assert.strictEqual(moved, 1, 'one block pulled');
        assert.strictEqual(win.scheduleAssignments['Bunk 1A'][0].field, 'Court 1');
        assert.strictEqual(win.scheduleAssignments['Bunk 1A'][0]._prefMoved, true);
    });

    it('leaves the block alone when the preferred court is genuinely busy', () => {
        const win = bootPull(RULES, COURTS,
            { '1st Grade': { bunks: ['Bunk 1A'] }, '2nd Grade': { bunks: ['Bunk 2A'] } },
            { 'Bunk 1A': [block('Court 2')], 'Bunk 2A': [block('Court 1')] });
        // Court 1 is taken by 2nd Grade at the same time and can't be shared, so
        // 1st Grade keeps Court 2 rather than losing the period.
        assert.strictEqual(win.FieldQualityReopt.pullToPreferred({}), 0);
        assert.strictEqual(win.scheduleAssignments['Bunk 1A'][0].field, 'Court 2');
        assert.strictEqual(win.scheduleAssignments['Bunk 2A'][0].field, 'Court 1');
    });

    it('pulls the strongest preference first when two bunks want one court', () => {
        const win = bootPull(RULES, COURTS,
            { '1st Grade': { bunks: ['Bunk 1A', 'Bunk 1B'] } },
            { 'Bunk 1A': [block('Court 2')], 'Bunk 1B': [block('Court 2')] });
        // Court 1 holds one bunk (not sharable) → exactly one of them moves,
        // and the other keeps its slot instead of being dropped.
        assert.strictEqual(win.FieldQualityReopt.pullToPreferred({}), 1);
        const fields = ['Bunk 1A', 'Bunk 1B'].map(b => win.scheduleAssignments[b][0].field).sort();
        assert.deepStrictEqual(fields, ['Court 1', 'Court 2']);
    });

    it('never moves league / post-edit / pinned / pair-locked blocks', () => {
        const locks = [{ _league: true }, { _postEdit: true }, { _pinned: true }, { _pairLock: true }];
        locks.forEach(lock => {
            const win = bootPull(RULES, COURTS,
                { '1st Grade': { bunks: ['Bunk 1A'] } },
                { 'Bunk 1A': [block('Court 2', lock)] });
            assert.strictEqual(win.FieldQualityReopt.pullToPreferred({}), 0, Object.keys(lock)[0]);
            assert.strictEqual(win.scheduleAssignments['Bunk 1A'][0].field, 'Court 2');
        });
    });

    it('respects the caller\'s validator (access / time rules)', () => {
        const win = bootPull(RULES, COURTS,
            { '1st Grade': { bunks: ['Bunk 1A'] } },
            { 'Bunk 1A': [block('Court 2')] });
        const moved = win.FieldQualityReopt.pullToPreferred({
            validate: (field) => field === 'Court 1' ? 'field access: grade not allowed' : null
        });
        assert.strictEqual(moved, 0);
        assert.strictEqual(win.scheduleAssignments['Bunk 1A'][0].field, 'Court 2');
    });

    it('no-ops when no preference is configured', () => {
        const win = bootPull({}, COURTS,
            { '1st Grade': { bunks: ['Bunk 1A'] } },
            { 'Bunk 1A': [block('Court 2')] });
        assert.strictEqual(win.FieldQualityReopt.pullToPreferred({}), 0);
        assert.strictEqual(win.scheduleAssignments['Bunk 1A'][0].field, 'Court 2');
    });

    it('carries a moved field onto the block\'s continuation slots and labels', () => {
        const lead = block('Court 2', { _location: 'Court 2' });
        const cont = block('Court 2', { continuation: true, _location: 'Court 2' });
        const win = bootPull(RULES, COURTS,
            { '1st Grade': { bunks: ['Bunk 1A'] } },
            { 'Bunk 1A': [lead, cont] });
        assert.strictEqual(win.FieldQualityReopt.pullToPreferred({}), 1);
        assert.strictEqual(win.scheduleAssignments['Bunk 1A'][0].field, 'Court 1');
        assert.strictEqual(win.scheduleAssignments['Bunk 1A'][0]._location, 'Court 1');
        assert.strictEqual(win.scheduleAssignments['Bunk 1A'][1].field, 'Court 1');
        assert.strictEqual(win.scheduleAssignments['Bunk 1A'][1]._location, 'Court 1');
    });

    it('does not move a block onto a field that cannot host the activity', () => {
        const fields = [
            { name: 'Court 1', activities: ['Volleyball'], sharableWith: { type: 'not_sharable', capacity: 1 } },
            { name: 'Court 2', activities: ['Basketball'], sharableWith: { type: 'not_sharable', capacity: 1 } }
        ];
        const win = bootPull(RULES, fields,
            { '1st Grade': { bunks: ['Bunk 1A'] } },
            { 'Bunk 1A': [block('Court 2')] });
        assert.strictEqual(win.FieldQualityReopt.pullToPreferred({}), 0);
        assert.strictEqual(win.scheduleAssignments['Bunk 1A'][0].field, 'Court 2');
    });
});
