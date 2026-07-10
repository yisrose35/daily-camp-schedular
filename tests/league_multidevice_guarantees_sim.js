// =============================================================================
// league_multidevice_guarantees_sim.js
// -----------------------------------------------------------------------------
// ★ LG-8 end-to-end guarantees, driven against the REAL engines:
//
//   GUARANTEE 1 — users on different devices don't ruin each other:
//     TEST 1 — regular history: two devices generate DIFFERENT days against
//              the same cloud; both days end up in the cloud row (each push
//              read-merge-writes; neither clobbers the other).
//     TEST 2 — specialty history: mergeSpecialtyHistories unions divergent
//              lineages, fresher wins conflicts, derived stores (matchup date
//              arrays / field rotation / slotDebt) rebuilt from the merged log.
//     TEST 3 — specialty loadSpecialtyHistory merges cloud + local (the old
//              code let a non-empty cloud copy shadow local WHOLESALE).
//
//   GUARANTEE 2 — deleting a schedule deletes its matchups and sports:
//     TEST 4 — regular: cleanupDateFromHistory removes the date's gameLog,
//              matchup counts, team-sport entries and counters, stamps a
//              tombstone, and a STALE device copy cannot resurrect the day.
//     TEST 5 — specialty: same for matchup date-arrays, field rotation and
//              slotDebt via its cleanupDateFromHistory.
//
//   GUARANTEE 3 — regeneration ERASES the old league games and REPLACES them:
//     TEST 6 — regular: regenerate the same day with different fields — the
//              day's gameLog holds ONLY the new games (no stacking), matchup
//              counts don't inflate, and the pre-regen version cannot
//              resurrect via a stale copy (in-gen tombstone).
//     TEST 7 — regular: regenerating a day whose skeleton DROPPED the league
//              (generatedDivisions covers it) erases the day's games.
// =============================================================================

'use strict';
const assert = require('assert');

const cloudKV = {};
const settings = {};
global.localStorage = {
    _m: {},
    getItem(k) { return this._m[k] != null ? this._m[k] : null; },
    setItem(k, v) { this._m[k] = String(v); },
    removeItem(k) { delete this._m[k]; },
};
let upsertCalls = [];
function makeSupabaseStub() {
    return {
        from(table) {
            assert.strictEqual(table, 'camp_state_kv');
            return {
                select() {
                    const q = { _k: null };
                    q.eq = function (col, v) { if (col === 'key') q._k = v; return q; };
                    q.maybeSingle = async function () {
                        return { data: cloudKV[q._k] !== undefined ? { value: cloudKV[q._k] } : null, error: null };
                    };
                    return q;
                },
                upsert: async function (row) {
                    upsertCalls.push(row.key);
                    cloudKV[row.key] = row.value;
                    return { error: null };
                },
            };
        },
    };
}
global.window = {
    loadGlobalSettings: () => settings,
    saveGlobalSettings: (k, v) => { settings[k] = v; },
    supabase: makeSupabaseStub(),
    CampistryDB: { getCampId: () => 'camp-1' },
    __leagueHistoryPushRetryMs: 10,
    currentScheduleDate: null,
    divisionTimes: { Juniors: [{ startMin: 780, endMin: 840 }] },
    addEventListener: () => {},
    CustomEvent: function CustomEvent(type, opts) { this.type = type; this.detail = (opts || {}).detail; },
    dispatchEvent: () => true,
};
global.document = { readyState: 'complete', addEventListener: () => {} };

const origLog = console.log;
console.log = () => {};
require('../scheduler_core_leagues.js');
require('../scheduler_core_specialty_leagues.js');
console.log = origLog;
const Leagues = global.window.SchedulerCoreLeagues;
const Specialty = global.window.SchedulerCoreSpecialtyLeagues;
assert.ok(typeof Specialty.mergeSpecialtyHistories === 'function', 'specialty merge exported');
assert.ok(typeof Specialty.refreshHistoryFromCloud === 'function', 'specialty refresh exported');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const LG = 'Test League';
const TEAMS = ['Team 1', 'Team 2', 'Team 3', 'Team 4'];
const pairKey = (a, b) => [a, b].sort().join('|');
const FIELDS = [
    { name: 'BB Field', activities: ['Basketball'] },
    { name: 'SC Field', activities: ['Soccer'] },
];
const FIELDS_ALT = [
    { name: 'HK Field', activities: ['Hockey'] },
    { name: 'VB Field', activities: ['Volleyball'] },
];

