/**
 * Tests for: CHECK 17 — span-aware pinned-vs-pinned facility conflicts
 * (annotatePinSpans + checkPinnedTileConflicts in validator.js)
 *
 * Two pinned tiles reserving the same facility at overlapping times flag —
 * UNLESS they're linked into one multi-grade span (spanGroup: the grades do
 * the activity together), or the facility's capacity allows sharing.
 *
 * Run with:  node --test tests/pinned_tile_conflicts.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// =====================================================================
// MOCK ENVIRONMENT
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
    body: { appendChild() {} },
    head: { appendChild() {} }
};

global.window = global;
global.addEventListener = function () {};
global.removeEventListener = function () {};

global.SchedulerCoreUtils = {
    parseTimeToMinutes(str) {
        if (typeof str === 'number') return str;
        if (!str) return null;
        const s = String(str).toLowerCase().trim();
        const m = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/);
        if (!m) return null;
        let h = parseInt(m[1], 10);
        const mm = parseInt(m[2], 10);
        if (m[3] === 'pm' && h !== 12) h += 12;
        if (m[3] === 'am' && h === 12) h = 0;
        return h * 60 + mm;
    }
    // no getFieldCapacity → validator falls back to getSharingRules
};

require('../validator.js');

const V = global.ScheduleValidator._v31;

// A pinned reservation as collectTimedUsages emits it (kind 'event').
function pinUsage(divName, facility, startMin, endMin, activity) {
    return {
        fkey: facility.toLowerCase().trim(),
        facility,
        divName,
        bunk: 'B1',
        owner: divName + ' — ' + (activity || facility),
        kind: 'event',
        startMin,
        endMin,
        activity: activity || facility
    };
}

beforeEach(() => {
    fakeStorage = {};
    global.dailyOverrideSkeleton = [];
    global.MasterSchedulerInternal = undefined;
    // No sharing config → getSharingRules default capacity (not sharable = 1)
    global.loadGlobalSettings = function () { return {}; };
});

describe('checkPinnedTileConflicts (CHECK 17)', () => {
    it('flags two unlinked pinned tiles on the same facility at the same time', () => {
        const usages = [
            pinUsage('4th Grade', 'Main Hall', 800, 860, 'Assembly'),
            pinUsage('5th Grade', 'Main Hall', 800, 860, 'Assembly')
        ];
        V.annotatePinSpans(usages);
        const errors = V.checkPinnedTileConflicts(usages, {});
        assert.equal(errors.length, 1);
        assert.match(errors[0], /Pinned Tile Conflict/);
        assert.match(errors[0], /Main Hall/);
    });

    it('PASSES when the colliding tiles are one multi-grade span (together)', () => {
        global.dailyOverrideSkeleton = [
            { id: 'a', type: 'custom', event: 'Assembly', division: '4th Grade', location: 'Main Hall', startTime: '1:20pm', endTime: '2:20pm', spanGroup: 'span_x', spanDivisions: ['4th Grade', '5th Grade'] },
            { id: 'b', type: 'custom', event: 'Assembly', division: '5th Grade', location: 'Main Hall', startTime: '1:20pm', endTime: '2:20pm', spanGroup: 'span_x', spanDivisions: ['4th Grade', '5th Grade'] }
        ];
        const usages = [
            pinUsage('4th Grade', 'Main Hall', 800, 860, 'Assembly'),
            pinUsage('5th Grade', 'Main Hall', 800, 860, 'Assembly')
        ];
        V.annotatePinSpans(usages);
        assert.equal(usages[0].spanGroup, 'span_x', 'usage linked to its skeleton span tile');
        assert.equal(usages[1].spanGroup, 'span_x');
        const errors = V.checkPinnedTileConflicts(usages, {});
        assert.deepEqual(errors, []);
    });

    it('still flags a THIRD unlinked tile colliding with a span pair', () => {
        global.dailyOverrideSkeleton = [
            { id: 'a', type: 'custom', event: 'Assembly', division: '4th Grade', location: 'Main Hall', startTime: '1:20pm', endTime: '2:20pm', spanGroup: 'span_x' },
            { id: 'b', type: 'custom', event: 'Assembly', division: '5th Grade', location: 'Main Hall', startTime: '1:20pm', endTime: '2:20pm', spanGroup: 'span_x' }
        ];
        const usages = [
            pinUsage('4th Grade', 'Main Hall', 800, 860, 'Assembly'),
            pinUsage('5th Grade', 'Main Hall', 800, 860, 'Assembly'),
            pinUsage('6th Grade', 'Main Hall', 830, 890, 'Regroup')
        ];
        V.annotatePinSpans(usages);
        const errors = V.checkPinnedTileConflicts(usages, {});
        assert.equal(errors.length, 1, 'the outsider still conflicts with the joint reservation');
    });

    it('does not flag non-overlapping pinned tiles', () => {
        const usages = [
            pinUsage('4th Grade', 'Main Hall', 800, 860, 'Assembly'),
            pinUsage('5th Grade', 'Main Hall', 900, 960, 'Assembly')
        ];
        V.annotatePinSpans(usages);
        assert.deepEqual(V.checkPinnedTileConflicts(usages, {}), []);
    });

    it('does not flag different facilities', () => {
        const usages = [
            pinUsage('4th Grade', 'Main Hall', 800, 860, 'Assembly'),
            pinUsage('5th Grade', 'Art Room', 800, 860, 'Art')
        ];
        assert.deepEqual(V.checkPinnedTileConflicts(usages, {}), []);
    });

    it("an OPEN facility (sharing type 'all') holds several pins without flagging", () => {
        const activityProperties = {
            'Main Hall': { sharableWith: { type: 'all' } }
        };
        const usages = [
            pinUsage('4th Grade', 'Main Hall', 800, 860, 'Assembly'),
            pinUsage('5th Grade', 'Main Hall', 800, 860, 'Assembly')
        ];
        const errors = V.checkPinnedTileConflicts(usages, activityProperties);
        assert.deepEqual(errors, [], "type 'all' facility is open to everyone by config");
    });

    it("a bunk-sharing capacity (type 'custom', cap 2, no listed divisions) does NOT excuse two grades' pins", () => {
        // This is the common sports-field config — capacity 2 means two bunks
        // of a grade share a court, not that two grades may both pin it.
        const activityProperties = {
            'Main Hall': { sharableWith: { type: 'custom', capacity: 2 } }
        };
        const usages = [
            pinUsage('4th Grade', 'Main Hall', 800, 860, 'Assembly'),
            pinUsage('5th Grade', 'Main Hall', 800, 860, 'Assembly')
        ];
        const errors = V.checkPinnedTileConflicts(usages, activityProperties);
        assert.equal(errors.length, 1, 'cross-grade pin collision flags despite bunk capacity 2');
    });

    it("type 'custom' WITH the divisions listed as allowed passes", () => {
        const activityProperties = {
            'Main Hall': { sharableWith: { type: 'custom', capacity: 2, divisions: ['4th Grade', '5th Grade'] } }
        };
        const usages = [
            pinUsage('4th Grade', 'Main Hall', 800, 860, 'Assembly'),
            pinUsage('5th Grade', 'Main Hall', 800, 860, 'Assembly')
        ];
        const errors = V.checkPinnedTileConflicts(usages, activityProperties);
        assert.deepEqual(errors, [], 'explicitly-allowed divisions may share by config');
    });

    it("type 'same_division' does NOT excuse pins from two different grades", () => {
        const activityProperties = {
            'Main Hall': { sharableWith: { type: 'same_division', capacity: 2 } }
        };
        const usages = [
            pinUsage('4th Grade', 'Main Hall', 800, 860, 'Assembly'),
            pinUsage('5th Grade', 'Main Hall', 800, 860, 'Assembly')
        ];
        const errors = V.checkPinnedTileConflicts(usages, activityProperties);
        assert.equal(errors.length, 1);
    });

    it('matches span tiles via reservedFields too', () => {
        global.dailyOverrideSkeleton = [
            { id: 'a', type: 'custom', event: 'Hockey Night', division: '4th Grade', reservedFields: ['Rink'], startTime: '1:20pm', endTime: '2:20pm', spanGroup: 'span_r' },
            { id: 'b', type: 'custom', event: 'Hockey Night', division: '5th Grade', reservedFields: ['Rink'], startTime: '1:20pm', endTime: '2:20pm', spanGroup: 'span_r' }
        ];
        const usages = [
            pinUsage('4th Grade', 'Rink', 800, 860, 'Hockey Night'),
            pinUsage('5th Grade', 'Rink', 800, 860, 'Hockey Night')
        ];
        V.annotatePinSpans(usages);
        assert.deepEqual(V.checkPinnedTileConflicts(usages, {}), []);
    });
});
