/**
 * Tests for getCustomActivitySharingInfo — the per-activity config resolver
 * that makes general activities work "like specials" (each activity carries
 * its own sharing/consecutive config, even when two activities share a
 * facility).
 *
 * Resolution chain (highest precedence first):
 *   1. Per-LAYER override (layer.customSharing from the Layer editor)
 *   2. Per-ACTIVITY config (facility.generalActivities[name])
 *   3. Per-FACILITY/FIELD fallback (field.sharableWith, field.consecutiveBunks)
 *   4. Default { not_sharable, cap 1, no consec }
 *
 * Run with: node --test tests/custom_activity_resolver.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---------------------------------------------------------------------------
// Boot a tiny sandbox just enough for scheduler_core_auto.js to load and
// expose window.getCustomActivitySharingInfo. The resolver accepts an `gs`
// argument so we can pass crafted globalSettings per test without needing the
// full pipeline.
// ---------------------------------------------------------------------------
function bootResolver() {
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
    // Minimal globalSettings — the resolver reads gs we pass per-call.
    sandbox.globalSettings = { app1: { fields: [] }, facilities: [] };
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
    sandbox.getAllGlobalSports = () => []; sandbox.getSportMetaData = () => ({}); sandbox.getBunkMetaData = () => ({});
    sandbox.getGlobalSpecialActivities = () => []; sandbox.getAllSpecialActivities = () => [];
    sandbox.getFacilities = () => [];

    vm.createContext(sandbox);

    // scheduler_core_auto.js has internal dependencies — load the minimum set
    // (same order as flow.html) until the resolver export is available.
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
    assert.strictEqual(typeof sandbox.getCustomActivitySharingInfo, 'function',
        'window.getCustomActivitySharingInfo must be exposed');
    return sandbox.getCustomActivitySharingInfo;
}

const resolve = bootResolver();

// ---------------------------------------------------------------------------
// Default — nothing configured anywhere
// ---------------------------------------------------------------------------
describe('getCustomActivitySharingInfo — default tier', () => {
    it('unknown activity at unknown field → not_sharable cap 1', () => {
        const r = resolve('Main Activity', 'Auditorium', null, { app1: { fields: [] }, facilities: [] });
        assert.strictEqual(r.shareType, 'not_sharable');
        assert.strictEqual(r.capacity, 1);
        assert.strictEqual(r.consecutiveBunks, false);
        assert.strictEqual(r.source, 'default');
    });
});

// ---------------------------------------------------------------------------
// Field tier — facility-level fallback (legacy behavior)
// ---------------------------------------------------------------------------
describe('getCustomActivitySharingInfo — field tier', () => {
    const gs = {
        app1: { fields: [{ name: 'Auditorium', sharableWith: { type: 'cross_division', capacity: 4, allowedPairs: { 'Harmony|Prop': true } }, consecutiveBunks: true }] },
        facilities: [{ name: 'Auditorium', generalActivities: [{ name: 'Morning Activity' }, { name: 'Main Activity' }] }]
    };

    it('ga with no per-activity sharing → falls back to field config', () => {
        const r = resolve('Morning Activity', 'Auditorium', null, gs);
        assert.strictEqual(r.shareType, 'cross_division');
        assert.strictEqual(r.capacity, 4);
        assert.deepStrictEqual(r.allowedPairs, { 'Harmony|Prop': true });
        assert.strictEqual(r.consecutiveBunks, true);    // field-level flag honored
        assert.strictEqual(r.source, 'field');
    });

    it('different ga at same field → same field config (both fall through)', () => {
        const r1 = resolve('Morning Activity', 'Auditorium', null, gs);
        const r2 = resolve('Main Activity', 'Auditorium', null, gs);
        assert.strictEqual(r1.shareType, r2.shareType);
        assert.strictEqual(r1.capacity, r2.capacity);
    });
});

// ---------------------------------------------------------------------------
// Activity tier — the user's stated requirement
// ---------------------------------------------------------------------------
describe('getCustomActivitySharingInfo — per-activity tier', () => {
    const gs = {
        app1: { fields: [{ name: 'Auditorium', sharableWith: { type: 'not_sharable', capacity: 1 }, consecutiveBunks: false }] },
        facilities: [{
            name: 'Auditorium',
            generalActivities: [
                {
                    name: 'Morning Activity',
                    sharableWith: { type: 'cross_division', capacity: 4, allowedPairs: { 'Harmony|Prop': true } },
                    consecutiveBunks: false
                },
                {
                    name: 'Main Activity',
                    sharableWith: { type: 'not_sharable', capacity: 1 },
                    consecutiveBunks: true
                }
            ]
        }]
    };

    it('Morning Activity (per-activity config) overrides facility not_sharable', () => {
        const r = resolve('Morning Activity', 'Auditorium', null, gs);
        assert.strictEqual(r.shareType, 'cross_division');
        assert.strictEqual(r.capacity, 4);
        assert.deepStrictEqual(r.allowedPairs, { 'Harmony|Prop': true });
        assert.strictEqual(r.source, 'activity');
    });

    it('Main Activity (different per-activity config) keeps not_sharable at same field', () => {
        const r = resolve('Main Activity', 'Auditorium', null, gs);
        assert.strictEqual(r.shareType, 'not_sharable');
        assert.strictEqual(r.capacity, 1);
        assert.strictEqual(r.consecutiveBunks, true);   // per-activity consec flag
        assert.strictEqual(r.source, 'activity');
    });

    it('two activities at same facility have INDEPENDENT configs', () => {
        const m = resolve('Morning Activity', 'Auditorium', null, gs);
        const mn = resolve('Main Activity', 'Auditorium', null, gs);
        assert.notStrictEqual(m.shareType, mn.shareType);
        assert.notStrictEqual(m.capacity, mn.capacity);
        assert.notStrictEqual(m.consecutiveBunks, mn.consecutiveBunks);
    });

    it('case-insensitive activity-name match', () => {
        const r = resolve('MORNING ACTIVITY', 'auditorium', null, gs);
        assert.strictEqual(r.source, 'activity');
    });
});

// ---------------------------------------------------------------------------
// Layer tier — per-layer override (already in Layer editor UI)
// ---------------------------------------------------------------------------
describe('getCustomActivitySharingInfo — per-layer override tier', () => {
    const gs = {
        app1: { fields: [{ name: 'Auditorium', sharableWith: { type: 'not_sharable', capacity: 1 } }] },
        facilities: [{
            name: 'Auditorium',
            generalActivities: [{
                name: 'Morning Activity',
                sharableWith: { type: 'cross_division', capacity: 4, allowedPairs: { 'Harmony|Prop': true } }
            }]
        }]
    };

    it('layer override.capacity wins over per-activity config', () => {
        const r = resolve('Morning Activity', 'Auditorium', { capacity: 2, allowedGrades: ['Harmony'] }, gs);
        assert.strictEqual(r.source, 'layer');
        assert.strictEqual(r.capacity, 2);
        // Single allowed grade → same_division share type
        assert.strictEqual(r.shareType, 'same_division');
    });

    it('layer override.allowedGrades builds pairs', () => {
        const r = resolve('Morning Activity', 'Auditorium', { capacity: 4, allowedGrades: ['Harmony', 'Prop', 'Minors'] }, gs);
        assert.strictEqual(r.source, 'layer');
        // 3 grades → cross_division with pairs Harmony|Prop, Harmony|Minors, Minors|Prop, and self-pairs
        assert.strictEqual(r.shareType, 'cross_division');
        assert.strictEqual(r.allowedPairs['Harmony|Prop'], true);
        assert.strictEqual(r.allowedPairs['Harmony|Minors'], true);
        assert.strictEqual(r.allowedPairs['Minors|Prop'], true);
    });

    it('layer override.allowedGrades with NO capacity → resolves room capacity, never 1', () => {
        // Sharing turned on across 3 grades but no capacity number typed on the layer.
        // Must NOT default to 1 (cap 1 silently forces a staggered, per-bunk placement
        // and drops grades). Resolve the real room capacity from the per-activity config.
        const r = resolve('Morning Activity', 'Auditorium', { allowedGrades: ['Harmony', 'Prop', 'Minors'] }, gs);
        assert.strictEqual(r.source, 'layer');
        assert.strictEqual(r.shareType, 'cross_division');
        assert.strictEqual(r.capacity, 4);   // pulled from ga sharableWith.capacity, NOT defaulted to 1
    });

    it('layer cross-division, no capacity AND no configured room cap → generous fallback (not 1)', () => {
        const gsNoCap = { app1: { fields: [{ name: 'Gym', sharableWith: { type: 'not_sharable', capacity: 1 } }] }, facilities: [] };
        const r = resolve('Whatever', 'Gym', { allowedGrades: ['A', 'B', 'C'] }, gsNoCap);
        assert.strictEqual(r.shareType, 'cross_division');
        assert.ok(r.capacity > 1, 'cross-division shared layer must not be throttled to capacity 1');
    });

    it('layer override only sets sharing; consecutive still falls through to ga', () => {
        const gsConsec = { ...gs, facilities: [{ ...gs.facilities[0], generalActivities: [{ ...gs.facilities[0].generalActivities[0], consecutiveBunks: true }] }] };
        const r = resolve('Morning Activity', 'Auditorium', { capacity: 2, allowedGrades: ['Harmony'] }, gsConsec);
        assert.strictEqual(r.source, 'layer');
        assert.strictEqual(r.consecutiveBunks, true);   // ga consec still wins for the consec field
    });
});

// ---------------------------------------------------------------------------
// Independence — the user's bug
// ---------------------------------------------------------------------------
describe('the original bug: two activities at same facility, independent configs', () => {
    it('Main and Morning at same Auditorium can have different rules', () => {
        const gs = {
            app1: { fields: [{ name: 'Auditorium', sharableWith: { type: 'not_sharable', capacity: 1 } }] },
            facilities: [{
                name: 'Auditorium',
                generalActivities: [
                    { name: 'Main Activity', sharableWith: { type: 'not_sharable', capacity: 1 } },
                    { name: 'Morning Activity', sharableWith: { type: 'cross_division', capacity: 8, allowedPairs: { 'Harmony|Prop': true, 'Harmony|Harmony': true, 'Prop|Prop': true } } }
                ]
            }]
        };
        const main = resolve('Main Activity', 'Auditorium', null, gs);
        const morn = resolve('Morning Activity', 'Auditorium', null, gs);
        assert.strictEqual(main.shareType, 'not_sharable');
        assert.strictEqual(main.capacity, 1);
        assert.strictEqual(morn.shareType, 'cross_division');
        assert.strictEqual(morn.capacity, 8);
        assert.strictEqual(morn.allowedPairs['Harmony|Prop'], true);
    });
});
