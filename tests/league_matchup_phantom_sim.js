// =============================================================================
// league_matchup_phantom_sim.js
// -----------------------------------------------------------------------------
// Locks down the grid's league-matchup lookup (unified_schedule_system.js
// getLeagueMatchups / hasScheduledLeagueGame) against the "phantom duplicate
// game" bug: after a mid-day rain cut drops a post-cut league game, its league
// TILE still renders. The old ±2-slot fuzzy lookup then handed that empty slot
// an EARLIER, time-disjoint game's matchups (e.g. a 5:10 State League tile
// showing the 1:25 game on already-closed outdoor fields).
//
// Mirrors the real getLeagueMatchups logic (keep in sync). The fixes:
//   1. Fuzzy ±2 inheritance requires the stored game's time to actually cover
//      the queried slot (same spanning game), not merely be within 2 indices.
//   2. Master-league DEFAULT matchups only when the division has NO stored games
//      at all (never scheduled) — not when a specific slot was dropped.
// =============================================================================

'use strict';
const assert = require('assert');

// ---- Faithful mirror of getLeagueMatchups (unified_schedule_system.js) -------
function getLeagueMatchups(divName, slotIdx, W) {
  const leagues = W.leagueAssignments || {};
  if (leagues[divName] && leagues[divName][slotIdx]) {
    const d = leagues[divName][slotIdx];
    return { matchups: d.matchups || [], gameLabel: d.gameLabel || '', sport: d.sport || '', leagueName: d.leagueName || '' };
  }
  if (leagues[divName]) {
    const _dt = (W.divisionTimes && W.divisionTimes[divName]) || null;
    const _qs = _dt && _dt[slotIdx];
    const qStart = (_qs && _qs.startMin != null) ? _qs.startMin : null;
    const qEnd = (_qs && _qs.endMin != null) ? _qs.endMin : null;
    const keys = Object.keys(leagues[divName]).map(Number).sort((a, b) => a - b);
    for (const s of keys) {
      if (Math.abs(s - slotIdx) <= 2) {
        const d = leagues[divName][s];
        if (!(d && ((d.matchups && d.matchups.length > 0) || d.gameLabel))) continue;
        const gStart = (d._startMin != null) ? d._startMin : (_dt && _dt[s] && _dt[s].startMin != null ? _dt[s].startMin : null);
        const gEnd = (d._endMin != null) ? d._endMin : (_dt && _dt[s] && _dt[s].endMin != null ? _dt[s].endMin : null);
        if (qStart != null && qEnd != null && gStart != null && gEnd != null && !(gStart < qEnd && gEnd > qStart)) continue;
        return { matchups: d.matchups || [], gameLabel: d.gameLabel || '', sport: d.sport || '', leagueName: d.leagueName || '' };
      }
    }
  }
  const _hasStored = leagues[divName] && Object.keys(leagues[divName]).length > 0;
  if (!_hasStored) {
    const list = W.masterLeagues || [];
    const applicable = list.filter(l => l && l.name && l.divisions && l.divisions.includes(divName));
    if (applicable.length > 0) {
      const lg = applicable[0], teams = lg.teams || [];
      if (teams.length >= 2) {
        const m = [];
        for (let i = 0; i < teams.length - 1; i += 2) if (teams[i + 1]) m.push({ teamA: teams[i], teamB: teams[i + 1], display: `${teams[i]} vs ${teams[i + 1]}` });
        if (teams.length % 2 === 1) m.push({ teamA: teams[teams.length - 1], teamB: 'BYE', display: `${teams[teams.length - 1]} (BYE)` });
        return { matchups: m, gameLabel: `${lg.name} Game`, sport: (lg.sports && lg.sports[0]) || 'League', leagueName: lg.name };
      }
    }
  }
  return { matchups: [], gameLabel: '', sport: '', leagueName: '' };
}
const hasScheduledLeagueGame = (d, s, W) => {
  const li = getLeagueMatchups(d, s, W);
  return !!(li && ((li.matchups && li.matchups.length > 0) || li.gameLabel));
};

