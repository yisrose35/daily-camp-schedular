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
//   TEST 7 — the ledger reads the SAVED TILES first, so a day whose chinuch
//            attendance never reached history cannot make learning teams look
//            benched (observed live: history claimed 19 byes where the grid
//            showed 6, and the bye went to the wrong team for a week).
//   TEST 8 — the day being regenerated ignores its own stale tiles, so a regen
//            does not simply repeat the bye it is replacing.
//   TEST 9 — teams level on bye COUNT are ordered by who has waited longest.
//            Without it the tie fell to the matchup/sport weights, which are
//            blind to byes: observed live, a team in the draw six days running
//            was never once picked while tied at the league minimum.
//   TEST 10 — a history-only day for a chinuch league with no attendance record
//            cannot say who was benched, so it is skipped rather than guessed.
//            Guessing invented byes for every learning team, which is what
//            convinced the engine to stop sitting a team altogether.
//   TEST 11 — that skip depends on knowing the league runs chinuch, and the
//            config lookup was returning NOTHING for a camp whose app1.leagues
//            is present but empty — so the skip never fired in the field.
//   TEST 12 — so the question is now answered from RECORDED ATTENDANCE first:
//            a league with any chinuch on record runs chinuch, no config needed.
//   TEST 13 — and the config lookup itself merges both sources instead of
//            picking one, so junk in app1.leagues cannot mask leaguesByName.
//   TEST 14 — the end of the guessing: each day RECORDS who sat out, and the
//            ledger reads that list back verbatim.
//   TEST 15 — the record merges per (league, date) and dies with a deleted day,
//            like every other per-date store.
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

// ---- TEST 7: the ledger reads the saved tiles, not just the arithmetic ------
{
    // Observed live: a 7-team league where history claimed 19 byes across days
    // the grid showed 6. Cause — the day's chinuch attendance was missing from
    // history, so "periods − games played − chinuch" read every LEARNING team
    // as benched, and the bye went to the wrong team for a week. The saved tile
    // says who sat out outright, so it is now the ledger's first source.
    const savedDays = {};
    const put = function (date, label, lines) {
        savedDays[date] = savedDays[date] || { leagueAssignments: { Juniors: {} } };
        savedDays[date].leagueAssignments.Juniors[String(780 + Object.keys(savedDays[date].leagueAssignments.Juniors).length * 60)] =
            { leagueName: LG, gameLabel: label, sport: 'Basketball', matchups: lines };
    };
    // T1 learned (no bye); T5 actually sat out. Two days of it.
    put('2026-06-01', 'Game 1', ['T2 vs T3 @ Court 1 (Basketball)', 'T1 — Chinuch (Beis Medrash)', 'T4 — Chinuch (Beis Medrash)', 'T5 — Bye']);
    put('2026-06-02', 'Game 2', ['T2 vs T4 @ Court 1 (Basketball)', 'T1 — Chinuch (Beis Medrash)', 'T3 — Chinuch (Beis Medrash)', 'T5 — Bye']);
    const prevLoad = global.window.loadAllDailyData;
    global.window.loadAllDailyData = () => savedDays;

    // History for the same days with the chinuch attendance MISSING — the
    // corruption. The arithmetic fallback would read T1 as benched twice.
    const history = {
        teamSports: {}, matchupHistory: {}, gamesPerDate: {}, offCampusCounts: {},
        ocTripsByDate: {}, chinuchByDate: {}, _tombstones: {}, _savedAt: 1,
        gameLog: { [LG]: {
            '2026-06-01': [{ t1: 'T2', t2: 'T3', sport: 'Basketball', g: 'Game 1' }],
            '2026-06-02': [{ t1: 'T2', t2: 'T4', sport: 'Basketball', g: 'Game 2' }],
        } },
    };

    const led = Leagues.makeByeLedger(LG, TEAMS, history, '2026-06-03');
    global.window.loadAllDailyData = prevLoad;

    assert.strictEqual(led.count('T5'), 2, 'the tiles say T5 sat out twice: ' + JSON.stringify(led.counts));
    assert.strictEqual(led.count('T1'), 0, 'T1 was LEARNING, not benched — the old arithmetic scored it 2: ' + JSON.stringify(led.counts));
    assert.strictEqual(led.count('T3'), 0, 'T3 learned once and played once: ' + JSON.stringify(led.counts));
    assert.strictEqual(led.excess('T5'), 2, 'T5 is two steps ahead and must play next');
    console.log('✅ TEST 7 — the ledger reads the saved tiles, so a missing chinuch record cannot skew it');
}

