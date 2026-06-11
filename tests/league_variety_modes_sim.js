/* FN-57 logic simulation — mode-aware pairing + rematch-sport caveat.
 * Replicates getPairSports / generatePerfectMatchings /
 * choosePairingsForSportVariety exactly as written in
 * scheduler_core_leagues.js and proves:
 *   1. matching enumeration is complete (4 teams → 3, 6 → 15)
 *   2. sport-plentiful: SV chooser prefers least-met pairs → round-robin-like
 *      opponent coverage survives (all pairs before rematch)
 *   3. sport-scarce: SV chooser DEVIATES from round-robin to give every team
 *      an unplayed sport (the real mode difference)
 *   4. caveat filter: rematch never replays the pair's prior sport while an
 *      alternative exists; falls back when the pair exhausted everything
 */
'use strict';
const assert = require('assert');

function getMatchupKey(t1, t2) { return [t1, t2].sort().join('|'); }
function getMatchupCount(lg, t1, t2, h) { return h.matchupHistory[`${lg}:${getMatchupKey(t1, t2)}`] || 0; }
function getTeamSportHistory(lg, team, h) { return h.teamSports[`${lg}|${team}`] || []; }
function getPairSports(lg, t1, t2, h) {
    const out = [];
    const gl = h.gameLog?.[lg];
    if (!gl) return out;
    const key = getMatchupKey(t1, t2);
    Object.keys(gl).forEach(d => (gl[d] || []).forEach(e => {
        if (e && e.sport && getMatchupKey(e.t1, e.t2) === key) out.push(e.sport);
    }));
    return out;
}
function generatePerfectMatchings(teams) {
    const arr = teams.slice();
    if (arr.length % 2 === 1) arr.push('__BYE__');
    const out = [];
    (function rec(rem, cur) {
        if (rem.length === 0) { out.push(cur.slice()); return; }
        const a = rem[0];
        for (let i = 1; i < rem.length; i++) {
            cur.push([a, rem[i]]);
            rec(rem.slice(1, i).concat(rem.slice(i + 1)), cur);
            cur.pop();
        }
    })(arr, []);
    return out;
}
function choosePairingsForSportVariety(activeTeams, availablePool, lg, h, fallbackMatchups) {
    if (!Array.isArray(activeTeams) || activeTeams.length < 2 || activeTeams.length > 12) return fallbackMatchups;
    if (!Array.isArray(availablePool) || availablePool.length === 0) return fallbackMatchups;
    const matchings = generatePerfectMatchings(activeTeams);
    if (matchings.length <= 1) return fallbackMatchups;
    const histSets = {};
    activeTeams.forEach(t => { histSets[t] = new Set(getTeamSportHistory(lg, t, h)); });
    let best = null, bestFresh = -1, bestMeet = Infinity;
    for (const m of matchings) {
        let fresh = 0, meet = 0;
        for (const pair of m) {
            if (pair[0] === '__BYE__' || pair[1] === '__BYE__') continue;
            meet += getMatchupCount(lg, pair[0], pair[1], h);
            let bestPair = 0;
            for (const o of availablePool) {
                const s = (histSets[pair[0]].has(o.sport) ? 0 : 1) + (histSets[pair[1]].has(o.sport) ? 0 : 1);
                if (s > bestPair) { bestPair = s; if (bestPair === 2) break; }
            }
            fresh += bestPair;
        }
        if (fresh > bestFresh || (fresh === bestFresh && meet < bestMeet)) { best = m; bestFresh = fresh; bestMeet = meet; }
    }
    if (!best) return fallbackMatchups;
    return best.filter(p => p[0] !== '__BYE__' && p[1] !== '__BYE__').map(p => [p[0], p[1]]);
}
const pairKey = ms => ms.map(p => p.slice().sort().join('v')).sort().join(',');

// ---- Test 1: matching enumeration complete ----
{
    assert.strictEqual(generatePerfectMatchings(['1','2','3','4']).length, 3);
    assert.strictEqual(generatePerfectMatchings(['1','2','3','4','5','6']).length, 15);
    // odd → byes covered: 3 teams → 3 matchings (each team takes the bye once)
    assert.strictEqual(generatePerfectMatchings(['1','2','3']).length, 3);
    console.log('TEST 1 PASS — matching enumeration complete');
}

