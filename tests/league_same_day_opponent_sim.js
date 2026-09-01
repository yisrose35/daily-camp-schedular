// =============================================================================
// league_same_day_opponent_sim.js
// -----------------------------------------------------------------------------
// Drives the REAL SchedulerCoreLeagues.processRegularLeagues to prove the
// SAME-DAY OPPONENT GUARD (metToday penalty in chooseDailyMatchups): when a
// league has 2+ games in ONE day, two teams never face each other twice that
// day unless there is no other possible pairing — and the guard never causes
// a bye.
//
// The trap scenario: cross pairs (T1-T3, T1-T4, T2-T3, T2-T4) each met 3×
// on PRIOR days while T1-T2 / T3-T4 never met. Game 1 correctly picks the
// never-met pairs — but then game 2's optimizer STILL sees those pairs as
// the least-met option (1 vs 3 meetings) and, pre-fix, re-picked the exact
// same matchups for game 2 in BOTH scheduling modes.
//
//   TEST 1 — HARD GUARD (both modes): with the trap seed, game 2 must NOT
//            repeat any game-1 pairing. 6 runs per mode, zero byes.
//   TEST 2 — UNAVOIDABLE REPEAT: 2-team league, 2 periods → T1 vs T2 twice
//            (only possible pairing), zero byes — AND the same-day SPORT
//            guard still gives the rematch a different sport.
//   TEST 3 — KILLSWITCH: __leagueSameDayOpponentGuard=false restores the
//            old behavior on the trap seed (game 2 repeats game 1's pairs),
//            proving the guard is what changed the outcome.
//   TEST 4 — ODD TEAMS: 3 teams, 2 periods → the game-1 bye team plays in
//            game 2 (pairing can't just repeat).
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
const pairKey = (a, b) => [a, b].sort().join('|');

