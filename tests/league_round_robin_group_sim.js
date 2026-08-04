// =============================================================================
// league_round_robin_group_sim.js
// -----------------------------------------------------------------------------
// Drives the REAL SchedulerCoreLeagues.processRegularLeagues to prove ROUND-ROBIN
// GROUPS (league.roundRobin = {enabled, size}): with an odd number of teams
// playing, the team that would have been benched instead joins a group that
// shares ONE field and plays every pairing in the group.
//
// The camp this exists for has 3 teams. On a chinuch period one team learns and
// the other 2 play a normal game; with no chinuch all 3 are free and somebody
// used to sit. Now all 3 play a round robin.
//
// History semantics under test — the whole point of the feature:
//   • the group DOES count for SPORT rotation, ONCE per team (they played
//     basketball today, so tomorrow they get something else)
//   • the group does NOT count as a MATCHUP (it is a scheduling device, not a
//     fixture — it must not burn who-played-who variety)
//   • the group's individual games DO reach the Leagues page for score entry
//
//   TEST 1 — OFF BY DEFAULT: 3 teams, no config → 1 game + 1 bye, as before.
//   TEST 2 — ON: 3 teams → one 3-team group, nobody benched, all 3 on one field.
//   TEST 3 — HISTORY: sport counted once per team, zero matchups recorded.
//   TEST 4 — RESULTS: the group expands to its 3 real games for score entry.
//   TEST 5 — SPORT ROTATION MOVES ON: day 2 gives the group a different sport.
//   TEST 6 — EVEN COUNT UNTOUCHED: 4 teams → 2 normal games, no group.
//   TEST 7 — BIGGER LEAGUE: 5 teams → one 3-group + one normal game, no bye.
//   TEST 8 — SIZE 5: 5 teams, size 5 → a single 5-team group (10 games).
//   TEST 9 — TILE LINES are marked, so a history rebuild from a saved
//            schedule can never turn a group back into three matchups.
//   TEST 10 — KILLSWITCH: window.__leagueRoundRobinGroups=false → back to a bye.
//   TEST 11 — FIELD SHORTAGE (LG-14b): with fewer fields than entries, a group
//             is seated whole or benched whole — never half-placed.
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
const syncCalls = [];
global.window = {
    loadGlobalSettings: () => ({ leagueHistory: cloud.leagueHistory }),
    saveGlobalSettings: (k, v) => { cloud[k] = v; },
    currentScheduleDate: '2026-07-09',
    divisionTimes: {
        Juniors: [
            { startMin: 780, endMin: 840 },
            { startMin: 850, endMin: 910 },
        ],
    },
    addEventListener: () => {},
    CustomEvent: function CustomEvent(type, opts) { this.type = type; this.detail = (opts || {}).detail; },
    dispatchEvent: () => true,
    LeaguesAPI: {
        syncGamesFromGeneration: (lg, date, entries) => { syncCalls.push({ lg, date, entries }); return true; },
    },
};
global.document = { readyState: 'complete', addEventListener: () => {} };

require('../scheduler_core_leagues.js');
const Leagues = global.window.SchedulerCoreLeagues;
assert.ok(Leagues && typeof Leagues.processRegularLeagues === 'function', 'module loaded');

const LG = 'Test League';

// --- Scenario builder ---------------------------------------------------------
function makeContext(fields, periods, teams, roundRobin, day) {
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
    const filled = [];
    return {
        schedulableSlotBlocks: blocks,
        masterLeagues: {
            [LG]: {
                name: LG, enabled: true, divisions: ['Juniors'],
                teams: teams, sports: sports,
                schedulingPriority: 'sport_variety',
                roundRobin: roundRobin || { enabled: false, size: 3 },
            },
        },
        disabledLeagues: [],
        divisions: { Juniors: { bunks: ['J1', 'J2'], startTime: '10:50 AM', endTime: '3:45 PM' } },
        fillBlock: function (block, pick) { block._filled = true; if (pick) filled.push(pick); },
        _filled: filled,
        fieldUsageBySlot: {},
        activityProperties: {},
        rotationHistory: {},
        fields: fields,
        disabledFields: [],
    };
}

// `keepHistory` chains a second day onto the first (for the rotation test).
function run(fields, periods, teams, roundRobin, opts) {
    const o = opts || {};
    if (!o.keepHistory) { cloud.leagueHistory = undefined; global.localStorage._m = {}; }
    const day = o.day || '2026-07-09';
    global.window.currentScheduleDate = day;
    global.window.__leagueByeReport = [];
    syncCalls.length = 0;
    const ctx = makeContext(fields, periods, teams, roundRobin, day);
    Leagues.processRegularLeagues(ctx);
    const hist = cloud.leagueHistory || {};
    const dayLog = (hist.gameLog && hist.gameLog[LG] && hist.gameLog[LG][day]) || [];
    return {
        log: dayLog,
        history: hist,
        byes: (global.window.__leagueByeReport || []).slice(),
        sync: syncCalls.slice(),
        tiles: ctx._filled.slice(),
        // Every "A vs B @ Field (Sport)" line the tiles carry, deduped —
        // divisions each get the same list.
        lines: Array.from(new Set(ctx._filled.reduce((acc, p) => acc.concat(p._allMatchups || []), []))),
    };
}

