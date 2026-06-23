/* League rotation simulation — replicates the scheduler_core_leagues.js logic:
 *   1. cross-day rotation (a team rotates off a sport it has played a lot)
 *   2. within-slot spread (one slot doesn't stack the same sport)
 *   3. LEAST-OPTIONS-FIRST ordering (most field-constrained league picks first)
 *   4. HARD no-3-in-a-row blocks the 3rd consecutive same sport
 *   5. recency — with ≥3 sports, steer to the sport NEITHER team played last
 *   6. scarce-sport cap FORMULA (fields ÷ leagues, contended sports only)
 *   7. scarce-sport cap EFFECT — a league at its cap leaves the scarce sport
 *   8. under-cap is NOT penalized (the league still gets its fair 1 game)
 *   9. no-3-in-a-row: centered X[X]X blocked + fallback allows (never a bye)
 *
 * Mirrors the file's logic exactly; Math.random()*10 is dropped here.
 */
'use strict';
const assert = require('assert');

function getTeamSportHistory(lg, team, h) { return (h.teamSports[`${lg}|${team}`]) || []; }

function freshness(lg, team, sport, h) {
    const hist = getTeamSportHistory(lg, team, h);
    const c = hist.filter(s => s === sport).length;
    let score = (c === 0) ? 1000 : Math.max(0, 100 - c * 20);
    if (c > 0 && hist[hist.length - 1] === sport) score -= 350; // anti-streak (soft)
    return score;
}

// HARD no-3-in-a-row guard (file copy) — reads the date-keyed gameLog
function streakBlocked(lg, team, sport, h, dayId) {
    const gl = h.gameLog && h.gameLog[lg];
    if (!gl || dayId == null || !sport) return false;
    const tk = String(team);
    const sportOn = d => { for (const g of (gl[d] || [])) { if (String(g.t1) === tk || String(g.t2) === tk) return g.sport || null; } return null; };
    const before = Object.keys(gl).filter(d => d < dayId).sort();
    const after = Object.keys(gl).filter(d => d > dayId).sort();
    const p1 = before.length ? sportOn(before[before.length - 1]) : null;
    const p2 = before.length > 1 ? sportOn(before[before.length - 2]) : null;
    const n1 = after.length ? sportOn(after[0]) : null;
    const n2 = after.length > 1 ? sportOn(after[1]) : null;
    if (p1 === sport && p2 === sport) return true;
    if (p1 === sport && n1 === sport) return true;
    if (n1 === sport && n2 === sport) return true;
    return false;
}

// assignment inner sport pick: no-3 filter (hard) → freshness + spread + cap
function pickSport(lg, t1, t2, pool, h, used, slotCap, dayId) {
    let p = pool.filter(o => !streakBlocked(lg, t1, o.sport, h, dayId) && !streakBlocked(lg, t2, o.sport, h, dayId));
    if (p.length === 0) p = pool;             // fallback: forced repeat beats a bye
    let best = null, bestScore = -Infinity;
    for (const o of p) {
        let score = freshness(lg, t1, o.sport, h) + freshness(lg, t2, o.sport, h);
        const u = used[o.sport] || 0;
        score += u === 0 ? 500 : -u * 100;
        if (slotCap && slotCap[o.sport] != null && u >= slotCap[o.sport]) score -= 2500;
        if (score > bestScore) { bestScore = score; best = o; }
    }
    return best;
}

function computeCap(fieldsBySport, leagues) {
    const usingCount = {};
    leagues.forEach(l => (l.sports || []).forEach(sp => { usingCount[sp] = (usingCount[sp] || 0) + 1; }));
    const cap = {};
    Object.keys(usingCount).forEach(sp => {
        const n = Array.isArray(fieldsBySport[sp]) ? fieldsBySport[sp].length : 0;
        if (n > 0 && usingCount[sp] > 1 && n < usingCount[sp] * 3) cap[sp] = Math.max(1, Math.floor(n / usingCount[sp]));
    });
    return Object.keys(cap).length ? cap : null;
}

// least-options-first sort (file copy)
function sortByOptions(leagues, fbs) {
    const opt = l => (l.sports || []).reduce((s, sp) => s + (Array.isArray(fbs[sp]) ? fbs[sp].length : 0), 0);
    return leagues.slice().sort((a, b) => { const d = opt(a) - opt(b); if (d) return d; return (b.teams?.length || 0) - (a.teams?.length || 0); });
}

// 1: cross-day rotation
(function () {
    const h = { teamSports: { 'L|A': ['Basketball', 'Basketball'], 'L|B': [] } };
    const pool = [{ sport: 'Basketball' }, { sport: 'Volleyball' }, { sport: 'Baseball' }];
    assert.notStrictEqual(pickSport('L', 'A', 'B', pool, h, {}).sport, 'Basketball');
    console.log('TEST 1 PASS — cross-day rotation');
})();

// 2: within-slot spread
(function () {
    const h = { teamSports: {} };
    const pool = [{ sport: 'Volleyball' }, { sport: 'Baseball' }];
    const used = {}; const g1 = pickSport('L', 'A', 'B', pool, h, used); used[g1.sport] = 1;
    assert.notStrictEqual(pickSport('L', 'C', 'D', pool, h, used).sport, g1.sport);
    console.log('TEST 2 PASS — within-slot spread');
})();

