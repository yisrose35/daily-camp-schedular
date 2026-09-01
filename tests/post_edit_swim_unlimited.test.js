/**
 * Regression test: POST-EDIT treats a facility-less Swim as UNLIMITED.
 *
 * Bug: in a camp with NO facility assigned to swim (no Pool field, no Swim
 * special/general activity), the post-edit capacity gates fell through to
 * their capacity-1 default for the unconfigured name ("Swim" → not_sharable,
 * cap 1). Since generated swim entries carry the literal label "Swim" in
 * entry.field, the moment ANY other bunk was swimming, editing a cell to Swim
 * read "in use / conflict" — post-edit thought swim was limited.
 *
 * Rule: no facility assigned to swim → swim is unlimited (no cap). Same for
 * the other division-wide direct-fill labels (Lunch/Snacks/Dinner/Dismissal).
 * A camp that DOES configure the name (real Pool field w/ sharing rules)
 * keeps its real capacity. Kill-switch: window.__postEditUncappedLabels=false.
 *
 * Loads the REAL unified_schedule_system.js in a sandbox and drives the real
 * exported gates: checkFieldAvailableByTime, checkLocationConflict,
 * checkCrossDivisionConflict, findFieldsForActivity, isUncappedFacilitylessLabel.
 *
 * Run with: node --test tests/post_edit_swim_unlimited.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeEl() {
    const el = {
        style: {}, dataset: {}, children: [], classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
        appendChild(c) { this.children.push(c); return c; }, removeChild() {}, remove() {},
        addEventListener() {}, removeEventListener() {},
        querySelector() { return null; }, querySelectorAll() { return []; },
        insertBefore() {}, closest() { return null; }, contains() { return false; },
        focus() {}, blur() {}, click() {},
        innerHTML: '', textContent: '', value: '',
    };
    return el;
}

function buildSandbox() {
    const sandbox = {
        console, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
        Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set, WeakMap, WeakSet,
        Promise, parseInt, parseFloat, isNaN, isFinite, Infinity, NaN, Symbol,
        encodeURIComponent, decodeURIComponent, queueMicrotask: (fn) => fn && fn(),
        requestAnimationFrame: () => 0, cancelAnimationFrame() {},
        alert() {}, confirm() { return true; }, prompt() { return null; },
        CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
        Event: class { constructor(t) { this.type = t; } },
        MutationObserver: class { observe() {} disconnect() {} },
        dispatchEvent() { return true; }, addEventListener() {}, removeEventListener() {},
        location: { href: '', search: '', reload() {} },
        navigator: { userAgent: 'node-test' },
        document: {
            readyState: 'complete',
            getElementById() { return null; },
            querySelector() { return null; }, querySelectorAll() { return []; },
            createElement() { return makeEl(); }, createDocumentFragment() { return makeEl(); },
            addEventListener() {}, removeEventListener() {},
            body: makeEl(), head: makeEl(), documentElement: makeEl(),
        },
        localStorage: (() => { let s = {}; return {
            getItem(k) { return Object.prototype.hasOwnProperty.call(s, k) ? s[k] : null; },
            setItem(k, v) { s[k] = String(v); }, removeItem(k) { delete s[k]; }, clear() { s = {}; },
        }; })(),
    };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    const src = fs.readFileSync(path.join(__dirname, '..', 'unified_schedule_system.js'), 'utf8');
    vm.runInContext(src, sandbox, { filename: 'unified_schedule_system.js' });
    return sandbox;
}

// Camp state: NO facility anywhere hosts swim. 4 of 5 bunks are already
// swimming 600-645; we edit A1 into Swim at the same time.
function installFacilitylessCamp(w) {
    w.activityProperties = {};   // nothing configured — no Pool, no Swim special
    w.loadGlobalSettings = () => ({ app1: { fields: [], specialActivities: [] } });
    w.divisions = {
        Alef: { bunks: ['A1', 'A2', 'A3'] },
        Bet: { bunks: ['B1', 'B2'] },
    };
    w.divisionTimes = {
        Alef: [{ startMin: 600, endMin: 645, label: 'P1' }],
        Bet: [{ startMin: 600, endMin: 645, label: 'P1' }],
    };
    const swim = () => [{ field: 'Swim', _activity: 'Swim', _startMin: 600, _endMin: 645 }];
    w.scheduleAssignments = {
        A1: [{ field: 'Free', _activity: 'Free', _startMin: 600, _endMin: 645 }],
        A2: swim(), A3: swim(), B1: swim(), B2: swim(),
    };
}

test('facility-less Swim is unlimited in every post-edit gate', () => {
    const w = buildSandbox();
    installFacilitylessCamp(w);

    // The helper itself: Swim (unconfigured) is an uncapped label…
    assert.equal(w.isUncappedFacilitylessLabel('Swim', w.activityProperties), true);
    assert.equal(w.isUncappedFacilitylessLabel('swim', w.activityProperties), true);
    // …but an unconfigured NON-label name is not.
    assert.equal(w.isUncappedFacilitylessLabel('Gaga Pit', w.activityProperties), false);

    // Time-based availability: 4 concurrent swimmers must NOT make Swim busy.
    assert.equal(w.checkFieldAvailableByTime('Swim', 600, 645, 'A1', w.activityProperties), true,
        'Swim must stay available with other bunks swimming (was: capacity-1 default → busy)');

    // Conflict engine: co-swimming bunks are never conflicts.
    const check = w.checkLocationConflict('Swim', [0], 'A1');
    assert.equal(check.hasConflict, false, 'no conflict for facility-less Swim');
    assert.equal(check.maxCapacity, Infinity, 'capacity resolves as unlimited');
    assert.ok(check.currentUsage >= 1, 'usage is still visible/reported');
    assert.equal(check.canShare, true);

    // Cross-division check: no conflict either.
    const xdiv = w.checkCrossDivisionConflict('A1', 'Swim', 0);
    assert.equal(xdiv.conflict, false);

    // Field picker: Swim is offered OPEN (green), not busy/override.
    const picker = w.findFieldsForActivity('Swim', [0], 'Alef', 'A1', 600, 645);
    assert.equal(picker.none, false, 'Swim is offered (pseudo-location exists)');
    assert.equal(picker.busy.length, 0, 'Swim is never "in use"');
    assert.ok(picker.open.length >= 1, 'Swim appears as an open pick');
});

test('other direct-fill labels (Lunch) get the same unlimited treatment', () => {
    const w = buildSandbox();
    installFacilitylessCamp(w);
    ['A2', 'A3', 'B1'].forEach(b => {
        w.scheduleAssignments[b] = [{ field: 'Lunch', _activity: 'Lunch', _startMin: 600, _endMin: 645 }];
    });
    const check = w.checkLocationConflict('Lunch', [0], 'A1');
    assert.equal(check.hasConflict, false, 'co-lunching bunks are not conflicts');
    assert.equal(w.checkFieldAvailableByTime('Lunch', 600, 645, 'A1', w.activityProperties), true);
});

test('a REAL configured pool keeps its capacity (facility assigned -> cap enforced)', () => {
    const w = buildSandbox();
    installFacilitylessCamp(w);
    // Camp DID assign a facility: Pool field, capacity 2.
    w.activityProperties = { Pool: { sharableWith: { type: 'all', capacity: 2 } } };
    w.loadGlobalSettings = () => ({ app1: {
        fields: [{ name: 'Pool', activities: ['Swim'], sharableWith: { type: 'all', capacity: 2 } }],
        specialActivities: [],
    } });
    ['A2', 'A3'].forEach(b => {
        w.scheduleAssignments[b] = [{ field: 'Pool', _activity: 'Swim', _startMin: 600, _endMin: 645 }];
    });
    // The helper must NOT fire for a configured name…
    assert.equal(w.isUncappedFacilitylessLabel('Pool', w.activityProperties), false);
    // …so the real capacity (2, already full) still blocks.
    assert.equal(w.checkFieldAvailableByTime('Pool', 600, 645, 'A1', w.activityProperties), false,
        'configured pool at capacity must still read unavailable');
    const check = w.checkLocationConflict('Pool', [0], 'A1');
    assert.equal(check.hasConflict, true, 'configured pool at capacity still conflicts');
});

test('Swim GENERAL ACTIVITY on a facility -> the label follows ITS capacity', () => {
    const w = buildSandbox();
    installFacilitylessCamp(w);
    // Facility assigned the engine-preferred way: Swim GA with sharing rules.
    // Nothing under the literal name "Swim" in activityProperties.
    w.loadGlobalSettings = () => ({
        app1: { fields: [], specialActivities: [] },
        facilities: [{ name: 'Aquatics Center', generalActivities: [
            { name: 'Swim', quickType: 'swim', sharableWith: { type: 'all', capacity: 3 } },
        ] }],
    });
    const resolved = w.resolveLabelSharing('Swim', w.activityProperties);
    assert.notEqual(resolved, 'unlimited', 'GA-assigned swim is NOT facility-less');
    assert.equal(resolved.sharableWith.capacity, 3);
    // 4 co-swimmers > cap 3 -> conflict; the facility limit governs.
    const over = w.checkLocationConflict('Swim', [0], 'A1');
    assert.equal(over.hasConflict, true, '4 swimmers exceed the GA capacity of 3');
    assert.equal(over.maxCapacity, 3);
    assert.equal(w.checkFieldAvailableByTime('Swim', 600, 645, 'A1', w.activityProperties), false);
    // Under the cap: 2 co-swimmers -> fine.
    delete w.scheduleAssignments.B1;
    delete w.scheduleAssignments.B2;
    const under = w.checkLocationConflict('Swim', [0], 'A1');
    assert.equal(under.hasConflict, false, '2 swimmers fit the GA capacity of 3');
});

test('pool-named FIELD with sharing rules -> the label follows ITS capacity', () => {
    const w = buildSandbox();
    installFacilitylessCamp(w);
    w.loadGlobalSettings = () => ({ app1: {
        fields: [{ name: 'Pool', activities: [], sharableWith: { type: 'all', capacity: 2 } }],
        specialActivities: [],
    } });
    const resolved = w.resolveLabelSharing('Swim', w.activityProperties);
    assert.equal(resolved.sharableWith.capacity, 2, 'pool-named field sharing governs the Swim label');
    assert.equal(w.checkFieldAvailableByTime('Swim', 600, 645, 'A1', w.activityProperties), false,
        '4 swimmers exceed the pool field capacity of 2');
    assert.equal(w.checkLocationConflict('Swim', [0], 'A1').hasConflict, true);
});

test('legacy poolLaneCapacity is honored as an assigned cap', () => {
    const w = buildSandbox();
    installFacilitylessCamp(w);
    w.loadGlobalSettings = () => ({ app1: { fields: [], specialActivities: [], poolLaneCapacity: 2 } });
    const resolved = w.resolveLabelSharing('Swim', w.activityProperties);
    assert.equal(resolved.sharableWith.capacity, 2);
    assert.equal(w.checkLocationConflict('Swim', [0], 'A1').hasConflict, true, '4 swimmers exceed legacy cap 2');
});

test('pool-named field WITHOUT sharing config stays unlimited (engine parity)', () => {
    const w = buildSandbox();
    installFacilitylessCamp(w);
    // canUsePoolAtTime treats a pool field with no sharableWith as no config;
    // post-edit must agree.
    w.loadGlobalSettings = () => ({ app1: {
        fields: [{ name: 'Pool', activities: [] }], specialActivities: [],
    } });
    assert.equal(w.resolveLabelSharing('Swim', w.activityProperties), 'unlimited');
    assert.equal(w.checkLocationConflict('Swim', [0], 'A1').hasConflict, false);
});

test('unconfigured NON-label names keep the conservative capacity-1 default', () => {
    const w = buildSandbox();
    installFacilitylessCamp(w);
    w.scheduleAssignments.B1 = [{ field: 'Gaga Pit', _activity: 'Gaga', _startMin: 600, _endMin: 645 }];
    const check = w.checkLocationConflict('Gaga Pit', [0], 'A1');
    assert.equal(check.hasConflict, true, 'non-label unconfigured names are unchanged (cap 1)');
});

test('kill-switch __postEditUncappedLabels=false restores the old capacity-1 behavior', () => {
    const w = buildSandbox();
    installFacilitylessCamp(w);
    w.__postEditUncappedLabels = false;
    const check = w.checkLocationConflict('Swim', [0], 'A1');
    assert.equal(check.hasConflict, true, 'kill-switch restores the legacy conflict');
    assert.equal(w.checkFieldAvailableByTime('Swim', 600, 645, 'A1', w.activityProperties), false);
});
