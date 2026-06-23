/* Seniority ordering + sport-rotation simulation.
 * Replicates the logic added to scheduler_core_leagues.js and proves:
 *   1. cross-day rotation (a team rotates off a sport it has played a lot)
 *   2. within-slot spread (one slot doesn't stack the same sport)
 *   3. seniority sort (leagues run OLDEST division first)
 *   4. qualified division keys ("Camp Agudah > 6") order by Me position
 *   5. RECENCY / anti-streak — with ≥3 sports, the pick steers to the sport
 *      NEITHER team played most recently (kills back-to-back repeats)
 *   6. scarce-sport cap FORMULA (fields ÷ leagues-using-it, contended only)
 *   7. scarce-sport cap EFFECT — a league at its cap leaves the scarce sport
 *   8. under-cap is NOT penalized (the league still gets its fair 1 game)
 *
 * Mirrors the file's scoring exactly; Math.random()*10 is dropped here (all
 * decisive gaps are >> 10, so it can never flip these outcomes).
 */
'use strict';
const assert = require('assert');

function getTeamSportHistory(lg, team, h) { return (h.teamSports[`${lg}|${team}`]) || []; }

// _sportFreshnessScore — freshness + anti-streak recency penalty (file copy)
function freshness(lg, team, sport, h) {
    const hist = getTeamSportHistory(lg, team, h);
    const c = hist.filter(s => s === sport).length;
    let score = (c === 0) ? 1000 : Math.max(0, 100 - c * 20);
    if (c > 0 && hist[hist.length - 1] === sport) score -= 350; // anti-streak
    return score;
}

// assignment inner sport pick (indoor=0, random=0) — with scarce cap
function pickSport(lg, t1, t2, pool, h, usedSportsThisSlot, slotCap) {
    let best = null, bestScore = -Infinity;
    for (const o of pool) {
        let score = freshness(lg, t1, o.sport, h) + freshness(lg, t2, o.sport, h);
        const used = usedSportsThisSlot[o.sport] || 0;
        score += used === 0 ? 500 : -used * 100;
        if (slotCap && slotCap[o.sport] != null && used >= slotCap[o.sport]) score -= 2500;
        if (score > bestScore) { bestScore = score; best = o; }
    }
    return best;
}

// scarce-sport cap formula (file copy)
function computeCap(fieldsBySport, leagues) {
    const usingCount = {};
    leagues.forEach(l => (l.sports || []).forEach(sp => { usingCount[sp] = (usingCount[sp] || 0) + 1; }));
    const cap = {};
    Object.keys(usingCount).forEach(sp => {
        const n = Array.isArray(fieldsBySport[sp]) ? fieldsBySport[sp].length : 0;
        if (n > 0 && usingCount[sp] > 1 && n < usingCount[sp] * 2) cap[sp] = Math.max(1, Math.floor(n / usingCount[sp]));
    });
    return Object.keys(cap).length ? cap : null;
}

function sortLeaguesBySeniority(leagues, ageOrder) {
    const idx = {}; ageOrder.forEach((d, i) => { if (idx[String(d)] == null) idx[String(d)] = i; });
    const seniority = (l) => { let b = Infinity; (l.divisions || []).forEach(d => { const i = idx[String(d)]; if (i != null && i < b) b = i; }); return b; };
    return leagues.slice().sort((a, b) => seniority(a) - seniority(b));
}

// 1: cross-day rotation
(function () {
    const h = { teamSports: { 'L|A': ['Basketball', 'Basketball'], 'L|B': [] } };
    const pool = [{ sport: 'Basketball' }, { sport: 'Volleyball' }, { sport: 'Baseball' }];
    assert.notStrictEqual(pickSport('L', 'A', 'B', pool, h, {}).sport, 'Basketball');
    console.log('TEST 1 PASS — cross-day rotation: A rotated off Basketball');
})();

// 2: within-slot spread
(function () {
    const h = { teamSports: {} };
    const pool = [{ sport: 'Volleyball' }, { sport: 'Baseball' }];
    const used = {}; const g1 = pickSport('L', 'A', 'B', pool, h, used); used[g1.sport] = 1;
    assert.notStrictEqual(pickSport('L', 'C', 'D', pool, h, used).sport, g1.sport);
    console.log('TEST 2 PASS — within-slot spread: two games, two sports');
})();

