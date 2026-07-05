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
// mirrors makeSportCycles: "fresh" = the team still NEEDS the sport in its
// current cycle (count at the team's minimum across today's available sports).
function makeSportCycles(lg, teams, cycleSports, h) {
    const counts = {};
    teams.forEach(t => { const c = {}; getTeamSportHistory(lg, t, h).forEach(s => { c[s] = (c[s] || 0) + 1; }); counts[t] = c; });
    const mins = {};
    teams.forEach(t => { let m = Infinity; cycleSports.forEach(s => { const c = counts[t][s] || 0; if (c < m) m = c; }); mins[t] = m === Infinity ? 0 : m; });
    const gap = (t, s) => ((counts[t] || {})[s] || 0) - (mins[t] || 0);
    return { gap, isFresh: (t, s) => gap(t, s) === 0 };
}
function choosePairingsForSportVariety(activeTeams, availablePool, lg, h, fallbackMatchups) {
    if (!Array.isArray(activeTeams) || activeTeams.length < 2 || activeTeams.length > 12) return fallbackMatchups;
    if (!Array.isArray(availablePool) || availablePool.length === 0) return fallbackMatchups;
    const matchings = generatePerfectMatchings(activeTeams);
    if (matchings.length <= 1) return fallbackMatchups;
    const availSports = [...new Set(availablePool.map(o => o.sport))];
    const cycles = makeSportCycles(lg, activeTeams, availSports, h);
    let best = null, bestFresh = -1, bestMeet = Infinity;
    for (const m of matchings) {
        let fresh = 0, meet = 0;
        for (const pair of m) {
            if (pair[0] === '__BYE__' || pair[1] === '__BYE__') continue;
            meet += getMatchupCount(lg, pair[0], pair[1], h);
            let bestPair = 0;
            for (const o of availablePool) {
                const s = (cycles.isFresh(pair[0], o.sport) ? 1 : 0) + (cycles.isFresh(pair[1], o.sport) ? 1 : 0);
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

// ---- Test 4: caveat — rematch prefers the pair's LEAST-played sport (cycles) ----
// Mirrors _filterPoolByPairSportCycle: keep only options whose pair play count is
// the minimum. Cycle 1 behaves like the old binary filter (never replay while an
// unplayed sport exists); once the pair exhausted everything, a new pair cycle
// starts at the least-replayed sport instead of "anything goes".
{
    function filterPoolByPairSportCycle(pool, lg, t1, t2, h) {
        const pairCounts = {};
        getPairSports(lg, t1, t2, h).forEach(s => { pairCounts[s] = (pairCounts[s] || 0) + 1; });
        if (Object.keys(pairCounts).length === 0 || pool.length === 0) return pool;
        let minPair = Infinity;
        pool.forEach(o => { const c = pairCounts[o.sport] || 0; if (c < minPair) minPair = c; });
        const fresh = pool.filter(o => (pairCounts[o.sport] || 0) === minPair);
        return fresh.length ? fresh : pool;
    }
    const h = {
        teamSports: { 'L|1': ['M'], 'L|4': ['M'] },
        matchupHistory: { 'L:1|4': 1 },
        gameLog: { L: { 'd1': [{ t1: '1', t2: '4', sport: 'M' }] } }
    };
    // cycle 1: prior pair sport excluded while an unplayed alternative exists
    let out = filterPoolByPairSportCycle([{ sport: 'M' }, { sport: 'J' }], 'L', '1', '4', h);
    assert.deepStrictEqual(out.map(o => o.sport), ['J'], 'prior pair sport excluded while an alternative exists');
    // exhausted (only M available) → the repeat is allowed
    out = filterPoolByPairSportCycle([{ sport: 'M' }], 'L', '1', '4', h);
    assert.deepStrictEqual(out.map(o => o.sport), ['M'], 'repeat allowed when the pair exhausted everything');
    // pair CYCLE 2: pair played M twice and J once → J (least-replayed) preferred
    h.gameLog.L['d2'] = [{ t1: '1', t2: '4', sport: 'J' }];
    h.gameLog.L['d3'] = [{ t1: '1', t2: '4', sport: 'M' }];
    out = filterPoolByPairSportCycle([{ sport: 'M' }, { sport: 'J' }], 'L', '1', '4', h);
    assert.deepStrictEqual(out.map(o => o.sport), ['J'], 'new pair cycle starts at the least-replayed sport');
    console.log('TEST 4 PASS — rematch-sport caveat cycles (least-replayed first)');
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
