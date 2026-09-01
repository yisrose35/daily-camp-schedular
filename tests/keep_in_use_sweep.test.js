/**
 * Tests for: scheduler_core_main.js _keepFacilitiesInUse (STEP 7.96).
 *
 * Run with:  node --test tests/keep_in_use_sweep.test.js
 *
 * A facility flagged "Keep in use" in Facilities must never sit idle while
 * activities are running — as long as SOMEBODY is in there the camp is happy.
 * Leagues cover the periods they can (see tests/league_keep_in_use_sim.js);
 * this sweep is the backstop for every other period: it moves one bunk onto the
 * facility, preferring a Free slot, and never touches a commitment (a special,
 * a league game, a trip, lunch, or anything pinned / overridden / hand-edited).
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// =====================================================================
// MOCK ENVIRONMENT (scheduler_core_main.js top-level needs these)
// =====================================================================
let fakeStorage = {};
global.localStorage = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(fakeStorage, k) ? fakeStorage[k] : null; },
    setItem(k, v) { fakeStorage[k] = String(v); },
    removeItem(k) { delete fakeStorage[k]; }
};
global.document = {
    readyState: 'complete',
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
    createElement() { return { id: '', style: {}, classList: { add() {}, remove() {} }, appendChild() {}, addEventListener() {} }; },
    body: { appendChild() {} }
};
global.window = global;
global.addEventListener = function () {};
global.removeEventListener = function () {};

let FIELDS = [];
global.loadGlobalSettings = function () { return { app1: { fields: FIELDS } }; };

require('../scheduler_core_utils.js');   // real getKeepInUseFields
require('../scheduler_core_main.js');

const sweep = global._keepFacilitiesInUse;
assert.ok(typeof sweep === 'function', 'STEP 7.96 body is exposed');

// ---------------------------------------------------------------------
// A 3-period day. New Gym hosts Basketball only and must stay in use.
//   P1 600-660   P2 660-720   P3 720-780
// ---------------------------------------------------------------------
const P = [{ startMin: 600, endMin: 660 }, { startMin: 660, endMin: 720 }, { startMin: 720, endMin: 780 }];

function gymField(extra) {
    return Object.assign({
        name: 'New Gym', activities: ['Basketball'], available: true,
        keepInUse: { enabled: true }
    }, extra || {});
}

function setup(schedule, fields) {
    fakeStorage = {};
    FIELDS = fields || [
        gymField(),
        { name: 'Soccer Field', activities: ['Soccer'], available: true },
    ];
    global.__keepInUseSweep = undefined;
    global.__freeFillRotationGate = undefined;
    global.GenTrace = { active: false };
    global.GlobalFieldLocks = undefined;
    global.currentDisabledFields = [];
    global.loadCurrentDailyData = () => ({});
    global.RotationEngine = { getDaysSinceActivity: () => 5 };
    global.divisions = { Juniors: { bunks: Object.keys(schedule) } };
    global.divisionTimes = { Juniors: P.slice() };
    global._perBunkSlots = null;
    global.scheduleAssignments = schedule;
    return schedule;
}

const free = (i) => ({ field: 'Free', sport: null, _activity: 'Free', _startMin: P[i].startMin, _endMin: P[i].endMin });
const sport = (i, act, field) => ({ field: field, sport: act, _activity: act, _startMin: P[i].startMin, _endMin: P[i].endMin });
const lunch = (i) => ({ field: 'Lunch', sport: null, _activity: 'Lunch', _startMin: P[i].startMin, _endMin: P[i].endMin, _fixed: true });

const gymSlots = (sa) => {
    const out = [];
    Object.keys(sa).forEach(b => (sa[b] || []).forEach((e, i) => {
        if (e && e.field === 'New Gym') out.push({ bunk: b, idx: i, act: e._activity });
    }));
    return out;
};

describe('STEP 7.96 — keep-in-use facility sweep', () => {

    it('fills an idle period from a Free slot', () => {
        const sa = setup({
            A: [sport(0, 'Soccer', 'Soccer Field'), free(1), lunch(2)],
            B: [sport(0, 'Basketball', 'New Gym'), sport(1, 'Soccer', 'Soccer Field'), lunch(2)],
        });
        const res = sweep();
        assert.equal(res.filled, 1, 'exactly one idle period filled');
        const inGym = gymSlots(sa);
        assert.equal(inGym.length, 2, 'gym now busy in P1 and P2');
        assert.ok(inGym.some(g => g.bunk === 'A' && g.idx === 1 && g.act === 'Basketball'),
            'A\'s Free slot took the idle period, got ' + JSON.stringify(inGym));
        assert.equal(sa.A[1]._keepInUseForced, true, 'placement is tagged');
        assert.equal(sa.B[1].field, 'Soccer Field', 'B\'s real activity was left alone');
    });

    it('does not disturb a period the facility is already busy in', () => {
        const sa = setup({
            A: [sport(0, 'Basketball', 'New Gym'), sport(1, 'Basketball', 'New Gym'), lunch(2)],
            B: [sport(0, 'Soccer', 'Soccer Field'), free(1), lunch(2)],
        });
        const res = sweep();
        assert.equal(res.filled, 0, 'nothing forced');
        assert.equal(sa.B[1]._activity, 'Free', 'B keeps its Free slot');
    });

    it('displaces a plain sport when no Free slot is available', () => {
        const sa = setup({
            A: [sport(0, 'Soccer', 'Soccer Field'), sport(1, 'Soccer', 'Soccer Field'), lunch(2)],
            B: [sport(0, 'Soccer', 'Soccer Field'), sport(1, 'Soccer', 'Soccer Field'), lunch(2)],
        });
        const res = sweep();
        assert.equal(res.filled, 2, 'both activity periods covered');
        const inGym = gymSlots(sa);
        assert.equal(inGym.length, 2);
        assert.deepEqual(inGym.map(g => g.idx).sort(), [0, 1], 'one period each');
        assert.notEqual(inGym[0].bunk, inGym[1].bunk,
            'a DIFFERENT bunk covers each period — nobody gets Basketball twice in a day');
    });

    it('leaves a period uncovered rather than repeat an activity for the same bunk', () => {
        // One bunk, two periods, one gym sport → the second period genuinely
        // cannot be covered without giving that bunk Basketball twice.
        const sa = setup({
            A: [sport(0, 'Soccer', 'Soccer Field'), sport(1, 'Soccer', 'Soccer Field'), lunch(2)],
        });
        const res = sweep();
        assert.equal(res.filled, 1, 'the first period is covered');
        assert.equal(res.unfillable, 1, 'the second is reported, not faked');
        assert.equal(gymSlots(sa).length, 1);
    });

    it('prefers a Free slot over displacing a sport in the same period', () => {
        const sa = setup({
            A: [free(0), lunch(1), lunch(2)],
            B: [sport(0, 'Soccer', 'Soccer Field'), lunch(1), lunch(2)],
        });
        sweep();
        assert.equal(sa.A[0].field, 'New Gym', 'the Free slot was used');
        assert.equal(sa.B[0].field, 'Soccer Field', 'the real activity was left alone');
    });

    it('never pulls a bunk out of a special, a league game, a trip, or a pinned cell', () => {
        const sa = setup({
            A: [{ field: 'Art Room', sport: null, _activity: 'Arts & Crafts', _assignedSpecial: 'Arts & Crafts', _startMin: 600, _endMin: 660 }],
            B: [{ field: 'League: Grade 7', sport: 'Game 1', _activity: 'League: Grade 7', _leagueName: 'Grade 7', _h2h: true, _startMin: 600, _endMin: 660 }],
            C: [{ field: 'Zoo', sport: null, _activity: 'Trip', _isTrip: true, _startMin: 600, _endMin: 660 }],
            D: [Object.assign(sport(0, 'Soccer', 'Soccer Field'), { _pinned: true })],
        });
        const res = sweep();
        assert.equal(res.filled, 0, 'nothing was taken');
        assert.equal(res.unfillable, 0, 'and no window even offered a candidate');
        assert.equal(gymSlots(sa).length, 0);
    });

    it('moves a bunk already doing the activity elsewhere into the facility', () => {
        // The whole point: don't hand Basketball to somebody new when a bunk is
        // already playing it on another court — just move that game into the gym.
        const sa = setup({
            A: [sport(0, 'Basketball', 'Old Gym'), lunch(1)],
            B: [free(0), lunch(1)],
        }, [
            gymField(),
            { name: 'Old Gym', activities: ['Basketball'], available: true },
        ]);
        const res = sweep();
        assert.equal(res.filled, 1);
        assert.equal(sa.A[0].field, 'New Gym', 'A\'s existing Basketball moved into the gym');
        assert.equal(sa.A[0]._activity, 'Basketball', 'the activity is unchanged');
        assert.equal(sa.A[0]._keepInUseRedirected, true, 'tagged as a redirect, not a forced fill');
        assert.equal(sa.B[0]._activity, 'Free', 'nobody new was given Basketball');
    });

    it('moves a SHARED game into the facility as a whole when it can hold both', () => {
        const sa = setup({
            A: [sport(0, 'Basketball', 'Old Gym')],
            B: [sport(0, 'Basketball', 'Old Gym')],   // same court, same window
            C: [free(0)],
        }, [
            gymField({ sharableWith: { type: 'same_division', capacity: 2 } }),
            { name: 'Old Gym', activities: ['Basketball'], available: true },
        ]);
        sweep();
        assert.equal(sa.A[0].field, 'New Gym', 'both halves of the game moved');
        assert.equal(sa.B[0].field, 'New Gym');
        assert.equal(sa.C[0]._activity, 'Free', 'nobody new was given Basketball');
    });

    it('does not split a shared game when the facility cannot hold both', () => {
        const sa = setup({
            A: [sport(0, 'Basketball', 'Old Gym')],
            B: [sport(0, 'Basketball', 'Old Gym')],
            C: [free(0)],
        }, [
            gymField({ sharableWith: { type: 'not_sharable', capacity: 1 } }),
            { name: 'Old Gym', activities: ['Basketball'], available: true },
        ]);
        sweep();
        assert.equal(sa.A[0].field, 'Old Gym', 'the shared game is left intact');
        assert.equal(sa.B[0].field, 'Old Gym');
        assert.equal(sa.C[0].field, 'New Gym', 'the Free bunk covers the gym instead');
    });

    it('never gives a bunk an activity it already has today', () => {
        // A already has Basketball (redirected into the gym for P1). P2 is still
        // idle and A is the only bunk — giving A Basketball twice is not allowed.
        const sa = setup({
            A: [sport(0, 'Basketball', 'Old Gym'), free(1)],
        }, [
            gymField(),
            { name: 'Old Gym', activities: ['Basketball'], available: true },
        ]);
        const res = sweep();
        assert.equal(res.filled, 1, 'P1 covered by moving A\'s existing game in');
        assert.equal(res.unfillable, 1, 'P2 reported as uncoverable, not faked');
        assert.equal(sa.A[1]._activity, 'Free', 'A is not given Basketball a second time');
    });

    it('respects access restrictions on the facility', () => {
        const sa = setup({
            A: [free(0)],
        }, [gymField({ accessRestrictions: { enabled: true, divisions: { Seniors: true } } })]);
        const res = sweep();
        assert.equal(res.filled, 0, 'Juniors may not use the gym');
        assert.equal(sa.A[0]._activity, 'Free');
    });

    it('respects an Unavailable time rule on the facility', () => {
        const sa = setup({
            A: [free(0), free(1)],
        }, [gymField({ timeRules: [{ type: 'Unavailable', startMin: 600, endMin: 660 }] })]);
        sweep();
        assert.equal(sa.A[0]._activity, 'Free', 'P1 is inside the closed window');
        assert.equal(sa.A[1].field, 'New Gym', 'P2 is open and gets covered');
    });

    it('honours the configured "only between" window', () => {
        const sa = setup({
            A: [free(0), free(1), free(2)],
        }, [gymField({ keepInUse: { enabled: true, startMin: 660, endMin: 720 } })]);
        const res = sweep();
        assert.equal(res.filled, 1, 'only the configured window is covered');
        assert.equal(sa.A[0]._activity, 'Free');
        assert.equal(sa.A[1].field, 'New Gym');
        assert.equal(sa.A[2]._activity, 'Free');
    });

    it('skips a facility closed for today in Daily Adjustments', () => {
        const sa = setup({ A: [free(0)] });
        global.loadCurrentDailyData = () => ({ overrides: { disabledFields: ['New Gym'] } });
        const res = sweep();
        assert.equal(res.filled, 0);
        assert.equal(sa.A[0]._activity, 'Free');
    });

    it('treats a global field lock (league / pinned reservation) as "in use"', () => {
        const sa = setup({ A: [free(0)] });
        global.GlobalFieldLocks = { isFieldLockedByTime: (name) => name === 'New Gym' };
        const res = sweep();
        assert.equal(res.filled, 0, 'somebody already has the gym');
        assert.equal(res.covered, 1);
        assert.equal(sa.A[0]._activity, 'Free');
    });

    it('is an exact no-op when no facility opts in', () => {
        const sa = setup({ A: [free(0)] }, [{ name: 'New Gym', activities: ['Basketball'], available: true }]);
        assert.equal(sweep(), null, 'returns null — the caller logs nothing');
        assert.equal(sa.A[0]._activity, 'Free');
    });

    it('killswitch disables the sweep', () => {
        const sa = setup({ A: [free(0)] });
        global.__keepInUseSweep = false;
        assert.equal(sweep(), null);
        assert.equal(sa.A[0]._activity, 'Free');
        global.__keepInUseSweep = undefined;
    });

    it('relaxes the rotation gate only as a last resort', () => {
        // The engine hard-blocks Basketball for A (e.g. a fair-share cap), but A
        // is the only bunk that could cover the period — the facility wins.
        const sa = setup({ A: [free(0)] });
        global.RotationEngine = {
            getDaysSinceActivity: () => 5,
            CONFIG: { YESTERDAY_PENALTY: 50000 },
            calculateRotationScore: () => Infinity
        };
        const res = sweep();
        assert.equal(res.filled, 1, 'covered anyway');
        assert.equal(sa.A[0].field, 'New Gym');
    });

    // ---------------------------------------------------------------------
    // GRADE ROTATION (staggered grade clocks)
    // ---------------------------------------------------------------------
    // Grade 1 10:00-11:00 / 11:00-12:00, Grade 2 10:15-11:15 / 11:15-12:15.
    // Once Grade 1's first period is covered, EVERY Grade 2 period overlaps it,
    // so without rotation Grade 1 keeps the gym all day. With rotation on, the
    // grades take turns at the cost of a short gap at each handover.
    const STAG = {
        'Grade 1': [{ startMin: 600, endMin: 660 }, { startMin: 660, endMin: 720 }],
        'Grade 2': [{ startMin: 615, endMin: 675 }, { startMin: 675, endMin: 735 }],
    };
    const STAG_BUNKS = { 'Grade 1': ['1A', '1B'], 'Grade 2': ['2A', '2B'] };

    function setupStaggered(rotateGrades) {
        fakeStorage = {};
        FIELDS = [gymField({ keepInUse: { enabled: true, rotateGrades: rotateGrades } })];
        global.__keepInUseSweep = undefined;
        global.__freeFillRotationGate = undefined;
        global.GenTrace = { active: false };
        global.GlobalFieldLocks = undefined;
        global.currentDisabledFields = [];
        global.loadCurrentDailyData = () => ({});
        global.RotationEngine = { getDaysSinceActivity: () => 5 };
        global.divisions = { 'Grade 1': { bunks: STAG_BUNKS['Grade 1'] }, 'Grade 2': { bunks: STAG_BUNKS['Grade 2'] } };
        global.divisionTimes = STAG;
        global._perBunkSlots = null;
        const sa = {};
        Object.keys(STAG_BUNKS).forEach(g => STAG_BUNKS[g].forEach(b => {
            sa[b] = STAG[g].map(p => ({ field: 'Free', sport: null, _activity: 'Free', _startMin: p.startMin, _endMin: p.endMin }));
        }));
        global.scheduleAssignments = sa;
        return sa;
    }
    const gradesInGym = (sa) => {
        const out = {};
        Object.keys(sa).forEach(b => (sa[b] || []).forEach(e => {
            if (e && e.field === 'New Gym') { const g = b[0]; out[g] = (out[g] || 0) + 1; }
        }));
        return out;
    };

    it('staggered grades: rotation OFF keeps coverage seamless but one grade owns it', () => {
        const sa = setupStaggered(false);
        sweep();
        assert.deepEqual(gradesInGym(sa), { '1': 2 }, 'both slots went to the earliest grade');
        assert.equal(sa['1A'].concat(sa['1B']).filter(e => e.field === 'New Gym').length, 2);
        // seamless: 10:00-11:00 then 11:00-12:00, no gap between them
        const slots = [];
        Object.keys(sa).forEach(b => sa[b].forEach(e => { if (e.field === 'New Gym') slots.push(e); }));
        slots.sort((a, b) => a._startMin - b._startMin);
        assert.equal(slots[0]._endMin, slots[1]._startMin, 'no gap between the two gym slots');
    });

    it('staggered grades: rotation ON hands the facility to the other grade', () => {
        const sa = setupStaggered(true);
        sweep();
        const byGrade = gradesInGym(sa);
        assert.equal(byGrade['1'], 1, 'Grade 1 gets the first slot, got ' + JSON.stringify(byGrade));
        assert.equal(byGrade['2'], 1, 'Grade 2 gets the second, got ' + JSON.stringify(byGrade));
        const slots = [];
        Object.keys(sa).forEach(b => sa[b].forEach(e => { if (e.field === 'New Gym') slots.push(e); }));
        slots.sort((a, b) => a._startMin - b._startMin);
        assert.equal(slots[0]._startMin, 600, 'first slot still starts at the top of the day');
        assert.equal(slots[1]._startMin, 675, 'the handover starts on Grade 2\'s clock');
        assert.equal(slots[1]._startMin - slots[0]._endMin, 15, 'the handover costs exactly the 15-min stagger');
    });

    it('rotation is a no-op when every grade runs on the same clock', () => {
        // Same grid for both grades → no later-starting window to hand over to,
        // so rotation on/off must produce identical, gapless coverage.
        const same = { 'Grade 1': STAG['Grade 1'], 'Grade 2': STAG['Grade 1'] };
        const build = (rot) => {
            fakeStorage = {};
            FIELDS = [gymField({ keepInUse: { enabled: true, rotateGrades: rot } })];
            global.GenTrace = { active: false }; global.GlobalFieldLocks = undefined;
            global.currentDisabledFields = []; global.loadCurrentDailyData = () => ({});
            global.RotationEngine = { getDaysSinceActivity: () => 5 };
            global.divisions = { 'Grade 1': { bunks: ['1A', '1B'] }, 'Grade 2': { bunks: ['2A', '2B'] } };
            global.divisionTimes = same; global._perBunkSlots = null;
            const sa = {};
            ['1A', '1B', '2A', '2B'].forEach(b => {
                sa[b] = same['Grade 1'].map(p => ({ field: 'Free', sport: null, _activity: 'Free', _startMin: p.startMin, _endMin: p.endMin }));
            });
            global.scheduleAssignments = sa;
            sweep();
            const slots = [];
            Object.keys(sa).forEach(x => sa[x].forEach(e => { if (e.field === 'New Gym') slots.push(e._startMin + '-' + e._endMin); }));
            return slots.sort().join(',');
        };
        assert.equal(build(true), build(false), 'same clock → rotation changes nothing');
        assert.equal(build(true), '600-660,660-720', 'and the day is fully covered');
    });

    it('prefers a bunk the rotation gate allows over one it blocks', () => {
        const sa = setup({
            A: [free(0)],
            B: [free(0)],
        });
        global.RotationEngine = {
            getDaysSinceActivity: () => 5,
            CONFIG: { YESTERDAY_PENALTY: 50000 },
            calculateRotationScore: ({ bunkName }) => (bunkName === 'A' ? Infinity : 0)
        };
        sweep();
        assert.equal(sa.B[0].field, 'New Gym', 'the clean bunk took it');
        assert.equal(sa.A[0]._activity, 'Free');
    });
});
