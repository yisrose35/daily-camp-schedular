// =========================================================================
// regen_league_history_reconcile_sim.js
//
// Per-tile regen must leave the persistent league record agreeing with the
// grid. Two independent ways it used to disagree, both reported live as
// "the matchup doesn't go away — the program still thinks they played it":
//
//   A. The league tile is DELETED (or moved) and the neighbouring tile is
//      regenerated. No selection lands on the old game's start time, so
//      buildTimeRegenScope lists its label as "preserved" and the engine's
//      day-rollback keeps the record — for a game that is no longer anywhere
//      on the schedule.
//   B. A bunk's entries can't be safely re-keyed, so it re-rolls its WHOLE
//      day (fullRerollBunks). scheduler_core_main STEP 3 decides to re-roll a
//      league period from the FINAL regen set, so every league period is
//      re-rolled — but preservation was keyed off the raw selection, so the
//      old record was preserved AND a fresh one was logged. Two records, one
//      game, and the old matchup still counting.
//
// Fixes proven here:
//   • buildTimeRegenScope preserves off the FINAL regen sets (kills B), using
//     the REAL division_times_system.js.
//   • Leagues.reconcileDayWithSchedule rolls back every day-record whose game
//     label is no longer on the grid (kills A), mirrored from
//     scheduler_core_leagues.js rollbackDayRecords + _rollbackToSurvivors.
//
// Run: node --test tests/regen_league_history_reconcile_sim.js
// =========================================================================
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// ── load the REAL buildTimeRegenScope ──────────────────────────────────────
global.window = { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => {} };
global.document = { addEventListener: () => {}, getElementById: () => null, querySelectorAll: () => [] };
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.window.localStorage = global.localStorage;
global.window.CampUtils = {
    minutesToTimeLabel: function (m) {
        const h = Math.floor(m / 60), mm = m % 60, ap = h >= 12 ? 'pm' : 'am', h12 = h % 12 || 12;
        return h12 + ':' + (mm < 10 ? '0' + mm : mm) + ap;
    }
};
eval(fs.readFileSync(path.join(__dirname, '..', 'division_times_system.js'), 'utf8'));
const DTS = global.window.DivisionTimesSystem;

// ── mirror: scheduler_core_utils.js Utils.survivingLeagueLabels ────────────
function survivingLeagueLabels(leagueAssignments) {
    const regular = {}, specialty = {};
    Object.keys(leagueAssignments || {}).forEach(function (dv) {
        const map = leagueAssignments[dv];
        if (!map || typeof map !== 'object') return;
        Object.keys(map).forEach(function (k) {
            const e = map[k];
            if (!e || !e.leagueName || !e.gameLabel) return;
            const bucket = e.isSpecialtyLeague ? specialty : regular;
            (bucket[e.leagueName] = bucket[e.leagueName] || new Set()).add(e.gameLabel);
        });
    });
    return { regular: regular, specialty: specialty };
}

// ── mirror: scheduler_core_leagues.js rollbackDayRecords ───────────────────
const matchupKey = (a, b) => [a, b].sort().join('|');
function rollbackDayRecords(leagueName, date, history, preservedLabels, keepUnlabeled) {
    const entries = history.gameLog?.[leagueName]?.[date];
    if (!entries || !entries.length) return 0;
    const keepFn = function (e) {
        if (!e) return false;
        if (!e.g) return keepUnlabeled === true;
        return !!(preservedLabels && preservedLabels.has(e.g));
    };
    const keep = (keepUnlabeled === true || (preservedLabels && preservedLabels.size))
        ? entries.filter(keepFn) : [];
    const roll = (keep.length) ? entries.filter(e => keep.indexOf(e) < 0) : entries;
    roll.forEach(function (e) {
        if (e.sport) [e.t1, e.t2].forEach(function (t) {
            const arr = history.teamSports[`${leagueName}|${t}`];
            if (!arr) return;
            const i = arr.lastIndexOf(e.sport);
            if (i !== -1) arr.splice(i, 1);
        });
        if (e.t1 && e.t2) {
            const mk = `${leagueName}:${matchupKey(e.t1, e.t2)}`;
            if (history.matchupHistory[mk] > 1) history.matchupHistory[mk]--;
            else delete history.matchupHistory[mk];
        }
    });
    if (keep.length) history.gameLog[leagueName][date] = keep;
    else delete history.gameLog[leagueName][date];
    return roll.length;
}

