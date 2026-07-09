// =============================================================================
// league_span_group_sim.js
// -----------------------------------------------------------------------------
// Drives the REAL SchedulerCoreLeagues.processRegularLeagues to prove that a
// league tile SPANNED across two grades (linked by spanGroup) is processed as
// ONE game period — same matchups, same game number in both grades — even when
// the two per-grade copies' start times have drifted apart:
//
//   TEST 1 — SPAN MERGE: two blocks, same league, same spanGroup, DIFFERENT
//            start times (780 vs 800). Expect one shared period: both blocks
//            filled with identical _gameLabel + _allMatchups, and exactly ONE
//            game recorded for the day.
//
//   TEST 2 — NO SPAN (control): same two blocks WITHOUT spanGroup. Expect the
//            historical two-period behavior: two different game numbers and
//            TWO games recorded. Documents that the merge is span-scoped.
//
//   TEST 3 — SAME TIME (normal span): identical start times share a bucket
//            organically; both grades get the same result and one game.
//
// Run with:  node tests/league_span_group_sim.js
// =============================================================================

'use strict';
const assert = require('assert');

// --- Browser shims so the IIFE loads + processRegularLeagues runs in Node ----
const cloud = {};
global.localStorage = {
    _m: {},
    getItem(k) { return this._m[k] != null ? this._m[k] : null; },
    setItem(k, v) { this._m[k] = String(v); },
    removeItem(k) { delete this._m[k]; },
};
global.window = {
    loadGlobalSettings: () => ({ leagueHistory: cloud.leagueHistory }),
    saveGlobalSettings: (k, v) => { cloud[k] = v; },
    currentScheduleDate: '2026-07-06',
    divisionTimes: {
        '4th Grade': [{ startMin: 780, endMin: 840 }],
        '5th Grade': [{ startMin: 800, endMin: 860 }],
    },
    addEventListener: () => {},
    CustomEvent: function CustomEvent(type, opts) { this.type = type; this.detail = (opts || {}).detail; },
    dispatchEvent: () => true,
};
global.document = { readyState: 'complete', addEventListener: () => {} };

require('../scheduler_core_leagues.js');
const Leagues = global.window.SchedulerCoreLeagues;
assert.ok(Leagues && typeof Leagues.processRegularLeagues === 'function', 'module loaded');

const DAY = '2026-07-06';

function makeContext(blocks) {
    return {
        schedulableSlotBlocks: blocks,
        masterLeagues: {
            'Test League': {
                name: 'Test League', enabled: true,
                divisions: ['4th Grade', '5th Grade'],
                teams: ['A1', 'A2', 'B1', 'B2'], sports: ['Basketball'],
                schedulingPriority: 'sport_variety',
            },
        },
        disabledLeagues: [],
        divisions: {
            '4th Grade': { bunks: ['A1', 'A2'], startTime: '10:00 AM', endTime: '4:00 PM' },
            '5th Grade': { bunks: ['B1', 'B2'], startTime: '10:00 AM', endTime: '4:00 PM' },
        },
        fillBlock: function (block, pick) { block._filled = pick; },
        fieldUsageBySlot: {},
        activityProperties: {},
        rotationHistory: {},
        fields: [
            { name: 'Court 1', activities: ['Basketball'] },
            { name: 'Court 2', activities: ['Basketball'] },
        ],
        disabledFields: [],
    };
}

function leagueBlock(divName, startTime, spanGroup) {
    return {
        type: 'league', event: 'League Game', divName,
        leagueName: 'Test League', startTime, endTime: startTime + 60,
        slots: [0], spanGroup: spanGroup || null,
    };
}

function run(blocks) {
    cloud.leagueHistory = undefined;           // fresh history each run
    global.localStorage._m = {};
    Leagues.processRegularLeagues(makeContext(blocks));
    return blocks;
}

function gamesRecorded() {
    return cloud.leagueHistory?.gamesPerDate?.['Test League']?.[DAY] || 0;
}

// =============================================================================
// TEST 1 — spanGroup at DIFFERENT times → merged into one shared game
// =============================================================================
{
    const b4 = leagueBlock('4th Grade', 780, 'span_test1');
    const b5 = leagueBlock('5th Grade', 800, 'span_test1');
    run([b4, b5]);

    assert.ok(b4._filled, 'TEST1: 4th Grade block filled');
    assert.ok(b5._filled, 'TEST1: 5th Grade block filled');
    assert.strictEqual(b4._filled._gameLabel, 'Game 1', 'TEST1: 4th labeled Game 1');
    assert.strictEqual(b5._filled._gameLabel, 'Game 1', 'TEST1: 5th labeled Game 1 (same game)');
    assert.deepStrictEqual(b5._filled._allMatchups, b4._filled._allMatchups,
        'TEST1: both grades show identical matchups');
    assert.ok(b4._filled._allMatchups.length >= 2, 'TEST1: both matchups placed (2 courts)');
    assert.strictEqual(gamesRecorded(), 1, 'TEST1: exactly ONE game recorded for the day');
    console.log('✅ TEST 1 — span-linked blocks at different times merged into one shared game');
}

// =============================================================================
// TEST 2 — control: same blocks WITHOUT spanGroup → two independent periods
// =============================================================================
{
    const b4 = leagueBlock('4th Grade', 780);
    const b5 = leagueBlock('5th Grade', 800);
    run([b4, b5]);

    assert.ok(b4._filled && b5._filled, 'TEST2: both blocks filled');
    assert.strictEqual(b4._filled._gameLabel, 'Game 1', 'TEST2: first period is Game 1');
    assert.strictEqual(b5._filled._gameLabel, 'Game 2', 'TEST2: second period is Game 2');
    assert.strictEqual(gamesRecorded(), 2, 'TEST2: two games recorded');
    console.log('✅ TEST 2 — unlinked blocks at different times stay independent periods');
}

// =============================================================================
// TEST 3 — same time (the normal span case) → one shared game, one record
// =============================================================================
{
    const b4 = leagueBlock('4th Grade', 780, 'span_test3');
    const b5 = leagueBlock('5th Grade', 780, 'span_test3');
    run([b4, b5]);

    assert.ok(b4._filled && b5._filled, 'TEST3: both blocks filled');
    assert.strictEqual(b4._filled._gameLabel, 'Game 1', 'TEST3: 4th labeled Game 1');
    assert.strictEqual(b5._filled._gameLabel, 'Game 1', 'TEST3: 5th labeled Game 1');
    assert.deepStrictEqual(b5._filled._allMatchups, b4._filled._allMatchups,
        'TEST3: identical matchups');
    assert.strictEqual(gamesRecorded(), 1, 'TEST3: one game recorded');
    console.log('✅ TEST 3 — same-time span shares one game (unchanged behavior)');
}

console.log('\n🎉 league_span_group_sim: ALL TESTS PASSED');
