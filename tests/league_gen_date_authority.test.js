'use strict';
// Regression: the league engine must key its history writes (day-reset
// rollback + gameLog) off the AUTHORITATIVE gen-date — window._activeGenDate,
// snapshotted at generation entry (FN-14) — NOT the global date picker
// (window.currentScheduleDate), which can transiently revert to the
// PREVIOUSLY loaded date mid-generation (the accumulated-async race CB-23
// documents). When that race fired, the engine rolled back the WRONG day's
// records and left the gen-date's stale entries in place, so Play History
// showed a sport for a date whose real (regenerated) schedule played a
// different one — observed live: history said Baseball on Jul 6 when the
// schedule actually played Basketball.
//
// Drives the REAL SchedulerCoreLeagues.processRegularLeagues with a regen
// context that covers the league's division but has no league blocks (the
// minimal shape that still triggers the FN-54 day-reset).

const test = require('node:test');
const assert = require('node:assert');

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
const SCL = global.window.SchedulerCoreLeagues;

const LG = 'State League';
const D_PREV = '2026-07-02';   // previously loaded/viewed day (already played)
const D_GEN = '2026-07-06';    // the day actually being (re)generated

function seed() {
  cloud.leagueHistory = {
    teamSports: {
      [`${LG}|L.A`]: ['Baseball', 'Basketball'],
      [`${LG}|Dallas`]: ['Baseball', 'Basketball'],
    },
    matchupHistory: { [`${LG}:Dallas|L.A`]: 2 },
    gamesPerDate: { [LG]: { [D_PREV]: 1, [D_GEN]: 1 } },
    offCampusCounts: {},
    gameLog: {
      [LG]: {
        [D_PREV]: [{ t1: 'L.A', t2: 'Dallas', sport: 'Baseball', g: 'Game 1' }],
        [D_GEN]: [{ t1: 'L.A', t2: 'Dallas', sport: 'Basketball', g: 'Game 2' }],
      },
    },
  };
  global.localStorage._m = {};
}

function runEngine() {
  SCL.processRegularLeagues({
    schedulableSlotBlocks: [],
    masterLeagues: {
      [LG]: {
        name: LG, enabled: true, divisions: ['Juniors'],
        teams: ['L.A', 'Dallas'], sports: ['Baseball', 'Basketball'],
      },
    },
    disabledLeagues: [],
    divisions: {},
    fillBlock: null,
    fieldUsageBySlot: {},
    activityProperties: {},
    // Regen covering the league's division → the FN-54 day-reset is in play
    // even though the skeleton has no league blocks this run.
    generatedDivisions: ['Juniors'],
  });
}

test('mid-gen picker revert: day-reset keys off window._activeGenDate, not the picker', () => {
  seed();
  // The race: generation targets D_GEN (snapshotted at entry), but the global
  // picker has transiently reverted to the previously loaded date.
  global.window._activeGenDate = D_GEN;
  global.window.currentScheduleDate = D_PREV;
  try {
    runEngine();
  } finally {
    global.window._activeGenDate = null;
    delete global.window.currentScheduleDate;
  }

  const h = cloud.leagueHistory;
  // The GEN date's records were rolled back (this regen replaces that day)...
  assert.strictEqual(h.gameLog[LG][D_GEN], undefined,
    'gen-date gameLog records must be rolled back');
  assert.strictEqual(h.gamesPerDate[LG][D_GEN], undefined,
    'gen-date games-per-date entry must be cleared');
  // ...while the picker's (previous, already-played) day keeps its records.
  assert.deepStrictEqual(h.gameLog[LG][D_PREV],
    [{ t1: 'L.A', t2: 'Dallas', sport: 'Baseball', g: 'Game 1' }],
    'the previously loaded day must keep its records');
  assert.strictEqual(h.gamesPerDate[LG][D_PREV], 1,
    'the previously loaded day must keep its games-per-date count');
  // Only the gen-date's sport contribution is subtracted from the aggregates.
  assert.deepStrictEqual(h.teamSports[`${LG}|L.A`], ['Baseball']);
  assert.deepStrictEqual(h.teamSports[`${LG}|Dallas`], ['Baseball']);
  assert.strictEqual(h.matchupHistory[`${LG}:Dallas|L.A`], 1);
});

test('no snapshot set (manual/legacy path): falls back to the picker date unchanged', () => {
  seed();
  global.window._activeGenDate = null;
  global.window.currentScheduleDate = D_GEN;
  try {
    runEngine();
  } finally {
    delete global.window.currentScheduleDate;
  }

  const h = cloud.leagueHistory;
  assert.strictEqual(h.gameLog[LG][D_GEN], undefined,
    'picker date is still the day-reset target when no snapshot exists');
  assert.deepStrictEqual(h.gameLog[LG][D_PREV],
    [{ t1: 'L.A', t2: 'Dallas', sport: 'Baseball', g: 'Game 1' }]);
});