// ---- TEST 8: today's own stale tiles never bias its regeneration ------------
{
    // The day being regenerated still has LAST run's tiles on disk. Reading
    // them would push the engine to repeat the same bye. Today must come from
    // the (already rolled-back) gameLog instead.
    const today = '2026-06-05';
    const savedDays = { [today]: { leagueAssignments: { Juniors: { '780': {
        leagueName: LG, gameLabel: 'Game 1', sport: 'Basketball',
        matchups: ['T1 vs T2 @ Court 1 (Basketball)', 'T3 vs T4 @ Court 2 (Soccer)', 'T5 — Bye'],
    } } } } };
    const prevLoad = global.window.loadAllDailyData;
    global.window.loadAllDailyData = () => savedDays;
    const history = { gameLog: { [LG]: {} }, chinuchByDate: {} };   // day-reset already rolled it back
    const led = Leagues.makeByeLedger(LG, TEAMS, history, today);
    global.window.loadAllDailyData = prevLoad;

    assert.strictEqual(led.count('T5'), 0,
        "today's stale tile must not count against T5 on a regen: " + JSON.stringify(led.counts));
    console.log('✅ TEST 8 — the day being regenerated ignores its own stale tiles');
}

// ---- TEST 9: teams level on byes are split by who waited longest ------------
{
    // Observed live: five teams all level at the league minimum, one of them in
    // the draw six days running and never picked. With the count tied, the
    // choice fell through to the matchup/sport weights — which know nothing
    // about byes and happily favored the same teams every day. The ledger now
    // breaks that tie on how long each team has gone without sitting.
    const savedDays = {};
    const put = function (date, lines) {
        savedDays[date] = { leagueAssignments: { Juniors: { '780':
            { leagueName: LG, gameLabel: 'Game', sport: 'Basketball', matchups: lines } } } };
    };
    // T1..T4 each sat out once, recently. T5 also sat once — but long ago.
    put('2026-06-01', ['T1 vs T2 @ Court 1 (Basketball)', 'T3 vs T4 @ Court 2 (Soccer)', 'T5 — Bye']);
    put('2026-06-08', ['T2 vs T3 @ Court 1 (Basketball)', 'T4 vs T5 @ Court 2 (Soccer)', 'T1 — Bye']);
    put('2026-06-09', ['T1 vs T3 @ Court 1 (Basketball)', 'T4 vs T5 @ Court 2 (Soccer)', 'T2 — Bye']);
    put('2026-06-10', ['T1 vs T2 @ Court 1 (Basketball)', 'T4 vs T5 @ Court 2 (Soccer)', 'T3 — Bye']);
    put('2026-06-11', ['T1 vs T2 @ Court 1 (Basketball)', 'T3 vs T5 @ Court 2 (Soccer)', 'T4 — Bye']);
    const prevLoad = global.window.loadAllDailyData;
    global.window.loadAllDailyData = () => savedDays;
    const led = Leagues.makeByeLedger(LG, TEAMS, { gameLog: { [LG]: {} }, chinuchByDate: {} }, '2026-06-12');
    global.window.loadAllDailyData = prevLoad;

    TEAMS.forEach(t => assert.strictEqual(led.count(t), 1, t + ' sat out exactly once: ' + JSON.stringify(led.counts)));
    TEAMS.forEach(t => assert.strictEqual(led.excess(t), 0, 'nobody is ahead on count'));
    // …so the count alone cannot choose. Staleness can: T5 has waited longest.
    const stale = TEAMS.map(t => led.staleness(t));
    assert.strictEqual(Math.max.apply(null, stale), led.staleness('T5'),
        'T5 waited longest and must be first in line: ' + JSON.stringify(stale));
    assert.ok(led.staleness('T5') > led.staleness('T4'), JSON.stringify(stale));
    assert.strictEqual(led.staleness('T4'), 0, 'T4 sat out on the most recent league day');
    console.log('✅ TEST 9 — teams tied on byes are ordered by who has waited longest');
}

