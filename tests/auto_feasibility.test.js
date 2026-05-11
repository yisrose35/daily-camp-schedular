/**
 * Tests for: auto_feasibility.js — Phase A pre-flight diagnostic.
 *
 * Run with:  node --test tests/auto_feasibility.test.js
 *
 * Phase A is observation-only (no writes), so these tests assert:
 *   1. check() correctly identifies Cause-1 pool exhaustion (bunk has more
 *      sport-slots needed than unique sports available).
 *   2. check() correctly identifies a window-level field deficit (Cause 2).
 *   3. check() flags scarce specials with high contention (Cause 3).
 *   4. Recommendations are produced for every flagged item.
 *   5. forensics() categorizes Free blocks by _freeReason and cross-references
 *      against the pre-flight report.
 *
 * Follows the vm-sandbox pattern from tests/auto_commit_write_guard.test.js
 * (Slice 3 audit).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeSandbox() {
    const win = {};
    const sandbox = {
        window: win,
        // The module prints summaries via console.log; mute them in tests.
        console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
        setTimeout, clearTimeout,
        Date, Math, Object, Array, JSON, String, Number, Boolean,
        Map, Set, Promise, parseInt, parseFloat, isNaN, isFinite,
        Infinity, NaN, Symbol
    };
    sandbox.global = sandbox;
    vm.createContext(sandbox);
    return sandbox;
}

function loadInto(filename, ctx) {
    const src = fs.readFileSync(path.join(__dirname, '..', filename), 'utf8');
    vm.runInContext(src, ctx, { filename });
}

function setup() {
    const sb = makeSandbox();
    // SchedulerCoreUtils.parseTimeToMinutes — used by parseTime in the module.
    sb.window.SchedulerCoreUtils = {
        parseTimeToMinutes: (s) => {
            if (typeof s === 'number') return s;
            if (typeof s !== 'string') return null;
            const m = s.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
            if (!m) return null;
            let h = parseInt(m[1], 10);
            const min = parseInt(m[2] || '0', 10);
            const ap = m[3];
            if (ap === 'pm' && h !== 12) h += 12;
            if (ap === 'am' && h === 12) h = 0;
            return h * 60 + min;
        }
    };
    loadInto('auto_feasibility.js', sb);
    return sb;
}

// -----------------------------------------------------------------------------
// Test fixtures — minimal but realistic config shapes.
// -----------------------------------------------------------------------------

function buildBaseConfig() {
    return {
        divisions: {
            '1': {
                bunks: ['B1', 'B2'],
                startTime: '9:00am',
                endTime: '3:00pm'
            }
        },
        layers: [
            // grade 1 sport layer requiring at least 4 unique sports
            { grade: '1', type: 'sport', qty: 4, op: '>=', periodMin: 40, durationMin: 40 }
        ],
        globalSettings: {
            app1: {
                fields: [
                    { name: 'Court A', activities: ['Basketball'], isIndoor: true, sharableWith: { type: 'same_division', capacity: 2 } },
                    { name: 'Court B', activities: ['Tennis'],     isIndoor: true, sharableWith: { type: 'same_division', capacity: 2 } }
                ],
                specialActivities: [],
                disabledFields: []
            }
        },
        activityProperties: {},
        currentDate: '2024-07-15',
        dayName: 'Monday',
        isRainy: false,
        disabledFields: [],
        disabledSportsByField: {}
    };
}

// -----------------------------------------------------------------------------
// Tests.
// -----------------------------------------------------------------------------

describe('AutoFeasibility — exposure', () => {
    it('exposes window.AutoFeasibility with check + forensics', () => {
        const sb = setup();
        assert.ok(sb.window.AutoFeasibility, 'AutoFeasibility must be on window');
        assert.equal(typeof sb.window.AutoFeasibility.check, 'function');
        assert.equal(typeof sb.window.AutoFeasibility.forensics, 'function');
        assert.equal(typeof sb.window.AutoFeasibility.VERSION, 'string');
    });
});

describe('AutoFeasibility.check — Cause 1 (pool exhaustion)', () => {
    it('flags a bunk whose sport-slots-needed exceeds unique sport pool', () => {
        const sb = setup();
        const cfg = buildBaseConfig();
        // Use `op: '='` so cap=qty=4 (no time-driven overshoot). Pool = 2 (Basketball + Tennis).
        // Expected: every bunk flagged with poolDeficit = 2.
        cfg.layers = [
            { grade: '1', type: 'sport', qty: 4, op: '=', periodMin: 40, durationMin: 40 }
        ];
        const report = sb.window.AutoFeasibility.check(cfg);

        assert.equal(report.feasible, false, 'overall feasibility should be false');
        assert.ok(report.perBunk.B1, 'B1 entry must exist');
        assert.ok(report.perBunk.B2, 'B2 entry must exist');
        assert.equal(report.perBunk.B1.poolSize, 2, 'pool must include Basketball + Tennis');
        assert.equal(report.perBunk.B1.sportSlotsNeeded, 4, 'qty=4 op== cap=4');
        assert.equal(report.perBunk.B1.poolDeficit, 2);
        assert.equal(report.perBunk.B1.flagged, true);
        assert.equal(report.summary.totalBunksAtRisk, 2);
        assert.equal(report.summary.predictedMinFrees, 4, '2 deficit × 2 bunks');
    });

    it('correctly handles >= operator (time-limited upper bound)', () => {
        const sb = setup();
        const cfg = buildBaseConfig();
        // Default config: qty=4, op=>=, 6-hour day, 40-min sports → upper bound 9 slots.
        // Pool = 2 → predicted deficit = 9 - 2 = 7.
        const report = sb.window.AutoFeasibility.check(cfg);
        assert.equal(report.perBunk.B1.sportSlotsNeeded, 9, 'time-derived upper bound for >= op');
        assert.equal(report.perBunk.B1.poolDeficit, 7);
    });

    it('does NOT flag a bunk whose pool meets demand', () => {
        const sb = setup();
        const cfg = buildBaseConfig();
        cfg.layers = [
            { grade: '1', type: 'sport', qty: 2, op: '=', periodMin: 40, durationMin: 40 }
        ];
        const report = sb.window.AutoFeasibility.check(cfg);
        // 2 fields → pool=2; qty=2 op== → need 2 slots; deficit 0.
        assert.equal(report.perBunk.B1.poolSize, 2);
        assert.equal(report.perBunk.B1.sportSlotsNeeded, 2);
        assert.equal(report.perBunk.B1.poolDeficit, 0);
        assert.equal(report.perBunk.B1.flagged, false);
        assert.equal(report.summary.totalBunksAtRisk, 0);
    });

    it('respects rainy day — outdoor fields excluded from pool', () => {
        const sb = setup();
        const cfg = buildBaseConfig();
        cfg.globalSettings.app1.fields = [
            { name: 'Outdoor Court', activities: ['Soccer'],     isIndoor: false, sharableWith: { type: 'same_division', capacity: 2 } },
            { name: 'Gym',           activities: ['Basketball'], isIndoor: true,  sharableWith: { type: 'same_division', capacity: 2 } }
        ];
        cfg.isRainy = true;
        // Only Gym counts → pool size 1.
        const report = sb.window.AutoFeasibility.check(cfg);
        assert.equal(report.perBunk.B1.poolSize, 1, 'outdoor field excluded on rainy day');
    });

    it('respects disabled fields — disabled fields excluded from pool', () => {
        const sb = setup();
        const cfg = buildBaseConfig();
        cfg.disabledFields = ['Court B'];
        const report = sb.window.AutoFeasibility.check(cfg);
        assert.equal(report.perBunk.B1.poolSize, 1);
    });

    it('respects per-field daily sport restrictions', () => {
        const sb = setup();
        const cfg = buildBaseConfig();
        cfg.disabledSportsByField = { 'Court B': ['Tennis'] };
        const report = sb.window.AutoFeasibility.check(cfg);
        // Tennis disabled on its only field → not in pool.
        assert.equal(report.perBunk.B1.poolSize, 1);
        assert.ok(!report.perBunk.B1.uniqueSportPool.includes('Tennis'));
    });

    it('respects grade access restrictions on fields', () => {
        const sb = setup();
        const cfg = buildBaseConfig();
        cfg.globalSettings.app1.fields[1].accessRestrictions = { enabled: true, divisions: { '2': [] } };
        // Court B (Tennis) only allowed for grade 2, not grade 1.
        const report = sb.window.AutoFeasibility.check(cfg);
        assert.equal(report.perBunk.B1.poolSize, 1);
        assert.ok(!report.perBunk.B1.uniqueSportPool.includes('Tennis'));
    });
});

describe('AutoFeasibility.check — recommendations', () => {
    it('produces a high-severity recommendation for each flagged bunk', () => {
        const sb = setup();
        const cfg = buildBaseConfig();
        const report = sb.window.AutoFeasibility.check(cfg);
        const bunkRecs = report.recommendations.filter(r => r.cause === 1);
        assert.equal(bunkRecs.length, 2, 'one rec per flagged bunk');
        bunkRecs.forEach(r => {
            assert.equal(r.severity, 'high');
            assert.match(r.message, /unique sport slots/);
            assert.match(r.action, /Enable additional sports/);
        });
    });
});

describe('AutoFeasibility.check — special contention (Cause 3)', () => {
    it('flags a scarce special with high contention', () => {
        const sb = setup();
        const cfg = buildBaseConfig();
        cfg.globalSettings.app1.specialActivities = [
            { name: 'Pottery', sharableWith: { type: 'not_sharable', capacity: 1 }, availableDays: ['Monday'] }
        ];
        cfg.layers.push(
            { grade: '1', type: 'special', event: 'Pottery', qty: 1, op: '>=', periodMin: 40 }
        );
        // 2 bunks demanding Pottery, capacity 1 → contention 2.
        const report = sb.window.AutoFeasibility.check(cfg);
        const spec = report.perSpecial['Pottery'];
        assert.ok(spec, 'Pottery must appear in perSpecial');
        assert.equal(spec.capacity, 1);
        assert.equal(spec.totalBunksDemanding, 2);
        assert.equal(spec.isScarce, true);
        assert.ok(spec.contentionRatio > 1);
        const specialRecs = report.recommendations.filter(r => r.cause === 3);
        assert.ok(specialRecs.length >= 1, 'should produce special contention rec');
    });
});

describe('AutoFeasibility.check — determinism', () => {
    it('produces identical output for identical input across runs', () => {
        const sbA = setup();
        const sbB = setup();
        const cfgA = buildBaseConfig();
        const cfgB = buildBaseConfig();
        const rA = sbA.window.AutoFeasibility.check(cfgA);
        const rB = sbB.window.AutoFeasibility.check(cfgB);
        // generatedAt timestamps differ; compare structurally.
        const stripTs = (r) => { const x = JSON.parse(JSON.stringify(r)); delete x.summary.generatedAt; return x; };
        assert.deepEqual(stripTs(rA), stripTs(rB));
    });
});

describe('AutoFeasibility.forensics', () => {
    it('returns zero Frees for a fully-filled schedule', () => {
        const sb = setup();
        const sa = {
            B1: [
                { field: 'Court A', sport: 'Basketball', _activity: 'Basketball', _autoSolved: true }
            ]
        };
        const r = sb.window.AutoFeasibility.forensics({ scheduleAssignments: sa });
        assert.equal(r.totalFrees, 0);
    });

    it('categorizes Frees by _freeReason and lists them per bunk', () => {
        const sb = setup();
        const sa = {
            B1: [
                { field: 'Free', _activity: 'Free', _freeReason: 'pool_exhausted',  _startMin: 540, _endMin: 580 },
                { field: 'Free', _activity: 'Free', _freeReason: 'capacity_deficit', _startMin: 580, _endMin: 620 }
            ],
            B2: [
                { field: 'Free', _activity: 'Free', _freeReason: 'pool_exhausted',  _startMin: 540, _endMin: 580 }
            ]
        };
        const r = sb.window.AutoFeasibility.forensics({ scheduleAssignments: sa });
        assert.equal(r.totalFrees, 3);
        assert.equal(r.byReason.pool_exhausted, 2);
        assert.equal(r.byReason.capacity_deficit, 1);
        assert.equal(r.byBunk.B1.length, 2);
        assert.equal(r.byBunk.B2.length, 1);
    });

    it('cross-references against a pre-flight report', () => {
        const sb = setup();
        // Build a pre-flight report that flagged B1 but not B2.
        const preflight = {
            perBunk: {
                B1: { flagged: true,  bunk: 'B1' },
                B2: { flagged: false, bunk: 'B2' }
            }
        };
        const sa = {
            B1: [{ field: 'Free', _activity: 'Free', _freeReason: 'pool_exhausted' }],
            B2: [{ field: 'Free', _activity: 'Free', _freeReason: 'no_augmenting_path' }]
        };
        const r = sb.window.AutoFeasibility.forensics({ scheduleAssignments: sa, preflight });
        assert.equal(r.crossRef.predicted, 1, 'B1 was predicted');
        assert.equal(r.crossRef.unexpected, 1, 'B2 was not predicted');
    });

    it('treats missing _freeReason as "unknown"', () => {
        const sb = setup();
        const sa = {
            B1: [{ field: 'Free', _activity: 'Free' }]   // no reason stamped
        };
        const r = sb.window.AutoFeasibility.forensics({ scheduleAssignments: sa });
        assert.equal(r.byReason.unknown, 1);
    });

    it('skips continuation entries and filled entries', () => {
        const sb = setup();
        const sa = {
            B1: [
                { field: 'Court A', sport: 'Basketball' },                 // filled — skip
                { field: 'Free', _activity: 'Free', continuation: true },   // continuation — skip
                { field: 'Free', _activity: 'Free', _freeReason: 'pool_exhausted' }
            ]
        };
        const r = sb.window.AutoFeasibility.forensics({ scheduleAssignments: sa });
        assert.equal(r.totalFrees, 1);
    });
});

describe('AutoFeasibility — internal helpers', () => {
    // Note: assert.deepEqual against vm-sandbox return values fails on
    // prototype-identity in strict mode. Field-by-field comparison instead.
    function assertParseEq(actual, expected, msg) {
        assert.equal(actual.floor, expected.floor, (msg || '') + ' floor mismatch');
        assert.equal(actual.cap, expected.cap, (msg || '') + ' cap mismatch');
    }

    it('parseQtyOp handles separate qty/op shapes', () => {
        const sb = setup();
        const p = sb.window.AutoFeasibility._internal.parseQtyOp;
        assertParseEq(p({ qty: 2, op: '>=' }),        { floor: 2, cap: Infinity });
        assertParseEq(p({ quantity: 3, operator: '=' }), { floor: 3, cap: 3 });
        assertParseEq(p({ qty: 2, op: '<=' }),        { floor: 0, cap: 2 });
    });

    it('parseQtyOp handles combined shorthand', () => {
        const sb = setup();
        const p = sb.window.AutoFeasibility._internal.parseQtyOp;
        assertParseEq(p({ qty: '2>' }), { floor: 2, cap: Infinity });
        assertParseEq(p({ qty: '=1' }), { floor: 1, cap: 1 });
        assertParseEq(p({ qty: '3<' }), { floor: 0, cap: 3 });
    });
});
