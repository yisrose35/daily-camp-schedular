/* Daily pairing optimizer — chooses today's matchups ANEW from history (opponents
 * met + sports played) via a greedy max-weight matching that scales to ANY league
 * size (the old enumerator bailed to round-robin past 12 teams). Mirrors
 * chooseDailyMatchups in scheduler_core_leagues.js.
 */
'use strict';
const assert = require('assert');
const LG = 'L';

function getMatchupCount(h, a, b) { return (h.matchupHistory || {})[LG + ':' + [a, b].sort().join('|')] || 0; }
function playedSports(h, t) {
  const gl = (h.gameLog || {})[LG] || {}, out = new Set();
  Object.keys(gl).forEach(d => (gl[d] || []).forEach(e => { if (e.sport && (e.t1 === t || e.t2 === t)) out.add(e.sport); }));
  return out;
}
function chooseDailyMatchups(teams, availSports, h, mode) {
  const played = {}; teams.forEach(t => played[t] = playedSports(h, t));
  function sportFresh(a, b) { let best = 0; for (const s of availSports) { const f = (played[a].has(s) ? 0 : 1) + (played[b].has(s) ? 0 : 1); if (f > best) { best = f; if (best === 2) break; } } return best; }
  const isM = mode === 'matchup_variety', W_OPP = isM ? 1000 : 25, W_SPORT = isM ? 8 : 300;
  const pairs = [];
  for (let i = 0; i < teams.length; i++) for (let j = i + 1; j < teams.length; j++) {
    const a = teams[i], b = teams[j], met = getMatchupCount(h, a, b);
    pairs.push({ a, b, met, w: (-met) * W_OPP + sportFresh(a, b) * W_SPORT });
  }
  pairs.sort((x, y) => (y.w - x.w) || (x.met - y.met));
  const used = new Set(), m = [];
  for (const p of pairs) { if (used.has(p.a) || used.has(p.b)) continue; m.push([p.a, p.b]); used.add(p.a); used.add(p.b); }
  return m;
}
function H() { return { matchupHistory: {}, gameLog: { [LG]: {} } }; }
function addGame(h, date, t1, t2, sport) {
  h.matchupHistory[LG + ':' + [t1, t2].sort().join('|')] = (h.matchupHistory[LG + ':' + [t1, t2].sort().join('|')] || 0) + 1;
  (h.gameLog[LG][date] = h.gameLog[LG][date] || []).push({ t1, t2, sport });
}

// ---- TEST 1: scales to 16 teams (past the old 12-team cap) ----
(function () {
  const teams = []; for (let i = 1; i <= 16; i++) teams.push(String(i));
  const m = chooseDailyMatchups(teams, ['Football', 'Basketball', 'Baseball', 'Hockey'], H(), 'matchup_variety');
  assert.strictEqual(m.length, 8, '16 teams → 8 pairs');
  const seen = new Set(); m.forEach(p => { seen.add(p[0]); seen.add(p[1]); });
  assert.strictEqual(seen.size, 16, 'every team paired exactly once (valid perfect matching)');
  console.log('TEST 1 PASS — scales to 16 teams: 8 pairs, every team used once');
})();

// ---- TEST 2: matchup_variety keeps opponent rotation (avoids rematches) ----
(function () {
  const h = H();
  addGame(h, '2026-06-25', '1', '2', 'Basketball');
  addGame(h, '2026-06-25', '3', '4', 'Basketball');
  const m = chooseDailyMatchups(['1', '2', '3', '4'], ['Football', 'Basketball'], h, 'matchup_variety');
  const keys = m.map(p => p.slice().sort().join('v'));
  assert(!keys.includes('1v2') && !keys.includes('3v4'), 'matchup_variety must avoid already-met pairs: ' + keys.join(','));
  console.log('TEST 2 PASS — matchup_variety pairs UNMET opponents (avoided 1v2 & 3v4): ' + keys.join(', '));
})();

// ---- TEST 3: sport_variety pairs two needy teams so one scarce field serves both ----
(function () {
  const h = H();
  addGame(h, '2026-06-25', 'A', 'z0', 'Basketball');  // A: only Basketball, NEEDS Football
  addGame(h, '2026-06-25', 'B', 'z1', 'Basketball');  // B: only Basketball, NEEDS Football
  addGame(h, '2026-06-25', 'C', 'D', 'Football');     // C & D: already played Football
  const m = chooseDailyMatchups(['A', 'B', 'C', 'D'], ['Football', 'Basketball'], h, 'sport_variety');
  const keys = m.map(p => p.slice().sort().join('v'));
  assert(keys.includes('AvB'), 'sport_variety should pair the two Football-needy teams together (A vs B): ' + keys.join(','));
  console.log('TEST 3 PASS — sport_variety pairs the two needy teams (A vs B) so one Football field makes both fresh');
})();

console.log('\n✅ ALL DAILY-OPTIMIZER TESTS PASS');
