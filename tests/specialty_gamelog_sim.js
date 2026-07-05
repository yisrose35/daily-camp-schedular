/* FN-55 logic simulation — specialty league gameLog rollback.
 * Replicates updateHistoryAfterScheduling / rollbackDayRecords exactly as
 * written in scheduler_core_specialty_leagues.js and proves:
 *   1. regen same date N times → aggregates identical to single gen
 *      (teamFieldRotation arrays and matchupHistory date-arrays don't inflate)
 *   2. rollback of a date removes exactly its contribution (other dates kept,
 *      including a same-pair game on another date)
 *   3. legacy entries (no gameLog) are untouched (no over-subtraction)
 *   4. multiple games per date (same pair twice) roll back fully
 */
'use strict';
const assert = require('assert');

function updateHistory(id, assignments, history, currentDate, gameLabel) {
    if (!history.gameLog) history.gameLog = {};
    if (!history.gameLog[id]) history.gameLog[id] = {};
    if (!history.gameLog[id][currentDate]) history.gameLog[id][currentDate] = [];
    assignments.forEach(game => {
        const keyA = `${id}|${game.teamA}`;
        const keyB = `${id}|${game.teamB}`;
        if (!history.teamFieldRotation[keyA]) history.teamFieldRotation[keyA] = [];
        if (!history.teamFieldRotation[keyB]) history.teamFieldRotation[keyB] = [];
        history.teamFieldRotation[keyA].push(game.field);
        history.teamFieldRotation[keyB].push(game.field);
        history.lastSlotOrder[keyA] = game.slotOrder;
        history.lastSlotOrder[keyB] = game.slotOrder;
        const fullKey = `${id}|${[game.teamA, game.teamB].sort().join('|')}`;
        if (!history.matchupHistory[fullKey]) history.matchupHistory[fullKey] = [];
        history.matchupHistory[fullKey].push(currentDate);
        history.gameLog[id][currentDate].push({ tA: game.teamA, tB: game.teamB, field: game.field, g: gameLabel || null });
    });
}

function rollbackDayRecords(leagueId, date, history) {
    const entries = history.gameLog?.[leagueId]?.[date];
    if (!entries || !entries.length) return 0;
    entries.forEach(e => {
        if (e.field) {
            [e.tA, e.tB].forEach(team => {
                if (!team) return;
                const arr = history.teamFieldRotation[`${leagueId}|${team}`];
                if (!arr) return;
                const idx = arr.lastIndexOf(e.field);
                if (idx !== -1) arr.splice(idx, 1);
            });
        }
        if (e.tA && e.tB) {
            const mk = `${leagueId}|${[e.tA, e.tB].sort().join('|')}`;
            const dates = history.matchupHistory[mk];
            if (Array.isArray(dates)) {
                const di = dates.indexOf(date);
                if (di !== -1) dates.splice(di, 1);
                if (dates.length === 0) delete history.matchupHistory[mk];
            }
        }
    });
    const n = entries.length;
    delete history.gameLog[leagueId][date];
    return n;
}

function freshHistory() {
    return { teamFieldRotation: {}, lastSlotOrder: {}, conferenceRounds: {}, matchupHistory: {}, gamesPerDate: {}, gameLog: {} };
}
function genDay(id, date, games, h, label) {
    rollbackDayRecords(id, date, h);
    if (h.gamesPerDate?.[id]?.[date] !== undefined) delete h.gamesPerDate[id][date];
    updateHistory(id, games, h, date, label);
    if (!h.gamesPerDate[id]) h.gamesPerDate[id] = {};
    if (games.length > 0) h.gamesPerDate[id][date] = 1;
}
const snap = h => JSON.stringify({ tfr: h.teamFieldRotation, mh: h.matchupHistory, gpd: h.gamesPerDate });

// ---- Test 1: regen idempotency ----
{
    const h = freshHistory();
    const day = [{ teamA: 'A', teamB: 'B', field: 'Court 1', slotOrder: 1 }, { teamA: 'C', teamB: 'D', field: 'Court 2', slotOrder: 1 }];
    genDay('sl1', '2026-06-27', day, h, 'X Game 1');
    const once = snap(h);
    for (let i = 0; i < 5; i++) genDay('sl1', '2026-06-27', day, h, 'X Game 1');
    assert.strictEqual(snap(h), once, 'regen x5 must equal single gen');
    assert.deepStrictEqual(h.teamFieldRotation['sl1|A'], ['Court 1']);
    assert.deepStrictEqual(h.matchupHistory['sl1|A|B'], ['2026-06-27']);
    console.log('TEST 1 PASS — regen x5 idempotent (no field/date inflation)');
}

// ---- Test 2: date rollback removes exactly its contribution ----
{
    const h = freshHistory();
    genDay('sl1', 'd1', [{ teamA: 'A', teamB: 'B', field: 'Court 1', slotOrder: 1 }], h, 'G1');
    genDay('sl1', 'd2', [{ teamA: 'A', teamB: 'B', field: 'Court 2', slotOrder: 1 }], h, 'G2');
    rollbackDayRecords('sl1', 'd1', h);
    assert.deepStrictEqual(h.teamFieldRotation['sl1|A'], ['Court 2'], 'd2 field kept');
    assert.deepStrictEqual(h.matchupHistory['sl1|A|B'], ['d2'], 'd2 date kept, d1 removed');
    console.log('TEST 2 PASS — delete subtracts exactly the date (same-pair other-date kept)');
}

// ---- Test 3: legacy (pre-fix) data never over-subtracted ----
{
    const h = freshHistory();
    h.teamFieldRotation['sl1|A'] = ['Court 1', 'Court 1'];
    h.matchupHistory['sl1|A|B'] = ['2026-05-01', '2026-05-02'];
    rollbackDayRecords('sl1', '2026-05-01', h); // no gameLog → no-op
    assert.strictEqual(h.teamFieldRotation['sl1|A'].length, 2);
    assert.strictEqual(h.matchupHistory['sl1|A|B'].length, 2);
    console.log('TEST 3 PASS — legacy data untouched by rollback');
}

// ---- Test 4: same pair twice on one date rolls back both ----
{
    const h = freshHistory();
    genDay('sl1', 'd', [
        { teamA: 'A', teamB: 'B', field: 'Court 1', slotOrder: 1 },
        { teamA: 'A', teamB: 'B', field: 'Court 1', slotOrder: 2 }
    ], h, 'G1');
    assert.strictEqual(h.teamFieldRotation['sl1|A'].length, 2);
    assert.strictEqual(h.matchupHistory['sl1|A|B'].length, 2);
    rollbackDayRecords('sl1', 'd', h);
    assert.strictEqual((h.teamFieldRotation['sl1|A'] || []).length, 0);
    assert.strictEqual(h.matchupHistory['sl1|A|B'], undefined);
    console.log('TEST 4 PASS — multi-game same pair fully rolled back');
}

console.log('\nALL 4 SPECIALTY ROLLBACK TESTS PASS');