// 3: LEAST-OPTIONS-FIRST ordering
(function () {
    const fbs = { Hockey: Array(4), Baseball: Array(5), Football: Array(8), Volleyball: Array(10), Basketball: Array(15) };
    const leagues = [
        { name: '5sport', sports: ['Baseball', 'Basketball', 'Football', 'Hockey', 'Volleyball'], teams: Array(10) },
        { name: '4sport(8&9)', sports: ['Baseball', 'Football', 'Volleyball', 'Hockey'], teams: Array(18) },
    ];
    const order = sortByOptions(leagues, fbs).map(l => l.name);
    assert.deepStrictEqual(order, ['4sport(8&9)', '5sport'], 'fewest field options goes first');
    console.log('TEST 3 PASS — least-options-first: ' + order.join(' → '));
})();

// 4: HARD no-3-in-a-row blocks the 3rd
(function () {
    const h = { teamSports: {}, gameLog: { L: { '2026-06-21': [{ t1: 'A', t2: 'B', sport: 'Volleyball' }], '2026-06-23': [{ t1: 'A', t2: 'C', sport: 'Volleyball' }] } } };
    const pool = [{ sport: 'Volleyball' }, { sport: 'Football' }];
    const pick = pickSport('L', 'A', 'B', pool, h, {}, null, '2026-06-24').sport;
    assert.strictEqual(pick, 'Football', 'A played VB the last 2 days → VB blocked on day 3');
    console.log('TEST 4 PASS — no-3-in-a-row: 3rd consecutive Volleyball blocked');
})();

// 5: recency — pick the sport NEITHER team played last
(function () {
    const h = { teamSports: { 'L|A': ['Hockey', 'Volleyball', 'Basketball'], 'L|B': ['Basketball', 'Hockey', 'Volleyball'] } };
    const pool = [{ sport: 'Basketball' }, { sport: 'Volleyball' }, { sport: 'Hockey' }];
    assert.strictEqual(pickSport('L', 'A', 'B', pool, h, {}).sport, 'Hockey');
    console.log('TEST 5 PASS — recency: picked the mutually-non-recent sport');
})();

// 6: scarce-sport cap formula
(function () {
    const fbs = { Hockey: Array(4), Baseball: Array(5), Football: Array(8), Volleyball: Array(10), Basketball: Array(15) };
    const leagues = Array.from({ length: 4 }, () => ({ sports: ['Hockey', 'Baseball', 'Football', 'Volleyball', 'Basketball'] }));
    assert.deepStrictEqual(computeCap(fbs, leagues), { Hockey: 1, Baseball: 1, Football: 2, Volleyball: 2 });
    console.log('TEST 6 PASS — cap formula (Basketball uncapped = overflow valve)');
})();

// 7: cap EFFECT — at cap, leave the scarce sport
(function () {
    const pool = [{ sport: 'Hockey', field: 'H2' }, { sport: 'Volleyball', field: 'V1' }];
    assert.strictEqual(pickSport('L', 'A', 'B', pool, { teamSports: {} }, { Hockey: 1 }, { Hockey: 1 }).sport, 'Volleyball');
    console.log('TEST 7 PASS — cap effect: over-cap Hockey left for others');
})();

// 8: under cap — first scarce game allowed
(function () {
    const h = { teamSports: { 'L|A': ['Volleyball', 'Volleyball'], 'L|B': ['Volleyball', 'Volleyball'] } };
    const pool = [{ sport: 'Hockey', field: 'H1' }, { sport: 'Volleyball', field: 'V1' }];
    assert.strictEqual(pickSport('L', 'A', 'B', pool, h, {}, { Hockey: 1 }).sport, 'Hockey');
    console.log('TEST 8 PASS — under cap: first Hockey allowed');
})();

// 9: no-3-in-a-row centered + fallback (never a bye)
(function () {
    const hC = { teamSports: {}, gameLog: { L: { '2026-06-23': [{ t1: 'A', t2: 'B', sport: 'Volleyball' }], '2026-06-25': [{ t1: 'A', t2: 'C', sport: 'Volleyball' }] } } };
    assert.strictEqual(streakBlocked('L', 'A', 'Volleyball', hC, '2026-06-24'), true, 'centered V[V]V blocked');
    assert.strictEqual(streakBlocked('L', 'A', 'Football', hC, '2026-06-24'), false, 'a different sport is fine');
    const hF = { teamSports: {}, gameLog: { L: { '2026-06-21': [{ t1: 'A', t2: 'B', sport: 'Volleyball' }], '2026-06-23': [{ t1: 'A', t2: 'C', sport: 'Volleyball' }] } } };
    assert.strictEqual(pickSport('L', 'A', 'B', [{ sport: 'Volleyball' }], hF, {}, null, '2026-06-24').sport, 'Volleyball', 'fallback: only field left is allowed (no bye)');
    console.log('TEST 9 PASS — no-3 centered block + fallback (no bye)');
})();

console.log('\nALL 9 LEAGUE-ROTATION TESTS PASS');
