// =============================================================================
// league_game_renumber_sim.js
// -----------------------------------------------------------------------------
// Two things, one root cause.
//
// A game's number lives in stores that don't derive from each other at read
// time: the engine's gameLog (what the Leagues results page is built from) and
// the saved schedule (what the grid shows). updateFutureSchedules renumbered
// the SCHEDULE when an earlier day's game count changed, and left the gameLog
// alone — so the results page kept quoting numbers the sequence had moved past.
// Live symptom: the game list read "Game 10 — Aug 2" then "Game 8 — Jul 30",
// with no Game 9 anywhere.
//
//   TEST 1 — REGRESSION: an earlier day loses a game → a later day's schedule
//            AND its gameLog both renumber, and the results page is re-pushed
//            with the new numbers. Without the fix the log keeps "Game 10"
//            while the grid says "Game 9" — the reported gap.
//   TEST 2 — renumberGame moves a number across every store at once.
//   TEST 3 — renumbering onto a number already used that day SWAPS them, so a
//            number is never used twice.
//   TEST 4 — bad input is refused, and nothing is half-written.
// =============================================================================

'use strict';
const assert = require('assert');

const cloud = {};
let dailyData = {};
const syncCalls = [];
const savedSchedules = [];

global.localStorage = {
    _m: {},
    getItem(k) { return this._m[k] != null ? this._m[k] : null; },
    setItem(k, v) { this._m[k] = String(v); },
    removeItem(k) { delete this._m[k]; },
};
global.window = {
    loadGlobalSettings: () => ({ leagueHistory: cloud.leagueHistory }),
    saveGlobalSettings: (k, v) => { cloud[k] = v; },
    loadAllDailyData: () => dailyData,
    ScheduleDB: { saveSchedule: (d) => { savedSchedules.push(d); } },
    currentScheduleDate: '2026-08-02',
    divisionTimes: { Juniors: [{ startMin: 780, endMin: 840, startTime: '1:00 PM' }, { startMin: 850, endMin: 910, startTime: '2:10 PM' }] },
    leagueAssignments: {},
    addEventListener: () => {},
    CustomEvent: function (t, o) { this.type = t; this.detail = (o || {}).detail; },
    dispatchEvent: () => true,
    LeaguesAPI: {
        syncGamesFromGeneration: (lg, date, entries) => { syncCalls.push({ lg, date, entries }); return true; },
    },
    SchedulerCoreUtils: {
        parseTimeToMinutes: (t) => {
            if (t == null) return null;
            if (!isNaN(Number(t))) return Number(t);
            const m = String(t).match(/^(\d+):(\d+)\s*(AM|PM)?$/i);
            if (!m) return null;
            let h = parseInt(m[1], 10);
            const mi = parseInt(m[2], 10);
            const ap = (m[3] || '').toUpperCase();
            if (ap === 'PM' && h !== 12) h += 12;
            if (ap === 'AM' && h === 12) h = 0;
            return h * 60 + mi;
        },
    },
};
global.document = { readyState: 'complete', addEventListener: () => {} };

require('../scheduler_core_leagues.js');
const Leagues = global.window.SchedulerCoreLeagues;
assert.ok(Leagues && typeof Leagues.renumberGame === 'function', 'renumberGame exposed');

const LG = 'Majors';
const D_EARLY = '2026-07-30';
const D_LATE = '2026-08-02';

// A day of the shape the screenshot showed: one league period, several
// simultaneous matchups, mirrored into the per-bunk copy.
function makeDay(label, pairs) {
    return {
        leagueAssignments: {
            Juniors: { 0: { leagueName: LG, gameLabel: label, sport: 'Basketball', _startMin: 780, matchups: pairs.map(p => p[0] + ' vs ' + p[1] + ' @ Court 1 (Basketball)') } },
        },
        scheduleAssignments: {
            J1: [{ _leagueName: LG, _gameLabel: label, sport: label, _activity: 'League: ' + LG, _allMatchups: pairs.map(p => p[0] + ' vs ' + p[1] + ' @ Court 1 (Basketball)') }],
        },
    };
}

function seed() {
    cloud.leagueHistory = {
        teamSports: {}, matchupHistory: {},
        gameLog: {
            [LG]: {
                [D_EARLY]: [{ t1: 'BMW', t2: 'Jaguar', sport: 'Basketball', g: 'Game 8' }],
                [D_LATE]: [{ t1: 'Ferrari', t2: 'Porsche', sport: 'Basketball', g: 'Game 10' }],
            },
        },
        // Seven games on earlier dates, so Jul 30 is Game 8. Jul 30 used to hold
        // TWO games — one was removed, dropping its count to 1 — which is what
        // shifts Aug 2 from Game 10 down to Game 9.
        gamesPerDate: { [LG]: { '2026-07-01': 7, [D_EARLY]: 1, [D_LATE]: 1 } },
    };
    dailyData = {
        [D_EARLY]: makeDay('Game 8', [['BMW', 'Jaguar']]),
        [D_LATE]: makeDay('Game 10', [['Ferrari', 'Porsche']]),
    };
    global.localStorage._m = {};
    global.window.leagueAssignments = { Juniors: { 0: { leagueName: LG, gameLabel: 'Game 10', _startMin: 780 } } };
    syncCalls.length = 0;
    savedSchedules.length = 0;
}

