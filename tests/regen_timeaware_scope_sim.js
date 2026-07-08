// =========================================================================
// regen_timeaware_scope_sim.js — time-based partial-regen scope + league merge
//
// Loads the REAL division_times_system.js and drives buildTimeRegenScope /
// mergePreservedLeagueDivision with the live camp's exact shape from the
// 2026-07-06 incident: an afternoon-only generated day (pinned Intercamp @910,
// evening league @1030) that gains MORNING tiles (league/sports @740, league/GA
// @805). Asserts:
//   • newly-added morning tiles MAP (the "Could not map" fix)
//   • preserved afternoon entries re-key to their new indices (no 12:20 dup)
//   • the evening league game's label is listed for rollback preservation
//   • mergePreservedLeagueDivision never clobbers the engine's fresh slot-0
//     game and re-keys the evening game by time (the slot-0 league eater fix)
//   • misaligned non-selected divisions are refused with guidance
//   • league bookkeeping replica: counter/rollback/numbering with a preserved game
// Run: node tests/regen_timeaware_scope_sim.js
// =========================================================================
'use strict';
const fs = require('fs');
const path = require('path');

global.window = { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => {} };
global.document = { addEventListener: () => {}, getElementById: () => null, querySelectorAll: () => [] };
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.window.localStorage = global.localStorage;
global.window.CampUtils = {
    minutesToTimeLabel: function (m) {
        var h = Math.floor(m / 60), mm = m % 60, ap = h >= 12 ? 'pm' : 'am', h12 = h % 12 || 12;
        return h12 + ':' + (mm < 10 ? '0' + mm : mm) + ap;
    }
};
const src = fs.readFileSync(path.join(__dirname, '..', 'division_times_system.js'), 'utf8');
eval(src);
const DTS = global.window.DivisionTimesSystem;

let pass = true;
function ok(c, m) { if (!c) { pass = false; console.error('FAIL:', m); } else console.log('ok:', m); }

// ---- the live camp's shape --------------------------------------------
const divisions = {
    '2': { bunks: ['NA'], startTime: '12:00pm', endTime: '6:30pm' },
    '3': { bunks: ['NB'], startTime: '12:00pm', endTime: '6:30pm' },
    '7': { bunks: ['TO'], startTime: '12:00pm', endTime: '6:30pm' }
};
// Skeleton AFTER the user added the morning (divs 2+3); div 7 unchanged.
const skeleton = [
    { division: '2', startTime: '12:20pm', endTime: '1:25pm', event: 'Sports Slot', type: 'slot' },
    { division: '2', startTime: '1:25pm', endTime: '2:30pm', event: '1st and 2nd Day Camp', type: 'league' },
    { division: '2', startTime: '3:10pm', endTime: '4:50pm', event: 'Intercamp Game!!', type: 'pinned' },
    { division: '2', startTime: '5:10pm', endTime: '6:00pm', event: '1st and 2nd Day Camp', type: 'league' },
    { division: '3', startTime: '12:20pm', endTime: '1:25pm', event: '3rd and 4th Day Camp', type: 'league' },
    { division: '3', startTime: '1:25pm', endTime: '2:30pm', event: 'General Activity Slot', type: 'slot' },
    { division: '3', startTime: '3:10pm', endTime: '4:50pm', event: 'Intercamp Game!!', type: 'pinned' },
    { division: '3', startTime: '5:10pm', endTime: '6:00pm', event: '3rd and 4th Day Camp', type: 'league' },
    { division: '7', startTime: '3:10pm', endTime: '4:50pm', event: 'Activity', type: 'slot' }
];
// Schedule aligned to the OLD (afternoon-only) geometry; entries carry _startMin.
const sa = {
    NA: [{ _activity: 'Intercamp Game!!', _startMin: 910, _endMin: 1010, _pinned: true }, null],
    NB: [{ _activity: 'Intercamp Game!!', _startMin: 910, _endMin: 1010, _pinned: true }, null],
    TO: [{ _activity: 'Basketball', _startMin: 910, _endMin: 1010 }]
};
// Evening league games at OLD index 1 (stamped 1030 — the fillBlock stamp).
const la = {
    '2': { 1: { leagueName: '1st and 2nd Day Camp', gameLabel: 'Game 6', matchups: ['1 vs 2'], _startMin: 1030, _endMin: 1080 } },
    '3': { 1: { leagueName: '3rd and 4th Day Camp', gameLabel: 'Game 6', matchups: ['1 vs 2'], _startMin: 1030, _endMin: 1080 } }
};
// User double-clicked the NEW morning tiles.
const selections = [
    { bunk: 'NA', startMin: 740, endMin: 805 },
    { bunk: 'NA', startMin: 805, endMin: 870 },
    { bunk: 'NB', startMin: 740, endMin: 805 }
];