// 3: seniority order
(function () {
    const order = sortLeaguesBySeniority([
        { name: 'Young', divisions: ['1', '2'] }, { name: 'Old', divisions: ['8', '9'] }, { name: 'Mid', divisions: ['5', '6'] },
    ], ['9', '8', '7', '6', '5', '4', '3', '2', '1']).map(l => l.name);
    assert.deepStrictEqual(order, ['Old', 'Mid', 'Young']);
    console.log('TEST 3 PASS — seniority order: ' + order.join(' → '));
})();

// 4: qualified keys
(function () {
    const order = sortLeaguesBySeniority([
        { name: 'DayCamp6', divisions: ['Day Camp > 6'] }, { name: 'Agudah6', divisions: ['Camp Agudah > 6'] },
    ], ['9', '8', '7', 'Camp Agudah > 6', 'Day Camp > 6', '3']).map(l => l.name);
    assert.deepStrictEqual(order, ['Agudah6', 'DayCamp6']);
    console.log('TEST 4 PASS — qualified keys: ' + order.join(' → '));
})();

// 5: RECENCY — with 3 sports all played once, pick the one neither played LAST
(function () {
    // A's most recent = Basketball, B's most recent = Volleyball; Hockey is the
    // sport neither played most recently → recency should steer the pick to it.
    const h = { teamSports: { 'L|A': ['Hockey', 'Volleyball', 'Basketball'], 'L|B': ['Basketball', 'Hockey', 'Volleyball'] } };
    const pool = [{ sport: 'Basketball' }, { sport: 'Volleyball' }, { sport: 'Hockey' }];
    const pick = pickSport('L', 'A', 'B', pool, h, {}).sport;
    assert.strictEqual(pick, 'Hockey', 'should avoid each team\'s most-recent sport');
    console.log('TEST 5 PASS — recency: picked Hockey (neither team\'s last sport)');
})();

// 6: scarce-sport cap formula — only contended sports capped
(function () {
    const fbs = { Hockey: Array(4), Baseball: Array(5), Football: Array(8), Volleyball: Array(10), Basketball: Array(15) };
    const leagues = Array.from({ length: 4 }, () => ({ sports: ['Hockey', 'Baseball', 'Football', 'Volleyball', 'Basketball'] }));
    const cap = computeCap(fbs, leagues);
    assert.deepStrictEqual(cap, { Hockey: 1, Baseball: 1 }, 'only Hockey(4) and Baseball(5) are contended for 4 leagues');
    console.log('TEST 6 PASS — cap formula: ' + JSON.stringify(cap) + ' (abundant sports uncapped)');
})();

// 7: cap EFFECT — at cap, the league leaves the scarce sport for others
(function () {
    const h = { teamSports: {} }; // both teams fresh on everything
    const pool = [{ sport: 'Hockey', field: 'H2' }, { sport: 'Volleyball', field: 'V1' }];
    const used = { Hockey: 1 };            // already used its 1 Hockey
    const pick = pickSport('L', 'A', 'B', pool, h, used, { Hockey: 1 }).sport;
    assert.strictEqual(pick, 'Volleyball', 'over-cap Hockey must lose to an uncapped sport');
    console.log('TEST 7 PASS — cap effect: at Hockey cap → took Volleyball, left Hockey');
})();

// 8: under cap, the scarce sport is NOT penalized (gets its fair 1)
(function () {
    const h = { teamSports: { 'L|A': ['Volleyball', 'Volleyball'], 'L|B': ['Volleyball', 'Volleyball'] } };
    const pool = [{ sport: 'Hockey', field: 'H1' }, { sport: 'Volleyball', field: 'V1' }];
    const pick = pickSport('L', 'A', 'B', pool, h, {}, { Hockey: 1 }).sport; // used Hockey = 0 < cap 1
    assert.strictEqual(pick, 'Hockey', 'first Hockey is within cap and both teams are stale on Volleyball');
    console.log('TEST 8 PASS — under cap: first Hockey allowed (fair share granted)');
})();

console.log('\nALL 8 SENIORITY + ROTATION + SCARCE-CAP TESTS PASS');
