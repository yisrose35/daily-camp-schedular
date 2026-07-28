/**
 * The drawn day grows to fit what is actually scheduled (auto_schedule_grid.js).
 *
 * The division's configured start/end used to be a hard window: every block was
 * positioned as a percentage of (endTime - startTime), so an activity stretched
 * past the end of the day — the single most common last-minute edit, "swim ran
 * long, push the rest back" — was drawn past 100% and clipped off the edge of
 * the grid. Post-edit resize was clamped to the configured end for exactly that
 * reason, which is what made lengthening an activity so painful.
 *
 * computeDayBounds treats the configured times as a FLOOR. Blocks carry their
 * own _startMin/_endMin and the window widens to cover them, rounded out to a
 * clean 15-minute mark so the ruler still reads sensibly. post_edit_system.js
 * reads the same helper (window.ScheduleDayBounds) so a drag and the render can
 * never disagree about where the day currently ends.
 *
 * Run with: node --test tests/schedule_day_bounds.test.js
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

global.window = global;
const noop = () => {};

function makeEl() {
    return {
        style: {}, dataset: {}, children: [],
        classList: { contains: () => false, add: noop, remove: noop },
        textContent: '', innerHTML: '',
        appendChild(c) { this.children.push(c); return c; },
        remove: noop, setAttribute: noop, addEventListener: noop,
        querySelector: () => null, querySelectorAll: () => [],
        getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
        offsetWidth: 0, offsetHeight: 0
    };
}
global.document = {
    readyState: 'complete', head: makeEl(), body: makeEl(), createElement: makeEl,
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener: noop
};
global.MutationObserver = class { observe() {} disconnect() {} };
global.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };

// The grid parses "09:00" through SchedulerCoreUtils, exactly as it does in the
// browser — load the real one rather than a stub that could drift.
require('../scheduler_core_utils.js');
require('../auto_schedule_grid.js');
const bounds = (div) => window.ScheduleDayBounds.get(div);

const DIV = 'Seniors';

function entry(activity, startMin, endMin) {
    return { field: activity, sport: activity, _activity: activity, _startMin: startMin, _endMin: endMin };
}

beforeEach(() => {
    // 9:00 – 12:00, four 45-minute periods.
    window.divisions = { [DIV]: { startTime: '09:00', endTime: '12:00', bunks: ['Bunk 1', 'Bunk 2'] } };
    window.divisionTimes = {
        [DIV]: [
            { startMin: 540, endMin: 585 }, { startMin: 585, endMin: 630 },
            { startMin: 630, endMin: 675 }, { startMin: 675, endMin: 720 }
        ]
    };
    window.scheduleAssignments = {
        'Bunk 1': [entry('Swim', 540, 585), entry('Soccer', 585, 630), entry('Art', 630, 675), entry('Lunch', 675, 720)],
        'Bunk 2': [entry('Art', 540, 585), entry('Swim', 585, 630), entry('Soccer', 630, 675), entry('Lunch', 675, 720)]
    };
    window.scheduleSegments = undefined;
    window.AutoSegmentModel = undefined;
});

describe('computeDayBounds', () => {
    it('uses the configured day when nothing runs past it', () => {
        const b = bounds(DIV);
        assert.equal(b.start, 540);
        assert.equal(b.end, 720);
        assert.equal(b.cfgEnd, 720);
    });

    it('grows the end of the day to cover a stretched last activity', () => {
        window.scheduleAssignments['Bunk 1'][3] = entry('Lunch', 675, 755);   // runs to 12:35
        const b = bounds(DIV);
        assert.equal(b.end, 765, 'rounded out to the next clean 12:45 mark');
        assert.equal(b.cfgEnd, 720, 'the configured end is still reported');
        assert.equal(b.start, 540, 'the start is untouched');
    });

    it('grows for ANY bunk in the division, not just the first', () => {
        window.scheduleAssignments['Bunk 2'][3] = entry('Lunch', 675, 780);
        assert.equal(bounds(DIV).end, 780);
    });

    it('grows the front of the day when an activity is pulled earlier', () => {
        window.scheduleAssignments['Bunk 1'][0] = entry('Swim', 500, 585);    // starts 8:20
        const b = bounds(DIV);
        assert.equal(b.start, 495, 'rounded back to 8:15');
        assert.equal(b.cfgStart, 540);
    });

    it('never shrinks below the configured day', () => {
        // A short schedule that ends well before noon must still draw to noon.
        window.scheduleAssignments = { 'Bunk 1': [entry('Swim', 540, 585)], 'Bunk 2': [] };
        const b = bounds(DIV);
        assert.equal(b.start, 540);
        assert.equal(b.end, 720);
    });

    it('falls back to a sane 9–4 window when the division is unconfigured', () => {
        window.divisions = {};
        window.scheduleAssignments = {};
        const b = bounds('Nonexistent');
        assert.equal(b.start, 540);
        assert.equal(b.end, 960);
    });

    it('survives a division whose bunks have no schedule at all', () => {
        window.scheduleAssignments = {};
        const b = bounds(DIV);
        assert.equal(b.start, 540);
        assert.equal(b.end, 720);
    });

    it('always returns a non-empty window', () => {
        window.divisions = { [DIV]: { startTime: '10:00', endTime: '10:00', bunks: [] } };
        window.scheduleAssignments = {};
        const b = bounds(DIV);
        assert.ok(b.end > b.start, 'a zero-width day would divide by zero in the renderer');
    });
});
