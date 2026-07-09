// =============================================================================
// league_chinuch_bye_print_sim.js
// -----------------------------------------------------------------------------
// Proves the print center actually PRINTS chinuch and bye lines that ride along
// in a league game's matchups array. The league engine writes byes/chinuch as
// plain strings ("Team A — Bye", "Team B — Chinuch (Court)") into the SAME
// `matchups` array as real "X vs Y" games (see scheduler_core_leagues.js). The
// print-center matchup builders used to parse every line and drop anything that
// wasn't an "X vs Y" pair, so byes and chinuch never appeared on the printout.
//
// This test extracts the REAL print_center.js functions (pcParseMatchup,
// pcFormatMatchupLine, pcInfoLineText, pcInfoLineTeam, buildLeagueMatchups,
// pcLeagueInfoAt, pcLeagueLabel) and drives them the way the renderer does.
//
//   TEST 1 — division-level cell keeps every line: real games + byes + chinuch.
//   TEST 2 — per-bunk cell shows that team's OWN bye when it isn't playing.
//   TEST 3 — chinuch-only period still renders its chinuch lines.
//   TEST 4 — pcLeagueInfoAt (auto/time-top path) also surfaces byes + chinuch.
//   TEST 5 — a real matchup that happens to mention no keyword is untouched.
// =============================================================================

'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---- Pull only the matchup helpers out of print_center.js -------------------
// They form a self-contained block; we run them in a sandbox with the few
// globals the renderer supplies (window + findFirstSlotForTime), so the test
// exercises the real source rather than a copy.
const src = fs.readFileSync(path.join(__dirname, '..', 'print_center.js'), 'utf8');
function extract(name) {
    const marker = 'function ' + name + '(';
    const start = src.indexOf(marker);
    assert(start >= 0, 'could not find ' + name + ' in print_center.js');
    // Walk braces from the first '{' after the signature to the matching close.
    let i = src.indexOf('{', start);
    let depth = 0;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return src.slice(start, i);
}

const fns = ['pcParseMatchup', 'pcFormatMatchupLine', 'pcInfoLineText',
             'pcInfoLineTeam', 'buildLeagueMatchups', 'pcLeagueInfoAt',
             'pcLeagueSlotRecord', 'pcLeagueLabel'];

const sandbox = {
    window: { leagueAssignments: {}, lastLeagueMatchups: null },
    // The renderer resolves a time to a slot index; our data is keyed by
    // startMin directly, so "no slot index" (-1) forces the startMin lookup.
    findFirstSlotForTime: function () { return -1; },
    console,
};
vm.createContext(sandbox);
vm.runInContext(fns.map(extract).join('\n'), sandbox);

const { buildLeagueMatchups, pcLeagueInfoAt, pcLeagueLabel } = sandbox;

// ---- Realistic slot record: 6-team league, one game + one bye + one chinuch --
// Mirrors what scheduler_core_leagues.js stamps into leagueAssignments: real
// games as "A vs B @ Field (sport)" and non-game lines as "T — Bye" /
// "T — Chinuch (Facility)".
const DIV = 'Seniors';
const START = 600;
sandbox.window.leagueAssignments = {
    [DIV]: {
        [START]: {
            gameLabel: 'Game 4',
            leagueName: 'Senior League',
            sport: 'basketball',
            field: 'Court 1',
            matchups: [
                'Lions vs Tigers @ Court 1 (basketball)',
                'Bears vs Wolves @ Court 2 (basketball)',
                'Hawks — Bye',
                'Eagles — Chinuch (Beis Medrash)',
            ],
        },
    },
};

const eb = { startMin: START };

// ---- TEST 1 — division cell keeps games + bye + chinuch ---------------------
(function () {
    const lines = buildLeagueMatchups(eb, DIV);
    const joined = lines.join(' | ');
    assert(lines.some(l => /Lions vs Tigers/.test(l)), 'T1: real game 1 missing: ' + joined);
    assert(lines.some(l => /Bears vs Wolves/.test(l)), 'T1: real game 2 missing: ' + joined);
    assert(lines.some(l => /Hawks — Bye/.test(l)), 'T1: bye line missing: ' + joined);
    assert(lines.some(l => /Eagles — Chinuch \(Beis Medrash\)/.test(l)), 'T1: chinuch line missing: ' + joined);
    console.log('TEST 1 PASS — division cell prints games + bye + chinuch');
})();

