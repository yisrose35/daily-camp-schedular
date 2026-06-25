'use strict';
// Tests for window.PostEditFieldChange pure helpers + the apply rewrite engine.
// The string parse/rebuild is the fragile part (two distinct matchup formats);
// applyFieldChange is exercised against in-memory window.* stores.

const test = require('node:test');
const assert = require('node:assert');

// The module guards DOM/window access behind feature checks, so a minimal
// window stub is enough to require it and drive applyFieldChange.
global.window = global.window || {};
const PEFC = require('../post_edit_field_change.js');

test('parseMatchup — regular league "A vs B @ Field (Sport)"', () => {
  const p = PEFC.parseMatchup('Lions vs Tigers @ Baseball Field 2 (Baseball)');
  assert.strictEqual(p.kind, 'at');
  assert.strictEqual(p.teamA, 'Lions');
  assert.strictEqual(p.teamB, 'Tigers');
  assert.strictEqual(p.field, 'Baseball Field 2');
  assert.strictEqual(p.sport, 'Baseball');
});

test('parseMatchup — specialty league "A vs B — Field"', () => {
  const p = PEFC.parseMatchup('Team 1 vs Team 2 — Court 3');
  assert.strictEqual(p.kind, 'dash');
  assert.strictEqual(p.teamA, 'Team 1');
  assert.strictEqual(p.teamB, 'Team 2');
  assert.strictEqual(p.field, 'Court 3');
});

test('parseMatchup — field name containing spaces/numbers survives', () => {
  const p = PEFC.parseMatchup('A vs B — Full Gym (West)');
  assert.strictEqual(p.kind, 'dash');
  assert.strictEqual(p.field, 'Full Gym (West)');
});

test('parseMatchup — bye / chinuch are not editable', () => {
  assert.strictEqual(PEFC.parseMatchup('Sharks — Bye').kind, 'bye');
  assert.strictEqual(PEFC.parseMatchup('Sharks — Chinuch (Beis)').kind, 'chinuch');
  assert.strictEqual(PEFC.isEditableMatchup(PEFC.parseMatchup('Sharks — Bye')), false);
});

test('rebuildMatchup — round-trips and swaps field, preserving format', () => {
  const reg = PEFC.parseMatchup('Lions vs Tigers @ Field A (Soccer)');
  assert.strictEqual(PEFC.rebuildMatchup(reg, 'Field B'), 'Lions vs Tigers @ Field B (Soccer)');

  const spec = PEFC.parseMatchup('T1 vs T2 — Court 1');
  assert.strictEqual(PEFC.rebuildMatchup(spec, 'Court 5'), 'T1 vs T2 — Court 5');
});

test('normalizeGame — accepts structured objects (specialty uiEntry)', () => {
  const g = PEFC.normalizeGame({ teamA: 'Red', teamB: 'Blue', field: 'Pool' }, 'Swim', true);
  assert.strictEqual(g.teamA, 'Red');
  assert.strictEqual(g.field, 'Pool');
  assert.strictEqual(g.kind, 'dash');
});

test('applyFieldChange — rewrites regular-league strings across stores + swaps lock', () => {
  const unlocked = [];
  const locked = [];
  global.window.scheduleAssignments = {
    BunkA: [null, { _h2h: true, _allMatchups: ['Lions vs Tigers @ Field A (Soccer)', 'Bears vs Wolves @ Field C (Soccer)'] }],
    BunkB: [null, { _h2h: true, _allMatchups: ['Lions vs Tigers @ Field A (Soccer)', 'Bears vs Wolves @ Field C (Soccer)'] }],
  };
  global.window.leagueAssignments = {
    Majors: { 1: { _allMatchups: ['Lions vs Tigers @ Field A (Soccer)', 'Bears vs Wolves @ Field C (Soccer)'] } },
  };
  global.window.divisionTimes = { Majors: [null, { startMin: 600, endMin: 645 }] };
  global.window.getAllLocations = () => [{ name: 'Field B', type: 'field', activities: ['Soccer'], capacity: 1 }];
  global.window.GlobalFieldLocks = {
    isFieldLockedByTime: () => null,
    unlockField: (f) => unlocked.push(f),
    lockField: (f) => { locked.push(f); return true; },
  };

  const ctx = {
    kind: 'regular', divName: 'Majors', slotIdx: 1, startMin: 600, endMin: 645,
    leagueName: 'Majors League', slots: [1],
    game: { teamA: 'Lions', teamB: 'Tigers', teams: 'Lions vs Tigers', field: 'Field A', sport: 'Soccer' },
  };
  const res = PEFC.applyFieldChange(ctx, 'Field B');

  assert.strictEqual(res.ok, true);
  // Both bunks + the league store rewrote ONLY the Lions/Tigers game.
  assert.strictEqual(window.scheduleAssignments.BunkA[1]._allMatchups[0], 'Lions vs Tigers @ Field B (Soccer)');
  assert.strictEqual(window.scheduleAssignments.BunkB[1]._allMatchups[0], 'Lions vs Tigers @ Field B (Soccer)');
  assert.strictEqual(window.leagueAssignments.Majors[1]._allMatchups[0], 'Lions vs Tigers @ Field B (Soccer)');
  // Untouched game preserved.
  assert.strictEqual(window.scheduleAssignments.BunkA[1]._allMatchups[1], 'Bears vs Wolves @ Field C (Soccer)');
  // Lock swap happened.
  assert.deepStrictEqual(unlocked, ['Field A']);
  assert.deepStrictEqual(locked, ['Field B']);
});