const logLabels = (date) => (cloud.leagueHistory.gameLog[LG][date] || []).map(e => e.g);
const tileLabel = (date) => dailyData[date].leagueAssignments.Juniors[0].gameLabel;
const bunkLabel = (date) => dailyData[date].scheduleAssignments.J1[0]._gameLabel;

// =============================================================================
// TEST 1 — the regression: the log must renumber with the schedule
// =============================================================================
{
    seed();
    // Runs the same pass a generation runs at the end of a day's work.
    Leagues.updateFutureSchedules
        ? Leagues.updateFutureSchedules(D_EARLY, cloud.leagueHistory)
        : Leagues._updateFutureSchedules(D_EARLY, cloud.leagueHistory);

    assert.strictEqual(tileLabel(D_LATE), 'Game 9',
        'TEST1: the schedule renumbers to Game 9 (1 game before it), got ' + tileLabel(D_LATE));
    assert.deepStrictEqual(logLabels(D_LATE), ['Game 9'],
        'TEST1: THE BUG — the game log must follow the schedule, got ' + JSON.stringify(logLabels(D_LATE)));
    assert.strictEqual(bunkLabel(D_LATE), 'Game 9', 'TEST1: the per-bunk copy follows too');

    const sync = syncCalls.filter(c => c.date === D_LATE);
    assert.ok(sync.length, 'TEST1: the results page is re-pushed after a relabel');
    assert.strictEqual(sync[sync.length - 1].entries[0].gameLabel, 'Game 9',
        'TEST1: …with the new number, got ' + JSON.stringify(sync[sync.length - 1].entries));
    assert.strictEqual(logLabels(D_EARLY)[0], 'Game 8', 'TEST1: the earlier day is untouched');
    console.log('✅ TEST 1 — an earlier day losing a game renumbers the log, the grid and the results together');
}

// =============================================================================
// TEST 2 — manual renumber reaches every store
// =============================================================================
{
    seed();
    const res = Leagues.renumberGame(LG, D_LATE, 'Game 10', 'Game 9');
    assert.ok(res.ok, 'TEST2: renumber succeeded, got ' + JSON.stringify(res));
    assert.strictEqual(res.swappedWith, null, 'TEST2: nothing to swap with');
    assert.deepStrictEqual(logLabels(D_LATE), ['Game 9'], 'TEST2: game log updated');
    assert.strictEqual(tileLabel(D_LATE), 'Game 9', 'TEST2: league tile updated');
    assert.strictEqual(bunkLabel(D_LATE), 'Game 9', 'TEST2: per-bunk copy updated');
    assert.strictEqual(global.window.leagueAssignments.Juniors[0].gameLabel, 'Game 9',
        'TEST2: the live in-memory copy updated');
    assert.ok(savedSchedules.length, 'TEST2: the day was written back to storage');
    const sync = syncCalls.filter(c => c.date === D_LATE);
    assert.strictEqual(sync[sync.length - 1].entries[0].gameLabel, 'Game 9', 'TEST2: results list updated');
    console.log('✅ TEST 2 — renumberGame moves the number in the log, the grid, the bunk copy and the results');
}

// =============================================================================
// TEST 3 — renumbering onto a number already used that day swaps them
// =============================================================================
{
    seed();
    // Two games on one date, as a camp with two league periods has.
    cloud.leagueHistory.gameLog[LG][D_LATE] = [
        { t1: 'Ferrari', t2: 'Porsche', sport: 'Basketball', g: 'Game 10' },
        { t1: 'Audi', t2: 'Rolls Royce', sport: 'Soccer', g: 'Game 11' },
    ];
    const res = Leagues.renumberGame(LG, D_LATE, 'Game 10', 'Game 11');
    assert.ok(res.ok, 'TEST3: swap succeeded');
    assert.strictEqual(res.swappedWith, 'Game 10', 'TEST3: reported as a swap');
    const byTeam = {};
    cloud.leagueHistory.gameLog[LG][D_LATE].forEach(e => { byTeam[e.t1] = e.g; });
    assert.strictEqual(byTeam.Ferrari, 'Game 11', 'TEST3: Ferrari/Porsche took the new number');
    assert.strictEqual(byTeam.Audi, 'Game 10', 'TEST3: …and the other game took the old one');
    assert.strictEqual(new Set(Object.values(byTeam)).size, 2, 'TEST3: a number is never used twice');
    console.log('✅ TEST 3 — renumbering onto a used number swaps the two games');
}

// =============================================================================
// TEST 4 — bad input is refused
// =============================================================================
{
    seed();
    assert.strictEqual(Leagues.renumberGame(LG, D_LATE, 'Game 99', 'Game 9').ok, false,
        'TEST4: a label that is not on the date is refused');
    assert.deepStrictEqual(logLabels(D_LATE), ['Game 10'], 'TEST4: …and nothing was written');
    assert.strictEqual(Leagues.renumberGame(LG, '2026-01-01', 'Game 10', 'Game 9').ok, false,
        'TEST4: a date with no games is refused');
    assert.strictEqual(Leagues.renumberGame(LG, D_LATE, '', 'Game 9').ok, false, 'TEST4: a blank label is refused');
    assert.ok(Leagues.renumberGame(LG, D_LATE, 'Game 10', 'Game 10').ok, 'TEST4: a no-op renumber is fine');
    assert.deepStrictEqual(logLabels(D_LATE), ['Game 10'], 'TEST4: …and changes nothing');
    console.log('✅ TEST 4 — bad input is refused with nothing half-written');
}

console.log('\n🎉 league_game_renumber_sim: ALL TESTS PASSED');