// ---- 1. scope build ----------------------------------------------------
const scope = DTS.buildTimeRegenScope({ selections, skeleton, divisions, scheduleAssignments: sa, leagueAssignments: la });
ok(scope.ok === true, 'scope builds (no "Could not map")');
ok(scope.unmapped === 0, 'all selected morning tiles mapped');
ok(scope.selectedSlotCount === 3, '3 selected slots mapped');
const nb = scope.regenScope['NB'];
ok(nb && nb.regen.has(0) && nb.regen.size === 1, 'NB regen = new slot 0 (morning league period)');
ok(nb && nb.keep[2] && nb.keep[2]._activity === 'Intercamp Game!!', 'NB Intercamp re-keyed old idx 0 -> new idx 2 (no 12:20 duplicate)');
ok(nb && !nb.keep[0] && !nb.keep[1], 'NB morning slots left empty for the solver');
const na = scope.regenScope['NA'];
ok(na && na.regen.has(0) && na.regen.has(1), 'NA regen = new slots 0+1');
ok(na && na.keep[2] && na.keep[2]._activity === 'Intercamp Game!!', 'NA Intercamp re-keyed to new idx 2');
ok(scope.fullRerollBunks.length === 0, 'no full re-roll needed (entries stamped)');
ok((scope.preservedLeagueLabels['3rd and 4th Day Camp'] || []).indexOf('Game 6') >= 0,
    'evening game of 3rd/4th listed for rollback preservation');
ok((scope.preservedLeagueLabels['1st and 2nd Day Camp'] || []).indexOf('Game 6') >= 0,
    'evening game of 1st/2nd listed for rollback preservation');
ok(scope.affectedDivs.indexOf('7') < 0, 'unchanged division 7 not swept into scope');

// ---- 2. misaligned non-selected division refused -----------------------
const skeleton2 = skeleton.concat([{ division: '7', startTime: '12:20pm', endTime: '1:25pm', event: 'New Morning', type: 'slot' }]);
const scope2 = DTS.buildTimeRegenScope({ selections, skeleton: skeleton2, divisions, scheduleAssignments: sa, leagueAssignments: la });
ok(scope2.ok === false && scope2.reason === 'misaligned-divisions' && scope2.misalignedDivs.indexOf('7') >= 0,
    'division 7 changed too but not selected -> refused with guidance (no silent corruption)');

// ---- 3. bunk with an unstamped entry -> full re-roll, never partial ----
const sa3 = { NB: [{ _activity: 'Mystery' }, null], NA: sa.NA, TO: sa.TO };
const scope3 = DTS.buildTimeRegenScope({ selections, skeleton, divisions, scheduleAssignments: sa3, leagueAssignments: la });
ok(scope3.ok === true && scope3.fullRerollBunks.indexOf('NB') >= 0, 'unstamped entry -> NB flagged for full re-roll');
ok(scope3.regenScope['NB'].regen.size === 4 && Object.keys(scope3.regenScope['NB'].keep).length === 0,
    'full re-roll = every slot regenerates, nothing kept at a wrong index');

