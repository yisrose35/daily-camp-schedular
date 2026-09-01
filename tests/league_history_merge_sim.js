// =============================================================================
// league_history_merge_sim.js
// -----------------------------------------------------------------------------
// ★ LG-8: league history cloud tightening. leagueHistory used to be resolved
// WHOLESALE (fresher _savedAt wins, other copy discarded) and synced only via
// the debounced, role-gated camp_state_kv batch. With two writers the copies
// diverged into lineages and every load flapped between them — observed live:
// a cloud lineage with full game counters and no ghost dates vs a local
// lineage with ghost future dates and wiped counters; generations were blind
// to whichever lineage lost, restaging identical matchups and resetting the
// game counter to "Game 1".
//
// Drives the REAL scheduler_core_leagues.js module and proves:
//   TEST 1 — divergent lineages MERGE at (league,date) granularity: union of
//            dates, fresher copy wins conflicts, aggregates rebuilt from the
//            merged log, missing per-date counters healed from game labels.
//   TEST 2 — loadLeagueHistory returns the merged union when cloud and local
//            both exist (no more wholesale fresher-wins).
//   TEST 3 — tombstones: cleanupDateFromHistory kills a date across leagues
//            and a STALE copy cannot resurrect it in a later merge; a copy
//            saved AFTER the tombstone (regenerated day) survives.
//   TEST 4 — pure-legacy league (aggregates, no gameLog) keeps its aggregates
//            through a merge.
//   TEST 5 — direct verified cloud push: saveLeagueHistory upserts the
//            camp_state_kv row immediately (read-merge-write), retries on
//            transient failure, and merges concurrent cloud days in.
//   TEST 6 — generation end-to-end: processRegularLeagues triggers the direct
//            push and the pushed value contains the day's games.
// =============================================================================

'use strict';
const assert = require('assert');

const cloudKV = {};        // simulated camp_state_kv: key -> value
const settings = {};       // simulated hydrated globalSettings
global.localStorage = {
    _m: {},
    getItem(k) { return this._m[k] != null ? this._m[k] : null; },
    setItem(k, v) { this._m[k] = String(v); },
    removeItem(k) { delete this._m[k]; },
};

// --- supabase stub: from('camp_state_kv').select/upsert against cloudKV ----
let upsertCalls = [];
let failUpserts = 0;       // fail the next N upserts (transient error sim)
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
                    upsertCalls.push(JSON.parse(JSON.stringify(row)));
                    if (failUpserts > 0) { failUpserts--; return { error: { code: '500', message: 'transient' } }; }
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
    __leagueHistoryPushRetryMs: 10,   // fast retries in tests
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
console.log = origLog;
const Leagues = global.window.SchedulerCoreLeagues;
assert.ok(Leagues && typeof Leagues.mergeLeagueHistories === 'function', 'module + merge exported');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const LG = 'Day Camp League';

function mkHistory(savedAt, gameLogByDate, counters, extra) {
    const h = {
        teamSports: {}, matchupHistory: {},
        gamesPerDate: { [LG]: counters || {} },
        offCampusCounts: {}, gameLog: { [LG]: gameLogByDate || {} },
        _savedAt: savedAt,
    };
    return Object.assign(h, extra || {});
}
const rec = (t1, t2, sport, g) => ({ t1, t2, sport, g });

