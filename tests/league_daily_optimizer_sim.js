/* Daily pairing optimizer — the matchup creator for BOTH modes: every game's
 * matchups are computed FRESH from history (opponents met + sports NEEDED this
 * cycle), never a predetermined round-robin. Exact search over every possible
 * pairing for ≤12 teams; greedy max-weight matching + 2-opt refinement beyond.
 * Mirrors chooseDailyMatchups + makeSportCycles + makePairRecency in
 * scheduler_core_leagues.js.
 */
'use strict';
const assert = require('assert');
const LG = 'L';

// meeting count from the date-keyed gameLog (mirrors getMatchupCountByDate)
function getMatchupCount(h, a, b) {
  const gl = (h.gameLog || {})[LG]; const key = [a, b].sort().join('|'); let n = 0;
  if (!gl) return (h.matchupHistory || {})[LG + ':' + key] || 0;
  Object.keys(gl).forEach(d => (gl[d] || []).forEach(e => { if (e && [e.t1, e.t2].sort().join('|') === key) n++; }));
  return n;
}
function perfectMatchings(teams) {
  const arr = teams.slice();
  if (arr.length % 2 === 1) arr.push('__BYE__');
  const out = [];
  (function rec(rem, cur) {
    if (rem.length === 0) { out.push(cur.slice()); return; }
    const a = rem[0];
    for (let i = 1; i < rem.length; i++) { cur.push([a, rem[i]]); rec(rem.slice(1, i).concat(rem.slice(i + 1)), cur); cur.pop(); }
  })(arr, []);
  return out;
}
function sportCounts(h, t) {
  const gl = (h.gameLog || {})[LG] || {}, out = {};
  Object.keys(gl).forEach(d => (gl[d] || []).forEach(e => { if (e.sport && (e.t1 === t || e.t2 === t)) out[e.sport] = (out[e.sport] || 0) + 1; }));
  return out;
}
// mirrors makeSportCycles: fresh = play count sits at the team's current-cycle
// minimum across today's available sports (needs RESET after a full cycle).
function makeSportCycles(h, teams, cycleSports) {
  const counts = {}; teams.forEach(t => counts[t] = sportCounts(h, t));
  const mins = {};
  teams.forEach(t => { let m = Infinity; cycleSports.forEach(s => { const c = counts[t][s] || 0; if (c < m) m = c; }); mins[t] = m === Infinity ? 0 : m; });
  const gap = (t, s) => ((counts[t] || {})[s] || 0) - (mins[t] || 0);
  return { gap, isFresh: (t, s) => gap(t, s) === 0 };
}
// mirrors makePairRecency: 0 = never met, higher = met more recently.
function makePairRecency(h) {
  const gl = (h.gameLog || {})[LG] || {};
  const dates = Object.keys(gl).sort(), denom = dates.length + 1;
  return (a, b) => {
    const key = [a, b].sort().join('|'); let best = 0;
    dates.forEach((d, i) => { (gl[d] || []).forEach(e => { if (e && [e.t1, e.t2].sort().join('|') === key) best = (i + 1) / denom; }); });
    return best;
  };
}
function chooseDailyMatchups(teams, availSports, h, mode) {
  const cycles = makeSportCycles(h, teams, availSports);
  const recency = makePairRecency(h);
  function sportFresh(a, b) { let best = 0; for (const s of availSports) { const f = (cycles.isFresh(a, s) ? 1 : 0) + (cycles.isFresh(b, s) ? 1 : 0); if (f > best) { best = f; if (best === 2) break; } } return best; }
  const isM = mode === 'matchup_variety', W_OPP = isM ? 1000 : 25, W_SPORT = isM ? 8 : 300, W_REC = isM ? 100 : 10;
  const pairWeight = (a, b) => (-getMatchupCount(h, a, b)) * W_OPP + sportFresh(a, b) * W_SPORT - recency(a, b) * W_REC;
  if (teams.length <= 12) {
    // EXACT: enumerate every possible pairing, best total weight wins;
    // fewest total meetings breaks exact weight ties (new matchups first).
    const matchings = perfectMatchings(teams);
    let best = null, bestW = -Infinity, bestMet = Infinity;
    for (const m of matchings) {
      let tw = 0, tm = 0;
      for (const p of m) { if (p[0] === '__BYE__' || p[1] === '__BYE__') continue; tw += pairWeight(p[0], p[1]); tm += getMatchupCount(h, p[0], p[1]); }
      if (tw > bestW || (tw === bestW && tm < bestMet)) { best = m; bestW = tw; bestMet = tm; }
    }
    return best.filter(p => p[0] !== '__BYE__' && p[1] !== '__BYE__').map(p => [p[0], p[1]]);
  }
  // >12 teams: greedy max-weight matching + 2-opt refinement.
  const pairs = [];
  for (let i = 0; i < teams.length; i++) for (let j = i + 1; j < teams.length; j++) {
    const a = teams[i], b = teams[j];
    pairs.push({ a, b, met: getMatchupCount(h, a, b), w: pairWeight(a, b) });
  }
  pairs.sort((x, y) => (y.w - x.w) || (x.met - y.met));
  const used = new Set(), m = [];
  for (const p of pairs) { if (used.has(p.a) || used.has(p.b)) continue; m.push([p.a, p.b]); used.add(p.a); used.add(p.b); }
  // 2-opt refinement (mirrors source): swap partners while total weight improves.
  let improved = true, guard = 0;
  while (improved && guard < 300) {
    improved = false; guard++;
    for (let i = 0; i < m.length && !improved; i++) {
      for (let j = i + 1; j < m.length; j++) {
        const a = m[i][0], b = m[i][1], c = m[j][0], d = m[j][1];
        const base = pairWeight(a, b) + pairWeight(c, d);
        const s1 = pairWeight(a, c) + pairWeight(b, d);
        const s2 = pairWeight(a, d) + pairWeight(b, c);
        if (s1 > base && s1 >= s2) { m[i] = [a, c]; m[j] = [b, d]; improved = true; break; }
        if (s2 > base) { m[i] = [a, d]; m[j] = [b, c]; improved = true; break; }
      }
    }
  }
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

// ---- TEST 4: the best single pair can't strand the rest (whole-pairing scoring) ----
(function () {
  // sport_variety, sports M & J. A and B both need J; C and D both need M.
  // A vs B is the best single pair (fresh 2, never met) — but C & D have met 30
  // times, so the AvB/CvD split totals 600 + (-150) = 450, while AvC/BvD (never
  // met, fresh-to-one each) totals 300 + 300 = 600. A best-pair-first greedy
  // would grab AvB and get stuck with CvD; whole-pairing optimization (exact
  // search ≤12 teams, 2-opt beyond) must pick the better overall split.
  const h = H();
  addGame(h, '2026-06-20', 'A', 'p', 'M');
  addGame(h, '2026-06-20', 'B', 'q', 'M');
  addGame(h, '2026-06-20', 'C', 'r', 'J');
  addGame(h, '2026-06-20', 'D', 's', 'J');
  for (let i = 0; i < 30; i++) addGame(h, '2026-06-2' + (1 + (i % 5)), 'C', 'D', (i % 2) ? 'M' : 'J');
  const m = chooseDailyMatchups(['A', 'B', 'C', 'D'], ['M', 'J'], h, 'sport_variety');
  const keys = m.map(p => p.slice().sort().join('v'));
  assert(!keys.includes('CvD'), '2-opt must break up the over-met CvD leftover: ' + keys.join(','));
  console.log('TEST 4 PASS — 2-opt re-splits the greedy strand (no CvD): ' + keys.join(', '));
})();

console.log('\n✅ ALL DAILY-OPTIMIZER TESTS PASS');
