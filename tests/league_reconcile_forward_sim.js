// =============================================================================
// league_reconcile_forward_sim.js
// -----------------------------------------------------------------------------
// ★ LG-9: the engine's decisions are only as good as the history it reads.
// Two hardening layers, driven against the REAL engines:
//
//   HISTORY ⇄ SAVED-SCHEDULE RECONCILIATION — a (league, date) the gameLog has
//   no record of is rebuilt from the saved schedules before any decision:
//     TEST 1 — regular: with a completely LOST history but 3 days of saved
//              schedules (display-string matchups), generation rebuilds the
//              gameLog + counters, numbers the new day correctly (Game 4),
//              avoids yesterday's pairings, and pushes the healed history to
//              the cloud. BYE lines and foreign-league entries are ignored.
//     TEST 2 — a tombstoned (deliberately deleted) date is NOT resurrected.
//     TEST 3 — specialty: structured uiEntry matchups rebuild gameLog under
//              the league ID, matchup date-arrays, field rotation, slotDebt
//              and counters, via the exported repair utility.
//
//   FORWARD-LOOKING SPORT GUARD — middle-day regen also looks at the NEXT
//   game day's sports:
//     TEST 4 — HARD: yesterday Hockey + tomorrow Hockey → today must never be
//              Hockey (3-run straddling the regen boundary).
//     TEST 5 — SOFT: tomorrow Basketball → today prefers another sport even
//              when both options are otherwise equal.
//     TEST 6 — full-season met(): regenerating a middle day avoids a pair
//              that already meets two days later when a fresh pairing exists.
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
    __leagueHistoryCloudFreshAt: Date.now() + 1e9,   // silence the freshness warning in tests
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
assert.ok(typeof Leagues.reconcileHistoryFromSchedules === 'function', 'regular repair utility exported');
assert.ok(typeof Specialty.reconcileHistoryFromSchedules === 'function', 'specialty repair utility exported');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const LG = 'Test League';
const TEAMS = ['Team 1', 'Team 2', 'Team 3', 'Team 4', 'Team 5', 'Team 6'];
const pairKey = (a, b) => [a, b].sort().join('|');
const fieldsFor = (sportCounts) => Object.entries(sportCounts).flatMap(([sport, n]) =>
    Array.from({ length: n }, (_, i) => ({ name: sport + ' Field ' + (i + 1), activities: [sport] })));

function makeContext(fields, teams) {
    return {
        schedulableSlotBlocks: [{ type: 'league', event: 'League Time', divName: 'Juniors', leagueName: LG, startTime: 780, endTime: 840, slots: [0] }],
        masterLeagues: { [LG]: { name: LG, enabled: true, divisions: ['Juniors'], teams: teams || TEAMS, sports: [...new Set(fields.flatMap(f => f.activities))], schedulingPriority: 'matchup_variety' } },
        disabledLeagues: [],
        divisions: { Juniors: { bunks: ['J1'] } },
        fillBlock: function (block) { block._filled = true; },
        fieldUsageBySlot: {}, activityProperties: {}, rotationHistory: {},
        fields, disabledFields: [],
    };
}
function gen(date, fields, teams) {
    global.window.currentScheduleDate = date;
    global.window._activeGenDate = date;
    console.log = () => {};
    try { Leagues.processRegularLeagues(makeContext(fields, teams)); }
    finally { console.log = origLog; }
}
const histNow = () => settings.leagueHistory || {};
const wipe = () => { delete settings.leagueHistory; delete settings.specialtyLeagueHistory; global.localStorage._m = {}; delete cloudKV.leagueHistory; delete cloudKV.specialtyLeagueHistory; delete global.window.loadAllDailyData; };

// saved-schedule day for the regular league (display-string matchups, the
// exact shape fillBlock stores)
function savedDay(gameNum, matchups) {
    return {
        leagueAssignments: {
            Juniors: {
                0: {
                    leagueName: LG,
                    gameLabel: `${LG} Game ${gameNum}`,
                    sport: '',
                    matchups: matchups,
                    _startMin: 780, _endMin: 840,
                },
            },
        },
    };
}

