// =============================================================================
// league_bye_notify_sim.js
// -----------------------------------------------------------------------------
// Drives the REAL SchedulerCoreLeagues.processRegularLeagues to prove the new
// bye/skipped-period NOTIFICATION:
//
//   TEST 1 — FORCED BYE: 4 teams need 2 simultaneous games but only 1 field is
//            open → 1 game places, 1 matchup gets a bye. Expect
//            window.__leagueByeReport to contain ONE kind:'bye' entry whose
//            reason names the shortage, and the
//            'campistry-league-bye-warnings' event dispatched with count 1.
//
//   TEST 2 — WHOLE PERIOD SKIPPED: no field hosts the league's sport → pool is
//            empty → the period can't run. Expect ONE kind:'skipped' entry +
//            event count 1.
//
//   TEST 3 — CLEAN RUN CLEARS: 2 open fields → both matchups place. Expect an
//            EMPTY report and the event STILL dispatched (count 0) so a stale
//            banner from a previous generation clears.
//
//   TEST 4 — KILLSWITCH: window.__leagueByeNotify=false suppresses the event
//            but still publishes window.__leagueByeReport.
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
const dispatched = [];
global.window = {
    loadGlobalSettings: () => ({ leagueHistory: cloud.leagueHistory }),
    saveGlobalSettings: (k, v) => { cloud[k] = v; },
    currentScheduleDate: '2026-07-06',
    divisionTimes: { Juniors: [{ startMin: 780, endMin: 840 }] },
    addEventListener: () => {},
    CustomEvent: function CustomEvent(type, opts) { this.type = type; this.detail = (opts || {}).detail; },
    dispatchEvent: (ev) => { dispatched.push(ev); return true; },
};
global.document = { readyState: 'complete', addEventListener: () => {} };

require('../scheduler_core_leagues.js');
const Leagues = global.window.SchedulerCoreLeagues;
assert.ok(Leagues && typeof Leagues.processRegularLeagues === 'function', 'module loaded');

// --- Scenario builder ---------------------------------------------------------
function makeContext(fields, teams) {
    return {
        schedulableSlotBlocks: [{
            type: 'league', event: 'League Time', divName: 'Juniors',
            leagueName: 'Test League', startTime: 780, endTime: 840, slots: [0],
        }],
        masterLeagues: {
            'Test League': {
                name: 'Test League', enabled: true, divisions: ['Juniors'],
                teams: teams || ['T1', 'T2', 'T3', 'T4'], sports: ['Basketball'],
                schedulingPriority: 'sport_variety',
            },
        },
        disabledLeagues: [],
        divisions: { Juniors: { bunks: ['J1', 'J2'], startTime: '10:50 AM', endTime: '3:45 PM' } },
        fillBlock: function (block) { block._filled = true; },
        fieldUsageBySlot: {},
        activityProperties: {},
        rotationHistory: {},
        fields: fields,
        disabledFields: [],
    };
}

function run(fields, teams) {
    cloud.leagueHistory = undefined;           // fresh history each run
    global.localStorage._m = {};
    dispatched.length = 0;
    Leagues.processRegularLeagues(makeContext(fields, teams));
    return {
        report: global.window.__leagueByeReport || [],
        events: dispatched.filter(e => e.type === 'campistry-league-bye-warnings'),
    };
}

const courts = (n) => Array.from({ length: n }, (_, i) =>
    ({ name: 'Court ' + (i + 1), activities: ['Basketball'] }));

// =============================================================================
// TEST 1 — forced bye (2 games needed, 1 field open)
// =============================================================================
{
    const r = run(courts(1));
    assert.strictEqual(r.report.length, 1, 'TEST1: exactly one bye recorded, got ' + JSON.stringify(r.report));
    const b = r.report[0];
    assert.strictEqual(b.kind, 'bye', 'TEST1: kind is bye');
    assert.strictEqual(b.league, 'Test League', 'TEST1: league name');
    assert.ok(b.team1 && b.team2, 'TEST1: matchup teams recorded');
    assert.ok(/Not enough fields/i.test(b.reason), 'TEST1: reason says not enough fields: ' + b.reason);
    assert.ok(/2 simultaneous games/.test(b.reason), 'TEST1: reason has the demand: ' + b.reason);
    assert.ok(/only 1 field/.test(b.reason), 'TEST1: reason has the supply: ' + b.reason);
    assert.strictEqual(b.time, 780, 'TEST1: stamped with the period time');
    assert.ok(b.game != null, 'TEST1: stamped with the game number');
    assert.strictEqual(r.events.length, 1, 'TEST1: event dispatched once');
    assert.strictEqual(r.events[0].detail.count, 1, 'TEST1: event count 1');
    assert.strictEqual(r.events[0].detail.items[0].kind, 'bye', 'TEST1: event carries the bye');
    console.log('✅ TEST 1 — forced bye recorded with reason + event dispatched');
}

