// =============================================================================
// league_chinuch_rotation_sim.js
// -----------------------------------------------------------------------------
// Chinuch × matchups hardening. Drives the REAL scheduler_core_leagues.js:
//
//   TEST 1 — chinuch attendance is recorded per (league, date) into the
//            cloud-synced history (chinuchByDate) and re-recorded
//            idempotently on regen (no duplicate/stale entries).
//   TEST 2 — rotation ledger: with a subset config (1 team/day of 4), teams
//            with FEWER past attendances are picked first — across 4 days
//            every team attends exactly once (the old pure-shuffle had no
//            memory and could pick the same team repeatedly).
//   TEST 3 — resetDayRecords / cleanupDateFromHistory roll the date's
//            attendance back.
//   TEST 4 — mergeLeagueHistories adopts chinuchByDate per (league, date)
//            from both lineages (union), tombstone-gated.
//   TEST 5 — LG-20: away (off-campus) double-header EXCLUDES the day's
//            chinuch teams from the pairing (no double-booking), renders
//            their chinuch line on the block, and the excluded teams never
//            appear in the day's matchups.
//   TEST 6 — LG-20 fallback: when excluding chinuch teams leaves < 4 teams,
//            chinuch yields for the day (chinuchSchedule entry cleared, no
//            attendance recorded, full roster plays).
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

