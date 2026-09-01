// =============================================================================
// playoff_electives_print_sim.js
// -----------------------------------------------------------------------------
// Proves the print center PRINTS the playoff tile's "Electives:" section (the
// round's reserved fields for teams that are out) and the TBD round's
// "Open fields:" list. These section rows ride in the SAME matchups array as
// real "X vs Y" games (see scheduler_core_leagues.js playoff display block).
// pcInfoLineText used to keep only bye/chinuch lines, silently dropping the
// Electives section from every printout.
//
//   TEST 1 — division-level cell keeps games + explicit byes + Electives rows.
//   TEST 2 — per-bunk cell of a PLAYING team keeps its game + section rows.
//   TEST 3 — per-bunk cell of a team on a BYE keeps its bye + section rows.
//   TEST 4 — TBD tile rows (winners TBD / Open fields) survive printing.
// =============================================================================

'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'print_center.js'), 'utf8');
function extract(name) {
    const marker = 'function ' + name + '(';
    const start = src.indexOf(marker);
    assert(start >= 0, 'could not find ' + name + ' in print_center.js');
    let i = src.indexOf('{', start);
    let depth = 0;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return src.slice(start, i);
}

const fns = ['pcParseMatchup', 'pcFormatMatchupLine', 'pcInfoLineText',
             'pcInfoLineTeam', 'buildLeagueMatchups', 'pcLeagueSlotRecord',
             'pcLeagueLabel'];

const sandbox = {
    window: { leagueAssignments: {}, lastLeagueMatchups: null },
    findFirstSlotForTime: function () { return -1; },
    console,
};
vm.createContext(sandbox);
vm.runInContext(fns.map(extract).join('\n'), sandbox);

// Playoff tile rows as written by the league engine (Playoff R2: matchups,
// one explicit bye, then the round's reserved fields as Electives).
const ROWS = [
    '1 vs 3 @ AFFL Stadium 1 (Football)',
    '5 vs 7 @ Grand Slam Park (Baseball)',
    '9 — Bye',
    'Electives:',
    '  • Canteen',
    '  • Pool',
];

// TEST 1 — division cell (bunk = null) keeps everything
{
    const entry = { _allMatchups: ROWS, sport: 'Football', field: '' };
    const lbl = sandbox.pcLeagueLabel(entry, null, 'Div7', 600);
    const full = lbl.full || JSON.stringify(lbl);
    assert(/Team 1 vs Team 3/.test(full), 'T1: game 1 missing: ' + full);
    assert(/9 — Bye/.test(full), 'T1: bye missing: ' + full);
    assert(/Electives:/.test(full), 'T1: Electives header missing: ' + full);
    assert(/• Canteen/.test(full), 'T1: Canteen bullet missing: ' + full);
    assert(/• Pool/.test(full), 'T1: Pool bullet missing: ' + full);
    console.log('TEST 1 PASS — division cell prints games + bye + Electives');
}

// TEST 2 — playing team's per-bunk cell: own game + section rows, no other bye
{
    const entry = { _allMatchups: ROWS, sport: 'Football', field: '' };
    const lbl = sandbox.pcLeagueLabel(entry, '1', 'Div7', 600);
    const full = lbl.full;
    assert(/1 vs 3|Team 1 vs Team 3/.test(full), 'T2: own game missing: ' + full);
    assert(!/9 — Bye/.test(full), 'T2: other team\'s bye leaked: ' + full);
    assert(/Electives:/.test(full) && /• Canteen/.test(full), 'T2: Electives dropped: ' + full);
    console.log('TEST 2 PASS — playing team keeps game + Electives, drops others\' byes');
}

// TEST 3 — byed team's per-bunk cell: own bye + section rows
{
    const entry = { _allMatchups: ROWS, sport: 'Football', field: '' };
    const lbl = sandbox.pcLeagueLabel(entry, '9', 'Div7', 600);
    const full = lbl.full;
    assert(/9 — Bye/.test(full), 'T3: own bye missing: ' + full);
    assert(/Electives:/.test(full) && /• Pool/.test(full), 'T3: Electives dropped: ' + full);
    console.log('TEST 3 PASS — byed team keeps its bye + Electives');
}

// TEST 4 — TBD tile rows survive
{
    const rows = ['Round 3 — winners TBD', 'Open fields:', '  • Swish City', 'Electives:', '  • Canteen'];
    const kept = rows.map(sandbox.pcInfoLineText).filter(Boolean);
    assert(kept.length === 5, 'T4: expected all 5 TBD rows kept, got ' + JSON.stringify(kept));
    console.log('TEST 4 PASS — TBD tile rows (winners TBD / Open fields) survive');
}

console.log('\nALL TESTS PASSED — playoff Electives print from league cells');
