// =============================================================================
// league_adjacent_day_sim.js
// -----------------------------------------------------------------------------
// Drives the REAL SchedulerCoreLeagues.processRegularLeagues to prove two
// live-reported failures stay fixed:
//
//   1. ADJACENT-GAME-DAY OPPONENT GUARD (metAdjacent in chooseDailyMatchups):
//      the pairing optimizer only counts meetings on dates ≤ dayId, so a date
//      generated while a LATER date already had games was blind to it — both
//      days were computed from the identical history prefix and the
//      deterministic exact-search picked the IDENTICAL pairings (observed
//      live: the same two teams met 3 days in a row after middle-day regens).
//      TEST 1 — sequential 12-day season: no pair ever meets on consecutive
//               days (sanity for the guard's "previous day" side).
//      TEST 2 — out-of-order generation (day 4 before day 3): day 3 must not
//               duplicate day 4's pairings (the "next day" side).
//      TEST 3 — middle-day regen: after regenerating day 3 of 6, its pairings
//               must not collide with day 2 or day 4.
//      TEST 4 — killswitch (__leagueAdjacentDayOpponentGuard=false) restores
//               the old behavior on the out-of-order seed, proving causality.
//      TEST 5 — 2-team league: adjacent rematch unavoidable → game still runs.
//
//   2. PAIR-REMATCH SPORT REPAIR (lexicographic replay reduction in
//      _swapReoptimizeAssignments + pair-aware cycle rescue): when a rematch
//      lands on the leftover field, the pair could replay the exact sport it
//      already played together (observed live). The swap pass now takes any
//      legal trade (incl. 3-way rotations) that strictly reduces replays.
//      TEST 6 — 12-day season with 6 sports: ZERO avoidable rematch-sport
//               replays (a replay only allowed if every alternative is
//               hard-blocked, which never happens with 6 sports).
// =============================================================================

'use strict';
const assert = require('assert');