function makeContext(fields) {
    return {
        schedulableSlotBlocks: [{ type: 'league', event: 'League Time', divName: 'Juniors', leagueName: LG, startTime: 780, endTime: 840, slots: [0] }],
        masterLeagues: { [LG]: { name: LG, enabled: true, divisions: ['Juniors'], teams: TEAMS, sports: [...new Set(fields.flatMap(f => f.activities))], schedulingPriority: 'matchup_variety' } },
        disabledLeagues: [],
        divisions: { Juniors: { bunks: ['J1'] } },
        fillBlock: function (block) { block._filled = true; },
        fieldUsageBySlot: {}, activityProperties: {}, rotationHistory: {},
        fields, disabledFields: [],
    };
}
function gen(date, fields, ctxExtra) {
    global.window.currentScheduleDate = date;
    global.window._activeGenDate = date;
    console.log = () => {};
    try { Leagues.processRegularLeagues(Object.assign(makeContext(fields), ctxExtra || {})); }
    finally { console.log = origLog; }
}
const histNow = () => settings.leagueHistory || {};
const wipeDevice = () => { delete settings.leagueHistory; global.localStorage._m = {}; };

(async () => {

// ---- TEST 1: two devices, different days, neither clobbers the other -------
{
    delete cloudKV.leagueHistory;
    // DEVICE A generates 07-01, pushes to cloud.
    wipeDevice();
    gen('2026-07-01', FIELDS);
    await sleep(120);
    assert.ok(cloudKV.leagueHistory.gameLog[LG]['2026-07-01'], 'device A day in cloud');

    // DEVICE B: fresh device, NEVER saw A's day locally (simulates the stale
    // in-memory copy), generates 07-02 and pushes.
    wipeDevice();
    gen('2026-07-02', FIELDS);
    await sleep(120);
    const row = cloudKV.leagueHistory;
    assert.ok(row.gameLog[LG]['2026-07-01'], "device B's push kept device A's day (read-merge-write)");
    assert.ok(row.gameLog[LG]['2026-07-02'], "device B's own day in cloud");
    // and the merged counters cover both days
    assert.strictEqual(row.gamesPerDate[LG]['2026-07-01'], 1);
    assert.strictEqual(row.gamesPerDate[LG]['2026-07-02'], 1);
    console.log('✅ TEST 1 — two devices, different days: cloud row holds BOTH (no clobber)');
}

// ---- TEST 2: specialty merge — union + rebuild of derived stores -----------
{
    const mk = (savedAt, log, counters) => ({
        teamFieldRotation: {}, lastSlotOrder: {}, conferenceRounds: {},
        matchupHistory: {}, gamesPerDate: { 7: counters || {} }, gameLog: { 7: log || {} },
        slotDebt: {}, _savedAt: savedAt,
    });
    const A = mk(2000, {
        '2026-07-01': [{ tA: 'X', tB: 'Y', field: 'Court 1', g: 'Game 1', s: 1 }],
        '2026-07-02': [{ tA: 'X', tB: 'Z', field: 'Court 2', g: 'Game 2', s: 2 }],
    }, { '2026-07-01': 1, '2026-07-02': 1 });
    const B = mk(1000, {
        '2026-07-01': [{ tA: 'X', tB: 'Y', field: 'Court 9', g: 'Game 1', s: 1 }],   // conflicting version
        '2026-07-03': [{ tA: 'Y', tB: 'Z', field: 'Court 3', g: 'Game 3', s: 1 }],   // only B knows
    }, {});
    const m = Specialty.mergeSpecialtyHistories(A, B);
    assert.deepStrictEqual(Object.keys(m.gameLog[7]).sort(), ['2026-07-01', '2026-07-02', '2026-07-03'], 'union of days');
    assert.strictEqual(m.gameLog[7]['2026-07-01'][0].field, 'Court 1', 'fresher copy wins the conflicting day');
    assert.strictEqual(m.gamesPerDate[7]['2026-07-03'], 1, 'missing counter healed from labels');
    assert.deepStrictEqual(m.matchupHistory['7|X|Y'], ['2026-07-01'], 'matchup date-arrays rebuilt from merged log');
    assert.deepStrictEqual(m.teamFieldRotation['7|X'], ['Court 1', 'Court 2'], 'field rotation rebuilt in date order');
    assert.strictEqual(m.slotDebt['7|X'], 1, 'slotDebt rebuilt from per-game slotOrder');
    console.log('✅ TEST 2 — specialty merge: union, fresher-wins, derived stores rebuilt');
}

// ---- TEST 3: specialty load merges cloud + local ----------------------------
{
    settings.specialtyLeagueHistory = {
        teamFieldRotation: {}, lastSlotOrder: {}, conferenceRounds: {}, matchupHistory: {},
        gamesPerDate: { 7: { '2026-07-01': 1 } },
        gameLog: { 7: { '2026-07-01': [{ tA: 'X', tB: 'Y', field: 'C1', g: 'Game 1', s: 1 }] } },
        _savedAt: 2000,
    };
    global.localStorage._m['campSpecialtyLeagueHistory_v1'] = JSON.stringify({
        teamFieldRotation: {}, lastSlotOrder: {}, conferenceRounds: {}, matchupHistory: {},
        gamesPerDate: { 7: { '2026-07-02': 1 } },
        gameLog: { 7: { '2026-07-02': [{ tA: 'X', tB: 'Z', field: 'C2', g: 'Game 2', s: 1 }] } },
        _savedAt: 1000,
    });
    console.log = () => {};
    const h = Specialty.getHistorySnapshot();
    console.log = origLog;
    assert.ok(h.gameLog[7]['2026-07-01'] && h.gameLog[7]['2026-07-02'],
        'specialty load returns the UNION of cloud and local days');
    delete settings.specialtyLeagueHistory;
    global.localStorage._m = {};
    console.log('✅ TEST 3 — specialty loadSpecialtyHistory merges instead of cloud-shadows-local');
}

// ---- TEST 4: regular — deleting a schedule deletes matchups AND sports -----
{
    delete cloudKV.leagueHistory;
    wipeDevice();
    gen('2026-07-01', FIELDS);
    gen('2026-07-02', FIELDS);
    await sleep(120);
    const before = histNow();
    const d1Games = before.gameLog[LG]['2026-07-01'];
    assert.ok(d1Games && d1Games.length === 2, 'seed: two games on 07-01');
    const preSports = (before.teamSports[`${LG}|Team 1`] || []).length;
    assert.ok(preSports >= 2, 'seed: Team 1 has sport entries from both days');
    const staleCopy = JSON.parse(JSON.stringify(before));   // another device's copy, pre-delete

    console.log = () => {};
    Leagues.cleanupDateFromHistory('2026-07-01');
    console.log = origLog;
    await sleep(120);
    const after = histNow();
    assert.ok(!after.gameLog[LG] || !after.gameLog[LG]['2026-07-01'], 'matchups (gameLog) deleted');
    assert.strictEqual(after.gamesPerDate[LG]['2026-07-01'], undefined, 'counter deleted');
    assert.strictEqual((after.teamSports[`${LG}|Team 1`] || []).length, preSports - 1, 'sport entry subtracted');
    d1Games.forEach(g => {
        const mk = `${LG}:${pairKey(g.t1, g.t2)}`;
        assert.ok((after.matchupHistory[mk] || 0) < 2, 'matchup count subtracted for ' + mk);
    });
    // Stale device copy (saved before the delete) cannot bring the day back.
    const merged = Leagues.mergeLeagueHistories(after, staleCopy);
    assert.ok(!merged.gameLog[LG] || !merged.gameLog[LG]['2026-07-01'], 'tombstone: stale copy cannot resurrect the deleted day');
    // Cloud row reflects the deletion (verified push ran).
    assert.ok(!cloudKV.leagueHistory.gameLog[LG] || !cloudKV.leagueHistory.gameLog[LG]['2026-07-01'], 'deletion reached the cloud row');
    console.log('✅ TEST 4 — regular delete: matchups + sports + counters gone, tombstoned, synced');
}

// ---- TEST 5: specialty — delete removes matchups, rotation, slotDebt -------
{
    settings.specialtyLeagueHistory = {
        teamFieldRotation: { '7|X': ['C1', 'C2'], '7|Y': ['C1'] },
        lastSlotOrder: {}, conferenceRounds: {},
        matchupHistory: { '7|X|Y': ['2026-07-01'], '7|X|Z': ['2026-07-02'] },
        gamesPerDate: { 7: { '2026-07-01': 1, '2026-07-02': 1 } },
        gameLog: {
            7: {
                '2026-07-01': [{ tA: 'X', tB: 'Y', field: 'C1', g: 'Game 1', s: 2 }],
                '2026-07-02': [{ tA: 'X', tB: 'Z', field: 'C2', g: 'Game 2', s: 1 }],
            },
        },
        slotDebt: { '7|X': 1, '7|Y': 1 },
        _savedAt: 1000,
    };
    global.localStorage._m = {};
    const staleCopy = JSON.parse(JSON.stringify(settings.specialtyLeagueHistory));
    console.log = () => {};
    Specialty.cleanupDateFromHistory('2026-07-01');
    console.log = origLog;
    await sleep(120);
    const after = settings.specialtyLeagueHistory;
    assert.ok(!after.gameLog[7]['2026-07-01'], 'specialty gameLog date deleted');
    assert.strictEqual(after.matchupHistory['7|X|Y'], undefined, 'matchup date-array emptied and removed');
    assert.deepStrictEqual(after.teamFieldRotation['7|X'], ['C2'], 'field rotation entry subtracted');
    assert.strictEqual(after.slotDebt['7|X'], 0, 'slotDebt subtracted');
    assert.strictEqual(after.gamesPerDate[7]['2026-07-01'], undefined, 'counter deleted');
    const merged = Specialty.mergeSpecialtyHistories(after, staleCopy);
    assert.ok(!merged.gameLog[7] || !merged.gameLog[7]['2026-07-01'], 'tombstone: stale copy cannot resurrect');
    assert.ok(cloudKV.specialtyLeagueHistory, 'specialty deletion pushed to cloud (verified)');
    delete settings.specialtyLeagueHistory;
    global.localStorage._m = {};
    console.log('✅ TEST 5 — specialty delete: matchups + rotation + slotDebt gone, tombstoned, synced');
}

// ---- TEST 6: regeneration ERASES the old games and REPLACES them -----------
{
    delete cloudKV.leagueHistory;
    wipeDevice();
    gen('2026-07-01', FIELDS);
    const v1 = JSON.parse(JSON.stringify(histNow().gameLog[LG]['2026-07-01']));
    assert.strictEqual(v1.length, 2, 'first generation: 2 games');
    const preRegenCopy = JSON.parse(JSON.stringify(histNow()));   // stale device snapshot

    // Regenerate the SAME day with different fields/sports.
    gen('2026-07-01', FIELDS_ALT);
    await sleep(120);
    const v2 = histNow().gameLog[LG]['2026-07-01'];
    assert.strictEqual(v2.length, 2, 'regen: still exactly 2 games (no stacking)');
    v2.forEach(g => assert.ok(['Hockey', 'Volleyball'].includes(g.sport), 'regen games are the NEW games'));
    // matchup counts reflect ONE meeting per pair, not two
    Object.values(histNow().matchupHistory).forEach(c => assert.strictEqual(c, 1, 'no double-counted matchups after regen'));
    assert.strictEqual(histNow().gamesPerDate[LG]['2026-07-01'], 1, 'counter replaced, not stacked');
    // A stale copy carrying the PRE-regen games loses to the in-gen tombstone + fresher save.
    const merged = Leagues.mergeLeagueHistories(histNow(), preRegenCopy);
    const sports = merged.gameLog[LG]['2026-07-01'].map(g => g.sport).sort();
    sports.forEach(s => assert.ok(['Hockey', 'Volleyball'].includes(s), 'merge keeps the REGENERATED day, not the stale one'));
    assert.strictEqual(merged.gameLog[LG]['2026-07-01'].length, 2, 'merged day holds only the new games');
    // Cloud row has the new version.
    const cloudSports = cloudKV.leagueHistory.gameLog[LG]['2026-07-01'].map(g => g.sport);
    cloudSports.forEach(s => assert.ok(['Hockey', 'Volleyball'].includes(s), 'cloud row holds the regenerated games'));
    console.log('✅ TEST 6 — regen: old games erased, new games replace them, everywhere (local, merge, cloud)');
}

// ---- TEST 7: regen with the league REMOVED from the skeleton erases the day ----
{
    delete cloudKV.leagueHistory;
    wipeDevice();
    gen('2026-07-01', FIELDS);
    assert.ok(histNow().gameLog[LG]['2026-07-01'], 'seed: day has games');
    // Regen the same day with NO league blocks, but generatedDivisions covers
    // the league's division (the skeleton dropped the league tile).
    global.window.currentScheduleDate = '2026-07-01';
    global.window._activeGenDate = '2026-07-01';
    console.log = () => {};
    Leagues.processRegularLeagues({
        schedulableSlotBlocks: [],
        masterLeagues: { [LG]: { name: LG, enabled: true, divisions: ['Juniors'], teams: TEAMS, sports: ['Basketball', 'Soccer'], schedulingPriority: 'matchup_variety' } },
        disabledLeagues: [], divisions: { Juniors: { bunks: ['J1'] } },
        fillBlock: null, fieldUsageBySlot: {}, activityProperties: {},
        generatedDivisions: ['Juniors'],
    });
    console.log = origLog;
    await sleep(120);
    assert.ok(!histNow().gameLog[LG] || !histNow().gameLog[LG]['2026-07-01'], 'league dropped from skeleton → day\'s games erased');
    assert.strictEqual(histNow().gamesPerDate[LG]?.['2026-07-01'], undefined, 'counter erased too');
    console.log('✅ TEST 7 — regen without the league tile erases the day\'s league history');
}

console.log('\n🎉 league_multidevice_guarantees_sim: ALL TESTS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