const fieldsFor = (sportCounts) => Object.entries(sportCounts).flatMap(([sport, n]) =>
    Array.from({ length: n }, (_, i) => ({ name: sport + ' Field ' + (i + 1), activities: [sport] })));

const T3 = ['T1', 'T2', 'T3'];
const gameLines = (r) => r.lines.filter(l => / vs .+ @ /.test(l));
// "A vs B @ Field (Sport)" with an optional " — round robin" tag on group games
const sportOf = (l) => /\(([^)]+)\)(?:\s*—.*)?\s*$/.exec(l)[1];
const fieldOf = (l) => /@\s*(.+?)\s*\(/.exec(l)[1];
const matchupCount = (h, a, b) => h.matchupHistory[LG + ':' + [a, b].sort().join('|')] || 0;

// =============================================================================
// TEST 1 — off by default: 3 teams still means one game and one bye
// =============================================================================
{
    const r = run(fieldsFor({ Basketball: 2 }), 1, T3, null);
    assert.strictEqual(gameLines(r).length, 1, 'TEST1: one normal game, got ' + JSON.stringify(gameLines(r)));
    assert.ok(r.lines.some(l => /Bye/i.test(l)), 'TEST1: the third team is benched as before, lines=' + JSON.stringify(r.lines));
    console.log('✅ TEST 1 — off by default: 3 teams = 1 game + 1 bye, unchanged');
}

// =============================================================================
// TEST 2 — on: all 3 teams play, one field, no bye
// =============================================================================
{
    const r = run(fieldsFor({ Basketball: 2 }), 1, T3, { enabled: true, size: 3 });
    const games = gameLines(r);
    assert.strictEqual(games.length, 3, 'TEST2: 3 pairings for a 3-team group, got ' + JSON.stringify(games));
    assert.ok(!r.lines.some(l => /Bye/i.test(l)), 'TEST2: nobody is benched, lines=' + JSON.stringify(r.lines));
    // every game on ONE field, ONE sport
    const fieldsUsed = new Set(games.map(fieldOf));
    assert.strictEqual(fieldsUsed.size, 1, 'TEST2: the whole group shares one field, got ' + [...fieldsUsed]);
    const pairs = new Set(games.map(l => l.split(' @ ')[0].split(' vs ').sort().join('|')));
    assert.deepStrictEqual([...pairs].sort(), ['T1|T2', 'T1|T3', 'T2|T3'], 'TEST2: every pair in the group meets');
    console.log('✅ TEST 2 — 3 teams play a round robin on one field, nobody benched');
}

// =============================================================================
// TEST 3 — history: sport once per team, matchups untouched
// =============================================================================
{
    const r = run(fieldsFor({ Basketball: 2 }), 1, T3, { enabled: true, size: 3 });
    T3.forEach(t => {
        const sports = r.history.teamSports[LG + '|' + t] || [];
        assert.deepStrictEqual(sports, ['Basketball'],
            `TEST3: ${t} counted Basketball exactly once (not once per game it played), got ${JSON.stringify(sports)}`);
    });
    assert.strictEqual(matchupCount(r.history, 'T1', 'T2'), 0, 'TEST3: no matchup recorded for T1/T2');
    assert.strictEqual(matchupCount(r.history, 'T1', 'T3'), 0, 'TEST3: no matchup recorded for T1/T3');
    assert.strictEqual(matchupCount(r.history, 'T2', 'T3'), 0, 'TEST3: no matchup recorded for T2/T3');
    // the log itself: one-sided entries carrying the group roster
    assert.strictEqual(r.log.length, 3, 'TEST3: one log entry per team, got ' + JSON.stringify(r.log));
    r.log.forEach(e => {
        assert.strictEqual(e.t2, null, 'TEST3: group entries are one-sided so matchup readers skip them');
        assert.deepStrictEqual((e.rrTeams || []).slice().sort(), T3, 'TEST3: entry carries the group roster');
    });
    console.log('✅ TEST 3 — sport counted once per team, zero matchups recorded');
}

// =============================================================================
// TEST 4 — the group's real games reach the Leagues page for scores
// =============================================================================
{
    const r = run(fieldsFor({ Basketball: 2 }), 1, T3, { enabled: true, size: 3 });
    const call = r.sync.find(c => c.lg === LG);
    assert.ok(call, 'TEST4: the results store was synced');
    const matches = call.entries.reduce((acc, e) => acc.concat(e.matches), []);
    assert.strictEqual(matches.length, 3, 'TEST4: 3 scoreable games, got ' + JSON.stringify(matches));
    matches.forEach(m => {
        assert.ok(m.teamA && m.teamB, 'TEST4: both sides named (no half-empty row), got ' + JSON.stringify(m));
        assert.strictEqual(m.sport, 'Basketball', 'TEST4: the group sport carries onto each game');
    });
    const pk = new Set(matches.map(m => [m.teamA, m.teamB].sort().join('|')));
    assert.deepStrictEqual([...pk].sort(), ['T1|T2', 'T1|T3', 'T2|T3'], 'TEST4: all three pairings are scoreable');
    console.log('✅ TEST 4 — the group expands into 3 scoreable games on the Leagues page');
}

// =============================================================================
// TEST 5 — sport rotation moves on: day 2 is NOT basketball again
// =============================================================================
{
    const F = fieldsFor({ Basketball: 2, Soccer: 2 });
    run(F, 1, T3, { enabled: true, size: 3 }, { day: '2026-07-09' });
    const r2 = run(F, 1, T3, { enabled: true, size: 3 }, { day: '2026-07-10', keepHistory: true });
    const day1Sport = 'Basketball';
    const sports2 = new Set(gameLines(r2).map(sportOf));
    assert.strictEqual(sports2.size, 1, 'TEST5: day 2 group is on one sport, got ' + [...sports2]);
    const got = [...sports2][0];
    const day1 = new Set((cloud.leagueHistory.gameLog[LG]['2026-07-09'] || []).map(e => e.sport));
    assert.strictEqual(day1.size, 1, 'TEST5: day 1 had a single group sport');
    assert.notStrictEqual(got, [...day1][0],
        `TEST5: day 2 must rotate off day 1's sport (${[...day1][0]}), got ${got} — the group counted for sport history`);
    console.log('✅ TEST 5 — the group counts for sport rotation: day 2 gets a different sport');
}

// =============================================================================
// TEST 6 — an even count is untouched (this is what a chinuch period looks like)
// =============================================================================
{
    const r = run(fieldsFor({ Basketball: 2 }), 1, ['T1', 'T2', 'T3', 'T4'], { enabled: true, size: 3 });
    const games = gameLines(r);
    assert.strictEqual(games.length, 2, 'TEST6: two ordinary games, no group, got ' + JSON.stringify(games));
    assert.strictEqual(matchupCount(r.history, games[0].split(' vs ')[0], games[0].split(' vs ')[1].split(' @ ')[0]), 1,
        'TEST6: ordinary games still record their matchup');
    console.log('✅ TEST 6 — even team count pairs off normally, nothing changes');
}

// =============================================================================
// TEST 7 — 5 teams: one 3-group + one normal game, nobody benched
// =============================================================================
{
    const r = run(fieldsFor({ Basketball: 2, Soccer: 2 }), 1, ['T1', 'T2', 'T3', 'T4', 'T5'], { enabled: true, size: 3 });
    assert.ok(!r.lines.some(l => /Bye/i.test(l)), 'TEST7: nobody benched, lines=' + JSON.stringify(r.lines));
    const played = new Set();
    gameLines(r).forEach(l => { const p = l.split(' @ ')[0].split(' vs '); played.add(p[0]); played.add(p[1]); });
    assert.strictEqual(played.size, 5, 'TEST7: all 5 teams play, got ' + [...played]);
    assert.strictEqual(gameLines(r).length, 4, 'TEST7: 3 group games + 1 normal game, got ' + JSON.stringify(gameLines(r)));
    console.log('✅ TEST 7 — 5 teams: one 3-team group + one normal game, no bye');
}

// =============================================================================
// TEST 8 — configurable size: 5 teams in a single group of 5
// =============================================================================
{
    const r = run(fieldsFor({ Basketball: 2, Soccer: 2 }), 1, ['T1', 'T2', 'T3', 'T4', 'T5'], { enabled: true, size: 5 });
    const games = gameLines(r);
    assert.strictEqual(games.length, 10, 'TEST8: a group of 5 plays 10 pairings, got ' + games.length);
    const fieldsUsed = new Set(games.map(fieldOf));
    assert.strictEqual(fieldsUsed.size, 1, 'TEST8: all on one field, got ' + [...fieldsUsed]);
    ['T1', 'T2', 'T3', 'T4', 'T5'].forEach(t => {
        const sports = r.history.teamSports[LG + '|' + t] || [];
        assert.strictEqual(sports.length, 1, `TEST8: ${t} counted the sport once, got ${JSON.stringify(sports)}`);
    });
    console.log('✅ TEST 8 — size is configurable: 5 teams, one group, 10 games, sport counted once each');
}

// =============================================================================
// TEST 9 — the saved tile can never resurrect the group as matchups.
// A group's games are written to the tile in the ordinary "A vs B @ Field
// (Sport)" shape (so print / validators / rename all keep working), and that
// same shape is what the engine rebuilds a LOST gameLog from. Unmarked, a
// 3-team group would come back as three real matchups and undo the feature.
// =============================================================================
{
    const r = run(fieldsFor({ Basketball: 2 }), 1, T3, { enabled: true, size: 3 });
    const games = gameLines(r);
    assert.ok(games.every(l => Leagues._isRoundRobinLine(l)),
        'TEST9: every group line is marked as a round robin, got ' + JSON.stringify(games));
    // …and the parser the rebuild path uses refuses to read them as a matchup
    assert.ok(games.every(l => Leagues._parseDailyMatchup
        ? Leagues._parseDailyMatchup(l) === null : true), 'TEST9: group lines parse to no matchup');
    // a normal game's line is NOT marked, so ordinary rebuilds still work
    const plain = run(fieldsFor({ Basketball: 2 }), 1, ['T1', 'T2'], { enabled: true, size: 3 });
    assert.ok(gameLines(plain).length === 1 && !Leagues._isRoundRobinLine(gameLines(plain)[0]),
        'TEST9: an ordinary head-to-head line is untagged, got ' + JSON.stringify(gameLines(plain)));
    console.log('✅ TEST 9 — group lines are marked so a history rebuild can\'t recreate matchups');
}

// =============================================================================
// TEST 10 — killswitch
// =============================================================================
{
    global.window.__leagueRoundRobinGroups = false;
    const r = run(fieldsFor({ Basketball: 2 }), 1, T3, { enabled: true, size: 3 });
    assert.strictEqual(gameLines(r).length, 1, 'TEST10: back to one game with the killswitch on');
    assert.ok(r.lines.some(l => /Bye/i.test(l)), 'TEST10: and the bye is back');
    delete global.window.__leagueRoundRobinGroups;
    console.log('✅ TEST 10 — killswitch restores the old behavior');
}

// =============================================================================
// TEST 11 — a group under a FIELD SHORTAGE (LG-14b interaction).
// The field-shortage bye rotation ranks entries by how much play their teams
// have lost, and a group holds 3+ teams on one field — so stranding it benches
// all of them. 5 teams with size 3 gives a group of 3 plus a pair, and only ONE
// field to seat them: whichever is seated must be seated WHOLE. A group that
// half-lands (some members playing, some benched) is the failure this guards.
// =============================================================================
for (let iter = 1; iter <= 5; iter++) {
    const r = run([{ name: 'Court 1', activities: ['Basketball'] }], 1,
        ['T1', 'T2', 'T3', 'T4', 'T5'], { enabled: true, size: 3 });
    const games = gameLines(r);
    const rrGames = games.filter(l => Leagues._isRoundRobinLine(l));
    const playing = new Set();
    games.forEach(l => { const p = l.split(' @ ')[0].split(' vs '); playing.add(p[0]); playing.add(p[1]); });

    if (rrGames.length) {
        // the group was seated → all 3 of its games, on the one field
        assert.strictEqual(rrGames.length, 3,
            `TEST11[${iter}]: a seated group plays all 3 of its games, got ${JSON.stringify(rrGames)}`);
        assert.strictEqual(new Set(rrGames.map(fieldOf)).size, 1,
            `TEST11[${iter}]: the group is on one field`);
        assert.strictEqual(playing.size, 3,
            `TEST11[${iter}]: exactly the group's 3 teams play, got ${[...playing]}`);
    } else {
        // the pair was seated → one ordinary game, and no partial group
        assert.strictEqual(games.length, 1,
            `TEST11[${iter}]: one ordinary game when the pair wins the field, got ${JSON.stringify(games)}`);
        assert.strictEqual(playing.size, 2, `TEST11[${iter}]: exactly 2 teams play, got ${[...playing]}`);
    }
    // whoever sat out, the sport ledger must match who actually played
    ['T1', 'T2', 'T3', 'T4', 'T5'].forEach(t => {
        const n = (r.history.teamSports[LG + '|' + t] || []).length;
        assert.strictEqual(n, playing.has(t) ? 1 : 0,
            `TEST11[${iter}]: ${t} recorded ${n} sport(s) but ${playing.has(t) ? 'played' : 'sat out'}`);
    });
}
console.log('✅ TEST 11 — under a field shortage a group is seated whole or not at all');

console.log('\n🎉 league_round_robin_group_sim: ALL TESTS PASSED');
