/* FN-54 logic simulation — gameLog rollback idempotency (standalone, no DOM).
 * Replicates recordTeamSport/recordMatchup/logGameRecord/rollbackDayRecords
 * exactly as written in scheduler_core_leagues.js and proves:
 *   1. regen same date N times → aggregates identical to single gen
 *   2. rollback of a date removes exactly its contribution (other dates intact)
 *   3. legacy entries (no gameLog) are untouched by rollback (no over-subtract)
 */
'use strict';
const assert = require('assert');

function getMatchupKey(t1, t2) { return [t1, t2].sort().join('|'); }
function recordTeamSport(lg, team, sport, h) {
    const k = `${lg}|${team}`;
    if (!h.teamSports[k]) h.teamSports[k] = [];
    h.teamSports[k].push(sport);
}
function recordMatchup(lg, t1, t2, h) {
    const mk = `${lg}:${getMatchupKey(t1, t2)}`;
    h.matchupHistory[mk] = (h.matchupHistory[mk] || 0) + 1;
}
function logGameRecord(lg, date, t1, t2, sport, h) {
    if (!h.gameLog) h.gameLog = {};
    if (!h.gameLog[lg]) h.gameLog[lg] = {};
    if (!h.gameLog[lg][date]) h.gameLog[lg][date] = [];
    h.gameLog[lg][date].push({ t1, t2, sport: sport || null });
}
function rollbackDayRecords(lg, date, h) {
    const entries = h.gameLog?.[lg]?.[date];
    if (!entries || !entries.length) return 0;
    entries.forEach(e => {
        if (e.sport) {
            [e.t1, e.t2].forEach(team => {
                if (!team) return;
                const arr = h.teamSports[`${lg}|${team}`];
                if (!arr) return;
                const idx = arr.lastIndexOf(e.sport);
                if (idx !== -1) arr.splice(idx, 1);
            });
        }
        if (e.t1 && e.t2) {
            const mk = `${lg}:${getMatchupKey(e.t1, e.t2)}`;
            if (h.matchupHistory[mk] > 1) h.matchupHistory[mk]--;
            else delete h.matchupHistory[mk];
        }
    });
    const n = entries.length;
    delete h.gameLog[lg][date];
    return n;
}

// Simulates one generation run for a date: rollback (engine pre-pass), then record games.
function genDay(lg, date, games, h) {
    rollbackDayRecords(lg, date, h);
    if (h.gamesPerDate?.[lg]?.[date] !== undefined) delete h.gamesPerDate[lg][date];
    games.forEach(g => {
        recordTeamSport(lg, g.t1, g.sport, h);
        recordTeamSport(lg, g.t2, g.sport, h);
        recordMatchup(lg, g.t1, g.t2, h);
        logGameRecord(lg, date, g.t1, g.t2, g.sport, h);
    });
    if (!h.gamesPerDate) h.gamesPerDate = {};
    if (!h.gamesPerDate[lg]) h.gamesPerDate[lg] = {};
    if (games.length > 0) h.gamesPerDate[lg][date] = games.length;
}

const snap = h => JSON.stringify({ ts: h.teamSports, mh: h.matchupHistory, gpd: h.gamesPerDate });

// ---- Test 1: regen idempotency ----
{
    const h = { teamSports: {}, matchupHistory: {}, gamesPerDate: {}, gameLog: {} };
    const day1 = [{ t1: '1', t2: '3', sport: 'Gaga' }, { t1: '2', t2: '4', sport: 'Hockey' }];
    genDay('L', '2026-06-26', day1, h);
    const once = snap(h);
    for (let i = 0; i < 5; i++) genDay('L', '2026-06-26', day1, h);
    assert.strictEqual(snap(h), once, 'regen x5 must equal single gen');
    assert.strictEqual(h.teamSports['L|1'].length, 1);
    assert.strictEqual(h.matchupHistory['L:1|3'], 1);
    console.log('TEST 1 PASS — regen x5 idempotent');
}

