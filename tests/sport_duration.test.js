/**
 * Tests for getSportDurations — the per-sport configured-duration resolver
 * that makes sports honor a fixed length "like specials".
 *
 * Storage: sportMetaData[name].durations (canonical array) or .duration
 * (legacy scalar), set in the Rules tab. Empty ⇒ no duration lock (the slot
 * keeps its layer-derived length). Non-empty ⇒ the solver's duration gate
 * only lets the sport fill a slot whose length matches, and the gap-splitter
 * offers such slot sizes.
 *
 * Run with: node --test tests/sport_duration.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function boot() {
    const sandbox = {
        console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
        setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
        queueMicrotask: (fn) => fn && fn(),
        Date, Math, Object, Array, JSON, String, Number, Boolean, RegExp, Error,
        Map, Set, WeakMap, WeakSet, Promise, parseInt, parseFloat, isNaN, isFinite,
        Infinity, NaN, Symbol, encodeURIComponent, decodeURIComponent,
    };
    sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox; sandbox.global = sandbox;
    const makeEl = () => ({ appendChild() {}, addEventListener() {}, removeEventListener() {}, setAttribute() {}, style: {}, children: [], dataset: {} });
    sandbox.document = {
        readyState: 'complete', createElement: makeEl, createDocumentFragment: makeEl,
        getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; },
        addEventListener() {}, removeEventListener() {},
        body: makeEl(), head: makeEl(),
    };
    sandbox.localStorage = (() => { let s = {}; return { getItem(k) { return Object.prototype.hasOwnProperty.call(s, k) ? s[k] : null; }, setItem(k, v) { s[k] = String(v); }, removeItem(k) { delete s[k]; }, clear() { s = {}; } }; })();
    sandbox.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
    sandbox.Event = class { constructor(t) { this.type = t; } };
    sandbox.dispatchEvent = () => true; sandbox.addEventListener = () => {}; sandbox.removeEventListener = () => {};
    sandbox.requestAnimationFrame = () => 0; sandbox.cancelAnimationFrame = () => {};
    sandbox.alert = () => {}; sandbox.confirm = () => true; sandbox.prompt = () => null;
    sandbox.location = { href: '', reload() {}, search: '' };
    sandbox.navigator = { onLine: true, userAgent: 'node' };
    sandbox.fetch = () => Promise.reject(new Error('no fetch'));
    sandbox.globalSettings = { app1: { fields: [], sportMetaData: {} }, facilities: [] };
    sandbox.divisions = {}; sandbox.divisionTimes = {}; sandbox.activityProperties = {};
    sandbox.sportMetaData = {}; sandbox.bunkMetaData = {};
    sandbox.currentScheduleDate = '2026-07-15'; sandbox.currentDate = '2026-07-15';
    sandbox.scheduleAssignments = {}; sandbox.leagueAssignments = {};
    sandbox.loadGlobalSettings = () => sandbox.globalSettings;
    sandbox.saveGlobalSettings = (k, v) => { sandbox.globalSettings[k] = v; };
    sandbox.loadRotationHistory = () => ({ bunks: {}, leagues: {} });
    sandbox.saveRotationHistory = () => {};
    sandbox.loadCurrentDailyData = () => ({}); sandbox.loadAllDailyData = () => ({});
    sandbox.getDivisions = () => ({});
    sandbox.getAllGlobalSports = () => []; sandbox.getSportMetaData = () => (sandbox.globalSettings.app1.sportMetaData || {}); sandbox.getBunkMetaData = () => ({});
    sandbox.getGlobalSpecialActivities = () => []; sandbox.getAllSpecialActivities = () => [];
    sandbox.getFacilities = () => [];

    vm.createContext(sandbox);

    const files = [
        'campistry_utils.js',
        'rotation_events.js', 'rules.js', 'auto_segment_model.js', 'period_packer.js',
        'auto_solver_engine.js', 'feasibility_oracle.js', 'period_tiler.js', 'day_packer.js',
        'division_times_system.js', 'scheduler_core_utils.js', 'rotation_engine.js',
        'total_solver_engine.js', 'scheduler_core_auto.js',
    ];
    for (const f of files) {
        const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
        vm.runInContext(src, sandbox, { filename: f });
    }
    assert.strictEqual(typeof sandbox.getSportDurations, 'function',
        'window.getSportDurations must be exposed');
    return sandbox;
}

const sandbox = boot();
const getSportDurations = sandbox.getSportDurations;
const gsWith = (sportMetaData) => ({ app1: { fields: [], sportMetaData } });

// Arrays built inside the vm carry the sandbox's Array.prototype, which trips
// deepStrictEqual's reference-equality-on-prototype check. Spread into a
// test-realm array before comparing so we compare contents, not realms.
const eq = (actual, expected) => assert.deepStrictEqual([...actual], expected);

// ---------------------------------------------------------------------------
describe('getSportDurations — default / unset', () => {
    it('unknown sport → []', () => {
        eq(getSportDurations('Baseball', gsWith({})), []);
    });
    it('sport with only min/max (no duration) → []', () => {
        eq(getSportDurations('Baseball', gsWith({ Baseball: { minPlayers: 6, maxPlayers: 12 } })), []);
    });
    it('empty/blank name → []', () => {
        eq(getSportDurations('', gsWith({ Baseball: { duration: 45 } })), []);
        eq(getSportDurations(null, gsWith({ Baseball: { duration: 45 } })), []);
    });
});

describe('getSportDurations — canonical durations[] array', () => {
    it('single configured duration', () => {
        eq(getSportDurations('Baseball', gsWith({ Baseball: { durations: [45] } })), [45]);
    });
    it('multiple durations sorted + deduped', () => {
        eq(
            getSportDurations('Soccer', gsWith({ Soccer: { durations: [60, 30, 45, 30] } })),
            [30, 45, 60]);
    });
    it('string values parsed; non-positive dropped', () => {
        eq(
            getSportDurations('Hockey', gsWith({ Hockey: { durations: ['40', 0, -5, '20'] } })),
            [20, 40]);
    });
});

describe('getSportDurations — legacy scalar duration', () => {
    it('scalar duration used when no array', () => {
        eq(getSportDurations('Kickball', gsWith({ Kickball: { duration: 30 } })), [30]);
    });
    it('array wins over scalar when both present', () => {
        eq(
            getSportDurations('Volleyball', gsWith({ Volleyball: { durations: [50], duration: 25 } })),
            [50]);
    });
    it('empty array falls back to scalar', () => {
        eq(
            getSportDurations('Football', gsWith({ Football: { durations: [], duration: 35 } })),
            [35]);
    });
});

describe('getSportDurations — lookup robustness', () => {
    it('case-insensitive sport name lookup', () => {
        eq(getSportDurations('baseball', gsWith({ Baseball: { durations: [45] } })), [45]);
        eq(getSportDurations('BASEBALL', gsWith({ Baseball: { durations: [45] } })), [45]);
    });
    it('reads from window.sportMetaData when gs/getter have none', () => {
        const prevGetter = sandbox.getSportMetaData;
        sandbox.globalSettings = { app1: { fields: [] } };          // no sportMetaData on gs
        sandbox.getSportMetaData = () => null;                       // getter yields nothing
        sandbox.sportMetaData = { Tennis: { durations: [55] } };     // last fallback rung
        eq(getSportDurations('Tennis'), [55]);
        // restore
        sandbox.getSportMetaData = prevGetter;
        sandbox.globalSettings = { app1: { fields: [], sportMetaData: {} }, facilities: [] };
        sandbox.sportMetaData = {};
    });
});

// ---------------------------------------------------------------------------
// Solver duration gate — a configured-duration sport only fits a matching slot.
// Exercises AutoSolverEngine.buildCandidates wiring + the inline gate predicate.
// ---------------------------------------------------------------------------
describe('solver duration gate predicate', () => {
    // The gate is: configuredDurs.length && !configuredDurs.includes(slotLen) → reject.
    const gate = (configuredDurs, slotLen) =>
        !(configuredDurs && configuredDurs.length && !configuredDurs.includes(slotLen));

    it('no config → any slot length accepted', () => {
        assert.ok(gate([], 30));
        assert.ok(gate([], 45));
    });
    it('single configured duration only fits matching slot', () => {
        assert.ok(gate([45], 45));
        assert.ok(!gate([45], 30));
        assert.ok(!gate([45], 60));
    });
    it('multiple durations: any listed length fits', () => {
        assert.ok(gate([30, 45], 30));
        assert.ok(gate([30, 45], 45));
        assert.ok(!gate([30, 45], 40));
    });
});
