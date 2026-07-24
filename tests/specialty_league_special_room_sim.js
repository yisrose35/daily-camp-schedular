// =============================================================================
// specialty_league_special_room_sim.js
// -----------------------------------------------------------------------------
// Drives the REAL SchedulerCoreSpecialtyLeagues court-picking function to prove
// the "special rooms are special-only" invariant now holds for SPECIALTY
// leagues too.
//
// THE BUG THIS PINS (found 2026-07-23):
//   A court can also be a special activity's physical room — "Gym 1" is where
//   the "Basketball Clinic" runs. Specialty leagues are scheduled at STEP 4,
//   BEFORE Smart Tiles at STEP 6, and they LOCK every court they take. But the
//   Smart Tile gate (smart_logic_adapter canDivisionUseSpecial) tests
//   GlobalFieldLocks under the SPECIAL'S NAME, never under its host facility —
//   so a specialty league sitting on Gym 1 is completely invisible to the
//   clinic that lives there, and both get placed in the same room at the same
//   time. Regular leagues have excluded special rooms from their pool for
//   exactly this reason (buildAvailableFieldSportPool → _leagueSpecialRooms);
//   specialty leagues never did.
//
//   T1 the special's room is NOT handed to the specialty league
//   T2 ordinary courts are still handed out (the guard isn't over-blocking)
//   T3 a self-named special (location == its own name) is not a court, so
//      excluding it must be a no-op
//   T4 case / whitespace differences in the configured location still match
//   T5 no specials configured at all → every court still available
//   T6 killswitch restores the old behaviour
//   T7 a config read error fails OPEN (never drops every court)
// =============================================================================

'use strict';
const assert = require('assert');

global.localStorage = {
    _m: {},
    getItem(k) { return this._m[k] != null ? this._m[k] : null; },
    setItem(k, v) { this._m[k] = String(v); },
    removeItem(k) { delete this._m[k]; },
};
global.document = {
    readyState: 'complete', addEventListener: () => {}, removeEventListener: () => {},
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    createElement: () => ({ style: {}, appendChild() {}, classList: { add() {}, remove() {} } }),
    body: { appendChild() {} },
};
global.window = global;
global.addEventListener = () => {};
global.removeEventListener = () => {};

let SPECIALS = [];
let FIELDS = [];
global.loadGlobalSettings = () => ({ app1: { specialActivities: SPECIALS, fields: FIELDS } });
global.saveGlobalSettings = () => {};
global.currentScheduleDate = '2026-07-24';

require('../scheduler_core_specialty_leagues.js');
const SL = global.window.SchedulerCoreSpecialtyLeagues;
assert.ok(SL && typeof SL._assignMatchupsToFieldsAndSlots === 'function', 'module + test hook loaded');

// One division, one 60-minute period.
global.divisionTimes = { 'Grade 8': [{ startMin: 600, endMin: 660 }] };
global.divisions = { 'Grade 8': { bunks: ['8A'] } };

function freshHistory() {
    return {
        teamFieldRotation: {}, lastSlotOrder: {}, conferenceRounds: {},
        matchupHistory: {}, gamesPerDate: {}, gameLog: {}, slotDebt: {},
    };
}

