// =============================================================================
// league_first_time_sport_reservation_sim.js
// -----------------------------------------------------------------------------
// "We can't have it that just because they're the youngest they only get
// basketball — the system has to RESERVE it for them if they haven't had it."
//
// The need-first apportionment weights a league by _sportNeed, which SUMS every
// team's deficit. That scales with ROSTER SIZE, not with starvation: a 4-team
// league that has NEVER played hockey (9/team → weight 36) still loses both
// hockey fields to a 10-team league that is only mildly behind (4/team → 40).
// Over largest-remainder apportionment of 2 fields across 6 leagues, the small
// leagues cannot win a scarce sport at all — and the participation floor can
// only donate from SURPLUS, which is only ever the abundant sport. So the
// junior grades get basketball, every period, all season.
//
// Live 2026-08-03, 3rd Grade: {Basketball:1, Football:0, Hockey:0, Newcomb:0}
// in every period of the day, always on the same leftover court.
//
//   TEST 1 — the inequity itself: with the reservation OFF, the small starved
//            league gets ZERO cap on the scarce sport it has never played.
//   TEST 2 — with it ON, that league is seated on the scarce sport.
//   TEST 3 — the transfer invents no capacity: each sport's total is unchanged
//            and never exceeds the fields that exist, and the donor keeps seats.
//   TEST 4 — it does NOT fire for a league that has already played the sport.
//   TEST 5 — one reservation per league per period (no cap churn).
//   TEST 6 — end to end through the real engine: the junior league actually
//            gets a non-basketball game on the day.
// =============================================================================

'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

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
    divisionTimes: {},
    addEventListener: () => {},
    CustomEvent: function CustomEvent(type, opts) { this.type = type; this.detail = (opts || {}).detail; },
    dispatchEvent: () => true,
    loadAllDailyData: () => ({}),
    getFieldsInZone: () => [],
};
global.document = { readyState: 'complete', addEventListener: () => {} };

// ★ Load the REAL lock module. Without it the leagues never time-lock each
//   other off a shared court, both take the one rink, and an end-to-end test
//   passes for the wrong reason (seen while writing this: the juniors "got"
//   hockey pre-fix only because the seniors' lock was never applied).
//   Seniority order likewise has to be real, or the engine never runs
//   senior→junior and there is no drain to protect the juniors from.
(0, eval)(fs.readFileSync(path.join(__dirname, '..', 'global_field_locks.js'), 'utf8'));
assert.ok(global.window.GlobalFieldLocks, 'GlobalFieldLocks loaded');
global.window.getDivisionAgeOrder = (names) =>
    ['Seniors', 'Juniors'].filter(n => (names || []).indexOf(n) >= 0);

const origLog = console.log;
const origWarn = console.warn;
console.log = () => {};
require('../scheduler_core_leagues.js');
console.log = origLog;
const Leagues = global.window.SchedulerCoreLeagues;
assert.ok(Leagues && typeof Leagues.processRegularLeagues === 'function', 'engine loaded');

// ---------------------------------------------------------------------------
// The live shape, shrunk: one big league and one small one sharing an abundant
// sport (Basketball) and a scarce one (Hockey, a single rink). SENIOR is bigger
// AND already plays hockey; JUNIOR is small and has NEVER had it. Under the
// summed need weighting SENIOR wins the rink on roster size alone.
// ---------------------------------------------------------------------------
const SENIOR = 'Senior League';
const JUNIOR = 'Junior League';
const SENIOR_TEAMS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10'];
const JUNIOR_TEAMS = ['J1', 'J2', 'J3', 'J4'];
const DIVS = { Seniors: { bunks: ['SB1'] }, Juniors: { bunks: ['JB1'] } };
// ★ Five courts and one rink against 7 wanted games — the camp is SHORT, which
//   is the regime this bug lives in. Two calibration notes, both learned the
//   hard way while writing this:
//   • With plenty of SURPLUS the participation floor already rescues the
//     juniors on its own: it spreads a league's floor across its sports, so its
//     second transfer hands over the rink and there is no bug left to fix. The
//     live camp had no surplus anywhere (17 games wanted, 12 fields), so the
//     floor managed exactly ONE transfer per junior league — basketball.
//   • Squeeze it too far and the seniors legitimately need every field, so the
//     cap's fallback gives them the rink no matter what; reserving would only
//     buy the juniors a bye.
//   These numbers reproduce the live cap table exactly:
//   Senior {Basketball:4, Hockey:1}, Junior {Basketball:1, Hockey:0}.
const N_COURTS = 5;
const FIELDS = [];
for (let i = 1; i <= N_COURTS; i++) FIELDS.push({ name: 'Court ' + i, activities: ['Basketball'] });
FIELDS.push({ name: 'The Rink', activities: ['Hockey'] });
const PAST = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-06', '2026-07-07',
              '2026-07-08', '2026-07-09', '2026-07-10', '2026-07-13'];