// ---- TEST 10: a day that cannot say who sat out is ignored, not guessed -----
{
    // A history-only day (no saved schedule) for a league that runs chinuch,
    // with no attendance record: the arithmetic would count every LEARNING team
    // as benched. Those phantom byes are what convinced the engine a team was
    // over-benched and stopped it ever sitting again — worse than no data.
    const prevLoad = global.window.loadAllDailyData;
    global.window.loadAllDailyData = () => ({});          // nothing saved locally
    settings.leaguesByName = { [LG]: { name: LG, teams: TEAMS.slice(), chinuch: { enabled: true } } };
    const history = { chinuchByDate: {}, gameLog: { [LG]: {
        '2026-06-01': [{ t1: 'T1', t2: 'T2', sport: 'Basketball', g: 'Game 1' }],
        '2026-06-02': [{ t1: 'T3', t2: 'T4', sport: 'Basketball', g: 'Game 2' }],
    } } };
    const led = Leagues.makeByeLedger(LG, TEAMS, history, '2026-06-03');
    TEAMS.forEach(t => assert.strictEqual(led.count(t), 0,
        'an unreadable day must contribute nothing: ' + JSON.stringify(led.counts)));
    assert.strictEqual(led.unmeasurable.length, 2, 'and it is recorded as skipped');

    // The same days WITH an attendance record are readable, so they count.
    // Day 1: T1 vs T2 played, T3 and T4 learned → T5 sat out. Day 2 mirrors it.
    history.chinuchByDate = { [LG]: { '2026-06-01': ['T3', 'T4'], '2026-06-02': ['T1', 'T2'] } };
    const led2 = Leagues.makeByeLedger(LG, TEAMS, history, '2026-06-03');
    assert.strictEqual(led2.unmeasurable.length, 0);
    assert.strictEqual(led2.count('T5'), 2, 'T5 neither played nor learned: ' + JSON.stringify(led2.counts));
    assert.strictEqual(led2.count('T1'), 0, 'T1 played day 1 and learned day 2');

    // A league with chinuch OFF has nothing to confuse, so the arithmetic stands.
    settings.leaguesByName = { [LG]: { name: LG, teams: TEAMS.slice() } };
    const led3 = Leagues.makeByeLedger(LG, TEAMS, { chinuchByDate: {}, gameLog: history.gameLog }, '2026-06-03');
    assert.strictEqual(led3.unmeasurable.length, 0, 'no chinuch → nothing ambiguous');
    assert.strictEqual(led3.count('T5'), 2, 'T5 sat out both days: ' + JSON.stringify(led3.counts));
    global.window.loadAllDailyData = prevLoad;
    delete settings.leaguesByName;
    console.log('✅ TEST 10 — a day that cannot say who sat out is skipped, not guessed');
}

// ---- TEST 11: an empty app1.leagues must not hide the real league list ------
{
    // Observed live: a camp boots with `fromApp1: 0, fromGlobal: 5` — app1.leagues
    // is PRESENT and EMPTY while the real leagues live in leaguesByName. The old
    // `app1.leagues || leaguesByName` short-circuited on the empty-but-truthy
    // object and resolved to zero leagues, so every "does this league run
    // chinuch?" answered no. The ledger then stopped skipping days it cannot
    // read and counted each learning team as benched — 19 phantom byes across
    // days the grid showed 6, which kept the bye off the same team for a week.
    const prevLoad = global.window.loadAllDailyData;
    global.window.loadAllDailyData = () => ({});
    settings.app1 = { leagues: {} };                       // present, empty
    settings.leaguesByName = { [LG]: { name: LG, teams: TEAMS.slice(), chinuch: { enabled: true } } };
    try {
        assert.strictEqual(Leagues._leagueConfigs().length, 1,
            'an empty app1.leagues must fall through to leaguesByName');

        const history = { chinuchByDate: {}, gameLog: { [LG]: {
            '2026-06-01': [{ t1: 'T1', t2: 'T2', sport: 'Basketball', g: 'Game 1' }],
            '2026-06-02': [{ t1: 'T3', t2: 'T4', sport: 'Basketball', g: 'Game 2' }],
        } } };
        const led = Leagues.makeByeLedger(LG, TEAMS, history, '2026-06-03');
        assert.strictEqual(led.unmeasurable.length, 2,
            'chinuch is on, so unreadable days are skipped: ' + JSON.stringify(led.unmeasurable));
        TEAMS.forEach(t => assert.strictEqual(led.count(t), 0,
            'no phantom byes: ' + JSON.stringify(led.counts)));

        // A non-empty app1.leagues still wins, as it always did.
        settings.app1 = { leagues: { [LG]: { name: LG, teams: TEAMS.slice() } } };
        assert.strictEqual(Leagues._leagueConfigs()[0].chinuch, undefined,
            'a populated app1.leagues is still the primary source');
    } finally {
        global.window.loadAllDailyData = prevLoad;
        delete settings.app1; delete settings.leaguesByName;
    }
    console.log('✅ TEST 11 — an empty app1.leagues no longer hides the camp\'s leagues');
}