// Ask the real engine to seat ONE matchup and report which courts it used.
function courtsUsed(courts, specials, opts) {
    opts = opts || {};
    SPECIALS = specials || [];
    FIELDS = courts.map(n => ({ name: n, activities: ['Basketball'], available: true }));
    global.currentDisabledFields = [];
    global.GlobalFieldLocks = undefined;
    global.fieldReservations = undefined;
    global.FieldCombos = undefined;
    global.activityProperties = {};
    global.isRainyDay = false;
    global.getFacilities = () => FIELDS.map(f => ({ name: f.name }));
    global.loadCurrentDailyData = () => ({});
    // Make ONLY the guard's own settings read throw (it is the first caller in
    // this function); later reads succeed, so this isolates the guard's
    // fail-open behaviour rather than a pre-existing unguarded read.
    if (opts.breakConfig) {
        let n = 0;
        const real = () => ({ app1: { specialActivities: SPECIALS, fields: FIELDS } });
        global.loadGlobalSettings = () => { n++; if (n === 1) throw new Error('config read blew up'); return real(); };
    }

    const league = {
        id: 'spec1', name: 'Hockey League', sport: 'Basketball',
        fields: courts.slice(), gamesPerFieldSlot: 1, divisions: ['Grade 8'],
    };
    const matchups = [{ teamA: 'A', teamB: 'B' }];
    let out;
    try {
        out = SL._assignMatchupsToFieldsAndSlots(matchups, league, freshHistory(), [0], 'Grade 8');
    } finally {
        if (opts.breakConfig) global.loadGlobalSettings = () => ({ app1: { specialActivities: SPECIALS, fields: FIELDS } });
    }
    return (out || []).map(a => a.field);
}

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
    if (cond) { pass++; console.log('  ✅ ' + name); }
    else { fail++; console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')); }
};

// ---------------------------------------------------------------- T1
{
    const used = courtsUsed(['Gym 1', 'Outdoor Court'],
        [{ name: 'Basketball Clinic', location: 'Gym 1' }]);
    check('T1 the special\'s room is never handed to a specialty league',
        !used.includes('Gym 1'), 'used: ' + JSON.stringify(used));
    check('T1 the game still gets a court (not dropped)',
        used.length === 1 && used[0] === 'Outdoor Court', 'used: ' + JSON.stringify(used));
}

// ---------------------------------------------------------------- T2
{
    const used = courtsUsed(['Gym 1', 'Outdoor Court'],
        [{ name: 'Arts & Crafts', location: 'Art Room' }]);
    check('T2 unrelated courts are untouched (no over-blocking)',
        used.length === 1 && ['Gym 1', 'Outdoor Court'].includes(used[0]), 'used: ' + JSON.stringify(used));
}

// ---------------------------------------------------------------- T3
{
    // A self-named special isn't a sport court at all — "Lake" runs at "Lake".
    // It must not remove a same-named court from an unrelated league pool.
    const used = courtsUsed(['Gym 1'], [{ name: 'Lake', location: 'Lake' }]);
    check('T3 a self-named special does not block unrelated courts',
        used.length === 1 && used[0] === 'Gym 1', 'used: ' + JSON.stringify(used));
}

// ---------------------------------------------------------------- T4
{
    const used = courtsUsed(['Gym 1', 'Outdoor Court'],
        [{ name: 'Basketball Clinic', location: '  gym 1 ' }]);
    check('T4 case/whitespace in the configured location still matches',
        !used.includes('Gym 1'), 'used: ' + JSON.stringify(used));
}

// ---------------------------------------------------------------- T5
{
    const used = courtsUsed(['Gym 1', 'Outdoor Court'], []);
    check('T5 no specials configured → nothing is dropped',
        used.length === 1, 'used: ' + JSON.stringify(used));
}

// ---------------------------------------------------------------- T6
{
    global.window.__specLeagueSpecialRoomGuard = false;
    const used = courtsUsed(['Gym 1'], [{ name: 'Basketball Clinic', location: 'Gym 1' }]);
    global.window.__specLeagueSpecialRoomGuard = undefined;
    check('T6 killswitch restores the old behaviour',
        used.length === 1 && used[0] === 'Gym 1', 'used: ' + JSON.stringify(used));
}

// ---------------------------------------------------------------- T7
{
    // If the settings read throws, the guard must NOT swallow every court —
    // a league losing all its courts is far worse than the risk it guards.
    const used = courtsUsed(['Gym 1'], [{ name: 'Basketball Clinic', location: 'Gym 1' }], { breakConfig: true });
    check('T7 a config read error fails OPEN (courts survive)',
        used.length === 1 && used[0] === 'Gym 1', 'used: ' + JSON.stringify(used));
}

console.log('\n' + (fail === 0 ? '🎉' : '💥') + ' specialty_league_special_room_sim: ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