const TODAY = '2026-07-14';

// Nine days of history. Every team of both leagues plays plenty of basketball;
// only the SENIOR teams ever see the rink. So JUNIOR's per-team hockey deficit
// is the largest in the camp, and its summed weight is still the smallest.
function buildHistory(juniorHockeyDays) {
    const gameLog = { [SENIOR]: {}, [JUNIOR]: {} };
    PAST.forEach((d, i) => {
        gameLog[SENIOR][d] = [];
        gameLog[JUNIOR][d] = [];
        // ★ The seniors' last two days are Football (a sport with no field
        //   today, so it never enters the pool). Without it every senior team
        //   carries a 9-day basketball streak, and the HARD streak cap — no
        //   sport more than 2 game-days running, which outranks the fair-share
        //   cap — shoves them onto the rink no matter what their hockey cap
        //   says. That is the engine behaving correctly on an unrealistic
        //   fixture, not a bug: real teams get variety.
        const senIsTail = i >= PAST.length - 2;
        for (let k = 0; k < SENIOR_TEAMS.length; k += 2) {
            gameLog[SENIOR][d].push({
                t1: SENIOR_TEAMS[k], t2: SENIOR_TEAMS[k + 1],
                sport: senIsTail ? 'Football' : (k === 0 ? 'Hockey' : 'Basketball'),
                g: 'Game ' + (i + 1),
            });
        }
        const jSport = (juniorHockeyDays || []).indexOf(d) >= 0 ? 'Hockey' : 'Basketball';
        for (let k = 0; k < JUNIOR_TEAMS.length; k += 2) {
            gameLog[JUNIOR][d].push({
                t1: JUNIOR_TEAMS[k], t2: JUNIOR_TEAMS[k + 1],
                sport: jSport, g: 'Game ' + (i + 1),
            });
        }
    });
    return {
        gamesPerDate: {}, gameLog: gameLog, chinuchByDate: {}, byesByDate: {},
        ocTripsByDate: {}, offCampusCounts: {}, _tombstones: {},
    };
}

function makeContext() {
    return {
        schedulableSlotBlocks: [
            { type: 'league', event: 'League Time', divName: 'Seniors', leagueName: SENIOR, startTime: 780, endTime: 840, slots: [0] },
            { type: 'league', event: 'League Time', divName: 'Juniors', leagueName: JUNIOR, startTime: 780, endTime: 840, slots: [0] },
        ],
        masterLeagues: {
            [SENIOR]: { name: SENIOR, enabled: true, divisions: ['Seniors'], teams: SENIOR_TEAMS.slice(), sports: ['Basketball', 'Hockey'], schedulingPriority: 'sport_variety' },
            [JUNIOR]: { name: JUNIOR, enabled: true, divisions: ['Juniors'], teams: JUNIOR_TEAMS.slice(), sports: ['Basketball', 'Hockey'], schedulingPriority: 'sport_variety' },
        },
        disabledLeagues: [],
        divisions: DIVS,
        fillBlock: function (block, pick) { block._filled = true; block._pick = pick; },
        fieldUsageBySlot: {}, activityProperties: {}, rotationHistory: {},
        fields: FIELDS, disabledFields: [],
    };
}

// Run a generation and capture the cap table the engine logged for this slot.
function run(opts) {
    opts = opts || {};
    global.localStorage._m = {};
    settings.leagueHistory = buildHistory(opts.juniorHockeyDays);
    global.window.currentScheduleDate = TODAY;
    global.window._activeGenDate = TODAY;
    global.window.divisionTimes = { Seniors: [{ startMin: 780, endMin: 840 }], Juniors: [{ startMin: 780, endMin: 840 }] };
    global.window.GlobalFieldLocks.reset();   // locks are per-run
    if (opts.reservationOff) global.window.__leagueSportReservation = false;

    const lines = [];
    const ctx = makeContext();
    console.log = (...a) => { lines.push(a.join(' ')); };
    console.warn = () => {};
    try { Leagues.processRegularLeagues(ctx); }
    finally {
        console.log = origLog; console.warn = origWarn;
        delete global.window.__leagueSportReservation;
    }

    const capLine = lines.filter(l => l.indexOf('Need-first sport caps') >= 0).pop() || '';
    const caps = {};
    [SENIOR, JUNIOR].forEach(name => {
        const m = capLine.match(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=(\\{[^}]*\\})'));
        caps[name] = m ? JSON.parse(m[1]) : null;
    });
    const sports = {};
    ctx.schedulableSlotBlocks.forEach(b => {
        const p = b._pick; if (!p) return;
        sports[b.divName] = (p._allMatchups || []).join(' | ');
    });
    return {
        caps: caps,
        reservations: lines.filter(l => l.indexOf('First-time reservation') >= 0),
        sports: sports,
        assigned: lines.filter(l => l.indexOf('[SportVariety]') >= 0),
    };
}

