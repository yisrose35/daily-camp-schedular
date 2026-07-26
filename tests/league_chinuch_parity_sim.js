// =============================================================================
// league_chinuch_parity_sim.js
// -----------------------------------------------------------------------------
// "I have 8 teams across 3 periods. Period 1 gives 3 chinuch, 1 bye, 2 matchups.
//  Why doesn't the bye team get their chinuch then? They're waiting anyway!"
//
// A team sits out a BYE whenever the teams left to play are ODD:
//      active = teams - chinuchThisPeriod
// The old auto split was parity-blind — ceil(teams/periods) — so 8 teams over
// 3 periods gave [3,3,2] → active [5,5,6] → a wasted team in two of three
// periods. Observed live across FIVE leagues on 2026-07-25; the only league
// with no byes (Single A, 4 teams / 2 chinuch) was the only one whose chinuch
// count happened to match its roster parity.
//
// FIX (pure-auto mode only): choose per-period counts that share the ROSTER's
// parity, so active is even everywhere. Counts still sum to the roster, so
// every team keeps exactly one chinuch slot per day.
//
//   TEST 1 — the planner, extracted from REAL source, on the user's 5 leagues.
//   TEST 2 — planner invariants across N=2..16 x P=1..8 (sum, parity, no
//            starved period, byes never worse than the arithmetic minimum).
//   TEST 3 — REAL engine, pure auto: 8 teams / 3 periods → no structural bye.
//   TEST 4 — REAL engine: a MANUAL teams-per-round config is honored exactly
//            (the camp's capacity decision is never overridden).
//   TEST 5 — REAL engine: every team still gets exactly one chinuch slot.
// =============================================================================

'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// =============================================================================
// Extract the REAL _planChinuchCounts from scheduler_core_leagues.js so the
// algorithm tests bind to shipped source rather than a copy.
// =============================================================================
const src = fs.readFileSync(path.join(__dirname, '..', 'scheduler_core_leagues.js'), 'utf8');
const marker = 'function _planChinuchCounts(';
const start = src.indexOf(marker);
assert.ok(start >= 0,
    'REGRESSION: _planChinuchCounts is gone from scheduler_core_leagues.js — ' +
    'chinuch is parity-blind again and leagues will hand out avoidable byes');
let i = src.indexOf('{', start), depth = 0;
for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
}
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(src.slice(start, i), sandbox);
const _rawPlan = sandbox._planChinuchCounts;
assert.strictEqual(typeof _rawPlan, 'function', 'extracted the real planner');
// The vm sandbox is a separate realm, so arrays it returns have a different
// Array.prototype and would fail deepStrictEqual against literals. Copy into
// this realm at the boundary.
const planChinuchCounts = (N, P) => Array.from(_rawPlan(N, P));

const activeOf = (N, counts) => counts.map(c => N - c);
const byesOf = (N, counts) => activeOf(N, counts).filter(a => a % 2 === 1).length;
const gamesOf = (N, counts) => activeOf(N, counts).reduce((t, a) => t + Math.floor(a / 2), 0);

// Fewest bye-periods arithmetically possible while every team learns once.
// Even roster → always 0. Odd roster → counts must be odd, and an odd number
// of odd terms is needed to sum to an odd total, so at most the largest odd
// k <= min(P, N) periods can be bye-free.
function minPossibleByes(N, P) {
    if (N % 2 === 0) return 0;
    let k = Math.min(P, N);
    if (k % 2 === 0) k--;
    return P - k;
}

