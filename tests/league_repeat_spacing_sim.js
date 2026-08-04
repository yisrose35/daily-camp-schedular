// =============================================================================
// league_repeat_spacing_sim.js
// -----------------------------------------------------------------------------
// "The same teams keep playing the same sports, and even when we are forced to
// have that, at least let it be split up so that it's not basketball and then
// right after that another basketball game."
//
// The same-day repeat guard stored today's sports as a SET — which sports a team
// had played, never WHEN. So once every open sport was a repeat (the normal case
// in a camp short of fields) it picked the "least-bad" option by counting how
// many teams repeated, completely blind to whether the repeat was from this
// morning or from the period that had just finished. Basketball at 9:45 and
// basketball again at 10:35 scored identically to basketball and hockey.
//
//   TEST 1 — with two repeats available, the one played in the PREVIOUS period
//            is dropped in favour of the one played earlier in the day.
//   TEST 2 — the sport a team has not played today still wins outright; spacing
//            only ever arbitrates between repeats.
//   TEST 3 — the ordering fix: "not back-to-back" outranks "fewest teams
//            repeating". Pinned against the killswitch on the same fixture, so
//            the old ranking is shown picking the back-to-back.
//   TEST 4 — spacing never promotes a repeat over a genuinely unplayed sport.
//
// ⚠️ Deliberately unit-level. A whole-day A/B on a small fixture proves nothing:
//    with enough spare fields an unplayed sport is always open so the fallback
//    never runs, and with too few every choice is back-to-back. Both were tried;
//    both gave identical counts with the rule on and off.
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