// ---- Test 2: regen with DIFFERENT outcome replaces (not stacks) ----
{
    const h = { teamSports: {}, matchupHistory: {}, gamesPerDate: {}, gameLog: {} };
    genDay('L', '2026-06-26', [{ t1: '1', t2: '3', sport: 'Gaga' }], h);
    genDay('L', '2026-06-27', [{ t1: '1', t2: '2', sport: 'Belts' }], h);
    // regen 06-26 with a different sport
    genDay('L', '2026-06-26', [{ t1: '1', t2: '3', sport: 'Dodgeball' }], h);
    assert.deepStrictEqual(h.teamSports['L|1'].sort(), ['Belts', 'Dodgeball'], 'Gaga must be gone, Belts intact');
    assert.strictEqual(h.matchupHistory['L:1|3'], 1);
    assert.strictEqual(h.matchupHistory['L:1|2'], 1, 'other date matchup intact');
    console.log('TEST 2 PASS — regen replaces day records, other dates untouched');
}

// ---- Test 3: legacy (pre-fix) entries never over-subtracted ----
{
    const h = { teamSports: { 'L|1': ['Gaga', 'Gaga', 'Gaga'] }, matchupHistory: { 'L:1|3': 3 }, gamesPerDate: { L: { '2026-05-18': 1 } }, gameLog: {} };
    // regen a legacy date (no gameLog entry): rollback is a no-op; records replace gamesPerDate but append aggregates ONCE (documented one-time legacy skew)
    genDay('L', '2026-05-18', [{ t1: '1', t2: '3', sport: 'Gaga' }], h);
    assert.strictEqual(h.teamSports['L|1'].length, 4, 'legacy + 1 new');
    // second regen is now tracked → stable
    genDay('L', '2026-05-18', [{ t1: '1', t2: '3', sport: 'Gaga' }], h);
    assert.strictEqual(h.teamSports['L|1'].length, 4, 'tracked regen stable');
    assert.strictEqual(h.matchupHistory['L:1|3'], 4);
    console.log('TEST 3 PASS — legacy data safe; one-time skew then stable');
}

// ---- Test 4: date-delete rollback removes exactly its contribution ----
{
    const h = { teamSports: {}, matchupHistory: {}, gamesPerDate: {}, gameLog: {} };
    genDay('L', '2026-06-26', [{ t1: '1', t2: '3', sport: 'Gaga' }, { t1: '2', t2: '4', sport: 'Hockey' }], h);
    genDay('L', '2026-06-27', [{ t1: '1', t2: '4', sport: 'Gaga' }], h);
    rollbackDayRecords('L', '2026-06-26', h);
    assert.deepStrictEqual(h.teamSports['L|1'], ['Gaga'], 'only 06-27 Gaga remains for team 1');
    assert.deepStrictEqual(h.teamSports['L|2'], [], 'team 2 emptied');
    assert.strictEqual(h.matchupHistory['L:1|3'], undefined, 'deleted matchup gone');
    assert.strictEqual(h.matchupHistory['L:1|4'], 1, '06-27 matchup intact');
    console.log('TEST 4 PASS — date-delete subtracts exactly its games');
}

// ---- Test 5: rollback with sport missing from aggregate (corrupt/manual edit) is safe ----
{
    const h = { teamSports: { 'L|1': [] }, matchupHistory: {}, gamesPerDate: {}, gameLog: { L: { '2026-06-26': [{ t1: '1', t2: '3', sport: 'Gaga' }] } } };
    rollbackDayRecords('L', '2026-06-26', h); // must not throw
    assert.deepStrictEqual(h.teamSports['L|1'], []);
    assert.strictEqual(h.matchupHistory['L:1|3'], undefined);
    console.log('TEST 5 PASS — rollback resilient to missing aggregate entries');
}

console.log('\nALL 5 SIMULATION TESTS PASS');