// ── mirror: scheduler_core_leagues.js _rollbackToSurvivors ─────────────────
function reconcileDayWithSchedule(leagues, dateKey, surv, history) {
    leagues.forEach(function (league) {
        const dayRecs = history.gameLog?.[league.name]?.[dateKey];
        if (!dayRecs || !dayRecs.length) return;
        const raw = surv[league.name];
        const preserved = (raw instanceof Set) ? (raw.size ? raw : null) : null;
        if (rollbackDayRecords(league.name, dateKey, history, preserved, true) <= 0) return;
        const kept = history.gameLog?.[league.name]?.[dateKey] || [];
        const keptGames = new Set(kept.map(r => r && r.g).filter(Boolean)).size;
        if (keptGames > 0) {
            history.gamesPerDate[league.name] = history.gamesPerDate[league.name] || {};
            history.gamesPerDate[league.name][dateKey] = keptGames;
        } else if (history.gamesPerDate?.[league.name]?.[dateKey] !== undefined) {
            delete history.gamesPerDate[league.name][dateKey];
        }
    });
}

// ── mirror: scheduler_core_leagues.js logGameRecord + recordMatchup ────────
function logGame(h, lg, date, t1, t2, sport, label) {
    ((h.gameLog[lg] = h.gameLog[lg] || {})[date] = h.gameLog[lg][date] || [])
        .push({ t1, t2, sport: sport || null, g: label || null });
    const mk = `${lg}:${matchupKey(t1, t2)}`;
    h.matchupHistory[mk] = (h.matchupHistory[mk] || 0) + 1;
    [t1, t2].forEach(t => {
        const k = `${lg}|${t}`;
        (h.teamSports[k] = h.teamSports[k] || []).push(sport);
    });
}
const freshHistory = () => ({ gameLog: {}, matchupHistory: {}, teamSports: {}, gamesPerDate: {} });

const LEAGUES = [{ name: 'Camp League', divisions: ['A'], teams: ['T1', 'T2', 'T3', 'T4'] }];
const DAY = '2026-07-14';

// =========================================================================
test('A: league tile deleted → its day-record is rolled back by the reconcile', () => {
    const divisions = { A: { bunks: ['A1'] } };
    // The user deleted the 10:00 league tile and stretched Sports over the gap.
    const skeleton = [
        { division: 'A', startTime: '9:00am', endTime: '11:00am', event: 'Sports Slot', type: 'slot' }
    ];
    // Schedule + league store still hold the PRE-edit day.
    const scheduleAssignments = {
        A1: [{ _activity: 'Soccer', _startMin: 540, _endMin: 600 }, null]
    };
    const leagueAssignments = {
        A: { 1: { leagueName: 'Camp League', gameLabel: 'Game 1', sport: 'Basketball', _startMin: 600, _endMin: 660, matchups: ['T1 vs T2'] } }
    };

    const scope = DTS.buildTimeRegenScope({
        selections: [{ bunk: 'A1', startMin: 540, endMin: 660 }],
        skeleton, divisions, scheduleAssignments, leagueAssignments
    });
    assert.ok(scope.ok, 'scope builds');

    // The prediction still lists the game as preserved — the league period no
    // longer exists in the new geometry, so nothing can be selected at 10:00.
    assert.deepStrictEqual(scope.preservedLeagueLabels['Camp League'], ['Game 1'],
        'prediction preserves a game that is about to vanish from the grid');

    // Engine run: day-rollback honours the prediction, nothing re-logs the game.
    const h = freshHistory();
    logGame(h, 'Camp League', DAY, 'T1', 'T2', 'Basketball', 'Game 1');
    h.gamesPerDate['Camp League'] = { [DAY]: 1 };
    rollbackDayRecords('Camp League', DAY, h, new Set(scope.preservedLeagueLabels['Camp League']));
    assert.strictEqual(h.matchupHistory['Camp League:T1|T2'], 1,
        'without the reconcile the matchup survives (the reported bug)');

    // The grid the run actually produced: no league anywhere.
    const finalLeagueAssignments = {};
    reconcileDayWithSchedule(LEAGUES, DAY, survivingLeagueLabels(finalLeagueAssignments).regular, h);

    assert.strictEqual(h.matchupHistory['Camp League:T1|T2'], undefined, 'matchup released');
    assert.strictEqual(h.gameLog['Camp League'][DAY], undefined, 'day-record gone');
    assert.deepStrictEqual(h.teamSports['Camp League|T1'], [], 'sport variety released');
    assert.strictEqual(h.gamesPerDate['Camp League'][DAY], undefined, 'game count cleared');
});

