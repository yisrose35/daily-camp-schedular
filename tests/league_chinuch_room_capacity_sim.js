// =============================================================================
// league_chinuch_room_capacity_sim.js
// -----------------------------------------------------------------------------
// Chinuch teams are assigned a room each, and several teams usually name the
// SAME room. The period plan used to pour teams into periods by shuffled order
// alone, so three teams sharing one Beis Medrash could all be sent there in the
// same period — a physical double-book nothing else catches, because chinuch
// never enters the field-lock system. Drives the REAL engine:
//
//   TEST 1 — capacity resolution order: per-league override > the room's
//            Facilities capacity > 1; an unnamed room is unconstrained.
//   TEST 2 — 4 teams, 2 rooms holding 1 each, 2 league periods: no period
//            ever seats two teams in the same room.
//   TEST 3 — raising a room's capacity lets its teams learn together again.
//   TEST 4 — over-subscribed room: more teams than any number of periods can
//            seat → the ones that don't fit play instead of being double-booked,
//            and they are never recorded as having attended.
//   TEST 5 — the constraint holds under the manual teams-per-session override
//            and under exact perSessionCounts, not just the auto plan.
//   TEST 6 — rooms are respected across a week AND the attendance ledger still
//            rotates: every team gets sessions, nobody is starved.
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

// Rooms live in the Facilities tab; capacity comes off their sharing rule.
const FACILITIES = [
    { name: 'Beis Medrash', sharableWith: { type: 'not_sharable', capacity: 1 } },
    { name: 'Room 3',       sharableWith: { type: 'not_sharable', capacity: 1 } },
    { name: 'Big Hall',     sharableWith: { type: 'custom', capacity: 4 } },
];

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
    getFacilities: () => FACILITIES,
};
global.document = { readyState: 'complete', addEventListener: () => {} };

const origLog = console.log;
const origWarn = console.warn;
console.log = () => {};
require('../scheduler_core_leagues.js');
console.log = origLog;
const Leagues = global.window.SchedulerCoreLeagues;
assert.ok(Leagues && typeof Leagues.processRegularLeagues === 'function', 'engine loaded');
assert.ok(typeof Leagues.chinuchRoomCapacity === 'function', 'chinuchRoomCapacity exported');

const LG = 'Chinuch Rooms League';
const TEAMS = ['T1', 'T2', 'T3', 'T4'];
const FIELDS = [
    { name: 'Court 1', activities: ['Basketball'] },
    { name: 'Court 2', activities: ['Soccer'] },
];
const BLOCKS = [
    { type: 'league', event: 'League Time', divName: 'Juniors', leagueName: LG, startTime: 780, endTime: 840, slots: [0] },
    { type: 'league', event: 'League Time', divName: 'Juniors', leagueName: LG, startTime: 840, endTime: 900, slots: [1] },
];

