/* matchup_variety PAIRING — computed FRESH from history each game, no
 * predetermined round-robin. Mirrors chooseDailyMatchups (mode='matchup_variety')
 * + makeSportCycles + makePairRecency in scheduler_core_leagues.js:
 * exact search over every possible pairing for ≤12 teams; meetings dominate
 * (new matchups always first), recency rotates equal-met pairings, sport needs
 * break what's left.
 *
 * Invariants proven:
 *  1. matchups derive from HISTORY, not a fixed wheel — the same day-2 comes out
 *     different depending on what actually happened on day 1
 *  2. zero rematches whenever a zero-rematch pairing exists (new matchups first)
 *  3. shared sport needs concentrate among equally-fresh pairings
 *  4. a sport gain never buys an opponent repeat (matchup wins the tiebreak)
 *  5. regen-inverted flat aggregate is ignored — gameLog counts are the truth
 *  6. recency: once every pair has met, rotate to the pairing met longest ago
 *  7. cycle 2: the sport tiebreak stays alive after everyone played everything
 */
'use strict';
const assert = require('assert');
const LG = 'L';

function H() { return { matchupHistory: {}, gameLog: { [LG]: {} } }; }
function addGame(h, date, t1, t2, sport) {
  h.matchupHistory[LG + ':' + [t1, t2].sort().join('|')] = (h.matchupHistory[LG + ':' + [t1, t2].sort().join('|')] || 0) + 1;
  (h.gameLog[LG][date] = h.gameLog[LG][date] || []).push({ t1, t2, sport });
}
// meeting count from the date-keyed gameLog (mirrors getMatchupCountByDate —
// regen-safe truth; the flat aggregate can invert, see TEST 5)
function met(h, a, b, asOf) {
  const gl = (h.gameLog || {})[LG] || {}; const key = [a, b].sort().join('|'); let n = 0;
  Object.keys(gl).forEach(d => { if (asOf && d > asOf) return;
    (gl[d] || []).forEach(e => { if (e && [e.t1, e.t2].sort().join('|') === key) n++; }); });
  return n;
}
function sportCounts(h, t, asOf) {
  const gl = (h.gameLog || {})[LG] || {}, out = {};
  Object.keys(gl).forEach(d => { if (asOf && d >= asOf) return;
    (gl[d] || []).forEach(e => { if (e.sport && (e.t1 === t || e.t2 === t)) out[e.sport] = (out[e.sport] || 0) + 1; }); });
  return out;
}
// mirrors makeSportCycles
function makeSportCycles(h, teams, cycleSports, asOf) {
  const counts = {}; teams.forEach(t => counts[t] = sportCounts(h, t, asOf));
  const mins = {};
  teams.forEach(t => { let m = Infinity; cycleSports.forEach(s => { const c = counts[t][s] || 0; if (c < m) m = c; }); mins[t] = m === Infinity ? 0 : m; });
  const gap = (t, s) => ((counts[t] || {})[s] || 0) - (mins[t] || 0);
  return { isFresh: (t, s) => gap(t, s) === 0 };
}
// mirrors makePairRecency
function makePairRecency(h, asOf) {
  const gl = (h.gameLog || {})[LG] || {};
  const dates = Object.keys(gl).filter(d => !asOf || d <= asOf).sort(), denom = dates.length + 1;
  return (a, b) => {
    const key = [a, b].sort().join('|'); let best = 0;
    dates.forEach((d, i) => { (gl[d] || []).forEach(e => { if (e && [e.t1, e.t2].sort().join('|') === key) best = (i + 1) / denom; }); });
    return best;
  };
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
// mirrors chooseDailyMatchups (exact branch — all tests here use ≤12 teams)
function chooseDailyMatchups(teams, availSports, h, mode, asOf) {
  const cycles = makeSportCycles(h, teams, availSports, asOf);
  const recency = makePairRecency(h, asOf);
  function sportFresh(a, b) { let best = 0; for (const s of availSports) { const f = (cycles.isFresh(a, s) ? 1 : 0) + (cycles.isFresh(b, s) ? 1 : 0); if (f > best) { best = f; if (best === 2) break; } } return best; }
  const isM = mode === 'matchup_variety', W_OPP = isM ? 1000 : 25, W_SPORT = isM ? 8 : 300, W_REC = isM ? 100 : 10;
  const pairWeight = (a, b) => (-met(h, a, b, asOf)) * W_OPP + sportFresh(a, b) * W_SPORT - recency(a, b) * W_REC;
  const matchings = perfectMatchings(teams);
  let best = null, bestW = -Infinity, bestMet = Infinity;
  for (const m of matchings) {
    let tw = 0, tm = 0;
    for (const p of m) { if (p[0] === '__BYE__' || p[1] === '__BYE__') continue; tw += pairWeight(p[0], p[1]); tm += met(h, p[0], p[1], asOf); }
    if (tw > bestW || (tw === bestW && tm < bestMet)) { best = m; bestW = tw; bestMet = tm; }
  }
  return best.filter(p => p[0] !== '__BYE__' && p[1] !== '__BYE__').map(p => [p[0], p[1]]);
}
const MV = (teams, sports, h, asOf) => chooseDailyMatchups(teams, sports, h, 'matchup_variety', asOf);
const keys = m => m.map(p => p.slice().sort().join('v')).sort();
function countRematches(h, m) { return m.reduce((n, p) => n + (met(h, p[0], p[1]) > 0 ? 1 : 0), 0); }

// ---- TEST 1: history-driven, not a wheel — day 2 avoids whatever day 1 WAS ----
// A predetermined round-robin plays round N on game N regardless of what actually
// happened; the dynamic creator must dodge the pairs that really met, for ANY day-1.
(function () {
  [
    [['1', '3'], ['2', '4']],
    [['1', '4'], ['2', '3']],
    [['1', '2'], ['3', '4']],
  ].forEach(day1 => {
    const h = H();
    day1.forEach(p => addGame(h, 'd1', p[0], p[1], 'M'));
    const out = keys(MV(['1', '2', '3', '4'], ['M', 'J'], h));
    const played = day1.map(p => p.slice().sort().join('v'));
    played.forEach(k => assert(!out.includes(k),
      'day 2 must avoid day 1 (' + played.join('/') + '): ' + out.join(',')));
  });
  console.log('TEST 1 PASS — matchups derive from history: day 2 dodges day 1, whatever day 1 was');
})();

// ---- TEST 2: new matchups first — zero rematches whenever possible ----
(function () {
  const h = H();
  addGame(h, 'd1', '1', '2', 'Basketball');
  addGame(h, 'd1', '3', '4', 'Basketball');
  const out = MV(['1', '2', '3', '4'], ['Football', 'Basketball'], h);
  assert.strictEqual(countRematches(h, out), 0, 'must find the zero-rematch pairing: ' + keys(out).join(','));
  console.log('TEST 2 PASS — zero rematches whenever a fresh pairing exists: ' + keys(out).join(', '));
})();

// ---- TEST 3: shared sport needs concentrate among equally-fresh pairings ----
(function () {
  const h = H();
  // A & B need Football (only played Basketball). C & D need Basketball. All
  // history is vs phantoms → no real pair has met → every pairing is rematch-free
  // and equally recent; only sport need can decide.
  addGame(h, 'd1', 'A', 'p', 'Basketball');
  addGame(h, 'd1', 'B', 'q', 'Basketball');
  addGame(h, 'd1', 'C', 'r', 'Football');
  addGame(h, 'd1', 'D', 's', 'Football');
  const out = keys(MV(['A', 'B', 'C', 'D'], ['Football', 'Basketball'], h));
  assert(out.includes('AvB') && out.includes('CvD'),
    'should concentrate shared needs (AvB need Football, CvD need Basketball): ' + out.join(','));
  console.log('TEST 3 PASS — concentrated shared sport needs (A vs B, C vs D)');
})();

// ---- TEST 4: never trades an opponent repeat for a sport gain ----
(function () {
  const h = H();
  addGame(h, 'd1', 'A', 'B', 'Basketball'); // A&B met; a rematch would give both fresh Football
  addGame(h, 'd1', 'C', 'D', 'Football');   // C&D met; a rematch would give both fresh Basketball
  const out = keys(MV(['A', 'B', 'C', 'D'], ['Football', 'Basketball'], h));
  assert(!out.includes('AvB') && !out.includes('CvD'),
    'sport gain must NOT buy an opponent repeat: ' + out.join(','));
  console.log('TEST 4 PASS — refused the rematch despite the sport bait: ' + out.join(', '));
})();

// ---- TEST 5: regen-INVERTED aggregate — gameLog count keeps rotating opponents ----
// The live bug: a 4-team league stuck on 1v2/3v4 every game. The flat matchupHistory
// aggregate had INVERTED after regenerations; counting from the gameLog (truth) fixes it.
(function () {
  const h = H();
  addGame(h, '2026-06-29', '1', '2', 'Dodgeball');
  addGame(h, '2026-06-29', '3', '4', 'Kickball');
  // flat aggregate is INVERTED (phantom pre-gameLog counts a rollback never cleared):
  h.matchupHistory = { 'L:1|2': 1, 'L:1|3': 2, 'L:1|4': 2, 'L:2|3': 2, 'L:2|4': 2, 'L:3|4': 1 };
  const out = keys(MV(['1', '2', '3', '4'], ['Kickball', 'Dodgeball'], h, '2026-06-30'));
  assert(!(out.includes('1v2') && out.includes('3v4')),
    'must NOT stay stuck on the truly-overplayed 1v2/3v4: ' + out.join(','));
  console.log('TEST 5 PASS — gameLog count beats the inverted aggregate, rotates to: ' + out.join(', '));
})();

// ---- TEST 6: recency — after a full pass, rotate to the pairing met longest ago ----
(function () {
  const h = H();
  addGame(h, '2026-06-29', '1', '2', 'Kickball');
  addGame(h, '2026-06-29', '3', '4', 'Dodgeball');
  addGame(h, '2026-06-30', '1', '3', 'Kickball');
  addGame(h, '2026-06-30', '2', '4', 'Dodgeball');
  addGame(h, '2026-06-30', '1', '4', 'Kickball');
  addGame(h, '2026-06-30', '2', '3', 'Dodgeball');
  // every pair met exactly once → meeting counts tie; recency must decide.
  const out = keys(MV(['1', '2', '3', '4'], ['Kickball', 'Dodgeball'], h, '2026-07-01'));
  assert(out.includes('1v2') && out.includes('3v4'),
    'should pick the pairing played longest ago (06-29): ' + out.join(','));
  console.log('TEST 6 PASS — recency rotates to the oldest pairing instead of repeating: ' + out.join(', '));
})();

// ---- TEST 7: CYCLE 2 — sport tiebreak stays ALIVE after everyone played everything ----
// A & B are one Kickball ahead (need Dodgeball this cycle); C & D are one Dodgeball
// ahead (need Kickball). All games vs phantoms → meetings/recency all tie at 0 —
// only the cycle need can decide, and it must (binary played-ever would be dead here).
(function () {
  const h = H();
  ['A', 'B', 'C', 'D'].forEach((t, i) => {
    addGame(h, '2026-06-25', t, 'p' + i, 'Kickball');
    addGame(h, '2026-06-26', t, 'p' + i, 'Dodgeball');
  });
  addGame(h, '2026-06-27', 'A', 'p0', 'Kickball');   // A: K2 Dg1 → needs Dodgeball
  addGame(h, '2026-06-27', 'B', 'p1', 'Kickball');   // B: K2 Dg1 → needs Dodgeball
  addGame(h, '2026-06-27', 'C', 'p2', 'Dodgeball');  // C: K1 Dg2 → needs Kickball
  addGame(h, '2026-06-27', 'D', 'p3', 'Dodgeball');  // D: K1 Dg2 → needs Kickball
  const out = keys(MV(['A', 'B', 'C', 'D'], ['Kickball', 'Dodgeball'], h, '2026-06-28'));
  assert(out.includes('AvB') && out.includes('CvD'),
    'cycle-2 needs must still concentrate (AvB need Dg, CvD need K): ' + out.join(','));
  console.log('TEST 7 PASS — sport tiebreak alive in cycle 2 (AvB + CvD)');
})();

console.log('\n✅ ALL MATCHUP-VARIETY PAIRING TESTS PASS');