// =============================================================================
// TEST 2 — whole league period skipped (no field hosts the sport)
// =============================================================================
{
    const r = run([{ name: 'Soccer Pitch', activities: ['Soccer'] }]);
    assert.strictEqual(r.report.length, 1, 'TEST2: one skip recorded, got ' + JSON.stringify(r.report));
    const s = r.report[0];
    assert.strictEqual(s.kind, 'skipped', 'TEST2: kind is skipped');
    assert.ok(/could not run at all/.test(s.reason), 'TEST2: reason explains the skip: ' + s.reason);
    assert.strictEqual(s.time, 780, 'TEST2: stamped with the period time');
    assert.strictEqual(r.events.length, 1, 'TEST2: event dispatched');
    assert.strictEqual(r.events[0].detail.count, 1, 'TEST2: event count 1');
    console.log('✅ TEST 2 — skipped period recorded with reason + event dispatched');
}

// =============================================================================
// TEST 3 — clean run: empty report, event still dispatched (clears stale banner)
// =============================================================================
{
    const r = run(courts(2));
    assert.strictEqual(r.report.length, 0, 'TEST3: no byes on a clean run, got ' + JSON.stringify(r.report));
    assert.strictEqual(r.events.length, 1, 'TEST3: clearing event still dispatched');
    assert.strictEqual(r.events[0].detail.count, 0, 'TEST3: event count 0');
    console.log('✅ TEST 3 — clean run dispatches an empty (clearing) event');
}

// =============================================================================
// TEST 4 — killswitch suppresses the event, report still published
// =============================================================================
{
    global.window.__leagueByeNotify = false;
    const r = run(courts(1));
    assert.strictEqual(r.report.length, 1, 'TEST4: report still published');
    assert.strictEqual(r.events.length, 0, 'TEST4: no event under killswitch');
    global.window.__leagueByeNotify = undefined;
    console.log('✅ TEST 4 — killswitch works');
}

// =============================================================================
// TEST 5 — structural odd-team bye: 3 teams, PLENTY of fields → 1 game places,
//          1 team rotates to a bye. Must still be reported (not a field issue).
// =============================================================================
{
    const r = run(courts(3), ['T1', 'T2', 'T3']);
    assert.strictEqual(r.report.length, 1, 'TEST5: exactly one bye recorded, got ' + JSON.stringify(r.report));
    const b = r.report[0];
    assert.strictEqual(b.kind, 'bye', 'TEST5: kind is bye');
    assert.ok(b.team1 && !b.team2, 'TEST5: single-team (unpaired) bye');
    assert.ok(/odd number of teams/i.test(b.reason), 'TEST5: reason explains the rotation: ' + b.reason);
    assert.ok(/not a field shortage/i.test(b.reason), 'TEST5: reason distinguishes it from a field problem: ' + b.reason);
    assert.strictEqual(r.events.length, 1, 'TEST5: event dispatched');
    console.log('✅ TEST 5 — structural odd-team bye reported with its own reason');
}

// =============================================================================
// TEST 6 — no double-count: 4 teams (2 matchups) but only 1 field → 1 game
//          places, 1 matchup byes (field shortage). The unpaired-bye scan must
//          NOT also fire for those two teams (they were paired).
// =============================================================================
{
    const r = run(courts(1), ['T1', 'T2', 'T3', 'T4']);
    assert.strictEqual(r.report.length, 1, 'TEST6: exactly one bye (no double count), got ' + JSON.stringify(r.report));
    assert.strictEqual(r.report[0].kind, 'bye', 'TEST6: it is the field-shortage bye');
    assert.ok(r.report[0].team1 && r.report[0].team2, 'TEST6: it is the pairwise (field) bye, not a stray unpaired one');
    assert.ok(/Not enough fields/i.test(r.report[0].reason), 'TEST6: field-shortage reason kept');
    console.log('✅ TEST 6 — paired-but-fieldless bye not double-counted by the unpaired scan');
}

console.log('\n🎉 league_bye_notify_sim: ALL TESTS PASSED');
