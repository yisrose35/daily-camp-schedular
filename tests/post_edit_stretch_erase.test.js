/**
 * Post-edit usability: one-click ERASE and in-place STRETCH (post_edit_system.js).
 *
 * The two edits a head counselor makes at the last second are "that isn't
 * happening, rub it out" and "that ran long, give it another 15 and push the
 * rest of the day back". Both used to be the hardest things in the app:
 *
 *   - erase meant opening the modal and picking "Leave empty (Free)", and it
 *     left the activity counted in historicalCounts as though it had happened;
 *   - lengthening was routed through the MOVE applier, which re-maps a block
 *     onto the fixed period grid and refuses when the target slots are taken —
 *     so growing over a neighbour just bounced with "those slots are occupied".
 *
 * Resizing now writes the entry's own _startMin/_endMin (which is what the grid
 * renders from) and pushes the rest of the day when it has to. Growing past the
 * configured end of day is allowed — the drawn day grows to meet it.
 *
 * This loads the REAL post_edit_system.js against a DOM stub rather than copying
 * logic into the test, so the assertions can't drift from the shipped code.
 *
 * Run with: node --test tests/post_edit_stretch_erase.test.js
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// =====================================================================
// MINIMAL DOM / BROWSER STUBS
// =====================================================================

global.window = global;
const noop = () => {};

function makeEl() {
    return {
        style: {}, dataset: {}, children: [],
        classList: { contains: () => false, add: noop, remove: noop },
        textContent: '', innerHTML: '',
        appendChild(c) { this.children.push(c); return c; },
        removeChild: noop, remove: noop, setAttribute: noop, getAttribute: () => null,
        addEventListener: noop, removeEventListener: noop,
        querySelector: () => null, querySelectorAll: () => [],
        getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
        closest: () => null, focus: noop, contains: () => false,
        offsetWidth: 0, offsetHeight: 0
    };
}

global.document = {
    readyState: 'complete',
    head: makeEl(), body: makeEl(),
    createElement: makeEl,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: noop, removeEventListener: noop,
    dispatchEvent: noop
};
global.MutationObserver = class { observe() {} disconnect() {} };
global.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
// node ≥21 defines a getter-only global navigator — leave it alone.

function memStore() {
    let s = {};
    return {
        getItem: (k) => (Object.prototype.hasOwnProperty.call(s, k) ? s[k] : null),
        setItem: (k, v) => { s[k] = String(v); },
        removeItem: (k) => { delete s[k]; },
        clear: () => { s = {}; }
    };
}
global.localStorage = memStore();
global.sessionStorage = memStore();

// Timers are inert: the module schedules re-render / undo-restore callbacks we
// don't want firing mid-assertion.
global.setTimeout = () => 0;
global.clearTimeout = noop;

// Owner role so canEditBunk() allows every write.
window.AccessControl = { isInitialized: true, getCurrentRole: () => 'owner' };

const PEI = (() => {
    require('../post_edit_system.js');
    return window.PostEditInteractions;
})();

// =====================================================================
// FIXTURE — one division, one bunk, four 45-minute periods from 9:00
// =====================================================================

const DIV = 'Seniors';
const BUNK = 'Bunk 1';

/** 9:00–9:45, 9:45–10:30, 10:30–11:15, 11:15–12:00 */
function slots() {
    return [
        { startMin: 540, endMin: 585 },
        { startMin: 585, endMin: 630 },
        { startMin: 630, endMin: 675 },
        { startMin: 675, endMin: 720 }
    ];
}

function entry(activity, startMin, endMin, extra) {
    return Object.assign({
        field: activity, sport: activity, _activity: activity,
        _startMin: startMin, _endMin: endMin, _blockStart: startMin
    }, extra || {});
}

let savedCounts;

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    PEI.undoStack.length = 0;

    window.divisions = { [DIV]: { startTime: '09:00', endTime: '12:00', bunks: [BUNK] } };
    window.divisionTimes = { [DIV]: slots() };
    window.scheduleAssignments = {
        [BUNK]: [
            entry('Swim', 540, 585),
            entry('Soccer', 585, 630),
            entry('Art', 630, 675),
            entry('Lunch', 675, 720)
        ]
    };
    window.ScheduleDayBounds = undefined;   // exercise the config fallback
    window.commitManualWriteIfLegal = undefined;
    window.ScheduleDB = undefined;
    window.updateTable = noop;
    window.UnifiedScheduleSystem = undefined;

    savedCounts = { [BUNK]: { Swim: 3, Soccer: 1, Art: 2, Lunch: 5 } };
    window.loadGlobalSettings = () => ({ historicalCounts: savedCounts });
    window.saveGlobalSettings = (key, val) => { if (key === 'historicalCounts') savedCounts = val; };
    window.loadRotationHistory = () => ({ bunks: {}, leagues: {} });
    window.saveRotationHistory = noop;
    window.SchedulerCoreUtils = {
        applyPostEditCounts: window.applyPostEditCounts
    };
});

// Load the real counts helper once and hand it to the stub above.
require('../scheduler_core_utils.js');
window.getValidActivityNames = undefined;