function makeContext(leagueCfg, blocks) {
    return {
        schedulableSlotBlocks: (blocks || BLOCKS).map(b => Object.assign({}, b)),
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
// The plan the engine committed to: team -> period start minute.
const planOf = () => Object.assign({}, global.window.chinuchSchedule[LG] || {});
// Every (period, room) pair that the plan books, so overflow is easy to spot.
function roomLoad(plan, rooms) {
    const load = {};
    Object.keys(plan).forEach(function (t) {
        const p = plan[t], r = rooms[t];
        if (!r) return;
        const k = p + '|' + r;
        (load[k] = load[k] || []).push(t);
    });
    return load;
}
function assertNoOverflow(plan, rooms, caps, label) {
    const load = roomLoad(plan, rooms);
    Object.keys(load).forEach(function (k) {
        const room = k.split('|')[1];
        const cap = caps[room];
        assert.ok(load[k].length <= cap,
            label + ': "' + room + '" holds ' + cap + ' but ' + load[k].length
            + ' teams were sent there in one period (' + load[k].join(', ') + ')');
    });
}

(async () => {

// ---- TEST 1: capacity resolution order --------------------------------------
{
    const base = { name: LG, teams: TEAMS.slice(), chinuch: { enabled: true, bunkFacilities: {}, roomCapacity: {} } };
    assert.strictEqual(Leagues.chinuchRoomCapacity(base, 'Beis Medrash', null), 1,
        'a not-sharable room holds one group');
    assert.strictEqual(Leagues.chinuchRoomCapacity(base, 'Big Hall', null), 4,
        'the room\'s Facilities capacity is used when the league says nothing');

    const withOverride = { name: LG, teams: TEAMS.slice(),
        chinuch: { enabled: true, bunkFacilities: {}, roomCapacity: { 'Beis Medrash': 3, 'Big Hall': 2 } } };
    assert.strictEqual(Leagues.chinuchRoomCapacity(withOverride, 'Beis Medrash', null), 3,
        'the per-league override wins over the Facilities default');
    assert.strictEqual(Leagues.chinuchRoomCapacity(withOverride, 'Big Hall', null), 2,
        'the override can also LOWER a room below its Facilities capacity');

    assert.strictEqual(Leagues.chinuchRoomCapacity(base, 'Nowhere Room', null), 1,
        'an unknown room is assumed to hold one group');
    assert.strictEqual(Leagues.chinuchRoomCapacity(base, '', null), Infinity,
        'a team with no room named is unconstrained');
    console.log('✅ TEST 1 — capacity resolves: league override > Facilities > 1');
}

// ---- TEST 2: two teams per room, capacity 1, must split across periods -------
{
    delete settings.leagueHistory; global.localStorage._m = {};
    const rooms = { T1: 'Beis Medrash', T2: 'Beis Medrash', T3: 'Room 3', T4: 'Room 3' };
    const caps = { 'Beis Medrash': 1, 'Room 3': 1 };
    gen('2026-07-01', { chinuch: { enabled: true, bunkFacilities: rooms, roomCapacity: {} } });
    const plan = planOf();
    assert.strictEqual(Object.keys(plan).length, 4, 'all four teams got a session: ' + JSON.stringify(plan));
    assertNoOverflow(plan, rooms, caps, 'T2');
    assert.notStrictEqual(plan.T1, plan.T2, 'the two Beis Medrash teams must be in different periods');
    assert.notStrictEqual(plan.T3, plan.T4, 'the two Room 3 teams must be in different periods');
    console.log('✅ TEST 2 — shared rooms split across periods ' + JSON.stringify(plan));
}

// ---- TEST 3: a bigger room lets them learn together -------------------------
{
    delete settings.leagueHistory; global.localStorage._m = {};
    const rooms = { T1: 'Big Hall', T2: 'Big Hall', T3: 'Big Hall', T4: 'Big Hall' };
    gen('2026-07-01', { chinuch: { enabled: true, bunkFacilities: rooms, roomCapacity: {} } });
    const plan = planOf();
    assert.strictEqual(Object.keys(plan).length, 4, 'all four learn: ' + JSON.stringify(plan));
    assertNoOverflow(plan, rooms, { 'Big Hall': 4 }, 'T3');
    // Capacity 4 does not FORCE them together, but it must allow it — with the
    // parity plan for 4 teams over 2 periods the hall takes 2 at a time.
    const perPeriod = {};
    Object.keys(plan).forEach(t => { perPeriod[plan[t]] = (perPeriod[plan[t]] || 0) + 1; });
    assert.ok(Math.max.apply(null, Object.values(perPeriod)) >= 2,
        'a room with room to spare should seat more than one team at a time: ' + JSON.stringify(plan));

    // Lowering it to 1 through the league override splits them right back up.
    delete settings.leagueHistory; global.localStorage._m = {};
    gen('2026-07-01', { chinuch: { enabled: true, bunkFacilities: rooms, roomCapacity: { 'Big Hall': 1 } } });
    const tight = planOf();
    assertNoOverflow(tight, rooms, { 'Big Hall': 1 }, 'T3-tight');
    assert.strictEqual(new Set(Object.values(tight)).size, Object.keys(tight).length,
        'at capacity 1 every seated team needs its own period: ' + JSON.stringify(tight));
    console.log('✅ TEST 3 — a bigger room seats teams together; lowering it splits them again');
}

// ---- TEST 4: over-subscribed room → the overflow plays, never double-books ---
{
    delete settings.leagueHistory; global.localStorage._m = {};
    // All four teams in a one-team room, but only two league periods exist:
    // at most two can learn today. The other two must PLAY, not be crammed in.
    const rooms = { T1: 'Beis Medrash', T2: 'Beis Medrash', T3: 'Beis Medrash', T4: 'Beis Medrash' };
    const ctx = gen('2026-07-01', { chinuch: { enabled: true, bunkFacilities: rooms, roomCapacity: {} } });
    const plan = planOf();
    assertNoOverflow(plan, rooms, { 'Beis Medrash': 1 }, 'T4');
    assert.ok(Object.keys(plan).length <= 2,
        'two periods × one seat = at most two sessions today: ' + JSON.stringify(plan));

    // The teams that didn't fit are not recorded as having attended — the
    // rotation ledger must not think they learned.
    const att = (settings.leagueHistory.chinuchByDate?.[LG]?.['2026-07-01'] || []).slice().sort();
    assert.deepStrictEqual(att, Object.keys(plan).sort(), 'attendance matches the plan exactly');

    // …and they show up on the tiles as playing, not silently missing.
    const lines = ctx.schedulableSlotBlocks.map(b => b._pick).filter(Boolean)
        .flatMap(p => p._allMatchups || []);
    const seated = new Set(Object.keys(plan));
    TEAMS.filter(t => !seated.has(t)).forEach(t => {
        assert.ok(lines.some(l => l.indexOf(t) >= 0),
            t + ' fit in no chinuch session and vanished from the schedule: ' + JSON.stringify(lines));
    });
    console.log('✅ TEST 4 — an over-subscribed room seats who it can; the rest play ' + JSON.stringify(plan));
}

// ---- TEST 5: the manual and exact-count modes honor rooms too ----------------
{
    const rooms = { T1: 'Beis Medrash', T2: 'Beis Medrash', T3: 'Room 3', T4: 'Room 3' };
    const caps = { 'Beis Medrash': 1, 'Room 3': 1 };

    delete settings.leagueHistory; global.localStorage._m = {};
    gen('2026-07-01', { chinuch: { enabled: true, teamsPerRound: 2, timesPerDay: 2, bunkFacilities: rooms, roomCapacity: {} } });
    const manual = planOf();
    assertNoOverflow(manual, rooms, caps, 'T5-manual');
    assert.strictEqual(Object.keys(manual).length, 4, 'manual mode still seats everyone: ' + JSON.stringify(manual));

    delete settings.leagueHistory; global.localStorage._m = {};
    gen('2026-07-01', { chinuch: { enabled: true, perSessionCounts: [2, 2], bunkFacilities: rooms, roomCapacity: {} } });
    const exact = planOf();
    assertNoOverflow(exact, rooms, caps, 'T5-exact');
    assert.strictEqual(Object.keys(exact).length, 4, 'exact counts still seat everyone: ' + JSON.stringify(exact));
    console.log('✅ TEST 5 — manual teams-per-session and exact per-session counts respect rooms');
}

// ---- TEST 6: a week of generations — rooms hold, rotation still fair ---------
{
    delete settings.leagueHistory; global.localStorage._m = {};
    // Three teams in the one-seat Beis Medrash, one in Room 3, two periods:
    // only some of the Beis Medrash teams can learn each day, so the ledger has
    // to rotate which ones.
    const rooms = { T1: 'Beis Medrash', T2: 'Beis Medrash', T3: 'Beis Medrash', T4: 'Room 3' };
    const caps = { 'Beis Medrash': 1, 'Room 3': 1 };
    const cfg = { chinuch: { enabled: true, bunkFacilities: rooms, roomCapacity: {} } };
    const attended = {}; TEAMS.forEach(t => attended[t] = 0);
    ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-06', '2026-07-07', '2026-07-08'].forEach(function (d) {
        gen(d, cfg);
        const plan = planOf();
        assertNoOverflow(plan, rooms, caps, 'T6 ' + d);
        Object.keys(plan).forEach(t => attended[t]++);
    });
    ['T1', 'T2', 'T3'].forEach(t => assert.ok(attended[t] > 0,
        t + ' never got a chinuch session all week: ' + JSON.stringify(attended)));
    const share = ['T1', 'T2', 'T3'].map(t => attended[t]);
    assert.ok(Math.max.apply(null, share) - Math.min.apply(null, share) <= 1,
        'the three teams sharing a room take turns: ' + JSON.stringify(attended));
    console.log('✅ TEST 6 — a week of shared rooms: no double-books, turns taken ' + JSON.stringify(attended));
}

console.log('\n🎉 league_chinuch_room_capacity_sim: ALL TESTS PASSED');

})().catch(e => { console.error(e); process.exit(1); });