// =========================================================================
test('B: whole-day re-roll no longer preserves the league periods it re-rolls', () => {
    const divisions = { A: { bunks: ['A1'] } };
    const skeleton = [
        { division: 'A', startTime: '9:00am', endTime: '10:00am', event: 'Sports Slot', type: 'slot' },
        { division: 'A', startTime: '10:00am', endTime: '11:00am', event: 'Camp League', type: 'league' },
        { division: 'A', startTime: '11:00am', endTime: '12:00pm', event: 'Camp League', type: 'league' }
    ];
    // An entry with no _startMin can't be re-keyed → the bunk re-rolls its whole day.
    const scheduleAssignments = { A1: [{ _activity: 'Soccer' }, null, null] };
    const leagueAssignments = {
        A: {
            1: { leagueName: 'Camp League', gameLabel: 'Game 1', sport: 'Basketball', _startMin: 600, matchups: ['T1 vs T2'] },
            2: { leagueName: 'Camp League', gameLabel: 'Game 2', sport: 'Hockey', _startMin: 660, matchups: ['T3 vs T4'] }
        }
    };

    const scope = DTS.buildTimeRegenScope({
        selections: [{ bunk: 'A1', startMin: 540, endMin: 600 }],
        skeleton, divisions, scheduleAssignments, leagueAssignments
    });
    assert.ok(scope.ok);
    assert.deepStrictEqual(scope.fullRerollBunks, ['A1'], 'A1 falls back to a whole-day re-roll');

    // STEP 3 re-rolls a league period when ANY of the division's bunks has that
    // slot in `regen` — with a whole-day re-roll, that is every league period.
    const regen = scope.regenScope.A1.regen;
    assert.ok(regen.has(1) && regen.has(2), 'both league periods are in the regen set');

    // …so neither may be listed as preserved.
    assert.deepStrictEqual(scope.preservedLeagueLabels['Camp League'], undefined,
        'a period being re-rolled is never preserved (was: both preserved → duplicate records)');

    // End to end: rollback then re-log leaves exactly the fresh games.
    const h = freshHistory();
    logGame(h, 'Camp League', DAY, 'T1', 'T2', 'Basketball', 'Game 1');
    logGame(h, 'Camp League', DAY, 'T3', 'T4', 'Hockey', 'Game 2');
    const plbl = scope.preservedLeagueLabels['Camp League'];
    rollbackDayRecords('Camp League', DAY, h, plbl ? new Set(plbl) : null);
    logGame(h, 'Camp League', DAY, 'T1', 'T3', 'Basketball', 'Game 1');
    logGame(h, 'Camp League', DAY, 'T2', 'T4', 'Hockey', 'Game 2');

    assert.strictEqual(h.gameLog['Camp League'][DAY].length, 2, 'exactly the two games played');
    assert.strictEqual(h.matchupHistory['Camp League:T1|T2'], undefined, 'replaced matchup released');
    assert.strictEqual(h.matchupHistory['Camp League:T1|T3'], 1, 'fresh matchup recorded once');
    assert.deepStrictEqual(h.teamSports['Camp League|T1'], ['Basketball'], 'sport counted once, not twice');
});