(async () => {

// ---- TEST 1: the inequity, with the reservation switched off ---------------
{
    const r = run({ reservationOff: true });
    assert.ok(r.caps[JUNIOR], 'cap table was logged: ' + JSON.stringify(r.caps));
    assert.strictEqual(r.caps[JUNIOR].Hockey, 0,
        'expected the small league to be shut out of hockey pre-fix: ' + JSON.stringify(r.caps));
    assert.ok((r.caps[SENIOR].Hockey || 0) > 0,
        'expected the big league to take the rink pre-fix: ' + JSON.stringify(r.caps));
    assert.strictEqual(r.reservations.length, 0, 'reservation ran despite the killswitch');
    console.log('✅ TEST 1 — pre-fix the never-played league gets Hockey:0 ' + JSON.stringify(r.caps));
}

// ---- TEST 2: the reservation seats it --------------------------------------
{
    const r = run();
    assert.ok((r.caps[JUNIOR].Hockey || 0) > 0,
        'the league that has never played hockey still got no cap on it: ' + JSON.stringify(r.caps));
    assert.strictEqual(r.reservations.length, 1,
        'expected exactly one reservation: ' + JSON.stringify(r.reservations));
    assert.ok(/Hockey/.test(r.reservations[0]), 'reserved the wrong sport: ' + r.reservations[0]);
    console.log('✅ TEST 2 — reserved: ' + r.reservations[0].trim());
}

// ---- TEST 3: the transfer never invents capacity ---------------------------
// It hands ONE unit of the scarce sport across, so each sport's total must be
// unchanged and must never exceed the fields that actually exist. (Per-LEAGUE
// totals do move — that is the point, and the participation floor below the
// reservation is what re-seats the donor.)
{
    const off = run({ reservationOff: true });
    const on = run();
    const FIELDS_BY_SPORT = { Basketball: N_COURTS, Hockey: 1 };
    const totalForSport = (caps, sp) => [SENIOR, JUNIOR].reduce((a, n) => a + (caps[n][sp] || 0), 0);
    ['Basketball', 'Hockey'].forEach(sp => {
        assert.strictEqual(totalForSport(on.caps, sp), totalForSport(off.caps, sp),
            sp + ' total changed: ' + JSON.stringify(on.caps) + ' vs ' + JSON.stringify(off.caps));
        assert.ok(totalForSport(on.caps, sp) <= FIELDS_BY_SPORT[sp],
            sp + ' caps exceed the fields that exist: ' + JSON.stringify(on.caps));
    });
    // And the donor is not stripped bare — it still holds seats to play with.
    const donorTotal = Object.values(on.caps[SENIOR]).reduce((a, b) => a + b, 0);
    assert.ok(donorTotal > 0, 'the donor was zeroed out: ' + JSON.stringify(on.caps));
    console.log('✅ TEST 3 — transfer conserves each sport, donor keeps ' + donorTotal + ' seats ' + JSON.stringify(on.caps));
}

// ---- TEST 4: not a first-timer → no reservation ----------------------------
{
    const r = run({ juniorHockeyDays: ['2026-07-01', '2026-07-02'] });
    assert.strictEqual(r.reservations.length, 0,
        'reserved a sport the league has already played: ' + JSON.stringify(r.reservations));
    console.log('✅ TEST 4 — a league that has had the sport gets no reservation');
}

// ---- TEST 5: one reservation per league per period -------------------------
{
    const r = run();
    const byLeague = {};
    r.reservations.forEach(l => {
        const m = l.match(/held for "([^"]+)"/);
        if (m) byLeague[m[1]] = (byLeague[m[1]] || 0) + 1;
    });
    Object.keys(byLeague).forEach(n => assert.ok(byLeague[n] <= 1,
        n + ' reserved more than once in a period: ' + JSON.stringify(r.reservations)));
    console.log('✅ TEST 5 — at most one reservation per league per period');
}

// ---- TEST 6: end to end — the junior league actually plays hockey ----------
{
    const off = run({ reservationOff: true });
    const on = run();
    assert.ok(!/Hockey/.test(off.sports.Juniors || ''),
        'fixture is not adversarial — the juniors already got hockey pre-fix: ' + off.sports.Juniors);
    assert.ok(/Hockey/.test(on.sports.Juniors || ''),
        'the juniors still did not get on the rink: ' + JSON.stringify(on.sports));
    console.log('✅ TEST 6 — juniors on the day: "' + (on.sports.Juniors || '').trim()
        + '" (pre-fix: "' + (off.sports.Juniors || '').trim() + '")');
}

console.log('\n🎉 league_first_time_sport_reservation_sim: all tests passed');
})().catch(e => { console.error('❌', e && e.message ? e.message : e); process.exit(1); });
