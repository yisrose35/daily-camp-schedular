// =============================================================================
// special_host_facility_lock_sim.js
// -----------------------------------------------------------------------------
// Drives the REAL SmartLogicAdapter.canDivisionUseSpecial to prove the
// HOST-FACILITY lock check.
//
// THE BUG (root cause behind the specialty-league double-book):
//   A special is physically IN a room — "Basketball Clinic" runs in "Gym 1".
//   Everything that competes for that room locks it under the ROOM's name:
//   leagues, specialty leagues, pinned tiles, preserved multi-scheduler
//   placements. canDivisionUseSpecial only ever asked "is anything locked under
//   the SPECIAL'S NAME?", so none of those were visible and the clinic could be
//   dropped into a room something else was already sitting in.
//
// THE THING THAT MAKES THIS DELICATE:
//   The room's own special must still be able to fill it. Several paths lock the
//   room the moment the FIRST bunk is seated there, so blocking on those locks
//   would stop the second bunk joining and silently shrink every shared special.
//   A lock is therefore only a conflict when it belongs to SOMETHING ELSE.
//
//   T1  a league lock on the room blocks the special            (the bug)
//   T2  the special's OWN locks never block it — all four shapes (sharing safe)
//   T3  a DIFFERENT special's lock on the same room blocks
//   T4  a self-named special (room == its own name) is unchanged
//   T5  no resolvable room → skipped (fail open)
//   T6  killswitch restores the old behaviour
//   T7  time-based: a lock on ANOTHER division's grid still blocks
//   T8  an unrelated room's lock never blocks
//   T9  the name-based check still works (no regression)
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
global.loadGlobalSettings = () => ({ app1: {} });

require('../smart_logic_adapter.js');
const SLA = global.window.SmartLogicAdapter;
assert.ok(SLA && typeof SLA.canDivisionUseSpecial === 'function', 'adapter + test hook loaded');

// Two divisions whose slot 0 is a DIFFERENT clock time — the classic trap that
// makes slot-index lock lookups wrong across grades.
global.divisionTimes = {
    'Grade 1': [{ startMin: 600, endMin: 660 }],
    'Grade 2': [{ startMin: 615, endMin: 675 }],
};

// Minimal GlobalFieldLocks with the real contract: name-keyed, time-overlap,
// and division locks that exempt their own division.
function installLocks(locks) {
    global.GlobalFieldLocks = {
        _find(name, s, e, div) {
            return (locks || []).find(l => {
                if (String(l.field).toLowerCase() !== String(name).toLowerCase()) return false;
                if (l.lockType === 'division' && l.allowedDivision && l.allowedDivision === div) return false;
                if (s != null && e != null && l.s != null) return l.s < e && l.e > s;
                return true;
            }) || null;
        },
        isFieldLocked(name, slots, div) { return this._find(name, null, null, div); },
        isFieldLockedByTime(name, s, e, div) { return this._find(name, s, e, div); },
    };
}

const CLINIC = 'Basketball Clinic';
const props = (loc) => (loc === undefined ? { location: 'Gym 1' } : (loc === null ? {} : { location: loc }));

function can(opts) {
    opts = opts || {};
    installLocks(opts.locks || []);
    global.getSpecialActivityByName = opts.byName || (() => null);
    global.getLocationForActivity = opts.byLoc || (() => '');
    global.__specialHostLockCheck = opts.killswitch === true ? false : undefined;
    return SLA.canDivisionUseSpecial(
        opts.division || 'Grade 1',
        opts.props !== undefined ? opts.props : props(),
        opts.name || CLINIC,
        opts.slots || [0]
    );
}

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
    if (cond) { pass++; console.log('  ✅ ' + name); }
    else { fail++; console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')); }
};

// ---------------------------------------------------------------- T1
{
    const ok = can({ locks: [{ field: 'Gym 1', s: 600, e: 660, lockedBy: 'regular_league', leagueName: 'Grade 8 League' }] });
    check('T1 a league holding the room blocks the special', ok === false, 'got ' + ok);
}

