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

// run length if `sport` assigned today (file copy) — before+today+after
function runIfAssigned(lg, team, sport, h, dayId) {
    const gl = h.gameLog && h.gameLog[lg];
    if (!gl || dayId == null || !sport) return 1;
    const tk = String(team);
    const sportOn = d => { for (const g of (gl[d] || [])) { if (String(g.t1) === tk || String(g.t2) === tk) return g.sport || null; } return null; };
    const before = Object.keys(gl).filter(d => d < dayId).sort();
    const after = Object.keys(gl).filter(d => d > dayId).sort();
    let prev = 0; for (let i = before.length - 1; i >= 0; i--) { if (sportOn(before[i]) === sport) prev++; else break; }
    let next = 0; for (let i = 0; i < after.length; i++) { if (sportOn(after[i]) === sport) next++; else break; }
    return prev + 1 + next;
}
function streakBlocked(lg, team, sport, h, dayId) { return runIfAssigned(lg, team, sport, h, dayId) >= 3; }

// final no-4 swap repair (file copy)
function repairFourStreaks(assignments, lg, h, dayId) {
    if (!Array.isArray(assignments) || assignments.length < 2) return;
    const run = (t, s) => runIfAssigned(lg, t, s, h, dayId);
    for (let i = 0; i < assignments.length; i++) {
        const a = assignments[i]; if (!a || !a.sport) continue;
        if (run(a.team1, a.sport) < 4 && run(a.team2, a.sport) < 4) continue;
        for (let j = 0; j < assignments.length; j++) {
            if (j === i) continue; const b = assignments[j]; if (!b || !b.sport || b.sport === a.sport) continue;
            if (run(a.team1, b.sport) < 4 && run(a.team2, b.sport) < 4 && run(b.team1, a.sport) < 4 && run(b.team2, a.sport) < 4) {
                const s = a.sport, f = a.field; a.sport = b.sport; a.field = b.field; b.sport = s; b.field = f; break;
            }
        }
    }
}

// assignment inner sport pick: no-3 filter → freshness + spread + cap + run penalty
function pickSport(lg, t1, t2, pool, h, used, slotCap, dayId) {
    let p = pool.filter(o => !streakBlocked(lg, t1, o.sport, h, dayId) && !streakBlocked(lg, t2, o.sport, h, dayId));
    if (p.length === 0) p = pool;             // fallback: forced repeat beats a bye
    let best = null, bestScore = -Infinity;
    for (const o of p) {
        let score = freshness(lg, t1, o.sport, h) + freshness(lg, t2, o.sport, h);
        const u = used[o.sport] || 0;
        score += u === 0 ? 500 : -u * 100;
        if (slotCap && slotCap[o.sport] != null && u >= slotCap[o.sport]) score -= 2500;
        const run = Math.max(runIfAssigned(lg, t1, o.sport, h, dayId), runIfAssigned(lg, t2, o.sport, h, dayId));
        if (run >= 3) score -= 100000 * (run - 2); // crush 3, annihilate 4
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

// 10: the T4 bug — when forced to a streak, NEVER pick 4 over 3
(function () {
    // A played Dodgeball the last 3 days (DB would be 4); B played Kickball the
    // last 2 (KB would be 3). Both sports are "blocked" by no-3 → fallback. The
    // run penalty must pick KB (run 3) over DB (run 4) so A never hits 4.
    const h = {
        teamSports: {}, gameLog: {
            L: {
                '2026-06-21': [{ t1: 'A', t2: 'X', sport: 'Dodgeball' }],
                '2026-06-23': [{ t1: 'A', t2: 'Y', sport: 'Dodgeball' }, { t1: 'B', t2: 'Z', sport: 'Kickball' }],
                '2026-06-24': [{ t1: 'A', t2: 'W', sport: 'Dodgeball' }, { t1: 'B', t2: 'V', sport: 'Kickball' }],
            }
        }
    };
    const pick = pickSport('L', 'A', 'B', [{ sport: 'Dodgeball' }, { sport: 'Kickball' }], h, {}, null, '2026-06-25').sport;
    assert.strictEqual(pick, 'Kickball', 'forced repeat must be 3 (B), never 4 (A)');
    console.log('TEST 10 PASS — never-4: forced fallback took the 3-streak, not the 4');
})();

// 11: final repair swaps two games to break a 4-in-a-row
(function () {
    const h = {
        teamSports: {}, gameLog: {
            L: {
                '2026-06-21': [{ t1: 'A', t2: 'X', sport: 'Dodgeball' }],
                '2026-06-23': [{ t1: 'A', t2: 'Y', sport: 'Dodgeball' }],
                '2026-06-24': [{ t1: 'A', t2: 'W', sport: 'Dodgeball' }],
            }
        }
    };
    const assignments = [
        { team1: 'A', team2: 'B', sport: 'Dodgeball', field: 'F1' }, // A → 4th Dodgeball
        { team1: 'C', team2: 'D', sport: 'Kickball', field: 'F2' },
    ];
    repairFourStreaks(assignments, 'L', h, '2026-06-25');
    assert.strictEqual(assignments[0].sport, 'Kickball', 'A\'s game swapped off Dodgeball to break the 4');
    assert.strictEqual(assignments[1].sport, 'Dodgeball', 'the other game absorbed the Dodgeball');
    console.log('TEST 11 PASS — repair: swapped sports to break a 4-in-a-row');
})();

console.log('\nALL 11 LEAGUE-ROTATION TESTS PASS');
