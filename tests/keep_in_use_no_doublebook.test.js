/**
 * Tests for: scheduler_core_main.js _keepFacilitiesInUse (STEP 7.96) —
 * THE FACILITY IS NEVER DOUBLE-BOOKED.
 *
 * Run with:  node --test tests/keep_in_use_no_doublebook.test.js
 *
 * The sweep's whole job is to put somebody into a facility that looks empty, so
 * every way a facility can ALREADY be occupied has to be visible to it. There
 * are three separate stores, and no single one of them sees everything:
 *
 *   1. window.scheduleAssignments — a bunk on the field by name. Seen directly.
 *   2. GlobalFieldLocks           — league games (their real field lives in the
 *                                   matchup text, NOT in entry.field), specialty
 *                                   leagues, pinned tiles (facility in
 *                                   _reservedFields), a placed special's physical
 *                                   room (STEP 6.95), elective division locks,
 *                                   and combined-field mutual exclusion.
 *   3. window.fieldReservations   — Daily-Adjustments reservation tiles, which
 *                                   the solver gates on via canBlockFit but the
 *                                   lock table does not always carry.
 *
 * Each test below occupies the gym through exactly ONE of those stores and
 * asserts the sweep refuses to place anything on top of it.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

let fakeStorage = {};
global.localStorage = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(fakeStorage, k) ? fakeStorage[k] : null; },
    setItem(k, v) { fakeStorage[k] = String(v); },
    removeItem(k) { delete fakeStorage[k]; }
};
global.document = {
    readyState: 'complete', getElementById: () => null, querySelector: () => null,
    querySelectorAll: () => [], addEventListener() {}, removeEventListener() {},
    createElement: () => ({ id: '', style: {}, classList: { add() {}, remove() {} }, appendChild() {}, addEventListener() {} }),
    body: { appendChild() {} }
};
global.window = global;
global.addEventListener = function () {};
global.removeEventListener = function () {};

let FIELDS = [];
global.loadGlobalSettings = function () { return { app1: { fields: FIELDS } }; };

require('../scheduler_core_utils.js');
require('../scheduler_core_main.js');
const sweep = global._keepFacilitiesInUse;

const P = [{ startMin: 600, endMin: 660 }, { startMin: 660, endMin: 720 }];
const GYM = 'New Gym';

// One free bunk in each of two grades — so if the sweep were going to place
// anything, it certainly could.
function setup(opts) {
    opts = opts || {};
    fakeStorage = {};
    FIELDS = [
        { name: GYM, activities: ['Basketball'], available: true, keepInUse: { enabled: true } },
        { name: 'Soccer Field', activities: ['Soccer'], available: true },
    ];
    global.__keepInUseSweep = undefined;
    global.__freeFillRotationGate = undefined;
    global.GenTrace = { active: false };
    global.GlobalFieldLocks = opts.locks || undefined;
    global.fieldReservations = opts.reservations || undefined;
    global.currentDisabledFields = [];
    global.loadCurrentDailyData = () => ({});
    global.RotationEngine = { getDaysSinceActivity: () => 5 };
    global.divisions = { 'Grade 1': { bunks: ['1A'] }, 'Grade 2': { bunks: ['2A'] } };
    global.divisionTimes = { 'Grade 1': P.slice(), 'Grade 2': P.slice() };
    global._perBunkSlots = null;
    const free = (i) => ({ field: 'Free', sport: null, _activity: 'Free', _startMin: P[i].startMin, _endMin: P[i].endMin });
    const sa = opts.assignments || { '1A': [free(0), free(1)], '2A': [free(0), free(1)] };
    global.scheduleAssignments = sa;
    return sa;
}

// Every (field, window) the schedule now claims — used to assert no overlap.
function claimsOn(sa, fieldName) {
    const out = [];
    Object.keys(sa).forEach(b => (sa[b] || []).forEach(e => {
        if (!e) return;
        const f = e.field || e._specialLocation;
        if (String(f).toLowerCase() === String(fieldName).toLowerCase()) {
            out.push({ bunk: b, s: e._startMin, e: e._endMin });
        }
    }));
    return out;
}
const overlaps = (a, b) => a.s < b.e && a.e > b.s;

// A minimal lock registry with the same contract as GlobalFieldLocks: any lock
// whose window overlaps the query blocks it.
function lockRegistry(locks) {
    return {
        isFieldLockedByTime(name, s, e) {
            const hit = (locks || []).find(l =>
                String(l.field).toLowerCase() === String(name).toLowerCase() && l.s < e && l.e > s);
            return hit ? { lockedBy: hit.by || 'test' } : null;
        }
    };
}

describe('STEP 7.96 — the facility is never double-booked', () => {

    it('leaves a period alone when a BUNK is already on the field (store 1)', () => {
        const sa = setup({
            assignments: {
                '1A': [{ field: GYM, sport: 'Basketball', _activity: 'Basketball', _startMin: 600, _endMin: 660 },
                       { field: 'Free', sport: null, _activity: 'Free', _startMin: 660, _endMin: 720 }],
                '2A': [{ field: 'Free', sport: null, _activity: 'Free', _startMin: 600, _endMin: 660 },
                       { field: 'Soccer Field', sport: 'Soccer', _activity: 'Soccer', _startMin: 660, _endMin: 720 }],
            }
        });
        sweep();
        const c = claimsOn(sa, GYM);
        assert.equal(c.filter(x => x.s === 600).length, 1, 'still exactly one occupant at 10:00');
    });

    it('never overlaps a LEAGUE game holding the field (store 2 — invisible to entry.field)', () => {
        // The bunk grid shows "League: Grade 1" as the field; the real court is
        // only in the matchup text. Nothing but the lock table knows.
        const sa = setup({
            locks: lockRegistry([{ field: GYM, s: 600, e: 660, by: 'regular_league' }]),
            assignments: {
                '1A': [{ field: 'League: Grade 1', sport: 'Game 1', _activity: 'League: Grade 1', _leagueName: 'G1', _h2h: true, _startMin: 600, _endMin: 660 },
                       { field: 'Free', sport: null, _activity: 'Free', _startMin: 660, _endMin: 720 }],
                '2A': [{ field: 'Free', sport: null, _activity: 'Free', _startMin: 600, _endMin: 660 },
                       { field: 'Free', sport: null, _activity: 'Free', _startMin: 660, _endMin: 720 }],
            }
        });
        sweep();
        claimsOn(sa, GYM).forEach(c =>
            assert.ok(!overlaps(c, { s: 600, e: 660 }),
                'placed ' + JSON.stringify(c) + ' on top of the league game'));
    });

    it("never overlaps a placed SPECIAL's physical room (store 2 — STEP 6.95 lock)", () => {
        // A smart tile placed "Basketball Clinic" whose room IS the gym. The
        // entry's field is the special's NAME, so only the 6.95 lock reveals it.
        const sa = setup({
            locks: lockRegistry([{ field: GYM, s: 600, e: 660, by: 'placed_special_facility' }]),
            assignments: {
                '1A': [{ field: 'Basketball Clinic', sport: null, _activity: 'Basketball Clinic', _assignedSpecial: 'Basketball Clinic', _startMin: 600, _endMin: 660 },
                       { field: 'Free', sport: null, _activity: 'Free', _startMin: 660, _endMin: 720 }],
                '2A': [{ field: 'Free', sport: null, _activity: 'Free', _startMin: 600, _endMin: 660 },
                       { field: 'Free', sport: null, _activity: 'Free', _startMin: 660, _endMin: 720 }],
            }
        });
        sweep();
        claimsOn(sa, GYM).forEach(c =>
            assert.ok(!overlaps(c, { s: 600, e: 660 }),
                'placed ' + JSON.stringify(c) + " on top of the clinic's room"));
    });

    it('never overlaps a PINNED tile reserving the field (store 2 — facility in _reservedFields)', () => {
        const sa = setup({
            locks: lockRegistry([{ field: GYM, s: 600, e: 660, by: 'pinned_event_location' }]),
            assignments: {
                '1A': [{ field: 'Masmidim', sport: null, _activity: 'Masmidim', _pinned: true, _reservedFields: [GYM], _startMin: 600, _endMin: 660 },
                       { field: 'Free', sport: null, _activity: 'Free', _startMin: 660, _endMin: 720 }],
                '2A': [{ field: 'Free', sport: null, _activity: 'Free', _startMin: 600, _endMin: 660 },
                       { field: 'Free', sport: null, _activity: 'Free', _startMin: 660, _endMin: 720 }],
            }
        });
        sweep();
        claimsOn(sa, GYM).forEach(c =>
            assert.ok(!overlaps(c, { s: 600, e: 660 }),
                'placed ' + JSON.stringify(c) + ' on top of the pinned reservation'));
    });

    it('never overlaps a DAILY-ADJUSTMENTS reservation (store 3 — not in the lock table)', () => {
        const sa = setup({
            reservations: { [GYM]: [{ startMin: 600, endMin: 660, division: 'Grade 2', event: 'Signup leagues' }] },
        });
        sweep();
        claimsOn(sa, GYM).forEach(c =>
            assert.ok(!overlaps(c, { s: 600, e: 660 }),
                'placed ' + JSON.stringify(c) + ' on top of the reservation'));
    });

    it("a reservation owned by the bunk's OWN division still blocks (no self-exemption)", () => {
        // A division-scoped lock exempts its own grade by design — that
        // exemption must NOT apply here, because the reserving tile is the thing
        // physically using the facility.
        const sa = setup({
            reservations: { [GYM]: [{ startMin: 600, endMin: 660, division: 'Grade 1', event: 'Signup leagues' }] },
        });
        sweep();
        claimsOn(sa, GYM).forEach(c =>
            assert.ok(!overlaps(c, { s: 600, e: 660 }),
                'placed ' + JSON.stringify(c) + " on its own division's reservation"));
    });

    it('never overlaps a COMBINED-field partner in use (store 2 — combo exclusion)', () => {
        // GlobalFieldLocks.isFieldLockedByTime reports combo conflicts as a lock,
        // so claiming Gym 1 while "Full Gym" is running is blocked.
        const sa = setup({
            locks: lockRegistry([{ field: GYM, s: 600, e: 660, by: 'combined_field' }]),
        });
        sweep();
        claimsOn(sa, GYM).forEach(c =>
            assert.ok(!overlaps(c, { s: 600, e: 660 }),
                'placed ' + JSON.stringify(c) + ' while its combo partner was in use'));
    });

    it('the REDIRECT path is gated too — an occupied target is never moved into', () => {
        // 2A is already playing Basketball elsewhere (a redirect candidate), but
        // the gym is locked. The redirect must not fire.
        const sa = setup({
            locks: lockRegistry([{ field: GYM, s: 600, e: 660, by: 'regular_league' }]),
            assignments: {
                '2A': [{ field: 'Outdoor Court', sport: 'Basketball', _activity: 'Basketball', _startMin: 600, _endMin: 660 }],
            }
        });
        sweep();
        assert.equal(sa['2A'][0].field, 'Outdoor Court', 'the redirect did not steal a locked facility');
        assert.equal(claimsOn(sa, GYM).length, 0);
    });

    it('two bunks are never put in a not-sharable facility at the same time', () => {
        const sa = setup({
            assignments: {
                '1A': [{ field: 'Free', sport: null, _activity: 'Free', _startMin: 600, _endMin: 660 }],
                '2A': [{ field: 'Free', sport: null, _activity: 'Free', _startMin: 600, _endMin: 660 }],
            }
        });
        FIELDS[0].sharableWith = { type: 'not_sharable', capacity: 1 };
        sweep();
        const c = claimsOn(sa, GYM);
        assert.equal(c.length, 1, 'exactly one bunk got it, got ' + JSON.stringify(c));
    });

    it('placements this sweep makes block each other (no self-collision)', () => {
        // Overlapping windows across grades: covering 10:00-11:00 must make the
        // overlapping 10:15-11:15 window count as busy, not get a second bunk.
        fakeStorage = {};
        FIELDS = [{ name: GYM, activities: ['Basketball'], available: true, keepInUse: { enabled: true, rotateGrades: false } }];
        global.GenTrace = { active: false }; global.GlobalFieldLocks = undefined;
        global.fieldReservations = undefined;
        global.currentDisabledFields = []; global.loadCurrentDailyData = () => ({});
        global.RotationEngine = { getDaysSinceActivity: () => 5 };
        global.divisions = { 'Grade 1': { bunks: ['1A'] }, 'Grade 2': { bunks: ['2A'] } };
        global.divisionTimes = { 'Grade 1': [{ startMin: 600, endMin: 660 }], 'Grade 2': [{ startMin: 615, endMin: 675 }] };
        global._perBunkSlots = null;
        const sa = {
            '1A': [{ field: 'Free', sport: null, _activity: 'Free', _startMin: 600, _endMin: 660 }],
            '2A': [{ field: 'Free', sport: null, _activity: 'Free', _startMin: 615, _endMin: 675 }],
        };
        global.scheduleAssignments = sa;
        sweep();
        const c = claimsOn(sa, GYM);
        assert.equal(c.length, 1, 'only one of the overlapping windows was filled, got ' + JSON.stringify(c));
    });
});