// Mirrors the real 4/5 Agudah situation: a pre-cut game at slot 1 (805-870);
// the 5:10 State League tile lives at slot 3 (1030-1110) but its game was
// dropped by the rain cut, so leagueAssignments has NO slot-3 entry.
const DIV = 'Camp Agudah > 4';
const W = {
  divisionTimes: { [DIV]: { 1: { startMin: 805, endMin: 870 }, 2: { startMin: 930, endMin: 1010 }, 3: { startMin: 1030, endMin: 1110 } } },
  leagueAssignments: { [DIV]: { 1: { matchups: [{ display: '3 vs 6' }, { display: '1 vs 2' }, { display: '4 vs 5' }], gameLabel: 'Game 9', leagueName: '4th and 5th Grade League', _startMin: 805, _endMin: 870 } } },
  masterLeagues: [{ name: '4th and 5th Grade League', divisions: [DIV], teams: [1, 2, 3, 4, 5, 6], sports: ['Baseball'] }]
};

// TEST 1 — the real game at its own slot still resolves.
{
  const li = getLeagueMatchups(DIV, 1, W);
  assert.strictEqual(li.matchups.length, 3, 'slot 1 returns its real matchups');
  assert.strictEqual(li.gameLabel, 'Game 9');
  assert.ok(hasScheduledLeagueGame(DIV, 1, W), 'slot 1 has a scheduled game');
  console.log('TEST 1 PASS — the actual 1:25 game still resolves at its slot');
}

// TEST 2 — THE FIX: the dropped 5:10 slot (index 3) must NOT inherit slot 1's
//   game. Old ±2 fuzzy would (|1-3|=2), producing the phantom. Now: time-disjoint
//   → skip; division has stored games → no master-default → empty.
{
  const li = getLeagueMatchups(DIV, 3, W);
  assert.strictEqual(li.matchups.length, 0, 'slot 3 (dropped, disjoint) gets NO inherited matchups');
  assert.strictEqual(li.gameLabel, '', 'no fabricated game label');
  assert.strictEqual(hasScheduledLeagueGame(DIV, 3, W), false, 'no scheduled game → grid renders the activity, not a phantom');
  console.log('TEST 2 PASS — the phantom 5:10 duplicate is gone (empty, so the cell falls back to the activity)');
}

// TEST 3 — a GENUINE game spanning into a neighbor slot still shares matchups.
//   Stored game at slot 1 whose stamped span (805-930) covers slot 2 (930-1010
//   overlaps at the boundary via 900-960 span). Use a span that overlaps slot 2.
{
  const W3 = {
    divisionTimes: { [DIV]: { 1: { startMin: 805, endMin: 930 }, 2: { startMin: 900, endMin: 960 } } },
    leagueAssignments: { [DIV]: { 1: { matchups: [{ display: 'A vs B' }], gameLabel: 'Game 5', _startMin: 805, _endMin: 930 } } },
    masterLeagues: []
  };
  const li = getLeagueMatchups(DIV, 2, W3);
  assert.strictEqual(li.matchups.length, 1, 'a game whose span overlaps the neighbor slot still shares matchups');
  assert.strictEqual(li.gameLabel, 'Game 5');
  console.log('TEST 3 PASS — a genuine multi-column game still shares its matchups with the overlapping slot');
}

// TEST 4 — never-scheduled division: master-league DEFAULT still shows (unchanged).
{
  const W4 = { divisionTimes: {}, leagueAssignments: {}, masterLeagues: W.masterLeagues };
  const li = getLeagueMatchups(DIV, 1, W4);
  assert.strictEqual(li.matchups.length, 3, 'no stored games → master-league default matchups (1v2,3v4,5v6)');
  assert.strictEqual(li.matchups[0].display, '1 vs 2');
  console.log('TEST 4 PASS — a never-scheduled league still shows default matchups (feature preserved)');
}

console.log('\n✅ ALL league_matchup_phantom_sim TESTS PASSED');
