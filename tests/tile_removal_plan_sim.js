// =========================================================================
// tile_removal_plan_sim.js — removing a tile from an ALREADY-GENERATED day
//
// Deleting a tile only edited the skeleton. The generated day renders from
// divisionTimes + scheduleAssignments, both saved per date and both rebuilt
// only by a generation, so the removed period kept showing its activity — and
// a removed LEAGUE period kept its matchups on the books — until someone
// regenerated. "Remove the tile and put nothing in its place" was not
// expressible.
//
// buildTimeRemovalPlan (REAL division_times_system.js) builds the applied
// result as a pure value: geometry rebuilt from the post-delete skeleton,
// every surviving entry re-keyed onto it by its own _startMin, whatever lived
// in the removed window dropped, and a refusal rather than a half-apply when
// the day can't be remapped cleanly.
//
// Run: node --test tests/tile_removal_plan_sim.js
// =========================================================================
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

global.window = { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => {} };
global.document = { addEventListener: () => {}, getElementById: () => null, querySelectorAll: () => [] };
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.window.localStorage = global.localStorage;
global.window.CampUtils = {
    minutesToTimeLabel: function (m) {
        const h = Math.floor(m / 60), mm = m % 60, ap = h >= 12 ? 'pm' : 'am', h12 = h % 12 || 12;
        return h12 + ':' + (mm < 10 ? '0' + mm : mm) + ap;
    }
};
eval(fs.readFileSync(path.join(__dirname, '..', 'division_times_system.js'), 'utf8'));
const DTS = global.window.DivisionTimesSystem;

// mirror: scheduler_core_utils.js Utils.survivingLeagueLabels
function survivingLabels(la) {
    const regular = {};
    Object.keys(la || {}).forEach(dv => {
        const map = la[dv];
        if (!map || typeof map !== 'object') return;
        Object.keys(map).forEach(k => {
            const e = map[k];
            if (!e || !e.leagueName || !e.gameLabel || e.isSpecialtyLeague) return;
            (regular[e.leagueName] = regular[e.leagueName] || new Set()).add(e.gameLabel);
        });
    });
    return regular;
}

const ent = (a, s, e, extra) => Object.assign({ _activity: a, _startMin: s, _endMin: e }, extra || {});
const GAME = (t) => ({ leagueName: 'Camp League', gameLabel: 'Game 7', sport: 'Basketball', _startMin: t, matchups: ['T1 vs T2'] });

// The generated day: A plays 12–1 Sports, 1–2 League, 2–3 Swim.
const FULL_SKELETON = [
    { division: 'A', startTime: '12:00pm', endTime: '1:00pm', event: 'Sports Slot', type: 'slot' },
    { division: 'A', startTime: '1:00pm', endTime: '2:00pm', event: 'Camp League', type: 'league' },
    { division: 'A', startTime: '2:00pm', endTime: '3:00pm', event: 'Swim', type: 'pinned' }
];
const baseState = () => ({
    divisions: { A: { bunks: ['A1', 'A2'] } },
    scheduleAssignments: {
        A1: [ent('Soccer', 720, 780), null, ent('Swim', 840, 900, { _pinned: true })],
        A2: [ent('Hockey', 720, 780), null, ent('Swim', 840, 900, { _pinned: true })]
    },
    leagueAssignments: { A: { 1: GAME(780) } }
});

// =========================================================================
test('removing the league tile leaves the time unscheduled and drops the game', () => {
    const st = baseState();
    const skeleton = FULL_SKELETON.filter(t => t.type !== 'league');

    const plan = DTS.buildTimeRemovalPlan({
        removedTiles: [{ division: 'A', startMin: 780, endMin: 840 }],
        skeleton, divisions: st.divisions,
        scheduleAssignments: st.scheduleAssignments,
        leagueAssignments: st.leagueAssignments
    });
    assert.ok(plan.ok, 'plan applies');

    // The freed 1–2 window simply has no slot — nothing fills it.
    assert.deepStrictEqual(plan.newDT.A.map(s => s.startMin + '-' + s.endMin),
        ['720-780', '840-900'], 'the removed window is gone from the timeline');

    // Surviving entries carry across, re-keyed by their own _startMin (Swim
    // moves from index 2 to index 1 without being re-solved).
    assert.strictEqual(plan.assignments.A1.length, 2);
    assert.strictEqual(plan.assignments.A1[0]._activity, 'Soccer');
    assert.strictEqual(plan.assignments.A1[1]._activity, 'Swim');
    assert.strictEqual(plan.assignments.A1[1]._startMin, 840, 'Swim keeps its own time');
    assert.strictEqual(plan.assignments.A2[0]._activity, 'Hockey', 'sibling bunk carried across too');
    assert.deepStrictEqual(plan.affectedBunks.sort(), ['A1', 'A2']);

    // The league game is gone from the grid…
    assert.deepStrictEqual(plan.leagueAssignments.A, {}, 'league entry dropped');
    assert.strictEqual(plan.droppedLeagueGames, 1);
    // …so the reconcile sees no survivor for it and will release the record.
    assert.strictEqual(survivingLabels(plan.leagueAssignments)['Camp League'], undefined);
});

