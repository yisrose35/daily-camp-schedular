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

describe('AutoFeasibility.check — swim feasibility (Cause 2a)', () => {
    it('flags a grade where swim window can\'t fit all bunks', () => {
        const sb = setup();
        const cfg = buildBaseConfig();
        // 5 bunks need staggered 40-min swim, but only 1 viable period exists.
        cfg.divisions = {
            '1': { bunks: ['B1','B2','B3','B4','B5'], startTime: '9:00am', endTime: '3:00pm' }
        };
        cfg.layers = [
            { grade: '1', type: 'sport', qty: 1, op: '=', periodMin: 40, durationMin: 40 },
            { grade: '1', type: 'swim', startTime: '10:00am', endTime: '11:00am',
              periodMin: 40, durationMin: 40, fullGrade: false }
        ];
        // Configure bell-schedule periods (one fits swim, others don't)
        sb.window.campPeriods = {
            '1': [
                { startMin: 600, endMin: 640 },   // 10:00-10:40 — fits 40-min swim
                { startMin: 640, endMin: 680 }    // 10:40-11:20 — fits, but outside window (extends past 11:00)
            ]
        };
        const report = sb.window.AutoFeasibility.check(cfg);
        const swimEntry = (report.perSwim || []).find(s => s.grade === '1');
        assert.ok(swimEntry, 'perSwim entry must exist for grade 1');
        assert.equal(swimEntry.bunkCount, 5);
        assert.equal(swimEntry.isFullGrade, false);
        assert.equal(swimEntry.periodsInWindow, 1, 'only the first period fits within window');
        assert.equal(swimEntry.periodsNeeded, 5);
        assert.equal(swimEntry.deficit, 4);
        assert.equal(swimEntry.flagged, true);
        // Recommendation produced
        const swimRecs = report.recommendations.filter(r => r.target === 'grade:1:swim');
        assert.equal(swimRecs.length, 1);
        assert.equal(swimRecs[0].severity, 'high');
        assert.match(swimRecs[0].message, /staggered/);
    });

    it('does NOT flag a fullGrade swim layer with one fitting period', () => {
        const sb = setup();
        const cfg = buildBaseConfig();
        cfg.divisions = {
            '1': { bunks: ['B1','B2','B3','B4','B5'], startTime: '9:00am', endTime: '3:00pm' }
        };
        cfg.layers = [
            { grade: '1', type: 'sport', qty: 1, op: '=', periodMin: 40, durationMin: 40 },
            { grade: '1', type: 'swim', startTime: '10:00am', endTime: '11:00am',
              periodMin: 40, durationMin: 40, fullGrade: true }
        ];
        sb.window.campPeriods = {
            '1': [
                { startMin: 600, endMin: 640 }   // one fitting period suffices for fullGrade
            ]
        };
        const report = sb.window.AutoFeasibility.check(cfg);
        const swimEntry = (report.perSwim || []).find(s => s.grade === '1');
        assert.ok(swimEntry);
        assert.equal(swimEntry.isFullGrade, true);
        assert.equal(swimEntry.periodsNeeded, 1);
        assert.equal(swimEntry.flagged, false);
    });

    it('flags zero-period swim window even when fullGrade=true', () => {
        const sb = setup();
        const cfg = buildBaseConfig();
        cfg.divisions = {
            '1': { bunks: ['B1','B2'], startTime: '9:00am', endTime: '3:00pm' }
        };
        cfg.layers = [
            { grade: '1', type: 'sport', qty: 1, op: '=', periodMin: 40, durationMin: 40 },
            { grade: '1', type: 'swim', startTime: '10:00am', endTime: '10:20am',
              periodMin: 40, durationMin: 40, fullGrade: true }
        ];
        sb.window.campPeriods = {
            '1': [{ startMin: 600, endMin: 640 }]   // 40-min period, but ends at 10:40 = outside layer window 10:00-10:20
        };
        const report = sb.window.AutoFeasibility.check(cfg);
        const swimEntry = (report.perSwim || []).find(s => s.grade === '1');
        assert.ok(swimEntry);
        assert.equal(swimEntry.periodsInWindow, 0);
        assert.equal(swimEntry.flagged, true);
    });

    it('falls back to single-window candidate when no bell schedule', () => {
        const sb = setup();
        const cfg = buildBaseConfig();
        cfg.divisions = {
            '1': { bunks: ['B1','B2'], startTime: '9:00am', endTime: '3:00pm' }
        };
        cfg.layers = [
            { grade: '1', type: 'sport', qty: 1, op: '=', periodMin: 40, durationMin: 40 },
            { grade: '1', type: 'swim', startTime: '10:00am', endTime: '12:00pm',
              periodMin: 40, durationMin: 40, fullGrade: false }
        ];
        sb.window.campPeriods = {};   // explicitly no bell schedule
        const report = sb.window.AutoFeasibility.check(cfg);
        const swimEntry = (report.perSwim || []).find(s => s.grade === '1');
        assert.ok(swimEntry);
        // No bell schedule → one big window candidate. 2 bunks staggered needs 2 candidates;
        // we synthesize 1, so it should flag for staggered with bunkCount > 1.
        assert.equal(swimEntry.periodsInWindow, 1);
        assert.equal(swimEntry.deficit, 1);
        assert.equal(swimEntry.flagged, true);
    });
});

