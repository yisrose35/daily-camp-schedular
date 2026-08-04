// =============================================================================
// league_bye_fieldshortage_rotation_sim.js
// -----------------------------------------------------------------------------
// LG-14 covered the STRUCTURAL bye: an odd roster benches somebody at PAIRING
// time, and makeByeLedger rotates who. It did not cover the other way a team
// sits out — the FIELD-SHORTAGE bye, decided one stage later.
//
// With an EVEN roster every team gets paired, so the pairing chooser (the only
// consumer of the ledger) sees no bye to rotate. Then the field stage finds
// fewer fields than matchups and strands whatever it reaches last. That order
// was sport-starvation only, with no bye term at all — so on a tie it ran down
// the same enumeration every period and benched the same teams.
//
// Observed live (2026-08-03, 3rd Grade: 4 teams, 1 court left after the senior
// leagues locked theirs): Team 2 sat out every period of the day while Team 1
// played every one.
//
//   TEST 1 — 4 teams / 1 field, sport_variety: every team takes a comparable
//            share of the byes, and a full rotation lands them dead even.
//            Pre-fix one team never sat out at all.
//   TEST 2 — same for matchup_variety.
//   TEST 3 — three periods in ONE day rotate the bye within the day, so a team
//            stranded at 9am is not stranded again at 10am and 11am.
//   TEST 4 — a seeded 5/3/1/1 bye gap CLOSES: the league catches up to the
//            most-benched team instead of leaving it stranded. With the fix off
//            on the same fixture the gap survives untouched.
//   TEST 5 — killswitch: window.__leagueByeFairness = false restores the old
//            order, so this can be turned off in the field like LG-14.
//   TEST 6 — a partial shortage (3 matchups, 2 fields) rotates the single bye.
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
    divisionTimes: { Juniors: [
        { startMin: 780, endMin: 840 }, { startMin: 840, endMin: 900 }, { startMin: 900, endMin: 960 },
    ] },
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

const LG = 'Field Shortage League';
// EVEN roster — every team is paired, so LG-14's pairing-time ledger never
// sees a bye. Two matchups, and only ever one field to put them on.
const TEAMS = ['T1', 'T2', 'T3', 'T4'];
const ONE_FIELD = [{ name: 'Court 1', activities: ['Basketball'] }];
const DAYS = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-06', '2026-07-07',
              '2026-07-08', '2026-07-09', '2026-07-10'];

const SLOT = (i) => ({
    type: 'league', event: 'League Time', divName: 'Juniors', leagueName: LG,
    startTime: 780 + i * 60, endTime: 840 + i * 60, slots: [i],
});

function makeContext(leagueCfg, blocks, fields, teams) {
    return {
        schedulableSlotBlocks: blocks || [SLOT(0)],
        masterLeagues: { [LG]: Object.assign({
            name: LG, enabled: true, divisions: ['Juniors'], teams: (teams || TEAMS).slice(),
            sports: ['Basketball'], schedulingPriority: 'sport_variety',
        }, leagueCfg || {}) },
        disabledLeagues: [],
        divisions: { Juniors: { bunks: ['J1'] } },
        fillBlock: function (block, pick) { block._filled = true; block._pick = pick; },
        fieldUsageBySlot: {}, activityProperties: {}, rotationHistory: {},
        fields: fields || ONE_FIELD, disabledFields: [],
    };
}
function gen(date, leagueCfg, blocks, fields, teams) {
    global.window.currentScheduleDate = date;
    global.window._activeGenDate = date;
    const ctx = makeContext(leagueCfg, blocks, fields, teams);
    console.log = () => {}; console.warn = () => {};
    try { Leagues.processRegularLeagues(ctx); }
    finally { console.log = origLog; console.warn = origWarn; }
    return ctx;
}
// Who sat out, per period, read off the tiles the engine actually wrote — the
// same list that feeds history.byesByDate.
function byesPerPeriod(ctx) {
    return ctx.schedulableSlotBlocks
        .map(b => b._pick).filter(Boolean)
        .map(p => (p._allMatchups || []).filter(l => /—\s*Bye/i.test(l)).map(l => l.split(' — ')[0]));
}
function reset() { delete settings.leagueHistory; global.localStorage._m = {}; }
function runSeason(cfg, days, teams) {
    reset();
    const roster = teams || TEAMS;
    const tally = {}; roster.forEach(t => tally[t] = 0);
    (days || DAYS).forEach(d => {
        byesPerPeriod(gen(d, cfg, null, null, roster))
            .forEach(list => list.forEach(t => { tally[t] = (tally[t] || 0) + 1; }));
    });
    return tally;
}
function spread(tally) {
    const v = Object.values(tally);
    return Math.max.apply(null, v) - Math.min.apply(null, v);
}
function days(n, from) {
    const out = [];
    let d = new Date(from || Date.UTC(2026, 6, 1));
    for (let i = 0; i < n; i++) { out.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() + 864e5); }
    return out;
}
// ★ Why the bound is 2 and not 1. The PAIRING is chosen upstream (opponent
// variety) with no knowledge that the fields will run short, so the field stage
// only ever gets to pick which of the given pairs sits — and a pairing can make
// perfect balance unreachable that period (with counts 3,3,4,4 and the pairs
// (T2,T4)/(T1,T3), either choice benches one 3 and one 4). The result is a
// bounded oscillation around even, not drift: TEST 1 pins it back to EXACTLY
// even after a full rotation. Pre-fix the same measure grew without limit —
// 20 apart after 30 days, with one team never benched once.
const MAX_SPREAD = 2;

