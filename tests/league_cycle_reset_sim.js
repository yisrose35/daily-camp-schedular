/* SPORT-CYCLE RESET + MODE-AS-TIEBREAK — the dynamic matchup creator's contract:
 *
 *   1. Matchups are chosen from how many times teams have MET and which sports
 *      each team still NEEDS.
 *   2. Once a team has played every available sport, its needs RESET and a new
 *      cycle begins (freshness is cycle-relative, not played-ever).
 *   3. When a fresh OPPONENT and a fresh SPORT can't both happen (inevitable in
 *      a small league), the league's mode breaks the tie:
 *        matchup_variety → the new opponent wins (sport may repeat)
 *        sport_variety   → the new sport wins   (matchup may repeat)
 *
 * Mirrors makeSportCycles / makePairRecency / chooseDailyMatchups /
 * optimizeMatchupPairingForSport and the assigners' cycle-need scoring in
 * scheduler_core_leagues.js.
 */
'use strict';
const assert = require('assert');
const LG = 'L';

// ---------- mirrored helpers ----------
function H() { return { matchupHistory: {}, gameLog: { [LG]: {} } }; }
function addGame(h, date, t1, t2, sport) {
  h.matchupHistory[LG + ':' + [t1, t2].sort().join('|')] = (h.matchupHistory[LG + ':' + [t1, t2].sort().join('|')] || 0) + 1;
  (h.gameLog[LG][date] = h.gameLog[LG][date] || []).push({ t1, t2, sport });
}
function met(h, a, b) { return (h.matchupHistory || {})[LG + ':' + [a, b].sort().join('|')] || 0; }
function sportCounts(h, t) {
  const gl = (h.gameLog || {})[LG] || {}, out = {};
  Object.keys(gl).forEach(d => (gl[d] || []).forEach(e => { if (e.sport && (e.t1 === t || e.t2 === t)) out[e.sport] = (out[e.sport] || 0) + 1; }));
  return out;
}
function teamHist(h, t) {   // date-ordered flat sport list
  const gl = (h.gameLog || {})[LG] || {}, out = [];
  Object.keys(gl).sort().forEach(d => (gl[d] || []).forEach(e => { if (e.sport && (e.t1 === t || e.t2 === t)) out.push(e.sport); }));
  return out;
}
// mirrors makeSportCycles
function makeSportCycles(h, teams, cycleSports) {
  const counts = {}; teams.forEach(t => counts[t] = sportCounts(h, t));
  const mins = {};
  teams.forEach(t => { let m = Infinity; cycleSports.forEach(s => { const c = counts[t][s] || 0; if (c < m) m = c; }); mins[t] = m === Infinity ? 0 : m; });
  const gap = (t, s) => ((counts[t] || {})[s] || 0) - (mins[t] || 0);
  const done = t => cycleSports.reduce((n, s) => n + (gap(t, s) > 0 ? 1 : 0), 0);
  return { gap, isFresh: (t, s) => gap(t, s) === 0, starve: t => (mins[t] || 0) * 1000 + done(t) };
}
// mirrors makePairRecency
function makePairRecency(h) {
  const gl = (h.gameLog || {})[LG] || {};
  const dates = Object.keys(gl).sort(), denom = dates.length + 1;
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
// mirrors chooseDailyMatchups — the matchup creator for BOTH modes: exact search
// over every possible pairing (≤12 teams; all tests here are small), no
// predetermined round-robin anywhere.
function chooseDailyMatchups(teams, availSports, h, mode) {
  const cycles = makeSportCycles(h, teams, availSports);
  const recency = makePairRecency(h);
  function sportFresh(a, b) { let best = 0; for (const s of availSports) { const f = (cycles.isFresh(a, s) ? 1 : 0) + (cycles.isFresh(b, s) ? 1 : 0); if (f > best) { best = f; if (best === 2) break; } } return best; }
  const isM = mode === 'matchup_variety', W_OPP = isM ? 1000 : 25, W_SPORT = isM ? 8 : 300, W_REC = isM ? 100 : 10;
  const pairWeight = (a, b) => (-met(h, a, b)) * W_OPP + sportFresh(a, b) * W_SPORT - recency(a, b) * W_REC;
  const matchings = perfectMatchings(teams);
  let best = null, bestW = -Infinity, bestMet = Infinity;
  for (const m of matchings) {
    let tw = 0, tm = 0;
    for (const p of m) { if (p[0] === '__BYE__' || p[1] === '__BYE__') continue; tw += pairWeight(p[0], p[1]); tm += met(h, p[0], p[1]); }
    if (tw > bestW || (tw === bestW && tm < bestMet)) { best = m; bestW = tw; bestMet = tm; }
  }
  return best.filter(p => p[0] !== '__BYE__' && p[1] !== '__BYE__').map(p => [p[0], p[1]]);
}
const keys = m => m.map(p => p.slice().sort().join('v')).sort();

// ---- TEST 1: cycle reset — after playing everything, every sport is fresh again ----
(function () {
  const h = H();
  addGame(h, 'd1', 'A', 'p', 'M');
  addGame(h, 'd2', 'A', 'p', 'J');
  addGame(h, 'd3', 'A', 'p', 'K');
  const cycles = makeSportCycles(h, ['A'], ['M', 'J', 'K']);
  assert(cycles.isFresh('A', 'M') && cycles.isFresh('A', 'J') && cycles.isFresh('A', 'K'),
    'after a full cycle every sport must be needed again');
  // mid-cycle-2: play M again → M no longer fresh, J & K still are
  addGame(h, 'd4', 'A', 'p', 'M');
  const c2 = makeSportCycles(h, ['A'], ['M', 'J', 'K']);
  assert(!c2.isFresh('A', 'M') && c2.isFresh('A', 'J') && c2.isFresh('A', 'K'),
    'cycle 2 tracks needs exactly like cycle 1 did');
  console.log('TEST 1 PASS — sport needs reset once a team has played everything');
})();

// ---- TEST 2: THE IMPOSSIBLE SITUATION — the mode breaks the tie ----
// 2 sports (M, J), 4 teams. Day 1: 1v2 played M, 3v4 played J. On day 2 a fresh
// opponent and a fresh sport can't both happen: pairing new opponents (1v3/2v4)
// mixes needs (1&2 need J, 3&4 need M — no sport is fresh for both teams of any
// new pair), while re-pairing 1v2/3v4 gives everyone a fresh sport but rematches.
(function () {
  const h = H();
  addGame(h, '2026-06-25', '1', '2', 'M');
  addGame(h, '2026-06-25', '3', '4', 'J');
  // sport_variety → the NEW SPORT wins: accept the rematch so both teams of each
  // pair get the sport they still need.
  const sv = chooseDailyMatchups(['1', '2', '3', '4'], ['M', 'J'], h, 'sport_variety');
  assert.deepStrictEqual(keys(sv), ['1v2', '3v4'],
    'sport_variety must prefer a fresh sport over a fresh opponent: ' + keys(sv).join(','));
  // matchup_variety → the NEW OPPONENT wins: pick a fresh pairing even though
  // someone must repeat a sport.
  const mv = chooseDailyMatchups(['1', '2', '3', '4'], ['M', 'J'], h, 'matchup_variety');
  const mvk = keys(mv);
  assert(!mvk.includes('1v2') && !mvk.includes('3v4'),
    'matchup_variety must prefer a fresh opponent over a fresh sport: ' + mvk.join(','));
  console.log('TEST 2 PASS — impossible situation: sport_variety rematches for the sport, matchup_variety repeats the sport for the opponent');
})();

// ---- TEST 3: assigner need — cycle need beats field quality (no more pinning) ----
// Team played [M, M, J, K]: cycle 2 has started with M. The OLD count-based need
// (100 − 20·count → M 60, J 80, K 80) was swamped by the field-quality bonus
// (+188 on M's nicer field) → M a THIRD time. Cycle need (gap 0 → 1000) makes the
// still-needed J win regardless of field rank.
(function () {
  const h = H();
  addGame(h, 'd1', 'T', 'p', 'M');
  addGame(h, 'd2', 'T', 'p', 'M');
  addGame(h, 'd3', 'T', 'p', 'J');
  addGame(h, 'd4', 'T', 'p', 'K');
  const cycles = makeSportCycles(h, ['T'], ['M', 'J', 'K']);
  const hist = teamHist(h, 'T');
  const need = s => { const g = cycles.gap('T', s); return g <= 0 ? 1000 : Math.max(0, 100 - g * 20); };
  const fq = { M: 188, J: 0, K: 0 };            // M sits on the best-ranked field
  const recentGuard = s => (hist.length && hist[hist.length - 1] === s ? -1500 : 0);
  const score = s => need(s) + fq[s] + recentGuard(s);
  const oldNeed = s => { const c = hist.filter(x => x === s).length; return c === 0 ? 1000 : Math.max(0, 100 - c * 20); };
  const oldScore = s => oldNeed(s) + fq[s] + recentGuard(s);
  const pick = f => ['M', 'J', 'K'].reduce((b, s) => f(s) > f(b) ? s : b);
  assert.strictEqual(pick(oldScore), 'M', 'sanity: the old flat need let field quality pin the team to M');
  assert.strictEqual(pick(score), 'J', 'cycle need must send the team to a sport it still needs');
  console.log('TEST 3 PASS — cycle need outranks field quality; the pinned-to-best-field repeat is gone');
})();

// ---- TEST 4: 12-day season — both rotations stay live all season ----
// 4 teams, 3 sports, one field per sport, two games a day. sport_variety must keep
// every team's per-sport counts within 1 of each other ALL season (cycles work);
// matchup_variety must keep every pair's meeting counts within 1 of each other.
(function () {
  function runSeason(mode) {
    const h = H();
    const teams = ['1', '2', '3', '4'], sports = ['M', 'J', 'K'];
    for (let day = 1; day <= 12; day++) {
      const date = '2026-07-' + String(day).padStart(2, '0');
      // BOTH modes: matchups computed fresh from history each day — no wheel.
      const matchups = chooseDailyMatchups(teams, sports, h, mode);
      // simplified assigner: one field per sport; most-starved matchup picks first;
      // per matchup: cycle need + recent-sport guard (mirrors the scorer's core).
      const cycles = makeSportCycles(h, teams, sports);
      matchups.sort((a, b) => Math.min(cycles.starve(a[0]), cycles.starve(a[1])) - Math.min(cycles.starve(b[0]), cycles.starve(b[1])));
      const usedSports = new Set();
      matchups.forEach(([a, b]) => {
        let bestS = null, bestScore = -Infinity;
        sports.forEach(s => {
          if (usedSports.has(s)) return;
          const needOf = (t) => { const g = cycles.gap(t, s); return g <= 0 ? 1000 : Math.max(0, 100 - g * 20); };
          const ha = teamHist(h, a), hb = teamHist(h, b);
          let sc = needOf(a) + needOf(b);
          if (ha.length && ha[ha.length - 1] === s) sc -= 1500;
          if (hb.length && hb[hb.length - 1] === s) sc -= 1500;
          if (sc > bestScore) { bestScore = sc; bestS = s; }
        });
        usedSports.add(bestS);
        addGame(h, date, a, b, bestS);
      });
    }
    return h;
  }

  // sport_variety: per-team sport counts balanced within 1
  const hs = runSeason('sport_variety');
  ['1', '2', '3', '4'].forEach(t => {
    const c = sportCounts(hs, t), v = ['M', 'J', 'K'].map(s => c[s] || 0);
    assert(Math.max(...v) - Math.min(...v) <= 1,
      `sport_variety: team ${t} sport counts must stay within 1: ` + JSON.stringify(c));
  });

  // matchup_variety: per-pair meeting counts balanced within 1
  const hm = runSeason('matchup_variety');
  const meets = [];
  const T = ['1', '2', '3', '4'];
  for (let i = 0; i < T.length; i++) for (let j = i + 1; j < T.length; j++) meets.push(met(hm, T[i], T[j]));
  assert(Math.max(...meets) - Math.min(...meets) <= 1,
    'matchup_variety: pair meeting counts must stay within 1: ' + meets.join(','));
  console.log('TEST 4 PASS — 12-day season: sport counts (SV) and meeting counts (MV) each stay within 1');
})();

// ---- TEST 5: starve rank — never-played outranks a fresh cycle-2 start ----
(function () {
  const h = H();
  // A played M and J but NEVER K (still in cycle 1). B played all three (cycle 2).
  addGame(h, 'd1', 'A', 'p', 'M'); addGame(h, 'd2', 'A', 'p', 'J');
  addGame(h, 'd1', 'B', 'q', 'M'); addGame(h, 'd2', 'B', 'q', 'J'); addGame(h, 'd3', 'B', 'q', 'K');
  const cycles = makeSportCycles(h, ['A', 'B'], ['M', 'J', 'K']);
  assert(cycles.starve('A') < cycles.starve('B'),
    'A (never played K) must get first pick over B (starting cycle 2)');
  console.log('TEST 5 PASS — the team still missing a sport outranks the team starting a new cycle');
})();

console.log('\n✅ ALL CYCLE-RESET / MODE-TIEBREAK TESTS PASS');