// =============================================================================
// TEST 1 — the user's five real leagues
// =============================================================================
{
    const real = [
        // name,        teams, periods, chinuchBefore(per period), byesBefore
        ['Triple A',  8, 3, 3, 2],
        ['All Stars', 7, 6, 2, 1],
        ['Majors',    6, 5, 1, 5],
        ['Double A',  5, 2, 2, 1],
        ['Single A',  4, 2, 2, 0],
    ];
    for (const [name, N, P, oldPer, ,] of real) {
        const counts = planChinuchCounts(N, P);
        const sum = counts.reduce((a, b) => a + b, 0);
        assert.strictEqual(sum, N,
            `${name}: every team must still get exactly one chinuch slot (got ${sum}/${N})`);
        assert.strictEqual(byesOf(N, counts), minPossibleByes(N, P),
            `${name}: byes must hit the arithmetic minimum`);
        // The old flat split really was worse (or equal, for Single A).
        const oldActive = N - oldPer;
        if (oldActive % 2 === 1) {
            assert.ok(byesOf(N, counts) < P,
                `${name}: old flat count ${oldPer} left an odd active roster every period`);
        }
    }
    // Spot-check the headline case from the user's question.
    const t = planChinuchCounts(8, 3);
    assert.deepStrictEqual(activeOf(8, t), [4, 6, 6], 'Triple A: active becomes all-even');
    assert.strictEqual(byesOf(8, t), 0, 'Triple A: zero structural byes');
    assert.strictEqual(gamesOf(8, t), 8, 'Triple A: 8 games, up from 7');
}
console.log('TEST 1 PASS — 8 teams/3 periods → chinuch [4,2,2], active [4,6,6], 8 games, 0 byes');

// =============================================================================
// TEST 2 — invariants across a wide grid
// =============================================================================
{
    for (let N = 2; N <= 16; N++) {
        for (let P = 1; P <= 8; P++) {
            const counts = planChinuchCounts(N, P);
            const sum = counts.reduce((a, b) => a + b, 0);
            const active = activeOf(N, counts);

            assert.strictEqual(counts.length, P, `N=${N} P=${P}: one count per period`);
            assert.ok(counts.every(c => c >= 0), `N=${N} P=${P}: no negative counts`);
            assert.ok(sum <= N, `N=${N} P=${P}: never schedules more chinuch than teams`);
            // Never empty a period out — that is strictly worse than a bye.
            assert.ok(active.every(a => a >= 2 || N < 2),
                `N=${N} P=${P}: every period keeps >=2 teams able to play (active ${active})`);
            // Byes never worse than arithmetic minimum...
            assert.ok(byesOf(N, counts) <= minPossibleByes(N, P),
                `N=${N} P=${P}: byes ${byesOf(N, counts)} exceed minimum ${minPossibleByes(N, P)}`);
            // ...and everyone learns whenever the caps allow it.
            if (N - 2 >= Math.ceil(N / P)) {
                assert.strictEqual(sum, N,
                    `N=${N} P=${P}: every team should get a chinuch slot (got ${sum})`);
            }
        }
    }
}
console.log('TEST 2 PASS — planner invariants hold across N=2..16 x P=1..8 (112 shapes)');

// =============================================================================
// REAL-ENGINE HARNESS (mirrors league_chinuch_rotation_sim.js)
// =============================================================================
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
    divisionTimes: {
        Juniors: [
            { startMin: 780, endMin: 830 },
            { startMin: 840, endMin: 890 },
            { startMin: 900, endMin: 950 },
        ],
    },
    addEventListener: () => {},
    CustomEvent: function CustomEvent(type, opts) { this.type = type; this.detail = (opts || {}).detail; },
    dispatchEvent: () => true,
    loadAllDailyData: () => ({}),
    getFieldsInZone: () => [],
};
global.document = { readyState: 'complete', addEventListener: () => {} };

const origLog = console.log;
console.log = () => {};
require(path.join(__dirname, '..', 'scheduler_core_leagues.js'));
console.log = origLog;
const Leagues = global.window.SchedulerCoreLeagues;
assert.ok(Leagues && typeof Leagues.processRegularLeagues === 'function', 'engine loaded');

const LG = 'Parity League';
const TEAMS8 = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8'];
// Plenty of courts so nothing is a FIELD shortage — byes here are structural only.
const FIELDS = [];
for (let f = 1; f <= 8; f++) FIELDS.push({ name: 'Court ' + f, activities: ['Basketball'] });

