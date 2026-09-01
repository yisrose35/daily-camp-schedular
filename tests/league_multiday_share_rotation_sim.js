// =============================================================================
// league_multiday_share_rotation_sim.js
// -----------------------------------------------------------------------------
// Drives the REAL SchedulerCoreLeagues.processRegularLeagues to prove the
// FAIR-SHARE SPORT CAP ROTATES ACROSS PERIODS WITHIN A MULTI-GAME DAY.
//
// THE BUG (reported live): a camp runs ~6 league games in ONE day with only 4
// sports. Basketball has many courts; hockey/football/newcomb are scarce and
// SHARED across the grades playing leagues at the same time. The fair-share cap
// is recomputed each period, but its "need" was read from history that stopped
// at YESTERDAY — so every period computed the IDENTICAL apportionment, handed
// the same scarce sports to the same senior grades every period, and left the
// JUNIOR grade jammed onto the one abundant sport (basketball) for ~5 of 6
// games. Doubling a sport on a 4-sport / 6-game day is expected; 5/6 basketball
// is the starvation this guards against.
//
// THE FIX: fold the games already played EARLIER TODAY into the fair-share need
// so a grade that already got hockey/newcomb this morning shows lower need for
// it now, and the next period rotates it to a grade that hasn't.
//
//   TEST 1 — three grades, one 6-period day, screenshot field inventory
//            (4 basketball courts, 2 hockey, 2 football, 1 newcomb). Assert for
//            EVERY league: its teams collectively touch >= 3 distinct sports
//            (no grade is starved onto 1-2 sports) AND no single team plays one
//            sport >= 5 of its 6 games. Repeated 6x (scoring has random
//            tiebreaks — the rotation must hold every time).
// =============================================================================

'use strict';
const assert = require('assert');
const path = require('path');

const cloud = {};
global.localStorage = {
    _m: {},
    getItem(k) { return this._m[k] != null ? this._m[k] : null; },
    setItem(k, v) { this._m[k] = String(v); },
    removeItem(k) { delete this._m[k]; },
};
const P = [];
for (let i = 0; i < 6; i++) P.push({ startMin: 600 + i * 60, endMin: 660 + i * 60 });
global.window = {
    loadGlobalSettings: () => ({ leagueHistory: cloud.leagueHistory }),
    saveGlobalSettings: (k, v) => { cloud[k] = v; },
    currentScheduleDate: '2026-07-22',
    divisionTimes: { '2ND': P, '3RD': P, '4TH': P },
    addEventListener: () => {},
    CustomEvent: function CustomEvent(type, opts) { this.type = type; this.detail = (opts || {}).detail; },
    dispatchEvent: () => true,
};
global.document = { readyState: 'complete', addEventListener: () => {} };

try { require(path.join(__dirname, '..', 'scheduler_core_utils.js')); } catch (_e) {}
try { require(path.join(__dirname, '..', 'global_field_locks.js')); } catch (_e) {}
require(path.join(__dirname, '..', 'scheduler_core_leagues.js'));
const Leagues = global.window.SchedulerCoreLeagues;
assert.ok(Leagues && typeof Leagues.processRegularLeagues === 'function', 'module loaded');

const DAY = '2026-07-22';
const L2 = '2nd League', L3 = '3rd League', L4 = '4th League';
const SPORTS = ['Basketball', 'Football', 'Hockey', 'Newcomb'];

// Screenshot inventory: basketball abundant (4 courts), everything else scarce.
const fields = [
    { name: 'New Gym bball', activities: ['Basketball'] },
    { name: 'Red and Black bball', activities: ['Basketball'] },
    { name: 'Upper bball', activities: ['Basketball'] },
    { name: 'Lower bball', activities: ['Basketball'] },
    { name: 'Hockey Rink', activities: ['Hockey'] },
    { name: 'Old Gym Hockey', activities: ['Hockey'] },
    { name: 'Football field 1', activities: ['Football'] },
    { name: 'Football field 2', activities: ['Football'] },
    { name: 'Small Turf', activities: ['Newcomb'] },
];

