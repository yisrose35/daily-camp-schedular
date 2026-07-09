// =============================================================================
// league_same_day_sport_sim.js
// -----------------------------------------------------------------------------
// Drives the REAL SchedulerCoreLeagues.processRegularLeagues to prove the
// SAME-DAY SPORT REPEAT GUARD (_applySameDayRepeatFilter): when a league has
// 2+ games in ONE day, a team never plays the same sport twice that day
// unless there is truly no alternative — and the guard NEVER causes a bye.
//
//   TEST 1 — HARD GUARD: 4 teams, 2 league periods, 4 sports (2 fields each).
//            Every team plays 2 games — assert every team's two sports DIFFER,
//            all 4 games place, zero byes. Repeated 6× (scoring has random
//            tiebreaks; the guard is a hard filter so this must never flake).
//
//   TEST 2 — UNAVOIDABLE REPEAT ALLOWED (no bye regression): single-sport
//            league (Basketball only), 2 periods. A repeat is the only way to
//            play — assert all 4 games place (each team plays Basketball
//            twice), zero byes. "Unless absolutely needed" honored.
//
//   TEST 3 — LESSER-EVIL TIER: 2 sports only (Basketball, Soccer), 2 periods.
//            Game 1 uses both sports; every game-2 pairing must accept a
//            repeat for SOMEONE — assert no game-2 assignment repeats for
//            BOTH of its teams, all games place, zero byes.
//
//   TEST 4 — KILLSWITCH: window.__leagueSameDayRepeatGuard=false → generation
//            still completes with all games placed (guard fully bypassed).
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
    currentScheduleDate: '2026-07-09',
    divisionTimes: { Juniors: [{ startMin: 780, endMin: 840 }, { startMin: 850, endMin: 910 }] },
    addEventListener: () => {},
    CustomEvent: function CustomEvent(type, opts) { this.type = type; this.detail = (opts || {}).detail; },
    dispatchEvent: () => true,
};
global.document = { readyState: 'complete', addEventListener: () => {} };

require('../scheduler_core_leagues.js');
const Leagues = global.window.SchedulerCoreLeagues;
assert.ok(Leagues && typeof Leagues.processRegularLeagues === 'function', 'module loaded');

const DAY = '2026-07-09';
const LG = 'Test League';

