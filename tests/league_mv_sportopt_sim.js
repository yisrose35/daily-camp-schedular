/* matchup_variety SPORT-AWARE PAIRING (option 3) — starting from the round-robin
 * matchups, run 2-opt swaps that NEVER add a rematch and concentrate shared sport
 * needs (so one scarce field serves two needy teams). Mirrors
 * optimizeMatchupPairingForSport in scheduler_core_leagues.js.
 *
 * Invariants proven:
 *  1. zero rematches in / zero rematches out (opponents never worse than round-robin)
 *  2. shared sport-need concentration improves (two Football-needy teams get paired)
 *  3. a rematch already present in the round-robin input is REDUCED when an
 *     equally-fresh non-rematch arrangement exists (self-correction)
 */
'use strict';
const assert = require('assert');
const LG = 'L';
const BIG = 1e6;

function getMatchupCount(h, a, b) { return (h.matchupHistory || {})[LG + ':' + [a, b].sort().join('|')] || 0; }
// Regen-safe meeting count from the date-keyed gameLog (mirrors getMatchupCountByDate
// in scheduler_core_leagues.js). asOf=null → count all logged dates.
function getMatchupCountByDate(h, a, b, asOf) {
  const gl = (h.gameLog || {})[LG]; if (!gl) return getMatchupCount(h, a, b);
  const key = [a, b].sort().join('|'); let n = 0;
  Object.keys(gl).forEach(d => { if (asOf && d > asOf) return;
    (gl[d] || []).forEach(e => { if (e && [e.t1, e.t2].sort().join('|') === key) n++; }); });
  return n;
}
function playedSportCounts(h, t, asOf) {
  const gl = (h.gameLog || {})[LG] || {}, out = {};
  Object.keys(gl).forEach(d => { if (asOf && d >= asOf) return;
    (gl[d] || []).forEach(e => { if (e.sport && (e.t1 === t || e.t2 === t)) out[e.sport] = (out[e.sport] || 0) + 1; }); });
  return out;
}
// mirrors makeSportCycles: "fresh" = the team still NEEDS the sport in its
// current cycle (count at the team's minimum across today's available sports),
// so the sport tiebreak stays alive after every team's first full pass.
function makeSportCycles(h, teams, cycleSports, asOf) {
  const counts = {}; teams.forEach(t => counts[t] = playedSportCounts(h, t, asOf));
  const mins = {};
  teams.forEach(t => { let m = Infinity; cycleSports.forEach(s => { const c = counts[t][s] || 0; if (c < m) m = c; }); mins[t] = m === Infinity ? 0 : m; });
  const gap = (t, s) => ((counts[t] || {})[s] || 0) - (mins[t] || 0);
  return { gap, isFresh: (t, s) => gap(t, s) === 0 };
}