function makeContext() {
    const blocks = [];
    for (let i = 0; i < 6; i++) {
        blocks.push({ type: 'league', event: 'League Time', divName: '2ND', leagueName: L2, startTime: P[i].startMin, endTime: P[i].endMin, slots: [i] });
        blocks.push({ type: 'league', event: 'League Time', divName: '3RD', leagueName: L3, startTime: P[i].startMin, endTime: P[i].endMin, slots: [i] });
        blocks.push({ type: 'league', event: 'League Time', divName: '4TH', leagueName: L4, startTime: P[i].startMin, endTime: P[i].endMin, slots: [i] });
    }
    return {
        schedulableSlotBlocks: blocks,
        masterLeagues: {
            [L2]: { name: L2, enabled: true, divisions: ['2ND'], teams: ['B1', 'B2', 'B3', 'B4'], sports: SPORTS, schedulingPriority: 'sport_variety' },
            [L3]: { name: L3, enabled: true, divisions: ['3RD'], teams: ['C1', 'C2', 'C3', 'C4'], sports: SPORTS, schedulingPriority: 'sport_variety' },
            [L4]: { name: L4, enabled: true, divisions: ['4TH'], teams: ['Team 5', 'Team 6', 'Team 7', 'Team 8', 'Team 9'], sports: SPORTS, schedulingPriority: 'sport_variety' },
        },
        disabledLeagues: [],
        divisions: {
            '2ND': { bunks: ['a', 'b'], startTime: '10:00 AM', endTime: '4:00 PM' },
            '3RD': { bunks: ['c', 'd'], startTime: '10:00 AM', endTime: '4:00 PM' },
            '4TH': { bunks: ['e', 'f'], startTime: '10:00 AM', endTime: '4:00 PM' },
        },
        fillBlock: function (block) { block._filled = true; },
        fieldUsageBySlot: {}, activityProperties: {}, rotationHistory: {},
        fields: fields, disabledFields: [],
    };
}

function run() {
    cloud.leagueHistory = undefined;
    global.localStorage._m = {};
    global.window.__leagueByeReport = [];
    if (global.window.GlobalFieldLocks) global.window.GlobalFieldLocks.reset();
    const _origLog = console.log; console.log = () => {};
    Leagues.processRegularLeagues(makeContext());
    console.log = _origLog;
    const hist = cloud.leagueHistory || {};
    const perLeague = {};
    [L2, L3, L4].forEach(LG => {
        const games = (hist.gameLog && hist.gameLog[LG] && hist.gameLog[LG][DAY]) || [];
        const byTeam = {};
        games.forEach(e => { [e.t1, e.t2].forEach(t => { if (t) (byTeam[t] = byTeam[t] || []).push(e.sport); }); });
        perLeague[LG] = byTeam;
    });
    return perLeague;
}

for (let iter = 1; iter <= 6; iter++) {
    const perLeague = run();
    for (const LG of [L2, L3, L4]) {
        const byTeam = perLeague[LG];
        const leagueSports = new Set();
        for (const team of Object.keys(byTeam)) {
            const sports = byTeam[team];
            sports.forEach(s => leagueSports.add(s));
            const counts = {};
            sports.forEach(s => { counts[s] = (counts[s] || 0) + 1; });
            const worst = Math.max(0, ...Object.values(counts));
            assert.ok(worst < 5,
                `iter ${iter}: ${LG} / ${team} played one sport ${worst}x of ${sports.length} games ` +
                `(${JSON.stringify(counts)}) — starved onto one sport, fair-share rotation failed`);
        }
        assert.ok(leagueSports.size >= 3,
            `iter ${iter}: ${LG} only touched ${leagueSports.size} sport(s) [${[...leagueSports].join(', ')}] ` +
            `across the whole grade — the scarce sports were monopolized by the other grades`);
    }
}
console.log('✅ TEST 1 — 6/6 runs: every grade touched >= 3 sports on a shared 6-game day; no team stuck 5x on one sport');

console.log('\n🎉 league_multiday_share_rotation_sim: ALL TESTS PASSED');