const row = () => window.scheduleAssignments[BUNK];

// =====================================================================
// STRETCH — lengthen / shorten in place
// =====================================================================

describe('applyStretch — lengthening into free time', () => {
    it('writes the new span onto the entry and does not push anything', () => {
        // Clear the 9:45 block so Swim has room to grow into it.
        row()[1] = null;

        const res = PEI.applyStretch(BUNK, DIV, 0, 540, 585, 540, 615);

        assert.equal(res.ok, true);
        assert.equal(res.ripple, 0, 'growth fits in the gap — nothing to push');
        assert.equal(row()[0]._startMin, 540);
        assert.equal(row()[0]._endMin, 615);
        assert.equal(row()[0]._postEdited, true);
        // Untouched neighbours keep their times.
        assert.equal(row()[2]._startMin, 630);
    });

    it('keeps the block on its own slot index instead of re-mapping it', () => {
        row()[1] = null;
        PEI.applyStretch(BUNK, DIV, 0, 540, 585, 540, 615);
        assert.equal(row()[0]._activity, 'Swim', 'Swim stays at slot 0');
        assert.equal(row()[1], null, 'growing does not claim the neighbouring slot');
    });
});

describe('applyStretch — lengthening over the next block', () => {
    it('pushes the rest of the day back by exactly the overlap', () => {
        // Swim 9:00–9:45 grows to 10:00 — a 15-minute overlap with Soccer.
        const res = PEI.applyStretch(BUNK, DIV, 0, 540, 585, 540, 600);

        assert.equal(res.ok, true);
        assert.equal(res.ripple, 15);
        assert.equal(row()[0]._endMin, 600, 'Swim now runs to 10:00');
        assert.equal(row()[1]._startMin, 600, 'Soccer starts when Swim ends');
        assert.equal(row()[1]._endMin, 645);
        assert.equal(row()[2]._startMin, 645, 'Art slides too');
        assert.equal(row()[3]._startMin, 690, 'and so does Lunch');
    });

    it('marks every pushed entry as post-edited so the save carries them', () => {
        PEI.applyStretch(BUNK, DIV, 0, 540, 585, 540, 600);
        [1, 2, 3].forEach(i => assert.equal(row()[i]._postEdited, true, `slot ${i} flagged`));
    });

    it('leaves earlier blocks alone', () => {
        // Grow Art (slot 2); Swim and Soccer must not move.
        PEI.applyStretch(BUNK, DIV, 2, 630, 675, 630, 690);
        assert.equal(row()[0]._startMin, 540);
        assert.equal(row()[1]._startMin, 585);
        assert.equal(row()[3]._startMin, 690, 'only Lunch is pushed');
    });
});

describe('applyStretch — past the end of the day', () => {
    it('lets the last block run past the configured end and reports the day grew', () => {
        const res = PEI.applyStretch(BUNK, DIV, 3, 675, 720, 675, 750);

        assert.equal(res.ok, true);
        assert.equal(res.ripple, 0, 'nothing after Lunch to push');
        assert.equal(res.dayGrew, true, 'the drawn day has to grow to 12:30');
        assert.equal(row()[3]._endMin, 750);
    });

    it('a ripple that runs past the end of the day carries the tail with it', () => {
        // Soccer grows by 90 minutes: Art and Lunch both end up past 12:00.
        const res = PEI.applyStretch(BUNK, DIV, 1, 585, 630, 585, 720);
        assert.equal(res.ripple, 90);
        assert.equal(row()[3]._endMin, 810, 'Lunch now ends at 1:30');
        assert.equal(res.dayGrew, true);
    });
});

describe('applyStretch — shortening', () => {
    it('leaves a gap rather than pulling the day forward', () => {
        const res = PEI.applyStretch(BUNK, DIV, 0, 540, 585, 540, 570);
        assert.equal(res.ok, true);
        assert.equal(res.ripple, 0);
        assert.equal(row()[0]._endMin, 570);
        assert.equal(row()[1]._startMin, 585, 'Soccer stays put — 570→585 is now free');
    });

    it('refuses to shrink below the minimum block length', () => {
        const res = PEI.applyStretch(BUNK, DIV, 0, 540, 585, 540, 542);
        assert.equal(res.ok, false);
        assert.equal(row()[0]._endMin, 585, 'unchanged');
    });
});

describe('rippleDeltaFor', () => {
    it('is zero when the growth fits before the next block', () => {
        row()[1] = null;
        assert.equal(PEI.rippleDeltaFor(BUNK, DIV, 0, 585, 615), 0);
    });

    it('is zero when shrinking', () => {
        assert.equal(PEI.rippleDeltaFor(BUNK, DIV, 0, 585, 560), 0);
    });

    it('is the overlap with the next block when growing over it', () => {
        assert.equal(PEI.rippleDeltaFor(BUNK, DIV, 0, 585, 605), 20);
    });
});

