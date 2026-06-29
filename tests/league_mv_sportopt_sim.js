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
function playedSports(h, t) {
  const gl = (h.gameLog || {})[LG] || {}, out = new Set();
  Object.keys(gl).forEach(d => (gl[d] || []).forEach(e => { if (e.sport && (e.t1 === t || e.t2 === t)) out.add(e.sport); }));
  return out;
}

function optimizeMatchupPairingForSport(rrMatchups, teams, availSports, h) {
  const played = {}; teams.forEach(t => played[t] = playedSports(h, t));
  function rem(a, b) { return getMatchupCount(h, a, b) > 0 ? 1 : 0; }
  function val(a, b) {
    const pa = played[a], pb = played[b]; let freshBoth = 0;
    for (const s of availSports) { const f = (pa.has(s) ? 0 : 1) + (pb.has(s) ? 0 : 1); if (f > freshBoth) { freshBoth = f; if (freshBoth === 2) break; } }
    return freshBoth === 2 ? 3 : freshBoth;
  }
  function pairScore(a, b) { return (-BIG) * rem(a, b) + val(a, b); }
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

console.log('\n✅ ALL MATCHUP-SPORTOPT (option 3) TESTS PASS');