describe('AutoFeasibility.check — global Hall check (Cause 2b)', () => {
    it('flags a window where total demand exceeds total field count', () => {
        const sb = setup();
        const cfg = buildBaseConfig();
        // 10 bunks across two grades, 2 fields → demand 10, supply 2 at every slice
        cfg.divisions = {
            '1': { bunks: ['B1','B2','B3','B4','B5'], startTime: '9:00am', endTime: '3:00pm' },
            '2': { bunks: ['B6','B7','B8','B9','B10'], startTime: '9:00am', endTime: '3:00pm' }
        };
        cfg.layers = [
            { grade: '1', type: 'sport', qty: 1, op: '=', periodMin: 40, durationMin: 40 },
            { grade: '2', type: 'sport', qty: 1, op: '=', periodMin: 40, durationMin: 40 }
        ];
        const report = sb.window.AutoFeasibility.check(cfg);
        assert.ok(report.perWindow.length > 0, 'should detect global window deficit');
        const peakDeficit = Math.max(...report.perWindow.map(w => w.deficit));
        assert.equal(peakDeficit, 8, '10 bunks demanding, 2 fields available → deficit 8');
        // Recommendation should be at-window granularity
        const winRecs = report.recommendations.filter(r => r.cause === 2 && /^window:/.test(r.target));
        assert.ok(winRecs.length > 0);
        assert.equal(winRecs[0].severity, 'high');
        assert.match(winRecs[0].message, /field shortage/);
    });

    it('does NOT flag when supply meets demand', () => {
        const sb = setup();
        const cfg = buildBaseConfig();
        cfg.divisions = {
            '1': { bunks: ['B1','B2'], startTime: '9:00am', endTime: '3:00pm' }
        };
        cfg.layers = [
            { grade: '1', type: 'sport', qty: 1, op: '=', periodMin: 40, durationMin: 40 }
        ];
        // 2 bunks need sport, 2 fields available → no deficit
        const report = sb.window.AutoFeasibility.check(cfg);
        const deficitWindows = report.perWindow.filter(w => w.deficit > 0);
        assert.equal(deficitWindows.length, 0);
    });

    it('previous-version per-grade supply over-count regression: NOT flagged', () => {
        // Regression for v1.0 → v1.1: 2 grades each thinking they have all 2 fields.
        // Per-grade supply would say supply=2 ≥ demand=1 per grade → no deficit.
        // Global supply correctly says supply=2 < demand=2 (1 per grade × 2 grades).
        const sb = setup();
        const cfg = buildBaseConfig();
        cfg.divisions = {
            '1': { bunks: ['B1','B2'], startTime: '9:00am', endTime: '3:00pm' },
            '2': { bunks: ['B3','B4','B5'], startTime: '9:00am', endTime: '3:00pm' }
        };
        cfg.layers = [
            { grade: '1', type: 'sport', qty: 1, op: '=', periodMin: 40, durationMin: 40 },
            { grade: '2', type: 'sport', qty: 1, op: '=', periodMin: 40, durationMin: 40 }
        ];
        // 5 bunks → 5 demand, 2 fields → deficit 3
        const report = sb.window.AutoFeasibility.check(cfg);
        const peak = Math.max(...report.perWindow.map(w => w.deficit), 0);
        assert.equal(peak, 3, 'global Hall must see 5 bunks vs 2 fields');
    });
});