// ---- TEST 12: chinuch is detected from the DATA, not just the config -------
{
    // The skip has to fire even when the config lookup comes back empty — which
    // it did in the field twice over, first because app1.leagues was present and
    // empty, then in a profile whose league list had not hydrated yet. A league
    // with ANY recorded chinuch attendance demonstrably runs chinuch, so ask the
    // history before asking the config.
    const prevLoad = global.window.loadAllDailyData;
    global.window.loadAllDailyData = () => ({});
    delete settings.app1; delete settings.leaguesByName;      // no config at all
    try {
        const history = {
            // One earlier day proves chinuch runs here…
            chinuchByDate: { [LG]: { '2026-05-01': ['T1', 'T2'] } },
            gameLog: { [LG]: {
                '2026-05-01': [{ t1: 'T3', t2: 'T4', sport: 'Basketball', g: 'Game 0' }],
                // …so these two, which have no attendance record, are unreadable.
                '2026-06-01': [{ t1: 'T1', t2: 'T2', sport: 'Basketball', g: 'Game 1' }],
                '2026-06-02': [{ t1: 'T3', t2: 'T4', sport: 'Basketball', g: 'Game 2' }],
            } },
        };
        const led = Leagues.makeByeLedger(LG, TEAMS, history, '2026-06-03');
        assert.strictEqual(led.unmeasurable.length, 2,
            'the two record-less days are skipped with no config present: ' + JSON.stringify(led.unmeasurable));
        assert.strictEqual(led.count('T5'), 1,
            'only the readable day counts — T5 sat out 2026-05-01: ' + JSON.stringify(led.counts));

        // A league that has never recorded chinuch still reads as chinuch-free,
        // so its days stay measurable by the arithmetic.
        const plain = { chinuchByDate: {}, gameLog: history.gameLog };
        const led2 = Leagues.makeByeLedger(LG, TEAMS, plain, '2026-06-03');
        assert.strictEqual(led2.unmeasurable.length, 0, 'no chinuch anywhere → nothing ambiguous');
        assert.strictEqual(led2.count('T5'), 3,
            'all three days are readable, and T5 played in none of them: ' + JSON.stringify(led2.counts));
    } finally { global.window.loadAllDailyData = prevLoad; }
    console.log('✅ TEST 12 — chinuch is detected from recorded attendance, config optional');
}

// ---- TEST 13: the config lookup merges both sources ------------------------
{
    // app1.leagues holding entries that are not league objects used to win the
    // `||` and mask leaguesByName entirely.
    settings.app1 = { leagues: ['Some League Name', null, 42] };   // junk, not configs
    settings.leaguesByName = { [LG]: { name: LG, teams: TEAMS.slice(), chinuch: { enabled: true } } };
    try {
        const found = Leagues._leagueConfigs().find(function (l) { return l.name === LG; });
        assert.ok(found, 'the real league must still be found: ' + JSON.stringify(Leagues._leagueConfigs()));
        assert.strictEqual(found.chinuch.enabled, true);

        // A real app1 entry still takes precedence over the same name elsewhere.
        settings.app1 = { leagues: { [LG]: { name: LG, teams: [], marker: 'app1' } } };
        assert.strictEqual(Leagues._leagueConfigs().find(function (l) { return l.name === LG; }).marker, 'app1');
    } finally { delete settings.app1; delete settings.leaguesByName; }
    console.log('✅ TEST 13 — the league lookup merges app1 and leaguesByName');
}