// ---- TEST 1: divergent lineages merge (mirrors the live cloud/local dump) ----
{
    // CLOUD lineage (fresher): days 1-3 with counters, no ghosts.
    const cloud = mkHistory(2000,
        {
            '2026-07-01': [rec('1', '2', 'Soccer', 'Game 1')],
            '2026-07-02': [rec('3', '4', 'Hockey', 'Game 2')],
            '2026-07-03': [rec('5', '6', 'Baseball', 'Game 3')],
        },
        { '2026-07-01': 1, '2026-07-02': 1, '2026-07-03': 1 });
    // LOCAL lineage (older): same days 1-2 PLUS a day cloud never saw (ghost
    // or unsynced), and its counters were wiped (the live "Game 1" reset).
    const local = mkHistory(1000,
        {
            '2026-07-01': [rec('1', '2', 'Soccer', 'Game 1')],
            '2026-07-02': [rec('3', '4', 'Volleyball', 'Game 2')],   // conflicting version
            '2026-07-04': [rec('4', '6', 'Basketball', 'Game 4')],   // only local knows
        },
        {});                                                          // counters wiped

    const m = Leagues.mergeLeagueHistories(cloud, local);
    // union of dates
    assert.deepStrictEqual(Object.keys(m.gameLog[LG]).sort(),
        ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04'],
        'merged gameLog is the union of both lineages');
    // conflict: fresher (cloud) version of 07-02 wins
    assert.strictEqual(m.gameLog[LG]['2026-07-02'][0].sport, 'Hockey', 'fresher copy wins a conflicting day');
    // counters: cloud's kept, 07-04 healed from its game label
    assert.strictEqual(m.gamesPerDate[LG]['2026-07-03'], 1);
    assert.strictEqual(m.gamesPerDate[LG]['2026-07-04'], 1, 'missing counter healed from the day\'s game labels');
    // aggregates rebuilt from merged log
    assert.strictEqual(m.matchupHistory[`${LG}:4|6`], 1, 'aggregates rebuilt from merged log');
    assert.deepStrictEqual(m.teamSports[`${LG}|4`], ['Hockey', 'Basketball'], 'team sports rebuilt in date order');
    console.log('✅ TEST 1 — divergent lineages merge: union of days, fresher wins conflicts, counters healed');
}

// ---- TEST 2: loadLeagueHistory merges cloud + local instead of picking one ----
{
    settings.leagueHistory = mkHistory(2000, { '2026-07-01': [rec('1', '2', 'Soccer', 'Game 1')] }, { '2026-07-01': 1 });
    global.localStorage._m['campLeagueHistory_v2'] = JSON.stringify(
        mkHistory(1000, { '2026-07-02': [rec('3', '4', 'Hockey', 'Game 2')] }, { '2026-07-02': 1 }));
    console.log = () => {};
    const h = Leagues.getHistorySnapshot();
    console.log = origLog;
    assert.ok(h.gameLog[LG]['2026-07-01'] && h.gameLog[LG]['2026-07-02'],
        'loadLeagueHistory returns the UNION of cloud and local days');
    delete settings.leagueHistory;
    global.localStorage._m = {};
    console.log('✅ TEST 2 — loadLeagueHistory merges instead of wholesale fresher-wins');
}