// ---- TEST 2 — per-bunk cell shows that team's own bye, not others' info ------
// (The matchup slate itself falls back to "show all games" when the team isn't
// paired — pre-existing behavior for separate-entity leagues. What THIS change
// guarantees is that the bunk's own bye prints and another team's chinuch does
// NOT leak into its cell.)
(function () {
    const lines = buildLeagueMatchups(eb, DIV, 'Hawks');
    const joined = lines.join(' | ');
    assert(lines.some(l => /Hawks — Bye/.test(l)), 'T2: Hawks bye missing: ' + joined);
    assert(!lines.some(l => /Eagles — Chinuch/.test(l)), 'T2: leaked another team\'s chinuch: ' + joined);
    console.log('TEST 2 PASS — per-bunk cell shows its own bye, no other team\'s chinuch');
})();

// ---- TEST 3 — chinuch-only period still renders -----------------------------
(function () {
    sandbox.window.leagueAssignments[DIV][START] = {
        gameLabel: 'Chinuch',
        leagueName: 'Senior League',
        matchups: [
            'Lions — Chinuch (Beis Medrash)',
            'Tigers — Chinuch (Beis Medrash)',
        ],
    };
    const lines = buildLeagueMatchups(eb, DIV);
    assert.strictEqual(lines.length, 2, 'T3: expected 2 chinuch lines, got ' + JSON.stringify(lines));
    assert(lines.every(l => /Chinuch/.test(l)), 'T3: chinuch lines missing: ' + JSON.stringify(lines));
    console.log('TEST 3 PASS — chinuch-only period renders its lines');
})();

// ---- TEST 4 — pcLeagueInfoAt (auto/time-top path) surfaces bye + chinuch -----
(function () {
    sandbox.window.leagueAssignments[DIV][START] = {
        gameLabel: 'Game 4',
        leagueName: 'Senior League',
        matchups: [
            'Lions vs Tigers @ Court 1 (basketball)',
            'Hawks — Bye',
            'Eagles — Chinuch (Beis Medrash)',
        ],
    };
    const info = pcLeagueInfoAt(DIV, START);
    assert(info, 'T4: pcLeagueInfoAt returned null');
    const joined = info.matchups.join(' | ');
    assert(/Hawks — Bye/.test(joined), 'T4: bye missing: ' + joined);
    assert(/Eagles — Chinuch/.test(joined), 'T4: chinuch missing: ' + joined);
    // And the rich single-label builder includes them too.
    const lbl = pcLeagueLabel({ matchups: sandbox.window.leagueAssignments[DIV][START].matchups }, null, DIV, START);
    assert(/Hawks — Bye/.test(lbl.full), 'T4: pcLeagueLabel dropped bye: ' + lbl.full);
    assert(/Eagles — Chinuch/.test(lbl.full), 'T4: pcLeagueLabel dropped chinuch: ' + lbl.full);
    console.log('TEST 4 PASS — pcLeagueInfoAt + pcLeagueLabel surface bye + chinuch');
})();

// ---- TEST 5 — a real matchup is never misread as an info line ----------------
(function () {
    // "Bye vs Rest" would be a legit game; the vs-check must win over the keyword.
    assert.strictEqual(sandbox.pcInfoLineText('Bye vs Rest @ Court (basketball)'), '',
        'T5: real "vs" game wrongly classified as an info line');
    assert.strictEqual(sandbox.pcInfoLineText('Hawks — Bye'), 'Hawks — Bye',
        'T5: bye line not recognized');
    assert.strictEqual(sandbox.pcInfoLineTeam('Eagles — Chinuch (Beis Medrash)'), 'Eagles',
        'T5: team name not extracted from chinuch line');
    console.log('TEST 5 PASS — real games untouched, info lines classified correctly');
})();

console.log('\nALL TESTS PASSED — chinuch & byes print from league cells');
