/* Coverage-gap priority — a team that has NEVER played a sport gets first claim
 * on that scarce sport's field, ahead of a team that's merely on a streak (but has
 * already played everything). Mirrors the matchup sort added to both assigners:
 *   PRIMARY  coverMin (min distinct-sports-played across the pair) ascending
 *   SECONDARY stuck (trailing same-sport streak) descending
 *
 * Only the FIELD-PICK ORDER changes; pairings are fixed upstream by round-robin.
 */
'use strict';
const assert = require('assert');

const distinct = arr => new Set(arr).size;
function streak(arr) { if (!arr.length) return 0; const l = arr[arr.length - 1]; let n = 0; for (let i = arr.length - 1; i >= 0 && arr[i] === l; i--) n++; return n; }

// Team histories. A has NEVER played Football (and no streak). C & D are on a
// Basketball streak but have already played Football.
const H = {
  A: ['Basketball', 'Baseball', 'Basketball', 'Baseball'],  // distinct 2 — MISSING Football, no streak
  B: ['Football', 'Hockey', 'Basketball', 'Baseball'],      // distinct 4
  C: ['Football', 'Hockey', 'Basketball', 'Basketball'],    // distinct 3, Basketball streak 2
  D: ['Football', 'Baseball', 'Basketball', 'Basketball'],  // distinct 3, Basketball streak 2
};
// Round-robin fixed today's pairings: A vs B, C vs D.
const matchups = [['A', 'B'], ['C', 'D']];

function order(useCover) {
  return matchups.slice().sort((a, b) => {
    const ca = Math.min(distinct(H[a[0]]), distinct(H[a[1]])), cb = Math.min(distinct(H[b[0]]), distinct(H[b[1]]));
    const sa = streak(H[a[0]]) + streak(H[a[1]]), sb = streak(H[b[0]]) + streak(H[b[1]]);
    if (useCover && ca !== cb) return ca - cb;     // coverage-gap primary
    if (sa !== sb) return sb - sa;                 // streak secondary
    return 0;
  });
}
// Pool: ONE diverse field (Football) + plenty of Basketball. The matchup processed
// first claims the single Football field; the rest get Basketball.
function assign(useCover) {
  const locked = new Set(), out = {};
  order(useCover).forEach(m => {
    const pool = [{ f: 'FB1', s: 'Football' }].concat([1,2,3,4,5,6].map(i => ({ f: 'BK'+i, s: 'Basketball' }))).filter(o => !locked.has(o.f));
    const pick = pool.find(o => o.s !== 'Basketball') || pool[0];   // grab the diverse field if free
    locked.add(pick.f); out[m[0]] = pick.s; out[m[1]] = pick.s;
  });
  return out;
}

// ---- TEST 1: the sort puts the missing-sport matchup first, even vs a streak ----
(function () {
  assert.strictEqual(order(true)[0].join('v'), 'AvB', 'coverage-gap matchup (A vs B) must sort first');
  assert.strictEqual(order(false)[0].join('v'), 'CvD', 'old streak-first order would put the streak matchup first');
  console.log('TEST 1 PASS — coverage-gap matchup sorts ahead of the streak matchup');
})();

// ---- TEST 2: with coverage priority the missing-sport team finally gets Football ----
(function () {
  assert.strictEqual(assign(false)['A'], 'Basketball', 'without coverage priority, team A (never played Football) misses it again');
  assert.strictEqual(assign(true)['A'], 'Football', 'with coverage priority, team A gets the scarce Football field');
  console.log('TEST 2 PASS — the missing-sport team claims the scarce sport (Football) it had never played');
})();

console.log('\n✅ ALL COVERAGE-GAP TESTS PASS');
