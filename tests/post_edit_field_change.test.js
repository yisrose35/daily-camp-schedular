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

test('applyFieldChange — OVERRIDE lets you place on an occupied field (warned double-book)', () => {
  global.window.scheduleAssignments = {
    BunkA: [null, { _h2h: true, _allMatchups: ['Lions vs Tigers @ Field A (Soccer)'] }],
  };
  global.window.leagueAssignments = { Majors: { 1: { _allMatchups: ['Lions vs Tigers @ Field A (Soccer)'] } } };
  global.window.divisionTimes = { Majors: [null, { startMin: 600, endMin: 645 }] };
  global.window.getAllLocations = () => [{ name: 'Field B', type: 'field', activities: ['Soccer'], capacity: 1 }];
  // Field B is locked at this time — would be a hard block WITHOUT override.
  global.window.GlobalFieldLocks = { isFieldLockedByTime: (f) => (f === 'Field B' ? { leagueName: 'Other' } : null), unlockField: () => {}, lockField: () => true };

  const ctx = {
    kind: 'regular', divName: 'Majors', slotIdx: 1, startMin: 600, endMin: 645,
    leagueName: 'L', slots: [1],
    game: { teamA: 'Lions', teamB: 'Tigers', teams: 'Lions vs Tigers', field: 'Field A', sport: 'Soccer' },
  };
  const res = PEFC.applyFieldChange(ctx, 'Field B', null, null, { override: true });
  assert.strictEqual(res.ok, true);
  // The move went through despite the conflict.
  assert.strictEqual(window.scheduleAssignments.BunkA[1]._allMatchups[0], 'Lions vs Tigers @ Field B (Soccer)');
  assert.strictEqual(window.leagueAssignments.Majors[1]._allMatchups[0], 'Lions vs Tigers @ Field B (Soccer)');
});

