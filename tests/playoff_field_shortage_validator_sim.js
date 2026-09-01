// =============================================================================
// playoff_field_shortage_validator_sim.js
// -----------------------------------------------------------------------------
// Proves the validator's checkPlayoffFieldShortages catches playoff matchups
// the league engine dropped for lack of fields — the "you scheduled 6 baseball
// games but only 5 baseball fields exist" warning.
//
//   TEST 1 — regular league: 3 baseball games defined, 2 placed → the missing
//            matchup is reported with the per-sport field math.
//   TEST 2 — every defined matchup placed → no errors.
//   TEST 3 — decided matchups (winner set) and BYE placeholders don't count
//            as "missing".
//   TEST 4 — TBD tiles (winners not known yet) are skipped entirely.
//   TEST 5 — specialty league (em-dash line format, court capacity math).
//   TEST 6 — reserved fields are called out in the message math.
//
// Extracts the REAL checkPlayoffFieldShortages from validator.js and runs it
// against hand-built scheduleAssignments, mirroring the extraction pattern of
// playoff_electives_print_sim.js.
// =============================================================================

'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'validator.js'), 'utf8');
function extract(name) {
    const marker = 'function ' + name + '(';
    const start = src.indexOf(marker);
    assert(start >= 0, 'could not find ' + name + ' in validator.js');
    let i = src.indexOf('{', start);
    let depth = 0;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return src.slice(start, i);
}

const PM = require('../playoff_mode.js');

// Camp fields: 2 baseball diamonds + a reserved-capable canteen
const FIELDS = [
    { name: 'Diamond 1', activities: ['Baseball'] },
    { name: 'Diamond 2', activities: ['Baseball'] },
    { name: 'Diamond 3', activities: ['Baseball'] },
    { name: 'Court A', activities: ['Basketball'] },
];

const sandbox = {
    window: {
        PlayoffMode: PM,
        leaguesByName: {},
        specialtyLeagues: {},
        loadGlobalSettings: function () { return { app1: { fields: FIELDS } }; },
    },
    console,
    Set, Array, Object, String, RegExp, JSON, Math,
};
sandbox.window.window = sandbox.window;
vm.createContext(sandbox);
vm.runInContext(extract('checkPlayoffFieldShortages')
    + '\nthis.__check = checkPlayoffFieldShortages;', sandbox);
const check = sandbox.__check;
assert(typeof check === 'function', 'checkPlayoffFieldShortages failed to load');

function regularLeague(matchups, reserved) {
    return {
        name: 'Majors',
        teams: ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'],
        sports: ['Baseball', 'Basketball'],
        divisions: ['Div7'],
        playoff: {
            enabled: true,
            currentRound: 1,
            startGameCount: 0,
            reservedActivities: [],
            rounds: [{ number: 1, matchups: matchups, byes: [], reservedActivities: reserved || [] }]
        }
    };
}
function mu(a, b, sport, winner) {
    return { id: 'x' + a + b, teamA: a, teamB: b, sport: sport || 'Baseball', field: '', winner: winner || null };
}
function tile(lines, round, leagueName, extra) {
    return Object.assign({
        field: 'League: ' + (leagueName || 'Majors'),
        _leagueName: leagueName || 'Majors',
        _playoffRound: round == null ? 1 : round,
        _h2h: true,
        _allMatchups: lines
    }, extra || {});
}

// TEST 1 — 3 baseball games defined, only 2 placed → dropped matchup reported
{
    sandbox.window.leaguesByName = {
        Majors: regularLeague([mu('T1', 'T2'), mu('T3', 'T4'), mu('T5', 'T6')])
    };
    const assignments = {
        BunkA: [tile([
            'T1 vs T2 @ Diamond 1 (Baseball)',
            'T3 vs T4 @ Diamond 2 (Baseball)',
            'Electives:', '  • Canteen'
        ])]
    };
    const errors = check(assignments);
    assert.strictEqual(errors.length, 1, 'T1: expected exactly one error: ' + JSON.stringify(errors));
    assert.strictEqual(errors[0].type, 'playoff_field_shortage');
    assert(/T5 vs T6/.test(errors[0].message), 'T1: dropped matchup not named: ' + errors[0].message);
    assert(/you scheduled 3 Baseball games/.test(errors[0].message), 'T1: game count missing: ' + errors[0].message);
    assert(/only 3 fields can host Baseball/.test(errors[0].message), 'T1: field count missing: ' + errors[0].message);
    console.log('TEST 1 PASS — dropped playoff matchup reported with field math');
}