// --- Scenario builder ---------------------------------------------------------
function makeContext(fields, periods) {
    const blocks = [];
    for (let i = 0; i < periods; i++) {
        blocks.push({
            type: 'league', event: 'League Time', divName: 'Juniors',
            leagueName: LG,
            startTime: global.window.divisionTimes.Juniors[i].startMin,
            endTime: global.window.divisionTimes.Juniors[i].endMin,
            slots: [i],
        });
    }
    const sports = [...new Set(fields.flatMap(f => f.activities))];
    return {
        schedulableSlotBlocks: blocks,
        masterLeagues: {
            [LG]: {
                name: LG, enabled: true, divisions: ['Juniors'],
                teams: ['T1', 'T2', 'T3', 'T4'], sports: sports,
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

function run(fields, periods) {
    cloud.leagueHistory = undefined;           // fresh history each run
    global.localStorage._m = {};
    Leagues.processRegularLeagues(makeContext(fields, periods));
    const hist = cloud.leagueHistory || {};
    const dayGames = (hist.gameLog && hist.gameLog[LG] && hist.gameLog[LG][DAY]) || [];
    return {
        games: dayGames,
        byes: (global.window.__leagueByeReport || []).slice(),
        sportsByTeam: dayGames.reduce((m, e) => {
            [e.t1, e.t2].forEach(t => { (m[t] = m[t] || []).push(e.sport); });
            return m;
        }, {}),
    };
}

const fieldsFor = (sportCounts) => Object.entries(sportCounts).flatMap(([sport, n]) =>
    Array.from({ length: n }, (_, i) => ({ name: sport + ' Field ' + (i + 1), activities: [sport] })));

// =============================================================================
// TEST 1 — hard guard: 2 games/day, 4 sports open → no team repeats a sport
// =============================================================================
for (let iter = 1; iter <= 6; iter++) {
    const r = run(fieldsFor({ Basketball: 2, Soccer: 2, Hockey: 2, Kickball: 2 }), 2);
    assert.strictEqual(r.games.length, 4, `TEST1[${iter}]: 4 games placed (2 matchups × 2 periods), got ${JSON.stringify(r.games)}`);
    assert.strictEqual(r.byes.length, 0, `TEST1[${iter}]: no byes, got ${JSON.stringify(r.byes)}`);
    for (const [team, sports] of Object.entries(r.sportsByTeam)) {
        assert.strictEqual(sports.length, 2, `TEST1[${iter}]: ${team} played 2 games`);
        assert.notStrictEqual(sports[0], sports[1],
            `TEST1[${iter}]: ${team} played "${sports[0]}" TWICE in one day with 3 other sports open`);
    }
}
console.log('✅ TEST 1 — 6/6 runs: no team repeated a sport on a 2-game day');

// =============================================================================
// TEST 2 — single-sport league: repeat is unavoidable → allowed, zero byes
// =============================================================================
{
    const r = run(fieldsFor({ Basketball: 2 }), 2);
    assert.strictEqual(r.games.length, 4, 'TEST2: all 4 games still place, got ' + JSON.stringify(r.games));
    assert.strictEqual(r.byes.length, 0, 'TEST2: guard never causes a bye, got ' + JSON.stringify(r.byes));
    for (const [team, sports] of Object.entries(r.sportsByTeam)) {
        assert.deepStrictEqual(sports, ['Basketball', 'Basketball'], `TEST2: ${team} played Basketball twice (only option)`);
    }
    console.log('✅ TEST 2 — unavoidable repeat allowed, no byes (single-sport league)');
}

// =============================================================================
// TEST 3 — lesser-evil tier: 2 sports, 2 periods → game 2 never repeats for
// BOTH teams of a matchup
// =============================================================================
for (let iter = 1; iter <= 6; iter++) {
    const r = run(fieldsFor({ Basketball: 2, Soccer: 2 }), 2);
    assert.strictEqual(r.games.length, 4, `TEST3[${iter}]: all 4 games place, got ${JSON.stringify(r.games)}`);
    assert.strictEqual(r.byes.length, 0, `TEST3[${iter}]: no byes`);
    // reconstruct per-team game-1 sports, then check every game-2 entry
    const firstSport = {};
    r.games.forEach(e => {
        [e.t1, e.t2].forEach(t => { if (!(t in firstSport)) firstSport[t] = e.sport; });
    });
    const seen = new Set();
    r.games.forEach(e => {
        const isSecond = seen.has(e.t1) || seen.has(e.t2);
        if (isSecond) {
            const bothRepeat = firstSport[e.t1] === e.sport && firstSport[e.t2] === e.sport;
            assert.ok(!bothRepeat,
                `TEST3[${iter}]: ${e.t1} vs ${e.t2} repeated "${e.sport}" for BOTH teams while a split was available`);
        }
        seen.add(e.t1); seen.add(e.t2);
    });
}
console.log('✅ TEST 3 — 6/6 runs: forced repeats never hit both teams of a matchup');

// =============================================================================
// TEST 4 — killswitch: guard off → generation unaffected
// =============================================================================
{
    global.window.__leagueSameDayRepeatGuard = false;
    const r = run(fieldsFor({ Basketball: 2, Soccer: 2, Hockey: 2, Kickball: 2 }), 2);
    assert.strictEqual(r.games.length, 4, 'TEST4: 4 games place with guard disabled');
    assert.strictEqual(r.byes.length, 0, 'TEST4: no byes with guard disabled');
    delete global.window.__leagueSameDayRepeatGuard;
    console.log('✅ TEST 4 — killswitch bypasses guard cleanly');
}

console.log('\n🎉 league_same_day_sport_sim: ALL TESTS PASSED');
