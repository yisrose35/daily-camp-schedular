// =============================================================================
// league_bye_activity_sim.js
// -----------------------------------------------------------------------------
// Bye Activity: what a benched league team DOES instead of nothing.
//
// The reported shape: 5 teams + chinuch, only 2 games fit, so one team is
// always left over. Before this feature that team got a bare "Team — Bye";
// now the user names the activities those teams get instead.
//
//   TEST 1 — planner: off / nothing configured → no plan (plain byes stand).
//   TEST 2 — planner: a pinned team always gets its own activity; the shared
//            pool rotates by day+game; two benched teams in one period never
//            land on the same facility.
//   TEST 3 — REAL engine, 5 teams / 2 fields: the benched team's tile line
//            reads "T — Bye: <activity>", the plan is published for the auto
//            engine's per-bunk writeback, and the facility is reserved.
//   TEST 4 — REAL engine: feature off → the old plain "T — Bye" line, and
//            nothing is reserved (no regression).
//   TEST 5 — REAL engine: over consecutive days a repeatedly-benched team
//            rotates through the configured activities instead of always
//            drawing the first one.
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

// Records every reservation so the tests can assert the bye facility is held.
const locks = { divisionLocks: [], fieldLocks: [], multi: [] };
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
    GlobalFieldLocks: {
        // Nothing is pre-locked in these sims — the recorders below are what
        // the assertions read.
        isFieldLocked: () => false,
        isFieldLockedByTime: () => false,
        divisionAllowed: () => true,
        lockField: function (f, slots, by, kind, win) { locks.fieldLocks.push({ field: f, slots, by, kind, win }); },
        lockMultipleFields: function (fs, slots, meta) { locks.multi.push({ fields: fs, slots, meta }); },
        lockFieldForDivision: function (f, slots, divs, reason, win) {
            locks.divisionLocks.push({ field: f, slots, divs, reason, win });
        },
        debugPrintLocks: () => {},
    },
};
global.document = { readyState: 'complete', addEventListener: () => {} };

const origLog = console.log;
const origWarn = console.warn;
console.log = () => {};
require('../scheduler_core_leagues.js');
console.log = origLog;
const Leagues = global.window.SchedulerCoreLeagues;
assert.ok(Leagues && typeof Leagues.processRegularLeagues === 'function', 'engine loaded');
assert.ok(typeof Leagues.planByeActivities === 'function', 'planByeActivities exported');

const LG = 'Bye League';
// 5 teams — the reported camp's shape. Two games fit, one team is benched.
const TEAMS = ['T1', 'T2', 'T3', 'T4', 'T5'];
const FIELDS = [
    { name: 'Court 1', activities: ['Basketball'] },
    { name: 'Court 2', activities: ['Soccer'] },
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
    locks.divisionLocks.length = 0; locks.fieldLocks.length = 0; locks.multi.length = 0;
    const ctx = makeContext(leagueCfg, blocks);
    console.log = () => {}; console.warn = () => {};
    try { Leagues.processRegularLeagues(ctx); }
    finally { console.log = origLog; console.warn = origWarn; }
    return ctx;
}
function linesOf(ctx) {
    return ctx.schedulableSlotBlocks
        .map(b => b._pick)
        .filter(Boolean)
        .flatMap(p => p._allMatchups || []);
}
function byeLines(ctx) { return linesOf(ctx).filter(l => /—\s*Bye/i.test(l)); }
const histNow = () => settings.leagueHistory || {};