// ---------------------------------------------------------------- T2
{
    const shapes = [
        { lockedBy: 'smart_tile_special_location', activity: CLINIC + ' (smart tile @ Gym 1)' },
        { lockedBy: 'smart_tile_multi_guarantee', activity: CLINIC + ' (multi-guarantee)' },
        { lockedBy: 'special_activity_location', activity: CLINIC + ' (special @ Gym 1)' },
        { lockedBy: 'placed_special_facility', activity: 'Special: ' + CLINIC },
    ];
    let allOk = true, which = [];
    shapes.forEach(sh => {
        const ok = can({ locks: [Object.assign({ field: 'Gym 1', s: 600, e: 660 }, sh)] });
        if (ok !== true) { allOk = false; which.push(sh.lockedBy); }
    });
    check('T2 the special\'s own room lock never blocks it (capacity sharing safe)',
        allOk, 'blocked by: ' + which.join(', '));
}

// ---------------------------------------------------------------- T3
{
    const ok = can({ locks: [{ field: 'Gym 1', s: 600, e: 660, lockedBy: 'smart_tile_special_location', activity: 'Dodgeball Clinic (smart tile @ Gym 1)' }] });
    check('T3 a DIFFERENT special in the same room blocks', ok === false, 'got ' + ok);
}

// ---------------------------------------------------------------- T4
{
    // Self-named special: "Lake" runs at "Lake". The name check already covers
    // it; the host check must not fire a second time on the same key.
    const ok = can({ name: 'Lake', props: { location: 'Lake' }, locks: [] });
    check('T4 a self-named special is unaffected', ok === true, 'got ' + ok);
}

// ---------------------------------------------------------------- T5
{
    const ok = can({ props: {}, locks: [{ field: 'Gym 1', s: 600, e: 660, lockedBy: 'regular_league' }] });
    check('T5 no resolvable room → check skipped (fail open)', ok === true, 'got ' + ok);
}

// ---------------------------------------------------------------- T5b
{
    // location absent from props but resolvable via the canonical lookup —
    // the case-duplicated-special path.
    const ok = can({
        props: {},
        byName: (n) => (n === CLINIC ? { name: CLINIC, location: 'Gym 1' } : null),
        locks: [{ field: 'Gym 1', s: 600, e: 660, lockedBy: 'regular_league' }],
    });
    check('T5b room resolved via getSpecialActivityByName still blocks', ok === false, 'got ' + ok);
}

// ---------------------------------------------------------------- T6
{
    const ok = can({ killswitch: true, locks: [{ field: 'Gym 1', s: 600, e: 660, lockedBy: 'regular_league' }] });
    check('T6 killswitch restores the old behaviour', ok === true, 'got ' + ok);
}

// ---------------------------------------------------------------- T7
{
    // The lock was registered from Grade 2's grid (615-675). Grade 1 asks about
    // its slot 0 = 600-660. They overlap in TIME, so it must block — a
    // slot-index-only lookup would have compared the wrong windows.
    const ok = can({ division: 'Grade 1', locks: [{ field: 'Gym 1', s: 615, e: 675, lockedBy: 'specialty_league' }] });
    check('T7 a lock from another grade\'s grid still blocks (time-based)', ok === false, 'got ' + ok);
}

// ---------------------------------------------------------------- T7b
{
    // Disjoint in time → must NOT block.
    const ok = can({ division: 'Grade 1', locks: [{ field: 'Gym 1', s: 700, e: 760, lockedBy: 'specialty_league' }] });
    check('T7b a non-overlapping lock does not block', ok === true, 'got ' + ok);
}

// ---------------------------------------------------------------- T8
{
    const ok = can({ locks: [{ field: 'Some Other Court', s: 600, e: 660, lockedBy: 'regular_league' }] });
    check('T8 an unrelated room\'s lock never blocks', ok === true, 'got ' + ok);
}

// ---------------------------------------------------------------- T9
{
    const ok = can({ locks: [{ field: CLINIC, s: 600, e: 660, lockedBy: 'elective' }] });
    check('T9 the original name-based lock check still works', ok === false, 'got ' + ok);
}

// ---------------------------------------------------------------- helpers
{
    const same = SLA._lockIsSameSpecial;
    check('H1 "Swim" is not mistaken for a "Swimming" lock',
        same({ activity: 'Swimming (smart tile @ Pool)' }, 'Swim') === false);
    check('H2 exact-name lock counts as the same special',
        same({ activity: CLINIC }, CLINIC) === true);
    check('H3 a lock with no activity text is not treated as the same special',
        same({ lockedBy: 'regular_league' }, CLINIC) === false);
}

console.log('\n' + (fail === 0 ? '🎉' : '💥') + ' special_host_facility_lock_sim: ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
