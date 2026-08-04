// =============================================================================
// league_first_time_sport_reservation_sim.js
// -----------------------------------------------------------------------------
// "We can't have it that just because they're the youngest they only get
// basketball — the system has to RESERVE it for them if they haven't had it."
//
// The need-first apportionment weights a league by _sportNeed, which SUMS every
// team's deficit. That scales with ROSTER SIZE, not with starvation: a 4-team
// league 9 games/team behind on hockey (weight 36) loses the rink to a 10-team
// league only 4/team behind (weight 40). Under largest-remainder apportionment
// of a scarce sport across many leagues, the small leagues cannot win one at
// all — and the participation floor can only donate from SURPLUS, which is only
// ever the abundant sport. So the junior grades get basketball, every period.
//
// Live 2026-08-03 AND again on 08-04 after the first cut of this fix, 3rd Grade
// ran {Basketball:1, Football:0, Hockey:0, Newcomb:0} in every period of the
// day — at 12:10 with Hockey(Rink) OPEN in front of it.
//
// Two separate rules come out of that, tested separately here:
//   RESERVATION      — rank by PER-TEAM starvation and move one unit of a
//                      scarce sport to the league furthest behind on it.
//   CAP RELEASE      — a cap exists to leave a field for the leagues processed
//                      AFTER this one; for a sport nobody later plays it
//                      protects no one, so it is dropped.
//
//   TEST 1 — the inequity: with the reservation OFF, the starved mid-order
//            league gets ZERO cap on the scarce sport.
//   TEST 2 — with it ON, that league is seated on the scarce sport.
//   TEST 3 — the transfer invents no capacity: each sport's total is unchanged
//            and never exceeds the fields that exist, and the donor keeps seats.
//   TEST 4 — the gate is BEING BEHIND, not never having played: a caught-up
//            league gets nothing, a league still behind is reserved for.
//   TEST 5 — one reservation per league per period (no cap churn).
//   TEST 6 — end to end through the real engine: the junior league actually
//            moves off the basketball court and onto the rink.
//   TEST 7 — the last league's caps are released, and the killswitch restores
//            them. A senior league keeps its caps — later leagues want those.
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
    ['Seniors', 'Juniors', 'Youngest'].filter(n => (names || []).indexOf(n) >= 0);

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
// ★ A third, youngest league sits BELOW Junior in the order. It is here so that
//   Junior is mid-order and its caps still mean something: the separate
//   "release what nobody is waiting for" rule (TEST 7) deletes the caps of the
//   LAST league outright, which would otherwise fix this fixture on its own and
//   leave the reservation untested. It also plays Hockey — a sport no later
//   league wants is exactly what that rule releases.
const YOUNGEST = 'Youngest League';
const SENIOR_TEAMS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10'];
const JUNIOR_TEAMS = ['J1', 'J2', 'J3', 'J4'];
const YOUNGEST_TEAMS = ['Y1', 'Y2'];
const DIVS = { Seniors: { bunks: ['SB1'] }, Juniors: { bunks: ['JB1'] }, Youngest: { bunks: ['YB1'] } };
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
function buildHistory(juniorHockeyDays, youngestHockeyDays, juniorFootballDays) {
    const gameLog = { [SENIOR]: {}, [JUNIOR]: {}, [YOUNGEST]: {} };
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
        // Football has no field today, so it never enters the pool — it exists
        // only to raise this league's BASKETBALL deficit, so the apportionment
        // hands it a basketball cap alongside the reserved one. Two caps against
        // one wanted game is what makes the floor see surplus.
        const jSport = (juniorHockeyDays || []).indexOf(d) >= 0 ? 'Hockey'
            : ((juniorFootballDays || []).indexOf(d) >= 0 ? 'Football' : 'Basketball');
        for (let k = 0; k < JUNIOR_TEAMS.length; k += 2) {
            gameLog[JUNIOR][d].push({
                t1: JUNIOR_TEAMS[k], t2: JUNIOR_TEAMS[k + 1],
                sport: jSport, g: 'Game ' + (i + 1),
            });
        }
        gameLog[YOUNGEST][d] = [{
            t1: YOUNGEST_TEAMS[0], t2: YOUNGEST_TEAMS[1],
            sport: (youngestHockeyDays || []).indexOf(d) >= 0 ? 'Hockey' : 'Basketball',
            g: 'Game ' + (i + 1),
        }];
    });
    return {
        gamesPerDate: {}, gameLog: gameLog, chinuchByDate: {}, byesByDate: {},
        ocTripsByDate: {}, offCampusCounts: {}, _tombstones: {},
    };
}

