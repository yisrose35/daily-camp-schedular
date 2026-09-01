/* Mid-day rain league-COUNT rollback simulation (standalone, no DOM).
 *
 * When a mid-day weather cut removes the rained-out league games from the
 * schedule, their persistent records must come off the books too ("rain means
 * it never happened") — otherwise repeat-opponent avoidance, sport variety,
 * game numbering and the play report keep counting games that were erased.
 *
 * Replicates verbatim:
 *   - _rainySurvivingLeagueLabels (daily_adjustments.js)
 *   - rollbackDayRecords w/ preservedLabels (regular: scheduler_core_leagues.js;
 *     specialty: scheduler_core_specialty_leagues.js)
 *   - the gamesPerDate recompute that Leagues.rollbackCutGames does after it
 * and proves the cut subtracts EXACTLY the dropped games and nothing else.
 */
'use strict';
const { test } = require('node:test');
const assert = require('assert');

// ── mirror: _rainySurvivingLeagueLabels (daily_adjustments.js) ──────────────
function _rainySurvivingLeagueLabels(leagueAssignments) {
  const regular = {}, specialty = {};
  Object.keys(leagueAssignments || {}).forEach(function (key) {
    const map = leagueAssignments[key];
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

// ── mirror: regular rollbackDayRecords (scheduler_core_leagues.js) ──────────
function getMatchupKey(t1, t2) { return [t1, t2].sort().join('|'); }
function rollbackRegular(lg, date, h, preservedLabels) {
  const entries = h.gameLog?.[lg]?.[date];
  if (!entries || !entries.length) return 0;
  const _keep = (preservedLabels && preservedLabels.size)
    ? entries.filter(e => e && e.g && preservedLabels.has(e.g)) : [];
  const _roll = (_keep.length) ? entries.filter(e => _keep.indexOf(e) < 0) : entries;
  _roll.forEach(e => {
    if (e.sport) [e.t1, e.t2].forEach(t => {
      const arr = h.teamSports[`${lg}|${t}`]; if (!arr) return;
      const i = arr.lastIndexOf(e.sport); if (i !== -1) arr.splice(i, 1);
    });
    if (e.t1 && e.t2) {
      const mk = `${lg}:${getMatchupKey(e.t1, e.t2)}`;
      if (h.matchupHistory[mk] > 1) h.matchupHistory[mk]--; else delete h.matchupHistory[mk];
    }
  });
  const n = _roll.length;
  if (_keep.length) h.gameLog[lg][date] = _keep; else delete h.gameLog[lg][date];
  return n;
}

// ── mirror: gamesPerDate recompute from Leagues.rollbackCutGames ────────────
function recomputeGamesPerDate(h, lg, date) {
  const kept = h.gameLog?.[lg]?.[date] || [];
  const g = new Set(kept.map(r => r && r.g).filter(Boolean)).size;
  if (g > 0) { (h.gamesPerDate[lg] = h.gamesPerDate[lg] || {})[date] = g; }
  else if (h.gamesPerDate?.[lg]?.[date] !== undefined) delete h.gamesPerDate[lg][date];
  return g;
}

// ── mirror: specialty rollbackDayRecords (scheduler_core_specialty_leagues.js)
function rollbackSpecialty(id, date, h, preservedLabels) {
  const all = h.gameLog?.[id]?.[date];
  if (!all || !all.length) return 0;
  const keep = (preservedLabels && preservedLabels.size)
    ? all.filter(e => e && e.g && preservedLabels.has(e.g)) : [];
  const entries = (keep.length) ? all.filter(e => keep.indexOf(e) < 0) : all;
  entries.forEach(e => {
    if (e.tA && e.tB) {
      const mk = `${id}|${[e.tA, e.tB].sort().join('|')}`;
      const dates = h.matchupHistory[mk];
      if (Array.isArray(dates)) {
        const di = dates.indexOf(date); if (di !== -1) dates.splice(di, 1);
        if (dates.length === 0) delete h.matchupHistory[mk];
      }
    }
  });
  const n = entries.length;
  if (keep.length) h.gameLog[id][date] = keep; else delete h.gameLog[id][date];
  return n;
}

// ── fixtures ────────────────────────────────────────────────────────────────
function regularHistory() {
  return {
    matchupHistory: { 'L:A|B': 1, 'L:A|C': 1 },
    teamSports: { 'L|A': ['Soccer', 'Basketball'], 'L|B': ['Soccer'], 'L|C': ['Basketball'] },
    gameLog: { L: { '2026-07-21': [
      { t1: 'A', t2: 'B', sport: 'Soccer', g: 'Game 1' },     // morning — kept
      { t1: 'A', t2: 'C', sport: 'Basketball', g: 'Game 2' }, // afternoon — rained out
    ] } },
    gamesPerDate: { L: { '2026-07-21': 2 } },
  };
}

// ── tests ───────────────────────────────────────────────────────────────────
test('surviving-label extraction splits regular vs specialty and dedups labels', () => {
  const la = {
    Div1: {
      '0': { leagueName: 'L', gameLabel: 'Game 1' },              // regular, kept
      '3': { leagueName: 'S', gameLabel: 'S Game 1', isSpecialtyLeague: true },
    },
    Div2: { '0': { leagueName: 'L', gameLabel: 'Game 1' } },      // same label, other div
  };
  const { regular, specialty } = _rainySurvivingLeagueLabels(la);
  assert.deepStrictEqual([...regular.L], ['Game 1']);
  assert.ok(!regular.S, 'specialty league must not land in the regular bucket');
  assert.deepStrictEqual([...specialty.S], ['S Game 1']);
});

test('afternoon game removed → only its records are subtracted, morning intact', () => {
  const h = regularHistory();
  // Post-split assignments: only Game 1 (morning) survives.
  const la = { Div1: { '0': { leagueName: 'L', gameLabel: 'Game 1' } } };
  const surv = _rainySurvivingLeagueLabels(la).regular;
  const removed = rollbackRegular('L', '2026-07-21', h, surv.L);
  const kept = recomputeGamesPerDate(h, 'L', '2026-07-21');

  assert.strictEqual(removed, 1, 'exactly the afternoon game rolls back');
  assert.strictEqual(kept, 1, 'gamesPerDate reflects the one surviving game');
  assert.strictEqual(h.matchupHistory['L:A|B'], 1, 'morning matchup untouched');
  assert.strictEqual(h.matchupHistory['L:A|C'], undefined, 'afternoon matchup gone');
  assert.deepStrictEqual(h.teamSports['L|A'], ['Soccer'], 'Basketball removed from A');
  assert.deepStrictEqual(h.teamSports['L|C'], [], 'Basketball removed from C');
  assert.strictEqual(h.gameLog.L['2026-07-21'].length, 1);
  assert.strictEqual(h.gameLog.L['2026-07-21'][0].g, 'Game 1');
});

test('cut before any game (no survivors) → whole day rolls back', () => {
  const h = regularHistory();
  const surv = _rainySurvivingLeagueLabels({}).regular; // nothing survived
  const preserved = surv.L; // undefined → full rollback
  const removed = rollbackRegular('L', '2026-07-21', h, preserved);
  const kept = recomputeGamesPerDate(h, 'L', '2026-07-21');

  assert.strictEqual(removed, 2, 'both games roll back');
  assert.strictEqual(kept, 0);
  assert.strictEqual(h.matchupHistory['L:A|B'], undefined);
  assert.strictEqual(h.matchupHistory['L:A|C'], undefined);
  assert.deepStrictEqual(h.teamSports['L|A'], []);
  assert.strictEqual(h.gameLog.L['2026-07-21'], undefined, 'empty day is deleted');
  assert.strictEqual(h.gamesPerDate.L['2026-07-21'], undefined);
});

test('cut after all games (all survive) → nothing rolls back (idempotent)', () => {
  const h = regularHistory();
  const before = JSON.stringify(h);
  const surv = new Set(['Game 1', 'Game 2']);
  const removed = rollbackRegular('L', '2026-07-21', h, surv);
  recomputeGamesPerDate(h, 'L', '2026-07-21');
  assert.strictEqual(removed, 0, 'nothing dropped');
  assert.strictEqual(JSON.stringify(h), before, 'history unchanged');
});

test('specialty: date-array matchup + label preservation subtracts only dropped game', () => {
  const h = {
    matchupHistory: { 'sl1|A|B': ['2026-07-21'], 'sl1|C|D': ['2026-07-21'] },
    gameLog: { sl1: { '2026-07-21': [
      { tA: 'A', tB: 'B', field: 'F1', g: 'Game 1', s: 1 }, // kept
      { tA: 'C', tB: 'D', field: 'F2', g: 'Game 2', s: 2 }, // rained out
    ] } },
    gamesPerDate: { sl1: { '2026-07-21': 2 } },
  };
  // Survivors keyed by NAME in assignments; history keyed by id — the wiring
  // resolves name→id, here we pass the resolved preserved set directly.
  const la = { Div1: { '0': { leagueName: 'Chess', gameLabel: 'Game 1', isSpecialtyLeague: true } } };
  const survName = _rainySurvivingLeagueLabels(la).specialty['Chess'];
  const removed = rollbackSpecialty('sl1', '2026-07-21', h, survName);
  const kept = recomputeGamesPerDate(h, 'sl1', '2026-07-21');

  assert.strictEqual(removed, 1);
  assert.strictEqual(kept, 1);
  assert.deepStrictEqual(h.matchupHistory['sl1|A|B'], ['2026-07-21'], 'kept game matchup intact');
  assert.strictEqual(h.matchupHistory['sl1|C|D'], undefined, 'dropped game matchup gone');
  assert.strictEqual(h.gameLog.sl1['2026-07-21'].length, 1);
  assert.strictEqual(h.gameLog.sl1['2026-07-21'][0].g, 'Game 1');
});