(async () => {

// ---- TEST 3: tombstones — deleted date stays deleted; regen survives ----
{
    // Seed one copy with two days, load-modify-save through the real cleanup.
    settings.leagueHistory = mkHistory(1000, {
        '2026-07-01': [rec('1', '2', 'Soccer', 'Game 1')],
        '2026-07-02': [rec('3', '4', 'Hockey', 'Game 2')],
    }, { '2026-07-01': 1, '2026-07-02': 1 });
    global.localStorage._m = {};
    console.log = () => {};
    Leagues.cleanupDateFromHistory('2026-07-02');
    console.log = origLog;
    await sleep(100);   // let this save's direct push settle before later tests
    const afterDelete = settings.leagueHistory;
    assert.ok(!afterDelete.gameLog[LG]['2026-07-02'], 'date deleted locally');
    assert.ok(afterDelete._tombstones['*|2026-07-02'] > 0, 'tombstone stamped');

    // A STALE copy (saved before the delete) still carries the date — the
    // merge must NOT resurrect it.
    const stale = mkHistory(500, { '2026-07-02': [rec('3', '4', 'Hockey', 'Game 2')] }, { '2026-07-02': 1 });
    const m1 = Leagues.mergeLeagueHistories(afterDelete, stale);
    assert.ok(!m1.gameLog[LG] || !m1.gameLog[LG]['2026-07-02'], 'stale copy cannot resurrect a deleted date');
    assert.strictEqual(m1.gamesPerDate[LG]['2026-07-02'], undefined, 'counter stays deleted too');

    // A copy saved AFTER the tombstone (the day was regenerated) survives.
    const regen = mkHistory(Date.now() + 60000, { '2026-07-02': [rec('5', '6', 'Baseball', 'Game 2')] }, { '2026-07-02': 1 });
    const m2 = Leagues.mergeLeagueHistories(afterDelete, regen);
    assert.strictEqual(m2.gameLog[LG]['2026-07-02'][0].sport, 'Baseball', 'a regen after the delete survives the merge');
    delete settings.leagueHistory;
    global.localStorage._m = {};
    console.log('✅ TEST 3 — tombstones: deletes stick across merges, regens after the delete survive');
}

// ---- TEST 4: pure-legacy league keeps aggregates through a merge ----
{
    const a = mkHistory(2000, { '2026-07-01': [rec('1', '2', 'Soccer', 'Game 1')] }, { '2026-07-01': 1 });
    a.teamSports['Legacy League|T1'] = ['Hockey', 'Soccer'];
    a.matchupHistory['Legacy League:T1|T2'] = 3;
    const b = mkHistory(1000, {}, {});
    const m = Leagues.mergeLeagueHistories(a, b);
    assert.deepStrictEqual(m.teamSports['Legacy League|T1'], ['Hockey', 'Soccer'], 'legacy teamSports kept');
    assert.strictEqual(m.matchupHistory['Legacy League:T1|T2'], 3, 'legacy matchup counts kept');
    console.log('✅ TEST 4 — pure-legacy league aggregates survive the rebuild');
}

// ---- TEST 5: direct verified cloud push with retry + read-merge-write ----
{
    // Another device already pushed a day we don't have.
    cloudKV['leagueHistory'] = mkHistory(500, { '2026-07-05': [rec('1', '3', 'Kickball', 'Game 9')] }, { '2026-07-05': 1 });
    upsertCalls = [];
    failUpserts = 2;   // two transient failures → third attempt succeeds

    // saveLeagueHistory is module-private; drive it through cleanupDateFromHistory
    // on a seeded copy (any mutation path that saves works).
    settings.leagueHistory = mkHistory(1000, {
        '2026-07-01': [rec('1', '2', 'Soccer', 'Game 1')],
        '2026-07-06': [rec('4', '6', 'Football', 'Game 10')],
    }, { '2026-07-01': 1, '2026-07-06': 1 });
    console.log = () => {};
    Leagues.cleanupDateFromHistory('2026-07-01');
    console.log = origLog;

    await sleep(300);   // let the retries (10ms base) play out
    assert.strictEqual(upsertCalls.length, 3, 'two transient failures then a success = 3 upsert attempts');
    const pushed = cloudKV['leagueHistory'];
    assert.ok(pushed.gameLog[LG]['2026-07-06'], 'our day reached the cloud');
    assert.ok(pushed.gameLog[LG]['2026-07-05'], 'the OTHER device\'s day was merged in, not clobbered');
    assert.ok(!pushed.gameLog[LG]['2026-07-01'], 'our deletion applied');
    assert.ok(pushed._tombstones['*|2026-07-01'] > 0, 'tombstone travelled to the cloud');
    console.log('✅ TEST 5 — direct push: retried past transient failures, read-merge-write kept the other writer\'s day');
}

// ---- TEST 7: clearAllGamesPerDate survives merges (numbering stays reset) ----
{
    settings.leagueHistory = mkHistory(1000, {
        '2026-07-01': [rec('1', '2', 'Soccer', 'Game 1')],
        '2026-07-02': [rec('3', '4', 'Hockey', 'Game 2')],
    }, { '2026-07-01': 1, '2026-07-02': 1 });
    global.localStorage._m = {};
    console.log = () => {};
    Leagues.clearAllGamesPerDate();
    console.log = origLog;
    await sleep(100);
    const wiped = settings.leagueHistory;
    assert.ok(wiped._countersResetAt > 0, 'counter-reset marker stamped');
    assert.deepStrictEqual(wiped.gamesPerDate[LG], {}, 'counters wiped');

    // A stale copy still carrying the old counters must not resurrect them,
    // and healing must not rebuild them from the retained gameLog.
    const stale = mkHistory(500, {
        '2026-07-01': [rec('1', '2', 'Soccer', 'Game 1')],
    }, { '2026-07-01': 1, '2026-07-02': 1 });
    const m = Leagues.mergeLeagueHistories(wiped, stale);
    assert.strictEqual(m.gamesPerDate[LG]['2026-07-01'], undefined, 'stale counters stay wiped after merge');
    assert.strictEqual(m.gamesPerDate[LG]['2026-07-02'], undefined, 'healing skips pre-wipe days');
    assert.ok(m.gameLog[LG]['2026-07-01'], 'fairness gameLog is kept (by design)');

    // A day generated AFTER the wipe (its counter recorded normally by
    // recordGamesOnDate) keeps its counter through the merge.
    const post = mkHistory(Date.now() + 60000, { '2026-07-05': [rec('5', '6', 'Baseball', 'Game 1')] }, { '2026-07-05': 1 });
    const m2 = Leagues.mergeLeagueHistories(wiped, post);
    assert.strictEqual(m2.gamesPerDate[LG]['2026-07-05'], 1, 'post-wipe day keeps its counter');
    delete settings.leagueHistory;
    global.localStorage._m = {};
    console.log('✅ TEST 7 — erase-all counter wipe sticks across merges; post-wipe days still count');
}

// ---- TEST 6: generation end-to-end triggers the verified push ----
{
    delete settings.leagueHistory;
    global.localStorage._m = {};
    delete cloudKV['leagueHistory'];
    upsertCalls = []; failUpserts = 0;
    const TEAMS = ['Team 1', 'Team 2', 'Team 3', 'Team 4'];
    global.window.currentScheduleDate = '2026-07-09';
    global.window._activeGenDate = '2026-07-09';
    const fields = [
        { name: 'BB Field', activities: ['Basketball'] },
        { name: 'SC Field', activities: ['Soccer'] },
    ];
    console.log = () => {};
    Leagues.processRegularLeagues({
        schedulableSlotBlocks: [{ type: 'league', event: 'League Time', divName: 'Juniors', leagueName: 'E2E League', startTime: 780, endTime: 840, slots: [0] }],
        masterLeagues: { 'E2E League': { name: 'E2E League', enabled: true, divisions: ['Juniors'], teams: TEAMS, sports: ['Basketball', 'Soccer'], schedulingPriority: 'matchup_variety' } },
        disabledLeagues: [],
        divisions: { Juniors: { bunks: ['J1'] } },
        fillBlock: function (block) { block._filled = true; },
        fieldUsageBySlot: {}, activityProperties: {}, rotationHistory: {},
        fields, disabledFields: [],
    });
    console.log = origLog;
    await sleep(150);
    assert.ok(upsertCalls.length >= 1, 'generation triggered a direct cloud push');
    const row = cloudKV['leagueHistory'];
    assert.ok(row && row.gameLog['E2E League'] && row.gameLog['E2E League']['2026-07-09'],
        'the generated day\'s games are IN the cloud row immediately (no debounce window)');
    assert.strictEqual(row.gameLog['E2E League']['2026-07-09'].length, 2, 'both matchups pushed');
    console.log('✅ TEST 6 — generation pushes the day\'s games to the cloud row immediately, verified');
}

console.log('\n🎉 league_history_merge_sim: ALL TESTS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
