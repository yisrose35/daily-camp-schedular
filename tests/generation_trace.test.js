/**
 * Tests for: generation_trace.js (the "generation brain trace") and its
 * rotation_engine.js instrumentation.
 *
 * Run with:  node --test tests/generation_trace.test.js
 *
 * What must hold:
 *  1. Assigning window.runAutoScheduler AFTER the trace module loads still
 *     gets wrapped (accessor-property arming) — a trace begins and ends
 *     around every generation call, capturing success/failure.
 *  2. While a trace is active, RotationEngine.calculateRotationScore feeds
 *     per-(bunk, activity, slot) score breakdowns into the trace.
 *  3. Hard blocks record a machine-readable reason (e.g. maxUsage-cap,
 *     frequencyDays-cooldown) in trace.blocks AND on the score record.
 *  4. getRankedActivities records the ranked candidate list.
 *  5. No trace object grows while GenTrace is inactive (zero overhead).
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
        console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
        setTimeout, clearTimeout,
        Date, Math, Object, Array, JSON, String, Number, Boolean,
        Map, Set, Promise, parseInt, parseFloat, isNaN, isFinite,
        Infinity, NaN, Symbol
    };
    sandbox.global = sandbox;
    vm.createContext(sandbox);
    sandbox.window.currentScheduleDate = '2026-07-15';
    return sandbox;
}

function loadInto(filename, ctx) {
    const src = fs.readFileSync(path.join(__dirname, '..', filename), 'utf8');
    vm.runInContext(src, ctx, { filename });
}

function setup() {
    const sb = makeSandbox();
    sb.window.historicalCounts = {};
    sb.window.manualUsageOffsets = {};
    sb.window.scheduleAssignments = {};
    sb.window.activityProperties = {};
    sb.window.loadRotationHistory = () => ({ bunks: {}, leagues: {} });
    sb.window.loadGlobalSettings = () => ({
        app1: {
            fields: [{ name: 'Field A', activities: ['Soccer', 'Basketball', 'Hockey'] }],
            specialActivities: [{ name: 'Canteen' }]
        }
    });
    sb.window.loadAllDailyData = () => ({});
    sb.window.divisions = { Juniors: { bunks: ['Bunk 1', 'Bunk 2'] } };
    loadInto('generation_trace.js', sb);
    loadInto('rotation_engine.js', sb);
    return sb;
}

describe('generation_trace — entry-point arming', () => {
    it('wraps runAutoScheduler assigned after load and records begin/end', async () => {
        const sb = setup();
        const win = sb.window;
        let ran = false;
        // Simulate scheduler_core_auto.js assigning the entry point
        win.runAutoScheduler = async function (layers, options) {
            ran = true;
            assert.equal(win.GenTrace.active, true, 'trace must be active during generation');
            return true;
        };
        const res = await win.runAutoScheduler([], { allowedDivisions: ['Juniors'] });
        assert.equal(res, true);
        assert.equal(ran, true);
        assert.equal(win.GenTrace.active, false, 'trace must end after generation');
        assert.equal(win.GenTrace.traces.length, 1);
        const tr = win.GenTrace.traces[0];
        assert.equal(tr.result.success, true);
        assert.equal(tr.meta.entry, 'runAutoScheduler');
        assert.deepEqual(tr.meta.options, { allowedDivisions: ['Juniors'] });
        assert.ok(tr.counts, 'counts summary present');
    });

    it('records a failed generation (thrown error) and re-throws', async () => {
        const sb = setup();
        const win = sb.window;
        win.runAutoScheduler = async function () { throw new Error('boom'); };
        await assert.rejects(() => win.runAutoScheduler(), /boom/);
        assert.equal(win.GenTrace.active, false);
        assert.equal(win.GenTrace.traces[0].result.success, false);
        assert.match(win.GenTrace.traces[0].result.error, /boom/);
    });

    it('re-assignment (e.g. pinned-preservation hook) wraps once, no nested traces', async () => {
        const sb = setup();
        const win = sb.window;
        win.runAutoScheduler = async function () { return true; };
        // Simulate a second module wrapping the (already-wrapped) entry point
        const orig = win.runAutoScheduler;
        win.runAutoScheduler = async function (...args) { return orig.apply(this, args); };
        await win.runAutoScheduler();
        assert.equal(win.GenTrace.traces.length, 1, 'exactly one trace per generation');
    });
});

describe('generation_trace — rotation engine instrumentation', () => {
    it('captures score breakdowns and ranked lists while active', () => {
        const sb = setup();
        const win = sb.window;
        win.GenTrace.begin({ entry: 'test' });
        const ranked = win.RotationEngine.getRankedActivities({
            bunkName: 'Bunk 1', divisionName: 'Juniors', beforeSlotIndex: 0,
            availableActivities: ['Soccer', 'Basketball', 'Hockey'],
            activityProperties: {}
        });
        assert.ok(ranked.length === 3);
        win.GenTrace.end({ success: true });
        const tr = win.GenTrace.traces[0];
        assert.ok(tr.counts.scores >= 3, 'score breakdowns recorded');
        assert.equal(tr.ranks.length, 1, 'ranked list recorded');
        assert.equal(tr.ranks[0].bunk, 'Bunk 1');
        assert.equal(tr.ranks[0].ranked.length, 3);
        const key = Object.keys(tr.scores).find(k => k.startsWith('Bunk 1|Soccer|'));
        assert.ok(key, 'per bunk|activity|slot score key exists');
        const rec = tr.scores[key];
        for (const comp of ['recency', 'streak', 'frequency', 'variety', 'distribution', 'coverage', 'limit', 'total']) {
            assert.ok(comp in rec, 'component present: ' + comp);
        }
    });

    it('records hard-block reasons (maxUsage-cap) in blocks and on the score record', () => {
        const sb = setup();
        const win = sb.window;
        win.historicalCounts = { 'Bunk 1': { Canteen: 5 } };
        win.loadGlobalSettings = () => ({
            app1: {
                fields: [{ name: 'Field A', activities: ['Soccer'] }],
                specialActivities: [{ name: 'Canteen' }]
            },
            historicalCounts: { 'Bunk 1': { Canteen: 5 } }
        });
        win.GenTrace.begin({ entry: 'test' });
        const score = win.RotationEngine.calculateRotationScore({
            bunkName: 'Bunk 1', activityName: 'Canteen', divisionName: 'Juniors',
            beforeSlotIndex: 0, allActivities: null,
            activityProperties: { Canteen: { maxUsage: 2 } }
        });
        win.GenTrace.end({ success: true });
        assert.equal(score, Infinity, 'over-cap activity must be blocked');
        const tr = win.GenTrace.traces[0];
        const blk = tr.blocks.find(b => b.activity === 'Canteen' && b.bunk === 'Bunk 1');
        assert.ok(blk, 'block recorded');
        assert.equal(blk.reason, 'maxUsage-cap');
        assert.equal(blk.detail.maxUsage, 2);
        const key = Object.keys(tr.scores).find(k => k.startsWith('Bunk 1|Canteen|'));
        assert.ok(key, 'blocked score record exists');
        assert.equal(tr.scores[key].blocked, true);
        assert.equal(tr.scores[key].blockReason, 'maxUsage-cap');
    });

    it('records nothing when no trace is active (zero overhead when idle)', () => {
        const sb = setup();
        const win = sb.window;
        win.RotationEngine.getRankedActivities({
            bunkName: 'Bunk 1', divisionName: 'Juniors', beforeSlotIndex: 0,
            availableActivities: ['Soccer', 'Basketball'],
            activityProperties: {}
        });
        assert.equal(win.GenTrace.traces.length, 0, 'no trace captured while idle');
        assert.equal(win.GenTrace.active, false);
    });

    it('solverLog lines land in events with channel + level', () => {
        const sb = setup();
        const win = sb.window;
        win.GenTrace.begin({ entry: 'test' });
        win.GenTrace.solverLog('[AutoCore]', 'log', 'Phase 3 starting');
        win.GenTrace.solverLog('[AutoSolver]', 'warn', 'field contention high');
        win.GenTrace.end({ success: true });
        const ev = win.GenTrace.traces[0].events;
        assert.equal(ev.length, 2);
        assert.equal(ev[0].ch, '[AutoCore]');
        assert.equal(ev[1].lv, 'warn');
    });
});

describe('generation_trace — finalSchedule origin flags', () => {
    // Live case 2026-07-09: bunk לב's daily Basketball was a user bunk-override
    // preserved through the pre-gen wipe. Nothing placed it during generation,
    // so no decision explained it and the trace read as a rotation leak. The
    // snapshot now tags each entry's origin so preserved/pinned/league content
    // is self-explanatory.
    it('tags override / league / pinned / autoFill entries; plain fills untagged', () => {
        const sb = setup();
        const win = sb.window;
        win.scheduleAssignments = {
            'לב': [
                { _activity: 'Basketball', field: 'Abbl Arena', _startMin: 805, _endMin: 870, _fixed: true, _bunkOverride: true },
                { _activity: 'League: ABBL', field: 'League: ABBL', _h2h: true, _leagueName: 'ABBL', _startMin: 890, _endMin: 970 },
                { _activity: 'Swim', field: 'Swim', _pinned: true, _fixed: true, _startMin: 930, _endMin: 1110 },
                { _activity: 'Baseball', field: 'Strike Zone', _autoFilled: true, _fixed: true, _startMin: 740, _endMin: 805 },
                { _activity: 'Soccer', field: 'Soccer Field', _startMin: 600, _endMin: 660 },
                { _activity: 'Soccer', field: 'Soccer Field', continuation: true },
                null
            ]
        };
        win.GenTrace.begin({ entry: 'test' });
        win.GenTrace.end({ success: true });
        const snap = win.GenTrace.traces[0].finalSchedule['לב'];
        assert.equal(snap[0].o, 'override', 'bunk-override entry tagged');
        assert.equal(snap[1].o, 'league', 'league entry tagged');
        assert.equal(snap[2].o, 'pinned', 'pinned entry tagged');
        assert.equal(snap[3].o, 'autoFill', 'silent fallback fill tagged');
        assert.equal(snap[4].o, undefined, 'plain solver fill carries no tag');
        assert.equal(snap[5], 'cont', 'continuations unchanged');
        assert.equal(snap[6], null, 'null slots unchanged');
    });

    it('override outranks league flags on the same entry', () => {
        const sb = setup();
        const win = sb.window;
        win.scheduleAssignments = {
            'Bunk 1': [{ _activity: 'Hockey', field: 'Rink', _bunkOverride: true, _h2h: true, _startMin: 0, _endMin: 40 }]
        };
        win.GenTrace.begin({ entry: 'test' });
        win.GenTrace.end({ success: true });
        assert.equal(win.GenTrace.traces[0].finalSchedule['Bunk 1'][0].o, 'override');
    });
});