(async () => {

// ---- TEST 1: sport_variety, 4 teams / 1 field ------------------------------
{
    const tally = runSeason({ schedulingPriority: 'sport_variety' });
    const total = Object.values(tally).reduce((a, b) => a + b, 0);
    assert.strictEqual(total, DAYS.length * 2, 'two teams stranded per period: ' + JSON.stringify(tally));
    TEAMS.forEach(t => assert.ok(tally[t] > 0,
        t + ' never sat out — the field-shortage bye is not rotating: ' + JSON.stringify(tally)));
    assert.ok(spread(tally) <= MAX_SPREAD,
        'field-shortage byes are not evenly shared: ' + JSON.stringify(tally));
    // …and a full rotation settles dead even, proving it oscillates around
    // balance rather than drifting away from it.
    const full = runSeason({ schedulingPriority: 'sport_variety' }, days(12));
    assert.strictEqual(spread(full), 0,
        'a full rotation did not land even: ' + JSON.stringify(full));
    const long = runSeason({ schedulingPriority: 'sport_variety' }, days(30));
    assert.ok(spread(long) <= MAX_SPREAD,
        'the gap grows over a long season: ' + JSON.stringify(long));
    console.log('✅ TEST 1 — sport_variety: byes shared ' + JSON.stringify(tally)
        + ', even after a full rotation ' + JSON.stringify(full));
}

// ---- TEST 2: matchup_variety -----------------------------------------------
{
    const tally = runSeason({ schedulingPriority: 'matchup_variety' });
    TEAMS.forEach(t => assert.ok(tally[t] > 0,
        t + ' never sat out in matchup_variety: ' + JSON.stringify(tally)));
    assert.ok(spread(tally) <= MAX_SPREAD, 'byes are not evenly shared: ' + JSON.stringify(tally));
    assert.strictEqual(spread(runSeason({ schedulingPriority: 'matchup_variety' }, days(30))), 0,
        'matchup_variety does not settle even over a long season');
    console.log('✅ TEST 2 — matchup_variety: field-shortage byes spread evenly ' + JSON.stringify(tally));
}

// ---- TEST 3: three periods in ONE day --------------------------------------
// The live report: same team benched every period of the same day.
{
    reset();
    const periods = byesPerPeriod(gen('2026-07-01', { schedulingPriority: 'sport_variety' },
        [SLOT(0), SLOT(1), SLOT(2)]));
    assert.strictEqual(periods.length, 3, 'three periods ran: ' + JSON.stringify(periods));
    const tally = {}; TEAMS.forEach(t => tally[t] = 0);
    periods.forEach(list => list.forEach(t => { tally[t]++; }));
    // THE live symptom: one team benched every single period of the day.
    assert.ok(Math.max.apply(null, Object.values(tally)) < 3,
        'a team sat out all three periods of one day: ' + JSON.stringify(periods));
    // ★ 2,2,2,0 is OPTIMAL here, not a miss. Each period benches one whole
    //   pair, so the day's six team-byes can only be split as 2,2,2,0 or worse
    //   (any split that reaches a fourth team puts a third bye on someone). So
    //   the bar is "nobody is benched more than twice", not an even spread.
    assert.ok(Object.values(tally).filter(n => n > 0).length >= 3,
        'the same teams took every bye in the day: ' + JSON.stringify(periods));
    console.log('✅ TEST 3 — the bye moves within a multi-period day ' + JSON.stringify(periods));
}

// ---- TEST 4: the ledger DECIDES, and it is the ledger that decides ---------
// Seed a history where T1 has been benched most, T2 next, and T3/T4 never —
// while T3/T4 are the ones with all the game history (so every sport/matchup
// signal argues for seating THEM again). The most-benched team must get the
// field. Run the identical fixture with the killswitch to prove the fixture is
// adversarial and that this change is what flips it.
//
// ★ Only T1 is asserted, not T1 AND T2: the pairing is chosen upstream and
//   routinely splits the two benched teams into different matchups, and one
//   whole matchup has to sit. Demanding both would be asking the field stage
//   to undo a pairing it never made.
{
    const seed = () => {
        reset();
        settings.leagueHistory = {
            gamesPerDate: {}, gameLog: { [LG]: {
                '2026-06-01': [{ t1: 'T3', t2: 'T4', sport: 'Basketball', g: 'Game 1' }],
                '2026-06-02': [{ t1: 'T3', t2: 'T4', sport: 'Basketball', g: 'Game 2' }],
                '2026-06-03': [{ t1: 'T3', t2: 'T4', sport: 'Basketball', g: 'Game 3' }],
                '2026-06-04': [{ t1: 'T2', t2: 'T3', sport: 'Basketball', g: 'Game 4' }],
                '2026-06-05': [{ t1: 'T2', t2: 'T4', sport: 'Basketball', g: 'Game 5' }],
            } },
            chinuchByDate: {}, byesByDate: { [LG]: {
                '2026-06-01': ['T1', 'T2'], '2026-06-02': ['T1', 'T2'], '2026-06-03': ['T1', 'T2'],
                '2026-06-04': ['T1', 'T4'], '2026-06-05': ['T1', 'T3'],
            } },
            ocTripsByDate: {}, offCampusCounts: {}, _tombstones: {},
        };
    };
    // Seeded standing: T1 5 byes, T2 3, T3 1, T4 1 — spread 4.
    const SEEDED = { T1: 5, T2: 3, T3: 1, T4: 1 };
    function catchUp(fairnessOff) {
        seed();
        if (fairnessOff) global.window.__leagueByeFairness = false;
        const total = Object.assign({}, SEEDED);
        try {
            days(8, Date.UTC(2026, 5, 8)).forEach(d => {
                byesPerPeriod(gen(d, { schedulingPriority: 'sport_variety' }))
                    .forEach(list => list.forEach(t => { total[t]++; }));
            });
        } finally { if (fairnessOff) delete global.window.__leagueByeFairness; }
        return total;
    }
    const on = catchUp(false);
    const off = catchUp(true);
    assert.ok(spread(off) >= 4,
        'fixture is not adversarial — the old order closed the gap by itself: ' + JSON.stringify(off));
    assert.ok(spread(on) <= 1,
        'the league did not catch up to the most-benched team: ' + JSON.stringify(on));
    console.log('✅ TEST 4 — a seeded 5/3/1/1 gap closes to ' + JSON.stringify(on)
        + ' (fairness off, it stays ' + JSON.stringify(off) + ')');
}

// ---- TEST 5: killswitch ----------------------------------------------------
{
    global.window.__leagueByeFairness = false;
    let tally, longTally;
    try {
        tally = runSeason({ schedulingPriority: 'sport_variety' });
        longTally = runSeason({ schedulingPriority: 'sport_variety' }, days(30));
    } finally { delete global.window.__leagueByeFairness; }
    assert.ok(spread(tally) > MAX_SPREAD,
        'the killswitch did not restore the old (unfair) order: ' + JSON.stringify(tally));
    // This is the bug in one line: with fairness off a team is benched ZERO
    // times while its league-mates take every bye, and the gap only widens.
    assert.ok(Object.values(longTally).some(n => n === 0),
        'expected the pre-fix order to leave a team never benched: ' + JSON.stringify(longTally));
    assert.ok(spread(longTally) >= 15,
        'expected the pre-fix gap to grow without bound: ' + JSON.stringify(longTally));
    console.log('✅ TEST 5 — killswitch restores the pre-fix order ' + JSON.stringify(tally)
        + ' (30 days: ' + JSON.stringify(longTally) + ')');
}

// ---- TEST 6: partial shortage — 6 teams, 3 matchups, 2 fields --------------
{
    const SIX = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'];
    const TWO_FIELDS = [
        { name: 'Court 1', activities: ['Basketball'] },
        { name: 'Court 2', activities: ['Basketball'] },
    ];
    reset();
    const tally = {}; SIX.forEach(t => tally[t] = 0);
    DAYS.forEach(d => {
        byesPerPeriod(gen(d, { schedulingPriority: 'sport_variety' }, null, TWO_FIELDS, SIX))
            .forEach(list => list.forEach(t => { tally[t] = (tally[t] || 0) + 1; }));
    });
    SIX.forEach(t => assert.ok(tally[t] > 0,
        t + ' never sat out with a partial shortage: ' + JSON.stringify(tally)));
    assert.ok(spread(tally) <= MAX_SPREAD, 'the single bye is not rotating: ' + JSON.stringify(tally));
    console.log('✅ TEST 6 — a partial shortage rotates its bye too ' + JSON.stringify(tally));
}

console.log('\n🎉 league_bye_fieldshortage_rotation_sim: all tests passed');
})().catch(e => { console.error('❌', e && e.message ? e.message : e); process.exit(1); });