// ---- Test 2: sport-plentiful → least-met tiebreak preserves opponent coverage ----
{
    // Day 2 of a season: day 1 was 1v4 + 2v3 (both played, count 1).
    const h = {
        teamSports: { 'L|1': ['A'], 'L|2': ['B'], 'L|3': ['B'], 'L|4': ['A'] },
        matchupHistory: { 'L:1|4': 1, 'L:2|3': 1 },
        gameLog: { L: { 'd1': [{ t1: '1', t2: '4', sport: 'A' }, { t1: '2', t2: '3', sport: 'B' }] } }
    };
    // 12 plentiful sports — every matching can give everyone a new sport
    const pool = 'CDEFGHIJKLMN'.split('').map(s => ({ field: s, sport: s }));
    const rr = [['1','3'],['4','2']]; // round-robin round 1
    const chosen = choosePairingsForSportVariety(['1','2','3','4'], pool, 'L', h, rr);
    // fresh ties at max for all matchings → least-met wins → must AVOID the day-1 pairs
    assert.notStrictEqual(pairKey(chosen), pairKey([['1','4'],['2','3']]), 'must not rematch day-1 pairs when sports are plentiful');
    console.log('TEST 2 PASS — plentiful sports → fresh opponents (round-robin-like)');
}

// ---- Test 3: sport-scarce → SV deviates from round-robin for sport coverage ----
{
    // Only 2 sports exist: M and J. Day 1: 1v4 played M, 2v3 played J.
    const h = {
        teamSports: { 'L|1': ['M'], 'L|4': ['M'], 'L|2': ['J'], 'L|3': ['J'] },
        matchupHistory: { 'L:1|4': 1, 'L:2|3': 1 },
        gameLog: { L: { 'd1': [{ t1: '1', t2: '4', sport: 'M' }, { t1: '2', t2: '3', sport: 'J' }] } }
    };
    const pool = [{ field: 'M', sport: 'M' }, { field: 'J', sport: 'J' }];
    const rr = [['1','3'],['4','2']]; // round-robin wants new opponents
    const chosen = choosePairingsForSportVariety(['1','2','3','4'], pool, 'L', h, rr);
    // Only the rematch pairing {1v4, 2v3} lets BOTH teams of each pair play a
    // new sport (1+4 take J, 2+3 take M). Mixed pairings max out at new-to-one.
    assert.strictEqual(pairKey(chosen), pairKey([['1','4'],['2','3']]), 'must rematch to protect sport coverage');
    console.log('TEST 3 PASS — scarce sports → pairing deviates from round-robin (the mode difference)');
}

// ---- Test 4: caveat — rematch never replays the pair sport (with fallback) ----
{
    const h = {
        teamSports: { 'L|1': ['M'], 'L|4': ['M'] },
        matchupHistory: { 'L:1|4': 1 },
        gameLog: { L: { 'd1': [{ t1: '1', t2: '4', sport: 'M' }] } }
    };
    const pairSports = new Set(getPairSports('L', '1', '4', h));
    assert.deepStrictEqual([...pairSports], ['M']);
    // filter logic as written in both assigners:
    let pool = [{ sport: 'M' }, { sport: 'J' }];
    let fresh = pool.filter(o => !pairSports.has(o.sport));
    assert.deepStrictEqual(fresh.map(o => o.sport), ['J'], 'prior pair sport excluded while an alternative exists');
    // exhausted: only M available → fallback allows the repeat
    pool = [{ sport: 'M' }];
    fresh = pool.filter(o => !pairSports.has(o.sport));
    assert.strictEqual(fresh.length, 0, 'fallback path engages when the pair exhausted everything');
    console.log('TEST 4 PASS — rematch-sport caveat + best-effort fallback');
}

// ---- Test 5: rollback keeps pair history honest (regen of a rematch day) ----
{
    // gameLog-derived pair sports shrink when a date is rolled back — no
    // separate structure to desync.
    const h = { teamSports: {}, matchupHistory: {}, gameLog: { L: {
        'd1': [{ t1: '1', t2: '4', sport: 'M' }],
        'd2': [{ t1: '1', t2: '4', sport: 'J' }]
    } } };
    assert.deepStrictEqual(getPairSports('L', '1', '4', h).sort(), ['J', 'M']);
    delete h.gameLog.L['d2']; // what rollbackDayRecords does on regen/delete
    assert.deepStrictEqual(getPairSports('L', '1', '4', h), ['M']);
    console.log('TEST 5 PASS — pair-sport history is rollback-consistent via gameLog');
}

console.log('\nALL 5 MODE-SEMANTICS TESTS PASS');