(async () => {

// ---- TEST 1: nothing configured → no plan ----------------------------------
{
    const roster = { name: LG, teams: TEAMS.slice() };
    assert.deepStrictEqual(Leagues.planByeActivities(roster, ['T5'], { dayId: '2026-07-01', gameNumber: 1 }), {},
        'no byeActivity block → no plan');
    assert.deepStrictEqual(
        Leagues.planByeActivities(Object.assign({}, roster, { byeActivity: { enabled: false, activities: ['Pool'] } }),
            ['T5'], { dayId: '2026-07-01', gameNumber: 1 }), {},
        'disabled → no plan');
    assert.deepStrictEqual(
        Leagues.planByeActivities(Object.assign({}, roster, { byeActivity: { enabled: true, activities: [], teamActivities: {} } }),
            ['T5'], { dayId: '2026-07-01', gameNumber: 1 }), {},
        'enabled but empty → no plan');
    assert.deepStrictEqual(
        Leagues.planByeActivities(Object.assign({}, roster, { byeActivity: { enabled: true, activities: ['Pool'] } }),
            [], { dayId: '2026-07-01', gameNumber: 1 }), {},
        'nobody benched → no plan');
    console.log('✅ TEST 1 — planner is inert until the user configures something');
}

// ---- TEST 2: pins win, pool rotates, no collisions -------------------------
{
    const league = {
        name: LG, teams: TEAMS.slice(),
        byeActivity: { enabled: true, activities: ['Pool', 'Canteen', 'Rink'], teamActivities: { T5: 'Beis Medrash' } },
    };

    // A pinned team gets its activity on every bye, regardless of the seed.
    for (let g = 1; g <= 6; g++) {
        const p = Leagues.planByeActivities(league, ['T5'], { dayId: '2026-07-0' + ((g % 9) + 1), gameNumber: g });
        assert.strictEqual(p.T5, 'Beis Medrash', 'pinned team keeps its activity (game ' + g + ')');
    }

    // Several benched teams at once never share a facility while the pool has
    // room, and never draw the pinned team's.
    const many = Leagues.planByeActivities(league, ['T1', 'T2', 'T3', 'T5'], { dayId: '2026-07-01', gameNumber: 1 });
    const picked = ['T1', 'T2', 'T3', 'T5'].map(t => many[t]);
    assert.strictEqual(new Set(picked).size, 4, 'four benched teams → four distinct activities: ' + JSON.stringify(many));
    assert.strictEqual(many.T5, 'Beis Medrash', 'pin honored inside a crowded period');

    // More benched teams than activities → everyone still gets something.
    const small = { name: LG, teams: TEAMS.slice(), byeActivity: { enabled: true, activities: ['Pool'] } };
    const over = Leagues.planByeActivities(small, ['T1', 'T2'], { dayId: '2026-07-01', gameNumber: 1 });
    assert.strictEqual(over.T1, 'Pool');
    assert.strictEqual(over.T2, 'Pool', 'sharing beats stranding a team with nothing');

    // Deterministic: the same day + game re-plans identically (regen safety).
    const a = Leagues.planByeActivities(league, ['T1', 'T2'], { dayId: '2026-07-01', gameNumber: 2 });
    const b = Leagues.planByeActivities(league, ['T2', 'T1'], { dayId: '2026-07-01', gameNumber: 2 });
    assert.deepStrictEqual(a, b, 'plan does not depend on the order teams were collected');

    // Rotation is driven by how many byes the team has already had, read off
    // the persisted gameLog — three byes in a row walk the whole list.
    const hist = { gameLog: { [LG]: {} } };
    const seen = [];
    ['2026-07-01', '2026-07-02', '2026-07-03'].forEach(function (d) {
        seen.push(Leagues.planByeActivities(league, ['T1'], { dayId: d, gameNumber: 1, history: hist }).T1);
        // T1 sat that day out; the others played.
        hist.gameLog[LG][d] = [{ t1: 'T2', t2: 'T3', sport: 'Basketball', g: 'Game 1' }];
    });
    assert.strictEqual(new Set(seen).size, 3, 'three consecutive byes → three different activities: ' + JSON.stringify(seen));

    // A team that PLAYED does not advance in the rotation.
    const hist2 = { gameLog: { [LG]: { '2026-07-01': [{ t1: 'T1', t2: 'T2', sport: 'Basketball', g: 'Game 1' }] } } };
    assert.strictEqual(
        Leagues.planByeActivities(league, ['T1'], { dayId: '2026-07-01', gameNumber: 1, history: hist2 }).T1,
        Leagues.planByeActivities(league, ['T1'], { dayId: '2026-07-02', gameNumber: 1, history: hist2 }).T1,
        'playing a day does not move the team along the bye rotation');
    console.log('✅ TEST 2 — pins always win, the pool rotates, benched teams never collide');
}

// ---- TEST 3: real engine — line, published plan, reserved facility ----------
{
    delete settings.leagueHistory; global.localStorage._m = {};
    const cfg = { byeActivity: { enabled: true, activities: ['Pool'], teamActivities: {} } };
    const ctx = gen('2026-07-01', cfg);

    const games = linesOf(ctx).filter(l => / vs /.test(l));
    assert.strictEqual(games.length, 2, 'two fields → two games: ' + JSON.stringify(linesOf(ctx)));

    const bl = byeLines(ctx);
    assert.strictEqual(bl.length, 1, 'five teams, two games → exactly one bye: ' + JSON.stringify(bl));
    assert.ok(/^\S+ — Bye: Pool$/.test(bl[0]), 'bye line names the activity: ' + bl[0]);

    // The benched team's plan is published for the auto engine's per-bunk swap.
    const benched = bl[0].split(' — ')[0];
    const sched = global.window.leagueByeSchedule?.[LG]?.[benched];
    assert.ok(Array.isArray(sched) && sched.length === 1, 'plan published for ' + benched + ': ' + JSON.stringify(sched));
    assert.strictEqual(sched[0].activity, 'Pool');
    assert.strictEqual(sched[0].startMin, 780, 'published at the league period start');

    // The facility is held for the league's grades so nothing else takes it.
    const res = locks.divisionLocks.filter(l => l.field === 'Pool');
    assert.strictEqual(res.length, 1, 'Pool reserved once: ' + JSON.stringify(locks.divisionLocks));
    assert.ok(/Bye activity/i.test(res[0].reason), 'reservation reason names the feature: ' + res[0].reason);
    assert.strictEqual(res[0].divs, 'Juniors', 'reserved for the league\'s divisions');
    assert.strictEqual(res[0].win.startMin, 780, 'reserved for the league period');

    // The benched team is not silently logged as having played.
    const log = histNow().gameLog?.[LG]?.['2026-07-01'] || [];
    log.forEach(e => assert.ok(e.t1 !== benched && e.t2 !== benched, benched + ' must not appear in the game log'));

    // The bye report explains itself rather than crying "field shortage".
    const rep = (global.window.__leagueByeReport || []).filter(r => r.team1 === benched);
    assert.strictEqual(rep.length, 1, 'the bye is still reported: ' + JSON.stringify(global.window.__leagueByeReport));
    assert.strictEqual(rep[0].activity, 'Pool', 'report carries the activity');
    assert.ok(/Bye Activity setting/i.test(rep[0].reason), 'report says this is configured, not broken: ' + rep[0].reason);
    console.log('✅ TEST 3 — REAL engine: benched team gets "Bye: Pool", plan published, facility reserved');
}

// ---- TEST 4: feature off → unchanged behavior ------------------------------
{
    delete settings.leagueHistory; global.localStorage._m = {};
    global.window.leagueByeSchedule = { stale: true };   // must be rebuilt, not inherited
    const ctx = gen('2026-07-01', {});
    const bl = byeLines(ctx);
    assert.strictEqual(bl.length, 1, 'still exactly one bye');
    assert.ok(/^\S+ — Bye$/.test(bl[0]), 'plain bye when nothing is configured: ' + bl[0]);
    assert.deepStrictEqual(global.window.leagueByeSchedule, {}, 'stale plan cleared at the start of a run');
    assert.strictEqual(locks.divisionLocks.length, 0, 'nothing reserved when the feature is off');
    console.log('✅ TEST 4 — feature off → the old plain bye, nothing reserved');
}

// ---- TEST 5: rotation across days in the real engine -----------------------
{
    delete settings.leagueHistory; global.localStorage._m = {};
    const cfg = { byeActivity: { enabled: true, activities: ['Pool', 'Canteen', 'Rink'], teamActivities: {} } };
    const byTeam = {};
    ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-06', '2026-07-07', '2026-07-08'].forEach(d => {
        const bl = byeLines(gen(d, cfg));
        bl.forEach(l => {
            const m = /^(.+?) — Bye: (.+)$/.exec(l);
            assert.ok(m, 'every bye names an activity: ' + l);
            (byTeam[m[1]] = byTeam[m[1]] || []).push(m[2]);
        });
    });
    const repeats = Object.keys(byTeam).filter(t => byTeam[t].length >= 2);
    assert.ok(repeats.length > 0, 'some team was benched more than once: ' + JSON.stringify(byTeam));
    repeats.forEach(t => assert.strictEqual(new Set(byTeam[t]).size, byTeam[t].length,
        t + ' drew the same activity twice instead of advancing: ' + JSON.stringify(byTeam[t])));
    // …and the engine spread the byes around rather than benching one team daily.
    assert.ok(Object.keys(byTeam).length > 1, 'byes rotate between teams: ' + JSON.stringify(byTeam));
    console.log('✅ TEST 5 — REAL engine: a repeatedly-benched team rotates through the configured activities');
}