test('applyFieldChange — change matchup TEAMS while keeping the SAME field', () => {
  global.window.scheduleAssignments = {
    BunkA: [null, { _h2h: true, _allMatchups: ['Lions vs Tigers @ Field A (Soccer)'] }],
  };
  global.window.leagueAssignments = { Majors: { 1: { _allMatchups: ['Lions vs Tigers @ Field A (Soccer)'] } } };
  global.window.divisionTimes = { Majors: [null, { startMin: 600, endMin: 645 }] };
  global.window.GlobalFieldLocks = { isFieldLockedByTime: () => null, unlockField: () => {}, lockField: () => true };
  let editArgs = null;
  global.window.SchedulerCoreLeagues = { editGameRecord: (lg, date, oldG, newG) => { editArgs = { lg, date, oldG, newG }; } };
  global.window._scheduleAssignmentsDate = '2026-06-30';

  const ctx = {
    kind: 'regular', divName: 'Majors', slotIdx: 1, startMin: 600, endMin: 645,
    leagueName: 'Majors League', slots: [1],
    game: { teamA: 'Lions', teamB: 'Tigers', teams: 'Lions vs Tigers', field: 'Field A', sport: 'Soccer' },
  };
  // Same field, new opponent for Lions.
  const res = PEFC.applyFieldChange(ctx, 'Field A', null, { teamA: 'Lions', teamB: 'Bears' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(window.scheduleAssignments.BunkA[1]._allMatchups[0], 'Lions vs Bears @ Field A (Soccer)');
  assert.strictEqual(window.leagueAssignments.Majors[1]._allMatchups[0], 'Lions vs Bears @ Field A (Soccer)');
  // Rotation history was synced for the teams change.
  assert.ok(editArgs, 'editGameRecord should have been called');
  assert.strictEqual(editArgs.newG.teamB, 'Bears');
});

test('applyFieldChange — refuses a field with a PARTIAL time overlap (even a few minutes)', () => {
  global.window.scheduleAssignments = {
    BunkA: [null, { _h2h: true, _allMatchups: ['Lions vs Tigers @ Field A (Soccer)'] }],
    // Another bunk sits on Field B 640–700: only a 5-minute overlap with 600–645.
    Other: [null, { field: 'Field B', _startMin: 640, _endMin: 700 }],
  };
  global.window.leagueAssignments = { Majors: { 1: { _allMatchups: ['Lions vs Tigers @ Field A (Soccer)'] } } };
  global.window.divisionTimes = { Majors: [null, { startMin: 600, endMin: 645 }] };
  global.window.fieldLabel = (f) => f;
  global.window.GlobalFieldLocks = { isFieldLockedByTime: () => null, unlockField: () => {}, lockField: () => true };

  const ctx = {
    kind: 'regular', divName: 'Majors', slotIdx: 1, startMin: 600, endMin: 645,
    leagueName: 'L', slots: [1],
    game: { teamA: 'Lions', teamB: 'Tigers', teams: 'Lions vs Tigers', field: 'Field A', sport: 'Soccer' },
  };
  const res = PEFC.applyFieldChange(ctx, 'Field B');
  assert.strictEqual(res.ok, false, 'a 5-minute overlap should block the move');
  assert.strictEqual(window.scheduleAssignments.BunkA[1]._allMatchups[0], 'Lions vs Tigers @ Field A (Soccer)');
});

test('applyFieldChange — changes the SPORT on a regular-league matchup (same field)', () => {
  global.window.scheduleAssignments = {
    BunkA: [null, { _h2h: true, _allMatchups: ['Lions vs Tigers @ Field A (Soccer)'] }],
  };
  global.window.leagueAssignments = { Majors: { 1: { _allMatchups: ['Lions vs Tigers @ Field A (Soccer)'] } } };
  global.window.divisionTimes = { Majors: [null, { startMin: 600, endMin: 645 }] };
  global.window.GlobalFieldLocks = { isFieldLockedByTime: () => null, unlockField: () => {}, lockField: () => true };

  const ctx = {
    kind: 'regular', divName: 'Majors', slotIdx: 1, startMin: 600, endMin: 645,
    leagueName: 'L', slots: [1],
    game: { teamA: 'Lions', teamB: 'Tigers', teams: 'Lions vs Tigers', field: 'Field A', sport: 'Soccer' },
  };
  const res = PEFC.applyFieldChange(ctx, 'Field A', 'Hockey');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(window.scheduleAssignments.BunkA[1]._allMatchups[0], 'Lions vs Tigers @ Field A (Hockey)');
  assert.strictEqual(window.leagueAssignments.Majors[1]._allMatchups[0], 'Lions vs Tigers @ Field A (Hockey)');
});

test('applyFieldChange — changes sport AND field together', () => {
  global.window.scheduleAssignments = {
    BunkA: [null, { _h2h: true, _allMatchups: ['Lions vs Tigers @ Field A (Soccer)'] }],
  };
  global.window.leagueAssignments = { Majors: { 1: { _allMatchups: ['Lions vs Tigers @ Field A (Soccer)'] } } };
  global.window.divisionTimes = { Majors: [null, { startMin: 600, endMin: 645 }] };
  global.window.fieldLabel = (f) => f;
  global.window.GlobalFieldLocks = { isFieldLockedByTime: () => null, unlockField: () => {}, lockField: () => true };

  const ctx = {
    kind: 'regular', divName: 'Majors', slotIdx: 1, startMin: 600, endMin: 645,
    leagueName: 'L', slots: [1],
    game: { teamA: 'Lions', teamB: 'Tigers', teams: 'Lions vs Tigers', field: 'Field A', sport: 'Soccer' },
  };
  const res = PEFC.applyFieldChange(ctx, 'Hockey Rink', 'Hockey');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(window.scheduleAssignments.BunkA[1]._allMatchups[0], 'Lions vs Tigers @ Hockey Rink (Hockey)');
});

test('field is blocked when ANOTHER division uses it for a league at that time (real field in matchup, not entry.field)', () => {
  // Younger game 600–645 wants to move; Senior division plays on "Younger Hill 1"
  // 630–700 (overlaps). The senior entry.field is "League: Senior" — the real
  // field is ONLY inside its matchup string. No GlobalFieldLocks initialized.
  global.window.scheduleAssignments = {
    Y1: [{ _h2h: true, _startMin: 600, _endMin: 645, field: 'League: Younger', _allMatchups: ['Lions vs Tigers @ Field A (Baseball)'] }],
    S1: [{ _h2h: true, _startMin: 630, _endMin: 700, field: 'League: Senior', _allMatchups: ['Sharks vs Bears @ Younger Hill 1 (Baseball)'] }],
  };
  global.window.leagueAssignments = { Younger: { 0: { _allMatchups: ['Lions vs Tigers @ Field A (Baseball)'] } } };
  global.window.fieldLabel = (f) => f;
  delete global.window.GlobalFieldLocks; // simulate locks not initialized in post-edit
  global.window.getAllLocations = () => [{ name: 'Younger Hill 1', type: 'field', activities: ['Baseball'], capacity: 1 }];
  delete global.window.findFieldsForActivity;

  const ctx = {
    kind: 'regular', divName: 'Younger', slotIdx: 0, startMin: 600, endMin: 645,
    leagueName: 'L', slots: [0],
    game: { teamA: 'Lions', teamB: 'Tigers', teams: 'Lions vs Tigers', field: 'Field A', sport: 'Baseball' },
  };
  const res = PEFC.applyFieldChange(ctx, 'Younger Hill 1');
  assert.strictEqual(res.ok, false, "a field used by another division's league should be blocked");
  assert.strictEqual(window.scheduleAssignments.Y1[0]._allMatchups[0], 'Lions vs Tigers @ Field A (Baseball)');
});

test('connected grades: a change from one division auto-updates the other division copy', () => {
  // Same game shared by Younger + Senior (connected league). Each division has
  // its own leagueAssignments copy + its own participant bunks.
  global.window.scheduleAssignments = {
    Y1: [{ _h2h: true, _startMin: 600, _endMin: 645, field: 'League: Combined', _allMatchups: ['Lions vs Tigers @ Field A (Soccer)'] }],
    S1: [{ _h2h: true, _startMin: 600, _endMin: 645, field: 'League: Combined', _allMatchups: ['Lions vs Tigers @ Field A (Soccer)'] }],
  };
  global.window.leagueAssignments = {
    Younger: { 0: { _allMatchups: ['Lions vs Tigers @ Field A (Soccer)'] } },
    Senior:  { 0: { _allMatchups: ['Lions vs Tigers @ Field A (Soccer)'] } },
  };
  global.window.divisionTimes = { Younger: [{ startMin: 600, endMin: 645 }] };
  global.window.fieldLabel = (f) => f;
  global.window.getAllLocations = () => [{ name: 'Field B', type: 'field', activities: ['Soccer'], capacity: 1 }];
  global.window.GlobalFieldLocks = { isFieldLockedByTime: () => null, unlockField: () => {}, lockField: () => true };
  delete global.window.findFieldsForActivity;

  const ctx = {
    kind: 'regular', divName: 'Younger', slotIdx: 0, startMin: 600, endMin: 645,
    leagueName: 'Combined', slots: [0],
    game: { teamA: 'Lions', teamB: 'Tigers', teams: 'Lions vs Tigers', field: 'Field A', sport: 'Soccer' },
  };
  const res = PEFC.applyFieldChange(ctx, 'Field B');
  assert.strictEqual(res.ok, true);
  // BOTH divisions' league stores updated.
  assert.strictEqual(window.leagueAssignments.Younger[0]._allMatchups[0], 'Lions vs Tigers @ Field B (Soccer)');
  assert.strictEqual(window.leagueAssignments.Senior[0]._allMatchups[0], 'Lions vs Tigers @ Field B (Soccer)');
  // BOTH divisions' participant bunks updated.
  assert.strictEqual(window.scheduleAssignments.Y1[0]._allMatchups[0], 'Lions vs Tigers @ Field B (Soccer)');
  assert.strictEqual(window.scheduleAssignments.S1[0]._allMatchups[0], 'Lions vs Tigers @ Field B (Soccer)');
});

test('applyFieldChange — changes the matchup TEAMS + syncs regular-league rotation', () => {
  const edits = [];
  global.window.scheduleAssignments = {
    BunkA: [null, { _h2h: true, _allMatchups: ['L.A vs Dallas @ Clubhouse (Baseball)', 'Miami vs Cleveland @ Powerplay (Hockey)'] }],
  };
  global.window.leagueAssignments = {
    State: { 1: { leagueName: 'State League', _allMatchups: ['L.A vs Dallas @ Clubhouse (Baseball)', 'Miami vs Cleveland @ Powerplay (Hockey)'] } },
  };
  global.window.divisionTimes = { State: [null, { startMin: 600, endMin: 645 }] };
  global.window.fieldLabel = (f) => f;
  global.window.getAllLocations = () => [{ name: 'ABBL Arena', type: 'field', activities: ['Basketball'], capacity: 1 }];
  global.window.GlobalFieldLocks = { isFieldLockedByTime: () => null, unlockField: () => {}, lockField: () => true };
  delete global.window.findFieldsForActivity;
  global.window.leaguesByName = { 'State League': { teams: ['N.Y', 'Toronto', 'L.A', 'Dallas', 'Miami', 'Cleveland'], sports: ['Basketball', 'Baseball', 'Hockey'] } };
  global.window.currentScheduleDate = '2026-06-28';
  global.window.SchedulerCoreLeagues = { editGameRecord: (...a) => { edits.push(a); return { ok: true }; } };

  const ctx = {
    kind: 'regular', divName: 'State', slotIdx: 1, startMin: 600, endMin: 645,
    leagueName: 'State League', slots: [1],
    game: { teamA: 'L.A', teamB: 'Dallas', teams: 'L.A vs Dallas', field: 'Clubhouse', sport: 'Baseball' },
  };
  // Change L.A vs Dallas → N.Y vs Toronto, Basketball, ABBL Arena.
  const res = PEFC.applyFieldChange(ctx, 'ABBL Arena', 'Basketball', { teamA: 'N.Y', teamB: 'Toronto' });

  assert.strictEqual(res.ok, true);
  assert.strictEqual(window.scheduleAssignments.BunkA[1]._allMatchups[0], 'N.Y vs Toronto @ ABBL Arena (Basketball)');
  assert.strictEqual(window.leagueAssignments.State[1]._allMatchups[0], 'N.Y vs Toronto @ ABBL Arena (Basketball)');
  // Other game untouched.
  assert.strictEqual(window.scheduleAssignments.BunkA[1]._allMatchups[1], 'Miami vs Cleveland @ Powerplay (Hockey)');
  // Rotation sync fired with old + new game.
  assert.strictEqual(edits.length, 1);
  assert.deepStrictEqual(edits[0][2], { teamA: 'L.A', teamB: 'Dallas', sport: 'Baseball' });
  assert.deepStrictEqual(edits[0][3], { teamA: 'N.Y', teamB: 'Toronto', sport: 'Basketball' });
});

test('applyFieldChange — rotation sync targets the EDITED schedule date, not the global picker', () => {
  // Regression: editing a game on a date that is loaded into scheduleAssignments
  // while the picker (currentScheduleDate) sits on another day must sync the
  // rotation history to the LOADED date (window._scheduleAssignmentsDate).
  const edits = [];
  global.window.scheduleAssignments = {
    BunkA: [null, { _h2h: true, _allMatchups: ['L.A vs Dallas @ Clubhouse (Baseball)'] }],
  };
  global.window.leagueAssignments = {
    State: { 1: { leagueName: 'State League', _allMatchups: ['L.A vs Dallas @ Clubhouse (Baseball)'] } },
  };
  global.window.divisionTimes = { State: [null, { startMin: 600, endMin: 645 }] };
  global.window.fieldLabel = (f) => f;
  global.window.getAllLocations = () => [{ name: 'ABBL Arena', type: 'field', activities: ['Basketball'], capacity: 1 }];
  global.window.GlobalFieldLocks = { isFieldLockedByTime: () => null, unlockField: () => {}, lockField: () => true };
  delete global.window.findFieldsForActivity;
  global.window.leaguesByName = { 'State League': { teams: ['L.A', 'Dallas'], sports: ['Basketball', 'Baseball'] } };
  global.window.currentScheduleDate = '2026-07-03';        // picker is on a DIFFERENT day
  global.window._scheduleAssignmentsDate = '2026-06-25';   // the loaded/edited schedule
  global.window.SchedulerCoreLeagues = { editGameRecord: (...a) => { edits.push(a); return { ok: true }; } };

  const ctx = {
    kind: 'regular', divName: 'State', slotIdx: 1, startMin: 600, endMin: 645,
    leagueName: 'State League', slots: [1],
    game: { teamA: 'L.A', teamB: 'Dallas', teams: 'L.A vs Dallas', field: 'Clubhouse', sport: 'Baseball' },
  };
  const res = PEFC.applyFieldChange(ctx, 'ABBL Arena', 'Basketball');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(edits.length, 1);
  assert.strictEqual(edits[0][1], '2026-06-25', 'sync must use the edited schedule date, not the picker');
  delete global.window._scheduleAssignmentsDate;
});

test('applyFieldChange — pure field move does NOT call rotation sync', () => {
  const edits = [];
  global.window.scheduleAssignments = { BunkA: [null, { _h2h: true, _allMatchups: ['Lions vs Tigers @ Field A (Soccer)'] }] };
  global.window.leagueAssignments = { Majors: { 1: { _allMatchups: ['Lions vs Tigers @ Field A (Soccer)'] } } };
  global.window.divisionTimes = { Majors: [null, { startMin: 600, endMin: 645 }] };
  global.window.fieldLabel = (f) => f;
  global.window.getAllLocations = () => [{ name: 'Field B', type: 'field', activities: ['Soccer'], capacity: 1 }];
  global.window.GlobalFieldLocks = { isFieldLockedByTime: () => null, unlockField: () => {}, lockField: () => true };
  delete global.window.findFieldsForActivity;
  global.window.SchedulerCoreLeagues = { editGameRecord: (...a) => { edits.push(a); return { ok: true }; } };

  const ctx = {
    kind: 'regular', divName: 'Majors', slotIdx: 1, startMin: 600, endMin: 645,
    leagueName: 'L', slots: [1],
    game: { teamA: 'Lions', teamB: 'Tigers', teams: 'Lions vs Tigers', field: 'Field A', sport: 'Soccer' },
  };
  const res = PEFC.applyFieldChange(ctx, 'Field B');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(edits.length, 0); // teams + sport unchanged → no rotation churn
});