function makeContext(juniorTeams) {
    return {
        schedulableSlotBlocks: [
            { type: 'league', event: 'League Time', divName: 'Seniors', leagueName: SENIOR, startTime: 780, endTime: 840, slots: [0] },
            { type: 'league', event: 'League Time', divName: 'Juniors', leagueName: JUNIOR, startTime: 780, endTime: 840, slots: [0] },
            { type: 'league', event: 'League Time', divName: 'Youngest', leagueName: YOUNGEST, startTime: 780, endTime: 840, slots: [0] },
        ],
        masterLeagues: {
            [SENIOR]: { name: SENIOR, enabled: true, divisions: ['Seniors'], teams: SENIOR_TEAMS.slice(), sports: ['Basketball', 'Hockey'], schedulingPriority: 'sport_variety' },
            [JUNIOR]: { name: JUNIOR, enabled: true, divisions: ['Juniors'], teams: (juniorTeams || JUNIOR_TEAMS).slice(), sports: ['Basketball', 'Hockey'], schedulingPriority: 'sport_variety' },
            [YOUNGEST]: { name: YOUNGEST, enabled: true, divisions: ['Youngest'], teams: YOUNGEST_TEAMS.slice(), sports: ['Basketball', 'Hockey'], schedulingPriority: 'sport_variety' },
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
    settings.leagueHistory = buildHistory(opts.juniorHockeyDays, opts.youngestHockeyDays, opts.juniorFootballDays);
    global.window.currentScheduleDate = TODAY;
    global.window._activeGenDate = TODAY;
    global.window.divisionTimes = { Seniors: [{ startMin: 780, endMin: 840 }], Juniors: [{ startMin: 780, endMin: 840 }], Youngest: [{ startMin: 780, endMin: 840 }] };
    global.window.GlobalFieldLocks.reset();   // locks are per-run
    if (opts.reservationOff) global.window.__leagueSportReservation = false;

    const lines = [];
    const ctx = makeContext(opts.juniorTeams);
    console.log = (...a) => { lines.push(a.join(' ')); };
    console.warn = () => {};
    try { Leagues.processRegularLeagues(ctx); }
    finally {
        console.log = origLog; console.warn = origWarn;
        delete global.window.__leagueSportReservation;
    }

    const capLine = lines.filter(l => l.indexOf('Need-first sport caps') >= 0).pop() || '';
    const caps = {};
    [SENIOR, JUNIOR, YOUNGEST].forEach(name => {
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
        reservations: lines.filter(l => l.indexOf('Sport reservation') >= 0),
        floors: lines.filter(l => l.indexOf('Participation floor') >= 0),
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
    const totalForSport = (caps, sp) => [SENIOR, JUNIOR, YOUNGEST].reduce((a, n) => a + (caps[n][sp] || 0), 0);
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

// ---- TEST 4: a league that is CAUGHT UP gets no reservation -----------------
// The gate is "at least a game behind per team", not "has never played it".
// Hockey on 5 of 9 days makes hockey this league's MOST-played sport, so its
// hockey deficit is 0 and it is owed nothing. (Two days out of nine would NOT
// qualify it as caught up — that is still 5 games per team behind, and it
// should still be reserved for. That distinction is the whole fix.)
{
    // Youngest is caught up too, so JUNIOR is the only candidate for the rink
    // and the assertion is about Junior alone rather than about who out-starves
    // whom for a single field.
    const CAUGHT_UP = { youngestHockeyDays: PAST.slice(0, 5) };
    const r = run(Object.assign({ juniorHockeyDays: PAST.slice(0, 5) }, CAUGHT_UP));
    const forJunior = r.reservations.filter(l => l.indexOf(JUNIOR) >= 0);
    assert.strictEqual(forJunior.length, 0,
        'reserved for a league that is already caught up: ' + JSON.stringify(r.reservations));
    // …and the SAME fixture with one hockey day on record still reserves. That
    // is the fix in one comparison: having played it is not the question, being
    // behind is.
    //
    // ★ One day, not two. At two the league sits 5 games/team behind while the
    //   senior league it would take from sits 5.6 behind — and the donor guard
    //   correctly refuses to rob a hungrier league, so nothing moves. Which is
    //   right, and worth knowing: this reserves for the WORST-off league, it
    //   does not simply hand the scarce sport down the age order.
    const behind = run(Object.assign({ juniorHockeyDays: PAST.slice(0, 1) }, CAUGHT_UP));
    assert.ok(behind.reservations.some(l => l.indexOf(JUNIOR) >= 0),
        'a league 7 games/team behind was treated as caught up: ' + JSON.stringify(behind.reservations));
    console.log('✅ TEST 4 — caught up → no reservation; still behind → reserved');
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

// ---- TEST 7: a cap that protects nobody is released ------------------------
// Leagues run senior→junior and lock as they go, so a cap exists to make a
// league leave a field for the grades AFTER it. The LAST league has none, and
// capping it only stops it taking a field that will otherwise sit empty. Live
// 2026-08-04 @12:10 the youngest league was last in the order, held Hockey:0,
// and took a basketball court with the rink open in front of it.
{
    const on = run();
    assert.deepStrictEqual(on.caps[YOUNGEST], {},
        'the last league still carries caps nobody is waiting on: ' + JSON.stringify(on.caps));

    global.window.__leagueUnprotectedCapRelease = false;
    let off;
    try { off = run(); } finally { delete global.window.__leagueUnprotectedCapRelease; }
    assert.ok(Object.keys(off.caps[YOUNGEST] || {}).length > 0,
        'killswitch did not restore the caps: ' + JSON.stringify(off.caps));
    // The rule is about who comes AFTER, not about being junior: the senior
    // league keeps its caps because two leagues below it still want those sports.
    assert.ok(Object.keys(on.caps[SENIOR]).length > 0,
        'released a cap that later leagues still need: ' + JSON.stringify(on.caps));
    console.log('✅ TEST 7 — last league\'s caps released ' + JSON.stringify(on.caps[YOUNGEST])
        + ', restored by killswitch ' + JSON.stringify(off.caps[YOUNGEST]));
}

// ---- TEST 8: the floor must not confiscate the reserved cap ----------------
// A SMALL league is exactly the shape the participation floor reads as having
// surplus: 3 teams want 1 game, so its two caps look like one spare — and the
// floor promptly donated the reserved sport to somebody else. Live 2026-08-04,
// three periods running:
//   🎁 1 Hockey held for "3rd Grade" (3.0 game(s)/team behind) — from "5th Grade"
//   ⚖️ 1 Hockey cap 3rd Grade → 6th Grade (seat its games)
// The reservation fired all day and delivered one game out of six.
{
    const SMALL = ['J1', 'J2', 'J3'];   // 3 teams → 1 game wanted → reads as surplus
    // Youngest is caught up on hockey so it does not out-starve the small
    // league for the single rink — this test is about the FLOOR, not the race.
    const r = run({ juniorTeams: SMALL, juniorFootballDays: PAST.slice(0, 7),
                    youngestHockeyDays: PAST.slice(0, 5) });
    const mine = r.reservations.filter(l => l.indexOf(JUNIOR) >= 0);
    assert.ok(mine.length > 0,
        'fixture did not reserve for the small league: ' + JSON.stringify(r.reservations));
    const sport = (mine[0].match(/1 (\w+) held/) || [])[1];
    assert.ok(sport, 'could not read the reserved sport from: ' + mine[0]);

    // The floor may still take this league's OTHER caps — just not the held one.
    const stolen = r.floors.filter(l =>
        l.indexOf(sport) >= 0 && l.indexOf(JUNIOR + ' →') >= 0);
    assert.strictEqual(stolen.length, 0,
        'the floor took the reserved ' + sport + ' straight back: ' + JSON.stringify(r.floors));
    assert.ok((r.caps[JUNIOR] || {})[sport] > 0 || Object.keys(r.caps[JUNIOR] || {}).length === 0,
        'the reserved ' + sport + ' did not survive to the final caps: ' + JSON.stringify(r.caps));
    console.log('✅ TEST 8 — reserved ' + sport + ' survives the participation floor '
        + JSON.stringify(r.caps[JUNIOR]));
}

console.log('\n🎉 league_first_time_sport_reservation_sim: all tests passed');
})().catch(e => { console.error('❌', e && e.message ? e.message : e); process.exit(1); });