(async () => {

// ---- TEST 1: lost history rebuilt from saved schedules at generation -------
{
    wipe();
    global.window.loadAllDailyData = () => ({
        '2026-07-01': savedDay(1, ['Team 1 vs Team 2 @ BB Field 1 (Basketball)', 'Team 3 vs Team 4 @ SC Field 1 (Soccer)', 'Team 5 vs Team 6 @ HK Field 1 (Hockey)']),
        '2026-07-02': savedDay(2, ['Team 1 vs Team 3 @ HK Field 1 (Hockey)', 'Team 2 vs Team 5 @ BB Field 1 (Basketball)', 'Team 4 vs Team 6 @ SC Field 1 (Soccer)']),
        '2026-07-03': {
            leagueAssignments: {
                Juniors: {
                    0: {
                        leagueName: LG, gameLabel: `${LG} Game 3`, sport: '',
                        matchups: [
                            'Team 1 vs Team 6 @ SC Field 1 (Soccer)',
                            'Team 2 vs Team 4 @ HK Field 1 (Hockey)',
                            'Team 3 vs Team 5 @ BB Field 1 (Basketball)',
                            'Team 7 (BYE)',                                   // must be ignored
                        ],
                        _startMin: 780, _endMin: 840,
                    },
                    1: { leagueName: 'Some Other League', gameLabel: 'X Game 9', sport: '', matchups: ['A vs B @ F (Chess)'] },  // foreign — ignored
                },
            },
        },
    });
    gen('2026-07-04', fieldsFor({ Basketball: 1, Soccer: 1, Hockey: 1, Kickball: 1, Baseball: 1, Volleyball: 1 }));
    await sleep(120);
    const h = histNow();
    // gameLog rebuilt for all 3 lost days
    ['2026-07-01', '2026-07-02', '2026-07-03'].forEach(d =>
        assert.strictEqual((h.gameLog[LG][d] || []).length, 3, `reconstructed 3 games on ${d}`));
    assert.strictEqual(h.gameLog[LG]['2026-07-01'][0].sport, 'Basketball', 'sport parsed from the display string');
    // counters healed → today numbered correctly
    assert.strictEqual(h.gamesPerDate[LG]['2026-07-01'], 1);
    const todayLabels = new Set((h.gameLog[LG]['2026-07-04'] || []).map(g => g.g));
    assert.deepStrictEqual([...todayLabels], [`Game 4`], 'today numbered Game 4 (history healed), got ' + [...todayLabels]);
    // no BYE/foreign pollution
    Object.values(h.gameLog[LG]).flat().forEach(g => {
        assert.ok(TEAMS.includes(g.t1) && TEAMS.includes(g.t2), 'only real league teams recorded');
    });
    // yesterday's pairings not restaged
    const d3 = new Set((h.gameLog[LG]['2026-07-03'] || []).map(g => pairKey(g.t1, g.t2)));
    (h.gameLog[LG]['2026-07-04'] || []).forEach(g =>
        assert.ok(!d3.has(pairKey(g.t1, g.t2)), 'no repeat of yesterday\'s pairing after healing'));
    // healed history reached the cloud
    assert.ok(cloudKV.leagueHistory && cloudKV.leagueHistory.gameLog[LG]['2026-07-01'], 'healed history pushed to cloud');
    console.log('✅ TEST 1 — lost history rebuilt from saved schedules: numbering, matchups, sports, cloud');
}

// ---- TEST 2: a tombstoned date is not resurrected by reconciliation --------
{
    wipe();
    settings.leagueHistory = {
        teamSports: {}, matchupHistory: {}, gamesPerDate: {}, offCampusCounts: {}, gameLog: {},
        _tombstones: { [`*|2026-07-01`]: Date.now() },
        _savedAt: Date.now(),
    };
    global.window.loadAllDailyData = () => ({
        '2026-07-01': savedDay(1, ['Team 1 vs Team 2 @ BB Field 1 (Basketball)']),
    });
    console.log = () => {};
    const n = Leagues.reconcileHistoryFromSchedules({ [LG]: { name: LG, teams: TEAMS } });
    console.log = origLog;
    assert.strictEqual(n, 0, 'tombstoned date must not be backfilled');
    console.log('✅ TEST 2 — deliberately deleted dates stay deleted through reconciliation');
}

// ---- TEST 3: specialty reconciliation from structured uiEntries -------------
{
    wipe();
    const CFG = { 7: { id: 7, name: 'Hockey League', teams: ['X', 'Y', 'Z', 'W'], divisions: ['Juniors'] } };
    global.window.loadAllDailyData = () => ({
        '2026-07-01': {
            leagueAssignments: {
                Juniors: {
                    2: {
                        leagueName: 'Hockey League', sport: 'Hockey', gameLabel: 'Hockey League Game 1',
                        isSpecialtyLeague: true,
                        matchups: [
                            { teamA: 'X', teamB: 'Y', field: 'Rink 1', slotOrder: 1 },
                            { teamA: 'Z', teamB: 'W', field: 'Rink 2', slotOrder: 2 },
                        ],
                    },
                },
            },
        },
    });
    console.log = () => {};
    const n = Specialty.reconcileHistoryFromSchedules(CFG);
    console.log = origLog;
    await sleep(120);
    assert.strictEqual(n, 2, 'two specialty games backfilled');
    const h = settings.specialtyLeagueHistory;
    assert.strictEqual(h.gameLog[7]['2026-07-01'].length, 2, 'gameLog under the league ID');
    assert.deepStrictEqual(h.matchupHistory['7|X|Y'], ['2026-07-01'], 'matchup date-array rebuilt');
    assert.deepStrictEqual(h.teamFieldRotation['7|X'], ['Rink 1'], 'field rotation rebuilt');
    assert.strictEqual(h.slotDebt['7|Z'], 1, 'slotDebt rebuilt from slotOrder');
    assert.strictEqual(h.gamesPerDate[7]['2026-07-01'], 1, 'counter derived from labels');
    assert.ok(cloudKV.specialtyLeagueHistory, 'healed specialty history pushed to cloud');
    console.log('✅ TEST 3 — specialty history rebuilt from structured saved matchups');
}

// ---- TEST 4: HARD forward guard — no 3-run straddling a middle regen -------
{
    wipe();
    const four = ['Team 1', 'Team 2', 'Team 3', 'Team 4'];
    // Yesterday: T1 played Hockey. Tomorrow (already on the calendar): T1
    // plays Hockey again. Whatever T1 gets today, it must NOT be Hockey —
    // that would be the same sport 3 game days running, invisible to the
    // backward-only streak cap. (Tomorrow's other game is Kickball so no
    // OTHER team has a straddle conflict — the scenario is feasible.)
    settings.leagueHistory = {
        teamSports: {}, matchupHistory: {}, gamesPerDate: { [LG]: { '2026-07-01': 1, '2026-07-03': 1 } },
        offCampusCounts: {},
        gameLog: { [LG]: {
            '2026-07-01': [
                { t1: 'Team 1', t2: 'Team 2', sport: 'Hockey', g: 'Game 1' },
                { t1: 'Team 3', t2: 'Team 4', sport: 'Soccer', g: 'Game 1' },
            ],
            '2026-07-03': [
                { t1: 'Team 1', t2: 'Team 3', sport: 'Hockey', g: 'Game 3' },   // T1 plays Hockey TOMORROW
                { t1: 'Team 2', t2: 'Team 4', sport: 'Kickball', g: 'Game 3' },
            ],
        } },
        _savedAt: Date.now(),
    };
    gen('2026-07-02', fieldsFor({ Hockey: 1, Soccer: 1, Kickball: 1 }), four);
    const day2 = histNow().gameLog[LG]['2026-07-02'];
    assert.strictEqual(day2.length, 2, 'both matchups placed');
    const t1Game = day2.find(g => g.t1 === 'Team 1' || g.t2 === 'Team 1');
    assert.ok(t1Game, 'Team 1 plays');
    assert.notStrictEqual(t1Game.sport, 'Hockey',
        `Team 1 played Hockey yesterday AND plays Hockey tomorrow — today must not be Hockey (got ${t1Game.sport})`);
    console.log('✅ TEST 4 — hard forward guard: no same-sport 3-run straddling a middle-day regen');
}

// ---- TEST 5: SOFT forward guard — avoid tomorrow's sport when possible -----
{
    // Tomorrow T1 and T3 both play Basketball; today's pool has three sports
    // for two matchups, so Basketball can be left unused entirely. Without
    // the forward penalty the scorer has no reason to avoid it (all sports
    // are cycle-fresh) and random/field tiebreaks pick it often; with the
    // penalty it must NEVER be picked. 6 runs to defeat the random term.
    for (let iter = 1; iter <= 6; iter++) {
        wipe();
        const four = ['Team 1', 'Team 2', 'Team 3', 'Team 4'];
        settings.leagueHistory = {
            teamSports: {}, matchupHistory: {}, gamesPerDate: { [LG]: { '2026-07-03': 1 } },
            offCampusCounts: {},
            gameLog: { [LG]: {
                '2026-07-03': [
                    { t1: 'Team 1', t2: 'Team 3', sport: 'Basketball', g: 'Game 3' },
                    { t1: 'Team 2', t2: 'Team 4', sport: 'Soccer', g: 'Game 3' },
                ],
            } },
            _savedAt: Date.now(),
        };
        gen('2026-07-02', fieldsFor({ Basketball: 1, Hockey: 1, Kickball: 1 }), four);
        const day2 = histNow().gameLog[LG]['2026-07-02'];
        assert.strictEqual(day2.length, 2, 'both matchups placed');
        day2.forEach(g => assert.notStrictEqual(g.sport, 'Basketball',
            `[run ${iter}] a team playing Basketball tomorrow got Basketball today though two clean sports were open (${g.t1} vs ${g.t2})`));
    }
    console.log('✅ TEST 5 — soft forward guard: tomorrow\'s sport left unused when alternatives exist (6/6 runs)');
}

// ---- TEST 6: full-season met() — future meetings count in fairness ---------
{
    wipe();
    const four = ['Team 1', 'Team 2', 'Team 3', 'Team 4'];
    // 07-04 (two days ahead — outside the adjacent-day guard) already has
    // 1v2 + 3v4. Historical meetings tie everything else. Regenerating 07-02
    // must prefer the pairings NOT already booked for 07-04.
    settings.leagueHistory = {
        teamSports: {}, matchupHistory: {}, gamesPerDate: { [LG]: { '2026-07-04': 1 } },
        offCampusCounts: {},
        gameLog: { [LG]: {
            '2026-07-04': [
                { t1: 'Team 1', t2: 'Team 2', sport: 'Hockey', g: 'Game 4' },
                { t1: 'Team 3', t2: 'Team 4', sport: 'Soccer', g: 'Game 4' },
            ],
        } },
        _savedAt: Date.now(),
    };
    gen('2026-07-02', fieldsFor({ Hockey: 1, Soccer: 1 }), four);
    const day2 = histNow().gameLog[LG]['2026-07-02'];
    const booked = new Set([pairKey('Team 1', 'Team 2'), pairKey('Team 3', 'Team 4')]);
    day2.forEach(g => assert.ok(!booked.has(pairKey(g.t1, g.t2)),
        `pair ${pairKey(g.t1, g.t2)} already meets on 07-04 — a fresh pairing existed and must be used`));
    console.log('✅ TEST 6 — full-season meeting counts: future bookings steer today\'s pairings');
}

await sleep(200);   // drain trailing verified-push logs so the banner prints last
console.log('\n🎉 league_reconcile_forward_sim: ALL TESTS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