function makeSupabaseStub() {
    return {
        from() {
            return {
                select() {
                    const q = { _k: null };
                    q.eq = function (col, v) { if (col === 'key') q._k = v; return q; };
                    q.maybeSingle = async function () {
                        return { data: cloudKV[q._k] !== undefined ? { value: cloudKV[q._k] } : null, error: null };
                    };
                    return q;
                },
                upsert: async function (row) { cloudKV[row.key] = row.value; return { error: null }; },
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
    divisionTimes: { Juniors: [{ startMin: 780, endMin: 840 }, { startMin: 840, endMin: 900 }] },
    addEventListener: () => {},
    CustomEvent: function CustomEvent(type, opts) { this.type = type; this.detail = (opts || {}).detail; },
    dispatchEvent: () => true,
    loadAllDailyData: () => ({}),
    getFieldsInZone: (z) => (z === 'Away Park' ? ['Away Field A', 'Away Field B'] : []),
};
global.document = { readyState: 'complete', addEventListener: () => {} };

const origLog = console.log;
console.log = () => {};
require('../scheduler_core_leagues.js');
console.log = origLog;
const Leagues = global.window.SchedulerCoreLeagues;
assert.ok(Leagues && typeof Leagues.processRegularLeagues === 'function', 'engine loaded');

const LG = 'Chinuch League';
const TEAMS = ['T1', 'T2', 'T3', 'T4'];
const FIELDS = [
    { name: 'Court 1', activities: ['Basketball'] },
    { name: 'Court 2', activities: ['Soccer'] },
    { name: 'Away Field A', activities: ['Basketball'] },
    { name: 'Away Field B', activities: ['Soccer'] },
];

function makeContext(leagueCfg, blocks) {
    return {
        schedulableSlotBlocks: blocks || [
            { type: 'league', event: 'League Time', divName: 'Juniors', leagueName: LG, startTime: 780, endTime: 840, slots: [0] },
        ],
        masterLeagues: { [LG]: Object.assign({
            name: LG, enabled: true, divisions: ['Juniors'], teams: TEAMS.slice(),
            sports: ['Basketball', 'Soccer'], schedulingPriority: 'matchup_variety',
        }, leagueCfg || {}) },
        disabledLeagues: [],
        divisions: { Juniors: { bunks: ['J1'] } },
        fillBlock: function (block, pick) { block._filled = true; block._pick = pick; },
        fieldUsageBySlot: {}, activityProperties: {}, rotationHistory: {},
        fields: FIELDS, disabledFields: [],
    };
}
function gen(date, leagueCfg, blocks) {
    global.window.currentScheduleDate = date;
    global.window._activeGenDate = date;
    const ctx = makeContext(leagueCfg, blocks);
    console.log = () => {};
    try { Leagues.processRegularLeagues(ctx); }
    finally { console.log = origLog; }
    return ctx;
}
const histNow = () => settings.leagueHistory || {};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {

// ---- TEST 1: attendance recorded per (league, date), regen-idempotent ------
{
    delete settings.leagueHistory; global.localStorage._m = {}; Object.keys(cloudKV).forEach(k => delete cloudKV[k]);
    gen('2026-07-01', { chinuch: { enabled: true, teamsPerRound: 2, timesPerDay: 1 } });
    let att = histNow().chinuchByDate?.[LG]?.['2026-07-01'];
    assert.ok(Array.isArray(att) && att.length === 2, 'two teams recorded at chinuch: ' + JSON.stringify(att));
    const first = att.slice().sort();
    // regen the same day — record replaced, not duplicated/stale
    gen('2026-07-01', { chinuch: { enabled: true, teamsPerRound: 2, timesPerDay: 1 } });
    att = histNow().chinuchByDate?.[LG]?.['2026-07-01'];
    assert.ok(Array.isArray(att) && att.length === 2, 'regen keeps exactly one record of 2 teams');
    assert.deepStrictEqual(att.slice().sort(), first, 'deterministic per-day pick (seeded)');
    console.log('✅ TEST 1 — chinuch attendance recorded per (league, date); regen idempotent');
}

// ---- TEST 2: rotation prefers least-attended across days --------------------
{
    delete settings.leagueHistory; global.localStorage._m = {};
    const cfg = { chinuch: { enabled: true, teamsPerRound: 1, timesPerDay: 1 } };
    const days = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-06'];
    days.forEach(d => gen(d, cfg));
    const cbd = histNow().chinuchByDate?.[LG] || {};
    const counts = {};
    TEAMS.forEach(t => counts[t] = 0);
    Object.values(cbd).forEach(arr => (arr || []).forEach(t => counts[t]++));
    TEAMS.forEach(t => assert.strictEqual(counts[t], 1,
        'every team attends exactly once over 4 days (ledger rotation): ' + JSON.stringify(counts)));
    console.log('✅ TEST 2 — subset chinuch rotates by attendance ledger: each of 4 teams attends once over 4 days');
}

// ---- TEST 3: deletes roll attendance back -----------------------------------
{
    delete settings.leagueHistory; global.localStorage._m = {};
    // resetDayRecords resolves league→divisions from the persisted config
    settings.leaguesByName = { [LG]: { name: LG, divisions: ['Juniors'], teams: TEAMS.slice() } };
    gen('2026-07-01', { chinuch: { enabled: true, teamsPerRound: 2, timesPerDay: 1 } });
    assert.ok(histNow().chinuchByDate[LG]['2026-07-01'], 'seeded');
    Leagues.resetDayRecords(['Juniors'], '2026-07-01');
    assert.ok(!histNow().chinuchByDate?.[LG]?.['2026-07-01'], 'resetDayRecords removed attendance');

    gen('2026-07-02', { chinuch: { enabled: true, teamsPerRound: 2, timesPerDay: 1 } });
    assert.ok(histNow().chinuchByDate[LG]['2026-07-02'], 'seeded day 2');
    Leagues.cleanupDateFromHistory('2026-07-02');
    assert.ok(!histNow().chinuchByDate?.[LG]?.['2026-07-02'], 'cleanupDateFromHistory removed attendance');
    console.log('✅ TEST 3 — day delete/reset rolls chinuch attendance back');
}

// ---- TEST 4: merge adopts chinuchByDate per (league, date) ------------------
{
    const mk = (savedAt, cbd) => ({
        teamSports: {}, matchupHistory: {}, gamesPerDate: {}, offCampusCounts: {},
        ocTripsByDate: {}, chinuchByDate: { [LG]: cbd }, gameLog: {}, _tombstones: {}, _savedAt: savedAt,
    });
    const A = mk(2000, { '2026-07-01': ['T1', 'T2'] });
    const B = mk(1000, { '2026-07-01': ['T3'], '2026-07-02': ['T3', 'T4'] });
    const m = Leagues.mergeLeagueHistories(A, B);
    assert.deepStrictEqual(m.chinuchByDate[LG]['2026-07-01'], ['T1', 'T2'], 'fresher copy wins the conflict day');
    assert.deepStrictEqual(m.chinuchByDate[LG]['2026-07-02'], ['T3', 'T4'], 'older lineage day adopted (union)');
    console.log('✅ TEST 4 — merge unions chinuch attendance per (league, date)');
}

// ---- TEST 5: away double-header excludes chinuch teams (LG-20) --------------
{
    delete settings.leagueHistory; global.localStorage._m = {};
    // 9 teams, 1 at chinuch → 8 active: 4 matchups, away group = 2 of them
    // (teamsPerDay 4) — the double-header pairing is fully feasible, so the
    // OC path MUST run without the chinuch team in any matchup, and its
    // chinuch line must show on the block.
    const teams9 = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9'];
    const cfg = {
        teams: teams9,
        chinuch: { enabled: true, teamsPerRound: 1, timesPerDay: 1, bunkFacilities: {} },
        offCampus: { enabled: true, zone: 'Away Park', teamsPerDay: 4 },
    };
    const blocks = [
        { type: 'league', event: 'League Time', divName: 'Juniors', leagueName: LG, startTime: 780, endTime: 840, slots: [0] },
        { type: 'league', event: 'League Time', divName: 'Juniors', leagueName: LG, startTime: 840, endTime: 900, slots: [1] },
    ];
    const ctx = gen('2026-07-08', cfg, blocks);
    const chTeam = (histNow().chinuchByDate?.[LG]?.['2026-07-08'] || [])[0];
    assert.ok(chTeam, 'one team recorded at chinuch');
    // The day ran through the OC path: both blocks filled with picks
    const picks = ctx.schedulableSlotBlocks.map(b => b._pick).filter(Boolean);
    assert.strictEqual(picks.length, 2, 'both paired periods produced league blocks');
    const allLines = picks.flatMap(p => p._allMatchups || []);
    const vsLines = allLines.filter(l => / vs /.test(l));
    assert.ok(vsLines.length > 0, 'games were placed');
    vsLines.forEach(l => assert.ok(l.indexOf(chTeam) < 0,
        'chinuch team "' + chTeam + '" must not appear in any matchup: ' + l));
    assert.ok(allLines.some(l => l.indexOf(chTeam + ' — Chinuch') === 0),
        'chinuch line rendered on the away-day block: ' + JSON.stringify(allLines));
    // and the day's gameLog contains no games for the chinuch team
    const logEntries = histNow().gameLog?.[LG]?.['2026-07-08'] || [];
    logEntries.forEach(e => {
        assert.ok(e.t1 !== chTeam && e.t2 !== chTeam, 'chinuch team not double-booked in gameLog');
    });
    console.log('✅ TEST 5 — away double-header excludes the chinuch team; chinuch line rendered; no double-booking');
}

// ---- TEST 6: too few teams → chinuch yields for the day ---------------------
{
    delete settings.leagueHistory; global.localStorage._m = {};
    // 4 teams, 1 at chinuch → 3 left (< 4): chinuch must yield, full roster plays.
    const cfg = {
        chinuch: { enabled: true, teamsPerRound: 1, timesPerDay: 1 },
        offCampus: { enabled: true, zone: 'Away Park', teamsPerDay: 2 },
    };
    const blocks = [
        { type: 'league', event: 'League Time', divName: 'Juniors', leagueName: LG, startTime: 780, endTime: 840, slots: [0] },
        { type: 'league', event: 'League Time', divName: 'Juniors', leagueName: LG, startTime: 840, endTime: 900, slots: [1] },
    ];
    const ctx = gen('2026-07-09', cfg, blocks);
    assert.ok(!global.window.chinuchSchedule[LG], 'chinuchSchedule entry cleared (chinuch yielded)');
    assert.ok(!histNow().chinuchByDate?.[LG]?.['2026-07-09'], 'no attendance recorded for the yielded day');
    const picks = ctx.schedulableSlotBlocks.map(b => b._pick).filter(Boolean);
    assert.strictEqual(picks.length, 2, 'double-header still ran with the full roster');
    const played = new Set();
    (histNow().gameLog?.[LG]?.['2026-07-09'] || []).forEach(e => { played.add(e.t1); played.add(e.t2); });
    assert.strictEqual(played.size, 4, 'all 4 teams played (no one benched by a phantom chinuch)');
    const byeNotice = (global.window.__leagueByeReport || []).find(b => /Chinuch was skipped/.test(b.reason || ''));
    assert.ok(byeNotice, 'the yield is surfaced in the bye/coverage report');
    console.log('✅ TEST 6 — infeasible chinuch on an away day yields loudly; full roster plays');
}

console.log('\n🎉 league_chinuch_rotation_sim: ALL TESTS PASSED');
process.exit(0);
})().catch(e => { console.error('❌ FAILED:', e); process.exit(1); });