// TEST 2 — everything placed → clean
{
    sandbox.window.leaguesByName = {
        Majors: regularLeague([mu('T1', 'T2'), mu('T3', 'T4')])
    };
    const assignments = {
        BunkA: [tile([
            'T1 vs T2 @ Diamond 1 (Baseball)',
            'T3 vs T4 @ Diamond 2 (Baseball)'
        ])]
    };
    assert.strictEqual(check(assignments).length, 0, 'T2: expected no errors');
    console.log('TEST 2 PASS — fully placed round produces no errors');
}

// TEST 3 — decided + BYE matchups aren't "missing"
{
    sandbox.window.leaguesByName = {
        Majors: regularLeague([
            mu('T1', 'T2', 'Baseball', 'T1'),                  // decided — engine doesn't place it
            { id: 'b', teamA: 'T3', teamB: 'BYE', sport: 'Baseball', field: '', winner: null },
            mu('T5', 'T6')
        ])
    };
    const assignments = {
        BunkA: [tile(['T5 vs T6 @ Diamond 1 (Baseball)'])]
    };
    assert.strictEqual(check(assignments).length, 0, 'T3: decided/BYE flagged as missing');
    console.log('TEST 3 PASS — decided and BYE matchups are not flagged');
}

// TEST 4 — TBD tiles are skipped
{
    sandbox.window.leaguesByName = {
        Majors: regularLeague([mu('T1', 'T2'), mu('T3', 'T4')])
    };
    const assignments = {
        BunkA: [tile(['Round 1 — winners TBD', 'Open fields:', '  • Diamond 1'], 1, 'Majors', { _playoffTBD: true })]
    };
    assert.strictEqual(check(assignments).length, 0, 'T4: TBD tile should be skipped');
    console.log('TEST 4 PASS — TBD tiles are skipped');
}

// TEST 5 — specialty league: em-dash lines + court capacity math
{
    sandbox.window.leaguesByName = {};
    sandbox.window.specialtyLeagues = {
        hoops1: {
            id: 'hoops1',
            name: 'Hoops',
            sport: 'Basketball',
            fields: ['Court A'],
            gamesPerFieldSlot: 1,
            playoff: {
                enabled: true, currentRound: 1, startGameCount: 0, reservedActivities: [],
                rounds: [{
                    number: 1,
                    matchups: [mu('T1', 'T2', 'Basketball'), mu('T3', 'T4', 'Basketball')],
                    byes: [], reservedActivities: []
                }]
            }
        }
    };
    const assignments = {
        BunkA: [tile(['T1 vs T2 — Court A'], 1, 'Hoops')]
    };
    const errors = check(assignments);
    assert.strictEqual(errors.length, 1, 'T5: expected one error: ' + JSON.stringify(errors));
    assert(/T3 vs T4/.test(errors[0].message), 'T5: dropped matchup not named: ' + errors[0].message);
    assert(/1 court can hold at most 1 simultaneous games/.test(errors[0].message), 'T5: court math missing: ' + errors[0].message);
    sandbox.window.specialtyLeagues = {};
    console.log('TEST 5 PASS — specialty court shortage reported');
}

// TEST 6 — reserved fields show up in the math
{
    sandbox.window.leaguesByName = {
        Majors: regularLeague(
            [mu('T1', 'T2'), mu('T3', 'T4'), mu('T5', 'T6')],
            ['Diamond 3'])                                     // 1 of the 3 diamonds reserved
    };
    const assignments = {
        BunkA: [tile([
            'T1 vs T2 @ Diamond 1 (Baseball)',
            'T3 vs T4 @ Diamond 2 (Baseball)'
        ])]
    };
    const errors = check(assignments);
    assert.strictEqual(errors.length, 1, 'T6: expected one error');
    assert(/only 2 fields can host Baseball/.test(errors[0].message), 'T6: usable count wrong: ' + errors[0].message);
    assert(/1 more reserved for the teams that are out/.test(errors[0].message), 'T6: reserved note missing: ' + errors[0].message);
    console.log('TEST 6 PASS — reserved fields excluded from the math and called out');
}

console.log('\nALL playoff_field_shortage_validator_sim TESTS PASSED');
