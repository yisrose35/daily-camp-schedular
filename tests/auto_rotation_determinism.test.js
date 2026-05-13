/**
 * Tests for: rotation_engine.js deterministic tie-breaker (Slice 3 N8).
 *
 * Run with:  node --test tests/auto_rotation_determinism.test.js
 *
 * Why this exists: Math.random() in the tie-breaker meant every
 * regenerate produced a different schedule even with identical inputs.
 * Slice 3 N8 replaced it with a djb2 hash of (bunkName+activityName+
 * dayKey). These tests assert that reproducibility property holds.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// --- Minimal browser env ---
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

function setupRotationEngine() {
    const sb = makeSandbox();
    // rotation_engine.js looks for window.historicalCounts and friends.
    sb.window.historicalCounts = {};
    sb.window.manualUsageOffsets = {};
    sb.window.scheduleAssignments = {};
    sb.window.activityProperties = {};
    sb.window.loadRotationHistory = () => ({ bunks: {}, leagues: {} });
    // Optional shimmed dependencies
    sb.window.SchedulerCoreUtils = {
        getValidActivityNames: () => new Set(['Soccer', 'Basketball', 'Hockey'])
    };
    loadInto('rotation_engine.js', sb);
    return sb;
}

describe('rotation_engine deterministic tie-breaker', () => {
    it('produces identical rankings across two calls with the same input', () => {
        const sb = setupRotationEngine();
        const RE = sb.window.RotationEngine;
        assert.ok(RE && typeof RE.getRankedActivities === 'function');

        const opts = {
            bunkName: 'Bunk 1',
            divisionName: 'Junior Boys',
            beforeSlotIndex: 0,
            availableActivities: ['Soccer', 'Basketball', 'Hockey'],
            activityProperties: {}
        };
        const r1 = RE.getRankedActivities(opts).map(r => r.activityName);
        const r2 = RE.getRankedActivities(opts).map(r => r.activityName);
        assert.deepEqual(r1, r2, 'two consecutive ranking calls with same input must agree');
    });

    it('differs across bunks (no global ordering bias)', () => {
        const sb = setupRotationEngine();
        const RE = sb.window.RotationEngine;

        const opts = (bunk) => ({
            bunkName: bunk,
            divisionName: 'Junior Boys',
            beforeSlotIndex: 0,
            availableActivities: ['Soccer', 'Basketball', 'Hockey'],
            activityProperties: {}
        });
        const r1 = RE.getRankedActivities(opts('Bunk 1')).map(r => r.activityName);
        const r2 = RE.getRankedActivities(opts('Bunk 2')).map(r => r.activityName);
        // The hash includes bunkName so ties should resolve differently
        // across bunks. Not asserting strict inequality (sometimes the
        // hashes collide on first ordering), but asserting at least one
        // of the two pairs is distinct across the 5 bunks tested.
        const allBunks = ['Bunk 1', 'Bunk 2', 'Bunk 3', 'Bunk 4', 'Bunk 5'];
        const orderings = new Set(allBunks.map(b =>
            RE.getRankedActivities(opts(b)).map(r => r.activityName).join('|')
        ));
        assert.ok(orderings.size >= 2,
            'tie-breaker should produce at least 2 distinct orderings across 5 bunks; got ' + orderings.size);
    });

    it('reproduces the exact same ordering after re-init (no implicit random state)', () => {
        const sb1 = setupRotationEngine();
        const r1 = sb1.window.RotationEngine.getRankedActivities({
            bunkName: 'Bunk 1',
            divisionName: 'Junior Boys',
            beforeSlotIndex: 0,
            availableActivities: ['Soccer', 'Basketball', 'Hockey'],
            activityProperties: {}
        }).map(r => r.activityName);

        const sb2 = setupRotationEngine();
        const r2 = sb2.window.RotationEngine.getRankedActivities({
            bunkName: 'Bunk 1',
            divisionName: 'Junior Boys',
            beforeSlotIndex: 0,
            availableActivities: ['Soccer', 'Basketball', 'Hockey'],
            activityProperties: {}
        }).map(r => r.activityName);

        assert.deepEqual(r1, r2,
            'rankings should be reproducible across fresh sandbox instances — Math.random() in tie-break is forbidden');
    });
});