describe('applyStretch — legality gate', () => {
    it('refuses a hard-blocked span and leaves the schedule untouched', () => {
        window.commitManualWriteIfLegal = () => ({ ok: false, soft: false, reason: 'Pool closed after 11' });
        const res = PEI.applyStretch(BUNK, DIV, 0, 540, 585, 540, 600);
        assert.equal(res.ok, false);
        assert.equal(row()[0]._endMin, 585);
        assert.equal(row()[1]._startMin, 585, 'no ripple ran');
    });

    it('runs the gate against the NEW span, not the old one', () => {
        const seen = [];
        window.commitManualWriteIfLegal = (bunk, slotIdx, act, loc, div, s, e) => {
            seen.push([s, e]);
            return { ok: true };
        };
        PEI.applyStretch(BUNK, DIV, 0, 540, 585, 540, 600);
        assert.deepEqual(seen[0], [540, 600]);
    });
});

// =====================================================================
// ERASE
// =====================================================================

describe('deleteBlock — one-click erase', () => {
    it('clears the entry and every continuation slot behind it', () => {
        window.scheduleAssignments[BUNK] = [
            entry('Swim', 540, 630),
            { field: 'Swim', sport: 'Swim', _activity: 'Swim', continuation: true },
            entry('Art', 630, 675),
            entry('Lunch', 675, 720)
        ];

        PEI.deleteBlock(BUNK, 0, DIV, 'Swim');

        assert.equal(row()[0], null);
        assert.equal(row()[1], null, 'the continuation goes with it');
        assert.notEqual(row()[2], null, 'Art survives');
    });

    it('takes the erased activity back off the rotation books', () => {
        assert.equal(savedCounts[BUNK].Soccer, 1);
        PEI.deleteBlock(BUNK, 1, DIV, 'Soccer');
        assert.equal(savedCounts[BUNK].Soccer, 0,
            'a game that never happened must not keep counting toward rotation');
        assert.equal(savedCounts[BUNK].Swim, 3, 'other activities untouched');
    });

    it('never drives a count below zero', () => {
        savedCounts[BUNK].Soccer = 0;
        PEI.deleteBlock(BUNK, 1, DIV, 'Soccer');
        assert.equal(savedCounts[BUNK].Soccer, 0);
    });

    it('records an undo transaction carrying the counts inverse', () => {
        PEI.deleteBlock(BUNK, 1, DIV, 'Soccer');
        const tx = PEI.undoStack[PEI.undoStack.length - 1];
        assert.ok(tx, 'a transaction was pushed');
        assert.equal(tx.bunks[0].bunk, BUNK);
        assert.equal(tx.counts[0].newAct, null);
        assert.deepEqual(tx.counts[0].oldActs, ['Soccer']);
    });

    it('undo puts the activity back and re-credits the count', () => {
        PEI.deleteBlock(BUNK, 1, DIV, 'Soccer');
        assert.equal(row()[1], null);
        assert.equal(savedCounts[BUNK].Soccer, 0);

        PEI.undo();

        assert.ok(row()[1], 'Soccer is back');
        assert.equal(row()[1]._activity, 'Soccer');
        assert.equal(savedCounts[BUNK].Soccer, 1, 'and so is its rotation credit');
    });

    it('refuses when the user cannot edit that bunk', () => {
        window.AccessControl = { isInitialized: true, getCurrentRole: () => 'scheduler' };
        window.getEditableBunks = () => new Set();
        try {
            PEI.deleteBlock(BUNK, 1, DIV, 'Soccer');
            assert.notEqual(row()[1], null, 'the block is still there');
        } finally {
            window.AccessControl = { isInitialized: true, getCurrentRole: () => 'owner' };
        }
    });
});

// =====================================================================
// DAY BOUNDS
// =====================================================================

describe('dayBounds', () => {
    it('falls back to the configured day when the grid module is absent', () => {
        const b = PEI.dayBounds(DIV);
        assert.equal(b.start, 540);
        assert.equal(b.end, 720);
    });

    it('defers to the grid so a drag and the render agree on the day', () => {
        window.ScheduleDayBounds = { get: () => ({ start: 540, end: 780, cfgStart: 540, cfgEnd: 720 }) };
        const b = PEI.dayBounds(DIV);
        assert.equal(b.end, 780, 'uses the grown window the grid is drawing');
        assert.equal(b.cfgEnd, 720, 'and still reports where the day was configured to end');
    });
});

// =====================================================================
// GUARDS
// =====================================================================

describe('slot-index guards', () => {
    it('an erase with no real slot behind it leaves the array clean', () => {
        // Freshly injected sub-entry blocks carry slotIdx -1.
        PEI.deleteBlock(BUNK, -1, DIV, 'Phantom');
        assert.equal(row().length, 4, 'no junk index was appended');
        assert.ok(!Object.prototype.hasOwnProperty.call(row(), '-1'), 'no "-1" property stamped on the array');
        assert.ok(row()[0], 'nothing real was touched');
    });

    it('applyStretch refuses to push the tail of the day past midnight', () => {
        const res = PEI.applyStretch(BUNK, DIV, 0, 540, 585, 540, 1430);
        assert.equal(res.ok, false);
        assert.equal(row()[0]._endMin, 585, 'unchanged');
        assert.equal(row()[3]._endMin, 720, 'the tail never moved');
    });
});