// =========================================================================
test('removing a middle activity tile re-keys the rest without re-solving', () => {
    const st = baseState();
    st.leagueAssignments = {};
    // Drop the 12–1 Sports tile instead.
    const skeleton = FULL_SKELETON.filter(t => t.startTime !== '12:00pm');

    const plan = DTS.buildTimeRemovalPlan({
        removedTiles: [{ division: 'A', startMin: 720, endMin: 780 }],
        skeleton, divisions: st.divisions,
        scheduleAssignments: st.scheduleAssignments,
        leagueAssignments: st.leagueAssignments
    });
    assert.ok(plan.ok);
    assert.deepStrictEqual(plan.newDT.A.map(s => s.startMin), [780, 840]);
    // Soccer is gone; Swim shifts from index 2 to index 1. The (empty) league
    // slot stays empty at index 0.
    assert.strictEqual(plan.assignments.A1[0], null, 'league period still unfilled');
    assert.strictEqual(plan.assignments.A1[1]._activity, 'Swim');
    assert.ok(!plan.assignments.A1.some(e => e && e._activity === 'Soccer'), 'removed activity is gone');
    assert.ok(!plan.assignments.A2.some(e => e && e._activity === 'Hockey'), 'sibling bunk too');
    assert.strictEqual(plan.droppedEntries, 2, 'counted across every affected bunk (A1 + A2)');
});

// =========================================================================
test('a game still played by ANOTHER division is not released', () => {
    const st = baseState();
    st.divisions.B = { bunks: ['B1'] };
    st.scheduleAssignments.B1 = [null];
    st.leagueAssignments.B = { 0: GAME(780) };   // B plays the same Game 7
    const skeleton = FULL_SKELETON.filter(t => t.type !== 'league').concat([
        { division: 'B', startTime: '1:00pm', endTime: '2:00pm', event: 'Camp League', type: 'league' }
    ]);

    const plan = DTS.buildTimeRemovalPlan({
        removedTiles: [{ division: 'A', startMin: 780, endMin: 840 }],
        skeleton, divisions: st.divisions,
        scheduleAssignments: st.scheduleAssignments,
        leagueAssignments: st.leagueAssignments
    });
    assert.ok(plan.ok);
    assert.deepStrictEqual(plan.leagueAssignments.A, {}, 'A no longer plays it');
    assert.ok(plan.leagueAssignments.B['0'], 'B keeps its copy untouched');
    assert.deepStrictEqual([...survivingLabels(plan.leagueAssignments)['Camp League']], ['Game 7'],
        'the game survives → the reconcile leaves its record alone');
    assert.deepStrictEqual(plan.affectedBunks, ['A1', 'A2'], 'B is not touched');
});

// =========================================================================
test('REFUSES rather than half-applying when a bunk cannot be re-keyed', () => {
    const st = baseState();
    // An entry with no _startMin is un-addressable — the regen path would
    // re-roll the bunk, but a removal has no solver to fall back on.
    st.scheduleAssignments.A2 = [{ _activity: 'Hockey' }, null, ent('Swim', 840, 900)];
    const skeleton = FULL_SKELETON.filter(t => t.type !== 'league');

    const plan = DTS.buildTimeRemovalPlan({
        removedTiles: [{ division: 'A', startMin: 780, endMin: 840 }],
        skeleton, divisions: st.divisions,
        scheduleAssignments: st.scheduleAssignments,
        leagueAssignments: st.leagueAssignments
    });
    assert.strictEqual(plan.ok, false);
    assert.strictEqual(plan.reason, 'unsafe-bunks');
    assert.deepStrictEqual(plan.unsafeBunks, ['A2']);
});

// =========================================================================
test('REFUSES when the division would have no periods left', () => {
    const st = baseState();
    const plan = DTS.buildTimeRemovalPlan({
        removedTiles: FULL_SKELETON.map(t => ({ division: 'A', startMin: 0, endMin: 0 })),
        skeleton: [], divisions: st.divisions,
        scheduleAssignments: st.scheduleAssignments,
        leagueAssignments: st.leagueAssignments
    });
    assert.strictEqual(plan.ok, false);
    assert.strictEqual(plan.reason, 'no-geometry');
    assert.deepStrictEqual(plan.emptyDivs, ['A']);
});

// =========================================================================
test('a multi-slot (continuation) fill is dropped as a whole', () => {
    const divisions = { A: { bunks: ['A1'] } };
    const skeletonFull = [
        { division: 'A', startTime: '12:00pm', endTime: '12:30pm', event: 'Sports Slot', type: 'slot' },
        { division: 'A', startTime: '12:30pm', endTime: '1:00pm', event: 'Sports Slot', type: 'slot' },
        { division: 'A', startTime: '1:00pm', endTime: '2:00pm', event: 'Swim', type: 'pinned' }
    ];
    // A 60-minute special spanning both morning slots, plus Swim.
    const scheduleAssignments = {
        A1: [
            ent('Ropes Course', 720, 780, { _blockStart: 720 }),
            Object.assign(ent('Ropes Course', 720, 780, { _blockStart: 720 }), { continuation: true }),
            ent('Swim', 780, 840, { _pinned: true })
        ]
    };
    // Remove BOTH morning tiles — the spanned fill's window disappears.
    const plan = DTS.buildTimeRemovalPlan({
        removedTiles: [
            { division: 'A', startMin: 720, endMin: 750 },
            { division: 'A', startMin: 750, endMin: 780 }
        ],
        skeleton: skeletonFull.filter(t => t.event === 'Swim'),
        divisions, scheduleAssignments, leagueAssignments: {}
    });
    assert.ok(plan.ok);
    assert.strictEqual(plan.assignments.A1.length, 1);
    assert.strictEqual(plan.assignments.A1[0]._activity, 'Swim');
    assert.strictEqual(plan.droppedEntries, 2, 'both halves of the span dropped together');
});