// Runs the real engine and returns both the chinuch plan AND everything the
// engine logged, so byes can be asserted from real output rather than inferred.
function runEngine(chinuchCfg) {
    global.window.currentScheduleDate = '2026-08-03';
    global.window._activeGenDate = '2026-08-03';
    global.window.leagueAssignments = {};
    global.window.chinuchSchedule = {};
    delete settings.leagueHistory;
    global.localStorage._m = {};
    Object.keys(cloudKV).forEach(k => delete cloudKV[k]);

    const ctx = {
        schedulableSlotBlocks: [780, 840, 900].map((t, idx) => ({
            type: 'league', event: 'League Time', divName: 'Juniors', leagueName: LG,
            startTime: t, endTime: t + 50, slots: [idx],
        })),
        masterLeagues: {
            [LG]: {
                name: LG, enabled: true, divisions: ['Juniors'], teams: TEAMS8.slice(),
                sports: ['Basketball'], schedulingPriority: 'matchup_variety',
                chinuch: Object.assign({ enabled: true }, chinuchCfg),
            },
        },
        disabledLeagues: [],
        divisions: { Juniors: { bunks: ['J1'] } },
        fillBlock: function (block, pick) { block._filled = true; block._pick = pick; },
        fieldUsageBySlot: {}, activityProperties: {}, rotationHistory: {},
        fields: FIELDS.map(f => Object.assign({}, f)), disabledFields: [],
    };

    // NOTE: the bye SUMMARY is emitted on console.warn, not console.log — capture
    // both, or the bye assertions silently pass on an empty string.
    const out = [];
    const _log = console.log, _warn = console.warn, _err = console.error;
    console.log = (...a) => { out.push(a.join(' ')); };
    console.warn = (...a) => { out.push(a.join(' ')); };
    console.error = (...a) => { out.push(a.join(' ')); };
    try { Leagues.processRegularLeagues(ctx); }
    finally { console.log = _log; console.warn = _warn; console.error = _err; }
    return { sched: global.window.chinuchSchedule[LG] || {}, log: out.join('\n'), ctx };
}

// A STRUCTURAL bye is the one this fix targets: the engine says the teams left
// to play were odd. (Field-shortage byes read differently and are not in scope.)
function structuralByes(log) {
    return (log.match(/odd number of teams playing this period/g) || []).length;
}
function fieldShortage(log) {
    return /No fields were open|Not enough fields/.test(log);
}

// Count how many teams the engine put on chinuch at each period key.
function countsByPeriod(sched, periodKeys) {
    return periodKeys.map(k =>
        Object.keys(sched).filter(t => Number(sched[t]) === k).length);
}

// =============================================================================
// TEST 3 — REAL engine, PURE AUTO: 8 teams / 3 periods → no structural bye
// =============================================================================
{
    const { sched, log } = runEngine({ timesPerDay: null, teamsPerRound: null, perSessionCounts: null });
    const counts = countsByPeriod(sched, [780, 840, 900]);
    const active = counts.map(c => TEAMS8.length - c);

    assert.strictEqual(counts.reduce((a, b) => a + b, 0), 8,
        'pure auto: all 8 teams still get a chinuch slot');
    assert.ok(active.every(a => a % 2 === 0),
        `pure auto: every period must leave an EVEN number playing, got active [${active}] ` +
        `from chinuch [${counts}] — this is the whole point of the fix`);
    assert.deepStrictEqual(counts.slice().sort(), [2, 2, 4],
        `pure auto: expected a parity-balanced [4,2,2] split, got [${counts}]`);

    // Non-vacuous: the fixture must give the engine real courts to place on,
    // otherwise "no byes" would just mean "no games happened".
    assert.ok(!fieldShortage(log),
        'fixture sanity: courts must actually be available, else the bye check is vacuous');
    assert.strictEqual(structuralByes(log), 0,
        'pure auto: the ENGINE must report zero odd-roster byes across all 3 periods');
}
console.log('TEST 3 PASS — REAL engine, pure auto: 8 teams/3 periods → 0 structural byes reported by the engine');