describe('AutoFeasibility.check — swim concurrent capacity (Fix v1.1)', () => {
    // Regression: pre v1.1 always assumed staggered (1 bunk per period). When a
    // swim field has sharableWith.capacity=N, ceil(bunks/N) periods suffice.

    it('does NOT flag when pool capacity covers all bunks in one period', () => {
        const sb = setup();
        const cfg = buildBaseConfig();
        // 4 bunks, pool capacity=4 → only 1 period needed → no deficit.
        cfg.divisions = {
            '1': { bunks: ['B1','B2','B3','B4'], startTime: '9:00am', endTime: '3:00pm' }
        };
        cfg.layers = [
            { grade: '1', type: 'sport', qty: 1, op: '=', periodMin: 40, durationMin: 40 },
            { grade: '1', type: 'swim', startTime: '10:00am', endTime: '11:00am',
              periodMin: 40, durationMin: 40, fullGrade: false }
        ];
        cfg.globalSettings.app1.fields = [
            { name: 'Pool', activities: ['Swim'], isIndoor: false,
              sharableWith: { type: 'same_division', capacity: 4 } }
        ];
        sb.window.campPeriods = {
            '1': [{ startMin: 600, endMin: 640 }]   // exactly 1 period in window
        };
        const report = sb.window.AutoFeasibility.check(cfg);
        const swimEntry = (report.perSwim || []).find(s => s.grade === '1');
        assert.ok(swimEntry, 'swim entry must exist');
        assert.equal(swimEntry.concurrentCapacity, 4, 'should read pool capacity=4');
        assert.equal(swimEntry.periodsNeeded, 1, 'ceil(4/4)=1 period needed');
        assert.equal(swimEntry.periodsInWindow, 1);
        assert.equal(swimEntry.flagged, false, 'should NOT flag when capacity covers all bunks');
    });

    it('uses ceil(bunks/capacity) to compute periodsNeeded for partial coverage', () => {
        const sb = setup();
        const cfg = buildBaseConfig();
        // 5 bunks, pool capacity=2 → ceil(5/2)=3 periods needed.
        cfg.divisions = {
            '1': { bunks: ['B1','B2','B3','B4','B5'], startTime: '9:00am', endTime: '3:00pm' }
        };
        cfg.layers = [
            { grade: '1', type: 'sport', qty: 1, op: '=', periodMin: 40, durationMin: 40 },
            { grade: '1', type: 'swim', startTime: '10:00am', endTime: '12:00pm',
              periodMin: 40, durationMin: 40, fullGrade: false }
        ];
        cfg.globalSettings.app1.fields = [
            { name: 'Pool', activities: ['Swim'], isIndoor: false,
              sharableWith: { type: 'same_division', capacity: 2 } }
        ];
        sb.window.campPeriods = {
            '1': [
                { startMin: 600, endMin: 640 },   // 10:00-10:40
                { startMin: 640, endMin: 680 },   // 10:40-11:20
                { startMin: 680, endMin: 720 }    // 11:20-12:00
            ]
        };
        const report = sb.window.AutoFeasibility.check(cfg);
        const swimEntry = (report.perSwim || []).find(s => s.grade === '1');
        assert.ok(swimEntry);
        assert.equal(swimEntry.concurrentCapacity, 2);
        assert.equal(swimEntry.periodsNeeded, 3, 'ceil(5/2)=3');
        assert.equal(swimEntry.periodsInWindow, 3);
        assert.equal(swimEntry.flagged, false, '3 periods available for 3 needed — ok');
    });

    it('flags when window periods < ceil(bunks/capacity)', () => {
        const sb = setup();
        const cfg = buildBaseConfig();
        // 6 bunks, capacity=2 → needs 3, only 2 in window → flagged.
        cfg.divisions = {
            '1': { bunks: ['B1','B2','B3','B4','B5','B6'], startTime: '9:00am', endTime: '3:00pm' }
        };
        cfg.layers = [
            { grade: '1', type: 'sport', qty: 1, op: '=', periodMin: 40, durationMin: 40 },
            { grade: '1', type: 'swim', startTime: '10:00am', endTime: '11:20am',
              periodMin: 40, durationMin: 40, fullGrade: false }
        ];
        cfg.globalSettings.app1.fields = [
            { name: 'Pool', activities: ['Swim'], isIndoor: false,
              sharableWith: { type: 'same_division', capacity: 2 } }
        ];
        sb.window.campPeriods = {
            '1': [
                { startMin: 600, endMin: 640 },   // 10:00-10:40
                { startMin: 640, endMin: 680 }    // 10:40-11:20 — exactly at window edge, fits
            ]
        };
        const report = sb.window.AutoFeasibility.check(cfg);
        const swimEntry = (report.perSwim || []).find(s => s.grade === '1');
        assert.ok(swimEntry);
        assert.equal(swimEntry.concurrentCapacity, 2);
        assert.equal(swimEntry.periodsNeeded, 3, 'ceil(6/2)=3');
        assert.equal(swimEntry.periodsInWindow, 2);
        assert.equal(swimEntry.deficit, 1);
        assert.equal(swimEntry.flagged, true);
    });

    it('falls back to capacity=1 when no swim field defined (staggered default)', () => {
        const sb = setup();
        const cfg = buildBaseConfig();
        // No swim field in globalSettings → swimPoolCap stays 1 → staggered assumed.
        cfg.globalSettings.app1.fields = [];   // no fields at all
        cfg.divisions = {
            '1': { bunks: ['B1','B2'], startTime: '9:00am', endTime: '3:00pm' }
        };
        cfg.layers = [
            { grade: '1', type: 'swim', startTime: '10:00am', endTime: '10:40am',
              periodMin: 40, durationMin: 40, fullGrade: false }
        ];
        sb.window.campPeriods = {
            '1': [{ startMin: 600, endMin: 640 }]   // 1 period, but 2 bunks staggered need 2
        };
        const report = sb.window.AutoFeasibility.check(cfg);
        const swimEntry = (report.perSwim || []).find(s => s.grade === '1');
        assert.ok(swimEntry);
        assert.equal(swimEntry.concurrentCapacity, 1);
        assert.equal(swimEntry.periodsNeeded, 2);
        assert.equal(swimEntry.flagged, true);
    });

    it('sharableWith.type="all" with no explicit capacity defaults to 999 (not flagged)', () => {
        // Regression: pre-flight was defaulting to 1 for any field without explicit
        // capacity. The scheduler defaults 'all'-type fields to 999 (unlimited sharing).
        // 8 bunks, type='all', no capacity → swimPoolCap=999 → needed=ceil(8/999)=1.
        const sb = setup();
        const cfg = buildBaseConfig();
        cfg.divisions = {
            '1': { bunks: ['B1','B2','B3','B4','B5','B6','B7','B8'],
                   startTime: '9:00am', endTime: '4:00pm' }
        };
        cfg.layers = [
            { grade: '1', type: 'swim', startTime: '10:00am', endTime: '3:00pm',
              periodMin: 40, durationMin: 40, fullGrade: false }
        ];
        cfg.globalSettings.app1.fields = [
            { name: 'Pool', activities: ['Swim'], isIndoor: false,
              sharableWith: { type: 'all' } }   // no explicit capacity
        ];
        sb.window.campPeriods = {
            '1': [
                { startMin: 600, endMin: 640 },   // 10:00-10:40
                { startMin: 640, endMin: 680 },   // 10:40-11:20
                { startMin: 680, endMin: 720 },   // 11:20-12:00
                { startMin: 720, endMin: 760 },   // 12:00-12:40
                { startMin: 760, endMin: 800 },   // 12:40-13:20
                { startMin: 800, endMin: 840 }    // 13:20-14:00
            ]   // 6 periods — fine for 1 needed
        };
        const report = sb.window.AutoFeasibility.check(cfg);
        const swimEntry = (report.perSwim || []).find(s => s.grade === '1');
        assert.ok(swimEntry, 'swim entry must exist');
        assert.equal(swimEntry.concurrentCapacity, 999, 'all-type pool → 999');
        assert.equal(swimEntry.periodsNeeded, 1, 'ceil(8/999)=1');
        assert.equal(swimEntry.flagged, false, 'should NOT flag for all-type pool');
    });

    it('sharableWith type not set and no capacity → defaults to 2 (not "all")', () => {
        // Regression guard: a field with no sharableWith at all defaults to 2 (not 999).
        // 8 bunks, no sharableWith → swimPoolCap=2 → needed=ceil(8/2)=4 periods.
        const sb = setup();
        const cfg = buildBaseConfig();
        cfg.divisions = {
            '1': { bunks: ['B1','B2','B3','B4','B5','B6','B7','B8'],
                   startTime: '9:00am', endTime: '4:00pm' }
        };
        cfg.layers = [
            { grade: '1', type: 'swim', startTime: '10:00am', endTime: '3:00pm',
              periodMin: 40, durationMin: 40, fullGrade: false }
        ];
        cfg.globalSettings.app1.fields = [
            { name: 'Pool', activities: ['Swim'], isIndoor: false }   // no sharableWith at all
        ];
        sb.window.campPeriods = {
            '1': [
                { startMin: 600, endMin: 640 },
                { startMin: 640, endMin: 680 },
                { startMin: 680, endMin: 720 }    // 3 periods — deficit=1 for needed=4
            ]
        };
        const report = sb.window.AutoFeasibility.check(cfg);
        const swimEntry = (report.perSwim || []).find(s => s.grade === '1');
        assert.ok(swimEntry, 'swim entry must exist');
        assert.equal(swimEntry.concurrentCapacity, 2, 'no sharableWith → defaults to 2');
        assert.equal(swimEntry.periodsNeeded, 4, 'ceil(8/2)=4');
        assert.equal(swimEntry.periodsInWindow, 3);
        assert.equal(swimEntry.deficit, 1);
        assert.equal(swimEntry.flagged, true, 'should flag when needed > available');
    });
});

