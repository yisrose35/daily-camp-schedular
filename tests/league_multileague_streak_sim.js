/* MULTI-LEAGUE + HARD STREAK CAP — proves the matchup creator's guarantees hold
 * when several leagues (different teams, different sports, different modes) run
 * the same period sharing one field inventory:
 *   1. league histories are fully independent (per-league keys) — each league's
 *      matchup + sport rotation is computed only from its own games
 *   2. no field is double-booked within a slot
 *   3. HARD STREAK CAP: no team ever plays the same sport more than 2 game days
 *      in a row (mirrors _applyStreakCapFilter — the soft -1500 recent-sport
 *      penalty alone could not guarantee this in constrained slots)
 *   4. rotations stay sane under cross-league field contention (need-first
 *      fair-share caps): per-league meeting counts and sport counts stay tight
 *
 * Mirrors chooseDailyMatchups (exact branch) / makeSportCycles / makePairRecency
 * / _applyStreakCapFilter / _filterPoolByPairSportCycle and the assigners'
 * scoring in scheduler_core_leagues.js.
 */
'use strict';
const assert = require('assert');

// ---------- mirrored engine pieces (per league name LG) ----------
function H() { return { gameLog: {} }; }
function addGame(h, lg, date, t1, t2, sport) {
  if (!h.gameLog[lg]) h.gameLog[lg] = {};
  (h.gameLog[lg][date] = h.gameLog[lg][date] || []).push({ t1, t2, sport });
}
function met(h, lg, a, b) {
  const gl = h.gameLog[lg] || {}; const key = [a, b].sort().join('|'); let n = 0;
  Object.keys(gl).forEach(d => (gl[d] || []).forEach(e => { if ([e.t1, e.t2].sort().join('|') === key) n++; }));
  return n;
}
function sportCounts(h, lg, t) {
  const gl = h.gameLog[lg] || {}, out = {};
  Object.keys(gl).forEach(d => (gl[d] || []).forEach(e => { if (e.sport && (e.t1 === t || e.t2 === t)) out[e.sport] = (out[e.sport] || 0) + 1; }));
  return out;
}
function teamHist(h, lg, t) {
  const gl = h.gameLog[lg] || {}, out = [];
  Object.keys(gl).sort().forEach(d => (gl[d] || []).forEach(e => { if (e.sport && (e.t1 === t || e.t2 === t)) out.push(e.sport); }));
  return out;
}
function pairSports(h, lg, a, b) {
  const gl = h.gameLog[lg] || {}, key = [a, b].sort().join('|'), out = [];
  Object.keys(gl).forEach(d => (gl[d] || []).forEach(e => { if (e.sport && [e.t1, e.t2].sort().join('|') === key) out.push(e.sport); }));
  return out;
}
function makeSportCycles(h, lg, teams, cycleSports) {
  const counts = {}; teams.forEach(t => counts[t] = sportCounts(h, lg, t));
  const mins = {};
  teams.forEach(t => { let m = Infinity; cycleSports.forEach(s => { const c = counts[t][s] || 0; if (c < m) m = c; }); mins[t] = m === Infinity ? 0 : m; });
  const gap = (t, s) => ((counts[t] || {})[s] || 0) - (mins[t] || 0);
  const done = t => cycleSports.reduce((n, s) => n + (gap(t, s) > 0 ? 1 : 0), 0);
  return { gap, isFresh: (t, s) => gap(t, s) === 0, starve: t => (mins[t] || 0) * 1000 + done(t) };
}
function makePairRecency(h, lg) {
  const gl = h.gameLog[lg] || {};
  const dates = Object.keys(gl).sort(), denom = dates.length + 1;
  return (a, b) => {
    const key = [a, b].sort().join('|'); let best = 0;
    dates.forEach((d, i) => (gl[d] || []).forEach(e => { if ([e.t1, e.t2].sort().join('|') === key) best = (i + 1) / denom; }));
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
function chooseDailyMatchups(h, lg, teams, availSports, mode) {
  const cycles = makeSportCycles(h, lg, teams, availSports);
  const recency = makePairRecency(h, lg);
  function sportFresh(a, b) { let best = 0; for (const s of availSports) { const f = (cycles.isFresh(a, s) ? 1 : 0) + (cycles.isFresh(b, s) ? 1 : 0); if (f > best) { best = f; if (best === 2) break; } } return best; }
  const isM = mode === 'matchup_variety', W_OPP = isM ? 1000 : 25, W_SPORT = isM ? 8 : 300, W_REC = isM ? 100 : 10;
  const pairWeight = (a, b) => (-met(h, lg, a, b)) * W_OPP + sportFresh(a, b) * W_SPORT - recency(a, b) * W_REC;
  const matchings = perfectMatchings(teams);
  let best = null, bestW = -Infinity, bestMet = Infinity;
  for (const m of matchings) {
    let tw = 0, tm = 0;
    for (const p of m) { if (p[0] === '__BYE__' || p[1] === '__BYE__') continue; tw += pairWeight(p[0], p[1]); tm += met(h, lg, p[0], p[1]); }
    if (tw > bestW || (tw === bestW && tm < bestMet)) { best = m; bestW = tw; bestMet = tm; }
  }
  return best.filter(p => p[0] !== '__BYE__' && p[1] !== '__BYE__').map(p => [p[0], p[1]]);
}
// mirrors _applyStreakCapFilter — the HARD "never 3 game days in a row" rule
function applyStreakCap(pool, hist1, hist2) {
  if (!pool.length) return pool;
  const blocked = new Set();
  [hist1, hist2].forEach(hist => {
    const n = hist.length;
    if (n >= 2 && hist[n - 1] === hist[n - 2]) blocked.add(hist[n - 1]);
  });
  if (!blocked.size) return pool;
  const ok = pool.filter(o => !blocked.has(o.sport));
  return ok.length ? ok : pool;
}
// mirrors _filterPoolByPairSportCycle
function applyPairCycle(pool, h, lg, a, b) {
  const pc = {}; pairSports(h, lg, a, b).forEach(s => pc[s] = (pc[s] || 0) + 1);
  if (!Object.keys(pc).length || !pool.length) return pool;
  let minPair = Infinity; pool.forEach(o => { const c = pc[o.sport] || 0; if (c < minPair) minPair = c; });
  const fresh = pool.filter(o => (pc[o.sport] || 0) === minPair);
  return fresh.length ? fresh : pool;
}
// mirrors the assigner (both mode scorers share this shape; scarcity + slot
// usage + recent guard + hard filters; field quality/indoor/random omitted —
// neutral here)
function assignLeague(h, lg, matchups, pool, mode, sportCaps) {
  const teams = [...new Set(matchups.flat())];
  const availSports = [...new Set(pool.map(o => o.sport))];
  const cycles = makeSportCycles(h, lg, teams, availSports);
  const streak = hist => { if (!hist.length) return 0; const l = hist[hist.length - 1]; let n = 0; for (let i = hist.length - 1; i >= 0 && hist[i] === l; i--) n++; return n; };
  const fieldsBySport = {}; pool.forEach(o => { fieldsBySport[o.sport] = (fieldsBySport[o.sport] || 0) + 1; });
  const maxFields = Math.max(1, ...Object.values(fieldsBySport));
  const scarcity = s => ((maxFields / (fieldsBySport[s] || 1)) - 1) * 300;

  const ordered = matchups.map(([a, b]) => ({
    a, b,
    coverMin: Math.min(cycles.starve(a), cycles.starve(b)),
    stuck: streak(teamHist(h, lg, a)) + streak(teamHist(h, lg, b)),
    variety: cycles.starve(a) + cycles.starve(b),
    mc: met(h, lg, a, b)
  })).sort((x, y) => x.coverMin - y.coverMin || y.stuck - x.stuck || x.variety - y.variety || x.mc - y.mc);

  const usedFields = new Set(), usedSportsThisSlot = {}, out = [];
  ordered.forEach(({ a, b }) => {
    let p = pool.filter(o => !usedFields.has(o.field));
    const ha = teamHist(h, lg, a), hb = teamHist(h, lg, b);
    p = applyStreakCap(p, ha, hb);
    // fair-share cap BEFORE the pair caveat (mirrors the source ordering fix):
    // pair-sport freshness must never push a league past its share and starve
    // a junior league of its only sports' fields.
    if (sportCaps) {
      const under = p.filter(o => sportCaps[o.sport] == null || (usedSportsThisSlot[o.sport] || 0) < sportCaps[o.sport]);
      if (under.length) p = under;
    }
    // ★ CYCLE RESCUE (mirrors _applyCycleRescueFilter): a team ≥2 plays behind
    // on an available sport gets it as a hard preference — a partner's
    // 2-in-a-row is the lesser evil (3-in-a-row stays impossible: p is already
    // streak-filtered). Rescued picks are pinned against the swap pass.
    let rescued = false;
    {
      const poolSports = [...new Set(p.map(o => o.sport))];
      if (p.length >= 2 && poolSports.length >= 2) {
        const cnt = hist => { const c = {}; hist.forEach(s => c[s] = (c[s] || 0) + 1); return c; };
        const c1 = cnt(ha), c2 = cnt(hb);
        const deficit = (c, s) => { let max = 0; poolSports.forEach(sp => { const v = c[sp] || 0; if (v > max) max = v; }); return max - (c[s] || 0); };
        let best = null, bestD = 0;
        poolSports.forEach(s => {
          const d1 = deficit(c1, s), d2 = deficit(c2, s);
          const d = (d1 >= 2 ? d1 : 0) + (d2 >= 2 ? d2 : 0);
          if (d > bestD) { bestD = d; best = s; }
        });
        if (best) {
          const rp = p.filter(o => o.sport === best);
          if (rp.length) { p = rp; rescued = true; }
        }
      }
    }
    p = applyPairCycle(p, h, lg, a, b);
    let bestO = null, bestScore = -Infinity;
    p.forEach(o => {
      const g1 = cycles.gap(a, o.sport), g2 = cycles.gap(b, o.sport);
      let score = (g1 <= 0 ? 1000 : Math.max(0, 100 - g1 * 20)) + (g2 <= 0 ? 1000 : Math.max(0, 100 - g2 * 20));
      score += ((g1 <= 0 ? 1 : 0) + (g2 <= 0 ? 1 : 0)) * scarcity(o.sport);
      if (ha.length && ha[ha.length - 1] === o.sport) score -= 1500;
      if (hb.length && hb[hb.length - 1] === o.sport) score -= 1500;
      if (mode === 'sport_variety') {
        const u = usedSportsThisSlot[o.sport] || 0;
        score += u === 0 ? 500 : -u * 100;
      }
      if (score > bestScore) { bestScore = score; bestO = o; }
    });
    if (!bestO) return;
    usedFields.add(bestO.field);
    usedSportsThisSlot[bestO.sport] = (usedSportsThisSlot[bestO.sport] || 0) + 1;
    out.push({ a, b, sport: bestO.sport, field: bestO.field, _rescued: rescued || undefined });
  });
  // ★ within-slot swap pass (mirrors _swapReoptimizeAssignments): trade the
  // (sport, field) choices of two matchups when that serves cycle needs
  // better and creates no 3-day streak — fixes need-stranding between
  // matchups competing for one scarce field.
  const swapCycles = makeSportCycles(h, lg, teams, [...new Set(out.map(o => o.sport))]);
  const hists = {}; teams.forEach(t => hists[t] = teamHist(h, lg, t));
  const tScore = (t, s) => {
    const g = swapCycles.gap(t, s);
    let sc = g <= 0 ? 1000 : Math.max(0, 100 - g * 20);
    const hh = hists[t];
    if (hh.length && hh[hh.length - 1] === s) sc -= 1500;
    return sc;
  };
  const illegal = (t, s) => { const hh = hists[t]; return hh.length >= 2 && hh[hh.length - 1] === s && hh[hh.length - 2] === s; };
  const aScore = (g, s) => tScore(g.a, s) + tScore(g.b, s) - pairSports(h, lg, g.a, g.b).filter(x => x === s).length * 400;
  let swImproved = true, swGuard = 0;
  while (swImproved && swGuard++ < 100) {
    swImproved = false;
    for (let i = 0; i < out.length && !swImproved; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const A = out[i], B = out[j];
        if (A.sport === B.sport) continue;
        if (A._rescued || B._rescued) continue;   // never trade a rescued sport away
        if (illegal(A.a, B.sport) || illegal(A.b, B.sport) || illegal(B.a, A.sport) || illegal(B.b, A.sport)) continue;
        if (aScore(A, B.sport) + aScore(B, A.sport) > aScore(A, A.sport) + aScore(B, B.sport)) {
          const tmp = { field: A.field, sport: A.sport };
          A.field = B.field; A.sport = B.sport;
          B.field = tmp.field; B.sport = tmp.sport;
          swImproved = true; break;
        }
      }
    }
  }
  return out;
}
// mirrors the need-first fair-share caps (_sportNeed + largest remainder)
function computeCaps(h, leagues, fieldsBySport, dayId) {
  const games = {}; leagues.forEach(l => games[l.name] = Math.max(1, Math.floor(l.teams.length / 2)));
  let seed = 0; for (let i = 0; i < dayId.length; i++) seed = (seed * 31 + dayId.charCodeAt(i)) & 0x7fffffff;
  const need = (l, sport) => {
    let total = 0;
    l.teams.forEach(t => {
      const c = sportCounts(h, l.name, t);
      let most = 0; for (const s in c) if (c[s] > most) most = c[s];
      total += Math.max(0, most - (c[sport] || 0));
    });
    return total;
  };
  const caps = {}; leagues.forEach(l => caps[l.name] = {});
  const allSports = new Set(); leagues.forEach(l => l.sports.forEach(s => allSports.add(s)));
  allSports.forEach(sport => {
    const fc = fieldsBySport[sport] || 0; if (fc <= 0) return;
    const parts = leagues.filter(l => l.sports.includes(sport));
    let weights = parts.map(l => need(l, sport));
    if (weights.reduce((s, w) => s + w, 0) === 0) weights = parts.map(l => games[l.name]);
    const totalW = weights.reduce((s, w) => s + w, 0) || 1;
    const rows = parts.map((l, idx) => { const exact = fc * weights[idx] / totalW; const base = Math.floor(exact); return { name: l.name, base, frac: exact - base, idx }; });
    let rem = fc - rows.reduce((s, r) => s + r.base, 0);
    rows.sort((a, b) => (b.frac - a.frac) || (((a.idx + seed) % rows.length) - ((b.idx + seed) % rows.length)));
    for (let i = 0; i < rows.length; i++) rows[i].base += (i < rem ? 1 : 0);
    rows.forEach(r => { caps[r.name][sport] = r.base; });
  });
  // ★ PARTICIPATION FLOOR (mirrors source): a league must be able to SEAT its
  // games — a caught-up league (need 0 everywhere) would otherwise get cap 0
  // on all its sports and be starved by the seniors' fallback.
  const capTotal = l => l.sports.reduce((s, sp) => s + (caps[l.name][sp] || 0), 0);
  const maxSeats = l => l.sports.reduce((s, sp) => s + (fieldsBySport[sp] || 0), 0);
  let guard = 0;
  while (guard++ < 64) {
    let moved = false;
    for (const l of leagues) {
      const wanted = Math.min(games[l.name], maxSeats(l));
      if (capTotal(l) >= wanted) continue;
      let best = null;
      for (const sp of l.sports) {
        const lcap = caps[l.name][sp] || 0;
        if (lcap >= (fieldsBySport[sp] || 0)) continue;
        for (const d of leagues) {
          if (d === l || !d.sports.includes(sp)) continue;
          if ((caps[d.name][sp] || 0) <= 0) continue;
          const surplus = capTotal(d) - games[d.name];
          if (surplus <= 0) continue;
          if (!best || lcap < best.lcap || (lcap === best.lcap && surplus > best.surplus)) best = { donor: d, sp, surplus, lcap };
        }
      }
      if (!best) continue;
      caps[best.donor.name][best.sp]--;
      caps[l.name][best.sp] = (caps[l.name][best.sp] || 0) + 1;
      moved = true;
    }
    if (!moved) break;
  }
  return caps;
}

// ---------- TEST 1: focused streak-cap proofs ----------
(function () {
  // 2 in a row is allowed; a 3rd consecutive day is hard-blocked even when the
  // scorer would otherwise favor it (cycle need max, scarce sport).
  const pool = [{ field: 'HK1', sport: 'Hockey' }, { field: 'FB1', sport: 'Football' }];
  // team A's last two games were Hockey → Hockey must vanish from its pool
  let out = applyStreakCap(pool, ['Football', 'Hockey', 'Hockey'], ['Football', 'Baseball']);
  assert.deepStrictEqual(out.map(o => o.sport), ['Football'], '3rd consecutive Hockey day must be impossible');
  // one Hockey yesterday only → both options stay (2 in a row remains possible)
  out = applyStreakCap(pool, ['Football', 'Hockey'], ['Football', 'Baseball']);
  assert.strictEqual(out.length, 2, 'a 2nd consecutive day stays allowed (soft penalty decides)');
  // the OPPONENT's streak blocks too (both teams play the chosen sport)
  out = applyStreakCap(pool, ['Football', 'Baseball'], ['Hockey', 'Hockey']);
  assert.deepStrictEqual(out.map(o => o.sport), ['Football'], "opponent's streak blocks the sport as well");
  // fallback: single-sport league — cap would empty the pool → keep it
  out = applyStreakCap([{ field: 'HK1', sport: 'Hockey' }], ['Hockey', 'Hockey'], ['Hockey', 'Hockey']);
  assert.strictEqual(out.length, 1, 'single-sport league: game still happens');
  console.log('TEST 1 PASS — hard streak cap: 2 in a row allowed, 3rd day impossible, safe fallback');
})();

// ---------- TEST 2: 12-day multi-league season under shared fields ----------
(function () {
  const FIELDS = [
    { field: 'FB-A', sport: 'Football' }, { field: 'FB-B', sport: 'Football' },
    { field: 'BK-A', sport: 'Basketball' }, { field: 'BK-B', sport: 'Basketball' }, { field: 'BK-C', sport: 'Basketball' },
    { field: 'BB-A', sport: 'Baseball' }, { field: 'BB-B', sport: 'Baseball' },
    { field: 'HK-A', sport: 'Hockey' }, { field: 'HK-B', sport: 'Hockey' },
    { field: 'SC-A', sport: 'Soccer' }, { field: 'VB-A', sport: 'Volleyball' },
  ];
  const FIELDS_BY_SPORT = {}; FIELDS.forEach(f => FIELDS_BY_SPORT[f.sport] = (FIELDS_BY_SPORT[f.sport] || 0) + 1);
  const LEAGUES = [   // seniority order: processed first claims fields first
    { name: 'Seniors', teams: ['S1','S2','S3','S4','S5','S6','S7','S8'], sports: ['Football','Basketball','Baseball','Hockey'], mode: 'sport_variety' },
    { name: 'Juniors', teams: ['J1','J2','J3','J4','J5','J6'], sports: ['Basketball','Soccer','Volleyball'], mode: 'matchup_variety' },
    { name: 'Minis',   teams: ['M1','M2','M3','M4'], sports: ['Football','Basketball'], mode: 'sport_variety' },
  ];
  const h = H();
  const days = [];
  for (let d = 1; d <= 12; d++) {
    const date = '2026-07-' + String(d).padStart(2, '0');
    const caps = computeCaps(h, LEAGUES, FIELDS_BY_SPORT, date);
    const usedFieldsToday = new Set();
    const dayGames = {};
    LEAGUES.forEach(l => {
      // pool: this league's sports, on fields not already locked by an earlier league
      const pool = FIELDS.filter(f => l.sports.includes(f.sport) && !usedFieldsToday.has(f.field));
      const matchups = chooseDailyMatchups(h, l.name, l.teams, [...new Set(pool.map(o => o.sport))], l.mode);
      const games = assignLeague(h, l.name, matchups, pool, l.mode, caps[l.name]);
      games.forEach(g => { usedFieldsToday.add(g.field); addGame(h, l.name, date, g.a, g.b, g.sport); });
      dayGames[l.name] = games;
    });
    days.push({ date, dayGames });
  }

  // (a) every league scheduled every matchup every day (no dropped games)
  days.forEach(({ date, dayGames }) => {
    assert.strictEqual(dayGames['Seniors'].length, 4, 'Seniors: 4 games on ' + date);
    assert.strictEqual(dayGames['Juniors'].length, 3, 'Juniors: 3 games on ' + date);
    assert.strictEqual(dayGames['Minis'].length, 2, 'Minis: 2 games on ' + date);
  });

  // (b) no field double-booked within any day
  days.forEach(({ date, dayGames }) => {
    const seen = new Set();
    Object.values(dayGames).flat().forEach(g => {
      assert(!seen.has(g.field), 'field ' + g.field + ' double-booked on ' + date);
      seen.add(g.field);
    });
  });

  // (c) sports/teams stay within each league's config (per-league isolation)
  days.forEach(({ dayGames }) => LEAGUES.forEach(l => dayGames[l.name].forEach(g => {
    assert(l.sports.includes(g.sport), l.name + ' got foreign sport ' + g.sport);
    assert(l.teams.includes(g.a) && l.teams.includes(g.b), l.name + ' got foreign team');
  })));

  // (d) HARD STREAK CAP: no team, in any league, plays the same sport 3 game days running
  LEAGUES.forEach(l => l.teams.forEach(t => {
    const hist = teamHist(h, l.name, t);
    for (let i = 2; i < hist.length; i++) {
      assert(!(hist[i] === hist[i - 1] && hist[i] === hist[i - 2]),
        l.name + '/' + t + ' played ' + hist[i] + ' 3 days in a row: ' + hist.join(','));
    }
  }));

  // (e) rotations stay sane under contention
  LEAGUES.forEach(l => {
    // meetings spread (matchup fairness)
    const meets = [];
    for (let i = 0; i < l.teams.length; i++) for (let j = i + 1; j < l.teams.length; j++) meets.push(met(h, l.name, l.teams[i], l.teams[j]));
    const spreadM = Math.max(...meets) - Math.min(...meets);
    assert(spreadM <= 2, l.name + ': meeting spread must stay ≤2, got ' + spreadM + ' (' + meets.join(',') + ')');
    // per-team sport spread (sport fairness)
    l.teams.forEach(t => {
      const c = sportCounts(h, l.name, t);
      const v = l.sports.map(s => c[s] || 0);
      const spreadS = Math.max(...v) - Math.min(...v);
      assert(spreadS <= 3, l.name + '/' + t + ': sport spread must stay ≤3, got ' + JSON.stringify(c));
    });
  });

  // report
  console.log('TEST 2 PASS — 12-day, 3-league season: 108 games, zero double-books, streak cap held');
  LEAGUES.forEach(l => {
    const meets = [];
    for (let i = 0; i < l.teams.length; i++) for (let j = i + 1; j < l.teams.length; j++) meets.push(met(h, l.name, l.teams[i], l.teams[j]));
    console.log('  ' + l.name + ' (' + l.mode + '): meetings min/max ' + Math.min(...meets) + '/' + Math.max(...meets)
      + ' · sample sport counts ' + l.teams.slice(0, 2).map(t => t + '=' + JSON.stringify(sportCounts(h, l.name, t))).join(' '));
  });
})();

console.log('\n✅ ALL MULTI-LEAGUE + STREAK-CAP TESTS PASS');
