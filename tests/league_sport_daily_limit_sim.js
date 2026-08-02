// =============================================================================
// league_sport_daily_limit_sim.js
// -----------------------------------------------------------------------------
// Drives the REAL SchedulerCoreLeagues.processRegularLeagues to prove the
// PER-SPORT DAILY LIMIT (league.sportDailyLimits, set in Leagues → Sports →
// "Daily limit per team"): a sport capped at N games per team per day is NEVER
// played an (N+1)th time by the same team that day — even when a repeat is the
// only way to fill the period. Unlike the generic same-day repeat guard (which
// yields "unless absolutely needed"), this cap is HARD: the matchup takes a
// bye instead.
//
//   TEST 1 — NO CONFIG = NO CHANGE: single-sport league, 2 periods, no limits.
//            Unchanged behavior — all 4 games place, each team plays twice.
//
//   TEST 2 — HARD CAP: same league with Basketball capped at 1/day. Game 1
//            places; game 2 must NOT place Basketball again → zero game-2
//            games, and every bye is reported with the daily-limit reason.
//
//   TEST 3 — CAP STEERS, DOESN'T BLOCK: Basketball (cap 1) + Soccer (no cap),
//            2 fields each, 2 periods, with the generic same-day repeat guard
//            DISABLED so only the cap can be doing the work. All 4 games place,
//            zero byes, and no team plays Basketball twice. Repeated 6×.
//
//   TEST 4 — NUMERIC CAP: Basketball capped at 2/day over 3 periods. Games 1
//            and 2 place; game 3 is blocked.
//
//   TEST 5 — KILLSWITCH: window.__leagueSportDailyLimit=false → the cap-1
//            single-sport league places all 4 games again.
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
    divisionTimes: {
        Juniors: [
            { startMin: 780, endMin: 840 },
            { startMin: 850, endMin: 910 },
            { startMin: 920, endMin: 980 },
        ],
    },
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
function makeContext(fields, periods, sportDailyLimits) {
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
                sportDailyLimits: sportDailyLimits || {},
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

function run(fields, periods, sportDailyLimits) {
    cloud.leagueHistory = undefined;           // fresh history each run
    global.localStorage._m = {};
    global.window.__leagueByeReport = [];
    Leagues.processRegularLeagues(makeContext(fields, periods, sportDailyLimits));
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

const countFor = (sports, sport) => sports.filter(s => s === sport).length;

// =============================================================================
// TEST 1 — no limits configured → behavior is exactly as before
// =============================================================================
{
    const r = run(fieldsFor({ Basketball: 2 }), 2, null);
    assert.strictEqual(r.games.length, 4, 'TEST1: all 4 games place with no cap, got ' + JSON.stringify(r.games));
    for (const [team, sports] of Object.entries(r.sportsByTeam)) {
        assert.deepStrictEqual(sports, ['Basketball', 'Basketball'], `TEST1: ${team} played Basketball twice (no cap set)`);
    }
    console.log('✅ TEST 1 — no daily limit configured: unchanged (repeat still allowed)');
}

// =============================================================================
// TEST 2 — Basketball capped at 1/day: game 2 must not repeat it
// =============================================================================
{
    const r = run(fieldsFor({ Basketball: 2 }), 2, { Basketball: 1 });
    assert.strictEqual(r.games.length, 2, 'TEST2: only game 1 places (game 2 is over the cap), got ' + JSON.stringify(r.games));
    for (const [team, sports] of Object.entries(r.sportsByTeam)) {
        assert.strictEqual(countFor(sports, 'Basketball'), 1,
            `TEST2: ${team} played Basketball ${countFor(sports, 'Basketball')}× on a 1×/day cap`);
    }
    const limitByes = r.byes.filter(b => /daily limit/i.test(b.reason || ''));
    assert.ok(limitByes.length >= 2,
        'TEST2: every blocked matchup is reported with the daily-limit reason, got ' + JSON.stringify(r.byes));
    assert.ok(/Basketball 1× per team per day/.test(limitByes[0].reason),
        'TEST2: the bye reason names the sport and its cap, got: ' + limitByes[0].reason);
    console.log('✅ TEST 2 — hard cap: the over-cap game is dropped, with an explanatory bye');
}

// =============================================================================
// TEST 3 — with an uncapped alternative the cap steers instead of blocking.
// The generic same-day repeat guard is OFF so only the cap can be at work.
// =============================================================================
{
    global.window.__leagueSameDayRepeatGuard = false;
    for (let iter = 1; iter <= 6; iter++) {
        const r = run(fieldsFor({ Basketball: 2, Soccer: 2 }), 2, { Basketball: 1 });
        assert.strictEqual(r.games.length, 4, `TEST3[${iter}]: all 4 games still place, got ${JSON.stringify(r.games)}`);
        assert.strictEqual(r.byes.length, 0, `TEST3[${iter}]: the cap caused no bye, got ${JSON.stringify(r.byes)}`);
        for (const [team, sports] of Object.entries(r.sportsByTeam)) {
            assert.strictEqual(sports.length, 2, `TEST3[${iter}]: ${team} played 2 games`);
            assert.ok(countFor(sports, 'Basketball') <= 1,
                `TEST3[${iter}]: ${team} played Basketball ${countFor(sports, 'Basketball')}× on a 1×/day cap (${sports.join(', ')})`);
        }
    }
    delete global.window.__leagueSameDayRepeatGuard;
    console.log('✅ TEST 3 — 6/6 runs: capped sport never doubles up, uncapped sport absorbs game 2');
}

// =============================================================================
// TEST 4 — numeric cap: 2/day allows two, blocks the third
// =============================================================================
{
    const r = run(fieldsFor({ Basketball: 2 }), 3, { Basketball: 2 });
    assert.strictEqual(r.games.length, 4, 'TEST4: games 1 and 2 place, game 3 does not, got ' + JSON.stringify(r.games));
    for (const [team, sports] of Object.entries(r.sportsByTeam)) {
        assert.strictEqual(countFor(sports, 'Basketball'), 2,
            `TEST4: ${team} played Basketball ${countFor(sports, 'Basketball')}× on a 2×/day cap`);
    }
    assert.ok(r.byes.some(b => /daily limit/i.test(b.reason || '')),
        'TEST4: the blocked third game is reported as a daily-limit bye');
    console.log('✅ TEST 4 — numeric cap: 2 allowed, 3rd blocked');
}

// =============================================================================
// TEST 5 — killswitch: cap fully bypassed
// =============================================================================
{
    global.window.__leagueSportDailyLimit = false;
    const r = run(fieldsFor({ Basketball: 2 }), 2, { Basketball: 1 });
    assert.strictEqual(r.games.length, 4, 'TEST5: all 4 games place with the cap disabled, got ' + JSON.stringify(r.games));
    assert.strictEqual(r.byes.length, 0, 'TEST5: no byes with the cap disabled');
    delete global.window.__leagueSportDailyLimit;
    console.log('✅ TEST 5 — killswitch bypasses the cap cleanly');
}

console.log('\n🎉 league_sport_daily_limit_sim: ALL TESTS PASSED');
