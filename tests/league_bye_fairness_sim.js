// =============================================================================
// league_bye_fairness_sim.js
// -----------------------------------------------------------------------------
// LG-14: with an odd team count somebody is benched every round, and nothing
// tracked WHO. Both pairing choosers scored a bye pair as zero, so at every
// score tie the deterministic enumeration handed the bye to the same team —
// the last in the roster — day after day. Drives the REAL engine:
//
//   TEST 1 — ledger: counts periods sat out from the gameLog, ignores chinuch
//            sessions, and reports each team's distance from the least-benched.
//   TEST 2 — 5 teams / 2 fields, matchup_variety, 10 days: every team gets
//            byes, and no team is benched more than one more time than any
//            other. (Before the fix one team took every single bye.)
//   TEST 3 — same for sport_variety, the mode the audit called out by name.
//   TEST 4 — two league periods in ONE day bench two DIFFERENT teams.
//   TEST 5 — killswitch: window.__leagueByeFairness = false restores the old
//            behavior, so the fix can be turned off in the field.
//   TEST 6 — a team pulled for chinuch is not treated as having been benched,
//            so chinuch rotation and bye rotation don't fight each other.
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
    getFieldsInZone: () => [],
};
global.document = { readyState: 'complete', addEventListener: () => {} };

const origLog = console.log;
const origWarn = console.warn;
console.log = () => {};
require('../scheduler_core_leagues.js');
console.log = origLog;
const Leagues = global.window.SchedulerCoreLeagues;
assert.ok(Leagues && typeof Leagues.processRegularLeagues === 'function', 'engine loaded');
assert.ok(typeof Leagues.makeByeLedger === 'function', 'makeByeLedger exported');

const LG = 'Bye Fairness League';
// Five teams, two fields → two games, one team benched. The reported shape.
const TEAMS = ['T1', 'T2', 'T3', 'T4', 'T5'];
const FIELDS = [
    { name: 'Court 1', activities: ['Basketball'] },
    { name: 'Court 2', activities: ['Soccer'] },
];
const DAYS = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-06', '2026-07-07',
              '2026-07-08', '2026-07-09', '2026-07-10', '2026-07-13', '2026-07-14'];

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
    console.log = () => {}; console.warn = () => {};
    try { Leagues.processRegularLeagues(ctx); }
    finally { console.log = origLog; console.warn = origWarn; }
    return ctx;
}
// Who sat out each period, read off the tiles the engine actually wrote.
function byeTeams(ctx) {
    return ctx.schedulableSlotBlocks
        .map(b => b._pick).filter(Boolean)
        .flatMap(p => (p._allMatchups || []).filter(l => /—\s*Bye/i.test(l)))
        .map(l => l.split(' — ')[0]);
}
function runSeason(cfg, days) {
    delete settings.leagueHistory; global.localStorage._m = {};
    const tally = {}; TEAMS.forEach(t => tally[t] = 0);
    (days || DAYS).forEach(d => byeTeams(gen(d, cfg)).forEach(t => { tally[t] = (tally[t] || 0) + 1; }));
    return tally;
}
function spread(tally) {
    const v = Object.values(tally);
    return Math.max.apply(null, v) - Math.min.apply(null, v);
}