// ---- 4. league merge: the slot-0 eater --------------------------------
const newSlots = scope.newDT['3'];
ok(newSlots.length === 4 && newSlots[0].startMin === 740, 'div 3 new geometry: 4 slots, morning at idx 0');
const fresh = { 0: { leagueName: '3rd and 4th Day Camp', gameLabel: 'Game 7', matchups: ['3 vs 6'], _startMin: 740 } };
const merged = DTS.mergePreservedLeagueDivision(fresh, la['3'], newSlots);
ok(merged[0] && merged[0].gameLabel === 'Game 7', "engine's fresh morning game at slot 0 SURVIVES the preserved-restore");
ok(merged[3] && merged[3].gameLabel === 'Game 6', 'evening game re-keyed by time: old idx 1 -> new idx 3 (its 1030 tile)');
ok(!merged[1], 'nothing left on the non-league 805 slot');
// legacy game without a stamp -> original key, but never clobbers fresh
const mergedLegacy = DTS.mergePreservedLeagueDivision({ 0: fresh[0] }, { 0: { leagueName: 'X', gameLabel: 'Old' } }, newSlots);
ok(mergedLegacy[0].gameLabel === 'Game 7', 'legacy unstamped snapshot never clobbers a fresh game');

// ---- 5. league bookkeeping replica (rollback/number/record) ------------
function getMatchupKey(a, b) { return [a, b].sort().join('|'); }
function rollbackDayRecords(leagueName, date, history, preservedLabels) {
    const entries = history.gameLog?.[leagueName]?.[date];
    if (!entries || !entries.length) return 0;
    const _keep = (preservedLabels && preservedLabels.size)
        ? entries.filter(e => e && e.g && preservedLabels.has(e.g)) : [];
    const _roll = (_keep.length) ? entries.filter(e => _keep.indexOf(e) < 0) : entries;
    _roll.forEach(e => {
        if (e.t1 && e.t2) {
            const mk = `${leagueName}:${getMatchupKey(e.t1, e.t2)}`;
            if (history.matchupHistory[mk] > 1) history.matchupHistory[mk]--;
            else delete history.matchupHistory[mk];
        }
    });
    if (_keep.length) history.gameLog[leagueName][date] = _keep;
    else delete history.gameLog[leagueName][date];
    return _roll.length;
}
const hist = {
    gameLog: { L: { '2026-07-06': [{ t1: 1, t2: 2, sport: 'K', g: 'Game 7' }, { t1: 3, t2: 4, sport: 'D', g: 'Game 7' }] } },
    matchupHistory: { 'L:1|2': 1, 'L:3|4': 1 },
    gamesPerDate: { L: { '2026-07-01': 6, '2026-07-06': 1 } }
};
// per-tile regen preserving the evening game (labels published by the regen UI)
const rolled = rollbackDayRecords('L', '2026-07-06', hist, new Set(['Game 7']));
ok(rolled === 0 && hist.gameLog.L['2026-07-06'].length === 2, 'preserved game records survive the rollback');
ok(hist.matchupHistory['L:1|2'] === 1, 'preserved matchup counts untouched');
const keptGames = new Set(hist.gameLog.L['2026-07-06'].map(r => r.g)).size;
hist.gamesPerDate.L['2026-07-06'] = keptGames; // call-site behavior
const preservedToday = keptGames;
// numbering for the NEW morning game: base = games on earlier dates (6)
const base = Object.keys(hist.gamesPerDate.L).filter(d => d < '2026-07-06').reduce((n, d) => n + hist.gamesPerDate.L[d], 0);
const gameNumber = base + preservedToday + 0 + 1;
ok(gameNumber === 8, 'new morning game numbered 8 (evening keeps 7 — no label collision)');
// record: this run scheduled 1 game -> day total = 1 + preserved 1 = 2
hist.gamesPerDate.L['2026-07-06'] = 1 + preservedToday;
const nextBase = Object.keys(hist.gamesPerDate.L).filter(d => d < '2026-07-07').reduce((n, d) => n + hist.gamesPerDate.L[d], 0);
ok(nextBase === 8, "next day's game numbered 9 (counter advanced past BOTH games)");
// normal full gen (no preserved labels): behavior unchanged
const hist2 = { gameLog: { L: { d: [{ t1: 1, t2: 2, g: 'Game 3' }] } }, matchupHistory: { 'L:1|2': 1 }, gamesPerDate: { L: {} } };
ok(rollbackDayRecords('L', 'd', hist2, null) === 1 && !hist2.gameLog.L['d'], 'no preserved labels -> full rollback (no regression)');

console.log('\n' + (pass ? 'ALL PASS ✅' : 'FAILURES ❌'));
process.exit(pass ? 0 : 1);
