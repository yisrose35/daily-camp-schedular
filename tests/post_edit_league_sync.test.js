'use strict';
// END-TO-END: a post-edit matchup change in the modal (PostEditFieldChange.
// applyFieldChange) must propagate into the REAL league rotation/variety stores
// via SchedulerCoreLeagues.editGameRecord, so the rest of the system "knows"
// the new matchup — future pairing variety, sport variety, and the Leagues-page
// results all follow what was actually played.
//
// Unlike post_edit_field_change.test.js (which mocks editGameRecord), this test
// loads BOTH real modules and asserts the league history after the edit.

const test = require('node:test');
const assert = require('node:assert');

// in-memory cloud + localStorage stubs (mirror league_editgamerecord.test.js)
const cloud = {};
global.localStorage = {
  _m: {},
  getItem(k) { return this._m[k] != null ? this._m[k] : null; },
  setItem(k, v) { this._m[k] = String(v); },
  removeItem(k) { delete this._m[k]; },
};
global.window = global.window || {};
global.window.loadGlobalSettings = () => ({ leagueHistory: cloud.leagueHistory });
global.window.saveGlobalSettings = (k, v) => { cloud[k] = v; };

// Load the real modules (order: leagues first — PEFC calls into it).
require('../scheduler_core_leagues.js');
const PEFC = require('../post_edit_field_change.js');

const mk = (a, b) => [a, b].sort().join('|');

test('post-edit matchup change flows through to the real league history', () => {
  const LG = 'State League', D = '2026-06-30';

  // As generated: L.A vs Dallas played Baseball on Field A.
  cloud.leagueHistory = {
    teamSports: { [`${LG}|L.A`]: ['Baseball'], [`${LG}|Dallas`]: ['Baseball'] },
    matchupHistory: { [`${LG}:${mk('L.A', 'Dallas')}`]: 1 },
    gamesPerDate: {}, offCampusCounts: {},
    gameLog: { [LG]: { [D]: [{ t1: 'L.A', t2: 'Dallas', sport: 'Baseball', g: 'Game 1' }] } },
  };
  global.localStorage._m = {};

  // Schedule + league stores hold the matchup string the user clicked on.
  global.window.scheduleAssignments = {
    BunkA: [null, { _h2h: true, _allMatchups: ['L.A vs Dallas @ Field A (Baseball)'] }],
  };
  global.window.leagueAssignments = {
    Majors: { 1: { _allMatchups: ['L.A vs Dallas @ Field A (Baseball)'] } },
  };
  global.window.divisionTimes = { Majors: [null, { startMin: 600, endMin: 645 }] };
  global.window.GlobalFieldLocks = { isFieldLockedByTime: () => null, unlockField: () => {}, lockField: () => true };
  global.window._scheduleAssignmentsDate = D;            // the edited grid's date
  global.window.saveCurrentDailyData = () => {};
  global.window.bypassSaveAllBunks = () => Promise.resolve();
  global.window.updateTable = () => {};
  // Leagues-page results sync — capture the call so we can assert it fired.
  let syncCall = null;
  global.window.LeaguesAPI = { syncGamesFromGeneration: (lg, date, entries) => { syncCall = { lg, date, entries }; } };

  // The modal's "Save changes — keep field" path: same field, new opponent.
  const ctx = {
    kind: 'regular', divName: 'Majors', slotIdx: 1, startMin: 600, endMin: 645,
    leagueName: LG, slots: [1],
    game: { kind: 'at', teamA: 'L.A', teamB: 'Dallas', teams: 'L.A vs Dallas', field: 'Field A', sport: 'Baseball' },
  };
  const res = PEFC.applyFieldChange(ctx, 'Field A', null, { teamA: 'L.A', teamB: 'Detroit' });
  assert.strictEqual(res.ok, true);

  // (a) The visible schedule strings reflect the new matchup.
  assert.strictEqual(window.scheduleAssignments.BunkA[1]._allMatchups[0], 'L.A vs Detroit @ Field A (Baseball)');
  assert.strictEqual(window.leagueAssignments.Majors[1]._allMatchups[0], 'L.A vs Detroit @ Field A (Baseball)');

  // (b) The REAL rotation/variety stores now know the new matchup, not the old.
  const h = cloud.leagueHistory;
  assert.strictEqual(h.matchupHistory[`${LG}:${mk('L.A', 'Dallas')}`], undefined, 'old pairing must be removed from matchup variety');
  assert.strictEqual(h.matchupHistory[`${LG}:${mk('L.A', 'Detroit')}`], 1, 'new pairing must be recorded for matchup variety');

  // (c) Sport-variety: Dallas no longer credited with this Baseball game;
  //     Detroit now is; L.A still has exactly one Baseball play.
  assert.deepStrictEqual(h.teamSports[`${LG}|Dallas`], [], 'Dallas should lose the moved-away Baseball credit');
  assert.deepStrictEqual(h.teamSports[`${LG}|Detroit`], ['Baseball'], 'Detroit should gain the Baseball credit');
  assert.deepStrictEqual(h.teamSports[`${LG}|L.A`], ['Baseball'], 'L.A keeps exactly one Baseball play');

  // (d) The reversible date-keyed game log shows the new opponents (label kept).
  const logged = h.gameLog[LG][D];
  assert.strictEqual(logged.length, 1);
  assert.strictEqual(mk(logged[0].t1, logged[0].t2), mk('L.A', 'Detroit'));
  assert.strictEqual(logged[0].g, 'Game 1', 'display label preserved');

  // (e) The Leagues-page results store was re-synced with the new matchup.
  assert.ok(syncCall, 'LeaguesAPI.syncGamesFromGeneration should fire');
  assert.strictEqual(syncCall.lg, LG);
  const allMatches = syncCall.entries.flatMap(e => e.matches);
  assert.ok(allMatches.some(m => mk(m.teamA, m.teamB) === mk('L.A', 'Detroit')), 'Leagues page sees the new matchup');
});