// --- Scenario builder ---------------------------------------------------------
function makeContext(fields, periods, teams, mode) {
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
                teams: teams, sports: sports,
                schedulingPriority: mode || 'sport_variety',
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

// Prior-day trap seed: every CROSS pair met 3×, T1-T2 / T3-T4 never met.
// sport:null keeps sport-cycle/pair-sport signals neutral (only meetings count).
function trapHistory() {
    const gl = {};
    let d = 1;
    [['T1', 'T3'], ['T1', 'T4'], ['T2', 'T3'], ['T2', 'T4']].forEach(pair => {
        for (let k = 0; k < 3; k++) {
            const date = '2026-07-0' + d;   // 01..09 — all before DAY? use 06 max
            (gl[date] = gl[date] || []).push({ t1: pair[0], t2: pair[1], sport: null });
        }
        d++;
    });
    return {
        teamSports: {}, matchupHistory: {}, gamesPerDate: {}, offCampusCounts: {},
        gameLog: { [LG]: gl },
    };
}

function run(fields, periods, opts) {
    opts = opts || {};
    cloud.leagueHistory = opts.seed || undefined;
    global.localStorage._m = {};
    Leagues.processRegularLeagues(makeContext(fields, periods, opts.teams || ['T1', 'T2', 'T3', 'T4'], opts.mode));
    const hist = cloud.leagueHistory || {};
    const dayGames = (hist.gameLog && hist.gameLog[LG] && hist.gameLog[LG][DAY]) || [];
    return { games: dayGames, byes: (global.window.__leagueByeReport || []).slice() };
}

const fieldsFor = (sportCounts) => Object.entries(sportCounts).flatMap(([sport, n]) =>
    Array.from({ length: n }, (_, i) => ({ name: sport + ' Field ' + (i + 1), activities: [sport] })));

// Split a day's games into per-period halves by log order (2 matchups/period
// for 4 teams; 1/period for 2-3 teams) and return the pair keys per game.
function pairsByGame(games, perGame) {
    const out = [];
    for (let i = 0; i < games.length; i += perGame) {
        out.push(games.slice(i, i + perGame).map(e => pairKey(e.t1, e.t2)));
    }
    return out;
}

// =============================================================================
// TEST 1 — hard guard: trap seed, game 2 never repeats a game-1 pairing
// =============================================================================
for (const mode of ['sport_variety', 'matchup_variety']) {
    for (let iter = 1; iter <= 6; iter++) {
        const r = run(fieldsFor({ Basketball: 2, Soccer: 2, Hockey: 2, Kickball: 2 }), 2,
            { seed: trapHistory(), mode });
        assert.strictEqual(r.games.length, 4, `TEST1[${mode}/${iter}]: 4 games placed, got ${JSON.stringify(r.games)}`);
        assert.strictEqual(r.byes.length, 0, `TEST1[${mode}/${iter}]: no byes`);
        const [g1, g2] = pairsByGame(r.games, 2);
        g2.forEach(pk => assert.ok(!g1.includes(pk),
            `TEST1[${mode}/${iter}]: pairing ${pk} played TWICE in one day (game1=${g1}, game2=${g2})`));
    }
    console.log(`✅ TEST 1 (${mode}) — 6/6 runs: no same-day rematch despite trap seed`);
}

// =============================================================================
// TEST 2 — 2-team league: rematch unavoidable → plays anyway, different sport
// =============================================================================
{
    const r = run(fieldsFor({ Basketball: 1, Soccer: 1 }), 2, { teams: ['T1', 'T2'] });
    assert.strictEqual(r.games.length, 2, 'TEST2: both games place, got ' + JSON.stringify(r.games));
    assert.strictEqual(r.byes.length, 0, 'TEST2: no byes');
    r.games.forEach(e => assert.strictEqual(pairKey(e.t1, e.t2), 'T1|T2', 'TEST2: only possible pairing plays'));
    assert.notStrictEqual(r.games[0].sport, r.games[1].sport,
        'TEST2: unavoidable rematch still gets a DIFFERENT sport (got ' + r.games.map(e => e.sport) + ')');
    console.log('✅ TEST 2 — unavoidable rematch plays (no bye) and rotates sport');
}

// =============================================================================
// TEST 3 — killswitch restores old behavior on the trap seed
// =============================================================================
{
    global.window.__leagueSameDayOpponentGuard = false;
    const r = run(fieldsFor({ Basketball: 2, Soccer: 2, Hockey: 2, Kickball: 2 }), 2,
        { seed: trapHistory(), mode: 'matchup_variety' });
    delete global.window.__leagueSameDayOpponentGuard;
    assert.strictEqual(r.games.length, 4, 'TEST3: 4 games placed');
    const [g1, g2] = pairsByGame(r.games, 2);
    const repeats = g2.filter(pk => g1.includes(pk)).length;
    assert.strictEqual(repeats, 2,
        `TEST3: with the guard OFF the trap seed repeats both pairings (least-met wins), got ${repeats} (game1=${g1}, game2=${g2})`);
    console.log('✅ TEST 3 — killswitch reverts to pre-fix pairing (proves causality)');
}

// =============================================================================
// TEST 4 — 3 teams: game-1 bye team must play in game 2
// =============================================================================
for (let iter = 1; iter <= 6; iter++) {
    const r = run(fieldsFor({ Basketball: 2, Soccer: 2, Hockey: 2 }), 2, { teams: ['T1', 'T2', 'T3'] });
    assert.strictEqual(r.games.length, 2, `TEST4[${iter}]: 1 game per period, got ${JSON.stringify(r.games)}`);
    const [g1, g2] = pairsByGame(r.games, 1);
    assert.notStrictEqual(g1[0], g2[0], `TEST4[${iter}]: same pair played both periods (${g1[0]}) — bye team never got in`);
}
console.log('✅ TEST 4 — 6/6 runs: odd-team bye rotates into game 2');

console.log('\n🎉 league_same_day_opponent_sim: ALL TESTS PASSED');