// =========================================================================
test('a league period the user did NOT touch keeps its record', () => {
    const divisions = { A: { bunks: ['A1'] } };
    const skeleton = [
        { division: 'A', startTime: '9:00am', endTime: '10:00am', event: 'Sports Slot', type: 'slot' },
        { division: 'A', startTime: '10:00am', endTime: '11:00am', event: 'Camp League', type: 'league' }
    ];
    const scheduleAssignments = { A1: [{ _activity: 'Soccer', _startMin: 540, _endMin: 600 }, null] };
    const leagueAssignments = {
        A: { 1: { leagueName: 'Camp League', gameLabel: 'Game 1', sport: 'Basketball', _startMin: 600, matchups: ['T1 vs T2'] } }
    };

    const scope = DTS.buildTimeRegenScope({
        selections: [{ bunk: 'A1', startMin: 540, endMin: 600 }],
        skeleton, divisions, scheduleAssignments, leagueAssignments
    });
    assert.deepStrictEqual(scope.preservedLeagueLabels['Camp League'], ['Game 1'],
        'untouched league period stays preserved');

    const h = freshHistory();
    logGame(h, 'Camp League', DAY, 'T1', 'T2', 'Basketball', 'Game 1');
    h.gamesPerDate['Camp League'] = { [DAY]: 1 };
    rollbackDayRecords('Camp League', DAY, h, new Set(scope.preservedLeagueLabels['Camp League']));

    // The grid still shows the game → the reconcile is a no-op.
    reconcileDayWithSchedule(LEAGUES, DAY, survivingLeagueLabels(leagueAssignments).regular, h);
    assert.strictEqual(h.matchupHistory['Camp League:T1|T2'], 1, 'record survives');
    assert.strictEqual(h.gameLog['Camp League'][DAY].length, 1);
    assert.strictEqual(h.gamesPerDate['Camp League'][DAY], 1);
});

// =========================================================================
test('reconcile leaves an UNLABELLED day-record alone (cannot be matched)', () => {
    const h = freshHistory();
    logGame(h, 'Camp League', DAY, 'T1', 'T2', 'Basketball', null); // hand-edited record
    logGame(h, 'Camp League', DAY, 'T3', 'T4', 'Hockey', 'Game 2');
    const grid = {
        A: { 1: { leagueName: 'Camp League', gameLabel: 'Game 2', sport: 'Hockey', matchups: ['T3 vs T4'] } }
    };
    reconcileDayWithSchedule(LEAGUES, DAY, survivingLeagueLabels(grid).regular, h);
    assert.strictEqual(h.matchupHistory['Camp League:T1|T2'], 1, 'unlabelled record untouched');
    assert.strictEqual(h.matchupHistory['Camp League:T3|T4'], 1, 'on-grid record untouched');
    assert.strictEqual(h.gameLog['Camp League'][DAY].length, 2);
});

// =========================================================================
test('reconcile after a FULL generation is a no-op', () => {
    const h = freshHistory();
    logGame(h, 'Camp League', DAY, 'T1', 'T3', 'Basketball', 'Game 1');
    h.gamesPerDate['Camp League'] = { [DAY]: 1 };
    const grid = {
        A: { 1: { leagueName: 'Camp League', gameLabel: 'Game 1', sport: 'Basketball', matchups: ['T1 vs T3'] } }
    };
    const before = JSON.stringify(h);
    reconcileDayWithSchedule(LEAGUES, DAY, survivingLeagueLabels(grid).regular, h);
    assert.strictEqual(JSON.stringify(h), before, 'history unchanged');
});