describe('AutoFeasibility.forensics — cross-ref Cause 2 (Fix v1.1)', () => {
    // Regression: pre v1.1 only checked bunk-level pool flag (Cause 1). Frees
    // caused by swim deficits (Cause 2a) or window deficits (Cause 2b) were all
    // counted as "unexpected" even when pre-flight predicted them.

    it('counts Frees in swim-deficit grades as predicted (Cause 2a)', () => {
        const sb = setup();
        // Pre-flight says grade 1 swim was flagged; grade 2 was not.
        const preflight = {
            perBunk: {
                B1: { flagged: false, grade: '1', bunk: 'B1' },
                B2: { flagged: false, grade: '1', bunk: 'B2' },
                B3: { flagged: false, grade: '2', bunk: 'B3' }
            },
            perSwim: [
                { grade: '1', flagged: true },
                { grade: '2', flagged: false }
            ],
            perWindow: []
        };
        const sa = {
            B1: [{ field: 'Free', _activity: 'Free', _freeReason: 'capacity_deficit', _startMin: 600, _endMin: 640 }],
            B2: [{ field: 'Free', _activity: 'Free', _freeReason: 'capacity_deficit', _startMin: 640, _endMin: 680 }],
            B3: [{ field: 'Free', _activity: 'Free', _freeReason: 'capacity_deficit', _startMin: 600, _endMin: 640 }]
        };
        const r = sb.window.AutoFeasibility.forensics({ scheduleAssignments: sa, preflight });
        // B1 and B2 are in grade 1 (swim flagged) → predicted.
        // B3 is in grade 2 (swim not flagged) → unexpected.
        assert.equal(r.crossRef.predicted, 2, 'swim-deficit grade Frees must be predicted');
        assert.equal(r.crossRef.unexpected, 1, 'non-deficit grade Free must be unexpected');
    });

    it('counts Frees in window-deficit time slots as predicted (Cause 2b)', () => {
        const sb = setup();
        // Pre-flight says window 540-600 had a deficit.
        const preflight = {
            perBunk: {
                B1: { flagged: false, grade: '1', bunk: 'B1' },
                B2: { flagged: false, grade: '1', bunk: 'B2' }
            },
            perSwim: [],
            perWindow: [
                { startMin: 540, endMin: 600, deficit: 2 }   // 9:00-10:00 deficit
            ]
        };
        const sa = {
            B1: [{ field: 'Free', _activity: 'Free', _freeReason: 'capacity_deficit', _startMin: 540, _endMin: 580 }],
            B2: [{ field: 'Free', _activity: 'Free', _freeReason: 'capacity_deficit', _startMin: 620, _endMin: 660 }]
        };
        const r = sb.window.AutoFeasibility.forensics({ scheduleAssignments: sa, preflight });
        // B1's Free (540-580) overlaps the deficit window (540-600) → predicted.
        // B2's Free (620-660) is outside the deficit window → unexpected.
        assert.equal(r.crossRef.predicted, 1, 'Free inside deficit window must be predicted');
        assert.equal(r.crossRef.unexpected, 1, 'Free outside deficit window must be unexpected');
    });

    it('Cause 1 bunk flag still works alongside Cause 2 checks', () => {
        const sb = setup();
        const preflight = {
            perBunk: {
                B1: { flagged: true,  grade: '1', bunk: 'B1' },  // pool exhaustion
                B2: { flagged: false, grade: '2', bunk: 'B2' }   // no flag at all
            },
            perSwim: [],
            perWindow: []
        };
        const sa = {
            B1: [{ field: 'Free', _activity: 'Free', _freeReason: 'pool_exhausted' }],
            B2: [{ field: 'Free', _activity: 'Free', _freeReason: 'pool_exhausted' }]
        };
        const r = sb.window.AutoFeasibility.forensics({ scheduleAssignments: sa, preflight });
        assert.equal(r.crossRef.predicted, 1, 'B1 (pool flag) must be predicted');
        assert.equal(r.crossRef.unexpected, 1, 'B2 (no flag) must be unexpected');
    });

    it('Frees with no startMin are not matched by window deficit', () => {
        const sb = setup();
        const preflight = {
            perBunk: {
                B1: { flagged: false, grade: '1', bunk: 'B1' }
            },
            perSwim: [],
            perWindow: [{ startMin: 540, endMin: 600, deficit: 1 }]
        };
        const sa = {
            // startMin is null — cannot be matched to window
            B1: [{ field: 'Free', _activity: 'Free', _freeReason: 'capacity_deficit' }]
        };
        const r = sb.window.AutoFeasibility.forensics({ scheduleAssignments: sa, preflight });
        assert.equal(r.crossRef.unexpected, 1, 'null startMin cannot match window — unexpected');
        assert.equal(r.crossRef.predicted, 0);
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