test('applyFieldChange — specialty updates structured objects + string + gameLog', () => {
  const saved = {};
  global.window.scheduleAssignments = {
    BunkA: [{ _isSpecialtyLeague: true, _allMatchups: ['Red vs Blue — Court 1'], _assignments: [{ teamA: 'Red', teamB: 'Blue', field: 'Court 1' }] }],
  };
  global.window.leagueAssignments = {
    DivX: { 0: { isSpecialtyLeague: true, matchups: [{ teamA: 'Red', teamB: 'Blue', field: 'Court 1' }] } },
  };
  global.window.divisionTimes = { DivX: [{ startMin: 700, endMin: 745 }] };
  global.window.getAllLocations = () => [{ name: 'Court 5', type: 'field', activities: ['Basketball'], capacity: 1 }];
  global.window.GlobalFieldLocks = { isFieldLockedByTime: () => null, unlockField: () => {}, lockField: () => true };
  global.window.currentScheduleDate = '2026-07-01';
  global.window.loadGlobalSettings = () => ({
    specialtyLeagues: [{ id: 'L9', name: 'Hoops League' }],
    specialtyLeagueHistory: { gameLog: { L9: { '2026-07-01': [{ tA: 'Red', tB: 'Blue', field: 'Court 1', g: 'Game 1', s: 1 }] } } },
  });
  global.window.saveGlobalSettings = (k, v) => { saved[k] = v; };

  const ctx = {
    kind: 'specialty', divName: 'DivX', slotIdx: 0, startMin: 700, endMin: 745,
    leagueName: 'Hoops League', slots: [0],
    game: { teamA: 'Red', teamB: 'Blue', teams: 'Red vs Blue', field: 'Court 1', sport: 'Basketball' },
  };
  const res = PEFC.applyFieldChange(ctx, 'Court 5');

  assert.strictEqual(res.ok, true);
  assert.strictEqual(window.scheduleAssignments.BunkA[0]._allMatchups[0], 'Red vs Blue — Court 5');
  assert.strictEqual(window.scheduleAssignments.BunkA[0]._assignments[0].field, 'Court 5');
  assert.strictEqual(window.leagueAssignments.DivX[0].matchups[0].field, 'Court 5');
  // gameLog (history) updated + persisted.
  assert.ok(saved.specialtyLeagueHistory);
  assert.strictEqual(saved.specialtyLeagueHistory.gameLog.L9['2026-07-01'][0].field, 'Court 5');
});

test('applyFieldChange — refuses an occupied field (hard block)', () => {
  global.window.scheduleAssignments = {
    BunkA: [null, { _h2h: true, _allMatchups: ['Lions vs Tigers @ Field A (Soccer)'] }],
  };
  global.window.leagueAssignments = { Majors: { 1: { _allMatchups: ['Lions vs Tigers @ Field A (Soccer)'] } } };
  global.window.divisionTimes = { Majors: [null, { startMin: 600, endMin: 645 }] };
  global.window.getAllLocations = () => [{ name: 'Field B', type: 'field', activities: ['Soccer'], capacity: 1 }];
  // Field B is locked at this time.
  global.window.GlobalFieldLocks = { isFieldLockedByTime: (f) => (f === 'Field B' ? { leagueName: 'Other' } : null), unlockField: () => {}, lockField: () => true };

  const ctx = {
    kind: 'regular', divName: 'Majors', slotIdx: 1, startMin: 600, endMin: 645,
    leagueName: 'L', slots: [1],
    game: { teamA: 'Lions', teamB: 'Tigers', teams: 'Lions vs Tigers', field: 'Field A', sport: 'Soccer' },
  };
  const res = PEFC.applyFieldChange(ctx, 'Field B');
  assert.strictEqual(res.ok, false);
  // No rewrite happened.
  assert.strictEqual(window.scheduleAssignments.BunkA[1]._allMatchups[0], 'Lions vs Tigers @ Field A (Soccer)');
});
