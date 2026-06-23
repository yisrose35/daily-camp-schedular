/* Seniority ordering + sport-rotation simulation.
 * Replicates the NEW logic added to scheduler_core_leagues.js:
 *   1. _sportFreshnessScore + matchup_variety scoring → a team that already
 *      played a sport rotates OFF it the next day when an alternative exists.
 *   2. within-slot spread → two games in one slot don't stack the same sport
 *      while another sport/field is free.
 *   3. seniority sort → leagues order OLDEST division first (by getDivisionAgeOrder),
 *      younger leagues "make their way down".
 *
 * Mirrors the file exactly; the Math.random()*10 tie-breaker is set to 0 here
 * (all decisive gaps are >> 10, so it can never flip these outcomes).
 */
'use strict';
const assert = require('assert');

// ---- replicated from scheduler_core_leagues.js -------------------------------
function getTeamSportHistory(lg, team, h) { return (h.teamSports[`${lg}|${team}`]) || []; }
function _sportFreshnessScore(lg, team, sport, h) {
    const hist = getTeamSportHistory(lg, team, h);
    const c = hist.filter(s => s === sport).length;
    if (c === 0) return 1000;
    return Math.max(0, 100 - c * 20);
}
// matchup_variety inner sport pick (indoor bias = 0, random = 0 here)
function pickSport(lg, t1, t2, pool, h, usedSportsThisSlot) {
    let best = null, bestScore = -Infinity;
    for (const o of pool) {
        let score = _sportFreshnessScore(lg, t1, o.sport, h) + _sportFreshnessScore(lg, t2, o.sport, h);
        const used = usedSportsThisSlot[o.sport] || 0;
        score += used === 0 ? 500 : -used * 100;
        if (score > bestScore) { bestScore = score; best = o; }
    }
    return best;
}
// seniority sort (oldest division first)
function sortLeaguesBySeniority(leagues, ageOrder) {
    const idx = {};
    ageOrder.forEach((d, i) => { if (idx[String(d)] == null) idx[String(d)] = i; });
    const seniority = (l) => {
        let best = Infinity;
        (l.divisions || []).forEach(d => { const i = idx[String(d)]; if (i != null && i < best) best = i; });
        return best;
    };
    return leagues.slice().sort((a, b) => seniority(a) - seniority(b));
}

// ---- TEST 1: cross-day rotation ---------------------------------------------
(function () {
    const h = { teamSports: { 'L|A': ['Basketball', 'Basketball'], 'L|B': [] } };
    const pool = [{ sport: 'Basketball', field: 'Court1' }, { sport: 'Volleyball', field: 'V1' }, { sport: 'Baseball', field: 'B1' }];
    const pick = pickSport('L', 'A', 'B', pool, h, {});
    assert.notStrictEqual(pick.sport, 'Basketball', 'team that played Basketball 2x must rotate OFF it');
    console.log(`TEST 1 PASS — cross-day rotation: A (played Basketball x2) got ${pick.sport}, not Basketball`);
})();

// ---- TEST 2: within-slot spread ---------------------------------------------
(function () {
    const h = { teamSports: {} }; // everyone fresh on everything
    const pool = [{ sport: 'Volleyball', field: 'V1' }, { sport: 'Volleyball', field: 'V2' }, { sport: 'Baseball', field: 'B1' }];
    const used = {};
    const g1 = pickSport('L', 'A', 'B', pool, h, used);
    used[g1.sport] = (used[g1.sport] || 0) + 1;
    const g2 = pickSport('L', 'C', 'D', pool, h, used);
    assert.notStrictEqual(g2.sport, g1.sport, 'second game must pick a different sport when one is free');
    console.log(`TEST 2 PASS — within-slot spread: games picked ${g1.sport} then ${g2.sport} (no stacking)`);
})();

// ---- TEST 3: seniority order (oldest first) ---------------------------------
(function () {
    const ageOrder = ['9', '8', '7', '6', '5', '4', '3', '2', '1']; // oldest-first
    const leagues = [
        { name: 'Young (1&2)', divisions: ['1', '2'] },
        { name: 'Old (8&9)', divisions: ['8', '9'] },
        { name: 'Mid (5&6)', divisions: ['5', '6'] },
    ];
    const ordered = sortLeaguesBySeniority(leagues, ageOrder).map(l => l.name);
    assert.deepStrictEqual(ordered, ['Old (8&9)', 'Mid (5&6)', 'Young (1&2)'], 'leagues must run oldest division first');
    console.log(`TEST 3 PASS — seniority order: ${ordered.join(' → ')}`);
})();

// ---- TEST 4: qualified division keys (Camp Agudah > 6 style) -----------------
(function () {
    const ageOrder = ['9', '8', '7', 'Camp Agudah > 6', 'Day Camp > 6', '3', '2', '1'];
    const leagues = [
        { name: 'Day Camp 6th', divisions: ['Day Camp > 6'] },
        { name: 'Agudah 6th', divisions: ['Camp Agudah > 6'] },
    ];
    const ordered = sortLeaguesBySeniority(leagues, ageOrder).map(l => l.name);
    assert.deepStrictEqual(ordered, ['Agudah 6th', 'Day Camp 6th'], 'qualified grade keys order by Me position');
    console.log(`TEST 4 PASS — qualified keys: ${ordered.join(' → ')}`);
})();

console.log('\nALL 4 SENIORITY + SPORT-ROTATION TESTS PASS');
