'use strict';
// Tests the REAL SchedulerCoreLeagues.editGameRecord (post-edit rotation sync).
// scheduler_core_leagues.js is a browser IIFE that assigns window.SchedulerCoreLeagues
// as a side effect, so we stub window.{load,save}GlobalSettings + localStorage,
// require it, then drive the exported function against an in-memory history.

const test = require('node:test');
const assert = require('node:assert');

// in-memory cloud + localStorage stubs
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

require('../scheduler_core_leagues.js');
const editGameRecord = global.window.SchedulerCoreLeagues.editGameRecord;
const mk = (a, b) => [a, b].sort().join('|');

function seed(history) { cloud.leagueHistory = history; global.localStorage._m = {}; }

test('editGameRecord — changing teams + sport moves rotation credit correctly', () => {
  const LG = 'State League', D = '2026-06-28';
  // As generated: L.A vs Dallas played Baseball.
  seed({
    teamSports: { [`${LG}|L.A`]: ['Baseball'], [`${LG}|Dallas`]: ['Baseball'] },
    matchupHistory: { [`${LG}:${mk('L.A', 'Dallas')}`]: 1 },
    gamesPerDate: {}, offCampusCounts: {},
    gameLog: { [LG]: { [D]: [{ t1: 'L.A', t2: 'Dallas', sport: 'Baseball', g: 'Game 1' }] } },
  });

  const res = editGameRecord(LG, D,
    { teamA: 'L.A', teamB: 'Dallas', sport: 'Baseball' },
    { teamA: 'N.Y', teamB: 'Toronto', sport: 'Basketball' });

  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.removed, true);
  const h = cloud.leagueHistory;
  // old pair/sport credit removed
  assert.strictEqual(h.matchupHistory[`${LG}:${mk('L.A', 'Dallas')}`], undefined);
  assert.deepStrictEqual(h.teamSports[`${LG}|L.A`], []);
  assert.deepStrictEqual(h.teamSports[`${LG}|Dallas`], []);
  // new pair/sport credit added
  assert.strictEqual(h.matchupHistory[`${LG}:${mk('N.Y', 'Toronto')}`], 1);
  assert.deepStrictEqual(h.teamSports[`${LG}|N.Y`], ['Basketball']);
  assert.deepStrictEqual(h.teamSports[`${LG}|Toronto`], ['Basketball']);
  // gameLog entry rewritten in place, label preserved
  const log = h.gameLog[LG][D];
  assert.strictEqual(log.length, 1);
  assert.strictEqual(log[0].t1, 'N.Y');
  assert.strictEqual(log[0].t2, 'Toronto');
  assert.strictEqual(log[0].sport, 'Basketball');
  assert.strictEqual(log[0].g, 'Game 1');
});

test('editGameRecord — no matching old entry → inserts the new game', () => {
  const LG = 'State League', D = '2026-06-28';
  seed({ teamSports: {}, matchupHistory: {}, gamesPerDate: {}, offCampusCounts: {}, gameLog: {} });

  const res = editGameRecord(LG, D, null, { teamA: 'Miami', teamB: 'Cleveland', sport: 'Hockey' }, 'Game 3');
  assert.strictEqual(res.ok, true);
  const h = cloud.leagueHistory;
  assert.strictEqual(h.matchupHistory[`${LG}:${mk('Miami', 'Cleveland')}`], 1);
  assert.deepStrictEqual(h.teamSports[`${LG}|Miami`], ['Hockey']);
  assert.strictEqual(h.gameLog[LG][D][0].g, 'Game 3');
});

test('editGameRecord — only the matched pair is decremented (rematch count preserved)', () => {
  const LG = 'State League', D = '2026-06-28';
  // L.A vs Dallas met twice historically; today's game is one of them.
  seed({
    teamSports: { [`${LG}|L.A`]: ['Baseball', 'Baseball'], [`${LG}|Dallas`]: ['Baseball', 'Baseball'] },
    matchupHistory: { [`${LG}:${mk('L.A', 'Dallas')}`]: 2 },
    gamesPerDate: {}, offCampusCounts: {},
    gameLog: { [LG]: { [D]: [{ t1: 'L.A', t2: 'Dallas', sport: 'Baseball', g: 'Game 1' }] } },
  });

  editGameRecord(LG, D,
    { teamA: 'L.A', teamB: 'Dallas', sport: 'Baseball' },
    { teamA: 'L.A', teamB: 'Dallas', sport: 'Hockey' }); // same teams, new sport

  const h = cloud.leagueHistory;
  // matchup count decremented then re-incremented (same pair) → back to 2
  assert.strictEqual(h.matchupHistory[`${LG}:${mk('L.A', 'Dallas')}`], 2);
  // one Baseball removed, one Hockey added per team
  assert.deepStrictEqual(h.teamSports[`${LG}|L.A`].sort(), ['Baseball', 'Hockey']);
  assert.deepStrictEqual(h.teamSports[`${LG}|Dallas`].sort(), ['Baseball', 'Hockey']);
});