function optimizeMatchupPairingForSport(rrMatchups, teams, availSports, h, asOf) {
  const cycles = makeSportCycles(h, teams, availSports, asOf);
  // Real meeting COUNT from the date-keyed gameLog (not a 0/1 flag, not the flat
  // aggregate which inverts under regen). Mirrors the source fix.
  function rem(a, b) { return getMatchupCountByDate(h, a, b, asOf); }
  function val(a, b) {
    let freshBoth = 0;
    for (const s of availSports) { const f = (cycles.isFresh(a, s) ? 1 : 0) + (cycles.isFresh(b, s) ? 1 : 0); if (f > freshBoth) { freshBoth = f; if (freshBoth === 2) break; } }
    return freshBoth === 2 ? 3 : freshBoth;
  }
  // RECENCY tiebreak (mirrors source): once counts tie, prefer the pair met longest ago.
  const MED = 1000;
  const _gl = (h.gameLog || {})[LG] || {};
  const _dates = Object.keys(_gl).filter(d => !asOf || d <= asOf).sort();
  const _denom = _dates.length + 1;
  function recency(a, b) {
    const key = [a, b].sort().join('|'); let best = 0;
    _dates.forEach((d, i) => (_gl[d] || []).forEach(e => { if (e && [e.t1, e.t2].sort().join('|') === key) best = (i + 1) / _denom; }));
    return best;
  }
  function pairScore(a, b) { return (-BIG) * rem(a, b) - MED * recency(a, b) + val(a, b); }
  const m = rrMatchups.map(p => [p[0], p[1]]);
  let improved = true, guard = 0;
  while (improved && guard < 300) {
    improved = false; guard++;
    for (let i = 0; i < m.length && !improved; i++) {
      for (let j = i + 1; j < m.length; j++) {
        const a = m[i][0], b = m[i][1], c = m[j][0], d = m[j][1];
        const base = pairScore(a, b) + pairScore(c, d);
        const s1 = pairScore(a, c) + pairScore(b, d);
        const s2 = pairScore(a, d) + pairScore(b, c);
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
function countRematches(h, m) { return m.reduce((n, p) => n + (getMatchupCount(h, p[0], p[1]) > 0 ? 1 : 0), 0); }
function keys(m) { return m.map(p => p.slice().sort().join('v')); }

// ---- TEST 1: zero rematches preserved (opponents never worse than round-robin) ----
(function () {
  const h = H();
  // All four teams have each only played Basketball; NONE have met → fresh round-robin.
  addGame(h, '2026-06-25', '1', 'x', 'Basketball');
  addGame(h, '2026-06-25', '2', 'x2', 'Basketball');
  addGame(h, '2026-06-25', '3', 'x3', 'Basketball');
  addGame(h, '2026-06-25', '4', 'x4', 'Basketball');
  const rr = [['1', '2'], ['3', '4']];
  assert.strictEqual(countRematches(h, rr), 0, 'precondition: round-robin has no rematch');
  const out = optimizeMatchupPairingForSport(rr, ['1', '2', '3', '4'], ['Football', 'Basketball'], h);
  assert.strictEqual(countRematches(h, out), 0, 'output must have ZERO rematches: ' + keys(out).join(','));
  console.log('TEST 1 PASS — zero rematches in, zero rematches out: ' + keys(out).join(', '));
})();

// ---- TEST 2: shared sport-need concentration improves ----
(function () {
  const h = H();
  // A & B need Football (only played Basketball). C & D need Basketball (only played Football).
  addGame(h, '2026-06-25', 'A', 'p', 'Basketball');
  addGame(h, '2026-06-25', 'B', 'q', 'Basketball');
  addGame(h, '2026-06-25', 'C', 'r', 'Football');
  addGame(h, '2026-06-25', 'D', 's', 'Football');
  // Round-robin happens to pair a needy-with-satisfied split: A vs C, B vs D.
  // No team has met → every arrangement is rematch-free, so the 2-opt is free to
  // concentrate: A vs B (both need Football → one Football field) and C vs D
  // (both need Basketball → one Basketball field).
  const rr = [['A', 'C'], ['B', 'D']];
  const out = optimizeMatchupPairingForSport(rr, ['A', 'B', 'C', 'D'], ['Football', 'Basketball'], h);
  assert.strictEqual(countRematches(h, out), 0, 'no rematches introduced: ' + keys(out).join(','));
  const k = keys(out);
  assert(k.includes('AvB') && k.includes('CvD'),
    'should concentrate shared needs (AvB + CvD): ' + k.join(','));
  console.log('TEST 2 PASS — concentrated shared sport needs (A vs B, C vs D): ' + k.join(', '));
})();

// ---- TEST 3: self-correction — a rematch in the round-robin input is reduced ----
(function () {
  const h = H();
  // 1 & 2 already met (a stale rematch in today's round-robin), 3 & 4 have not.
  addGame(h, '2026-06-25', '1', '2', 'Basketball');
  const rr = [['1', '2'], ['3', '4']];  // 1v2 is a rematch
  assert.strictEqual(countRematches(h, rr), 1, 'precondition: input has one rematch');
  const out = optimizeMatchupPairingForSport(rr, ['1', '2', '3', '4'], ['Football', 'Basketball'], h);
  assert(countRematches(h, out) < 1, 'self-correct: rematch reduced to 0: ' + keys(out).join(','));
  const k = keys(out);
  assert(!k.includes('1v2'), 'must break the 1v2 rematch: ' + k.join(','));
  console.log('TEST 3 PASS — self-corrected the round-robin rematch (1v2 broken): ' + k.join(', '));
})();

// ---- TEST 4: never trades an opponent repeat for a sport gain (matchup wins ties) ----
(function () {
  const h = H();
  // Make A vs B a fresh-for-both sport win, but A & B already met → must NOT pair them.
  addGame(h, '2026-06-25', 'A', 'B', 'Basketball'); // A&B met; both played Basketball
  addGame(h, '2026-06-25', 'C', 'D', 'Football');   // C&D met; both played Football
  const rr = [['A', 'C'], ['B', 'D']]; // none of A-C, B-D met → fresh
  const out = optimizeMatchupPairingForSport(rr, ['A', 'B', 'C', 'D'], ['Football', 'Basketball'], h);
  const k = keys(out);
  assert(!k.includes('AvB') && !k.includes('CvD'),
    'sport gain must NOT override an opponent repeat: ' + k.join(','));
  assert.strictEqual(countRematches(h, out), 0, 'output keeps zero rematches: ' + k.join(','));
  console.log('TEST 4 PASS — refused the rematch despite the sport bait: ' + k.join(', '));
})();

// ---- TEST 5: regen-INVERTED aggregate — gameLog count keeps rotating opponents ----
// The live bug: a 4-team league stuck on 1v2/3v4 every game. The flat matchupHistory
// aggregate had INVERTED: pre-gameLog meetings for 1v3/1v4/2v3/2v4 froze at 2 (rollback
// can't subtract what isn't in the gameLog), while the actually-overplayed 1v2/3v4 got
// decremented to 1 on each regen — so the aggregate said 1v2/3v4 were the LEAST-met and
// the optimizer kept re-selecting them. Counting from the gameLog (truth) fixes it.
(function () {
  const h = H();
  // gameLog TRUTH: only 1v2 and 3v4 have ever actually been logged (the collapse).
  addGame(h, '2026-06-29', '1', '2', 'Dodgeball');
  addGame(h, '2026-06-29', '3', '4', 'Kickball');
  // flat aggregate is INVERTED (phantom pre-gameLog counts the rollback never cleared):
  h.matchupHistory = { 'L:1|2': 1, 'L:1|3': 2, 'L:1|4': 2, 'L:2|3': 2, 'L:2|4': 2, 'L:3|4': 1 };

  // Sanity: the OLD flat-aggregate guard would pick the WRONG (overplayed) pairs.
  const remFlat = (a, b) => getMatchupCount(h, a, b);
  assert(remFlat('1', '2') < remFlat('1', '3'),
    'precondition: flat aggregate is inverted (1v2 looks rarer than 1v3)');

  // gameLog-derived optimizer must AVOID the truly-overplayed 1v2/3v4.
  const meetings = m => m.reduce((n, p) => n + getMatchupCountByDate(h, p[0], p[1], '2026-06-30'), 0);
  const rr = [['1', '2'], ['3', '4']];                 // the round-robin round that lands today
  const out = optimizeMatchupPairingForSport(rr, ['1', '2', '3', '4'], ['Kickball', 'Dodgeball'], h, '2026-06-30');
  const k = keys(out);
  assert(!(k.includes('1v2') && k.includes('3v4')),
    'must NOT stay stuck on the truly-overplayed 1v2/3v4: ' + k.join(','));
  assert(meetings(out) < meetings(rr),
    'must move to genuinely less-met opponents (per gameLog): ' + k.join(','));
  console.log('TEST 5 PASS — gameLog count beats the inverted aggregate, rotates to: ' + k.join(', '));
})();

// ---- TEST 6: recency tiebreak — after a full cycle, don't repeat yesterday ----
// 4 teams play a full round-robin over two days (06-29: 1v2/3v4, 06-30: 1v3/2v4 then
// 1v4/2v3). Now every pair has met exactly once → counts all tie. The next day must
// pick the round played LONGEST ago (1v2/3v4 from 06-29), NOT repeat 06-30's 1v4/2v3.
(function () {
  const h = H();
  addGame(h, '2026-06-29', '1', '2', 'Kickball');
  addGame(h, '2026-06-29', '3', '4', 'Dodgeball');
  addGame(h, '2026-06-30', '1', '3', 'Kickball');
  addGame(h, '2026-06-30', '2', '4', 'Dodgeball');
  addGame(h, '2026-06-30', '1', '4', 'Kickball');
  addGame(h, '2026-06-30', '2', '3', 'Dodgeball');
  // every pair met exactly once → counts tie
  ['1|2', '1|3', '1|4', '2|3', '2|4', '3|4'].forEach(k =>
    assert.strictEqual(getMatchupCountByDate(h, k.split('|')[0], k.split('|')[1], '2026-07-01'), 1, 'precondition: all pairs met once'));
  // round-robin hands today the most-recent round; recency must rotate away from it.
  const rr = [['1', '4'], ['2', '3']];
  const out = optimizeMatchupPairingForSport(rr, ['1', '2', '3', '4'], ['Kickball', 'Dodgeball'], h, '2026-07-01');
  const k = keys(out);
  assert(!(k.includes('1v4') && k.includes('2v3')),
    'must NOT repeat yesterday (06-30) 1v4/2v3: ' + k.join(','));
  assert(k.includes('1v2') && k.includes('3v4'),
    'should pick the round played longest ago (06-29) 1v2/3v4: ' + k.join(','));
  console.log('TEST 6 PASS — recency rotates to the oldest round instead of repeating: ' + k.join(', '));
})();

// ---- TEST 7: CYCLE 2 — sport tiebreak stays ALIVE after everyone played everything ----
// With the old binary played-ever freshness, once every team had played both sports
// val() returned 0 for every pairing — the sport term canceled out and matchup mode
// lost its sport tiebreak for the REST OF THE SEASON. Cycle-aware freshness keeps it:
// A & B are one Kickball AHEAD (K2, Dg1 → they need Dodgeball this cycle); C & D are
// one Dodgeball ahead (K1, Dg2 → they need Kickball). All history is vs phantom
// teams, so no real pair has met (meetings/recency all tie at 0) — only the sport
// need can decide. The 2-opt must re-pair AvC/BvD → AvB (both need Dg) + CvD (both
// need K), which the dead binary signal could never do.
(function () {
  const h = H();
  addGame(h, '2026-06-25', 'A', 'p1', 'Kickball');
  addGame(h, '2026-06-25', 'B', 'p2', 'Kickball');
  addGame(h, '2026-06-25', 'C', 'p3', 'Kickball');
  addGame(h, '2026-06-25', 'D', 'p4', 'Kickball');
  addGame(h, '2026-06-26', 'A', 'p1', 'Dodgeball');
  addGame(h, '2026-06-26', 'B', 'p2', 'Dodgeball');
  addGame(h, '2026-06-26', 'C', 'p3', 'Dodgeball');
  addGame(h, '2026-06-26', 'D', 'p4', 'Dodgeball');
  // cycle 2 begins, unevenly:
  addGame(h, '2026-06-27', 'A', 'p1', 'Kickball');   // A: K2 Dg1 → needs Dodgeball
  addGame(h, '2026-06-27', 'B', 'p2', 'Kickball');   // B: K2 Dg1 → needs Dodgeball
  addGame(h, '2026-06-27', 'C', 'p3', 'Dodgeball');  // C: K1 Dg2 → needs Kickball
  addGame(h, '2026-06-27', 'D', 'p4', 'Dodgeball');  // D: K1 Dg2 → needs Kickball
  const rr = [['A', 'C'], ['B', 'D']];
  const out = optimizeMatchupPairingForSport(rr, ['A', 'B', 'C', 'D'], ['Kickball', 'Dodgeball'], h, '2026-06-28');
  const k = keys(out);
  assert(k.includes('AvB') && k.includes('CvD'),
    'cycle-2 needs must still concentrate (AvB need Dg, CvD need K): ' + k.join(','));
  console.log('TEST 7 PASS — sport tiebreak alive in cycle 2 (AvB + CvD): ' + k.join(', '));
})();

console.log('\n✅ ALL MATCHUP-SPORTOPT (option 3) TESTS PASS');