// ---- TEST 6: the reported shape — 5 teams + chinuch --------------------------
{
    delete settings.leagueHistory; global.localStorage._m = {};
    // 5 teams, one at chinuch → 4 left, two games fit, nobody benched. Bump
    // chinuch to two teams and 3 must share 2 fields → one is benched, and it
    // is the bye activity — not chinuch — that covers it.
    const cfg = {
        chinuch: { enabled: true, teamsPerRound: 2, timesPerDay: 1, bunkFacilities: { T1: 'Beis Medrash' } },
        byeActivity: { enabled: true, activities: ['Pool', 'Canteen'], teamActivities: {} },
    };
    const ctx = gen('2026-07-01', cfg);
    const all = linesOf(ctx);
    const chinuch = all.filter(l => /— Chinuch/.test(l));
    const byes = byeLines(ctx);
    assert.strictEqual(chinuch.length, 2, 'two teams at chinuch: ' + JSON.stringify(all));
    assert.strictEqual(byes.length, 1, 'the odd team left over is benched: ' + JSON.stringify(all));
    assert.ok(/ — Bye: (Pool|Canteen)$/.test(byes[0]), 'benched team gets a real activity: ' + byes[0]);

    // Chinuch and bye are different teams doing different things — no overlap.
    const chTeams = chinuch.map(l => l.split(' — ')[0]);
    const byeTeam = byes[0].split(' — ')[0];
    assert.ok(chTeams.indexOf(byeTeam) < 0, 'a chinuch team is not also on a bye');
    assert.ok(!/Beis Medrash/.test(byes[0]), 'the bye activity is not the chinuch room');
    console.log('✅ TEST 6 — 5 teams + chinuch: the leftover team gets an activity, not a bare bye');
}

console.log('\n🎉 league_bye_activity_sim: ALL TESTS PASSED');

})().catch(e => { console.error(e); process.exit(1); });