// =============================================================================
// TEST 4 — REAL engine: a MANUAL config is honored EXACTLY, never overridden
// =============================================================================
{
    // 3 teams/round is a capacity decision (rooms, rebbeim). It yields active=5
    // (odd → a bye) — and the engine must NOT silently "fix" that.
    const { sched, log } = runEngine({ timesPerDay: null, teamsPerRound: 3, perSessionCounts: null });
    const counts = countsByPeriod(sched, [780, 840, 900]);
    assert.ok(counts.some(c => c === 3),
        `manual teamsPerRound=3 must be honored verbatim, got [${counts}]`);
    assert.ok(!counts.some(c => c === 4),
        `manual config must NOT be parity-adjusted to 4, got [${counts}]`);
    // And the resulting bye is left in place rather than engineered away —
    // proving the parity planner really is confined to pure-auto mode.
    assert.ok(structuralByes(log) > 0,
        'the bye implied by the camp\'s own number must survive (manual is never overridden)');

    // Explicit per-session counts are likewise untouched.
    const r2 = runEngine({ timesPerDay: null, teamsPerRound: null, perSessionCounts: [3, 3, 2] });
    const counts2 = countsByPeriod(r2.sched, [780, 840, 900]);
    assert.deepStrictEqual(counts2, [3, 3, 2],
        `explicit perSessionCounts [3,3,2] must be honored verbatim, got [${counts2}]`);
}
console.log('TEST 4 PASS — REAL engine: manual teams-per-round + perSessionCounts honored exactly (bye left intact)');

// =============================================================================
// TEST 5 — REAL engine: no team is double-booked or dropped in auto mode
// =============================================================================
{
    const { sched } = runEngine({ timesPerDay: null, teamsPerRound: null, perSessionCounts: null });
    const assigned = Object.keys(sched);
    assert.strictEqual(new Set(assigned).size, assigned.length, 'no team listed twice');
    assert.strictEqual(assigned.length, TEAMS8.length,
        'every team gets exactly one chinuch period (the camp rule: everyone learns daily)');
    for (const t of assigned) {
        assert.ok([780, 840, 900].includes(Number(sched[t])),
            `${t} assigned to a real league period, got ${sched[t]}`);
    }
}
console.log('TEST 5 PASS — REAL engine: every team gets exactly one chinuch period, none duplicated');

// =============================================================================
// TEST 6 — HEAD-TO-HEAD, one engine, one fixture: old split vs new split.
// The OLD auto rule was teamsPerSession = ceil(teams/periods) = ceil(8/3) = 3,
// giving [3,3,2]. Feeding exactly that through perSessionCounts reproduces the
// old behaviour on the CURRENT engine, so the two runs differ only in the
// chinuch split. This is the non-vacuous proof that the fix does real work.
// =============================================================================
{
    const oldRun = runEngine({ timesPerDay: null, teamsPerRound: null, perSessionCounts: [3, 3, 2] });
    const newRun = runEngine({ timesPerDay: null, teamsPerRound: null, perSessionCounts: null });

    const oldByes = structuralByes(oldRun.log);
    const newByes = structuralByes(newRun.log);

    assert.ok(!fieldShortage(oldRun.log) && !fieldShortage(newRun.log),
        'both runs must have real courts, else the comparison is vacuous');
    assert.strictEqual(oldByes, 2,
        `old [3,3,2] split must produce 2 structural byes (active [5,5,6]), got ${oldByes}`);
    assert.strictEqual(newByes, 0,
        `new parity split must produce 0 structural byes, got ${newByes}`);
    assert.ok(newByes < oldByes,
        'the parity plan must strictly reduce byes on identical inputs');

    // And the teams freed from byes actually become games: 7 → 8.
    const oldCounts = countsByPeriod(oldRun.sched, [780, 840, 900]);
    const newCounts = countsByPeriod(newRun.sched, [780, 840, 900]);
    const games = (c) => c.reduce((t, x) => t + Math.floor((8 - x) / 2), 0);
    assert.strictEqual(games(oldCounts), 7, 'old split yields 7 games');
    assert.strictEqual(games(newCounts), 8, 'new split yields 8 games — the wasted teams now play');
}
console.log('TEST 6 PASS — head-to-head on one engine: [3,3,2] → 2 byes / 7 games  vs  [4,2,2] → 0 byes / 8 games');

console.log('\nALL 6 CHINUCH PARITY TESTS PASS');