// ---- TEST 14: the engine RECORDS who sat out, and the ledger reads it ------
{
    // The end of the inference. Every earlier attempt derived byes from
    // (periods − games played − chinuch), which needs two stores to agree and
    // invents byes when they don't — a roster team that has never played reads
    // as benched in every period of every day. The day now writes its own list.
    delete settings.leagueHistory; global.localStorage._m = {};
    const cfg = { schedulingPriority: 'matchup_variety' };
    const day1 = '2026-07-01', day2 = '2026-07-02';

    const sat1 = byeTeams(gen(day1, cfg));
    const rec1 = settings.leagueHistory.byesByDate?.[LG]?.[day1];
    assert.deepStrictEqual(rec1, sat1, 'the day records exactly the teams the tiles benched: '
        + JSON.stringify(rec1) + ' vs ' + JSON.stringify(sat1));

    // The ledger reads the record rather than re-deriving anything.
    const led = Leagues.makeByeLedger(LG, TEAMS, settings.leagueHistory, day2);
    assert.strictEqual(led.count(sat1[0]), 1, 'the benched team is credited once: ' + JSON.stringify(led.counts));
    TEAMS.filter(t => t !== sat1[0]).forEach(t => assert.strictEqual(led.count(t), 0,
        t + ' played and must not be credited a bye: ' + JSON.stringify(led.counts)));
    assert.strictEqual(led.unmeasurable.length, 0, 'a recorded day is never unreadable');

    // A second day appends; it does not replace.
    const sat2 = byeTeams(gen(day2, cfg));
    assert.deepStrictEqual(settings.leagueHistory.byesByDate[LG][day1], sat1, 'day 1 survives day 2');
    assert.deepStrictEqual(settings.leagueHistory.byesByDate[LG][day2], sat2);

    // Re-generating a day REPLACES its record instead of doubling it.
    const again = byeTeams(gen(day1, cfg));
    const rec1b = settings.leagueHistory.byesByDate[LG][day1];
    assert.strictEqual(rec1b.length, again.length,
        'a regen rewrites the day, never appends to it: ' + JSON.stringify(rec1b));
    assert.deepStrictEqual(rec1b, again);
    console.log('✅ TEST 14 — byes are recorded per day and read back verbatim');
}

// ---- TEST 15: the record survives a merge and dies with a deleted day ------
{
    const mk = (savedAt, byes) => ({
        teamSports: {}, matchupHistory: {}, gamesPerDate: {}, offCampusCounts: {},
        ocTripsByDate: {}, chinuchByDate: {}, byesByDate: { [LG]: byes },
        gameLog: {}, _tombstones: {}, _savedAt: savedAt,
    });
    const A = mk(2000, { '2026-07-01': ['T1'] });
    const B = mk(1000, { '2026-07-01': ['T9'], '2026-07-02': ['T2'] });
    const m = Leagues.mergeLeagueHistories(A, B);
    assert.deepStrictEqual(m.byesByDate[LG]['2026-07-01'], ['T1'], 'fresher copy wins the conflict day');
    assert.deepStrictEqual(m.byesByDate[LG]['2026-07-02'], ['T2'], 'the older lineage day is adopted');

    // And a deleted day takes its bye record with it.
    delete settings.leagueHistory; global.localStorage._m = {};
    settings.leaguesByName = { [LG]: { name: LG, divisions: ['Juniors'], teams: TEAMS.slice() } };
    gen('2026-07-01', { schedulingPriority: 'matchup_variety' });
    assert.ok(settings.leagueHistory.byesByDate[LG]['2026-07-01'], 'seeded');
    Leagues.cleanupDateFromHistory('2026-07-01');
    assert.ok(!settings.leagueHistory.byesByDate?.[LG]?.['2026-07-01'],
        'deleting the day removes its bye record');
    delete settings.leaguesByName;
    console.log('✅ TEST 15 — the bye record merges per (league, date) and rolls back with the day');
}

console.log('\n🎉 league_bye_fairness_sim: ALL TESTS PASSED');

})().catch(e => { console.error(e); process.exit(1); });