(async () => {

// ---- TEST 1: the ledger itself ---------------------------------------------
{
    const hist = {
        gameLog: { [LG]: {
            // One period. T1 vs T2 and T3 vs T4 played; T5 sat out.
            '2026-07-01': [
                { t1: 'T1', t2: 'T2', sport: 'Basketball', g: 'Game 1' },
                { t1: 'T3', t2: 'T4', sport: 'Soccer', g: 'Game 1' },
            ],
            // Two periods on one day. T5 played both; T1 sat out both.
            '2026-07-02': [
                { t1: 'T5', t2: 'T2', sport: 'Basketball', g: 'Game 2' },
                { t1: 'T3', t2: 'T4', sport: 'Soccer', g: 'Game 2' },
                { t1: 'T5', t2: 'T3', sport: 'Basketball', g: 'Game 3' },
                { t1: 'T2', t2: 'T4', sport: 'Soccer', g: 'Game 3' },
            ],
        } },
        chinuchByDate: {},
    };
    const led = Leagues.makeByeLedger(LG, TEAMS, hist);
    assert.strictEqual(led.count('T1'), 2, 'T1 sat out both periods on day 2: ' + JSON.stringify(led.counts));
    assert.strictEqual(led.count('T5'), 1, 'T5 sat out day 1 only');
    assert.strictEqual(led.count('T2'), 0, 'T2 played every period');
    assert.strictEqual(led.excess('T2'), 0, 'the least-benched team is the one whose turn it is');
    assert.strictEqual(led.excess('T1'), 2, 'two steps ahead of the least-benched');

    // Chinuch is not a bye — the team was pulled deliberately.
    const hist2 = { gameLog: hist.gameLog, chinuchByDate: { [LG]: { '2026-07-01': ['T5'] } } };
    assert.strictEqual(Leagues.makeByeLedger(LG, TEAMS, hist2).count('T5'), 0,
        'a chinuch session does not count against the bye rotation');

    // A long-idle team is clamped so it can never outrank the rematch guards.
    const hist3 = { gameLog: { [LG]: {} }, chinuchByDate: {} };
    for (let i = 1; i <= 9; i++) {
        hist3.gameLog[LG]['2026-08-0' + i] = [{ t1: 'T1', t2: 'T2', sport: 'Basketball', g: 'Game ' + i }];
    }
    assert.strictEqual(Leagues.makeByeLedger(LG, TEAMS, hist3).excess('T5'), 4, 'excess is clamped at 4');
    console.log('✅ TEST 1 — ledger counts sat-out periods, ignores chinuch, clamps the excess');
}

// ---- TEST 2: matchup_variety over a 10-day season ---------------------------
{
    const tally = runSeason({ schedulingPriority: 'matchup_variety' });
    const total = Object.values(tally).reduce((a, b) => a + b, 0);
    assert.strictEqual(total, DAYS.length, 'exactly one bye per day: ' + JSON.stringify(tally));
    TEAMS.forEach(t => assert.ok(tally[t] > 0, t + ' never got a bye — the rotation skipped it: ' + JSON.stringify(tally)));
    assert.ok(spread(tally) <= 1, 'byes are within one of each other: ' + JSON.stringify(tally));
    console.log('✅ TEST 2 — matchup_variety: 10 byes spread evenly over 5 teams ' + JSON.stringify(tally));
}

// ---- TEST 3: sport_variety — the mode LG-14 named ---------------------------
{
    const tally = runSeason({ schedulingPriority: 'sport_variety' });
    TEAMS.forEach(t => assert.ok(tally[t] > 0, t + ' took no bye in sport_variety: ' + JSON.stringify(tally)));
    assert.ok(spread(tally) <= 1, 'byes are within one of each other: ' + JSON.stringify(tally));
    console.log('✅ TEST 3 — sport_variety: byes spread evenly too ' + JSON.stringify(tally));
}

// ---- TEST 4: two periods in one day bench two different teams ---------------
{
    delete settings.leagueHistory; global.localStorage._m = {};
    const blocks = [
        { type: 'league', event: 'League Time', divName: 'Juniors', leagueName: LG, startTime: 780, endTime: 840, slots: [0] },
        { type: 'league', event: 'League Time', divName: 'Juniors', leagueName: LG, startTime: 840, endTime: 900, slots: [1] },
    ];
    const sat = byeTeams(gen('2026-07-01', { schedulingPriority: 'matchup_variety' }, blocks));
    assert.strictEqual(sat.length, 2, 'one bye per period: ' + JSON.stringify(sat));
    assert.notStrictEqual(sat[0], sat[1], 'the same team sat out both periods of one day: ' + JSON.stringify(sat));
    console.log('✅ TEST 4 — two periods in a day bench two different teams ' + JSON.stringify(sat));
}

// ---- TEST 5: a neglected team is pulled back in, even against the weights ---
{
    // The ledger has to WIN, not just break ties. Seed a history where every
    // other signal argues for benching T5 again: it has already met all four
    // opponents twice (so in matchup_variety its pairs carry the heaviest
    // rematch penalty in the league) while the other four have met each other
    // once, AND it has sat out the last three periods. The old scoring benches
    // whoever makes the remaining pairs cheapest — that is T5. Bye fairness has
    // to override it.
    function seedSkewedHistory() {
        delete settings.leagueHistory; global.localStorage._m = {};
        const gameLog = { [LG]: {
            // T5 plays everyone twice — heaviest rematch weight in the league.
            '2026-06-01': [{ t1: 'T5', t2: 'T1', sport: 'Basketball', g: 'Game 1' },
                           { t1: 'T2', t2: 'T3', sport: 'Soccer', g: 'Game 1' }],
            '2026-06-02': [{ t1: 'T5', t2: 'T2', sport: 'Basketball', g: 'Game 2' },
                           { t1: 'T3', t2: 'T4', sport: 'Soccer', g: 'Game 2' }],
            '2026-06-03': [{ t1: 'T5', t2: 'T3', sport: 'Basketball', g: 'Game 3' },
                           { t1: 'T1', t2: 'T4', sport: 'Soccer', g: 'Game 3' }],
            '2026-06-04': [{ t1: 'T5', t2: 'T4', sport: 'Basketball', g: 'Game 4' },
                           { t1: 'T1', t2: 'T2', sport: 'Soccer', g: 'Game 4' }],
            '2026-06-05': [{ t1: 'T5', t2: 'T1', sport: 'Soccer', g: 'Game 5' },
                           { t1: 'T3', t2: 'T2', sport: 'Basketball', g: 'Game 5' }],
            '2026-06-08': [{ t1: 'T5', t2: 'T2', sport: 'Soccer', g: 'Game 6' },
                           { t1: 'T4', t2: 'T3', sport: 'Basketball', g: 'Game 6' }],
            '2026-06-09': [{ t1: 'T5', t2: 'T3', sport: 'Soccer', g: 'Game 7' },
                           { t1: 'T1', t2: 'T4', sport: 'Basketball', g: 'Game 7' }],
            '2026-06-10': [{ t1: 'T5', t2: 'T4', sport: 'Soccer', g: 'Game 8' },
                           { t1: 'T2', t2: 'T1', sport: 'Basketball', g: 'Game 8' }],
            // …then sits out the last three periods.
            '2026-06-11': [{ t1: 'T1', t2: 'T2', sport: 'Basketball', g: 'Game 9' },
                           { t1: 'T3', t2: 'T4', sport: 'Soccer', g: 'Game 9' }],
            '2026-06-12': [{ t1: 'T1', t2: 'T3', sport: 'Basketball', g: 'Game 10' },
                           { t1: 'T2', t2: 'T4', sport: 'Soccer', g: 'Game 10' }],
            '2026-06-15': [{ t1: 'T1', t2: 'T4', sport: 'Basketball', g: 'Game 11' },
                           { t1: 'T2', t2: 'T3', sport: 'Soccer', g: 'Game 11' }],
        } };
        settings.leagueHistory = { teamSports: {}, matchupHistory: {}, gamesPerDate: {},
            offCampusCounts: {}, ocTripsByDate: {}, chinuchByDate: {}, gameLog: gameLog,
            _tombstones: {}, _savedAt: Date.now() };
        return settings.leagueHistory;
    }

    const led = Leagues.makeByeLedger(LG, TEAMS, seedSkewedHistory());
    assert.strictEqual(led.count('T5'), 3, 'T5 sat out the last three periods: ' + JSON.stringify(led.counts));

    // With the fix: T5 plays, despite carrying every rematch penalty.
    const withFix = byeTeams(gen('2026-06-16', { schedulingPriority: 'matchup_variety' }));
    assert.strictEqual(withFix.length, 1, 'one bye: ' + JSON.stringify(withFix));
    assert.notStrictEqual(withFix[0], 'T5',
        'T5 sat out three periods running and was benched AGAIN: ' + JSON.stringify(withFix));

    // Killswitch: the old scoring is restored and benches T5 a fourth time —
    // which is exactly the behavior this fix exists to remove.
    seedSkewedHistory();
    global.window.__leagueByeFairness = false;
    let without;
    try { without = byeTeams(gen('2026-06-16', { schedulingPriority: 'matchup_variety' })); }
    finally { delete global.window.__leagueByeFairness; }
    assert.strictEqual(without[0], 'T5',
        'killswitch should restore the old behavior (T5 benched again), got: ' + JSON.stringify(without));
    console.log('✅ TEST 5 — a 3-period-neglected team plays (' + withFix[0]
        + ' sits instead); killswitch restores the old skew (' + without[0] + ')');
}

// ---- TEST 6: chinuch and bye rotation coexist -------------------------------
{
    // 5 teams, 1 at chinuch per day → 4 left, two games, nobody benched. Bump
    // to 2 at chinuch → 3 left, one game, one benched. The benched team must
    // still rotate, and must never be a team that is at chinuch.
    const cfg = {
        schedulingPriority: 'matchup_variety',
        chinuch: { enabled: true, teamsPerRound: 2, timesPerDay: 1, bunkFacilities: {} },
    };
    delete settings.leagueHistory; global.localStorage._m = {};
    const tally = {}; TEAMS.forEach(t => tally[t] = 0);
    DAYS.forEach(d => {
        const ctx = gen(d, cfg);
        const lines = ctx.schedulableSlotBlocks.map(b => b._pick).filter(Boolean)
            .flatMap(p => p._allMatchups || []);
        const chTeams = lines.filter(l => /— Chinuch/.test(l)).map(l => l.split(' — ')[0]);
        byeTeams(ctx).forEach(t => {
            assert.ok(chTeams.indexOf(t) < 0, t + ' is listed at chinuch AND on a bye: ' + JSON.stringify(lines));
            tally[t]++;
        });
    });
    const benched = Object.keys(tally).filter(t => tally[t] > 0);
    assert.ok(benched.length >= 3,
        'the bye moved around even with chinuch running: ' + JSON.stringify(tally));
    console.log('✅ TEST 6 — chinuch running: the bye still rotates ' + JSON.stringify(tally));
}

console.log('\n🎉 league_bye_fairness_sim: ALL TESTS PASSED');

})().catch(e => { console.error(e); process.exit(1); });
