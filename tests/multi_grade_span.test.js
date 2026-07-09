/**
 * Tests for: multi-grade tile spanning in the manual skeleton builder
 * (span helpers + horizontal-resize commit logic in master_schedule_builder.js)
 *
 * Data model under test: each spanned grade keeps its OWN skeleton event;
 * members are linked by a shared `spanGroup` id + `spanDivisions` list.
 *
 * Run with:  node --test tests/multi_grade_span.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// =====================================================================
// MOCK ENVIRONMENT — browser globals master_schedule_builder.js touches
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

// Grades in display order (getColumnOrder reads window.availableDivisions)
global.availableDivisions = ['3rd Grade', '4th Grade', '5th Grade', '6th Grade'];

// One league that covers 4th–6th but NOT 3rd — lets us verify league remap
// on mirrors ("4th and 5th grade leagues" is one league spanning grades).
global.loadGlobalSettings = function () {
    return {
        leaguesByName: {
            'Junior League': { enabled: true, divisions: ['4th Grade', '5th Grade', '6th Grade'] }
        }
    };
};

require('../master_schedule_builder.js');

const MSI = global.MasterSchedulerInternal;

function leagueTile(division, overrides) {
    return Object.assign({
        id: 'evt_' + Math.random().toString(36).slice(2, 9),
        type: 'league',
        event: 'Junior League',
        leagueName: 'Junior League',
        division,
        startTime: '10:00am',
        endTime: '11:00am'
    }, overrides || {});
}

beforeEach(() => {
    fakeStorage = {};
    MSI.setSkeleton([]);
});

// =====================================================================
describe('commitSpanResize — drag right to cover a neighbor grade', () => {
    it('creates a linked mirror event in the newly covered grade', () => {
        const src = leagueTile('4th Grade');
        MSI.setSkeleton([src]);

        MSI.commitSpanResize(src, ['4th Grade', '5th Grade']);

        const skel = MSI.dailySkeleton;
        assert.equal(skel.length, 2);
        const fourth = skel.find(e => e.division === '4th Grade');
        const fifth = skel.find(e => e.division === '5th Grade');
        assert.ok(fourth && fifth, 'both grades have an event');
        assert.ok(fourth.spanGroup, 'span group assigned');
        assert.equal(fourth.spanGroup, fifth.spanGroup, 'members share the span group');
        assert.deepEqual(fourth.spanDivisions, ['4th Grade', '5th Grade']);
        assert.deepEqual(fifth.spanDivisions, ['4th Grade', '5th Grade']);
        assert.notEqual(fourth.id, fifth.id, 'mirror gets its own id');
        assert.equal(fifth.startTime, '10:00am');
        assert.equal(fifth.endTime, '11:00am');
        assert.equal(fifth.leagueName, 'Junior League', 'league covering the new grade is kept');
    });

    it('growing an existing span keeps the existing members (same ids)', () => {
        const src = leagueTile('4th Grade');
        MSI.setSkeleton([src]);
        MSI.commitSpanResize(src, ['4th Grade', '5th Grade']);
        const idsBefore = MSI.dailySkeleton.map(e => e.id).sort();

        MSI.commitSpanResize(MSI.dailySkeleton.find(e => e.division === '4th Grade'),
            ['4th Grade', '5th Grade', '6th Grade']);

        const skel = MSI.dailySkeleton;
        assert.equal(skel.length, 3);
        idsBefore.forEach(id => assert.ok(skel.some(e => e.id === id), 'existing member survived: ' + id));
        skel.forEach(e => assert.deepEqual(e.spanDivisions, ['4th Grade', '5th Grade', '6th Grade']));
        assert.equal(new Set(skel.map(e => e.spanGroup)).size, 1, 'one shared group id');
    });

    it('shrinking back to one grade removes mirrors and clears span fields', () => {
        const src = leagueTile('4th Grade');
        MSI.setSkeleton([src]);
        MSI.commitSpanResize(src, ['4th Grade', '5th Grade', '6th Grade']);
        assert.equal(MSI.dailySkeleton.length, 3);

        MSI.commitSpanResize(MSI.dailySkeleton.find(e => e.division === '4th Grade'), ['4th Grade']);

        const skel = MSI.dailySkeleton;
        assert.equal(skel.length, 1);
        assert.equal(skel[0].division, '4th Grade');
        assert.equal(skel[0].spanGroup, undefined, 'span group cleared');
        assert.equal(skel[0].spanDivisions, undefined, 'span divisions cleared');
    });

    it('dragging the left edge out re-anchors onto the surviving grades', () => {
        const src = leagueTile('4th Grade');
        MSI.setSkeleton([src]);
        MSI.commitSpanResize(src, ['4th Grade', '5th Grade']);
        const anchor = MSI.dailySkeleton.find(e => e.division === '4th Grade');

        // Left-edge dragged right past the anchor's own column: only 5th stays.
        MSI.commitSpanResize(anchor, ['5th Grade']);

        const skel = MSI.dailySkeleton;
        assert.equal(skel.length, 1);
        assert.equal(skel[0].division, '5th Grade');
        assert.equal(skel[0].spanGroup, undefined);
    });

    it('mirror into a grade without the league clears the league reference', () => {
        const src = leagueTile('4th Grade');
        MSI.setSkeleton([src]);

        // 3rd Grade is not in Junior League.
        MSI.commitSpanResize(src, ['3rd Grade', '4th Grade']);

        const third = MSI.dailySkeleton.find(e => e.division === '3rd Grade');
        assert.ok(third, '3rd grade mirror exists');
        assert.equal(third.leagueName, undefined, 'league not assigned to 3rd is dropped');
        assert.equal(third.event, 'League Game', 'label reverts to generic');
    });

    it('mirrors never carry split-tile bunk groups from the source grade', () => {
        const src = leagueTile('4th Grade', { type: 'split', event: 'Swim / Sports', group1Bunks: ['B1', 'B2'] });
        delete src.leagueName;
        MSI.setSkeleton([src]);

        MSI.commitSpanResize(src, ['4th Grade', '5th Grade']);

        const fifth = MSI.dailySkeleton.find(e => e.division === '5th Grade');
        assert.equal(fifth.group1Bunks, undefined, 'source-grade bunk groups stripped');
        const fourth = MSI.dailySkeleton.find(e => e.division === '4th Grade');
        assert.deepEqual(fourth.group1Bunks, ['B1', 'B2'], 'source keeps its own groups');
    });
});

// =====================================================================
describe('league remap on span/copy — shared league stays shared', () => {
    const restore = global.loadGlobalSettings;

    it('keeps the shared league when the new grade also plays in it (multi-league grade)', () => {
        // 5th Grade plays in TWO leagues; its "first" league is NOT the shared
        // one. Spanning a Junior League tile from 4th into 5th must keep
        // Junior League — remapping to 5th's first league would split one
        // spanned game into two different leagues with different matchups.
        global.loadGlobalSettings = () => ({
            leaguesByName: {
                'Fifth Grade League': { enabled: true, divisions: ['5th Grade'] },
                'Junior League': { enabled: true, divisions: ['4th Grade', '5th Grade', '6th Grade'] }
            }
        });
        try {
            const src = leagueTile('4th Grade');
            MSI.setSkeleton([src]);
            MSI.commitSpanResize(src, ['4th Grade', '5th Grade']);

            const fifth = MSI.dailySkeleton.find(e => e.division === '5th Grade');
            assert.equal(fifth.leagueName, 'Junior League', 'shared league kept on the mirror');
        } finally {
            global.loadGlobalSettings = restore;
        }
    });

    it('falls back to the new grade\'s own league when the tile\'s league does not cover it', () => {
        global.loadGlobalSettings = () => ({
            leaguesByName: {
                'Third Grade League': { enabled: true, divisions: ['3rd Grade'] },
                'Junior League': { enabled: true, divisions: ['4th Grade', '5th Grade', '6th Grade'] }
            }
        });
        try {
            const src = leagueTile('4th Grade');
            MSI.setSkeleton([src]);
            MSI.commitSpanResize(src, ['3rd Grade', '4th Grade']);

            const third = MSI.dailySkeleton.find(e => e.division === '3rd Grade');
            assert.equal(third.leagueName, 'Third Grade League', 'remapped to the grade\'s own league');
        } finally {
            global.loadGlobalSettings = restore;
        }
    });

    it('specialty tiles remap against the specialty store, keeping a shared specialty league', () => {
        global.loadGlobalSettings = () => ({
            leaguesByName: {
                'Fifth Grade League': { enabled: true, divisions: ['5th Grade'] }
            },
            specialtyLeagues: {
                sl1: { name: 'Hockey Masters', enabled: true, divisions: ['4th Grade', '5th Grade'] }
            }
        });
        try {
            const ev = {
                type: 'specialty_league', event: 'Hockey Masters',
                leagueName: 'Hockey Masters', division: '4th Grade'
            };
            global._mbRemapLeagueForGrade(ev, '5th Grade');
            assert.equal(ev.leagueName, 'Hockey Masters',
                'specialty league covering the new grade is kept (not swapped for a regular league)');
        } finally {
            global.loadGlobalSettings = restore;
        }
    });
});

// =====================================================================
describe('spanMembers', () => {
    it('returns just the event itself when there is no span', () => {
        const src = leagueTile('4th Grade');
        MSI.setSkeleton([src]);
        assert.deepEqual(MSI.spanMembers(src).map(e => e.id), [src.id]);
    });

    it('returns every member of the group', () => {
        const src = leagueTile('4th Grade');
        MSI.setSkeleton([src]);
        MSI.commitSpanResize(src, ['4th Grade', '5th Grade', '6th Grade']);
        const anchor = MSI.dailySkeleton.find(e => e.division === '4th Grade');
        assert.equal(MSI.spanMembers(anchor).length, 3);
    });
});

// =====================================================================
describe('syncSpanSiblings — edits apply to the whole span', () => {
    it('propagates shared fields but preserves per-grade identity', () => {
        const src = leagueTile('4th Grade');
        MSI.setSkeleton([src]);
        MSI.commitSpanResize(src, ['4th Grade', '5th Grade']);

        const anchor = MSI.dailySkeleton.find(e => e.division === '4th Grade');
        const mirrorIdBefore = MSI.dailySkeleton.find(e => e.division === '5th Grade').id;

        anchor.startTime = '2:00pm';
        anchor.endTime = '3:00pm';
        anchor.location = 'Field A';
        MSI.syncSpanSiblings(anchor);

        const mirror = MSI.dailySkeleton.find(e => e.division === '5th Grade');
        assert.equal(mirror.id, mirrorIdBefore, 'mirror keeps its id');
        assert.equal(mirror.division, '5th Grade', 'mirror keeps its division');
        assert.equal(mirror.startTime, '2:00pm');
        assert.equal(mirror.endTime, '3:00pm');
        assert.equal(mirror.location, 'Field A');
    });

    it('removes fields deleted on the edited member', () => {
        const src = leagueTile('4th Grade', { location: 'Field A' });
        MSI.setSkeleton([src]);
        MSI.commitSpanResize(src, ['4th Grade', '5th Grade']);

        const anchor = MSI.dailySkeleton.find(e => e.division === '4th Grade');
        delete anchor.location;
        MSI.syncSpanSiblings(anchor);

        const mirror = MSI.dailySkeleton.find(e => e.division === '5th Grade');
        assert.equal(mirror.location, undefined);
    });
});

// =====================================================================
describe('repairSpans — heals groups after external add/remove', () => {
    it('clears span fields when only one member survives', () => {
        const a = leagueTile('4th Grade', { spanGroup: 'g1', spanDivisions: ['4th Grade', '5th Grade'] });
        const skel = [a];
        MSI.repairSpans(skel);
        assert.equal(a.spanGroup, undefined);
        assert.equal(a.spanDivisions, undefined);
    });

    it('rebuilds spanDivisions from surviving members in display order', () => {
        const a = leagueTile('6th Grade', { spanGroup: 'g1', spanDivisions: ['4th Grade', '5th Grade', '6th Grade'] });
        const b = leagueTile('4th Grade', { spanGroup: 'g1', spanDivisions: ['4th Grade', '5th Grade', '6th Grade'] });
        const skel = [a, b];
        MSI.repairSpans(skel);
        assert.deepEqual(a.spanDivisions, ['4th Grade', '6th Grade']);
        assert.deepEqual(b.spanDivisions, ['4th Grade', '6th Grade']);
        assert.equal(a.spanGroup, 'g1');
    });

    it('heals a stale mirror whose league differs from the span\'s shared league', () => {
        // Span saved BEFORE the shared-league remap fix: the 5th Grade mirror
        // was remapped to 5th's own league. Repair must unify the span onto
        // the league that covers every spanned grade.
        const restore = global.loadGlobalSettings;
        global.loadGlobalSettings = () => ({
            leaguesByName: {
                'Fifth Grade League': { enabled: true, divisions: ['5th Grade'] },
                'Junior League': { enabled: true, divisions: ['4th Grade', '5th Grade'] }
            }
        });
        try {
            const a = leagueTile('4th Grade', { spanGroup: 'g1', spanDivisions: ['4th Grade', '5th Grade'] });
            const b = leagueTile('5th Grade', {
                spanGroup: 'g1', spanDivisions: ['4th Grade', '5th Grade'],
                leagueName: 'Fifth Grade League', event: 'Fifth Grade League'
            });
            MSI.repairSpans([a, b]);
            assert.equal(b.leagueName, 'Junior League', 'stale mirror adopts the shared league');
            assert.equal(b.event, 'Junior League', 'event label follows the league');
            assert.equal(a.leagueName, 'Junior League', 'anchor unchanged');
        } finally {
            global.loadGlobalSettings = restore;
        }
    });
});