global.window = {
    loadGlobalSettings: () => settings,
    saveGlobalSettings: (k, v) => { settings[k] = v; },
    supabase: { from() { return {
        select() { const q = { _k: null };
            q.eq = function (c, v) { if (c === 'key') q._k = v; return q; };
            q.maybeSingle = async function () { return { data: cloudKV[q._k] !== undefined ? { value: cloudKV[q._k] } : null, error: null }; };
            return q; },
        upsert: async function (row) { cloudKV[row.key] = row.value; return { error: null }; },
    }; } },
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
(0, eval)(fs.readFileSync(path.join(__dirname, '..', 'global_field_locks.js'), 'utf8'));
global.window.getDivisionAgeOrder = (n) => ['Juniors'].filter(x => (n || []).indexOf(x) >= 0);

const origLog = console.log, origWarn = console.warn;
console.log = () => {};
require('../scheduler_core_leagues.js');
console.log = origLog;
const Leagues = global.window.SchedulerCoreLeagues;
assert.ok(Leagues && typeof Leagues.processRegularLeagues === 'function', 'engine loaded');

const LG = 'Spacing League';
const TEAMS = ['T1', 'T2', 'T3', 'T4'];
const TODAY = '2026-07-14';

// Four teams, two fields, three periods. Both fields are BASKETBALL plus one
// hockey rink, so a repeat is forced but the ENGINE STILL HAS A CHOICE of which
// repeat — which is the whole point.
const FIELDS = [
    { name: 'Court 1', activities: ['Basketball'] },
    { name: 'Court 2', activities: ['Basketball'] },
    { name: 'The Rink', activities: ['Hockey'] },
];
const SLOT = (i) => ({
    type: 'league', event: 'League Time', divName: 'Juniors', leagueName: LG,
    startTime: 780 + i * 60, endTime: 840 + i * 60, slots: [i],
});

function makeContext(blocks) {
    return {
        schedulableSlotBlocks: blocks,
        masterLeagues: { [LG]: {
            name: LG, enabled: true, divisions: ['Juniors'], teams: TEAMS.slice(),
            sports: ['Basketball', 'Hockey'], schedulingPriority: 'sport_variety',
        } },
        disabledLeagues: [],
        divisions: { Juniors: { bunks: ['J1'] } },
        fillBlock: function (block, pick) { block._filled = true; block._pick = pick; },
        fieldUsageBySlot: {}, activityProperties: {}, rotationHistory: {},
        fields: FIELDS, disabledFields: [],
    };
}
function gen(blocks, seedHistory) {
    global.localStorage._m = {};
    Object.keys(cloudKV).forEach(k => { delete cloudKV[k]; });   // else run 2 inherits run 1
    delete settings.leagueHistory;
    if (seedHistory) settings.leagueHistory = seedHistory;
    global.window.currentScheduleDate = TODAY;
    global.window._activeGenDate = TODAY;
    global.window.divisionTimes = { Juniors: blocks.map((_, i) => ({ startMin: 780 + i * 60, endMin: 840 + i * 60 })) };
    global.window.GlobalFieldLocks.reset();
    const ctx = makeContext(blocks);
    const lines = [];
    console.log = (...a) => { lines.push(a.join(' ')); };
    console.warn = () => {};
    try { Leagues.processRegularLeagues(ctx); }
    finally { console.log = origLog; console.warn = origWarn; }
    return { ctx, lines, assigned: lines.filter(l => l.indexOf('[SportVariety]') >= 0) };
}
// team → [sport per period], read off the tiles the engine wrote.
function sportsByPeriod(ctx) {
    const out = {};
    TEAMS.forEach(t => { out[t] = []; });
    ctx.schedulableSlotBlocks.forEach((b, period) => {
        const p = b._pick; if (!p) return;
        TEAMS.forEach(t => { out[t][period] = null; });
        (p._allMatchups || []).forEach(line => {
            const m = line.match(/^(.+?) vs (.+?) @ .*\((\w+)\)/);
            if (!m) return;
            out[m[1]][period] = m[3];
            out[m[2]][period] = m[3];
        });
    });
    return out;
}
function seedToday(entries) {
    return {
        gamesPerDate: {}, gameLog: { [LG]: { [TODAY]: entries } },
        chinuchByDate: {}, byesByDate: {}, ocTripsByDate: {},
        offCampusCounts: {}, _tombstones: {},
    };
}

(async () => {

// ---- TEST 1: the unit rule — drop the MORE RECENT repeat --------------------
// T1 played Basketball in "Game 1" (this morning) and Hockey in "Game 2" (the
// period that just finished). Both are repeats. Hockey must be held off.
{
    const hist = seedToday([
        { t1: 'T1', t2: 'T2', sport: 'Basketball', g: 'Game 1' },
        { t1: 'T1', t2: 'T2', sport: 'Hockey', g: 'Game 2' },
    ]);
    const pool = [
        { sport: 'Basketball', field: 'Court 1' },
        { sport: 'Hockey', field: 'The Rink' },
    ];
    const out = Leagues._testApplySameDayRepeatFilter
        ? Leagues._testApplySameDayRepeatFilter(pool, 'T1', 'T2', LG, hist, TODAY)
        : null;
    assert.ok(out, 'filter not exported for testing');
    assert.deepStrictEqual(out.map(o => o.sport), ['Basketball'],
        'expected the just-played Hockey to be held off, got ' + JSON.stringify(out.map(o => o.sport)));
    console.log('✅ TEST 1 — the sport from the previous period is dropped, the older repeat kept');
}

// ---- TEST 2: a genuinely fresh sport still wins -----------------------------
// Spacing must only arbitrate BETWEEN repeats — never outrank a sport the teams
// have not played at all today.
{
    const hist = seedToday([{ t1: 'T1', t2: 'T2', sport: 'Basketball', g: 'Game 1' }]);
    const pool = [
        { sport: 'Basketball', field: 'Court 1' },
        { sport: 'Hockey', field: 'The Rink' },
    ];
    const out = Leagues._testApplySameDayRepeatFilter(pool, 'T1', 'T2', LG, hist, TODAY);
    assert.deepStrictEqual(out.map(o => o.sport), ['Hockey'],
        'a not-yet-played sport must win outright: ' + JSON.stringify(out.map(o => o.sport)));
    console.log('✅ TEST 2 — an unplayed sport still beats every repeat');
}

// ---- TEST 3: back-to-back outranks 'fewest teams repeating' ----------------
// The exact shape that was going wrong in the real camp. Today so far:
//   Game 1  T1 vs T2  Basketball      (both played Basketball, an hour ago)
//   Game 2  T1 vs T3  Newcomb
//   Game 3  T1 vs T4  Hockey  +  T2 vs T3  Newcomb   <- the period just ended
// Now pair T1 vs T2 again, with all three sports open:
//   Basketball  repeats for BOTH, but neither just played it   -> no back-to-back
//   Newcomb     repeats for one (T2 JUST played it)            -> back-to-back
//   Hockey      repeats for one (T1 JUST played it)            -> back-to-back
// Ranking by 'fewest teams repeating' picks Hockey or Newcomb — a back-to-back —
// because Basketball 'repeats for both'. Ranking by back-to-back first picks
// Basketball, which is what anyone reading the sheet would want.
{
    const hist = seedToday([
        { t1: 'T1', t2: 'T2', sport: 'Basketball', g: 'Game 1' },
        { t1: 'T1', t2: 'T3', sport: 'Newcomb', g: 'Game 2' },
        { t1: 'T1', t2: 'T4', sport: 'Hockey', g: 'Game 3' },
        { t1: 'T2', t2: 'T3', sport: 'Newcomb', g: 'Game 3' },
    ]);
    const pool = [
        { sport: 'Basketball', field: 'Court 1' },
        { sport: 'Newcomb', field: 'Small Turf' },
        { sport: 'Hockey', field: 'The Rink' },
    ];
    const now = Leagues._testApplySameDayRepeatFilter(pool, 'T1', 'T2', LG, hist, TODAY);
    assert.deepStrictEqual(now.map(o => o.sport), ['Basketball'],
        'expected the non-back-to-back option, got ' + JSON.stringify(now.map(o => o.sport)));

    global.window.__leagueRepeatSpacing = false;
    let old;
    try { old = Leagues._testApplySameDayRepeatFilter(pool, 'T1', 'T2', LG, hist, TODAY); }
    finally { delete global.window.__leagueRepeatSpacing; }
    assert.ok(old.map(o => o.sport).indexOf('Basketball') < 0,
        'fixture is not adversarial — the old ranking already avoided the repeat: '
        + JSON.stringify(old.map(o => o.sport)));
    console.log('✅ TEST 3 — back-to-back beats fewest-repeats: picks '
        + JSON.stringify(now.map(o => o.sport)) + ', old ranking picked '
        + JSON.stringify(old.map(o => o.sport)));
}

// ---- TEST 4: an unplayed sport is still untouchable ------------------------
// Spacing reorders REPEATS. It must never promote a repeat over a sport the
// teams have not played today at all.
{
    const hist = seedToday([
        { t1: 'T1', t2: 'T2', sport: 'Basketball', g: 'Game 1' },
        { t1: 'T1', t2: 'T2', sport: 'Hockey', g: 'Game 2' },
    ]);
    const pool = [
        { sport: 'Basketball', field: 'Court 1' },
        { sport: 'Hockey', field: 'The Rink' },
        { sport: 'Newcomb', field: 'Small Turf' },
    ];
    const out = Leagues._testApplySameDayRepeatFilter(pool, 'T1', 'T2', LG, hist, TODAY);
    assert.deepStrictEqual(out.map(o => o.sport), ['Newcomb'],
        'an unplayed sport must win outright: ' + JSON.stringify(out.map(o => o.sport)));
    console.log('✅ TEST 4 — an unplayed sport still beats every repeat');
}



console.log('\n🎉 league_repeat_spacing_sim: all tests passed');
})().catch(e => { console.error('❌', e && e.message ? e.message : e); process.exit(1); });