const cloud = {};
global.localStorage = {
    _m: {},
    getItem(k) { return this._m[k] != null ? this._m[k] : null; },
    setItem(k, v) { this._m[k] = String(v); },
    removeItem(k) { delete this._m[k]; },
};
global.window = {
    loadGlobalSettings: () => ({ leagueHistory: cloud.leagueHistory }),
    saveGlobalSettings: (k, v) => { cloud[k] = v; },
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
assert.ok(Leagues && typeof Leagues.processRegularLeagues === 'function', 'module loaded');

const LG = 'Test League';
const TEAMS = ['Team 1', 'Team 2', 'Team 3', 'Team 4', 'Team 5', 'Team 6'];
const pairKey = (a, b) => [a, b].sort().join('|');
const fieldsFor = (sportCounts) => Object.entries(sportCounts).flatMap(([sport, n]) =>
    Array.from({ length: n }, (_, i) => ({ name: sport + ' Field ' + (i + 1), activities: [sport] })));

function makeContext(fields, mode, teams) {
    const sports = [...new Set(fields.flatMap(f => f.activities))];
    return {
        schedulableSlotBlocks: [{
            type: 'league', event: 'League Time', divName: 'Juniors',
            leagueName: LG, startTime: 780, endTime: 840, slots: [0],
        }],
        masterLeagues: {
            [LG]: { name: LG, enabled: true, divisions: ['Juniors'], teams: teams || TEAMS, sports, schedulingPriority: mode },
        },
        disabledLeagues: [],
        divisions: { Juniors: { bunks: ['J1'], startTime: '10:50 AM', endTime: '3:45 PM' } },
        fillBlock: function (block) { block._filled = true; },
        fieldUsageBySlot: {}, activityProperties: {}, rotationHistory: {},
        fields, disabledFields: [],
    };
}

function gen(date, fields, mode, teams) {
    global.window.currentScheduleDate = date;
    global.window._activeGenDate = date;
    console.log = () => {};
    try { Leagues.processRegularLeagues(makeContext(fields, mode, teams)); }
    finally { console.log = origLog; }
}
const gamesOn = (date) => ((cloud.leagueHistory || {}).gameLog?.[LG]?.[date]) || [];
const reset = () => { cloud.leagueHistory = undefined; global.localStorage._m = {}; };
const pairsOn = (date) => new Set(gamesOn(date).map(g => pairKey(g.t1, g.t2)));

const FIELDS6 = fieldsFor({ Basketball: 1, Soccer: 1, Hockey: 1, Kickball: 1, Baseball: 1, Volleyball: 1 });
const DATES = Array.from({ length: 12 }, (_, i) => '2026-07-' + String(i + 1).padStart(2, '0'));

// ---- TEST 1: sequential season — no consecutive-day rematch, either mode ----
for (const mode of ['matchup_variety', 'sport_variety']) {
    reset();
    DATES.forEach(d => gen(d, FIELDS6, mode));
    for (let i = 1; i < DATES.length; i++) {
        const prev = pairsOn(DATES[i - 1]);
        gamesOn(DATES[i]).forEach(g => {
            const pk = pairKey(g.t1, g.t2);
            assert.ok(!prev.has(pk), `TEST1[${mode}]: ${pk} met on consecutive days ${DATES[i - 1]} and ${DATES[i]}`);
        });
    }
    console.log(`✅ TEST 1 (${mode}) — 12 sequential days: no pair meets on consecutive days`);
}

// ---- TEST 2: out-of-order — day generated BEFORE an existing later day ----
{
    reset();
    ['2026-07-01', '2026-07-02', '2026-07-04'].forEach(d => gen(d, FIELDS6, 'matchup_variety'));
    gen('2026-07-03', FIELDS6, 'matchup_variety');   // generated LAST, with 07-04 already on the books
    const d4 = pairsOn('2026-07-04');
    gamesOn('2026-07-03').forEach(g => {
        const pk = pairKey(g.t1, g.t2);
        assert.ok(!d4.has(pk), `TEST2: ${pk} duplicated on 07-03 and 07-04 (optimizer blind to the existing next day)`);
    });
    const d2 = pairsOn('2026-07-02');
    gamesOn('2026-07-03').forEach(g => {
        assert.ok(!d2.has(pairKey(g.t1, g.t2)), `TEST2: ${pairKey(g.t1, g.t2)} duplicated on 07-02 and 07-03`);
    });
    console.log('✅ TEST 2 — out-of-order generation: day 3 avoids both day 2 and the pre-existing day 4 pairings');
}

// ---- TEST 3: middle-day regen — new pairings avoid both neighbors ----
{
    reset();
    DATES.slice(0, 6).forEach(d => gen(d, FIELDS6, 'matchup_variety'));
    gen('2026-07-03', FIELDS6, 'matchup_variety');   // regenerate the middle day
    const d2 = pairsOn('2026-07-02'), d4 = pairsOn('2026-07-04');
    gamesOn('2026-07-03').forEach(g => {
        const pk = pairKey(g.t1, g.t2);
        assert.ok(!d2.has(pk), `TEST3: regen'd 07-03 duplicated ${pk} from 07-02`);
        assert.ok(!d4.has(pk), `TEST3: regen'd 07-03 duplicated ${pk} from 07-04`);
    });
    console.log('✅ TEST 3 — middle-day regen: no collision with the previous or next day');
}

// ---- TEST 4: killswitch restores the old (broken) behavior — causality ----
{
    reset();
    global.window.__leagueAdjacentDayOpponentGuard = false;
    try {
        ['2026-07-01', '2026-07-02', '2026-07-04'].forEach(d => gen(d, FIELDS6, 'matchup_variety'));
        gen('2026-07-03', FIELDS6, 'matchup_variety');
    } finally {
        delete global.window.__leagueAdjacentDayOpponentGuard;
    }
    const d4 = pairsOn('2026-07-04');
    const dup = gamesOn('2026-07-03').filter(g => d4.has(pairKey(g.t1, g.t2))).length;
    assert.strictEqual(dup, 3,
        `TEST4: with the guard OFF, 07-03 must fully duplicate 07-04's pairings (same history prefix, deterministic optimizer) — got ${dup}/3`);
    console.log('✅ TEST 4 — killswitch reproduces the pre-fix duplicate day (proves the guard is the fix)');
}

// ---- TEST 5: 2-team league — adjacent rematch unavoidable, game still runs ----
{
    reset();
    const two = ['Team 1', 'Team 2'];
    ['2026-07-01', '2026-07-02', '2026-07-03'].forEach(d => gen(d, fieldsFor({ Basketball: 1, Soccer: 1, Hockey: 1 }), 'matchup_variety', two));
    ['2026-07-01', '2026-07-02', '2026-07-03'].forEach(d => {
        assert.strictEqual(gamesOn(d).length, 1, `TEST5: the only possible matchup must still play on ${d}`);
    });
    console.log('✅ TEST 5 — 2-team league: uniform penalty, game never dropped');
}

// ---- TEST 6: no avoidable rematch-sport replay across a 12-day season ----
{
    reset();
    DATES.forEach(d => gen(d, FIELDS6, 'matchup_variety'));
    const lastMeeting = {};
    DATES.forEach(date => gamesOn(date).forEach(g => {
        const pk = pairKey(g.t1, g.t2);
        const prev = lastMeeting[pk];
        assert.ok(!(prev && prev.sport && g.sport && prev.sport === g.sport),
            `TEST6: ${pk} replayed ${g.sport} (met ${prev && prev.date}, again ${date}) with 6 sports available`);
        lastMeeting[pk] = { date, sport: g.sport };
    }));
    console.log('✅ TEST 6 — 12-day season, 6 sports: every rematch got a sport the pair had not played together');
}

console.log('\n🎉 league_adjacent_day_sim: ALL TESTS PASSED');
